// `published: false` in a docs page's frontmatter keeps it off the site: it stays in the repo (read
// on GitHub, still covered by test/markdown.test.ts) but gets no route, no sidebar entry and no
// llms.txt line, and links to it become GitHub links (rewrite-links.mjs). For maintainers' notes.

/** False when the page's frontmatter says `published: false`. Pure: takes the file's text. */
export const isPublished = (markdown) => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
  return !/^published:\s*false\s*$/m.test(fm);
};
