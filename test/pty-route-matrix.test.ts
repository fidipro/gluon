/**
 * The coverage matrix's `unit` tier (`test/fixtures/gluon-matrix.ts`): `route()` is pure, so every
 * unit cell is checked here — the state as a `RouteContext`, the input's bytes through the real key
 * decoder, `route()`, and what the compositor and the session then do with its actions (the rest
 * of a click Gluon took goes nowhere; a question takes only Enter, Esc and Ctrl+C), against the
 * cell's expectation. Then seeded property fuzz over random contexts and inputs, and the compositor
 * itself (on fake streams) under random input.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Compositor, route, type HomeView, type RouteContext, type ViewSession } from "../src/pty/compositor.ts";
import { layout, tabSpans, type TabSpans } from "../src/pty/chrome.ts";
import { createKeyDecoder, isCtrlC, isKeyUp } from "../src/pty/keys.ts";
import { HOME_MODES, type ModesState } from "../src/pty/modes.ts";
import { createScreen } from "../src/pty/screen.ts";
import type { Key } from "../src/pty/types.ts";
import { SessionStore } from "../src/sessions.ts";
import { bytesOf, KEYS, REPLIES, type Action, type MouseEncodingName } from "./e2e/actions.ts";
import { inputAction, PASTES, resolve, screenOf, sessionTabs, shiftedReports, type Expect, type InputId, type SessionState, type StateId } from "./fixtures/gluon-matrix.ts";

const decode = (bytes: string): Key[] => {
  const d = createKeyDecoder("ctrl+\\");
  return [...d.feed(bytes), ...d.flush()];
};

/** A session state as `route` sees it, on the screen it is reached at (`SESSION_STATES`). */
interface StateModel {
  ctx: RouteContext;
  /** The shown session's id. */
  current: number;
  cols: number;
  rows: number;
}

/** The fakes turn bracketed paste on (`fake-tui.ts`). */
const FAKE_MODES: ModesState = { ...HOME_MODES, bracketedPaste: true };
/** Every session has rows to scroll back to: the fake prints its argv and environment first. */
const SCROLLBACK = 40;

/** The strip of `n` sessions named as `openSessions` names them, `current` shown. */
function strip(n: number, current: number, cols: number): TabSpans {
  const sessions = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: n === 1 ? "Gluon-task" : `Gluon-session-${i + 1}`, state: "awaiting" as const }));
  return tabSpans(sessions, current, cols);
}

function stateModel(state: SessionState): StateModel {
  const { n, current } = sessionTabs(state);
  const { cols, rows, strip } = screenOf(`s.cc.${state}`)!;
  const lay = layout(cols, rows);
  const modes: ModesState = {
    ...FAKE_MODES,
    ...(state === "mouse" ? { mouseTracking: "vt200" as const, mouseEncoding: "sgr" as const } : {}),
    ...(state === "focus" ? { focus: true } : {}),
    ...(state === "kitty" ? { kittyFlags: 1 } : {}),
  };
  const untouched = !["typed", "slashMenu", "questionClear", "questionCompact"].includes(state);
  return {
    current,
    cols,
    rows,
    ctx: {
      modes,
      // Gluon leaves the wheel to an agent on its alternate screen (BUG-175).
      capture: state !== "alt",
      interior: lay.interior,
      offset: state === "scrolled" ? 3 : 0,
      scrollback: state === "alt" ? 0 : SCROLLBACK,
      question: state === "questionClear" || state === "questionCompact",
      untouched,
      prefix: false,
      pressed: false,
      tabRow: lay.tabRow,
      strip,
    },
  };
}

/** What one input did: the agent's bytes, the view it left for, rows scrolled, scroll mode left, the question answered. */
interface Outcome {
  agent: string;
  view: string | null;
  scroll: number;
  unscroll: boolean;
  answered: boolean;
}

/**
 * The keys through `route`, and its actions as the compositor (`sessionKey`, `restOfClick`) and the
 * session (`AgentSession.input`: a question takes Enter yes, Esc / Ctrl+C no, drops the rest) carry
 * them out. A view change ends the input's run here (the rest of a click Gluon took goes nowhere).
 */
