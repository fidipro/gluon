#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * The behavioural oracle for Claude Code's cost (issue #39): drives the REAL `claude` binary,
 * offline, against a local fake Messages API that answers with usage vectors chosen here (a 5m and
 * a 1h cache write, US inference, fast mode, web searches, several models), and checks that Gluon's
 * port (`src/cost/claude.ts`, the catalog table: `--catalog <file>`, else the local store's) reproduces the cost Claude reports for each.
 * Not part of the regression suite (it runs a real binary): run it by hand when refreshing the price tables.
 *   bun scripts/pricing/oracle-claude.ts --binary path [--catalog claude-catalog.json]
 * Exit 1 when any vector differs. No login, no key, no network beyond loopback: an isolated HOME.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCost, claudePriceFromTier, type ClaudeUsage } from "../../src/cost/claude.ts";
import { parseTable } from "../../src/cost/table-schema.ts";
import { claudeCatalogModel, currentTables, type ClaudeCatalog } from "../../src/cost/tables.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const binary = arg("--binary");
if (!binary) throw new Error("no claude binary: pass --binary <path> (a binary is never looked up on PATH)");
const catalogFile = arg("--catalog");
let CLAUDE_CATALOG: ClaudeCatalog | undefined = currentTables().claudeCatalog;
if (catalogFile) {
  const parsed = parseTable("claude-catalog", readFileSync(catalogFile, "utf8"));
  if ("problem" in parsed) throw new Error(`--catalog ${catalogFile}: ${parsed.problem}`);
  CLAUDE_CATALOG = parsed.table as unknown as ClaudeCatalog;
}
if (!CLAUDE_CATALOG) throw new Error("no claude catalog: pass --catalog <file> (the local store has none yet)");

interface Vector {
  name: string;
  model: string;
  usage: ClaudeUsage & { speed?: string };
  /** The price Claude should have used (default: the model's catalog tier). */
  fast?: boolean;
}
const base = { input_tokens: 1000, output_tokens: 600, cache_creation_input_tokens: 20_000 };
const vectors: Vector[] = [
  { name: "5m write", model: "claude-opus-4-6", usage: base },
  { name: "1h write", model: "claude-opus-4-6", usage: { ...base, cache_creation: { ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 0 } } },
  { name: "mixed 8k 5m + 12k 1h", model: "claude-opus-4-6", usage: { ...base, cache_creation: { ephemeral_1h_input_tokens: 12_000, ephemeral_5m_input_tokens: 8_000 } } },
  { name: "US inference x1.1", model: "claude-opus-4-6", usage: { ...base, inference_geo: "us" } },
  { name: "2 web searches", model: "claude-opus-4-6", usage: { ...base, server_tool_use: { web_search_requests: 2 } } },
  { name: "cache read", model: "claude-haiku-4-5", usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 30_000 } },
  { name: "sonnet 5.5", model: "claude-sonnet-5-5", usage: base },
  { name: "opus 5.5", model: "claude-opus-5-5", usage: base },
  { name: "fable 5.1", model: "claude-fable-5-1", usage: base },
  { name: "fast mode", model: "claude-opus-4-6", usage: { ...base, speed: "fast" }, fast: true },
  // A tier with a `long_prompt` row (2.1.293 on: Haiku 5.5): a prompt over its size is billed wholly at that row (BUG-675). Skipped when the catalog lacks the model.
  { name: "haiku 5.5 short prompt", model: "claude-haiku-5-5", usage: { input_tokens: 1000, output_tokens: 600, cache_read_input_tokens: 90_000 } },
  { name: "haiku 5.5 long prompt", model: "claude-haiku-5-5", usage: { input_tokens: 1000, output_tokens: 600, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 10_000 } },
];

let current: Vector | undefined;
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/messages" || !current) return new Response("{}", { headers: { "content-type": "application/json" } });
    const j = (await req.json()) as { model: string; stream?: boolean };
    const u = current.usage;
    const message = { id: "msg_1", type: "message", role: "assistant", model: j.model, content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { ...u, output_tokens: 1 } };
    if (!j.stream) return Response.json({ ...message, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: u });
    const body =
      sse("message_start", { type: "message_start", message }) +
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }) +
      sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: u.output_tokens } }) +
      sse("message_stop", { type: "message_stop" });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

const home = mkdtempSync(join(tmpdir(), "gluon-oracle-"));
mkdirSync(join(home, "work"), { recursive: true });
writeFileSync(join(home, "cfg.json"), "{}");
let failures = 0;
let ran = 0;
try {
  for (const v of vectors) {
    const m = claudeCatalogModel(v.model, CLAUDE_CATALOG);
    if (!m) {
      console.log(`skip ${v.name.padEnd(24)} (${v.model} is not in the catalog)`);
      continue;
    }
    ran++;
    current = v;
    // Async: this process is also the fake API, which must answer while the binary runs.
    const proc = Bun.spawn([binary, "-p", "say ok", "--model", v.model, "--output-format", "json"], {
      cwd: join(home, "work"),
      env: { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_CONFIG_DIR: join(home, "cfg"), ANTHROPIC_API_KEY: "sk-ant-oracle00000000000000", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), 90_000);
    const out = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);
    let reported = Number.NaN;
    try {
      const result = JSON.parse(out) as { total_cost_usd?: number };
      reported = result.total_cost_usd ?? Number.NaN;
    } catch {}
    // Fast mode: the catalog data's fast row for the model (from Claude Code's price function), else the usual tier.
    const fastTier = CLAUDE_CATALOG.fastPricing?.[m.id];
    const price = claudePriceFromTier(v.fast && fastTier ? fastTier : CLAUDE_CATALOG.pricingTiers[m.pricing]!);
    const own = claudeCost(price, v.usage);
    const ok = Math.abs(own.micros - Math.round(reported * 1e6)) <= 1;
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "DIFF"} ${v.name.padEnd(24)} claude ${Number.isFinite(reported) ? `$${reported.toFixed(6)}` : "no cost (exit " + exitCode + ")"}  gluon $${own.usd.toFixed(6)}`);
  }
} finally {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
}
console.log(failures ? `${failures} of ${ran} vectors differ: Claude Code's pricing changed (update scripts/pricing and src/cost/claude.ts)` : `${ran} of ${ran} vectors reproduce Claude Code's own cost`);
// Every vector skipped (a renamed catalog) proves nothing: that is a failure, not a pass.
if (ran === 0) console.log("0 of 0 vectors ran: no vector's model is in the catalog (renamed ids? update the vectors in scripts/pricing/oracle-claude.ts)");
process.exit(failures || ran === 0 ? 1 : 0);
