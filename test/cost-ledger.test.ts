/** The audit ledger (`src/cost/ledger.ts`, `ledger-file.ts`, issue #39): what it keeps, what it never does, and how it caps itself. */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DroppedEntry } from "../src/cost/ledger.ts";
import { explain, Ledger, sanitize, toleranceMicros } from "../src/cost/ledger.ts";
import { reportLines } from "../src/cost/report.ts";
import { tableInfos } from "../src/cost/tables.ts";
import { FIXTURE_CLAUDE_CATALOG as CLAUDE_CATALOG, FIXTURE_CODEX_WINDOWS as CODEX_WINDOWS, FIXTURE_GROK_MODELS as GROK_MODELS, FIXTURE_MODELS_DEV as MODELS_DEV } from "./fixtures/fixture-tables.ts";
import { ledgerDir, MARKER_RESERVE, MAX_FILE_BYTES, MAX_FILES, MAX_PER_MINUTE, openLedgerFile, readLedger, removeLedger } from "../src/cost/ledger-file.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-ledger-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const dir = () => join(TMP, `d${++n}`, "gluon", "cost-audit");
const usage = (over: object = {}) => ({ kind: "usage", t: 1_791_000_000_000, harness: "claude-code", model: "claude-opus-4-6", connection: "anthropic", channel: "otel", counts: { input: 3, output: 4, cacheWrite: 21_929 }, ownMicros: 137_171, assumptions: ["cache-ttl-assumed-5m"], table: "3a1d9fce", ...over });

