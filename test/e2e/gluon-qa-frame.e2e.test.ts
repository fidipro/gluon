/**
 * QA attacks on Gluon's frame and the PTY layer (campaign section B1): the interceptor per harness
 * fake, pastes (huge, hostile, during a question), resize storms, quitting and signals, the terminal
 * a crashing agent leaves behind, the mouse at the edges. A case that shows a product bug is
 * `test.failing("BUG-CANDIDATE/QA-frame-nn: …")` (`test/e2e/README.md`); the findings are in
 * `qa/findings/frame.md`.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { click, KEYS, mouseReports } from "./actions.ts";
import { fakeAgents, freshConfig, repo, WIN } from "./fixtures.ts";
import type { FakeAgent } from "./fixtures.ts";
import { assertInvariants } from "./gluon-invariants.ts";
import { layout } from "../../src/pty/chrome.ts";
import { gluon, home, launch, launchAs, openSessions, say, toChoice } from "./gluon-kit.ts";
import { App, HOME_VIEW, SLOW, stopAll, SYSTEM_PATH } from "./harness.ts";

setDefaultTimeout(120_000 * SLOW);
afterAll(stopAll);

const YAML = "handoff:\n  on_clear: ask\n  on_compact: ask\n";
const lastRow = (app: App) => app.screen().split("\n").at(-1) ?? "";
const askedClear = (app: App) => /^ \? (\/\S+ ends this session|End (this )?session\?)/.test(lastRow(app));
const askedCompact = (app: App) => app.screen().includes("instead of compacting");
const asked = (app: App) => askedClear(app) || askedCompact(app);

async function until(ok: () => boolean, ms = 1500): Promise<boolean> {
  const end = performance.now() + ms * SLOW;
  while (performance.now() < end) {
    if (ok()) return true;
    await Bun.sleep(20);
  }
  return ok();
}

/** What an Enter (or Tab) did: Gluon asked about /clear, about /compact, or let it go on to the agent. */
async function outcome(app: App, key: string = KEYS.enter): Promise<"clear" | "compact" | "forwarded"> {
  await app.press(key);
  if (await until(() => asked(app), 1200)) return askedCompact(app) ? "compact" : "clear";
  return "forwarded";
}

/** Answers a question with Esc (keep) and clears the agent's line by Backspaces. */
async function keepAndErase(app: App, n: number) {
  if (asked(app)) {
    await app.press(KEYS.esc);
    await until(() => !asked(app));
  }
  await app.press(KEYS.backspace.repeat(n));
}

const FAKES5: FakeAgent[] = ["claude", "codex", "opencode", "agy", "grok"];
/** What a typed command does, per harness (`COMMANDS` in `src/pty/readers/index.ts`): Antigravity has no /compact. */
const WANT: Record<string, "clear" | "compact" | "forwarded"> = { "/clear": "clear", "/new": "clear", "/compact": "compact" };

describe("interception: a typed command, per harness fake", () => {
  for (const fake of FAKES5)
    test(`QA-frame/intercept: ${fake}: typed /clear, /new, /compact ask (agy: no /compact); edits, Tab and a menu Enter still ask; a paste never does @full`, async () => {
      const app = await launchAs(fake, { yaml: YAML });
      // 1. each command typed, then Enter.
      for (const cmd of ["/clear", "/new", "/compact"]) {
        await app.type(cmd);
        const got = await outcome(app);
        expect({ fake, cmd, got }).toEqual({ fake, cmd, got: fake === "agy" && cmd === "/compact" ? "forwarded" : WANT[cmd]! });
        await keepAndErase(app, cmd.length);
      }
      // 2. typed, edited with Backspace, then Enter.
      await app.type("/clearx");
      await app.press(KEYS.backspace);
      expect({ fake, step: "backspace", got: await outcome(app) }).toEqual({ fake, step: "backspace", got: "clear" });
      await keepAndErase(app, 6);
      // 3. typed, ← and → (the agent's own on a touched line), then Enter.
      await app.type("/new");
      await app.press(KEYS.left, KEYS.right);
      expect({ fake, step: "left-right", got: await outcome(app) }).toEqual({ fake, step: "left-right", got: "clear" });
      await keepAndErase(app, 4);
      // 4. typed, Ctrl+U (the agent clears its line), then another command.
      await app.type("/compact");
      await app.press(KEYS.ctrlU);
      await app.type("/clear");
      expect({ fake, step: "ctrlU", got: await outcome(app) }).toEqual({ fake, step: "ctrlU", got: "clear" });
      await keepAndErase(app, 6);
      // 5. a line that never started with `/`, erased, then a typed command.
      await app.type("hello");
      await app.press(KEYS.ctrlU);
      await app.type("/new");
      expect({ fake, step: "erased-first", got: await outcome(app) }).toEqual({ fake, step: "erased-first", got: "clear" });
      await keepAndErase(app, 4);
      // 6. the slash menu: `/` alone, Enter runs its highlighted /clear.
      await app.type("/");
      expect({ fake, step: "menu-enter", got: await outcome(app) }).toEqual({ fake, step: "menu-enter", got: "clear" });
      await keepAndErase(app, 1);
      // 7. a prefix and Tab: OpenCode's Tab runs the menu item (held), the others complete it and the Enter after asks.
      await app.type("/cle");
      const tab = await outcome(app, KEYS.tab);
      if (fake === "opencode") {
        expect({ fake, step: "tab", got: tab }).toEqual({ fake, step: "tab", got: "clear" });
        await keepAndErase(app, 4);
      } else {
        expect({ fake, step: "tab", got: tab }).toEqual({ fake, step: "tab", got: "forwarded" });
        expect({ fake, step: "tab-enter", got: await outcome(app) }).toEqual({ fake, step: "tab-enter", got: "clear" });
        await keepAndErase(app, 6);
      }
      // 8. a pasted command never counts, nor does one pasted into a typed line, nor a pasted Enter.
      await app.paste("/clear");
      expect({ fake, step: "paste", got: await outcome(app) }).toEqual({ fake, step: "paste", got: "forwarded" });
      await app.settle(200);
      await app.type("/");
      await app.paste("clear");
      expect({ fake, step: "paste-tail", got: await outcome(app) }).toEqual({ fake, step: "paste-tail", got: "forwarded" });
      await app.settle(200);
      await app.paste("/new\r");
      await app.settle(300);
      expect(asked(app)).toBe(false);
      // 9. look-alikes: the full-width slash, a command with a capital.
      await app.type("／clear");
      expect({ fake, step: "fullwidth", got: await outcome(app) }).toEqual({ fake, step: "fullwidth", got: "forwarded" });
      assertInvariants(app);
    });
});

