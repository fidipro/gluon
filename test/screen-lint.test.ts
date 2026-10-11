/**
 * The screen lints' own rules (`test/e2e/screen-lint.ts`), on frames built here: no terminal needed.
 */
import { describe, expect, test } from "bun:test";
import type { Cell, Frame } from "./e2e/frame.ts";
import { lint } from "./e2e/screen-lint.ts";

const cell = (ch: string): Cell => ({ ch, w: 1, fg: null, bg: "#000000", bold: false, dim: false, italic: false, underline: false, inverse: false });

/** A home frame of `cols` columns whose rows are `rows` (padded with blanks; the last row stays empty). */
const home = (cols: number, rows: string[]): Frame => ({
  scene: "unit",
  cols,
  rows: rows.length + 1,
  theme: "dark",
  cells: [...rows, ""].map((r) => Array.from({ length: cols }, (_, x) => cell(r[x] ?? " "))),
  cursor: { x: 0, y: 0, visible: false },
  wrapped: Array.from({ length: rows.length + 1 }, () => false),
});

const cuts = (f: Frame) => lint(f).filter((p) => p.startsWith("cut:"));

describe("screen lint: cut, the home view's right margin", () => {
  test("BUG-723/tiny home view: text may fill a terminal under 24 columns, where Gluon draws no side margin", () => {
    // 19 columns (the matrix's h.tooSmall): the chat's rows run to the last column, as the rules do.
    expect(cuts(home(19, ["    start a session", "    with the right"]))).toEqual([]);
    expect(cuts(home(23, ["x".repeat(23)]))).toEqual([]);
  });

  test("from 24 columns the home view's 2-column right margin is still kept", () => {
    const at24 = cuts(home(24, ["    text into the margin"]));
    expect(at24).toHaveLength(1);
    expect(at24[0]).toContain("runs into the right margin (column 23)");
    expect(cuts(home(80, ["x".repeat(79)]))).toHaveLength(1);
    expect(cuts(home(80, [`${"x".repeat(78)}…`]))).toEqual([]);
    expect(cuts(home(80, ["x".repeat(78)]))).toEqual([]);
  });
});
