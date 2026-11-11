//! The window: one tab per project across the top, and under it the
//! selected project's chats with the agent.
//!
//! A locked project shows a passphrase box. Unlocking starts that
//! project's agent server; the chat view talks to it over the loopback
//! interface. Nothing here is a web page.
//!
//! The interface thread never waits: unlocking, sealing and every request
//! to an agent server run on other threads and report back in a [`Msg`].

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eframe::egui::{self, Align, Color32, Key, Layout, RichText, ScrollArea, TextEdit, Ui};
use serde_json::{json, Value};
use zeroize::Zeroize;

use crate::api::Client;
use crate::supervisor::{Access, AgentPart, Approvals, Config, FocusDraft, Manager, ProjectView, Provider, Settings};
use crate::Result;

/// Set by Ctrl+C and friends: close the window, which locks everything.
pub static QUIT: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    QUIT.store(true, Ordering::SeqCst);
}

enum Msg {
    Projects(Vec<ProjectView>),
    /// A project operation finished: what to say, or what went wrong.
    Done { id: String, result: std::result::Result<String, String> },
    Created(std::result::Result<String, String>),
    /// The login finished: the shared settings, or what went wrong.
    LoggedIn(std::result::Result<Settings, String>),
    LoggedOut,
    /// The shared provider keys were applied to a project's agent.
    Applied { id: String, applied: BTreeMap<String, String> },
    Unlocked { id: String, error: Option<String> },
    Sessions { id: String, list: Vec<Value> },
    Messages { id: String, session: String, list: Vec<Value> },
    /// Streamed text of a reply still being written.
    Delta { id: String, session: String, message: String, ordinal: u64, reasoning: bool, delta: String },
    Permissions { id: String, list: Vec<Value> },
    Models { id: String, list: Vec<Value> },
    Integrations { id: String, list: Vec<Value> },
    Commands { id: String, names: Vec<String> },
    /// A chat was started for a first message.
    Started { id: String, session: String },
    Notice { id: String, text: String },
    /// The desktop's file chooser was closed. `None`: there is none.
    Picked { id: String, folder: bool, paths: Option<Vec<PathBuf>> },
}

/// What the poller thread shares with the interface.
struct Shared {
    stop: AtomicBool,
    /// Fetch models, providers and chats again on the next round.
    refresh: AtomicBool,
    /// Something changed on the server: fetch now instead of waiting.
    wake: AtomicBool,
    /// The chat list changed.
    sessions_changed: AtomicBool,
    /// The event stream is connected, so the poller can wait longer.
    streaming: AtomicBool,
    session: Mutex<String>,
}

/// An unlocked project's chat view.
struct Tab {
    client: Client,
    shared: Arc<Shared>,
    sessions: Vec<Value>,
    messages: Vec<Value>,
    /// Text streamed for reply parts not stored yet: `(message, ordinal)`
    /// to whether it is thinking, and the text so far.
    live: BTreeMap<(String, u64), (bool, String)>,
    permissions: Vec<Value>,
    models: Vec<Value>,
    integrations: Vec<Value>,
    commands: Vec<String>,
    /// `(provider, model)` for new chats and the next message.
    model: Option<(String, String)>,
    composer: String,
    /// Files to send with the next message.
    attachments: Vec<PathBuf>,
    notice: String,
    to_bottom: bool,
    /// Pressed by the self-test script, as if Send had been clicked.
    press_send: bool,
    /// Provider -> fingerprint of the key this project's agent was given.
    applied: BTreeMap<String, String>,
    /// The shared keys have been compared with this project's agent.
    reconciled: bool,
    /// Remembered between unlocks, inside the project's sealed data.
    prefs: PathBuf,
}

enum Dialog {
    Rename { id: String, name: String },
    Delete { id: String, name: String, typed: String },
    Export { id: String, dir: String },
    Import { id: String, dir: String },
    /// `time`: how long the loop may run ("2h", "30m"); empty for no limit.
    Loop { id: String, review: String, time: String },
    /// Choosing files to attach: the folder shown and what is in it.
    Attach { id: String, dir: PathBuf, typed: String, entries: Vec<(String, bool)> },
}

/// A folder's entries, folders first, each with whether it is a folder.
fn entries(dir: &std::path::Path) -> Vec<(String, bool)> {
    let mut list: Vec<(String, bool)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path().is_dir()))
        .collect();
    list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    list
}

/// Opens the desktop's own file chooser (zenity, or kdialog on KDE) off the
/// interface thread, and reports what was chosen in [`Msg::Picked`].
fn pick(tx: &Sender<Msg>, ctx: &egui::Context, id: &str, title: &str, folder: bool) {
    let (tx, ctx, id, title) = (tx.clone(), ctx.clone(), id.to_string(), title.to_string());
    std::thread::spawn(move || {
        let start = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"));
        let start = format!("{}/", start.display());
        let zenity: Vec<String> = if folder {
            vec!["--file-selection".into(), "--directory".into(), format!("--title={title}"), format!("--filename={start}")]
        } else {
            vec!["--file-selection".into(), "--multiple".into(), "--separator=\n".into(), format!("--title={title}"), format!("--filename={start}")]
        };
        let kdialog: Vec<String> = if folder {
            vec!["--title".into(), title.clone(), "--getexistingdirectory".into(), start.clone()]
        } else {
            vec!["--title".into(), title.clone(), "--getopenfilename".into(), start.clone(), "--multiple".into(), "--separate-output".into()]
        };
        let kde = std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|d| d.to_uppercase().contains("KDE"));
        let order = if kde { [("kdialog", kdialog.clone()), ("zenity", zenity.clone())] } else { [("zenity", zenity), ("kdialog", kdialog)] };
        // The first chooser that exists; it exits non-zero when closed without a choice.
        let paths = order.into_iter().find_map(|(program, args)| {
            let out = std::process::Command::new(program).args(&args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().ok()?;
            Some(if out.status.success() { String::from_utf8_lossy(&out.stdout).lines().filter(|l| !l.trim().is_empty()).map(PathBuf::from).collect() } else { Vec::new() })
        });
        let _ = tx.send(Msg::Picked { id, folder, paths });
        ctx.request_repaint();
    });
}

fn attach_dialog(id: &str, dir: PathBuf) -> Dialog {
    Dialog::Attach { id: id.to_string(), typed: dir.to_string_lossy().into_owned(), entries: entries(&dir), dir }
}

struct App {
    manager: Arc<Mutex<Manager>>,
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    ctx: egui::Context,
    projects: Vec<ProjectView>,
    selected: String,
    tabs: BTreeMap<String, Tab>,
    busy: BTreeSet<String>,
    creating: bool,
    new_name: String,
    /// A passphrase has been set for the app; and it has been given.
    has_login: bool,
    logged_in: bool,
    login_pass: String,
    login_pass2: String,
    login_error: String,
    login_busy: bool,
    press_login: bool,
    /// Shared by every project; sealed in the app's vault.
    settings: Settings,
    show_settings: bool,
    /// The agent settings the open projects were started with.
    started_with: Option<AgentPart>,
    /// When the user last did anything, for the auto-lock.
    last_input: std::time::Instant,
    set_filter: String,
    set_chosen: String,
    set_key: String,
    new_error: String,
    new_busy: bool,
    pass: String,
    pass_error: String,
    status: String,
    dialog: Option<Dialog>,
    /// Pressed by the self-test script, as if the button had been clicked.
    press_create: bool,
    press_unlock: bool,
    #[cfg(feature = "selftest")]
    script: selftest::Script,
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

/// Watches one unlocked project's agent server and reports what changed.
fn poll(id: String, client: Client, shared: Arc<Shared>, tx: Sender<Msg>, ctx: egui::Context) {
    let mut last = BTreeMap::<&str, String>::new();
    let mut round = 0u32;
    let mut providers_known = false;
    // The chat on screen: its id and its messages by id (ids sort by time).
    let mut loaded: (String, BTreeMap<String, Value>) = Default::default();
    let send = |msg: Msg| {
        let _ = tx.send(msg);
        ctx.request_repaint();
    };
    // Sent only when it differs from what was sent last, so an idle
    // project costs no redraws.
    let mut changed = |key: &'static str, list: &[Value]| {
        let now = serde_json::to_string(list).unwrap_or_default();
        if last.get(key) == Some(&now) {
            return false;
        }
        last.insert(key, now);
        true
    };
    while !shared.stop.load(Ordering::SeqCst) {
        let refresh = shared.refresh.swap(false, Ordering::SeqCst);
        // The server fills in its provider list a moment after it starts,
        // so ask again until there is one.
        if round == 0 || refresh || (!providers_known && round % 3 == 0) {
            if let Ok(list) = client.models() {
                send(Msg::Models { id: id.clone(), list });
            }
            if let Ok(list) = client.integrations() {
                providers_known = !list.is_empty();
                send(Msg::Integrations { id: id.clone(), list });
            }
            if let Ok(list) = client.commands() {
                send(Msg::Commands { id: id.clone(), names: list.iter().map(|c| text(c, "name")).collect() });
            }
        }
        if round % 6 == 0 || refresh || shared.sessions_changed.swap(false, Ordering::SeqCst) {
            if let Ok(list) = client.sessions() {
                if changed("sessions", &list) {
                    send(Msg::Sessions { id: id.clone(), list });
                }
            }
        }
        let session = shared.session.lock().unwrap().clone();
        if session != loaded.0 {
            loaded = (session.clone(), BTreeMap::new());
        }
        if !session.is_empty() {
            // The whole chat once, then only its newest page, merged in.
            match client.messages(&session, loaded.1.is_empty()) {
                Ok(page) => {
                    for mut m in page {
                        // An attachment's bytes are not drawn; keep only its name and kind.
                        for file in m["files"].as_array_mut().into_iter().flatten() {
                            if let Some(o) = file.as_object_mut() {
                                o.remove("data");
                            }
                        }
                        loaded.1.insert(text(&m, "id"), m);
                    }
                    let list: Vec<Value> = loaded.1.values().cloned().collect();
                    let mut keyed = vec![Value::String(session.clone())];
                    keyed.extend(list.iter().cloned());
                    if changed("messages", &keyed) {
                        send(Msg::Messages { id: id.clone(), session: session.clone(), list });
                    }
                }
                Err(e) if round % 20 == 0 => send(Msg::Notice { id: id.clone(), text: format!("Could not read the chat: {e}") }),
                Err(_) => {}
            }
        }
        if let Ok(list) = client.permissions() {
            if changed("permissions", &list) {
                send(Msg::Permissions { id: id.clone(), list });
            }
        }
        round += 1;
        // With the event stream connected, changes wake this at once, so the
        // regular check can be slow; without it, check often.
        let wait = if shared.streaming.load(Ordering::SeqCst) { 3000 } else { 450 };
        let mut slept = 0;
        while slept < wait && !shared.wake.swap(false, Ordering::SeqCst) && !shared.stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(30));
            slept += 30;
        }
    }
}