describe("what a ledger entry may hold", () => {
  test("only whitelisted fields: no prompt, user id, host, path or free text ever passes through", () => {
    const e = sanitize({ ...usage(), "user.id": "abc", prompt: "secret text", host: "me-laptop", cwd: "/home/me/repo", session: "s1", counts: { input: 3, "user.email": 1, prompt_length: 9, output: 4 }, harnessVersion: "2.1.289" });
    expect(e).toEqual({ kind: "usage", t: 1_791_000_000_000, harness: "claude-code", harnessVersion: "2.1.289", model: "claude-opus-4-6", connection: "anthropic", channel: "otel", counts: { input: 3, output: 4 }, ownMicros: 137_171, assumptions: ["cache-ttl-assumed-5m"], table: "3a1d9fce" });
    expect(JSON.stringify(e)).not.toMatch(/secret|abc|laptop|repo|s1|email/);
  });

  test("names that aren't names become '?', unknown assumptions and bad versions drop, counts are bounded integers", () => {
    const e = sanitize(usage({ model: "has spaces and /etc/passwd\\n", connection: "x".repeat(500), assumptions: ["list-price", "launched-model-price", "rm -rf /"], harnessVersion: "1.0; DROP", counts: { input: -5, output: 1.7, cacheRead: Number.NaN, cached: 1e30 } }))!;
    expect(e).toMatchObject({ model: "?", connection: "?", assumptions: ["list-price", "launched-model-price"], counts: { output: 2 } });
    expect(e as object).not.toHaveProperty("harnessVersion");
  });

  test("not entries: wrong kind, harness, channel, missing or negative money", () => {
    for (const bad of [null, "x", 3, {}, usage({ harness: "emacs" }), usage({ channel: "screen" }), usage({ ownMicros: -1 }), usage({ ownMicros: "1" }), usage({ t: Number.NaN }), { kind: "observation", t: 1, harness: "codex", scope: "weekly", reportedMicros: 1 }]) expect(sanitize(bad)).toBeNull();
  });

  test("a context entry keeps both sides' tokens, window and percentage (bounded) and a cause from the list; a mismatch beyond a point is a divergence", () => {
    expect(sanitize({ kind: "context", t: 5, harness: "claude-code", ownTokens: 380_000, reportedTokens: 380_000, ownWindow: 1_000_000, reportedWindow: 2_000_000, ownPct: 38, reportedPct: 19, cause: "window", prompt: "x" })).toEqual({ kind: "context", t: 5, harness: "claude-code", ownTokens: 380_000, reportedTokens: 380_000, ownWindow: 1_000_000, reportedWindow: 2_000_000, ownPct: 38, reportedPct: 19, cause: "window" });
    expect(sanitize({ kind: "context", t: 5, harness: "claude-code", ownPct: 11.4, reportedPct: 2, cause: "window" })).toEqual({ kind: "context", t: 5, harness: "claude-code", ownPct: 11, reportedPct: 2, cause: "window" });
    // One side may be missing (Gluon has no figure of its own yet); a figure that is not valid is absent, the valid ones stay (BUG-368); a cause outside the list is dropped.
    expect(sanitize({ kind: "context", t: 5, harness: "opencode", reportedPct: 32, reportedTokens: 32_000, cause: "unexplained" })).toEqual({ kind: "context", t: 5, harness: "opencode", reportedPct: 32, reportedTokens: 32_000 });
    expect(sanitize({ kind: "context", t: 5, harness: "claude-code", ownPct: -1, reportedPct: 2, cause: "window" })).toEqual({ kind: "context", t: 5, harness: "claude-code", reportedPct: 2 });
    expect(sanitize({ kind: "context", t: 5, harness: "claude-code", ownPct: 1, reportedTokens: -3 })).toEqual({ kind: "context", t: 5, harness: "claude-code", ownPct: 1 });
    for (const bad of [{ ownPct: -1 }, { ownTokens: 5 }, {}]) expect(sanitize({ kind: "context", t: 5, harness: "claude-code", ...bad })).toBeNull();
    const l = new Ledger();
    l.add({ kind: "context", t: 1, harness: "claude-code", ownPct: 11, reportedPct: 2, cause: "window" });
    l.add({ kind: "context", t: 2, harness: "claude-code", ownPct: 20, reportedPct: 20, cause: "none" });
    expect(l.contextDivergences().map((c) => c.cause)).toEqual(["window"]);
    expect(reportLines(l.entries.concat(sanitize(usage())!)).join("\n")).toContain("context % audited against the harness's own: 2 readings, 1 differ by more than a point\n  claude-code none: 1 reading (own 20%, reported 20%, on average)\n  claude-code window: 1 reading (own 11%, reported 2%, on average)");
  });

  test("a dropped entry keeps what it was for, a reason slug and a count; nothing else", () => {
    expect(sanitize({ kind: "dropped", t: 5, harness: "codex", what: "usage", reason: "side-conversation", count: 3, prompt: "x" })).toEqual({ kind: "dropped", t: 5, harness: "codex", what: "usage", reason: "side-conversation", count: 3 });
    for (const bad of [{ what: "prompt" }, { reason: "Not A Slug" }, { count: -1 }, { count: undefined }]) expect(sanitize({ kind: "dropped", t: 5, harness: "codex", what: "usage", reason: "x", count: 1, ...bad })).toBeNull();
    const l = new Ledger();
    l.add({ kind: "dropped", t: 1, harness: "codex", what: "usage", reason: "side-conversation", count: 2 });
    l.add({ kind: "dropped", t: 2, harness: "codex", what: "usage", reason: "side-conversation", count: 1 });
    expect(reportLines(l.entries.concat(sanitize(usage())!)).join("\n")).toContain("records Gluon did not count:\n  codex usage: side-conversation: 3");
  });

  test("an observation keeps what it is of (cost unless it says context), its scope, reported and own figure and a cause slug", () => {
    expect(sanitize({ kind: "observation", t: 5, harness: "opencode", what: "cost", scope: "request", reportedMicros: 134, ownMicros: 134, cause: "none", prompt: "x" })).toEqual({ kind: "observation", t: 5, harness: "opencode", what: "cost", scope: "request", reportedMicros: 134, ownMicros: 134, cause: "none" });
    expect(sanitize({ kind: "observation", t: 5, harness: "opencode", what: "context", scope: "turn", reportedMicros: 1, cause: "Not A Slug!" })).toEqual({ kind: "observation", t: 5, harness: "opencode", what: "context", scope: "turn", reportedMicros: 1 });
    // An entry from before `what` existed (or one with junk) is a cost.
    expect(sanitize({ kind: "observation", t: 5, harness: "opencode", what: "prompt", scope: "turn", reportedMicros: 1 })).toMatchObject({ what: "cost" });
    expect(sanitize({ kind: "observation", t: 5, harness: "opencode", scope: "turn", reportedMicros: 1 })).toMatchObject({ what: "cost" });
    // A context observation is no cost divergence.
    const l = new Ledger();
    l.add({ kind: "observation", t: 5, harness: "opencode", what: "context", scope: "request", reportedMicros: 900, ownMicros: 1 });
    expect(l.divergences()).toEqual([]);
  });
});

