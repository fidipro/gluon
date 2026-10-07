/**
 * BUG-615 (QA-perf-01): `patches/string-width@8.3.0.patch` puts a cheap pre-check before string-width's
 * `/^\p{RGI_Emoji}$/v` (49 us per cluster, run by Ink for every box glyph of every frame). The pre-check
 * must change no width. Here the patched module is compared with the same source with the pre-check
 * reverted (the unpatched one), over a wide corpus; the `@full` test covers every code point.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dir, "..");
const patchedFile = join(root, "node_modules", "string-width", "index.js");
const patchedSource = readFileSync(patchedFile, "utf8");
const CALL = "(canBeRgiEmoji(segment) && rgiEmojiRegex.test(segment))";

type Width = (input: string, options?: { ambiguousIsNarrow?: boolean; countAnsiEscapeCodes?: boolean }) => number;

/** The unpatched module: the installed source with the pre-check call reverted, its imports made absolute. */
async function loadUnpatched(): Promise<Width> {
  expect(patchedSource).toContain(CALL);
  const abs = (name: string) => pathToFileURL(Bun.resolveSync(name, join(root, "node_modules", "string-width"))).href;
  const source = patchedSource
    .replace(CALL, "rgiEmojiRegex.test(segment)")
    .replace("from 'strip-ansi'", `from '${abs("strip-ansi")}'`)
    .replace("from 'get-east-asian-width'", `from '${abs("get-east-asian-width")}'`);
  const dir = mkdtempSync(join(tmpdir(), "gluon-sw-"));
  try {
    const file = join(dir, "string-width-unpatched.mjs");
    writeFileSync(file, source);
    return (await import(pathToFileURL(file).href)).default as Width;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const patched = (await import("string-width")).default as Width;
const unpatched = await loadUnpatched();

const rgi = /^\p{RGI_Emoji}$/v;
const precheck = /\p{Emoji}/u;
/** The pre-check as the patch writes it. */
const canBe = (s: string) => (s.length > 1 || s.charCodeAt(0) > 0x7f) && precheck.test(s);

const FE0F = "️";
const FE0E = "︎";
const ZWJ = "‍";
const KEYCAP = "⃣";
const SKIN = [0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff].map((c) => String.fromCodePoint(c));

function* codePoints(from: number, to: number) {
  for (let cp = from; cp <= to; cp++) if (cp < 0xd800 || cp > 0xdfff) yield cp;
}

/** Seeded PRNG (mulberry32): the corpus is the same on every run. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sequences built the way Unicode builds RGI emoji (and near misses), from every emoji code point. */
function emojiSequences(emoji: string[], rand: () => number, pairs: number): string[] {
  const out: string[] = [];
  for (const e of emoji) {
    out.push(e + FE0F, e + FE0E, e + KEYCAP, e + FE0F + KEYCAP, e + ZWJ, ZWJ + e);
    for (const s of SKIN) out.push(e + s);
  }
  for (let i = 0; i < pairs; i++) {
    const a = emoji[Math.floor(rand() * emoji.length)]!;
    const b = emoji[Math.floor(rand() * emoji.length)]!;
    out.push(a + ZWJ + b, a + FE0F + ZWJ + b + FE0F, a + SKIN[i % 5] + ZWJ + b, a + ZWJ + b + ZWJ + a);
  }
  // Keycaps, flags (every regional-indicator pair), tag sequences, real ZWJ families.
  for (const k of "0123456789#*") out.push(k + FE0F + KEYCAP, k + KEYCAP, k + FE0F, k);
  for (let a = 0; a < 26; a++)
    for (let b = 0; b < 26; b++) out.push(String.fromCodePoint(0x1f1e6 + a, 0x1f1e6 + b));
  for (let a = 0; a < 26; a++) out.push(String.fromCodePoint(0x1f1e6 + a), String.fromCodePoint(0x1f1e6 + a, 0x1f1e6 + a, 0x1f1e6 + a));
  const tags = (word: string) => String.fromCodePoint(0x1f3f4, ...[...word].map((c) => 0xe0000 + c.charCodeAt(0)), 0xe007f);
  out.push(tags("gbeng"), tags("gbsct"), tags("gbwls"), tags("gbxyz"), tags("us"), String.fromCodePoint(0x1f3f4, 0xe007f));
  out.push("👨‍👩‍👧‍👦", "🏳️‍🌈", "🧑🏽‍💻", "❤️‍🔥", "👩🏿‍🤝‍👨🏻", "🏴‍☠️", "👁️‍🗨️", "🐻‍❄️", "1️⃣", "#️⃣", "*️⃣", "🇺🇸", "🇮🇱", "©️", "®️", "™️", "☺️", "☺︎");
  return out;
}

/** Strings of what Gluon draws and what users type: box glyphs, CJK, jamo, marks, emoji, controls. */
function mixedStrings(rand: () => number, count: number): string[] {
  const pools: string[][] = [
    [..."abc xyzABC 019#*.,:;-_/\\()[]{}"],
    [..."─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▀▄█▌▐░▒▓■□▪▫▲▶▼◀◆◇○●◉◦•·…→←↑↓✓✗✔✘❯❮⏎⎿"],
    [..."日本語中文汉字한국어ひらがなカタカナｱｲｳﾞﾟｰＡＢＣ１２３　"],
    ["ᄀ", "ᅡ", "ᆨ", "ꥠ", "ힰ", "ퟋ", "가", "각", "ᄀ", "ᅡ"],
    ["́", "̀", "̈", "⃝", "ः", "ा", "é", "ä", "ั", "ก", "​", "­", "⁠", "﻿"],
    ["\t", "\r\n", "\n", "\u001B[31m", "\u001B[0m", "\u0007", "\u009B1m", "\u0085", " "],
    ["🙂", "😀", "👍🏽", "🧑‍💻", "🇮🇱", "1️⃣", "❤️", "❤", "☺", "⌚", "⭐", "✨", "🚀", "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "👨‍👩‍👧", "©", "®", "™", "‼️", "↔️", "▶️", "☑️", "✔️", "©️"],
    ["ǆ", "Æ", "¡", "°", "±", "×", "÷", "Ω", "я", "א", "ع", "ก", "α", "§", "¶", "½"],
  ];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = 1 + Math.floor(rand() * 12);
    let s = "";
    for (let j = 0; j < n; j++) {
      const pool = pools[Math.floor(rand() * pools.length)]!;
      s += pool[Math.floor(rand() * pool.length)]!;
    }
    out.push(s);
  }
  return out;
}

const emojiPoints = [...codePoints(0, 0x10ffff)].filter((cp) => precheck.test(String.fromCodePoint(cp))).map((cp) => String.fromCodePoint(cp));

test("BUG-615/string-width: the pre-check admits every RGI emoji (singles in the emoji blocks and every sequence shape)", () => {
  expect(emojiPoints.length).toBeGreaterThan(1300);
  let matched = 0;
  const check = (s: string) => {
    if (!rgi.test(s)) return;
    matched++;
    if (!canBe(s)) throw new Error(`RGI emoji rejected by the pre-check: ${[...s].map((c) => c.codePointAt(0)!.toString(16)).join(" ")}`);
  };
  // Every ASCII and Latin-1 single, the BMP below the CJK blocks, the whole of planes 1 (emoji) and the tags.
  for (const ranges of [[0, 0x2fff], [0xfe00, 0xfe0f], [0x1f000, 0x1ffff], [0xe0000, 0xe007f]] as const)
    for (const cp of codePoints(ranges[0], ranges[1])) check(String.fromCodePoint(cp));
  for (const s of emojiSequences(emojiPoints, prng(615), 4000)) check(s);
  // The corpus is not trivial: it holds many real RGI emoji (singles, flags, keycaps, modifiers, ZWJ).
  expect(matched).toBeGreaterThan(2000);
});

test("BUG-615/string-width: patched and unpatched give the same width for the frame's glyphs, CJK, marks, jamo and emoji", () => {
  const rand = prng(616);
  const corpus: string[] = [
    "",
    " ",
    "─".repeat(120),
    "│ " + "a".repeat(40) + " │",
    "╭" + "─".repeat(30) + "╮",
    "1234567890 #*",
    ...emojiSequences(emojiPoints.filter((_, i) => i % 7 === 0), rand, 300),
    ...mixedStrings(rand, 2500),
  ];
  // Every single code point that is not a CJK ideograph block (those are all East Asian wide, no emoji).
  for (const cp of codePoints(0, 0x2fff)) corpus.push(String.fromCodePoint(cp));
  for (const cp of codePoints(0xff00, 0xffff)) corpus.push(String.fromCodePoint(cp));
  for (const cp of codePoints(0x1f000, 0x1faff)) corpus.push(String.fromCodePoint(cp));
  for (const s of corpus) {
    expect(patched(s)).toBe(unpatched(s));
    expect(patched(s, { ambiguousIsNarrow: false })).toBe(unpatched(s, { ambiguousIsNarrow: false }));
  }
}, 20_000); // the unpatched module's slow emoji regex over the whole corpus: about 5 s on a loaded machine, the default limit

test("BUG-615/string-width: the pre-check makes a box-drawing line at least 5x cheaper", () => {
  const line = "─".repeat(120) + "│ done │";
  const time = (f: Width) => {
    for (let i = 0; i < 20; i++) f(line);
    const t = performance.now();
    for (let i = 0; i < 200; i++) f(line);
    return performance.now() - t;
  };
  // Best of 3 to ride out a loaded machine; the real ratio is 10 to 15.
  const ratio = Math.max(...[1, 2, 3].map(() => time(unpatched) / time(patched)));
  expect(ratio).toBeGreaterThan(5);
});

test("BUG-615/string-width @full: the pre-check admits every RGI emoji among all code points (alone, with FE0F, a skin tone) and widths agree", () => {
  // Slow (about 40 s: the regex under test is the slow part). Every code point alone and with FE0F and a skin tone must
  // not be an RGI emoji the pre-check rejects; widths are compared for every one the pre-check admits plus a seeded sample.
  const rand = prng(615_616);
  let matched = 0;
  for (const cp of codePoints(0, 0x10ffff)) {
    const c = String.fromCodePoint(cp);
    for (const s of [c, c + FE0F, c + SKIN[cp % 5]]) {
      if (!rgi.test(s)) continue;
      matched++;
      if (!canBe(s)) throw new Error(`RGI emoji rejected by the pre-check: ${cp.toString(16)}`);
      expect(patched(s)).toBe(unpatched(s));
    }
    if (cp % 97 === 0) expect(patched(c)).toBe(unpatched(c));
  }
  expect(matched).toBeGreaterThan(1400);
  for (const s of mixedStrings(rand, 5000)) expect(patched(s)).toBe(unpatched(s));
  for (const s of emojiSequences(emojiPoints, rand, 20000)) {
    if (rgi.test(s)) expect(canBe(s)).toBe(true);
  }
}, 600_000);

test("BUG-615/string-width: the installed module is the patched one (bun install applied patches/)", () => {
  expect(patchedSource).toContain("canBeRgiEmoji");
  // The implication tests above use their own copy of the pre-check: keep it the patch's.
  expect(patchedSource).toContain("const emojiPrecheckRegex = /\\p{Emoji}/u;");
  expect(patchedSource).toContain("return (segment.length > 1 || segment.charCodeAt(0) > 0x7F) && emojiPrecheckRegex.test(segment);");
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).patchedDependencies["string-width@8.3.0"]).toBe("patches/string-width@8.3.0.patch");
});
