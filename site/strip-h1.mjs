// Sätteri mdast plugin: on pages without a frontmatter title, drop the first
// `# heading`. The loader in src/content.config.ts already turned it into the page
// title, which Starlight renders as the page <h1>.
export const stripFirstH1 = ({ source }) => {
  if (/^---\n[\s\S]*?^title:/m.test(source.startsWith("---\n") ? source.slice(0, source.indexOf("\n---", 4) + 1) : "")) return;
  let done = false;
  return {
    name: "gluon-strip-first-h1",
    heading(node, ctx) {
      if (done || node.depth !== 1) return;
      done = true;
      ctx.removeNode(node);
    },
  };
};