describe("explaining a difference", () => {
  const hyps = [{ name: "cache-ttl-1h", deltaMicros: 82_250 }, { name: "us-geo", deltaMicros: 14_500 }];
  test("the hypothesis whose delta equals the residual; rounding is no divergence; nothing fits is 'unexplained'", () => {
    expect(explain(82_250, hyps)).toBe("cache-ttl-1h");
    expect(explain(82_251, hyps, 2)).toBe("cache-ttl-1h");
    expect(explain(14_500, hyps)).toBe("us-geo");
    expect(explain(1, hyps)).toBe("none");
    expect(explain(-3, hyps, 3)).toBe("none");
    expect(explain(50_000, hyps)).toBe("unexplained");
    expect(explain(5, [])).toBe("unexplained");
    expect(toleranceMicros(1_000_000)).toBe(1000);
    expect(toleranceMicros(10)).toBe(1);
  });

  test("a Ledger sums our own figure and lists observations that differ beyond rounding", () => {
    const l = new Ledger();
    l.add(usage({ ownMicros: 100 }));
    l.add(usage({ ownMicros: 250 }));
    l.add({ kind: "observation", t: 2, harness: "claude-code", scope: "cumulative", reportedMicros: 350, ownMicros: 350 });
    l.add({ kind: "observation", t: 3, harness: "claude-code", scope: "request", reportedMicros: 90_000, ownMicros: 8_000, cause: "cache-ttl-1h" });
    expect(l.add({ junk: true })).toBeNull();
    expect(l.ownMicros()).toBe(350);
    expect(l.divergences().map((d) => d.cause)).toEqual(["cache-ttl-1h"]);
  });

  test("a sink that throws never breaks the launch", () => {
    const l = new Ledger(() => {
      throw new Error("disk full");
    });
    expect(l.add(usage())).not.toBeNull();
  });
});

