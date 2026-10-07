import { groupOf, GROUPS, ROOT_FILES_LABEL } from "./groups.mjs";

/**
 * The text of llms.txt (https://llmstxt.org): every page, under the sidebar's group names, in
 * sidebar order. The plugin's own route names a section after its folder and leaves out the
 * Overview page, so this replaces it (src/llms-route.ts). Pure.
 *
 * @param {{ id: string, title: string, description?: string }[]} docs
 * @param {{ title: string, description?: string, origin: string, order: string[] }} site `order`: slugs in sidebar order
 */
export const llmsTxt = (docs, { title, description, origin, order }) => {
  const rank = new Map(order.map((slug, i) => [slug, i]));
  const sorted = [...docs].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.id.localeCompare(b.id));
  const lines = [`# ${title}`, ""];
  if (description) lines.push(`> ${description}`, "");
  lines.push("## Documentation sets", "");
  lines.push(`- [Full documentation](${origin}/llms-full.txt): every page concatenated, source-faithful (mermaid, math, asides, components preserved as text).`);
  lines.push(`- [Abridged documentation](${origin}/llms-small.txt): only top-level pages and section overviews.`, "");
  for (const label of [...GROUPS.map((g) => g.label), ROOT_FILES_LABEL]) {
    const pages = sorted.filter((d) => groupOf(d.id) === label);
    if (pages.length === 0) continue;
    lines.push(`## ${label}`, "");
    for (const d of pages) lines.push(`- [${d.title}](${origin}/${d.id}.md)${d.description ? `: ${d.description}` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
};
