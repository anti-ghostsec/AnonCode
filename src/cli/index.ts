import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ROOT, DATA_DIR, VAULT_FILE, RUN_DIR } from "../config/paths.ts";
import { Vault, WrongPassphraseError, type VaultHeader } from "../crypto/vault.ts";
import { EncryptedStore, newId } from "../store/store.ts";
import { promptHidden, promptLine } from "./prompt.ts";
import {
  loadConfig,
  setProvider,
  resolveProvider,
  type ProviderKind,
} from "../config/config.ts";
import { SessionStore } from "../session/store.ts";
import { createProvider } from "../providers/index.ts";
import { AgentLoopError } from "../agent/loopguard.ts";
import { toProviderMessages } from "../agent/conversation.ts";
import { compressHistory, HeuristicDraftModel } from "../context/index.ts";
import { runAgent } from "../agent/agentloop.ts";
import { stripToolBlock } from "../agent/toolcall.ts";
import type { ContentPart } from "../session/types.ts";
import { buildAgentPrompt } from "../agent/prompt.ts";
import { defaultTools } from "../tools/registry.ts";
import { CommandDiagnostics, NoDiagnostics, type DiagnosticsProvider } from "../tools/diagnostics.ts";
import { LspDiagnostics } from "../lsp/diagnostics.ts";
import type { ToolContext } from "../tools/types.ts";
import { EncryptedFS } from "../vfs/efs.ts";
import { Runspace, exportProject, importProject } from "../vfs/runspace.ts";
import { TuiApp } from "../tui/app.ts";
import { GuiServer } from "../server/server.ts";

const firstLine = (s: string) => (s.split("\n")[0] ?? "").slice(0, 120);

