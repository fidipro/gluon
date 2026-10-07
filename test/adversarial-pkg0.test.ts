/**
 * Independent adversarial tests for issue #39 package 0 (Gluon owns its context % and cost): each
 * test here fails under a mutation of the code that the builder's own tests let through (named in the
 * test), or probes an edge the builder's tests do not reach. The bug candidates it found are fixed and
 * numbered at the end (BUG-366 to BUG-369).
 */
import { describe, expect, test } from "bun:test";
import { contextCause, ownPercent, ownWindow, windowIsGuess } from "../src/cost/context.ts";
import { Ledger, sanitize, type ContextEntry, type LedgerEntry } from "../src/cost/ledger.ts";
import type { CostTracker } from "../src/cost/tracker.ts";
import type { ModelsDevTable } from "../src/cost/tables.ts";
import { GROK_DEFAULT_WINDOW } from "../src/cost/grok.ts";
import { costLabel } from "../src/sessions.ts";
import type { Harness } from "../src/harnesses.ts";
import { FROZEN_CLAUDE_CATALOG, FROZEN_TABLE, frozenTableWith, frozenTracker } from "./fixtures/frozen-prices.ts";

const usageOf = (l: Ledger) => l.entries.filter((e): e is Extract<LedgerEntry, { kind: "usage" }> => e.kind === "usage");
const contextsOf = (l: Ledger) => l.entries.filter((e): e is ContextEntry => e.kind === "context");

