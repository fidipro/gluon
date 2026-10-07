/**
 * The Markdown policy ("Markdown files" in the root AGENTS.md): every tracked .md/.mdx says how it is
 * kept fresh and is linked from somewhere; the AGENTS.md files name only files, symbols and
 * `bun run` scripts that exist.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
/** Not the repo's: `.claude` holds local settings and coding agents' throwaway worktrees (whole copies of the repo, BUG-163). */
const SKIP_DIRS = new Set([".git", ".claude", "node_modules", "reference", "dist", "qa", "runs", ".astro"]);
const CODE = /\.(tsx?|m?js|json|toml|sh|ps1|ya?ml|py|txt)$|^Dockerfile/;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    if (SKIP_DIRS.has(f)) return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const FILES = walk(ROOT);
const rel = (p: string) => p.slice(ROOT.length + 1).replaceAll("\\", "/");
const AGENTS = FILES.filter((p) => basename(p) === "AGENTS.md");
const NAMES = new Set(FILES.flatMap((p) => [basename(p), ...rel(p).split("/").slice(0, -1)]));
/** The code a name must appear in: not the docs, which could repeat a stale name. */
const CORPUS = FILES.filter((p) => CODE.test(basename(p))).map((p) => readFileSync(p, "utf8")).join("\n");
/** Tracked Markdown only (`.mdx` too: the docs site's pages): the walk also sees gitignored notes. */
const MARKDOWN = Bun.spawnSync(["git", "ls-files", "*.md", "*.mdx"], { cwd: ROOT, env: process.env, stdout: "pipe" }).stdout.toString().split("\n").filter(Boolean);
/** Entry points readers find on their own (GitHub shows them; agents load AGENTS.md). */
const ENTRY = new Set(["README.md", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"]);
const SCRIPTS = Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts);

/** Inline code spans outside fenced blocks (fences hold commands and the template). */
const spans = (md: string) => md.replace(/^```[\s\S]*?^```/gm, "").match(/`[^`\n]+`/g)?.map((s) => s.slice(1, -1)) ?? [];
const isPath = (s: string) => /^[\w.][\w.\-/*]*$/.test(s) && (s.includes("/") || /\.(md|tsx?|js|json|toml|sh|ps1|ya?ml|py|txt|exe)$/.test(s)) && !/^\d/.test(s);
/** Runtime APIs (`Bun.which`, `path.delimiter`) aren't the project's names. */
const RUNTIME = /^(Bun|process|path|node|import)\./;
const isSymbol = (s: string) => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(s) && !isPath(s) && !RUNTIME.test(s);
const wordIn = (w: string, text: string) => new RegExp(`(^|[^\\w$])${w.replace(/[.$]/g, "\\$&")}($|[^\\w$])`).test(text);

const pathExists = (s: string, from: string) => {
  const p = s.replace(/\/?\*.*$/, "").replace(/\/$/, "");
  // A bare name may be a file outside the repo that the code handles (`claude.exe`, the user's `CLAUDE.md`).
  if (!p.includes("/")) return NAMES.has(p) || wordIn(p, CORPUS);
  return existsSync(join(ROOT, p)) || existsSync(join(dirname(from), p));
};

test("BUG-163: names are checked against this checkout only, never a worktree's copy under .claude/", () => {
  expect(FILES.filter((p) => rel(p).startsWith(".claude/"))).toEqual([]);
});

test("there is a root AGENTS.md and at least one nested one", () => {
  expect(AGENTS.map(rel)).toContain("AGENTS.md");
  expect(AGENTS.length).toBeGreaterThan(1);
});

describe.each(AGENTS.map((p) => [rel(p), p]))("%s", (_name, file) => {
  const md = readFileSync(file, "utf8");
  const named = spans(md);

  test("every file it names exists", () => {
    expect(named.filter(isPath).filter((s) => !pathExists(s, file))).toEqual([]);
  });

  test("every symbol it names appears in the code", () => {
    expect(named.filter(isSymbol).filter((s) => !wordIn(s, CORPUS))).toEqual([]);
  });

  test("every `bun run` script it names is in package.json", () => {
    const runs = [...md.matchAll(/bun run ([\w:-]+)/g)].map((m) => m[1]!);
    expect(runs.filter((r) => !SCRIPTS.includes(r))).toEqual([]);
  });
});

/**
 * The docs site's sidebar (`site/astro.config.mjs`, `site/sidebar.mjs`) lists a folder of `docs/`
 * by name instead of each page, so a page is linked when the config quotes its slug or one of
 * its folders: `docs/guides/harnesses/x.md` by "guides", "guides/harnesses" or "guides/harnesses/x".
 */
export const linkedBySidebar = (docsFile: string, config: string): boolean => {
  const parts = docsFile.replace(/^docs\//, "").replace(/\.mdx?$/, "").split("/");
  const names = new Set([...config.matchAll(/"([\w\-/]+)"/g)].map((m) => m[1]!));
  return parts.some((_, i) => names.has(parts.slice(0, i + 1).join("/")));
};
const SIDEBAR_CONFIG = existsSync(join(ROOT, "site/astro.config.mjs")) ? readFileSync(join(ROOT, "site/astro.config.mjs"), "utf8") : "";

test("a docs page is linked by the sidebar when its slug or a folder of it is named", () => {
  const config = 'docsGroup("Guides", "guides"), { slug: "index" }, docsItems("getting-started")';
  expect(linkedBySidebar("docs/guides/harnesses/x.md", config)).toBe(true);
  expect(linkedBySidebar("docs/getting-started/install.mdx", config)).toBe(true);
  expect(linkedBySidebar("docs/index.mdx", config)).toBe(true);
  expect(linkedBySidebar("docs/other/x.md", config)).toBe(false);
  expect(linkedBySidebar("docs/guides-extra/x.md", config)).toBe(false);
});

/** Prose only: fenced blocks hold commands and templates. */
const prose = (md: string) => md.replace(/^```[\s\S]*?^```/gm, "");

describe.each(MARKDOWN.map((f) => [f]))("%s", (file) => {
  const md = readFileSync(join(ROOT, file), "utf8");

  test("it says how it is kept fresh", () => {
    expect(prose(md)).toMatch(/Keeping (this file|AGENTS\.md files) fresh/);
  });

  test.skipIf(ENTRY.has(file) || file.startsWith(".github/"))("another file links to it", () => {
    const linked = (file.startsWith("docs/") && linkedBySidebar(file, SIDEBAR_CONFIG)) || FILES.some((p) => {
      if (rel(p) === file || !(p.endsWith(".md") || p.endsWith(".mdx") || CODE.test(basename(p)))) return false;
      const text = readFileSync(p, "utf8");
      return text.includes(file) || text.includes(relative(dirname(p), join(ROOT, file)).replaceAll("\\", "/"));
    });
    expect(linked).toBe(true);
  });
});

/**
 * A guide's footer says which files it describes, so whoever changes them knows to update it: every
 * repo path the footer names (in backticks, or bare like `src/x.ts`) must exist, and a guide names at least one.
 * `docs/reference/` is generated and has no such footer to keep.
 */
const footerPaths = (md: string): string[] => {
  const at = md.lastIndexOf("Keeping this file fresh");
  const footer = at < 0 ? "" : md.slice(at);
  const bare = footer.match(/(?<![\w./-])(?:src|docs|scripts|test|site|\.github)\/[\w./*\-]*[\w*]/g) ?? [];
  return [...new Set([...spans(footer).filter(isPath), ...bare])];
};

test("footerPaths reads backticked and bare paths from a footer", () => {
  const md = "text\n<!-- Keeping this file fresh: update when `src/a.ts`, src/b.ts or docs/x.md (and `bun run t`) change. -->";
  expect(footerPaths(md)).toEqual(["src/a.ts", "src/b.ts", "docs/x.md"]);
});

describe.each(MARKDOWN.filter((f) => f.startsWith("docs/") && !f.startsWith("docs/reference/")).map((f) => [f]))("%s footer", (file) => {
  const paths = footerPaths(readFileSync(join(ROOT, file), "utf8"));

  test("every path it names exists (fix the footer: a file was renamed or removed)", () => {
    expect(paths.filter((s) => !pathExists(s, join(ROOT, file)))).toEqual([]);
  });

  test("it names at least one file the page describes (add the source files, e.g. `src/routing.ts`)", () => {
    expect(paths.length).toBeGreaterThan(0);
  });
});
