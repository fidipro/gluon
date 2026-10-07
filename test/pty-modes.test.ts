import { describe, expect, test } from "bun:test";
import { HOME_MODES, MODES_RESET, type ModesState, modeTransition } from "../src/pty/modes.ts";
import { createScreen, type TermScreen } from "../src/pty/screen.ts";

const state = (over: Partial<ModesState>): ModesState => ({ ...HOME_MODES, ...over });

async function fed(...chunks: string[]): Promise<TermScreen> {
  const s = createScreen(20, 4);
  for (const c of chunks) await s.write(c);
  return s;
}

const kitty = async (s: TermScreen, seq: string) => {
  await s.write(seq);
  return s.modes().kittyFlags;
};

describe("modes: what a session set", () => {
  test("a fresh screen has the home modes", async () => {
    const s = await fed();
    expect(s.modes()).toEqual(HOME_MODES);
    s.dispose();
  });

  test("reads xterm's modes and the ones xterm doesn't expose", async () => {
    const s = await fed("\x1b[?1h\x1b=\x1b[?2004h\x1b[?1004h\x1b[?1002h\x1b[?1006h\x1b[>5u\x1b[4 q\x1b[?9001h");
    expect(s.modes()).toEqual(
      state({ cursorKeys: true, keypad: true, bracketedPaste: true, focus: true, mouseTracking: "drag", mouseEncoding: "sgr", kittyFlags: 5, cursorShape: 4, win32Input: true }),
    );
    s.dispose();
  });

  test("xterm still handles what the handlers watched", async () => {
    const s = await fed();
    const replies: string[] = [];
    s.onReply((r) => replies.push(r));
    await s.write("\x1b[?1006h\x1b[?25l\x1b[?1006$p\x1b[?25$p");
    expect(replies).toEqual(["\x1b[?1006;1$y", "\x1b[?25;2$y"]);
    expect(s.cursorVisible()).toBe(false);
    s.dispose();
  });

  test("mouse encoding: the last one set wins; turning off the active one goes back to the default", async () => {
    const s = await fed("\x1b[?1006h\x1b[?1015h");
    expect(s.modes().mouseEncoding).toBe("urxvt");
    await s.write("\x1b[?1006l");
    expect(s.modes().mouseEncoding).toBe("urxvt");
    await s.write("\x1b[?1015l");
    expect(s.modes().mouseEncoding).toBe("default");
    await s.write("\x1b[?1005h");
    expect(s.modes().mouseEncoding).toBe("utf8");
    s.dispose();
  });

  test("kitty flags: push, pop (past the bottom too), set, or, and-not", async () => {
    const s = await fed();
    expect(await kitty(s, "\x1b[>1u")).toBe(1);
    expect(await kitty(s, "\x1b[>3u")).toBe(3);
    expect(await kitty(s, "\x1b[>31u")).toBe(31);
    expect(await kitty(s, "\x1b[<u")).toBe(3);
    expect(await kitty(s, "\x1b[<1u")).toBe(1);
    expect(await kitty(s, "\x1b[<u")).toBe(0);
    expect(await kitty(s, "\x1b[<u")).toBe(0);
    expect(await kitty(s, "\x1b[>1u\x1b[>2u\x1b[>4u\x1b[<2u")).toBe(1);
    expect(await kitty(s, "\x1b[=8u")).toBe(8);
    expect(await kitty(s, "\x1b[=3;2u")).toBe(11);
    expect(await kitty(s, "\x1b[=9;3u")).toBe(2);
    expect(await kitty(s, "\x1b[=5;1u")).toBe(5);
    expect(await kitty(s, "\x1b[<u")).toBe(0);
    s.dispose();
  });

  test("kitty flags: one stack per screen, as kitty keeps", async () => {
    const s = await fed("\x1b[>1u");
    expect(await kitty(s, "\x1b[?1049h")).toBe(0);
    expect(await kitty(s, "\x1b[>7u")).toBe(7);
    expect(await kitty(s, "\x1b[?1049l")).toBe(1);
    expect(await kitty(s, "\x1b[?1049h")).toBe(7);
    s.dispose();
  });

  test("RIS resets every mode", async () => {
    const s = await fed("\x1b[?1h\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[>5u\x1b[2 q\x1b[?9001h\x1b[?25l");
    await s.write("\x1bc");
    expect(s.modes()).toEqual(HOME_MODES);
    expect(s.cursorVisible()).toBe(true);
    s.dispose();
  });
});

describe("modes: switching the real terminal between sessions", () => {
  const A = state({ cursorKeys: true, bracketedPaste: true, mouseTracking: "vt200", mouseEncoding: "sgr", kittyFlags: 1, cursorShape: 6 });
  const B = state({ keypad: true, focus: true, mouseTracking: "any", mouseEncoding: "urxvt", kittyFlags: 27, win32Input: true });
  const C = state({ bracketedPaste: true, mouseTracking: "x10", mouseEncoding: "utf8", cursorShape: 2 });
  const STATES = [HOME_MODES, A, B, C, state({ kittyFlags: 3 }), state({ mouseEncoding: "sgr-pixels" })];

  test("the bytes for each change", () => {
    expect(modeTransition(HOME_MODES, A)).toBe("\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[>1u\x1b[6 q");
    expect(modeTransition(A, HOME_MODES)).toBe("\x1b[?1l\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[<u\x1b[0 q");
    expect(modeTransition(A, B)).toBe("\x1b[?1l\x1b=\x1b[?2004l\x1b[?1004h\x1b[?1000l\x1b[?1003h\x1b[?1006l\x1b[?1015h\x1b[=27;1u\x1b[0 q\x1b[?9001h");
    for (const s of STATES) expect(modeTransition(s, s)).toBe("");
    // ?2026 is the session's own business, never switched.
    expect(modeTransition(HOME_MODES, state({ syncOutput: true }))).toBe("");
  });

  test("a terminal in one session's modes, sent a transition, is in the other's", async () => {
    for (const from of STATES)
      for (const to of STATES) {
        const t = await fed(modeTransition(HOME_MODES, from));
        expect(t.modes()).toEqual(from);
        await t.write(modeTransition(from, to));
        expect({ from, to, got: t.modes() }).toEqual({ from, to, got: to });
        t.dispose();
      }
  });

  test("MODES_RESET brings any of them home and shows the cursor", async () => {
    for (const s of STATES) {
      const t = await fed(modeTransition(HOME_MODES, s), "\x1b[?25l");
      await t.write(MODES_RESET);
      expect(t.modes()).toEqual(HOME_MODES);
      expect(t.cursorVisible()).toBe(true);
      t.dispose();
    }
  });
});