/// Follows one project's server events: streams the text of replies as it
/// is written, and wakes the poller when anything else changes.
fn stream(id: String, client: Client, shared: Arc<Shared>, tx: Sender<Msg>, ctx: egui::Context) {
    while !shared.stop.load(Ordering::SeqCst) {
        let result = client.events(|event| {
            shared.streaming.store(true, Ordering::SeqCst);
            let kind = event["type"].as_str().unwrap_or("");
            let data = &event["data"];
            let session = text(data, "sessionID");
            let current = *shared.session.lock().unwrap() == session;
            match kind {
                "session.text.delta" | "session.reasoning.delta" if current => {
                    let _ = tx.send(Msg::Delta {
                        id: id.clone(),
                        session,
                        message: text(data, "assistantMessageID"),
                        ordinal: data["ordinal"].as_u64().unwrap_or(0),
                        reasoning: kind == "session.reasoning.delta",
                        delta: text(data, "delta"),
                    });
                    ctx.request_repaint();
                }
                "session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta" | "server.connected" => {}
                "session.created" | "session.deleted" | "session.renamed" | "session.updated" | "session.archived" => {
                    shared.sessions_changed.store(true, Ordering::SeqCst);
                    shared.wake.store(true, Ordering::SeqCst);
                }
                k if k.starts_with("permission.") || current => shared.wake.store(true, Ordering::SeqCst),
                _ => {}
            }
        });
        shared.streaming.store(false, Ordering::SeqCst);
        if result.is_err() {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}

impl Tab {
    fn new(id: &str, view: &ProjectView, tx: &Sender<Msg>, ctx: &egui::Context) -> Option<Tab> {
        let server = view.server.as_ref()?;
        let client = Client::new(server);
        let prefs = server.home.join("anoncode-gui.json");
        let saved: Value = std::fs::read(&prefs).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
        let model = match (saved["provider"].as_str(), saved["model"].as_str()) {
            (Some(p), Some(m)) => Some((p.to_string(), m.to_string())),
            _ => None,
        };
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            refresh: AtomicBool::new(false),
            wake: AtomicBool::new(false),
            sessions_changed: AtomicBool::new(false),
            streaming: AtomicBool::new(false),
            session: Mutex::new(text(&saved, "session")),
        });
        let (id2, c, s, tx2, ctx2) = (id.to_string(), client.clone(), shared.clone(), tx.clone(), ctx.clone());
        std::thread::spawn(move || poll(id2, c, s, tx2, ctx2));
        let (id, c, s, tx, ctx) = (id.to_string(), client.clone(), shared.clone(), tx.clone(), ctx.clone());
        std::thread::spawn(move || stream(id, c, s, tx, ctx));
        Some(Tab {
            client,
            shared,
            sessions: Vec::new(),
            messages: Vec::new(),
            live: BTreeMap::new(),
            permissions: Vec::new(),
            models: Vec::new(),
            integrations: Vec::new(),
            commands: Vec::new(),
            model,
            composer: String::new(),
            attachments: Vec::new(),
            notice: String::new(),
            to_bottom: true,
            press_send: false,
            applied: saved["applied"].as_object().map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default(),
            reconciled: false,
            prefs,
        })
    }

    fn session(&self) -> String {
        self.shared.session.lock().unwrap().clone()
    }

    fn save_prefs(&self) {
        let (provider, model) = self.model.clone().unwrap_or_default();
        let _ = std::fs::write(&self.prefs, json!({ "provider": provider, "model": model, "session": self.session(), "applied": self.applied }).to_string());
    }

    fn select(&mut self, session: &str) {
        *self.shared.session.lock().unwrap() = session.to_string();
        self.shared.wake.store(true, Ordering::SeqCst);
        self.messages.clear();
        self.live.clear();
        self.to_bottom = true;
        self.save_prefs();
    }

    /// The agent is in the middle of a turn in the chat on screen.
    fn working(&self) -> bool {
        self.messages.last().is_some_and(|m| m["type"] != "idle")
    }
}

