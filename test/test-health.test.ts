/**
 * `bun run test:health` (`scripts/test-health.ts`): its pure parts, and the repository's own bug-candidate titles,
 * which this test keeps well formed (one id per title, at its start, with a number).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./areas.ts";
import { ageDays, ago, baselineGaps, compareVersions, fixtureStatus, groupCandidates, ledgerSummary, parseVersion, render, scanCandidates, scanQuarantines, slowTests } from "../scripts/test-health.ts";
import { FULL_OVER_S, type TimesFile } from "../scripts/test-times.ts";

const scan = (text: string, path = "test/x.test.ts") => scanCandidates([{ path, text }]);

describe("ages and versions", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  test("ageDays counts whole days, never negative, null for junk", () => {
    expect(ageDays("2026-10-03T13:00:00Z", now)).toBe(2);
    expect(ageDays("2026-10-06T11:00:00Z", now)).toBe(0);
    expect(ageDays("2027-01-01T00:00:00Z", now)).toBe(0);
    expect(ageDays("", now)).toBeNull();
    expect(ageDays(undefined, now)).toBeNull();
    expect([ago(0), ago(1), ago(9), ago(null)]).toEqual(["today", "1 day ago", "9 days ago", "at an unknown date"]);
  });

  test("parseVersion reads the first line of a --version output like src/status.ts", () => {
    expect(parseVersion("2.1.292 (Claude Code)\n")).toBe("2.1.292");
    expect(parseVersion("codex-cli 0.160.0")).toBe("0.160.0");
    expect(parseVersion("grok 1.0.46 (2765805b9442) [stable]")).toBe("1.0.46");
    expect(parseVersion("opencode v2.0.21")).toBe("2.0.21");
    expect(parseVersion("\n\x1b[1m1.3.0\x1b[0m\nmore 9.9.9")).toBe("1.3.0");
    expect(parseVersion("2.0.0-beta.3")).toBe("2.0.0-beta.3");
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("no version here")).toBeNull();
  });

  test("compareVersions is numeric, part by part", () => {
    expect(compareVersions("0.160.0", "0.159.3")).toBe(1);
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  test("fixtureStatus: a match, a newer or older install, no fixtures", () => {
    expect(fixtureStatus("1.0.46", ["1.0.46"])).toBe("match");
    expect(fixtureStatus("2.1.292", ["2.1.286"])).toBe("installed-newer");
    expect(fixtureStatus("2.1.280", ["2.1.286", "2.1.270"])).toBe("installed-older");
    expect(fixtureStatus("2.1.270", ["2.1.286", "2.1.270"])).toBe("match");
    expect(fixtureStatus("1.0.0", [])).toBe("no-fixtures");
  });
});

describe("bug candidates", () => {
  test("a well formed title is listed with its id, file and line; MODEL-GAP too", () => {
    const r = scan('test.failing("BUG-CANDIDATE/QA-sec-01: a secret is refused", () => {});\n  test("MODEL-GAP/QA-gap-02: the model forgets", () => {});\n(QUICK ? test.skip : test.failing)("BUG-CANDIDATE/QA-perf-01: slow", async () => {});');
    expect(r.problems).toEqual([]);
    expect(r.candidates.map((c) => [c.marker, c.id, c.line])).toEqual([["BUG-CANDIDATE", "QA-sec-01", 1], ["MODEL-GAP", "QA-gap-02", 2], ["BUG-CANDIDATE", "QA-perf-01", 3]]);
  });

  test("a title on the line after the call, a letter suffix and an issue id all count", () => {
    const r = scan('test.failing(\n  "BUG-CANDIDATE/QA-resume-04b: x",\n  () => {});\ntest.failing(\'BUG-CANDIDATE/issue-40-stop-failure: y\', () => {});');
    expect(r.problems).toEqual([]);
    expect(r.candidates.map((c) => c.id)).toEqual(["QA-resume-04b", "issue-40-stop-failure"]);
  });

  test("comments, generated titles and the monkey's template are not candidates", () => {
    expect(scan('// test.failing("BUG-CANDIDATE/QA-x-01: no")\n * `test.failing("BUG-CANDIDATE/QA-frame-nn: …")`\n/* ("BUG-CANDIDATE/QA-y-02: no") */')).toEqual({ candidates: [], problems: [] });
    expect(scan("test(`BUG-CANDIDATE/${bug.id}: lint`, () => {});")).toEqual({ candidates: [], problems: [] });
    expect(scan('test("BUG-CANDIDATE/GM-…: x", () => {});', "test/e2e/gluon-monkey.ts")).toEqual({ candidates: [], problems: [] });
  });

  test("one id per title, at its start, with a number, and not on a describe; the same title twice is a duplicate", () => {
    const bad = (text: string) => scan(text).problems.map((p) => p.replace(/^[^ ]+ /, ""));
    expect(bad('test.failing("BUG-CANDIDATE/QA-a-01: x, and BUG-CANDIDATE/QA-b-02: y", () => {});')[0]).toContain("2 candidate ids");
    expect(bad('test.failing("QA: BUG-CANDIDATE/QA-a-01: x", () => {});')[0]).toContain("not at the start");
    expect(bad('test.failing("BUG-CANDIDATE/QA-resume: x", () => {});')[0]).toContain("not an id of the form");
    expect(bad('test.failing("BUG-CANDIDATE/QA-a-01 x", () => {});')[0]).toContain("not an id of the form");
    expect(bad('test.failing("BUG-CANDIDATE/: x", () => {});')[0]).toContain("no id after the marker");
    expect(bad('describe("BUG-CANDIDATE/QA-resume-01: group", () => {});')[0]).toContain("a describe carries");
    expect(bad('test.failing("BUG-CANDIDATE/QA-a-01: x", () => {});\ntest.failing("BUG-CANDIDATE/QA-a-01: x", () => {});')[0]).toContain("the same title twice");
    // one bug, several measurements: the same id on different titles is fine
    expect(bad('test.failing("BUG-CANDIDATE/QA-a-01: x", () => {});\ntest.failing("BUG-CANDIDATE/QA-a-01: y", () => {});')).toEqual([]);
  });

  test("groupCandidates counts the tests and files per id, in numeric order", () => {
    const a = scan('test.failing("BUG-CANDIDATE/QA-a-10: x", () => {});\ntest.failing("BUG-CANDIDATE/QA-a-2: x", () => {});\ntest.failing("BUG-CANDIDATE/QA-a-2: y", () => {});', "test/a.test.ts").candidates;
    const b = scan('test.failing("BUG-CANDIDATE/QA-a-2: z", () => {});', "test/b.test.ts").candidates;
    expect(groupCandidates([...a, ...b])).toEqual([
      { id: "QA-a-2", marker: "BUG-CANDIDATE", tests: 3, files: ["test/a.test.ts", "test/b.test.ts"] },
      { id: "QA-a-10", marker: "BUG-CANDIDATE", tests: 1, files: ["test/a.test.ts"] },
    ]);
  });

  test("every candidate test title in this repository is well formed, and starts with its id", () => {
    const files = [...new Bun.Glob("test/**/*.{ts,tsx}").scanSync({ cwd: ROOT })].filter((f) => !f.includes("node_modules")).map((path) => ({ path: path.replaceAll("\\", "/"), text: readFileSync(join(ROOT, path), "utf8") }));
    const { candidates, problems } = scanCandidates(files);
    expect(problems).toEqual([]);
    // The scan misses no file: every test file with a candidate title as a call's first argument is found (a fixed count broke as candidates were fixed; 0 open is the goal).
    // Comment lines don't count (a file's header may show the title's form), as in the scan.
    const code = (text: string) => text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const raw = files.filter((f) => !["test/e2e/gluon-monkey.ts", "test/test-health.test.ts"].includes(f.path) && /\(\s*["'`](BUG-CANDIDATE|MODEL-GAP)\/[A-Za-z0-9]/.test(code(f.text))).map((f) => f.path);
    expect([...new Set(candidates.map((c) => c.file))].sort()).toEqual(raw.sort());
    expect(candidates.every((c) => c.title.startsWith(`${c.marker}/${c.id}:`))).toBe(true);
  });
});

describe("quarantined tests", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const q = (title: string) => scanQuarantines([{ path: "test/x.test.ts", text: `test("${title}", () => {});` }], now);

  test("a quarantine names its bug and its end; a well-formed one inside its 30 days is listed, nothing broken", () => {
    expect(q("BUG-7/a: flaky @quarantine BUG-7 until:2026-10-20")).toEqual({ quarantined: [{ file: "test/x.test.ts", line: 1, title: "BUG-7/a: flaky @quarantine BUG-7 until:2026-10-20", bug: "BUG-7", until: "2026-10-20" }], problems: [] });
    expect(q("a test with no tag").quarantined).toEqual([]);
  });

  test("past its date, with no date or bug, or longer than 30 days: broken, with what to do", () => {
    expect(q("t @quarantine BUG-7 until:2026-10-08").problems).toEqual(["test/x.test.ts:1: BUG-7's quarantine ended 2026-10-08: fix the test (and drop the tag) or delete it"]);
    expect(q("t @quarantine BUG-7").problems[0]).toContain('"@quarantine BUG-nn until:YYYY-MM-DD"');
    expect(q("t @quarantine until:2026-10-20").problems[0]).toContain('"@quarantine BUG-nn until:YYYY-MM-DD"');
    expect(q("t @quarantine BUG-7 until:2026-12-31").problems).toEqual(["test/x.test.ts:1: BUG-7's quarantine runs to 2026-12-31, more than 30 days"]);
  });

  test("no quarantine in this repository is broken", () => {
    const files = [...new Bun.Glob("test/**/*.{ts,tsx}").scanSync({ cwd: ROOT })].filter((f) => !f.includes("node_modules")).map((path) => ({ path: path.replaceAll("\\", "/"), text: readFileSync(join(ROOT, path), "utf8") }));
    expect(scanQuarantines(files, new Date()).problems).toEqual([]);
  });
});

