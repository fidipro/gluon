import { describe, expect, test } from "bun:test";
import { createScreen, type TermScreen } from "../src/pty/screen.ts";
import type { Screen } from "../src/pty/types.ts";
import { loadFixtures, recordedCells, screenOf } from "./fixtures/screens.ts";

/** Every visible cell (text and attributes) and the cursor. */
function snapshot(s: Screen) {
  return { cursor: s.cursor(), rows: Array.from({ length: s.rows }, (_, y) => s.line(y)) };
}

async function roundTrip(s: Screen) {
  const copy = createScreen(s.cols, s.rows);
  await copy.write("garbage that the redraw must clear\r\n\x1b[41mred\x1b[0m");
  await copy.write(s.serialize());
  expect(snapshot(copy)).toEqual(snapshot(s));
  copy.dispose();
}

/** A CPU-bound test (every captured screen through xterm): 1-2 s alone, so bun's 5 s default fails it on a loaded machine (the unit shards run side by side). */
const HEAVY_MS = 30_000;

describe("screen model", () => {
  test("reads text, attributes and the cursor", async () => {
    const s = createScreen(20, 4);
    await s.write("ab\x1b[7mcd\x1b[0m \x1b[1;31mE\x1b[0m\x1b[38;2;1;2;3mR\x1b[48;5;200mG\x1b[0m\r\n> x");
    const l = s.line(0);
    expect(l.text).toBe("abcd ERG");
    expect(l.cells[2]).toEqual({ char: "c", inverse: true, bold: false, dim: false, fg: -1, bg: -1 });
    expect(l.cells[5]).toEqual({ char: "E", inverse: false, bold: true, dim: false, fg: 1, bg: -1 });
    expect(l.cells[6]!.fg).toBe(0x010203);
    expect(l.cells[7]!.bg).toBe(200);
    expect(s.line(1).text).toBe("> x");
    expect(s.cursor()).toEqual({ x: 3, y: 1 });
    expect(s.line(99)).toEqual({ text: "", cells: [] });
    s.dispose();
  });

  test("keeps only the visible screen and follows a resize", async () => {
    const s = createScreen(10, 3);
    await s.write("1\r\n2\r\n3\r\n4");
    expect([0, 1, 2].map((y) => s.line(y).text)).toEqual(["2", "3", "4"]);
    s.resize(30, 5);
    expect([s.cols, s.rows]).toEqual([30, 5]);
    s.dispose();
  });

  test("serialize round-trips text, every attribute, wide characters and the cursor", async () => {
    const s = createScreen(24, 6);
    await s.write("\x1b[1mbold\x1b[2mdim\x1b[0m\x1b[3mit\x1b[4mul\x1b[5mbl\x1b[0m\r\n");
    await s.write("\x1b[7minv\x1b[8mhid\x1b[9mst\x1b[53mov\x1b[0m\r\n");
    await s.write("\x1b[31;42mp\x1b[91;102mq\x1b[38;5;123;48;5;45mr\x1b[38;2;10;20;30;48;2;40;50;60ms\x1b[0m\r\n");
    await s.write("中文 ok ❯ │ ┃\r\n");
    await s.write("\x1b[44m  blue tail  \x1b[0m\r\n");
    await s.write("\x1b[6;24Hz\x1b[3;7H");
    await roundTrip(s);
    s.dispose();
  });

  test("serialize restores a hidden cursor and insert mode", async () => {
    const s = createScreen(10, 2);
    await s.write("hi\x1b[?25l\x1b[4h");
    const out = s.serialize();
    expect(out).toContain("\x1b[?25l");
    expect(out.endsWith("\x1b[?25l")).toBe(true);
    expect(out).toContain("\x1b[4h");
    await s.write("\x1b[?25h\x1b[4l");
    expect(s.serialize()).toContain("\x1b[?25h");
    expect(s.serialize()).not.toContain("\x1b[4h");
    s.dispose();
  });

  test("the redraw of a captured screen shows what the harness's own output showed", async () => {
    for (const f of loadFixtures())
      for (const state of f.states) {
        const s = await screenOf(f, state);
        const cells = Array.from({ length: s.rows }, (_, y) => s.line(y).cells);
        expect({ state: state.name, text: cells.map((_, y) => s.line(y).text) }).toEqual({ state: state.name, text: state.rows.map((r) => r.text.trimEnd()) });
        expect(cells.map((row) => row.map(({ dim: _, ...c }) => c))).toEqual(recordedCells(state, cells));
        expect(s.cursor()).toEqual(state.cursor);
        s.dispose();
      }
  }, HEAVY_MS);

  test("serialize round-trips every captured harness screen @full", async () => {
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures)
      for (const state of f.states) {
        const s = await screenOf(f, state);
        await roundTrip(s);
        s.dispose();
      }
  }, HEAVY_MS);
});

