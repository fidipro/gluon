/** Gluon's compositor (`src/pty/compositor.ts`): the key table, mouse shifting, and the views on fake streams. */
import { SLOW } from "./fixtures/slow.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Compositor, effectiveModes, homeInput, neighbour, route, SELF_GUARD_MS, shiftMouse, type HomeView, type RouteContext, type ViewSession } from "../src/pty/compositor.ts";
import { createKeyDecoder } from "../src/pty/keys.ts";
import { HOME_MODES, MODES_RESET, type ModesState } from "../src/pty/modes.ts";
import { createScreen, type TermScreen } from "../src/pty/screen.ts";
import type { Key, MouseReport } from "../src/pty/types.ts";
import { SessionStore } from "../src/sessions.ts";
import { DOUBLE_CLICK_MS } from "../src/ui/layout.ts";
import { GLUON_HEX } from "../src/ui/theme.ts";

const keys = (text: string): Key[] => {
  const d = createKeyDecoder("ctrl+\\");
  return [...d.feed(text), ...d.flush()];
};
const key = (text: string) => keys(text)[0]!;
const interior = { top: 3, left: 1, cols: 98, rows: 25 };
/** The strip: `◆ gluon` [0, 9), tab 1 [9, 20), tab 2 [21, 32) on row 0. */
const strip = { home: [0, 9] as [number, number], tabs: [{ id: 1, x0: 9, x1: 20 }, { id: 2, x0: 21, x1: 32 }] };
const ctx = (o: Partial<RouteContext> = {}): RouteContext => ({ modes: { ...HOME_MODES }, capture: true, interior, offset: 0, scrollback: 0, question: false, untouched: false, prefix: false, pressed: false, tabRow: 0, strip, ...o });
const mouseModes: ModesState = { ...HOME_MODES, mouseTracking: "vt200", mouseEncoding: "sgr" };

describe("the session view's keys (route)", () => {
  test("Gluon's own keys: the home key is the prefix; terminal replies are dropped; Alt+PgUp/PgDn are the agent's", () => {
    expect(route(key("\x1c"), ctx())).toEqual([{ kind: "prefix" }]);
    for (const raw of ["\x1b[6;3~", "\x1b[5;3~", "\x1b[57422;3u", "\x1b[34;81;0;1;2;1_"]) expect(route(key(raw), ctx())).toEqual([{ kind: "input", key: key(raw) }]);
    expect(route(key("\x1b]11;rgb:0/0/0\x07"), ctx())).toEqual([]);
    expect(route(key("\x1b[?1;2c"), ctx())).toEqual([]);
  });

  test("everything else goes to the agent as typed (Ctrl+C included); a paste is one key", () => {
    for (const raw of ["a", "\r", "\x03", "\x1b[A", "\x1b[D", "\x1b[C", "\x1b[99;5u", "\x1b[13;2u"]) expect(route(key(raw), ctx())).toEqual([{ kind: "input", key: key(raw) }]);
    const paste = key("\x1b[200~/clear\r\x1b[201~");
    expect(route(paste, ctx())).toEqual([{ kind: "input", key: paste }]);
  });

  test("Shift+PgUp/PgDn scroll a page when there's something to scroll back to; else the agent gets them", () => {
    expect(route(key("\x1b[5;2~"), ctx({ scrollback: 40 }))).toEqual([{ kind: "scroll", by: 24 }]);
    expect(route(key("\x1b[5;2~"), ctx())).toEqual([{ kind: "input", key: key("\x1b[5;2~") }]);
    expect(route(key("\x1b[6;2~"), ctx({ offset: 30, scrollback: 40 }))).toEqual([{ kind: "scroll", by: -24 }]);
    expect(route(key("\x1b[6;2~"), ctx())).toEqual([{ kind: "input", key: key("\x1b[6;2~") }]);
  });

  test("scrolled back: Esc and q leave scroll mode; any other key leaves it and goes on", () => {
    const c = ctx({ offset: 5, scrollback: 40 });
    expect(route(key("\x1b"), c)).toEqual([{ kind: "unscroll" }]);
    expect(route(key("q"), c)).toEqual([{ kind: "unscroll" }]);
    expect(route(key("x"), c)).toEqual([{ kind: "unscroll" }, { kind: "input", key: key("x") }]);
  });

  test("the wheel scrolls the frame when Gluon captures the mouse; with capture off nothing comes", () => {
    const up = key("\x1b[<64;10;10M");
    const down = key("\x1b[<65;10;10M");
    expect(route(up, ctx())).toEqual([{ kind: "scroll", by: 3 }]);
    expect(route(down, ctx())).toEqual([]);
    expect(route(down, ctx({ offset: 6 }))).toEqual([{ kind: "scroll", by: -3 }]);
    expect(route(up, ctx({ capture: false }))).toEqual([]);
    // A click with the mouse captured is Gluon's (dropped).
    expect(route(key("\x1b[<0;10;10M"), ctx())).toEqual([]);
  });

  test("an agent that asked for the mouse gets it, moved into its screen; outside the frame it's dropped", () => {
    expect(route(key("\x1b[<0;10;10M"), ctx({ modes: mouseModes }))).toEqual([{ kind: "mouse", bytes: "\x1b[<0;9;7M" }]);
    expect(route(key("\x1b[<64;10;10M"), ctx({ modes: mouseModes }))).toEqual([{ kind: "mouse", bytes: "\x1b[<64;9;7M" }]);
    // Row 1 past the tabs, the border.
    expect(route(key("\x1b[<0;40;1M"), ctx({ modes: mouseModes }))).toEqual([]);
    expect(route(key("\x1b[<0;1;10M"), ctx({ modes: mouseModes }))).toEqual([]);
  });

  test("a focus report reaches the agent only if it asked for them", () => {
    expect(route(key("\x1b[I"), ctx())).toEqual([]);
    expect(route(key("\x1b[I"), ctx({ modes: { ...HOME_MODES, focus: true } }))).toEqual([{ kind: "passthrough", bytes: "\x1b[I" }]);
  });

  test("BUG-195/route: plain ←/→ on an untouched line switch, always (the ring wraps through home); Alt+←/→ there are dropped", () => {
    const left = key("\x1b[D");
    const right = key("\x1b[C");
    const empty = ctx({ untouched: true });
    expect(route(left, empty)).toEqual([{ kind: "switch", dir: -1 }]);
    expect(route(right, empty)).toEqual([{ kind: "switch", dir: 1 }]);
    // A touched line: the agent's arrows. Shift and Ctrl arrows are never Gluon's.
    expect(route(left, ctx())).toEqual([{ kind: "input", key: left }]);
    for (const raw of ["\x1b[1;2D", "\x1b[1;5D", "\x1b[1;4C"]) expect(route(key(raw), empty)).toEqual([{ kind: "input", key: key(raw) }]);
    // Scrolled back: the switch (the next view is live).
    expect(route(left, ctx({ untouched: true, offset: 5, scrollback: 40 }))).toEqual([{ kind: "switch", dir: -1 }]);
    // Gluon's question keeps them (dropped, as any key but its answers).
    expect(route(left, ctx({ untouched: true, question: true }))).toEqual([{ kind: "answer", key: left }]);
    // The win32 key-up the decoder dropped (raw ""): nothing, for the agent or the line.
    expect(route(key("\x1b[37;75;0;0;256;1_"), ctx())).toEqual([]);
  });

  test("BUG-280/route: Alt+←/→ on an untouched line are dropped (Codex/OpenCode would use them); on a touched line they reach the agent", () => {
    for (const raw of ["\x1b[1;3D", "\x1b[1;3C", "\x1b[1;3:1D", "\x1b[37;75;0;1;258;1_"]) {
      expect(route(key(raw), ctx({ untouched: true }))).toEqual([]);
      expect(route(key(raw), ctx({ untouched: true, offset: 5, scrollback: 40 }))).toEqual([]);
      expect(route(key(raw), ctx())).toEqual([{ kind: "input", key: key(raw) }]);
    }
    // The win32 key-up the decoder dropped: nothing either way.
    expect(route(key("\x1b[37;75;0;0;258;1_"), ctx())).toEqual([]);
    // A question up: not Gluon's, not the agent's.
    expect(route(key("\x1b[1;3C"), ctx({ untouched: true, question: true }))).toEqual([{ kind: "answer", key: key("\x1b[1;3C") }]);
  });

  test("BUG-279/route: while the home key waits, ←/→ switch, the home key goes home, Esc cancels, any other key ends it and is routed as usual — in every state", () => {
    const left = key("\x1b[D");
    const right = key("\x1b[C");
    const states: [string, Partial<RouteContext>][] = [
      ["untouched", { untouched: true }],
      ["typed line", { untouched: false }],
      ["question up", { question: true }],
      ["scrolled back", { offset: 5, scrollback: 40 }],
      ["scrolled back, question up", { offset: 5, scrollback: 40, question: true }],
    ];
    for (const [name, o] of states) {
      const c = ctx({ ...o, prefix: true });
      const at = (what: string) => `${name}: ${what}`;
      expect({ [at("←")]: route(left, c) }).toEqual({ [at("←")]: [{ kind: "unprefix" }, { kind: "switch", dir: -1 }] });
      expect({ [at("→")]: route(right, c) }).toEqual({ [at("→")]: [{ kind: "unprefix" }, { kind: "switch", dir: 1 }] });
      expect({ [at("home")]: route(key("\x1c"), c) }).toEqual({ [at("home")]: [{ kind: "unprefix" }, { kind: "home" }] });
      expect({ [at("esc")]: route(key("\x1b"), c) }).toEqual({ [at("esc")]: [{ kind: "unprefix" }] });
      // Any other key: the prefix ends and the key is routed as if it had come alone (Esc pasted is no Esc).
      for (const raw of ["x", "\r", "\x1b[A", "\x1b[1;3C", "\x1b[6;3~", "\x1b[5;2~", "\x1b[<64;10;10M"]) {
        const k = key(raw);
        expect({ [at(raw)]: route(k, c) }).toEqual({ [at(raw)]: [{ kind: "unprefix" }, ...route(k, { ...c, prefix: false })] });
      }
      const paste = key("\x1b[200~\x1b\x1b[201~");
      expect(route(paste, c)).toEqual([{ kind: "unprefix" }, ...route(paste, { ...c, prefix: false })]);
    }
    // Replies and focus reports are not keys: the prefix keeps waiting.
    expect(route(key("\x1b]11;rgb:0/0/0\x07"), ctx({ prefix: true }))).toEqual([]);
    expect(route(key("\x1b[I"), ctx({ prefix: true }))).toEqual([]);
    expect(route(key("\x1b[I"), ctx({ prefix: true, modes: { ...HOME_MODES, focus: true } }))).toEqual([{ kind: "passthrough", bytes: "\x1b[I" }]);
    // The win32 key-up the decoder dropped (no bytes): not a key either.
    expect(route(key("\x1b[37;75;0;0;256;1_"), ctx({ prefix: true }))).toEqual([]);
    // BUG-279/win32: the Ctrl key-up of win32-input-mode (or a kitty release) right after the home key
    // is no pick: it goes on to the agent, which got the Ctrl press, and the prefix stays.
    for (const up of ["\x1b[17;29;0;0;8;1_", "\x1b[92;5:3u"]) {
      const k = key(up);
      expect(route(k, ctx({ prefix: true }))).toEqual([{ kind: "input", key: k }]);
    }
    // The home key with nothing pending starts it, in every state.
    for (const [, o] of states) expect(route(key("\x1c"), ctx(o))).toEqual([{ kind: "prefix" }]);
  });

  test("BUG-284/route: with the home key pending, z zooms (never routed as if alone, in every state); a pasted z, or z with nothing pending, is the agent's", () => {
    for (const o of [{ untouched: true }, { untouched: false }, { question: true }, { offset: 5, scrollback: 40 }] as Partial<RouteContext>[]) {
      expect(route(key("z"), ctx({ ...o, prefix: true }))).toEqual([{ kind: "unprefix" }, { kind: "zoom" }]);
    }
    const paste = key("\x1b[200~z\x1b[201~");
    expect(route(paste, ctx({ prefix: true }))).toEqual([{ kind: "unprefix" }, ...route(paste, ctx())]);
    expect(route(key("z"), ctx())).toEqual([{ kind: "input", key: key("z") }]);
  });

  test("BUG-196/route: a left click on the tab strip shows home or that tab, whether or not the agent asked for the mouse", () => {
    const switches = (a: { kind: string }) => a.kind === "home" || a.kind === "show";
    for (const modes of [HOME_MODES, mouseModes]) {
      const c = ctx({ modes: { ...modes } });
      expect(route(key("\x1b[<0;1;1M"), c)).toEqual([{ kind: "home" }]);
      expect(route(key("\x1b[<0;9;1M"), c)).toEqual([{ kind: "home" }]);
      expect(route(key("\x1b[<0;10;1M"), c)).toEqual([{ kind: "show", id: 1 }]);
      expect(route(key("\x1b[<0;20;1M"), c)).toEqual([{ kind: "show", id: 1 }]);
      expect(route(key("\x1b[<0;32;1M"), c)).toEqual([{ kind: "show", id: 2 }]);
      // The gap between tabs, past the last one, row 2, the right button, a release, a drag: no switch.
      for (const raw of ["\x1b[<0;21;1M", "\x1b[<0;40;1M", "\x1b[<0;10;2M", "\x1b[<2;10;1M", "\x1b[<0;10;1m", "\x1b[<32;10;1M"]) expect(route(key(raw), c).some(switches)).toBe(false);
    }
    // X10 reports too; none while the strip isn't drawn, nor in pixels (mode 1016).
    expect(route(key(`\x1b[M${String.fromCharCode(32, 32 + 12, 33)}`), ctx())).toEqual([{ kind: "show", id: 1 }]);
    expect(route(key("\x1b[<0;10;1M"), ctx({ strip: null }))).toEqual([]);
    expect(route(key("\x1b[<0;10;1M"), ctx({ modes: { ...mouseModes, mouseEncoding: "sgr-pixels" } }))).toEqual([]);
  });

  test("BUG-212/route: a left click on ‹ or › shows the nearest hidden tab on that side; as with tabs, only a press", () => {
    const scrolled = { home: [0, 9] as [number, number], prev: { id: 7, x0: 9, x1: 11 }, tabs: [{ id: 8, x0: 11, x1: 30 }], next: { id: 9, x0: 98, x1: 100 } };
    for (const modes of [HOME_MODES, mouseModes]) {
      const c = ctx({ modes: { ...modes }, strip: scrolled });
      expect(route(key("\x1b[<0;10;1M"), c)).toEqual([{ kind: "show", id: 7 }]);
      expect(route(key("\x1b[<0;11;1M"), c)).toEqual([{ kind: "show", id: 7 }]);
      expect(route(key("\x1b[<0;12;1M"), c)).toEqual([{ kind: "show", id: 8 }]);
      expect(route(key("\x1b[<0;100;1M"), c)).toEqual([{ kind: "show", id: 9 }]);
      for (const raw of ["\x1b[<0;100;1m", "\x1b[<2;100;1M", "\x1b[<32;100;1M", "\x1b[<0;100;2M"]) expect(route(key(raw), c).some((a) => a.kind === "show")).toBe(false);
    }
  });

  test("BUG-409/launch-modes: while a note is up Esc hides it and every other key goes on as usual; a question and scroll mode keep their keys", () => {
    const n = ctx({ note: true });
    expect(route(key("\x1b"), n)).toEqual([{ kind: "dismiss" }]);
    expect(route(key("x"), n)).toEqual([{ kind: "input", key: key("x") }]);
    expect(route(key("\x1b[200~\x1b\x1b[201~"), n)).toEqual([{ kind: "input", key: key("\x1b[200~\x1b\x1b[201~") }]);
    expect(route(key("\x1b"), ctx({ note: true, question: true }))).toEqual([{ kind: "answer", key: key("\x1b") }]);
    expect(route(key("\x1b"), ctx({ note: false }))).toEqual([{ kind: "input", key: key("\x1b") }]);
    expect(route(key("\x1c"), n)).toEqual([{ kind: "prefix" }]);
  });

  test("the question takes Enter, Esc, Ctrl+C (and the rest) but not Gluon's keys or a paste", () => {
    const q = ctx({ question: true });
    expect(route(key("\r"), q)).toEqual([{ kind: "answer", key: key("\r") }]);
    expect(route(key("\x1c"), q)).toEqual([{ kind: "prefix" }]);
    expect(route(key("\x1b[200~x\x1b[201~"), q)).toEqual([]);
  });
});

