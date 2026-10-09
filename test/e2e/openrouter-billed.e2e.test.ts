/**
 * What OpenRouter billed an OpenRouter session in Gluon's frame (`src/openrouter-billed.ts`): a fake `/api/v1/key` (the test seam
 * `GLUON_TEST_OPENROUTER` points Gluon at it, with short timings; release builds have no seam) gives the key's usage before and after the session;
 * the settled delta is what the chat says the session was billed, and a session that shared the key says why it has no figure.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedger } from "../../src/cost/ledger-file.ts";
import { keyTag } from "../../src/openrouter-billed.ts";
import { WIN } from "./fixtures.ts";
import { ASK_YAML, gluon, launch } from "./gluon-kit.ts";
import { KEY as KEYS, SLOW, stopAll } from "./harness.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

const KEY = "sk-or-v1-test-0123456789abcdef";
const YAML = `${ASK_YAML}connections:\n  kimi-code: { auth: api, provider: openrouter }\n`;

/** A fake OpenRouter: `/key` answers the next usage (the last repeats) and remembers who asked. */
function fakeOpenRouter(usages: number[]) {
  const seen: { path: string; auth: string | null }[] = [];
  let i = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, auth: req.headers.get("authorization") });
      if (path === "/api/v1/key") return Response.json({ data: { usage: usages[Math.min(i++, usages.length - 1)], limit: null } });
      return new Response("{}", { status: 404 });
    },
  });
  return { server, seen, base: `http://127.0.0.1:${server.port}/api/v1` };
}

async function session(usages: number[]) {
  const dir = mkdtempSync(join(tmpdir(), "gluon-or-e2e-"));
  const state = join(dir, "state");
  const or = fakeOpenRouter(usages);
  const seam = join(dir, "seam.json");
  writeFileSync(seam, JSON.stringify({ base: or.base, timings: { pollMs: 150, settleMs: 300, giveUpMs: 8000, sampleMs: 60_000, tailMs: 400 } }));
  const app = await gluon(100, 30, { XDG_STATE_HOME: state, GLUON_TEST_OPENROUTER: seam, OPENROUTER_API_KEY: KEY }, YAML, ["kimi"]);
  return { app, dir, state, or };
}

const end = async (app: Awaited<ReturnType<typeof gluon>>) => {
  await app.type("/exit");
  await app.press(KEYS.enter);
};

test.skipIf(WIN)("BUG-481/e2e: an OpenRouter session on a key nothing else used: the chat says what OpenRouter billed (the key's usage over the session), the ledger audits it against Gluon's own, the key is only in the header @full", async () => {
  const s = await session([10, 10.37]);
  try {
    await launch(s.app, "fix the thing");
    // While it runs the figure is an estimate (the model has two endpoint prices), and the key was read once, before it started.
    await s.app.waitFor((r) => r.split("\n")[1]!.includes("kimi code"), 20_000);
    expect(s.or.seen.filter((r) => r.path === "/api/v1/key")).toHaveLength(1);
    await end(s.app);
    await s.app.waitFor((r) => r.replace(/\s+/g, " ").includes("OpenRouter billed $0.37✓ for this session"), 30_000);
    expect(s.or.seen.filter((r) => r.path === "/api/v1/key").every((r) => r.auth === `Bearer ${KEY}`)).toBe(true);
    // The key's usage is the only thing Gluon asks OpenRouter at run time (the endpoint prices are in the table).
    expect(s.or.seen.every((r) => r.path === "/api/v1/key")).toBe(true);
    expect(s.app.history()).not.toContain(KEY);
    const entries = readLedger(join(s.state, "gluon", "cost-audit"));
    expect(entries.find((e) => e.kind === "observation" && e.scope === "billed")).toMatchObject({ harness: "kimi-code", reportedMicros: 370_000 });
    expect(JSON.stringify(entries)).not.toContain(KEY);
  } finally {
    s.or.server.stop(true);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

