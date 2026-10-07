import chalk from "chalk";
import { Box, Text } from "ink";
import type { Theme } from "./theme.ts";
import { useTextColor, useWidth, wrap } from "./width.tsx";

/** A small markdown renderer following Codex's conventions: no fences, no backticks, • bullets. */
export function inline(text: string, theme: Theme): string {
  // Code spans first, so emphasis around them (**the `add` function**) still applies and
  // emphasis markers inside them stay literal.
  const code: string[] = [];
  const held = text.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${code.push(c) - 1}\u0000`);
  const re = /(\*\*[^*]+\*\*|(?<![*\w])\*[^*\s][^*]*\*(?!\w)|(?<!\w)_[^_\s][^_]*_(?!\w))/g;
  const styled = held.replace(re, (t) => (t.startsWith("**") ? chalk.bold(t.slice(2, -2)) : chalk.italic(t.slice(1, -1))));
  return styled.replace(/\u0000(\d+)\u0000/g, (_, i: string) => chalk.hex(theme.code)(code[Number(i)]!));
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableRule = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

const columnWidths = (rows: string[][]) => Array.from({ length: Math.max(...rows.map((r) => r.length)) }, (_, i) => Math.max(...rows.map((r) => Bun.stringWidth(r[i] ?? ""))));
const tableFits = (rows: string[][], width: number) => {
  const widths = columnWidths(rows);
  return widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1) <= width;
};

/** One drawn block of a markdown text: what `Markdown` draws, and what `markdownRows` counts. */
type Block =
  | { key: number; kind: "code"; text: string }
  | { key: number; kind: "blank" }
  | { key: number; kind: "table"; rows: string[][] }
  | { key: number; kind: "heading"; text: string; level: number }
  | { key: number; kind: "rule" }
  | { key: number; kind: "quote"; text: string }
  | { key: number; kind: "item"; marker: string; markerColor?: string; depth: number; text: string }
  | { key: number; kind: "para"; text: string };

/** `text` as the blocks `Markdown` draws, inline styles applied. */
function blocks(text: string, theme: Theme): Block[] {
  const out: Block[] = [];
  let inCode = false;
  let prevBlank = false;
  // Indentation of the enclosing list items, to turn indentation into nesting depth.
  let listIndents: number[] = [];
  const lines = text.replace(/\s+$/, "").replace(/^\s*\n/, "").split("\n");
  const depthFor = (indent: number) => {
    while (listIndents.length && indent < listIndents.at(-1)!) listIndents.pop();
    if (!listIndents.length || indent > listIndents.at(-1)!) listIndents.push(indent);
    return listIndents.length - 1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push({ key: i, kind: "code", text: line || " " });
      continue;
    }
    if (!line.trim()) {
      if (!prevBlank && out.length) out.push({ key: i, kind: "blank" });
      prevBlank = true;
      continue;
    }
    prevBlank = false;
    if (isTableRow(line) && isTableRule(lines[i + 1] ?? "")) {
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      out.push({ key: i, kind: "table", rows });
      listIndents = [];
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push({ key: i, kind: "heading", text: inline(`${heading[1]} ${heading[2]}`, theme), level: heading[1]!.length });
      listIndents = [];
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ key: i, kind: "rule" });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push({ key: i, kind: "quote", text: inline(quote[1]!, theme) });
      continue;
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const task = bullet[2]!.match(/^\[([ xX])\]\s+(.*)$/);
      out.push({ key: i, kind: "item", marker: task ? (task[1] === " " ? "☐ " : "☑ ") : "• ", depth: depthFor(bullet[1]!.length), text: inline(task ? task[2]! : bullet[2]!, theme) });
      continue;
    }
    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ordered) {
      out.push({ key: i, kind: "item", marker: `${ordered[2]}. `, markerColor: theme.listMarker, depth: depthFor(ordered[1]!.length), text: inline(ordered[3]!, theme) });
      continue;
    }
    if (!/^\s/.test(line)) listIndents = [];
    out.push({ key: i, kind: "para", text: inline(line, theme) });
  }
  return out;
}

/** Columns `Indent` leaves. */
const indented = (width: number, by: number) => Math.max(10, width - by);

/** `text` wrapped at `width`, one string per row. */
const linesOf = (text: string, width: number) => wrap(text, width).split("\n");

/**
 * Every row `Markdown` draws for `text` at `width`, each one line high: `Markdown` draws a run of
 * them, `markdownRows` counts them. `color` is the text's colour (`useTextColor`).
 */
function markdownLines(text: string, theme: Theme, width: number, color?: string): React.ReactElement[] {
  const rows: React.ReactElement[] = [];
  const add = (row: React.ReactElement) => rows.push(row);
  /** A marker (bullet, number) on the first row, the text hanging under it. */
  const hanging = (key: number, marker: string, markerColor: string | undefined, depth: number, text: string, style: React.ComponentProps<typeof Text>) =>
    linesOf(text, indented(width, depth * 3 + marker.length)).forEach((l, i) =>
      add(
        <Box key={`${key}.${i}`} paddingLeft={depth * 3}>
          <Text color={markerColor ?? color}>{i === 0 ? marker : " ".repeat(Bun.stringWidth(marker))}</Text>
          <Text color={color} {...style}>
            {l}
          </Text>
        </Box>,
      ),
    );
  const wrapped = (key: number | string, text: string, style: React.ComponentProps<typeof Text> = {}) =>
    linesOf(text, width).forEach((l, i) =>
      add(
        <Text key={`${key}.${i}`} color={color} {...style}>
          {l}
        </Text>,
      ),
    );
  for (const b of blocks(text, theme)) {
    switch (b.kind) {
      case "code":
        // Wrapped, never truncated: the spec shown is the whole spec. A blank line keeps its row
        // (wrapped, it would be empty and take none).
        if (b.text.trim()) wrapped(b.key, b.text, { color: theme.code });
        else add(<Text key={b.key}> </Text>);
        break;
      case "blank":
        add(<Text key={b.key}> </Text>);
        break;
      case "table": {
        // Aligned columns when they fit the width; otherwise one `a · b · c` line per row.
        const cols = Math.max(...b.rows.map((r) => r.length));
        const plain = b.rows.map((r) => r.map((c) => inline(c, theme)));
        const widths = columnWidths(plain);
        const fits = tableFits(plain, width);
        plain.forEach((r, i) => {
          if (!fits) return wrapped(`${b.key}.${i}`, r.join(chalk.dim(" · ")), { bold: i === 0 });
          add(
            <Text key={`${b.key}.${i}`} bold={i === 0} color={color}>
              {r.map((c, j) => c + " ".repeat(j < cols - 1 ? widths[j]! - Bun.stringWidth(c) + 2 : 0)).join("")}
            </Text>,
          );
        });
        break;
      }
      case "heading":
        wrapped(b.key, b.text, { bold: b.level <= 3, italic: b.level >= 3 });
        break;
      case "rule":
        add(
          <Text key={b.key} dimColor>
            {"─".repeat(Math.min(40, width))}
          </Text>,
        );
        break;
      case "quote":
        hanging(b.key, "│ ", undefined, 0, b.text, { italic: true, dimColor: true });
        break;
      case "item":
        hanging(b.key, b.marker, b.markerColor, b.depth, b.text, {});
        break;
      case "para":
        wrapped(b.key, b.text);
        break;
    }
  }
  return rows;
}

/** Rows `Markdown` takes for `text` at `width` (to cut or scroll it without measuring). */
export function markdownRows(text: string, theme: Theme, width: number): number {
  return markdownLines(text, theme, width).length;
}

// Codex: markdown_render.rs (a subset) — no fences or backticks, `• ` bullets, inline code in the
// accent, ordered markers light blue.
/**
 * `text` as Markdown, or only `count` of its rows from `from`: a box shows part of a text by
 * drawing only those rows, never by clipping it. Ink applies only the innermost `overflow`
 * clip, so a clipped box inside the scrolled chat drew its rows outside the chat (BUG-199).
 */
export function Markdown({ text, theme, from = 0, count }: { text: string; theme: Theme; from?: number; count?: number }) {
  const rows = markdownLines(text, theme, useWidth(), useTextColor());
  return <Box flexDirection="column">{rows.slice(from, count === undefined ? undefined : from + count)}</Box>;
}
