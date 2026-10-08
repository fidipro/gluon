/** The pure parts of `bun run test:value` (scripts/test-value.ts): where it mutates, how, and what its kills mean. */
import { describe, expect, test } from "bun:test";
import { applyMutant, junitCases, killTable, mutationSites, sample } from "../scripts/test-value.ts";

describe("test:value", () => {
  test("the mutation sites: a deciding operator flipped, a `!` dropped, a boolean swapped; nothing in a type", () => {
    const src = "type T = A | B;\nexport const f = (a: number, b: boolean): boolean => a < 3 && !b ? true : a === 1;\n";
    const ms = mutationSites(src, "src/x.ts");
    expect(ms.map((m) => `${m.line} ${m.from}→${m.to}`)).toEqual(["2 &&→||", "2 <→<=", "2 !→", "2 true→false", "2 ===→!=="]);
    expect(applyMutant(src, ms[0]!)).toContain("a < 3 || !b");
    expect(applyMutant(src, ms[2]!)).toContain("&& b ?");
  });

  test("the sample is the same for the same seed, and everything when there are fewer sites than asked", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    expect(sample(xs, 5, 7)).toEqual(sample(xs, 5, 7));
    expect(sample(xs, 5, 7)).not.toEqual(sample(xs, 5, 8));
    expect(sample([1, 2], 5, 1)).toEqual([1, 2]);
  });

  test("a test's kills, and its unique kills (a mutant only it caught)", () => {
    const kills = [new Set(["a", "b"]), new Set(["a"]), new Set<string>(), new Set(["c"])];
    expect(killTable(kills, ["a", "b", "c", "d"])).toEqual([
      { test: "a", kills: 2, unique: 1 },
      { test: "b", kills: 1, unique: 0 },
      { test: "c", kills: 1, unique: 1 },
      { test: "d", kills: 0, unique: 0 },
    ]);
  });

  test("Bun's JUnit report: each test's full name, seconds, and failure", () => {
    const xml = '<testcase name="t &amp; u" classname="grp" file="test/a.test.ts" time="0.5"><failure /></testcase><testcase name="v" classname="" file="test/a.test.ts" time="0.1" />';
    expect(junitCases(xml)).toEqual([
      { name: "test/a.test.ts › grp › t & u", s: 0.5, failed: true },
      { name: "test/a.test.ts › v", s: 0.1, failed: false },
    ]);
  });
});
