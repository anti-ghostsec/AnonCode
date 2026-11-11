//! The list of projects.
//!
//! Each project is its own vault, with its own passphrase, in its own
//! folder under `.anoncode/projects/`, so projects are separated by
//! cryptography and not just by folder.
//!
//! The list of projects (ids, names, creation times) is sealed in the app's
//! vault once there is a login ([`Projects::seal_index`]); a plaintext
//! `projects/index.json` from before is moved in there and deleted.
//!
//! ```text
//! .anoncode/
//!   projects/
//!     <id>/
//!       vault.json          scrypt cost, salt, sealed check value
//!       project/*.enc       the project's files, sealed
//!       state/*.enc         chats, settings and keys, sealed
//!       run/                plaintext while unlocked, wiped on lock
//!         work/             the project's files (tools need real files)
//! ```
//!
//! The agent's own data (its chat database, settings, caches) is plaintext
//! only in memory while a project is unlocked: it is written out under the
//! user's runtime folder (`$XDG_RUNTIME_DIR`) or `/dev/shm`, both RAM,
//! never under the folder on disk. Either is used only if it is a real
//! folder owned by this user that no one else can enter.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::fsx::{create_private_dir, safe_name, write_private_atomic};
use crate::vault::{random_hex, Vault, VaultHeader};
use crate::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

pub struct ProjectPaths {
    pub dir: PathBuf,
    pub vault_file: PathBuf,
    pub run: PathBuf,
    /// The project's own files, in plaintext, while unlocked.
    pub work: PathBuf,
    /// The agent's data and config, in plaintext, while unlocked. In RAM
    /// where the system has a memory-backed folder.
    pub home: PathBuf,
    /// The agent's scratch files and its log, beside `home`.
    pub scratch: PathBuf,
}

/// The registry, rooted at a `.anoncode` folder.
pub struct Projects {
    base: PathBuf,
    /// Where the list is kept once it is sealed.
    sealed: Option<crate::store::Store>,
}

impl Projects {
    pub fn new(base: impl Into<PathBuf>) -> Projects {
        Projects { base: base.into(), sealed: None }
    }

    /// Keeps the list sealed in `store` from now on, moving a plaintext
    /// list from before into it.
    pub fn seal_index(&mut self, store: crate::store::Store) -> Result<()> {
        let plain = self.list()?;
        self.sealed = Some(store);
        if self.index_file().is_file() {
            let mut list = self.list()?;
            for p in plain {
                if !list.iter().any(|q| q.id == p.id) {
                    list.push(p);
                }
            }
            self.write(&list)?;
            fs::remove_file(self.index_file())?;
        }
        Ok(())
    }

    /// Back to the plaintext list (on logout nothing can be listed).
    pub fn forget_index(&mut self) {
        self.sealed = None;
    }

    pub fn base(&self) -> &Path {
        &self.base
    }

    fn dir(&self) -> PathBuf {
        self.base.join("projects")
    }

    fn index_file(&self) -> PathBuf {
        self.dir().join("index.json")
    }

