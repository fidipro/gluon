/** The pure parts of CI's `red-check` (scripts/red-check.ts) and `test-guard` (scripts/test-guard.ts). */
import { describe, expect, test } from "bun:test";
import { addedBugTests, passedTitles, titlePattern } from "../scripts/red-check.ts";
import { titles, weakened } from "../scripts/test-guard.ts";

const diff = (file: string, lines: string[]) => [`--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", ...lines].join("\n");

describe("red-check: a new bug's test must fail without its fix", () => {
  test("the bug tests a diff adds: plain titles under test/, any test modifier; not a built title, not a source file", () => {
    const d = [
      diff("test/a.test.ts", ['+test("BUG-12/case: it works", () => {});', '+  test.skipIf(WIN)("BUG-13: another", async () => {});', "+test(`BUG-14/${x}: built`, () => {});", '+test("A12: not a bug", () => {});', '-test("BUG-15: removed", () => {});']),
      diff("src/a.ts", ['+test("BUG-16: not a test file", () => {});']),
    ].join("\n");
    expect(addedBugTests(d)).toEqual([
      { file: "test/a.test.ts", title: "BUG-12/case: it works" },
      { file: "test/a.test.ts", title: "BUG-13: another" },
    ]);
  });

  test("the -t pattern selects exactly those titles, their regex characters escaped", () => {
    const re = new RegExp(titlePattern(["BUG-1: a (b) [c]", "BUG-2: x.y"]));
    expect(["describe BUG-1: a (b) [c]", "BUG-2: x.y", "BUG-2: xzy", "BUG-1: a (b) [c] and more"].map((t) => re.test(t))).toEqual([true, true, false, false]);
  });

  test("from Bun's JUnit report, only the tests that passed", () => {
    const xml = '<testcase name="BUG-1: ok &amp; fine" /><testcase name="BUG-2: no"><failure type="x" /></testcase><testcase name="BUG-3: skip"><skipped /></testcase>';
    expect([...passedTitles(xml)]).toEqual(["BUG-1: ok & fine"]);
  });
});

describe("test-guard: weakening a test needs a person's review", () => {
  const before = (o: Record<string, string>) => titles(o);

  test("an assertion removed is found; one edited in place (same subject, same matcher) or moved is not", () => {
    const d = diff("test/a.test.ts", ["-  expect(x).toBe(1);", "-  expect(Date.now() - t0).toBeLessThan(1500);", "+  expect(Date.now() - t0).toBeLessThan(1500 * SLOW);", "-  expect(y).toEqual([1]);", "+    expect(y).toEqual([1]);", "-  expect(z).toBe(2);", "+  expect(z).toBeTruthy();"]);
    expect(weakened(d, new Map(), new Map()).map((f) => `${f.kind}: ${f.text}`)).toEqual(["assertion removed: expect(x).toBe(1);", "assertion removed: expect(z).toBe(2);"]);
  });

  test("a test switched off or out is found once per marker and file; a line edited that keeps its @full is not; a sample in an assertion is not", () => {
    const d = diff("test/a.test.ts", ['+test.skip("x", () => {});', '-test("y", () => {});', '+test("y @full", () => {});', '-test("z @full: old", () => {});', '+test("z @full: new", () => {});', '+  expect(q("t @quarantine BUG-7")).toBe(1);']);
    expect(weakened(d, new Map(), new Map()).map((f) => f.text.split(" (")[0])).toEqual([".skip ×1", "@full ×1"]);
  });

  test("a test gone is found; one renamed or split while its bug is still tested in that file is not", () => {
    const was = before({ "test/a.test.ts": 'test("BUG-1: a", () => {}); test("plain one", () => {});' });
    const now = before({ "test/a.test.ts": 'test("BUG-1/x: a, split", () => {});' });
    expect(weakened("", was, now)).toEqual([{ kind: "test gone", file: "test/a.test.ts", text: "plain one" }]);
  });
});
