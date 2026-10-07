/** The PTY's key decoder (`src/pty/keys.ts`): byte fixtures for every encoding a terminal sends. */
import { describe, expect, test } from "bun:test";
import { asVt, createKeyDecoder, CSI_TIMEOUT_MS, encodeMouse, ESC_TIMEOUT_MS, forInk, isModifierOnly, PASTE_IDLE_MS, PASTE_KEY_GAP_MS, PASTE_MAX_MS, returnKeyByte, RETURN_KEYS, unbracketed } from "../src/pty/keys.ts";
import type { Key, MouseEncoding, MouseReport } from "../src/pty/types.ts";

/** The keys `chunks` decode to, flushed at the end. `returnKey`: `handoff.key` (the default, ctrl+\). */
function decode(chunks: string | string[], returnKey = "ctrl+\\") {
  const d = createKeyDecoder(returnKey);
  const keys: Key[] = [];
  for (const c of typeof chunks === "string" ? [chunks] : chunks) keys.push(...d.feed(c));
  keys.push(...d.flush());
  return keys;
}
const label = (k: Key) => (k.name === "text" ? `text:${k.text}${k.pasted ? ":pasted" : ""}` : k.name);
/** Adjacent pieces of one paste as one (a paste split across chunks comes in pieces). */
function pastesJoined(keys: Key[]): Key[] {
  const out: Key[] = [];
  for (const k of keys) {
    const last = out.at(-1);
    if (k.pasted && last?.pasted) out[out.length - 1] = { ...last, raw: last.raw + k.raw, text: (last.text ?? "") + (k.text ?? "") };
    else out.push(k);
  }
  return out;
}
const names = (chunks: string | string[], rk?: string) => pastesJoined(decode(chunks, rk)).map(label);
/** Every byte comes out again, in order (except a dropped key-up of a consumed key). */
const raws = (chunks: string | string[], rk?: string) => decode(chunks, rk).map((k) => k.raw).join("");
/** `bytes` split in two at every boundary decodes to the same keys as in one piece, every byte in order. */
function everySplit(bytes: string, expected: string[], rk?: string) {
  expect(names(bytes, rk)).toEqual(expected);
  for (let i = 1; i < bytes.length; i++) {
    const parts = [bytes.slice(0, i), bytes.slice(i)];
    expect(names(parts, rk)).toEqual(expected);
    expect(raws(parts, rk)).toBe(bytes);
  }
}
/** win32-input-mode as CI's conhost sent it from a plain-VT terminal: each character a key-down with no virtual key. */
const chars = (s: string) => [...s].map((c) => `\x1b[0;0;${c.charCodeAt(0)};1;0;1_`).join("");

describe("plain bytes", () => {
  test("printables, UTF-8 (one key per code point), Enter, Backspace, Tab", () => {
    expect(names("a/é😀")).toEqual(["text:a", "text:/", "text:é", "text:😀"]);
    expect(names("\r\x7f\b\t")).toEqual(["enter", "backspace", "backspace", "tab"]);
    expect(names("\n\x03\x00\x1a")).toEqual(["other", "other", "other", "other"]);
  });

  test("a lone ESC is Escape (after the caller's flush); ESC ESC is Escape then what follows", () => {
    const d = createKeyDecoder("ctrl+\\");
    expect(d.feed("\x1b")).toEqual([]);
    expect(d.flush()).toEqual([{ name: "escape", raw: "\x1b" }]);
    expect(names("\x1b\x1b")).toEqual(["escape", "escape"]);
    expect(names("\x1b\x1b[A")).toEqual(["escape", "up"]);
    expect(names("\x1b\x1bx")).toEqual(["escape", "other"]);
  });

  test("Alt + a key is ESC + its bytes: other", () => {
    expect(decode("\x1bx")).toEqual([{ name: "other", raw: "\x1bx" }]);
    expect(decode("\x1b\x1c")).toEqual([{ name: "other", raw: "\x1b\x1c" }]);
  });

  test("BUG-260/GLUON-42: ESC in one read and a key in a later one (before the flush) is still Alt+key as bytes, but carries the Esc key and that key apart; in one read it doesn't", () => {
    expect(decode(["\x1b", "x"])).toEqual([{ name: "other", raw: "\x1bx", apart: [{ name: "escape", raw: "\x1b" }, { name: "text", raw: "x", text: "x" }] }]);
    expect(decode(["\x1b", "\r"])).toEqual([{ name: "other", raw: "\x1b\r", apart: [{ name: "escape", raw: "\x1b" }, { name: "enter", raw: "\r" }] }]);
    expect(decode(["\x1b", "😀b"])).toEqual([{ name: "other", raw: "\x1b😀", apart: [{ name: "escape", raw: "\x1b" }, { name: "text", raw: "😀", text: "😀" }] }, { name: "text", raw: "b", text: "b" }]);
    // One read: Alt+key. A sequence completed in a later read is that sequence; ESC ESC is Escape twice.
    expect(decode("\x1bx")[0]!.apart).toBeUndefined();
    expect(decode(["a\x1bx"]).map((k) => k.apart)).toEqual([undefined, undefined]);
    expect(names(["\x1b", "[A"])).toEqual(["up"]);
    expect(names(["\x1b", "\x1bx"])).toEqual(["escape", "other"]);
    expect(decode(["\x1b", "\x1bx"])[1]!.apart).toBeUndefined();
    // A paste's ESC left at the end of a read is the paste's.
    expect(decode(["\x1b[200~a\x1b", "[201~"]).some((k) => k.apart)).toBe(false);
  });
});

describe("CSI and SS3", () => {
  test("plain arrows are named; modified arrows and other keys are other", () => {
    expect(names("\x1b[A\x1b[B\x1bOA\x1bOB\x1b[1A")).toEqual(["up", "down", "up", "down", "up"]);
    expect(names("\x1b[C\x1b[D\x1bOC\x1bOD\x1b[1D")).toEqual(["right", "left", "right", "left", "left"]);
    expect(names("\x1b[1;5A\x1b[1;2D\x1b[1;5D\x1b[2D\x1b[1;4C\x1b[3~\x1b[H\x1bOP\x1b[15~\x1b[5~\x1b[6~")).toEqual(Array(11).fill("other"));
    expect(names("\x1b[1;3D\x1b[1;3C")).toEqual(["alt-left", "alt-right"]);
  });

  test("SS3 M (keypad Enter) is Enter", () => {
    expect(names("\x1bOM")).toEqual(["enter"]);
  });

  test("split anywhere across chunks", () => {
    expect(names(["\x1b", "[", "A"])).toEqual(["up"]);
    expect(names(["\x1b[1", ";5", "A", "x"])).toEqual(["other", "text:x"]);
    expect(raws(["\x1b[1", ";5", "A"])).toBe("\x1b[1;5A");
  });

  test("an unfinished sequence goes on as it is when flushed", () => {
    expect(decode(["\x1b[12"])).toEqual([{ name: "other", raw: "\x1b[12" }]);
  });
});

