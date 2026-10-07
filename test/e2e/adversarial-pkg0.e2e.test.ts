/**
 * Independent adversarial e2e tests for issue #39 package 0 (Gluon's own context %): the gaps that
 * mutations of `src/gluon.ts` left open (named in each test). Offline: the TUI fake's `!otel` / `!event`.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDir } from "./fixtures.ts";
import { gluon, launch, say } from "./gluon-kit.ts";
import { SLOW, stopAll } from "./harness.ts";
import type { ContextEntry } from "../../src/cost/ledger.ts";
import { readLedger } from "../../src/cost/ledger-file.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

async function waitUntil(ok: () => boolean, ms = 10_000 * SLOW) {
  for (const end = Date.now() + ms; !ok(); await Bun.sleep(50)) if (Date.now() > end) throw new Error("timed out waiting for the ledger");
}

describe("Gluon's own context %: gaps found by mutation", () => {
  test("ADV-PKG0/peak-in-the-first-big-request: a first prompt past 200k on a 200k model proves 1M at once (25%, not 100%), and the proof outlives a compaction @full", async () => {
    const app = await gluon();
    await launch(app, "peak task");
    const info = () => app.lines()[1]!;
    await say(app, "!otel 1 100000 claude-opus-4-6", "OTEL 200,200");
    await app.waitFor((s) => /· ~?\$[\d.]+ · 50% context/.test(s.split("\n")[1]!));
    await say(app, "!otel 1 250000 claude-opus-4-6", "OTEL 200,200");
    await app.waitFor((s) => s.split("\n")[1]!.includes("25% context"));
    await say(app, "!otel 1 compact", "OTEL 200,200");
    await app.waitFor((s) => !s.split("\n")[1]!.includes("% context"));
    // The window proved by the 250k prompt is still the session's.
    await say(app, "!otel 1 100000 claude-opus-4-6", "OTEL 200,200");
    await app.waitFor((s) => s.split("\n")[1]!.includes("10% context"));
    expect(info()).not.toContain("50% context");
  });

  test("ADV-PKG0/compaction-hook-clears-the-row: a status with `compacting` (Codex's PreCompact hook) empties the context % until the next request @full", async () => {
    const app = await gluon();
    await launch(app, "hook task");
    await say(app, "!otel 1.23 380000", "OTEL 200,200");
    await app.waitFor((s) => s.split("\n")[1]!.includes("38% context"));
    await say(app, "!event compacting", "EVENT compacting");
    await app.waitFor((s) => !s.split("\n")[1]!.includes("% context"));
    await say(app, "!otel 1.30 100000", "OTEL 200,200");
    await app.waitFor((s) => s.split("\n")[1]!.includes("10% context"));
  });

  test("ADV-PKG0/audit-of-a-stale-or-windowless-report: a report with tokens and no window is audited against our own figure; after a compaction there is no figure of ours to audit against; hostile figures are survived @full", async () => {
    const state = mkdtempSync(join(tmpdir(), "gluon-ledger-"));
    try {
      const app = await gluon(100, 30, { XDG_STATE_HOME: state });
      await launch(app, "audit task");
      const contexts = () => readLedger(join(state, "gluon", "cost-audit")).filter((e): e is ContextEntry => e.kind === "context");
      await say(app, "!otel 1.23 380000", "OTEL 200,200");
      await app.waitFor((s) => s.split("\n")[1]!.includes("38% context"));
      // Tokens, no window (a harness that does not say): our side and its tokens are kept, there is no percentage on its side and no cause.
      await say(app, "!event figures tokens=380000", "EVENT figures");
      // A reading with no percentage can't agree with ours, so it waits for ours (BUG-472): the next reading judges it, here one that agrees (it is written at once).
      await say(app, "!event figures tokens=380000 window=1000000", "EVENT figures");
      await waitUntil(() => contexts().length >= 2);
      expect(contexts()[0]).toMatchObject({ harness: "claude-code", ownTokens: 380_000, ownWindow: 1_000_000, ownPct: 38, reportedTokens: 380_000 });
      expect(contexts()[0]).not.toHaveProperty("reportedWindow");
      expect(contexts()[0]).not.toHaveProperty("reportedPct");
      expect(contexts()[0]).not.toHaveProperty("cause");
      // A compaction empties our figure; the next report is audited against nothing (not against the request before the compaction).
      await say(app, "!otel 1.30 compact", "OTEL 200,200");
      await app.waitFor((s) => !s.split("\n")[1]!.includes("% context"));
      await say(app, "!event figures tokens=9000 window=1000000", "EVENT figures");
      // It waits for ours too (we have none): the next valid reading judges it.
      await say(app, "!event figures tokens=9001 window=1000000", "EVENT figures");
      await waitUntil(() => contexts().length >= 3);
      const after = contexts()[2]!;
      expect(after).toMatchObject({ reportedTokens: 9_000, reportedWindow: 1_000_000 });
      for (const k of ["ownTokens", "ownWindow", "ownPct", "cause"]) expect(after).not.toHaveProperty(k);
      // Hostile figures from the status channel: the session carries on and shows only its own percentage.
      for (const f of ["tokens=-5 window=200000", "tokens=NaN window=200000", "tokens=1e300 window=200000", "tokens=100 window=-1"]) await say(app, `!event figures ${f}`, "EVENT figures");
      await say(app, "!otel 1.40 100000", "OTEL 200,200");
      await app.waitFor((s) => s.split("\n")[1]!.includes("10% context"));
      expect(app.lines()[1]).not.toMatch(/NaN|-\d+% context|\d{4,}% context/);
      for (const c of contexts()) for (const v of [c.ownTokens, c.reportedTokens, c.ownWindow, c.reportedWindow, c.ownPct, c.reportedPct]) if (v !== undefined) expect(v >= 0 && Number.isFinite(v)).toBe(true);
    } finally {
      cleanDir(state);
    }
  });
});

describe("BUG-366/peak-is-per-model", () => {
  // `peak` was the session's largest prompt: after a /model switch from a 1M-window model that had a 250k prompt to Haiku 4.5 (200k),
  // Haiku's 100k prompt read 10% of a window it does not have (50% is right). It is kept per model now.
  test("BUG-366/peak-survives-a-model-switch: the 1M window proved by one model's big prompt is not applied to another model's 200k window @full", async () => {
    const app = await gluon();
    await launch(app, "switch task");
    await say(app, "!otel 1 250000 claude-opus-4-6", "OTEL 200,200");
    await app.waitFor((s) => s.split("\n")[1]!.includes("25% context"));
    await say(app, "!otel 1 100000 claude-haiku-4-5", "OTEL 200,200");
    await app.waitFor((s) => s.split("\n")[1]!.includes("50% context"), 5_000);
    // Back on the model that proved it: its own proof still holds.
    await say(app, "!otel 1 100000 claude-opus-4-6", "OTEL 200,200");
    await app.waitFor((s) => s.split("\n")[1]!.includes("10% context"), 5_000);
  });
});
