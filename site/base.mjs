// The docs site is a GitHub Pages project page: https://<owner>.github.io/<repo>/ (.github/workflows/pages.yml
// publishes it). The one place that names the repository is src/repo.ts: read it, don't copy it.
// Astro does not prefix links written in Markdown, so rewrite-links.mjs adds BASE itself. Only for Node-side config
// code: it reads a file, so a bundled route (src/llms-route.ts) uses import.meta.env.BASE_URL instead.
import { readFileSync } from "node:fs";

const slug = /REPO_SLUG\s*=\s*"([^/"]+)\/([^/"]+)"/.exec(readFileSync(new URL("../src/repo.ts", import.meta.url), "utf8"));
if (!slug) throw new Error("site/base.mjs: no REPO_SLUG = \"owner/name\" in src/repo.ts");

/** Where the site is served from (GitHub Pages' host for the repository's owner). */
export const SITE_URL = `https://${slug[1].toLowerCase()}.github.io`;
/** The path under that host: the repository's name. */
export const BASE = `/${slug[2]}`;