describe("terminal replies: their own kind (the router drops them)", () => {
  test.each([
    ["cursor position report", "\x1b[12;40R"],
    ["cursor position report, row 1 column 1", "\x1b[1;1R"],
    ["cursor position report, row 1 column 17", "\x1b[1;17R"],
    ["cursor position report, row 2 column 5", "\x1b[2;5R"],
    ["DECXCPR", "\x1b[?12;40;1R"],
    ["device attributes (DA1)", "\x1b[?62;22c"],
    ["secondary device attributes (DA2)", "\x1b[>41;354;0c"],
    ["kitty flags reply", "\x1b[?1u"],
    ["kitty flags reply, none", "\x1b[?0u"],
    ["DEC private mode report", "\x1b[?2026;2$y"],
    ["ANSI mode report", "\x1b[4;2$y"],
    ["status report", "\x1b[0n"],
    ["colour scheme report", "\x1b[?997;1n"],
    ["window size report", "\x1b[8;24;80t"],
    ["OSC 11 reply, BEL", "\x1b]11;rgb:0c0c/0c0c/0c0c\x07"],
    ["OSC 11 reply, ST", "\x1b]11;rgb:ffff/ffff/ffff\x1b\\"],
    ["DCS reply", "\x1bP1$r0m\x1b\\"],
    ["XTVERSION (DCS)", "\x1bP>|xterm(390)\x1b\\"],
    ["APC (kitty graphics) reply", "\x1b_Gi=1;OK\x1b\\"],
  ])("%s", (_, bytes) => {
    expect(decode(bytes)).toEqual([{ name: "reply", raw: bytes }]);
    everySplit(bytes, ["reply"]);
  });

  test("CSI 1;2R … CSI 1;16R is Shift/Alt/Ctrl+F3 in xterm, the same bytes as a cursor report at row 1: a key (forwarded)", () => {
    for (let m = 2; m <= 16; m++) expect(names(`\x1b[1;${m}R`)).toEqual(["other"]);
    expect(names("\x1b[R")).toEqual(["other"]);
  });

  test("a reply with a return-key byte in it is not the return key", () => {
    expect(names("\x1b]2;a\x1cb\x07")).toEqual(["reply"]);
    expect(names("\x1b]2;a\x1db\x07", "ctrl+]")).toEqual(["reply"]);
  });

  test("Alt+] or Alt+P alone starts no reply: it goes on as other at the flush", () => {
    expect(decode("\x1b]")).toEqual([{ name: "other", raw: "\x1b]" }]);
    expect(decode("\x1bP")).toEqual([{ name: "other", raw: "\x1bP" }]);
  });
});

describe("focus reports", () => {
  test("CSI I is in, CSI O is out", () => {
    expect(decode("\x1b[I")).toEqual([{ name: "focus", raw: "\x1b[I", focus: "in" }]);
    expect(decode("\x1b[O")).toEqual([{ name: "focus", raw: "\x1b[O", focus: "out" }]);
    everySplit("\x1b[I\x1b[O", ["focus", "focus"]);
  });
});

describe("mouse reports", () => {
  const ev = (raw: string) => {
    const keys = decode(raw);
    expect(keys.map((k) => k.name)).toEqual(["mouse"]);
    expect(keys[0]!.raw).toBe(raw);
    return keys[0]!.mouse!;
  };
  const pick = (m: MouseReport) => ({ ...m });

  test.each<[string, string, Partial<MouseReport>]>([
    ["SGR left press", "\x1b[<0;10;5M", { code: 0, button: 0, x: 10, y: 5, release: false, motion: false, wheel: null, encoding: "sgr" }],
    ["SGR left release", "\x1b[<0;10;5m", { button: 0, release: true, encoding: "sgr" }],
    ["SGR right press with Ctrl+Shift", "\x1b[<22;1;1M", { button: 2, shift: true, ctrl: true, alt: false }],
    ["SGR middle with Alt", "\x1b[<9;300;200M", { button: 1, alt: true, x: 300, y: 200 }],
    ["SGR drag with the left button", "\x1b[<32;3;4M", { button: 0, motion: true, release: false }],
    ["SGR motion, no button", "\x1b[<35;3;4M", { button: 3, motion: true, release: false }],
    ["SGR wheel up", "\x1b[<64;7;8M", { button: 4, wheel: "up", release: false }],
    ["SGR wheel down with Ctrl", "\x1b[<81;7;8M", { button: 5, wheel: "down", ctrl: true }],
    ["SGR wheel left / right", "\x1b[<66;1;1M", { button: 6, wheel: "left" }],
    ["SGR extra button 8", "\x1b[<128;1;1M", { button: 8, wheel: null }],
    ["X10 left press", "\x1b[M !!", { code: 0, button: 0, x: 1, y: 1, release: false, encoding: "x10" }],
    ["X10 release (button unknown)", "\x1b[M#*+", { code: 3, button: 3, x: 10, y: 11, release: true, encoding: "x10" }],
    ["X10 wheel down", "\x1b[Ma!!", { button: 5, wheel: "down", release: false }],
    ["UTF-8 (1005) far column", `\x1b[M ${String.fromCodePoint(1032)}!`, { x: 1000, y: 1, encoding: "utf8" }],
    ["urxvt (1015) press", "\x1b[32;10;5M", { code: 0, button: 0, x: 10, y: 5, release: false, encoding: "urxvt" }],
    ["urxvt release", "\x1b[35;10;5M", { button: 3, release: true, encoding: "urxvt" }],
    ["urxvt wheel up", "\x1b[96;10;5M", { wheel: "up", release: false }],
  ])("%s", (_, raw, want) => {
    expect(pick(ev(raw))).toMatchObject(want);
    everySplit(raw, ["mouse"]);
  });

  test("not mouse reports: a CSI M with another shape, a cell 0", () => {
    expect(names("\x1b[1;2M")).toEqual(["other"]);
    expect(names("\x1b[10;5;3M")).toEqual(["other"]); // urxvt button below 32
    expect(names("\x1b[<0;0;5M")).toEqual(["other"]);
    expect(names("\x1b[<0;1M")).toEqual(["other"]);
    // X10 past column 95: a byte that isn't UTF-8 reaches the decoder as U+FFFD, its value lost.
    expect(names("\x1b[M �!")).toEqual(["other"]);
  });

  test("never inside a paste", () => {
    expect(names("\x1b[200~\x1b[<0;1;1M\x1b[201~")).toEqual(["text:\x1b[<0;1;1M:pasted"]);
  });
});