function simulate(keys: Key[], m: StateModel, ctx: RouteContext = { ...m.ctx }): Outcome {
  const o: Outcome = { agent: "", view: null, scroll: 0, unscroll: false, answered: false };
  let clickTaken = false;
  for (const k of keys) {
    const ms = k.mouse;
    if (clickTaken && k.name === "mouse" && ms) {
      if (ms.release) {
        clickTaken = false;
        continue;
      }
      if (ms.motion && ms.button !== 3) continue;
      if (!ms.wheel) clickTaken = false;
    }
    const actions = route(k, ctx);
    // A release ends the press; a press the agent gets (no question up) starts one (`Compositor.pressed`).
    if (ms?.release) ctx.pressed = false;
    if (ms && !ms.release && !ms.motion && !ms.wheel && !ctx.question && actions.some((a) => a.kind === "mouse")) ctx.pressed = true;
    for (const a of actions) {
      if (a.kind === "home") return { ...o, view: "home" };
      if (a.kind === "prefix") return { ...o, view: "prefix" };
      if (a.kind === "unprefix") continue;
      if (a.kind === "zoom") return { ...o, view: "zoom" };
      if (a.kind === "switch") return { ...o, view: `switch${a.dir}` };
      if (a.kind === "show") {
        clickTaken = true;
        if (a.id !== m.current) return { ...o, view: `show:${a.id}` };
        break;
      }
      if (a.kind === "scroll") {
        o.scroll += a.by;
        ctx.offset = Math.max(0, Math.min(ctx.scrollback, ctx.offset + a.by));
      } else if (a.kind === "unscroll") {
        o.unscroll = true;
        ctx.offset = 0;
      } else if (a.kind === "input") o.agent += a.key.raw;
      else if (a.kind === "answer") {
        if ((a.key.name === "enter" && !a.key.pasted) || a.key.name === "escape" || isCtrlC(a.key)) o.answered = true;
      } else if (a.kind !== "dismiss") o.agent += a.bytes;
    }
  }
  return o;
}

const NONE: Outcome = { agent: "", view: null, scroll: 0, unscroll: false, answered: false };

/** The outcome a cell's expectation means, for this input's keys in this state (null: not a route matter). */
function expected(e: Expect, keys: Key[], bytes: string, m: StateModel, target: { id: number } | null): Partial<Outcome> | null {
  if ("toAgent" in e) {
    if (e.toAgent === "same") return { agent: bytes, view: null, scroll: 0, answered: false };
    if (e.toAgent === "shifted") {
      const agent = shiftedReports(keys, m.ctx.interior, m.ctx.modes.mouseEncoding, m.ctx.pressed);
      return { agent, view: null, scroll: 0, unscroll: false, answered: false };
    }
    return { agent: e.toAgent, view: null };
  }
  if ("dropped" in e) return NONE;
  if ("home" in e) return { agent: "", view: "home" };
  if ("prefix" in e) return { agent: "", view: "prefix" };
  if ("switch" in e) return { agent: "", view: `switch${e.switch}` };
  if ("show" in e) return { agent: "", view: `show:${target?.id}` };
  if ("scroll" in e) {
    const page = Math.max(1, m.ctx.interior.rows - 1);
    return { ...NONE, scroll: e.scroll === "page" ? page : e.scroll === "-page" ? -page : e.scroll };
  }
  if ("unscroll" in e) return { ...NONE, unscroll: true };
  if ("answer" in e) return { ...NONE, answered: true };
  return null;
}

/** The tab (or marker) a mouse input aims at, for `show`. */
function targetOf(id: InputId, m: StateModel): { id: number } | null {
  const [, target] = id.split(".");
  const s = m.ctx.strip;
  if (!s) return null;
  if (target === "tab") return s.tabs.find((t) => t.id !== m.current) ?? s.tabs[0] ?? null;
  if (target === "prev") return s.prev ?? null;
  if (target === "next") return s.next ?? null;
  return null;
}

const table = resolve();
const unitCells: { s: StateId; i: InputId; e: Expect }[] = [];
for (const [s, row] of table) for (const [i, cell] of row) if (cell && "expect" in cell && cell.tier === "unit") unitCells.push({ s, i, e: cell.expect });

