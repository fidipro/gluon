import { describe, expect, test } from "bun:test";
import type { Harness } from "../src/harnesses.ts";
import { createInterceptor, lineAfter, TOUCHED } from "../src/pty/intercept.ts";
import { createKeyDecoder, erases } from "../src/pty/keys.ts";
import { READERS } from "../src/pty/readers/index.ts";
import { createScreen } from "../src/pty/screen.ts";
import type { Interceptor, Key, Screen } from "../src/pty/types.ts";
import { fixture, screenOf, state } from "./fixtures/screens.ts";

const NAMED: Record<string, Key> = {
  tab: { name: "tab", raw: "\t" },
  up: { name: "up", raw: "\x1b[A" },
  down: { name: "down", raw: "\x1b[B" },
  left: { name: "left", raw: "\x1b[D" },
  backspace: { name: "backspace", raw: "\x7f" },
  esc: { name: "escape", raw: "\x1b" },
  enter: { name: "enter", raw: "\r" },
  ctrlc: { name: "other", raw: "\x03" },
  ctrlc_kitty: { name: "other", raw: "\x1b[99;5u" },
};
/** Fixture key names → keys; anything else is one typed character. */
const keysOf = (names: string[]): Key[] => names.map((n) => NAMED[n] ?? { name: "text", raw: n, text: n });
const pasted = (s: string): Key[] => [...s].map((c) => ({ name: "text", raw: c, text: c, pasted: true }));

const ON = { clear: true, compact: true };

/** Feeds the keys (screen as at Enter), then Enter; returns what Enter would be held for. */
function enter(i: Interceptor, keys: Key[], screen: Screen) {
  for (const k of keys) expect(i.key(k, screen)).toBeNull();
  return i.key(NAMED.enter!, screen);
}

async function onFixture(harness: Harness, name: string, opts = ON) {
  const f = fixture(harness);
  const s = state(f, name);
  const screen = await screenOf(f, s);
  const out = enter(createInterceptor({ harness, ...opts }), keysOf(s.keys), screen);
  screen.dispose();
  return out;
}

