/**
 * The catalog (`test/catalog.ts`) and the seams (`test/seams.ts`), held against the tests: every entry is tested, every
 * test names a known entry, and a test below the surface reaches `src/` only through a seam. The tests that don't yet are a
 * ratchet: `test/catalog.baseline.json` holds them per file, and a count may only go down. When yours went down:
 *   GLUON_CATALOG_UPDATE=1 bun test test/catalog.test.ts
 * (it never raises one: a new test names its entry, and imports only seams).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./areas.ts";
import { CATALOG, ENTRIES, entryOf, layersOf, testTitles } from "./catalog.ts";
import { pastSeams, REPO_TESTS, SEAMS } from "./seams.ts";

type Baseline = { untagged: Record<string, number>; pastSeams: Record<string, string[]> };
const BASELINE = join(ROOT, "test", "catalog.baseline.json");
const LOWER = "lower the baseline: GLUON_CATALOG_UPDATE=1 bun test test/catalog.test.ts";

const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const scan = (g: string) => [...new Bun.Glob(g).scanSync({ cwd: ROOT })].map((f) => f.replaceAll("\\", "/"));
const FILES = ["test/*.test.ts", "test/*.test.tsx", "test/e2e/*.e2e.test.ts", "test/real/*.test.ts", "test/perf/*.perf.test.ts"].flatMap(scan).filter((f) => !REPO_TESTS.includes(f)).sort();
const UNIT = FILES.filter((f) => /^test\/[^/]+$/.test(f));

/** A title's entry when its feature is in the catalog (`update/e2e: …` names no feature yet: an untagged test). */
const named = (t: string) => {
  const id = entryOf(t);
  return id && id.split("/")[0]! in CATALOG ? id : undefined;
};
const tests = FILES.flatMap((file) => testTitles(read(file)).map((title) => ({ file, title, id: named(title) })));

/** An open bug candidate names no entry until a maintainer triages it (`bun run test:health` lists them; test/test-health.test.ts keeps its id first). */
const CANDIDATE = /^(BUG-CANDIDATE|MODEL-GAP)\//;

function current(): Baseline {
  const untagged: Record<string, number> = {};
  for (const t of tests) if (!t.id && !CANDIDATE.test(t.title)) untagged[t.file] = (untagged[t.file] ?? 0) + 1;
  const past: Record<string, string[]> = {};
  for (const f of UNIT) {
    const p = pastSeams(f, read(f));
    if (p.length) past[f] = p;
  }
  return { untagged, pastSeams: past };
}

const now = current();
const base = JSON.parse(read("test/catalog.baseline.json")) as Baseline;
if (process.env.GLUON_CATALOG_UPDATE) {
  // Lower only: a count over the baseline stays a failure.
  const untagged = Object.fromEntries(Object.entries(base.untagged).map(([f, n]) => [f, Math.min(n, now.untagged[f] ?? 0)]).filter(([, n]) => (n as number) > 0));
  const past = Object.fromEntries(Object.entries(base.pastSeams).map(([f, ms]) => [f, ms.filter((m) => now.pastSeams[f]?.includes(m))]).filter(([, ms]) => (ms as string[]).length));
  Object.assign(base, { untagged, pastSeams: past });
  writeFileSync(BASELINE, `${JSON.stringify(base, null, 1)}\n`);
}

describe("the catalog", () => {
  test("every entry is tested: a test whose title starts with its id", () => {
    const tested = new Set(tests.map((t) => t.id));
    expect([...ENTRIES.keys()].filter((id) => !tested.has(id)).map((id) => `${id}: no test names it; write one at its layer (${ENTRIES.get(id)!.at.join(" or ")}) titled "${id}: …"`)).toEqual([]);
  });

  test("a test names an entry the catalog has, and runs at that entry's layer", () => {
    const bad = tests.flatMap(({ file, title, id }) => {
      if (!id) return [];
      const e = ENTRIES.get(id);
      if (!e) return [`${file}: "${title.slice(0, 80)}" names ${id}, which test/catalog.ts doesn't have`];
      return layersOf(file).some((l) => e.at.includes(l)) ? [] : [`${file}: ${id} is tested at ${e.at.join(" or ")}, not here`];
    });
    expect(bad).toEqual([]);
  });

  test("ids are kebab-case and every entry says what holds", () => {
    const bad = [...ENTRIES].filter(([id, e]) => !/^[a-z][a-z0-9-]*\/[a-z0-9-]+$/.test(id) || e.says.length < 20 || !e.at.length).map(([id]) => id);
    expect(bad).toEqual([]);
  });
});

describe("the ratchet (test/catalog.baseline.json only goes down)", () => {
  test("a test names its entry: `feature/entry: what holds` (test/catalog.ts)", () => {
    const over: string[] = [];
    const under: string[] = [];
    for (const f of new Set([...Object.keys(now.untagged), ...Object.keys(base.untagged)])) {
      const n = now.untagged[f] ?? 0;
      const was = base.untagged[f] ?? 0;
      if (n > was) over.push(`${f}: ${n} tests name no entry, the baseline allows ${was}: start the new test's title with its entry's id (add the entry to test/catalog.ts if none fits)`);
      if (n < was) under.push(`${f}: ${n} tests name no entry, the baseline still says ${was}: ${LOWER}`);
    }
    expect(over).toEqual([]);
    expect(under).toEqual([]);
  });

  test("a test below the surface imports from src/ only a seam (test/seams.ts); anything else is tested end to end", () => {
    const over: string[] = [];
    const under: string[] = [];
    for (const f of new Set([...Object.keys(now.pastSeams), ...Object.keys(base.pastSeams)])) {
      const have = now.pastSeams[f] ?? [];
      const had = base.pastSeams[f] ?? [];
      const fresh = have.filter((m) => !had.includes(m));
      if (fresh.length) over.push(`${f} imports ${fresh.join(", ")}: not a seam; test it through a seam (${Object.keys(SEAMS).join(", ")}) or end to end`);
      if (had.some((m) => !have.includes(m))) under.push(`${f} no longer imports ${had.filter((m) => !have.includes(m)).join(", ")}: ${LOWER}`);
    }
    expect(over).toEqual([]);
    expect(under).toEqual([]);
  });
});

describe("the checks' own cases", () => {
  test("titles: any modifier, a conditional test, a built title cut at its first `${`; not a describe, nor `re.test(…)`", () => {
    // One line with its expect: the samples switch tests off on purpose, and scripts/test-guard.ts skips an assertion's line.
    expect(testTitles(['test("a/b: one", () => {});', 'test.skipIf(WIN)("a/c: two", () => {});', '(QUICK ? test.skip : test)("three", () => {});', "it.concurrent(`a/d: ${x} four`, () => {});", 'describe("not a test", () => {});', "ONLY.test(`not ${a} test`);"].join("\n"))).toEqual(["a/b: one", "a/c: two", "three", "a/d: "]);
    expect(["a/b: one", "BUG-1/x: no", "Feature/x: no", "three"].map(entryOf)).toEqual(["a/b", undefined, undefined, undefined]);
  });

  test("past the seams: value imports of src/ modules that aren't seams; type-only, seam and support imports are fine", () => {
    const text = ['import type { A } from "../src/a.ts";', 'import { type B } from "../src/b.ts";', 'import { route } from "../src/routing.ts";', 'import { HARNESSES } from "../src/harnesses.ts";', 'import { x } from "../src/gluon.ts";', 'import { y } from "./fixtures/z.ts";'].join("\n");
    expect(pastSeams("test/x.test.ts", text)).toEqual(["src/gluon.ts"]);
  });
});
