import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listProjects,
  getProject,
  createProject,
  renameProject,
  deleteProject,
  projectPaths,
  type ProjectMeta,
} from "../config/projects.ts";
import { Vault, WrongPassphraseError, type VaultHeader } from "../crypto/vault.ts";
import { EncryptedStore, newId } from "../store/store.ts";
import { loadConfig, saveConfig, resolveProvider, setProvider } from "../config/config.ts";
import { createProvider, probeProvider, friendlyProviderError, listModels } from "../providers/index.ts";
import type { ProviderConfig } from "../config/config.ts";
import { PROVIDER_PRESETS } from "../providers/catalog.ts";
import { exportProject } from "../vfs/runspace.ts";
import { ProviderError } from "../providers/types.ts";
import { MockProvider } from "../providers/mock.ts";
import { SessionStore } from "../session/store.ts";
import type { Session, ContentPart } from "../session/types.ts";
import { EncryptedFS } from "../vfs/efs.ts";
import { Runspace } from "../vfs/runspace.ts";
import { defaultTools, type ToolRegistry } from "../tools/registry.ts";
import type { ToolContext } from "../tools/types.ts";
import { NoDiagnostics, CommandDiagnostics, type DiagnosticsProvider } from "../tools/diagnostics.ts";
import { LspDiagnostics } from "../lsp/diagnostics.ts";
import { HeuristicDraftModel } from "../context/draft.ts";
import { compressHistory } from "../context/index.ts";
import { toProviderMessages } from "../agent/conversation.ts";
import { buildAgentPrompt } from "../agent/prompt.ts";
import { runAgent } from "../agent/agentloop.ts";
import { runReview, summarizeTrace, type Verdict } from "../agent/reviewer.ts";
import { stripToolBlock } from "../agent/toolcall.ts";
import { AgentLoopError } from "../agent/loopguard.ts";
import type { Provider } from "../providers/types.ts";

const HTML = join(import.meta.dir, "public", "index.html");

type Unlocked = {
  id: string;
  name: string;
  store: EncryptedStore;
  fs: EncryptedFS;
  runspace: Runspace;
  provider: Provider;
  providerName: string;
  model: string;
  mode: "build" | "plan";
  registry: ToolRegistry;
  ctx: ToolContext;
  diagnostics: DiagnosticsProvider;
  draft: HeuristicDraftModel;
  sessions: SessionStore;
  session: Session;
  config: ReturnType<typeof loadConfig>;
};

/**
 * Local GUI server. Wraps the encrypted engine behind a tiny HTTP + SSE API,
 * bound to 127.0.0.1 and gated by a per-process secret token so only a page
 * that knows the token (the one we print the URL for) can reach it. The vault
 * is unlocked in-process; the browser only ever posts the passphrase to
 * localhost, never to anywhere else.
 */
export class GuiServer {
  readonly token = randomBytes(24).toString("base64url");
  private server: ReturnType<typeof Bun.serve> | null = null;
  /** Unlocked engines by project id (a project stays unlocked once opened). */
  private projects = new Map<string, Unlocked>();
  private activeId: string | null = null;
  private sse: ReadableStreamDefaultController<Uint8Array> | null = null;
  private pending = new Map<string, (ok: boolean) => void>();
  private encoder = new TextEncoder();

  constructor(private readonly opts: { demo?: boolean } = {}) {}

  start(port = 0): { url: string; port: number } {
    this.server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
    if (this.opts.demo) {
      const demo = this.buildDemo();
      this.projects.set(demo.id, demo);
      this.activeId = demo.id;
    } else {
      this.activeId = listProjects()[0]!.id;
    }
    const realPort = this.server.port ?? port;
    return { url: `http://127.0.0.1:${realPort}/?t=${this.token}`, port: realPort };
  }

  stop(): void {
    for (const u of this.projects.values()) {
      u.diagnostics.dispose?.();
      u.runspace.wipe();
    }
    this.server?.stop(true);
  }

