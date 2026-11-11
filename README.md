# AnonCode

A private AI coding agent with a native interface. Every project is its own encrypted vault,
and one passphrase opens them all: project files, chats, settings and API keys are sealed and
unreadable without it.

AnonCode is three things put together:

- **The agent** is [opencode](https://github.com/anomalyco/opencode) (v2.2.7, upstream commit
  `d4aeee5`). It does the chat, the tools and the language servers. Its source is unmodified;
  the parts AnonCode doesn't run (the web and desktop apps, the website, cloud infrastructure,
  release tooling) are removed. Its own readme is in [README.opencode.md](README.opencode.md).
- **The app** (`packages/anoncode`, Rust) is the window you use and the vault underneath it.
  It is not a web page and has no browser in it.
- **Plugins** (`packages/anoncode-plugins`) add the reviewer loop and FOCUS context
  compression to the agent, take identifying headers out of model requests (`privacy`), and
  take tool calls a model wrote out as text out of what it is sent back (`tidy`).

> Status: early. It runs and has been used against a real model, but parts of the interface
> have only been exercised by a script. See "What's missing".

## Using it

```sh
./anoncode
```

The first run builds the app and installs the agent's dependencies. You need
[Rust](https://rustup.rs), [Bun](https://bun.sh) 1.4 and bubblewrap (`apt install bubblewrap`).

- **You log in once.** The first run asks you to choose a passphrase; after that it is asked
  for when the app starts, and nothing else is.
- **Projects are tabs** across the top, like a browser. `+` makes a new one; a closed project
  shows a lock. Click a tab to open it, double-click to rename it, right-click to delete it.
  **Lock** closes a project: it is sealed and its agent stops. Closing the window does that
  for all of them.
- **Settings** (top right) is where a model provider's API key goes, once. It is sealed in
  AnonCode's own vault and given to every project. No models are available until you add one:
  opencode's hosted models, web search and sharing are switched off, and the model list is not
  fetched from the network. The model you pick becomes the default for other projects.
- **Settings** also holds what the agent may do, for every project:
  - run in the sandbox (on by default; turn off only if a tool can't work inside it),
  - fetch web pages: off (default), ask each time, or allowed,
  - run commands and change files without asking (default), or ask first,
  - FOCUS on or off, how full a chat gets before it starts, whether the chat's model or a
    quick offline guess decides what to leave out, and how many plans the model drafts,
  - keep build caches (cargo, npm, bun, pip, Go, downloaded tools) between sessions, sealed
    with each project (on by default),
  - lock AnonCode after 5 to 60 idle minutes.

  The agent settings apply when a project is opened; **Reopen them now** restarts the open ones.
- **+** in the message box attaches files with your desktop's own file chooser (zenity, or
  kdialog on KDE); you can also drop files on the window. Import and Export choose folders
  the same way.
- **Copying and pasting** work as elsewhere: drag over chat text and press Ctrl+C or
  right-click, Copy; right-click any part of the chat for "Copy all of this"; Ctrl+A outside
  the message box selects the whole chat. In the message box and every other field,
  Ctrl+X/C/V/A and the right-click menu (Cut, Copy, Paste, Select all) work.
- Replies appear as they are written: the window follows the agent's event stream.
- **Loop…** starts a reviewer that checks each turn against your request and tells the agent
  what to do next. Its messages appear in the chat like any other. "Stop after" limits how
  long it runs (30m, 2h, 1h30m, 5 hours, 1 day…); when the time is up it stops the agent and
  says so in the chat ([more](packages/anoncode-plugins/loop/README.md)).
- **Import** copies a folder into a project. **Export** decrypts a project to a folder.

## What is sealed, and how

| | |
| --- | --- |
| Login | Your passphrase opens AnonCode's own vault, which holds the shared settings (provider keys, default model) and a random secret for each project. Each project's vault is locked to its secret, so projects stay separate vaults but need no passphrase of their own. |
| Key | Argon2id (192 MiB, 3 passes) over the passphrase, and a random salt. A project's vault, locked to a random 256-bit secret, uses the lowest cost, since its secret can't be guessed. The cost stored in a vault is checked against a minimum and a maximum before anything is derived. Vaults from the first AnonCode (scrypt) still open. |
| Encryption | AES-256-GCM, a fresh random nonce per record, tampering detected on open. Each record is bound to its name, so a record copied over another fails to open, and each file is checked against the hash in its project's sealed manifest, so an older copy put back is caught. |
| Key at rest | Never written. Only the cost, the salt and a sealed check value are on disk. The key is wiped from memory on lock. |
| Project files | One sealed record per file, listed by a sealed manifest. Record names are a keyed hash of the path, so a name can't be matched against a guessed path. |
| Chats, keys, settings | The agent's database is sealed with the project. While unlocked it exists only in memory (`$XDG_RUNTIME_DIR`, or `/dev/shm`), never on disk; a memory folder is used only if it is owned by you and closed to everyone else. |
| Build caches | With "keep build caches" on, cargo's registry, the npm, bun, pip and Go caches and downloaded tools are kept per project under `run/cache` while it is unlocked and sealed into its vault when it locks, like the working copy. Off, they live in memory with the agent's data and are thrown away on lock. |
| Project list | Names and creation times are sealed in AnonCode's vault, not kept in a plaintext list. |
| Working copy | Tools need real files, so while a project is unlocked its files are plaintext under `.anoncode/projects/<id>/run/work`. Locking seals what changed and wipes it. |
| After a crash | The leftover working copy is sealed at the next unlock before anything else, but only if a sealed marker says AnonCode wrote it out and its folder is still closed to everyone else. Otherwise it is thrown away. |
| The agent | Runs in a bubblewrap sandbox with an empty environment, so no API key or setting from your shell reaches it. It sees the system folders and a few toolchains read-only (`~/.local/bin`, `~/.cargo/bin`, `~/.rustup`, `~/.bun/bin`, not `~/.cargo` as a whole, which holds registry credentials), the project at `/work`, its own data at `/home/agent`, its build caches at `/cache`, and nothing else of your disk. Its user and machine are called `agent` and `anoncode`. Without bubblewrap AnonCode refuses to start an agent unless the sandbox is turned off in Settings. |
| Network | Nothing goes to opencode's servers: its hosted models, web search, sharing, model-list download and updater are off. The agent may not fetch web pages unless Settings allows it. Requests to a model provider carry a plain user agent and none of the headers naming opencode. |
| Recovery | None. A lost passphrase means everything is gone. |

Everything AnonCode stores is under `.anoncode/` in this folder. Vaults made by the first
AnonCode (same scrypt and AES-256-GCM format) still open, and a project that has its own
passphrase is asked for it once, after which it opens with the others.

**What it does not protect.** How many files and projects there are, roughly how big each is
and when each last changed are visible on disk. While a project is unlocked, anything running as
you can read its working copy. The sandbox keeps the network, because the model provider needs
it, so the agent's shell commands can reach the internet too. Rolling the whole folder back to
an older copy is not detected. A power cut loses chat history since the last lock or "Save to
vault".

## FOCUS

When a chat outgrows 60% of the model's context window (the share is in Settings), whole spans
of it (an assistant message with its tool results) are left out of what the model is sent.
What stays is sent word for word; nothing is summarised. The stored chat is never changed.
From "Training-Free Decision-Preserving Context Compression" (arXiv:2609.37590):

1. The chat's model drafts plans for the next steps (3 by default), each step citing the parts
   of the chat it needs. How often a part is cited is its score; parts cited by at least 30%
   of the plans stay.
2. A defensive pass keeps your messages, errors, the system parts and the most recent spans.
3. The model reviews what is about to be left out and rescues anything whose loss would make
   the agent repeat a mistake or lose state it still needs.
4. If that is still over the budget, spans go until it fits: unscored ones first, then older
   reviewer-loop messages (each restates the mission), then older messages of yours, errors
   and rescues. Your first message, your latest one, the system parts and the recent spans
   always stay.

With "a quick offline guess" in Settings, step 1 scores by word overlap with your request,
recency and errors, and step 3 is skipped: no extra model calls. If a model call fails, the
guess is used for that compression. `/focus` shows what was left out, `/focus off` sends
everything again.

## What's missing

- A diff view, a terminal and renaming chats.
- Linux only so far.

## Development

```sh
cd packages/anoncode
cargo test --release --no-default-features    # the vault, the file tree, FOCUS, tidy
cargo build --release                         # the app
```

`--features selftest` builds an app that can press its own buttons from a script
(`ANONCODE_SELFTEST`, described in `src/gui.rs`). For testing, `ANONCODE_FOCUS_BUDGET` forces a
FOCUS budget in tokens and `ANONCODE_AGENT_STEPS` caps the agent's steps per turn.

## License

MIT, as is opencode. See [LICENSE](LICENSE).