describe("the other checks", () => {
  test("slowTests lists non-@full tests over the threshold, slowest first, once per test across tiers", () => {
    const times: TimesFile = {
      version: 1, updated: "", cores: 1,
      tiers: {
        fast: { files: {}, tests: { "test/a.test.ts": { slow: 5, ok: 1.5, "heavy @full": 30 } } },
        full: { files: {}, tests: { "test/a.test.ts": { slow: 7 }, "test/e2e/b.e2e.test.ts": { other: FULL_OVER_S + 0.1, edge: FULL_OVER_S } } },
      },
    };
    expect(slowTests(times, FULL_OVER_S)).toEqual([
      { file: "test/a.test.ts", name: "slow", s: 7 },
      { file: "test/e2e/b.e2e.test.ts", name: "other", s: FULL_OVER_S + 0.1 },
    ]);
    expect(slowTests({ version: 1, updated: "", cores: 1, tiers: {} }, 3)).toEqual([]);
  });

  test("ledgerSummary prints dollars per bucket and the runs, and nothing else from the file", () => {
    expect(ledgerSummary({ caps: { bedrock: 30, other: 10 }, spent: { bedrock: 3.549346, other: 2.2, openrouter: 0.375 }, runs: [{ at: "2026-10-05T10:00:00Z", key: "sk-secret" }, { at: "2026-10-06T16:27:35.797Z", key: "sk-secret" }] }))
      .toBe("bedrock $3.55 of $30.00, other $2.20 of $10.00, openrouter $0.38 (2 runs, last 2026-10-06)");
    expect(ledgerSummary({ spent: { bedrock: 0 }, runs: [] })).toBe("bedrock $0.00 (0 runs)");
    expect(ledgerSummary({ spent: { other: "x" } })).toBe("other ? (0 runs)");
    expect(ledgerSummary(null)).toBeNull();
    expect(ledgerSummary({})).toBeNull();
    expect(ledgerSummary({ spent: { other: 1 }, runs: [{ at: "2026-10-06", apiKey: "sk-ant-123" }] })).not.toContain("sk-");
  });

  test("baselineGaps names the platforms without a baseline", () => {
    expect(baselineGaps({ linux: { a: 1 } })).toEqual(["darwin", "win32"]);
    expect(baselineGaps({ linux: { a: 1 }, darwin: { a: 1 }, win32: { a: 1 } })).toEqual([]);
  });

  test("render counts stale and broken lines and prints each action under its line", () => {
    const r = render([{ title: "T", lines: [{ level: "ok", text: "fine" }, { level: "stale", text: "old", action: "do this" }, { level: "BROKEN", text: "bad" }, { level: "info", text: "fyi" }] }]);
    expect([r.stale, r.broken]).toEqual([1, 1]);
    expect(r.text).toContain("stale  old\n         -> do this");
  });
});