describe("encodeMouse: a report again, in the agent's encoding, at a shifted cell", () => {
  const ENCODINGS: MouseEncoding[] = ["sgr", "urxvt", "utf8", "x10"];
  const parse = (raw: string) => decode(raw)[0]!.mouse!;
  const SAMPLES = ["\x1b[<0;10;5M", "\x1b[<2;10;5M", "\x1b[<22;3;4M", "\x1b[<32;3;4M", "\x1b[<35;3;4M", "\x1b[<64;7;8M", "\x1b[<81;7;8M", "\x1b[<9;1;1M"];

  test("each encoding: written and read again, the same report (and the same bytes)", () => {
    for (const raw of SAMPLES) {
      const m = parse(raw);
      expect(encodeMouse(m, "sgr", 0, 0)).toBe(raw);
      for (const enc of ENCODINGS) {
        const out = encodeMouse(m, enc, 0, 0)!;
        const back = parse(out);
        expect({ ...back, encoding: m.encoding }).toEqual(m);
        expect(encodeMouse(back, enc, 0, 0)).toBe(out);
      }
    }
  });

  test("shifted into the agent's screen", () => {
    const m = parse("\x1b[<0;10;5M");
    expect(encodeMouse(m, "sgr", -2, -3)).toBe("\x1b[<0;8;2M");
    expect(encodeMouse(m, "urxvt", -2, -3)).toBe("\x1b[32;8;2M");
    expect(encodeMouse(m, "x10", -2, -3)).toBe("\x1b[M (\"");
    expect(encodeMouse(m, "utf8", 1000, 0)).toBe(`\x1b[M ${String.fromCodePoint(1042)}%`);
  });

  test("a release: SGR keeps its button; elsewhere it is button 3; an X10 release as SGR is the left button's", () => {
    const right = parse("\x1b[<2;4;4m");
    expect(encodeMouse(right, "sgr", 0, 0)).toBe("\x1b[<2;4;4m");
    expect(encodeMouse(right, "x10", 0, 0)).toBe("\x1b[M#$$");
    expect(encodeMouse(right, "urxvt", 0, 0)).toBe("\x1b[35;4;4M");
    const x10 = parse("\x1b[M#$$");
    expect(x10.release).toBe(true);
    expect(encodeMouse(x10, "sgr", 0, 0)).toBe("\x1b[<0;4;4m");
    // With Ctrl held: the modifier stays.
    expect(encodeMouse(parse("\x1b[<18;4;4m"), "x10", 0, 0)).toBe(`\x1b[M${String.fromCharCode(32 + 19)}$$`);
  });

  test("out of range: off the screen (below 1), past what the encoding carries", () => {
    const m = parse("\x1b[<0;10;5M");
    expect(encodeMouse(m, "sgr", -10, 0)).toBeNull();
    expect(encodeMouse(m, "sgr", 0, -5)).toBeNull();
    expect(encodeMouse(m, "sgr", -9, -4)).toBe("\x1b[<0;1;1M");
    // X10: one 7-bit byte each (a byte from 0x80 would reach the PTY as two UTF-8 bytes).
    expect(encodeMouse(m, "x10", 85, 0)).toBe(`\x1b[M ${String.fromCharCode(127)}%`);
    expect(encodeMouse(m, "x10", 86, 0)).toBeNull();
    expect(encodeMouse(m, "x10", 0, 91)).toBeNull();
    expect(encodeMouse(parse("\x1b[<128;1;1M"), "x10", 0, 0)).toBeNull();
    // UTF-8: up to 2015.
    expect(encodeMouse(m, "utf8", 2005, 0)).not.toBeNull();
    expect(encodeMouse(m, "utf8", 2006, 0)).toBeNull();
    // SGR and urxvt: no limit.
    expect(encodeMouse(m, "sgr", 5000, 5000)).toBe("\x1b[<0;5010;5005M");
    expect(encodeMouse(m, "urxvt", 5000, 0)).toBe("\x1b[32;5010;5M");
  });
});

describe("the return key", () => {
  test("default ctrl+\\ (0x1c); each choice; a saved ctrl+] still works", () => {
    expect(decode("\x1c")).toEqual([{ name: "return-key", raw: "\x1c" }]);
    for (const [spec, byte] of Object.entries(RETURN_KEYS)) {
      expect(returnKeyByte(spec)).toBe(byte);
      expect(names(String.fromCharCode(byte), spec)).toEqual(["return-key"]);
    }
    expect(names("\x1d", "ctrl+]")).toEqual(["return-key"]);
    // Another return key configured: the other bytes are just bytes for the agent.
    expect(names("\x1d")).toEqual(["other"]);
    expect(names("\x1c", "ctrl+]")).toEqual(["other"]);
    expect(returnKeyByte("ctrl+x")).toBeNull();
    // Unknown value: the default.
    expect(names("\x1c", "nonsense")).toEqual(["return-key"]);
    expect(names("\x1d", "nonsense")).toEqual(["other"]);
  });

  test("kitty: ctrl+\\ is CSI 92;5u, Ctrl+4 CSI 52;5u (also with locks, a press event); ctrl+] CSI 93;5u", () => {
    expect(names("\x1b[92;5u")).toEqual(["return-key"]);
    expect(names("\x1b[52;5u")).toEqual(["return-key"]);
    expect(names("\x1b[52;69u")).toEqual(["return-key"]); // + Caps Lock
    expect(names("\x1b[52;5:1u")).toEqual(["return-key"]);
    expect(names("\x1b[52;5:3u")).toEqual(["other"]); // release
    expect(names("\x1b[52;7u")).toEqual(["other"]); // ctrl+alt
    expect(names("\x1b[52u")).toEqual(["text:4"]);
    expect(names("\x1b[52;5u", "ctrl+]")).toEqual(["other"]);
    expect(names("\x1b[93;5u", "ctrl+]")).toEqual(["return-key"]);
    expect(names("\x1b[93;69u", "ctrl+]")).toEqual(["return-key"]);
    expect(names("\x1b[93;5:3u", "ctrl+]")).toEqual(["other"]);
    expect(names("\x1b[93;7u", "ctrl+]")).toEqual(["other"]);
    expect(names("\x1b[93u", "ctrl+]")).toEqual(["text:]"]);
    expect(names("\x1b[54:94;6u", "ctrl+^")).toEqual(["return-key"]);
    expect(names("\x1b[54;5u", "ctrl+^")).toEqual(["return-key"]);
    expect(names("\x1b[45;5u", "ctrl+_")).toEqual(["return-key"]);
  });

  test("win32-input-mode: Uc 0x1c, or VK_OEM_5 or VK '4' with Ctrl; its key-up is dropped", () => {
    expect(names("\x1b[220;43;28;1;8;1_")).toEqual(["return-key"]);
    expect(names("\x1b[220;43;0;1;8;1_")).toEqual(["return-key"]);
    expect(names("\x1b[52;5;0;1;8;1_")).toEqual(["return-key"]); // Ctrl+4
    expect(names("\x1b[52;5;0;1;4;1_")).toEqual(["return-key"]); // right Ctrl+4
    expect(decode("\x1b[220;43;28;0;8;1_")).toEqual([{ name: "other", raw: "" }]);
    expect(decode("\x1b[52;5;0;0;8;1_")).toEqual([{ name: "other", raw: "" }]);
    // 4 alone, or with AltGr, is text; Ctrl+4 with another return key is other.
    expect(names("\x1b[52;5;52;1;0;1_")).toEqual(["text:4"]);
    expect(names("\x1b[52;5;0;1;8;1_", "ctrl+]")).toEqual(["other"]);
    // ctrl+] saved: VK_OEM_6.
    expect(names("\x1b[221;27;29;1;8;1_", "ctrl+]")).toEqual(["return-key"]);
    expect(names("\x1b[221;27;0;1;8;1_", "ctrl+]")).toEqual(["return-key"]);
    expect(decode("\x1b[221;27;29;0;8;1_", "ctrl+]")).toEqual([{ name: "other", raw: "" }]);
    // The Ctrl key itself is forwarded.
    expect(decode("\x1b[17;29;0;1;8;1_")).toEqual([{ name: "other", raw: "\x1b[17;29;0;1;8;1_" }]);
  });

  test("never inside a paste", () => {
    expect(names("\x1b[200~a\x1cb\x1b[201~")).toEqual(["text:a\x1cb:pasted"]);
  });
});