describe("interceptor on captured screens", () => {
  const cases: [string, Harness[], "clear" | "compact" | null][] = [
    ["clear", ["claude-code", "codex", "opencode", "antigravity"], "clear"], // exact
    ["new", ["claude-code", "codex", "opencode", "antigravity"], "clear"],
    ["cl", ["claude-code", "codex", "opencode", "antigravity"], "clear"], // prefix, Enter on the menu
    ["cl-tab", ["claude-code", "codex", "antigravity"], "clear"], // prefix + Tab
    ["clear-edited", ["claude-code", "codex", "opencode", "antigravity"], "clear"], // edits
    ["c-down2", ["claude-code"], "clear"], // arrows in the menu
    ["c-down3", ["codex"], "clear"],
    ["c-down1", ["opencode", "antigravity"], "clear"],
    ["c", ["codex"], "compact"], // the first item of the menu
    ["c", ["claude-code", "opencode"], null], // /cd highlighted
    ["c", ["antigravity"], null], // /changelog
    ["c-down1", ["claude-code", "codex"], null], // /copy
    ["c-down2", ["antigravity"], null], // /codesearch
    ["c-down3", ["antigravity"], null], // /config, the menu scrolled
    ["c-up1", ["antigravity"], null], // /codesearch
    ["comp", ["claude-code", "codex"], "compact"],
    ["compact", ["claude-code", "codex"], "compact"],
    ["compact", ["opencode"], null], // Enter would run the highlighted /review
    ["compact-args", ["claude-code", "codex", "opencode"], "compact"], // `/compact <instructions>`
    // Antigravity has no /compact ("No matches"): nothing to hold, however it's typed.
    ["comp", ["antigravity"], null],
    ["compact", ["antigravity"], null],
    ["compact-args", ["antigravity"], null],
    ["compact-long", ["antigravity"], null],
    ["cle-esc", ["antigravity"], null], // Esc closed the menu, "/cle" is no command
    ["help", ["claude-code", "codex", "opencode", "antigravity"], null], // other commands go on
    ["slash", ["claude-code", "codex", "opencode", "antigravity"], null],
    ["hello", ["claude-code", "codex", "opencode", "antigravity"], null],
    ["cl-tab", ["opencode"], null], // Tab already ran /clear (see the Tab case below)
    // BUG-191: Codex inside Gluon's frame, after a turn, during one, unshaded.
    ...(["frame-turn-clear", "frame-turn-cl-tab", "frame-turn-c-down3", "frame-turn-new", "frame-working-clear", "frame-plain-clear", "frame-plain-cl-tab"] as const).map(
      (n): [string, Harness[], "clear"] => [n, ["codex"], "clear"],
    ),
    ["frame-turn-idle", ["codex"], null],
  ];
  for (const [name, harnesses, want] of cases)
    for (const h of harnesses) test(`${name.startsWith("frame-") ? "BUG-191: " : ""}${h} ${name} → ${want}`, async () => expect(await onFixture(h, name)).toBe(want));

  test("settings off: nothing is held for that setting", async () => {
    expect(await onFixture("claude-code", "clear", { clear: false, compact: true })).toBeNull();
    expect(await onFixture("claude-code", "compact", { clear: true, compact: false })).toBeNull();
    expect(await onFixture("codex", "compact", { clear: false, compact: true })).toBe("compact");
    expect(await onFixture("codex", "cl", { clear: false, compact: false })).toBeNull();
  });

  test("OpenCode: Tab on the menu runs the item, so that Tab is held", async () => {
    const f = fixture("opencode");
    const screen = await screenOf(f, "cl");
    const i = createInterceptor({ harness: "opencode", ...ON });
    for (const k of keysOf(["/", "c", "l"])) expect(i.key(k, screen)).toBeNull();
    expect(i.key(NAMED.tab!, screen)).toBe("clear");
    // Tab on another item, or in another harness, is just a key.
    const other = await screenOf(f, "c");
    const j = createInterceptor({ harness: "opencode", ...ON });
    for (const k of keysOf(["/", "c", "tab"])) expect(j.key(k, other)).toBeNull();
    const cc = await screenOf(fixture("claude-code"), "cl");
    const k2 = createInterceptor({ harness: "claude-code", ...ON });
    for (const k of keysOf(["/", "c", "l", "tab"])) expect(k2.key(k, cc)).toBeNull();
  });

  test("Antigravity: Tab completes the item (it doesn't run it), so only the Enter after it is held", async () => {
    const f = fixture("antigravity");
    const i = createInterceptor({ harness: "antigravity", ...ON });
    for (const k of keysOf(["/", "c", "l", "tab"])) expect(i.key(k, await screenOf(f, "cl"))).toBeNull();
    expect(i.key(NAMED.enter!, await screenOf(f, "cl-tab"))).toBe("clear");
  });

  test("Antigravity: /compact is never held, even with the compact setting alone on", async () => {
    for (const name of ["compact", "compact-args", "compact-long"])
      expect(await onFixture("antigravity", name, { clear: false, compact: true })).toBeNull();
    expect(await onFixture("antigravity", "clear", { clear: false, compact: true })).toBeNull();
  });

  test("a pasted /clear is never held, wherever the paste is", async () => {
    const screen = await screenOf(fixture("claude-code"), "clear");
    expect(enter(createInterceptor({ harness: "claude-code", ...ON }), pasted("/clear"), screen)).toBeNull();
    expect(enter(createInterceptor({ harness: "claude-code", ...ON }), [...keysOf(["/", "c", "l"]), ...pasted("ear")], screen)).toBeNull();
    expect(enter(createInterceptor({ harness: "claude-code", ...ON }), [...pasted(" "), ...keysOf(["backspace", ..."/clear"])], screen)).toBeNull();
    // A newline inside a paste is not an Enter.
    const i = createInterceptor({ harness: "claude-code", ...ON });
    for (const k of keysOf([..."/clear"])) i.key(k, screen);
    expect(i.key({ name: "enter", raw: "\r", pasted: true }, screen)).toBeNull();
  });

  test("a menu drawn by the agent's output without a typed / is never held", async () => {
    for (const h of ["claude-code", "codex", "opencode", "antigravity"] as const) {
      const screen = await screenOf(fixture(h), "clear");
      expect(enter(createInterceptor({ harness: h, ...ON }), [], screen)).toBeNull();
      expect(enter(createInterceptor({ harness: h, ...ON }), keysOf(["x"]), screen)).toBeNull();
      expect(enter(createInterceptor({ harness: h, ...ON }), keysOf(["up"]), screen)).toBeNull(); // history recall
    }
  });

  test("Ctrl+C and the return key reset the line", async () => {
    const screen = await screenOf(fixture("claude-code"), "clear");
    for (const k of ["ctrlc", "ctrlc_kitty"]) {
      const i = createInterceptor({ harness: "claude-code", ...ON });
      expect(enter(i, keysOf(["/", "c", "l", "e", "a", "r", k]), screen)).toBeNull();
    }
    const i = createInterceptor({ harness: "claude-code", ...ON });
    expect(enter(i, [...keysOf([..."/clear"]), { name: "return-key", raw: "\x1d" }], screen)).toBeNull();
  });

  test("BUG-147: Esc that closes the slash menu keeps the typed / line", async () => {
    // After Esc the menu is gone and the typed line stays: the screen of `/cl` + Tab shows that.
    for (const h of ["claude-code", "codex", "antigravity"] as const) {
      const f = fixture(h);
      const kept = await screenOf(f, "cl-tab");
      expect(enter(createInterceptor({ harness: h, ...ON }), keysOf([..."/clear", "esc"]), kept)).toBe("clear");
      // Esc that cleared the line: what's left on the screen is what runs.
      const idle = await screenOf(f, "idle");
      expect(enter(createInterceptor({ harness: h, ...ON }), keysOf([..."/clear", "esc"]), idle)).toBeNull();
      // A line that didn't start with a typed / starts over at Esc.
      const clear = await screenOf(f, "clear");
      expect(enter(createInterceptor({ harness: h, ...ON }), keysOf([..."hello", "esc", ..."/clear"]), clear)).toBe("clear");
      // A paste stays a paste.
      expect(enter(createInterceptor({ harness: h, ...ON }), [...keysOf(["/"]), ...pasted("clear"), ...keysOf(["esc"])], kept)).toBeNull();
    }
    // A screen it can't read: after Esc the typed line is no longer known for sure.
    expect(enter(createInterceptor({ harness: "claude-code", ...ON }), keysOf([..."/clear", "esc"]), createScreen(80, 24))).toBeNull();
  });

  test("BUG-150: /clear and Enter in one chunk still asks: a screen behind the keys falls back to the typed line", async () => {
    for (const h of ["claude-code", "codex", "opencode", "antigravity"] as const) {
      const f = fixture(h);
      // Nothing echoed yet, or only part of it (a menu then highlights something else).
      for (const name of ["idle", "slash", "c", "cl"]) {
        const screen = await screenOf(f, name);
        expect(enter(createInterceptor({ harness: h, ...ON }), keysOf([..."/clear"]), screen)).toBe("clear");
        // Only a line typed key by key with no edits that is exactly a command (else the screen,
        // as it is, decides: on `/c` and `/cl` its highlighted item).
        if (name === "c" || name === "cl") continue;
        expect(enter(createInterceptor({ harness: h, ...ON }), keysOf([..."/clearx", "backspace"]), screen)).toBeNull();
        expect(enter(createInterceptor({ harness: h, ...ON }), keysOf([..."/clear now"]), screen)).toBeNull();
        expect(enter(createInterceptor({ harness: h, ...ON }), keysOf([..."/help"]), screen)).toBeNull();
      }
      // A screen showing something else than the start of the typed line: the screen decides.
      expect(enter(createInterceptor({ harness: h, ...ON }), keysOf([..."/clear"]), await screenOf(f, "hello"))).toBeNull();
    }
  });

  test("BUG-205/live: a line erased by the user's keys, then a typed /clear, asks; the screen says what is left", async () => {
    const ctrlU: Key = { name: "other", raw: "\x15" };
    const end: Key = { name: "other", raw: "\x1b[F" };
    for (const h of ["claude-code", "codex", "opencode", "antigravity"] as const) {
      const f = fixture(h);
      const clear = await screenOf(f, "clear");
      const hello = await screenOf(f, "hello");
      const i = () => createInterceptor({ harness: h, ...ON });
      // `abc`, Backspace ×3, `/clear`.
      expect(enter(i(), keysOf([..."abc", "backspace", "backspace", "backspace", ..."/clear"]), clear)).toBe("clear");
      // `hello`, ← ←, Ctrl+U, End, Ctrl+U, `/clear`.
      expect(enter(i(), [...keysOf([..."hello", "left", "left"]), ctrlU, end, ctrlU, ...keysOf([..."/clear"])], clear)).toBe("clear");
      // What the erasing left is on screen, and it isn't a command: no.
      expect(enter(i(), keysOf([..."abc", "backspace", ..."/clear"]), hello)).toBeNull();
      // The first printable after the erasing isn't a typed /: never.
      expect(enter(i(), keysOf([..."fix", "backspace", ..."x /clear"]), clear)).toBeNull();
      // A paste in the line still never counts.
      expect(enter(i(), [...pasted("abc"), ...keysOf(["backspace", "backspace", "backspace", ..."/clear"])], clear)).toBeNull();
    }
    // A screen it can't read: what the keys erased isn't known, so no.
    expect(enter(createInterceptor({ harness: "claude-code", ...ON }), keysOf([..."abc", "backspace", "backspace", "backspace", ..."/clear"]), createScreen(80, 24))).toBeNull();
  });

  test("BUG-205/keys: erases() knows Backspace, Delete, Ctrl+U/W/K/H, Alt+Backspace in every encoding, not a release", () => {
    const k = (raw: string, name: Key["name"] = "other"): Key => ({ name, raw });
    for (const raw of ["\x15", "\x17", "\x0b", "\x1b\x7f", "\x1b\x08", "\x1b[3~", "\x1b[3;5~", "\x1b[117;5u", "\x1b[119;5u", "\x1b[127;3u", "\x1b[85;22;21;1;8;1_", "\x1b[46;83;0;1;0;1_"]) expect(erases(k(raw))).toBe(true);
    expect(erases(k("\x7f", "backspace"))).toBe(true);
    for (const raw of ["\x03", "\x1b[D", "\x1b[117;5:3u", "\x1b[3;1:3~", "\x1b[85;22;21;0;8;1_", "\x1b[117u", "\x1bu"]) expect(erases(k(raw))).toBe(false);
    expect(erases({ name: "text", raw: "u", text: "u" })).toBe(false);
    // The legacy bytes decode as keys `erases` knows.
    const d = createKeyDecoder("ctrl+\\");
    expect([...d.feed("\x15\x17\x1b[3~\x7f"), ...d.flush()].map(erases)).toEqual([true, true, true, true]);
  });

  test("state starts over after every Enter", async () => {
    const f = fixture("codex");
    const i = createInterceptor({ harness: "codex", ...ON });
    const hello = await screenOf(f, "hello");
    const clear = await screenOf(f, "clear");
    expect(enter(i, keysOf([..."hello world"]), hello)).toBeNull();
    expect(enter(i, keysOf([..."/clear"]), clear)).toBe("clear");
    expect(enter(i, [], clear)).toBeNull(); // a second Enter without typing
  });
});

