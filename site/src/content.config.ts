import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import type { Loader } from "astro/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { isPublished } from "../published.mjs";

const h1Of = (md: string) => /^# +(.+?)\s*$/m.exec(md.replace(/^---\n[\s\S]*?\n---\n/, ""))?.[1]?.replace(/[`*_]/g, "");

// Root files the site publishes as pages. Never copied into docs/: read from the repo root at
// every build (and watched in dev), so the page can't drift from the file GitHub shows.
const ROOT_PAGES = [
  { id: "changelog", file: "../CHANGELOG.md", description: "What changed in each Gluon release." },
  { id: "security", file: "../SECURITY.md", description: "What Gluon protects, how, and how to report a problem." },
];

// The content is the repo's docs/ tree (plain Markdown for GitHub readers), not
// site/src/content/docs. Plain pages have no frontmatter: the title comes from
// the first `# heading` (see strip-h1.mjs, which removes that heading from the body).
const docsLoader = (): Loader => {
  const inner = glob({ base: "../docs", pattern: "**/*.{md,mdx}" });
  return {
    name: "gluon-docs",
    load: async (ctx) => {
      await inner.load({
        ...ctx,
        parseData: (entry) => {
          const data = { ...entry.data } as Record<string, unknown>;
          if (typeof data.title !== "string" && entry.filePath) {
            const file = fileURLToPath(new URL(entry.filePath, ctx.config.root));
            data.title = h1Of(readFileSync(file, "utf8")) ?? entry.id;
          }
          return ctx.parseData({ ...entry, data });
        },
      });

      // `published: false` pages stay in the repo only (published.mjs). A page toggled while the dev
      // server runs needs a restart, like a new page.
      for (const [id, entry] of ctx.store.entries()) {
        const file = entry.filePath && fileURLToPath(new URL(entry.filePath, ctx.config.root));
        if (file && !isPublished(readFileSync(file, "utf8"))) ctx.store.delete(id);
      }

      // Links in these files are rewritten by rewrite-links.mjs, from the file URL passed to renderMarkdown.
      for (const { id, file, description } of ROOT_PAGES) {
        const path = fileURLToPath(new URL(file, ctx.config.root));
        const raw = readFileSync(path, "utf8");
        const title = h1Of(raw) ?? id;
        const body = raw.replace(/^# .*\n+/, "");
        const data = await ctx.parseData({ id, data: { title, description } });
        ctx.watcher?.add(path);
        ctx.store.set({
          id,
          data,
          body,
          filePath: file,
          digest: ctx.generateDigest(raw),
          rendered: await ctx.renderMarkdown(body, { fileURL: pathToFileURL(path) }),
        });
      }
    },
  };
};

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
