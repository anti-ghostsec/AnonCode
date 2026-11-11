//! The project manager: owns the unlocked vaults and runs one agent
//! server per unlocked project.
//!
//! Unlocking a project derives its key, writes its files out under its
//! `run/` folder, and starts the agent server with every folder it uses
//! (data, config, state, cache, temp) pointed inside `run/`. Locking stops
//! the server, seals what changed and wipes `run/`. The key lives only in
//! this process.
//!
//! There is one login. The app's own vault (`.anoncode/vault.json`,
//! `.anoncode/app/`) is opened with the user's passphrase and holds, sealed,
//! the settings shared by every project (provider keys, the default model)
//! and each project's own secret. A project's vault is locked to a random
//! secret made when the project is created, so opening a project asks for
//! nothing. A project made before there was a login still has its own
//! passphrase: it is asked for once and then kept in the app's vault.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;

use crate::efs::Efs;
use crate::fsx::create_private_dir;
use crate::http;
use crate::projects::{ProjectPaths, Projects};
use crate::runspace::{self, SKIP_DIRS};
use crate::store::Store;
use crate::vault::{random_hex, Vault};
use crate::{Error, Result};

/// Folders in the agent's own data that are not kept: logs, locks, and
/// caches (compiled code, downloaded tools), which are made again.
const HOME_SKIP: &[&str] = &["log", "locks", "pty", "cache", ".cargo", "tmp", "node_modules", "target", ".next", "__pycache__", ".venv"];

pub struct Config {
    /// The AnonCode folder (the one holding `packages/`).
    pub root: PathBuf,
    /// Its `.anoncode` folder.
    pub base: PathBuf,
    /// The command that starts the agent server, for tests. Empty: bun.
    pub server_command: Vec<String>,
}

struct Open {
    vault: Arc<Vault>,
    port: u16,
    password: String,
    child: Child,
    sandboxed: bool,
}

/// Where the agent finds the project, its own data and its code, inside
/// the sandbox.
const SANDBOX_WORK: &str = "/work";
const SANDBOX_HOME: &str = "/home/agent";
const SANDBOX_CODE: &str = "/opt/anoncode";
const SANDBOX_BIN: &str = "/opt/anoncode-bin";
const SANDBOX_TOOLS: &str = "/opt/tools";
/// Toolchains in the user's home the agent may run, read-only. Only these:
/// not `~/.cargo` as a whole, which holds registry credentials.
const TOOLCHAINS: &[&str] = &[".local/bin", ".local/lib", ".cargo/bin", ".rustup", ".bun/bin"];
/// System folders the sandbox sees, read-only.
const SYSTEM: &[&str] = &["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc"];
/// Sealed records saying a project's plaintext copies were written out.
/// Only someone holding the key can make one, so a copy left behind by a
/// crash is sealed back in only if it was AnonCode's own.
const MARK_WORK: &str = "work-out";
const MARK_HOME: &str = "home-out";

/// Settings shared by every project, sealed in the app's vault.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Model providers and their API keys.
    pub providers: Vec<Provider>,
    /// `(provider, model)` used where a project has not chosen one.
    pub model: Option<(String, String)>,
    /// Providers the agent knows, `(id, name)`, remembered from the last
    /// time an agent was running so they can be listed before one is.
    pub known: Vec<(String, String)>,
    /// Run the agent in the bubblewrap sandbox.
    pub sandbox: bool,
    /// The agent's web-page tool.
    pub web_fetch: Access,
    /// Shell commands and file changes: done at once, or asked first.
    pub approvals: Approvals,
    /// FOCUS context compression.
    pub focus: bool,
    /// When FOCUS starts, as a percentage of the model's context window.
    pub focus_share: u8,
    /// Lock AnonCode after this many minutes with no input (0: never).
    pub auto_lock_minutes: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            providers: Vec::new(),
            model: None,
            known: Vec::new(),
            sandbox: true,
            web_fetch: Access::Off,
            approvals: Approvals::Auto,
            focus: true,
            focus_share: 60,
            auto_lock_minutes: 0,
        }
    }
}