describe("the matrix's unit tier (route)", () => {
  test("the unit cells are session states (route is the session view's)", () => {
    expect(unitCells.length).toBeGreaterThan(15_000);
    expect(unitCells.filter((c) => !c.s.startsWith("s.")).map((c) => `${c.s} × ${c.i}`)).toEqual([]);
  });

  test("the states' strips are what they say: one tab, three, five scrolled both ways at 60 columns", () => {
    expect(stateModel("idle").ctx.strip!.tabs).toHaveLength(1);
    expect(stateModel("midTab").ctx.strip!.tabs).toHaveLength(3);
    const o = stateModel("overflow").ctx.strip!;
    expect(o.prev && o.next).toBeTruthy();
    expect(stateModel("tooSmall").ctx.strip).toBeNull();
  });

  const byState = new Map<StateId, typeof unitCells>();
  for (const c of unitCells) byState.set(c.s, [...(byState.get(c.s) ?? []), c]);
  for (const [s, cells] of byState) {
    test(`${s}: every unit cell`, () => {
      const state = s.split(".")[2] as SessionState;
      const m = stateModel(state);
      const wrong: string[] = [];
      for (const { i, e } of cells) {
        const a = inputAction(i, { cols: m.cols, rows: m.rows, strip: m.ctx.strip, current: m.current });
        if (!a) {
          wrong.push(`${i}: no target on this screen`);
          continue;
        }
        let bytes: string;
        try {
          bytes = bytesOf(a.action, a.encoding);
        } catch (err) {
          wrong.push(`${i}: ${(err as Error).message}`);
          continue;
        }
        const keys = decode(bytes);
        const got = simulate(keys, m);
        const want = expected(e, keys, bytes, m, targetOf(i, m));
        if (!want) {
          wrong.push(`${i}: ${JSON.stringify(e)} isn't a route matter (tier it e2e)`);
          continue;
        }
        const diff = (Object.keys(want) as (keyof Outcome)[]).filter((k) => got[k] !== want[k]);
        if (diff.length) wrong.push(`${i}: want ${JSON.stringify(e)}, got ${JSON.stringify(got)}`);
      }
      expect(wrong).toEqual([]);
    });
  }
});

/** A seeded random number generator (mulberry32): the same seed, the same run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.GLUON_FUZZ_SEED) || 0x6c756f6e;
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** A random context: any modes, scroll, question, line, tab position and strip. */
function randomContext(r: () => number): { ctx: RouteContext; current: number; cols: number; rows: number } {
  const cols = pick(r, [19, 20, 40, 60, 100, 160]);
  const rows = pick(r, [5, 6, 12, 24, 30, 50]);
  const lay = layout(cols, rows);
  const n = 1 + Math.floor(r() * 6);
  const current = 1 + Math.floor(r() * n);
  const tracking = pick(r, ["none", "none", "x10", "vt200", "drag", "any"] as const);
  const scrollback = pick(r, [0, 0, 5, 200]);
  return {
    current,
    cols,
    rows,
    ctx: {
      modes: { ...HOME_MODES, bracketedPaste: r() < 0.7, focus: r() < 0.3, kittyFlags: r() < 0.2 ? 1 : 0, cursorKeys: r() < 0.2, mouseTracking: tracking, mouseEncoding: pick(r, ["default", "utf8", "sgr", "sgr", "urxvt", "sgr-pixels"] as const) },
      capture: r() < 0.8,
      interior: lay.interior,
      scrollback,
      offset: scrollback && r() < 0.3 ? Math.floor(r() * scrollback) + 1 : 0,
      question: r() < 0.2,
      untouched: r() < 0.5,
      prefix: false,
      pressed: r() < 0.5,
      tabRow: lay.tabRow,
      strip: lay.small ? null : strip(n, current, lay.cols),
    },
  };
}

const KEY_NAMES = Object.keys(KEYS) as (keyof typeof KEYS)[];
const PASTE_TEXTS = [...Object.values(PASTES), "\x1c", "\x1b[6;3~", "/clear\r", "\x1b[D", "q", "\x1b[<0;2;1M"];