describe("screen model: scrollback", () => {
  test("line() stays the live screen; viewLine() and cells() scroll back into history", async () => {
    const s = createScreen(10, 3, { scrollback: 5 });
    await s.write(Array.from({ length: 12 }, (_, i) => `L${i}`).join("\r\n"));
    expect([0, 1, 2].map((y) => s.line(y).text)).toEqual(["L9", "L10", "L11"]);
    expect(s.scrollbackLength()).toBe(5);
    expect([0, 1, 2].map((y) => s.viewLine(y, 2).text)).toEqual(["L7", "L8", "L9"]);
    // Past the oldest kept row: the oldest view.
    expect([0, 1, 2].map((y) => s.viewLine(y, 99).text)).toEqual(["L4", "L5", "L6"]);
    expect(s.cells(0, 5).map((c) => c.char).join("")).toBe("L4");
    expect(s.cells(3, 1)).toEqual([]);
    s.dispose();
  });

  test("none by default, none on the alternate screen", async () => {
    const s = createScreen(10, 2);
    await s.write("1\r\n2\r\n3\r\n4");
    expect(s.scrollbackLength()).toBe(0);
    expect(s.viewLine(0, 3).text).toBe("3");
    const t = createScreen(10, 2, { scrollback: 100 });
    await t.write("1\r\n2\r\n3\r\n4\x1b[?1049h\x1b[Halt");
    expect(t.altScreen()).toBe(true);
    expect(t.scrollbackLength()).toBe(0);
    expect(t.viewLine(0, 2).text).toBe("alt");
    await t.write("\x1b[?1049l");
    expect(t.scrollbackLength()).toBe(2);
    s.dispose();
    t.dispose();
  });
});

describe("screen model: cells for painting", () => {
  test("every column, every attribute, palette and RGB told apart, wide characters", async () => {
    const s = createScreen(12, 2);
    await s.write("\x1b[1;3;4;9;53;38;5;5;48;2;0;0;5mA\x1b[0;2;5;7;8;38;2;0;0;5;45mB\x1b[0m中x");
    const c = s.cells(0);
    expect(c).toHaveLength(12);
    expect(c[0]).toEqual({
      char: "A",
      width: 1,
      fg: 5,
      bg: 5,
      fgMode: "palette",
      bgMode: "rgb",
      bold: true,
      dim: false,
      italic: true,
      underline: true,
      blink: false,
      inverse: false,
      invisible: false,
      strike: true,
      overline: true,
      sgr: "0;1;3;4;9;53;35;48;2;0;0;5",
    });
    expect(c[1]).toMatchObject({ char: "B", fg: 5, bg: 5, fgMode: "rgb", bgMode: "palette", dim: true, blink: true, inverse: true, invisible: true, sgr: "0;2;5;7;8;38;2;0;0;5;45" });
    expect(c[2]).toMatchObject({ char: "中", width: 2 });
    expect(c[3]).toMatchObject({ char: "", width: 0 });
    expect(c[4]).toMatchObject({ char: "x", width: 1, sgr: "0" });
    expect(c[5]).toMatchObject({ char: "", width: 1, sgr: "0" });
    s.dispose();
  });

  test("Unicode 11 widths: emoji newer than Unicode 6 are wide, as real terminals draw them", async () => {
    const s = createScreen(12, 1);
    await s.write("🤖🦀a");
    expect(s.cells(0).slice(0, 5).map((c) => c.width)).toEqual([2, 0, 2, 0, 1]);
    expect(s.cursor()).toEqual({ x: 5, y: 0 });
    s.dispose();
  });
});

