/**
 * The area manifest (`test/areas.ts`) stays complete: every `src/**` file and every unit / e2e test file
 * is in exactly one area, nothing it lists is gone, and `--changed`'s file → area mapping behaves.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AREAS, CORE, ROOT, e2eTestFiles, manifestProblems, matches, platformsOf, selectAreas, selectChanged, srcFiles, srcOwner, testOwner, unitTestFiles } from "./areas.ts";

const names = Object.keys(AREAS);

describe("the manifest is complete", () => {
  test("every src file belongs to exactly one area", () => {
    const owners = (f: string) => names.filter((a) => matches(AREAS[a]!.src, f));
    expect(srcFiles().filter((f) => owners(f).length === 0)).toEqual([]);
    expect(srcFiles().filter((f) => owners(f).length > 1).map((f) => `${f}: ${owners(f)}`)).toEqual([]);
  });

  test("every unit and e2e test file is listed in exactly one area", () => {
    const listed = (f: string) => names.filter((a) => AREAS[a]!.unit.includes(f) || AREAS[a]!.e2e.includes(f));
    const all = [...unitTestFiles(), ...e2eTestFiles()];
    expect(all.filter((f) => listed(f).length === 0)).toEqual([]);
    expect(all.filter((f) => listed(f).length > 1).map((f) => `${f}: ${listed(f)}`)).toEqual([]);
  });

  test("a unit list holds only unit files and an e2e list only e2e files", () => {
    for (const [a, x] of Object.entries(AREAS)) {
      expect(x.unit.filter((f) => !/^test\/[^/]+\.test\.tsx?$/.test(f)).map((f) => `${a}: ${f}`)).toEqual([]);
      expect(x.e2e.filter((f) => !/^test\/e2e\/[^/]+\.e2e\.test\.ts$/.test(f)).map((f) => `${a}: ${f}`)).toEqual([]);
    }
  });

  test("every listed path exists (a glob must match something, unless the area is optional)", () => {
    const missing: string[] = [];
    for (const [a, x] of Object.entries(AREAS)) {
      for (const f of [...x.unit, ...x.e2e, ...Object.values(x.hooks ?? {}).flatMap((h) => h.files)]) if (!existsSync(join(ROOT, f))) missing.push(`${a}: ${f}`);
      if (x.optional) continue;
      for (const g of [...x.src, ...(x.files ?? []), ...(x.e2eOnly ?? []), ...Object.keys(x.unmeasured ?? {})].filter((g) => !g.startsWith("!"))) {
        if ([...new Bun.Glob(g).scanSync({ cwd: ROOT, dot: true })].length === 0) missing.push(`${a}: ${g}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the e2e-only and unmeasured src files are in their area", () => {
    for (const [a, x] of Object.entries(AREAS)) {
      for (const g of [...(x.e2eOnly ?? []), ...Object.keys(x.unmeasured ?? {})]) for (const f of new Bun.Glob(g).scanSync({ cwd: ROOT })) expect(`${a}: ${f}: ${srcOwner(f)}`).toBe(`${a}: ${f}: ${a}`);
    }
  });

  test("manifestProblems() (what `bun run test:health` prints) is empty", () => {
    expect(manifestProblems()).toEqual([]);
  });

  test("every CORE file exists", () => {
    expect(CORE.filter((f) => !existsSync(join(ROOT, f)))).toEqual([]);
  });
});

describe("--changed: files to areas", () => {
  test("a source file selects its area's tests only", () => {
    const s = selectChanged(["src/stats.ts"]);
    expect(s.kind).toBe("areas");
    if (s.kind !== "areas") return;
    expect(s.areas).toEqual(["analytics-stats"]);
    expect(s.unit).toContain("test/stats.test.ts");
    expect(s.e2e).toContain("test/e2e/analytics.e2e.test.ts");
  });

  test("a core file, an unknown src file and an unclassified file mean the fast tier", () => {
    expect(selectChanged(["src/config.ts"]).kind).toBe("fast");
    expect(selectChanged(["src/not-in-any-area.ts"]).kind).toBe("fast");
    expect(selectChanged(["something/new.bin"]).kind).toBe("fast");
    expect(selectChanged(["src/stats.ts", "package.json"]).kind).toBe("fast");
  });

  test("a changed test file is included itself, and its area's other tests are not", () => {
    const s = selectChanged(["test/stats.test.ts"]);
    expect(s.kind === "areas" && s.unit).toEqual(["test/stats.test.ts"]);
    expect(s.kind === "areas" && s.areas).toEqual([]);
    expect(selectChanged(["test/brand-new.test.ts"]).kind).toBe("fast");
  });

  test("docs alone mean the docs tests; a hook's file names the hook", () => {
    const d = selectChanged(["docs/guides/x.mdx", "README.md", "src/agent/AGENTS.md"]);
    expect(d.kind === "areas" && d.areas).toEqual(["docs"]);
    const v = selectChanged(["test/visual/scenes.visual.test.ts"]);
    expect(v.kind === "areas" && v.hooks.map((h) => h.name)).toContain("visual");
  });

  test("nothing a test reads means nothing runs", () => {
    expect(selectChanged(["qa/findings/x.md", "qa/y.ts"]).kind).toBe("none");
    expect(selectChanged([]).kind).toBe("none");
  });

  test("test-ownership agrees with the lists", () => {
    expect(testOwner("test/e2e/resume.e2e.test.ts")).toBe("resume-workspaces");
    expect(selectAreas(["perf"]).hooks.map((h) => h.cmd)).toEqual(["bun run test:perf"]);
  });
});

describe("--changed: the OSes a pull request needs (CI's plan job)", () => {
  test("Linux alone when every touched area says so; a docs-only change too; a test file counts as its area", () => {
    expect(platformsOf(selectChanged(["docs/concepts/architecture.md"]))).toBe("linux");
    expect(platformsOf(selectChanged(["src/routing.ts", "docs/concepts/architecture.md"]))).toBe("linux");
    expect(platformsOf(selectChanged(["test/route.test.ts"]))).toBe("linux");
    expect(platformsOf(selectChanged([]))).toBe("linux");
  });

  test("every OS for an area that runs processes, paths or a terminal, for one of several areas, and for the whole tier", () => {
    expect(platformsOf(selectChanged(["src/pty/session.ts"]))).toBe("all");
    expect(platformsOf(selectChanged(["src/routing.ts", "src/pty/session.ts"]))).toBe("all");
    // The brain starts `codex app-server`: a process, so every OS.
    expect(platformsOf(selectChanged(["src/agent/codex.ts"]))).toBe("all");
    expect(platformsOf(selectChanged(["test/e2e/auth.e2e.test.ts"]))).toBe("all");
    expect(platformsOf(selectChanged(["bun.lock"]))).toBe("all");
    expect(platformsOf(selectChanged(["somewhere/unknown.txt"]))).toBe("all");
  });

  test("only areas with no process, path or terminal of their own are Linux-only", () => {
    expect(Object.keys(AREAS).filter((a) => AREAS[a]!.platforms === "linux").sort()).toEqual(["docs", "routing"]);
  });
});
