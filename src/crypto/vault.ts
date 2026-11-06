import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";

/**
 * AnonCode vault: a passphrase-locked AES-256-GCM key store.
 *
 * A master key is derived from the user's passphrase with a memory-hard KDF
 * and a random per-vault salt. The master key never touches disk — only the
 * KDF parameters, the salt, and an encrypted verifier are persisted (the
 * VaultHeader). Every record AnonCode stores is sealed with AES-256-GCM under
 * the master key, so the raw files on disk are indistinguishable from random
 * without the passphrase.
 *
 * The KDF is pluggable (see KdfParams). The default is scrypt, which is
 * memory-hard and ships inside the runtime with zero external dependencies —
 * a deliberate choice for a privacy tool that must work fully offline.
 * Argon2id can be slotted in behind the same interface later.
 */

export type KdfParams = {
  algo: "scrypt";
  /** CPU/memory cost; must be a power of two. */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelization. */
  p: number;
  /** Derived key length in bytes (32 = AES-256). */
  keyLen: number;
};

export type Envelope = {
  /** base64, 12-byte GCM nonce */
  iv: string;
  /** base64, 16-byte GCM auth tag */
  tag: string;
  /** base64 ciphertext */
  ct: string;
};

export type VaultHeader = {
  version: 1;
  kdf: KdfParams;
  /** base64 random salt */
  salt: string;
  /** encryption of CHECK_MAGIC under the master key; used to verify unlock */
  check: Envelope;
};

// ~64 MiB of memory for the KDF (128 * N * r bytes). Strong for interactive
// unlock on a laptop; raise N for a harder target.
const DEFAULT_KDF: KdfParams = { algo: "scrypt", N: 1 << 16, r: 8, p: 1, keyLen: 32 };

const CHECK_MAGIC = Buffer.from("anoncode-vault-v1-check", "utf8");

export class WrongPassphraseError extends Error {
  constructor() {
    super("wrong passphrase or corrupted/tampered vault");
    this.name = "WrongPassphraseError";
  }
}

export class Vault {
  private constructor(
    private key: Buffer,
    readonly header: VaultHeader,
  ) {}

  /** Derive the master key from a passphrase + salt under the given KDF. */
  static deriveKey(passphrase: string, salt: Buffer, kdf: KdfParams): Buffer {
    if (kdf.algo !== "scrypt") {
      throw new Error(`unsupported KDF: ${kdf.algo}`);
    }
    // node's default maxmem (32 MiB) is below our cost; raise it past 128*N*r.
    const maxmem = 256 * kdf.N * kdf.r + (1 << 20);
    return scryptSync(Buffer.from(passphrase, "utf8"), salt, kdf.keyLen, {
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      maxmem,
    });
  }

  /** Create a brand-new vault locked to `passphrase`. */
  static create(passphrase: string, kdf: KdfParams = DEFAULT_KDF): Vault {
    if (passphrase.length === 0) throw new Error("passphrase must not be empty");
    const salt = randomBytes(16);
    const key = Vault.deriveKey(passphrase, salt, kdf);
    const check = seal(key, CHECK_MAGIC);
    const header: VaultHeader = {
      version: 1,
      kdf,
      salt: salt.toString("base64"),
      check,
    };
    return new Vault(key, header);
  }

  /** Re-open an existing vault. Throws WrongPassphraseError on a bad key. */
  static unlock(passphrase: string, header: VaultHeader): Vault {
    if (header.version !== 1) throw new Error(`unsupported vault version: ${header.version}`);
    const salt = Buffer.from(header.salt, "base64");
    const key = Vault.deriveKey(passphrase, salt, header.kdf);
    let plain: Buffer;
    try {
      plain = open(key, header.check);
    } catch {
      throw new WrongPassphraseError();
    }
    if (plain.length !== CHECK_MAGIC.length || !timingSafeEqual(plain, CHECK_MAGIC)) {
      throw new WrongPassphraseError();
    }
    return new Vault(key, header);
  }

  encrypt(data: Buffer): Envelope {
    return seal(this.key, data);
  }

  decrypt(env: Envelope): Buffer {
    return open(this.key, env);
  }

  encryptString(s: string): Envelope {
    return this.encrypt(Buffer.from(s, "utf8"));
  }

  decryptString(env: Envelope): string {
    return this.decrypt(env).toString("utf8");
  }

  /** Wipe the in-memory key. Call on lock/exit. */
  destroy(): void {
    this.key.fill(0);
  }
}

function seal(key: Buffer, data: Buffer): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

function open(key: Buffer, env: Envelope): Buffer {
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  const ct = Buffer.from(env.ct, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  // final() throws if the tag does not verify (tampering / wrong key).
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
