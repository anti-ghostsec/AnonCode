# AnonCode roadmap

Built in verifiable layers. Each phase stays runnable and tested.

## Done (foundation)

- **Encrypted vault** (`src/crypto/vault.ts`) — passphrase → memory-hard KDF →
  AES-256-GCM. Master key never persisted. Tampering detected.
- **Encrypted in-folder store** (`src/store/store.ts`) — every record sealed,
  atomic writes, path-escape guarded, all under `./.anoncode/`.
- **Media normalization policy** (`src/media/`) — inspect image dimensions with
  no dependencies; decide ok / upscale / downscale / reject against per-provider
  limits; placeholder fallback. This is what stops the "too-small image →
  model refuses → retry forever" loop *at the source*.
- **Loop guard** (`src/agent/loopguard.ts`) — hard caps on total steps,
  repeated identical errors, and no-progress stalls. The safety net that makes
  an infinite agent loop structurally impossible.
- **CLI** — `init`, `unlock`, `status`, `selftest`, `config`, `chat`.
- **Session + message model** (`src/session/`) — typed `Session`/`Message`
  records on `EncryptedStore` (`sessions`, `messages/<sessionId>`), ordered,
  encrypted, isolated per session.
- **Encrypted provider config** (`src/config/config.ts`) — provider settings
  and API keys sealed in the vault; no plaintext dotenv.
- **Provider adapters** (`src/providers/`) — `Provider` interface with
  Anthropic, OpenAI-compatible (covers local/Ollama), and a Mock adapter;
  normalized `ProviderError` kinds.
- **Guarded agent loop** (`src/agent/loop.ts`) — preflight → generate →
  remediate (strip refused images) / backoff / fatal, all inside `LoopGuard`.
  Proven by tests to resolve the refused-image case and to stop (not hang) when
  a provider fails forever.

- **FOCUS context compression** (`src/context/`) — decision-preserving
  compression from arXiv:2609.37590: spans as (reasoning, action, observation)
  units; Monte Carlo draft-model citation scoring with a τ threshold; a
  defensive pass that always keeps errors, the task goal, system spans, and
  recent state; verbatim retention; an optional hard cap; and a full audit
  report. Draft model is pluggable — a dependency-free heuristic default and an
  LLM-backed `ModelDraftModel`. Wired into `chat`.

- **Tool system + agent loop** (`src/tools/`, `src/agent/`) — read/write/edit/
  ls/glob/grep/bash with a workspace-root path guard, a **read-before-write**
  rule, and a permission gate. The `edit` tool uses a **tolerant replacer
  chain** (exact → line-trimmed → whitespace-normalized → block-anchor) so
  imperfect match strings still land. A provider-agnostic text tool protocol
  (fenced `tool` blocks) drives a multi-step loop guarded by `LoopGuard`, with
  a **diagnostics feedback pass** after each edit (opencode's key technique for
  weak models — `DiagnosticsProvider`, default off / command-based). System
  prompt includes environment + tools + AGENTS.md/CLAUDE.md. Plan vs build
  tool sets. Wired into `chat`.

- **Encrypted project filesystem** (`src/vfs/`) — every project file (source,
  docs, AGENTS.md, downloads) is a sealed blob in the vault, listed via an
  encrypted manifest; nothing is written to disk as plaintext. The file tools
  operate on this FS. A `bash`/diagnostics **runspace** is an ephemeral
  plaintext mirror under `.anoncode/run/`, materialized while a session is
  active and wiped on exit. `export`/`import` decrypt-to-folder / encrypt-in.
  AGENTS.md is read from the encrypted FS.

- **Real LSP diagnostics** (`src/lsp/`) — a JSON-RPC-over-stdio language-server
  client: framing codec, request/notify + `publishDiagnostics` tracking, and an
  `LspDiagnostics` provider that opens/updates changed files in the server
  (rooted at the runspace), waits with a 150ms debounce / 3s timeout, and feeds
  formatted errors/warnings back. Servers start lazily, persist across edits,
  and are killed on dispose; a missing binary is skipped (never blocks the
  loop). Configurable per language; preferred over the command-based checker.

- **Full-screen TUI** (`src/tui/`) — zero-dependency terminal UI: alternate
  screen buffer, raw-mode input, live transcript with word-wrap and per-role
  colors, a status/spinner line, inline permission prompts, input history, and
  PgUp/PgDn scrollback. Pure logic (ANSI layout, key parsing, line editor,
  transcript) is unit-tested; `tui` command, TTY-gated, with `chat` as the
  plain-line fallback.

- **Local web GUI** (`src/server/`) — a sleek browser UI over the same
  encrypted engine. A Bun HTTP server bound to `127.0.0.1` and gated by a
  per-process secret token exposes unlock, an SSE event stream, message, and a
  permission round-trip; the single-page frontend (dark theme, chat bubbles,
  tool/diagnostics chips, permission modal) talks to it. `anoncode gui`, plus
  `--demo` (throwaway vault + mock model). The vault is unlocked in-process; the
  passphrase only ever goes to localhost.

## Next

### Phase 3b — Tool system refinements
Built, including **persisted tool traces** — the full step trace (assistant
turns with `tool_call` parts + `tool_result` parts, errors flagged) is saved as
encrypted session messages, so tool context survives between turns and flows
into FOCUS. Assistant text is stored stripped of the raw tool block, with a
compact `[called X]` note, so large writes aren't replayed verbatim.

Remaining refinements:
- Native provider function-calling as an alternative to the text protocol for
  stronger models, behind the same loop.
- `subagent`/`task` tool and a `todo` tool.
- Persistent snapshots + `/undo` (snapshot seam already exists in ToolContext).

### Phase 4 — TUI polish
Core TUI is built. Nice-to-haves: streaming token-by-token output (needs
streaming providers), file references (`@` fuzzy-find), image paste, a
scrollable tool-output pane, and `/undo`.

### Phase 5 — FOCUS tuning (done; refinements remain)
Core FOCUS is built (`src/context/`). Remaining refinements:
- Real token counting (provider tokenizer) in place of the 4-chars/token
  estimate, so `memoryBudgetTokens`/`hardCapTokens` are exact.
- Default to the LLM-backed `ModelDraftModel` with a cheap model when one is
  configured, keeping the heuristic as the offline fallback.
- Surface the per-span audit report via a `--explain` flag.

### Phase 6 — Hardening
- Optional **Argon2id** KDF (`@node-rs/argon2`) behind the existing KDF
  interface; auto-upgrade vault params.
- Idle **auto-lock** (wipe key after N minutes).
- Encrypted config for provider keys + per-provider image limits.
- Actual pixel resizing for upscale/downscale (via `sharp`/`jimp`), with the
  placeholder path as the zero-dependency fallback.

## Open questions for later

- Which providers/models to prioritize first.
- Whether to support multiple vaults (per-project passphrases) or one.
- TUI framework (raw ANSI vs. a library) for the chat view.