describe("mouse reports into the frame (shiftMouse)", () => {
  const report = (o: Partial<MouseReport>): MouseReport => ({ code: 0, button: 0, x: 10, y: 10, release: false, motion: false, wheel: null, shift: false, alt: false, ctrl: false, encoding: "sgr", ...o });

  test("in the agent's encoding: SGR, urxvt, X10 (a release as button 3)", () => {
    expect(shiftMouse(report({}), interior, "sgr", false)).toBe("\x1b[<0;9;7M");
    expect(shiftMouse(report({ release: true }), interior, "sgr", true)).toBe("\x1b[<0;9;7m");
    expect(shiftMouse(report({}), interior, "urxvt", false)).toBe("\x1b[32;9;7M");
    expect(shiftMouse(report({ release: true }), interior, "default", true)).toBe(`\x1b[M${String.fromCharCode(3 + 32, 9 + 32, 7 + 32)}`);
  });

  test("outside the interior: a press is dropped; a release or a drag is held at the edge", () => {
    expect(shiftMouse(report({ x: 1 }), interior, "sgr", false)).toBeNull();
    expect(shiftMouse(report({ y: 29 }), interior, "sgr", true)).toBeNull();
    expect(shiftMouse(report({ x: 1, release: true }), interior, "sgr", true)).toBe("\x1b[<0;1;7m");
    expect(shiftMouse(report({ y: 40, code: 32, motion: true }), interior, "sgr", true)).toBe("\x1b[<32;9;25M");
    // Motion with no button outside: dropped.
    expect(shiftMouse(report({ y: 40, code: 35, button: 3, motion: true }), interior, "sgr", true)).toBeNull();
  });

  test("BUG-240/GLUON-27: outside the interior, a release or a drag whose press the agent never got is dropped, not held", () => {
    expect(shiftMouse(report({ x: 1, release: true }), interior, "sgr", false)).toBeNull();
    expect(shiftMouse(report({ y: 40, code: 32, motion: true }), interior, "sgr", false)).toBeNull();
    // Inside, a release goes on as it is.
    expect(shiftMouse(report({ release: true }), interior, "sgr", false)).toBe("\x1b[<0;9;7m");
    // Through the key table: a click on the bottom bar (row 30) is nothing; after a press the agent got, the release there is held.
    const m = { ...HOME_MODES, mouseTracking: "vt200" as const, mouseEncoding: "sgr" as const };
    expect(keys("\x1b[<0;50;30M\x1b[<0;50;30m").flatMap((k) => route(k, ctx({ modes: m })))).toEqual([]);
    expect(route(key("\x1b[<0;50;30m"), ctx({ modes: m, pressed: true }))).toEqual([{ kind: "mouse", bytes: "\x1b[<0;49;25m" }]);
  });
});

describe("modes and tabs", () => {
  test("the real terminal reports the wheel while the agent has no mouse tracking (and capture is on)", () => {
    expect(effectiveModes(HOME_MODES, true)).toMatchObject({ mouseTracking: "vt200", mouseEncoding: "sgr" });
    expect(effectiveModes(HOME_MODES, false)).toMatchObject({ mouseTracking: "none" });
    expect(effectiveModes({ ...mouseModes, mouseTracking: "any", mouseEncoding: "urxvt" }, true)).toMatchObject({ mouseTracking: "any", mouseEncoding: "urxvt" });
    expect(effectiveModes({ ...HOME_MODES, syncOutput: true }, false).syncOutput).toBe(false);
  });

  test("BUG-172/F: bracketed paste is on on the real terminal for every session, whatever the agent asked", () => {
    expect(effectiveModes(HOME_MODES, false).bracketedPaste).toBe(true);
    expect(effectiveModes({ ...HOME_MODES, bracketedPaste: true }, true).bracketedPaste).toBe(true);
  });

  test("BUG-210/ring: ←/→ walk a ring of tabs with home (null) its leftmost, wrapping both ways", () => {
    expect(neighbour([1, 2, 3], 2, 1)).toBe(3);
    expect(neighbour([1, 2, 3], 2, -1)).toBe(1);
    expect(neighbour([1, 2, 3], 3, 1)).toBeNull();
    expect(neighbour([1, 2, 3], 1, -1)).toBeNull();
    // From home: the first session, or (wrapping) the last.
    expect(neighbour([1, 2, 3], null, 1)).toBe(1);
    expect(neighbour([1, 2, 3], null, -1)).toBe(3);
    expect(neighbour([], null, 1)).toBeNull();
    // A session gone from the ring counts as home.
    expect(neighbour([4], 9, 1)).toBe(4);
    expect(neighbour([4], 4, 1)).toBeNull();
  });
});

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
  async lines() {
    await this.parsed;
    return Array.from({ length: this.rows }, (_, y) => this.screen.viewLine(y).text);
  }
}