/// Runs `work` against a project's agent server off the interface thread;
/// a failure shows as that project's notice.
fn request(tx: &Sender<Msg>, ctx: &egui::Context, id: &str, work: impl FnOnce() -> std::result::Result<(), String> + Send + 'static) {
    let (tx, ctx, id) = (tx.clone(), ctx.clone(), id.to_string());
    std::thread::spawn(move || {
        if let Err(text) = work() {
            let _ = tx.send(Msg::Notice { id, text });
            ctx.request_repaint();
        }
    });
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>, manager: Manager) -> App {
        cc.egui_ctx.add_plugin(Selected::default());
        let (tx, rx) = channel();
        let has_login = manager.has_login();
        App {
            manager: Arc::new(Mutex::new(manager)),
            tx,
            rx,
            ctx: cc.egui_ctx.clone(),
            creating: false,
            projects: Vec::new(),
            selected: String::new(),
            has_login,
            logged_in: false,
            login_pass: String::new(),
            login_pass2: String::new(),
            login_error: String::new(),
            login_busy: false,
            press_login: false,
            settings: Settings::default(),
            show_settings: false,
            started_with: None,
            last_input: std::time::Instant::now(),
            set_filter: String::new(),
            set_chosen: String::new(),
            set_key: String::new(),
            tabs: BTreeMap::new(),
            busy: BTreeSet::new(),
            new_name: String::new(),
            new_error: String::new(),
            new_busy: false,
            pass: String::new(),
            pass_error: String::new(),
            status: String::new(),
            dialog: None,
            press_create: false,
            press_unlock: false,
            #[cfg(feature = "selftest")]
            script: selftest::Script::from_env(),
        }
    }

    /// Runs a project operation off the interface thread, then reports the
    /// new project list and the outcome.
    fn run(&mut self, id: &str, work: impl FnOnce(&mut Manager) -> Result<String> + Send + 'static) {
        self.busy.insert(id.to_string());
        let (manager, tx, ctx, id) = (self.manager.clone(), self.tx.clone(), self.ctx.clone(), id.to_string());
        std::thread::spawn(move || {
            let mut m = manager.lock().unwrap();
            let result = work(&mut m).map_err(|e| e.to_string());
            let _ = tx.send(Msg::Projects(m.list().unwrap_or_default()));
            let _ = tx.send(Msg::Done { id, result });
            ctx.request_repaint();
        });
    }

    /// Seals the shared settings, off the interface thread.
    fn save_settings(&self) {
        let (manager, settings) = (self.manager.clone(), self.settings.clone());
        std::thread::spawn(move || {
            let _ = manager.lock().unwrap().save_settings(&settings);
        });
    }

    /// Keeps the agent's list of providers, so Settings can show it before
    /// any project is open.
    fn remember_providers(&mut self, id: &str) {
        let Some(tab) = self.tabs.get(id) else { return };
        let known: Vec<(String, String)> = tab
            .integrations
            .iter()
            .filter(|i| i["methods"].as_array().is_some_and(|m| m.iter().any(|x| x["type"] == "key")))
            .map(|i| (text(i, "id"), text(i, "name")))
            .collect();
        if !known.is_empty() && known != self.settings.known {
            self.settings.known = known;
            self.save_settings();
        }
    }

    /// Makes a project's agent hold exactly the provider keys in Settings:
    /// gives it the ones it lacks or that changed, takes back the rest.
    fn reconcile(&mut self, id: &str) {
        let Some(tab) = self.tabs.get_mut(id) else { return };
        tab.reconciled = true;
        let wanted: Vec<(String, String, String)> = self.settings.providers.iter().map(|p| (p.id.clone(), p.key.clone(), crate::efs::sha256_hex(p.key.as_bytes())[..16].to_string())).collect();
        let connected: Vec<(String, Vec<String>)> = tab
            .integrations
            .iter()
            .map(|i| (text(i, "id"), i["connections"].as_array().into_iter().flatten().filter(|c| c["type"] == "credential").map(|c| text(c, "id")).collect::<Vec<_>>()))
            .filter(|(_, credentials)| !credentials.is_empty())
            .collect();
        let (client, shared, mut applied, tx, project) = (tab.client.clone(), tab.shared.clone(), tab.applied.clone(), self.tx.clone(), id.to_string());
        request(&self.tx, &self.ctx, id, move || {
            let mut problems = Vec::new();
            for (provider, credentials) in &connected {
                if !wanted.iter().any(|w| &w.0 == provider) {
                    for c in credentials {
                        let _ = client.disconnect(c);
                    }
                }
            }
            applied.retain(|provider, _| wanted.iter().any(|w| &w.0 == provider));
            for (provider, key, fingerprint) in &wanted {
                let held = connected.iter().find(|c| &c.0 == provider);
                if held.is_some() && applied.get(provider) == Some(fingerprint) {
                    continue;
                }
                for c in held.map(|h| h.1.as_slice()).unwrap_or_default() {
                    let _ = client.disconnect(c);
                }
                match client.connect_key(provider, key) {
                    Ok(()) => {
                        applied.insert(provider.clone(), fingerprint.clone());
                    }
                    Err(e) => problems.push(format!("Could not connect {provider}: {e}")),
                }
            }
            let _ = tx.send(Msg::Applied { id: project, applied });
            shared.refresh.store(true, Ordering::SeqCst);
            if problems.is_empty() {
                Ok(())
            } else {
                Err(problems.join("\n"))
            }
        });
    }

    /// After Settings changed: bring every open project's agent in line.
    fn settings_changed(&mut self) {
        self.save_settings();
        for id in self.tabs.keys().cloned().collect::<Vec<_>>() {
            if self.tabs[&id].integrations.is_empty() {
                self.tabs.get_mut(&id).unwrap().reconciled = false;
            } else {
                self.reconcile(&id);
            }
        }
    }

    /// Restarts every open project's agent with the current settings.
    fn reopen_all(&mut self) {
        let ids: Vec<String> = self.tabs.keys().cloned().collect();
        for id in &ids {
            if let Some(tab) = self.tabs.remove(id) {
                tab.shared.stop.store(true, Ordering::SeqCst);
            }
            self.busy.insert(id.clone());
        }
        let wanted = self.settings.agent_part();
        self.started_with = Some(wanted);
        let (manager, tx, ctx) = (self.manager.clone(), self.tx.clone(), self.ctx.clone());
        std::thread::spawn(move || {
            let mut m = manager.lock().unwrap();
            let mut problems = Vec::new();
            for id in &ids {
                if let Err(e) = m.reopen(id) {
                    problems.push(format!("{id}: {e}"));
                }
            }
            let _ = tx.send(Msg::Projects(m.list().unwrap_or_default()));
            for id in ids {
                let _ = tx.send(Msg::Done { id, result: if problems.is_empty() { Ok("Reopened with the new settings.".into()) } else { Err(problems.join("\n")) } });
            }
            ctx.request_repaint();
        });
    }

    /// Locks everything and asks for the passphrase again.
    fn lock_app(&mut self) {
        let (manager, tx, ctx) = (self.manager.clone(), self.tx.clone(), self.ctx.clone());
        for tab in self.tabs.values() {
            tab.shared.stop.store(true, Ordering::SeqCst);
        }
        std::thread::spawn(move || {
            manager.lock().unwrap().logout();
            let _ = tx.send(Msg::LoggedOut);
            ctx.request_repaint();
        });
    }

    /// Opens a project whose secret the app's vault holds.
    fn open_project(&mut self, id: &str) {
        let target = id.to_string();
        self.run(id, move |m| m.open(&target).map(|()| String::new()));
    }

    fn take_messages(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                Msg::Projects(list) => {
                    self.projects = list;
                    if !self.projects.iter().any(|p| p.open) {
                        self.started_with = None;
                    } else if self.started_with.is_none() {
                        self.started_with = Some(self.settings.agent_part());
                    }
                    for p in &self.projects {
                        if p.open && !self.tabs.contains_key(&p.id) {
                            if let Some(mut tab) = Tab::new(&p.id, p, &self.tx, &self.ctx) {
                                if tab.model.is_none() {
                                    tab.model = self.settings.model.clone();
                                }
                                self.tabs.insert(p.id.clone(), tab);
                            }
                        }
                    }
                    let open: BTreeSet<&str> = self.projects.iter().filter(|p| p.open).map(|p| p.id.as_str()).collect();
                    self.tabs.retain(|id, tab| {
                        let keep = open.contains(id.as_str());
                        if !keep {
                            tab.shared.stop.store(true, Ordering::SeqCst);
                        }
                        keep
                    });
                    if !self.projects.iter().any(|p| p.id == self.selected) {
                        self.selected = self.projects.first().map(|p| p.id.clone()).unwrap_or_default();
                    }
                    if self.projects.is_empty() && self.logged_in {
                        self.creating = true;
                    }
                }
                Msg::Done { id, result } => {
                    self.busy.remove(&id);
                    self.status = result.unwrap_or_else(|e| e);
                }
                Msg::Created(result) => {
                    self.new_busy = false;
                    match result {
                        Ok(id) => {
                            self.selected = id;
                            self.creating = false;
                            self.new_name.clear();
                            self.new_error.clear();
                        }
                        Err(e) => self.new_error = e,
                    }
                }
                Msg::LoggedIn(result) => {
                    self.login_busy = false;
                    match result {
                        Ok(settings) => {
                            self.settings = settings;
                            self.logged_in = true;
                            self.has_login = true;
                            self.login_error.clear();
                            self.creating = self.projects.is_empty();
                        }
                        Err(e) => self.login_error = e,
                    }
                }
                Msg::LoggedOut => {
                    for tab in self.tabs.values() {
                        tab.shared.stop.store(true, Ordering::SeqCst);
                    }
                    self.tabs.clear();
                    self.projects.clear();
                    self.settings = Settings::default();
                    self.logged_in = false;
                    self.show_settings = false;
                    self.dialog = None;
                    self.busy.clear();
                }
                Msg::Applied { id, applied } => {
                    if let Some(tab) = self.tabs.get_mut(&id) {
                        tab.applied = applied;
                        tab.save_prefs();
                    }
                }
                Msg::Unlocked { id, error } => {
                    self.busy.remove(&id);
                    if id == self.selected {
                        self.pass_error = error.unwrap_or_default();
                    }
                }
                Msg::Sessions { id, list } => {
                    if let Some(tab) = self.tabs.get_mut(&id) {
                        let current = tab.session();
                        // A remembered chat that no longer exists gives way to the newest one.
                        if !list.iter().any(|s| s["id"] == current.as_str()) {
                            let newest = list.first().map(|s| text(s, "id")).unwrap_or_default();
                            if newest != current {
                                tab.select(&newest);
                            }
                        }
                        tab.sessions = list;
                    }
                }
                Msg::Messages { id, session, list } => {
                    if let Some(tab) = self.tabs.get_mut(&id) {
                        if tab.session() == session {
                            tab.messages = list;
                            // Streamed text gives way to the stored text once there is some.
                            let stored = |message: &str, ordinal: u64| {
                                tab.messages.iter().find(|m| m["id"] == message).and_then(|m| m["content"].get(ordinal as usize)).and_then(|p| p["text"].as_str()).is_some_and(|t| !t.is_empty())
                            };
                            let working = tab.working();
                            tab.live.retain(|(message, ordinal), _| working && !stored(message, *ordinal));
                        }
                    }
                }
                Msg::Delta { id, session, message, ordinal, reasoning, delta } => {
                    if let Some(tab) = self.tabs.get_mut(&id) {
                        if tab.session() == session {
                            #[cfg(feature = "selftest")]
                            if !tab.live.contains_key(&(message.clone(), ordinal)) {
                                eprintln!("selftest: streaming {} part {ordinal} of {message}", if reasoning { "thinking" } else { "text" });
                            }
                            tab.live.entry((message, ordinal)).or_insert_with(|| (reasoning, String::new())).1.push_str(&delta);
                        }
                    }
                }
                Msg::Permissions { id, list } => {
                    if let Some(tab) = self.tabs.get_mut(&id) {
                        tab.permissions = list;
                    }
                }
                Msg::Models { id, list } => {
                    let default = self.settings.model.clone();
                    if let Some(tab) = self.tabs.get_mut(&id) {
                        tab.models = list.into_iter().filter(|m| m["type"].as_str().unwrap_or("chat") == "chat").collect();
                        let known = |m: &(String, String)| tab.models.iter().any(|x| x["providerID"] == m.0.as_str() && x["id"] == m.1.as_str());
                        // An empty list only means the agent has no provider key yet: keep the choice.
                        if !tab.models.is_empty() && tab.model.as_ref().is_some_and(|m| !known(m)) {
                            tab.model = None;
                        }
                        if tab.model.is_none() && default.as_ref().is_some_and(known) {
                            tab.model = default;
                            tab.save_prefs();
                        }
                    }
                }
                Msg::Integrations { id, list } => {
                    let mut ready = false;
                    if let Some(tab) = self.tabs.get_mut(&id) {
                        ready = !list.is_empty() && !tab.reconciled;
                        tab.integrations = list;
                    }
                    if ready {
                        self.remember_providers(&id);
                        self.reconcile(&id);
                    }
                }
                Msg::Commands { id, names } => {
                    if let Some(tab) = self.tabs.get_mut(&id) {
                        tab.commands = names;
                    }
                }
                Msg::Started { id, session } => {
                    if let Some(tab) = self.tabs.get_mut(&id) {
                        tab.select(&session);
                        tab.shared.refresh.store(true, Ordering::SeqCst);
                    }
                }
                Msg::Picked { id, folder, paths } => match (folder, paths) {
                    (false, Some(paths)) => {
                        if let Some(tab) = self.tabs.get_mut(&id) {
                            for p in paths {
                                if !tab.attachments.contains(&p) {
                                    tab.attachments.push(p);
                                }
                            }
                        }
                    }
                    // No file chooser on this system: the one built in.
                    (false, None) => {
                        if let Some(tab) = self.tabs.get(&id) {
                            let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| tab.client.host_dir().to_path_buf());
                            self.dialog = Some(attach_dialog(&id, home));
                        }
                    }
                    (true, Some(paths)) => {
                        if let (Some(chosen), Some(Dialog::Export { dir, .. } | Dialog::Import { dir, .. })) = (paths.into_iter().next(), self.dialog.as_mut()) {
                            *dir = chosen.to_string_lossy().into_owned();
                        }
                    }
                    (true, None) => {
                        if let Some(tab) = self.tabs.get_mut(&id) {
                            tab.notice = "No file chooser was found (zenity or kdialog). Type the folder's path instead.".into();
                        }
                    }
                },
                Msg::Notice { id, text } => {
                    #[cfg(feature = "selftest")]
                    eprintln!("selftest: notice: {text}");
                    if let Some(tab) = self.tabs.get_mut(&id) {
                        tab.notice = text;
                    }
                }
            }
        }
    }

    fn tab_bar(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            ui.label(RichText::new("AnonCode").strong().weak());
            ui.separator();
            let mut select = None;
            for p in &self.projects {
                // A closed project's name is dimmed (the default font has no
                // lock symbol); one being opened or closed gets an ellipsis.
                let name = clip(&p.name, 28);
                let label = if self.busy.contains(&p.id) {
                    RichText::new(format!("{name} …"))
                } else if p.open {
                    RichText::new(name)
                } else {
                    RichText::new(name).weak().italics()
                };
                let r = ui
                    .selectable_label(!self.creating && p.id == self.selected, label)
                    .on_hover_text(format!("{} ({}). Double-click to rename, right-click for more.", p.name, if p.open { "unlocked" } else { "locked" }));
                if r.clicked() {
                    select = Some(p.id.clone());
                }
                if r.double_clicked() {
                    self.dialog = Some(Dialog::Rename { id: p.id.clone(), name: p.name.clone() });
                }
                r.context_menu(|ui| {
                    if ui.button("Rename…").clicked() {
                        self.dialog = Some(Dialog::Rename { id: p.id.clone(), name: p.name.clone() });
                        ui.close();
                    }
                    if ui.button("Delete…").clicked() {
                        self.dialog = Some(Dialog::Delete { id: p.id.clone(), name: p.name.clone(), typed: String::new() });
                        ui.close();
                    }
                });
            }
            if let Some(id) = select {
                let closed = self.projects.iter().any(|p| p.id == id && p.known && !p.open) && !self.busy.contains(&id);
                self.selected = id.clone();
                self.creating = false;
                self.pass.zeroize();
                self.pass_error.clear();
                if closed {
                    self.open_project(&id);
                }
            }
            if ui.selectable_label(self.creating, " + ").on_hover_text("New project").clicked() {
                self.creating = true;
            }
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                self.settings_button(ui);
                ui.separator();
                let id = self.selected.clone();
                if !self.creating && self.tabs.contains_key(&id) {
                    let idle = !self.busy.contains(&id);
                    if ui.add_enabled(idle, egui::Button::new("Lock")).on_hover_text("Seal everything, stop the agent and wipe the plaintext copy").clicked() {
                        let target = id.clone();
                        self.run(&id, move |m| m.lock(&target).map(|()| "Locked.".to_string()));
                    }
                    if ui.add_enabled(idle, egui::Button::new("Export")).on_hover_text("Decrypt this project's files to a folder").clicked() {
                        self.dialog = Some(Dialog::Export { id: id.clone(), dir: "~/".into() });
                    }
                    if ui.add_enabled(idle, egui::Button::new("Import")).on_hover_text("Copy a folder into this project").clicked() {
                        self.dialog = Some(Dialog::Import { id: id.clone(), dir: "~/".into() });
                    }
                    if ui.add_enabled(idle, egui::Button::new("Save to vault")).on_hover_text("Seal the project's current files and chats now").clicked() {
                        let target = id.clone();
                        self.run(&id, move |m| {
                            let s = m.seal(&target)?;
                            let left = if s.skipped.is_empty() { String::new() } else { format!(", {} left out (too large or unreadable)", s.skipped.len()) };
                            Ok(format!("Saved to vault: {} files changed, {} removed{left}.", s.changed, s.deleted))
                        });
                    }
                }
                ui.label(RichText::new(clip(&self.status, 90)).weak());
            });
        });
        ui.separator();
    }

    /// The far end of the tab bar: Settings, for the whole app.
    fn settings_button(&mut self, ui: &mut Ui) {
        if ui.selectable_label(self.show_settings, "Settings").on_hover_text("Provider keys and the lock, for every project").clicked() {
            self.show_settings = !self.show_settings;
        }
    }

    fn create_form(&mut self, ui: &mut Ui) {
        ui.vertical_centered(|ui| {
            ui.set_max_width(380.0);
            ui.add_space(60.0);
            ui.heading("New project");
            ui.label(RichText::new("A project is its own encrypted vault. It opens with your AnonCode passphrase; there is nothing else to remember.").weak());
            ui.add_space(8.0);
            let field = ui.add(TextEdit::singleline(&mut self.new_name).hint_text("Name (shown on the tab, not encrypted)").desired_width(f32::INFINITY));
            edit_menu(&field, &mut self.new_name, false);
            let enter = field.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
            if !self.new_busy && self.new_name.is_empty() && !field.has_focus() {
                field.request_focus();
            }
            if !self.new_error.is_empty() {
                ui.colored_label(ui.visuals().error_fg_color, &self.new_error);
            }
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                let go = ui.add_enabled(!self.new_busy, egui::Button::new(if self.new_busy { "Creating…" } else { "Create" })).clicked();
                if !self.projects.is_empty() && ui.button("Cancel").clicked() {
                    self.creating = false;
                }
                if (go || enter || std::mem::take(&mut self.press_create)) && !self.new_busy {
                    self.new_busy = true;
                    self.new_error.clear();
                    let (manager, tx, ctx, name) = (self.manager.clone(), self.tx.clone(), self.ctx.clone(), self.new_name.clone());
                    std::thread::spawn(move || {
                        let mut m = manager.lock().unwrap();
                        let result = m.create(&name).map_err(|e| e.to_string());
                        let _ = tx.send(Msg::Projects(m.list().unwrap_or_default()));
                        let _ = tx.send(Msg::Created(result));
                        ctx.request_repaint();
                    });
                }
            });
        });
    }

    /// The first screen: set the app's passphrase, or give it.
    fn login_form(&mut self, ui: &mut Ui) {
        ui.vertical_centered(|ui| {
            ui.set_max_width(380.0);
            ui.add_space(110.0);
            ui.heading("AnonCode");
            ui.label(RichText::new(if self.has_login {
                "Everything is encrypted. Enter your passphrase to open it."
            } else {
                "Choose a passphrase. It unlocks every project, your provider keys and your settings. There is no recovery: if it is lost, everything is."
            }).weak());
            ui.add_space(8.0);
            let first = ui.add_enabled(!self.login_busy, TextEdit::singleline(&mut self.login_pass).password(true).hint_text("Passphrase").desired_width(f32::INFINITY));
            edit_menu(&first, &mut self.login_pass, true);
            let mut enter = first.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) && self.has_login;
            if !self.has_login {
                let again = ui.add_enabled(!self.login_busy, TextEdit::singleline(&mut self.login_pass2).password(true).hint_text("Passphrase again").desired_width(f32::INFINITY));
                edit_menu(&again, &mut self.login_pass2, true);
                enter = again.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
            } else if !self.login_busy && self.login_pass.is_empty() && !first.has_focus() {
                first.request_focus();
            }
            if !self.login_error.is_empty() {
                ui.colored_label(ui.visuals().error_fg_color, &self.login_error);
            }
            ui.add_space(6.0);
            let label = match (self.login_busy, self.has_login) {
                (true, _) => "Opening…",
                (false, true) => "Unlock",
                (false, false) => "Set passphrase",
            };
            let go = ui.add_enabled(!self.login_busy, egui::Button::new(label)).clicked();
            if (go || enter || std::mem::take(&mut self.press_login)) && !self.login_busy && !self.login_pass.is_empty() {
                if !self.has_login && self.login_pass.chars().count() < 8 {
                    self.login_error = "Use a passphrase of at least 8 characters.".into();
                } else if !self.has_login && self.login_pass != self.login_pass2 {
                    self.login_error = "The two passphrases don't match.".into();
                } else {
                    self.login_busy = true;
                    self.login_error.clear();
                    let (manager, tx, ctx, setup) = (self.manager.clone(), self.tx.clone(), self.ctx.clone(), !self.has_login);
                    let mut pass = std::mem::take(&mut self.login_pass);
                    self.login_pass2.zeroize();
                    std::thread::spawn(move || {
                        let mut m = manager.lock().unwrap();
                        let result = if setup { m.setup(&pass) } else { m.login(&pass) };
                        pass.zeroize();
                        let result = result.and_then(|()| m.settings()).map_err(|e| match e {
                            crate::Error::WrongPassphrase => "Wrong passphrase.".to_string(),
                            other => other.to_string(),
                        });
                        if result.is_ok() {
                            let _ = tx.send(Msg::Projects(m.list().unwrap_or_default()));
                        }
                        let _ = tx.send(Msg::LoggedIn(result));
                        ctx.request_repaint();
                    });
                }
            }
        });
    }

    /// Settings for the whole app, apart from any project.
    fn settings_window(&mut self, ctx: &egui::Context) {
        if !self.show_settings {
            return;
        }
        let mut open = true;
        let mut changed = false;
        let mut logout = false;
        let mut reopen = false;
        egui::Window::new("Settings").open(&mut open).collapsible(false).resizable(false).anchor(egui::Align2::CENTER_CENTER, [0.0, -20.0]).show(ctx, |ui| {
            ui.set_width(460.0);
            ui.strong("Model providers");
            ui.label(RichText::new("Add a provider's API key once. It is sealed in AnonCode's vault and used by every project.").weak());
            ui.add_space(4.0);
            let mut remove = None;
            for (i, p) in self.settings.providers.iter().enumerate() {
                ui.horizontal(|ui| {
                    let name = self.settings.known.iter().find(|k| k.0 == p.id).map(|k| k.1.clone()).unwrap_or_else(|| p.id.clone());
                    let tail: String = p.key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
                    ui.label(format!("{name}   key ending {tail}"));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        if ui.small_button("Remove").clicked() {
                            remove = Some(i);
                        }
                    });
                });
            }
            if self.settings.providers.is_empty() {
                ui.label(RichText::new("None yet. Without one there are no models to choose.").weak());
            }
            if let Some(i) = remove {
                self.settings.providers.remove(i).key.zeroize();
                changed = true;
            }
            ui.separator();
            ui.label("Add a provider");
            let field = ui.add(TextEdit::singleline(&mut self.set_filter).hint_text("Search, or type a provider id (venice, openrouter, ollama…)").desired_width(f32::INFINITY));
            edit_menu(&field, &mut self.set_filter, false);
            let needle = self.set_filter.trim().to_lowercase();
            // Until an agent has run once, only a short list is known.
            let builtin = [("venice", "Venice AI"), ("openrouter", "OpenRouter"), ("openai", "OpenAI"), ("groq", "Groq"), ("deepseek", "DeepSeek"), ("mistral", "Mistral"), ("xai", "xAI")];
            let mut known: Vec<(String, String)> = if self.settings.known.is_empty() { builtin.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() } else { self.settings.known.clone() };
            // The common ones first, then the rest by name.
            let first = ["venice", "openrouter", "anthropic", "openai", "google", "deepseek", "groq", "mistral", "xai", "ollama", "lmstudio"];
            known.sort_by_key(|(id, name)| (first.iter().position(|f| f == id).unwrap_or(first.len()), name.to_lowercase()));
            ScrollArea::vertical().max_height(170.0).auto_shrink([false, true]).show(ui, |ui| {
                for (id, name) in known.iter().filter(|(id, name)| needle.is_empty() || id.contains(&needle) || name.to_lowercase().contains(&needle)) {
                    if ui.selectable_label(self.set_chosen == *id, name).clicked() {
                        self.set_chosen = id.clone();
                    }
                }
                if !needle.is_empty() && !known.iter().any(|(id, _)| *id == needle) && ui.selectable_label(self.set_chosen == needle, format!("Use the id \"{needle}\"")).clicked() {
                    self.set_chosen = needle.clone();
                }
            });
            if !self.set_chosen.is_empty() {
                ui.add_space(4.0);
                ui.label(format!("API key for {}:", self.set_chosen));
                let field = ui.add(TextEdit::singleline(&mut self.set_key).password(true).hint_text("Paste the key (Ctrl+V)").desired_width(f32::INFINITY));
                edit_menu(&field, &mut self.set_key, true);
                if ui.add_enabled(!self.set_key.trim().is_empty(), egui::Button::new("Save key")).clicked() {
                    let key = std::mem::take(&mut self.set_key).trim().to_string();
                    let id = std::mem::take(&mut self.set_chosen);
                    self.settings.providers.retain(|p| p.id != id);
                    self.settings.providers.push(Provider { id, key });
                    self.set_filter.clear();
                    changed = true;
                }
            }
            ui.separator();
            ui.strong("The agent");
            let before = self.settings.agent_part();
            ui.checkbox(&mut self.settings.sandbox, "Run the agent in a sandbox (bubblewrap)")
                .on_hover_text("It sees only the project and its own data, never your home folder, and starts with none of your environment. Turn off only if a tool you need can't work inside it.");
            if !self.settings.sandbox {
                ui.colored_label(ui.visuals().warn_fg_color, "Without the sandbox the agent can read and change everything your account can.");
            }
            ui.horizontal(|ui| {
                ui.label("Fetching web pages:");
                for (label, value) in [("Off", Access::Off), ("Ask each time", Access::Ask), ("Allowed", Access::Allow)] {
                    ui.radio_value(&mut self.settings.web_fetch, value, label);
                }
            });
            ui.horizontal(|ui| {
                ui.label("Commands and file changes:");
                ui.radio_value(&mut self.settings.approvals, Approvals::Auto, "Just do them");
                ui.radio_value(&mut self.settings.approvals, Approvals::Ask, "Ask me first");
            });
            ui.checkbox(&mut self.settings.focus, "FOCUS: leave out old, low-value parts of long chats")
                .on_hover_text("Nothing is summarised or changed in the chat; old tool output is simply not sent again. Your messages, errors and recent work always stay.");
            ui.add_enabled_ui(self.settings.focus, |ui| {
                ui.horizontal(|ui| {
                    ui.label("Start when a chat fills");
                    ui.add(egui::Slider::new(&mut self.settings.focus_share, 30..=90).suffix("%"));
                    ui.label("of the model's context");
                });
                ui.horizontal(|ui| {
                    ui.label("Decides with:");
                    ui.radio_value(&mut self.settings.focus_draft, FocusDraft::Model, "the chat's model")
                        .on_hover_text("The FOCUS paper's method: the model drafts plans of the next steps, each citing the parts of the chat it needs, then reviews what would be left out. A few extra model calls each time a chat is compressed.");
                    ui.radio_value(&mut self.settings.focus_draft, FocusDraft::Quick, "a quick offline guess")
                        .on_hover_text("Word overlap with your request, recency and errors. No extra calls, less precise.");
                });
                ui.add_enabled_ui(self.settings.focus_draft == FocusDraft::Model, |ui| {
                    ui.horizontal(|ui| {
                        ui.label("Plans drafted each time");
                        ui.add(egui::Slider::new(&mut self.settings.focus_rollouts, 1..=5));
                    });
                });
            });
            ui.checkbox(&mut self.settings.tool_cache, "Keep build caches between sessions (sealed)")
                .on_hover_text("cargo's registry, npm, bun, pip and Go caches and downloaded tools are kept on disk with each project and sealed when it locks, so big builds don't start from nothing each time. Off: they live in memory and are gone when the project locks.");
            if self.settings.agent_part() != before {
                changed = true;
            }
            if self.started_with.is_some_and(|s| s != self.settings.agent_part()) {
                ui.horizontal(|ui| {
                    ui.colored_label(ui.visuals().warn_fg_color, "Open projects still use the old settings.");
                    if ui.button("Reopen them now").on_hover_text("Each open project is saved to its vault and its agent restarted").clicked() {
                        reopen = true;
                    }
                });
            }
            ui.separator();
            ui.strong("Lock");
            ui.horizontal(|ui| {
                ui.label("Lock AnonCode after");
                let mut minutes = self.settings.auto_lock_minutes;
                egui::ComboBox::from_id_salt("autolock").selected_text(if minutes == 0 { "never".to_string() } else { format!("{minutes} minutes idle") }).show_ui(ui, |ui| {
                    for m in [0u32, 5, 15, 30, 60] {
                        ui.selectable_value(&mut minutes, m, if m == 0 { "never".to_string() } else { format!("{m} minutes idle") });
                    }
                });
                if minutes != self.settings.auto_lock_minutes {
                    self.settings.auto_lock_minutes = minutes;
                    changed = true;
                }
            });
            ui.horizontal(|ui| {
                if ui.button("Lock AnonCode").on_hover_text("Seal and close every project and ask for the passphrase again").clicked() {
                    logout = true;
                }
                ui.label(RichText::new("Closing the window does the same.").weak());
            });
        });
        if changed {
            self.settings_changed();
        }
        if reopen {
            self.reopen_all();
        }
        if logout {
            self.lock_app();
        }
        if !open || ctx.input(|i| i.key_pressed(Key::Escape)) {
            self.show_settings = false;
        }
    }

    fn locked_form(&mut self, ui: &mut Ui) {
        let Some(project) = self.projects.iter().find(|p| p.id == self.selected).cloned() else { return };
        let busy = self.busy.contains(&project.id);
        ui.vertical_centered(|ui| {
            ui.set_max_width(380.0);
            ui.add_space(80.0);
            ui.heading(&project.name);
            if project.known {
                ui.label(RichText::new("Closed. Everything in it is encrypted on disk.").weak());
                ui.add_space(8.0);
                let go = ui.add_enabled(!busy, egui::Button::new(if busy { "Opening…" } else { "Open" })).clicked();
                if busy {
                    ui.spinner();
                }
                if (go || ui.input(|i| i.key_pressed(Key::Enter))) && !busy {
                    self.open_project(&project.id);
                }
                return;
            }
            ui.label(RichText::new("This project was made before AnonCode had a single login and still has its own passphrase. Enter it once; after that it opens with the others.").weak());
            ui.add_space(8.0);
            let field = ui.add_enabled(!busy, TextEdit::singleline(&mut self.pass).password(true).hint_text("Passphrase").desired_width(f32::INFINITY));
            edit_menu(&field, &mut self.pass, true);
            let enter = field.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
            if !self.pass_error.is_empty() {
                ui.colored_label(ui.visuals().error_fg_color, &self.pass_error);
            }
            ui.add_space(6.0);
            let go = ui.add_enabled(!busy, egui::Button::new(if busy { "Unlocking…" } else { "Unlock" })).clicked();
            if busy {
                ui.spinner();
            } else if !field.has_focus() && self.pass.is_empty() {
                field.request_focus();
            }
            if (go || enter || std::mem::take(&mut self.press_unlock)) && !busy && !self.pass.is_empty() {
                self.busy.insert(project.id.clone());
                self.pass_error.clear();
                let (manager, tx, ctx, id) = (self.manager.clone(), self.tx.clone(), self.ctx.clone(), project.id.clone());
                let mut pass = std::mem::take(&mut self.pass);
                std::thread::spawn(move || {
                    let mut m = manager.lock().unwrap();
                    let error = m.unlock(&id, &pass).err().map(|e| match e {
                        crate::Error::WrongPassphrase => "Wrong passphrase.".to_string(),
                        other => other.to_string(),
                    });
                    pass.zeroize();
                    let _ = tx.send(Msg::Projects(m.list().unwrap_or_default()));
                    let _ = tx.send(Msg::Unlocked { id, error });
                    ctx.request_repaint();
                });
            }
        });
    }

    fn chat(&mut self, ui: &mut Ui) {
        let id = self.selected.clone();
        let (tx, ctx) = (self.tx.clone(), self.ctx.clone());
        let mut open_dialog = None;
        let mut picked: Option<(String, String)> = None;
        let Some(tab) = self.tabs.get_mut(&id) else { return };
        let height = ui.available_height();
        ui.horizontal_top(|ui| {
            // The project's chats.
            ui.allocate_ui_with_layout(egui::vec2(200.0, height), Layout::top_down(Align::Min), |ui| {
                if ui.add_sized([200.0, 24.0], egui::Button::new("+ New chat")).clicked() {
                    tab.select("");
                }
                ui.add_space(4.0);
                ScrollArea::vertical().id_salt("chats").auto_shrink(false).show(ui, |ui| {
                    let current = tab.session();
                    let mut pick = None;
                    let mut remove = None;
                    for s in &tab.sessions {
                        let sid = text(s, "id");
                        let title = s["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("New chat");
                        let r = ui.add_sized([192.0, 22.0], egui::Button::selectable(sid == current, clip(title, 30)).truncate());
                        if r.clicked() {
                            pick = Some(sid.clone());
                        }
                        r.context_menu(|ui| {
                            if ui.button("Delete chat").clicked() {
                                remove = Some(sid.clone());
                                ui.close();
                            }
                        });
                    }
                    if let Some(sid) = pick {
                        tab.select(&sid);
                    }
                    if let Some(sid) = remove {
                        let (client, shared) = (tab.client.clone(), tab.shared.clone());
                        request(&tx, &ctx, &id, move || {
                            client.delete_session(&sid)?;
                            shared.refresh.store(true, Ordering::SeqCst);
                            Ok(())
                        });
                    }
                });
            });
            ui.separator();
            ui.allocate_ui_with_layout(egui::vec2(ui.available_width(), height), Layout::top_down(Align::Min), |ui| {
                // Model, providers, loop.
                ui.horizontal(|ui| {
                    let shown = tab.model.as_ref().map(|(p, m)| format!("{p} / {m}")).unwrap_or_else(|| if tab.models.is_empty() { "No model: add a provider key in Settings".into() } else { "Choose a model".into() });
                    let before = tab.model.clone();
                    egui::ComboBox::from_id_salt("model").selected_text(clip(&shown, 46)).width(300.0).height(420.0).show_ui(ui, |ui| {
                        for m in &tab.models {
                            let pair = (text(m, "providerID"), text(m, "id"));
                            let label = format!("{} / {}", pair.0, m["name"].as_str().unwrap_or(&pair.1));
                            if ui.selectable_label(tab.model.as_ref() == Some(&pair), label).clicked() {
                                tab.model = Some(pair);
                            }
                        }
                    });
                    if tab.model != before {
                        picked = tab.model.clone();
                        tab.save_prefs();
                        let session = tab.session();
                        if let (false, Some((p, m))) = (session.is_empty(), tab.model.clone()) {
                            let client = tab.client.clone();
                            request(&tx, &ctx, &id, move || client.set_model(&session, &p, &m));
                        }
                    }
                    if ui.button("Loop…").on_hover_text("A reviewer that checks each turn and tells the agent what to do next").clicked() {
                        open_dialog = Some(Dialog::Loop { id: id.clone(), review: String::new(), time: String::new() });
                    }
                    if tab.working() {
                        ui.spinner();
                        ui.label(RichText::new("working").weak());
                    }
                });
                ui.separator();

                let composer_height = 108.0 + if tab.attachments.is_empty() { 0.0 } else { 28.0 } + if tab.permissions.is_empty() { 0.0 } else { 64.0 } + if tab.notice.is_empty() { 0.0 } else { 40.0 };
                let scroll = ScrollArea::vertical().id_salt("timeline").auto_shrink(false).max_height((ui.available_height() - composer_height).max(80.0)).stick_to_bottom(true);
                let to_bottom = std::mem::take(&mut tab.to_bottom);
                scroll.show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    if tab.messages.is_empty() {
                        ui.add_space(40.0);
                        ui.vertical_centered(|ui| ui.label(RichText::new(if tab.session().is_empty() { "A new chat. Type below to start." } else { "…" }).weak()));
                    }
                    for (i, m) in tab.messages.iter().enumerate() {
                        ui.push_id(i, |ui| message(ui, m, &tab.live));
                    }
                    // A reply streaming before its message is stored.
                    for ((mid, _), (reasoning, body)) in &tab.live {
                        if !tab.messages.iter().any(|m| m["id"] == mid.as_str()) {
                            live_part(ui, *reasoning, body);
                        }
                    }
                    if to_bottom {
                        ui.scroll_to_cursor(Some(Align::BOTTOM));
                    }
                });

                // Waiting for a yes or no.
                let session = tab.session();
                for p in tab.permissions.iter().filter(|p| p["sessionID"] == session.as_str()).take(1) {
                    ui.group(|ui| {
                        let what = p["resources"].as_array().map(|r| r.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                        ui.label(format!("The agent asks to: {} {}", text(p, "action"), clip(&what, 200)));
                        ui.horizontal(|ui| {
                            for (label, decision) in [("Allow once", "once"), ("Always allow", "always"), ("Deny", "reject")] {
                                if ui.button(label).clicked() {
                                    let (client, session, request_id) = (tab.client.clone(), session.clone(), text(p, "id"));
                                    request(&tx, &ctx, &id, move || client.reply_permission(&session, &request_id, decision));
                                }
                            }
                        });
                    });
                }
                if !tab.notice.is_empty() {
                    ui.horizontal(|ui| {
                        if ui.small_button("x").clicked() {
                            tab.notice.clear();
                        }
                        ScrollArea::vertical().id_salt("notice").max_height(120.0).show(ui, |ui| ui.label(&tab.notice));
                    });
                }

                // The composer: one rounded box holding the files waiting to
                // go, the text, and a row with + (attach) on the left and a
                // single round button on the right that sends, or stops the
                // agent while it is working. Enter sends, Shift+Enter is a new line.
                let working = tab.working();
                let ready = !tab.composer.trim().is_empty() || !tab.attachments.is_empty();
                let sent = egui::Frame::new()
                    .fill(ui.visuals().extreme_bg_color)
                    .stroke(ui.visuals().widgets.noninteractive.bg_stroke)
                    .corner_radius(12.0)
                    .inner_margin(egui::Margin::symmetric(10, 8))
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        if !tab.attachments.is_empty() {
                            ui.horizontal_wrapped(|ui| {
                                let mut drop = None;
                                for (i, path) in tab.attachments.iter().enumerate() {
                                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                                    if ui.add(egui::Button::new(RichText::new(format!("{}   x", clip(&name, 40))).small()).corner_radius(10.0)).on_hover_text(format!("{}\nClick to remove.", path.display())).clicked() {
                                        drop = Some(i);
                                    }
                                }
                                if let Some(i) = drop {
                                    tab.attachments.remove(i);
                                }
                            });
                        }
                        let edit = ui.add(
                            TextEdit::multiline(&mut tab.composer)
                                .hint_text("Ask anything. /loop and /focus are commands.")
                                .desired_rows(2)
                                .desired_width(f32::INFINITY)
                                .frame(egui::Frame::NONE)
                                .return_key(egui::KeyboardShortcut::new(egui::Modifiers::SHIFT, Key::Enter)),
                        );
                        edit_menu(&edit, &mut tab.composer, false);
                        let mut send = edit.has_focus() && ui.input(|i| i.key_pressed(Key::Enter) && !i.modifiers.shift);
                        ui.horizontal(|ui| {
                            if round_button(ui, Icon::Plus, true).on_hover_text("Attach files. You can also drop files on the window.").clicked() {
                                pick(&tx, &ctx, &id, "Attach files", false);
                            }
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if working && !ready {
                                    if round_button(ui, Icon::Stop, true).on_hover_text("Stop the agent").clicked() {
                                        let (client, session) = (tab.client.clone(), tab.session());
                                        request(&tx, &ctx, &id, move || client.interrupt(&session));
                                    }
                                } else {
                                    send |= round_button(ui, Icon::Send, ready).on_hover_text(if working { "Send (the agent reads it at its next step)" } else { "Send (Enter)" }).clicked();
                                }
                            });
                        });
                        send
                    })
                    .inner;
                if (sent || std::mem::take(&mut tab.press_send)) && (!tab.composer.trim().is_empty() || !tab.attachments.is_empty()) {
                    let message = std::mem::take(&mut tab.composer).trim().to_string();
                    let command = message.strip_prefix('/').and_then(|rest| {
                        let (name, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
                        tab.commands.iter().any(|c| c == name).then(|| (name.to_string(), args.trim().to_string()))
                    });
                    if tab.model.is_none() {
                        tab.notice = "Choose a model first. If the list is empty, add a provider's API key in Settings (top right).".into();
                        tab.composer = message;
                    } else {
                        tab.notice.clear();
                        tab.to_bottom = true;
                        let (client, session, model, tx2, id2) = (tab.client.clone(), tab.session(), tab.model.clone(), tx.clone(), id.clone());
                        // Files go with a message; a command keeps them for the next one.
                        let files = if command.is_none() { std::mem::take(&mut tab.attachments) } else { Vec::new() };
                        request(&tx, &ctx, &id, move || {
                            let session = if session.is_empty() {
                                let created = client.create_session(model.as_ref().map(|(p, m)| (p.as_str(), m.as_str())))?;
                                let sid = text(&created, "id");
                                let _ = tx2.send(Msg::Started { id: id2, session: sid.clone() });
                                sid
                            } else {
                                session
                            };
                            match command {
                                Some((name, args)) => client.command(&session, &name, &args),
                                None => client.prompt(&session, &message, &files),
                            }
                        });
                    }
                }
            });
        });
        if open_dialog.is_some() {
            self.dialog = open_dialog;
        }
        if picked.is_some() && picked != self.settings.model {
            self.settings.model = picked;
            self.save_settings();
        }
    }

    fn dialogs(&mut self, ctx: &egui::Context) {
        let Some(mut dialog) = self.dialog.take() else { return };
        let mut keep = true;
        let mut open = true;
        let window = |title: &str| egui::Window::new(title.to_string()).collapsible(false).resizable(false).anchor(egui::Align2::CENTER_CENTER, [0.0, -40.0]);
        match &mut dialog {
            Dialog::Rename { id, name } => {
                window("Rename project").open(&mut open).show(ctx, |ui| {
                    let r = ui.add(TextEdit::singleline(name).desired_width(280.0));
                    edit_menu(&r, name, false);
                    r.request_focus();
                    let enter = ui.input(|i| i.key_pressed(Key::Enter));
                    if (ui.button("Rename").clicked() || enter) && !name.trim().is_empty() {
                        let (target, new_name) = (id.clone(), name.clone());
                        self.run(id, move |m| m.rename(&target, &new_name).map(|()| String::new()));
                        keep = false;
                    }
                });
            }
            Dialog::Delete { id, name, typed } => {
                window("Delete project").open(&mut open).show(ctx, |ui| {
                    ui.set_max_width(360.0);
                    ui.label(format!("This permanently deletes \"{name}\": its encrypted files, chats and settings. It cannot be undone."));
                    ui.label("Type the project's name to confirm:");
                    let field = ui.add(TextEdit::singleline(typed).desired_width(280.0));
                    edit_menu(&field, typed, false);
                    if ui.add_enabled(typed == name, egui::Button::new(RichText::new("Delete forever").color(ui.visuals().error_fg_color))).clicked() {
                        let target = id.clone();
                        self.run(id, move |m| m.delete(&target).map(|()| "Project deleted.".to_string()));
                        keep = false;
                    }
                });
            }
            Dialog::Export { id, dir } => {
                window("Export decrypted files").open(&mut open).show(ctx, |ui| {
                    ui.set_max_width(420.0);
                    ui.label("Writes this project's files, unencrypted, to a folder outside AnonCode. Use an absolute path or ~/…");
                    ui.horizontal(|ui| {
                        let field = ui.add(TextEdit::singleline(dir).desired_width(320.0));
                        edit_menu(&field, dir, false);
                        if ui.button("Choose…").clicked() {
                            pick(&self.tx, &self.ctx, id, "Export to this folder", true);
                        }
                    });
                    if ui.button("Export").clicked() {
                        let (target, to) = (id.clone(), dir.clone());
                        self.run(id, move |m| m.export(&target, &to).map(|n| format!("Exported {n} files to {to}.")));
                        keep = false;
                    }
                });
            }
            Dialog::Import { id, dir } => {
                window("Import a folder").open(&mut open).show(ctx, |ui| {
                    ui.set_max_width(420.0);
                    ui.label("Copies a folder's files into this project. Files with the same path are replaced. Use an absolute path or ~/…");
                    ui.horizontal(|ui| {
                        let field = ui.add(TextEdit::singleline(dir).desired_width(320.0));
                        edit_menu(&field, dir, false);
                        if ui.button("Choose…").clicked() {
                            pick(&self.tx, &self.ctx, id, "Import this folder", true);
                        }
                    });
                    if ui.button("Import").clicked() {
                        let (target, from) = (id.clone(), dir.clone());
                        self.run(id, move |m| m.import(&target, &from).map(|n| format!("Imported {n} files.")));
                        keep = false;
                    }
                });
            }
            Dialog::Attach { id, dir, typed, entries: list } => {
                let Some(tab) = self.tabs.get_mut(id) else { return };
                window("Attach files").open(&mut open).show(ctx, |ui| {
                    ui.set_width(480.0);
                    let mut go: Option<PathBuf> = None;
                    ui.horizontal(|ui| {
                        if ui.button("Up").clicked() {
                            go = dir.parent().map(PathBuf::from);
                        }
                        if ui.button("Project").on_hover_text("This project's files").clicked() {
                            go = Some(tab.client.host_dir().to_path_buf());
                        }
                        if ui.button("Home").clicked() {
                            go = std::env::var_os("HOME").map(PathBuf::from);
                        }
                        let field = ui.add(TextEdit::singleline(typed).hint_text("Folder or file path").desired_width(f32::INFINITY));
                        edit_menu(&field, typed, false);
                        if field.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)) {
                            let home = std::env::var("HOME").unwrap_or_default();
                            go = Some(PathBuf::from(typed.trim().replacen('~', &home, usize::from(typed.trim().starts_with('~')))));
                        }
                    });
                    ScrollArea::vertical().max_height(320.0).auto_shrink([false, false]).show(ui, |ui| {
                        if list.is_empty() {
                            ui.label(RichText::new("Nothing here (or the folder can't be read).").weak());
                        }
                        for (name, is_dir) in list.iter() {
                            let path = dir.join(name);
                            let chosen = tab.attachments.contains(&path);
                            let label = if *is_dir { format!("{name}/") } else { name.clone() };
                            if ui.selectable_label(chosen, label).clicked() {
                                go = Some(path);
                            }
                        }
                    });
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(format!("{} attached. Click a file to add or remove it.", tab.attachments.len())).weak());
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if ui.button("Done").clicked() {
                                keep = false;
                            }
                        });
                    });
                    match go {
                        Some(path) if path.is_dir() => {
                            *typed = path.to_string_lossy().into_owned();
                            *list = entries(&path);
                            *dir = path;
                        }
                        Some(path) if path.is_file() => match tab.attachments.iter().position(|p| *p == path) {
                            Some(i) => {
                                tab.attachments.remove(i);
                            }
                            None => tab.attachments.push(path),
                        },
                        _ => {}
                    }
                });
            }
            Dialog::Loop { id, review, time } => {
                let Some(tab) = self.tabs.get(id) else { return };
                let session = tab.session();
                window("Reviewer loop").open(&mut open).show(ctx, |ui| {
                    ui.set_width(440.0);
                    ui.label(RichText::new("After every turn a reviewer checks the work against your request and tells the agent the next step, until it is done or needs you. Everything it says appears in the chat as an ordinary message.").weak());
                    let field = ui.add(TextEdit::multiline(review).hint_text("What should the reviewer check? Leave empty for the default rules.").desired_rows(4).desired_width(f32::INFINITY));
                    edit_menu(&field, review, false);
                    ui.horizontal(|ui| {
                        ui.label("Stop after");
                        let field = ui.add(TextEdit::singleline(time).hint_text("no limit").desired_width(110.0));
                        edit_menu(&field, time, false);
                        ui.label(RichText::new("e.g. 30m, 2h, 1h30m, 5 hours").weak());
                    });
                    let limit = time.trim().to_string();
                    let send = |args: Vec<String>| {
                        let (client, session) = (tab.client.clone(), session.clone());
                        // In order: the time limit is set on the loop the first command started.
                        request(&self.tx, &self.ctx, id, move || args.iter().try_for_each(|a| client.command(&session, "loop", a)));
                    };
                    ui.add_enabled_ui(!session.is_empty(), |ui| {
                        ui.horizontal(|ui| {
                            if ui.button("Start").clicked() {
                                let mut args = vec![format!("start {}", review.trim())];
                                if !limit.is_empty() {
                                    args.push(format!("time {limit}"));
                                }
                                send(args);
                                keep = false;
                            }
                            if ui.add_enabled(!limit.is_empty(), egui::Button::new("Set time")).on_hover_text("Change the running loop's time limit, counted from now").clicked() {
                                send(vec![format!("time {limit}")]);
                                keep = false;
                            }
                            for (label, word) in [("Pause", "pause"), ("Resume", "resume"), ("Clear", "clear"), ("Status", "")] {
                                if ui.button(label).clicked() {
                                    send(vec![word.to_string()]);
                                    keep = false;
                                }
                            }
                        });
                    });
                    if session.is_empty() {
                        ui.label(RichText::new("Send a first message to start the chat, then start the loop.").weak());
                    }
                });
            }
        }
        if keep && open && !ctx.input(|i| i.key_pressed(Key::Escape)) {
            self.dialog = Some(dialog);
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Icon {
    Plus,
    Send,
    Stop,
}

/// A round button with a drawn icon: + is quiet, send and stop are solid.
fn round_button(ui: &mut Ui, icon: Icon, enabled: bool) -> egui::Response {
    let size = 28.0;
    let (rect, response) = ui.allocate_exact_size(egui::vec2(size, size), if enabled { egui::Sense::click() } else { egui::Sense::hover() });
    let visuals = ui.visuals();
    let hovered = enabled && response.hovered();
    let (fill, ink) = match icon {
        Icon::Plus => (if hovered { visuals.widgets.hovered.bg_fill } else { visuals.widgets.inactive.bg_fill }, visuals.text_color()),
        _ if !enabled => (visuals.widgets.inactive.bg_fill, visuals.weak_text_color()),
        _ => (if hovered { visuals.strong_text_color() } else { visuals.text_color() }, visuals.extreme_bg_color),
    };
    let painter = ui.painter();
    let c = rect.center();
    painter.circle_filled(c, size / 2.0, fill);
    let stroke = egui::Stroke::new(1.8, ink);
    match icon {
        Icon::Plus => {
            painter.line_segment([c - egui::vec2(5.5, 0.0), c + egui::vec2(5.5, 0.0)], stroke);
            painter.line_segment([c - egui::vec2(0.0, 5.5), c + egui::vec2(0.0, 5.5)], stroke);
        }
        Icon::Send => {
            // An arrow pointing up.
            painter.line_segment([c + egui::vec2(0.0, 6.0), c - egui::vec2(0.0, 6.0)], stroke);
            painter.line_segment([c - egui::vec2(0.0, 6.0), c + egui::vec2(-5.0, -1.0)], stroke);
            painter.line_segment([c - egui::vec2(0.0, 6.0), c + egui::vec2(5.0, -1.0)], stroke);
        }
        Icon::Stop => {
            painter.rect_filled(egui::Rect::from_center_size(c, egui::vec2(9.0, 9.0)), 2.0, ink);
        }
    }
    if enabled {
        response.on_hover_cursor(egui::CursorIcon::PointingHand)
    } else {
        response
    }
}

/// One entry of a chat. Every kind of entry is drawn: nothing the model
/// was sent is hidden.
fn message(ui: &mut Ui, m: &Value, live: &BTreeMap<(String, u64), (bool, String)>) {
    let weak = ui.visuals().weak_text_color();
    match m["type"].as_str().unwrap_or("") {
        "user" => {
            let from_loop = m["metadata"]["source"] == "loop";
            egui::Frame::group(ui.style()).fill(ui.visuals().faint_bg_color).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(RichText::new(if from_loop { "Reviewer loop" } else { "You" }).small().strong().color(if from_loop { Color32::from_rgb(214, 158, 46) } else { weak }));
                prose(ui, m["text"].as_str().unwrap_or(""));
                for file in m["files"].as_array().into_iter().flatten() {
                    let name = file["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("attachment");
                    ui.label(RichText::new(format!("Attached: {name}  ({})", file["mime"].as_str().unwrap_or("file"))).small().color(weak));
                }
            });
        }
        "assistant" => {
            let mid = text(m, "id");
            let content = m["content"].as_array().map(Vec::as_slice).unwrap_or_default();
            for (i, part) in content.iter().enumerate() {
                let streamed = live.get(&(mid.clone(), i as u64)).filter(|_| part["text"].as_str().is_none_or(str::is_empty));
                if let Some((reasoning, body)) = streamed {
                    live_part(ui, *reasoning, body);
                    continue;
                }
                match part["type"].as_str().unwrap_or("") {
                    "text" => {
                        let raw = part["text"].as_str().unwrap_or("");
                        let shown = crate::tidy::tidy(raw);
                        prose(ui, &shown);
                        if shown.trim().is_empty() && !raw.trim().is_empty() {
                            ui.label(RichText::new("(The model wrote a tool call as text instead of making it. It did not run.)").weak().small());
                        }
                    }
                    "reasoning" => {
                        let body = part["text"].as_str().unwrap_or("");
                        if !body.trim().is_empty() {
                            egui::CollapsingHeader::new(RichText::new("Thinking").weak().small()).id_salt(("think", i)).show(ui, |ui| {
                                copy_menu(ui.label(RichText::new(body).weak()), body);
                            });
                        }
                    }
                    "tool" => tool(ui, i, part),
                    _ => {}
                }
            }
            for ((_, _), (reasoning, body)) in live.range((mid.clone(), content.len() as u64)..).take_while(|((id, _), _)| *id == mid) {
                live_part(ui, *reasoning, body);
            }
            if let Some(error) = m["error"]["message"].as_str().or(m["error"]["name"].as_str()) {
                ui.colored_label(ui.visuals().error_fg_color, format!("The model request failed: {error}"));
            }
        }
        "synthetic" | "system" | "skill" => {
            let label = m["description"].as_str().filter(|d| !d.is_empty()).unwrap_or(if m["type"] == "system" { "System note" } else { "Automatic message" });
            egui::CollapsingHeader::new(RichText::new(label).weak().small()).id_salt("note").show(ui, |ui| {
                let body = m["text"].as_str().unwrap_or("");
                copy_menu(ui.label(RichText::new(body).weak()), body);
            });
        }
        "shell" => {
            egui::CollapsingHeader::new(RichText::new(format!("$ {}", clip(m["command"].as_str().unwrap_or(""), 90))).monospace().small()).id_salt("shell").show(ui, |ui| {
                let output = m["output"]["output"].as_str().unwrap_or("");
                copy_menu(ui.label(RichText::new(clip(output, 6000)).monospace().small()), output);
            });
        }
        "model-switched" => {
            ui.label(RichText::new(format!("Model: {} / {}", text(&m["model"], "providerID"), text(&m["model"], "id"))).weak().small());
        }
        "agent-switched" => {
            ui.label(RichText::new(format!("Agent: {}", text(m, "agent"))).weak().small());
        }
        "compaction" => {
            ui.label(RichText::new("The conversation was compacted here.").weak().small());
        }
        "idle" => {
            match m["outcome"].as_str() {
                Some("failed") => {
                    ui.colored_label(ui.visuals().error_fg_color, format!("Stopped with an error: {}", m["error"]["message"].as_str().unwrap_or("unknown")));
                }
                Some("interrupted") => {
                    ui.label(RichText::new("Stopped.").weak().small());
                }
                _ => {}
            }
            ui.add_space(6.0);
        }
        _ => {}
    }
    ui.add_space(4.0);
}