describe("tracker: gaps found by mutation", () => {
  test("digest: a Claude fast request is tagged with the table that priced it: the catalog's own fast rows for a catalog model, models.dev's fast row for one outside it (mutation: digest follows `tier` alone)", () => {
    // Package A: Claude Code's price function gives a catalog model its fast row (`fastPricing`); models.dev's fast mode is only for a model the catalog does not list.
    const outside = "claude-adv-outside-9";
    const table: ModelsDevTable = { ...FROZEN_TABLE, catalogDigest: "e".repeat(64), entries: { ...FROZEN_TABLE.entries, [`anthropic/${outside}`]: { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 }, context: 1_000_000, modes: { fast: { speed: "fast", cost: { input: 30, output: 150, cache_read: 3, cache_write: 37.5 } } } } } };
    const ledger = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger, table, now: () => 1 });
    const req = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
    t.claudeRequest({ ...req, model: "claude-opus-4-6" });
    t.claudeRequest({ ...req, model: "claude-opus-4-6", fast: true });
    t.claudeRequest({ ...req, model: outside });
    t.claudeRequest({ ...req, model: outside, fast: true });
    const [catNormal, catFast, outNormal, outFast] = usageOf(ledger);
    expect(catFast!.ownMicros).toBe(30_000 + 15_000);
    expect([catNormal!.table, catFast!.table]).toEqual([FROZEN_CLAUDE_CATALOG.catalogDigest.slice(0, 8), FROZEN_CLAUDE_CATALOG.catalogDigest.slice(0, 8)]);
    expect(outFast!.ownMicros).toBe(30_000 + 15_000);
    expect([outNormal!.table, outFast!.table]).toEqual(["e".repeat(8), "e".repeat(8)]);
  });

  test("launched-model-price is tagged on Codex and Grok too, not only OpenCode (mutation: tag dropped from codexResponse / grokRequest)", () => {
    const grokTable: ModelsDevTable = frozenTableWith({ "xai/adv-launched": { cost: { input: 2, output: 6, cache_read: 0.5 }, context: 500_000 } });
    const lg = new Ledger();
    const g = frozenTracker({ harness: "grok-build", conn: "xai", launchedKey: "xai/adv-launched", ledger: lg, table: grokTable, now: () => 1 });
    g.grokRequest({ model: "adv-unlisted", input: 1000, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    g.grokRequest({ model: "adv-launched", input: 1000, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    expect(usageOf(lg).map((u) => u.assumptions)).toEqual([["launched-model-price"], []]);
    expect(g.figure()!.approx).toBe(true);

    const lc = new Ledger();
    const c = frozenTracker({ harness: "codex", conn: "openai", launchedKey: "openai/gpt-6-luna", ledger: lc, now: () => 1 });
    c.codexResponse({ model: "gpt-unlisted-9", input: 1000, cached: 0, cacheWrite: 0, output: 100 });
    c.codexResponse({ model: "gpt-6-luna", input: 1000, cached: 0, cacheWrite: 0, output: 100 });
    expect(usageOf(lc).map((u) => u.assumptions)).toEqual([["launched-model-price"], []]);
    expect(usageOf(lc)[0]!.ownMicros).toBe(usageOf(lc)[1]!.ownMicros);
  });

  test("figure: one priced and one unpriced request never show the partial own sum as ours: the harness's total stands in, marked (mutation: `unpriced === 0` dropped)", () => {
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger: new Ledger(), now: () => 1 });
    t.claudeRequest({ model: "claude-haiku-4-5", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    t.claudeRequest({ model: "claude-made-up-9", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    // Only the priced request is in our sum: without the harness's total it is shown as an estimate (~), still ours.
    expect(t.figure()).toEqual({ usd: 1, approx: true, own: true });
    t.reportedCumulative(2.5);
    expect(t.figure()).toEqual({ usd: 2.5, approx: false, own: false });
    expect(costLabel(t.figure())).toBe("$2.50*");
  });

  test("observeContext: a harness's tokens past its window are a reading of 100%, not 250% (mutation: clamp dropped)", () => {
    const l = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger: l, now: () => 1 });
    t.observeContext({ own: { tokens: 100_000, window: 200_000 }, reported: { tokens: 500_000, window: 200_000 } });
    expect(contextsOf(l)[0]).toMatchObject({ ownPct: 50, reportedPct: 100, cause: "tokens" });
  });
});

describe("contextCause: boundaries (mutations: tolerances widened)", () => {
  test("tokens within 0.1% of the harness's count are the same tokens; one past it are not", () => {
    // Windows differ in both (so the percentages differ too): only the tokens decide window vs both.
    const own = { pct: 10, tokens: 1_000_900, window: 10_000_000 };
    const rep = (tokens: number) => ({ pct: 5, tokens, window: 20_000_000 });
    expect(contextCause(own, rep(1_000_000))).toBe("window");
    expect(contextCause({ ...own, tokens: 1_001_100 }, rep(1_000_000))).toBe("both");
  });

  test("percentages a whole point apart are the same reading; three points apart are not (the display's rounding is one point)", () => {
    expect(contextCause({ pct: 50, tokens: 100_000, window: 200_000 }, { pct: 49, tokens: 98_000, window: 200_000 })).toBe("none");
    expect(contextCause({ pct: 50, tokens: 100_000, window: 200_000 }, { pct: 47, tokens: 94_000, window: 200_000 })).toBe("tokens");
    expect(contextCause({ pct: 50, tokens: 100_000, window: 200_000 }, { pct: 51.5, tokens: 103_000, window: 200_000 })).toBe("tokens");
  });
});

describe("ownWindow: boundaries and the environment", () => {
  test("a prompt of exactly 200k fills a 200k window (100%); it takes one token more to prove a 1M one (mutation: `>` to `>=`)", () => {
    expect(ownWindow("claude-code", "claude-opus-4-6", { peak: 200_000 })).toEqual({ window: 200_000, source: "claude-catalog" });
    expect(ownWindow("claude-code", "claude-opus-4-6", { peak: 200_001 })).toEqual({ window: 1_000_000, source: "claude-peak" });
  });

  test("CLAUDE_CODE_DISABLE_1M_CONTEXT=0/false/empty leave the 1M window on; 1/true turn it off whatever the peak says (mutation: `false` read as set)", () => {
    for (const off of ["0", "false", "FALSE", ""]) expect([off, ownWindow("claude-code", "claude-opus-5-5", { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: off } }).window]).toEqual([off, 1_000_000]);
    for (const on of ["1", "true", "TRUE"]) expect([on, ownWindow("claude-code", "claude-opus-5-5", { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: on }, peak: 900_000 })]).toEqual([on, { window: 200_000, source: "claude-1m-disabled" }]);
    // At 200k the percentage stays within 0..100 even for a prompt Claude would never have sent.
    expect(ownPercent("claude-code", 900_000, 200_000)).toBe(100);
  });
});

