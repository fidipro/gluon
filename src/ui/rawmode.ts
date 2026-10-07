/**
 * Raw mode across Ink renders. The menus are separate Ink renders, one after another; Ink turns raw
 * mode on in an effect, a turn of the event loop after its first frame, and off when it exits. So
 * between two menus the terminal was in line mode for a moment, and on Windows a key typed then
 * (a digit pressed as soon as the next menu showed) was lost: the console's pending line read took
 * it (BUG-133; Linux keeps it in the tty's buffer).
 *
 * Every render goes through `inkRender`: raw mode is on before its first frame, and Ink turning it
 * off only starts a short grace (`GRACE_MS`) in which the next render takes over without a
 * line-mode gap. After the grace (nothing took over: a status check, the end of the flow) the
 * terminal goes back to line mode and stdin is paused, so no line read is left pending.
 * `releaseRaw()` ends it at once (a child gets the terminal); the process's exit restores it.
 *
 * A SIGTERM, SIGHUP or SIGINT while raw mode is held and Gluon's compositor doesn't own the terminal (the setup menus,
 * before the frame) would end the process by default with the terminal still raw and the cursor hidden: `armSignals`
 * restores both and exits 128 + the signal's number (BUG-667). Not on Windows, which has no such signals to a console app.
 */
import { render } from "ink";
import { constants as osConstants } from "node:os";
import tty from "node:tty";
import type { ReactNode } from "react";

/** How long raw mode outlives the last render that wanted it. */
export const GRACE_MS = 250;

/**
 * The terminal's input stream: every reader of it goes through here, never a cached `process.stdin`. A handoff ends
 * its reader (`endStdinReader`) and what the UI reads next is a fresh one (`freshStdin`), which may be another object.
 */
let current: NodeJS.ReadStream | undefined;
/** `endStdinReader` ended the reader and `freshStdin` hasn't given the next one yet. */
let ended = false;

export function currentStdin(): NodeJS.ReadStream {
  return current ?? process.stdin;
}

/**
 * Before a child gets the terminal (`inTerminal`: raw mode off, stdin paused): ends the reader for good. Under Bun on
 * macOS the reader a `pause()` leaves behind outlives it and takes lines typed for the child, about 1 in 10 (issue #29,
 * BUG-614); a destroyed stream's read is gone. Not on Windows, where the pause alone keeps the agent's first line
 * (BUG-100) and nothing was seen lost, and not without a terminal (a pipe's reader is no one's to end). Returns whether
 * it ended one: `freshStdin` must follow once the child is gone.
 */
export function endStdinReader(): boolean {
  const s = currentStdin();
  if (process.platform === "win32" || !s.isTTY || s.destroyed) return false;
  s.pause();
  s.destroy();
  ended = true;
  return true;
}

/**
 * After the child: the reader the UI reads next, a fresh one (the ended one is never used again; nothing after the
 * handoff keeps a reference to it). Bun has no other stdin object to give: `process.stdin` takes a new native reader
 * when it is resumed after `destroy()`. A `tty.ReadStream(0)` of our own won't do: it reads with a blocking `read`
 * nothing can cancel, which takes the next child's line on Linux too. Then paused again, as a first stream starts: a
 * turn of the event loop before, so the end settles (a `close` still queued would end it again), and one after, so the
 * reader the resume took is let go (no key comes before that). Does nothing unless `endStdinReader` ended one.
 */
export async function freshStdin(): Promise<NodeJS.ReadStream> {
  if (ended) {
    ended = false;
    const turn = () => new Promise<void>((r) => setImmediate(r));
    await turn();
    const s = process.stdin;
    if (s.destroyed) {
      s.resume();
      await turn();
      s.pause();
      await turn();
    }
    // A Bun that no longer revives it: a stream of our own still reads (its blocking read may take a child's line, as above).
    current = s.destroyed ? (new tty.ReadStream(0) as unknown as NodeJS.ReadStream) : s;
  }
  return currentStdin();
}

/** Renders that want raw mode (Ink asked for it, or it's about to draw its first frame). */
const wanting = new Set<object>();
/** Raw mode is on because of us. */
let held = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let exitHooked = false;

/** Gluon's compositor owns the terminal for the rest of the process: raw mode stays on, `releaseRaw` does nothing. */
let pinned = false;

/**
 * Raw mode on for the process's lifetime (Gluon: one reader, every key decoded; Ctrl+\ and Ctrl+C
 * are bytes, never signals). A grace timer left by an earlier render can't turn it off; the
 * process's exit (or `unpinRaw`) restores line mode.
 */
export function pinRaw() {
  pinned = true;
  disarmSignals();
  hold();
}

/** Line mode again (Gluon is exiting): the pin is gone, stdin paused. */
export function unpinRaw() {
  pinned = false;
  releaseRaw();
}

const SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
let armed: Array<[NodeJS.Signals, () => void]> = [];

