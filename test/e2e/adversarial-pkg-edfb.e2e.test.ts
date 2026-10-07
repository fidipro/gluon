/**
 * Independent adversarial e2e tests for issue #39 packages D and B (src/gluon.ts wiring): the gaps that
 * mutations of the wiring left open. Offline: the TUI fakes' `!event`.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDir } from "./fixtures.ts";
import { launchAs, say } from "./gluon-kit.ts";
import { SLOW, stopAll } from "./harness.ts";
import type { ContextEntry, LedgerEntry } from "../../src/cost/ledger.ts";
import { readLedger } from "../../src/cost/ledger-file.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

async function waitUntil(ok: () => boolean, ms = 10_000 * SLOW) {
  for (const end = Date.now() + ms; !ok(); await Bun.sleep(50)) if (Date.now() > end) throw new Error("timed out waiting for the ledger");
}

describe("Antigravity: the row is Gluon's own, agy's figures only audit", () => {
  test("ADV-EDFB/agy-row: no cost on the row (agy has none: its totals are the conversation's size), the context is total_input_tokens over Gluon's window, agy's own figures reach the ledger only; after /clear the new conversation's size shows at once (BUG-387, BUG-389) @full", async () => {
    const state = mkdtempSync(join(tmpdir(), "gluon-ledger-"));
    try {
      const app = await launchAs("agy", { env: { XDG_STATE_HOME: state } });
      const info = () => app.lines()[1]!;
      const ledger = () => readLedger(join(state, "gluon", "cost-audit"));
      // agy's own figures alone: no cost, no context % on the row.
      await say(app, "!event figures cost=0.5 tokens=100000 window=1000000", "EVENT figures");
      await say(app, "!event status awaiting", "EVENT status awaiting");
      await app.waitFor((s) => s.split("\n")[1]!.includes("awaiting your input"));
      expect(info()).not.toContain("$0.50");
      expect(info()).not.toContain("% context");
      // The conversation's size over Gluon's window (gemini-3.8-flash: 1,048,576): 524,288 tokens are 50%. Whatever the totals are, no cost.
      await say(app, "!event totals 524288 100000 gemini-3.8-flash", "EVENT totals");
      await app.waitFor((s) => s.split("\n")[1]!.includes("50% context"));
      expect(info()).not.toMatch(/\$\d/);
      // agy's own percentage lands in the ledger beside ours, with no difference.
      await say(app, "!event figures tokens=524288 window=1048576", "EVENT figures");
      await waitUntil(() => ledger().some((e) => e.kind === "context" && e.ownPct === 50 && e.reportedPct === 50));
      expect(ledger().find((e): e is ContextEntry => e.kind === "context" && e.ownPct === 50 && e.reportedPct === 50)).toMatchObject({ cause: "none", ownWindow: 1_048_576 });
      expect(ledger().some((e) => e.kind === "usage")).toBe(false);
      // `/clear`: a new conversation, totals back to zero: the row shows its size now, not the old one.
      await say(app, "!event totals 0 0 gemini-3.8-flash", "EVENT totals");
      await app.waitFor((s) => s.split("\n")[1]!.includes("0% context"));
      expect(info()).not.toContain("50% context");
    } finally {
      cleanDir(state);
    }
  });
});

describe("Codex: the hook names the main conversation; turn costs are audited", () => {
  test("ADV-EDFB/codex-main-session: the context follows the conversation the hook's session event names (a /fork), not the first one seen; a turn_cost lands in the ledger as a turn observation, never on the row @full", async () => {
    const state = mkdtempSync(join(tmpdir(), "gluon-ledger-"));
    try {
      const app = await launchAs("codex", { env: { XDG_STATE_HOME: state } });
      const info = () => app.lines()[1]!;
      const ledger = () => readLedger(join(state, "gluon", "cost-audit"));
      // Codex: (tokens - 12,000) / (258,400 - 12,000) of the usable window of gpt-6-sol.
      const pct = (tokens: number) => Math.round(((tokens - 12_000) / (258_400 - 12_000)) * 100);
      await say(app, "!codex response orig 60000 10", "CODEX response 200");
      await app.waitFor((s) => s.split("\n")[1]!.includes(`${pct(60_010)}% context`));
      // The hook of a forked thread names it; the original thread's later responses are then a side conversation.
      await say(app, "!event session forked-thread", "EVENT session");
      await say(app, "!codex response forked-thread 120000 10", "CODEX response 200");
      await app.waitFor((s) => s.split("\n")[1]!.includes(`${pct(120_010)}% context`));
      await say(app, "!codex response orig 200000 10", "CODEX response 200");
      await say(app, "!codex response forked-thread 130000 10", "CODEX response 200");
      await app.waitFor((s) => s.split("\n")[1]!.includes(`${pct(130_010)}% context`));
      expect(info()).not.toContain(`${pct(200_010)}% context`);
      // A turn_cost whose tokens are those of the responses Gluon priced: a turn-scope observation in the ledger; the row shows our figure only.
      await say(app, "!codex turn forked-thread 120000 10 0.5", "CODEX turn 200");
      await waitUntil(() => ledger().some((e) => e.kind === "observation" && e.scope === "turn"));
      expect(ledger().find((e) => e.kind === "observation" && e.scope === "turn")).toMatchObject({ harness: "codex", reportedMicros: 500_000 });
      expect(info()).not.toContain("$0.50");
    } finally {
      cleanDir(state);
    }
  });
});
