# AnonCode

A private, **encryption-first** AI coding agent — an opencode-style terminal
agent rebuilt from the ground up so that:

- **Nothing is stored in plaintext.** Every chat, message, config value, and
  **project file the agent reads or creates** (source, docs, AGENTS.md,
  downloads) is sealed with AES-256-GCM under a key derived from your
  passphrase. The raw files on disk are indistinguishable from random without
  it — there is no readable `.db` and nothing in `/tmp`.
- **The project is locked up until you export it.** The agent works on an
  encrypted in-vault filesystem. `anoncode export <dir>` is the only thing that
  writes plaintext — the deliberate unlock for building or pushing to GitHub.
- **Nothing leaves the folder.** All runtime data lives under `./.anoncode/`
  inside this project directory. AnonCode never writes to `~/.config`,
  `~/.local/share`, or system temp.
- **It can't hang on a bad image.** A known opencode failure — a model refusing
  a too-small image and the agent retrying forever — is fixed here by
  normalizing media before it's sent and by a hard loop guard.

> Status: **a working agent with a UI.** Encrypted storage, encrypted project
> filesystem, session model, provider adapters (Anthropic,
> OpenAI-compatible/local, mock), media preflight, the guarded agent loop,
> **FOCUS compression**, a **tool-using agent** (read/write/edit/bash/glob/grep)
> with **real LSP diagnostics feedback**, persisted tool traces, a
> **zero-dependency full-screen TUI**, and a **sleek local web GUI** are built
> and tested. See `docs/ROADMAP.md` for what's next.

## Projects

AnonCode is **multi-project**: a tab bar across the top lets you keep separate
projects, and **each project is its own independent encrypted vault** (its own
passphrase, its own sealed chats and files) — so they're cryptographically
isolated, not just folders. Click **+** to create one, click a tab to switch
(locked projects prompt for their passphrase; a ● / ○ dot shows which are
open), double-click to rename, and × to delete. An existing single-vault install
is adopted automatically as the **Default** project, in place — nothing moves.

> The tab list (`.anoncode/projects/index.json`) stores only project *names* and
> ids in the clear so tabs can render before anything is unlocked; all actual
> content stays sealed. Keep project names non-sensitive.

## Interfaces

AnonCode has three ways to use it, all over the same encrypted engine:

- `anoncode gui` — a sleek local web UI. It starts a Bun server on `127.0.0.1`
  (gated by a one-time token) and **auto-opens your browser** to the right URL.
  Try it with `anoncode gui --demo` (throwaway vault + mock model, no setup).
- `anoncode tui` — a full-screen terminal UI.
- `anoncode chat` — a plain line-mode REPL (good for piping / no TTY).

**It is a web app, not a file to open.** Double-clicking `index.html` shows a
blank page because there is no server behind it. Launch it one of these ways:

- `bun run src/cli/index.ts gui` (or `./bin/anoncode gui`) — opens the browser
  for you.
- Double-click **`scripts/anoncode-gui.sh`** (or the **`AnonCode.desktop`**
  launcher) to start it without a terminal command. On GNOME you may first need
  to right-click the `.desktop` file → *Allow Launching* (or
  `gio set AnonCode.desktop metadata::trusted true`).

The URL includes a security token — open the exact URL the command prints; a
URL without the token shows an "open the exact URL" notice rather than working.

**First run is handled in the GUI.** If there's no vault yet, the page walks you
through creating one (set a passphrase) and connecting a model, then drops you
into chat. No `anoncode init` / `anoncode config` required (those CLI commands
still work if you prefer).

Connecting a model is a **one-click preset list** (like opencode's): Anthropic,
OpenAI, Google Gemini, OpenRouter, Groq, DeepSeek, Venice AI, Mistral, xAI,
Together, Fireworks, Cerebras, Ollama / LM Studio (local), or a custom
OpenAI-compatible endpoint. Picking one fills in the engine, base URL, and suggested models, so a
Groq or OpenRouter key no longer silently goes to the wrong host. The API key is
**validated with one tiny request before it's saved**, so a wrong key is caught
right there (with a clear message) instead of failing mid-chat — and the key is
sealed in the encrypted vault, never written in plaintext.

Model lists come **live from the provider's own API** (`/models`), not a canned
list — hit **"↻ load from provider"** in the connect form, and the chat header
has an **inline model dropdown** so you can switch models mid-session without
opening settings.

Responses **stream** as they're generated, and when a model reasons (DeepSeek-R1
and friends, `<think>` blocks, `reasoning_content`) the chain-of-thought is
pulled into a live, collapsible **thinking panel** — separate from the answer,
so you can watch it reason and catch mistakes. If a model puts everything in its
reasoning and returns no answer, you get a clear note instead of a blank bubble.