/** The terminal back as the shell had it (line mode, cursor shown), then the process ends as a signal ends one (BUG-667). */
function onSignal(sig: (typeof SIGNALS)[number]) {
  try {
    // A hung-up terminal fails writes: never as an uncaught error.
    if (sig === "SIGHUP") {
      process.stdout.on("error", () => {});
      process.stdin.on("error", () => {});
    }
    const stdin = currentStdin();
    if (held && stdin.isTTY) stdin.setRawMode(false);
    if (process.stdout.isTTY) process.stdout.write("\x1b[?25h");
  } catch {}
  process.exit(128 + (osConstants.signals[sig] ?? 0));
}

function armSignals() {
  if (process.platform === "win32" || pinned || armed.length) return;
  for (const sig of SIGNALS) {
    const fn = () => onSignal(sig);
    process.on(sig, fn);
    armed.push([sig, fn]);
  }
}

function disarmSignals() {
  for (const [sig, fn] of armed) process.off(sig, fn);
  armed = [];
}

function hold() {
  clearTimeout(timer);
  timer = undefined;
  if (held) return;
  currentStdin().setRawMode(true);
  held = true;
  armSignals();
  if (!exitHooked) {
    exitHooked = true;
    // Never leave the shell's terminal in raw mode (process.exit within the grace, Cancelled → 130).
    process.on("exit", () => {
      if (held) currentStdin().setRawMode(false);
    });
  }
}

function drop(token: object) {
  wanting.delete(token);
  if (wanting.size || !held || timer) return;
  timer = setTimeout(releaseRaw, GRACE_MS);
  timer.unref();
}

/**
 * Line mode now, stdin paused (no read left pending: on Windows it would take the first line typed
 * into a child, BUG-100). The next render reads again. For a handoff, after the UI has unmounted.
 */
export function releaseRaw() {
  clearTimeout(timer);
  timer = undefined;
  if (pinned) return;
  disarmSignals();
  const stdin = currentStdin();
  if (held && stdin.isTTY) stdin.setRawMode(false);
  held = false;
  stdin.pause();
}

/** Ink's `render` with raw mode on before the first frame and held across to the next render. */
export function inkRender(node: ReactNode, options: { exitOnCtrlC: boolean; stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; onRender?: () => void }): ReturnType<typeof render> {
  // A stream someone else feeds (Gluon's compositor pipes the keys of the home view; raw mode is
  // pinned for the process's life: `pinRaw`): Ink reads it as given, and its raw-mode calls aren't ours.
  const stdin = currentStdin();
  if (options.stdin || !stdin.isTTY) return render(node, options);
  const token = {};
  wanting.add(token);
  hold();
  // Ink's stdin, but its raw-mode switch goes through the hold: "on" takes it, "off" lets go.
  const proxy = new Proxy(stdin, {
    get(target, prop) {
      if (prop === "setRawMode")
        return (on: boolean) => {
          if (on) {
            wanting.add(token);
            hold();
          } else drop(token);
          return proxy;
        };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const app = render(node, { ...options, stdin: proxy });
  void app.waitUntilExit().then(
    () => drop(token),
    () => drop(token),
  );
  return app;
}

/**
 * What a full-screen agent may leave behind when it ends without cleaning up (Gluon ended it, or
 * it crashed): the alternate screen, a hidden cursor, mouse tracking, bracketed paste, the kitty
 * keyboard protocol, focus events. For a launch Gluon didn't watch (no PTY: `inTerminal`), it
 * can't tell whether the agent is still on the alternate screen: leaving it also restores the cursor
 * saved on the screen it goes back to, a stale position when the agent already left it; saving
 * the cursor first (ESC 7) makes it a no-op where terminals keep one saved cursor per screen
 * (xterm, xterm.js). Gluon then draws on the alternate screen again.
 */
export const TERMINAL_RESET = "\x1b7\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[?1004l";

/**
 * After a UI handoff without a PTY (issue #13): resets the terminal (`reset`), then throws away what was typed for the
 * agent but never read (keys, a partial line, a late terminal reply), so it doesn't land in the
 * next render's composer. Raw mode makes a partial line readable; it stays held for the next
 * render, or is let go after `GRACE_MS`. Reads with 'readable' + read(), as Ink does.
 */
export async function afterHandoff({ quietMs = 60, maxMs = 400, reset = TERMINAL_RESET }: { quietMs?: number; maxMs?: number; reset?: string } = {}): Promise<void> {
  if (process.stdout.isTTY) process.stdout.write(reset);
  releaseRaw();
  await freshStdin();
  const stdin = currentStdin();
  if (!stdin.isTTY) return;
  // Bun clears a read left pending by the pause on the next tick; listening before that, no key comes.
  await new Promise<void>((r) => setImmediate(r));
  hold();
  await new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(cap);
      stdin.off("readable", onReadable);
      stdin.pause();
      resolve();
    };
    const onReadable = () => {
      while (stdin.read() !== null);
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    };
    const cap = setTimeout(done, maxMs);
    quiet = setTimeout(done, quietMs);
    stdin.on("readable", onReadable);
  });
  // Line mode again after the grace, unless a render takes over first.
  if (!wanting.size && !timer) {
    timer = setTimeout(releaseRaw, GRACE_MS);
    timer.unref();
  }
}