describe("probes: an unknown model on every harness", () => {
  const unknown = "adv-no-such-model-0";
  test("windows: Claude and OpenCode and Antigravity have none of ours; Codex falls to its own default; Grok to its default (marked as one)", () => {
    const got = (h: Harness) => ownWindow(h, unknown, { launchedModel: "adv-launched-0" });
    expect(got("claude-code")).toEqual({ window: undefined, source: "none" });
    expect(got("opencode")).toEqual({ window: undefined, source: "none" });
    expect(got("antigravity")).toEqual({ window: undefined, source: "none" });
    expect(got("codex")).toEqual({ window: 258_400, source: "codex-fallback" });
    // Package C: the default is its own source (BUG-369), so a guess is not told as the table's word.
    expect(got("grok-build")).toEqual({ window: GROK_DEFAULT_WINDOW, source: "grok-default" });
    // No window, no percentage, whatever the tokens.
    expect(ownPercent("claude-code", 10_000, got("claude-code").window)).toBeUndefined();
  });

  test("cost: every harness's unknown model has no figure of ours, an unknown-model line in the ledger, and the harness's total is the marked fallback", () => {
    const run = (harness: Harness, conn: "anthropic" | "openai" | "xai" | "openrouter", feed: (t: CostTracker) => void) => {
      const l = new Ledger();
      const t = frozenTracker({ harness, conn, ledger: l, now: () => 1 });
      feed(t);
      expect([harness, t.figure()]).toEqual([harness, undefined]);
      expect(usageOf(l).map((u) => [u.assumptions, u.ownMicros])).toEqual([[["unknown-model"], 0]]);
      t.reportedCumulative(0.75);
      expect([harness, t.figure()]).toEqual([harness, { usd: 0.75, approx: false, own: false }]);
    };
    run("claude-code", "anthropic", (t) => t.claudeRequest({ model: unknown, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }));
    run("codex", "openai", (t) => t.codexResponse({ model: unknown, input: 1, cached: 0, cacheWrite: 0, output: 1 }));
    run("grok-build", "xai", (t) => t.grokRequest({ model: unknown, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }));
    run("opencode", "openrouter", (t) => t.opencodeStep({ model: `openrouter/${unknown}`, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }));
  });
});

