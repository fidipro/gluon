/**
 * Independent QA of the home view's drag selection (issue #62, `src/pty/selection.ts`, `homeMouse` & co in
 * `src/pty/compositor.ts`): the awkward paths — a busy screen, the last row, odd report orders, other buttons.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Compositor, type HomeView } from "../src/pty/compositor.ts";
import { createKeyDecoder } from "../src/pty/keys.ts";
import { createScreen, type TermScreen } from "../src/pty/screen.ts";
import { copyText, osc52, spans } from "../src/pty/selection.ts";
import type { Key, MouseReport } from "../src/pty/types.ts";
import { SessionStore } from "../src/sessions.ts";

const keys = (text: string): Key[] => {
  const d = createKeyDecoder("ctrl+\\");
  return [...d.feed(text), ...d.flush()];
};
const tick = (ms = 40) => Bun.sleep(ms);

/** A terminal stand-in: what the compositor writes goes into a screen model of its own. */
class FakeOut extends EventEmitter {
  isTTY = true;
  raw = "";
  screen: TermScreen;
  private parsed: Promise<void> = Promise.resolve();
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
    this.screen = createScreen(columns, rows);
  }
  write(s: string) {
    this.raw += s;
    this.parsed = this.parsed.then(() => this.screen.write(s));
    return true;
  }
  async settled() {
    await this.parsed;
  }
  async lines() {
    await this.parsed;
    return Array.from({ length: this.rows }, (_, y) => this.screen.viewLine(y).text);
  }
}

function fakeHome() {
  let input: PassThrough | undefined;
  let output: NodeJS.WriteStream | undefined;
  const mice: MouseReport[] = [];
  const view: HomeView = {
    mouse: (m) => void mice.push(m),
    mount: (i, o) => void ((input = i as unknown as PassThrough), (output = o)),
    suspend: async () => {},
    resume: async () => {},
    unmount: async () => {},
  };
  return { view, mice, read: () => String(input?.read() ?? ""), write: (s: string) => output!.write(s) };
}

