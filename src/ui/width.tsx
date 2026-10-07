import { Text } from "ink";
import { createContext, useContext } from "react";
import wrapAnsi from "wrap-ansi";
import { expandTabs } from "./editor.ts";

/**
 * Columns available to text at this point of the tree. Ink wraps with `trim: false`, which leaves
 * a space at the start of wrapped lines and can overflow a full line by one column; so prose is
 * wrapped here, knowing its width, before Ink sees it.
 */
const WidthContext = createContext(80);

export const useWidth = () => useContext(WidthContext);

/** Children get `by` fewer columns (for a prefix, indent, border or padding). */
export function Indent({ by, children }: { by: number; children: React.ReactNode }) {
  const width = useWidth();
  return <WidthContext.Provider value={Math.max(10, width - by)}>{children}</WidthContext.Provider>;
}

export function Width({ columns, children }: { columns: number; children: React.ReactNode }) {
  return <WidthContext.Provider value={Math.max(1, columns)}>{children}</WidthContext.Provider>;
}

/**
 * A separator between words (` · `, ` × `) goes with the word after it, so a line never ends in
 * one (BUG-267) — unless that word fits a line alone and the two don't: then the separator is
 * dropped at the break (`DANGLING`, its styles kept).
 */
const SEPARATOR = / ([·×]) (\S+)/g;
const DANGLING = / [·×]((?:\x1b\[[0-9;]*m)*)$/;
const GLUE = "\u00a0";

/**
 * Wraps at word boundaries to `width`. Each line keeps its leading indentation (tabs expanded),
 * and its wrapped continuation lines hang under the indented text. A ` · ` or ` × ` starts the
 * next line rather than ending this one (`claude code × sonnet 5.5 × medium` / `· recommended`).
 */
export function wrap(text: string, width: number): string {
  return text
    .split("\n")
    .map((line) => {
      const expanded = expandTabs(line);
      const indent = expanded.match(/^ */)![0].slice(0, Math.floor(width / 2));
      const room = width - indent.length;
      const glue = (all: string, sep: string, word: string) => (Bun.stringWidth(word) + 2 <= room ? ` ${sep}${GLUE}${word}` : all);
      const body = expanded.slice(indent.length).replace(SEPARATOR, glue);
      if (!body) return "";
      const rows = wrapAnsi(body, room, { hard: true, trim: true }).replaceAll(GLUE, " ").split("\n");
      return rows.map((l, i) => indent + (i < rows.length - 1 ? l.replace(DANGLING, "$1") : l)).join("\n");
    })
    .join("\n");
}

/** `text` may carry ANSI styles; it is wrapped at word boundaries to the available width. */
export function Wrapped({ text, ...style }: { text: string } & React.ComponentProps<typeof Text>) {
  const width = useWidth();
  const color = useContext(TextColorContext);
  return (
    <Text color={color} {...style}>
      {wrap(text, width)}
    </Text>
  );
}

/**
 * The colour of text that sets none, below this point (Ink doesn't pass a colour from a Box to
 * the Text in it). Gluon's view paints its own background, so its text can't be the terminal's.
 */
const TextColorContext = createContext<string | undefined>(undefined);

export function TextColor({ color, children }: { color: string; children: React.ReactNode }) {
  return <TextColorContext.Provider value={color}>{children}</TextColorContext.Provider>;
}

export const useTextColor = () => useContext(TextColorContext);
