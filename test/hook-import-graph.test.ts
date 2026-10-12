/**
 * `gluon hook` / `gluon signal` run inside a launched agent on every tool call or status change, so
 * they must stay fast to load (issue #39): nothing under `src/cost/` and not `src/models.ts` (about
 * 1 MB of JSON price tables) may be reachable from `src/internal.ts` by an import, static or dynamic
 * with a literal path. `src/AGENTS.md` and `src/cost/AGENTS.md` state the rule; this test enforces it.
 */
import { describe, expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";
import { reachable } from "../scripts/import-graph.ts";

const ROOT = resolve(import.meta.dir, "..");
/** What `src/cli.tsx` loads for `gluon signal` and `gluon hook`, before anything else. */
const ENTRY = join(ROOT, "src/internal.ts");

/** A path relative to `from`, with forward slashes (as the specifiers and the rules are written), also on Windows. */
const rel = (from: string, f: string) => relative(from, f).replaceAll("\\", "/");

/** `a → b → c`: how the entry reaches a file. */
const chain = (seen: Map<string, string | null>, file: string) => {
  const out: string[] = [];
  for (let f: string | null | undefined = file; f; f = seen.get(f)) out.unshift(rel(ROOT, f));
  return out.join(" → ");
};

describe("the import walker", () => {
  const tmp = (name: string) => join(import.meta.dir, "fixtures", "hook-graph", name);
  test("perf/hook-light: the import walker follows static, re-export and literal dynamic imports; ignores type-only ones, bare specifiers and comments", () => {
    const seen = reachable(tmp("entry.ts"));
    const names = [...seen.keys()].map((f) => rel(tmp(""), f)).sort();
    expect(names).toEqual(["a.ts", "dyn.ts", "entry.ts", "idx/index.ts", "re.ts", "tsx.tsx"]);
  });
});

describe("gluon hook / gluon signal stay light", () => {
  test("perf/hook-light: nothing under src/cost/ and not src/models.ts is reachable from src/internal.ts #BUG-358/hook-graph", () => {
    const seen = reachable(ENTRY);
    // The walker found the graph at all (through the dynamic import of the adapters).
    for (const f of ["src/events.ts", "src/adapters/index.ts", "src/adapters/claude-code.ts"]) expect(seen.has(join(ROOT, f))).toBe(true);
    const heavy = [...seen.keys()].filter((f) => rel(ROOT, f).startsWith("src/cost/") || rel(ROOT, f) === "src/models.ts");
    expect(heavy.map((f) => chain(seen, f))).toEqual([]);
  });
});