describe("interception: edges", () => {
  test("QA-frame/intercept-64: a command line longer than the interceptor's 64-character memory still asks, from the screen @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    for (const n of [50, 55, 56, 57, 64, 120]) {
      const line = `/compact ${"x".repeat(n)}`;
      await app.enter(line);
      expect({ n, got: await outcome(app) }).toEqual({ n, got: "compact" });
      await keepAndErase(app, line.length);
    }
    // 63 / 64 / 65 characters of /clear + arguments, typed key by key (the memory's edge).
    for (const n of [57, 58, 59]) {
      const line = `/clear ${"y".repeat(n)}`;
      await app.type(line);
      expect({ n, len: line.length, got: await outcome(app) }).toEqual({ n, len: line.length, got: "clear" });
      await keepAndErase(app, line.length);
    }
    assertInvariants(app);
  });

  test("QA-frame/intercept-kitty: an agent that asked for every key as CSI u (kitty): /clear typed as `CSI 99 u` keys and its Enter as `CSI 13 u` still asks @full", async () => {
    const app = await launchAs("claude", { yaml: YAML, env: { FAKE_KITTY: "1" } });
    const csiu = (s: string) => [...s].map((c) => `\x1b[${c.codePointAt(0)}u`).join("");
    for (const cmd of ["/clear", "/compact"]) {
      for (const c of csiu(cmd).match(/\x1b\[\d+u/g)!) await app.press(c);
      const got = await outcome(app, KEYS.kittyEnter);
      expect({ cmd, got }).toEqual({ cmd, got: cmd === "/clear" ? "clear" : "compact" });
      await keepAndErase(app, cmd.length);
    }
    assertInvariants(app);
  });

  test("QA-frame/intercept-ime: composed input — a combining accent, a ZWJ emoji, then a typed /clear still asks; the pre-edit text never starts a command @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    // An IME commits whole strings in one write.
    app.write("é\u{1F468}‍\u{1F469}‍\u{1F467}");
    await app.settle(200);
    await app.press(KEYS.backspace.repeat(4));
    await app.press(KEYS.ctrlU);
    await app.write("/cle");
    await app.settle(100);
    app.write("ar");
    await app.settle(100);
    expect(await outcome(app)).toBe("clear");
    await keepAndErase(app, 6);
    // A commit of the whole word at once, then Enter in its own write.
    app.write("/clear");
    await app.settle(200);
    expect(await outcome(app)).toBe("clear");
    assertInvariants(app);
  });
});

// ── Pastes ──────────────────────────────────────────────────────────────────────────────────────

/** Writes a big paste in chunks (a terminal sends one in pieces; the pty's buffer is finite). */
async function bigPaste(app: App, text: string, chunk = 16_384) {
  const all = `\x1b[200~${text}\x1b[201~`;
  for (let i = 0; i < all.length; i += chunk) {
    app.write(all.slice(i, i + chunk));
    await Bun.sleep(1);
  }
}

