/**
 * The pages an outsider reads (`CONTRIBUTING.md`, `docs/contributing/maintenance.md`, `SECURITY.md`) say only what
 * an outside contributor can act on. Bug and issue numbers, paid-run budgets, dev-machine specs and dated status
 * go in `docs/contributing/internal.md` (unpublished). Line budgets force a cut or a move before a page bloats.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const SCRIPTS = Object.keys(JSON.parse(read("package.json")).scripts);

/** Page → line budget. Over it: cut, or move maintainer-only detail to internal.md (and keep internal.md under its own). */
const PAGES = { "CONTRIBUTING.md": 115, "docs/contributing/maintenance.md": 100, "SECURITY.md": 85 } as const;
const INTERNAL = { "docs/contributing/internal.md": 180 } as const;

/** What an outsider can't see or use. */
const INTERNAL_MARKERS: [string, RegExp][] = [
  ["a bug id (BUG-nn, BUG-CANDIDATE)", /\bBUG-(\d|CANDIDATE)/],
  ["an issue or PR number", /(?:\b[Ii]ssue|\bPR) #\d+|\(#\d+\)|(?<![\w&])#\d{2,}\b/],
  ["a QA-campaign id", /\bQA-[a-z]+-\d/],
  ["a dev-machine spec", /WSL dev|\d+-core|dev machine/i],
  ["a paid-run budget", /live-spend|\$\d+(\.\d+)?\s*(≤|total|cap)|(≤|cap)\s*\$\d/i],
  ["a dated status note", /\bas of 20\d\d-\d\d|\b20\d\d-\d\d-\d\d\b/],
];

const strip = (md: string) => md.replace(/<!--[\s\S]*?-->/g, "");
const spans = (md: string) => strip(md).replace(/^```[\s\S]*?^```/gm, "").match(/`[^`\n]+`/g)?.map((s) => s.slice(1, -1)) ?? [];
const isRepoPath = (s: string) => /^(?:src|docs|scripts|test|site|\.github)\/[\w.\-/]*[\w]$/.test(s) && !/[*<>]/.test(s);

describe.each(Object.entries(PAGES))("%s", (file, budget) => {
  const md = read(file);

  test.each(INTERNAL_MARKERS)("has no %s (maintainer detail goes in docs/contributing/internal.md)", (_what, re) => {
    expect(strip(md).split("\n").filter((l) => re.test(l))).toEqual([]);
  });

  test("every `bun run` script it names is in package.json", () => {
    const runs = [...strip(md).matchAll(/bun run ([\w:-]+)/g)].map((m) => m[1]!);
    expect(runs.filter((r) => !SCRIPTS.includes(r))).toEqual([]);
  });

  test("every repo file it names exists", () => {
    const missing = spans(md).filter(isRepoPath).filter((p) => !existsSync(join(ROOT, p)) && !existsSync(join(ROOT, dirname(file), p)));
    expect(missing).toEqual([]);
  });

  test(`stays within ${budget} lines`, () => {
    expect(md.split("\n").length).toBeLessThanOrEqual(budget);
  });
});

describe.each(Object.entries(INTERNAL))("%s", (file, budget) => {
  const md = read(file);
  test("every `bun run` script it names is in package.json", () => {
    const runs = [...strip(md).matchAll(/bun run ([\w:-]+)/g)].map((m) => m[1]!);
    expect(runs.filter((r) => !SCRIPTS.includes(r))).toEqual([]);
  });
  test(`stays within ${budget} lines (cut what is done or moot)`, () => {
    expect(md.split("\n").length).toBeLessThanOrEqual(budget);
  });
});