/** A random input's bytes, and what kind it is. */
function randomInput(r: () => number, c: { cols: number; rows: number }): { kind: "key" | "paste" | "mouse" | "focus" | "reply"; bytes: string; action?: Action } {
  const roll = r();
  if (roll < 0.45) return { kind: "key", bytes: KEYS[pick(r, KEY_NAMES)] };
  if (roll < 0.6) return { kind: "paste", bytes: bytesOf({ paste: pick(r, PASTE_TEXTS) + (r() < 0.3 ? pick(r, PASTE_TEXTS) : "") }) };
  if (roll < 0.9) {
    const op = pick(r, ["press", "release", "drag", "click", "wheel"] as const);
    const button = op === "wheel" ? pick(r, ["up", "down"] as const) : pick(r, ["left", "middle", "right"] as const);
    const x = 1 + Math.floor(r() * Math.max(1, c.cols));
    const y = 1 + Math.floor(r() * Math.max(1, c.rows));
    const action: Action = { mouse: { op, button, x, y, to: { x: Math.max(1, x + Math.floor(r() * 7) - 3), y: Math.max(1, y + Math.floor(r() * 5) - 2) } } };
    const enc = pick(r, ["sgr", "sgr", "urxvt", "utf8"] as MouseEncodingName[]);
    return { kind: "mouse", bytes: bytesOf(action, enc), action };
  }
  if (roll < 0.95) return { kind: "focus", bytes: pick(r, ["\x1b[I", "\x1b[O"]) };
  return { kind: "reply", bytes: REPLIES[pick(r, Object.keys(REPLIES) as (keyof typeof REPLIES)[])] };
}

