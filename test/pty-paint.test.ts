import { describe, expect, test } from "bun:test";
import xterm from "@xterm/headless";
import { createPainter, type Painter, syncPending } from "../src/pty/paint.ts";
import { createScreen, type PaintCell, type TermScreen } from "../src/pty/screen.ts";
import { loadFixtures, sizeOf } from "./fixtures/screens.ts";

/** The frame's interior on the outer terminal (0-based), as Gluon will place it. */
const TOP = 3;
const LEFT = 2;
const EL_ED = /\x1b\[[0-9;?]*[JK]/;

/** A pattern in every cell, so a cell the painter misses (or one it touches outside the rectangle) shows. */
function border(cols: number, rows: number): string {
  let out = "";
  for (let y = 0; y < rows; y++) {
    out += `\x1b[${y + 1};1H\x1b[0;38;5;${16 + y};48;2;${y * 9};40;90m`;
    for (let x = 0; x < cols; x++) out += String.fromCharCode(65 + ((x + y) % 26));
  }
  return `${out}\x1b[0m\x1b[H`;
}

async function outerFor(w: number, h: number): Promise<{ outer: TermScreen; pristine: TermScreen }> {
  const outer = createScreen(w + 4, h + 6);
  const pristine = createScreen(w + 4, h + 6);
  await outer.write(border(w + 4, h + 6));
  await pristine.write(border(w + 4, h + 6));
  return { outer, pristine };
}

/** A painted blank is a space; a never-written cell reads "". */
const norm = (c: PaintCell | undefined) => (c ? { ...c, char: c.width === 0 ? c.char : c.char || " " } : c);

function expectInterior(outer: TermScreen, src: TermScreen, label: string, w = src.cols, h = src.rows, off = 0) {
  for (let y = 0; y < h; y++) {
    const want = src.cells(y, off).slice(0, w).map(norm);
    const got = outer.cells(TOP + y).slice(LEFT, LEFT + w).map(norm);
    expect({ label, y, row: got }).toEqual({ label, y, row: want });
  }
}

function expectBorder(outer: TermScreen, pristine: TermScreen, w: number, h: number, label: string) {
  for (let y = 0; y < outer.rows; y++) {
    const got = outer.cells(y);
    const want = pristine.cells(y);
    for (let x = 0; x < outer.cols; x++) {
      if (y >= TOP && y < TOP + h && x >= LEFT && x < LEFT + w) continue;
      expect({ label, y, x, cell: got[x] }).toEqual({ label, y, x, cell: want[x] });
    }
  }
}

/** Paints `src` into a fresh outer terminal and checks every interior and border cell. */
async function roundTrip(src: TermScreen, label: string, painter?: Painter): Promise<{ outer: TermScreen; painter: Painter; bytes: string }> {
  const { outer, pristine } = await outerFor(src.cols, src.rows);
  const p = painter ?? createPainter({ top: TOP, left: LEFT, cols: src.cols, rows: src.rows });
  const bytes = p.paint(src);
  expect(bytes).not.toMatch(EL_ED);
  await outer.write(bytes);
  expectInterior(outer, src, label);
  expectBorder(outer, pristine, src.cols, src.rows, label);
  pristine.dispose();
  return { outer, painter: p, bytes };
}

/** Rows (1-based) that a paint moved the cursor to. */
const rowsMoved = (bytes: string) => new Set([...bytes.matchAll(/\x1b\[(\d+);(\d+)H/g)].map((m) => Number(m[1])));

const SYNTHETIC: Record<string, string> = {
  "emoji and CJK": "😀 a🤖b 中文字 ｶﾀｶﾅ 한국어\r\n🎉🎉🎉 end\r\n❯ │ ┃ ─ ╭╮",
  "wide character at the last column": "123456789😀x\r\n12345678901中",
  "combining marks and variation selectors": "é ä ❤️ ✔️ ok\r\n👍🏽 skin",
  "palette, 256 and RGB colours": "\x1b[31mr\x1b[92mg\x1b[38;5;123mx\x1b[48;5;45my\x1b[38;2;1;2;3mz\x1b[48;2;0;0;5mw\x1b[0m\x1b[38;5;5mP\x1b[38;2;0;0;5mR\x1b[0m",
  "every attribute": "\x1b[1mb\x1b[0;2md\x1b[0;3mi\x1b[0;4mu\x1b[0;5mk\x1b[0;7mv\x1b[0;8mh\x1b[0;9ms\x1b[0;53mo\x1b[0;1;3;4;7;38;2;200;100;50;48;5;17mall\x1b[0m",
  "inverse and underline runs with blanks": "\x1b[7m  inverse bar   \x1b[0m\r\n\x1b[4;44m under  \x1b[0m tail",
  "coloured blanks to the edge": "\x1b[44m\x1b[2K\x1b[0m\r\n\x1b[41m               \x1b[0m",
};

/** A CPU-bound test (every captured screen through xterm): ~3 s alone, so bun's 5 s default fails it on a loaded machine (the unit shards run side by side). */
const HEAVY_MS = 30_000;

describe("painter: the frame's interior shows the screen model cell for cell", () => {
  test("every captured harness screen, painted at an offset, over a border pattern @full", async () => {
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(4);
    for (const f of fixtures)
      for (const state of f.states) {
        const { cols, rows } = sizeOf(f, state);
        const src = createScreen(cols, rows);
        await src.write(state.ansi);
        const { outer } = await roundTrip(src, `${f.harness} ${state.name}`);
        outer.dispose();
        src.dispose();
      }
  }, HEAVY_MS);

  test("emoji, CJK, combining marks, colours and every attribute", async () => {
    for (const [name, ansi] of Object.entries(SYNTHETIC)) {
      const src = createScreen(12, 5);
      await src.write(ansi);
      const { outer } = await roundTrip(src, name);
      outer.dispose();
      src.dispose();
    }
  });

  test("a screen wider and taller than the rectangle is clipped; a cut wide character is a space", async () => {
    const src = createScreen(20, 8);
    await src.write("abcdefghi中jklmnopqr\r\n\x1b[41m" + "x".repeat(20) + "\x1b[0m\r\nrow 3\r\n\r\n\r\n\r\n\r\nlast row");
    const w = 10;
    const h = 5;
    const { outer, pristine } = await outerFor(w, h);
    const bytes = createPainter({ top: TOP, left: LEFT, cols: w, rows: h }).paint(src);
    expect(bytes).not.toMatch(EL_ED);
    await outer.write(bytes);
    expectBorder(outer, pristine, w, h, "clipped");
    expect(outer.viewLine(TOP).text.slice(LEFT, LEFT + w)).toBe("abcdefghi ");
    expect(outer.cells(TOP + 1)[LEFT + w - 1]!.bg).toBe(1);
    expect(outer.cells(TOP + 1)[LEFT + w]!.char).toBe(pristine.cells(TOP + 1)[LEFT + w]!.char);
    for (const s of [outer, pristine, src]) s.dispose();
  });

  test("a screen smaller than the rectangle leaves blanks, not the old pattern", async () => {
    const src = createScreen(6, 2);
    await src.write("hi\r\nyo");
    const w = 9;
    const h = 4;
    const { outer, pristine } = await outerFor(w, h);
    await outer.write(createPainter({ top: TOP, left: LEFT, cols: w, rows: h }).paint(src));
    expectBorder(outer, pristine, w, h, "smaller");
    expect([0, 1, 2, 3].map((y) => outer.viewLine(TOP + y).text.slice(LEFT, LEFT + w))).toEqual(["hi       ", "yo       ", "         ", "         "]);
    expect(outer.cells(TOP + 3)[LEFT]).toMatchObject({ char: " ", sgr: "0" });
    for (const s of [outer, pristine, src]) s.dispose();
  });
});

describe("painter: damage", () => {
  test("a later paint writes only the rows that changed; no change writes nothing", async () => {
    const src = createScreen(16, 6);
    await src.write("one\r\ntwo\r\nthree 中\r\nfour\r\nfive\x1b[1;1H");
    const { outer, painter, bytes } = await roundTrip(src, "first");
    expect(rowsMoved(bytes).size).toBe(6);
    expect(painter.paint(src)).toBe("");

    await src.write("\x1b[3;2H\x1b[1;35mHR\x1b[0m\x1b[3;1H");
    const again = painter.paint(src);
    expect(rowsMoved(again)).toEqual(new Set([TOP + 3]));
    await outer.write(again);
    expectInterior(outer, src, "after a change");

    // Only the cursor moved: just the cursor.
    await src.write("\x1b[5;4H");
    expect(painter.paint(src)).toBe(`\x1b[${TOP + 5};${LEFT + 4}H\x1b[?25h`);
    // A hidden cursor is hidden, with no move.
    await src.write("\x1b[?25l");
    expect(painter.paint(src)).toBe("\x1b[?25l");
    await src.write("\x1b[?25h");
    expect(painter.paint(src)).toEndWith("\x1b[?25h");
    outer.dispose();
    src.dispose();
  });

  test("invalidate and force repaint every row; resize moves the rectangle", async () => {
    const src = createScreen(8, 3);
    await src.write("a\r\nb\r\nc");
    const painter = createPainter({ top: TOP, left: LEFT, cols: 8, rows: 3 });
    painter.paint(src);
    painter.invalidate();
    expect(rowsMoved(painter.paint(src)).size).toBe(3);
    expect(rowsMoved(painter.paint(src, { force: true })).size).toBe(3);
    painter.resize({ top: 1, left: 0, cols: 8, rows: 3 });
    expect(painter.rect).toEqual({ top: 1, left: 0, cols: 8, rows: 3 });
    const moved = painter.paint(src);
    expect(moved).toStartWith("\x1b[2;1H");
    expect(rowsMoved(moved)).toEqual(new Set([2, 3, 4]));
    src.dispose();
  });

  // The painter moves the cursor after a wide character so a terminal that draws it narrower
  // can't shift the rest of the row; but the cell it skips keeps whatever the terminal had there.
  // Seen with a ZWJ family emoji in a session: `GOT <👨‍x👩‍c👧m …>` (the old row's letters).
  test("BUG-166/E: a terminal that draws a wide character narrower shows no stale cell after it", async () => {
    const src = createScreen(12, 1);
    const painter = createPainter({ top: 0, left: 0, cols: 12, rows: 1 });
    // Unicode 6 widths (no unicode11 addon): this terminal draws 🙂 in one cell.
    const outer = new xterm.Terminal({ cols: 12, rows: 1, allowProposedApi: true });
    const put = (bytes: string) => new Promise<void>((r) => outer.write(bytes, r));
    await src.write("XXXXXXXXXXXX");
    await put(painter.paint(src));
    await src.write("\r\x1b[2K🙂🙂ab");
    await put(painter.paint(src));
    expect(outer.buffer.active.getLine(0)!.translateToString(true)).not.toContain("X");
    outer.dispose();
    src.dispose();
  });

  test("the cursor goes to the harness's cursor plus the offset", async () => {
    const src = createScreen(10, 4);
    await src.write("x\x1b[3;7H");
    const out = createPainter({ top: TOP, left: LEFT, cols: 10, rows: 4 }).paint(src);
    expect(out).toEndWith(`\x1b[${TOP + 3};${LEFT + 7}H\x1b[?25h`);
    src.dispose();
  });
});

describe("painter: scrolled back", () => {
  test("shows history rows, hides the cursor, and comes back to the live screen", async () => {
    const src = createScreen(10, 4, { scrollback: 100 });
    await src.write(Array.from({ length: 20 }, (_, i) => `\x1b[3${i % 8}mL${i}`).join("\r\n"));
    expect(src.scrollbackLength()).toBe(16);
    const painter = createPainter({ top: TOP, left: LEFT, cols: 10, rows: 4 });
    const { outer } = await outerFor(10, 4);
    const back = painter.paint(src, { scrollOffset: 3 });
    expect(back).toEndWith("\x1b[?25l");
    await outer.write(back);
    expectInterior(outer, src, "scrolled", 10, 4, 3);
    expect(outer.viewLine(TOP).text.slice(LEFT, LEFT + 3)).toBe("L13");
    const live = painter.paint(src);
    expect(live).toEndWith("\x1b[?25h");
    await outer.write(live);
    expectInterior(outer, src, "live");
    outer.dispose();
    src.dispose();
  });
});

describe("painter: synchronized output", () => {
  test("syncPending follows the session's ?2026", async () => {
    const src = createScreen(10, 2);
    expect(syncPending(src)).toBe(false);
    await src.write("\x1b[?2026h");
    expect(syncPending(src)).toBe(true);
    await src.write("\x1b[?2026l");
    expect(syncPending(src)).toBe(false);
    src.dispose();
  });
});