describe("screen model: replies, bell, title", () => {
  const replies = (s: TermScreen) => {
    const got: string[] = [];
    s.onReply((r) => got.push(r));
    return got;
  };

  test("xterm's replies to DA1, CPR and DECRQM come out in order", async () => {
    const s = createScreen(20, 4);
    const got = replies(s);
    await s.write("\x1b[c\x1b[2;3H\x1b[6n\x1b[?2026$p");
    expect(got).toEqual(["\x1b[?1;2c", "\x1b[2;3R", "\x1b[?2026;2$y"]);
    s.dispose();
  });

  test("OSC 10 / 11 / 12 are answered from the colours given, else not at all", async () => {
    const s = createScreen(20, 4, { colours: { fg: [0xe0, 0xe0, 0xe0], bg: [0x1e, 0x1e, 0x2e], cursor: [255, 0, 127.6] } });
    const got = replies(s);
    await s.write("\x1b]11;?\x07\x1b]10;?\x1b\\\x1b]12;?\x07\x1b]10;?;?\x07");
    expect(got).toEqual([
      "\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\",
      "\x1b]10;rgb:e0e0/e0e0/e0e0\x1b\\",
      "\x1b]12;rgb:ffff/0000/8080\x1b\\",
      "\x1b]10;rgb:e0e0/e0e0/e0e0\x1b\\",
      "\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\",
    ]);
    got.length = 0;
    await s.write("\x1b]11;#000000\x07");
    expect(got).toEqual([]);
    const t = createScreen(20, 4, { colours: { bg: [0, 0, 0] } });
    const none = replies(t);
    await t.write("\x1b]10;?\x07\x1b]12;?\x07");
    expect(none).toEqual([]);
    s.dispose();
    t.dispose();
  });

  test("CSI ? u is answered only when the real terminal speaks kitty, with the flags in effect", async () => {
    const off = createScreen(20, 4);
    const offGot = replies(off);
    await off.write("\x1b[?u\x1b[>1u\x1b[?u");
    expect(offGot).toEqual([]);
    const on = createScreen(20, 4, { kitty: true });
    const onGot = replies(on);
    await on.write("\x1b[?u\x1b[>11u\x1b[?u\x1b[<u\x1b[?u");
    expect(onGot).toEqual(["\x1b[?0u", "\x1b[?11u", "\x1b[?0u"]);
    off.dispose();
    on.dispose();
  });

  test("one ordered queue: a kitty reply comes before the DA1 reply after it, however the input is split", async () => {
    const input = "\x1b[?u\x1b]11;?\x07\x1b[c\x1b[6n";
    const want = ["\x1b[?0u", "\x1b]11;rgb:0000/0000/0000\x1b\\", "\x1b[?1;2c", "\x1b[1;1R"];
    for (let cut = 0; cut <= input.length; cut++) {
      const s = createScreen(20, 4, { kitty: true, colours: { bg: [0, 0, 0] } });
      const got = replies(s);
      await s.write(input.slice(0, cut));
      await s.write(input.slice(cut));
      expect({ cut, got }).toEqual({ cut, got: want });
      s.dispose();
    }
  });

  test("a listener stops when it unsubscribes; bell, title and change are reported", async () => {
    const s = createScreen(20, 4);
    const got: string[] = [];
    const off = s.onReply((r) => got.push(r));
    let bells = 0;
    let changes = 0;
    const titles: string[] = [];
    s.onBell(() => bells++);
    s.onTitle((t) => titles.push(t));
    s.onChange(() => changes++);
    await s.write("\x1b[c");
    off();
    await s.write("\x1b[c\x07\x1b]2;working\x07\x1b]0;done\x1b\\");
    expect(got).toHaveLength(1);
    expect(bells).toBe(1);
    expect(titles).toEqual(["working", "done"]);
    expect(s.title()).toBe("done");
    expect(changes).toBeGreaterThan(0);
    s.dispose();
  });
});