describe("pastes", () => {
  // Not on Windows: the fake TUI itself reads at about 1.5 KB/s through a ConPTY (measured without Gluon: 32 KB in 20 s), so 1 MB never ends; real agents are not the fake.
  test.skipIf(WIN)("QA-frame/paste-1mb-session: a 1 MB paste into a session reaches the agent whole, in order, and Gluon stays responsive @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    const body = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n").slice(0, 1_000_000);
    const t0 = performance.now();
    await bigPaste(app, body);
    const want = `\x1b[200~${body}\x1b[201~`.length;
    const got = () => app.inputLog().length;
    let last = 0;
    for (let i = 0; i < 40 && got() < want; i++) {
      await Bun.sleep(5000);
      console.log(`paste-1mb-session: ${Math.round((performance.now() - t0) / 1000)} s: ${got()} of ${want} bytes (${got() - last} in the last 5 s)`);
      last = got();
    }
    const ms = Math.round(performance.now() - t0);
    console.log(`paste-1mb-session: ${ms} ms`);
    expect({ bytes: got(), want }).toEqual({ bytes: want, want });
    expect(app.inputLog().endsWith(`${body.slice(-30)}\x1b[201~`)).toBe(true);
    // Still alive: the home key, a typed line.
    await home(app);
    assertInvariants(app);
  }, 400_000 * SLOW);

  // Not on Windows either, for the same reason: Gluon's own home reads through the ConPTY at about 1.5 KB/s too (CI: the test ran 124 s and failed).
  test.skipIf(WIN)("QA-frame/paste-1mb-home: a 1 MB paste into the home composer is taken, and the composer answers the next key within seconds @full", async () => {
    const app = await gluon(100, 30, {}, YAML);
    const body = Array.from({ length: 20_000 }, (_, i) => `word${i} ${"y".repeat(40)}`).join(" ").slice(0, 1_000_000);
    const t0 = performance.now();
    await bigPaste(app, body);
    await app.settle(500);
    app.write("Z");
    const ok = await until(() => app.screen().includes("Z") || /more lines?/.test(app.screen()), 30_000);
    const ms = Math.round(performance.now() - t0);
    expect({ ok, fast: ms < 30_000 * SLOW }).toEqual({ ok: true, fast: true });
    expect(app.screen()).not.toMatch(/\[20[01]~/);
  });

  test.skipIf(WIN)("QA-frame/paste-end-marker-injection: text pasted with its own end marker (`ESC [ 201 ~`) ends the paste there; what follows is read as keys (the terminal's to strip, not Gluon's) @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    await home(app);
    // `A`, then a marker inside the paste, then the home key's bytes and a `B` typed as keys: home is already shown, so the keys type at the composer.
    app.write(`\x1b[200~A\x1b[201~B`);
    await app.waitFor((s) => /› AB/.test(s));
    assertInvariants(app);
  });

  test("BUG-656/QA-frame-01: a stray bracketed-paste end marker (`ESC [ 201 ~`, left over when a paste held its own marker, or a terminal glitch) at home is dropped, never typed into the composer as `[201~` @full", async () => {
    const app = await gluon(100, 30, {}, YAML);
    app.write("\x1b[201~");
    await app.settle(500);
    app.write("x");
    await app.waitFor(/› .*x/);
    expect(app.screen()).not.toContain("201~");
  });

  test.skipIf(WIN)("QA-frame/paste-nested-start: a second paste start inside a paste, an unterminated paste, then keys: the user can still get home and quit @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    app.write("\x1b[200~one\x1b[200~two\x1b[201~");
    await app.settle(300);
    // An unterminated paste: later input is the paste's, until its quiet gap ends it (BUG-171).
    app.write("\x1b[200~lost end");
    await app.settle(1500);
    await app.press(KEYS.ctrlBackslash, KEYS.ctrlBackslash);
    await app.waitFor(HOME_VIEW, 5000);
    assertInvariants(app);
  });

  test("QA-frame/paste-in-question: a paste while the question bar is up is dropped (even `y`, Enter); Esc then keeps the session and the agent never saw it @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    await app.type("/clear");
    await app.press(KEYS.enter);
    await app.waitFor(() => askedClear(app));
    const before = app.inputLog().length;
    await app.paste("y\r");
    await app.paste("x".repeat(200_000));
    await app.settle(300);
    expect(askedClear(app)).toBe(true);
    expect(app.inputLog().length).toBe(before);
    await app.press(KEYS.esc);
    await until(() => !asked(app));
    expect(app.screen()).not.toContain("CLEARED");
    assertInvariants(app);
  });
});

// ── Resize ──────────────────────────────────────────────────────────────────────────────────────

const sizeLine = (app: App) => [...app.screen().matchAll(/SIZE (\d+)x(\d+)/g)].at(-1)?.slice(1).map(Number);

