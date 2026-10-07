/** The composer's text and cursor; every edit returns a new draft. */
export interface Draft {
  text: string;
  cursor: number;
}

export const EMPTY: Draft = { text: "", cursor: 0 };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Offsets where a user-perceived character (an emoji, a letter with its marks) starts, plus the
 * end, within `window` code units around `i` (segmenting a huge paste on every key is too slow).
 */
function boundaries(text: string, i = 0, window = Infinity): number[] {
  const from = Math.max(0, i - window);
  const to = Math.min(text.length, i + window);
  const out = [...graphemes.segment(text.slice(from, to))].map((s) => from + s.index);
  out.push(to);
  return out;
}

/** The character boundary before / after `i` (never inside a surrogate pair or grapheme cluster). */
export function prevBoundary(text: string, i: number): number {
  let prev = Math.max(0, i - 64);
  for (const b of boundaries(text, i, 64)) {
    if (b >= i) return prev;
    prev = b;
  }
  return prev;
}

export function nextBoundary(text: string, i: number): number {
  for (const b of boundaries(text, i, 64)) if (b > i) return b;
  return text.length;
}

export function insert(d: Draft, s: string): Draft {
  const clean = s.replace(/\r\n?/g, "\n");
  return { text: d.text.slice(0, d.cursor) + clean + d.text.slice(d.cursor), cursor: d.cursor + clean.length };
}

export function backspace(d: Draft): Draft {
  if (d.cursor === 0) return d;
  const at = prevBoundary(d.text, d.cursor);
  return { text: d.text.slice(0, at) + d.text.slice(d.cursor), cursor: at };
}

/** The Delete key: removes the character after the cursor. */
export function deleteForward(d: Draft): Draft {
  if (d.cursor >= d.text.length) return d;
  return { text: d.text.slice(0, d.cursor) + d.text.slice(nextBoundary(d.text, d.cursor)), cursor: d.cursor };
}

export function deleteWordBack(d: Draft): Draft {
  const before = d.text.slice(0, d.cursor).replace(/\S+\s*$|\s+$/, "");
  return { text: before + d.text.slice(d.cursor), cursor: before.length };
}

export function killToStart(d: Draft): Draft {
  const start = d.text.lastIndexOf("\n", d.cursor - 1) + 1;
  return { text: d.text.slice(0, start) + d.text.slice(d.cursor), cursor: start };
}

/** Moves by `by` characters (graphemes). */
export function move(d: Draft, by: number): Draft {
  let cursor = d.cursor;
  for (let i = 0; i < Math.abs(by); i++) cursor = by < 0 ? prevBoundary(d.text, cursor) : nextBoundary(d.text, cursor);
  return { ...d, cursor };
}

export function home(d: Draft): Draft {
  return { ...d, cursor: d.text.lastIndexOf("\n", d.cursor - 1) + 1 };
}

export function end(d: Draft): Draft {
  const nl = d.text.indexOf("\n", d.cursor);
  return { ...d, cursor: nl === -1 ? d.text.length : nl };
}

/** Whether the cursor is on the first / last line of a multi-line draft. */
export const onFirstLine = (d: Draft) => d.text.lastIndexOf("\n", d.cursor - 1) === -1;
export const onLastLine = (d: Draft) => d.text.indexOf("\n", d.cursor) === -1;

/** Moves to the previous (-1) or next (1) line, keeping the column where the line allows. */
export function moveLine(d: Draft, dir: -1 | 1): Draft {
  const start = d.text.lastIndexOf("\n", d.cursor - 1) + 1;
  const col = d.cursor - start;
  let target: number;
  if (dir < 0) {
    if (start === 0) return { ...d, cursor: 0 };
    target = d.text.lastIndexOf("\n", start - 2) + 1;
  } else {
    const nl = d.text.indexOf("\n", d.cursor);
    if (nl === -1) return { ...d, cursor: d.text.length };
    target = nl + 1;
  }
  const lineEnd = d.text.indexOf("\n", target);
  const at = Math.min(target + col, lineEnd === -1 ? d.text.length : lineEnd);
  // Snap back onto a character boundary.
  return { ...d, cursor: boundaries(d.text, at, 64).includes(at) ? at : prevBoundary(d.text, at) };
}

/** Tabs as spaces to the next multiple of `stop` (terminals and Ink disagree on a tab's width). */
export function expandTabs(line: string, stop = 4): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const ch of line) out += ch === "\t" ? " ".repeat(stop - (Bun.stringWidth(out) % stop)) : ch;
  return out;
}
