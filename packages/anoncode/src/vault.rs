//! The vault: a passphrase-locked AES-256-GCM key, in AnonCode's format.
//!
//! The master key comes from the passphrase with scrypt and a random
//! per-vault salt. It is never written anywhere: the header on disk
//! (`vault.json`) holds only the scrypt cost, the salt and an encrypted
//! check value. Everything else AnonCode stores is sealed under that key,
//! each record with its own random 96-bit nonce and a 128-bit tag.
//!
//! The header and the JSON envelope are byte-compatible with the first
//! AnonCode (`src/crypto/vault.ts`), so its vaults open here.
//!
//! The cost in a header is checked against a minimum and a maximum before
//! scrypt allocates anything: a planted header can neither make the key
//! cheap to guess nor make the app allocate gigabytes.

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

use crate::{Error, Result};

pub const KEY: usize = 32;
pub const NONCE: usize = 12;
pub const TAG: usize = 16;
const CHECK_MAGIC: &[u8] = b"anoncode-vault-v1-check";
/// First bytes of a binary sealed blob: `ANC1 | nonce | tag | ciphertext`.
pub const BLOB_MAGIC: &[u8; 4] = b"ANC1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub algo: String,
    /// CPU/memory cost, a power of two.
    #[serde(rename = "N")]
    pub n: u64,
    pub r: u32,
    pub p: u32,
    #[serde(rename = "keyLen")]
    pub key_len: u32,
}

impl KdfParams {
    /// 64 MiB (128 * N * r bytes), the cost the first AnonCode used.
    pub fn default_cost() -> Self {
        KdfParams { algo: "scrypt".into(), n: 1 << 16, r: 8, p: 1, key_len: 32 }
    }

    /// Tiny cost for tests only; `check` refuses it.
    pub fn for_tests() -> Self {
        KdfParams { algo: "scrypt".into(), n: 1 << 10, r: 8, p: 1, key_len: 32 }
    }

    /// From 16 MiB up to 1 GiB, and only shapes scrypt accepts.
    pub fn check(&self) -> Result<()> {
        let mem = 128u64.saturating_mul(self.n).saturating_mul(self.r as u64);
        let ok = self.algo == "scrypt"
            && self.key_len as usize == KEY
            && self.n.is_power_of_two()
            && (1 << 14..=1 << 20).contains(&self.n)
            && (8..=32).contains(&self.r)
            && (1..=4).contains(&self.p)
            && mem <= 1 << 30;
        if ok {
            Ok(())
        } else {
            Err(Error::Kdf)
        }
    }
}

/// A sealed record as JSON: base64 nonce, tag and ciphertext.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub iv: String,
    pub tag: String,
    pub ct: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultHeader {
    pub version: u32,
    pub kdf: KdfParams,
    /// base64 random salt
    pub salt: String,
    /// The check value sealed under the master key, to verify an unlock.
    pub check: Envelope,
}

/// An unlocked vault. Holds the derived key, never the passphrase. The key
/// is wiped when the vault is dropped.
pub struct Vault {
    key: Zeroizing<[u8; KEY]>,
    pub header: VaultHeader,
}

impl Vault {
    pub fn create(passphrase: &str) -> Result<Vault> {
        Self::create_with(passphrase, KdfParams::default_cost(), true)
    }

    /// `checked: false` lets tests use a cost `KdfParams::check` refuses.
    pub fn create_with(passphrase: &str, kdf: KdfParams, checked: bool) -> Result<Vault> {
        if passphrase.is_empty() {
            return Err(Error::Other("the passphrase must not be empty".into()));
        }
        if checked {
            kdf.check()?;
        }
        let mut salt = [0u8; 16];
        random(&mut salt)?;
        let key = derive(passphrase, &salt, &kdf)?;
        let check = envelope(&key, CHECK_MAGIC)?;
        Ok(Vault { key, header: VaultHeader { version: 1, kdf, salt: B64.encode(salt), check } })
    }

    pub fn unlock(passphrase: &str, header: &VaultHeader) -> Result<Vault> {
        Self::unlock_with(passphrase, header, true)
    }

    pub fn unlock_with(passphrase: &str, header: &VaultHeader, checked: bool) -> Result<Vault> {
        if header.version != 1 {
            return Err(Error::Other(format!("unsupported vault version {}", header.version)));
        }
        if checked {
            header.kdf.check()?;
        }
        let salt = B64.decode(&header.salt).map_err(|_| Error::Damaged)?;
        if salt.len() < 16 {
            return Err(Error::Damaged);
        }
        let key = derive(passphrase, &salt, &header.kdf)?;
        let plain = open_envelope(&key, &header.check).map_err(|_| Error::WrongPassphrase)?;
        if plain.len() != CHECK_MAGIC.len() || !bool::from(plain.ct_eq(CHECK_MAGIC)) {
            return Err(Error::WrongPassphrase);
        }
        Ok(Vault { key, header: header.clone() })
    }

