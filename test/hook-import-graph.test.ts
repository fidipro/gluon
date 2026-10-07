/**
 * `gluon hook` / `gluon signal` run inside a launched agent on every tool call or status change, so
 * they must stay fast to load (issue #39): nothing under `src/cost/` and not `src/models.ts` (about
 * 1 MB of JSON price tables) may be reachable from `src/internal.ts` by an import, static or dynamic
 * with a literal path. `src/AGENTS.md` and `src/cost/AGENTS.md` state the rule; this test enforces it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
/** What `src/cli.tsx` loads for `gluon signal` and `gluon hook`, before anything else. */
const ENTRY = join(ROOT, "src/internal.ts");

/** A path relative to `from`, with forward slashes (as the specifiers and the rules are written), also on Windows. */
const rel = (from: string, f: string) => relative(from, f).replaceAll("\\", "/");

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/** The file a relative specifier names from `from`: as written, with `.ts`/`.tsx`, `.js` for `.ts`, or an `index`. Bare and `node:`/`bun:` specifiers are not Gluon's files. */
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, ".ts"), base.replace(/\.jsx?$/, ".tsx"), join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find(isFile) ?? null;
}

/**
 * Every file reachable from `entry` through `import … from`, `export … from`, side-effect imports and
 * `import("literal")` (Bun's scanner: it skips `import type` and a comment or string that only looks
 * like an import). Returns file → the file that first reached it, for the failure message.
 */
function reachable(entry: string): Map<string, string | null> {
  const seen = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (!/\.tsx?$/.test(file)) continue;
    const scanner = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" });
    for (const { path } of scanner.scanImports(readFileSync(file, "utf8"))) {
      const next = resolveImport(file, path);
      if (!next || seen.has(next)) continue;
      seen.set(next, file);
      queue.push(next);
    }
  }
  return seen;
}

/** `a → b → c`: how the entry reaches a file. */
const chain = (seen: Map<string, string | null>, file: string) => {
  const out: string[] = [];
  for (let f: string | null | undefined = file; f; f = seen.get(f)) out.unshift(rel(ROOT, f));
  return out.join(" → ");
};

describe("the import walker", () => {
  const tmp = (name: string) => join(import.meta.dir, "fixtures", "hook-graph", name);
  test("follows static, re-export and literal dynamic imports; ignores type-only ones, bare specifiers and comments", () => {
    const seen = reachable(tmp("entry.ts"));
    const names = [...seen.keys()].map((f) => rel(tmp(""), f)).sort();
    expect(names).toEqual(["a.ts", "dyn.ts", "entry.ts", "idx/index.ts", "re.ts", "tsx.tsx"]);
  });
});

describe("gluon hook / gluon signal stay light", () => {
  test("BUG-358/hook-graph: nothing under src/cost/ and not src/models.ts is reachable from src/internal.ts", () => {
    const seen = reachable(ENTRY);
    // The walker found the graph at all (through the dynamic import of the adapters).
    for (const f of ["src/events.ts", "src/adapters/index.ts", "src/adapters/claude-code.ts"]) expect(seen.has(join(ROOT, f))).toBe(true);
    const heavy = [...seen.keys()].filter((f) => rel(ROOT, f).startsWith("src/cost/") || rel(ROOT, f) === "src/models.ts");
    expect(heavy.map((f) => chain(seen, f))).toEqual([]);
  });
});