describe("Gluon's keys: Shift+PgUp/PgDn scroll; Alt+PgUp/PgDn are the agent's", () => {
  test.each<[string, string, string]>([
    // legacy xterm: CSI 5/6 ; modifier ~ (2 = Shift)
    ["legacy Shift+PgUp", "\x1b[5;2~", "scroll-up"],
    ["legacy Shift+PgDn", "\x1b[6;2~", "scroll-down"],
    // kitty: the same with an event type (1 press), lock bits
    ["kitty Shift+PgUp press", "\x1b[5;2:1~", "scroll-up"],
    ["kitty keypad Shift+PgUp", "\x1b[57421;2u", "scroll-up"],
    // win32-input-mode: VK_NEXT 0x22 / VK_PRIOR 0x21, Shift 0x10, enhanced key 0x100
    ["win32 Shift+PgUp", "\x1b[33;73;0;1;16;1_", "scroll-up"],
    ["win32 Shift+PgDn", "\x1b[34;81;0;1;272;1_", "scroll-down"],
    ["win32 characters, legacy Shift+PgDn", chars("\x1b[6;2~"), "scroll-down"],
  ])("%s", (_, bytes, name) => {
    expect(decode(bytes)).toEqual([{ name: name as Key["name"], raw: bytes }]);
    everySplit(bytes, [name]);
  });

  test("BUG-279/keys: Alt+PgUp/PgDn, in every encoding, are plain other keys (forwarded as they are); rxvt's ESC ESC[5~ is Escape, then PgUp", () => {
    for (const bytes of [
      "\x1b[6;3~", "\x1b[5;3~", "\x1b[6;3:1~", "\x1b[6;3:2~", "\x1b[5;67~", "\x1b[5;131:1~", "\x1b[57422;3u",
      "\x1b[34;81;0;1;2;1_", "\x1b[33;73;0;1;1;1_", "\x1b[34;81;0;1;258;1_",
    ])
      expect(decode(bytes)).toEqual([{ name: "other", raw: bytes }]);
    // Through win32-input-mode from a plain-VT terminal (BUG-153): the VT sequence as characters.
    expect(names(chars("\x1b[6;3~"))).toEqual(["other"]);
    expect(names("\x1b\x1b[6~")).toEqual(["escape", "other"]);
    expect(names("\x1b\x1b[5~")).toEqual(["escape", "other"]);
    expect(raws("\x1b\x1b[5~")).toBe("\x1b\x1b[5~");
    expect(names(["\x1b\x1b[6", "~"])).toEqual(["escape", "other"]);
    // Their win32 key-ups go on to the agent too: nothing of the key is Gluon's.
    expect(decode("\x1b[34;81;0;0;2;1_")).toEqual([{ name: "other", raw: "\x1b[34;81;0;0;2;1_" }]);
    expect(decode("\x1b[33;73;0;0;1;1_")).toEqual([{ name: "other", raw: "\x1b[33;73;0;0;1;1_" }]);
  });

  test("other modifiers, no modifier, a release: not Gluon's keys (forwarded as they are)", () => {
    for (const bytes of ["\x1b[5~", "\x1b[6~", "\x1b[6;5~", "\x1b[6;4~", "\x1b[6;7~", "\x1b[5;9~", "\x1b[6;3:3~", "\x1b[5;2:3~", "\x1b[57422;3:3u", "\x1b[57422u", "\x1b[57421;5u"])
      expect(decode(bytes)).toEqual([{ name: "other", raw: bytes }]);
    // win32: no modifier, Ctrl+Alt, AltGr (Ctrl + right Alt), Alt+Shift.
    for (const bytes of ["\x1b[34;81;0;1;0;1_", "\x1b[34;81;0;1;10;1_", "\x1b[34;81;0;1;9;1_", "\x1b[34;81;0;1;18;1_"]) expect(names(bytes)).toEqual(["other"]);
  });

  test("win32 key-ups of Shift+PgUp/PgDn go on", () => {
    expect(decode("\x1b[33;73;0;0;16;1_")).toEqual([{ name: "other", raw: "\x1b[33;73;0;0;16;1_" }]);
  });

  test.each<[string, string, string]>([
    ["legacy ←", "\x1b[D", "left"],
    ["legacy →", "\x1b[C", "right"],
    ["legacy ← with a count of 1", "\x1b[1D", "left"],
    ["SS3 ← (application cursor keys)", "\x1bOD", "left"],
    ["SS3 →", "\x1bOC", "right"],
    ["kitty ← with no modifier", "\x1b[1;1D", "left"],
    ["kitty → press", "\x1b[1;1:1C", "right"],
    ["kitty ← repeat", "\x1b[1;1:2D", "left"],
    ["kitty ← with Caps Lock", "\x1b[1;65D", "left"],
    ["kitty → with Num Lock", "\x1b[1;129C", "right"],
    ["kitty keypad ←", "\x1b[57417u", "left"],
    ["kitty keypad →", "\x1b[57418;1u", "right"],
    // win32-input-mode: VK_LEFT 0x25 / VK_RIGHT 0x27, enhanced key 0x100, Num Lock 0x20
    ["win32 ←", "\x1b[37;75;0;1;256;1_", "left"],
    ["win32 →, Num Lock", "\x1b[39;77;0;1;288;1_", "right"],
    ["win32 characters, legacy ←", chars("\x1b[D"), "left"],
    ["win32 characters, SS3 →", chars("\x1bOC"), "right"],
  ])("BUG-195/keys: plain %s", (_, bytes, name) => {
    expect(decode(bytes)).toEqual([{ name: name as Key["name"], raw: bytes }]);
    everySplit(bytes, [name]);
  });

  test("BUG-195/keys: ←/→ with Shift or Ctrl, a kitty release, Alt as ESC: other (forwarded as they are)", () => {
    for (const bytes of ["\x1b[1;2D", "\x1b[5;3D", "\x1b[1;5D", "\x1b[1;9C", "\x1b[1;1:3D", "\x1b[57417;5u", "\x1b[57418;1:3u", "\x1b\x1b[D", "\x1b[1;4C", "\x1b[1;7D"]) expect(raws(bytes)).toBe(bytes);
    for (const bytes of ["\x1b[1;2D", "\x1b[1;5D", "\x1b[1;9C", "\x1b[1;1:3D", "\x1b[57417;5u", "\x1b[57418;1:3u", "\x1b[1;4C", "\x1b[1;7D"]) expect(names(bytes)).toEqual(["other"]);
    // win32: Shift, left Ctrl, Ctrl+Alt (AltGr), Alt+Shift.
    for (const bytes of ["\x1b[37;75;0;1;272;1_", "\x1b[39;77;0;1;264;1_", "\x1b[37;75;0;1;266;1_", "\x1b[39;77;0;1;274;1_"]) expect(decode(bytes)).toEqual([{ name: "other", raw: bytes }]);
  });

  test("BUG-195/keys: win32 key-ups of plain ←/→ are dropped (Gluon may take the key); a modified one's goes on", () => {
    expect(decode("\x1b[37;75;0;0;256;1_")).toEqual([{ name: "other", raw: "" }]);
    expect(decode("\x1b[39;77;0;0;256;1_")).toEqual([{ name: "other", raw: "" }]);
    expect(decode("\x1b[37;75;0;0;272;1_")).toEqual([{ name: "other", raw: "\x1b[37;75;0;0;272;1_" }]);
  });

  test.each<[string, string, string]>([
    ["legacy Alt+←", "\x1b[1;3D", "alt-left"],
    ["legacy Alt+→", "\x1b[1;3C", "alt-right"],
    ["kitty Alt+← press", "\x1b[1;3:1D", "alt-left"],
    ["kitty Alt+→ repeat", "\x1b[1;3:2C", "alt-right"],
    ["kitty Alt+← with Caps Lock", "\x1b[1;67D", "alt-left"],
    ["kitty Alt+→ with Num Lock", "\x1b[1;131:1C", "alt-right"],
    // win32-input-mode: left Alt 0x2, right Alt 0x1, enhanced key 0x100
    ["win32 left Alt+←", "\x1b[37;75;0;1;258;1_", "alt-left"],
    ["win32 right Alt+→", "\x1b[39;77;0;1;257;1_", "alt-right"],
    ["win32 characters, legacy Alt+←", chars("\x1b[1;3D"), "alt-left"],
  ])("BUG-280/keys: %s", (_, bytes, name) => {
    expect(decode(bytes)).toEqual([{ name: name as Key["name"], raw: bytes }]);
    everySplit(bytes, [name]);
  });

  test("BUG-280/keys: a kitty release of Alt+←/→ stays other; Alt+↑/↓ are not Gluon's; win32 key-ups of Alt+←/→ are dropped, a Shift+Alt one's goes on", () => {
    for (const bytes of ["\x1b[1;3:3D", "\x1b[1;3:3C", "\x1b[1;3A", "\x1b[1;3B"]) expect(decode(bytes)).toEqual([{ name: "other", raw: bytes }]);
    expect(decode("\x1b[37;75;0;0;258;1_")).toEqual([{ name: "other", raw: "" }]);
    expect(decode("\x1b[39;77;0;0;257;1_")).toEqual([{ name: "other", raw: "" }]);
    expect(decode("\x1b[39;77;0;0;274;1_")).toEqual([{ name: "other", raw: "\x1b[39;77;0;0;274;1_" }]);
  });

  test("an ESC ESC is Escape and what follows, however it is split or flushed", () => {
    expect(names(["\x1b\x1b[", "A"])).toEqual(["escape", "up"]);
    expect(decode(["\x1b\x1b[5"])).toEqual([
      { name: "escape", raw: "\x1b" },
      { name: "other", raw: "\x1b[5" },
    ]);
    everySplit("\x1b\x1b[200~x\x1b[201~", ["escape", "text:x:pasted"]);
  });

  test("never inside a paste", () => {
    expect(names("\x1b[200~\x1b[1;3D\x1b\x1b[5~\x1b[5;2~\x1b[201~")).toEqual(["text:\x1b[1;3D\x1b\x1b[5~\x1b[5;2~:pasted"]);
  });
});