describe("interceptor without a readable screen", () => {
  const blank = () => createScreen(80, 24);
  test("a bare command typed key by key counts", () => {
    expect(enter(createInterceptor({ harness: "claude-code", ...ON }), keysOf([..."/clear"]), blank())).toBe("clear");
    expect(enter(createInterceptor({ harness: "codex", ...ON }), keysOf([..."/compact"]), blank())).toBe("compact");
    expect(enter(createInterceptor({ harness: "claude-code", ...ON }), keysOf([..."/reset"]), blank())).toBe("clear");
  });
  test("anything else doesn't: Tab, arrows, edits, arguments, prefixes, other commands", () => {
    for (const keys of [
      ["/", "c", "l", "tab"],
      ["/", "c", "down"],
      ["/", "c", "l", "e", "a", "x", "backspace", "r"],
      ["/", "c", "l", "e", "a", "r", "left"],
      [..."/compact now"],
      [..."/cl"],
      [..."/help"],
      [..."/cost"],
      [..."clear"],
    ])
      expect(enter(createInterceptor({ harness: "claude-code", ...ON }), keysOf(keys), blank())).toBeNull();
  });
  test("Grok Build's reader reads its composer box (not the cursor); with its menu open, Enter runs the highlighted item", async () => {
    const s = createScreen(40, 8);
    const box = (input: string) => `\x1b[2J\x1b[1;1H╭${"─".repeat(36)}╮\r\n│ ❯ ${input.padEnd(33)}│\r\n╰${"─".repeat(14)} Grok 4.7 (low) ─╯`;
    await s.write(`${box("/clear")}\x1b[8;1H`);
    expect(enter(createInterceptor({ harness: "grok-build", ...ON }), keysOf([..."/clear"]), s)).toBe("clear");
    await s.write(box("/clearx"));
    expect(enter(createInterceptor({ harness: "grok-build", ...ON }), keysOf([..."/clearx"]), s)).toBeNull();
    const rule = "─".repeat(36);
    await s.write(`\x1b[2J\x1b[1;1H  ${rule}\r\n    ❯ /clear  new\r\n      /compact  compact\r\n  ${rule}\r\n  ╭${"─".repeat(30)}╮\r\n  │ ❯ ${"/c".padEnd(27)}│\r\n  ╰${"─".repeat(8)} Grok 4.7 (low) ─╯`);
    // `/c`, the panel above the box highlights `/clear`: Enter runs it.
    expect(enter(createInterceptor({ harness: "grok-build", ...ON }), keysOf(["/", "c"]), s)).toBe("clear");
  });
});

