/** Pieces shared by the setup menus (`signin.tsx`) and the intake chat (`chat.tsx`). */
import { Box, Text } from "ink";
import type { Draft } from "./editor.ts";
import { inline } from "./markdown.tsx";
import type { Theme } from "./theme.ts";
import { useWidth, Width, wrap, Wrapped } from "./width.tsx";

export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Where an option row's label and description go at this width (shared with the height estimates of the menus). */
export function optionLayout(avail: number, n: number, labelWidth: number, hasDescription: boolean, count = n) {
  const prefixWidth = 2 + String(count).length + 2;
  const room = avail - prefixWidth;
  const col = Math.min(labelWidth, Math.floor(room * 0.45));
  return { prefixWidth, room, col, side: hasDescription && room - col - 2 >= 20 };
}

/** Rows an option row takes at this width (an estimate: markdown marks are counted as text). */
export function optionHeight(avail: number, o: { label: string; description?: string }, labelWidth: number, count: number): number {
  const { room, col, side } = optionLayout(avail, count, labelWidth, o.description !== undefined, count);
  const lines = (text: string, width: number) => wrap(text, Math.max(1, width)).split("\n").length;
  if (side) return Math.max(lines(o.label, col), lines(o.description!, room - col - 2));
  return lines(o.label, room) + (o.description ? lines(o.description, room) : 0);
}

/**
 * `› N. label  description` (Codex's selection row). Labels wrap within their own column; on a
 * narrow terminal the description moves under the label. `count`: the number of rows in the list,
 * so numbers are right-aligned (" 9." over "10.").
 */
export function OptionRow({ n, label, description, selected, labelWidth, theme, count = n }: { n: number; label: string; description?: string; selected: boolean; labelWidth: number; theme: Theme; count?: number }) {
  const avail = useWidth();
  const { prefixWidth, room, col, side } = optionLayout(avail, n, labelWidth, description !== undefined, count);
  const prefix = `${selected ? "› " : "  "}${`${n}.`.padStart(prefixWidth - 3)} `;
  const tone = { color: selected ? theme.accent : undefined, bold: selected };
  return (
    <Box>
      <Text {...tone}>{prefix}</Text>
      {side ? (
        <>
          <Box width={col} flexShrink={0}>
            <Width columns={col}>
              <Wrapped text={inline(label, theme)} {...tone} />
            </Width>
          </Box>
          <Box marginLeft={2} flexShrink={1}>
            <Width columns={room - col - 2}>
              <Wrapped text={inline(description!, theme)} dimColor />
            </Width>
          </Box>
        </>
      ) : (
        <Box flexDirection="column" flexShrink={1}>
          <Width columns={room}>
            <Wrapped text={inline(label, theme)} {...tone} />
            {description ? <Wrapped text={inline(description, theme)} dimColor /> : null}
          </Width>
        </Box>
      )}
    </Box>
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One screen row of the composer: the draft offsets it shows and its text. */
interface VisualRow {
  from: number;
  to: number;
  cells: { text: string; at: number }[];
  last: boolean; // the last row of its line (the cursor may sit after it)
}

// Codex: textarea.rs — `wrap_ranges`: rows break after whitespace, a word longer than a row is cut.
/**
 * Wraps one line of the draft into rows of `width` columns at word boundaries (BUG-266): a word
 * that doesn't fit starts the next row, with the blank before it ending this one; only a word
 * longer than a row is broken. Every grapheme stays on screen (a row never passes `width`); tabs
 * become spaces.
 */
function layoutLine(line: string, start: number, width: number): VisualRow[] {
  const rows: VisualRow[] = [];
  let row: VisualRow = { from: start, to: start, cells: [], last: false };
  let col = 0;
  // Where the row's last word starts (its cells after the last blank); 0: no blank before it.
  let word = 0;
  for (const { segment, index } of graphemes.segment(line)) {
    const text = segment === "\t" ? " ".repeat(4 - (col % 4)) : segment;
    const w = Bun.stringWidth(text);
    while (col + w > width && row.cells.length) {
      // The word being typed moves down whole; one with no blank before it in this row is cut here.
      const carry = word > 0 && word < row.cells.length ? row.cells.splice(word) : [];
      const at = carry[0]?.at ?? start + index;
      row.to = at;
      rows.push(row);
      row = { from: at, to: at, cells: carry, last: false };
      col = carry.reduce((n, c) => n + Bun.stringWidth(c.text), 0);
      word = 0;
    }
    row.cells.push({ text, at: start + index });
    row.to = start + index + segment.length;
    col += w;
    if (/^\s+$/.test(segment)) word = row.cells.length;
  }
  // Room for the cursor after a full last row.
  if (col >= width && row.cells.length) {
    rows.push(row);
    row = { from: row.to, to: row.to, cells: [], last: false };
  }
  row.last = true;
  rows.push(row);
  return rows;
}

/** The composer's rows: the draft wrapped to `width`, at most `maxRows` shown around the cursor (`first`…`last`), the rest counted. */
export function composerRows(draft: Draft, width: number, maxRows: number) {
  const lines = draft.text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  let cursorLine = 0;
  for (const [i, line] of lines.entries()) {
    starts.push(offset);
    if (draft.cursor >= offset && draft.cursor <= offset + line.length) cursorLine = i;
    offset += line.length + 1;
  }
  const estimate = (i: number) => Math.max(1, Math.ceil((Bun.stringWidth(lines[i]!) + 1) / width));
  // Lay out only the lines near the cursor; the rest are counted.
  let rows = layoutLine(lines[cursorLine]!, starts[cursorLine]!, width);
  let above = cursorLine;
  let below = cursorLine;
  while (above > 0 && rows.length < maxRows * 2) rows = [...layoutLine(lines[--above]!, starts[above]!, width), ...rows];
  while (below < lines.length - 1 && rows.length < maxRows * 4) rows = [...rows, ...layoutLine(lines[++below]!, starts[below]!, width)];
  let hiddenAbove = 0;
  let hiddenBelow = 0;
  for (let i = 0; i < above; i++) hiddenAbove += estimate(i);
  for (let i = below + 1; i < lines.length; i++) hiddenBelow += estimate(i);

  const cursorRow = rows.findIndex((r) => draft.cursor >= r.from && (draft.cursor < r.to || (r.last && draft.cursor === r.to)));
  let first = Math.max(0, cursorRow - maxRows + 1);
  let last = Math.min(rows.length, first + maxRows);
  // The "more" markers take a row each.
  if (hiddenAbove + first > 0 && cursorRow > first) first++;
  if (hiddenBelow + rows.length - last > 0 && cursorRow < last - 1) last--;
  const moreAbove = hiddenAbove + first;
  const moreBelow = hiddenBelow + rows.length - last;
  return { rows, first, last, cursorRow, moreAbove, moreBelow };
}