describe("kitty keyboard protocol", () => {
  test("Enter, Tab, Esc, Backspace by code", () => {
    expect(names("\x1b[13u\x1b[9u\x1b[27u\x1b[127u")).toEqual(["enter", "tab", "escape", "backspace"]);
    expect(names("\x1b[13;2u\x1b[27;5u")).toEqual(["other", "other"]); // shift+Enter, ctrl+Esc
  });

  test("printable codes are text (shifted key, text field); ctrl+letter is other", () => {
    expect(names("\x1b[97u")).toEqual(["text:a"]);
    expect(names("\x1b[97:65;2u")).toEqual(["text:A"]);
    expect(names("\x1b[97;1;65u")).toEqual(["text:A"]);
    expect(names("\x1b[99;5u")).toEqual(["other"]);
    expect(names("\x1b[57399u")).toEqual(["other"]); // a keypad key (private use)
  });
});

describe("win32-input-mode", () => {
  test("key-downs by Uc; key-ups are other", () => {
    expect(names("\x1b[65;30;97;1;0;1_")).toEqual(["text:a"]);
    expect(names("\x1b[65;30;97;0;0;1_")).toEqual(["other"]);
    expect(names("\x1b[13;28;13;1;0;1_\x1b[9;15;9;1;0;1_\x1b[27;1;27;1;0;1_\x1b[8;14;8;1;0;1_")).toEqual(["enter", "tab", "escape", "backspace"]);
    // Shift/Ctrl/Alt + Enter puts a newline in the input: not the Enter that runs it (BUG-148).
    expect(names("\x1b[13;28;13;1;16;1_\x1b[13;28;13;1;8;1_\x1b[13;28;13;1;2;1_")).toEqual(["other", "other", "other"]);
    expect(names("\x1b[38;72;0;1;0;1_\x1b[40;80;0;1;0;1_")).toEqual(["up", "down"]);
    // Ctrl+C: Uc 3, other (forwarded; ConPTY makes it the agent's Ctrl+C).
    expect(names("\x1b[67;46;3;1;8;1_")).toEqual(["other"]);
    // AltGr (Ctrl + right Alt) + Q on a German layout: @ is text.
    expect(names("\x1b[81;16;64;1;9;1_")).toEqual(["text:@"]);
  });

  test("split across chunks", () => {
    expect(names(["\x1b[65;30;9", "7;1;0;1_"])).toEqual(["text:a"]);
  });

  test("BUG-153: characters with no virtual key are read again as VT: one key, all their bytes", () => {
    const down = chars("\x1b[B");
    expect(decode(down)).toEqual([{ name: "down", raw: down }]);
    expect(names([chars("\x1b[A"), down, chars("\x1b[92;5u"), chars("\x1b[13u")])).toEqual(["up", "down", "return-key", "enter"]);
    expect(names(chars("\x1b[104u\x1b[99;5u"))).toEqual(["text:h", "other"]);
    // Split anywhere, and mixed with real keys: in order, nothing lost.
    const mixed = `${chars("\x1b[")}${chars("B")}\x1b[72;35;104;1;0;1_\x1b[72;35;104;0;0;1_`;
    for (let i = 1; i < mixed.length; i++) {
      expect(names([mixed.slice(0, i), mixed.slice(i)])).toEqual(["down", "text:h", "other"]);
      expect(raws([mixed.slice(0, i), mixed.slice(i)])).toBe(mixed);
    }
    // A lone ESC character is Escape after the pause.
    expect(names(chars("\x1b"))).toEqual(["escape"]);
  });

  test("characters with no virtual key: mouse, focus and replies keep their kind and fields", () => {
    const sgr = chars("\x1b[<64;7;8M");
    expect(decode(sgr)).toEqual([{ name: "mouse", raw: sgr, mouse: decode("\x1b[<64;7;8M")[0]!.mouse! }]);
    expect(decode(chars("\x1b[I"))).toEqual([{ name: "focus", raw: chars("\x1b[I"), focus: "in" }]);
    expect(names(chars("\x1b]11;rgb:0/0/0\x07"))).toEqual(["reply"]);
  });

  test("BUG-153: a paste whose brackets come as characters and its text as real keys is one pasted key", () => {
    // `/clear` pasted, exactly as CI's conhost sent it.
    const bytes =
      "\x1b[0;0;27;1;0;1_\x1b[0;0;91;1;0;1_\x1b[0;0;50;1;0;1_\x1b[0;0;48;1;0;1_\x1b[0;0;48;1;0;1_\x1b[0;0;126;1;0;1_" +
      "\x1b[191;53;47;1;0;1_\x1b[191;53;47;0;0;1_\x1b[67;46;99;1;0;1_\x1b[67;46;99;0;0;1_\x1b[76;38;108;1;0;1_\x1b[76;38;108;0;0;1_" +
      "\x1b[69;18;101;1;0;1_\x1b[69;18;101;0;0;1_\x1b[65;30;97;1;0;1_\x1b[65;30;97;0;0;1_\x1b[82;19;114;1;0;1_\x1b[82;19;114;0;0;1_" +
      "\x1b[0;0;27;1;0;1_\x1b[0;0;91;1;0;1_\x1b[0;0;50;1;0;1_\x1b[0;0;48;1;0;1_\x1b[0;0;49;1;0;1_\x1b[0;0;126;1;0;1_";
    expect(decode(bytes)).toEqual([{ name: "text", raw: bytes, text: "/clear", pasted: true }]);
    const enter = "\x1b[13;28;13;1;0;1_";
    for (let i = 1; i < bytes.length; i++) {
      const keys = decode([bytes.slice(0, i), bytes.slice(i) + enter]);
      expect(keys.map((k) => k.raw).join("")).toBe(bytes + enter);
      expect(keys.filter((k) => k.pasted).map((k) => k.text).join("")).toBe("/clear");
      expect(keys.filter((k) => !k.pasted).map((k) => k.name)).toEqual(["enter"]);
    }
  });
});

