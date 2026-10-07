import { describe, expect, test } from "bun:test";
import { renderToString, type Key } from "ink";
import { loadConfig } from "../src/config.ts";
import { composerHeight, GluonComposer } from "../src/ui/chat.tsx";
import * as ed from "../src/ui/editor.ts";
import { inline } from "../src/ui/markdown.tsx";
import { LateOscFilter, NO_KEY, replyPart, splitKeys } from "../src/ui/keys.ts";
import { fitMenu, PickMany } from "../src/ui/signin.tsx";
import { inkTerm } from "./fixtures/ink-term.tsx";
import { makeTheme, parseTerminalReplies } from "../src/ui/theme.ts";
import { Width, wrap } from "../src/ui/width.tsx";

const theme = makeTheme(null);
const config = loadConfig();

test("keys that arrive in one chunk are split: Enter submits, control keys are keys", () => {
  const keys = splitKeys("fix it\r\x15x");
  expect(keys.map(([i, k]) => [i, k.return, k.ctrl])).toEqual([
    ["fix it", false, false],
    ["", true, false],
    ["u", false, true],
    ["x", false, false],
  ]);
});

test("the composer shows at most maxRows rows, around the cursor", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const draft = { text, cursor: text.length };
  const out = renderToString(
    <Width columns={59}>
      <GluonComposer draft={draft} placeholder="" maxRows={5} palette={theme.gluon} />
    </Width>,
    { columns: 60 },
  );
  // Colour codes (FORCE_COLOR in the environment) don't make a blank line count.
  const lines = Bun.stripANSI(out).split("\n").filter((l) => l.trim() && !/^─+$/.test(l.trim()));
  expect(lines).toHaveLength(5);
  expect(composerHeight(draft, 59, 5)).toBe(7);
  expect(out).toContain("line 49");
  expect(out).toContain("more lines");
});

test("wrapping keeps each line's indentation; tabs become spaces", () => {
  expect(wrap("def f(x):\n    if x:\n\treturn 1", 40)).toBe("def f(x):\n    if x:\n    return 1");
  expect(wrap("    aaaa bbbb cccc", 13)).toBe("    aaaa bbbb\n    cccc");
});

test("inline code inside bold is styled, not left with backticks", () => {
  expect(Bun.stripANSI(inline("**The `add` function**", theme))).toBe("The add function");
});

test("COLORFGBG picks a light theme when OSC 11 isn't answered", () => {
  const prev = process.env.COLORFGBG;
  process.env.COLORFGBG = "0;15";
  expect(makeTheme(null).dark).toBe(false);
  process.env.COLORFGBG = prev;
  if (prev === undefined) delete process.env.COLORFGBG;
  expect(ed.expandTabs("a\tb")).toBe("a   b");
});

describe.concurrent("the late OSC 11 filter (BUG-54/BUG-63)", () => {
  const feed = async (events: ([string, Partial<Key>] | number)[], escHold = 150) => {
    const got: string[] = [];
    const f = new LateOscFilter((input, key) => got.push(key.escape ? "<esc>" : key.ctrl ? `^${input}` : input), () => escHold);
    for (const e of events) {
      if (typeof e === "number") await Bun.sleep(e);
      else f.feed(e[0], { ...NO_KEY, ...e[1] });
    }
    await Bun.sleep(escHold + 50);
    f.dispose();
    return got;
  };
  const esc = ["", { escape: true }] as [string, Partial<Key>];

  test("BUG-54/3.2: a light terminal's reply (ESC \\ terminator, delivered as a lone \\) is dropped whole", async () => {
    expect(await feed([["]", {}], ["11;rgb:ffff/ffff/ffff", {}], ["\\", {}], ["x", {}]])).toEqual(["x"]);
    // Split after its ESC, any delay: the ESC is held, the rest recognised whenever it comes.
    expect(await feed([esc, 120, ["]11;rgb:ffff/ffff/ffff", {}], ["\\", {}], ["x", {}]])).toEqual(["x"]);
    // Split inside the colour, and a BEL (Ctrl+G) terminator.
    expect(await feed([["]", {}], ["11;rgb:0c0c/0c", {}], ["0c/0c0c", {}], ["g", { ctrl: true }], ["y", {}]])).toEqual(["y"]);
    // Split inside the last colour ("…/0c" then "0c" + BEL): nothing typed.
    expect(await feed([["]", {}], ["11;rgb:0c0c/0c0c/0c", {}], ["0c\x07", {}], ["w", {}]])).toEqual(["w"]);
    // The terminator's own ESC split from its "\".
    expect(await feed([["]", {}], ["11;rgb:ffff/ffff/ffff", {}], esc, ["\\", {}], ["z", {}]])).toEqual(["z"]);
  });

  test("BUG-63/3.1: the ESC is held longer while a reply is still expected; a real Esc still goes through @full", async () => {
    expect(await feed([esc, 250, ["]11;rgb:0c0c/0c0c/0c0c\x07", {}]], 1000)).toEqual([]);
    expect(await feed([esc], 1000)).toEqual(["<esc>"]);
    expect(await feed([esc, ["x", {}]])).toEqual(["<esc>", "x"]);
    // Typing that only looks a bit like a reply is typed.
    expect(await feed([["1", {}], ["1", {}], [";", {}], ["r", {}], ["]", {}], ["a", {}]])).toEqual(["1", "1", ";", "r", "]", "a"]);
    expect(await feed([["\\", {}]])).toEqual(["\\"]);
  });

  test("replies are recognised in their pieces", () => {
    expect(replyPart("]11;rgb:0c0c/0c0c/0c0c\x07")?.phase).toBe("done");
    expect(replyPart("11;rgb:ffff/ffff/ffff")?.phase).toBe("tail");
    expect(replyPart("]11;rgb:ff")?.phase).toBe("open");
    expect(replyPart("1")).toBeNull();
    expect(replyPart("rgb")?.phase).toBe("open");
    expect(replyPart("hello")).toBeNull();
  });
});

