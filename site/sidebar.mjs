import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPublished } from "./published.mjs";

const DOCS = new URL("../docs/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** `sidebar: { order: N }` from a page's frontmatter (pages without one sort by file name, after the numbered ones). */
const orderOf = (file) => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
  const n = /^sidebar:\s*\n(?:[ \t]+.*\n)*?[ \t]+order:\s*(-?\d+)/m.exec(fm + "\n")?.[1];
  return n === undefined ? Infinity : Number(n);
};

/**
 * The sidebar items for one folder of ../docs: its pages (by `sidebar.order`, then file name), then
 * a group per subfolder. Starlight's own `autogenerate` can't be used: it only sees files under
 * src/content/docs, and the content here lives in ../docs. A missing or empty folder gives no items.
 * Slug items also give llms.txt its page order. New pages need a dev-server restart.
 */
export const docsItems = (dir) => {
  const abs = join(DOCS, dir);
  if (!existsSync(abs)) return [];
  const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const pages = entries
    .filter((e) => e.isFile() && /\.mdx?$/.test(e.name) && isPublished(readFileSync(join(abs, e.name), "utf8")))
    .map((e) => ({ slug: join(dir, e.name.replace(/\.mdx?$/, "")).replaceAll("\\", "/").replace(/\/index$/, ""), order: orderOf(join(abs, e.name)) }))
    .sort((a, b) => a.order - b.order);
  const groups = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ label: e.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), items: docsItems(join(dir, e.name)) }))
    .filter((g) => g.items.length > 0);
  return [...pages.map(({ slug }) => ({ slug })), ...groups];
};

/** A top-level group for a folder; dropped while the folder has no pages. */
export const docsGroup = (label, dir) => {
  const items = docsItems(dir);
  return items.length > 0 ? [{ label, items }] : [];
};