A **reviewer loop** (the **Loop** pill above the composer) runs a second agent
that reviews each turn against your mission and feeds a concrete correction back
to the worker — catching mistakes and goal drift automatically — until it
approves or hits the round limit. Arm it with a review instruction (and an
optional separate reviewer model); reviewer verdicts (continue / done / blocked)
show inline as you watch it self-correct.

A **settings panel** (gear, top-right) lets you switch model/provider, flip
between **Build** (can edit/run) and **Plan** (read-only) mode, choose a
**permission mode** — **Ask** (prompt each time) or **Auto** (approve
automatically, opencode-style) — **export** the decrypted project to a folder,
or **lock** the vault — all without leaving the chat. It closes only with the ✕
or **Escape** (an outside click won't dismiss it).

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 (this repo was built against 1.4).
- No network needed for the crypto core — it uses the runtime's built-in
  primitives with zero external dependencies.

## Quick start

```bash
# (optional) install dev dependencies for type-checking
bun install

# create your encrypted vault (sets your passphrase)
bun run src/cli/index.ts init

# configure an AI provider (API key is sealed in the vault)
bun run src/cli/index.ts config

# (optional) pull an existing codebase into the encrypted project
bun run src/cli/index.ts import ../my-project

# start the full-screen UI (the agent works on the in-vault project)
bun run src/cli/index.ts tui
# ...or a plain line-mode chat (good for piping / no TTY)
bun run src/cli/index.ts chat

# when ready to build/ship: decrypt the project to a real folder
bun run src/cli/index.ts export ./out

# other commands
bun run src/cli/index.ts unlock     # verify your passphrase
bun run src/cli/index.ts selftest   # round-trip an encrypted record
bun run src/cli/index.ts status     # vault + storage status
```

For a fully local, no-data-leaves-the-machine setup, point the OpenAI-compatible
provider at a local server (e.g. Ollama at `http://localhost:11434/v1`) with a
blank API key.

Or use the launcher: `./bin/anoncode <command>`.

Run the tests:

```bash
bun test
```

## Security model

| Property | How |
| --- | --- |
| Key derivation | Memory-hard KDF (scrypt, ~64 MiB) over your passphrase + a random per-vault salt. Pluggable — Argon2id can replace it behind the same interface. |
| Encryption | AES-256-GCM per record (random 96-bit nonce, 128-bit auth tag). Tampering is detected on decrypt. |
| Key at rest | **Never.** Only KDF params, the salt, and an encrypted verifier are written (`.anoncode/vault.json`). The master key exists only in memory while unlocked and is wiped on lock/exit. |
| Project files | Stored in an encrypted filesystem (`src/vfs/`): each file is a sealed blob, listed via an encrypted manifest. The agent never writes project files to disk as plaintext. |
| Running tools | `bash`/tests/compilers need real files, so an ephemeral plaintext **runspace** (`.anoncode/run/`) is materialized while a session is active and **wiped on exit**. Plaintext exists only transiently, only inside the folder. |
| Export | `anoncode export <dir>` decrypts to a folder on purpose (with confirmation). `anoncode import <dir>` encrypts a folder in. |
| Recovery | None by design. No passphrase = no data. There is no backdoor. |
| Scope | Everything is confined to `./.anoncode/`; collection, record, and virtual file paths are validated against path-escape. |

See `docs/ARCHITECTURE.md` for internals and `docs/ROADMAP.md` for what's next.

## Layout

```
src/
  config/paths.ts     in-folder path roots + escape guard
  crypto/vault.ts     passphrase -> key, AES-256-GCM seal/open
  store/store.ts      encrypted, filesystem-backed object store
  media/inspect.ts    dependency-free image dimension reader
  media/policy.ts     normalize/placeholder policy (anti refuse-loop)
  session/            typed Session/Message model on the encrypted store
  providers/          Provider interface + anthropic / openai / mock adapters
  context/            FOCUS compression: spans, draft models, compressor
  vfs/                encrypted project filesystem + runspace + export/import
  lsp/                JSON-RPC language-server client + live diagnostics
  tools/              read/write/edit/bash/glob/grep + tolerant replacer + diagnostics
  agent/loopguard.ts  iteration + repeated-failure caps (anti hang)
  agent/loop.ts       preflight -> generate -> remediate, guarded
  agent/agentloop.ts  multi-step tool loop + diagnostics feedback
  agent/toolcall.ts   provider-agnostic tool-call protocol
  agent/prompt.ts     system prompt (env + tools + AGENTS.md)
  tui/                zero-dep full-screen UI (ansi, keys, editor, transcript)
  server/             local web GUI: Bun API server (SSE) + single-page frontend
  cli/                passphrase prompt + commands (init/config/gui/tui/chat/...)
tests/                unit tests for all of the above (85 tests)
```
