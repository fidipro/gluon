/**
 * Gluon's import graph, statically: which files a file reaches through its imports. `bun run verify` and `--changed` use it to
 * find the tests that import a changed `src/` file (`testsReaching`); `test/hook-import-graph.test.ts` uses `reachable` to keep
 * the hook path light (issue #39).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/** The file a relative specifier names from `from`: as written, with `.ts`/`.tsx`, `.js` for `.ts`, or an `index`. Bare and `node:`/`bun:` specifiers are not Gluon's files. */
export function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, base.replace(/\.js$/, ".ts"), base.replace(/\.jsx?$/, ".tsx"), join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find(isFile) ?? null;
}

const scanned = new Map<string, string[]>();
/** A file's own imports, resolved (cached for the process: the tree doesn't change during a run). */
function importsOf(file: string): string[] {
  let out = scanned.get(file);
  if (!out) {
    const scanner = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" });
    // A script's shebang line isn't TypeScript: the scanner gets the rest.
    out = scanner.scanImports(readFileSync(file, "utf8").replace(/^#!.*/, "")).flatMap(({ path }) => resolveImport(file, path) ?? []);
    scanned.set(file, out);
  }
  return out;
}

/**
 * Every file reachable from `entry` through `import … from`, `export … from`, side-effect imports and
 * `import("literal")` (Bun's scanner: it skips `import type` and a comment or string that only looks
 * like an import). Returns file → the file that first reached it, for a failure message.
 */
export function reachable(entry: string): Map<string, string | null> {
  const seen = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (!/\.tsx?$/.test(file)) continue;
    for (const next of importsOf(file)) {
      if (seen.has(next)) continue;
      seen.set(next, file);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * The tests (paths from `root`) that reach one of the `changed` files through their imports, directly or through a fixture or
 * another `src/` file. A test that only spawns Gluon (an end-to-end scenario) reaches little this way: its area's list covers it.
 */
export function testsReaching(changed: string[], tests: string[], root: string): string[] {
  const want = new Set(changed.map((f) => resolve(root, f)));
  if (!want.size) return [];
  return tests.filter((t) => [...reachable(resolve(root, t)).keys()].some((f) => want.has(f))).map((t) => relative(root, resolve(root, t)).replaceAll("\\", "/"));
}