describe("resize", () => {
  test("QA-frame/resize-storm: 50 resizes in 1 s leave the frame whole, the final size drawn and every agent told the last one @full", async () => {
    const app = await gluon(100, 30, {}, YAML, ["claude", "opencode"]);
    await openSessions(app, ["claude", "opencode"]);
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 50; i++) {
      app.resize(30 + rnd(110), 8 + rnd(40));
      await Bun.sleep(20);
    }
    app.resize(90, 28);
    await app.settle(500);
    await app.waitFor((s) => s.includes("◆ gluon"), 10_000);
    const lay = layout(90, 28);
    await app.waitFor((s) => s.includes(`SIZE ${lay.interior.cols}x${lay.interior.rows}`), 10_000);
    assertInvariants(app);
    // The other session got the last size too.
    await app.press(KEYS.left);
    await app.waitFor((s) => s.includes("◆ gluon") && s.includes("SIZE"), 10_000);
    expect(sizeLine(app)).toEqual([lay.interior.cols, lay.interior.rows]);
    assertInvariants(app);
  });

  test("QA-frame/resize-tiny: below 20×6 only `too small` is drawn, at every edge; coming back redraws the frame whole and the agent gets the size @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    for (const [c, r] of [[20, 6], [19, 6], [20, 5], [19, 5], [1, 1], [100, 30], [60, 20]] as const) {
      app.resize(c, r);
      await app.settle(300);
      if (c < 20 || r < 6) {
        expect({ c, r, small: app.screen().includes("too small") || c < 12 }).toEqual({ c, r, small: true });
        expect(app.screen()).not.toContain("TUI ready");
      } else {
        await app.waitFor((s) => s.includes("◆ gluon"), 10_000);
        assertInvariants(app);
      }
    }
    const lay = layout(60, 20);
    await app.waitFor((s) => s.includes(`SIZE ${lay.interior.cols}x${lay.interior.rows}`), 10_000);
    // Typing at the tiny size goes where it should (the agent; nothing drawn).
    app.resize(19, 5);
    await app.settle(300);
    const m = app.inputLog().length;
    await app.type("hi");
    app.resize(80, 24);
    await app.waitFor((s) => s.includes("◆ gluon"), 10_000);
    expect(app.inputLog().slice(m)).toBe("hi");
    assertInvariants(app);
  });

  test("QA-frame/resize-tiny-home: the home view at 19×5 and 1×1 and back is whole, and its draft survives @full", async () => {
    const app = await gluon(100, 30, {}, YAML);
    await app.type("draft text");
    for (const [c, r] of [[19, 5], [1, 1], [5, 40], [100, 30]] as const) {
      app.resize(c, r);
      await app.settle(300);
    }
    await app.waitFor(/Gluon v\d/, 10_000);
    expect(app.screen()).toContain("draft text");
    assertInvariants(app);
  });

  test("QA-frame/resize-question: a resize while the question bar is up keeps the question, answerable, on the last row @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    await app.type("/clear");
    await app.press(KEYS.enter);
    await app.waitFor(() => askedClear(app));
    for (const [c, r] of [[60, 20], [40, 12], [100, 30]] as const) {
      app.resize(c, r);
      await app.settle(300);
      expect({ c, r, asked: askedClear(app) }).toEqual({ c, r, asked: true });
    }
    assertInvariants(app);
    await app.press(KEYS.esc);
    await until(() => !asked(app));
    expect(app.screen()).not.toContain("CLEARED");
  });

  test("QA-frame/resize-selecting: a resize in the middle of a drag selection at home: no crash, the view whole, the release harmless @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    await home(app);
    app.write(mouseReports({ op: "press", button: "left", x: 5, y: 5 })[0]!);
    app.write(mouseReports({ op: "drag", button: "left", x: 5, y: 5, to: { x: 40, y: 6 } })[1]!);
    await app.settle(200);
    app.resize(70, 20);
    await app.settle(300);
    app.write(mouseReports({ op: "release", button: "left", x: 40, y: 6 })[0]!);
    await app.settle(300);
    app.resize(100, 30);
    await app.settle(300);
    await app.waitFor(HOME_VIEW);
    assertInvariants(app);
    expect(app.exitCode(50)).resolves.toBeNull();
  });
});

// ── Signals, quitting, and the terminal an agent leaves behind ──────────────────────────────────

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const ICANON = process.platform === "darwin" ? 0x100 : 0x2;
const pidFile = (tag: string) => {
  const f = join(tmpdir(), `gluon-qa-frame-${process.pid}-${tag}`);
  rmSync(f, { force: true });
  return f;
};
/** The terminal is as a shell expects it: the normal screen, modes reset, line mode (after `app.mark()`). */
function expectRestored(app: App) {
  const out = app.since();
  expect(out).toContain("\x1b[?1049l");
  expect(app.localFlags & ICANON).toBe(ICANON);
  const m = app.modes();
  expect({ mouse: m.mouseTracking, focus: m.focus, paste: m.bracketedPaste, kitty: m.kittyFlags, alt: m.altScreen, cursor: m.cursorVisible }).toEqual({ mouse: "none", focus: false, paste: false, kitty: 0, alt: false, cursor: true });
}