/** A key pressed and let go in win32-input-mode: its key-down and key-up. */
const press = (vk: number, sc: number, uc: number, cs = 0) => `\x1b[${vk};${sc};${uc};1;${cs};1_\x1b[${vk};${sc};${uc};0;${cs};1_`;
/** What a plain-VT reader gets of `bytes` decoded (`asVt` of every key). */
const vt = (bytes: string | string[]) => decode(bytes).map(asVt).join("");
const WIN32_SEQ = /\d*;\d*;\d*;\d*;\d*;\d*_/;

test("BUG-237/keys: what the home view (Ink) gets — modifyOtherKeys in kitty's form, the Esc key unambiguous, the rest and pastes as they are", () => {
  const ink = (bytes: string | string[]) => decode(bytes).map(forInk);
  expect(ink("\x1b[27;2;13~")).toEqual(["\x1b[13;2u"]);
  expect(ink("\x1b[27;5;9~")).toEqual(["\x1b[9;5u"]);
  // Kitty's own Shift+Enter, Alt+Enter, text, an arrow: unchanged.
  for (const b of ["\x1b[13;2u", "\x1b\r", "x", "\x1b[C"]) expect(ink(b)).toEqual([b]);
  // A lone Esc (told apart once no more bytes came): Ink would read a key within 20 ms as Alt+key.
  const d = createKeyDecoder("ctrl+\\");
  expect([...d.feed("\x1b"), ...d.flush()].map(forInk)).toEqual(["\x1b[27u"]);
  // A paste carrying such bytes is the user's text.
  expect(ink("\x1b[200~a\x1b[27;2;13~b\x1b[201~").join("")).toBe("\x1b[200~a\x1b[27;2;13~b\x1b[201~");
});

test("BUG-656/keys: a paste's end marker with no paste before it is nothing to the home view (Ink would type `[201~`), whole or among keys, and still the user's bytes for an agent; a paste and its own marker are as before", () => {
  const ink = (bytes: string | string[]) => decode(bytes).map(forInk).join("");
  expect(ink("\x1b[201~")).toBe("");
  expect(ink("a\x1b[201~b")).toBe("ab");
  // Split across chunks, and after a whole paste.
  expect(ink(["\x1b[2", "01~"])).toBe("");
  expect(ink("\x1b[200~x\x1b[201~\x1b[201~")).toBe("\x1b[200~x\x1b[201~");
  // Its bytes are kept in order for an agent (the decoder drops nothing).
  expect(decode("a\x1b[201~b").map((k) => k.raw).join("")).toBe("a\x1b[201~b");
  expect(decode("\x1b[201~").map(unbracketed).join("")).toBe("\x1b[201~");
  // The start marker alone is not touched, nor the other CSI `~` keys.
  expect(ink("\x1b[3~")).toBe("\x1b[3~");
  expect(ink("\x1b[200~x\x1b[201~")).toBe("\x1b[200~x\x1b[201~");
});

// QA triage of #35 ("Other platforms"): BUG-237 fixed only the VT encodings. In win32-input-mode Shift+Enter arrives as VK_RETURN
// with Uc 13 and the Shift bit, and `win32AsVt` took the character branch (`String.fromCharCode(13)`), dropping the Shift: Ink
// got a plain Enter and the home composer submitted instead of adding a new line. Windows Terminal turns win32-input-mode on
// whenever an app asks for it, so this is the default there. `forInk` gives kitty's form, as for modifyOtherKeys.
test("BUG-655/QA-keys-01: a win32-input-mode Shift+Enter reaches the home view as Shift+Enter (kitty's form), not as a plain Enter (#35)", () => {
  expect(decode(press(13, 28, 13, 16)).map(forInk).join("")).toBe("\x1b[13;2u");
});

test("BUG-655/variants: win32-input-mode Enter with Ctrl, Shift+Ctrl, Shift+Alt reaches Ink in kitty's form; plain Enter, Alt+Enter and AltGr+Enter are as before; no such Enter counts as the one that runs a line", () => {
  const ink = (bytes: string) => decode(bytes).map(forInk).join("");
  // Ctrl+Enter comes with Uc 10 (LF) from conhost, or 13: either way it is Ctrl+Enter.
  expect(ink(press(13, 28, 10, 8))).toBe("\x1b[13;5u");
  expect(ink(press(13, 28, 13, 8))).toBe("\x1b[13;5u");
  expect(ink(press(13, 28, 13, 24))).toBe("\x1b[13;6u");
  expect(ink(press(13, 28, 13, 18))).toBe("\x1b[13;4u");
  // A repeat count (Rc) repeats the key: each one in kitty's form, never `[27;2;13~` typed (a global replace, not an anchored one).
  expect(ink("\x1b[13;28;13;1;16;2_\x1b[13;28;13;0;16;2_")).toBe("\x1b[13;2u".repeat(2));
  expect(ink("\x1b[13;28;13;1;16;3_\x1b[13;28;13;0;16;3_")).toBe("\x1b[13;2u".repeat(3));
  expect(ink("\x1b[13;28;10;1;8;2_\x1b[13;28;10;0;8;2_")).toBe("\x1b[13;5u".repeat(2));
  expect(ink("\x1b[13;28;10;1;8;3_\x1b[13;28;10;0;8;3_")).toBe("\x1b[13;5u".repeat(3));
  // The keypad's Enter (ENHANCED_KEY) is the same key.
  expect(ink(press(13, 28, 13, 16 | 0x100))).toBe("\x1b[13;2u");
  // Left alone: plain Enter, Alt+Enter (ESC + Enter, as VT), AltGr+Enter (no modifier Ink knows).
  expect(ink(press(13, 28, 13))).toBe("\r");
  expect(ink(press(13, 28, 13, 2))).toBe("\x1b\r");
  expect(ink(press(13, 28, 13, 9))).toBe("\r");
  // The decoder names it `other` (not `enter`), so the question bar and the line tracker never read it as an Enter that runs a line.
  expect(decode(press(13, 28, 13, 16)).map((k) => k.name)).not.toContain("enter");
});

