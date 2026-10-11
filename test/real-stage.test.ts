/**
 * `bun run regression`'s real stage (scripts/real-stage.ts, issue #31): which harnesses a change's real stage covers, when it skips
 * (no tmux, no binary), what it hands the tier, and the model API the tier talks to (test/fixtures/fake-model-api.ts) speaking each
 * harness's protocol. Offline: no harness runs here (the tier itself does: test/real/).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REAL_HARNESSES, REAL_TESTS, realHarnesses, realStage, type RealOptions } from "../scripts/real-stage.ts";
import { liveChecks, selectChanged } from "./areas.ts";
import { FAKE_USAGE, fakeModelApi } from "./fixtures/fake-model-api.ts";

const opts = (extra: Partial<RealOptions> = {}): RealOptions & { said: string[]; runs: Record<string, string>[] } => {
  const said: string[] = [];
  const runs: Record<string, string>[] = [];
  return {
    newest: false,
    tmux: true,
    say: (l) => said.push(l),
    run: async (env) => (runs.push(env), { code: 0, out: " 2 pass\n 0 fail\nRan 2 tests" }),
    bin: async (h, newest) => ({ path: `/cache/${h}`, version: newest ? "9.9.9" : "1.0.0" }),
    said,
    runs,
    ...extra,
  };
};

describe("the real stage", () => {
  test("covers the harnesses of the change's harness checks that can reach a loopback API; a whole tier: all four; the brain alone: none", () => {
    const of = (fs: string[]) => realHarnesses(liveChecks(selectChanged(fs), fs));
    expect(of(["src/adapters/codex.ts"])).toEqual(["codex"]);
    expect(of(["src/pty/session.ts"])).toEqual(["claude-code"]);
    expect(of(["bun.lock"])).toEqual(REAL_HARNESSES);
    expect(of(["src/brain.ts"])).toEqual([]);
    expect(of(["docs/concepts/architecture.md"])).toEqual([]);
    expect(REAL_HARNESSES).not.toContain("antigravity");
    for (const f of REAL_TESTS) expect([f, existsSync(join(import.meta.dir, "..", f))]).toEqual([f, true]);
  });

  test("hands the tier the harnesses and their binaries (the newest with `newest`); its failure fails the stage", async () => {
    const o = opts({ newest: true });
    expect(await realStage(["codex", "opencode"], o)).toEqual({ failed: false });
    expect(o.runs).toEqual([{ GLUON_REAL_HARNESSES: "codex,opencode", GLUON_REAL_BINS: JSON.stringify({ codex: { path: "/cache/codex", version: "9.9.9" }, opencode: { path: "/cache/opencode", version: "9.9.9" } }) }]);
    expect(o.said.join("\n")).toContain("codex 9.9.9, opencode 9.9.9 (newest; loopback model API)");
    const bad = opts({ run: async () => ({ code: 1, out: "(fail) codex: …" }) });
    expect(await realStage(["codex"], bad)).toEqual({ failed: true });
    expect(bad.said.join("\n")).toContain("FAILED\n(fail) codex");
  });

  test("skips, never fails, without tmux (Windows) or a binary (offline, nothing cached); nothing to cover, nothing said", async () => {
    const noTmux = opts({ tmux: false });
    expect(await realStage(["codex"], noTmux)).toEqual({ failed: false });
    expect(noTmux.said).toEqual(["── real: SKIP (no tmux here) · would run: codex"]);
    const noBin = opts({ bin: async () => Promise.reject(new Error("GET https://registry.npmjs.org/x: fetch failed")) });
    expect(await realStage(["codex"], noBin)).toEqual({ failed: false });
    expect(noBin.said.join("\n")).toContain("SKIP (no codex binary: GET https://registry.npmjs.org/x: fetch failed");
    expect(noBin.runs).toEqual([]);
    const none = opts();
    expect(await realStage([], none)).toEqual({ failed: false });
    expect(none.said).toEqual([]);
  });
});

describe("the loopback model API", () => {
  const post = (url: string, body: unknown, enc?: "gzip") =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(enc ? { "content-encoding": enc } : {}) }, body: enc ? Bun.gzipSync(JSON.stringify(body)) : JSON.stringify(body) });

  test("Anthropic Messages (Claude Code), JSON and SSE: the reply and small fixed usage", async () => {
    const api = fakeModelApi("OK", 0);
    try {
      const j = (await (await post(`${api.url}/v1/messages`, { model: "claude-haiku-5-5" })).json()) as { content: { text: string }[]; usage: { input_tokens: number } };
      expect([j.content[0]!.text, j.usage.input_tokens]).toEqual(["OK", FAKE_USAGE.input]);
      const sse = await (await post(`${api.url}/v1/messages`, { model: "m", stream: true })).text();
      expect(sse).toContain('"text_delta","text":"OK"');
      expect(sse.trim().endsWith('data: {"type":"message_stop"}')).toBe(true);
    } finally {
      api.stop();
    }
  });

  test("OpenAI Responses (Codex), a gzip body read; Chat Completions (OpenCode, Kimi Code), JSON and SSE ending in [DONE]; every request recorded", async () => {
    const api = fakeModelApi("hi", 0);
    try {
      const r = await (await post(`${api.url}/v1/responses`, { model: "gpt-6-luna" }, "gzip")).text();
      expect(r).toContain('"type":"response.completed"');
      expect(r).toContain('"text":"hi"');
      const c = (await (await post(`${api.url}/v1/chat/completions`, { model: "x" })).json()) as { choices: { message: { content: string } }[] };
      expect(c.choices[0]!.message.content).toBe("hi");
      expect((await (await post(`${api.url}/v1/chat/completions`, { model: "x", stream: true })).text()).trim().endsWith("data: [DONE]")).toBe(true);
      expect(api.requests.map((q) => q.path)).toEqual(["/v1/responses", "/v1/chat/completions", "/v1/chat/completions"]);
      expect(api.requests[0]!.body).toEqual({ model: "gpt-6-luna" });
    } finally {
      api.stop();
    }
  });
});
