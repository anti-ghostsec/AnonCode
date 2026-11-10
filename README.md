# AnonCode

A private AI coding agent with a native interface. Every project is its own encrypted vault:
its files, its chats and its API keys are sealed under a passphrase and unreadable without it.

AnonCode is three things put together:

- **The agent** is [opencode](https://github.com/anomalyco/opencode) (v2.2.7), unmodified. It
  does the chat, the tools and the language servers. Its own readme is in
  [README.opencode.md](README.opencode.md).
- **The app** (`packages/anoncode`, Rust) is the window you use and the vault underneath it.
  It is not a web page and has no browser in it.
- **Two plugins** (`packages/anoncode-plugins`) add the reviewer loop and FOCUS context
  compression to the agent.

> Status: early. It runs and has been used against a real model, but parts of the interface
> have only been exercised by a script. See "What's missing".

## Using it

```sh
./anoncode
```

The first run builds the app and installs the agent's dependencies. You need
[Rust](https://rustup.rs) and [Bun](https://bun.sh) 1.4.

- **Projects are tabs** across the top, like a browser. `+` makes a new one; a locked project
  shows a lock. Double-click a tab to rename it, right-click to delete it.
- **Unlocking** a project asks for its passphrase and starts an agent for it. **Lock** (or
  closing the window) seals everything and stops the agent.
- **Providers…** connects a model provider with your own API key. The key is stored in that
  project's sealed data. No models are available until you connect one: opencode's hosted
  models, web search and sharing are switched off, and the model list is not fetched from the
  network.
- **+** in the message box attaches files; you can also drop files on the window.
- **Loop…** starts a reviewer that checks each turn against your request and tells the agent
  what to do next. Its messages appear in the chat like any other
  ([more](packages/anoncode-plugins/loop/README.md)).
- **Import** copies a folder into a project. **Export** decrypts a project to a folder.

## What is sealed, and how

| | |
| --- | --- |
| Key | scrypt (64 MiB) over your passphrase and a random salt. The cost stored in a vault is checked against a minimum and a maximum before anything is derived. |
| Encryption | AES-256-GCM, a fresh random nonce per record, tampering detected on open. |
| Key at rest | Never written. Only the cost, the salt and a sealed check value are on disk. The key is wiped from memory on lock. |
| Project files | One sealed record per file, listed by a sealed manifest. Record names are a keyed hash of the path, so a name can't be matched against a guessed path. |
| Chats, keys, settings | The agent's database is sealed with the project. While unlocked it exists only in memory (`/dev/shm`), never on disk. |
| Working copy | Tools need real files, so while a project is unlocked its files are plaintext under `.anoncode/projects/<id>/run/work`. Locking seals what changed and wipes it. |
| After a crash | The leftover working copy is sealed at the next unlock before anything else. |
| Recovery | None. A lost passphrase means the project is gone. |

Everything AnonCode stores is under `.anoncode/` in this folder. Vaults made by the first
AnonCode (same scrypt and AES-256-GCM format) still open.

**What it does not protect.** How many files a project has, roughly how big each is and when it
last changed are visible on disk, as are project names. While a project is unlocked, anything
running as you can read its working copy. A power cut loses chat history since the last lock or
"Save to vault". The agent's plan folder (`~/.opencode/plan`) and its terminal sockets (`/tmp`)
are outside the vault, and so is `.anoncode/cache`, which holds the agent's compiled code and
downloaded tools, not your data.

## FOCUS

When a chat outgrows 60% of the model's context window, whole spans of it (an assistant message
with its tool results) are left out of what the model is sent. What stays is sent word for
word; nothing is summarised. Every message of yours, every error and the most recent spans
always stay. The stored chat is never changed. `/focus` shows what was left out, `/focus off`
sends everything again. From "Training-Free Decision-Preserving Context Compression"
(arXiv:2609.37590).

## What's missing

- A diff view, a terminal and renaming chats.
- Replies update by asking the agent about twice a second, not by streaming.
- FOCUS uses only its offline scoring, not the paper's model-backed one.
- Linux only so far.

## Development

```sh
cd packages/anoncode
cargo test --release --no-default-features    # the vault, the file tree, FOCUS
cargo build --release                         # the app
```

`--features selftest` builds an app that can press its own buttons from a script
(`ANONCODE_SELFTEST`, described in `src/gui.rs`).

## License

MIT, as is opencode. See [LICENSE](LICENSE).
