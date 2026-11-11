//! A tree of files kept as sealed blobs.
//!
//! Every file is its own sealed record; one sealed manifest lists the
//! paths. A record is named by a hash of its path keyed with a secret from
//! the vault, so without the passphrase the names can't be matched against
//! guessed paths ("is there a `.env` in here?"). Nothing is written in
//! plaintext. What does show on disk: how many files there are, roughly how
//! big each is, and when each last changed.
//!
//! A sync that fails part-way leaves a tree that opens: changed files are
//! sealed first, the manifest is replaced in one step, and only then are
//! the records of deleted files removed.
//!
//! The manifest is a superset of the first AnonCode's (`size`, `mtime`), so
//! its projects open here. The extra fields keep what a real working tree
//! needs: the executable bit, symlinks, and a content hash so unchanged
//! files aren't sealed again.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::fsx::norm_vpath;
use crate::store::Store;
use crate::{Error, Result};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub size: u64,
    /// Milliseconds since 1970.
    pub mtime: u64,
    /// SHA-256 of the contents, hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exec: bool,
    /// A symlink's target; such an entry has no blob.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

pub type Manifest = BTreeMap<String, Entry>;

pub struct Efs {
    store: Store,
    collection: String,
    manifest: Manifest,
    dirty: bool,
    name_key: zeroize::Zeroizing<[u8; 32]>,
    /// Records to remove once the manifest no longer lists them.
    doomed: Vec<String>,
}

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// The first AnonCode's record name: an unkeyed hash of the path. Still
/// read, never written.
fn legacy_blob_id(path: &str) -> String {
    format!("f{}", sha256_hex(path.as_bytes()))
}

impl Efs {
    pub fn open(store: Store, collection: &str) -> Result<Efs> {
        let manifest = store.get_json::<Manifest>(collection, "manifest")?.unwrap_or_default();
        let name_key = store.vault().name_key();
        Ok(Efs { store, collection: collection.to_string(), manifest, dirty: false, name_key, doomed: Vec::new() })
    }

    fn blob_id(&self, path: &str) -> String {
        let mut h = Sha256::new();
        h.update(&self.name_key[..]);
        h.update(path.as_bytes());
        format!("g{}", h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>())
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn paths(&self) -> Vec<String> {
        self.manifest.keys().cloned().collect()
    }

    pub fn entry(&self, path: &str) -> Option<&Entry> {
        norm_vpath(path).ok().and_then(|p| self.manifest.get(&p))
    }

    pub fn read(&self, path: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let p = norm_vpath(path)?;
        match self.manifest.get(&p) {
            Some(e) if e.link.is_none() => {
                let data = match self.store.get(&self.collection, &self.blob_id(&p))? {
                    Some(data) => Some(data),
                    None => self.store.get(&self.collection, &legacy_blob_id(&p))?,
                };
                // The manifest records each file's hash: an older copy of a
                // file put back on its own is caught here.
                if let (Some(data), Some(hash)) = (&data, &e.hash) {
                    if sha256_hex(data) != *hash {
                        return Err(Error::Damaged);
                    }
                }
                Ok(data)
            }
            _ => Ok(None),
        }
    }

    /// Seals a file. The manifest is saved by [`Efs::flush`].
    pub fn write(&mut self, path: &str, data: &[u8], mtime: u64, exec: bool) -> Result<()> {
        let p = norm_vpath(path)?;
        if p.is_empty() {
            return Err(Error::Unsafe("the project root is not a file".into()));
        }
        self.store.put(&self.collection, &self.blob_id(&p), data)?;
        self.doomed.push(legacy_blob_id(&p));
        self.manifest.insert(p, Entry { size: data.len() as u64, mtime, hash: Some(sha256_hex(data)), exec, link: None });
        self.dirty = true;
        Ok(())
    }

    pub fn write_link(&mut self, path: &str, target: &str, mtime: u64) -> Result<()> {
        let p = norm_vpath(path)?;
        if p.is_empty() {
            return Err(Error::Unsafe("the project root is not a file".into()));
        }
        self.doomed.extend([self.blob_id(&p), legacy_blob_id(&p)]);
        self.manifest.insert(p, Entry { size: 0, mtime, hash: None, exec: false, link: Some(target.to_string()) });
        self.dirty = true;
        Ok(())
    }

    /// Updates a file's recorded time and mode without sealing it again.
    pub fn touch(&mut self, path: &str, mtime: u64, exec: bool) {
        if let Some(e) = norm_vpath(path).ok().and_then(|p| self.manifest.get_mut(&p)) {
            if e.mtime != mtime || e.exec != exec {
                e.mtime = mtime;
                e.exec = exec;
                self.dirty = true;
            }
        }
    }

    pub fn remove(&mut self, path: &str) -> Result<()> {
        let p = norm_vpath(path)?;
        if self.manifest.remove(&p).is_some() {
            self.doomed.extend([self.blob_id(&p), legacy_blob_id(&p)]);
            self.dirty = true;
        }
        Ok(())
    }

    /// Saves the manifest if anything changed since the last flush.
    pub fn flush(&mut self) -> Result<()> {
        if self.dirty {
            self.store.put_json(&self.collection, "manifest", &self.manifest)?;
            self.dirty = false;
        }
        for id in std::mem::take(&mut self.doomed) {
            // A path deleted and written again before this flush keeps its record.
            let live = self.manifest.iter().any(|(p, e)| e.link.is_none() && self.blob_id(p) == id);
            if !live {
                self.store.remove(&self.collection, &id)?;
            }
        }
        Ok(())
    }
}