/// The right-click menu on selected chat text.
///
/// In egui any press on a label starts a new selection, the right button
/// too, so a right-click would wipe out what was selected. This sees the
/// window's input before egui does: a right-click inside the selected chat
/// text opens this menu instead, and a click on one of its items is taken
/// here too, so the selection stays as it was.
#[derive(Default)]
struct Selected {
    /// The selected text, as egui last reported it.
    last: String,
    /// Chat text drawn last frame: where, and all of it.
    labels: Vec<(egui::Rect, String)>,
    menu: Option<CopyMenu>,
    /// Text to put on the clipboard this frame.
    copy: Option<String>,
    /// The release of a press this took.
    swallow: Option<egui::PointerButton>,
    /// Ctrl+A outside a text box: the whole chat is selected.
    all: bool,
}

impl Selected {
    fn all_text(&self) -> String {
        self.labels.iter().map(|(_, t)| t.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n\n")
    }
}

#[derive(Clone)]
struct CopyMenu {
    at: egui::Pos2,
    selected: String,
    whole: String,
    /// Where its two items were drawn: copy the selection, copy all.
    items: [egui::Rect; 2],
}

impl egui::plugin::Plugin for Selected {
    fn debug_name(&self) -> &'static str {
        "anoncode copy menu"
    }