test("BUG-58/4.4: a menu fits in the terminal: margins go, then the body is clipped, then the list scrolls", () => {
  const body = Array.from({ length: 8 }, (_, i) => `line ${i}`);
  const items = Array(10).fill(1);
  expect(fitMenu({ columns: 80, rows: 40, title: "T", body, items, cursor: 0, footer: true })).toEqual({ compact: false, bodyRows: null, window: { start: 0, end: 10 } });
  const tight = fitMenu({ columns: 80, rows: 15, title: "T", body, items, cursor: 0, footer: true });
  expect(tight.compact).toBe(true);
  expect(tight.bodyRows).toBe(2);
  const tiny = fitMenu({ columns: 80, rows: 8, title: "T", body, items, cursor: 9, footer: true });
  expect(tiny.bodyRows).toBe(0);
  expect(tiny.window.end).toBe(10);
  expect(tiny.window.end - tiny.window.start).toBeLessThanOrEqual(8 - 1 - 2 - 1);
});

describe("a long checklist (a list of twelve: no setup list has that many rows any more)", () => {
  const options = Array.from({ length: 12 }, (_, i) => ({ label: `Provider ${i + 1}`, description: `KEY_${i + 1}` }));
  const shown = (columns: number, rows: number) => inkTerm(<PickMany theme={theme} title="Which providers?" options={options} onDone={() => {}} />, { columns, rows });

  test("BUG-62/2.6: numbers right-aligned, '1' then '0' checks row 10, the hint is true", async () => {
    const t = await shown(80, 30);
    expect(t.text()).toContain("space or 1-12 to check");
    const col = (label: string) => t.text().split("\n").find((l) => l.includes(label))!.indexOf("[ ]");
    expect(col("Provider 1 ")).toBe(col("Provider 10"));
    await t.keys("1");
    await t.keys("0");
    expect(t.text()).toMatch(/10\. \[x\] Provider 10/);
    expect(t.text()).toMatch(/ 1\. \[ \] Provider 1 /);
    t.unmount();
  });

  test("BUG-58/4.4: at 60×12 the list scrolls with the cursor, the title stays", async () => {
    const t = await shown(60, 12);
    for (let i = 0; i < 9; i++) await t.keys("\x1b[B");
    expect(t.text()).toMatch(/› 10\. \[ \] Provider 10/);
    expect(t.text()).toContain("Which providers?");
    t.unmount();
  });
});

test("BUG-160: the startup probe's answers: kitty's flags, the foreground and cursor colours, all before DA1", () => {
  expect(parseTerminalReplies("\x1b]10;rgb:ffff/ffff/ffff\x07")).toBeNull();
  expect(parseTerminalReplies("\x1b]10;rgb:ffff/8080/0000\x07\x1b]12;rgb:00/ff/00\x1b\\\x1b[?1u\x1b[?62;22c")).toEqual({ kitty: true, fg: [255, 128, 0], cursor: [0, 255, 0] });
  // A terminal without kitty or colour answers: DA1 alone.
  expect(parseTerminalReplies("\x1b[?1;2c")).toEqual({ kitty: false, fg: null, cursor: null });
});