    /// A secret for naming records, so a record's name on disk says nothing
    /// about what it holds to someone without the passphrase.
    pub fn name_key(&self) -> Zeroizing<[u8; 32]> {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"anoncode-record-names-v1");
        h.update(&self.key[..]);
        Zeroizing::new(h.finalize().into())
    }

    /// Seals `data` as a JSON envelope (the first AnonCode's record format).
    pub fn seal_envelope(&self, data: &[u8]) -> Result<Envelope> {
        envelope(&self.key, data)
    }

    pub fn open_envelope(&self, env: &Envelope) -> Result<Zeroizing<Vec<u8>>> {
        open_envelope(&self.key, env)
    }

    /// Seals `data` as a binary blob: `ANC1 | nonce | tag | ciphertext`.
    pub fn seal(&self, data: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0u8; NONCE];
        random(&mut nonce)?;
        let mut out = Vec::with_capacity(4 + NONCE + TAG + data.len());
        out.extend_from_slice(BLOB_MAGIC);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&[0u8; TAG]);
        out.extend_from_slice(data);
        let body = 4 + NONCE + TAG;
        let tag = cipher(&self.key)
            .encrypt_in_place_detached(Nonce::from_slice(&nonce), BLOB_MAGIC, &mut out[body..])
            .map_err(|_| Error::Damaged)?;
        out[4 + NONCE..body].copy_from_slice(&tag);
        Ok(out)
    }

    /// Opens a sealed record in either format: a binary blob, or a JSON
    /// envelope written by the first AnonCode.
    pub fn open(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        if sealed.first() == Some(&b'{') {
            let env: Envelope = serde_json::from_slice(sealed).map_err(|_| Error::Damaged)?;
            return self.open_envelope(&env);
        }
        let body = 4 + NONCE + TAG;
        if sealed.len() < body || &sealed[..4] != BLOB_MAGIC {
            return Err(Error::Damaged);
        }
        let mut plain = Zeroizing::new(sealed[body..].to_vec());
        cipher(&self.key)
            .decrypt_in_place_detached(
                Nonce::from_slice(&sealed[4..4 + NONCE]),
                BLOB_MAGIC,
                &mut plain,
                Tag::from_slice(&sealed[4 + NONCE..body]),
            )
            .map_err(|_| Error::Damaged)?;
        Ok(plain)
    }
}

fn cipher(key: &[u8; KEY]) -> Aes256Gcm {
    Aes256Gcm::new(key.into())
}

fn derive(passphrase: &str, salt: &[u8], kdf: &KdfParams) -> Result<Zeroizing<[u8; KEY]>> {
    if kdf.algo != "scrypt" || kdf.key_len as usize != KEY || !kdf.n.is_power_of_two() || kdf.n < 2 {
        return Err(Error::Kdf);
    }
    let params = scrypt::Params::new(kdf.n.trailing_zeros() as u8, kdf.r, kdf.p, KEY).map_err(|_| Error::Kdf)?;
    let mut key = Zeroizing::new([0u8; KEY]);
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, key.as_mut()).map_err(|_| Error::Kdf)?;
    Ok(key)
}

fn envelope(key: &[u8; KEY], data: &[u8]) -> Result<Envelope> {
    let mut nonce = [0u8; NONCE];
    random(&mut nonce)?;
    let mut buf = data.to_vec();
    let tag = cipher(key).encrypt_in_place_detached(Nonce::from_slice(&nonce), b"", &mut buf).map_err(|_| Error::Damaged)?;
    Ok(Envelope { iv: B64.encode(nonce), tag: B64.encode(tag), ct: B64.encode(&buf) })
}

fn open_envelope(key: &[u8; KEY], env: &Envelope) -> Result<Zeroizing<Vec<u8>>> {
    let iv = B64.decode(&env.iv).map_err(|_| Error::Damaged)?;
    let tag = B64.decode(&env.tag).map_err(|_| Error::Damaged)?;
    if iv.len() != NONCE || tag.len() != TAG {
        return Err(Error::Damaged);
    }
    let mut plain = Zeroizing::new(B64.decode(&env.ct).map_err(|_| Error::Damaged)?);
    cipher(key)
        .decrypt_in_place_detached(Nonce::from_slice(&iv), b"", &mut plain, Tag::from_slice(&tag))
        .map_err(|_| Error::Damaged)?;
    Ok(plain)
}

pub fn random(buf: &mut [u8]) -> Result<()> {
    getrandom::getrandom(buf).map_err(|_| Error::Other("no random numbers available".into()))
}

/// Hex of `n` random bytes.
pub fn random_hex(n: usize) -> Result<String> {
    let mut b = vec![0u8; n];
    random(&mut b)?;
    let s = b.iter().map(|x| format!("{x:02x}")).collect();
    b.zeroize();
    Ok(s)
}