function fakeHome() {
  const calls: string[] = [];
  let input: PassThrough | undefined;
  let output: NodeJS.WriteStream | undefined;
  /** The mouse reports it got, and what it does with each (a click on a row opens a session). */
  const mice: MouseReport[] = [];
  let onMouse: (m: MouseReport) => void = () => {};
  const view: HomeView = {
    mouse: (m) => void (mice.push(m), onMouse(m)),
    mount: (i, o) => void (calls.push("mount"), (input = i as unknown as PassThrough), (output = o)),
    suspend: async () => void calls.push("suspend"),
    resume: async () => void calls.push("resume"),
    unmount: async () => void calls.push("unmount"),
  };
  /** What the home view writes (as Ink would, through the stream it was mounted with). */
  const write = (s: string) => output!.write(s);
  return { view, calls, mice, read: () => String(input?.read() ?? ""), write, onMouse: (f: (m: MouseReport) => void) => void (onMouse = f) };
}

function fakeSession(): ViewSession & { inputs: Key[]; mice: string[]; screen: TermScreen; holdsLine: boolean; awaitsChoice: boolean; setQuestion(q: string | null): void; changed(): void } {
  const screen = createScreen(98, 25, { scrollback: 200 });
  const change = new Set<() => void>();
  const question = new Set<(q: string | null) => void>();
  let q: string | null = null;
  const s = {
    screen,
    alive: true,
    get question() {
      return q;
    },
    holdsLine: false,
    awaitsChoice: false,
    inputs: [] as Key[],
    mice: [] as string[],
    input: (k: Key) => void s.inputs.push(k),
    mouse: (b: string) => void s.mice.push(b),
    passthrough: () => {},
    resize: (c: number, r: number) => screen.resize(c, r),
    onChange: (fn: () => void) => (change.add(fn), () => void change.delete(fn)),
    onQuestion: (fn: (q: string | null) => void) => (question.add(fn), () => void question.delete(fn)),
    setQuestion(v: string | null) {
      q = v;
      question.forEach((f) => f(v));
    },
    changed: () => change.forEach((f) => f()),
  };
  return s;
}

const tick = (ms = 40) => Bun.sleep(ms);
/**
 * Waits until `ok()` holds (a ceiling that scales with the machine), then asserts it. For what the compositor paints after the home view's model
 * has parsed a frame and its output is quiet (`SELECTION_QUIET_MS`): a fixed `tick` is too short where timers tick every 15 ms and the loop is busy.
 */
async function until(ok: () => boolean, ms = 5000 * SLOW) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(5);
  expect(ok()).toBe(true);
}

