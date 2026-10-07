import { describe, expect, test } from "bun:test";
import { formatPeak, parseArgs, parsePeak, psQuote, STAGES, stageCommand, stageScript, syncPlan } from "../scripts/windows-test.ts";

describe("test:windows (scripts/windows-test.ts)", () => {
  test("no arguments run every stage; named stages run in CI's order", () => {
    expect(parseArgs([]).stages).toEqual([...STAGES]);
    expect(parseArgs(["e2e", "unit"]).stages).toEqual(["unit", "e2e"]);
  });

  test("perf is not a CI stage: it runs only when named, after the CI stages, and is the serial perf suite", () => {
    expect(STAGES as readonly string[]).not.toContain("perf");
    expect(parseArgs(["perf"]).stages).toEqual(["perf"]);
    expect(parseArgs(["perf", "unit"]).stages).toEqual(["unit", "perf"]);
    expect(stageCommand("perf").join("\n")).toMatch(/GLUON_PERF = '1'[\s\S]*--max-concurrency=1 \.\/test\/perf/);
  });

  test("a stage's script keeps the first failing exit code, stops the lines after it, and reports the peak file", () => {
    const script = stageScript(["a", "b"], "C:\\Users\\o'k\\repo", "C:\\bun", "C:\\t\\peak.txt");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\Users\\o''k\\repo'");
    expect(script).toContain("'C:\\t\\peak.txt'");
    expect(script).toContain("  a; if ($LASTEXITCODE -ne 0) { $rc = $LASTEXITCODE; break }\n  b; if");
    expect(script.endsWith("exit $rc")).toBe(true);
    expect(script.indexOf("do {")).toBeLessThan(script.indexOf("  a;"));
  });

  test("the peak is read from the sampler's file: bytes in, megabytes out, '?' when there is none", () => {
    expect(parsePeak("1073741824\r\n")).toBe(1073741824);
    expect(parsePeak("")).toBeUndefined();
    expect(parsePeak("junk")).toBeUndefined();
    expect(formatPeak(1073741824)).toBe("peak 1024 MB");
    expect(formatPeak(undefined)).toBe("peak ?");
  });

  test("-t runs install and then only the matching tests; no stages with it", () => {
    expect(parseArgs(["-t", "BUG-190"])).toEqual({ stages: ["install"], filter: "BUG-190", files: [] });
    expect(() => parseArgs(["-t"])).toThrow("needs a test-name pattern");
    expect(() => parseArgs(["-t", "x", "unit"])).toThrow("no stages");
    expect(() => parseArgs(["lint"])).toThrow('unknown stage "lint"');
  });

  test("-f runs only the named test files (under test/), e2e ones concurrently, the filter still a variable", () => {
    expect(parseArgs(["-f", "test\\tools.test.ts", "-f", "test/e2e/cli.e2e.test.ts", "-t", "H2"])).toEqual({ stages: ["install"], filter: "H2", files: ["test/tools.test.ts", "test/e2e/cli.e2e.test.ts"] });
    expect(() => parseArgs(["-f", "../x.ts"])).toThrow("path under test/");
    expect(() => parseArgs(["-f", "test/a.ts; rm x"])).toThrow("path under test/");
    expect(() => parseArgs(["-f"])).toThrow("needs a test file");
    expect(() => parseArgs(["-f", "test/a.test.ts", "unit"])).toThrow("no stages");
    expect(stageCommand("unit", undefined, ["test/a.test.ts"])).toEqual(["bun test 'test/a.test.ts'"]);
    // Perf files skip themselves without GLUON_PERF, and run one at a time.
    expect(stageCommand("unit", undefined, ["test/perf/a.perf.test.ts"])).toEqual(["$env:GLUON_PERF = '1'", "bun test --max-concurrency=1 'test/perf/a.perf.test.ts'"]);
    expect(stageCommand("unit", "x", ["test/e2e/a.e2e.test.ts"])[0]).toMatch(/^bun test --concurrent --max-concurrency=\d+ 'test\/e2e\/a\.e2e\.test\.ts' -t \$env:GLUON_WT_FILTER$/);
  });

  test("BUG-664/windows-test: -f with unit and e2e files together runs --concurrent on the e2e files only, perf files serially", () => {
    const lines = stageCommand("unit", undefined, ["test/a.test.ts", "test/e2e/b.e2e.test.ts"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("bun test 'test/a.test.ts'");
    expect(lines[1]).toMatch(/^bun test --concurrent --max-concurrency=\d+ 'test\/e2e\/b\.e2e\.test\.ts'$/);
    expect(stageCommand("unit", "x", ["test/e2e/b.e2e.test.ts", "test/a.test.ts", "test/perf/p.perf.test.ts"])).toEqual([
      "bun test 'test/a.test.ts' -t $env:GLUON_WT_FILTER",
      expect.stringMatching(/^bun test --concurrent --max-concurrency=\d+ 'test\/e2e\/b\.e2e\.test\.ts' -t \$env:GLUON_WT_FILTER$/),
      "$env:GLUON_PERF = '1'",
      "bun test --max-concurrency=1 'test/perf/p.perf.test.ts' -t $env:GLUON_WT_FILTER",
    ]);
  });

  test("the filter reaches PowerShell as a variable, never spliced into the command", () => {
    for (const line of stageCommand("unit", "a'; rm -r C:\\ #")) expect(line).toEndWith("-t $env:GLUON_WT_FILTER");
    expect(psQuote("it's")).toBe("'it''s'");
  });

  test("sync copies new and changed files and deletes the ones no longer listed", () => {
    const plan = syncPlan({ "a.ts": "1:1", "b.ts": "2:2", "gone.ts": "3:3" }, { "a.ts": "1:1", "b.ts": "2:9", "new.ts": "4:4" });
    expect(plan).toEqual({ copy: ["b.ts", "new.ts"], remove: ["gone.ts"] });
    expect(syncPlan({}, { "a.ts": "1:1" })).toEqual({ copy: ["a.ts"], remove: [] });
  });
});
