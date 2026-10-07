/**
 * README.md is the landing page: short, links that resolve, the two sections readers look for.
 * Detail belongs in docs/ (the "Markdown files" rules in the root AGENTS.md).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const MAX_LINES = 104;

describe("README.md is a landing page", () => {
  test(`at most ${MAX_LINES} lines`, () => {
    const lines = readme.replace(/\n$/, "").split("\n").length;
    expect(lines, `README.md has ${lines} lines (limit ${MAX_LINES}): move detail into docs/ and link it`).toBeLessThanOrEqual(MAX_LINES);
  });

  test("every relative link resolves to an existing file", () => {
    const text = readme.replace(/^```[\s\S]*?^```/gm, "").replace(/<!--[\s\S]*?-->/g, "");
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!).concat([...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!));
    const relative = targets.filter((t) => !/^([a-z][a-z0-9+.-]*:|#)/i.test(t)).map((t) => t.split("#")[0]!);
    expect(relative.length).toBeGreaterThan(0);
    for (const t of relative) expect(existsSync(join(ROOT, t)), `README.md links ${t}, which doesn't exist`).toBe(true);
  });

  test("has the Quickstart and Docs sections", () => {
    expect(readme).toMatch(/^## Quickstart$/m);
    expect(readme).toMatch(/^## Docs$/m);
  });
});