describe("probes: what a harness reports as its context", () => {
  const tracker = () => {
    const l = new Ledger();
    return { l, t: frozenTracker({ harness: "claude-code", conn: "anthropic", ledger: l, now: () => 1 }) };
  };

  test("a report with tokens and no window: our side is kept, the reading has no percentage and no cause; with nothing of ours it writes nothing", () => {
    const { l, t } = tracker();
    t.observeContext({ own: { tokens: 100_000, window: 200_000 }, reported: { tokens: 100_000 } });
    expect(contextsOf(l)).toEqual([{ kind: "context", t: 1, harness: "claude-code", ownTokens: 100_000, reportedTokens: 100_000, ownWindow: 200_000, ownPct: 50 }]);
    t.observeContext({ reported: { tokens: 100_000 } });
    t.observeContext({ own: { tokens: 100_000 }, reported: { tokens: 100_000, window: 0 } });
    expect(contextsOf(l).length).toBe(1);
  });

  test("a percentage-only report (Antigravity): within a point of ours it is `none`; otherwise `both` (tokens and window are unknown on its side)", () => {
    const { l, t } = tracker();
    t.observeContext({ own: { tokens: 100_000, window: 200_000 }, reported: { pct: 50.8 } });
    t.observeContext({ own: { tokens: 100_000, window: 200_000 }, reported: { pct: 20 } });
    t.observeContext({ own: { tokens: 100_000 }, reported: { pct: 20 } });
    expect(contextsOf(l).map((c) => [c.ownPct, c.reportedPct, c.cause, c.reportedTokens, c.reportedWindow])).toEqual([[50, 51, "none", undefined, undefined], [50, 20, "both", undefined, undefined], [undefined, 20, undefined, undefined, undefined]]);
    expect(l.contextDivergences().length).toBe(1);
  });

  test("negative, NaN, infinite and huge figures never throw and never put a nonsense figure in the ledger", () => {
    const { l, t } = tracker();
    const own = { tokens: 100_000, window: 200_000 };
    const bad = [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300];
    for (const v of bad) {
      expect(() => t.observeContext({ own, reported: { tokens: v, window: 200_000 } })).not.toThrow();
      expect(() => t.observeContext({ own, reported: { pct: v } })).not.toThrow();
      expect(() => t.observeContext({ own, reported: { tokens: 100_000, window: v } })).not.toThrow();
      expect(() => t.observeContext({ own: { tokens: v, window: 200_000 }, reported: { tokens: 100_000, window: 200_000 } })).not.toThrow();
    }
    for (const c of contextsOf(l)) for (const k of ["ownTokens", "reportedTokens", "ownWindow", "reportedWindow", "ownPct", "reportedPct"] as const) if (c[k] !== undefined) expect(c[k]! >= 0 && c[k]! <= 1e13 && Number.isFinite(c[k]!)).toBe(true);
    // A figure that is not a number is not written as one: the sanitizer leaves it out and keeps the rest (BUG-368); with nothing valid it refuses the entry.
    expect(sanitize({ kind: "context", t: 1, harness: "claude-code", ownPct: 10, reportedPct: Number.NaN })).toEqual({ kind: "context", t: 1, harness: "claude-code", ownPct: 10 });
    expect(sanitize({ kind: "context", t: 1, harness: "claude-code", ownPct: Number.NaN, reportedPct: Number.NaN })).toBeNull();
    // Huge but valid tokens against a window: a percentage clamped at 100.
    t.observeContext({ own, reported: { tokens: 9e12, window: 200_000 } });
    expect(contextsOf(l).at(-1)).toMatchObject({ reportedTokens: 9e12, reportedPct: 100 });
  });

  test("a harness-reported percentage over 100 is kept as the harness said it (up to the ledger's 1000 cap); over the cap that side is absent and our own stays (BUG-368)", () => {
    const { l, t } = tracker();
    t.observeContext({ own: { tokens: 100_000, window: 200_000 }, reported: { pct: 150 } });
    expect(contextsOf(l)[0]).toMatchObject({ ownPct: 50, reportedPct: 150, cause: "both" });
    t.observeContext({ own: { tokens: 100_000, window: 200_000 }, reported: { pct: 5000 } });
    expect(contextsOf(l)).toHaveLength(2);
    expect(contextsOf(l)[1]).toEqual({ kind: "context", t: 1, harness: "claude-code", ownTokens: 100_000, ownWindow: 200_000, ownPct: 50 });
  });
});