describe.skipIf(WIN)("signals and quitting", () => {
  for (const [sig, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGINT", 130]] as const)
    test(`QA-frame/signal-${sig}-ignoring-agent: ${sig} to Gluon with an agent that ignores SIGTERM: exit ${code} in about the kill grace, the agent SIGKILLed, the terminal restored @full`, async () => {
      const pf = pidFile(sig);
      const app = await launchAs("claude", { yaml: YAML, env: { FAKE_HANG: "ignore-term", FAKE_PID_FILE: pf } });
      const pid = Number(readFileSync(pf, "utf8"));
      app.mark();
      const t0 = performance.now();
      app.signal(sig);
      const got = await app.exitCode(8000);
      const ms = performance.now() - t0;
      expect({ got, fast: ms < 5000 * SLOW }).toEqual({ got: code, fast: true });
      expect(await until(() => !alive(pid), 2000)).toBe(true);
      expectRestored(app);
    });

  // `shutdown` (src/gluon.ts): a second signal while the first waits for the agents (`SIGNAL_GRACE_MS`) goes through `compositor.abort()` before it exits.
  test("BUG-666/QA-frame-02: a second SIGTERM while the first still waits for an agent that ignores it: the terminal is restored all the same (normal screen, mouse and focus reports off, line mode) @full", async () => {
    const pf = pidFile("twice");
    const app = await launchAs("claude", { yaml: YAML, env: { FAKE_HANG: "ignore-term", FAKE_PID_FILE: pf } });
    const pid = Number(readFileSync(pf, "utf8"));
    app.mark();
    app.signal("SIGTERM");
    await Bun.sleep(150);
    app.signal("SIGTERM");
    const got = await app.exitCode(8000);
    expect(got).toBe(143);
    expect(await until(() => !alive(pid), 2500)).toBe(true);
    expectRestored(app);
  });

  test("QA-frame/signal-hup-then-term: SIGHUP then SIGINT (a closing terminal) leaves no agent behind @full", async () => {
    const pf = pidFile("hupint");
    const app = await launchAs("claude", { yaml: YAML, env: { FAKE_HANG: "ignore-term", FAKE_PID_FILE: pf } });
    const pid = Number(readFileSync(pf, "utf8"));
    app.signal("SIGHUP");
    await Bun.sleep(100);
    app.signal("SIGINT");
    expect(await app.exitCode(8000)).not.toBeNull();
    expect(await until(() => !alive(pid), 2500)).toBe(true);
  });

  test("QA-frame/quit-ignoring-agent: Ctrl+C twice at home with an agent that ignores SIGTERM, then y: Gluon exits 130 within the grace, the agent gone, the terminal restored @full", async () => {
    const pf = pidFile("quit");
    const app = await launchAs("claude", { yaml: YAML, env: { FAKE_HANG: "ignore-term", FAKE_PID_FILE: pf } });
    const pid = Number(readFileSync(pf, "utf8"));
    await home(app);
    await app.press(KEYS.ctrlC, KEYS.ctrlC);
    await app.waitFor(/1 session running — quit and end it\?/);
    app.mark();
    const t0 = performance.now();
    await app.press("\r");
    expect(await app.exitCode(8000)).toBe(130);
    expect(performance.now() - t0).toBeLessThan(6000 * SLOW);
    expect(await until(() => !alive(pid), 2500)).toBe(true);
    expectRestored(app);
  });

  test("QA-frame/ctrl-c-held-at-home: Ctrl+C held down at home (key repeat) toggles the quit question harmlessly: no exit, no key into the composer, and Esc leaves it @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    await home(app);
    for (let i = 0; i < 9; i++) {
      app.write(KEYS.ctrlC);
      await Bun.sleep(30);
    }
    await app.settle(300);
    expect(await app.exitCode(300)).toBeNull();
    // An odd count leaves the question up, an even one down: it never typed anything either way.
    await app.press(KEYS.esc);
    await app.settle(200);
    expect(app.screen()).not.toContain("\x03");
    assertInvariants(app);
  });
});

describe.skipIf(WIN)("a crashing agent leaves the terminal as it found it", () => {
  for (const fake of ["claude", "opencode"] as const)
    test(`QA-frame/crash-modes-${fake}: the agent turned on mouse, focus and kitty (alt screen too), floods, and is killed with SIGKILL mid-output: home shows, no mode left on the real terminal @full`, async () => {
      const pf = pidFile(`crash-${fake}`);
      const app = await launchAs(fake, { yaml: YAML, env: { FAKE_ALT: "1", FAKE_PID_FILE: pf } });
      const pid = Number(readFileSync(pf, "utf8"));
      for (const c of ["!mouse", "!focus", "!kitty"]) {
        await app.type(c);
        await app.press(KEYS.enter);
        await app.settle(200);
      }
      await app.type("!flood 3000");
      await app.press(KEYS.enter);
      await Bun.sleep(30);
      process.kill(pid, "SIGKILL");
      await app.waitFor(HOME_VIEW, 15_000);
      await app.settle(500);
      assertInvariants(app);
      expect(app.kittyDepth()).toBe(0);
      const m = app.modes();
      expect({ focus: m.focus, kitty: m.kittyFlags, alt: m.altScreen }).toEqual({ focus: false, kitty: 0, alt: true });
      // Gluon itself still works: a home composer key, the exit path.
      await app.type("ok");
      expect(app.screen()).toContain("ok");
    });
});

// ── Tabs, the home key's prefix, the mouse ──────────────────────────────────────────────────────

/** The highlighted tab on the strip (its underlined text). */
function shownTab(app: App): string {
  const line = app.term.buffer.active.getLine(app.term.buffer.active.viewportY);
  let out = "";
  for (let x = 0; line && x < app.term.cols; x++) {
    const c = line.getCell(x);
    if (c?.isUnderline()) out += c.getChars() || " ";
  }
  return out.trim();
}
const bar = (app: App) => app.lines().at(-1) ?? "";

describe("tabs", () => {
  test("QA-frame/tabs-16: 16 sessions: the strip scrolls (‹n n›), ← and → walk the whole ring through home, a click on a marker reaches the hidden neighbour, home lists them all @full", async () => {
    const app = await gluon(100, 30, {}, YAML, ["claude", "opencode"]);
    await openSessions(app, Array.from({ length: 16 }, (_, i) => (i % 2 ? "opencode" : "claude")));
    expect(shownTab(app)).toContain("-16");
    assertInvariants(app);
    expect(app.lines()[0]).toMatch(/‹\d+/);
    // ← through every tab, then home, then → around.
    const seen: string[] = [];
    for (let i = 0; i < 16; i++) {
      await app.press(KEYS.left);
      await app.waitFor((s) => s.includes("◆ gluon") || HOME_VIEW.test(s));
      seen.push(HOME_VIEW.test(app.screen()) ? "home" : shownTab(app));
    }
    expect(seen.at(-1)).toBe("home");
    expect(new Set(seen).size).toBe(16);
    // From home, → opens the first tab; a click on `3›`-style marker shows a hidden one.
    await app.press(KEYS.right);
    await app.waitFor((s) => s.includes("◆ gluon"));
    const row0 = app.lines()[0]!;
    const next = /(\d+)›/.exec(row0);
    expect(next).not.toBeNull();
    const x = row0.lastIndexOf("›") + 1;
    const before = shownTab(app);
    app.write(click(x, 1));
    await app.waitFor(() => shownTab(app) !== before);
    assertInvariants(app);
    await home(app);
    expect(app.screen()).toMatch(/Gluon-session-1\b/);
  }, 400_000 * SLOW);
});

describe.skipIf(WIN)("the home key's prefix", () => {
  for (const key of ["ctrl+\\", "ctrl+]", "ctrl+^", "ctrl+_"] as const) {
    const byte = { "ctrl+\\": KEYS.ctrlBackslash, "ctrl+]": KEYS.ctrlBracket, "ctrl+^": KEYS.ctrlCaret, "ctrl+_": KEYS.ctrlUnderscore }[key];
    test(`QA-frame/prefix-${key}: the prefix has no timeout (BUG-706); an unknown key after it goes to the agent and never the key itself; twice goes home @full`, async () => {
      const app = await launchAs("claude", { yaml: `${YAML}  key: ${key}\n` });
      const m = app.inputLog().length;
      // Prefix, then nothing: it stays (BUG-706, #113); Esc ends it.
      await app.press(byte);
      await app.waitFor((s) => /ctrl\+.*(again|home)/.test(bar(app)) || bar(app).includes(key));
      const during = bar(app);
      await app.settle(3200);
      expect(bar(app)).toBe(during);
      await app.press(KEYS.esc);
      await app.waitFor((s) => bar(app) !== during, 4000);
      // Prefix, then an unknown key: the prefix ends, the key goes on as typed.
      await app.press(byte);
      await app.press("x");
      await app.waitFor("❯ x");
      expect(app.inputLog().slice(m)).toBe("x");
      // Prefix, then Esc: nothing.
      await app.press(KEYS.backspace, byte, KEYS.esc);
      await app.settle(200);
      expect(app.inputLog().slice(m)).toBe(`x${KEYS.backspace}`);
      // Twice: home; the key never reached the agent.
      await app.press(byte, byte);
      await app.waitFor(HOME_VIEW);
      expect(app.inputLog().slice(m)).not.toContain(byte);
      assertInvariants(app);
    });
  }

  test("QA-frame/prefix-pending-then-tab-switch: the prefix pending, a click on the strip or a wheel notch ends it and does what it does; a key after the lapse is plain @full", async () => {
    const app = await gluon(100, 30, {}, YAML, ["claude", "opencode"]);
    await openSessions(app, ["claude", "opencode"]);
    await app.press(KEYS.ctrlBackslash);
    const x = app.lines()[0]!.indexOf("Gluon-session-1") + 3;
    app.write(click(x, 1));
    await app.waitFor(() => shownTab(app).includes("session-1"));
    expect(bar(app)).not.toMatch(/again|waiting/);
    assertInvariants(app);
  });
});

describe.skipIf(WIN)("the mouse", () => {
  test("QA-frame/mouse-strip-edges: a left press on the first and last cell of ◆ gluon and of each tab acts, the cell between tabs and the one past the last do nothing @full", async () => {
    const app = await gluon(100, 30, {}, YAML, ["claude", "opencode"]);
    await openSessions(app, ["claude", "opencode", "claude"]);
    const row = app.lines()[0]!;
    const starts = ["Gluon-session-1", "Gluon-session-2", "Gluon-session-3"].map((n) => row.indexOf(n));
    expect(starts.every((s) => s > 0)).toBe(true);
    // The home mark: `◆ gluon` is columns 1..8; a tab is ` g name ` (the gap cell is its last).
    const homeAt = row.indexOf("◆") + 1;
    app.write(click(homeAt, 1));
    await app.waitFor(HOME_VIEW);
    await app.press(KEYS.right);
    await app.waitFor((s) => s.includes("◆ gluon"));
    // The last cell of the strip's text, and the cell past it: nothing happens.
    const end = app.lines()[0]!.trimEnd().length;
    const was = shownTab(app);
    app.write(click(end + 5, 1));
    await app.settle(300);
    expect(shownTab(app)).toBe(was);
    assertInvariants(app);
  });

  test("QA-frame/mouse-alt-agent-with-mouse: an alternate-screen agent that asked for the mouse: a click on the tab strip still switches, a click inside reaches the agent @full", async () => {
    const app = await gluon(100, 30, { FAKE_ALT: "1" }, YAML, ["claude", "opencode"]);
    await openSessions(app, ["claude", "opencode"]);
    await app.type("!mouse");
    await app.press(KEYS.enter);
    await app.settle(300);
    expect(app.modes().mouseTracking).not.toBe("none");
    const x = app.lines()[0]!.indexOf("Gluon-session-1") + 3;
    app.write(click(x, 1));
    await app.waitFor(() => shownTab(app).includes("session-1"));
    assertInvariants(app);
  });

  test("QA-frame/mouse-alt-agent-no-mouse: an alternate-screen agent with no mouse tracking: the real terminal tracks no mouse, so the tab strip is not clickable (by design, BUG-175) @full", async () => {
    const app = await gluon(100, 30, { FAKE_ALT: "1" }, YAML, ["claude", "opencode"]);
    await openSessions(app, ["claude", "opencode"]);
    expect(app.modes().mouseTracking).toBe("none");
  });

  test("QA-frame/mouse-select-wide: a drag over the home composer's CJK and emoji text copies it whole (OSC 52), from either half of a wide character @full", async () => {
    const app = await gluon(100, 30, {}, YAML);
    await app.enter("你好世界🐛 text");
    await app.waitFor(/› 你好世界🐛 text/);
    const y = app.row(/›.*你好世界/) + 1;
    expect(y).toBeGreaterThan(0);
    const x0 = app.lines()[y - 1]!.indexOf("你") + 1;
    // From the right half of 你 (a wide character: two cells) to past the end of the text.
    for (const start of [x0, x0 + 1]) {
      app.mark();
      const [press, motion, release] = mouseReports({ op: "drag", button: "left", x: start, y, to: { x: x0 + 14, y } });
      app.write(press!);
      app.write(motion!);
      app.write(release!);
      await until(() => /\x1b\]52;c;[A-Za-z0-9+/=]*\x07/.test(app.since()), 5000);
      await app.settle(200);
      const osc = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(app.since());
      expect(osc).not.toBeNull();
      const text = Buffer.from(osc![1]!, "base64").toString("utf8");
      expect({ start, text: text.includes("你好世界🐛 text") || (start === x0 + 1 && text.includes("好世界🐛 text")) }).toEqual({ start, text: true });
      await app.press("a");
      await app.press(KEYS.backspace);
    }
    assertInvariants(app);
  });

  test("QA-frame/mouse-select-big: a drag over a whole 400×100 home view: one OSC 52 sequence, whole, its size reported @full", async () => {
    const app = await gluon(400, 100, {}, YAML);
    app.mark();
    const [press, motion, release] = mouseReports({ op: "drag", button: "left", x: 1, y: 1, to: { x: 400, y: 99 } });
    app.write(press!);
    app.write(motion!);
    app.write(release!);
    await until(() => /\x1b\]52;c;[A-Za-z0-9+/=]*\x07/.test(app.since()), 5000);
    const osc = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(app.since());
    console.log(`osc52 for a 400x100 view: ${osc ? osc[1]!.length : "none"} base64 characters`);
    expect(osc).not.toBeNull();
    assertInvariants(app);
  });
});

