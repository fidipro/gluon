/**
 * Kimi Code's cost in Gluon's frame (`src/kimi-usage.ts`): the session's figure comes from the official binary's own `kimi export`, a zip the
 * fake `kimi` hands over (`FAKE_KIMI_ZIP`), read for its `usage.record` lines alone and priced at Gluon's table.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiCost } from "../../src/cost/kimi.ts";
import { readLedger } from "../../src/cost/ledger-file.ts";
import { priceEntry } from "../../src/cost/tables.ts";
import { WIN } from "./fixtures.ts";
import { ASK_YAML, gluon, launch } from "./gluon-kit.ts";
import { SLOW, stopAll } from "./harness.ts";
import { makeZip, usageLine } from "../fixtures/zip.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

const MAIN = { inputOther: 1_000_000, output: 100_000, inputCacheRead: 0, inputCacheCreation: 0 };
const SUB = { inputOther: 500_000, output: 50_000, inputCacheRead: 0, inputCacheCreation: 0 };
const PROMPT = "SECRET-PROMPT-never-kept";

/** The zip a fake `kimi export` hands over: a main agent's wire log with a prompt in it, and a subagent's. */
function zipFile(dir: string, model: string): string {
  const file = join(dir, "export.zip");
  writeFileSync(
    file,
    makeZip({
      "manifest.json": "{}",
      "agents/main/wire.jsonl": `${JSON.stringify({ type: "turn.prompt", text: PROMPT })}\n${usageLine(MAIN, { model })}\n`,
      "agents/agent_sub1/wire.jsonl": `${usageLine(SUB, { agentId: "agent_sub1", model, usageScope: "session" })}\n`,
    }),
  );
  return file;
}

async function session(yaml: string, key: string, model: string) {
  const dir = mkdtempSync(join(tmpdir(), "gluon-kimi-cost-"));
  const state = join(dir, "state");
  const log = join(dir, "kimi.log");
  const app = await gluon(100, 30, { XDG_STATE_HOME: state, FAKE_KIMI_ZIP: zipFile(dir, model), FAKE_KIMI_LOG: log, OPENROUTER_API_KEY: "sk-or-v1-test-0123456789abcdef" }, yaml, ["kimi"]);
  await launch(app, "fix the thing");
  const ours = (kimiCost(priceEntry(key)!, MAIN).usd + kimiCost(priceEntry(key)!, SUB).usd).toFixed(2);
  return { app, dir, state, log, ours };
}

test.skipIf(WIN)("Kimi Code on OpenRouter: the figure is Gluon's, `~` (an estimate while it runs), tokens of its export (a subagent's too) at OpenRouter's price; the zip and its directory are gone, the ledger keeps counts only @full", async () => {
  const k = await session(`${ASK_YAML}connections:\n  kimi-code: { auth: api, provider: openrouter }\n`, "openrouter/moonshotai/kimi-k3", "__kimi_env_model__");
  try {
    // From the status timer, not from the screen: a few seconds after the launch. An OpenRouter session's running figure is an estimate (`~`: the provider that served each request sets the price).
    await k.app.waitFor((s) => s.split("\n")[1]!.includes(`· ~$${k.ours}`), 30_000);
    const log = readFileSync(k.log, "utf8");
    expect(log).toMatch(/^export session_fake1 -o \S+session\.zip -y --no-include-global-log mode=700$/m);
    const dir = /-o (\S+)session\.zip/.exec(log)![1]!;
    expect(dir).toContain("gluon-kimi-export-");
    expect(readdirSync(tmpdir()).filter((f) => `${tmpdir()}/${f}/` === dir)).toEqual([]);
    const entries = readLedger(join(k.state, "gluon", "cost-audit"));
    const usage = entries.filter((e) => e.kind === "usage");
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ harness: "kimi-code", connection: "openrouter", model: "moonshotai/kimi-k3", channel: "export", counts: { input: 1_000_000, output: 100_000 } });
    expect(JSON.stringify(entries)).not.toContain(PROMPT);
    expect(entries.filter((e) => e.kind === "observation")).toEqual([]);
  } finally {
    rmSync(k.dir, { recursive: true, force: true });
  }
});

test.skipIf(WIN)("Kimi Code on its plan: Moonshot's API price of the model, marked as a plan's API-equivalent (`~`) @full", async () => {
  const k = await session(`${ASK_YAML}connections:\n  kimi-code: { auth: subscription }\n`, "moonshotai/kimi-k3", "kimi-code/k3");
  try {
    await k.app.waitFor((s) => s.split("\n")[1]!.includes(`· ~$${k.ours}`), 30_000);
    const usage = readLedger(join(k.state, "gluon", "cost-audit")).filter((e) => e.kind === "usage");
    expect(usage[0]).toMatchObject({ connection: "plan", model: "kimi-k3", channel: "export" });
  } finally {
    rmSync(k.dir, { recursive: true, force: true });
  }
});