describe("BUG-208: win32-input-mode as plain VT (asVt, for Gluon's home view)", () => {
  test("BUG-208/keys: key-ups and keys with no character are nothing; the home key's Ctrl+\\ is its byte", () => {
    // Ctrl+\ as conhost sends it: Ctrl down, \ down and up (Uc 0x1c), Ctrl up.
    expect(vt("\x1b[17;29;0;1;8;1_\x1b[220;43;28;1;8;1_\x1b[220;43;28;0;8;1_\x1b[17;29;0;0;0;1_")).toBe("\x1c");
    // The Ctrl key-up alone (what reached the home view on Windows CI), an Enter key-up, Shift, Caps Lock, Alt, Win.
    for (const seq of ["\x1b[17;29;0;0;0;1_", "\x1b[13;28;13;0;0;1_", press(16, 42, 0, 16), press(20, 58, 0), press(18, 56, 0, 2), press(91, 91, 0, 0)])
      expect(vt(seq)).toBe("");
  });

  test("BUG-208/keys: typed text, Enter, Backspace, Tab, Esc, Ctrl and Alt keys reach a VT reader as VT", () => {
    expect(vt(press(72, 35, 104) + press(73, 23, 105))).toBe("hi");
    expect(vt(`\x1b[16;42;0;1;16;1_${press(72, 35, 72, 16)}\x1b[16;42;0;0;0;1_`)).toBe("H");
    expect(vt(press(13, 28, 13))).toBe("\r");
    expect(vt(press(8, 14, 8))).toBe("\x7f");
    expect(vt(press(9, 15, 9))).toBe("\t");
    expect(vt(press(9, 15, 9, 16))).toBe("\x1b[Z");
    expect(vt(press(27, 1, 27))).toBe("\x1b");
    expect(vt(press(67, 46, 3, 8))).toBe("\x03");
    // Ctrl + a letter reported as the letter: its control byte.
    expect(vt(press(85, 22, 117, 8))).toBe("\x15");
    expect(vt(press(88, 45, 120, 2))).toBe("\x1bx");
    // AltGr + Q on a German layout: @, not Alt+@.
    expect(vt(press(81, 16, 64, 9))).toBe("@");
    // A repeat count: the character that many times.
    expect(vt("\x1b[65;30;97;1;0;3_")).toBe("aaa");
  });

  test("BUG-208/keys: arrows, Home/End, PgUp/PgDn, Insert/Delete, F-keys as their VT sequences, modifiers in xterm's form", () => {
    expect(vt(press(38, 72, 0) + press(40, 80, 0) + press(39, 77, 0) + press(37, 75, 0))).toBe("\x1b[A\x1b[B\x1b[C\x1b[D");
    expect(vt(press(37, 75, 0, 8))).toBe("\x1b[1;5D");
    expect(vt(press(36, 71, 0) + press(35, 79, 0))).toBe("\x1b[H\x1b[F");
    expect(vt(press(33, 73, 0) + press(34, 81, 0) + press(45, 82, 0) + press(46, 83, 0))).toBe("\x1b[5~\x1b[6~\x1b[2~\x1b[3~");
    expect(vt(press(34, 81, 0, 2))).toBe("\x1b[6;3~");
    expect(vt(press(112, 59, 0) + press(116, 63, 0) + press(123, 88, 0))).toBe("\x1bOP\x1b[15~\x1b[24~");
  });

  test("BUG-208/keys: VT characters with no virtual key (BUG-153) come out as the VT they were; nothing win32 leaks", () => {
    expect(vt(chars("\x1b[B"))).toBe("\x1b[B");
    const paste =
      "\x1b[0;0;27;1;0;1_\x1b[0;0;91;1;0;1_\x1b[0;0;50;1;0;1_\x1b[0;0;48;1;0;1_\x1b[0;0;48;1;0;1_\x1b[0;0;126;1;0;1_" +
      press(72, 35, 104) +
      press(73, 23, 105) +
      "\x1b[0;0;27;1;0;1_\x1b[0;0;91;1;0;1_\x1b[0;0;50;1;0;1_\x1b[0;0;48;1;0;1_\x1b[0;0;49;1;0;1_\x1b[0;0;126;1;0;1_";
    expect(vt(paste)).toBe("\x1b[200~hi\x1b[201~");
    const all = `\x1b[17;29;0;1;8;1_${press(220, 43, 28, 8)}\x1b[17;29;0;0;0;1_${press(72, 35, 104)}${press(13, 28, 13)}${press(8, 14, 8)}${press(38, 72, 0)}${press(37, 75, 0)}${press(39, 77, 0)}${press(27, 1, 27)}`;
    for (let i = 1; i < all.length; i++) expect(vt([all.slice(0, i), all.slice(i)])).not.toMatch(WIN32_SEQ);
  });

  test("BUG-208/keys: plain VT keys, and a VT paste that only looks like win32, are left as they are", () => {
    for (const raw of ["a", "\r", "\x7f", "\x1b[A", "\x1b[3~", "\x1c", "\x1b[99;5u"]) expect(vt(raw)).toBe(raw);
    const paste = "\x1b[200~\x1b[65;30;97;0;0;1_\x1b[201~";
    expect(vt(paste)).toBe(paste);
  });
});

describe("BUG-170/F: how long flush waits", () => {
  test("a lone ESC (or ESC [) the Esc key's time; a CSI under way longer, so a split read stays one key", () => {
    const d = createKeyDecoder("ctrl+\\");
    expect(d.wait!()).toBe(ESC_TIMEOUT_MS);
    d.feed("\x1b");
    expect(d.wait!()).toBe(ESC_TIMEOUT_MS);
    d.feed("[");
    expect(d.wait!()).toBe(ESC_TIMEOUT_MS);
    d.feed("6;");
    expect(d.wait!()).toBe(CSI_TIMEOUT_MS);
    expect(d.feed("3~").map(label)).toEqual(["other"]);
    expect(d.wait!()).toBe(ESC_TIMEOUT_MS);
    // A CSI under way after an Escape.
    expect(d.feed("\x1b\x1b[5").map(label)).toEqual(["escape"]);
    expect(d.wait!()).toBe(CSI_TIMEOUT_MS);
    expect(d.feed("~").map(label)).toEqual(["other"]);
  });
});