describe("the compositor on fake streams", () => {
  let c: Compositor | undefined;
  afterEach(async () => {
    await c?.stop();
    c = undefined;
  });

  async function setup({ mouseCapture = true } = {}) {
    const out = new FakeOut(100, 30);
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin }) as unknown as NodeJS.ReadStream;
    const store = new SessionStore();
    const home = fakeHome();
    c = new Compositor({ store, home: home.view, homeKey: "ctrl+\\", mouseCapture, truecolor: true, stdin, stdout: out as unknown as NodeJS.WriteStream });
    await c.start();
    const add = async (name: string) => {
      const s = fakeSession();
      const v = store.launched(name, { harness: "claude-code", model: "opus", effort: "high" }, { alive: true, end: async () => {} });
      c!.add(v.id, s);
      return { id: v.id, s };
    };
    return { out, store, home, add, c: c!, stdin };
  }

  test("starts on the alternate screen with every mode off (but its own clicks: BUG-269), home view mounted; stop gives the terminal back", async () => {
    const { out, home, c } = await setup();
    expect(out.raw).toStartWith(`\x1b[?1049h${MODES_RESET}`);
    expect(home.calls).toEqual(["mount"]);
    await c.stop();
    expect(out.raw).toEndWith(`${MODES_RESET}\x1b[?1049l`);
    expect(home.calls).toEqual(["mount", "unmount"]);
  });

  test("BUG-269/GLUON-51: at home Gluon asks for SGR clicks (none without mouse_capture); reports go to the home view's mouse, never into its input; none while a question is up; the rest of a click that opened a session never reaches its agent", async () => {
    const { out, home, add, c } = await setup();
    expect(out.raw).toStartWith(`\x1b[?1049h${MODES_RESET}\x1b[?1002h\x1b[?1006h`);
    const a = await add("alpha");
    // A press and a wheel notch: the home view's, not text; the press's release is Gluon's too (it goes nowhere).
    c.dispatch(keys("\x1b[<0;10;12M\x1b[<0;10;12m\x1b[<64;5;5M"));
    expect(home.mice.map((m) => [m.x, m.y, m.release, m.wheel])).toEqual([
      [10, 12, false, null],
      [5, 5, false, "up"],
    ]);
    expect(home.read()).toBe("");
    // A question on the last row: the mouse goes nowhere until it is answered.
    const asked = c.confirm("Quit Gluon?");
    c.dispatch(keys("\x1b[<0;10;12M\x1b[<0;10;12m\x1b[<64;5;5M"));
    expect(home.mice).toHaveLength(2);
    c.dispatch(keys("\x1b"));
    expect(await asked).toBe(false);
    // A click that opens a session (an agent that tracks the mouse): its release, in the same read, isn't the agent's.
    await a.s.screen.write("\x1b[?1000h\x1b[?1006h");
    home.onMouse((m) => !m.release && void c.open(a.id));
    c.dispatch(keys("\x1b[<0;10;12M\x1b[<0;10;12m"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(a.s.mice).toEqual([]);
    expect(a.s.inputs).toEqual([]);
    // Back home: Gluon's clicks again.
    const mark = out.raw.length;
    await c.home();
    expect(out.raw.slice(mark)).toContain(`${MODES_RESET}\x1b[?1002h\x1b[?1006h`);
    await c.stop();
    // Without mouse_capture: no mouse at home, a (late) report goes nowhere.
    const off = await setup({ mouseCapture: false });
    expect(off.out.raw).not.toContain("\x1b[?1002h");
    off.c.dispatch(keys("\x1b[<0;10;12M\x1b[<0;10;12m"));
    expect(off.home.mice).toEqual([]);
    expect(off.home.read()).toBe("");
  });

  test("BUG-286/GLUON-61: a drag over the home view's text selects it (reversed on the terminal) and the release copies it (OSC 52, 'Copied' on the last row); a click without a drag is the home view's, delivered at its release; a key, a press or a changed screen ends the selection", async () => {
    const { out, home, c } = await setup();
    const frame = "\x1b[1;1Hhello world\x1b[2;1Hsecond line\x1b[3;1Hthird line";
    home.write(frame);
    await tick();
    // Press, drag over other cells, release: none of it is the home view's, and the home view's screen keeps its text.
    let mark = out.raw.length;
    c.dispatch(keys("\x1b[<0;7;1M"));
    expect(home.mice).toEqual([]);
    c.dispatch(keys("\x1b[<32;7;2M\x1b[<32;5;3M"));
    await until(() => out.raw.slice(mark).includes("\x1b[0;7mw")); // "world" on the first row, reversed
    c.dispatch(keys("\x1b[<0;5;3m"));
    expect(home.mice).toEqual([]);
    await until(() => out.raw.slice(mark).includes(`\x1b]52;c;${Buffer.from("world\nsecond line\nthird").toString("base64")}\x07`));
    expect(out.raw.slice(mark)).toContain(" Copied 23 characters");
    // Gluon's own redraw of a frame with the same text paints the highlight again (once the home view's output is quiet and its model has parsed it).
    mark = out.raw.length;
    home.write(frame);
    await until(() => out.raw.slice(mark).includes("\x1b[0;7mw"));
    // A frame whose text under it changed: the selection is gone, and not painted again.
    mark = out.raw.length;
    home.write("\x1b[1;7Hxorld");
    await tick();
    expect(out.raw.slice(mark)).not.toContain("\x1b[0;7m");
    // A click (a press and a release on one cell) is the home view's, a press at its release.
    c.dispatch(keys("\x1b[<0;10;12M"));
    expect(home.mice).toEqual([]);
    c.dispatch(keys("\x1b[<0;10;12m"));
    expect(home.mice.map((m) => [m.x, m.y, m.release])).toEqual([[10, 12, false]]);
    // The wheel is the home view's all along.
    c.dispatch(keys("\x1b[<64;5;5M"));
    expect(home.mice.map((m) => m.wheel)).toEqual([null, "up"]);
    // A key ends a selection and paints it back as the screen has it ...
    home.write(frame);
    await tick();
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;3;1M\x1b[<0;3;1m"));
    mark = out.raw.length;
    c.dispatch(keys("x"));
    expect(out.raw.slice(mark)).toContain("\x1b[0mh");
    expect(out.raw.slice(mark)).not.toContain("\x1b[0;7m");
    expect(home.read()).toBe("x");
    // ... so does the next press (a click elsewhere: the selection is painted back at once, the click comes with its release).
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;3;1M\x1b[<0;3;1m"));
    mark = out.raw.length;
    c.dispatch(keys("\x1b[<0;30;20M"));
    expect(out.raw.slice(mark)).toContain("\x1b[0mh");
    c.dispatch(keys("\x1b[<0;30;20m"));
    // A drag over blank cells copies nothing.
    mark = out.raw.length;
    c.dispatch(keys("\x1b[<0;50;20M\x1b[<32;60;20M\x1b[<0;60;20m"));
    expect(out.raw.slice(mark)).not.toContain("\x1b]52;");
    // Without mouse_capture: no selection, no model.
    await c.stop();
    const off = await setup({ mouseCapture: false });
    off.home.write(frame);
    off.c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;3;1M\x1b[<0;3;1m"));
    expect(off.out.raw).not.toContain("\x1b]52;");
  });

  // QA triage of PR #69 (known, "not addressed"): a press and a release one cell apart (a trackpad's jitter, an SGR report per cell crossed)
  // is a two-character selection, and the click on a row or an option is lost. `homeMouse` has no distance threshold.
  test("BUG-657/QA-ui-01: a press and a release one cell apart is still a click on the home view, not a selection that eats it (PR #69)", async () => {
    const { out, home, c } = await setup();
    home.write("\x1b[1;1Hhello world\x1b[2;1Hsecond line");
    await tick();
    const mark = out.raw.length;
    c.dispatch(keys("\x1b[<0;3;1M\x1b[<32;4;1M\x1b[<0;4;1m"));
    expect(out.raw.slice(mark)).not.toContain("\x1b]52;");
    expect(home.mice.map((m) => [m.release, m.motion])).toEqual([[false, false]]);
  });

  test("BUG-657/variants: a press and release a cell apart (up, down, diagonal; with or without motion reports) is a click; two cells apart, or a jitter that goes on, is a selection from the press's cell", async () => {
    const { out, home, c } = await setup();
    home.write("\x1b[1;1Hhello world\x1b[2;1Hsecond line");
    await tick();
    for (const [x, y] of [[2, 1], [4, 1], [3, 2], [4, 2], [2, 2]]) {
      home.mice.length = 0;
      const mark = out.raw.length;
      c.dispatch(keys(`\x1b[<0;3;1M\x1b[<32;${x};${y}M\x1b[<0;${x};${y}m`));
      expect(out.raw.slice(mark)).not.toContain("\x1b]52;");
      expect(home.mice.map((m) => [m.release, m.motion, m.x, m.y])).toEqual([[false, false, 3, 1]]);
    }
    // No motion report at all (a terminal that coalesces them): the release alone, a cell away.
    home.mice.length = 0;
    c.dispatch(keys("\x1b[<0;3;1M\x1b[<0;4;1m"));
    expect(home.mice.map((m) => [m.release, m.motion])).toEqual([[false, false]]);
    // Two cells away is a selection: nothing reaches the home view, the cells are copied.
    home.mice.length = 0;
    let mark = out.raw.length;
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;3;1M\x1b[<0;3;1m"));
    expect(out.raw.slice(mark)).toContain(`\x1b]52;c;${Buffer.from("hel").toString("base64")}\x07`);
    expect(home.mice).toEqual([]);
    // A jitter that goes on: the selection starts at the press's cell, not where it got past the threshold.
    mark = out.raw.length;
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;2;1M\x1b[<32;4;1M\x1b[<0;4;1m"));
    expect(out.raw.slice(mark)).toContain(`\x1b]52;c;${Buffer.from("hell").toString("base64")}\x07`);
    expect(home.mice).toEqual([]);
    // Without motion reports, two cells away is a selection too.
    mark = out.raw.length;
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<0;3;1m"));
    expect(out.raw.slice(mark)).toContain(`\x1b]52;c;${Buffer.from("hel").toString("base64")}\x07`);
    expect(home.mice).toEqual([]);
  });

  test("BUG-286/GLUON-61: a drag at home while a question is up selects nothing; a drag during a session never reaches the home view or the clipboard; a trip to a session and back, or a resize, drops the selection", async () => {
    const { out, home, add, c } = await setup();
    home.write("\x1b[1;1Hhello world");
    await tick();
    const asked = c.confirm("Quit Gluon?");
    const mark = out.raw.length;
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;5;1M\x1b[<0;5;1m"));
    expect(out.raw.slice(mark)).not.toContain("\x1b]52;");
    c.dispatch(keys("\x1b"));
    expect(await asked).toBe(false);
    // Selected, then a session shown and home again: the home view draws anew; no selection is left.
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;5;1M\x1b[<0;5;1m"));
    const a = await add("alpha");
    await c.open(a.id);
    // A drag in the session's frame: not the home view's, and never copied.
    const shown = out.raw.length;
    const seen = home.mice.length;
    c.dispatch(keys("\x1b[<0;10;10M\x1b[<32;20;10M\x1b[<0;20;10m"));
    expect(home.mice).toHaveLength(seen);
    expect(out.raw.slice(shown)).not.toContain("\x1b]52;");
    await c.home();
    const back = out.raw.length;
    home.write("\x1b[1;1Hhello world");
    await tick();
    expect(out.raw.slice(back)).not.toContain("\x1b[0;7m");
    // Selected again, then the terminal resized: no highlight is painted over the redrawn frame.
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;5;1M\x1b[<0;5;1m"));
    out.columns = 90;
    out.rows = 28;
    out.emit("resize");
    const resized = out.raw.length;
    home.write("\x1b[1;1Hhello world");
    await tick();
    expect(out.raw.slice(resized)).not.toContain("\x1b[0;7m");
    // And a drag on the resized screen works as before.
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;5;1M\x1b[<0;5;1m"));
    expect(out.raw.slice(resized)).toContain(`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`);
  });

  test("BUG-286/GLUON-61: a drag queued behind a frame the home view's model hasn't parsed is dropped when a session is shown meanwhile: no highlight is painted over the session, nothing copied", async () => {
    const { out, home, add, c } = await setup();
    home.write("\x1b[1;1Hhello world");
    await tick();
    const a = await add("alpha");
    home.write("\x1b[1;1HHELLO world");
    c.dispatch(keys("\x1b[<0;1;1M\x1b[<32;5;1M\x1b[<0;5;1m"));
    await c.open(a.id);
    const mark = out.raw.length;
    await tick(100);
    expect(out.raw.slice(mark)).not.toContain("\x1b[0;7m");
    expect(out.raw.slice(mark)).not.toContain("\x1b]52;");
    expect(home.mice).toEqual([]);
  });

  test("BUG-272/GLUON-56: a double-click at home whose first click opened a session: its second click (press, drag, release; reads of their own) never reaches the agent; a click after DOUBLE_CLICK_MS does, as does one at home that opened nothing", async () => {
    const { home, add, c } = await setup();
    const a = await add("alpha");
    await a.s.screen.write("\x1b[?1000h\x1b[?1006h");
    home.onMouse((m) => !m.release && void c.open(a.id));
    const click = "\x1b[<0;10;12M\x1b[<0;10;12m";
    c.dispatch(keys(click));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    c.dispatch(keys("\x1b[<0;10;12M"));
    c.dispatch(keys("\x1b[<32;11;12M"));
    c.dispatch(keys("\x1b[<0;10;12m"));
    await tick();
    expect(a.s.mice).toEqual([]);
    // Later, a click is the agent's (moved into its screen).
    await Bun.sleep(DOUBLE_CLICK_MS + 50);
    c.dispatch(keys(click));
    expect(a.s.mice).toEqual(["\x1b[<0;9;8M", "\x1b[<0;9;8m"]);
    // A click at home that opened nothing (off the list), then the session opened by a key: its click is the agent's.
    a.s.mice.length = 0;
    await c.home();
    home.onMouse(() => {});
    c.dispatch(keys(click));
    await c.open(a.id);
    c.dispatch(keys(click));
    expect(a.s.mice).toEqual(["\x1b[<0;9;8M", "\x1b[<0;9;8m"]);
  });

  describe("zoom", () => {
    const HOME = "\x1c";
    const size = (s: { screen: TermScreen }) => [s.screen.cols, s.screen.rows];
    async function zoomed() {
      const t = await setup();
      const a = await t.add("alpha");
      const b = await t.add("beta");
      await t.c.open(a.id);
      const pick = async (bytes: string) => {
        t.c.dispatch(keys(bytes));
        await tick();
      };
      return { ...t, a, b, pick, bar: async () => (await t.out.lines())[29]! };
    }

    test("BUG-284/zoom: the home key then z gives the shown session the whole terminal but the last row (no tab strip, info line or frame; only its PTY resizes); z again brings the frame back", async () => {
      const { out, a, b, pick, bar, c } = await zoomed();
      expect(size(a.s)).toEqual([98, 24]);
      expect((await out.lines())[0]).toMatch(/^ ◆ gluon/);
      await a.s.screen.write("TOP LEFT");
      await pick(HOME);
      await pick("z");
      expect(c.current).toEqual({ kind: "session", id: a.id });
      expect(size(a.s)).toEqual([100, 29]);
      // The others keep the interior: a toggle is no SIGWINCH for them.
      expect(size(b.s)).toEqual([98, 24]);
      const lines = await out.lines();
      expect(lines[0]).toBe("TOP LEFT");
      expect(lines.slice(0, 29).join("\n")).not.toMatch(/[┌│└◆]/);
      expect(await bar()).toMatch(/^ zoomed · ctrl\+\\ z back · ctrl\+\\ sessions/);
      // The agent's keys still reach it.
      await pick("x");
      expect(a.s.inputs.map((k) => k.raw)).toEqual(["x"]);
      await pick(HOME);
      expect(await bar()).toMatch(/^ ←\/→ switch session · ctrl\+\\ home · esc cancel · z unzoom/);
      await pick("z");
      expect(size(a.s)).toEqual([98, 24]);
      expect((await out.lines())[0]).toMatch(/^ ◆ gluon/);
      // The line is typed (x): no switch key in the bar (BUG-241), as before the zoom.
      expect(await bar()).toMatch(/^ ctrl\+\\ sessions/);
      // A pasted z is no pick: the prefix ends, the paste goes to the agent, nothing zooms.
      await pick(HOME);
      await pick("\x1b[200~z\x1b[201~");
      expect(size(a.s)).toEqual([98, 24]);
    });

    test("BUG-284/zoom: zoom ends with the tab (switching, home), and the session is the interior again; the next one is framed", async () => {
      const { out, a, b, pick, bar, c } = await zoomed();
      await pick(HOME);
      await pick("z");
      await pick(HOME);
      await pick("\x1b[C");
      expect(c.current).toEqual({ kind: "session", id: b.id });
      expect(size(a.s)).toEqual([98, 24]);
      expect(size(b.s)).toEqual([98, 24]);
      expect((await out.lines())[0]).toMatch(/^ ◆ gluon/);
      expect(await bar()).toMatch(/ctrl\+\\ sessions/);
      // Back to a, zoom, then home: the same.
      await c.open(a.id);
      await pick(HOME);
      await pick("z");
      expect(size(a.s)).toEqual([100, 29]);
      await c.home();
      expect(size(a.s)).toEqual([98, 24]);
      // Reopened, it is framed (zoom doesn't stick to the session).
      await c.open(a.id);
      expect((await out.lines())[0]).toMatch(/^ ◆ gluon/);
      expect(size(a.s)).toEqual([98, 24]);
    });

    test("BUG-284/zoom: a resize while zoomed keeps the zoom: the shown session gets the new whole-but-last-row size, the others the new interior", async () => {
      const { out, a, b, pick } = await zoomed();
      await pick(HOME);
      await pick("z");
      out.screen.resize(120, 40);
      out.columns = 120;
      out.rows = 40;
      out.emit("resize");
      await tick();
      expect(size(a.s)).toEqual([120, 39]);
      expect(size(b.s)).toEqual([118, 34]);
      expect((await out.lines()).slice(0, 39).join("\n")).not.toMatch(/[┌│└◆]/);
    });

    test("BUG-284/zoom: below 20×6 only tooSmall is drawn (the pick is ignored there); growing back, the zoom is still on and nothing stale is left", async () => {
      const { out, a, b, pick, bar } = await zoomed();
      await pick(HOME);
      await pick("z");
      const resize = async (cols: number, rows: number) => {
        out.screen.resize(cols, rows);
        out.columns = cols;
        out.rows = rows;
        out.emit("resize");
        await tick();
      };
      await resize(15, 5);
      expect(size(a.s)).toEqual([20, 5]);
      expect(size(b.s)).toEqual([18, 1]);
      expect((await out.lines()).join("\n")).toContain("too small");
      // The pick while small does nothing: the zoom is as it was.
      await pick(HOME);
      await pick("z");
      await resize(100, 30);
      expect(size(a.s)).toEqual([100, 29]);
      expect(size(b.s)).toEqual([98, 24]);
      expect((await out.lines()).slice(0, 29).join("\n")).not.toMatch(/[┌│└◆]|too small/);
      expect(await bar()).toMatch(/^ zoomed/);
      await pick(HOME);
      await pick("z");
      expect(size(a.s)).toEqual([98, 24]);
    });

    test("BUG-284/zoom: removing the zoomed session goes home with no zoom left; a session added or opened after is framed at the interior", async () => {
      const { out, a, b, add, pick, c } = await zoomed();
      await pick(HOME);
      await pick("z");
      await c.remove(a.id);
      expect(c.current).toEqual({ kind: "home" });
      const g = await add("gamma");
      expect(size(g.s)).toEqual([98, 24]);
      await c.open(b.id);
      expect((await out.lines())[0]).toMatch(/^ ◆ gluon/);
      expect(size(b.s)).toEqual([98, 24]);
    });

    test("BUG-284/zoom: the last row stays Gluon's — the scroll indicator while scrolled back, the question, the prefix bar — and a click on it never reaches the agent", async () => {
      const { out, a, pick, bar } = await zoomed();
      await a.s.screen.write(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\r\n"));
      await pick(HOME);
      await pick("z");
      await pick("\x1b[5;2~");
      expect(await bar()).toMatch(/↑ \d+ · esc back/);
      expect(await bar()).toMatch(/^ zoomed/);
      await pick("\x1b");
      expect(await bar()).not.toContain("↑");
      a.s.setQuestion("End this session?");
      await tick();
      expect(await bar()).toMatch(/^ \? End this session\?/);
      a.s.setQuestion(null);
      await tick();
      // The agent asks for the mouse: a click inside is its (unshifted: the screen starts at the corner), on the last row nobody's.
      await a.s.screen.write("\x1b[?1000h\x1b[?1006h");
      await pick("\x1b[<0;10;1M\x1b[<0;10;1m");
      expect(a.s.mice).toEqual(["\x1b[<0;10;1M", "\x1b[<0;10;1m"]);
      a.s.mice.length = 0;
      await pick("\x1b[<0;10;30M\x1b[<0;10;30m");
      expect(a.s.mice).toEqual([]);
      expect(out.raw).toContain("zoomed");
    });
  });

  test("home: keys go on to the home view as typed; replies are dropped", async () => {
    const { home, stdin } = await setup();
    (stdin as unknown as PassThrough).write("ab\x1b]11;rgb:0/0/0\x07\r");
    await tick(80);
    expect(home.read()).toBe("ab\r");
  });

  test("BUG-208/compositor: win32-input-mode keys reach the home view as plain VT — the home key's Ctrl key-up, Enter's key-up, typed text, Enter, Backspace, arrows; nothing win32 leaks", async () => {
    const { home, add, c, stdin } = await setup();
    const a = await add("alpha");
    const press = (vk: number, sc: number, uc: number, cs = 0) => `\x1b[${vk};${sc};${uc};1;${cs};1_\x1b[${vk};${sc};${uc};0;${cs};1_`;
    await c.open(a.id);
    // Ctrl+\ in the session, twice with Ctrl held (the home key's prefix, then home): Ctrl down goes to the agent, \ is Gluon's; \'s key-ups are dropped, Ctrl's comes at home.
    c.dispatch(keys("\x1b[17;29;0;1;8;1_\x1b[220;43;28;1;8;1_"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    c.dispatch(keys("\x1b[220;43;28;0;8;1_\x1b[220;43;28;1;8;1_"));
    await tick();
    expect(c.current).toEqual({ kind: "home" });
    c.dispatch(keys("\x1b[220;43;28;0;8;1_\x1b[17;29;0;0;0;1_\x1b[13;28;13;0;0;1_"));
    expect(home.read()).toBe("");
    (stdin as unknown as PassThrough).write(press(72, 35, 104) + press(73, 23, 105) + press(8, 14, 8) + press(13, 28, 13) + press(38, 72, 0) + press(37, 75, 0) + press(39, 77, 0));
    await tick(80);
    expect(home.read()).toBe("hi\x7f\r\x1b[A\x1b[D\x1b[C");
    // The quit question takes Enter's key-down; its key-up never reaches the home view.
    const yes = c.confirm("quit?");
    c.dispatch(keys(press(13, 28, 13)));
    expect(await yes).toBe(true);
    expect(home.read()).toBe("");
  });

  test("a session in the frame: chrome, the agent's cells inside, its cursor; the home view suspended", async () => {
    const { out, home, add, c } = await setup();
    const { id, s } = await add("alpha");
    await s.screen.write("hello from the agent\r\n> ");
    await c.open(id);
    const lines = await out.lines();
    expect(home.calls).toEqual(["mount", "suspend"]);
    expect(lines[0]).toMatch(/^ ◆ gluon +● alpha/);
    expect(lines[1]).toMatch(/^ claude code × opus × high · now/);
    expect(lines[3]).toMatch(/^┌─ claude code × opus × high ─+┐$/);
    expect(lines[2]).toBe("");
    expect(lines[4]).toBe(`│hello from the agent${" ".repeat(78)}│`);
    // The only tab: nothing to switch to, home has its key (BUG-241).
    expect(lines[29]).toMatch(/^ ctrl\+\\ sessions/);
    expect(out.screen.cursor()).toEqual({ x: 3, y: 5 });
    // Gluon asked for the wheel (the agent has no mouse tracking).
    expect(out.raw).toContain("\x1b[?1002l\x1b[?1000h");
  });

  test("switching applies the next session's modes and undoes the last one's; home resets them all", async () => {
    const { out, add, c, home } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await a.s.screen.write("\x1b[>1u\x1b[?2004hALPHA");
    await b.s.screen.write("BETA");
    await c.open(a.id);
    expect(out.raw).toContain("\x1b[?2004h");
    expect(out.raw).toContain("\x1b[>1u");
    let mark = out.raw.length;
    c.dispatch(keys("\x1b[C"));
    await tick();
    const toB = out.raw.slice(mark);
    // Bracketed paste stays on whatever the session asked (BUG-172); its kitty keys go.
    expect(toB).not.toContain("\x1b[?2004l");
    expect(toB).toContain("\x1b[<u");
    expect((await out.lines())[4]).toStartWith("│BETA");
    mark = out.raw.length;
    // A mode the active session changes reaches the real terminal on its next paint.
    await b.s.screen.write("\x1b[?1004h");
    b.s.changed();
    await tick();
    expect(out.raw.slice(mark)).toContain("\x1b[?1004h");
    mark = out.raw.length;
    // The home key, then the home key again.
    c.dispatch(keys("\x1c"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: b.id });
    c.dispatch(keys("\x1c"));
    await tick();
    expect(out.raw.slice(mark)).toContain(MODES_RESET);
    expect(home.calls.at(-1)).toBe("resume");
    expect(c.current).toEqual({ kind: "home" });
  });

  test("background output only updates that session's model; the shown one repaints only what changed", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await c.open(a.id);
    await tick();
    const mark = out.raw.length;
    await b.s.screen.write("background text");
    b.s.changed();
    await tick();
    expect(out.raw.slice(mark)).toBe("");
    await a.s.screen.write("x");
    a.s.changed();
    await tick();
    const repaint = out.raw.slice(mark);
    // One row of the interior (and the cursor), not the chrome.
    expect(repaint.match(/\x1b\[\d+;2H/g)?.length).toBe(1);
    expect(repaint).not.toContain("◆ gluon");
  });

  test("scroll mode: the wheel scrolls back through the scrollback with an indicator; q returns to the live screen", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    await a.s.screen.write(Array.from({ length: 60 }, (_, i) => `LINE ${i + 1}`).join("\r\n"));
    await c.open(a.id);
    expect((await out.lines())[4]).toContain("LINE 37");
    c.dispatch(keys("\x1b[<64;10;10M\x1b[<64;10;10M"));
    await tick();
    let lines = await out.lines();
    expect(lines[4]).toContain("LINE 31");
    expect(lines[28]).toMatch(/↑ 6 · esc back ─┘$/);
    c.dispatch(keys("q"));
    await tick();
    lines = await out.lines();
    expect(lines[4]).toContain("LINE 37");
    expect(lines[28]).not.toContain("esc back");
    // q was Gluon's: the agent didn't get it.
    expect(a.s.inputs).toEqual([]);
  });

  test("the question replaces the bottom bar; Enter goes to the session as its answer", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    await c.open(a.id);
    a.s.setQuestion("End this session?");
    await tick();
    expect((await out.lines())[29]).toMatch(/^ \? End this session\? +enter yes · esc no/);
    c.dispatch(keys("\r"));
    expect(a.s.inputs.map((k) => k.name)).toEqual(["enter"]);
    a.s.setQuestion(null);
    await tick();
    expect((await out.lines())[29]).toMatch(/^ ctrl\+\\ sessions/);
  });

  test("BUG-409/launch-modes: a session's note is drawn wrapped over its frame (shown now, or when it is opened), stays over the agent's output, and Esc hides it without reaching the agent", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    const line = "/plan Read the session brief in /tmp/gluon-abcdef/0123456789abcdef/spec.md and start.";
    const note = `couldn't type the first line into Codex (its composer didn't show); type this yourself: ${line}`;
    // Not shown: it waits for the session to be opened.
    c.note(b.id, note);
    await c.open(a.id);
    await tick();
    expect((await out.lines()).join("\n")).not.toContain("type this yourself");
    c.note(a.id, note);
    await tick();
    const shown = (await out.lines()).slice(4, 10).join(" ").replace(/[│\s]+/g, " ");
    expect(shown).toContain(note);
    expect(shown).toContain("esc hides this note");
    // The agent writes under it: the note is still on top.
    await a.s.screen.write("\x1b[H\x1b[2Jagent output");
    a.s.changed();
    await tick();
    expect((await out.lines()).slice(4, 10).join(" ").replace(/[│\s]+/g, " ")).toContain(note);
    // Esc is Gluon's while it is up; the next one is the agent's.
    c.dispatch(keys("\x1b"));
    await tick();
    expect(a.s.inputs).toEqual([]);
    const after = (await out.lines()).join("\n");
    expect(after).not.toContain("type this yourself");
    expect(after).toContain("agent output");
    c.dispatch(keys("\x1b"));
    expect(a.s.inputs.map((k) => k.name)).toEqual(["escape"]);
    // The other session's note is there when it is opened.
    await c.open(b.id);
    await tick();
    expect((await out.lines()).slice(4, 10).join(" ").replace(/[│\s]+/g, " ")).toContain(note);
  });

  test("a resize reaches every session and redraws the frame at the new size", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await c.open(a.id);
    out.columns = 120;
    out.rows = 40;
    out.screen.resize(120, 40);
    out.emit("resize");
    await tick();
    expect([a.s.screen.cols, a.s.screen.rows, b.s.screen.cols, b.s.screen.rows]).toEqual([118, 34, 118, 34]);
    const lines = await out.lines();
    expect(lines[3]).toMatch(/^┌─.*┐$/);
    expect(Bun.stringWidth(lines[3]!)).toBe(120);
    expect(lines[38]).toMatch(/^└─+┘$/);
  });

  test("BUG-175/F: no wheel capture while the agent is on its alternate screen (the terminal's wheel-as-arrows reach it); back on the main screen, captured again", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    await a.s.screen.write("\x1b[?1049hFULLSCREEN");
    // The home view's clicks (BUG-269) go with it.
    const opened = out.raw.length;
    await c.open(a.id);
    expect(out.raw.slice(opened)).toContain("\x1b[?1002l");
    expect(out.raw.slice(opened)).not.toContain("\x1b[?1002h");
    c.dispatch(keys("\x1b[A"));
    expect(a.s.inputs.map((k) => k.raw)).toEqual(["\x1b[A"]);
    let mark = out.raw.length;
    await a.s.screen.write("\x1b[?1049l");
    a.s.changed();
    await tick();
    expect(out.raw.slice(mark)).toContain("\x1b[?1000h");
    mark = out.raw.length;
    await a.s.screen.write("\x1b[?1049h");
    a.s.changed();
    await tick();
    expect(out.raw.slice(mark)).toContain("\x1b[?1000l");
  });

  test("BUG-170/F: a → split across two reads 100 ms apart (SSH) is still one key: the session switches; Alt+PgDn split the same way reaches the agent whole", async () => {
    const { add, c, stdin } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await c.open(a.id);
    (stdin as unknown as PassThrough).write("\x1b[1");
    await tick(100);
    (stdin as unknown as PassThrough).write("C");
    await tick(100);
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(a.s.inputs).toEqual([]);
    expect(b.s.inputs).toEqual([]);
    (stdin as unknown as PassThrough).write("\x1b[6;");
    await tick(100);
    (stdin as unknown as PassThrough).write("3~");
    await tick(100);
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(b.s.inputs.map((k) => k.raw)).toEqual(["\x1b[6;3~"]);
  });

  test("BUG-279/F: the home key then ←/→ switches in every state — typed line, question up (left pending), scrolled back — and wraps home at both ends; the bar says what the next key does", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    const g = await add("gamma");
    const pick = async (bytes: string) => {
      c.dispatch(keys(bytes));
      await tick();
    };
    const bar = async () => (await out.lines())[29]!;
    const HOME = "\x1c";
    const LEFT = "\x1b[D";
    const RIGHT = "\x1b[C";
    // A typed line: the arrows are the agent's, the prefix still switches; the home key is not typed.
    await c.open(b.id);
    await pick("x");
    await pick(LEFT);
    expect(c.current).toEqual({ kind: "session", id: b.id });
    await pick(HOME);
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(await bar()).toMatch(/^ ←\/→ switch session · ctrl\+\\ home · esc cancel/);
    await pick(RIGHT);
    expect(c.current).toEqual({ kind: "session", id: g.id });
    expect(await bar()).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions/);
    expect(b.s.inputs.map((k) => k.raw)).toEqual(["x", LEFT]);
    // Wraps home at both ends: → from the last tab, ← from the first.
    await pick(HOME);
    await pick(RIGHT);
    expect(c.current).toEqual({ kind: "home" });
    await c.open(a.id);
    await pick(HOME);
    await pick(LEFT);
    expect(c.current).toEqual({ kind: "home" });
    // The home key twice is home.
    await c.open(g.id);
    await pick(HOME);
    await pick(HOME);
    expect(c.current).toEqual({ kind: "home" });
    // The question up: the bar shows the prefix instead, the question stays pending on its tab.
    await c.open(b.id);
    b.s.setQuestion("End this session?");
    await tick();
    expect(await bar()).toMatch(/^ \? End this session\?/);
    await pick(HOME);
    expect(await bar()).toMatch(/^ ←\/→ switch session · ctrl\+\\ home · esc cancel/);
    await pick(LEFT);
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(b.s.question).toBe("End this session?");
    await c.open(b.id);
    expect(await bar()).toMatch(/^ \? End this session\?/);
    expect(b.s.inputs).toEqual([expect.objectContaining({ raw: "x" }), expect.objectContaining({ raw: LEFT })]);
    // Scrolled back.
    await g.s.screen.write(Array.from({ length: 60 }, (_, i) => `LINE ${i + 1}`).join("\r\n"));
    await c.open(g.id);
    await pick("\x1b[<64;10;10M");
    expect((await out.lines())[28]).toContain("esc back");
    await pick(HOME);
    await pick(LEFT);
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(g.s.inputs).toEqual([]);
  });

  test("BUG-279/F: Esc cancels the home key, any other key ends it and is routed as usual, a switch away or home ends it; BUG-706: time doesn't", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    const pick = async (bytes: string) => {
      c.dispatch(keys(bytes));
      await tick();
    };
    const bar = async () => (await out.lines())[29]!;
    const HOME = "\x1c";
    const LEFT = "\x1b[D";
    await c.open(b.id);
    // Esc: nothing for the agent, the bar goes back.
    await pick(HOME);
    await pick("\x1b");
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(await bar()).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions/);
    expect(b.s.inputs).toEqual([]);
    // Any other key ends it and goes on to the agent; a ← after it is the agent's now (the line is touched).
    await pick(HOME);
    await pick("x");
    expect(b.s.inputs.map((k) => k.raw)).toEqual(["x"]);
    await pick(LEFT);
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(b.s.inputs.map((k) => k.raw)).toEqual(["x", LEFT]);
    // A Gluon key is routed as usual too: Shift+PgUp scrolls, as it would alone.
    await b.s.screen.write(Array.from({ length: 60 }, (_, i) => `LINE ${i + 1}`).join("\r\n"));
    await pick(HOME);
    await pick("\x1b[5;2~");
    expect((await out.lines())[28]).toContain("esc back");
    expect(await bar()).not.toMatch(/esc cancel/);
    await pick("q");
    // BUG-706 (#113): time doesn't end it. Past the old 1.5 s wait the bar is still up and ← is Gluon's.
    await pick(HOME);
    expect(await bar()).toMatch(/esc cancel/);
    await Bun.sleep(1560);
    expect(await bar()).toMatch(/esc cancel/);
    await pick(LEFT);
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(await bar()).not.toMatch(/esc cancel/);
    expect(b.s.inputs.map((k) => k.raw)).toEqual(["x", LEFT]);
    await c.open(b.id);
    // Showing another session (a click, a call) or going home ends it.
    await pick(HOME);
    await c.open(a.id);
    await tick();
    expect(await bar()).not.toMatch(/esc cancel/);
    await pick(HOME);
    await c.home();
    await c.open(b.id);
    await tick();
    expect(await bar()).not.toMatch(/esc cancel/);
    await pick(LEFT);
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(a.s.inputs).toEqual([]);
  });


  test("BUG-282/GLUON-42: Esc that cancels the home key, then a key in a later read before the decoder's wait is over: the key reaches the agent alone, not as Alt+key (the Esc was Gluon's)", async () => {
    const { add, c, stdin } = await setup();
    const a = await add("alpha");
    await add("beta");
    await c.open(a.id);
    const write = (s: string) => (stdin as unknown as PassThrough).write(s);
    write("\x1c");
    await tick();
    write("\x1b");
    await tick(10);
    write("x");
    await tick(100);
    expect(a.s.inputs.map((k) => k.raw)).toEqual(["x"]);
    // Alone (no prefix) the bytes are the user's, ESC and x as typed, in one key.
    write("\x1b");
    await tick(10);
    write("y");
    await tick(100);
    expect(a.s.inputs.map((k) => k.raw).join("")).toBe("x\x1by");
  });

  test("BUG-283/GLUON-42: a modifier alone pressed while the home key waits (win32-input-mode's Ctrl down, kitty's all-keys modifier press) doesn't pick: the home key pressed again, Ctrl let go in between, goes home", async () => {
    const { add, c, stdin } = await setup();
    const a = await add("alpha");
    await add("beta");
    await c.open(a.id);
    const write = (s: string) => (stdin as unknown as PassThrough).write(s);
    // Windows Terminal: Ctrl down, \ down, \ up, Ctrl up; twice.
    const ctrlDown = "\x1b[17;29;0;1;8;1_";
    const ctrlUp = "\x1b[17;29;0;0;0;1_";
    const press = ctrlDown + "\x1b[220;43;28;1;8;1_" + "\x1b[220;43;28;0;8;1_" + ctrlUp;
    write(press);
    await tick(60);
    expect(c.current).toEqual({ kind: "session", id: a.id });
    write(press);
    await tick(60);
    expect(c.current).toEqual({ kind: "home" });
    // Kitty with every key reported: the modifier's press is an event of its own.
    await c.open(a.id);
    const kitty = "\x1b[57442;5u\x1b[92;5u\x1b[92;5:3u\x1b[57442;1:3u";
    write(kitty);
    await tick(60);
    write(kitty);
    await tick(60);
    expect(c.current).toEqual({ kind: "home" });
    // The agent got the modifiers as typed (never the home key's press), up to the one that went home.
    expect(a.s.inputs.map((k) => k.raw)).toEqual([ctrlDown, ctrlUp, ctrlDown, "\x1b[57442;5u", "\x1b[92;5:3u", "\x1b[57442;1:3u", "\x1b[57442;5u"]);
  });
  test("BUG-279/F: Alt+PgUp/PgDn go to the agent, in a session and at home (the home view's text, never a switch)", async () => {
    const { home, add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    const ALT_PGUP = "\x1b[5;3~";
    const ALT_PGDN = "\x1b[6;3~";
    c.dispatch(keys(ALT_PGDN + ALT_PGUP));
    await tick();
    expect(c.current).toEqual({ kind: "home" });
    expect(home.read()).toBe(ALT_PGDN + ALT_PGUP);
    await c.open(b.id);
    c.dispatch(keys(ALT_PGDN + ALT_PGUP));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(b.s.inputs.map((k) => k.raw)).toEqual([ALT_PGDN, ALT_PGUP]);
    expect(a.s.inputs).toEqual([]);
  });

  test("BUG-281/F: the bar names ←/→ only while an arrow will switch (untouched line, more than one tab); once typed it is the home key alone; after Enter ←/→ again", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    const bar = async () => (await out.lines())[29]!;
    await c.open(a.id);
    // The only tab: nothing to switch to (BUG-241).
    expect(await bar()).toMatch(/^ ctrl\+\\ sessions/);
    expect(await bar()).not.toContain("←/→");
    const b = await add("beta");
    await tick();
    expect(await bar()).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions/);
    c.dispatch(keys("x"));
    await tick();
    expect(await bar()).toMatch(/^ ctrl\+\\ sessions( |$)/);
    expect(await bar()).not.toMatch(/alt\+pg|←|switch/);
    c.dispatch(keys("\r"));
    await tick();
    expect(await bar()).toMatch(/^ ←\/→ switch session · ctrl\+\\ sessions/);
    expect(b.s.inputs).toEqual([]);
  });

  test("BUG-211/F: Esc and Ctrl+C reach the agent but don't count as typing: ← right after them still walks back; after typing it's still the agent's", async () => {
    const { add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await c.open(b.id);
    c.dispatch(keys("\x1b"));
    c.dispatch(keys("\x03"));
    c.dispatch(keys("\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(b.s.inputs.map((k) => k.raw)).toEqual(["\x1b", "\x03"]);
    await c.open(b.id);
    c.dispatch(keys("x"));
    c.dispatch(keys("\x03"));
    c.dispatch(keys("\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(b.s.inputs.map((k) => k.raw).slice(2)).toEqual(["x", "\x03", "\x1b[D"]);
  });

  test("BUG-234/F: a no (Esc or Ctrl+C) to a held /clear leaves its line typed: ← then goes to the agent, not to the previous tab", async () => {
    for (const no of ["\x1b", "\x03"]) {
      const { add, c } = await setup();
      const a = await add("alpha");
      const b = await add("beta");
      await c.open(b.id);
      c.dispatch(keys("\r"));
      await tick();
      b.s.setQuestion("End this session?");
      b.s.holdsLine = true;
      c.dispatch(keys(no));
      b.s.holdsLine = false;
      b.s.setQuestion(null);
      c.dispatch(keys("\x1b[D"));
      await tick();
      expect(c.current).toEqual({ kind: "session", id: b.id });
      expect(b.s.inputs.map((k) => k.raw)).toEqual(["\r", no, "\x1b[D"]);
      expect(a.s.inputs).toEqual([]);
      await c.stop();
    }
  });

  test("BUG-268/GLUON-50: `BBB` and three Backspaces leave the line untouched again: the bar names ←/→ again and ← walks back; any other key keeps it the agent's", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await c.open(b.id);
    c.dispatch(keys("BBB\x7f\x7f"));
    await tick();
    expect((await out.lines())[29]).toMatch(/^ ctrl\+\\ sessions( |$)/);
    c.dispatch(keys("\x7f"));
    await tick();
    expect((await out.lines())[29]).toMatch(/^ ←\/→ switch session/);
    c.dispatch(keys("\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(b.s.inputs.map((k) => k.raw).join("")).toBe("BBB\x7f\x7f\x7f");
    // Ctrl+U on the typed line: touched until Enter, Backspaces or not.
    await c.open(b.id);
    c.dispatch(keys("B\x15\x7f\x7f\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(b.s.inputs.map((k) => k.raw).join("")).toBe("BBB\x7f\x7f\x7f" + "B\x15\x7f\x7f\x1b[D");
    expect(a.s.inputs).toEqual([]);
  });

  test("BUG-705/issue-111: keys that answer the agent's own dialog (a digit, t, Tab, Down, Esc) leave an untouched line untouched: ←/→ still switch; a draft typed before stays the agent's", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await c.open(b.id);
    // Codex's hook review: the keys go to the dialog, the composer behind it stays empty.
    b.s.awaitsChoice = true;
    c.dispatch(keys("2t\t\x1b[B\x1b"));
    await tick();
    expect((await out.lines())[29]).toMatch(/^ ←\/→ switch session/);
    b.s.awaitsChoice = false;
    c.dispatch(keys("\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(b.s.inputs.map((k) => k.raw).join("")).toBe("2t\t\x1b[B\x1b");
    // A draft typed before the dialog came stays: the dialog's keys don't clear it, ← edits it.
    await c.open(b.id);
    c.dispatch(keys("hi"));
    b.s.awaitsChoice = true;
    c.dispatch(keys("1"));
    b.s.awaitsChoice = false;
    c.dispatch(keys("\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: b.id });
    // Enter ends the draft as ever, dialog or not.
    c.dispatch(keys("\r\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    // Not a dialog: a digit is typed text, and so is ← after a Tab.
    await c.open(b.id);
    c.dispatch(keys("\t\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: b.id });
  });

  // OpenCode's permission selector (Allow once / Allow always / Reject) is driven by ←/→ and Tab. The owner decided (QA report F11)
  // to keep the switching rule (BUG-195/280: with 2+ sessions, ←/→ on an untouched line switch in every state, the agent's dialog
  // included, as for Codex's dialogs and Kimi Code's question panel, BUG-705/663) and to document Tab instead
  // (`docs/guides/harnesses/opencode.md`). This pins that: no routing exception for a dialog.
  test("BUG-673/F11: with a dialog of the agent's own up (OpenCode's permission selector), ←/→ still switch sessions on an untouched line; Tab and Enter reach the agent", async () => {
    const { add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await c.open(b.id);
    b.s.awaitsChoice = true;
    c.dispatch(keys("\t\r"));
    await tick();
    expect(b.s.inputs.map((k) => k.raw)).toEqual(["\t", "\r"]);
    c.dispatch(keys("\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(b.s.inputs.map((k) => k.raw)).toEqual(["\t", "\r"]);
    await c.open(b.id);
    c.dispatch(keys("\x1b[C"));
    await tick();
    expect(c.current).toEqual({ kind: "home" });
    expect(b.s.inputs).toHaveLength(2);
  });

  test("BUG-206/F: → on the last tab (untouched line) goes home, nothing reaches the agent; a modified → there is the agent's and touches the line", async () => {
    const { add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await c.open(b.id);
    c.dispatch(keys("\x1b[C"));
    await tick();
    expect(c.current).toEqual({ kind: "home" });
    expect(b.s.inputs).toEqual([]);
    await c.open(b.id);
    c.dispatch(keys("\x1b[1;5C\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(b.s.inputs.map((k) => k.raw)).toEqual(["\x1b[1;5C", "\x1b[D"]);
    expect(a.s.inputs).toEqual([]);
  });

  test("BUG-280/F: Alt+←/→ on an untouched line never reach the agent (nor switch); on a touched line they do; → on the last tab goes home, ← on the first", async () => {
    const { add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    const ALT_LEFT = "\x1b[1;3D";
    const ALT_RIGHT = "\x1b[1;3C";
    const WIN32_ALT_LEFT = "\x1b[37;75;0;1;258;1_\x1b[37;75;0;0;258;1_";
    await c.open(a.id);
    c.dispatch(keys(ALT_LEFT + ALT_RIGHT + WIN32_ALT_LEFT));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(a.s.inputs).toEqual([]);
    // Typed: the agent's (cursor, word, dialog tabs).
    c.dispatch(keys("x" + ALT_LEFT + ALT_RIGHT));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(a.s.inputs.map((k) => k.raw)).toEqual(["x", ALT_LEFT, ALT_RIGHT]);
    // Plain arrows on the untouched line: wrap through home.
    await c.open(b.id);
    c.dispatch(keys("\x1b[C"));
    await tick();
    expect(c.current).toEqual({ kind: "home" });
    await c.open(a.id);
    await c.home();
    await c.open(b.id);
    c.dispatch(keys("\x1b[D"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(b.s.inputs).toEqual([]);
  });

  test("BUG-195/F: ←/→ walk the tabs while the line is untouched (from the user's keys); typed keys make them the agent's until Enter", async () => {
    const { add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    const view = () => c.current;
    await c.open(b.id);
    // Untouched since it started: ← the previous tab, → the next; → on the last tab is home.
    c.dispatch(keys("\x1b[D"));
    await tick();
    expect(view()).toEqual({ kind: "session", id: a.id });
    c.dispatch(keys("\x1b[C"));
    await tick();
    expect(view()).toEqual({ kind: "session", id: b.id });
    c.dispatch(keys("\x1b[C"));
    await tick();
    expect(view()).toEqual({ kind: "home" });
    expect(b.s.inputs).toEqual([]);
    await c.open(b.id);
    // Typed, then ←: the agent's (edits the line); one Backspace for two characters leaves one typed (BUG-268).
    c.dispatch(keys("xy\x7f\x1b[D"));
    await tick();
    expect(view()).toEqual({ kind: "session", id: b.id });
    expect(b.s.inputs.map((k) => k.raw)).toEqual(["x", "y", "\x7f", "\x1b[D"]);
    // Enter: untouched again. A win32 Enter key-up after it changes nothing; the arrow's key-down
    // switches and its key-up is dropped.
    c.dispatch(keys("\r\x1b[13;28;13;0;0;1_\x1b[37;75;0;1;256;1_\x1b[37;75;0;0;256;1_"));
    await tick();
    expect(view()).toEqual({ kind: "session", id: a.id });
    expect(b.s.inputs.map((k) => k.raw).join("")).toBe("xy\x7f\x1b[D\r\x1b[13;28;13;0;0;1_");
    // Each session keeps its own line: alpha's is untouched, ← goes home.
    c.dispatch(keys("\x1bOD"));
    await tick();
    expect(view()).toEqual({ kind: "home" });
    expect(a.s.inputs).toEqual([]);
    // The question up: the arrows answer nothing and switch nothing.
    await c.open(a.id);
    a.s.setQuestion("End this session?");
    c.dispatch(keys("\x1b[D"));
    await tick();
    expect(view()).toEqual({ kind: "session", id: a.id });
    // An agent that has exited has no line: a touched one walks the tabs too.
    await c.open(b.id);
    c.dispatch(keys("y"));
    (b.s as { alive: boolean }).alive = false;
    c.dispatch(keys("\x1b[D"));
    await tick();
    expect(view()).toEqual({ kind: "session", id: a.id });
  });

  test("BUG-196/F: a click on a tab shows that session; on ◆ gluon, home — with the agent's mouse on or off", async () => {
    const { add, c } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await b.s.screen.write("\x1b[?1000h\x1b[?1006h");
    await c.open(a.id);
    // ` ◆ gluon ` is 9 cells, then ` ● alpha ` (cells 10–18, 1-based), a gap, ` ● beta `.
    c.dispatch(keys("\x1b[<0;22;1M\x1b[<0;22;1m"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: b.id });
    expect(a.s.mice).toEqual([]);
    c.dispatch(keys("\x1b[<0;12;1M"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: a.id });
    expect(b.s.mice).toEqual([]);
    c.dispatch(keys("\x1b[<0;3;1M"));
    await tick();
    expect(c.current).toEqual({ kind: "home" });
  });

  test("BUG-212/F: a click on › or ‹ of an overflowing strip opens the nearest hidden tab on that side; the strip scrolls to it", async () => {
    const { out, add, c } = await setup();
    const all: { id: number; s: ReturnType<typeof fakeSession> }[] = [];
    for (let i = 1; i <= 9; i++) all.push(await add(`session-number-${i}`));
    await c.open(all[0]!.id);
    let strip = (await out.lines())[0]!;
    expect(strip.endsWith("›")).toBe(true);
    const lastShown = Number(/.*session-number-(\d)/.exec(strip)![1]);
    // › is the last cell of row 1 (1-based column 100).
    c.dispatch(keys("\x1b[<0;100;1M\x1b[<0;100;1m"));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: all[lastShown]!.id });
    strip = (await out.lines())[0]!;
    expect(strip).toContain(`session-number-${lastShown + 1}`);
    expect(strip).toContain("‹");
    const firstShown = Number(/session-number-(\d)/.exec(strip)![1]);
    c.dispatch(keys(`\x1b[<0;${strip.indexOf("‹") + 1};1M\x1b[<0;${strip.indexOf("‹") + 1};1m`));
    await tick();
    expect(c.current).toEqual({ kind: "session", id: all[firstShown - 2]!.id });
    // The clicks went to no agent.
    expect(all.every((x) => x.s.inputs.length === 0 && x.s.mice.length === 0)).toBe(true);
  });

  test("BUG-181/E:a session view on a terminal under 20×6 shows one line, never the bar over the frame; back to size, the frame again", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    await c.open(a.id);
    const to = async (cols: number, rows: number) => {
      out.columns = cols;
      out.rows = rows;
      out.screen.resize(cols, rows);
      out.emit("resize");
      await tick();
      return out.lines();
    };
    const small = await to(30, 5);
    expect(small[0]).toBe("too small · ctrl+\\ home");
    expect(small.slice(1).every((l) => l === "")).toBe(true);
    // The PTYs keep the layout's minimum.
    expect([a.s.screen.cols, a.s.screen.rows]).toEqual([28, 1]);
    const back = await to(40, 12);
    expect(back[2]).toMatch(/^┌─.*┐$/);
    expect(back[11]).toMatch(/ctrl\+\\ sessions/);
  });

  test("BUG-245/V-01: the home view's last row (outside its rows − 1 frame) stays on the ground — after the home view's frame erases it, and after a resize", async () => {
    const { out, home } = await setup();
    const ground = [1, 3, 5].map((i) => parseInt(GLUON_HEX.ground.slice(i, i + 2), 16));
    const onGround = async (y: number) => {
      await out.lines();
      return out.screen.cells(y).every((c) => c.bgMode === "rgb" && c.bg === (ground[0]! << 16) + (ground[1]! << 8) + ground[2]!);
    };
    expect(await onGround(29)).toBe(true);
    // Ink's frame: its erase (EL from a reset: the terminal's default) reaches the last row, then its rows − 1.
    home.write(`\x1b[30;1H\x1b[0m\x1b[2K\x1b[1;1H${"frame\r\n".repeat(29)}`);
    expect(await onGround(29)).toBe(true);
    // A taller terminal: its new rows come on the default background, the home view's frame is redrawn.
    out.rows = 34;
    out.screen.resize(100, 34);
    out.emit("resize");
    await tick();
    expect(await onGround(33)).toBe(true);
    home.write(`\x1b[1;1H${"frame\r\n".repeat(33)}`);
    expect(await onGround(33)).toBe(true);
  });

  test("BUG-192/compositor: the shown session's row removed (its agent ended) brings the sessions home; another one removed doesn't", async () => {
    const { home, add, c, store } = await setup();
    const a = await add("alpha");
    const b = await add("beta");
    await c.open(a.id);
    store.remove(b.id);
    await c.remove(b.id);
    expect(c.current).toEqual({ kind: "session", id: a.id });
    store.remove(a.id);
    await c.remove(a.id);
    expect(c.current).toEqual({ kind: "home" });
    expect(home.calls).toEqual(["mount", "suspend", "resume"]);
    expect(c.session(a.id)).toBeUndefined();
  });

  test("BUG-213/compositor: home's questions take only Enter (yes) and Esc or Ctrl+C (no) — y, n and other keys are ignored and reach no one", async () => {
    const { out, home, c } = await setup();
    const yes = c.confirm("2 sessions running — quit and end them?");
    expect((await out.lines())[29]).toMatch(/2 sessions running — quit and end them\? +enter yes · esc no/);
    let answered: boolean | null = null;
    void yes.then((v) => (answered = v));
    for (const k of ["x", "y", "Y", "n", "N", " ", "\x1b[A", "\x7f", "\x1b[200~y\x1b[201~", "\x1b[200~\r\x1b[201~"]) c.dispatch(keys(k));
    await tick();
    expect(answered).toBeNull();
    expect((await out.lines())[29]).toMatch(/quit and end them\?/);
    c.dispatch(keys("\r"));
    expect(await yes).toBe(true);
    expect(home.read()).toBe("");
    for (const k of ["\x1b", "\x03", "\x1b[99;5u", "\x1b[27u"]) {
      const no = c.confirm("Discard this chat?");
      c.dispatch(keys("n"));
      c.dispatch(keys(k));
      expect(await no).toBe(false);
    }
    // Kitty and win32 Enter say yes too.
    for (const k of ["\x1b[13u", "\x1b[13;28;13;1;0;1_"]) {
      const y = c.confirm("End Gluon-fix-add-bug?");
      c.dispatch(keys(k));
      expect(await y).toBe(true);
    }
    expect(home.read()).toBe("");
  });

  test("BUG-288/resume: choose() tells the user's no (Esc) from a question taken away (another question, a session opened); confirm() calls both no", async () => {
    const { add, c } = await setup();
    const a = await add("alpha");
    const user = c.choose("Start it again?");
    c.dispatch(keys("\x1b"));
    expect(await user).toBe(false);
    const yes = c.choose("Start it again?");
    c.dispatch(keys("\r"));
    expect(await yes).toBe(true);
    // Another question replaces it.
    const first = c.choose("Start it again?");
    const second = c.choose("End this session?");
    expect(await first).toBeNull();
    c.dispatch(keys("\r"));
    expect(await second).toBe(true);
    // A session opened from home takes it away.
    const third = c.choose("Start it again?");
    await c.open(a.id);
    expect(await third).toBeNull();
    await c.home();
    const old = c.confirm("Quit?");
    const newer = c.confirm("Discard?");
    expect(await old).toBe(false);
    c.dispatch(keys("\x1b"));
    expect(await newer).toBe(false);
  });

  test("BUG-299/resume: a question Gluon raises by itself ignores Enter, Esc and Ctrl+C for the guard; other keys (typing, a paste) close it as typed and reach the home view", async () => {
    const { home, c } = await setup();
    const q = c.choose("Start it again?", undefined, true);
    let answered: unknown = "pending";
    void q.then((v) => (answered = v));
    for (const k of ["\r", "\x1b", "\x03"]) c.dispatch(keys(k));
    await tick();
    expect(answered).toBe("pending");
    // The guard is over: Enter says yes.
    await tick(SELF_GUARD_MS + 50);
    c.dispatch(keys("\r"));
    expect(await q).toBe(true);
    // Typing is not an answer: it closes the question, and every key of it reaches the composer, the Enter after it too.
    const typed = c.choose("Start it again?", undefined, true);
    c.dispatch(keys("hi\r"));
    expect(await typed).toBe("typed");
    await tick();
    expect(home.read()).toBe("hi\r");
    // A paste, an arrow key and an Enter inside a paste are the user's as well.
    for (const k of ["\x1b[200~y\x1b[201~", "\x1b[A", "\x1b[200~\r\x1b[201~"]) {
      const again = c.choose("Start it again?", undefined, true);
      c.dispatch(keys(k));
      expect(await again).toBe("typed");
    }
    // An ordinary question stays as it was (BUG-213): no guard, typing ignored, Ctrl+C is no.
    const plain = c.choose("End it?");
    c.dispatch(keys("x"));
    c.dispatch(keys("\r"));
    expect(await plain).toBe(true);
    expect(home.read()).not.toContain("x");
  });

  test("BUG-300/resume: Ctrl+C on a question Gluon raised by itself is keep (not no); Esc is no; the guard restarts when home is shown again", async () => {
    const { add, c } = await setup();
    const a = await add("alpha");
    const keep = c.choose("Start it again?", undefined, true);
    await tick(SELF_GUARD_MS + 50);
    c.dispatch(keys("\x03"));
    expect(await keep).toBe("keep");
    const esc = c.choose("Start it again?", undefined, true);
    await tick(SELF_GUARD_MS + 50);
    c.dispatch(keys("\x1b"));
    expect(await esc).toBe(false);
    // Asked while a session is up, it shows only at home: the user's keys just before are not its answer.
    await c.open(a.id);
    const late = c.choose("Start it again?", undefined, true);
    await tick(SELF_GUARD_MS + 50);
    await c.home();
    c.dispatch(keys("\r"));
    await tick();
    c.dispatch(keys("\x1b"));
    await tick();
    c.dispatch(keys("\x1b"));
    await tick(SELF_GUARD_MS + 50);
    c.dispatch(keys("\r"));
    expect(await late).toBe(true);
  });

  test("BUG-203/compositor: “End this session?” on home names the keys the session's bar names (enter yes · esc no); Enter says yes", async () => {
    const { out, add, c } = await setup();
    const a = await add("alpha");
    await c.open(a.id);
    a.s.setQuestion("End this session?");
    await tick();
    const inSession = (await out.lines())[29]!;
    a.s.setQuestion(null);
    await c.home();
    const enter = c.confirm("End this session?");
    const atHome = (await out.lines())[29]!;
    expect(atHome).toMatch(/^ \? End this session\? +enter yes · esc no/);
    expect(atHome).toBe(inSession);
    c.dispatch(keys("\r"));
    expect(await enter).toBe(true);
  });

  test("BUG-260/GLUON-42: at home, Esc and then a key in a later read, before the decoder's wait is over, reach the home view as Esc and that key; Alt+key in one read stays Alt+key; a session gets the bytes as typed", async () => {
    const { home, add, c, stdin } = await setup();
    const w = (s: string) => (stdin as unknown as PassThrough).write(s);
    w("\x1b");
    await tick(10);
    w("x");
    await tick(80);
    expect(home.read()).toBe("\x1b[27ux");
    w("\x1bx");
    await tick(80);
    expect(home.read()).toBe("\x1bx");
    const a = await add("alpha");
    await c.open(a.id);
    w("\x1b");
    await tick(10);
    w("x");
    await tick(80);
    expect(a.s.inputs.map((k) => k.raw).join("")).toBe("\x1bx");
  });

  test("homeInput looks like a terminal to Ink", () => {
    const s = homeInput();
    expect(s.isTTY).toBe(true);
    expect(s.setRawMode(true)).toBe(s);
  });
});
