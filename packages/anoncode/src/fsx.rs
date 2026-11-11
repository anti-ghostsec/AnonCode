//! File helpers: private atomic writes and path checks.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use crate::{Error, Result};

/// Replaces the file at `path` with `bytes`, so that after a crash it holds
/// either the old contents or the new, whole. The temporary file is created
/// 0600 as it is opened, never through an existing file or link. With
/// `durable`, the file and its folder are flushed to the disk as well.
pub fn write_private_atomic(path: &Path, bytes: &[u8], durable: bool) -> io::Result<()> {
    let name = path.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?;
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    let (tmp, mut file) = create_private(dir, name)?;
    let mut written = file.write_all(bytes);
    if durable {
        written = written.and_then(|()| file.sync_all());
    }
    drop(file);
    if let Err(e) = written.and_then(|()| fs::rename(&tmp, path)) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if durable {
        sync_dir(dir)?;
    }
    Ok(())
}

fn create_private(dir: &Path, name: &std::ffi::OsStr) -> io::Result<(PathBuf, File)> {
    for _ in 0..16 {
        let mut r = [0u8; 8];
        getrandom::getrandom(&mut r).map_err(io::Error::other)?;
        let mut tmp = OsString::from(".");
        tmp.push(name);
        tmp.push(format!(".{:016x}.tmp", u64::from_le_bytes(r)));
        let tmp = dir.join(tmp);
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        match opts.open(&tmp) {
            Ok(file) => return Ok((tmp, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "no free temporary file name"))
}

#[cfg(unix)]
pub fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
pub fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// Creates a folder (and its parents) that only its owner can enter.
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

/// A real folder (not a link) owned by this user that no one else can
/// read, write or enter.
#[cfg(unix)]
pub fn is_private_dir(dir: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match fs::symlink_metadata(dir) {
        Ok(m) => m.is_dir() && m.uid() == unsafe { libc::getuid() } && m.mode() & 0o077 == 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
pub fn is_private_dir(dir: &Path) -> bool {
    dir.is_dir()
}

/// A record or collection name that can't be a path: letters, digits, `_`,
/// `.`, `-`; not starting with `.` or `-`; no `..`.
pub fn safe_name(name: &str, kind: &str) -> Result<()> {
    let first_ok = name.bytes().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_');
    let rest_ok = name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'));
    if first_ok && rest_ok && !name.contains("..") && name.len() <= 200 {
        Ok(())
    } else {
        Err(Error::Unsafe(format!("{kind} {name:?}")))
    }
}

/// Normalises a project-relative path (`/` separators, no `.` or empty
/// parts) and refuses one that would leave the project.
pub fn norm_vpath(p: &str) -> Result<String> {
    let mut parts = Vec::new();
    for seg in p.split(['/', '\\']) {
        match seg {
            "" | "." => {}
            ".." => return Err(Error::Unsafe(format!("path {p:?}"))),
            s if s.contains('\0') => return Err(Error::Unsafe(format!("path {p:?}"))),
            s => parts.push(s),
        }
    }
    Ok(parts.join("/"))
}

/// `base` joined with a relative path that has only normal parts.
pub fn join_within(base: &Path, rel: &str) -> Result<PathBuf> {
    let rel = norm_vpath(rel)?;
    let p = Path::new(&rel);
    if p.components().any(|c| !matches!(c, Component::Normal(_))) && !rel.is_empty() {
        return Err(Error::Unsafe(format!("path {rel:?}")));
    }
    Ok(base.join(p))
}
