// Sätteri mdast plugin: the docs link to each other (and to files elsewhere in the repo) with
// repo-relative paths (`quickstart.md`, `../../CONTRIBUTING.md`), because that is what works on
// GitHub and in the repo's link tests. On the site those become page routes, or GitHub URLs for
// files that are not pages. Absolute URLs, `#anchor`-only links, mailto: and images are untouched.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE } from "./base.mjs";
import { isPublished } from "./published.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS_DIR = resolve(REPO_ROOT, "docs");

// The one place that names the repository is src/repo.ts: read it, don't copy it.
const repoSlug = () => /REPO_SLUG\s*=\s*"([^"]+)"/.exec(readFileSync(resolve(REPO_ROOT, "src/repo.ts"), "utf8"))?.[1];

// Root files the site publishes as pages (src/content.config.ts), by repo-relative path.
const ROOT_PAGES = { "CHANGELOG.md": "/changelog/", "SECURITY.md": "/security/" };

// Routes are written under the site's base path (base.mjs); `opts.base` is for tests.

// A page with `published: false` has no route on the site (published.mjs): its links go to GitHub.
const unpublished = (path) => {
  try {
    return !isPublished(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
};

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Where `href`, written in the repo file `fromFile`, should point on the site; `undefined` = leave it.
 * Pure but for one directory check (a GitHub /tree/ link instead of /blob/) and one read of src/repo.ts
 * (skipped when `opts.slug` is given).
 */
export const resolveLink = (href, fromFile, opts = {}) => {
  const root = opts.repoRoot ?? REPO_ROOT;
  const base = opts.base ?? BASE;
  if (!href || href.startsWith("#") || href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  const cut = href.search(/[#?]/);
  const path = cut < 0 ? href : href.slice(0, cut);
  const tail = cut < 0 ? "" : href.slice(cut);
  if (!path) return undefined;
  const target = resolve(dirname(fromFile), decodeURIComponent(path));
  const rel = relative(root, target).split(sep).join("/");
  if (rel === "" || rel.startsWith("../") || rel === "..") return undefined; // outside the repo
  if (rel in ROOT_PAGES) return base + ROOT_PAGES[rel] + tail;
  const inDocs = rel.startsWith("docs/");
  if (inDocs && /\.mdx?$/.test(rel) && !(opts.unpublished ?? unpublished)(target)) {
    const slug = rel.slice("docs/".length).replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
    return base + (slug ? `/${slug}/` : "/") + tail;
  }
  if (inDocs && !/\.mdx?$/.test(rel)) return undefined; // a non-page file in docs/: not ours to guess
  const slug = opts.slug ?? repoSlug();
  const kind = (opts.isDir ?? isDir)(target) ? "tree" : "blob";
  return `https://github.com/${slug}/${kind}/main/${rel}${tail}`;
};

export const rewriteLinks = (ctx) => {
  // No file (a string compiled on its own): nothing to resolve against.
  if (!ctx.fileURL) return;
  const from = fileURLToPath(ctx.fileURL);
  const fix = (href) => resolveLink(href, from);
  return {
    name: "gluon-rewrite-links",
    link(node, c) {
      const to = fix(node.url);
      if (to) c.setProperty(node, "url", to);
    },
    definition(node, c) {
      const to = fix(node.url);
      if (to) c.setProperty(node, "url", to);
    },
    // `<Card href="x.md">` and friends in MDX.
    mdxJsxFlowElement: jsx,
    mdxJsxTextElement: jsx,
  };
  function jsx(node, c) {
    node.attributes?.forEach((attr, i) => {
      if (attr.type !== "mdxJsxAttribute" || attr.name !== "href" || typeof attr.value !== "string") return;
      const to = fix(attr.value);
      if (to) c.setProperty(node, "attributes", node.attributes.map((a, j) => (j === i ? { ...a, value: to } : a)));
    });
  }
};
