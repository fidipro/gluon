/**
 * The text-layout seam (`test/seams.ts`): text, a theme and a width → the rows it is drawn in. The e2e scenarios check a
 * few widths through Gluon's terminal (test/e2e/agent-choice.e2e.test.ts); this sweeps every width, which a terminal walk
 * can't afford.
 */
import { expect, test } from "bun:test";
import { renderToString } from "ink";
import { Markdown, markdownRows } from "../src/ui/markdown.tsx";
import { makeTheme } from "../src/ui/theme.ts";
import { Width, wrap } from "../src/ui/width.tsx";

const theme = makeTheme(null, { COLORTERM: "truecolor" });

test("markdown/blocks: markdownRows counts the rows Markdown draws at any width, so a spec box is cut without measuring #BUG-197", () => {
  const text = [
    "# Title that is long enough to wrap at a narrow width",
    "",
    "A paragraph with **bold**, `code` and _italic_ words that wraps over several lines here.",
    "",
    "",
    "- a bullet that also wraps when the width is small enough",
    "  - a nested bullet, deeper, that wraps as well at narrow widths",
    "1. an ordered item with some words",
    "- [ ] a task",
    "> a quote that runs long enough to wrap at most widths",
    "---",
    "| a | b |",
    "|---|---|",
    "| one | a longer cell here |",
    "```",
    "const code = 'a long line of code that is wrapped, never truncated';",
    "",
    "```",
    "\tindented paragraph",
  ].join("\n");
  // From 20 columns: narrower, a nested item keeps 10 for its indent and Ink wraps it again.
  for (let w = 20; w <= 100; w++) {
    const drawn = Bun.stripANSI(renderToString(<Width columns={w}><Markdown text={text} theme={theme} /></Width>, { columns: w })).split("\n").length;
    expect(`${w}: ${markdownRows(text, theme, w)}`).toBe(`${w}: ${drawn}`);
  }
});

test("agent-choice/fits: wrapped text never ends a line in its `·` or `×` separator, at any width, and keeps every letter #BUG-267/GLUON-49", () => {
  const texts = ["claude code × sonnet 5.5 × medium · recommended", "I'd start it with: claude code × sonnet 5.5 × medium", "1. opencode × deepseek flash × max · explore · accept edits"];
  for (const text of texts) {
    // From 12 columns: narrower, a separator and a long word can't share a row (at 8–9 a lone `×` row is left).
    for (let w = 12; w <= 110; w++) {
      const rows = wrap(text, w).split("\n");
      for (const r of rows) expect(`${w}: ${r}`).not.toMatch(/ [·×]$/);
      for (const r of rows) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(w);
      // Every letter stays (a word longer than a row is broken there); only a separator that ends up at a break may go.
      const letters = (t: string) => t.replace(/[\s·×]/g, "");
      expect(letters(rows.join(""))).toBe(letters(text));
    }
  }
  // A separator starts the next line with its word; one too long to go with it is dropped at the break.
  expect(wrap("I'd start it with: claude code × sonnet 5.5 × medium", 28)).toBe("I'd start it with: claude\ncode × sonnet 5.5 × medium");
  expect(wrap("medium · recommended", 12)).toBe("medium\nrecommended");
});
