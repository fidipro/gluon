import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { resolveLink } from "../site/rewrite-links.mjs";

// The docs link to each other with repo-relative paths; site/rewrite-links.mjs maps them to site
// routes or GitHub URLs. Pure rules only (no Astro build).
// The injected predicates see native paths: backslashes on Windows.
const slash = (p: string) => p.replaceAll("\\", "/");
const root = resolve("/r");
const opts = { repoRoot: root, slug: "o/r", base: "", isDir: (p: string) => slash(p).endsWith("/src") };
const at = (file: string, href: string): string | undefined => resolveLink(href, join(root, file), opts);

test("docs links: a page in docs/ becomes its route, anchor kept", () => {
  expect(at("docs/getting-started/install.md", "quickstart.md")).toBe("/getting-started/quickstart/");
  expect(at("docs/guides/keyboard.md", "../reference/cli.md#flags")).toBe("/reference/cli/#flags");
  expect(at("docs/guides/harnesses/codex.md", "../sessions.md#a")).toBe("/guides/sessions/#a");
  expect(at("docs/index.mdx", "getting-started/quickstart.md")).toBe("/getting-started/quickstart/");
  expect(at("docs/guides/x.md", "../index.mdx")).toBe("/");
  expect(at("docs/guides/x.md", "../reference/index.md")).toBe("/reference/");
});

test("docs links: repo files outside docs/ go to GitHub, root changelog and security to their pages", () => {
  expect(at("docs/contributing/contributing.md", "../../CONTRIBUTING.md")).toBe("https://github.com/o/r/blob/main/CONTRIBUTING.md");
  expect(at("docs/concepts/platforms.md", "../../test/windows-manual-qa.md#x")).toBe("https://github.com/o/r/blob/main/test/windows-manual-qa.md#x");
  expect(at("docs/concepts/architecture.md", "../../src")).toBe("https://github.com/o/r/tree/main/src");
  expect(at("docs/contributing/contributing.md", "../../CHANGELOG.md")).toBe("/changelog/");
  expect(at("docs/getting-started/install.md", "../../SECURITY.md#reporting")).toBe("/security/#reporting");
});

test("docs links: routes carry the site's base path (a GitHub Pages project page), GitHub URLs do not", () => {
  const based = (file: string, href: string) => resolveLink(href, join(root, file), { ...opts, base: "/gluon" });
  expect(based("docs/getting-started/install.md", "quickstart.md#a")).toBe("/gluon/getting-started/quickstart/#a");
  expect(based("docs/guides/x.md", "../index.mdx")).toBe("/gluon/");
  expect(based("docs/guides/x.md", "../../CHANGELOG.md")).toBe("/gluon/changelog/");
  expect(based("docs/guides/x.md", "../../CONTRIBUTING.md")).toBe("https://github.com/o/r/blob/main/CONTRIBUTING.md");
  // the default is the real base (site/base.mjs): the repository's name
  expect(resolveLink("quickstart.md", join(root, "docs/getting-started/install.md"), { repoRoot: root, slug: "o/r" })).toStartWith("/gluon/");
});

test("docs links: root files resolve from the repo root", () => {
  expect(at("SECURITY.md", "docs/getting-started/install.md#verifying-by-hand")).toBe("/getting-started/install/#verifying-by-hand");
  expect(at("CHANGELOG.md", "./docs/index.mdx")).toBe("/");
  expect(at("SECURITY.md", "CONTRIBUTING.md")).toBe("https://github.com/o/r/blob/main/CONTRIBUTING.md");
});

test("docs links: absolute URLs, anchors, mailto, site-absolute paths and paths outside the repo stay", () => {
  for (const href of ["https://example.com/a.md", "#top", "mailto:a@b.c", "/guides/x/", "//cdn/x.md", "../../../outside.md", ""]) {
    expect(at("docs/guides/x.md", href)).toBeUndefined();
  }
});

// ---------------------------------------------------------------- published: false

test("BUG-542/a page with `published: false` is left out of the site, any other page is in", async () => {
  const { isPublished } = await import("../site/published.mjs");
  expect(isPublished('---\ntitle: "x"\npublished: false\n---\nbody')).toBe(false);
  expect(isPublished('---\r\ntitle: "x"\r\npublished: false\r\n---\r\nbody')).toBe(false);
  expect(isPublished('---\ntitle: "x"\npublished: true\n---\nbody')).toBe(true);
  expect(isPublished('---\ntitle: "x"\n---\nbody')).toBe(true);
  expect(isPublished("# no frontmatter\npublished: false")).toBe(true);
  expect(isPublished('---\ntitle: "x"\n---\npublished: false')).toBe(true);
});

