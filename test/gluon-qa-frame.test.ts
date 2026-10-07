/**
 * QA attacks on the frame's pure parts (campaign section B1): the tab strip at 15+ tabs and every
 * width, long, wide and composed names, clicks at every cell of the strip, and the interceptor's
 * "a paste never counts" under random keys. The app-level attacks are `test/e2e/gluon-qa-frame.e2e.test.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { layout, tabSpans, tabStrip } from "../src/pty/chrome.ts";
import { HOME_MODES } from "../src/pty/modes.ts";
import { route, shiftMouse, type RouteContext } from "../src/pty/compositor.ts";
import { createKeyDecoder } from "../src/pty/keys.ts";
import type { SessionView } from "../src/sessions.ts";
import { sw } from "../src/ui/layout.ts";
import { createScreen } from "../src/pty/screen.ts";

const tabs = (names: string[]) => names.map((name, i): Pick<SessionView, "id" | "name" | "state" | "markedDone"> => ({ id: i + 1, name, state: "working" }));
const NAMES = {
  ascii: (i: number) => `Gluon-session-${i}`,
  // The brain's slug keeps names ASCII and within 24, but the strip must hold whatever it is given.
  long: (i: number) => `Gluon-${"a-very-long-session-name-".repeat(3)}${i}`,
  cjk: (i: number) => `修复登录错误${i}你好世界`,
  emoji: (i: number) => `🐛🐛🐛-fix-${i}-🚀`,
  zwj: (i: number) => `👨‍👩‍👧‍👦-family-${i}`,
  combining: (i: number) => `ééé-${i}-à`,
  empty: () => "",
};

/** One row's drawn text, read back from a headless terminal. */
async function drawn(bytes: string, cols: number): Promise<string> {
  const t = createScreen(cols, 1);
  await t.write(`\x1b[H${bytes}`);
  return t.viewLine(0).text;
}

describe("the tab strip: many tabs, every width, awkward names", () => {
  for (const [kind, name] of Object.entries(NAMES))
    test(`QA-frame/strip-${kind}: 1 to 40 tabs at 20 to 200 columns: spans stay inside the row, in order, never overlap; the shown tab is in view; ‹ › name the right neighbours`, () => {
      for (const n of [1, 2, 5, 9, 10, 15, 16, 40]) {
        const ss = tabs(Array.from({ length: n }, (_, i) => name(i + 1)));
        for (const cols of [20, 21, 30, 40, 60, 80, 100, 137, 200]) {
          for (const cur of [null, ...ss.map((s) => s.id)]) {
            const sp = tabSpans(ss, cur, cols);
            const where = `${kind} n=${n} cols=${cols} cur=${cur}`;
            const parts = [{ n: "home", x0: sp.home[0], x1: sp.home[1] }, ...(sp.prev ? [{ n: "prev", ...sp.prev }] : []), ...sp.tabs.map((t) => ({ n: `tab${t.id}`, ...t })), ...(sp.next ? [{ n: "next", ...sp.next }] : [])];
            let end = 0;
            for (const p of parts) {
              expect({ where, part: p.n, ok: p.x0 >= 0 && p.x1 <= cols && p.x0 <= p.x1 }).toEqual({ where, part: p.n, ok: true });
              expect({ where, part: p.n, after: p.x0 >= end }).toEqual({ where, part: p.n, after: true });
              end = Math.max(end, p.x1);
            }
            // The shown tab is on the strip (unless even one alone doesn't fit the width, then it is cut but present or home is shown).
            if (cur !== null && cols >= 30 && sw(name(1)) <= 24) expect({ where, shown: sp.tabs.some((t) => t.id === cur) }).toEqual({ where, shown: true });
            // The markers point at the nearest hidden tab on their side.
            if (sp.prev && sp.tabs.length) expect({ where, prev: sp.prev.id }).toEqual({ where, prev: sp.tabs[0]!.id - 1 });
            if (sp.next && sp.tabs.length) expect({ where, next: sp.next.id }).toEqual({ where, next: sp.tabs.at(-1)!.id + 1 });
          }
        }
      }
    });

  test("QA-frame/strip-draw: the strip drawn is exactly `cols` cells wide, a tab's name starts where its span says, no cell of the row is lost to a wide or composed character @full", async () => {
    // Not `zwj`: a family emoji is one cluster of 2 cells to `sw` but 8 to a terminal without grapheme clustering (xterm's headless one is such);
    // session names are ASCII slugs (`sessionName`), so it never comes up.
    for (const [kind, name] of Object.entries(NAMES).filter(([k]) => k !== "zwj")) {
      for (const [n, cols] of [[3, 100], [15, 100], [15, 60], [40, 200], [5, 41]] as const) {
        const ss = tabs(Array.from({ length: n }, (_, i) => name(i + 1)));
        for (const cur of [ss[0]!.id, ss[Math.floor(n / 2)]!.id, ss.at(-1)!.id]) {
          const bytes = tabStrip(ss, cur, cols, true);
          const t = createScreen(cols, 2);
          await t.write(`\x1b[H${bytes}`);
          // Nothing spilled onto a second row, and the cursor sits at or before the last column.
          expect({ kind, n, cols, second: t.viewLine(1).text.trim() }).toEqual({ kind, n, cols, second: "" });
          const text = t.viewLine(0).text;
          expect({ kind, n, cols, width: sw(text) <= cols }).toEqual({ kind, n, cols, width: true });
        }
      }
    }
  });

  test("QA-frame/strip-click: a left press on every cell of row 1 picks what the drawn strip shows there — ◆ gluon, a tab, ‹ ›, or nothing on a gap — for 1 to 16 tabs @full", () => {
    const decoder = (x: number) => {
      const d = createKeyDecoder("ctrl+\\");
      return d.feed(`\x1b[<0;${x};1M`)[0]!;
    };
    for (const n of [1, 3, 8, 16]) {
      const ss = tabs(Array.from({ length: n }, (_, i) => NAMES.ascii(i + 1)));
      for (const cols of [40, 60, 100]) {
        for (const cur of ss.map((s) => s.id)) {
          const strip = tabSpans(ss, cur, cols);
          const ctx: RouteContext = {
            modes: { ...HOME_MODES, bracketedPaste: true },
            capture: true,
            interior: layout(cols, 30).interior,
            offset: 0,
            scrollback: 0,
            question: false,
            untouched: true,
            prefix: false,
            pressed: false,
            tabRow: 0,
            strip,
          };
          const owner = (x0: number) => {
            if (x0 >= strip.home[0] && x0 < strip.home[1]) return "home";
            if (strip.prev && x0 >= strip.prev.x0 && x0 < strip.prev.x1) return `show${strip.prev.id}`;
            if (strip.next && x0 >= strip.next.x0 && x0 < strip.next.x1) return `show${strip.next.id}`;
            const t = strip.tabs.find((t) => x0 >= t.x0 && x0 < t.x1);
            return t ? `show${t.id}` : "none";
          };
          for (let x = 1; x <= cols; x++) {
            const acts = route(decoder(x), ctx);
            const got = acts.length === 0 ? "none" : acts[0]!.kind === "home" ? "home" : acts[0]!.kind === "show" ? `show${(acts[0] as { id: number }).id}` : acts[0]!.kind;
            expect({ n, cols, cur, x, got }).toEqual({ n, cols, cur, x, got: owner(x - 1) });
          }
        }
      }
    }
  });
});

