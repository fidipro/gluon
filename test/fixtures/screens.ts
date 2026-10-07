/**
 * Screens captured from the real harnesses (`screens/<harness>/<version>.json`): for each state,
 * the keys typed since the start, the screen as escape sequences (`ansi`, from the screen model's
 * `serialize()`), and what the screen model read from the harness's own output (`rows`: text and
 * runs `[from, to, flags, fg, bg]` of non-default cells by cell index, flags `i` inverse, `b` bold, `d` faint (recorded from Antigravity on);
 * `cursor`; `size` when the state was captured at another size than the file's: inside Gluon's frame;
 * `version` when it was captured from another version than the file's, added later: the notes say how).
 * Never Enter on /clear or /compact; no prompt reached a model.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "../../src/harnesses.ts";
import { createScreen } from "../../src/pty/screen.ts";
import type { Cell, Screen } from "../../src/pty/types.ts";

export interface ScreenState {
  name: string;
  version?: string;
  size?: { cols: number; rows: number };
  keys: string[];
  cursor: { x: number; y: number };
  ansi: string;
  rows: { text: string; runs: [number, number, string, number, number][] }[];
}

export interface ScreenFixture {
  harness: Harness;
  version: string;
  cols: number;
  rows: number;
  notes: string;
  states: ScreenState[];
}

const DIR = join(import.meta.dir, "screens");

let cache: ScreenFixture[] | undefined;
export function loadFixtures(): ScreenFixture[] {
  return (cache ??= readdirSync(DIR).flatMap((h) =>
    readdirSync(join(DIR, h))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(DIR, h, f), "utf8")) as ScreenFixture),
  ));
}

export function fixture(harness: Harness): ScreenFixture {
  const f = loadFixtures().find((x) => x.harness === harness);
  if (!f) throw new Error(`no captured screens for ${harness}`);
  return f;
}

export function state(f: ScreenFixture, name: string): ScreenState {
  const s = f.states.find((x) => x.name === name);
  if (!s) throw new Error(`${f.harness} ${f.version}: no state ${name}`);
  return s;
}

/** The size the state was captured at. */
export const sizeOf = (f: ScreenFixture, s: ScreenState) => s.size ?? { cols: f.cols, rows: f.rows };

/** A screen model showing the state. */
export async function screenOf(f: ScreenFixture, s: ScreenState | string): Promise<Screen> {
  const st = typeof s === "string" ? state(f, s) : s;
  const { cols, rows } = sizeOf(f, st);
  const screen = createScreen(cols, rows);
  await screen.write(st.ansi);
  return screen;
}

/** Runs' flags: `i` inverse, `b` bold, `d` faint. */
const flagsOf = (c: Omit<Cell, "char">) => `${c.inverse ? "i" : ""}${c.bold ? "b" : ""}${c.dim ? "d" : ""}`;

/** A row of cells in the recorded shape: its text and the runs of cells that aren't all default, by cell index. */
export function recordRow(text: string, cells: readonly Cell[]): ScreenState["rows"][number] {
  const runs: ScreenState["rows"][number]["runs"] = [];
  cells.forEach((c, x) => {
    const flags = flagsOf(c);
    if (!flags && c.fg === -1 && c.bg === -1) return;
    const last = runs.at(-1);
    if (last && last[1] === x && last[2] === flags && last[3] === c.fg && last[4] === c.bg) last[1] = x + 1;
    else runs.push([x, x + 1, flags, c.fg, c.bg]);
  });
  return { text, runs };
}

/** The recorded rows as cells (inverse, bold, fg, bg). */
export function recordedCells(s: ScreenState, cells: Cell[][]): Omit<Cell, "dim">[][] {
  return s.rows.map((r, y) =>
    cells[y]!.map((c, x) => {
      const run = r.runs.find(([from, to]) => x >= from && x < to);
      return { char: c.char, inverse: !!run?.[2].includes("i"), bold: !!run?.[2].includes("b"), fg: run?.[3] ?? -1, bg: run?.[4] ?? -1 };
    }),
  );
}
