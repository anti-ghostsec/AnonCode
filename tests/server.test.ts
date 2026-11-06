import { test, expect, beforeAll, afterAll } from "bun:test";
import { GuiServer } from "../src/server/server.ts";

let server: GuiServer;
let base: string;
let token: string;

beforeAll(() => {
  server = new GuiServer({ demo: true });
  const { port } = server.start(0);
  base = `http://127.0.0.1:${port}`;
  token = server.token;
});
afterAll(() => server.stop());

const auth = () => ({ "content-type": "application/json", "x-anoncode-token": token });

test("API routes are gated by the token", async () => {
  expect((await fetch(`${base}/api/state`)).status).toBe(403);
  const ok = await fetch(`${base}/api/state`, { headers: auth() });
  expect(ok.status).toBe(200);
});

test("serves the GUI page", async () => {
  const html = await fetch(`${base}/`).then((r) => r.text());
  expect(html).toContain("<title>AnonCode</title>");
});

test("demo mode reports unlocked with a mock provider", async () => {
  const state = (await fetch(`${base}/api/state`, { headers: auth() }).then((r) => r.json())) as any;
  expect(state.unlocked).toBe(true);
  expect(state.demo).toBe(true);
  expect(state.provider).toBe("mock");
});

test("serves the provider catalog with presets and a known shape", async () => {
  const data = (await fetch(`${base}/api/catalog`, { headers: auth() }).then((r) => r.json())) as any;
  expect(Array.isArray(data.presets)).toBe(true);
  const ids = data.presets.map((p: any) => p.id);
  expect(ids).toContain("anthropic");
  expect(ids).toContain("openrouter");
  expect(ids).toContain("ollama");
  const or = data.presets.find((p: any) => p.id === "openrouter");
  expect(or.kind).toBe("openai");
  expect(or.baseUrl).toContain("openrouter.ai");
  // The catalog must never leak a key field.
  for (const p of data.presets) expect("apiKey" in p).toBe(false);
});

test("the models route always returns a models array (even with no provider)", async () => {
  const r = await fetch(`${base}/api/models`, { method: "POST", headers: auth(), body: "{}" });
  const data = (await r.json()) as any;
  expect(Array.isArray(data.models)).toBe(true);
});

test("the quick model switch route accepts a model", async () => {
  const r = await fetch(`${base}/api/model`, { method: "POST", headers: auth(), body: JSON.stringify({ model: "demo" }) });
  // Demo short-circuits to state(); the point is the route exists and is gated.
  expect(r.status).toBe(200);
  const r2 = await fetch(`${base}/api/model`, { method: "POST" });
  expect(r2.status).toBe(403);
});

test("a message runs the agent and streams the answer back over SSE", async () => {
  const events: any[] = [];
  const res = await fetch(`${base}/api/stream?t=${token}`);
  // Read the SSE stream in the background.
  void (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {
      /* stream closed on server stop — expected during teardown */
    }
  })();

  await waitFor(() => events.some((e) => e.type === "ready"));
  const post = await fetch(`${base}/api/message`, { method: "POST", headers: auth(), body: JSON.stringify({ text: "hello there" }) });
  expect(post.status).toBe(202);

  await waitFor(() => events.some((e) => e.type === "assistant_final"), 4000);
  const final = events.find((e) => e.type === "assistant_final");
  expect(final.text).toContain("demo mode");
  expect(final.text).toContain("hello there");
  expect(events.some((e) => e.type === "turn_done")).toBe(true);
  // Every turn event is tagged with the project it ran on, so the browser can
  // ignore events from a tab the user switched away from.
  expect(final.project).toBe("demo");
  expect(events.find((e) => e.type === "turn_done").project).toBe("demo");

  // The stored conversation is replayable (transcript restore on tab switch).
  const t = (await fetch(`${base}/api/transcript`, { headers: auth() }).then((r) => r.json())) as any;
  expect(Array.isArray(t.items)).toBe(true);
  expect(t.items.some((i: any) => i.kind === "user" && i.text.includes("hello there"))).toBe(true);
  expect(t.items.some((i: any) => i.kind === "ai" && i.text.includes("demo mode"))).toBe(true);
});

test("the files route returns an array (powers the @-file picker)", async () => {
  const r = await fetch(`${base}/api/files`, { headers: auth() });
  expect(r.status).toBe(200);
  const data = (await r.json()) as any;
  expect(Array.isArray(data.files)).toBe(true);
  expect((await fetch(`${base}/api/files`)).status).toBe(403);
});

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}