describe("QA: the home selection on fake streams", () => {
  let c: Compositor | undefined;
  afterEach(async () => {
    await c?.stop();
    c = undefined;
  });

  async function setup({ mouseCapture = true, cols = 100, rows = 30 } = {}) {
    const out = new FakeOut(cols, rows);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin }) as unknown as NodeJS.ReadStream;
    const store = new SessionStore();
    const home = fakeHome();
    c = new Compositor({ store, home: home.view, homeKey: "ctrl+\\", mouseCapture, toastMs: 150, truecolor: true, stdin, stdout: out as unknown as NodeJS.WriteStream });
    await c.start();
    return { out, store, home, c: c!, stdin };
  }
  const frame = "\x1b[1;1Hhello world\x1b[2;1Hsecond line\x1b[3;1Hthird line";
  const copied = (raw: string) => [...raw.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)].map((m) => Buffer.from(m[1]!, "base64").toString("utf8"));

  const drag = (x1: number, y1: number, x2: number, y2: number) => `\x1b[<0;${x1};${y1}M\x1b[<32;${x2};${y2}M\x1b[<0;${x2};${y2}m`;

  test("BUG-286/last row: the text the model has on the last row is what the terminal shows (an expired toast must not be copied or painted back)", async () => {
    const { out, home, c } = await setup();
    home.write(frame);
    await tick();
    c.dispatch(keys(drag(1, 1, 5, 1)));
    await tick();
    expect((await out.lines())[29]).toContain("Copied 5 characters");
    // A frame while the toast shows carries it in its last row (the model parses it) ...
    home.write(frame);
    await tick(400);
    // ... the toast went (drawn on the terminal alone), and a drag over the last row ...
    expect((await out.lines())[29]!.trim()).toBe("");
    const mark = out.raw.length;
    c.dispatch(keys(drag(1, 30, 40, 30)));
    await tick();
    expect(copied(out.raw.slice(mark)).join("")).not.toContain("Copied");
    expect((await out.lines())[29]!.trim()).toBe("");
  });

  test("BUG-286/toast colours: the toast's text cells sit on the ground like the rest of the last row", async () => {
    const { out, home, c } = await setup();
    home.write(frame);
    await tick();
    c.dispatch(keys(drag(1, 1, 5, 1)));
    await tick();
    await out.settled();
    const row = out.screen.cells(29);
    expect(row[1]!.char).toBe("C");
    expect([row[1]!.bgMode, row[1]!.bg]).toEqual([row[60]!.bgMode, row[60]!.bg]);
  });

  test("BUG-286/frame in the same turn: a drag handled before the model parsed the frame Ink just wrote copies and paints the old text", async () => {
    const { out, home, c } = await setup();
    home.write(frame);
    await tick();
    const mark = out.raw.length;
    home.write("\x1b[1;1HHELLO world");
    c.dispatch(keys(drag(1, 1, 5, 1)));
    await tick(100);
    expect(copied(out.raw.slice(mark))).toEqual(["HELLO"]);
    expect((await out.lines())[0]).toStartWith("HELLO world");
  });

  test("BUG-286/mid-drag change: text changing under a drag in progress (a spinner) must not end the drag; the release still copies", async () => {
    const { out, home, c } = await setup();
    home.write(frame);
    await tick();
    const mark = out.raw.length;
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;5;3M"));
    home.write("\x1b[2;1Hsecond LINE");
    await tick(60);
    c.dispatch(keys("\x1b[<32;9;3M\x1b[<0;9;3m"));
    const got = copied(out.raw.slice(mark));
    expect(got.length).toBe(1);
    expect(got[0]).toContain("second LINE");
  });

  test("BUG-286/release without motion: a press released on another cell is a drag, not a click on the press's cell (a terminal that coalesces or never sends motion)", async () => {
    const { home, c } = await setup();
    home.write(frame);
    await tick();
    c.dispatch(keys("\x1b[<0;10;12M\x1b[<0;50;12m"));
    expect(home.mice).toEqual([]);
  });

  test("BUG-286/release cell: the selection ends where the button was released, not at the last motion report", async () => {
    const { out, home, c } = await setup();
    home.write(frame);
    await tick();
    const mark = out.raw.length;
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;3;1M\x1b[<0;8;1m"));
    expect(copied(out.raw.slice(mark))).toEqual(["hello wo"]);
  });

  test("BUG-286/chat gutter: copyText: a chat row's gutter, glyph and the page's padding are left out of a whole-row copy (the home view pads 2 columns each side)", async () => {
    const s = createScreen(100, 4);
    await s.write("\x1b[1;1H   ◆  A focused change with a clear test path; Sonnet at medium effort is the cheapest reliable\x1b[2;1H      fit. I'd start it with:\x1b[3;1H   ›  fix the add bug");
    const text = copyText(spans(s, { anchor: { x: 0, y: 0 }, head: { x: 99, y: 2 } }));
    expect(text).toBe("A focused change with a clear test path; Sonnet at medium effort is the cheapest reliable\nfit. I'd start it with:\nfix the add bug");
  });

  test("BUG-286/osc52: whatever the text holds (BEL, ESC, ST, newlines, wide chars) the sequence has one terminator and a base64 body", () => {
    for (const text of ["a\x07b", "x\x1b\\y", "\x1b]52;c;?\x07", "日本語 😀\né", ""]) {
      const seq = osc52(text);
      expect(seq).toMatch(/^\x1b\]52;c;[A-Za-z0-9+/]*={0,2}\x07$/);
      expect(Buffer.from(seq.slice(7, -1), "base64").toString("utf8")).toBe(text);
    }
  });

  test("BUG-286/buttons: a right or middle drag selects nothing, paints nothing and copies nothing", async () => {
    const { out, home, c } = await setup();
    home.write(frame);
    await tick();
    const mark = out.raw.length;
    c.dispatch(keys("\x1b[<2;1;1M\x1b[<34;5;1M\x1b[<2;5;1m\x1b[<1;1;1M\x1b[<33;5;1M\x1b[<1;5;1m"));
    expect(out.raw.slice(mark)).not.toContain("\x1b]52;");
    expect(out.raw.slice(mark)).not.toContain(";7m");
  });

  test("BUG-286/bounds: a drag far past the window's edge is held at the last cell; a drag backwards and up selects the same cells", async () => {
    const { out, home, c } = await setup();
    home.write(frame);
    await tick();
    let mark = out.raw.length;
    c.dispatch(keys(drag(1, 1, 9999, 9999)));
    expect(copied(out.raw.slice(mark))).toEqual(["hello world\nsecond line\nthird line"]);
    mark = out.raw.length;
    c.dispatch(keys(drag(5, 3, 7, 1)));
    expect(copied(out.raw.slice(mark))).toEqual(["world\nsecond line\nthird"]);
  });

  test("BUG-286/split reads: a report split anywhere across reads selects as a whole one", async () => {
    const { out, home, stdin } = await setup();
    home.write(frame);
    await tick();
    const mark = out.raw.length;
    for (const part of ["\x1b[<0;1", ";1M\x1b[<32;4", ";1M\x1b", "[<0;4;1m"]) {
      stdin.write(part);
      await tick(15);
    }
    await tick();
    expect(copied(out.raw.slice(mark))).toEqual(["hell"]);
    expect(home.mice).toEqual([]);
  });

  test("BUG-286/wide: a selection over wide, combining and coloured text paints and unpaints exactly the cells that were there", async () => {
    const { out, home, c } = await setup();
    home.write("\x1b[1;1H\x1b[1;32mab日本語 \x1b[0m😀\x1b[44m x \x1b[0me\u0301 end\x1b[2;1Hsecond");
    await tick();
    await out.settled();
    const look = () => out.screen.cells(0).map((x) => `${x.char || " "}|${x.width}|${x.inverse}`);
    const before = look();
    // Each drag moves at least 2 cells: a press and release within 1 cell is a click (BUG-657, the owner's QA-ui-01 decision), so the narrowest selections over a wide or combining cell start a cell earlier.
    for (const [a, b] of [[1, 100], [3, 5], [4, 6], [5, 7], [9, 14], [12, 14], [13, 15], [12, 16], [16, 12]] as const) {
      c.dispatch(keys(drag(a, 1, b, 1)));
      await tick(20);
      await out.settled();
      const on = look();
      expect(on.some((x) => x.endsWith("|true"))).toBe(true);
      expect(on.map((x) => x.replace("|true", "|false"))).toEqual(before);
      c.dispatch(keys("\x1b[<0;60;20M\x1b[<0;60;20m"));
      await tick(20);
      await out.settled();
      expect(look()).toEqual(before);
    }
  });

  test("BUG-286/clicks: two quick clicks reach the home view as two presses, each on its own cell and in order, at their releases", async () => {
    const { home, c } = await setup();
    c.dispatch(keys("\x1b[<0;12;9M"));
    expect(home.mice).toEqual([]);
    c.dispatch(keys("\x1b[<0;12;9m\x1b[<0;12;9M\x1b[<0;12;9m"));
    expect(home.mice.map((m) => [m.x, m.y, m.release])).toEqual([[12, 9, false], [12, 9, false]]);
  });

  test("BUG-286/toast: it clears by itself and never clobbers a question that came meanwhile", async () => {
    const { out, home, c } = await setup();
    home.write(frame);
    await tick();
    c.dispatch(keys(drag(1, 1, 5, 1)));
    await tick();
    const asked = c.confirm("Delete the session?");
    await tick(400);
    expect((await out.lines())[29]).toContain("Delete the session?");
    c.dispatch(keys("\x1b"));
    expect(await asked).toBe(false);
    await tick(200);
    expect((await out.lines())[29]!.trim()).toBe("");
  });

  test("BUG-286/stop: nothing is written after stop() with a selection and a toast pending", async () => {
    const { out, home, c } = await setup();
    home.write(frame);
    await tick();
    c.dispatch(keys(drag(1, 1, 5, 1)));
    home.write(frame);
    await c.stop();
    const n = out.raw.length;
    await tick(400);
    expect(out.raw.length).toBe(n);
  });

  test("BUG-286/session: an agent that tracks the mouse still gets a drag moved into its frame; the home view gets none of it", async () => {
    const { out, home, c, store } = await setup();
    const screen = createScreen(98, 25, { scrollback: 200 });
    await screen.write("\x1b[?1002h\x1b[?1006h");
    const mice: string[] = [];
    const s = { screen, alive: true, question: null, holdsLine: false, input: () => {}, mouse: (b: string) => void mice.push(b), passthrough: () => {}, resize: (cc: number, r: number) => screen.resize(cc, r), onChange: () => () => {}, onQuestion: () => () => {} };
    const v = store.launched("alpha", { harness: "claude-code", model: "opus", effort: "high" }, { alive: true, end: async () => {} });
    c.add(v.id, s as never);
    home.write(frame);
    await tick();
    await c.open(v.id);
    c.dispatch(keys(drag(10, 10, 40, 12)));
    expect(mice.length).toBe(3);
    expect(home.mice).toEqual([]);
    expect(out.raw).not.toContain("\x1b]52;");
  });
});