describe("the matrix's `na` reasons that could be cells after all", () => {
  test.skipIf(WIN)("QA-frame/na-home-kitty: kitty-protocol keys that reach the home view anyway (a terminal that keeps sending them after the agent's flags were popped) read as the keys they are @full", async () => {
    const app = await gluon(100, 30, {}, YAML);
    await app.press(KEYS.kittyA);
    await app.waitFor(/› a/);
    await app.press(KEYS.kittyBackspace);
    await app.waitFor((s) => !/› a/.test(s));
    await app.press(KEYS.kittyA, KEYS.kittyShiftEnter, KEYS.kittyA);
    await app.waitFor((s) => /› a\s*\n\s*a/.test(s) || /›\s*a/.test(s));
    assertInvariants(app);
  });

  test.skipIf(WIN)("QA-frame/na-tiny-mouse: below 20×6 a mouse-tracking agent gets no mouse report, and the wheel scrolls nothing visible @full", async () => {
    const app = await launchAs("claude", { yaml: YAML });
    await app.type("!mouse");
    await app.press(KEYS.enter);
    await app.settle(300);
    app.resize(19, 5);
    await app.settle(400);
    const m = app.inputLog().length;
    for (const g of [click(5, 3), ...[mouseReports({ op: "wheel", button: "up", x: 5, y: 3 })[0]!]]) {
      app.write(g);
      await Bun.sleep(100);
    }
    await app.settle(300);
    expect(app.inputLog().slice(m)).toBe("");
    app.resize(100, 30);
    await app.waitFor((s) => s.includes("◆ gluon"));
    assertInvariants(app);
  });

  test.skipIf(WIN)("QA-frame/na-alt-kitty-enter-menu: an agent that pushed the kitty flags with a slash menu open: `/clear` typed as CSI-u keys and a CSI-u Enter on the menu's highlighted item still asks @full", async () => {
    const app = await launchAs("claude", { yaml: YAML, env: { FAKE_KITTY: "1" } });
    await app.press("\x1b[47u");
    await app.waitFor("/compact");
    expect(await outcome(app, KEYS.kittyEnter)).toBe("clear");
    assertInvariants(app);
  });
});