const USAGE = `anoncode — private, encryption-first AI coding agent

Usage:
  anoncode init          Create the encrypted vault (sets your passphrase)
  anoncode unlock        Verify your passphrase can open the vault
  anoncode status        Show vault + storage status
  anoncode selftest      Round-trip an encrypted record to prove the store works
  anoncode config        Set up an AI provider (API key sealed in the vault)
  anoncode gui           Start the local web GUI (sleek browser UI)
  anoncode tui           Start the full-screen encrypted chat UI
  anoncode chat          Start an encrypted chat session (plain line mode)
  anoncode import <dir>  Encrypt an existing folder into the project vault
  anoncode export <dir>  Decrypt the project to a folder (plaintext; for build/push)
  anoncode help          Show this help

All data lives under ${DATA_DIR} and is encrypted at rest.
`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "help";
  switch (cmd) {
    case "init":
      return cmdInit();
    case "unlock":
      return cmdUnlock();
    case "status":
      return cmdStatus();
    case "selftest":
      return cmdSelftest();
    case "config":
      return cmdConfig();
    case "chat":
      return cmdChat();
    case "tui":
      return cmdTui();
    case "gui":
      return cmdGui(argv);
    case "export":
      return cmdExport(argv[1]);
    case "import":
      return cmdImport(argv[1]);
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

function loadHeader(): VaultHeader {
  return JSON.parse(readFileSync(VAULT_FILE, "utf8")) as VaultHeader;
}

async function cmdInit(): Promise<number> {
  if (existsSync(VAULT_FILE)) {
    process.stderr.write(`vault already exists at ${VAULT_FILE}\n`);
    return 1;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const pass = await promptHidden("Choose a passphrase: ");
  if (pass.length < 8) {
    process.stderr.write("passphrase must be at least 8 characters\n");
    return 1;
  }
  const confirm = await promptHidden("Confirm passphrase: ");
  if (pass !== confirm) {
    process.stderr.write("passphrases do not match\n");
    return 1;
  }
  process.stdout.write("Deriving key (memory-hard KDF)...\n");
  const vault = Vault.create(pass);
  writeFileSync(VAULT_FILE, JSON.stringify(vault.header, null, 2), { mode: 0o600 });
  vault.destroy();
  process.stdout.write(
    `Vault created at ${VAULT_FILE}\n` +
      "Keep your passphrase safe — it cannot be recovered and there is no backdoor.\n",
  );
  return 0;
}

async function withVault<T>(fn: (vault: Vault) => T | Promise<T>): Promise<T> {
  if (!existsSync(VAULT_FILE)) {
    throw new Error(`no vault found — run 'anoncode init' first`);
  }
  const header = loadHeader();
  const pass = await promptHidden("Passphrase: ");
  const vault = Vault.unlock(pass, header); // throws WrongPassphraseError
  try {
    return await fn(vault);
  } finally {
    vault.destroy();
  }
}

async function cmdUnlock(): Promise<number> {
  try {
    await withVault(() => {});
    process.stdout.write("Vault unlocked. Passphrase is correct.\n");
    return 0;
  } catch (err) {
    return reportUnlockError(err);
  }
}

async function cmdStatus(): Promise<number> {
  const hasVault = existsSync(VAULT_FILE);
  process.stdout.write(`Data dir:  ${DATA_DIR}\n`);
  process.stdout.write(`Vault:     ${hasVault ? VAULT_FILE : "(not initialized — run 'anoncode init')"}\n`);
  if (hasVault) {
    const h = loadHeader();
    process.stdout.write(`KDF:       ${h.kdf.algo} (N=${h.kdf.N}, r=${h.kdf.r}, p=${h.kdf.p})\n`);
    process.stdout.write(`Version:   ${h.version}\n`);
  }
  return 0;
}

async function cmdSelftest(): Promise<number> {
  try {
    return await withVault((vault) => {
      const store = new EncryptedStore(vault);
      const id = newId("selftest");
      const payload = { ok: true, at: new Date().toISOString(), nonce: Math.random() };
      store.putJSON("_selftest", id, payload);
      const back = store.getJSON<typeof payload>("_selftest", id);
      store.remove("_selftest", id);
      const matches = JSON.stringify(back) === JSON.stringify(payload);
      process.stdout.write(
        matches
          ? "Self-test passed: wrote, sealed, read back, and verified an encrypted record.\n"
          : "Self-test FAILED: round-trip mismatch.\n",
      );
      return matches ? 0 : 1;
    });
  } catch (err) {
    return reportUnlockError(err);
  }
}

async function cmdConfig(): Promise<number> {
  try {
    return await withVault(async (vault) => {
      const store = new EncryptedStore(vault);
      const kindRaw = (await promptLine("Provider kind [anthropic/openai]: ")).trim().toLowerCase();
      if (kindRaw !== "anthropic" && kindRaw !== "openai") {
        process.stderr.write("provider kind must be 'anthropic' or 'openai'\n");
        return 1;
      }
      const kind = kindRaw as ProviderKind;
      const model = (await promptLine("Model id: ")).trim();
      if (!model) {
        process.stderr.write("model id is required\n");
        return 1;
      }
      const baseUrl = (await promptLine("Base URL (blank for default): ")).trim();
      const apiKey = await promptHidden("API key (hidden, blank for local/keyless): ");
      setProvider(store, kind, {
        kind,
        model,
        apiKey: apiKey || undefined,
        baseUrl: baseUrl || undefined,
      });
      process.stdout.write(`Saved provider '${kind}' (sealed in the vault) and set it as default.\n`);
      return 0;
    });
  } catch (err) {
    return reportUnlockError(err);
  }
}

async function cmdChat(): Promise<number> {
  try {
    return await withVault(async (vault) => {
      const store = new EncryptedStore(vault);
      const config = loadConfig(store);
      const resolved = resolveProvider(config);
      if (!resolved) {
        process.stderr.write("no provider configured — run 'anoncode config' first\n");
        return 1;
      }
      const provider = createProvider(resolved.provider);
      const draft = new HeuristicDraftModel();
      const mode = config.agentMode ?? "build";
      const registry = defaultTools(mode);
      const diagnostics: DiagnosticsProvider = config.lsp?.enabled
        ? new LspDiagnostics(config.lsp.servers)
        : config.diagnosticsCommand
          ? new CommandDiagnostics(config.diagnosticsCommand)
          : new NoDiagnostics();
      const fs = new EncryptedFS(store);
      const runspace = Runspace.materialize(fs, RUN_DIR);
      const ctx: ToolContext = {
        fs,
        readFiles: new Set<string>(),
        runspace,
        allow: async (action, detail) => {
          const ans = (await promptLine(`  allow ${action} (${detail})? [y/N] `)).trim().toLowerCase();
          return ans === "y" || ans === "yes";
        },
      };
      const system = buildAgentPrompt({ fs, registry, mode });
      const sessions = new SessionStore(store);
      const session = sessions.createSession({
        provider: resolved.name,
        model: resolved.provider.model,
        title: `chat ${new Date().toISOString()}`,
      });
      process.stdout.write(
        `AnonCode chat — provider '${resolved.name}', model '${resolved.provider.model}'.\n` +
          `Session ${session.id}. Type your message, or '/exit' to quit.\n\n`,
      );

      for (;;) {
        const line = await promptLine("you › ");
        const trimmed = line.trim();
        if (trimmed === "/exit" || trimmed === "/quit") break;
        if (trimmed === "") continue;

        sessions.addMessage(session, "user", [{ type: "text", text: trimmed }]);

        try {
          // FOCUS: compress history to decision-relevant spans before sending.
          const compressed = await compressHistory(
            sessions.messages(session),
            draft,
            trimmed,
            config.focus,
          );
          if (compressed.report.triggered) {
            const r = compressed.report;
            process.stdout.write(
              `  · FOCUS kept ${r.keptCount}/${r.decisions.length} spans ` +
                `(${r.keptTokens}/${r.totalTokens} est. tokens)\n`,
            );
          }
          const result = await runAgent({
            provider,
            model: resolved.provider.model,
            system,
            messages: toProviderMessages(compressed.messages),
            registry,
            ctx,
            diagnostics,
            onEvent: (e) => {
              if (e.type === "tool_call")
                process.stdout.write(`  ⚙ ${e.call.tool} ${JSON.stringify(e.call.args).slice(0, 120)}\n`);
              else if (e.type === "tool_result")
                process.stdout.write(`  ⤷ ${e.ok ? "ok" : "err"}: ${firstLine(e.output)}\n`);
              else if (e.type === "diagnostics")
                process.stdout.write(`  ⚠ diagnostics fed back to model\n`);
            },
          });
          // Persist the full tool-step trace (encrypted) so the model keeps
          // its tool context across turns, not just the final answer.
          for (const entry of result.trace) {
            if (entry.kind === "assistant") {
              const prose = stripToolBlock(entry.text);
              const parts: ContentPart[] = [];
              if (prose) parts.push({ type: "text", text: prose });
              if (entry.call)
                parts.push({ type: "tool_call", id: newId("call"), name: entry.call.tool, args: entry.call.args });
              if (parts.length === 0) parts.push({ type: "text", text: "(working…)" });
              sessions.addMessage(session, "assistant", parts);
            } else {
              const text = entry.diagnostics
                ? `${entry.output}\n[diagnostics]\n${entry.diagnostics}`
                : entry.output;
              sessions.addMessage(session, "tool", [
                { type: "tool_result", id: newId("tr"), result: text, isError: !entry.ok },
              ]);
            }
          }
          process.stdout.write(`ai  › ${result.finalText}\n\n`);
        } catch (err) {
          if (err instanceof AgentLoopError) {
            process.stderr.write(`  ! stopped (${err.reason}): ${err.message}\n\n`);
          } else {
            process.stderr.write(`  ! error: ${(err as Error).message}\n\n`);
          }
        }
      }
      diagnostics.dispose?.(); // kill any language servers
      runspace.wipe(); // remove the plaintext mirror; only ciphertext remains
      process.stdout.write(`Session saved (encrypted): ${session.id}\nRunspace wiped — project is locked up again.\n`);
      return 0;
    });
  } catch (err) {
    return reportUnlockError(err);
  }
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best effort — the URL is printed above */
  }
}

async function cmdGui(argv: string[]): Promise<number> {
  const demo = argv.includes("--demo");
  const portIdx = argv.indexOf("--port");
  const port = portIdx !== -1 ? Number(argv[portIdx + 1]) || 0 : 0;
  const server = new GuiServer({ demo });
  const { url } = server.start(port);
  process.stdout.write(`\nAnonCode GUI running at:\n  ${url}\n\n`);
  process.stdout.write(
    demo
      ? "Demo mode: throwaway vault + mock model.\n"
      : "Unlock with your passphrase in the browser.\n",
  );
  if (!argv.includes("--no-open")) {
    openBrowser(url);
    process.stdout.write("Opening your browser… (if it didn't, paste the URL above)\n");
  }
  process.stdout.write("Bound to 127.0.0.1 only. Keep this running; press Ctrl-C to stop.\n");
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.stop();
      process.stdout.write("\nGUI stopped; runspace wiped.\n");
      resolve();
    });
  });
  return 0;
}

