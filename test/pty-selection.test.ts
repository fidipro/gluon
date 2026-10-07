/** Dragging over the home view's text (`src/pty/selection.ts`): which cells, what is copied, how they are painted (issue #62). */
import { describe, expect, test } from "bun:test";
import { createScreen } from "../src/pty/screen.ts";
import { copyText, diffSpans, osc52, paintSpans, spans, spansKey } from "../src/pty/selection.ts";

/** A screen of `cols` × `rows` showing `lines`, one per row. */
async function screenOf(lines: string[], cols = 40, rows = 8) {
  const s = createScreen(cols, rows);
  await s.write(lines.map((l, i) => `\x1b[${i + 1};1H${l}`).join(""));
  return s;
}

describe("spans", () => {
  test("BUG-286: a stream between two cells: the first row from its column, whole rows between, the last up to its column, both ends included", async () => {
    const s = await screenOf(["hello world", "second line", "third line"]);
    const sel = spans(s, { anchor: { x: 6, y: 0 }, head: { x: 4, y: 2 } });
    expect(sel.map((x) => [x.y, x.x0, x.x1, x.text])).toEqual([
      [0, 6, 40, "world"],
      [1, 0, 40, "second line"],
      [2, 0, 5, "third"],
    ]);
    // Dragged backwards, up and to the left: the same cells.
    expect(spans(s, { anchor: { x: 4, y: 2 }, head: { x: 6, y: 0 } })).toEqual(sel);
    // One row: the cells between, ends included.
    expect(spans(s, { anchor: { x: 7, y: 0 }, head: { x: 2, y: 0 } }).map((x) => x.text)).toEqual(["llo wo"]);
  });

  test("BUG-286: a wide character is selected whole whichever half the drag ends on", async () => {
    const s = await screenOf(["a日本b"]);
    // Cells: a(0) 日(1,2) 本(3,4) b(5). A drag from the right half of 日 to the left half of 本.
    expect(spans(s, { anchor: { x: 2, y: 0 }, head: { x: 3, y: 0 } }).map((x) => [x.x0, x.x1, x.text])).toEqual([[1, 5, "日本"]]);
  });

  test("BUG-286: the screen changing under a selection changes its key (so a repaint knows to drop it)", async () => {
    const s = await screenOf(["hello"]);
    const sel = { anchor: { x: 0, y: 0 }, head: { x: 4, y: 0 } };
    const before = spansKey(spans(s, sel));
    expect(spansKey(spans(s, sel))).toBe(before);
    await s.write("\x1b[1;1Hjello");
    expect(spansKey(spans(s, sel))).not.toBe(before);
  });
});

describe("copyText", () => {
  test("BUG-286: the spec box's edges and padding are left out; the chat's gutter and glyph too; trailing blank rows go", async () => {
    const s = await screenOf(["   ╭─ spec ────────────╮", "   │ Add the flag       │", "   │ and test it        │", "   ╰────────────────────╯", " ◆  The spec is above.", "    Say go.", ""], 30);
    const all = spans(s, { anchor: { x: 0, y: 1 }, head: { x: 29, y: 2 } });
    expect(copyText(all)).toBe("Add the flag\nand test it");
    const chat = spans(s, { anchor: { x: 0, y: 4 }, head: { x: 29, y: 6 } });
    expect(copyText(chat)).toBe("The spec is above.\nSay go.");
  });

  test("BUG-286: a drag that begins in the page's padding copies the same as one from column 0: whole rows lose the glyph and the shared indent, the rows' own indent between them stays", async () => {
    const s = await screenOf(["   ◆  First line of it", "        nested line", "      last one"], 40);
    const want = "First line of it\n  nested line\nlast one";
    for (const x of [0, 1, 3]) expect(copyText(spans(s, { anchor: { x, y: 0 }, head: { x: 39, y: 2 } }))).toBe(want);
    // Starting inside the text is a part of the row: kept as it is.
    expect(copyText(spans(s, { anchor: { x: 9, y: 0 }, head: { x: 39, y: 0 } }))).toBe("st line of it");
  });

  test("BUG-286: a part of a row keeps its text as it is (no gutter cut from the middle of a line)", async () => {
    const s = await screenOf(["    indented text here"], 30);
    const part = spans(s, { anchor: { x: 2, y: 0 }, head: { x: 12, y: 0 } });
    expect(copyText(part)).toBe("  indented");
  });
});

describe("paintSpans", () => {
  test("BUG-286: the cells again at their place, reversed while selected, as the screen has them when not; a reversed cell is un-reversed; the cursor is saved and restored", async () => {
    const s = await screenOf(["ab"]);
    await s.write("\x1b[2;1H\x1b[1;7mX\x1b[0m");
    const sp = spans(s, { anchor: { x: 0, y: 0 }, head: { x: 1, y: 1 } });
    const on = paintSpans(s, sp, true);
    expect(on).toStartWith("\x1b7\x1b[1;1H");
    // The same attributes in a row: one SGR for the run.
    expect(on).toContain("\x1b[0;7mab");
    expect(on).toContain("\x1b[2;1H\x1b[0;1;7;27mX");
    expect(on).toEndWith("\x1b[0m\x1b8");
    const off = paintSpans(s, sp, false);
    expect(off).toContain("\x1b[0mab");
    expect(off).toContain("\x1b[0;1;7mX");
    expect(paintSpans(s, [], true)).toBe("");
  });
});

describe("diffSpans and the size of a paint", () => {
  test("BUG-286: going from one selection to the next, only the cells that change state are painted; same attributes in a row are one SGR", async () => {
    const s = await screenOf(["hello world", "second line"], 20);
    const was = spans(s, { anchor: { x: 2, y: 0 }, head: { x: 4, y: 1 } });
    const now = spans(s, { anchor: { x: 2, y: 0 }, head: { x: 6, y: 1 } });
    const { off, on } = diffSpans(was, now);
    // Row 0 is the same; row 1 grew by two cells (x 5 and 6).
    expect(off).toEqual([]);
    expect(on.map((x) => [x.y, x.x0, x.x1])).toEqual([[1, 5, 7]]);
    // Shrinking paints back what left: row 1 from 7 down to 5 cells.
    const back = diffSpans(now, was);
    expect(back.on).toEqual([]);
    expect(back.off.map((x) => [x.y, x.x0, x.x1])).toEqual([[1, 5, 7]]);
    // A move that leaves a hole in the middle of the old one.
    const wide = spans(s, { anchor: { x: 0, y: 0 }, head: { x: 10, y: 0 } });
    const narrow = spans(s, { anchor: { x: 3, y: 0 }, head: { x: 5, y: 0 } });
    expect(diffSpans(wide, narrow).off.map((x) => [x.x0, x.x1])).toEqual([[0, 3], [6, 11]]);
    // Cells with one set of attributes cost one SGR for the run.
    const bytes = paintSpans(s, spans(s, { anchor: { x: 0, y: 0 }, head: { x: 10, y: 0 } }), true);
    expect(bytes.match(/\x1b\[0;7m/g)).toHaveLength(1);
    expect(bytes).toContain("hello world");
  });
});

describe("osc52", () => {
  test("the text as the terminal's clipboard, base64 of its UTF-8", () => {
    expect(osc52("hé")).toBe(`\x1b]52;c;${Buffer.from("hé").toString("base64")}\x07`);
  });
});
