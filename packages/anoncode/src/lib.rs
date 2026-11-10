//! AnonCode's encryption core.
//!
//! * [`vault`]: passphrase -> scrypt -> AES-256-GCM, in the first AnonCode's
//!   format.
//! * [`store`]: sealed records in folders; nothing readable on disk.
//! * [`efs`]: a project's files as sealed blobs behind a sealed manifest.
//! * [`runspace`]: the plaintext copy tools need while a project is open,
//!   and getting changes back out of it.
//! * [`projects`]: the list of projects, each its own vault.
//! * [`focus`]: FOCUS context compression (which spans of a conversation
//!   to keep).

#[cfg(feature = "gui")]
pub mod api;
pub mod efs;
pub mod focus;
pub mod fsx;
#[cfg(feature = "gui")]
pub mod gui;
pub mod http;
pub mod projects;
pub mod runspace;
pub mod store;
pub mod supervisor;
pub mod vault;

use std::fmt;
use std::io;

#[derive(Debug)]
pub enum Error {
    Io(io::Error),
    /// The seal on the vault's check value doesn't verify.
    WrongPassphrase,
    /// A sealed record doesn't verify or can't be parsed. Deliberately the
    /// same whether it was changed, cut short or sealed under another key.
    Damaged,
    /// The key derivation cost is out of range. Nothing was derived.
    Kdf,
    /// A name or path that could leave the folder it belongs to.
    Unsafe(String),
    Other(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(e) => write!(f, "storage error: {e}"),
            Error::WrongPassphrase => f.write_str("wrong passphrase"),
            Error::Damaged => f.write_str("damaged or tampered data"),
            Error::Kdf => f.write_str("key derivation cost out of range"),
            Error::Unsafe(s) => write!(f, "unsafe name or path: {s}"),
            Error::Other(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Error::Damaged
    }
}

pub type Result<T> = std::result::Result<T, Error>;
