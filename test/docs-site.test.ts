/**
 * The docs site (`site/`) shows `docs/`: a page that no sidebar entry reaches is published but
 * unfindable, and a sidebar entry for a folder that is gone is a dead link. The sidebar is the folders named in
 * `site/astro.config.mjs` (`docsGroup("Label", "dir")`, `docsItems("dir")`) scanned by `site/sidebar.mjs`
 * (no Astro in it, so the test runs the real scan), plus the slugs the config lists by hand.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HARNESSES } from "../src/harnesses.ts";
import { REPO_SLUG } from "../src/repo.ts";
import { CLI_OPTIONS } from "../src/usage.ts";
import { astroArgv } from "../scripts/docs/astro.ts";
import { GROUPS, ROOT_FILES_LABEL, groupOf } from "../site/groups.mjs";
import { llmsTxt } from "../site/llms.mjs";
import { isPublished } from "../site/published.mjs";
import { docsItems } from "../site/sidebar.mjs";

const ROOT = join(import.meta.dir, "..");
const DOCS = join(ROOT, "docs");
const CONFIG = readFileSync(join(ROOT, "site/astro.config.mjs"), "utf8");
/** Pages the site builds from root files (`site/src/content.config.ts`), not from `docs/`. */
const BUILT_FROM_ROOT = new Set(["changelog", "security"]);

const pages = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? pages(p) : /\.mdx?$/.test(f) ? [p] : [];
  });
const PAGES = pages(DOCS).map((p) => p.slice(DOCS.length + 1).replaceAll("\\", "/"));
const slugOf = (page: string) => page.replace(/\.mdx?$/, "").replace(/\/index$/, "").replace(/^index$/, "index");

const dirsNamed = [...CONFIG.matchAll(/docs(?:Group|Items)\(\s*(?:"[^"]*"\s*,\s*)?"([\w\-/]+)"/g)].map((m) => m[1]!).concat(GROUPS.map((g: { dir: string }) => g.dir));
const slugsNamed = [...CONFIG.matchAll(/slug:\s*"([\w\-/]+)"/g)].map((m) => m[1]!);
type Item = { slug?: string; items?: Item[] };
const slugsIn = (items: Item[]): string[] => items.flatMap((i) => (i.slug ? [i.slug] : slugsIn(i.items ?? [])));
const REACHED = new Set([...slugsNamed, ...dirsNamed.flatMap((d) => slugsIn(docsItems(d)))]);

const textOf = (page: string) => readFileSync(join(DOCS, page), "utf8");
/** A page with `published: false` stays in the repository only (`site/published.mjs`): no route, no sidebar entry. */
const unpublished = (page: string) => !isPublished(textOf(page));
const PUBLISHED = PAGES.filter((p) => !unpublished(p));
const frontmatter = (page: string) => /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(DOCS, page), "utf8"))?.[1] ?? "";

test("BUG-540/docs:dev and docs:build pass Astro an absolute --root (a relative one made Astro 7's dev child create site/site/)", () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
  for (const name of ["docs:dev", "docs:build"]) {
    expect(scripts[name]).toMatch(/^bun --no-env-file --config=scripts\/empty-bunfig\.toml scripts\/docs\/astro\.ts (dev|build)$/);
    expect(scripts[name]).not.toContain("--root");
  }
  for (const cmd of ["dev", "build"]) {
    const argv = astroArgv(cmd);
    const root = argv[argv.indexOf("--root") + 1]!;
    expect(isAbsolute(root)).toBe(true);
    expect(root).toBe(join(ROOT, "site"));
    expect(argv).toContain(cmd);
    expect(argv.filter((a) => /^\.?\.?\/?site$/.test(a) || a === "site")).toEqual([]);
    expect(argv.every((a) => !a.startsWith("--") || a === "--root" || /^--(no-env-file|config=|bun)/.test(a))).toBe(true);
  }
});

test("BUG-542/published:false pages (if any) are not in the sidebar, and every other page is", () => {
  const unpub = PAGES.filter(unpublished);
  const reached = new Set([...slugsNamed, ...dirsNamed.flatMap((d) => slugsIn(docsItems(d)))]);
  expect(unpub.filter((p) => reached.has(slugOf(p)))).toEqual([]);
});

test("BUG-544/maintainer notes stay off the published pages, and in no page of this repository", () => {
  const FORBIDDEN = [/live-spend/, /CLAUDE_CODE_OAUTH_TOKEN/, /owner only/i, /WSL dev machine/, /\$\d[\d.,]*[^\n]{0,40}\bpaid\b/i, /\bpaid[^\n]{0,40}\$\d/i, /gluon-coverage|gluon-followups/];
  const rootPages = ["CHANGELOG.md", "SECURITY.md"].map((f) => [f, readFileSync(join(ROOT, f), "utf8")] as const);
  const published = [...PUBLISHED.map((p) => [`docs/${p}`, textOf(p)] as const), ...rootPages];
  expect(published.length).toBeGreaterThan(20);
  const hits = published.flatMap(([file, text]) => FORBIDDEN.filter((re) => re.test(text)).map((re) => `${file}: ${re}`));
  expect(hits).toEqual([]);
  // the maintainers' notes are kept privately: no page here is kept off the site, none holds them
  expect(PAGES.filter(unpublished)).toEqual([]);
  expect(PAGES.filter((p) => /(^|\/)internal\.md$/.test(p))).toEqual([]);
});