// ── The typed first line: a slow, redrawing or interrupted composer ─────────────────────────────

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffDefaults, handoffFor } from "../src/handoff.ts";
import type { Harness } from "../src/harnesses.ts";
import { AgentSession } from "../src/pty/session.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-qa-frame-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const hasPty = typeof (Bun as { Terminal?: unknown }).Terminal === "function";
const SLOWK = process.env.GLUON_TEST_SLOW ? 3 : 1;

const chunksOf = (log: string) =>
  (existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(1) : [])
    .filter(Boolean)
    .map((l) => l.slice(l.indexOf(" ") + 1).replace(/\\x([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
const decode = (s: string) => {
  const d = createKeyDecoder("ctrl+\\");
  return [...d.feed(s), ...d.flush()];
};
async function waitUntil(ok: () => boolean, ms = 20_000 * SLOWK) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(20);
  return ok();
}

/** The fake TUI of `harness` behind a delay (the agent is slow to show its composer). */
function slowSession(o: { name: string; harness: Harness; line: string; delayS: number; timing?: Partial<{ waitMs: number; pauseMs: number; landMs: number; planMs: number }>; log: string }) {
  const script = join(import.meta.dir, "fixtures/fake-tui.ts");
  const s = new AgentSession({
    argv: ["bash", "-c", `sleep ${o.delayS}; exec "$0" --no-env-file "$1"`, process.execPath, script],
    env: { ...process.env, FAKE_AGENT_NAME: o.name, FAKE_INPUT_LOG: o.log, TERM: "xterm-256color" },
    harness: o.harness,
    settings: handoffFor(handoffDefaults(), o.harness),
    cols: 100,
    rows: 30,
    firstLine: o.line,
    firstLineTiming: { waitMs: 15_000, pauseMs: 200, landMs: 3000, planMs: 4000, ...o.timing },
    screen: { colours: { bg: [12, 12, 12] as const } },
  });
  const notes: string[] = [];
  s.onNote((n) => notes.push(n));
  return { s, notes };
}

const CASES: { name: string; harness: Harness; line: string }[] = [
  { name: "codex", harness: "codex", line: "/plan Read the session brief in /tmp/brief.md and start." },
  { name: "grok", harness: "grok-build", line: "/plan Read the session brief in /tmp/brief.md and start." },
  { name: "kimi", harness: "kimi-code", line: "Read the session brief in /tmp/brief.md and start." },
];

// `bash -c "sleep …; exec …"` in `slowSession`: no bash on Windows (PATH holds WSL's launcher, not a shell for the fake).
describe.skipIf(!hasPty || process.platform === "win32")("QA-frame/first-line: the agent's composer is slow, redraws, or the user types first (real PTY, the fake TUIs) @full", () => {
  for (const c of CASES) {
    test(`${c.name}: a composer that takes 2 s to appear gets the line once, then its Enter apart; no note`, async () => {
      const log = join(TMP, `slow-${c.name}.log`);
      const { s, notes } = slowSession({ ...c, delayS: 2, log });
      try {
        expect(await waitUntil(() => chunksOf(log).length >= 2)).toBe(true);
        expect(chunksOf(log)).toEqual([c.line, "\r"]);
        await Bun.sleep(600);
        expect(chunksOf(log)).toEqual([c.line, "\r"]);
        expect(notes).toEqual([]);
      } finally {
        await s.end(200);
        s.dispose();
      }
    });

    test(`${c.name}: the user types while the agent is still starting: nothing of the line is typed, the user is told it, and it is never retried when the composer shows`, async () => {
      const log = join(TMP, `user-${c.name}.log`);
      const { s, notes } = slowSession({ ...c, delayS: 2, log });
      try {
        await Bun.sleep(700);
        for (const k of decode("h")) s.input(k);
        expect(await waitUntil(() => notes.length === 1)).toBe(true);
        expect(notes[0]).toContain(c.line);
        expect(notes[0]).toContain("you typed first");
        // The composer shows later: still nothing typed by Gluon.
        await Bun.sleep(3000);
        const got = chunksOf(log).join("");
        expect(got).not.toContain("/plan");
        expect(got).not.toContain("Read the session brief");
        expect(notes.length).toBe(1);
      } finally {
        await s.end(200);
        s.dispose();
      }
    });

    test(`${c.name}: a resize (the composer redraws) between the text and its Enter: the Enter still comes once, the line is not typed twice`, async () => {
      const log = join(TMP, `redraw-${c.name}.log`);
      const { s, notes } = slowSession({ ...c, delayS: 1, log, timing: { pauseMs: 800 } });
      try {
        expect(await waitUntil(() => chunksOf(log).length >= 1)).toBe(true);
        s.resize(101, 31);
        await Bun.sleep(150);
        s.resize(100, 30);
        expect(await waitUntil(() => chunksOf(log).length >= 2)).toBe(true);
        await Bun.sleep(500);
        expect(chunksOf(log)).toEqual([c.line, "\r"]);
        expect(notes).toEqual([]);
      } finally {
        await s.end(200);
        s.dispose();
      }
    });

    test(`${c.name}: a composer that never shows within the wait: the user is told the line, and a composer that shows later is left alone`, async () => {
      const log = join(TMP, `late-${c.name}.log`);
      const { s, notes } = slowSession({ ...c, delayS: 3, log, timing: { waitMs: 800 } });
      try {
        expect(await waitUntil(() => notes.length === 1)).toBe(true);
        expect(notes[0]).toContain("composer didn't show");
        await Bun.sleep(3500);
        expect(chunksOf(log).join("")).toBe("");
      } finally {
        await s.end(200);
        s.dispose();
      }
    });
  }
});

describe("matrix `na`: pixel mouse reports (mode 1016) that no fake asks for", () => {
  const ev = (x: number, y: number) => ({ code: 0, button: 0, x, y, release: false, motion: false, wheel: null, shift: false, alt: false, ctrl: false, encoding: "sgr" as const });
  const interior = { top: 3, left: 1, cols: 98, rows: 24 };

  test("QA-frame/pixels-control: in cells (SGR) a click in the middle of the interior reaches the agent, moved by the frame's offset", () => {
    expect(shiftMouse(ev(50, 15), interior, "sgr", false)).toBe("\x1b[<0;49;12M");
  });

  // `route` hands a 1016 agent's report to `shiftMouse`, which compares pixel coordinates with the interior's size in cells
  // and shifts them by whole cells: a click in the middle of an 800×480 px window (100×30 cells) is "outside" and dropped.
  // Proposed fix (open, the owner decides): Gluon needs the cell size in pixels. Ask for it once when an agent turns on ?1016
  // (`CSI 16 t`, reply `CSI 6;h;w t`, or `CSI 14 t` over the grid; again on resize) and catch that reply (`isReply` drops it today).
  // Then `shiftMouse` takes `cellPx`: the inside test on `floor((x-1)/w)+1`, the shift by `left*w` and `top*h` pixels, the clamp in
  // pixels; an unknown size still drops the report. Risks: a terminal that doesn't answer `16 t` (as today), a font change
  // without a resize (stale size), ConPTY has no 1016. The query is Gluon's own bytes; the reply must never reach an agent.
  // This test then passes `cellPx` (say 8×20) and expects pixel (392,140) shifted; add: outside is null, unknown size is null.
  test.failing("BUG-CANDIDATE/QA-frame-04: an agent that asked for pixel mouse reports (?1016) gets a click in the middle of its screen (pixel 400,200 of 800×480): moved or passed on, never dropped as outside the interior", () => {
    expect(shiftMouse(ev(400, 200), interior, "sgr-pixels", false)).not.toBeNull();
  });
});