    fn input_hook(&mut self, ctx: &egui::Context, input: &mut egui::RawInput) {
        use egui::{Event, PointerButton};
        let selected = self.all || (!self.last.is_empty() && ctx.with_plugin(|l: &mut egui::text_selection::LabelSelectionState| l.has_selection()).unwrap_or(false));
        let in_text_box = ctx.memory(|m| m.focused().is_some());
        let mut keep = Vec::with_capacity(input.events.len());
        for event in std::mem::take(&mut input.events) {
            match &event {
                Event::PointerButton { button, pressed: false, .. } if self.swallow == Some(*button) => {
                    self.swallow = None;
                    continue;
                }
                Event::Key { key: egui::Key::A, pressed: true, modifiers, .. } if (modifiers.ctrl || modifiers.command) && !in_text_box && !self.labels.is_empty() => {
                    self.all = true;
                    ctx.with_plugin(|l: &mut egui::text_selection::LabelSelectionState| l.clear_selection());
                    ctx.request_repaint();
                    continue;
                }
                Event::Copy | Event::Cut if self.all && !in_text_box => {
                    self.copy = Some(self.all_text());
                    continue;
                }
                Event::PointerButton { pos, button: PointerButton::Secondary, pressed: true, .. } if selected => {
                    if let Some((_, whole)) = self.labels.iter().find(|(r, _)| r.contains(*pos)) {
                        let chosen = if self.all { self.all_text() } else { self.last.clone() };
                        self.menu = Some(CopyMenu { at: *pos, selected: chosen, whole: whole.clone(), items: [egui::Rect::NOTHING; 2] });
                        self.swallow = Some(PointerButton::Secondary);
                        continue;
                    }
                }
                Event::PointerButton { pos, button: PointerButton::Primary, pressed: true, .. } if self.menu.is_some() => {
                    let menu = self.menu.take().unwrap();
                    if let Some(i) = menu.items.iter().position(|r| r.contains(*pos)) {
                        self.copy = Some(if i == 0 { menu.selected } else { menu.whole });
                        self.swallow = Some(PointerButton::Primary);
                        continue;
                    }
                    self.all = false;
                }
                Event::PointerButton { pressed: true, button: PointerButton::Primary, .. } | Event::Text(_) => self.all = false,
                Event::Key { key: egui::Key::Escape, pressed: true, .. } => {
                    self.menu = None;
                    self.all = false;
                }
                Event::MouseWheel { .. } => self.menu = None,
                _ => {}
            }
            keep.push(event);
        }
        input.events = keep;
    }