describe("route: seeded properties", () => {
  const RUNS = 4000;

  test(`a paste never goes home, switches or shows a tab; it reaches the agent whole or not at all (seed ${SEED})`, () => {
    const r = rng(SEED);
    for (let n = 0; n < RUNS; n++) {
      const { ctx } = randomContext(r);
      const text = pick(r, PASTE_TEXTS) + pick(r, PASTE_TEXTS);
      const keys = decode(bytesOf({ paste: text }));
      expect(keys).toHaveLength(1);
      const acts = route(keys[0]!, ctx);
      expect(acts.filter((a) => a.kind === "home" || a.kind === "switch" || a.kind === "show" || a.kind === "answer")).toEqual([]);
      const input = acts.filter((a) => a.kind === "input");
      if (ctx.question) expect(acts).toEqual([]);
      else expect(input.map((a) => (a as { key: Key }).key.raw)).toEqual([keys[0]!.raw]);
    }
  });

  test(`a terminal reply gives nothing, in any context (seed ${SEED + 1})`, () => {
    const r = rng(SEED + 1);
    for (let n = 0; n < RUNS; n++) {
      const { ctx } = randomContext(r);
      for (const k of decode(REPLIES[pick(r, Object.keys(REPLIES) as (keyof typeof REPLIES)[])])) {
        expect(k.name).toBe("reply");
        expect(route(k, ctx)).toEqual([]);
      }
    }
  });

  test(`with a question up only Enter, Esc and Ctrl+C answer it; other keys and pastes are dropped (Gluon's own keys still work) (seed ${SEED + 2})`, () => {
    const r = rng(SEED + 2);
    for (let n = 0; n < RUNS; n++) {
      const m = randomContext(r);
      m.ctx.question = true;
      const input = randomInput(r, m);
      const keys = decode(input.bytes);
      const o = simulate(keys, { ...m, ctx: m.ctx }, { ...m.ctx });
      const answers = keys.some((k) => !k.pasted && (k.name === "enter" || k.name === "escape" || isCtrlC(k)));
      const gluons = keys.some((k) => ["return-key", "scroll-up", "scroll-down", "mouse"].includes(k.name));
      if (!gluons) {
        expect({ bytes: input.bytes, answered: o.answered }).toEqual({ bytes: input.bytes, answered: answers });
        // Nothing typed reaches the agent past the question (a focus report it asked for may).
        if (input.kind !== "focus") expect({ bytes: input.bytes, agent: o.agent }).toEqual({ bytes: input.bytes, agent: "" });
      }
    }
  });

  test(`a mouse report outside the interior reaches the agent only as a release or a drag held at the edge, after a press it got (seed ${SEED + 3})`, () => {
    const r = rng(SEED + 3);
    let outside = 0;
    for (let n = 0; n < RUNS * 2; n++) {
      const m = randomContext(r);
      const input = randomInput(r, m);
      if (input.kind !== "mouse") continue;
      for (const k of decode(input.bytes)) {
        const ev = k.mouse;
        if (!ev) continue;
        const i = m.ctx.interior;
        const inside = ev.x - i.left >= 1 && ev.x - i.left <= i.cols && ev.y - i.top >= 1 && ev.y - i.top <= i.rows;
        if (inside) continue;
        outside++;
        for (const a of route(k, { ...m.ctx })) {
          if (a.kind !== "mouse") continue;
          expect({ report: k.raw, held: m.ctx.pressed && (ev.release || (ev.motion && ev.button !== 3)) }).toEqual({ report: k.raw, held: true });
          // Held at the edge: the cell the agent gets is on its screen.
          const cell = /(\d+);(\d+)[Mm]$/.exec(a.bytes);
          if (cell) {
            expect(Number(cell[1])).toBeLessThanOrEqual(i.cols);
            expect(Number(cell[2])).toBeLessThanOrEqual(i.rows);
          }
        }
      }
    }
    expect(outside).toBeGreaterThan(100);
  });

  test(`BUG-279/route: Alt+PgUp / Alt+PgDn never switch, go home or start a prefix, whatever the context: the agent's, or dropped by a question (seed ${SEED + 4})`, () => {
    const r = rng(SEED + 4);
    const forms = [KEYS.altPgup, KEYS.altPgdn, "\x1b[57421;3u", "\x1b[57422;3u", "\x1b[5;3:2~", "\x1b[34;81;0;1;2;1_", "\x1b[33;73;0;1;1;1_"];
    for (const bytes of forms) expect(decode(bytes).map((k) => k.name)).toEqual(["other"]);
    for (let n = 0; n < RUNS; n++) {
      const { ctx } = randomContext(r);
      const bytes = pick(r, forms);
      const keys = decode(bytes);
      expect(keys).toHaveLength(1);
      const acts = route(keys[0]!, ctx);
      expect(acts.filter((a) => a.kind !== "input" && a.kind !== "answer" && a.kind !== "unscroll")).toEqual([]);
      if (!ctx.question) expect(acts.filter((a) => a.kind === "input").map((a) => (a as { key: Key }).key.raw)).toEqual([bytes]);
    }
  });

  test(`the home key starts the prefix whatever the context (nothing pending): never home at once (seed ${SEED + 5})`, () => {
    const r = rng(SEED + 5);
    for (let n = 0; n < RUNS; n++) {
      const { ctx } = randomContext(r);
      const keys = decode(pick(r, [KEYS.ctrlBackslash, KEYS.kittyCtrlBackslash]));
      expect(route(keys[0]!, ctx)).toEqual([{ kind: "prefix" }]);
    }
  });

  test(`BUG-279/route: with the prefix pending, in any context: ←/→ switch, the home key goes home, z zooms, Esc cancels, any other key ends it and is routed as if alone; replies and focus reports wait on (seed ${SEED + 7})`, () => {
    const r = rng(SEED + 7);
    const states = { switchPrev: 0, switchNext: 0, home: 0, cancel: 0, other: 0, wait: 0 };
    for (let n = 0; n < RUNS * 2; n++) {
      const m = randomContext(r);
      const ctx = { ...m.ctx, prefix: true };
      const input = randomInput(r, m);
      for (const k of decode(input.bytes)) {
        const acts = route(k, ctx);
        if (k.name === "reply" || k.name === "focus") {
          states.wait++;
          expect({ bytes: k.raw, acts: acts.filter((a) => a.kind === "unprefix") }).toEqual({ bytes: k.raw, acts: [] });
        } else if (k.name === "left" || k.name === "right") {
          states[k.name === "left" ? "switchPrev" : "switchNext"]++;
          expect(acts).toEqual([{ kind: "unprefix" }, { kind: "switch", dir: k.name === "left" ? -1 : 1 }]);
        } else if (k.name === "return-key") {
          states.home++;
          expect(acts).toEqual([{ kind: "unprefix" }, { kind: "home" }]);
        } else if (k.name === "text" && k.text === "z" && !k.pasted) {
          // The zoom key (BUG-284): not routed as if alone.
          expect(acts).toEqual([{ kind: "unprefix" }, { kind: "zoom" }]);
        } else if (k.name === "escape" && !k.pasted) {
          states.cancel++;
          expect(acts).toEqual([{ kind: "unprefix" }]);
        } else if (k.raw && isKeyUp(k)) {
          // A key let go (a kitty release) isn't the pick: the agent gets it, the prefix stays.
          expect({ bytes: k.raw, acts }).toEqual({ bytes: k.raw, acts: [{ kind: "input", key: k }] });
        } else if (k.raw) {
          states.other++;
          expect({ bytes: k.raw, acts }).toEqual({ bytes: k.raw, acts: [{ kind: "unprefix" }, ...route(k, { ...ctx, prefix: false })] });
        }
      }
    }
    expect(Object.values(states).every((n) => n > 5)).toBe(true);
  });

  test(`BUG-280/route: on an untouched line plain ←/→ switch, Alt+←/→ are dropped (nothing for the agent); touched, all four are the agent's (seed ${SEED + 8})`, () => {
    const r = rng(SEED + 8);
    for (let n = 0; n < RUNS; n++) {
      const { ctx } = randomContext(r);
      const plain = { ...ctx, question: false, prefix: false };
      const [left, right, altLeft, altRight] = [KEYS.left, KEYS.right, KEYS.altLeft, KEYS.altRight].map((b) => decode(b)[0]!);
      const k = pick(r, [left!, right!, altLeft!, altRight!]);
      const untouched = route(k, { ...plain, untouched: true });
      if (k === left || k === right) expect(untouched).toEqual([{ kind: "switch", dir: k === left ? -1 : 1 }]);
      else expect(untouched).toEqual([]);
      const touched = route(k, { ...plain, untouched: false });
      expect(touched.filter((a) => a.kind === "input").map((a) => (a as { key: Key }).key.raw)).toEqual([k.raw]);
      expect(touched.filter((a) => a.kind === "switch" || a.kind === "home")).toEqual([]);
      // A question up: the arrows are answers (dropped by the session), switching nothing.
      expect(route(k, { ...plain, question: true })).toEqual([{ kind: "answer", key: k }]);
    }
  });
});

