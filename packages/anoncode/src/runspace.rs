//! The plaintext copy of a sealed tree that real tools need.
//!
//! Compilers, language servers, git and the agent itself work on files, so
//! while a project is unlocked its tree is written out under the project's
//! `run/` folder. [`sync_back`] seals what changed there back into the
//! [`Efs`]; [`wipe`] removes the plaintext when the project is locked.
//! Between those two, plaintext exists on disk, inside the AnonCode folder
//! and nowhere else.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use crate::efs::{sha256_hex, Efs};
use crate::fsx::{create_private_dir, join_within};
use crate::Result;

/// Folders that are rebuilt rather than kept: they are never sealed.
pub const SKIP_DIRS: &[&str] = &["node_modules", "target", ".next", "__pycache__", ".venv", ".anoncode"];
/// Files larger than this are left out of the vault (and reported).
pub const MAX_FILE: u64 = 256 * 1024 * 1024;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Synced {
    pub changed: Vec<String>,
    pub deleted: Vec<String>,
    /// Too large, unreadable, or not a regular file or symlink.
    pub skipped: Vec<String>,
}

/// Writes every file in `efs` under `dir`. Returns how many were written.
pub fn materialize(efs: &Efs, dir: &Path) -> Result<usize> {
    create_private_dir(dir)?;
    let mut n = 0;
    for (path, entry) in efs.manifest() {
        let abs = join_within(dir, path)?;
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Some(target) = &entry.link {
            #[cfg(unix)]
            {
                let _ = fs::remove_file(&abs);
                std::os::unix::fs::symlink(target, &abs)?;
            }
            #[cfg(not(unix))]
            let _ = target;
            n += 1;
            continue;
        }
        let Some(data) = efs.read(path)? else { continue };
        fs::write(&abs, &data[..])?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&abs, fs::Permissions::from_mode(if entry.exec { 0o700 } else { 0o600 }))?;
        }
        // Keep the recorded time, so the next sync sees the file as unchanged
        // and build tools don't see everything as new.
        let file = fs::File::options().write(true).open(&abs)?;
        let _ = file.set_modified(UNIX_EPOCH + Duration::from_millis(entry.mtime));
        n += 1;
    }
    Ok(n)
}

/// Seals files that were created or changed under `dir` into `efs`, and
/// drops the ones that were deleted there. `dir` is the truth: after this,
/// `efs` holds what `dir` holds (less the skipped folders and files).
pub fn sync_back(efs: &mut Efs, dir: &Path) -> Result<Synced> {
    sync_back_skipping(efs, dir, SKIP_DIRS)
}

/// [`sync_back`] with its own list of folder names to leave out.
pub fn sync_back_skipping(efs: &mut Efs, dir: &Path, skip: &[&str]) -> Result<Synced> {
    let mut out = Synced::default();
    let mut seen = BTreeSet::new();
    if dir.is_dir() {
        walk(efs, dir, dir, skip, &mut seen, &mut out)?;
        for path in efs.paths() {
            if !seen.contains(&path) {
                efs.remove(&path)?;
                out.deleted.push(path);
            }
        }
    }
    efs.flush()?;
    Ok(out)
}

fn walk(efs: &mut Efs, root: &Path, dir: &Path, skip: &[&str], seen: &mut BTreeSet<String>, out: &mut Synced) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let full = entry.path();
        let Some(rel) = full.strip_prefix(root).ok().and_then(|p| p.to_str()).map(|s| s.replace('\\', "/")) else {
            out.skipped.push(full.to_string_lossy().into_owned());
            continue;
        };
        let meta = match fs::symlink_metadata(&full) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        if meta.is_dir() {
            if name.to_str().is_some_and(|n| skip.contains(&n)) {
                continue;
            }
            walk(efs, root, &full, skip, seen, out)?;
        } else if meta.file_type().is_symlink() {
            let target = fs::read_link(&full)?.to_string_lossy().into_owned();
            if efs.entry(&rel).and_then(|e| e.link.as_deref()) != Some(target.as_str()) {
                efs.write_link(&rel, &target, mtime)?;
                out.changed.push(rel.clone());
            }
            seen.insert(rel);
        } else if meta.is_file() {
            if meta.len() > MAX_FILE {
                out.skipped.push(rel);
                continue;
            }
            let exec = is_exec(&meta);
            let same_stat = efs.entry(&rel).is_some_and(|e| e.link.is_none() && e.size == meta.len() && e.mtime == mtime && e.hash.is_some());
            if same_stat {
                efs.touch(&rel, mtime, exec);
                seen.insert(rel);
                continue;
            }
            let data = match fs::read(&full) {
                Ok(d) => d,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(_) => {
                    out.skipped.push(rel);
                    continue;
                }
            };
            let same = efs.entry(&rel).is_some_and(|e| e.link.is_none() && e.size == data.len() as u64 && e.hash.as_deref() == Some(sha256_hex(&data).as_str()));
            if same {
                efs.touch(&rel, mtime, exec);
            } else {
                efs.write(&rel, &data, mtime, exec)?;
                out.changed.push(rel.clone());
            }
            seen.insert(rel);
        } else {
            // Sockets, pipes and devices have no place in a vault.
            out.skipped.push(rel);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn is_exec(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o100 != 0
}

#[cfg(not(unix))]
fn is_exec(_meta: &fs::Metadata) -> bool {
    false
}

/// Removes the plaintext tree.
pub fn wipe(dir: &Path) -> Result<()> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Encrypts a folder's files into `efs` (an import). Unlike [`sync_back`]
/// nothing already in `efs` is removed. Returns the number of files added
/// or changed.
pub fn import(efs: &mut Efs, source: &Path) -> Result<Synced> {
    let mut out = Synced::default();
    let mut seen = BTreeSet::new();
    walk(efs, source, source, SKIP_DIRS, &mut seen, &mut out)?;
    efs.flush()?;
    Ok(out)
}