    fn on_begin_pass(&mut self, _ui: &mut Ui) {
        self.labels.clear();
    }

    /// The whole chat, when selected, is shown as selected.
    fn on_end_pass(&mut self, ui: &mut Ui) {
        if !self.all {
            return;
        }
        let color = ui.visuals().selection.bg_fill.gamma_multiply(0.45);
        let painter = ui.ctx().layer_painter(egui::LayerId::new(egui::Order::Middle, egui::Id::unique("anoncode-select-all")));
        for (rect, _) in self.labels.iter().filter(|(r, _)| r.is_positive()) {
            painter.rect_filled(*rect, 2.0, color);
        }
    }

    fn output_hook(&mut self, _ctx: &egui::Context, output: &mut egui::FullOutput) {
        for command in &output.platform_output.commands {
            if let egui::OutputCommand::TextSelectionSettled(text) = command {
                self.last = text.clone();
            }
        }
    }
}

/// Draws the copy menu, if open, and copies what it was asked to.
fn selected_menu(ctx: &egui::Context) {
    let (menu, copy) = ctx.with_plugin(|s: &mut Selected| (s.menu.clone(), s.copy.take())).unwrap_or_default();
    if let Some(text) = copy {
        ctx.copy_text(text);
    }
    let Some(menu) = menu else { return };
    let items = egui::Area::new(egui::Id::unique("anoncode-copy-menu"))
        .order(egui::Order::Foreground)
        .fixed_pos(menu.at)
        .show(ctx, |ui| {
            egui::Frame::menu(ui.style())
                .show(ui, |ui| {
                    ui.set_min_width(150.0);
                    let copy = ui.add(egui::Button::new("Copy").shortcut_text("Ctrl+C").frame(false)).rect;
                    let all = ui.add(egui::Button::new("Copy all of this").frame(false)).rect;
                    [copy, all]
                })
                .inner
        })
        .inner;
    ctx.with_plugin(|s: &mut Selected| {
        if let Some(m) = &mut s.menu {
            m.items = items;
        }
    });
}

