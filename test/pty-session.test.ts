/** Gluon's AgentSession (`src/pty/session.ts`) on a fake PTY: what reaches the agent, the question, events, status. */
import { SLOW } from "./fixtures/slow.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventsDir, stepGate, writeEvent } from "../src/events.ts";
import { Ledger } from "../src/cost/ledger.ts";
import { CostTracker } from "../src/cost/tracker.ts";
import { handoffDefaults, handoffFor, type HandoffSettings } from "../src/handoff.ts";
import type { Harness } from "../src/harnesses.ts";
import { createKeyDecoder } from "../src/pty/keys.ts";
import { AgentSession, ECHO_GRACE_MS, type FirstLineTiming, END_COMPACT_QUESTION, END_QUESTION, HOOK_TRUST_MS, QUIET_AWAIT_MS, REDRAW_GRACE_MS, REDRAW_WAIT_MS, TURN_FINISHED, type SendKind, type Spawner } from "../src/pty/session.ts";
import { fixture, sizeOf, state } from "./fixtures/screens.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-session-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** A fake agent process: records what is written into its PTY, prints what the test says. */
function fakePty({ dieOnTerm = true } = {}) {
  const writes: string[] = [];
  const kills: string[] = [];
  const sizes: [number, number][] = [];
  const exited = Promise.withResolvers<number>();
  let alive = true;
  let onData: (d: Uint8Array) => void = () => {};
  const exit = (code: number) => {
    alive = false;
    exited.resolve(code);
  };
  const spawn: Spawner = (_argv, o) => {
    onData = o.onData;
    return {
      write: (d) => void writes.push(d),
      resize: (c, r) => void sizes.push([c, r]),
      exited: exited.promise,
      alive: () => alive,
      kill(sig) {
        kills.push(sig);
        if (sig === "SIGKILL" || dieOnTerm) exit(sig === "SIGKILL" ? 137 : 143);
      },
      close() {},
    };
  };
  return { spawn, writes, kills, sizes, exit, print: (s: string) => onData(new TextEncoder().encode(s)) };
}

function session(o: { harness?: Harness; settings?: Partial<HandoffSettings>; events?: string; now?: () => number; tickMs?: number; dieOnTerm?: boolean; colours?: boolean; kitty?: boolean; settleMaxMs?: number; firstLine?: string; firstLineTiming?: Partial<FirstLineTiming>; stamps?: number[]; cols?: number; rows?: number } = {}) {
  const pty = fakePty({ dieOnTerm: o.dieOnTerm ?? true });
  const sent: [SendKind, string][] = [];
  const harness = o.harness ?? "claude-code";
  const s = new AgentSession({
    argv: ["agent"],
    env: {},
    harness,
    settings: { ...handoffFor(handoffDefaults(), harness), ...o.settings },
    cols: o.cols ?? 60,
    rows: o.rows ?? 12,
    spawn: pty.spawn,
    ...(o.firstLine ? { firstLine: o.firstLine } : {}),
    ...(o.firstLineTiming ? { firstLineTiming: o.firstLineTiming } : {}),
    onSend: (k, d) => {
      sent.push([k, d]);
      o.stamps?.push(performance.now());
    },
    ...(o.events ? { events: o.events } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.tickMs ? { tickMs: o.tickMs } : {}),
    ...(o.settleMaxMs ? { settleMaxMs: o.settleMaxMs } : {}),
    screen: { ...(o.colours ? { colours: { bg: [12, 12, 12] as const } } : {}), ...(o.kitty ? { kitty: true } : {}) },
  });
  return { s, pty, sent };
}

const keys = (text: string) => {
  const d = createKeyDecoder("ctrl+\\");
  return [...d.feed(text), ...d.flush()];
};
const settle = (ms = 30) => Bun.sleep(ms);
async function until(ok: () => boolean, ms = 3000 * SLOW) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(10);
  expect(ok()).toBe(true);
}