impl Settings {
    /// What an agent is started with: changing these takes effect when a
    /// project is opened (or reopened).
    pub fn agent_part(&self) -> (bool, Access, Approvals, bool, u8) {
        (self.sandbox, self.web_fetch, self.approvals, self.focus, self.focus_share)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Off,
    Ask,
    Allow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Approvals {
    /// The agent runs commands and changes files without asking.
    Auto,
    /// Each command and file change waits for a yes.
    Ask,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Provider {
    pub id: String,
    pub key: String,
}

/// What the interface shows for one project.
#[derive(Clone, Debug)]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub open: bool,
    /// Its secret is in the app's vault, so it opens without asking.
    pub known: bool,
    /// How to reach this project's agent server, while it is unlocked.
    pub server: Option<Server>,
}

/// An unlocked project's agent server, on the loopback interface.
#[derive(Clone, Debug)]
pub struct Server {
    pub port: u16,
    /// `Basic ...` for the `Authorization` header.
    pub auth: String,
    /// The project's plaintext folder, which the agent works in.
    pub work: PathBuf,
    /// The same folder as the agent sees it (`/work` in the sandbox).
    pub agent_work: String,
    /// The agent's unsealed data, sealed with the project on lock.
    pub home: PathBuf,
}

/// What a save to the vault did.
#[derive(Clone, Debug, Default)]
pub struct Sealed {
    pub changed: usize,
    pub deleted: usize,
    pub skipped: Vec<String>,
}

pub struct Manager {
    cfg: Config,
    projects: Projects,
    open: BTreeMap<String, Open>,
    /// The app's vault, while logged in.
    app: Option<Store>,
}

fn other(msg: impl Into<String>) -> Error {
    Error::Other(msg.into())
}

impl Manager {
    pub fn new(cfg: Config) -> Result<Manager> {
        create_private_dir(&cfg.base)?;
        Ok(Manager { projects: Projects::new(&cfg.base), cfg, open: BTreeMap::new(), app: None })
    }

    fn logged_in_with(&mut self, vault: Vault) -> Result<()> {
        let app = Store::new(Arc::new(vault), self.cfg.base.join("app"))?;
        self.projects.seal_index(app.clone())?;
        self.app = Some(app);
        Ok(())
    }

    fn app_header(&self) -> PathBuf {
        self.cfg.base.join("vault.json")
    }

    /// A passphrase has been set for the app.
    pub fn has_login(&self) -> bool {
        self.app_header().is_file()
    }

    pub fn logged_in(&self) -> bool {
        self.app.is_some()
    }

    /// Sets the app's passphrase, the first time.
    pub fn setup(&mut self, passphrase: &str) -> Result<()> {
        if self.has_login() {
            return Err(other("a passphrase is already set"));
        }
        let vault = Vault::create(passphrase)?;
        crate::fsx::write_private_atomic(&self.app_header(), &serde_json::to_vec(&vault.header)?, true)?;
        self.logged_in_with(vault)
    }

    pub fn login(&mut self, passphrase: &str) -> Result<()> {
        let header = serde_json::from_slice(&fs::read(self.app_header())?)?;
        let vault = Vault::unlock(passphrase, &header)?;
        self.logged_in_with(vault)
    }

    /// Locks every project and forgets the app's key.
    pub fn logout(&mut self) {
        self.lock_all();
        self.projects.forget_index();
        self.app = None;
    }

    fn app(&self) -> Result<&Store> {
        self.app.as_ref().ok_or_else(|| other("not logged in"))
    }

    pub fn settings(&self) -> Result<Settings> {
        Ok(self.app()?.get_json("settings", "settings")?.unwrap_or_default())
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        self.app()?.put_json("settings", "settings", settings)
    }

    pub fn is_open(&self, id: &str) -> bool {
        self.open.contains_key(id)
    }

    pub fn any_open(&self) -> bool {
        !self.open.is_empty()
    }

    /// Creates a project, locked to a random secret kept in the app's
    /// vault, and opens it.
    pub fn create(&mut self, name: &str) -> Result<String> {
        let secret = random_hex(32)?;
        let (meta, vault) = self.projects.create_with_secret(name, &secret)?;
        self.app()?.put_with("keys", &meta.id, secret.as_bytes(), true)?;
        self.start(&meta.id, Arc::new(vault))?;
        Ok(meta.id)
    }

    /// Opens a project whose secret is in the app's vault.
    pub fn open(&mut self, id: &str) -> Result<()> {
        if self.open.contains_key(id) {
            return Ok(());
        }
        let secret = self.app()?.get("keys", id)?.ok_or_else(|| other("this project needs its own passphrase once"))?;
        let secret = std::str::from_utf8(&secret).map_err(|_| Error::Damaged)?.to_string();
        let vault = Arc::new(self.projects.unlock(id, &secret)?);
        self.start(id, vault)
    }

    /// Stops a project's agent and starts it again, so new settings apply.
    /// Its files and chats are sealed in between, as on a lock.
    pub fn reopen(&mut self, id: &str) -> Result<()> {
        if !self.open.contains_key(id) {
            return Ok(());
        }
        self.lock(id)?;
        self.open(id)
    }

    /// The projects open now.
    pub fn open_ids(&self) -> Vec<String> {
        self.open.keys().cloned().collect()
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<()> {
        self.projects.rename(id, name).map(|_| ())
    }

    fn store(&self, vault: &Arc<Vault>, paths: &ProjectPaths) -> Result<Store> {
        Store::new(vault.clone(), &paths.dir)
    }

    /// Opens a project made before there was a login, with its own
    /// passphrase, and keeps that passphrase in the app's vault.
    pub fn unlock(&mut self, id: &str, passphrase: &str) -> Result<()> {
        if self.open.contains_key(id) {
            return Ok(());
        }
        let vault = Arc::new(self.projects.unlock(id, passphrase)?);
        // Kept, sealed, so it is not asked for again.
        self.app()?.put_with("keys", id, passphrase.as_bytes(), true)?;
        self.start(id, vault)
    }

    fn start(&mut self, id: &str, vault: Arc<Vault>) -> Result<()> {
        let paths = self.projects.paths(id)?;
        let store = self.store(&vault, &paths)?;
        kill_stale(&paths.run);
        let mut project = Efs::open(store.clone(), "project")?;
        let mut state = Efs::open(store.clone(), "state")?;
        // A plaintext copy left by a crash or a kill is newer than what is
        // sealed, so it is sealed before anything else, but only if it is
        // AnonCode's own: a sealed marker says it was written out, and the
        // folder must still be closed to everyone else. Otherwise it is
        // thrown away and written out afresh.
        if store.has("meta", MARK_WORK) && crate::fsx::is_private_dir(&paths.run) && paths.work.is_dir() {
            runspace::sync_back(&mut project, &paths.work)?;
        } else {
            runspace::wipe(&paths.run)?;
            create_private_dir(&paths.run)?;
            runspace::materialize(&project, &paths.work)?;
            store.put_with("meta", MARK_WORK, b"1", true)?;
        }
        if store.has("meta", MARK_HOME) && crate::fsx::is_private_dir(&paths.scratch) && paths.home.is_dir() {
            runspace::sync_back_skipping(&mut state, &paths.home, HOME_SKIP)?;
        } else {
            if paths.scratch != paths.run {
                runspace::wipe(&paths.scratch)?;
            }
            create_private_dir(&paths.scratch)?;
            runspace::materialize(&state, &paths.home)?;
            store.put_with("meta", MARK_HOME, b"1", true)?;
        }
        create_private_dir(&paths.work)?;
        create_private_dir(&paths.home)?;
        let (child, port, password, sandboxed) = self.spawn_server(&paths)?;
        self.open.insert(id.to_string(), Open { vault, port, password, child, sandboxed });
        Ok(())
    }

    /// Starts the agent server for an unlocked project, in a sandbox.
    ///
    /// The sandbox (bubblewrap) sees the system folders and a few
    /// toolchains read-only, AnonCode's code read-only, the project at
    /// `/work` and the agent's own data at `/home/agent`, and nothing else
    /// of the disk: not the user's home, not the AnonCode folder's own
    /// instruction files above the project, not other projects. /tmp and
    /// /run are private. It starts with an empty environment, so no API
    /// key or setting from the user's shell reaches the agent. It keeps the
    /// network, which the model provider needs; so do the agent's tools.
    ///
    /// Without bubblewrap it refuses to start, unless `ANONCODE_NO_SANDBOX`
    /// is set: then the agent runs as the user, still with an empty
    /// environment.
    fn spawn_server(&self, paths: &ProjectPaths) -> Result<(Child, u16, String, bool)> {
        let port = TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port();
        let password = random_hex(24)?;
        let log = fs::File::options().create(true).append(true).open(paths.scratch.join("server.log"))?;
        let home_dir = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let exe = std::env::current_exe().unwrap_or_default();
        let bwrap = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].into_iter().map(PathBuf::from).find(|p| p.is_file());
        let settings = self.settings().unwrap_or_default();
        let sandboxed = self.cfg.server_command.is_empty() && settings.sandbox && std::env::var_os("ANONCODE_NO_SANDBOX").is_none();
        if sandboxed && bwrap.is_none() {
            return Err(other("the agent runs in a sandbox, and bubblewrap (bwrap) isn't installed. Install it (Debian: apt install bubblewrap), or turn the sandbox off in Settings."));
        }

        // The paths the agent is given, inside the sandbox or not.
        let (code, work, home, bin) = if sandboxed {
            (PathBuf::from(SANDBOX_CODE), PathBuf::from(SANDBOX_WORK), PathBuf::from(SANDBOX_HOME), PathBuf::from(SANDBOX_BIN))
        } else {
            (self.cfg.root.clone(), paths.work.clone(), paths.home.clone(), exe.clone())
        };
        let tools: Vec<&str> = TOOLCHAINS.iter().copied().filter(|t| home_dir.join(t).exists()).collect();
        let mut path: Vec<String> = Vec::new();
        for t in [".local/bin", ".cargo/bin", ".bun/bin"] {
            if tools.contains(&t) {
                path.push(if sandboxed { format!("{SANDBOX_TOOLS}/{t}") } else { home_dir.join(t).to_string_lossy().into_owned() });
            }
        }
        path.extend(["/usr/local/bin", "/usr/bin", "/bin"].map(String::from));
        let plugins: Vec<String> = ["loop", "focus", "privacy"]
            .iter()
            .filter(|p| self.cfg.root.join("packages/anoncode-plugins").join(p).is_dir())
            .map(|p| code.join("packages/anoncode-plugins").join(p).to_string_lossy().into_owned())
            .collect();
        // Nothing goes to opencode's servers: its hosted models, web search
        // and sharing are off, and models come only from providers the user
        // gives a key. The agent may not fetch web pages either.
        let deny = |action: &str, resource: &str| serde_json::json!({ "action": action, "resource": resource, "effect": "deny" });
        let mut policies = vec![deny("provider.use", "opencode"), deny("integration.use", "opencode"), deny("integration.connect", "opencode"), deny("websearch.use", "*")];
        // Rules for the agent's tools, the last match winning. Off is a
        // policy, which nothing can override; ask and allow are rules.
        let rule = |action: &str, effect: &str| serde_json::json!({ "action": action, "resource": "*", "effect": effect });
        let mut permissions = Vec::new();
        match settings.web_fetch {
            Access::Off => policies.push(deny("tool.use", "webfetch:*")),
            Access::Ask => permissions.push(rule("webfetch", "ask")),
            Access::Allow => permissions.push(rule("webfetch", "allow")),
        }
        if settings.approvals == Approvals::Ask {
            for tool in ["shell", "edit", "write", "patch"] {
                permissions.push(rule(tool, "ask"));
            }
        }
        let mut config = serde_json::json!({
            "plugins": plugins,
            "share": "disabled",
            "policies": policies,
            "permissions": permissions,
        });
        // For testing the reviewer loop: caps the agent's steps per turn, so
        // a bigger task can't be finished in one.
        if let Some(steps) = std::env::var("ANONCODE_AGENT_STEPS").ok().and_then(|v| v.parse::<u32>().ok()) {
            config["agents"] = serde_json::json!({ "build": { "steps": steps } });
        }
        let mut env: Vec<(String, String)> = vec![
            ("PATH".into(), path.join(":")),
            ("HOME".into(), home.to_string_lossy().into_owned()),
            ("LANG".into(), std::env::var("LANG").unwrap_or_else(|_| "C.UTF-8".into())),
            ("TERM".into(), "xterm-256color".into()),
            ("XDG_DATA_HOME".into(), home.join("data").to_string_lossy().into_owned()),
            ("XDG_CONFIG_HOME".into(), home.join("config").to_string_lossy().into_owned()),
            ("XDG_STATE_HOME".into(), home.join("state").to_string_lossy().into_owned()),
            // Caches (compiled code, downloaded tools) live and die with the
            // agent's data in RAM; they are not sealed.
            ("XDG_CACHE_HOME".into(), home.join("cache").to_string_lossy().into_owned()),
            ("CARGO_HOME".into(), home.join(".cargo").to_string_lossy().into_owned()),
            ("TMPDIR".into(), if sandboxed { "/tmp".into() } else { paths.scratch.join("tmp").to_string_lossy().into_owned() }),
            ("OPENCODE_PASSWORD".into(), password.clone()),
            ("OPENCODE_DISABLE_CHANNEL_DB".into(), "1".into()),
            // The model list comes from the copy shipped with the agent.
            ("OPENCODE_DISABLE_MODELS_FETCH".into(), "1".into()),
            ("OPENCODE_DISABLE_AUTOUPDATE".into(), "1".into()),
            ("OPENCODE_CONFIG_CONTENT".into(), config.to_string()),
            ("ANONCODE_WORK".into(), work.to_string_lossy().into_owned()),
            ("ANONCODE_BIN".into(), bin.to_string_lossy().into_owned()),
        ];
        if tools.contains(&".rustup") {
            env.push(("RUSTUP_HOME".into(), if sandboxed { format!("{SANDBOX_TOOLS}/.rustup") } else { home_dir.join(".rustup").to_string_lossy().into_owned() }));
        }
        env.push(("ANONCODE_FOCUS".into(), if settings.focus { "on".into() } else { "off".into() }));
        env.push(("ANONCODE_FOCUS_SHARE".into(), settings.focus_share.clamp(20, 95).to_string()));
        if let Ok(budget) = std::env::var("ANONCODE_FOCUS_BUDGET") {
            env.push(("ANONCODE_FOCUS_BUDGET".into(), budget));
        }
        if !sandboxed {
            create_private_dir(&paths.scratch.join("tmp"))?;
        }

        let mut argv = self.cfg.server_command.clone();
        if argv.is_empty() {
            argv = ["bun", "run", "--cwd"].map(String::from).to_vec();
            argv.push(code.join("packages/cli").to_string_lossy().into_owned());
            argv.extend(["src/index.ts", "serve"].map(String::from));
        }
        argv.extend(["--port".to_string(), port.to_string(), "--hostname".into(), "127.0.0.1".into()]);

        let mut cmd = if sandboxed {
            let mut c = Command::new(bwrap.unwrap());
            let mut a: Vec<String> = Vec::new();
            let mut add = |items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));
            for d in SYSTEM {
                if Path::new(d).exists() {
                    add(&["--ro-bind", d, d]);
                }
            }
            add(&["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run"]);
            // DNS settings that point into /run (systemd-resolved).
            if let Ok(real) = fs::canonicalize("/etc/resolv.conf") {
                if real.starts_with("/run") {
                    let r = real.to_string_lossy().into_owned();
                    add(&["--ro-bind", &r, &r]);
                }
            }
            // A neutral user and machine name: the real ones are not the
            // agent's business, and it would pass them on to the model.
            let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
            let ids = paths.scratch.join("ids");
            create_private_dir(&ids)?;
            fs::write(ids.join("passwd"), format!("root:x:0:0:root:/root:/bin/sh\nagent:x:{uid}:{gid}:agent:{SANDBOX_HOME}:/bin/sh\nnobody:x:65534:65534:nobody:/:/usr/sbin/nologin\n"))?;
            fs::write(ids.join("group"), format!("root:x:0:\nagent:x:{gid}:\nnogroup:x:65534:\n"))?;
            fs::write(ids.join("hostname"), "anoncode\n")?;
            fs::write(ids.join("hosts"), "127.0.0.1 localhost anoncode\n::1 localhost\n")?;
            for f in ["passwd", "group", "hostname", "hosts"] {
                let src = ids.join(f).to_string_lossy().into_owned();
                add(&["--ro-bind", &src, &format!("/etc/{f}")]);
            }
            add(&["--hostname", "anoncode"]);
            let root = self.cfg.root.to_string_lossy().into_owned();
            add(&["--ro-bind", &root, SANDBOX_CODE]);
            // A project's own .anoncode can't be inside the code it reads.
            let base_in_code = self.cfg.base.strip_prefix(&self.cfg.root).ok().map(|rel| format!("{SANDBOX_CODE}/{}", rel.display()));
            if let Some(hidden) = &base_in_code {
                add(&["--tmpfs", hidden]);
            }
            let exe_s = exe.to_string_lossy().into_owned();
            add(&["--ro-bind", &exe_s, SANDBOX_BIN]);
            for t in &tools {
                let host = home_dir.join(t).to_string_lossy().into_owned();
                add(&["--ro-bind", &host, &format!("{SANDBOX_TOOLS}/{t}")]);
            }
            let (h, w) = (paths.home.to_string_lossy().into_owned(), paths.work.to_string_lossy().into_owned());
            // bun finds its preload modules from the folder it starts in, so
            // the server starts in its own package; the agent works in /work.
            add(&["--bind", &h, SANDBOX_HOME, "--bind", &w, SANDBOX_WORK, "--chdir", &format!("{SANDBOX_CODE}/packages/cli")]);
            // No --die-with-parent: it fires when the thread that started the
            // sandbox ends, not the app. Locking stops the server, and one left
            // by a crash is stopped at the next unlock.
            add(&["--unshare-all", "--share-net", "--clearenv"]);
            for (k, v) in &env {
                add(&["--setenv", k, v]);
            }
            a.push("--".into());
            c.args(&a).args(&argv);
            c.env_clear();
            c
        } else {
            let mut c = Command::new(&argv[0]);
            c.args(&argv[1..]).env_clear().envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
            if self.cfg.server_command.is_empty() {
                // bun is looked up on the agent's PATH.
                if let Some(bun) = path.iter().map(|d| Path::new(d).join("bun")).find(|p| p.is_file()) {
                    c = Command::new(bun);
                    c.args(&argv[1..]).env_clear().envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
                }
            }
            c
        };
        if !sandboxed {
            cmd.current_dir(self.cfg.root.join("packages/cli"));
        }
        cmd.stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so the whole tree can be stopped.
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| other(format!("could not start the agent server: {e}")))?;
        fs::write(paths.run.join("server.pid"), child.id().to_string())?;