/// Chat text: drag to select, then Ctrl+C or right-click to copy. Without
/// a selection the right-click menu copies all of it.
fn copy_menu(response: egui::Response, whole: &str) {
    // The visible part only: what scrolled out of view is clipped away.
    let rect = response.interact_rect;
    response.ctx.with_plugin(|s: &mut Selected| s.labels.push((rect, whole.to_string())));
    response.context_menu(|ui| {
        if ui.button("Copy all of this").clicked() {
            ui.ctx().copy_text(whole.to_string());
            ui.close();
        }
    });
}

/// The right-click menu on a text box: cut, copy, paste and select all,
/// as Ctrl+X, Ctrl+C, Ctrl+V and Ctrl+A do. A password can only be pasted
/// and selected.
fn edit_menu(response: &egui::Response, text: &mut String, password: bool) {
    use egui::text::{CCursor, CCursorRange};
    let ctx = response.ctx.clone();
    let id = response.id;
    // The right button's press moves the cursor and drops the selection,
    // as any press does; the selection from before it is put back.
    let before = id.with("before right-click");
    let right = ctx.input(|i| i.pointer.button_down(egui::PointerButton::Secondary) || i.pointer.button_released(egui::PointerButton::Secondary));
    if ctx.memory(|m| m.has_focus(id)) && ctrl_a(&ctx) {
        select_all(&ctx, id, text);
    }
    if let Some(mut state) = egui::text_edit::TextEditState::load(&ctx, id) {
        if response.secondary_clicked() {
            if let Some(range) = ctx.data(|d| d.get_temp::<CCursorRange>(before)) {
                state.cursor.set_char_range(Some(range));
                state.store(&ctx, id);
                ctx.memory_mut(|m| m.request_focus(id));
            }
        } else if !right && ctx.memory(|m| m.has_focus(id)) {
            // Only while focused: pressing a menu item takes the focus, and
            // with it the selection, before the item acts.
            if let Some(range) = state.cursor.char_range() {
                ctx.data_mut(|d| d.insert_temp(before, range));
            }
        }
    }
    response.context_menu(|ui| {
        let mut state = egui::text_edit::TextEditState::load(&ctx, id).unwrap_or_default();
        let range = ctx.data(|d| d.get_temp::<CCursorRange>(before)).or(state.cursor.char_range());
        let [a, b] = range.map_or([CCursor::new(0); 2], |r| r.sorted_cursors()).map(|c| c.index.0.min(text.chars().count()));
        let byte = |c: usize| text.char_indices().nth(c).map_or(text.len(), |(i, _)| i);
        let (start, end) = (byte(a), byte(b));
        let has = start < end && !password;
        let place = |state: &mut egui::text_edit::TextEditState, from: usize, to: usize| {
            state.cursor.set_char_range(Some(CCursorRange::two(CCursor::new(from), CCursor::new(to))));
            ctx.memory_mut(|m| m.request_focus(id));
        };
        if ui.add_enabled(has, egui::Button::new("Cut").shortcut_text("Ctrl+X")).clicked() {
            ctx.copy_text(text[start..end].to_string());
            text.replace_range(start..end, "");
            place(&mut state, a, a);
            ui.close();
        }
        if ui.add_enabled(has, egui::Button::new("Copy").shortcut_text("Ctrl+C")).clicked() {
            ctx.copy_text(text[start..end].to_string());
            place(&mut state, a, b);
            ui.close();
        }
        if ui.add(egui::Button::new("Paste").shortcut_text("Ctrl+V")).clicked() {
            if let Some(pasted) = arboard::Clipboard::new().and_then(|mut c| c.get_text()).ok().filter(|t| !t.is_empty()) {
                text.replace_range(start..end, &pasted);
                let at = a + pasted.chars().count();
                place(&mut state, at, at);
            }
            ui.close();
        }
        if ui.add_enabled(!text.is_empty(), egui::Button::new("Select all").shortcut_text("Ctrl+A")).clicked() {
            place(&mut state, 0, text.chars().count());
            ui.close();
        }
        state.store(&ctx, id);
    });
}

/// Ctrl+A was pressed this frame.
fn ctrl_a(ctx: &egui::Context) -> bool {
    ctx.input(|i| i.events.iter().any(|e| matches!(e, egui::Event::Key { key: Key::A, pressed: true, modifiers, .. } if modifiers.ctrl || modifiers.command)))
}

/// Focuses a text box with all of its text selected.
fn select_all(ctx: &egui::Context, id: egui::Id, text: &str) {
    use egui::text::{CCursor, CCursorRange};
    let mut state = egui::text_edit::TextEditState::load(ctx, id).unwrap_or_default();
    state.cursor.set_char_range(Some(CCursorRange::two(CCursor::new(0), CCursor::new(text.chars().count()))));
    state.store(ctx, id);
    ctx.data_mut(|d| d.insert_temp(id.with("before right-click"), CCursorRange::two(CCursor::new(0), CCursor::new(text.chars().count()))));
    ctx.memory_mut(|m| m.request_focus(id));
}

/// Part of a reply as it is being written.
fn live_part(ui: &mut Ui, reasoning: bool, body: &str) {
    if reasoning {
        ui.label(RichText::new(clip(body.trim(), 600)).weak().italics());
        return;
    }
    prose(ui, &crate::tidy::tidy(body));
}

fn tool(ui: &mut Ui, index: usize, part: &Value) {
    let state = &part["state"];
    let status = state["status"].as_str().unwrap_or("");
    let input = &state["input"];
    // The most telling argument, for the one-line summary.
    let hint = ["path", "command", "pattern", "query", "url", "description"].iter().find_map(|k| input[*k].as_str()).unwrap_or("");
    let mark = match status {
        "completed" => "done",
        "error" => "failed",
        _ => "running",
    };
    let title = format!("{} {}  ({mark})", text(part, "name"), clip(hint, 80));
    let color = if status == "error" { ui.visuals().error_fg_color } else { ui.visuals().weak_text_color() };
    egui::CollapsingHeader::new(RichText::new(title).monospace().small().color(color)).id_salt(("tool", index)).show(ui, |ui| {
        let pretty = serde_json::to_string_pretty(input).unwrap_or_default();
        copy_menu(ui.label(RichText::new(clip(&pretty, 4000)).monospace().small()), &pretty);
        let output: String = state["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n");
        if !output.is_empty() {
            ui.separator();
            copy_menu(ui.label(RichText::new(clip(&output, 6000)).monospace().small()), &output);
        }
        if let Some(error) = state["error"]["message"].as_str() {
            ui.colored_label(ui.visuals().error_fg_color, error);
        }
    });
}

/// Text with the common markdown the models write: fenced code in a
/// monospace box, `**bold**`, `` `code` ``, headings, lists and `>` quotes.
fn prose(ui: &mut Ui, body: &str) {
    for (i, chunk) in body.split("```").enumerate() {
        if i % 2 == 1 {
            // The first line of a fence is its language.
            let code = chunk.split_once('\n').map(|(_, rest)| rest).unwrap_or(chunk).trim_end();
            egui::Frame::group(ui.style()).fill(ui.visuals().extreme_bg_color).show(ui, |ui| {
                ui.set_width(ui.available_width());
                copy_menu(ui.add(egui::Label::new(RichText::new(code).monospace()).selectable(true)), code);
            });
        } else if !chunk.trim().is_empty() {
            copy_menu(ui.add(egui::Label::new(inline(ui, chunk.trim_matches('\n'))).wrap().selectable(true)), body);
        }
    }
}

fn inline(ui: &Ui, body: &str) -> egui::text::LayoutJob {
    use egui::text::{LayoutJob, TextFormat};
    let font = egui::TextStyle::Body.resolve(ui.style());
    let mono = egui::TextStyle::Monospace.resolve(ui.style());
    let (normal, strong, weak) = (ui.visuals().text_color(), ui.visuals().strong_text_color(), ui.visuals().weak_text_color());
    let mut job = LayoutJob::default();
    for (n, raw) in body.lines().enumerate() {
        if n > 0 {
            job.append("\n", 0.0, TextFormat { font_id: font.clone(), color: normal, ..Default::default() });
        }
        let trimmed = raw.trim_start();
        // A quoted line is dimmed; a heading is strong; a list item gets a bullet.
        let (line, base, heading) = if let Some(rest) = trimmed.strip_prefix('>') {
            (rest.trim_start().to_string(), weak, false)
        } else if trimmed.starts_with('#') {
            (trimmed.trim_start_matches('#').trim_start().to_string(), strong, true)
        } else if let Some(rest) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            (format!("{}• {rest}", " ".repeat(raw.len() - trimmed.len())), normal, false)
        } else {
            (raw.to_string(), normal, false)
        };
        let (mut bold, mut code) = (heading, false);
        let mut rest = line.as_str();
        while !rest.is_empty() {
            let next = [rest.find("**").filter(|_| !code).map(|i| (i, 2)), rest.find('`').map(|i| (i, 1))].into_iter().flatten().min();
            let (text, skip) = match next {
                Some((at, len)) => (&rest[..at], at + len),
                None => (rest, rest.len()),
            };
            if !text.is_empty() {
                let format = if code {
                    TextFormat { font_id: mono.clone(), color: strong, background: ui.visuals().extreme_bg_color, ..Default::default() }
                } else {
                    TextFormat { font_id: font.clone(), color: if bold { strong } else { base }, ..Default::default() }
                };
                job.append(text, 0.0, format);
            }
            match next {
                Some((_, 2)) => bold = !bold,
                Some(_) => code = !code,
                None => {}
            }
            rest = &rest[skip..];
        }
    }
    job
}

