//! The project manager: owns the unlocked vaults and runs one agent
//! server per unlocked project.
//!
//! Unlocking a project derives its key, writes its files out under its
//! `run/` folder, and starts the agent server with every folder it uses
//! (data, config, state, cache, temp) pointed inside `run/`. Locking stops
//! the server, seals what changed and wipes `run/`. The key lives only in
//! this process.

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

/// Folders in the agent's own data that are not worth keeping.
const HOME_SKIP: &[&str] = &["log", "locks", "pty", "node_modules", "target", ".next", "__pycache__", ".venv"];

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
}

/// What the interface shows for one project.
#[derive(Clone, Debug)]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    pub open: bool,
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
}

fn other(msg: impl Into<String>) -> Error {
    Error::Other(msg.into())
}

impl Manager {
    pub fn new(cfg: Config) -> Result<Manager> {
        create_private_dir(&cfg.base)?;
        Ok(Manager { projects: Projects::new(&cfg.base), cfg, open: BTreeMap::new() })
    }

    pub fn is_open(&self, id: &str) -> bool {
        self.open.contains_key(id)
    }

    pub fn any_open(&self) -> bool {
        !self.open.is_empty()
    }

    /// Creates a project locked to `passphrase` and opens it.
    pub fn create(&mut self, name: &str, passphrase: &str) -> Result<String> {
        let (meta, vault) = self.projects.create(name, passphrase)?;
        self.start(&meta.id, Arc::new(vault))?;
        Ok(meta.id)
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<()> {
        self.projects.rename(id, name).map(|_| ())
    }

    fn store(&self, vault: &Arc<Vault>, paths: &ProjectPaths) -> Result<Store> {
        Store::new(vault.clone(), &paths.dir)
    }

    pub fn unlock(&mut self, id: &str, passphrase: &str) -> Result<()> {
        if self.open.contains_key(id) {
            return Ok(());
        }
        let vault = Arc::new(self.projects.unlock(id, passphrase)?);
        self.start(id, vault)
    }

    fn start(&mut self, id: &str, vault: Arc<Vault>) -> Result<()> {
        let paths = self.projects.paths(id)?;
        let store = self.store(&vault, &paths)?;
        kill_stale(&paths.run);
        let mut project = Efs::open(store.clone(), "project")?;
        let mut state = Efs::open(store, "state")?;
        // A folder with its marker was left by a crash or a kill: its
        // plaintext is newer than what is sealed, so it is sealed before
        // anything else. A folder without one is not trusted (it may be
        // half written, or gone with a reboot) and is written out afresh.
        if paths.run.join(".ready").is_file() {
            runspace::sync_back(&mut project, &paths.work)?;
        } else {
            runspace::wipe(&paths.run)?;
            runspace::materialize(&project, &paths.work)?;
            fs::write(paths.run.join(".ready"), b"")?;
        }
        if paths.scratch.join(".ready").is_file() {
            runspace::sync_back_skipping(&mut state, &paths.home, HOME_SKIP)?;
        } else {
            if paths.scratch != paths.run {
                runspace::wipe(&paths.scratch)?;
            }
            runspace::materialize(&state, &paths.home)?;
            create_private_dir(&paths.scratch)?;
            fs::write(paths.scratch.join(".ready"), b"")?;
        }
        create_private_dir(&paths.work)?;
        create_private_dir(&paths.home)?;
        let (child, port, password) = self.spawn_server(&paths)?;
        self.open.insert(id.to_string(), Open { vault, port, password, child });
        Ok(())
    }

    fn spawn_server(&self, paths: &ProjectPaths) -> Result<(Child, u16, String)> {
        let port = free_port(preferred_port(&paths.dir))?;
        let password = random_hex(24)?;
        let tmp = paths.scratch.join("tmp");
        create_private_dir(&tmp)?;
        let cache = self.cfg.base.join("cache");
        create_private_dir(&cache)?;
        let log = fs::File::options().create(true).append(true).open(paths.scratch.join("server.log"))?;

        let mut argv = self.cfg.server_command.clone();
        if argv.is_empty() {
            argv = ["bun", "run", "--cwd"].map(String::from).to_vec();
            argv.push(self.cfg.root.join("packages/cli").to_string_lossy().into_owned());
            argv.extend(["src/index.ts", "serve"].map(String::from));
        }
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..])
            .args(["--port", &port.to_string(), "--hostname", "127.0.0.1"])
            .env("XDG_DATA_HOME", paths.home.join("data"))
            .env("XDG_CONFIG_HOME", paths.home.join("config"))
            .env("XDG_STATE_HOME", paths.home.join("state"))
            .env("XDG_CACHE_HOME", &cache)
            .env("TMPDIR", &tmp)
            .env("OPENCODE_PASSWORD", &password)
            .env("OPENCODE_DISABLE_CHANNEL_DB", "1")
            // The model list comes from the copy shipped with the agent, not from the network.
            .env("OPENCODE_DISABLE_MODELS_FETCH", "1")
            .env("ANONCODE_WORK", &paths.work)
            .env("ANONCODE_BIN", std::env::current_exe().unwrap_or_default())
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        let plugins: Vec<String> = ["loop", "focus"]
            .iter()
            .map(|p| self.cfg.root.join("packages/anoncode-plugins").join(p))
            .filter(|p| p.is_dir())
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        // opencode's own hosted models, web search and session sharing are
        // switched off: nothing goes to its servers. Models come only from
        // providers the user connects with their own key.
        let deny = |action: &str| serde_json::json!({ "action": action, "resource": "opencode", "effect": "deny" });
        let config = serde_json::json!({
            "plugins": plugins,
            "share": "disabled",
            "policies": [deny("provider.use"), deny("integration.use"), deny("integration.connect"), deny("websearch.use")],
        });
        cmd.env("OPENCODE_CONFIG_CONTENT", config.to_string());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group, so the whole tree can be stopped.
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| other(format!("could not start the agent server ({}): {e}", argv[0])))?;
        fs::write(paths.run.join("server.pid"), child.id().to_string())?;

        let basic = B64.encode(format!("opencode:{password}"));
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if matches!(http::get_status(port, "/api/info", &basic), Ok(200)) {
                return Ok((child, port, password));
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
        self.open.remove(id);
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
                server: open.map(|o| Server { port: o.port, auth: format!("Basic {}", B64.encode(format!("opencode:{}", o.password))), work: paths.work.clone(), home: paths.home.clone() }),
                id: p.id,
                name: p.name,
            });
        }
        Ok(out)
    }
}

fn preferred_port(dir: &Path) -> u16 {
    let h = dir.to_string_lossy().bytes().fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(b as u32));
    47200 + (h % 700) as u16
}

fn free_port(preferred: u16) -> Result<u16> {
    if TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return Ok(preferred);
    }
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
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
        // Only if that process group still runs out of this run/ folder.
        let ours = fs::read(format!("/proc/{pid}/environ")).map(|e| String::from_utf8_lossy(&e).contains(&*run.to_string_lossy())).unwrap_or(false);
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