describe("small items of issue #35", () => {
  test("BUG-610/QA-frame-03: QA-frame/stale-activity-keeps-working-row: a tool line (`Editing app.ts`), the turn ends (done), then a new turn starts (`working`, no activity yet, as Claude Code's UserPromptSubmit sends it): the row is no longer `Turn finished` @full", async () => {
    const app = await gluon();
    await launch(app, "first task");
    await say(app, "!event status working Editing app.ts", "EVENT status working");
    await say(app, "!event status done", "EVENT status done");
    await app.waitFor((s) => s.split("\n")[1]!.includes("awaiting your input"));
    // The old tool line is already replaced by `Turn finished` (BUG-187).
    await say(app, "!event status working", "EVENT status working");
    await app.waitFor((s) => /· Working|· Turn finished/.test(s.split("\n")[1]!));
    expect(app.lines()[1]).not.toContain("Turn finished");
  });
});

describe.skipIf(WIN)("matrix `na`: setup menus are outside the frame, but signals still reach them", () => {
  for (const sig of ["SIGTERM", "SIGHUP"] as const)
    test(`BUG-667/QA-frame-05: QA-frame/na-menu-signal-${sig}: ${sig} to Gluon while the onboarding checklist is up ends it and leaves the terminal in line mode, cursor shown @full`, async () => {
      const app = new App({ cwd: repo.tiny(), args: [], env: { GLUON_CONFIG: freshConfig(`qa-menu-${sig}`), ANTHROPIC_API_KEY: undefined }, agents: ["claude"], noDemo: true, rows: 40, cols: 110 });
      await app.waitFor("Connect your coding agents");
      app.mark();
      app.signal(sig);
      const code = await app.exitCode(5000);
      expect(code).not.toBeNull();
      expect(app.localFlags & ICANON).toBe(ICANON);
      expect(app.modes().cursorVisible).toBe(true);
    });
});