test("BUG-545/every getting-started page, guide and harness page ends with a Next steps section", () => {
  const needing = PUBLISHED.filter((p) => /^(getting-started|guides)\//.test(p));
  expect(needing.length).toBeGreaterThan(10);
  expect(needing.filter((p) => !/^## Next steps\s*$/m.test(textOf(p).replace(/^```[\s\S]*?^```/gm, "")))).toEqual([]);
});

test("BUG-549/the favicon every page links exists in site/public", () => {
  expect(existsSync(join(ROOT, "site/public/favicon.svg"))).toBe(true);
  expect(readFileSync(join(ROOT, "site/public/favicon.svg"), "utf8")).toMatch(/^<svg[\s\S]*#D97757/);
});

test("BUG-550/llms.txt lists every published page under the sidebar's group names, Overview included", () => {
  const titleOf = (p: string) => /^title:\s*"?(.+?)"?\s*$/m.exec(frontmatter(p))?.[1] ?? p;
  const docs = PUBLISHED.map((p) => ({ id: slugOf(p), title: titleOf(p), description: "d" }));
  const order = [...slugsNamed, ...dirsNamed.flatMap((d) => slugsIn(docsItems(d)))];
  const text = llmsTxt(docs, { title: "Gluon", description: "x", origin: "https://h", order });
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
  expect(headings).toEqual(["Documentation sets", ...GROUPS.map((g: { label: string }) => g.label)]);
  expect(text).toContain("- [Overview");
  for (const d of docs) expect(text).toContain(`(https://h/${d.id}.md)`);
  expect(text).not.toContain("internal");
  expect(groupOf("changelog")).toBe(ROOT_FILES_LABEL);
  expect(llmsTxt([{ id: "security", title: "Security" }], { title: "T", origin: "o", order: [] })).toContain(`## ${ROOT_FILES_LABEL}`);
  // the config's sidebar is built from the same groups, and the plugin's own route is swapped for ours
  expect(CONFIG).toContain("GROUPS");
  expect(CONFIG).toContain("src/llms-route.ts");
  expect(existsSync(join(ROOT, "site/src/llms-route.ts"))).toBe(true);
});

test("BUG-551/harness pages are in the order of HARNESSES in the sidebar, and each one's next-agent link matches", () => {
  const harnessPages = PUBLISHED.filter((p) => p.startsWith("guides/harnesses/"));
  expect(harnessPages.map((p) => p.replace(/^.*\/|\.md$/g, "")).sort()).toEqual([...HARNESSES].sort());
  const sidebar = slugsIn(docsItems("guides")).filter((s) => s.startsWith("guides/harnesses/")).map((s) => s.replace("guides/harnesses/", ""));
  expect(sidebar).toEqual([...HARNESSES]);
  HARNESSES.forEach((h, i) => {
    const next = [...textOf(`guides/harnesses/${h}.md`).matchAll(/^- \[[^\]]+\]\(([\w-]+)\.md\): the next agent\./gm)].map((m) => m[1]);
    expect([h, next]).toEqual([h, i + 1 < HARNESSES.length ? [HARNESSES[i + 1]] : []]);
  });
});

test("BUG-554/the quickstart shows the demo-mode command", () => {
  const quickstart = textOf("getting-started/quickstart.md");
  expect(quickstart).toMatch(/^<!-- example -->\n```sh\ngluon --demo\n```$/m);
  expect(CLI_OPTIONS).toHaveProperty("demo");
});

test("BUG-556/the local-release path says to clone the repository first and links CONTRIBUTING.md", () => {
  const install = textOf("getting-started/install.md");
  const section = install.slice(install.indexOf("## A release directory built locally"), install.indexOf("## Verifying by hand"));
  expect(section).toContain("CONTRIBUTING.md");
  expect(section.indexOf("git clone")).toBeGreaterThan(-1);
  expect(section.indexOf("git clone")).toBeLessThan(section.indexOf("bun install"));
});

test("BUG-557/the docs site's URL and base path come from site/base.mjs (GitHub Pages, project page named after the repository)", async () => {
  const { SITE_URL, BASE } = await import("../site/base.mjs");
  expect(`${SITE_URL}${BASE}`).toBe(`https://${REPO_SLUG.split("/")[0]!.toLowerCase()}.github.io/${REPO_SLUG.split("/")[1]}`);
  expect(CONFIG).toMatch(/\bsite: SITE_URL,/);
  expect(CONFIG).toMatch(/\bbase: BASE,/);
  expect(CONFIG).not.toMatch(/https?:\/\//);
});

test("the config names folders (the test would pass vacuously otherwise)", () => {
  expect(dirsNamed.length).toBeGreaterThan(2);
});

test("every folder and slug the sidebar config names exists under docs/ (fix site/astro.config.mjs)", () => {
  const missingDirs = dirsNamed.filter((d) => !existsSync(join(DOCS, d)));
  const missingSlugs = slugsNamed.filter((s) => !BUILT_FROM_ROOT.has(s) && !PAGES.some((p) => slugOf(p) === s));
  expect({ missingDirs, missingSlugs }).toEqual({ missingDirs: [], missingSlugs: [] });
});

describe.each(PAGES.map((p) => [p]))("docs/%s", (page) => {
  const fm = frontmatter(page);

  test("the sidebar reaches it (put it in a folder named in site/astro.config.mjs, or give it `sidebar: { hidden: true }` frontmatter)", () => {
    const hidden = /^sidebar:\s*\n(?:[ \t]+.*\n)*?[ \t]+hidden:\s*true/m.test(fm + "\n");
    expect(hidden || unpublished(page) || REACHED.has(slugOf(page))).toBe(true);
  });

  test("it has a frontmatter title and description (the site's page title and search summary)", () => {
    expect([page, /^title:\s*\S/m.test(fm), /^description:\s*\S/m.test(fm)]).toEqual([page, true, true]);
  });
});