describe("the ledger on disk", () => {
  const write = (open: ReturnType<typeof openLedgerFile>, count = 1) => {
    for (let i = 0; i < count; i++) open!(sanitize(usage({ t: 1_791_000_000_000 + i }))!);
  };

  test("the state directory by platform", () => {
    expect(ledgerDir({ XDG_STATE_HOME: "/s" }, "linux", "/h")).toBe("/s/gluon/cost-audit");
    expect(ledgerDir({}, "linux", "/h")).toBe("/h/.local/state/gluon/cost-audit");
    expect(ledgerDir({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\h")).toBe("C:\\L\\gluon\\cost-audit");
  });

  test.skipIf(process.platform === "win32")("private from the start: directory 0700, file 0600, one line per entry, readable back", () => {
    const d = dir();
    const open = openLedgerFile(d, { now: () => 1_791_000_000_000, pid: 42 });
    write(open, 3);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    const [file] = readdirSync(d);
    expect(file).toMatch(/^\d{8}T\d{6}-42\.jsonl$/);
    expect(statSync(join(d, file!)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(d, file!), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
    expect(readLedger(d)).toHaveLength(3);
  });

  test("a partial last line and junk lines are skipped; another entry's fields never come back", () => {
    const d = dir();
    const open = openLedgerFile(d, { now: () => 1_791_000_000_000, pid: 1 });
    write(open, 2);
    const f = join(d, readdirSync(d)[0]!);
    appendFileSync(f, `{"kind":"usage","t":1,"harness":"codex","user.id":"leak","prompt":"p"}\\nnot json\\n{"kind":"usage","t":17910000`);
    const all = readLedger(d);
    expect(all).toHaveLength(2);
    expect(JSON.stringify(all)).not.toMatch(/leak|prompt/);
    expect(readLedger(join(TMP, "nothing-here"))).toEqual([]);
  });

  test("capped: a launch writes at most MAX_PER_MINUTE entries a minute, and starts again the next minute", () => {
    const d = dir();
    let t = 1_791_000_000_000;
    const open = openLedgerFile(d, { now: () => t, pid: 2 });
    write(open, MAX_PER_MINUTE + 50);
    expect(readLedger(d).filter((e) => e.kind === "usage")).toHaveLength(MAX_PER_MINUTE);
    t += 61_000;
    write(open, 5);
    expect(readLedger(d).filter((e) => e.kind === "usage")).toHaveLength(MAX_PER_MINUTE + 5);
  });

  const droppedIn = (d: string) => readLedger(d).filter((e): e is DroppedEntry => e.kind === "dropped");

  test("BUG-353/cap-marker: the first entry a cap refuses leaves one dropped marker; the rest is silent, and the next minute's first write adds the count", () => {
    const d = dir();
    let t = 1_791_000_000_000;
    const open = openLedgerFile(d, { now: () => t, pid: 20 });
    write(open, MAX_PER_MINUTE + 50);
    expect(droppedIn(d)).toEqual([{ kind: "dropped", t, harness: "claude-code", what: "usage", reason: "rate-cap", count: 1 }]);
    // The window resets: the 49 refused after the marker are added, once.
    t += 61_000;
    write(open, 1);
    expect(droppedIn(d).map((x) => x.count)).toEqual([1, 49]);
    write(open, 5);
    expect(droppedIn(d)).toHaveLength(2);
    expect(reportLines(readLedger(d)).join("\n")).toContain("claude-code usage: rate-cap: 50");
  });

  test("BUG-403/cap-marker-at-quit: what the rate cap refused after its marker is added when the writer is closed (quit), not lost; nothing is written after the close; a second close adds nothing", () => {
    const d = dir();
    const t = 1_791_000_000_000;
    const open = openLedgerFile(d, { now: () => t, pid: 21 });
    write(open, MAX_PER_MINUTE + 50);
    expect(droppedIn(d).map((x) => x.count)).toEqual([1]);
    open!.close();
    expect(droppedIn(d)).toEqual([{ kind: "dropped", t, harness: "claude-code", what: "usage", reason: "rate-cap", count: 1 }, { kind: "dropped", t, harness: "claude-code", what: "usage", reason: "rate-cap", count: 49 }]);
    open!.close();
    write(open, 1);
    expect(readLedger(d).filter((e) => e.kind === "usage")).toHaveLength(MAX_PER_MINUTE);
    expect(droppedIn(d)).toHaveLength(2);
    expect(reportLines(readLedger(d)).join("\n")).toContain("claude-code usage: rate-cap: 50");
  });

  test("BUG-353/cap-marker: the size cap leaves one marker inside the file's budget, never beyond MAX_FILE_BYTES", () => {
    const d = dir();
    let t = 1_791_000_000_000;
    const open = openLedgerFile(d, { now: () => t, pid: 21 })!;
    const e = sanitize(usage())!;
    const per = JSON.stringify(e).length + 1;
    // (a fresh minute each time: only the size cap can stop it)
    for (let i = 0; i < MAX_FILE_BYTES / per + 20; i++) {
      t += 61_000;
      open(e);
    }
    const file = join(d, readdirSync(d)[0]!);
    expect(statSync(file).size).toBeLessThanOrEqual(MAX_FILE_BYTES);
    expect(statSync(file).size).toBeGreaterThan(MAX_FILE_BYTES - MARKER_RESERVE - per);
    expect(droppedIn(d)).toEqual([expect.objectContaining({ harness: "claude-code", what: "usage", reason: "file-size-cap", count: 1 })]);
    // A marker comes after the last entry, once, and what follows is silent.
    const size = statSync(file).size;
    open(e);
    expect(statSync(file).size).toBe(size);
  });

  test("BUG-353/cap-marker: files pruned past MAX_FILES are said at the launch's first write", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < MAX_FILES + 2; i++) writeFileSync(join(d, `20260101T0000${String(10 + i).padStart(2, "0")}-${i}.jsonl`), "");
    const open = openLedgerFile(d, { now: () => 1_791_000_000_000, pid: 22 });
    write(open, 2);
    expect(droppedIn(d)).toMatchObject([{ reason: "files-pruned", count: 3 }]);
    expect(readLedger(d).filter((e) => e.kind === "usage")).toHaveLength(2);
  });

  test("at most MAX_FILES files are kept: the oldest go when a new one starts", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    for (let i = 0; i < MAX_FILES + 5; i++) writeFileSync(join(d, `20260101T0000${String(10 + i).padStart(2, "0")}-${i}.jsonl`), "");
    openLedgerFile(d, { now: () => 1_791_000_000_000, pid: 9 });
    const files = readdirSync(d).sort();
    expect(files).toHaveLength(MAX_FILES);
    expect(files.at(-1)).toMatch(/-9\.jsonl$/);
    expect(files[0]).not.toMatch(/T000010-0/);
  });

  test.skipIf(process.platform === "win32")("never writes through a symlink planted at its path; failures return null, never throw", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    const target = join(TMP, "victim.txt");
    writeFileSync(target, "keep");
    symlinkSync(target, join(d, "20260101T000000-7.jsonl"));
    expect(openLedgerFile(d, { now: () => Date.UTC(2026, 0, 1), pid: 7 })).toBeNull();
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(openLedgerFile(join(target, "inside-a-file"), {})).toBeNull();
  });

  test.skipIf(process.platform === "win32")("BUG-357/ledger-dir: an existing directory with a loose mode is set back to 0700; a symlink in its place is refused, and what it points to is untouched", () => {
    const d = dir();
    mkdirSync(d, { recursive: true, mode: 0o755 });
    chmodSync(d, 0o755);
    const open = openLedgerFile(d, { now: () => 1_791_000_000_000, pid: 30 });
    expect(open).not.toBeNull();
    write(open);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(readLedger(d)).toHaveLength(1);

    const real = join(TMP, "someone-elses-dir");
    mkdirSync(real, { mode: 0o755 });
    const link = dir();
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(real, link);
    expect(openLedgerFile(link, { now: () => 1_791_000_000_000, pid: 31 })).toBeNull();
    expect(readdirSync(real)).toEqual([]);
    expect(statSync(real).mode & 0o777).toBe(0o755);
    // A file where the directory should be: refused too, never thrown.
    const file = join(TMP, "a-file");
    writeFileSync(file, "x");
    expect(openLedgerFile(file, { pid: 32 })).toBeNull();
  });

  test.skipIf(process.platform === "win32" || process.getuid === undefined)("BUG-357/ledger-dir: a directory owned by someone else is refused (checked against the process's uid)", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    const uid = process.getuid!;
    // The directory is ours; pretend to be another user.
    (process as { getuid?: () => number }).getuid = () => uid() + 1;
    try {
      expect(openLedgerFile(d, { pid: 33 })).toBeNull();
    } finally {
      (process as { getuid?: () => number }).getuid = uid;
    }
    expect(readdirSync(d)).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("BUG-356/remove: removeLedger unlinks a symlink at the path and leaves what it points to", () => {
    const real = join(TMP, "linked-target");
    mkdirSync(real);
    writeFileSync(join(real, "keep.jsonl"), "x");
    const link = dir();
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(real, link);
    removeLedger(link);
    expect(readFileSync(join(real, "keep.jsonl"), "utf8")).toBe("x");
    expect(() => statSync(link)).toThrow();
    removeLedger(link); // nothing there: no throw
  });

  test("removeLedger deletes every file and the directory", () => {
    const d = dir();
    write(openLedgerFile(d, { now: () => 1_791_000_000_000, pid: 5 }));
    removeLedger(d);
    expect(readLedger(d)).toEqual([]);
  });
});

describe("gluon cost-report (src/cost/report.ts)", () => {
  test("per harness and model, the audit and its causes, unknown models, the table's age", () => {
    const l = new Ledger();
    l.add(usage({ ownMicros: 137_171, harnessVersion: "2.1.289" }));
    l.add(usage({ ownMicros: 28_000, assumptions: [] }));
    l.add(usage({ harness: "codex", model: "gpt-6-luna", connection: "openai", ownMicros: 1_000, assumptions: ["service-tier-requested"] }));
    l.add(usage({ harness: "grok-build", model: "grok-9", connection: "xai", ownMicros: 0, assumptions: ["unknown-model"] }));
    l.add({ kind: "observation", t: 2, harness: "claude-code", scope: "request", reportedMicros: 137_171, ownMicros: 137_171, cause: "none" });
    l.add({ kind: "observation", t: 3, harness: "claude-code", scope: "request", reportedMicros: 220_000, ownMicros: 145_000, cause: "cache-ttl-1h" });
    const text = reportLines(l.entries, { now: Date.parse("2026-10-30T00:00:00Z"), tables: [{ source: "models.dev", updatedAt: "2026-10-04T08:57:09.103Z", version: null, digest: "3a1d9fce060e" }, { source: "claude-code binary", updatedAt: null, version: "2.1.289", digest: "990b7ce55305" }] }).join("\\n");
    expect(text).toContain("price table: models.dev of 2026-10-04 (25 days old: stale); priced 4 requests here");
    expect(text).toContain("price table: claude-code binary of version 2.1.289 (undated)");
    expect(text).toContain("claude-code claude-opus-4-6 (anthropic): 2 requests, $0.17 [2.1.289]; assumed: cache-ttl-assumed-5m");
    expect(text).toContain("codex gpt-6-luna (openai): 1 request, $0.0010; assumed: service-tier-requested");
    expect(text).toContain("audited against the harness's own figure, per request: 2 observations, 1 differ");
    expect(text).toContain("claude-code cache-ttl-1h: 1 observation, +$0.07 (the harness's figure minus ours)");
    expect(text).toContain("no price in the table for: grok-build grok-9");
  });
  test("an empty ledger says so, and where it would be", () => {
    expect(reportLines([], { dir: "/x" }).join("\\n")).toContain("no cost audit entries in /x yet");
  });

  test("BUG-354/report-scopes: turn and cumulative observations are aggregated beside the request ones, a causes table for each scope", () => {
    const l = new Ledger();
    l.add(usage());
    l.add({ kind: "observation", t: 2, harness: "codex", scope: "turn", reportedMicros: 500_000, ownMicros: 400_000, cause: "cached-input" });
    l.add({ kind: "observation", t: 3, harness: "codex", scope: "turn", reportedMicros: 100_000, ownMicros: 100_000, cause: "none" });
    l.add({ kind: "observation", t: 4, harness: "claude-code", scope: "cumulative", reportedMicros: 3_000_000, ownMicros: 2_000_000, cause: "subagent" });
    l.add({ kind: "observation", t: 5, harness: "claude-code", scope: "request", reportedMicros: 90_000, ownMicros: 90_000, cause: "none" });
    l.add({ kind: "observation", t: 6, harness: "opencode", scope: "cumulative", reportedMicros: 1_000 });
    const text = reportLines(l.entries).join("\n");
    expect(text).toContain("audited against the harness's own figure, per request: 1 observation, 0 differ");
    expect(text).toContain("per turn: 2 observations, 1 differ\n  codex cached-input: 1 observation, +$0.10 (the harness's figure minus ours)");
    expect(text).toContain("running total: 1 observation, 1 differ\n  claude-code subagent: 1 observation, +$1.00");
    expect(text).toContain("reported by a harness with no figure of ours to compare: 1 observation");
  });

  test("BUG-355/report-without-usage: context-only and dropped-only ledgers (Antigravity has no usage entries) still report; a one-sided reading is counted", () => {
    const l = new Ledger();
    l.add({ kind: "context", t: 1, harness: "antigravity", reportedPct: 40, reportedTokens: 400_000, reportedWindow: 1_000_000 });
    l.add({ kind: "context", t: 2, harness: "antigravity", ownPct: 30, ownTokens: 300_000, ownWindow: 1_000_000, reportedPct: 35, reportedTokens: 350_000, reportedWindow: 1_000_000, cause: "tokens" });
    l.add({ kind: "dropped", t: 3, harness: "antigravity", what: "cost", reason: "no-usage", count: 4 });
    const text = reportLines(l.entries, { tables: [{ source: "models.dev", updatedAt: null, version: null, digest: "a" }] }).join("\n");
    expect(text).not.toContain("no cost audit entries");
    expect(text).not.toContain("priced by Gluon");
    expect(text).toContain("context % audited against the harness's own: 1 reading, 1 differ by more than a point; 1 reading had only one side");
    expect(text).toContain("antigravity tokens: 1 reading (own 30% of 1000000, reported 35% of 1000000, on average)");
    expect(text).toContain("antigravity reported-only: 1 reading (reported 40% of 1000000, on average)");
    expect(text).toContain("antigravity cost: no-usage: 4");
    expect(text).toContain("price table: models.dev of undated");
  });

  test("BUG-360/table-age: the tables listed are the ones tables.ts exports metadata for (models.dev, Claude Code's catalog, Codex's windows and Grok's models today; a digest in `catalogDigest` or `digest`, a date in `catalogUpdatedAt` or `generatedAt`)", () => {
    const infos = tableInfos();
    expect(infos.map((t) => t.source)).toEqual(["claude-code binary", "codex debug models", "grok binary default_models.json", "models.dev"]);
    expect(infos.find((t) => t.source === "grok binary default_models.json")).toMatchObject({ version: GROK_MODELS.grokVersion, updatedAt: GROK_MODELS.generatedAt, digest: GROK_MODELS.digest });
    expect(infos.find((t) => t.source === "codex debug models")).toMatchObject({ version: CODEX_WINDOWS.codexVersion, updatedAt: CODEX_WINDOWS.generatedAt, digest: CODEX_WINDOWS.digest });
    expect(infos.find((t) => t.source === "models.dev")).toMatchObject({ updatedAt: MODELS_DEV.catalogUpdatedAt ?? MODELS_DEV.generatedAt, digest: MODELS_DEV.catalogDigest });
    expect(infos.find((t) => t.source === "models.dev")!.updatedAt).not.toBeNull();
    expect(infos.find((t) => t.source === "claude-code binary")).toMatchObject({ version: CLAUDE_CATALOG.claudeCodeVersion, updatedAt: null });
  });
});