async function cmdTui(): Promise<number> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("tui requires an interactive terminal — use 'anoncode chat' instead\n");
    return 1;
  }
  try {
    return await withVault(async (vault) => {
      const store = new EncryptedStore(vault);
      const config = loadConfig(store);
      const resolved = resolveProvider(config);
      if (!resolved) {
        process.stderr.write("no provider configured — run 'anoncode config' first\n");
        return 1;
      }
      const provider = createProvider(resolved.provider);
      const draft = new HeuristicDraftModel();
      const mode = config.agentMode ?? "build";
      const registry = defaultTools(mode);
      const diagnostics: DiagnosticsProvider = config.lsp?.enabled
        ? new LspDiagnostics(config.lsp.servers)
        : config.diagnosticsCommand
          ? new CommandDiagnostics(config.diagnosticsCommand)
          : new NoDiagnostics();
      const fs = new EncryptedFS(store);
      const runspace = Runspace.materialize(fs, RUN_DIR);
      const ctx: ToolContext = { fs, readFiles: new Set<string>(), runspace, allow: async () => true };
      const system = buildAgentPrompt({ fs, registry, mode });
      const sessions = new SessionStore(store);
      const session = sessions.createSession({
        provider: resolved.name,
        model: resolved.provider.model,
        title: `tui ${new Date().toISOString()}`,
      });

      await new Promise<void>((resolveQuit) => {
        const app = new TuiApp({
          provider,
          providerName: resolved.name,
          model: resolved.provider.model,
          mode,
          system,
          draft,
          sessions,
          session,
          registry,
          ctx,
          diagnostics,
          config,
          onQuit: () => {
            diagnostics.dispose?.();
            runspace.wipe();
            resolveQuit();
          },
        });
        app.run();
      });
      process.stdout.write(`Session saved (encrypted): ${session.id}\n`);
      return 0;
    });
  } catch (err) {
    return reportUnlockError(err);
  }
}