    pub fn list(&self) -> Result<Vec<ProjectMeta>> {
        if let Some(store) = &self.sealed {
            return Ok(store.get_json("projects", "index")?.unwrap_or_default());
        }
        match fs::read(self.index_file()) {
            Ok(b) => Ok(serde_json::from_slice(&b).unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    fn write(&self, list: &[ProjectMeta]) -> Result<()> {
        if let Some(store) = &self.sealed {
            return store.put_json("projects", "index", &list.to_vec());
        }
        create_private_dir(&self.dir())?;
        write_private_atomic(&self.index_file(), &serde_json::to_vec_pretty(list)?, true)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<ProjectMeta> {
        self.list()?.into_iter().find(|p| p.id == id).ok_or_else(|| Error::Other(format!("no project {id:?}")))
    }

    pub fn paths(&self, id: &str) -> Result<ProjectPaths> {
        safe_name(id, "project id")?;
        let dir = self.dir().join(id);
        let run = dir.join("run");
        let private = memory_dir(&dir).unwrap_or_else(|| run.clone());
        Ok(ProjectPaths { vault_file: dir.join("vault.json"), work: run.join("work"), home: private.join("home"), scratch: private, run, dir })
    }

    /// Creates a project and its vault, locked to `passphrase`.
    pub fn create(&self, name: &str, passphrase: &str) -> Result<(ProjectMeta, Vault)> {
        let vault = Vault::create(passphrase)?;
        self.create_from(name, vault)
    }

    /// A project locked to a random secret: the lowest Argon2id cost is
    /// enough, since a 256-bit secret can't be guessed.
    pub fn create_with_secret(&self, name: &str, secret: &str) -> Result<(ProjectMeta, Vault)> {
        let vault = Vault::create_with(secret, crate::vault::KdfParams::for_random_secret(), true)?;
        self.create_from(name, vault)
    }

    pub fn create_from(&self, name: &str, vault: Vault) -> Result<(ProjectMeta, Vault)> {
        let mut list = self.list()?;
        let meta = ProjectMeta { id: format!("p{}", random_hex(5)?), name: clean_name(name), created_at: now_iso() };
        let paths = self.paths(&meta.id)?;
        create_private_dir(&paths.dir)?;
        write_private_atomic(&paths.vault_file, &serde_json::to_vec(&vault.header)?, true)?;
        list.push(meta.clone());
        self.write(&list)?;
        Ok((meta, vault))
    }

    pub fn header(&self, id: &str) -> Result<VaultHeader> {
        let bytes = fs::read(self.paths(id)?.vault_file)?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub fn unlock(&self, id: &str, passphrase: &str) -> Result<Vault> {
        Vault::unlock(passphrase, &self.header(id)?)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<ProjectMeta> {
        let mut list = self.list()?;
        let meta = list.iter_mut().find(|p| p.id == id).ok_or_else(|| Error::Other(format!("no project {id:?}")))?;
        meta.name = clean_name(name);
        let meta = meta.clone();
        self.write(&list)?;
        Ok(meta)
    }

    /// Deletes a project and everything sealed in it. There is no undo.
    pub fn delete(&self, id: &str) -> Result<()> {
        let list = self.list()?;
        if !list.iter().any(|p| p.id == id) {
            return Err(Error::Other(format!("no project {id:?}")));
        }
        match fs::remove_dir_all(self.paths(id)?.dir) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        self.write(&list.into_iter().filter(|p| p.id != id).collect::<Vec<_>>())
    }
}

/// A folder in RAM for one project's unsealed agent data, named by a hash
/// of the project's folder so two AnonCode folders never share one.
///
/// It is under `$XDG_RUNTIME_DIR` (made by the system for this user alone)
/// or else `/dev/shm/anoncode-<uid>`. Either is used only if it is a real
/// folder, not a link, owned by this user, and closed to everyone else; a
/// `/dev/shm` folder someone else made first is refused, not used.
#[cfg(unix)]
fn memory_dir(project: &Path) -> Option<PathBuf> {
    let name = crate::efs::sha256_hex(project.to_string_lossy().as_bytes());
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|d| d.is_absolute() && crate::fsx::is_private_dir(d));
    let base = match runtime {
        Some(d) => d.join("anoncode"),
        None => {
            let shm = Path::new("/dev/shm");
            if !shm.is_dir() {
                return None;
            }
            shm.join(format!("anoncode-{}", unsafe { libc::getuid() }))
        }
    };
    // Made 0700 if missing; then checked, whoever made it.
    let _ = create_private_dir(&base);
    if !crate::fsx::is_private_dir(&base) {
        return None;
    }
    Some(base.join(&name[..24]))
}

#[cfg(not(unix))]
fn memory_dir(_project: &Path) -> Option<PathBuf> {
    None
}

fn clean_name(name: &str) -> String {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).take(80).collect();
    if n.is_empty() {
        "Untitled".into()
    } else {
        n
    }
}

/// The current time as `2026-11-10T12:34:56Z`.
pub fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil date from a day count (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}
