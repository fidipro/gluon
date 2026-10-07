/**
 * Gluon: paints a session's screen model into a rectangle of the real terminal (the frame's
 * interior). Only rows that changed since the last paint are written; each with an absolute move
 * and its cells from an SGR reset. Never EL/ED (they would erase outside the frame): blanks are
 * written as spaces. Clipped to the rectangle; a wide character cut by the right edge becomes a
 * space. A wide character's two cells are blanked before it is drawn, and after it (or one made of
 * several code points, whose width terminals disagree on) the cursor is moved again, so a terminal
 * that draws it narrower or wider can't shift the rest of the row or keep a stale cell.
 */
import type { PaintCell, TermScreen } from "./screen.ts";

/** 0-based position and size on the real terminal. */
export interface Rect {
  top: number;
  left: number;
  cols: number;
  rows: number;
}

export interface PaintOptions {
  /** Rows scrolled back (`TermScreen.cells`); the cursor is hidden while > 0. */
  scrollOffset?: number;
  /** Repaint every row (as after `invalidate`). */
  force?: boolean;
}

export type PaintSource = Pick<TermScreen, "cols" | "rows" | "cells" | "cursor" | "cursorVisible">;

export interface Painter {
  readonly rect: Rect;
  /** The bytes that bring the rectangle (and the cursor) in line with `screen`; "" when nothing changed. */
  paint(screen: PaintSource, opts?: PaintOptions): string;
  /** Forget what the terminal shows: the next paint writes every row (after a switch, a redraw of the chrome). */
  invalidate(): void;
  /** Move or resize the rectangle; invalidates. */
  resize(rect: Rect): void;
}

/** Begin / end a synchronized update (`?2026`): terminals without it ignore both. */
export const beginSync = () => "\x1b[?2026h";
export const endSync = () => "\x1b[?2026l";
/** How long to wait for a session that has `?2026` on before painting anyway. */
export const SYNC_WAIT_MS = 150;
/** The session is in the middle of a synchronized update: wait (≤ `SYNC_WAIT_MS`) before painting it. */
export const syncPending = (screen: Pick<TermScreen, "modes">) => screen.modes().syncOutput;

const cup = (row: number, col: number) => `\x1b[${row + 1};${col + 1}H`;
const MULTI = /[̀-ͯ‍️]|[\ud800-\udbff][\udc00-\udfff]./;

export function createPainter(initial: Rect): Painter {
  let rect = { ...initial };
  let painted: (string | undefined)[] = [];
  let cursorWas: string | undefined;

  const row = (cells: PaintCell[], y: number): string => {
    const r = rect.top + y;
    let out = "\x1b[0m";
    let sgr = "0";
    const put = (s: string, ch: string) => {
      if (s !== sgr) out += `\x1b[${s}m`;
      sgr = s;
      out += ch;
    };
    for (let x = 0; x < rect.cols; ) {
      const c = cells[x];
      if (!c) {
        put("0", " ");
        x++;
        continue;
      }
      if (c.width === 2) {
        if (x + 1 >= rect.cols) {
          put(c.sgr, " "); // its right half is outside the rectangle
          x++;
          continue;
        }
        // Both cells blanked first, then the character over them: a terminal that draws it one
        // cell wide leaves a blank in the second cell, never what was there before (BUG-166).
        put(c.sgr, "  ");
        out += cup(r, rect.left + x) + (c.char || " ");
        x += 2;
        if (x < rect.cols) out += cup(r, rect.left + x);
        continue;
      }
      // A right half with no left half (shouldn't happen) is a space.
      const ch = c.width === 0 ? " " : c.char || " ";
      put(c.sgr, ch);
      x++;
      if (ch.length > 1 && MULTI.test(ch) && x < rect.cols) out += cup(r, rect.left + x);
    }
    return out;
  };

  return {
    get rect() {
      return { ...rect };
    },
    paint(screen, opts = {}) {
      const off = Math.max(0, opts.scrollOffset ?? 0);
      if (opts.force) this.invalidate();
      let out = "";
      for (let y = 0; y < rect.rows; y++) {
        const bytes = row(y < screen.rows ? screen.cells(y, off) : [], y);
        if (painted[y] === bytes) continue;
        painted[y] = bytes;
        out += cup(rect.top + y, rect.left) + bytes;
      }
      if (out) out += "\x1b[0m";
      const { x, y } = screen.cursor();
      const shown = off === 0 && screen.cursorVisible() && x < rect.cols && y < rect.rows && y < screen.rows;
      const cursor = shown ? `${cup(rect.top + y, rect.left + x)}\x1b[?25h` : "\x1b[?25l";
      if (out || cursor !== cursorWas) out += cursor;
      cursorWas = cursor;
      return out;
    },
    invalidate() {
      painted = [];
      cursorWas = undefined;
    },
    resize(r) {
      rect = { ...r };
      this.invalidate();
    },
  };
}
