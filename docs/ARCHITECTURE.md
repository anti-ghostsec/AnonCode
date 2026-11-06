# AnonCode architecture

## Principles

1. **Encrypted at rest, always.** Plaintext exists only in memory while the
   vault is unlocked. Anything written to disk is sealed.
2. **In-folder only.** The single source of truth for runtime paths is
   `src/config/paths.ts`, rooted at the project directory. Every write goes
   through it and through a path-escape guard.
3. **No silent loops.** Any repeated-work path (agent steps, retries) is bounded
   by `src/agent/loopguard.ts`.
4. **Few dependencies.** The security core uses only the runtime's built-in
   crypto, so it audits easily and runs offline.

## Data flow

```
passphrase ──▶ Vault.deriveKey (scrypt, salt) ──▶ master key (memory only)
                                                      │
record ──▶ JSON ──▶ Vault.encrypt (AES-256-GCM) ──▶ Envelope{iv,tag,ct}
                                                      │
                                           EncryptedStore ──▶ ./.anoncode/<collection>/<id>.enc
```

- **Vault** (`crypto/vault.ts`): derives the master key and seals/opens
  `Envelope`s. `VaultHeader` (KDF params, salt, encrypted verifier) is the only
  thing persisted about the key. `unlock` verifies the passphrase by decrypting
  the verifier; a bad key fails GCM authentication → `WrongPassphraseError`.
- **EncryptedStore** (`store/store.ts`): collection/id → sealed `.enc` file.
  Atomic writes (temp + rename), `0o600` mode, sortable `newId()` so listings
  are chronological. No plaintext index.

## Media preflight (the opencode loop fix)

```
image bytes ──▶ inspectImage (header parse, no deps) ──▶ {format,w,h}
            ──▶ planImage(limits) ──▶ ok | upscale | downscale | reject
                                         │
            resizer present? ── yes ──▶ normalize to target dims ──▶ send
                             └─ no / reject ──▶ imagePlaceholder() ──▶ send text
```

The provider adapter calls `planImage` before sending. An image that would be
refused is reshaped or replaced, so the model never errors on it. If a refusal
still happens (unknown provider rule), the adapter builds an `errorSignature`
and hands it to the loop guard, which trips after a few identical failures
instead of retrying forever.

## Loop guard

`LoopGuard` wraps the agent step loop:

- `beginStep()` — enforces `maxSteps`.
- `recordError(sig)` — trips after `maxRepeatedErrors` identical failures.
- `recordProgress(sig)` — trips after `maxRepeatedStalls` identical no-progress
  signatures; any new signature (real progress) resets the streaks.

Errors and progress are distinguished deliberately: FOCUS (Phase 5) must retain
error spans, and the guard already treats them as a first-class category.

## Why filesystem, not SQLite

The requirement is that chats and files are not readable outside the chat. A
single `.db` invites being opened by any SQLite browser. Instead each record is
an independently-sealed blob; there is no database schema or plaintext to open,
and corruption is contained to one record. SQLCipher could be added later behind
the same `EncryptedStore` interface if a query layer is needed.
