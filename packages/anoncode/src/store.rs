//! Sealed records in folders.
//!
//! Records are grouped into named collections (`sessions`, `project`, ...).
//! Each is sealed under the vault's key and written as `<id>.enc`: on disk
//! there is only ciphertext. Collection and record names are checked so
//! none can leave the store's folder. Writes are atomic.
//!
//! New records are binary blobs bound to their collection and id, so a
//! record copied over another fails to open. Older unbound blobs and the
//! first AnonCode's JSON envelopes are still read.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::fsx::{create_private_dir, safe_name, write_private_atomic};
use crate::vault::Vault;
use crate::Result;

#[derive(Clone)]
pub struct Store {
    vault: Arc<Vault>,
    base: PathBuf,
}

impl Store {
    pub fn new(vault: Arc<Vault>, base: impl Into<PathBuf>) -> Result<Store> {
        let base = base.into();
        create_private_dir(&base)?;
        Ok(Store { vault, base })
    }

    /// Whether `vault` is the one these records are sealed under.
    pub fn same_vault(&self, vault: &Arc<Vault>) -> bool {
        Arc::ptr_eq(&self.vault, vault)
    }

    pub fn vault(&self) -> &Vault {
        &self.vault
    }

    pub fn base(&self) -> &Path {
        &self.base
    }

    fn collection_dir(&self, collection: &str) -> Result<PathBuf> {
        let mut dir = self.base.clone();
        for part in collection.split('/') {
            safe_name(part, "collection")?;
            dir.push(part);
        }
        Ok(dir)
    }

    fn record_path(&self, collection: &str, id: &str) -> Result<PathBuf> {
        safe_name(id, "id")?;
        Ok(self.collection_dir(collection)?.join(format!("{id}.enc")))
    }

    pub fn put(&self, collection: &str, id: &str, data: &[u8]) -> Result<()> {
        self.put_with(collection, id, data, false)
    }

    /// `durable` also flushes the record and its folder to the disk.
    pub fn put_with(&self, collection: &str, id: &str, data: &[u8], durable: bool) -> Result<()> {
        let path = self.record_path(collection, id)?;
        create_private_dir(path.parent().unwrap())?;
        write_private_atomic(&path, &self.vault.seal_bound(&format!("{collection}/{id}"), data)?, durable)?;
        Ok(())
    }

    /// The record, or `None` if there is none. Fails if it was tampered with.
    pub fn get(&self, collection: &str, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let path = self.record_path(collection, id)?;
        let sealed = match fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        self.vault.open_bound(&format!("{collection}/{id}"), &sealed).map(Some)
    }

    pub fn put_json<T: Serialize>(&self, collection: &str, id: &str, value: &T) -> Result<()> {
        let json = Zeroizing::new(serde_json::to_vec(value)?);
        self.put_with(collection, id, &json, true)
    }

    pub fn get_json<T: DeserializeOwned>(&self, collection: &str, id: &str) -> Result<Option<T>> {
        match self.get(collection, id)? {
            Some(b) => Ok(Some(serde_json::from_slice(&b)?)),
            None => Ok(None),
        }
    }

    pub fn has(&self, collection: &str, id: &str) -> bool {
        self.record_path(collection, id).map(|p| p.is_file()).unwrap_or(false)
    }

    /// Record ids in a collection, sorted.
    pub fn list(&self, collection: &str) -> Result<Vec<String>> {
        let dir = self.collection_dir(collection)?;
        let mut ids = Vec::new();
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ids),
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            if let Some(id) = entry?.file_name().to_str().and_then(|n| n.strip_suffix(".enc")) {
                ids.push(id.to_string());
            }
        }
        ids.sort();
        Ok(ids)
    }

    pub fn remove(&self, collection: &str, id: &str) -> Result<()> {
        match fs::remove_file(self.record_path(collection, id)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    pub fn remove_collection(&self, collection: &str) -> Result<()> {
        match fs::remove_dir_all(self.collection_dir(collection)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}