describe.concurrent("what reaches the agent's PTY", () => {
  test("only the user's bytes (unchanged), the model's replies (in query order) and shifted mouse reports", async () => {
    const { s, pty, sent } = session({ colours: true, kitty: true, settings: { on_clear: "stay", on_compact: "stay" } });
    // DA1, a cursor position report, OSC 11, kitty's flags query: the model answers each.
    pty.print("hello\x1b[c\x1b[6n\x1b]11;?\x07\x1b[?u");
    await until(() => sent.length >= 4);
    for (const k of keys("hi\x1b[A\r")) s.input(k);
    s.mouse("\x1b[<0;3;4M");
    s.passthrough("\x1b[I");
    await until(() => sent.length >= 10);
    expect(sent).toEqual([
      ["reply", "\x1b[?1;2c"],
      ["reply", "\x1b[1;6R"],
      ["reply", "\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\"],
      ["reply", "\x1b[?0u"],
      ["user", "h"],
      ["user", "i"],
      ["user", "\x1b[A"],
      ["user", "\r"],
      ["mouse", "\x1b[<0;3;4M"],
      ["user", "\x1b[I"],
    ]);
    // What the PTY got is exactly that, in that order.
    expect(pty.writes.join("")).toBe(sent.map(([, d]) => d).join(""));
    s.dispose();
  });

  test("the source writes into the PTY in one place only, with one of the four kinds", () => {
    const src = readFileSync(join(import.meta.dir, "../src/pty/session.ts"), "utf8");
    expect(src.match(/this\.proc\.write\(/g)?.length).toBe(1);
    const kinds = [...src.matchAll(/this\.send\(("[a-z]+")/g)].map((m) => m[1]);
    expect(new Set(kinds)).toEqual(new Set(['"user"', '"reply"', '"mouse"', '"launch"']));
  });

  test("nothing is written after the agent exits; keys are dropped", async () => {
    const { s, pty } = session();
    pty.exit(0);
    await s.exited;
    for (const k of keys("x\r")) s.input(k);
    s.mouse("\x1b[<0;1;1M");
    await settle();
    expect(pty.writes).toEqual([]);
    expect(s.alive).toBe(false);
    expect(s.code).toBe(0);
  });
});

// The launch's first line (`/plan Read the session brief in <file> and start.`, Codex's Plan mode): typed once, only on an
// empty composer with bracketed paste on and before the user typed; the text, a pause, then its Enter (Codex loses an Enter
// that comes first or in the same chunk). Otherwise the user is told the line to type.
describe.concurrent("the launch's first line", () => {
  const LINE = "/plan Read the session brief in /tmp/b.md and start.";
  // The deadlines the test's own steps have to meet scale with the machine (63 tests run at once; timers tick every 15 ms on Windows); the pause stays.
  const FAST = { waitMs: 400 * SLOW, pauseMs: 60, landMs: 300 * SLOW, planMs: 300 * SLOW };
  const ON = "\x1b[?2004h";
  /** Codex's composer on row 3 (an empty one shows the faint placeholder), its footer below: `plan` adds Plan mode's mark. */
  const composer = (text = "", plan = false) =>
    `\x1b[3;1H\x1b[2K\x1b[1m› \x1b[0m${text || "\x1b[2mAsk Codex to do anything\x1b[0m\x1b[3;3H"}\x1b[4;1H\x1b[2K  gpt-5 default · ~/proj${plan ? " \x1b[35mPlan mode\x1b[0m" : ""}\x1b[3;${3 + text.length}H`;
  const codex = (o: Parameters<typeof session>[0] = {}) => {
    const at: number[] = [];
    const r = session({ harness: "codex", firstLine: LINE, firstLineTiming: FAST, stamps: at, ...o });
    const notes: string[] = [];
    r.s.onNote((n) => notes.push(n));
    return { ...r, notes, at };
  };

  test("types the text, then after a pause its Enter, once: not before the composer and bracketed paste, then the Plan mode check passes", async () => {
    const { s, pty, sent, notes, at } = codex();
    // Nothing yet: no screen, then a composer without bracketed paste (the TUI isn't set up).
    await settle(100);
    expect(pty.writes).toEqual([]);
    pty.print(composer());
    await settle(150);
    expect(pty.writes).toEqual([]);
    pty.print(ON);
    await until(() => pty.writes.length === 1);
    expect(pty.writes).toEqual([LINE]);
    // The agent echoes it; the Enter comes after the pause, separately.
    pty.print(composer(LINE));
    await until(() => pty.writes.length === 2);
    expect(pty.writes).toEqual([LINE, "\r"]);
    expect(sent.map(([k]) => k)).toEqual(["launch", "launch"]);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(FAST.pauseMs - 5);
    // Plan mode shows: no note; and never written again.
    pty.print(composer("", true));
    await settle(450);
    expect(pty.writes).toEqual([LINE, "\r"]);
    expect(notes).toEqual([]);
    s.dispose();
  });

  test("a user's key before the composer: nothing is typed; the user is told the line", async () => {
    const { s, pty, notes } = codex();
    pty.print(ON);
    for (const k of keys("h")) s.input(k);
    pty.print(composer());
    await until(() => notes.length === 1);
    expect(pty.writes).toEqual(["h"]);
    expect(notes[0]).toContain(LINE);
    expect(notes[0]).toContain("you typed first");
    expect(notes[0]).toContain("Codex");
    // A note given later is replayed to a late listener.
    const late: string[] = [];
    s.onNote((n) => late.push(n));
    expect(late).toEqual(notes);
    s.dispose();
  });

  test("BUG-705/issue-111: `awaitsChoice` is true on each captured Codex dialog (folder trust, hooks review, approval) and false on the idle composer: the compositor reads it per key", async () => {
    const f = fixture("codex");
    for (const name of ["frame-folder-trust", "frame-hook-review", "frame-approve-command"]) {
      const st = state(f, name);
      const dialog = codex({ ...sizeOf(f, st) });
      dialog.pty.print(ON + st.ansi);
      await settle(80);
      expect([name, dialog.s.awaitsChoice]).toEqual([name, true]);
      dialog.pty.print("\x1b[2J" + composer());
      await settle(80);
      expect([name, dialog.s.awaitsChoice]).toEqual([name, false]);
      dialog.s.dispose();
    }
  });

  test("a mouse report counts as the user's; an answer to the agent's own dialog (folder trust) does not", async () => {
    const f = fixture("codex");
    const trust = state(f, "frame-folder-trust");
    const size = sizeOf(f, trust);
    const dialog = codex({ ...size });
    dialog.pty.print(ON + trust.ansi);
    await settle(80);
    for (const k of keys("\r")) dialog.s.input(k);
    await until(() => dialog.pty.writes.length === 1);
    expect(dialog.pty.writes).toEqual(["\r"]);
    // The dialog is gone, the composer is up: now the line is typed.
    dialog.pty.print("\x1b[2J" + composer());
    await until(() => dialog.pty.writes.length === 2);
    expect(dialog.pty.writes).toEqual(["\r", LINE]);
    dialog.s.dispose();
    const mouse = codex();
    mouse.pty.print(ON + composer());
    mouse.s.mouse("\x1b[<0;3;4M");
    await until(() => mouse.notes.length === 1);
    expect(mouse.pty.writes).toEqual(["\x1b[<0;3;4M"]);
    mouse.s.dispose();
  });

  test("a user's key after the text, before its Enter: no Enter; told to clear the line first", async () => {
    const { s, pty, notes } = codex({ firstLineTiming: { ...FAST, pauseMs: 150 } });
    pty.print(ON + composer());
    await until(() => pty.writes.length === 1);
    pty.print(composer(LINE));
    for (const k of keys("x")) s.input(k);
    await until(() => notes.length === 1);
    expect(pty.writes).not.toContain("\r");
    expect(notes[0]).toContain("clear");
    expect(notes[0]).toContain(LINE);
    s.dispose();
  });

  test("BUG-408/launch-modes: a line the composer word-wraps over two rows (the space at the break dropped) has landed: its Enter is sent", async () => {
    const { s, pty, notes } = codex();
    pty.print(ON + composer());
    await until(() => pty.writes.length === 1);
    const [head, tail] = [LINE.slice(0, LINE.indexOf(" /tmp")), LINE.slice(LINE.indexOf("/tmp"))];
    // Codex's composer rows are shaded; the cursor ends on the continuation row.
    const bg = "\x1b[48;5;236m";
    pty.print(`\x1b[3;1H\x1b[2K${bg}\x1b[1m› \x1b[22m${head}\x1b[K\x1b[0m\x1b[4;1H\x1b[2K${bg}  ${tail}\x1b[K\x1b[0m\x1b[5;1H\x1b[2K  gpt-5 default · ~/proj\x1b[4;${3 + tail.length}H`);
    await until(() => pty.writes.length === 2);
    expect(pty.writes).toEqual([LINE, "\r"]);
    expect(notes.filter((n) => n.includes("didn't reach"))).toEqual([]);
    s.dispose();
  });

  test("the text never shows on the composer: no Enter, the line is given", async () => {
    const { s, pty, notes } = codex();
    pty.print(ON + composer());
    await until(() => notes.length === 1);
    expect(pty.writes).toEqual([LINE]);
    expect(notes[0]).toContain("didn't reach");
    expect(notes[0]).toContain(LINE);
    await settle(100);
    expect(pty.writes).toEqual([LINE]);
    s.dispose();
  });

  test("no composer within the wait (a dialog of the agent's own stays up): nothing is typed, the line is given", async () => {
    const f = fixture("codex");
    const trust = state(f, "frame-folder-trust");
    const { s, pty, notes } = codex({ ...sizeOf(f, trust) });
    pty.print(ON + trust.ansi);
    await until(() => notes.length === 1);
    expect(pty.writes).toEqual([]);
    expect(notes[0]).toContain("showing a dialog of its own");
    expect(notes[0]).toContain(LINE);
    s.dispose();
  });

  // Codex's "Update available" dialog (live run, Codex 0.160.0: `qa/findings/live-screens/codex-plan-firstline-update-dialog.txt`,
  // a text capture taken when Gluon's note came up, no colours): its option rows and hint row are that capture's, the title
  // rows are not (hidden under the note), and the highlighted row is drawn inverse like the other dialogs'. The capture shows no
  // composer, yet the live run typed the line: the sequence that did is not captured, so these cases give the gate the dialog
  // together with an empty composer (a screen the reader would call ready) and the dialog arriving after the text.
  describe("BUG-670/F05: Codex's update dialog", () => {
    const SIZE = { cols: 100, rows: 24 };
    const DIALOG =
      "\x1b[2;3H\x1b[2K\x1b[1m\u2728 Update available!\x1b[0m 0.160.0 -> 0.160.1" +
      "\x1b[4;1H\x1b[2K\x1b[7;1m\u203a 1. Update now (runs `bun install -g @openai/codex`)\x1b[0m" +
      "\x1b[5;1H\x1b[2K  2. Skip\x1b[6;1H\x1b[2K  3. Skip until next version" +
      "\x1b[8;1H\x1b[2K  \x1b[1menter\x1b[0m\x1b[2m continue \u00b7 \x1b[0m\x1b[1mesc\x1b[0m\x1b[2m skip\x1b[0m";
    /** Codex's composer on row 12, under the dialog's rows. */
    const lower = (text = "") => `\x1b[12;1H\x1b[2K\x1b[1m\u203a \x1b[0m${text || "\x1b[2mAsk Codex to do anything\x1b[0m\x1b[12;3H"}\x1b[12;${3 + text.length}H`;

    test("the line is not typed while the dialog is up, even with an empty composer on screen; it is, once the dialog is gone", async () => {
      const { s, pty, notes } = codex({ ...SIZE });
      pty.print(ON + DIALOG + lower());
      await settle(250 * SLOW);
      expect(s.awaitsChoice).toBe(true);
      // No byte went into the dialog: a digit in the line would have picked an option, an Enter the first.
      expect(pty.writes).toEqual([]);
      pty.print("\x1b[2J" + composer());
      await until(() => pty.writes.length === 1);
      expect(pty.writes).toEqual([LINE]);
      expect(notes).toEqual([]);
      s.dispose();
    });

    test("a dialog that stays up past the wait: nothing is typed, and the user is told the line and why", async () => {
      const { s, pty, notes } = codex({ ...SIZE });
      pty.print(ON + DIALOG + lower());
      await until(() => notes.length === 1);
      expect(pty.writes).toEqual([]);
      expect(notes[0]).toContain(LINE);
      expect(notes[0]).toContain("dialog");
      s.dispose();
    });

    test("a dialog that opens after the text went in: the Enter is never sent (it would pick \"Update now\")", async () => {
      const { s, pty, notes } = codex({ ...SIZE });
      pty.print(ON + composer());
      await until(() => pty.writes.length === 1);
      // The dialog comes up and, on the screen, the composer shows the text (as a stale row would).
      pty.print(DIALOG + `\x1b[12;1H\x1b[2K\x1b[1m\u203a \x1b[0m${LINE}\x1b[12;${3 + LINE.length}H`);
      await until(() => notes.length === 1);
      await settle(150 * SLOW);
      expect(pty.writes).toEqual([LINE]);
      expect(notes[0]).toContain(LINE);
      s.dispose();
    });
  });

  test("Plan mode not shown after the Enter: the user is told", async () => {
    const { s, pty, notes } = codex();
    pty.print(ON + composer());
    await until(() => pty.writes.length === 1);
    pty.print(composer(LINE));
    await until(() => pty.writes.length === 2);
    await until(() => notes.length === 1);
    expect(notes[0]).toContain("Plan mode");
    expect(notes[0]).toContain(LINE);
    s.dispose();
  });

  test("a session with no first line types nothing, and one that ends before its composer says nothing", async () => {
    const plain = session({ harness: "codex" });
    plain.pty.print(ON + composer());
    await settle(100);
    expect(plain.pty.writes).toEqual([]);
    plain.s.dispose();
    const { s, pty, notes } = codex();
    pty.exit(1);
    await s.exited;
    await settle(500);
    expect(pty.writes).toEqual([]);
    expect(notes).toEqual([]);
  });
});

// Grok Build's `/plan …` the same way (`--permission-mode plan` does nothing in its TUI). Its screens are the captured ones
// (`grok-build/1.0.46.json`, 120x40): the start screen's big box is no composer (and the cursor, hidden while it draws, says
// nothing), the box under it is; the text typed in one burst lands, and the mode shows as ` · plan` in the box's border.
describe.concurrent("BUG-411/launch-modes: the launch's first line: Grok Build", () => {
  const LINE = "/plan Read the session brief in /tmp/x/session.md and start.";
  // The deadlines the test's own steps have to meet scale with the machine (63 tests run at once; timers tick every 15 ms on Windows); the pause stays.
  const FAST = { waitMs: 400 * SLOW, pauseMs: 60, landMs: 300 * SLOW, planMs: 300 * SLOW };
  const ON = "\x1b[?2004h";
  const f = fixture("grok-build");
  const grok = () => {
    const r = session({ harness: "grok-build", firstLine: LINE, firstLineTiming: FAST, cols: 120, rows: 40 });
    const notes: string[] = [];
    r.s.onNote((n) => notes.push(n));
    return { ...r, notes };
  };
  /** The start screen with its composer cut off: the logo box and the hidden cursor somewhere in it. */
  const drawing = () => {
    const idle = state(f, "idle");
    return "\x1b[?25l" + idle.rows.slice(0, 20).map((r, y) => `\x1b[${y + 1};1H${r.text}`).join("") + "\x1b[8;40H";
  };

  test("types the line once the composer's box is drawn (not at the start screen), then its Enter after the pause; plan mode shows: no note", async () => {
    const { s, pty, notes } = grok();
    pty.print(ON + drawing());
    await settle(150);
    expect(pty.writes).toEqual([]);
    pty.print("\x1b[2J" + state(f, "idle").ansi);
    await until(() => pty.writes.length === 1);
    expect(pty.writes).toEqual([LINE]);
    pty.print(state(f, "plan-line").ansi);
    await until(() => pty.writes.length === 2);
    expect(pty.writes).toEqual([LINE, "\r"]);
    pty.print(state(f, "plan-mode").ansi);
    await settle(450);
    expect(pty.writes).toEqual([LINE, "\r"]);
    expect(notes).toEqual([]);
    s.dispose();
  });

  test("the text never shows in the box, or plan mode never shows: the user is told, naming Grok Build and the line", async () => {
    const lost = grok();
    lost.pty.print(ON + state(f, "idle").ansi);
    await until(() => lost.notes.length === 1);
    expect(lost.pty.writes).toEqual([LINE]);
    expect(lost.notes[0]).toContain("didn't reach");
    expect(lost.notes[0]).toContain("Grok Build");
    expect(lost.notes[0]).toContain(LINE);
    lost.s.dispose();
    const normal = grok();
    normal.pty.print(ON + state(f, "idle").ansi);
    await until(() => normal.pty.writes.length === 1);
    normal.pty.print(state(f, "plan-line").ansi);
    await until(() => normal.pty.writes.length === 2);
    // Still the normal mode (no ` · plan` in the border) after the Enter.
    normal.pty.print(state(f, "idle-cleared").ansi);
    await until(() => normal.notes.length === 1);
    expect(normal.notes[0]).toContain("Plan mode");
    expect(normal.notes[0]).toContain(LINE);
    normal.s.dispose();
  });
});

// Kimi Code's brief the same way. Kimi draws its composer before it has applied its env model (the welcome banner's
// `Model:` line and the footer come 0.1 to 1 s later): a line sent into that early composer can draw `Error: LLM not set` (F04).
describe.concurrent("BUG-674/F04: the launch's first line: Kimi Code waits for its model", () => {
  const LINE = "Read the session brief in /tmp/x/session.md and start.";
  const FAST = { waitMs: 400 * SLOW, pauseMs: 60, landMs: 300 * SLOW, planMs: 300 * SLOW };
  const ON = "\x1b[?2004h";
  const f = fixture("kimi-code");
  const size = sizeOf(f, state(f, "frame-early-composer"));
  const kimi = (o: Partial<FirstLineTiming> = {}) => {
    const r = session({ harness: "kimi-code", firstLine: LINE, firstLineTiming: { ...FAST, ...o }, ...size });
    const notes: string[] = [];
    r.s.onNote((n) => notes.push(n));
    return { ...r, notes };
  };

  test("the early composer (empty, bracketed paste on, no banner or footer yet) gets nothing; once the model shows the line is typed, then its Enter", async () => {
    const { s, pty, notes } = kimi();
    pty.print(ON + state(f, "frame-early-composer").ansi);
    await settle(200);
    expect(pty.writes).toEqual([]);
    // Kimi applied its model: the banner and the footer are drawn and the composer moved down.
    pty.print("\x1b[2J" + state(f, "frame-ready-composer").ansi);
    await until(() => pty.writes.length === 1);
    expect(pty.writes).toEqual([LINE]);
    // The text is in the composer: the Enter goes, apart.
    const ready = state(f, "frame-ready-composer");
    const echoed = ready.rows.map((r, y) => `\x1b[${y + 1};1H${/^ │ > +│/.test(r.text) ? ` │ > ${LINE}`.padEnd(r.text.length - 1) + "│" : r.text}`).join("");
    pty.print("\x1b[2J" + echoed);
    await until(() => pty.writes.length === 2);
    expect(pty.writes).toEqual([LINE, "\r"]);
    s.dispose();
    expect(notes).toEqual([]);
  });

  test("the user can type into the early composer at any time: their keys go through and Gluon types nothing then; the line is given to them", async () => {
    const { s, pty, notes } = kimi();
    pty.print(ON + state(f, "frame-early-composer").ansi);
    await settle(100);
    for (const k of keys("h")) s.input(k);
    await until(() => pty.writes.length === 1);
    expect(pty.writes).toEqual(["h"]);
    await until(() => notes.length === 1);
    expect(notes[0]).toContain("you typed first");
    expect(notes[0]).toContain(LINE);
    pty.print("\x1b[2J" + state(f, "frame-ready-composer").ansi);
    await settle(200);
    expect(pty.writes).toEqual(["h"]);
    s.dispose();
  });

  test("a model that never shows: nothing is typed and, at the wait's end, the user is told the line to type", async () => {
    const { s, pty, notes } = kimi({ waitMs: 300 * SLOW });
    pty.print(ON + state(f, "frame-early-composer").ansi);
    await until(() => notes.length === 1);
    expect(pty.writes).toEqual([]);
    expect(notes[0]).toContain("Kimi Code");
    expect(notes[0]).toContain(LINE);
    s.dispose();
  });
});

describe.concurrent("the question (/clear ends this session in Gluon — end it?)", () => {
  test("BUG-234/F31: a typed /clear holds its Enter: Esc never sends it (the line stays typed, the next Enter asks again); Enter lets the agent clear, then ends it", async () => {
    const { s, pty } = session();
    const asked: (string | null)[] = [];
    s.onQuestion((q) => asked.push(q));
    for (const k of keys("/clear")) s.input(k);
    s.input(keys("\r")[0]!);
    await until(() => s.question === END_QUESTION);
    expect(pty.writes.join("")).toBe("/clear");
    // While it's up, keys answer it (a typed letter does nothing).
    s.input(keys("x")[0]!);
    s.input(keys("\x1b")[0]!);
    await until(() => s.question === null);
    await settle();
    // No: the Enter never went; `/clear` is still on the agent's line.
    expect(pty.writes.join("")).toBe("/clear");
    expect(pty.kills).toEqual([]);
    // Enter on that same line asks again.
    s.input(keys("\r")[0]!);
    await until(() => s.question === END_QUESTION);
    s.input(keys("\r")[0]!);
    // The agent clears (output), then is quiet: ended.
    await until(() => pty.writes.join("") === "/clear\r");
    pty.print("cleared");
    await until(() => pty.kills.length > 0, 4000);
    expect(pty.writes.join("")).toBe("/clear\r");
    expect(pty.kills[0]).toBe("SIGTERM");
    await s.exited;
    expect(s.reason).toBe("clear");
    expect(asked).toEqual([END_QUESTION, null, END_QUESTION, null]);
  });

  test("BUG-270/GLUON-53: the question says what the command does in Gluon — `/clear ends this session in Gluon — end it?`, `/new …` for /new; /compact keeps its own", async () => {
    expect(END_QUESTION).toBe("/clear ends this session in Gluon — end it?");
    for (const [typed, q] of [
      ["/new", "/new ends this session in Gluon — end it?"],
      ["/clear", END_QUESTION],
      ["/compact", END_COMPACT_QUESTION],
    ] as const) {
      const { s } = session();
      for (const k of keys(typed)) s.input(k);
      s.input(keys("\r")[0]!);
      await until(() => s.question !== null);
      expect(s.question!).toBe(q);
      s.dispose();
    }
  });

  test("BUG-311/resume: onSessionId fires once with the first valid session event; later ones are ignored; a late subscriber is called at once; unsubscribing works", async () => {
    const { dir } = createEventsDir(TMP);
    const { s } = session({ events: dir, harness: "codex" });
    expect(s.sessionId).toBeUndefined();
    const first: string[] = [];
    const gone: string[] = [];
    s.onSessionId((id) => void first.push(id));
    s.onSessionId((id) => void gone.push(id))();
    writeEvent(dir, { name: "session", id: "sess-1" });
    await until(() => s.sessionId !== undefined);
    // A sub-agent's id, and the same one again: ignored.
    writeEvent(dir, { name: "session", id: "sub-2" });
    writeEvent(dir, { name: "session", id: "sess-1" });
    await Bun.sleep(300);
    expect(first).toEqual(["sess-1"]);
    expect(gone).toEqual([]);
    expect(s.sessionId).toBe("sess-1");
    const late: string[] = [];
    s.onSessionId((id) => void late.push(id));
    expect(late).toEqual(["sess-1"]);
    s.dispose();
  });

  test("BUG-337/fork: onMainSession fires with every change of the hook's session id (a fork or a new thread), not for a repeat; a late subscriber gets the latest; the resume id stays the first", async () => {
    const { dir } = createEventsDir(TMP);
    const { s } = session({ events: dir, harness: "codex" });
    const main: string[] = [];
    s.onMainSession((id) => void main.push(id));
    writeEvent(dir, { name: "session", id: "sess-1" });
    writeEvent(dir, { name: "session", id: "sess-1" });
    await until(() => main.length >= 1);
    writeEvent(dir, { name: "session", id: "fork-2" });
    await until(() => main.length >= 2);
    writeEvent(dir, { name: "session", id: "fork-2" });
    await Bun.sleep(300);
    expect(main).toEqual(["sess-1", "fork-2"]);
    expect(s.sessionId).toBe("sess-1");
    const late: string[] = [];
    s.onMainSession((id) => void late.push(id));
    expect(late).toEqual(["fork-2"]);
    s.dispose();
  });

  test("BUG-311/resume: an invalid session event never sets the id (the next valid one does); a throwing subscriber breaks nothing", async () => {
    const { dir } = createEventsDir(TMP);
    const { s } = session({ events: dir, harness: "opencode" });
    const got: string[] = [];
    s.onSessionId(() => {
      throw new Error("boom");
    });
    s.onSessionId((id) => void got.push(id));
    writeFileSync(join(dir, "000000000000001-000001-1-aaaaaa.event"), "session -x");
    writeFileSync(join(dir, "000000000000002-000002-1-bbbbbb.event"), "session");
    await Bun.sleep(300);
    expect(s.sessionId).toBeUndefined();
    writeEvent(dir, { name: "session", id: "ses_ok" });
    await until(() => got.length > 0);
    expect(got).toEqual(["ses_ok"]);
    s.dispose();
  });

  test("BUG-176/F: after a yes, a slow agent gets its time: nothing ended before it reacts; its hooks' status keeps it going; at most settleMaxMs @full", async () => {
    const { dir } = createEventsDir(TMP);
    const { s, pty } = session({ events: dir });
    for (const k of keys("/clear")) s.input(k);
    s.input(keys("\r")[0]!);
    await until(() => s.question === END_QUESTION);
    const at = Date.now();
    s.input(keys("\r")[0]!);
    // 2 s without a sign of life (the old cap was 1.5 s): still running.
    await Bun.sleep(2000);
    expect(pty.kills).toEqual([]);
    // Its /clear's hooks report while it closes: each one counts as activity.
    pty.print("clearing");
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(600);
      writeEvent(dir, { name: "status", status: { state: "working" } });
    }
    await Bun.sleep(400);
    expect(pty.kills).toEqual([]);
    await until(() => pty.kills.length > 0, 4000);
    expect(Date.now() - at).toBeGreaterThanOrEqual(3800);
    await s.exited;
    expect(s.reason).toBe("clear");
    // Never responding at all: ended at the cap.
    const quiet = session({ settleMaxMs: 300 });
    for (const k of keys("/clear")) quiet.s.input(k);
    quiet.s.input(keys("\r")[0]!);
    await until(() => quiet.s.question === END_QUESTION);
    quiet.s.input(keys("\r")[0]!);
    await until(() => quiet.pty.kills.length > 0, 2000);
  }, 15_000);

  test("Ctrl+C is no in every keyboard protocol (plain, kitty, win32-input-mode); a paste never answers", async () => {
    for (const ctrlC of ["\x03", "\x1b[99;5u", "\x1b[67;46;3;1;8;1_"]) {
      const { s, pty } = session();
      for (const k of keys("/clear")) s.input(k);
      s.input(keys("\r")[0]!);
      await until(() => s.question === END_QUESTION);
      for (const k of keys("\x1b[200~\r\x1b[201~")) s.input(k);
      await settle();
      expect(s.question).toBe(END_QUESTION);
      for (const k of keys(ctrlC)) s.input(k);
      await until(() => s.question === null);
      // No: the held Enter never goes (BUG-234), the agent stays.
      await settle();
      expect(pty.writes.join("")).toBe("/clear");
      expect(pty.kills).toEqual([]);
      s.dispose();
    }
  });

  test("BUG-234/F25: a typed /compact's no never sends the Enter: nothing compacts, no marker is left, the next Enter asks again", async () => {
    const { dir } = createEventsDir(TMP);
    const { s, pty } = session({ events: dir });
    for (const k of keys("/compact")) s.input(k);
    s.input(keys("\r")[0]!);
    await until(() => s.question === END_COMPACT_QUESTION);
    s.input(keys("\x1b")[0]!);
    await until(() => s.question === null);
    await settle();
    expect(pty.writes.join("")).toBe("/compact");
    expect(readdirSync(dir).filter((f) => f !== "pid")).toEqual([]);
    s.input(keys("\r")[0]!);
    await until(() => s.question === END_COMPACT_QUESTION);
    s.input(keys("\r")[0]!);
    await s.exited;
    expect(s.reason).toBe("compact");
    expect(pty.writes.join("")).toBe("/compact");
  });

  test("an unanswered compaction question is no", async () => {
    const { dir } = createEventsDir(TMP);
    const pty = fakePty();
    const s = new AgentSession({ argv: ["agent"], env: {}, harness: "claude-code", settings: handoffFor(handoffDefaults(), "claude-code"), cols: 60, rows: 12, spawn: pty.spawn, events: dir, compactTimeoutMs: 100 });
    writeEvent(dir, { name: "compact", id: "late" });
    await until(() => s.question === END_COMPACT_QUESTION);
    await until(() => existsSync(join(dir, "late.answer")));
    expect(readFileSync(join(dir, "late.answer"), "utf8")).toBe("no");
    expect(s.question).toBeNull();
    s.dispose();
  });

  test("BUG-172/F: a paste reaches an agent without bracketed paste as its bytes, no markers; with it, as pasted", async () => {
    const { s, pty } = session({ settings: { on_clear: "stay" } });
    for (const k of keys("\x1b[200~/clear\x1c\r\x1b[201~")) s.input(k);
    await until(() => pty.writes.join("") === "/clear\x1c\r");
    pty.print("\x1b[?2004h");
    await settle();
    for (const k of keys("\x1b[200~ab\x1b[201~")) s.input(k);
    await until(() => pty.writes.join("") === "/clear\x1c\r\x1b[200~ab\x1b[201~");
    s.dispose();
  });

  test("a paste never counts; with on_clear: stay nothing is held", async () => {
    const { s, pty } = session({ settings: { on_clear: "stay" } });
    for (const k of keys("/clear\r")) s.input(k);
    await until(() => pty.writes.join("") === "/clear\r");
    expect(s.question).toBeNull();
    const p = session();
    for (const k of keys("\x1b[200~/clear\x1b[201~\r")) p.s.input(k);
    await until(() => p.pty.writes.join("").endsWith("\r"));
    expect(p.s.question).toBeNull();
    s.dispose();
    p.s.dispose();
  });
});

describe.concurrent("events", () => {
  test("back shows home (the agent keeps running); a status sets the state; a waiting compaction asks, no is answered", async () => {
    const { dir } = createEventsDir(TMP);
    const { s, pty } = session({ events: dir });
    let backs = 0;
    s.onBack(() => backs++);
    const states: string[] = [];
    s.onStatus((st) => states.push(`${st.state}${st.activity ? `:${st.activity}` : ""}`));
    writeEvent(dir, { name: "back" });
    await until(() => backs === 1);
    expect(pty.kills).toEqual([]);
    expect(s.alive).toBe(true);
    writeEvent(dir, { name: "status", status: { state: "awaiting", activity: "Bash: bun test" } });
    await until(() => states.includes("awaiting:Bash: bun test"));
    writeEvent(dir, { name: "compact", id: "abc123" });
    await until(() => s.question === END_COMPACT_QUESTION);
    s.input(keys("\x1b")[0]!);
    await until(() => existsSync(join(dir, "abc123.answer")));
    expect(readFileSync(join(dir, "abc123.answer"), "utf8")).toBe("no");
    writeEvent(dir, { name: "compact", id: "def456" });
    await until(() => s.question === END_COMPACT_QUESTION);
    s.input(keys("\r")[0]!);
    await s.exited;
    expect(s.reason).toBe("compact");
    // A yes is never answered: the hook goes with the agent (BUG-151).
    expect(existsSync(join(dir, "def456.answer"))).toBe(false);
  });
});

describe.concurrent("BUG-187/live: a turn's end after a tool line", () => {
  test("Stop (done) after a tool line says the turn finished; a done with an activity of its own keeps it", async () => {
    const { dir } = createEventsDir(TMP);
    const { s } = session({ events: dir });
    const status = (st: { state?: "working" | "awaiting" | "done"; activity?: string }) => writeEvent(dir, { name: "status", status: st });
    status({ state: "working", activity: "Bash: bun test" });
    status({ state: "working" });
    await until(() => s.state.activity === "Bash: bun test");
    status({ state: "done" });
    await until(() => s.state.state === "done");
    expect(s.state.activity).toBe(TURN_FINISHED);
    status({ state: "working", activity: "Read a.ts" });
    await until(() => s.state.state === "working");
    status({ state: "done", activity: "its own" });
    await until(() => s.state.state === "done");
    expect(s.state.activity).toBe("its own");
    s.dispose();
  });
});

describe.concurrent("BUG-214/live: a row's activity never stays on an answered question", () => {
  const PERMISSION = "Claude needs your permission to use Bash";

  test("Claude Code's permission prompt, answered: the tool line again while it runs, Turn finished at Stop", async () => {
    const { dir } = createEventsDir(TMP);
    const { s } = session({ events: dir });
    const status = (st: { state?: "working" | "awaiting" | "done"; activity?: string }) => writeEvent(dir, { name: "status", status: st });
    const seen: (string | undefined)[] = [];
    s.onStatus((st) => seen.push(st.activity));
    // PreToolUse, then the Notification (permission_prompt) with its message.
    status({ state: "working", activity: "Bash: bun test" });
    status({ state: "awaiting", activity: PERMISSION });
    await until(() => s.state.state === "awaiting");
    expect(s.state.activity).toBe(PERMISSION);
    // Allowed: PostToolUse says working (no activity) — the question is answered.
    status({ state: "working" });
    await until(() => s.state.state === "working");
    expect(s.state.activity).toBe("Bash: bun test");
    // A second prompt in the same turn, then Stop: the turn finished, not the question.
    status({ state: "awaiting", activity: PERMISSION });
    await until(() => s.state.state === "awaiting");
    status({ state: "done" });
    await until(() => s.state.state === "done");
    expect(s.state.activity).toBe(TURN_FINISHED);
    expect(seen.at(-1)).toBe(TURN_FINISHED);
    s.dispose();
  });

  test("a question with no tool line before it: answered, no activity (the row says Working); its idle notification (done) after: Turn finished", async () => {
    const { dir } = createEventsDir(TMP);
    const { s } = session({ events: dir });
    const status = (st: { state?: "working" | "awaiting" | "done"; activity?: string }) => writeEvent(dir, { name: "status", status: st });
    status({ state: "awaiting", activity: "Claude needs your input" });
    await until(() => s.state.state === "awaiting");
    status({ state: "working" });
    await until(() => s.state.state === "working");
    expect(s.state.activity).toBeUndefined();
    // Asked again and left unanswered until the turn ends (Notification idle_prompt → done).
    status({ state: "awaiting", activity: PERMISSION });
    await until(() => s.state.state === "awaiting");
    status({ state: "done" });
    await until(() => s.state.state === "done");
    expect(s.state.activity).toBe(TURN_FINISHED);
    // Awaiting with no message of its own (Codex's PermissionRequest) keeps the tool line it asks about.
    status({ state: "working", activity: "Edit a.ts" });
    status({ state: "awaiting" });
    await until(() => s.state.state === "awaiting");
    expect(s.state.activity).toBe("Edit a.ts");
    s.dispose();
  });
});

describe.concurrent("BUG-610/QA-frame-03: a new turn is not the last turn's end", () => {
  test("a turn's end says Turn finished; the next turn's working (no tool line yet) clears it; its own tool line shows; Stop again: Turn finished", async () => {
    const { dir } = createEventsDir(TMP);
    const { s } = session({ events: dir });
    const status = (st: { state?: "working" | "awaiting" | "done"; activity?: string }) => writeEvent(dir, { name: "status", status: st });
    status({ state: "working", activity: "Editing app.ts" });
    await until(() => s.state.activity === "Editing app.ts");
    status({ state: "done" });
    await until(() => s.state.state === "done");
    expect(s.state.activity).toBe(TURN_FINISHED);
    // UserPromptSubmit: working, no activity (the old line was replaced by Turn finished: BUG-187; that is not this turn's).
    status({ state: "working" });
    await until(() => s.state.state === "working");
    expect(s.state.activity).toBeUndefined();
    status({ state: "working", activity: "Reading b.ts" });
    await until(() => s.state.activity === "Reading b.ts");
    status({ state: "done" });
    await until(() => s.state.state === "done");
    expect(s.state.activity).toBe(TURN_FINISHED);
    s.dispose();
  });

  test("an agent's own activity kept by a working event with none, and a Turn finished after an awaiting (a question) still cleared by the next working", async () => {
    const { dir } = createEventsDir(TMP);
    const { s } = session({ events: dir });
    const status = (st: { state?: "working" | "awaiting" | "done"; activity?: string }) => writeEvent(dir, { name: "status", status: st });
    // A figures-only event (no state) after a turn's end leaves Turn finished as it is.
    status({ state: "working", activity: "Edit a.ts" });
    status({ state: "done" });
    await until(() => s.state.state === "done");
    writeEvent(dir, { name: "status", status: { costUsd: 0.01 } });
    await until(() => s.state.costUsd === 0.01);
    expect(s.state.activity).toBe(TURN_FINISHED);
    status({ state: "working" });
    await until(() => s.state.state === "working");
    expect(s.state.activity).toBeUndefined();
    s.dispose();
  });
});

describe.concurrent("status fallback (an agent without hooks)", () => {
  test("quiet output with the input line on screen → awaiting; output again → working; exit → done", async () => {
    let now = 0;
    const { s, pty } = session({ now: () => now, tickMs: 10 });
    const states: string[] = [];
    s.onStatus((st) => states.push(st.state));
    pty.print(`${"─".repeat(20)}\r\n❯ \r\n${"─".repeat(20)}\x1b[2;3H`);
    await settle(50);
    expect(s.state.state).toBe("working");
    now += QUIET_AWAIT_MS + 1;
    await until(() => s.state.state === "awaiting");
    now += 1000;
    pty.print("more output");
    expect(s.state.state).toBe("working");
    pty.exit(0);
    await s.exited;
    expect(s.state.state).toBe("done");
    expect(states).toEqual(["awaiting", "working", "done"]);
  });

  test("BUG-663/QA-live-04: Kimi Code's `question` panel (no composer, no hooks) on a quiet screen → awaiting, and `awaitsChoice` says so (the compositor reads it per key); a `[1]` list quoted in its output stays Working", async () => {
    // Captured live on Kimi Code 2.1.1 (the fixture's notes). Live: the row said Working for over four minutes.
    const f = fixture("kimi-code");
    for (const name of ["frame-question-panel", "frame-question-panel-wrapped", "frame-question-panel-described"]) {
      const st = state(f, name);
      let now = 0;
      const { s, pty } = session({ harness: "kimi-code", now: () => now, tickMs: 10, ...sizeOf(f, st) });
      pty.print(st.ansi);
      await settle(80);
      expect([name, s.state.state]).toEqual([name, "working"]);
      expect([name, s.awaitsChoice]).toEqual([name, true]);
      now += QUIET_AWAIT_MS + 1;
      await until(() => s.state.state === "awaiting");
      s.dispose();
    }
    let now = 0;
    const quoted = session({ harness: "kimi-code", now: () => now, tickMs: 10, cols: 98, rows: 24 });
    quoted.pty.print("\x1b[2J\x1b[H ● Kimi wrote:\r\n   [1] README only\r\n   [2] README + minimal test\r\n   [3] Other\r\n\r\n ↑↓ select  1-3 / ↵ choose  ←/→/tab switch  esc cancel");
    await settle(80);
    now += QUIET_AWAIT_MS + 1;
    await settle(150);
    expect(quoted.s.awaitsChoice).toBe(false);
    expect(quoted.s.state.state).toBe("working");
    quoted.s.dispose();
  });

  test("a key's echo is not work; a hook's state wins over output", async () => {
    let now = 0;
    const { dir } = createEventsDir(TMP);
    const { s, pty } = session({ now: () => now, tickMs: 10, events: dir });
    writeEvent(dir, { name: "status", status: { state: "done" } });
    await until(() => s.state.state === "done");
    now += 50;
    pty.print("output after the hook");
    expect(s.state.state).toBe("done");
    s.dispose();
    const b = session({ now: () => now, tickMs: 10 });
    b.pty.print(`${"─".repeat(20)}\r\n❯ \r\n${"─".repeat(20)}\x1b[2;3H`);
    await settle(30);
    now += QUIET_AWAIT_MS + 1;
    await until(() => b.s.state.state === "awaiting");
    b.s.input(keys("a")[0]!);
    await until(() => b.pty.writes.length === 1);
    now += 10;
    b.pty.print("a");
    expect(b.s.state.state).toBe("awaiting");
    b.s.dispose();
  });
});

describe.concurrent("BUG-204/live: an idle agent with hooks isn't Working for good after output", () => {
  test("a redraw after Gluon's resize is not work; other output long after the hook is, until it goes quiet", async () => {
    let now = 0;
    const { dir } = createEventsDir(TMP);
    const { s, pty } = session({ now: () => now, tickMs: 10, events: dir });
    writeEvent(dir, { name: "status", status: { state: "awaiting" } });
    await until(() => s.state.state === "awaiting");
    now += HOOK_TRUST_MS + 1000;
    // The terminal was resized: the agent redraws its idle screen.
    s.resize(80, 20);
    now += 50;
    pty.print("\x1b[2J\x1b[H idle screen, redrawn");
    expect(s.state.state).toBe("awaiting");
    // Output long after the hook, not a redraw nor an echo: a guess of work (past the window in
    // which a late redraw is still owed, REDRAW_WAIT_MS: BUG-669)...
    now += REDRAW_WAIT_MS + 1;
    pty.print("something else");
    expect(s.state.state).toBe("working");
    // ...that goes back to what the hook said once the output is quiet.
    now += QUIET_AWAIT_MS + 1;
    await until(() => s.state.state === "awaiting");
    // A hook's working stays, quiet or not.
    writeEvent(dir, { name: "status", status: { state: "working" } });
    await until(() => s.state.state === "working");
    now += QUIET_AWAIT_MS + 1;
    await settle(50);
    expect(s.state.state).toBe("working");
    s.dispose();
  });
});

describe.concurrent("QA live: Esc during a turn", () => {
  // Claude Code and Codex send no Stop hook when the user interrupts a turn (seen live: Claude Code 2.1.291 on Bedrock, Codex 0.160.0): the
  // last hook said working and nothing says otherwise, so the row stays Working with the stale activity for good while the agent sits idle.
  // Claude draws a no-break space after the `⎿` (the captured screens have it).
  const rule = "─".repeat(40);
  const claudeBox = `${rule}\r\n❯ \r\n${rule}\r\n  ⏸ manual mode on · ? for shortcuts\x1b[4;3H`;
  const codexBox = `\x1b[5;1H\x1b[2K\x1b[1m› \x1b[0m\x1b[2mAsk Codex to do anything\x1b[0m\x1b[5;3H\x1b[6;1H\x1b[2K  gpt-5 default · ~/proj\x1b[5;3H`;
  const CODEX_MARK = "■ Conversation interrupted - use /feedback if something went wrong";
  const CLAUDE_MARK = "Interrupted · What should Claude do instead?";
  const interrupted: [Harness, string][] = [
    ["claude-code", `\x1b[2J\x1b[H❯ Write a very long essay\r\n  ⎿  ${CLAUDE_MARK}\r\n${claudeBox}`],
    ["codex", `\x1b[2J\x1b[H› Write a very long essay\r\n\r\n${CODEX_MARK}${codexBox}`],
  ];
  /** The same turn on the idle box with no marker (Esc not pressed, or a harness that says nothing). */
  const idle: Record<string, string> = {
    "claude-code": `\x1b[2J\x1b[H❯ Write a very long essay\r\n● Here is the start of the essay.\r\n${claudeBox}`,
    codex: `\x1b[2J\x1b[H› Write a very long essay\r\n\r\n• Here is the start of the essay.${codexBox}`,
  };
  /** The marker's words in what the agent printed: a tool's output, with a line after it, above the idle box. */
  const quoted: Record<string, string> = {
    "claude-code": `\x1b[2J\x1b[H❯ cat notes.txt\r\n  ⎿  ${CLAUDE_MARK}\r\n     more of the file\r\n${claudeBox}`,
    codex: `\x1b[2J\x1b[H• Ran cat notes.txt\r\n  └ ${CODEX_MARK}\r\n    more of the file${codexBox}`,
  };
  for (const [harness, screen] of interrupted) {
    test(`BUG-609/QA-live-01: ${harness}, a turn interrupted with Esc (the hook said working, no Stop followed, the screen is idle and says Interrupted): the row goes back to awaiting after the quiet period, not Working for good`, async () => {
      // Control: the same screen with no hook ever seen reads as awaiting (the screen fallback works).
      let now = 0;
      const a = session({ harness, now: () => now, tickMs: 10 });
      a.pty.print(screen);
      await settle(30);
      now += QUIET_AWAIT_MS + 1;
      await until(() => a.s.state.state === "awaiting");
      a.s.dispose();
      // With hooks: UserPromptSubmit said working, the user pressed Esc, no Stop came.
      const { dir } = createEventsDir(TMP);
      const b = session({ harness, now: () => now, tickMs: 10, events: dir });
      writeEvent(dir, { name: "status", status: { state: "working" } });
      await until(() => b.s.state.state === "working");
      b.pty.print(screen);
      await settle(30);
      now += 60_000;
      // Wait for the row to change rather than for 100 ms: the screen model parses the print on its own time (slow on Windows), and a tick before that reads the old screen.
      await until(() => b.s.state.state === "awaiting");
      b.s.dispose();
    });

    test(`BUG-609/QA-live-01: ${harness}, no marker on the idle screen: the hook's Working and its tool line stay (BUG-204); the marker ends them, the stale tool line goes, and a later redraw's guess falls back to awaiting`, async () => {
      let now = 0;
      const { dir } = createEventsDir(TMP);
      const { s, pty } = session({ harness, now: () => now, tickMs: 10, events: dir });
      writeEvent(dir, { name: "status", status: { state: "working", activity: "Bash: echo hi > proof.txt" } });
      await until(() => s.state.activity === "Bash: echo hi > proof.txt");
      pty.print(idle[harness]!);
      await settle(30);
      now += 60_000;
      await settle(100);
      expect(s.state.state).toBe("working");
      expect(s.state.activity).toBe("Bash: echo hi > proof.txt");
      // Esc: the marker on the agent's own rows, quiet: awaiting, and the stale tool line is gone.
      pty.print(screen);
      await settle(30);
      now += 60_000;
      await until(() => s.state.state === "awaiting");
      expect(s.state.activity).toBeUndefined();
      // The agent redraws long after (a guess of work), then goes quiet: back to awaiting, the state the interruption left.
      now += HOOK_TRUST_MS + 1000;
      pty.print(screen);
      expect(s.state.state).toBe("working");
      now += QUIET_AWAIT_MS + 1;
      await until(() => s.state.state === "awaiting");
      s.dispose();
    });

    test(`BUG-609/QA-live-01: ${harness}, a hook says working after the marker was drawn (a new turn): Working stays, quiet or not; the marker drawn after that hook ends it again`, async () => {
      let now = 0;
      const { dir } = createEventsDir(TMP);
      const { s, pty } = session({ harness, now: () => now, tickMs: 10, events: dir });
      const status = (st: { state?: "working" | "awaiting" | "done"; activity?: string }) => writeEvent(dir, { name: "status", status: st });
      status({ state: "working", activity: "Bash: sleep 99" });
      await until(() => s.state.activity === "Bash: sleep 99");
      pty.print(screen);
      await settle(30);
      now += 60_000;
      await until(() => s.state.state === "awaiting");
      // The user sends a new prompt: UserPromptSubmit says working while the old marker is still the last row on screen (no output since).
      status({ state: "working", activity: "Edit app.ts" });
      await until(() => s.state.state === "working");
      now += 60_000;
      await settle(100);
      expect(s.state.state).toBe("working");
      expect(s.state.activity).toBe("Edit app.ts");
      // Interrupted again: the marker drawn after that hook ends it.
      pty.print(screen);
      await settle(30);
      now += 60_000;
      await until(() => s.state.state === "awaiting");
      s.dispose();
    });

    test(`BUG-609/QA-live-01: ${harness}, the marker's words inside what the agent printed (a file's text, with more output under them): the hook's Working is not ended`, async () => {
      let now = 0;
      const { dir } = createEventsDir(TMP);
      const { s, pty } = session({ harness, now: () => now, tickMs: 10, events: dir });
      writeEvent(dir, { name: "status", status: { state: "working" } });
      await until(() => s.state.state === "working");
      pty.print(quoted[harness]!);
      await settle(30);
      now += 60_000;
      await settle(100);
      expect(s.state.state).toBe("working");
      s.dispose();
    });
  }

  for (const [harness, name] of [
    ["claude-code", "frame-interrupted"],
    ["codex", "frame-turn-idle"],
  ] as const) {
    test(`BUG-609/QA-live-01: ${harness}, the captured interrupted screen (${name}) ends a hook's Working and its tool line`, async () => {
      const f = fixture(harness);
      const st = state(f, name);
      let now = 0;
      const { dir } = createEventsDir(TMP);
      const { s, pty } = session({ harness, now: () => now, tickMs: 10, events: dir, ...sizeOf(f, st) });
      writeEvent(dir, { name: "status", status: { state: "working", activity: "Bash: echo hi > proof.txt" } });
      await until(() => s.state.activity === "Bash: echo hi > proof.txt");
      pty.print(st.ansi);
      await settle(30);
      now += 60_000;
      await until(() => s.state.state === "awaiting");
      expect(s.state.activity).toBeUndefined();
      s.dispose();
    });
  }

  for (const cols of [40, 30]) {
    test(`BUG-609/QA-live-01: at ${cols} columns the marker wraps over two rows (Claude Code's, Codex's): a hook's Working still ends`, async () => {
      const rule = "─".repeat(cols);
      const screens: [Harness, string][] = [
        ["claude-code", `\x1b[2J\x1b[H❯ Write an essay\r\n  ⎿ \u00a0Interrupted · What should Claude do instead?\r\n${rule}\r\n❯ \r\n${rule}\r\n  ⏸ manual mode on\x1b[6;3H`],
        ["codex", `\x1b[2J\x1b[H› Write an essay\r\n\r\n■ Conversation interrupted - use /feedback if something went wrong\x1b[6;1H\x1b[2K\x1b[1m› \x1b[0m\x1b[2mAsk Codex\x1b[0m\x1b[6;3H`],
      ];
      for (const [harness, screen] of screens) {
        let now = 0;
        const { dir } = createEventsDir(TMP);
        const { s, pty } = session({ harness, now: () => now, tickMs: 10, events: dir, cols, rows: 12 });
        writeEvent(dir, { name: "status", status: { state: "working", activity: "Bash: sleep 99" } });
        await until(() => s.state.activity === "Bash: sleep 99");
        pty.print(screen);
        await settle(30);
        now += 60_000;
        await until(() => s.state.state === "awaiting");
        expect(s.state.activity).toBeUndefined();
        s.dispose();
      }
    });
  }

  test("BUG-609/QA-live-01 (F10): the captured context-limit screen (frame-precompact: the limit is in the history, PreCompact runs under it): a hook's Working is not ended", async () => {
    const f = fixture("claude-code");
    const st = state(f, "frame-precompact");
    let now = 0;
    const { dir } = createEventsDir(TMP);
    const { s, pty } = session({ harness: "claude-code", now: () => now, tickMs: 10, events: dir, ...sizeOf(f, st) });
    writeEvent(dir, { name: "status", status: { state: "working" } });
    await until(() => s.state.state === "working");
    pty.print(st.ansi);
    await settle(30);
    now += 60_000;
    await settle(100);
    expect(s.state.state).toBe("working");
    s.dispose();
  });
});

describe.concurrent("BUG-242/GLUON-36: a late redraw after a resize isn't work either; real work still is", () => {
  /** An idle agent without hooks (its prompt on screen, quiet): awaiting. */
  async function idle() {
    let now = 0;
    const b = session({ now: () => now, tickMs: 10 });
    b.pty.print(`${"─".repeat(20)}\r\n❯ \r\n${"─".repeat(20)}\x1b[2;3H`);
    await settle(30);
    now += QUIET_AWAIT_MS + 1;
    await until(() => b.s.state.state === "awaiting");
    return { ...b, at: (ms: number) => (now += ms) };
  }

  test("two resizes, each redrawn 1.5 s late (a TUI that debounces SIGWINCH): still awaiting; output after the redraw went quiet is work", async () => {
    const { s, pty, at } = await idle();
    s.resize(80, 20);
    at(200);
    s.resize(100, 30);
    at(1500);
    pty.print("\x1b[2J\x1b[H redrawn at 80x20");
    at(200);
    pty.print("\x1b[2J\x1b[H redrawn at 100x30");
    expect(s.state.state).toBe("awaiting");
    at(REDRAW_GRACE_MS + 1);
    pty.print("new work");
    expect(s.state.state).toBe("working");
    s.dispose();
  });

  test("a redraw that never comes: output past REDRAW_WAIT_MS is work; output that goes on past it is work", async () => {
    const a = await idle();
    a.s.resize(80, 20);
    a.at(REDRAW_WAIT_MS + 1);
    a.pty.print("work");
    expect(a.s.state.state).toBe("working");
    a.s.dispose();
    // A ticking agent: every 200 ms from the resize on reads Working once past the window.
    const b = await idle();
    b.s.resize(80, 20);
    for (let t = 0; t <= REDRAW_WAIT_MS; t += 200) {
      b.at(200);
      b.pty.print(`TICK ${t}`);
    }
    expect(b.s.state.state).toBe("working");
    b.s.dispose();
  });

  test("BUG-669/QA-win-02: ConPTY repaints at once, the agent redraws 1.5 s later: still awaiting; real work after that is work", async () => {
    const { s, pty, at } = await idle();
    s.resize(80, 20);
    at(50);
    pty.print("\x1b[H ConPTY's repaint");
    expect(s.state.state).toBe("awaiting");
    at(1500);
    pty.print("\x1b[2J\x1b[H the agent's redraw");
    expect(s.state.state).toBe("awaiting");
    // Only one late redraw is owed: output after a pause past REDRAW_GRACE_MS is work.
    at(REDRAW_GRACE_MS + 1);
    pty.print("new work");
    expect(s.state.state).toBe("working");
    s.dispose();
  });

  test("BUG-669/QA-win-02: output past the window after ConPTY's repaint is work", async () => {
    const a = await idle();
    a.s.resize(80, 20);
    a.at(50);
    a.pty.print("\x1b[H ConPTY's repaint");
    a.at(REDRAW_WAIT_MS + 1);
    a.pty.print("work");
    expect(a.s.state.state).toBe("working");
    a.s.dispose();
  });

  test("BUG-669/QA-win-02: a key typed after ConPTY's repaint (before the agent's redraw): what the agent prints next is its answer", async () => {
    const { s, pty, at } = await idle();
    s.resize(80, 20);
    at(50);
    pty.print("\x1b[H ConPTY's repaint");
    s.input(keys("\r")[0]!);
    await until(() => pty.writes.length === 1);
    at(ECHO_GRACE_MS + 1);
    pty.print("working on it");
    expect(s.state.state).toBe("working");
    s.dispose();
  });

  test("a key typed after the redraw came: what the agent prints next is its answer, not the redraw", async () => {
    const { s, pty, at } = await idle();
    s.resize(80, 20);
    at(1500);
    pty.print("\x1b[2J\x1b[H redrawn");
    s.input(keys("\r")[0]!);
    await until(() => pty.writes.length === 1);
    at(ECHO_GRACE_MS + 1);
    pty.print("working on it");
    expect(s.state.state).toBe("working");
    s.dispose();
  });
});

describe.concurrent("BUG-244/GLUON-40: Claude Code's first-run trust question reads as awaiting the user, not Working", () => {
  test("its dialog (captured from 2.1.288) on screen and the output quiet: awaiting; a screen with neither an input box nor the dialog stays Working", async () => {
    let now = 0;
    const st = state(fixture("claude-code"), "frame-trust-dialog");
    const { s, pty } = session({ now: () => now, tickMs: 10 });
    s.resize(st.size!.cols, st.size!.rows);
    pty.print(st.ansi);
    await settle(30);
    expect(s.state.state).toBe("working");
    now += QUIET_AWAIT_MS + 1;
    await until(() => s.state.state === "awaiting");
    s.dispose();
    const b = session({ now: () => now, tickMs: 10 });
    b.pty.print(" ❯ No, exit\r\n   Yes, I trust this folder");
    await settle(30);
    now += QUIET_AWAIT_MS + 1;
    await settle(60);
    expect(b.s.state.state).toBe("working");
    b.s.dispose();
  });
});

describe.concurrent("issue-40: Codex's own dialogs (captured from 0.159.3) read as awaiting the user, not Working", () => {
  for (const name of ["frame-folder-trust", "frame-hook-review", "frame-approve-command", "frame-plan-question", "frame-plan-question-notes"]) {
    test(`${name} on screen and the output quiet: awaiting; before that, Working`, async () => {
      let now = 0;
      const st = state(fixture("codex"), name);
      const { s, pty } = session({ harness: "codex", now: () => now, tickMs: 10 });
      s.resize(st.size!.cols, st.size!.rows);
      pty.print(st.ansi);
      await settle(30);
      expect(s.state.state).toBe("working");
      now += QUIET_AWAIT_MS + 1;
      await until(() => s.state.state === "awaiting");
      s.dispose();
    });
  }

  test("a screen that only looks like one (the options, no key hints) stays Working", async () => {
    let now = 0;
    const { s, pty } = session({ harness: "codex", now: () => now, tickMs: 10 });
    pty.print("\x1b[2J\x1b[H\x1b[1;7m› 1. Yes, proceed (y)\x1b[0m\r\n  2. No");
    await settle(30);
    now += QUIET_AWAIT_MS * 2;
    await settle(60);
    expect(s.state.state).toBe("working");
    s.dispose();
  });
});

describe.concurrent("issue-40: the screen fallback and the hooks, for every harness", () => {
  /** Each harness's idle input box as captured. */
  type Drawn = { ansi: string; cols: number; rows: number };
  const captured = (h: Harness, name: string): Drawn => {
    const st = state(fixture(h), name);
    return { ...sizeOf(fixture(h), st), ansi: st.ansi };
  };
  const IDLE: [Harness, string, () => Drawn][] = [
    ["claude-code", "idle", () => captured("claude-code", "idle")],
    ["opencode", "idle", () => captured("opencode", "idle")],
    ["antigravity", "idle", () => captured("antigravity", "idle")],
    ["codex", "idle", () => captured("codex", "idle")],
    // Codex inside Gluon's frame, after a finished turn.
    ["codex", "frame-turn-idle", () => captured("codex", "frame-turn-idle")],
    ["grok-build", "idle", () => captured("grok-build", "idle")],
  ];

  for (const [harness, name, screen] of IDLE) {
    test(`${harness} (${name}), no hooks: its input box on screen reads awaiting only once the output has been quiet ${QUIET_AWAIT_MS} ms`, async () => {
      let now = 0;
      const { cols, rows, ansi } = screen();
      const { s, pty } = session({ harness, now: () => now, tickMs: 10 });
      s.resize(cols, rows);
      pty.print(ansi);
      await settle(30);
      // Output with nothing said yet: at work.
      expect(s.state.state).toBe("working");
      now += QUIET_AWAIT_MS - 100;
      await settle(60);
      expect(s.state.state).toBe("working");
      // More output restarts the quiet.
      pty.print("\x1b[0m");
      now += QUIET_AWAIT_MS - 100;
      await settle(60);
      expect(s.state.state).toBe("working");
      now += 200;
      await until(() => s.state.state === "awaiting");
      s.dispose();
    });
  }

  // Antigravity 1.3.3 under tmux re-sends `ESC[?2004h ESC[>4;2m` every 2 s while idle: it stayed Working for good.
  test("BUG-721/agy-tmux: output that only sets terminal modes is not work and doesn't restart the quiet; drawn output still is", async () => {
    let now = 0;
    const { cols, rows, ansi } = captured("antigravity", "idle");
    const { s, pty } = session({ harness: "antigravity", now: () => now, tickMs: 10 });
    s.resize(cols, rows);
    pty.print(ansi);
    await settle(30);
    expect(s.state.state).toBe("working");
    const keepAlive = "\x1b[?2004h\x1b[>4;2m";
    for (let t = 0; t < 2; t++) {
      now += 1500;
      pty.print(keepAlive);
      await settle(30);
    }
    now += 100;
    await until(() => s.state.state === "awaiting");
    // Past the resize's redraw window: mode settings keep it awaiting, anything drawn is work again.
    now += REDRAW_WAIT_MS;
    pty.print(keepAlive);
    await settle(60);
    expect(s.state.state).toBe("awaiting");
    pty.print(`${keepAlive}x`);
    await until(() => s.state.state === "working");
    s.dispose();
  });

  for (const harness of ["claude-code", "codex", "opencode", "antigravity"] as const) {
    test(`${harness}, no hooks: a quiet screen with no input box on it (it is thinking) stays Working`, async () => {
      let now = 0;
      const { s, pty } = session({ harness, now: () => now, tickMs: 10 });
      pty.print("\x1b[2J\x1b[HThinking… (12s · esc to interrupt)");
      await settle(30);
      now += QUIET_AWAIT_MS * 2;
      await settle(60);
      expect(s.state.state).toBe("working");
      s.dispose();
    });
  }

  for (const harness of ["claude-code", "codex", "opencode", "grok-build", "antigravity"] as const) {
    test(`${harness}, with hooks: what a hook said stands, however idle the screen looks (BUG-204)`, async () => {
      let now = 0;
      const { dir } = createEventsDir(TMP);
      const { s, pty } = session({ harness, now: () => now, tickMs: 10, events: dir });
      pty.print("\x1b[2J\x1b[H> ");
      await settle(30);
      // Each step changes the state, so `until` sees the hook read (a session starts out Working).
      for (const said of ["awaiting", "working", "done", "working"] as const) {
        writeEvent(dir, { name: "status", status: { state: said } });
        await until(() => s.state.state === said);
        now += QUIET_AWAIT_MS * 2;
        await settle(60);
        expect(s.state.state).toBe(said);
      }
      s.dispose();
    });
  }
});

describe.concurrent("lifecycle", () => {
  test("resize reaches the PTY and the model; end() is SIGTERM, then SIGKILL after the grace", async () => {
    const { s, pty } = session({ dieOnTerm: false });
    s.resize(80, 20);
    expect(pty.sizes).toEqual([[80, 20]]);
    expect([s.screen.cols, s.screen.rows]).toEqual([80, 20]);
    await s.end(50);
    expect(pty.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(s.code).toBe(137);
    // The last screen stays readable after the exit.
    expect(s.screen.cols).toBe(80);
  });
});

// Windows CI hung 28 minutes in the lifecycle test above: end() waits for the SIGKILL timer, and an
// unref'd timer there never fired on Windows. finish() clears it at the exit, so it stays referenced.
test("BUG-190/W: end()'s SIGKILL timer is kept referenced", () => {
  const src = readFileSync(join(import.meta.dir, "../src/pty/session.ts"), "utf8");
  expect(src).toContain('this.killTimer = setTimeout(() => this.proc.kill("SIGKILL"), grace);');
  expect(src).not.toMatch(/killTimer\.unref/);
});

describe("OpenCode's step records reach Gluon whole (issue #39)", () => {
  test("BUG-344/steps-not-coalesced: status events that carry `steps` are never merged into one another or into the state: a burst written in the same millisecond is delivered record by record, in order, each once", async () => {
    const { dir } = createEventsDir(TMP);
    const { s } = session({ events: dir });
    const got: number[] = [];
    s.onSteps((steps) => got.push(...steps.map((r) => r.n)));
    const states: (string | undefined)[] = [];
    s.onStatus((st) => states.push(st.state));
    const rec = (n: number) => ({ n, model: "fake/fake-1", input: n, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    // Two steps 22 ms apart lost the first when merged (the spike of issue #39): thirty at once, a state change between, then a batch with a state.
    for (let n = 1; n <= 30; n++) {
      writeEvent(dir, { name: "status", status: { steps: [rec(n)] } });
      if (n === 15) writeEvent(dir, { name: "status", status: { state: "working" } });
    }
    writeEvent(dir, { name: "status", status: { steps: [rec(31), rec(32), rec(33)], state: "done" } });
    await until(() => got.length === 33);
    expect(got).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
    expect(states.at(-1)).toBe("done");
    s.dispose();
  });
});

describe("the harness's figures reach Gluon once each (issue #39)", () => {
  test("BUG-399/figures-not-resent: the merged status keeps the last cost and context, but a later state or activity change delivers neither again; a changed figure, a compaction's null and the same tokens after it do", async () => {
    const { dir } = createEventsDir(TMP);
    const { s } = session({ events: dir });
    const figs: unknown[] = [];
    s.onFigures((f) => figs.push(f));
    const states: (string | undefined)[] = [];
    s.onStatus((st) => states.push(st.state));
    writeEvent(dir, { name: "status", status: { costUsd: 0.5, contextTokens: 1000, contextWindow: 200_000, model: "m" } });
    await until(() => figs.length === 1);
    // Later changes of state and activity carry the merged figures in the status, not as new samples.
    writeEvent(dir, { name: "status", status: { state: "done" } });
    await until(() => states.includes("done"));
    writeEvent(dir, { name: "status", status: { state: "working", activity: "Bash: ls" } });
    await until(() => states.filter((x) => x === "working").length >= 2);
    expect(figs).toEqual([{ costUsd: 0.5, contextTokens: 1000, contextWindow: 200_000, model: "m" }]);
    writeEvent(dir, { name: "status", status: { costUsd: 0.75 } });
    await until(() => figs.length === 2);
    expect(figs[1]).toEqual({ costUsd: 0.75, model: "m" });
    writeEvent(dir, { name: "status", status: { contextTokens: null } });
    await until(() => figs.length === 3);
    expect(figs[2]).toMatchObject({ contextTokens: null });
    writeEvent(dir, { name: "status", status: { contextTokens: 1000 } });
    await until(() => figs.length === 4);
    expect(figs[3]).toEqual({ contextTokens: 1000, contextWindow: 200_000, model: "m" });
    s.dispose();
  });
});

describe("OpenCode's step counter restarts (issue #39)", () => {
  const rec = (n: number) => ({ n, model: "fake/fake-1", input: n, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  test("BUG-402/step-counter-restart: a plugin reload or a second follower restarts `n` at 1: its records are new, not repeats of the first run's; an exact repeat is left out and counted", () => {
    const gate = stepGate();
    expect(gate([rec(1), rec(2), rec(3), rec(4), rec(5)]).fresh.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
    // Restarted: every later step used to be dropped for good (`n <= stepsSeen`).
    expect(gate([rec(1), rec(2)])).toMatchObject({ repeated: 0, fresh: [{ n: 1 }, { n: 2 }] });
    expect(gate([rec(3)]).fresh.map((r) => r.n)).toEqual([3]);
    // A record sent twice.
    expect(gate([rec(3), rec(4)])).toMatchObject({ repeated: 1, fresh: [{ n: 4 }] });
  });

  test("BUG-402/step-repeat-is-a-dropped-entry: the tracker records the repeats it was told of, with a reason and a count", () => {
    const ledger = new Ledger();
    new CostTracker({ harness: "opencode", conn: "openrouter", ledger }).stepsRepeated(2);
    expect(ledger.entries).toMatchObject([{ kind: "dropped", what: "usage", reason: "opencode-step-repeated", count: 2 }]);
  });
});
