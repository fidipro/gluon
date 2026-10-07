import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { satteri } from "@astrojs/markdown-satteri";
import { stripFirstH1 } from "./strip-h1.mjs";
import { rewriteLinks } from "./rewrite-links.mjs";
import { BASE, SITE_URL } from "./base.mjs";
import { GROUPS, ROOT_FILES_LABEL } from "./groups.mjs";
import { docsGroup, docsItems } from "./sidebar.mjs";
import starlightLlmTools from "@wave-rf/starlight-llm-tools";

// Sidebar: one group per folder of ../docs (groups.mjs, scanned by sidebar.mjs), so a new page appears
// by being added. test/markdown.test.ts reads the folders named in groups.mjs: a page in one of
// them counts as linked. llms.txt uses the same group names (src/llms-route.ts).
const [first, ...folders] = GROUPS;
const sidebar = [
  { label: first.label, items: [{ slug: "index", label: "Overview" }, ...docsItems(first.dir)] },
  ...folders.flatMap(({ label, dir }) => docsGroup(label, dir)), // guides/harnesses/ becomes a "Harnesses" subgroup
  // changelog and security are built from the root CHANGELOG.md and SECURITY.md (src/content.config.ts)
  { label: ROOT_FILES_LABEL, items: [{ slug: "changelog" }, { slug: "security" }] },
];

export default defineConfig({
  site: SITE_URL,
  base: BASE,
  markdown: { processor: satteri({ mdastPlugins: [stripFirstH1, rewriteLinks] }) },
  vite: {
    plugins: [
      {
        // The llms-tools plugin's /llms.txt names sections after folders and leaves out the Overview:
        // serve src/llms-route.ts (llms.mjs) in its place.
        name: "gluon-llms-txt",
        enforce: "pre",
        resolveId: (id) => (/starlight-llm-tools\/src\/routes\/llms\.txt\.ts$/.test(id) ? fileURLToPath(new URL("./src/llms-route.ts", import.meta.url)) : undefined),
      },
    ],
    // MDX files live in ../docs, outside this package: bare imports there do not
    // find site/node_modules, so point them at it.
    resolve: {
      alias: [
        {
          find: /^@astrojs\/starlight\/components$/,
          replacement: fileURLToPath(import.meta.resolve("@astrojs/starlight/components")),
        },
      ],
    },
  },
  integrations: [
    starlight({
      title: "Gluon",
      description: "The control platform for coding agents.",
      markdown: { processedDirs: ["../docs"] }, // asides, heading links: only run on src/content/docs by default
      sidebar,
      customCss: ["./src/styles/theme.css"],
      components: { PageTitle: "./src/components/PageTitle.astro" },
      lastUpdated: false,
      pagination: true,
      plugins: [starlightLlmTools()],
    }),
  ],
});