/** A terminal stand-in: what the compositor writes goes into a screen model. */
class FakeOut extends EventEmitter {
  isTTY = true;
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
  write() {
    return true;
  }
}

function stubSession(modes: Partial<ModesState> = {}) {
  const screen = createScreen(98, 24, { scrollback: 200 });
  // The fakes' bracketed paste, and the agent's own modes.
  void screen.write(`\x1b[?2004h${modes.mouseTracking && modes.mouseTracking !== "none" ? "\x1b[?1000h\x1b[?1006h" : ""}${modes.focus ? "\x1b[?1004h" : ""}${"line\r\n".repeat(60)}`);
  let q: string | null = null;
  const questions = new Set<(q: string | null) => void>();
  const s = {
    screen,
    alive: true,
    get question() {
      return q;
    },
    holdsLine: false,
    got: [] as string[],
    input(k: Key) {
      if (q) {
        if (!k.pasted && (k.name === "enter" || k.name === "escape" || isCtrlC(k))) s.setQuestion(null);
        return;
      }
      s.got.push(k.raw);
    },
    mouse: (b: string) => void s.got.push(b),
    passthrough: (b: string) => void s.got.push(b),
    resize: (c: number, r: number) => screen.resize(c, r),
    onChange: () => () => {},
    onQuestion: (fn: (q: string | null) => void) => (questions.add(fn), () => void questions.delete(fn)),
    setQuestion(v: string | null) {
      q = v;
      questions.forEach((f) => f(v));
    },
  };
  return s satisfies ViewSession;
}