describe("NO_COLOR screens", () => {
  /** The SGR sequences of `ansi` without their colours (what an agent draws under NO_COLOR). */
  const noColor = (ansi: string) =>
    ansi.replace(/\x1b\[([\d;]*)m/g, (_, p: string) => {
      const ps = p.split(";");
      const keep: string[] = [];
      for (let i = 0; i < ps.length; i++) {
        const n = Number(ps[i]);
        if (n === 38 || n === 48) i += ps[i + 1] === "5" ? 2 : 4;
        else if (!((n >= 30 && n <= 37) || n === 39 || (n >= 40 && n <= 47) || n === 49 || (n >= 90 && n <= 97) || (n >= 100 && n <= 107))) keep.push(ps[i]!);
      }
      return keep.length ? `\x1b[${keep.join(";")}m` : "";
    });

  test("never trigger a wrong command: without the highlight colours it's the same answer or none", async () => {
    for (const h of ["claude-code", "codex", "opencode", "antigravity"] as const) {
      const f = fixture(h);
      for (const s of f.states) {
        const coloured = await screenOf(f, s);
        const plain = await screenOf(f, { ...s, ansi: noColor(s.ansi) });
        const want = enter(createInterceptor({ harness: h, ...ON }), keysOf(s.keys), coloured);
        const got = enter(createInterceptor({ harness: h, ...ON }), keysOf(s.keys), plain);
        if (got !== null) expect(`${h} ${s.name}: ${got}`).toBe(`${h} ${s.name}: ${want}`);
        const sel = READERS[h].selectedCommand(plain);
        // "" (or null): a highlight it can't read.
        if (sel) expect(`${h} ${s.name}: ${sel}`).toBe(`${h} ${s.name}: ${READERS[h].selectedCommand(coloured)}`);
      }
    }
    // Claude Code 2.1.296 marks the highlighted item `❯`: its menu reads the same without colours (BUG-718).
    const cc = fixture("claude-code");
    const cl = await screenOf(cc, { ...state(cc, "cl"), ansi: noColor(state(cc, "cl").ansi) });
    expect(READERS["claude-code"].selectedCommand(cl)).toBe("/clear");
    // 2.1.286's menu, the highlight in colour only, can't be read without its colours: unsure, so nothing is held for `/cl`.
    const old = createScreen(60, 6);
    await old.write(`  /clear     Start a new session\r\n  /claude-api  The API\r\n${"─".repeat(40)}\r\n❯ /cl\r\n${"─".repeat(40)}\x1b[4;6H`);
    expect(READERS["claude-code"].selectedCommand(old)).toBeNull();
    old.dispose();
    // OpenCode outside a session: Enter on "/compact" runs the fuzzy "/review"; without the colours, nothing is held.
    const oc = fixture("opencode");
    const compact = await screenOf(oc, { ...state(oc, "compact"), ansi: noColor(state(oc, "compact").ansi) });
    expect(READERS.opencode.selectedCommand(compact)).toBe("");
    expect(enter(createInterceptor({ harness: "opencode", ...ON }), keysOf([..."/compact"]), compact)).toBeNull();
  });
});

describe("BUG-148: a /compact with long instructions that wraps still asks", () => {
  const LONG = "/compact keep the parser tests and the migration notes";
  /** Claude Code draws long input on several rows itself (continuation rows indented two cells). */
  async function claudeWrapped() {
    const s = createScreen(44, 8);
    const border = "─".repeat(43);
    await s.write(`\x1b[3;1H${border}\r\n❯ /compact keep the parser tests and the\r\n  migration notes\r\n${border}\x1b[5;18H`);
    return s;
  }
  /** Codex: the composer on a shaded background, continuation rows indented two cells. */
  async function codexWrapped() {
    const s = createScreen(44, 8);
    await s.write(`\x1b[3;1H\x1b[48;5;236m› /compact keep the parser tests and the\x1b[K\r\n  migration notes\x1b[K\x1b[0m\x1b[4;18H`);
    return s;
  }
  const newlines: Key[] = [
    { name: "other", raw: "\x1b[13;2u" }, // Shift+Enter, kitty
    { name: "other", raw: "\x1b\r" }, // Alt+Enter
    { name: "other", raw: "\n" }, // Ctrl+J
    { name: "other", raw: "\x1b[27;2;13~" }, // Shift+Enter, modifyOtherKeys
    { name: "other", raw: "\x1b[13;28;13;1;16;1_" }, // Shift+Enter, win32-input-mode
  ];

  test("rows the agent wrapped are one line: typed key by key, it asks", async () => {
    for (const [h, screen] of [
      ["claude-code", await claudeWrapped()],
      ["codex", await codexWrapped()],
    ] as const) {
      expect(READERS[h].inputLine(screen)).toBe("/compact keep the parser tests and the\nmigration notes");
      expect(enter(createInterceptor({ harness: h, ...ON }), keysOf([...LONG]), screen)).toBe("compact");
    }
  });

  test("a real multi-line input never counts: a key put the newline there, or history brought it back", async () => {
    for (const [h, screen] of [
      ["claude-code", await claudeWrapped()],
      ["codex", await codexWrapped()],
    ] as const) {
      for (const nl of newlines) {
        const keys = [...keysOf([..."/compact keep the parser tests and the"]), nl, ...keysOf([..."migration notes"])];
        expect(enter(createInterceptor({ harness: h, ...ON }), keys, screen)).toBeNull();
      }
      expect(enter(createInterceptor({ harness: h, ...ON }), keysOf(["/", "up"]), screen)).toBeNull();
    }
    // A line ending in a backslash: Enter adds a newline there.
    const s = createScreen(44, 8);
    await s.write(`\x1b[3;1H${"─".repeat(43)}\r\n❯ /compact x\\\r\n${"─".repeat(43)}\x1b[4;14H`);
    expect(enter(createInterceptor({ harness: "claude-code", ...ON }), keysOf([..."/compact x\\"]), s)).toBeNull();
  });

  test("a line wrapped over rows reads as one line: the terminal's soft wrap (Claude Code), Grok's box rows", async () => {
    // Claude Code's box with its input wrapped by the terminal: no indent on the wrapped row.
    const c = createScreen(30, 8);
    await c.write(`\x1b[2;1H${"─".repeat(29)}\r\n❯ ${LONG}\r\n${"─".repeat(29)}\x1b[4;27H`);
    expect(c.line(3).wrapped).toBe(true);
    expect(READERS["claude-code"].inputLine(c)).toBe(LONG);
    // Grok's composer wraps the words itself, onto rows of the box: one line to the interceptor.
    const s = createScreen(34, 7);
    const rows = ["/compact keep the parser", "tests and the migration", "notes"];
    await s.write(`\x1b[2;1H╭${"─".repeat(30)}╮\r\n${rows.map((r, i) => `│ ${i ? " " : "❯"} ${r.padEnd(27)}│`).join("\r\n")}\r\n╰${"─".repeat(10)} Grok 4.7 (low) ─╯`);
    expect(READERS["grok-build"].inputLine(s)).toBe(rows.join("\n"));
    expect(enter(createInterceptor({ harness: "grok-build", ...ON }), keysOf([...LONG]), s)).toBe("compact");
  });
});

describe("the typed line, untouched since the last Enter (lineAfter)", () => {
  const decoded = (s: string) => {
    const d = createKeyDecoder("ctrl+\\");
    return [...d.feed(s), ...d.flush()];
  };
  const line = (s: string, from = 0) => decoded(s).reduce((n, k) => lineAfter(k, n), from);
  /** Untouched after `s`, from an untouched line (`from` true) or one another key touched. */
  const after = (s: string, from = true) => line(s, from ? 0 : TOUCHED) === 0;

  test("BUG-195/line: Enter empties it; any other key touches it until the next Enter; a key-up changes nothing", () => {
    expect(after("")).toBe(true);
    expect(after("\r", false)).toBe(true);
    for (const s of ["a", "\x1b[A", "\x1b[D", "\x1b[200~x\x1b[201~", "\n", "\x1b[13;2u"]) expect(after(s)).toBe(false);
    expect(after("ab\r")).toBe(true);
    // A paste with a newline in it is no Enter.
    expect(after("\x1b[200~x\r\x1b[201~")).toBe(false);
    // Kitty Enter and its release; win32 Enter, its key-up, a dropped key-up; a win32 key-up alone.
    expect(after("x\x1b[13u\x1b[13;1:3u")).toBe(true);
    expect(after("x\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_\x1b[37;75;0;0;256;1_")).toBe(true);
    expect(after("\x1b[65;30;97;0;0;1_", false)).toBe(false);
  });

  test("BUG-268/GLUON-50: printables and as many Backspaces leave the line untouched; any other key keeps it touched until Enter", () => {
    // `BBB` and three Backspaces: untouched again (legacy DEL, Ctrl+H, kitty Backspace, win32).
    expect(after("BBB\x7f\x7f\x7f")).toBe(true);
    expect(after("BBB\x7f\x7f")).toBe(false);
    expect(line("BBB\x7f\x7f")).toBe(1);
    expect(after("ab\x08\x1b[127u")).toBe(true);
    expect(after("\x1b[66;48;66;1;16;1_\x1b[66;48;66;0;16;1_\x1b[8;14;8;1;0;1_\x1b[8;14;8;0;0;1_")).toBe(true);
    // Never below 0: Backspaces on an empty line don't bank against what comes next.
    expect(after("\x7f\x7f")).toBe(true);
    expect(after("\x7f\x7fa")).toBe(false);
    // A character is its code points; a win32 key its repeat count (the agent inserts it that many times).
    expect(line("é你")).toBe(2);
    expect(line("\x1b[65;30;97;1;0;3_")).toBe(3);
    // Any other key (Tab, an arrow, Delete, Ctrl+U, Ctrl+W, Alt+Backspace, Ctrl+Backspace in kitty, a paste) touches it for good.
    for (const k of ["\t", "\x1b[D", "\x1b[3~", "\x15", "\x17", "\x1b\x7f", "\x1b[127;5u", "\x1b[200~x\x1b[201~"]) {
      expect(line(`a${k}`)).toBe(TOUCHED);
      expect(after(`a${k}\x7f\x7f\x7f`)).toBe(false);
      expect(after(`a${k}\r`)).toBe(true);
    }
    // Esc and Ctrl+C on a typed line (a menu, a line kept or recalled): touched until Enter.
    expect(after("a\x1b[27u\x7f")).toBe(false);
    expect(after("a\x03\x7f")).toBe(false);
    // A key-up changes nothing.
    expect(line("a\x1b[97;1:3u")).toBe(1);
  });

  test("BUG-209/line: a win32 modifier alone (Ctrl down before Ctrl+\\, Shift) leaves the line as it was", () => {
    expect(after("\x1b[17;29;0;1;8;1_")).toBe(true);
    expect(after("\x1b[16;42;0;1;16;1_\x1b[16;42;0;0;0;1_")).toBe(true);
    expect(after("\x1b[17;29;0;1;8;1_", false)).toBe(false);
    // Ctrl+U is a key: it touches the line.
    expect(after("\x1b[85;22;21;1;8;1_")).toBe(false);
  });

  test("BUG-211/line: Esc and Ctrl+C (interrupting the agent) leave an untouched line untouched, and a touched one touched — legacy, kitty, win32", () => {
    const escs = ["\x1b", "\x1b[27u", "\x1b[27;1:1u", "\x1b[27;1;27;1;0;1_"];
    const ctrlCs = ["\x03", "\x1b[99;5u", "\x1b[99;69u", "\x1b[67;46;3;1;8;1_"];
    for (const s of [...escs, ...ctrlCs]) {
      expect(after(s)).toBe(true);
      expect(after(s, false)).toBe(false);
      expect(after(`x${s}`)).toBe(false);
    }
    // Alt+C (kitty) is a key like any other: it touches the line.
    expect(after("\x1b[99;3u")).toBe(false);
  });
});

describe("keys and screens stay in memory", () => {
  test("the PTY screen, modes, painter, readers and interceptor import no file, network or process API", async () => {
    const { Glob } = await import("bun");
    const files = [...new Glob("src/pty/{screen,modes,paint,intercept}.ts").scanSync({ cwd: import.meta.dir + "/.." }), ...new Glob("src/pty/readers/*.ts").scanSync({ cwd: import.meta.dir + "/.." })];
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      const src = await Bun.file(`${import.meta.dir}/../${f}`).text();
      const imports = [...src.matchAll(/(?:import|from)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const m of imports) expect(`${f}: ${m}`).toMatch(/: (\.{1,2}\/|@xterm\/(headless|addon-unicode11)$)/);
      expect(src).not.toMatch(/\b(Bun\.(write|file|spawn|connect|listen|serve)|console\.|fetch\(|process\.(stdout|stderr)|require\()/);
    }
  });
});
