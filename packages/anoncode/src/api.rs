//! A client for an unlocked project's agent server (opencode's HTTP API),
//! on the loopback interface. Blocking: call it off the interface thread.

use std::time::Duration;

use serde_json::{json, Value};

use crate::supervisor::Server;

#[derive(Clone)]
pub struct Client {
    base: String,
    auth: String,
    directory: String,
    agent: ureq::Agent,
}

pub type ApiResult<T> = std::result::Result<T, String>;

fn percent(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

impl Client {
    pub fn new(server: &Server) -> Client {
        Client {
            base: format!("http://127.0.0.1:{}", server.port),
            auth: server.auth.clone(),
            directory: server.work.to_string_lossy().into_owned(),
            agent: ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).timeout(Duration::from_secs(60)).build(),
        }
    }

    pub fn directory(&self) -> &str {
        &self.directory
    }

    fn call(&self, method: &str, path: &str, body: Option<Value>) -> ApiResult<Value> {
        let request = self
            .agent
            .request(method, &format!("{}{path}", self.base))
            .set("authorization", &self.auth)
            .set("x-opencode-directory", &percent(&self.directory));
        let response = match body {
            Some(b) => request.set("content-type", "application/json").send_string(&b.to_string()),
            None => request.call(),
        };
        match response {
            Ok(r) => {
                let text = r.into_string().map_err(|e| e.to_string())?;
                Ok(if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::String(text)) })
            }
            Err(ureq::Error::Status(_, r)) => {
                let text = r.into_string().unwrap_or_default();
                // The server's errors are JSON with a message; show the message.
                let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let message = ["message", "error"].iter().find_map(|k| parsed.get(k).and_then(|v| v.as_str().map(String::from).or_else(|| v.get("message").and_then(Value::as_str).map(String::from))));
                Err(message.unwrap_or(text))
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn data(&self, method: &str, path: &str, body: Option<Value>) -> ApiResult<Value> {
        self.call(method, path, body).map(|mut v| v.get_mut("data").map(Value::take).unwrap_or(v))
    }

    fn list(&self, path: &str) -> ApiResult<Vec<Value>> {
        Ok(self.data("GET", path, None)?.as_array().cloned().unwrap_or_default())
    }

    /// This project's chats, most recently used first.
    pub fn sessions(&self) -> ApiResult<Vec<Value>> {
        self.list(&format!("/api/session?limit=200&directory={}", percent(&self.directory)))
    }

    pub fn create_session(&self, model: Option<(&str, &str)>) -> ApiResult<Value> {
        let mut body = json!({ "location": { "directory": self.directory } });
        if let Some((provider, id)) = model {
            body["model"] = json!({ "providerID": provider, "id": id });
        }
        self.data("POST", "/api/session", Some(body))
    }

    pub fn delete_session(&self, id: &str) -> ApiResult<()> {
        self.call("DELETE", &format!("/api/session/{id}"), None).map(|_| ())
    }

    /// A chat's messages, oldest first. The server hands them out newest
    /// first, 200 at a time: `all` follows the pages back to the start,
    /// otherwise only the newest page is fetched.
    pub fn messages(&self, id: &str, all: bool) -> ApiResult<Vec<Value>> {
        let mut list = Vec::new();
        let mut cursor = String::new();
        for _ in 0..50 {
            let page = self.call("GET", &format!("/api/session/{id}/message?limit=200{cursor}"), None)?;
            list.extend(page["data"].as_array().cloned().unwrap_or_default());
            match page["cursor"]["next"].as_str() {
                Some(next) if all && !next.is_empty() => cursor = format!("&cursor={}", percent(next)),
                _ => break,
            }
        }
        list.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        Ok(list)
    }

    /// Sends a message, with any files to attach. The server reads each
    /// file itself and keeps its bytes with the chat (sealed with it).
    pub fn prompt(&self, id: &str, text: &str, files: &[std::path::PathBuf]) -> ApiResult<()> {
        let files: Vec<Value> = files
            .iter()
            .map(|path| {
                let uri: String = path.to_string_lossy().bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
                json!({ "uri": format!("file://{uri}"), "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() })
            })
            .collect();
        let mut body = json!({ "text": text });
        if !files.is_empty() {
            body["files"] = Value::Array(files);
        }
        self.call("POST", &format!("/api/session/{id}/prompt"), Some(body)).map(|_| ())
    }

    /// Runs a slash command (`/loop ...`).
    pub fn command(&self, id: &str, name: &str, text: &str) -> ApiResult<()> {
        self.call("POST", &format!("/api/session/{id}/command"), Some(json!({ "name": name, "text": text }))).map(|_| ())
    }

    pub fn commands(&self) -> ApiResult<Vec<Value>> {
        self.list("/api/command")
    }

    pub fn interrupt(&self, id: &str) -> ApiResult<()> {
        self.call("POST", &format!("/api/session/{id}/interrupt"), None).map(|_| ())
    }

    pub fn set_model(&self, id: &str, provider: &str, model: &str) -> ApiResult<()> {
        self.call("POST", &format!("/api/session/{id}/model"), Some(json!({ "model": { "providerID": provider, "id": model } }))).map(|_| ())
    }

    pub fn models(&self) -> ApiResult<Vec<Value>> {
        self.list("/api/model")
    }

    /// Providers that can be connected, with the ways each can be.
    pub fn integrations(&self) -> ApiResult<Vec<Value>> {
        self.list("/api/integration")
    }

    /// Stores a provider's API key. It goes into the project's sealed data.
    pub fn connect_key(&self, integration: &str, key: &str) -> ApiResult<()> {
        self.call("POST", &format!("/api/integration/{}/connect/key", percent(integration)), Some(json!({ "key": key }))).map(|_| ())
    }

    pub fn disconnect(&self, credential: &str) -> ApiResult<()> {
        self.call("DELETE", &format!("/api/credential/{}", percent(credential)), None).map(|_| ())
    }

    /// Requests waiting for the user's yes or no.
    pub fn permissions(&self) -> ApiResult<Vec<Value>> {
        self.list("/api/permission/request")
    }

    /// `decision` is `once`, `always` or `reject`.
    pub fn reply_permission(&self, session: &str, request: &str, decision: &str) -> ApiResult<()> {
        self.call("POST", &format!("/api/session/{session}/permission/{request}/reply"), Some(json!({ "decision": decision }))).map(|_| ())
    }
}