describe("the compositor under random input (fake streams)", () => {
  test(`seeded: Gluon's keys move the view as the ring says; a paste never moves it; nothing reaches a session not shown (seed ${SEED + 6})`, async () => {
    const r = rng(SEED + 6);
    for (let round = 0; round < 6; round++) {
      const out = new FakeOut(100, 30);
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin }) as unknown as NodeJS.ReadStream;
      const store = new SessionStore();
      const home: HomeView = { mount: () => {}, suspend: async () => {}, resume: async () => {}, unmount: async () => {} };
      const c = new Compositor({ store, home, homeKey: "ctrl+\\", mouseCapture: true, truecolor: true, stdin, stdout: out as unknown as NodeJS.WriteStream });
      await c.start();
      const sessions = new Map<number, ReturnType<typeof stubSession>>();
      const n = 1 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const s = stubSession(r() < 0.3 ? { mouseTracking: "vt200", mouseEncoding: "sgr" } : r() < 0.3 ? { focus: true } : {});
        const v = store.launched(`Gluon-s${i}`, { harness: "claude-code", model: "opus", effort: "high" }, { alive: true, end: async () => {} }, i + 1);
        c.add(v.id, s);
        sessions.set(v.id, s);
      }
      const ids = [...sessions.keys()];
      await c.open(ids[0]!);
      const pending = () => (c as unknown as { prefix: boolean }).prefix;
      for (let step = 0; step < 150; step++) {
        const before = c.current;
        const wasPending = pending();
        const shown = before.kind === "session" ? before.id : null;
        if (shown !== null && r() < 0.05) sessions.get(shown)!.setQuestion("End this session?");
        const got = new Map(ids.map((id) => [id, sessions.get(id)!.got.length]));
        const input = randomInput(r, { cols: 100, rows: 30 });
        const keys = decode(input.bytes);
        c.dispatch(keys);
        // Not Bun.sleep(0): a timer, 15 ms on Windows, 900 times.
        await new Promise((r) => setImmediate(r));
        const after = c.current;
        const label = `round ${round} step ${step}: ${JSON.stringify(input.bytes)} from ${JSON.stringify(before)}`;
        // Sessions not shown get nothing.
        for (const id of ids) if (id !== shown) expect({ label, id, got: sessions.get(id)!.got.length }).toEqual({ label, id, got: got.get(id)! });
        if (input.kind === "paste" || input.kind === "reply" || input.kind === "focus") expect({ label, view: after }).toEqual({ label, view: before });
        if (before.kind === "session" && keys.length === 1) {
          const k = keys[0]!;
          const ring = [null, ...ids];
          const at = ring.indexOf(before.id);
          const want = (dir: number) => ring[(at + dir + ring.length) % ring.length];
          const id = (v: typeof after) => (v.kind === "home" ? null : v.id);
          const waits = k.name === "reply" || k.name === "focus" || !k.raw;
          if (wasPending && k.name === "left") expect({ label, view: id(after) }).toEqual({ label, view: want(-1)! });
          if (wasPending && k.name === "right") expect({ label, view: id(after) }).toEqual({ label, view: want(1)! });
          if (wasPending && k.name === "return-key") expect({ label, view: after }).toEqual({ label, view: { kind: "home" } });
          // The home key alone never leaves the view: it waits for the key that picks.
          if (!wasPending && k.name === "return-key") expect({ label, view: after, pending: pending() }).toEqual({ label, view: before, pending: true });
          // Any key but a reply or a focus report ends the prefix (the home key starts it again when none was pending).
          if (wasPending && !waits) expect({ label, pending: pending() }).toEqual({ label, pending: false });
          if (!wasPending && !waits && k.name !== "return-key") expect({ label, pending: pending() }).toEqual({ label, pending: false });
        }
        // Back to a session for the next step, now and then.
        if (after.kind === "home" && r() < 0.7) await c.open(pick(r, ids));
      }
      await c.stop();
    }
  });
});