impl eframe::App for App {
    /// The self-test script's mouse and keyboard, fed in as if real.
    #[cfg(feature = "selftest")]
    fn raw_input_hook(&mut self, _ctx: &egui::Context, raw_input: &mut egui::RawInput) {
        raw_input.events.append(&mut self.script.events);
    }

    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        selected_menu(ui.ctx());
        if QUIT.load(Ordering::SeqCst) {
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
        }
        // Wake up now and then even with no input, to notice a signal.
        ui.ctx().request_repaint_after(Duration::from_millis(500));
        self.take_messages();
        // Auto-lock: any input counts as use; a working agent keeps it open.
        if ui.ctx().input(|i| !i.events.is_empty() || i.pointer.is_moving()) {
            self.last_input = std::time::Instant::now();
        }
        let minutes = self.settings.auto_lock_minutes;
        if self.logged_in && minutes > 0 && !self.tabs.values().any(|t| t.working()) && self.last_input.elapsed() > Duration::from_secs(60 * minutes as u64) {
            self.last_input = std::time::Instant::now();
            self.lock_app();
        }
        // Files dropped on the window are attached to the chat on screen.
        let dropped: Vec<PathBuf> = ui.ctx().input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).collect());
        if let (false, Some(tab)) = (dropped.is_empty(), self.tabs.get_mut(&self.selected)) {
            for path in dropped {
                if path.is_file() && !tab.attachments.contains(&path) {
                    tab.attachments.push(path);
                }
            }
        }
        #[cfg(feature = "selftest")]
        selftest::step(self, ui.ctx());
        egui::CentralPanel::default().show(ui, |ui| {
            if !self.logged_in {
                self.login_form(ui);
                return;
            }
            self.tab_bar(ui);
            let selected_open = self.tabs.contains_key(&self.selected);
            if self.creating {
                self.create_form(ui);
            } else if selected_open {
                self.chat(ui);
            } else {
                self.locked_form(ui);
            }
        });
        let ctx = ui.ctx().clone();
        self.dialogs(&ctx);
        self.settings_window(&ctx);
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        for tab in self.tabs.values() {
            tab.shared.stop.store(true, Ordering::SeqCst);
        }
        self.manager.lock().unwrap().logout();
    }
}

/// Opens the window and runs until it is closed; every open project is
/// then sealed and locked.
pub fn run(cfg: Config) -> Result<()> {
    let manager = Manager::new(cfg)?;
    unsafe {
        libc::signal(libc::SIGINT, on_signal as *const () as usize);
        libc::signal(libc::SIGTERM, on_signal as *const () as usize);
        libc::signal(libc::SIGHUP, on_signal as *const () as usize);
    }
    let options = eframe::NativeOptions {
        renderer: eframe::Renderer::Glow,
        viewport: egui::ViewportBuilder::default().with_inner_size([1180.0, 800.0]).with_min_inner_size([640.0, 420.0]).with_title("AnonCode").with_app_id("anoncode"),
        ..Default::default()
    };
    eframe::run_native("AnonCode", options, Box::new(move |cc| Ok(Box::new(App::new(cc, manager))))).map_err(|e| crate::Error::Other(format!("could not open the window: {e}")))
}

/// A script that presses the buttons, for checking the window without a
/// person at it. Only in builds made with the `selftest` feature.
///
/// `ANONCODE_SELFTEST` holds one step per line:
///
/// ```text
/// login PASSPHRASE           set (first run) or give the app's passphrase
/// create NAME                fill in and press Create
/// select NAME                click the tab with this name
/// unlock PASSPHRASE          an old project's own passphrase: fill in and press Unlock
/// open                       wait until the selected project is open
/// provider PROVIDER ENVVAR   in Settings, save the API key held in $ENVVAR
/// noprovider PROVIDER        in Settings, remove that provider's key
/// model PROVIDER MODEL       wait for the model to be listed, then choose it
/// attach PATH                attach a file to the next message
/// say TEXT                   type TEXT and press Send
/// idle                       wait until the agent's turn has ended
/// sleep SECONDS
/// lock                       press Lock and wait until it is locked
/// quit                       close the window
/// ```
#[cfg(feature = "selftest")]
mod selftest {
    use super::*;
    use std::time::Instant;

    pub struct Script {
        /// Input events for the next frame.
        pub events: Vec<egui::Event>,
        steps: Vec<String>,
        at: usize,
        started: bool,
        since: Instant,
    }

    impl Script {
        pub fn from_env() -> Script {
            let steps = std::env::var("ANONCODE_SELFTEST").unwrap_or_default().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
            Script { events: Vec::new(), steps, at: 0, started: false, since: Instant::now() }
        }
    }

    pub fn step(app: &mut App, ctx: &egui::Context) {
        let Some(line) = app.script.steps.get(app.script.at).cloned() else { return };
        ctx.request_repaint_after(Duration::from_millis(150));
        let (word, rest) = line.split_once(' ').unwrap_or((&line, ""));
        let first = !std::mem::replace(&mut app.script.started, true);
        if first {
            app.script.since = Instant::now();
            eprintln!("selftest: {}", if word == "create" || word == "unlock" { word } else { &line });
        }
        let id = app.selected.clone();
        let done = match word {
            "login" => {
                if first {
                    app.login_pass = rest.to_string();
                    app.login_pass2 = rest.to_string();
                    app.press_login = true;
                }
                !first && app.logged_in
            }
            "create" => {
                if first {
                    app.creating = true;
                    app.new_name = rest.to_string();
                    app.press_create = true;
                }
                !first && !app.new_busy
            }
            "provider" => {
                let (provider, var) = rest.split_once(' ').unwrap_or((rest, ""));
                app.settings.providers.retain(|p| p.id != provider);
                app.settings.providers.push(Provider { id: provider.to_string(), key: std::env::var(var).unwrap_or_default() });
                app.settings_changed();
                true
            }
            "set" => {
                // set webfetch off|ask|allow, set sandbox on|off, set approvals auto|ask, set focus on|off,
                // set draft model|quick, set rollouts N, set cache on|off, set reopen
                let (what, value) = rest.split_once(' ').unwrap_or((rest, ""));
                match (what, value) {
                    ("webfetch", v) => app.settings.web_fetch = match v { "ask" => Access::Ask, "allow" => Access::Allow, _ => Access::Off },
                    ("sandbox", v) => app.settings.sandbox = v == "on",
                    ("approvals", v) => app.settings.approvals = if v == "ask" { Approvals::Ask } else { Approvals::Auto },
                    ("focus", v) => app.settings.focus = v == "on",
                    ("draft", v) => app.settings.focus_draft = if v == "quick" { FocusDraft::Quick } else { FocusDraft::Model },
                    ("rollouts", v) => app.settings.focus_rollouts = v.parse().unwrap_or(3),
                    ("cache", v) => app.settings.tool_cache = v == "on",
                    ("reopen", _) => app.reopen_all(),
                    _ => {}
                }
                if what != "reopen" {
                    app.settings_changed();
                }
                true
            }
            "allow" => {
                // Answer the first waiting permission request: once or reject.
                let session = app.tabs.get(&id).map(|t| t.session()).unwrap_or_default();
                let Some(tab) = app.tabs.get(&id) else { return };
                let Some(p) = tab.permissions.iter().find(|p| p["sessionID"] == session.as_str()).cloned() else {
                    app.script.started = false;
                    return;
                };
                let (client, request_id, decision) = (tab.client.clone(), text(&p, "id"), if rest == "no" { "reject" } else { "once" });
                eprintln!("selftest: answering {} {}", text(&p, "action"), decision);
                request(&app.tx, &app.ctx, &id, move || client.reply_permission(&session, &request_id, decision));
                true
            }
            "settings" => {
                app.show_settings = true;
                true
            }
            // mouse move|down|up|rdown|rup|click|rclick X Y, in points.
            "mouse" => {
                let mut it = rest.split_whitespace();
                let (what, x, y) = (it.next().unwrap_or(""), it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0), it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0));
                let pos = egui::pos2(x, y);
                let button = |pressed, button| egui::Event::PointerButton { pos, button, pressed, modifiers: egui::Modifiers::NONE };
                app.script.events.push(egui::Event::PointerMoved(pos));
                match what {
                    "down" => app.script.events.push(button(true, egui::PointerButton::Primary)),
                    "up" => app.script.events.push(button(false, egui::PointerButton::Primary)),
                    "rdown" => app.script.events.push(button(true, egui::PointerButton::Secondary)),
                    "rup" => app.script.events.push(button(false, egui::PointerButton::Secondary)),
                    _ => {}
                }
                true
            }
            // key ctrl+a | ctrl+c | ctrl+v | ctrl+x | enter ...: as the window would get it.
            "key" => {
                let (ctrl, name) = rest.strip_prefix("ctrl+").map_or((false, rest), |k| (true, k));
                let modifiers = if ctrl { egui::Modifiers::COMMAND } else { egui::Modifiers::NONE };
                match (ctrl, name) {
                    (true, "c") => app.script.events.push(egui::Event::Copy),
                    (true, "x") => app.script.events.push(egui::Event::Cut),
                    // The window reads the clipboard itself on Ctrl+V.
                    (true, "v") => app.script.events.push(egui::Event::Paste(arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default())),
                    _ => {
                        if let Some(key) = egui::Key::from_name(&name.to_uppercase()).or_else(|| egui::Key::from_name(name)) {
                            for pressed in [true, false] {
                                app.script.events.push(egui::Event::Key { key, physical_key: None, pressed, repeat: false, modifiers });
                            }
                        }
                    }
                }
                true
            }
            // Prints the clipboard and the message box, to check copying and pasting.
            "show" => {
                let clip = arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default();
                eprintln!("selftest: clipboard: {clip:?}");
                eprintln!("selftest: message box: {:?}", app.tabs.get(&id).map(|t| t.composer.clone()).unwrap_or_default());
                eprintln!("selftest: attachments: {:?}", app.tabs.get(&id).map(|t| t.attachments.clone()).unwrap_or_default());
                eprintln!("selftest: scale {} pointer {:?} screen {:?}", ctx.pixels_per_point(), ctx.input(|i| i.pointer.latest_pos()), ctx.content_rect());
                true
            }
            // Saves the window's own frame as a PPM picture: nothing else on the screen is in it.
            "snap" => {
                let path = PathBuf::from(rest);
                ctx.request_screenshot(move |image| {
                    let mut out = format!("P6\n{} {}\n255\n", image.size[0], image.size[1]).into_bytes();
                    out.extend(image.pixels.iter().flat_map(|p| [p.r(), p.g(), p.b()]));
                    let _ = std::fs::write(&path, out);
                });
                ctx.request_repaint();
                true
            }
            // Waits for this file, then runs its lines next (it is removed).
            "more" => match std::fs::read_to_string(rest) {
                Ok(more) => {
                    let _ = std::fs::remove_file(rest);
                    let at = app.script.at + 1;
                    let lines: Vec<String> = more.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
                    app.script.steps.splice(at..at, lines);
                    true
                }
                Err(_) => false,
            },
            "clipboard" => {
                let _ = arboard::Clipboard::new().and_then(|mut c| c.set_text(rest.to_string()));
                true
            }
            "type" => {
                app.script.events.push(egui::Event::Text(rest.to_string()));
                true
            }
            "noprovider" => {
                app.settings.providers.retain(|p| p.id != rest);
                app.settings_changed();
                true
            }
            "select" => {
                // Click the tab with this name.
                if let Some(p) = app.projects.iter().find(|p| p.name == rest).cloned() {
                    app.selected = p.id.clone();
                    app.creating = false;
                    if p.known && !p.open {
                        app.open_project(&p.id);
                    }
                }
                true
            }
            "unlock" => {
                if first {
                    app.pass = rest.to_string();
                    app.press_unlock = true;
                }
                !first
            }
            "open" => app.tabs.contains_key(&id) && !app.busy.contains(&id),
            "model" => {
                let (provider, model) = rest.split_once(' ').unwrap_or((rest, ""));
                match app.tabs.get_mut(&id) {
                    Some(tab) if tab.models.iter().any(|m| m["providerID"] == provider && m["id"] == model) => {
                        tab.model = Some((provider.to_string(), model.to_string()));
                        tab.save_prefs();
                        // As the dropdown does: the choice becomes the default for other projects.
                        app.settings.model = Some((provider.to_string(), model.to_string()));
                        app.save_settings();
                        true
                    }
                    Some(tab) => {
                        if app.script.since.elapsed() > Duration::from_secs(2) {
                            tab.shared.refresh.store(true, Ordering::SeqCst);
                            app.script.since = Instant::now();
                        }
                        false
                    }
                    None => false,
                }
            }
            "attach" => {
                if let Some(tab) = app.tabs.get_mut(&id) {
                    tab.attachments.push(PathBuf::from(rest));
                }
                true
            }
            "say" => {
                if let (true, Some(tab)) = (first, app.tabs.get_mut(&id)) {
                    tab.composer = rest.to_string();
                    tab.press_send = true;
                }
                // Sent once the agent has started on it.
                !first && app.tabs.get(&id).is_some_and(|t| t.working() || app.script.since.elapsed() > Duration::from_secs(8))
            }
            "idle" => app.tabs.get(&id).is_some_and(|t| !t.working() && !t.messages.is_empty()) && app.script.since.elapsed() > Duration::from_secs(2),
            "sleep" => app.script.since.elapsed() >= Duration::from_secs(rest.parse().unwrap_or(1)),
            "lock" => {
                if first {
                    let target = id.clone();
                    app.run(&id, move |m| m.lock(&target).map(|()| "Locked.".to_string()));
                }
                !first && !app.tabs.contains_key(&id) && !app.busy.contains(&id)
            }
            "quit" => {
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                true
            }
            _ => true,
        };
        if done {
            app.script.at += 1;
            app.script.started = false;
        }
    }
}