  /** The project metas to show as tabs (demo is a single synthetic project). */
  private projectList(): ProjectMeta[] {
    return this.opts.demo ? [{ id: "demo", name: "Demo", createdAt: new Date().toISOString() }] : listProjects();
  }

  private activeMeta(): ProjectMeta | null {
    if (!this.activeId) return null;
    return this.projectList().find((p) => p.id === this.activeId) ?? null;
  }

  /** The unlocked engine for the active project, or null if locked/none. */
  private active(): Unlocked | null {
    return this.activeId ? this.projects.get(this.activeId) ?? null : null;
  }

  // ---- routing --------------------------------------------------------------

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      return new Response(readFileSync(HTML, "utf8"), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (!path.startsWith("/api/")) return new Response("not found", { status: 404 });

    // Token gate for all API routes.
    const tok = req.headers.get("x-anoncode-token") ?? url.searchParams.get("t");
    if (tok !== this.token) return json({ error: "forbidden" }, 403);

    try {
      if (path === "/api/state") return this.state();
      if (path === "/api/catalog") return json({ presets: PROVIDER_PRESETS });
      if (path === "/api/project/create" && req.method === "POST") return await this.createProjectRoute(req);
      if (path === "/api/project/select" && req.method === "POST") return await this.selectProject(req);
      if (path === "/api/project/rename" && req.method === "POST") return await this.renameProjectRoute(req);
      if (path === "/api/project/delete" && req.method === "POST") return await this.deleteProjectRoute(req);
      if (path === "/api/init" && req.method === "POST") return await this.initVault(req);
      if (path === "/api/unlock" && req.method === "POST") return await this.unlock(req);
      if (path === "/api/provider" && req.method === "POST") return await this.setProviderCfg(req);
      if (path === "/api/models" && req.method === "POST") return await this.listModelsRoute(req);
      if (path === "/api/model" && req.method === "POST") return await this.setModel(req);
      if (path === "/api/config" && req.method === "POST") return await this.setAppConfig(req);
      if (path === "/api/reviewer" && req.method === "POST") return await this.setReviewer(req);
      if (path === "/api/lock" && req.method === "POST") return this.lock();
      if (path === "/api/export" && req.method === "POST") return await this.exportProject(req);
      if (path === "/api/stream" && req.method === "GET") return this.stream();
      if (path === "/api/message" && req.method === "POST") return await this.message(req);
      if (path === "/api/permission" && req.method === "POST") return await this.permission(req);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
    return new Response("not found", { status: 404 });
  }

  private state(): Response {
    const u = this.active();
    const meta = this.activeMeta();
    const hasProvider = Boolean(u && u.providerName !== "none");
    const current = u ? resolveProvider(u.config) : null;
    const demo = Boolean(this.opts.demo);
    const hasVault = demo ? true : meta ? existsSync(projectPaths(meta).vaultFile) : false;
    return json({
      unlocked: Boolean(u),
      demo,
      hasVault,
      hasProvider,
      provider: hasProvider ? u!.providerName : null,
      model: hasProvider ? u!.model : null,
      // Non-secret details so the settings panel can pre-fill (never the key).
      kind: current?.provider.kind ?? null,
      baseUrl: current?.provider.baseUrl ?? null,
      mode: u?.mode ?? "build",
      permissionMode: u?.config.permissionMode ?? "ask",
      reviewer: {
        enabled: Boolean(u?.config.reviewer?.enabled),
        prompt: u?.config.reviewer?.prompt ?? "",
        mission: u?.config.reviewer?.mission ?? "",
        model: u?.config.reviewer?.model ?? "",
        maxRounds: u?.config.reviewer?.maxRounds ?? 4,
      },
      fileCount: u ? u.fs.paths().length : 0,
      // Project tabs: the list, which is active, and which are unlocked.
      activeProject: this.activeId,
      projects: this.projectList().map((p) => ({
        id: p.id,
        name: p.name,
        legacy: Boolean(p.legacy),
        unlocked: demo || this.projects.has(p.id),
      })),
    });
  }

  // ---- project tabs ---------------------------------------------------------

  private async createProjectRoute(req: Request): Promise<Response> {
    if (this.opts.demo) return json({ error: "projects are disabled in demo mode" }, 400);
    const { name } = (await req.json().catch(() => ({}))) as { name?: string };
    const meta = createProject(name || "New project");
    this.activeId = meta.id; // new project has no vault yet → UI shows create
    return this.state();
  }

  private async selectProject(req: Request): Promise<Response> {
    if (this.opts.demo) return this.state();
    const { id } = (await req.json().catch(() => ({}))) as { id?: string };
    if (!id || !getProject(id)) return json({ error: "no such project" }, 404);
    this.activeId = id;
    return this.state();
  }

  private async renameProjectRoute(req: Request): Promise<Response> {
    if (this.opts.demo) return this.state();
    const { id, name } = (await req.json().catch(() => ({}))) as { id?: string; name?: string };
    if (!id || !getProject(id)) return json({ error: "no such project" }, 404);
    const meta = renameProject(id, name || "");
    const u = this.projects.get(id);
    if (u && meta) u.name = meta.name;
    return this.state();
  }

  private async deleteProjectRoute(req: Request): Promise<Response> {
    if (this.opts.demo) return this.state();
    const { id } = (await req.json().catch(() => ({}))) as { id?: string };
    if (!id || !getProject(id)) return json({ error: "no such project" }, 404);
    const meta = getProject(id)!;
    if (meta.legacy) return json({ error: "the default project can't be deleted" }, 400);
    // Drop the in-memory engine (wipe its runspace) before removing on disk.
    const u = this.projects.get(id);
    if (u) { u.diagnostics.dispose?.(); u.runspace.wipe(); this.projects.delete(id); }
    deleteProject(id);
    if (this.activeId === id) this.activeId = this.projectList()[0]?.id ?? null;
    return this.state();
  }

  private async initVault(req: Request): Promise<Response> {
    if (this.opts.demo || this.active()) return this.state();
    const meta = this.activeMeta();
    if (!meta) return json({ error: "no active project" }, 400);
    const paths = projectPaths(meta);
    if (existsSync(paths.vaultFile)) return json({ error: "a vault already exists — unlock instead" }, 400);
    const { passphrase } = (await req.json().catch(() => ({}))) as { passphrase?: string };
    if (!passphrase || passphrase.length < 8) return json({ error: "passphrase must be at least 8 characters" }, 400);
    mkdirSync(paths.dir, { recursive: true });
    const vault = Vault.create(passphrase);
    writeFileSync(paths.vaultFile, JSON.stringify(vault.header, null, 2), { mode: 0o600 });
    this.projects.set(meta.id, this.buildUnlocked(vault, meta));
    return this.state();
  }

  private async setProviderCfg(req: Request): Promise<Response> {
    const u = this.active();
    if (!u) return json({ error: "locked" }, 401);
    if (this.opts.demo) return this.state();
    const { kind, model, apiKey, baseUrl, test } = (await req.json().catch(() => ({}))) as {
      kind?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      test?: boolean;
    };
    if (kind !== "anthropic" && kind !== "openai") return json({ error: "provider must be anthropic or openai" }, 400);
    if (!model || !model.trim()) return json({ error: "model is required" }, 400);
    const cfg = { kind, model: model.trim(), apiKey: apiKey || undefined, baseUrl: baseUrl || undefined } as const;

    // Validate the key/model against the provider before saving, so a bad key
    // is caught here with a clear message instead of failing on the first chat.
    if (test !== false) {
      const probe = await probeProvider(cfg);
      if (!probe.ok) return json({ error: probe.message ?? "provider test failed", testFailed: true }, 400);
    }

    setProvider(u.store, kind, cfg);
    const config = loadConfig(u.store);
    const resolved = resolveProvider(config)!;
    u.config = config;
    u.providerName = resolved.name;
    u.model = resolved.provider.model;
    u.provider = createProvider(resolved.provider);
    return this.state();
  }

  /** Live model list for a provider. Body may fully specify kind/baseUrl/apiKey
   * (used by the connect form), or be empty to use the saved provider's key
   * (used by the header switcher without re-entering the key). */
  private async listModelsRoute(req: Request): Promise<Response> {
    const u = this.active();
    if (!u) return json({ error: "locked", models: [] }, 401);
    const body = (await req.json().catch(() => ({}))) as { kind?: string; baseUrl?: string; apiKey?: string };
    let cfg: ProviderConfig;
    if (body.kind === "anthropic" || body.kind === "openai") {
      cfg = { kind: body.kind, model: "", apiKey: body.apiKey || undefined, baseUrl: body.baseUrl || undefined };
      // If the key is blank but matches the saved provider, reuse the saved key.
      if (!cfg.apiKey) {
        const cur = resolveProvider(u.config);
        if (cur && cur.provider.kind === cfg.kind && (cur.provider.baseUrl || "") === (cfg.baseUrl || ""))
          cfg.apiKey = cur.provider.apiKey;
      }
    } else {
      const cur = resolveProvider(u.config);
      if (!cur) return json({ error: "no provider configured", models: [] }, 400);
      cfg = cur.provider;
    }
    try {
      const models = await listModels(cfg);
      return json({ models });
    } catch (e) {
      // Not fatal — the form still works with typed/suggested models.
      return json({ models: [], error: friendlyProviderError(e, cfg) });
    }
  }

  /** Quick model switch for the current provider (keeps key + base URL). */
  private async setModel(req: Request): Promise<Response> {
    const u = this.active();
    if (!u) return json({ error: "locked" }, 401);
    if (this.opts.demo) return this.state();
    const { model } = (await req.json().catch(() => ({}))) as { model?: string };
    if (!model || !model.trim()) return json({ error: "model is required" }, 400);
    const cur = resolveProvider(u.config);
    if (!cur) return json({ error: "no provider configured" }, 400);
    setProvider(u.store, cur.name, { ...cur.provider, model: model.trim() });
    u.config = loadConfig(u.store);
    const r = resolveProvider(u.config)!;
    u.providerName = r.name;
    u.model = r.provider.model;
    u.provider = createProvider(r.provider);
    return this.state();
  }

  private async setAppConfig(req: Request): Promise<Response> {
    const u = this.active();
    if (!u) return json({ error: "locked" }, 401);
    if (this.opts.demo) return this.state();
    const { mode, permissionMode } = (await req.json().catch(() => ({}))) as { mode?: string; permissionMode?: string };
    if (mode !== undefined) {
      if (mode !== "build" && mode !== "plan") return json({ error: "mode must be build or plan" }, 400);
      u.config.agentMode = mode;
      u.mode = mode;
      u.registry = defaultTools(mode);
    }
    if (permissionMode !== undefined) {
      if (permissionMode !== "ask" && permissionMode !== "auto") return json({ error: "permissionMode must be ask or auto" }, 400);
      u.config.permissionMode = permissionMode;
    }
    saveConfig(u.store, u.config);
    return this.state();
  }

  private async setReviewer(req: Request): Promise<Response> {
    const u = this.active();
    if (!u) return json({ error: "locked" }, 401);
    if (this.opts.demo) return this.state();
    const body = (await req.json().catch(() => ({}))) as {
      enabled?: boolean; prompt?: string; mission?: string; model?: string; maxRounds?: number;
    };
    const prompt = (body.prompt ?? "").trim();
    if (body.enabled && !prompt) return json({ error: "a reviewer instruction is required to arm the loop" }, 400);
    u.config.reviewer = {
      enabled: Boolean(body.enabled),
      prompt: prompt || undefined,
      mission: (body.mission ?? "").trim() || undefined,
      model: (body.model ?? "").trim() || undefined,
      maxRounds: body.maxRounds ? Math.min(Math.max(Math.round(body.maxRounds), 1), 50) : undefined,
    };
    saveConfig(u.store, u.config);
    return this.state();
  }

  private lock(): Response {
    if (this.opts.demo) return this.state();
    const u = this.active();
    if (u) {
      u.diagnostics.dispose?.();
      u.runspace.wipe();
      this.projects.delete(u.id);
    }
    return this.state();
  }

  private async exportProject(req: Request): Promise<Response> {
    const u = this.active();
    if (!u) return json({ error: "locked" }, 401);
    if (this.opts.demo) return json({ error: "export is disabled in demo mode" }, 400);
    const { dir } = (await req.json().catch(() => ({}))) as { dir?: string };
    if (!dir || !dir.trim()) return json({ error: "a destination folder is required" }, 400);
    const target = dir.trim().startsWith("/") ? dir.trim() : join(process.cwd(), dir.trim());
    const files = u.fs.paths().length;
    if (files === 0) return json({ error: "the project is empty — nothing to export yet" }, 400);
    try {
      const n = exportProject(u.fs, target);
      return json({ ok: true, count: n, dir: target });
    } catch (e) {
      return json({ error: `export failed: ${(e as Error).message}` }, 500);
    }
  }

  private async unlock(req: Request): Promise<Response> {
    if (this.active()) return this.state();
    const meta = this.activeMeta();
    if (!meta) return json({ error: "no active project" }, 400);
    const paths = projectPaths(meta);
    const { passphrase } = (await req.json().catch(() => ({}))) as { passphrase?: string };
    if (!existsSync(paths.vaultFile)) return json({ error: "no vault for this project yet — create one" }, 400);
    const header = JSON.parse(readFileSync(paths.vaultFile, "utf8")) as VaultHeader;
    let vault: Vault;
    try {
      vault = Vault.unlock(passphrase ?? "", header);
    } catch (e) {
      if (e instanceof WrongPassphraseError) return json({ error: "wrong passphrase" }, 401);
      throw e;
    }
    this.projects.set(meta.id, this.buildUnlocked(vault, meta));
    return this.state();
  }

  private stream(): Response {
    const self = this;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        self.sse = controller;
        controller.enqueue(self.encoder.encode(`data: ${JSON.stringify({ type: "ready" })}\n\n`));
      },
      cancel() {
        self.sse = null;
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  private push(ev: unknown): void {
    this.sse?.enqueue(this.encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
  }

  private async message(req: Request): Promise<Response> {
    const u = this.active();
    if (!u) return json({ error: "locked" }, 401);
    const { text } = (await req.json().catch(() => ({}))) as { text?: string };
    if (!text || !text.trim()) return json({ error: "empty" }, 400);
    // Run the turn in the background; results arrive over SSE.
    void this.runTurn(u, text.trim());
    return json({ ok: true }, 202);
  }

  private async permission(req: Request): Promise<Response> {
    const { id, allow } = (await req.json().catch(() => ({}))) as { id?: string; allow?: boolean };
    const resolve = id ? this.pending.get(id) : undefined;
    if (resolve) {
      this.pending.delete(id!);
      resolve(Boolean(allow));
    }
    return json({ ok: true });
  }

  // ---- the turn -------------------------------------------------------------

  private async runTurn(u: Unlocked, text: string): Promise<void> {
    try {
      const rev = u.config.reviewer;
      const loopOn = Boolean(rev?.enabled && rev?.prompt && rev.prompt.trim());
      const maxRounds = loopOn ? Math.min(Math.max(rev!.maxRounds ?? 4, 1), 50) : 1;
      const mission = (rev?.mission && rev.mission.trim()) || text;
      let userText = text;
      let lastReason = "";

      for (let round = 1; round <= maxRounds; round++) {
        const result = await this.runWorkerTurn(u, userText);
        this.pushFinal(result);
        if (!loopOn) break;

        if (round >= maxRounds) {
          this.push({ type: "note", text: `Loop: reached the ${maxRounds}-round limit — stopping.` });
          break;
        }
        this.push({ type: "note", text: `Reviewer is checking the work (round ${round})…` });
        const evidence = summarizeTrace(result.trace);
        const endMessage = result.finalText.trim() || result.finalReasoning?.trim() || "(the worker produced no answer)";
        const reviewerModel = (rev!.model && rev!.model.trim()) || u.model;
        let review: { verdict?: Verdict; raw: string };
        try {
          review = await runReview(u.provider, reviewerModel, { review: rev!.prompt!, mission, endMessage, evidence, round, maxRounds });
        } catch (e) {
          this.push({ type: "note", text: `Reviewer error: ${(e as Error).message} — stopping the loop.` });
          break;
        }
        const v = review.verdict;
        this.push({ type: "reviewer", verdict: v?.verdict ?? "unclear", reason: v?.reason ?? review.raw.slice(0, 500), instruction: v && v.verdict === "continue" ? v.instruction : undefined });
        if (!v) { this.push({ type: "note", text: "Reviewer gave no usable verdict — stopping the loop." }); break; }
        if (v.verdict === "done") { this.push({ type: "note", text: `Reviewer approved the work — loop complete.` }); break; }
        if (v.verdict === "blocked") { this.push({ type: "note", text: `Reviewer paused the loop (needs you): ${v.reason}` }); break; }
        // continue — guard against spinning on the same unresolved reason.
        if (v.reason && v.reason === lastReason) { this.push({ type: "note", text: "No progress since the last round — stopping the loop." }); break; }
        lastReason = v.reason;
        userText = v.instruction;
      }
    } catch (err) {
      if (err instanceof AgentLoopError) this.push({ type: "error", text: `stopped (${err.reason}): ${err.message}` });
      else if (err instanceof ProviderError) {
        const r = resolveProvider(u.config);
        this.push({ type: "error", text: r ? friendlyProviderError(err, r.provider) : (err as Error).message });
      } else this.push({ type: "error", text: (err as Error).message });
    } finally {
      this.push({ type: "turn_done" });
    }
  }

  /** One worker turn: add the user message, compress, run the agent, persist. */
  private async runWorkerTurn(u: Unlocked, text: string): Promise<Awaited<ReturnType<typeof runAgent>>> {
    u.sessions.addMessage(u.session, "user", [{ type: "text", text }]);
    const compressed = await compressHistory(u.sessions.messages(u.session), u.draft, text, u.config.focus);
    if (compressed.report.triggered) {
      const r = compressed.report;
      this.push({ type: "note", text: `FOCUS kept ${r.keptCount}/${r.decisions.length} spans (${r.keptTokens}/${r.totalTokens} tok)` });
    }
    const result = await runAgent({
      provider: u.provider,
      model: u.model,
      system: buildAgentPrompt({ fs: u.fs, registry: u.registry, mode: u.mode }),
      messages: toProviderMessages(compressed.messages),
      registry: u.registry,
      ctx: u.ctx,
      diagnostics: u.diagnostics,
      onEvent: (e) => {
        if (e.type === "reasoning") this.push({ type: "reasoning", text: e.text });
        else if (e.type === "assistant_delta") this.push({ type: "assistant_delta", text: e.text });
        else if (e.type === "tool_call") this.push({ type: "tool_call", tool: e.call.tool, args: e.call.args });
        else if (e.type === "tool_result") this.push({ type: "tool_result", ok: e.ok, output: e.output });
        else if (e.type === "diagnostics") this.push({ type: "diagnostics", text: e.text });
      },
    });
    for (const entry of result.trace) {
      if (entry.kind === "assistant") {
        const prose = stripToolBlock(entry.text);
        const parts: ContentPart[] = [];
        if (prose) parts.push({ type: "text", text: prose });
        if (entry.call) parts.push({ type: "tool_call", id: newId("call"), name: entry.call.tool, args: entry.call.args });
        if (parts.length === 0) parts.push({ type: "text", text: "(working…)" });
        u.sessions.addMessage(u.session, "assistant", parts);
      } else {
        const t = entry.diagnostics ? `${entry.output}\n[diagnostics]\n${entry.diagnostics}` : entry.output;
        u.sessions.addMessage(u.session, "tool", [{ type: "tool_result", id: newId("tr"), result: t, isError: !entry.ok }]);
      }
    }
    return result;
  }

  /** Render the worker's final answer (or the reasoning-only / empty cases). */
  private pushFinal(result: Awaited<ReturnType<typeof runAgent>>): void {
    const finalText = result.finalText.trim();
    if (finalText) this.push({ type: "assistant_final", text: finalText });
    else if (result.finalReasoning && result.finalReasoning.trim())
      this.push({ type: "assistant_final", text: "", reasoningOnly: true });
    else this.push({ type: "assistant_final", text: "(no response — the model returned nothing; try again or switch models)", note: true });
  }

  private requestPermission(action: string, detail: string): Promise<boolean> {
    // Auto mode (opencode-style): approve without prompting, but still surface
    // what was allowed so nothing happens invisibly.
    if (this.active()?.config.permissionMode === "auto") {
      this.push({ type: "note", text: `auto-allowed ${action}: ${detail}` });
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const id = newId("perm");
      this.pending.set(id, resolve);
      this.push({ type: "permission", id, action, detail });
    });
  }

  // ---- building the unlocked engine ----------------------------------------

  private buildUnlocked(vault: Vault, meta: ProjectMeta): Unlocked {
    const paths = projectPaths(meta);
    const store = new EncryptedStore(vault, paths.dir);
    const config = loadConfig(store);
    const resolved = resolveProvider(config);
    const providerName = resolved?.name ?? "none";
    const model = resolved?.provider.model ?? "none";
    const mode = config.agentMode ?? "build";
    const provider = resolved ? createProvider(resolved.provider) : new MockProvider();
    const diagnostics: DiagnosticsProvider = config.lsp?.enabled
      ? new LspDiagnostics(config.lsp.servers)
      : config.diagnosticsCommand
        ? new CommandDiagnostics(config.diagnosticsCommand)
        : new NoDiagnostics();
    return this.assemble(meta.id, meta.name, store, config, provider, providerName, model, mode, diagnostics, paths.runDir);
  }

  private buildDemo(): Unlocked {
    const dir = mkdtempSync(join(tmpdir(), "anoncode-demo-"));
    const vault = Vault.create("demo", { algo: "scrypt", N: 1 << 12, r: 8, p: 1, keyLen: 32 });
    const store = new EncryptedStore(vault, dir);
    const config = loadConfig(store);
    const provider = new MockProvider({
      reply: (req) => {
        const last = [...req.messages].reverse().find((m) => m.role === "user");
        const t = last?.content.find((c) => c.type === "text");
        return `This is AnonCode's demo mode (no real model). You said: ${t && t.type === "text" ? t.text : ""}`;
      },
    });
    return this.assemble("demo", "Demo", store, config, provider, "mock", "demo", "build", new NoDiagnostics(), join(dir, "run"));
  }

  private assemble(
    id: string,
    name: string,
    store: EncryptedStore,
    config: ReturnType<typeof loadConfig>,
    provider: Provider,
    providerName: string,
    model: string,
    mode: "build" | "plan",
    diagnostics: DiagnosticsProvider,
    runDir: string,
  ): Unlocked {
    const fs = new EncryptedFS(store);
    const runspace = Runspace.materialize(fs, runDir);
    const registry = defaultTools(mode);
    const ctx: ToolContext = {
      fs,
      readFiles: new Set<string>(),
      runspace,
      allow: (action, detail) => this.requestPermission(action, detail),
    };
    const sessions = new SessionStore(store);
    const session = sessions.createSession({ provider: providerName, model, title: `gui ${new Date().toISOString()}` });
    return { id, name, store, fs, runspace, provider, providerName, model, mode, registry, ctx, diagnostics, draft: new HeuristicDraftModel(), sessions, session, config };
  }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