test("BUG-543/a link to an unpublished page goes to GitHub, not to a route the site doesn't have", () => {
  const unpublished = (p: string) => slash(p).endsWith("/private-note.md");
  const to = (href: string) => resolveLink(href, join(root, "docs/contributing/maintenance.md"), { ...opts, unpublished });
  expect(to("private-note.md")).toBe("https://github.com/o/r/blob/main/docs/contributing/private-note.md");
  expect(to("private-note.md#going-public")).toBe("https://github.com/o/r/blob/main/docs/contributing/private-note.md#going-public");
  expect(to("contributing.md")).toBe("/contributing/contributing/");
});

// ---------------------------------------------------------------- every relative link and anchor resolves

/**
 * A heading's anchor the way GitHub and Starlight (github-slugger) write it: lower case, everything but
 * letters, digits, marks, `_`, `-` and spaces removed, spaces to `-`; a repeat gets `-1`, `-2`. An explicit
 * trailing `{#id}` is the anchor instead.
 */
export const anchorsOf = (md: string): Set<string> => {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const m of md.replace(/^```[\s\S]*?^```/gm, "").replace(/<!--[\s\S]*?-->/g, "").matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    let text = m[1]!;
    const explicit = /\s\{#([\w-]+)\}$/.exec(text);
    if (explicit) {
      out.add(explicit[1]!);
      continue;
    }
    text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").replace(/[`*]/g, "");
    const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "").replaceAll(" ", "-");
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    out.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return out;
};

/** Relative link targets in a page's prose: `](x)`, `[x]: y` definitions and `href="x"`, outside code and comments. */
export const relativeLinks = (md: string): string[] => {
  const text = md.replace(/^```[\s\S]*?^```/gm, "").replace(/<!--[\s\S]*?-->/g, "").replace(/`[^`\n]*`/g, "");
  const all = [...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), ...text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm), ...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
  return all.filter((h) => !/^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(h));
};

test("anchorsOf follows the GitHub/Starlight rules", () => {
  const a = anchorsOf("# T\n## A release directory built locally\n## `gluon pricing update`\n## Kimi Code (K3)?\n## Same\n## Same\n## Custom {#my-id}\n```\n## not a heading\n```\n");
  expect([...a]).toEqual(["t", "a-release-directory-built-locally", "gluon-pricing-update", "kimi-code-k3", "same", "same-1", "my-id"]);
});

test("relativeLinks reads inline links, definitions and hrefs, and skips URLs, code and comments", () => {
  const md = "[a](x.md#h) [b](https://e.com) [c](#top) `[d](no.md)`\n[e]: y.md\n<a href=\"z.md\">z</a>\n<!-- [f](gone.md) -->\n```\n[g](nope.md)\n```\n";
  expect(relativeLinks(md)).toEqual(["x.md#h", "#top", "y.md", "z.md"]);
});

{
  const { existsSync, readdirSync, readFileSync, statSync } = await import("node:fs");
  const repo = join(import.meta.dir, "..");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : /\.mdx?$/.test(f) ? [join(dir, f)] : []));
  const FILES = [...walk(join(repo, "docs")), ...["README.md", "SECURITY.md", "CHANGELOG.md", "CONTRIBUTING.md"].map((f) => join(repo, f))];
  const rel = (p: string) => p.slice(repo.length + 1).replaceAll("\\", "/");
  const cache = new Map<string, Set<string>>();
  const anchorsIn = (file: string) => cache.get(file) ?? cache.set(file, anchorsOf(readFileSync(file, "utf8"))).get(file)!;

  test.each(FILES.map((f) => [rel(f), f]))("BUG-541/%s: every relative link target exists and every #anchor is a heading of its target", (_name, file) => {
    const broken: string[] = [];
    for (const href of relativeLinks(readFileSync(file!, "utf8"))) {
      const [path = "", anchor] = href.split("#") as [string, string | undefined];
      const target = path ? resolve(join(file!, ".."), decodeURIComponent(path)) : file!;
      if (!existsSync(target)) broken.push(`${href}: no such file`);
      else if (anchor && /\.mdx?$/.test(target) && !anchorsIn(target).has(anchor)) broken.push(`${href}: no heading #${anchor} in ${rel(target)}`);
    }
    expect(broken).toEqual([]);
  });
}