describe("BUG-366/367/368/369: what the first round of adversarial tests found", () => {
  // The telemetry names a `[1m]` model without its suffix, but Gluon knows what it launched: Package A's carry-over sizes it 1M.
  test("BUG-367/launched-1m-suffix: a launch of `claude-opus-4-6[1m]` is sized 1M although the telemetry names `claude-opus-4-6`", () => {
    expect(ownWindow("claude-code", "claude-opus-4-6", { launchedModel: "claude-opus-4-6[1m]" })).toEqual({ window: 1_000_000, source: "claude-launched" });
    // Only the same model: another model's launched suffix is not carried over, and a model the catalog says has no `[1m]` stays 200k.
    expect(ownWindow("claude-code", "claude-haiku-4-5", { launchedModel: "claude-opus-4-6[1m]" }).window).toBe(200_000);
  });

  test("BUG-366/override-is-codex's: the config's `model_context_window` sizes a Codex window only (capped by the model's maximum), no other harness's, and no Claude rule is skipped by it", () => {
    const models = { "claude-code": "claude-opus-4-6", "grok-build": "grok-4.6", opencode: "openrouter/deepseek/deepseek-v4-flash", antigravity: "gemini-3.8-flash" } as const;
    for (const [h, model] of Object.entries(models) as [keyof typeof models, string][]) expect([h, ownWindow(h, model, { override: 123_456 })]).toEqual([h, ownWindow(h, model)]);
    // Claude: the 1M rule and the peak rule still apply with an override present.
    expect(ownWindow("claude-code", "claude-opus-4-6", { override: 50_000, peak: 300_000 })).toEqual({ window: 1_000_000, source: "claude-peak" });
    expect(ownWindow("codex", "gpt-6-sol", { override: 100_000 })).toEqual({ window: 95_000, source: "override" });
  });

  test("BUG-368/context-sanitize-keeps-the-valid-side: one invalid figure is absent, the rest of the reading is kept; with no valid percentage left, a `dropped` count says so", () => {
    const l = new Ledger();
    const t = frozenTracker({ harness: "claude-code", conn: "anthropic", ledger: l, now: () => 1 });
    const own = { tokens: 100_000, window: 200_000 };
    // A NaN percentage, tokens past the cap, a negative window: each side's other figures are kept.
    t.observeContext({ own, reported: { pct: Number.NaN } });
    t.observeContext({ own, reported: { tokens: 2e13, window: 200_000 } });
    t.observeContext({ own: { tokens: 100_000, window: -1 }, reported: { tokens: 100_000, window: 200_000 } });
    expect(contextsOf(l)).toEqual([
      { kind: "context", t: 1, harness: "claude-code", ownTokens: 100_000, ownWindow: 200_000, ownPct: 50 },
      { kind: "context", t: 1, harness: "claude-code", ownTokens: 100_000, reportedWindow: 200_000, ownWindow: 200_000, ownPct: 50 },
      { kind: "context", t: 1, harness: "claude-code", ownTokens: 100_000, reportedTokens: 100_000, reportedWindow: 200_000, reportedPct: 50 },
    ]);
    // Nothing valid on either side: no context entry, a counted drop.
    t.observeContext({ own: { tokens: Number.NaN, window: 200_000 }, reported: { pct: Number.POSITIVE_INFINITY } });
    expect(contextsOf(l)).toHaveLength(3);
    expect(l.entries.at(-1)).toEqual({ kind: "dropped", t: 1, harness: "claude-code", what: "context", reason: "invalid-figures", count: 1 });
    // Nothing reported at all is not a drop.
    const before = l.entries.length;
    t.observeContext({ reported: {} });
    expect(l.entries).toHaveLength(before);
  });

  test("BUG-369/grok-unknown-model-window-is-a-guess: an unknown Grok model gets its own `grok-default` source, the row shows no % for it, and the ledger entry carries `unknown-model`", () => {
    expect(ownWindow("grok-build", "grok-no-such-9")).toEqual({ window: GROK_DEFAULT_WINDOW, source: "grok-default" });
    expect(windowIsGuess("grok-default")).toBe(true);
    for (const known of ["grok-table", "grok-observed", "codex-fallback", "claude-catalog", "opencode-models-dev", "agy-table"] as const) expect([known, windowIsGuess(known)]).toEqual([known, false]);
    const l = new Ledger();
    const t = frozenTracker({ harness: "grok-build", conn: "xai", ledger: l, now: () => 1 });
    t.observeContext({ own: { tokens: 100_000, window: GROK_DEFAULT_WINDOW, guessed: true }, reported: { tokens: 100_000, window: 256_000 } });
    t.observeContext({ own: { tokens: 100_000, window: GROK_DEFAULT_WINDOW }, reported: { tokens: 100_000, window: GROK_DEFAULT_WINDOW } });
    expect(contextsOf(l).map((c) => [c.ownWindow, c.cause, c.assumptions])).toEqual([[GROK_DEFAULT_WINDOW, "window", ["unknown-model"]], [GROK_DEFAULT_WINDOW, "none", undefined]]);
    // The sanitizer keeps only the named assumptions.
    expect(sanitize({ kind: "context", t: 1, harness: "grok-build", ownPct: 1, assumptions: ["unknown-model", "my prompt"] })).toMatchObject({ assumptions: ["unknown-model"] });
  });
});