async function cmdExport(target?: string): Promise<number> {
  const dir = target ? (target.startsWith("/") ? target : join(process.cwd(), target)) : join(ROOT, "export");
  try {
    return await withVault(async (vault) => {
      const store = new EncryptedStore(vault);
      const fs = new EncryptedFS(store);
      const files = fs.paths().length;
      if (files === 0) {
        process.stdout.write("project is empty — nothing to export\n");
        return 0;
      }
      process.stdout.write(`This will DECRYPT ${files} file(s) to ${dir} as plaintext.\n`);
      const ok = (await promptLine("Proceed? [y/N] ")).trim().toLowerCase();
      if (ok !== "y" && ok !== "yes") {
        process.stdout.write("aborted\n");
        return 1;
      }
      const n = exportProject(fs, dir);
      process.stdout.write(`Exported ${n} file(s) to ${dir} (plaintext).\n`);
      return 0;
    });
  } catch (err) {
    return reportUnlockError(err);
  }
}

async function cmdImport(source?: string): Promise<number> {
  if (!source) {
    process.stderr.write("usage: anoncode import <dir>\n");
    return 1;
  }
  const dir = source.startsWith("/") ? source : join(process.cwd(), source);
  try {
    return await withVault(async (vault) => {
      const store = new EncryptedStore(vault);
      const fs = new EncryptedFS(store);
      const n = importProject(fs, dir);
      process.stdout.write(`Imported and encrypted ${n} file(s) from ${dir} into the project.\n`);
      return 0;
    });
  } catch (err) {
    return reportUnlockError(err);
  }
}

function reportUnlockError(err: unknown): number {
  if (err instanceof WrongPassphraseError) {
    process.stderr.write("Wrong passphrase.\n");
    return 2;
  }
  process.stderr.write(`${(err as Error).message}\n`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