describe("bracketed paste", () => {
  test("one pasted text key, raw kept (markers included); never Enter or a command", () => {
    const k = decode("\x1b[200~/clear\r\x1b[201~");
    expect(k).toEqual([{ name: "text", raw: "\x1b[200~/clear\r\x1b[201~", text: "/clear\r", pasted: true }]);
    expect(names("x\x1b[200~y\x1b[201~\r")).toEqual(["text:x", "text:y:pasted", "enter"]);
  });

  test("split across chunks, including inside the markers: every byte goes on, in order", () => {
    const bytes = "\x1b[200~ab\x1b[A\x1b\rcd\x1b[201~e";
    for (let i = 1; i < bytes.length; i++) {
      const keys = decode([bytes.slice(0, i), bytes.slice(i)]);
      expect(keys.map((k) => k.raw).join("")).toBe(bytes);
      expect(keys.filter((k) => !k.pasted).map((k) => k.name)).toEqual(["text"]);
      expect(keys.filter((k) => k.pasted).map((k) => k.text).join("")).toBe("ab\x1b[A\x1b\rcd");
    }
  });

  test("an empty paste", () => {
    expect(raws("\x1b[200~\x1b[201~")).toBe("\x1b[200~\x1b[201~");
  });

  test("an open paste waits for its end (flush leaves it)", () => {
    const d = createKeyDecoder("ctrl+\\");
    expect(d.feed("\x1b[200~ab\x1b[20")).toEqual([{ name: "text", raw: "\x1b[200~ab", text: "ab", pasted: true }]);
    expect(d.flush()).toEqual([]);
    expect(d.feed("1~\r")).toEqual([
      { name: "text", raw: "\x1b[201~", text: "", pasted: true },
      { name: "enter", raw: "\r" },
    ]);
  });

  test("a paste whose end marker never comes is over after PASTE_IDLE_MS without input", () => {
    let t = 0;
    const d = createKeyDecoder("ctrl+\\", () => t);
    expect(d.feed("\x1b[200~ab")).toEqual([{ name: "text", raw: "\x1b[200~ab", text: "ab", pasted: true }]);
    // Still arriving: part of the paste, however long it takes overall.
    t += PASTE_IDLE_MS - 1;
    expect(d.feed("\x1c\r").map(label)).toEqual(["text:\x1c\r:pasted"]);
    t += PASTE_IDLE_MS - 1;
    expect(d.feed("c\x1b[20").map(label)).toEqual(["text:c:pasted"]);
    // Then a pause: the next keys are typed again; the held bytes go on as the paste's last piece.
    t += PASTE_IDLE_MS;
    const k = d.feed("\x1c");
    expect(k).toEqual([
      { name: "text", raw: "\x1b[20", text: "\x1b[20", pasted: true },
      { name: "return-key", raw: "\x1c" },
    ]);
  });

  test("BUG-171/F: an end marker lost while the user keeps typing: the return key pressed on its own still ends the paste", () => {
    let t = 0;
    const d = createKeyDecoder("ctrl+\\", () => t);
    d.feed("\x1b[200~ab");
    // Typing on, never a PASTE_IDLE_MS pause: still the paste.
    for (const ch of "hello") {
      t += 150;
      expect(d.feed(ch).map(label)).toEqual([`text:${ch}:pasted`]);
    }
    // The return key in a read of its own after a pause: the paste ends, the key is Gluon's.
    t += PASTE_KEY_GAP_MS;
    expect(d.feed("\x1c").map(label)).toEqual(["return-key"]);
    expect(d.feed("x").map(label)).toEqual(["text:x"]);
    // In the kitty encoding too.
    const k = createKeyDecoder("ctrl+\\", () => t);
    k.feed("\x1b[200~ab");
    t += PASTE_KEY_GAP_MS;
    expect(k.feed("\x1b[92;5u").map(label)).toEqual(["return-key"]);
    // win32-input-mode: the paste's brackets as characters, the key a real key-down (VK_OEM_5 with Ctrl).
    const w = createKeyDecoder("ctrl+\\", () => t);
    w.feed(chars("\x1b[200~") + "\x1b[65;30;97;1;0;1_");
    t += PASTE_KEY_GAP_MS;
    const wk = w.feed("\x1b[220;43;28;1;8;1_");
    expect(wk.map(label)).toEqual(["return-key"]);
    // A return key byte inside a burst stays the paste's.
    const b = createKeyDecoder("ctrl+\\", () => t);
    b.feed("\x1b[200~ab");
    t += PASTE_KEY_GAP_MS - 1;
    expect(b.feed("\x1c").map(label)).toEqual(["text:\x1c:pasted"]);
  });

  test("BUG-171/F: a paste open for PASTE_MAX_MS ends at the next read after a pause", () => {
    let t = 0;
    const d = createKeyDecoder("ctrl+\\", () => t);
    d.feed("\x1b[200~a");
    while (t + 500 < PASTE_MAX_MS) {
      t += 500;
      expect(d.feed("b").map(label)).toEqual(["text:b:pasted"]);
    }
    t = PASTE_MAX_MS;
    expect(d.feed("\r").map(label)).toEqual(["enter"]);
  });

  test("BUG-172/F: unbracketed — a paste's bytes without its markers, in every piece; anything else as it is", () => {
    expect(unbracketed(decode("\x1b[200~/clear\r\x1b[201~")[0]!)).toBe("/clear\r");
    const d = createKeyDecoder("ctrl+\\");
    const pieces = [...d.feed("\x1b[200~ab"), ...d.feed("\x1ccd"), ...d.feed("e\x1b[201~f")];
    expect(pieces.map(unbracketed)).toEqual(["ab", "\x1ccd", "e", "f"]);
    expect(unbracketed(decode("\x1b[200~\x1b[201~")[0]!)).toBe("");
    expect(unbracketed({ name: "text", raw: "x", text: "x" })).toBe("x");
    // win32-input-mode: the key's bytes aren't the markers around its text; they go as they are.
    const w = decode(chars("\x1b[200~") + "\x1b[65;30;97;1;0;1_" + chars("\x1b[201~"));
    expect(w.map(unbracketed).join("")).toBe(w.map((k) => k.raw).join(""));
  });

  test("the same in win32-input-mode, the paste's brackets as characters with no virtual key", () => {
    let t = 0;
    const d = createKeyDecoder("ctrl+\\", () => t);
    const a = "\x1b[65;30;97;1;0;1_";
    const enter = "\x1b[13;28;13;1;0;1_";
    expect(d.feed(chars("\x1b[200~") + a).map(label)).toEqual(["text:a:pasted"]);
    t += PASTE_IDLE_MS - 1;
    expect(d.feed(enter).map(label)).toEqual(["text:\r:pasted"]);
    expect(d.feed(chars("\x1b[2")).map(label)).toEqual([]);
    t += PASTE_IDLE_MS;
    const k = d.feed(enter);
    expect(k.map(label)).toEqual(["text:\x1b[2:pasted", "enter"]);
    expect(k.map((x) => x.raw).join("")).toBe(chars("\x1b[2") + enter);
  });
});

test("every byte of a mixed stream comes out again, in order, however it is split", () => {
  const bytes =
    "a\x1b[A\x1b[92;5u\x1b]11;rgb:1/2/3\x07é\x1b[<0;1;2M\x1b[65;30;97;1;0;1_\x1b[200~p\x1b[201~\r\x1bOB" +
    "\x1b[1;3C\x1b\x1b[5~\x1b[5;2:1~\x1b[M !!\x1b[32;4;5M\x1b[I\x1b[?62;22c\x1b[12;40R\x1b[37;75;0;1;258;1_\x1b[6;3~\x1c";
  const want = names(bytes);
  expect(want).toEqual([
    "text:a", "up", "return-key", "reply", "text:é", "mouse", "text:a", "text:p:pasted", "enter", "down",
    "alt-right", "escape", "other", "scroll-up", "mouse", "mouse", "focus", "reply", "reply", "alt-left", "other", "return-key",
  ]);
  for (let i = 1; i < bytes.length; i++)
    for (let j = i; j < bytes.length; j += 7) {
      const parts = [bytes.slice(0, i), bytes.slice(i, j), bytes.slice(j)];
      expect(raws(parts)).toBe(bytes);
      expect(names(parts)).toEqual(want);
    }
});

describe("a modifier alone", () => {
  test("BUG-283/keys: win32 Shift/Ctrl/Caps Lock down and kitty's modifier keys are modifier-only; characters, arrows, the home key, a paste and an empty key-up are not", () => {
    const only = (bytes: string) => decode(bytes).map(isModifierOnly);
    expect(only("\x1b[17;29;0;1;8;1_\x1b[16;42;0;1;16;1_\x1b[20;58;0;1;0;1_")).toEqual([true, true, true]);
    expect(only("\x1b[57442;5u\x1b[57441;2u\x1b[57454;1u\x1b[57442;1:3u")).toEqual([true, true, true, true]);
    expect(only("a\x1b[D\x1b[1;3D\x1c\x1b[92;5u\x1b[200~a\x1b[201~\x1b[57441u\x1b[57455u")).toEqual([false, false, false, false, false, false, true, false]);
    expect(only("\x1b[37;75;0;1;0;1_\x1b[220;43;28;1;8;1_\x1b[65;30;97;1;0;1_")).toEqual([false, false, false]);
    expect(isModifierOnly({ name: "other", raw: "" })).toBe(false);
  });
});
