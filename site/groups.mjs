// The sidebar's top-level groups, in order: one per folder of ../docs. The sidebar
// (astro.config.mjs) and llms.txt (src/llms-route.ts, llms.mjs) both read this, so a page has
// the same section name in both. Pages outside these folders: `index` is the Overview, under the
// first group; `changelog` and `security` are built from root files (src/content.config.ts).
export const GROUPS = [
  { label: "Getting started", dir: "getting-started" },
  { label: "Guides", dir: "guides" },
  { label: "Reference", dir: "reference" },
  { label: "Concepts", dir: "concepts" },
  { label: "Contributing", dir: "contributing" },
];
export const ROOT_FILES_LABEL = "Changelog and security";

/** The group label of a docs-collection page id. */
export const groupOf = (id) => {
  if (id === "index") return GROUPS[0].label;
  const top = id.split("/")[0];
  return GROUPS.find((g) => g.dir === top)?.label ?? ROOT_FILES_LABEL;
};