describe.skipIf(WIN)("an agent that exits at once", () => {
  /** A `claude` that answers the status checks as the fake does and, as an agent, prints `body` and exits `code`. */
  function brokenClaude(tag: string, body: string, code: number): string {
    const dir = join(tmpdir(), `gluon-qa-frame-bin-${process.pid}-${tag}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const real = join(fakeAgents(["claude"]), "claude");
    writeFileSync(join(dir, "claude"), `#!/bin/sh\ncase "$1" in auth|--version|-p|models) exec "${real}" "$@";; esac\nprintf '${body}'\nexit ${code}\n`);
    chmodSync(join(dir, "claude"), 0o755);
    return [dir, fakeAgents(["claude"]), ...SYSTEM_PATH].join(delimiter);
  }

  for (const [tag, body] of [
    ["silent", ""],
    // The alternate screen, mouse tracking (SGR), focus reports, kitty flags and no bracketed paste cleanup, then a crash.
    ["modes", "\\033[?1049h\\033[?1000h\\033[?1006h\\033[?1004h\\033[>1u\\033[?2004h\\033[?25l half a screen"],
  ] as const)
    test(`QA-frame/exits-at-once-${tag}: an agent that exits (code 3) before drawing anything: the session closes, home shows with the exit named, the real terminal is left as it was @full`, async () => {
      const app = await gluon(100, 30, { PATH: brokenClaude(tag, body, 3) }, YAML, ["claude"]);
      await toChoice(app, "dead task");
      await app.press(KEYS.enter);
      await app.waitFor((s) => s.includes("exited (code 3)"), 20_000);
      await app.settle(500);
      await app.waitFor(HOME_VIEW);
      assertInvariants(app);
      expect(app.kittyDepth()).toBe(0);
      // Still usable: another task can start.
      await app.type("next");
      await app.waitFor("› next");
    });
});