        let basic = B64.encode(format!("opencode:{password}"));
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if matches!(http::get_status(port, "/api/info", &basic), Ok(200)) {
                return Ok((child, port, password, sandboxed));
            }
            if let Ok(Some(status)) = child.try_wait() {
                return Err(other(format!("the agent server stopped ({status}):\n{}", tail(&paths.scratch.join("server.log")))));
            }
            if Instant::now() > deadline {
                stop(&mut child);
                return Err(other(format!("the agent server did not start in time:\n{}", tail(&paths.scratch.join("server.log")))));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// Seals what changed in the plaintext copy. The project stays open.
    pub fn seal(&self, id: &str) -> Result<Sealed> {
        let open = self.open.get(id).ok_or_else(|| other("the project is locked"))?;
        let paths = self.projects.paths(id)?;
        let store = self.store(&open.vault, &paths)?;
        let mut project = Efs::open(store.clone(), "project")?;
        let mut state = Efs::open(store, "state")?;
        let p = runspace::sync_back(&mut project, &paths.work)?;
        let s = runspace::sync_back_skipping(&mut state, &paths.home, HOME_SKIP)?;
        let mut skipped = p.skipped;
        skipped.extend(s.skipped.into_iter().map(|x| format!("(agent data) {x}")));
        Ok(Sealed { changed: p.changed.len(), deleted: p.deleted.len(), skipped })
    }

    pub fn lock(&mut self, id: &str) -> Result<()> {
        let Some(open) = self.open.get_mut(id) else { return Ok(()) };
        // Stopped first, so the database on disk is whole when it is sealed.
        stop(&mut open.child);
        self.seal(id)?;
        let paths = self.projects.paths(id)?;
        runspace::wipe(&paths.scratch)?;
        runspace::wipe(&paths.run)?;
        if let Some(open) = self.open.remove(id) {
            let store = self.store(&open.vault, &paths)?;
            store.remove("meta", MARK_WORK)?;
            store.remove("meta", MARK_HOME)?;
        }
        Ok(())
    }

    pub fn lock_all(&mut self) {
        for id in self.open.keys().cloned().collect::<Vec<_>>() {
            if let Err(e) = self.lock(&id) {
                eprintln!("anoncode: could not lock {id}: {e}. Its plaintext is still in its run/ folder and will be sealed at the next unlock.");
            }
        }
    }

    pub fn delete(&mut self, id: &str) -> Result<()> {
        if let Some(mut open) = self.open.remove(id) {
            stop(&mut open.child);
        }
        runspace::wipe(&self.projects.paths(id)?.scratch)?;
        if let Some(app) = &self.app {
            app.remove("keys", id)?;
        }
        self.projects.delete(id)
    }

    /// Decrypts the project's files to `dir`. Returns how many were written.
    pub fn export(&self, id: &str, dir: &str) -> Result<usize> {
        self.seal(id)?;
        let open = self.open.get(id).ok_or_else(|| other("the project is locked"))?;
        let paths = self.projects.paths(id)?;
        let target = export_dir(dir, &self.cfg.root)?;
        let project = Efs::open(self.store(&open.vault, &paths)?, "project")?;
        runspace::materialize(&project, &target)
    }

    /// Copies a folder's files into the project. Returns how many.
    pub fn import(&self, id: &str, dir: &str) -> Result<usize> {
        if !self.open.contains_key(id) {
            return Err(other("the project is locked"));
        }
        let source = expand(dir)?;
        if !source.is_dir() {
            return Err(other("that folder does not exist"));
        }
        let paths = self.projects.paths(id)?;
        let n = copy_tree(&source, &paths.work)?;
        self.seal(id)?;
        Ok(n)
    }

    pub fn list(&self) -> Result<Vec<ProjectView>> {
        let mut out = Vec::new();
        for p in self.projects.list()? {
            let open = self.open.get(&p.id);
            let paths = self.projects.paths(&p.id)?;
            out.push(ProjectView {
                open: open.is_some(),
                known: self.app.as_ref().is_some_and(|a| a.has("keys", &p.id)),
                server: open.map(|o| Server { port: o.port, auth: format!("Basic {}", B64.encode(format!("opencode:{}", o.password))), work: paths.work.clone(), agent_work: if o.sandboxed { SANDBOX_WORK.to_string() } else { paths.work.to_string_lossy().into_owned() }, home: paths.home.clone() }),
                id: p.id,
                name: p.name,
            });
        }
        Ok(out)
    }
}

fn stop(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    #[cfg(unix)]
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Stops a server left running by a launcher that was killed.
fn kill_stale(run: &Path) {
    let Ok(pid) = fs::read_to_string(run.join("server.pid")) else { return };
    let _ = fs::remove_file(run.join("server.pid"));
    #[cfg(unix)]
    if let Ok(pid) = pid.trim().parse::<i32>() {
        // Only if that process still runs for this project: its command
        // line names the project's folder.
        let ours = fs::read(format!("/proc/{pid}/cmdline")).map(|e| String::from_utf8_lossy(&e).contains(&*run.to_string_lossy())).unwrap_or(false);
        if pid > 1 && ours {
            unsafe {
                libc::killpg(pid, libc::SIGTERM);
            }
            std::thread::sleep(Duration::from_millis(1500));
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

fn tail(path: &Path) -> String {
    let Ok(mut f) = fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(2000)));
    let mut s = String::new();
    let _ = f.read_to_string(&mut s);
    s
}

fn expand(dir: &str) -> Result<PathBuf> {
    let d = dir.trim();
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    if d == "~" {
        Ok(home)
    } else if let Some(rest) = d.strip_prefix("~/") {
        Ok(home.join(rest))
    } else if Path::new(d).is_absolute() {
        Ok(PathBuf::from(d))
    } else {
        Err(other("use an absolute path or ~/... for the folder"))
    }
}

/// Where an export may go: never inside the AnonCode folder, which is a
/// git repository, so decrypted files there are one `git add` from being
/// published.
pub fn export_dir(dir: &str, root: &Path) -> Result<PathBuf> {
    let abs = expand(dir)?;
    if abs.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(other("the export folder must not contain .."));
    }
    let mut existing = abs.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or_else(|| other("bad export folder"))?;
    }
    let real = existing.canonicalize()?.join(abs.strip_prefix(existing).unwrap_or(Path::new("")));
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if real.starts_with(&root) {
        return Err(other("can't export inside the AnonCode folder: pick a folder outside it"));
    }
    Ok(abs)
}

fn copy_tree(from: &Path, to: &Path) -> Result<usize> {
    let mut n = 0;
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let meta = fs::symlink_metadata(entry.path())?;
        let target = to.join(entry.file_name());
        if meta.is_dir() {
            if entry.file_name().to_str().is_some_and(|x| SKIP_DIRS.contains(&x)) {
                continue;
            }
            n += copy_tree(&entry.path(), &target)?;
        } else if meta.is_file() {
            fs::copy(entry.path(), &target)?;
            n += 1;
        } else if meta.file_type().is_symlink() {
            #[cfg(unix)]
            {
                let _ = fs::remove_file(&target);
                std::os::unix::fs::symlink(fs::read_link(entry.path())?, &target)?;
                n += 1;
            }
        }
    }
    Ok(n)
}
