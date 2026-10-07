/**
 * Gluon's compositor: the one owner of the real terminal for the life of the process. One stdin
 * reader and key decoder; raw mode pinned (`pinRaw`); the alternate screen entered once at start
 * and left at exit. Two views:
 *
 * - **home**: the home view (Ink, `HomeView`) draws; every key goes on, as typed, into its stdin
 *   stream (terminal replies and focus reports dropped; win32-input-mode as plain VT, `forInk`), but
 *   mouse reports, which go to the home view's `mouse`, never into its stream. A quit confirmation can sit on the last row (`confirm`).
 * - **session**: the chrome (`chrome.ts`) around the active session's screen model, painted into
 *   the frame's interior (`paint.ts`, damage diff, synchronized updates). Gluon's keys switch or go
 *   home; the rest goes to the session (`route`).
 *
 * Every session keeps running in the background: its output only updates its model and the store.
 * The real terminal carries the active session's modes (kitty keys, mouse, …; `modeTransition` on
 * every switch and change; bracketed paste always, `effectiveModes`); at home none but SGR mouse
 * reports when Gluon captures the mouse (`homeModes`; BUG-269) — with the drags too: a drag over the
 * home view's text selects it, and the release copies it (`selection.ts`; BUG-286).
 *
 * Mouse: Gluon sees clicks only while the real terminal reports the mouse (the agent asked for it,
 * or Gluon took the wheel), so with `mouse_capture` off, or an agent on its alternate screen that
 * didn't ask for the mouse, the tab strip can't be clicked (the keys still switch). Home clicks go
 * to the home view through `homeMouse`, never into its input.
 *
 * What a session loses inside the frame: inline images, OSC 8 hyperlinks, and the agent's output in
 * the terminal's own scrollback once Gluon quits (everything is drawn on the alternate screen).
 */
import { PassThrough } from "node:stream";
import type { Config } from "../config.ts";
import { counts, tabs, type SessionState, type SessionStore } from "../sessions.ts";
import { DOUBLE_CLICK_MS, tripleSegs } from "../ui/layout.ts";
import { currentStdin, freshStdin, pinRaw, unpinRaw } from "../ui/rawmode.ts";
import { bg, GLUON_HEX, SGR_RESET } from "../ui/theme.ts";
import { bottomBar, frameBox, infoLine, layout, noteRows, prefixBar, questionBar, render, scrollFooter, switchKey, tabSpans, tabStrip, tooSmall, zoomBar, zoomLayout, type Layout, type TabSpans } from "./chrome.ts";
import { lineAfter, TOUCHED } from "./intercept.ts";
import { createKeyDecoder, forInk, encodeMouse, ESC_TIMEOUT_MS, isCtrlC, isKeyUp, isModifierOnly } from "./keys.ts";
import { HOME_MODES, MODES_RESET, modeTransition, type ModesState } from "./modes.ts";
import { beginSync, createPainter, endSync, SYNC_WAIT_MS, syncPending, type Painter, type Rect } from "./paint.ts";
import { createScreen, type TermScreen } from "./screen.ts";
import { copyText, diffSpans, osc52, paintSpans, spans, spansKey, type Selection, type Span } from "./selection.ts";
import type { Key, KeyDecoder, MouseEncoding, MouseReport } from "./types.ts";

/**
 * The home view as the compositor drives it. `mount`: start drawing to the real terminal, reading
 * keys from `input` (and writing through `output`, which keeps the compositor's overlay on top),
 * calling `rendered` as it renders each frame, before writing it (the last row then changes with the
 * frame that shows the matching hint: BUG-261). `suspend`: stop drawing (a session is shown;
 * renders meanwhile are dropped); `resume`: redraw all of it (the compositor has cleared the screen
 * and homed the cursor first).
 */
export interface HomeView {
  mount(input: NodeJS.ReadStream, output: NodeJS.WriteStream, rendered?: () => void): void;
  /** A mouse report at home (`handoff.mouse_capture`; never while a question is up): a click on the list, the wheel (BUG-269). */
  mouse?(m: MouseReport): void;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  unmount(): Promise<void>;
}

/**
 * How long a question Gluon raised by itself ignores Enter, Esc and Ctrl+C after it is asked: the
 * user was typing something else when it came (the install offer's `GUARD_MS`, `ui/signin.tsx`).
 */
export const SELF_GUARD_MS = 300;

/** What a home question came to (`Compositor.choose`): the user's yes or no, `null` when it was taken away, and for a question Gluon raised by itself also Ctrl+C (`"keep"`: neither) and typing (`"typed"`). */
export type Choice = boolean | null | "keep" | "typed";

/** What the compositor needs of a session (an `AgentSession`). */
export interface ViewSession {
  readonly screen: TermScreen;
  readonly alive: boolean;
  readonly question: string | null;
  /** The question up holds a typed command's key: a no leaves that line typed (BUG-234). */
  readonly holdsLine?: boolean;
  /** The agent shows a dialog of its own that waits for a pick (`awaitsChoice` of its reader): a key now answers it, it isn't typed into the line (BUG-705). */
  readonly awaitsChoice?: boolean;
  /** A key for the agent (through its interceptor), or an answer to its question. */
  input(k: Key): void;
  /** A mouse report already moved into the agent's screen. */
  mouse(bytes: string): void;
  /** Bytes the user's terminal sent for the agent that aren't keys (a focus report). */
  passthrough(bytes: string): void;
  resize(cols: number, rows: number): void;
  onChange(fn: () => void): () => void;
  onQuestion(fn: (q: string | null) => void): () => void;
}

/** What one key does in the session view. */
export type Action =
  | { kind: "home" }
  | { kind: "switch"; dir: 1 | -1 }
  /** The home key: the next key picks (←/→ switch, the home key again goes home, Esc cancels). */
  | { kind: "prefix" }
  /** The pending home key is over (a key picked, or any other came). */
  | { kind: "unprefix" }
  /** Show this session (a click on its tab). */
  | { kind: "show"; id: number }
  /** Scroll the frame back `by` rows (negative: forward). */
  | { kind: "scroll"; by: number }
  /** Leave scroll mode (back to the live screen). */
  | { kind: "unscroll" }
  /** Hide the session's note. */
  | { kind: "dismiss" }
  /** Zoom the shown session, or leave zoom (`z` after the home key). */
  | { kind: "zoom" }
  | { kind: "input"; key: Key }
  | { kind: "answer"; key: Key }
  | { kind: "mouse"; bytes: string }
  | { kind: "passthrough"; bytes: string };

export interface RouteContext {
  /** The active session's modes (its screen model's). */
  modes: ModesState;
  /** `handoff.mouse_capture`: the wheel scrolls the frame when the agent has no mouse tracking. */
  capture: boolean;
  interior: Rect;
  /** Rows scrolled back (0: the live screen). */
  offset: number;
  /** Rows there are to scroll back to. */
  scrollback: number;
  /** The session's question is up. */
  question: boolean;
  /** A note about the session is drawn over its frame (`Compositor.note`): Esc hides it. */
  note?: boolean;
  /** The session's typed line is untouched since the last Enter, by the user's keys alone (`lineAfter`). */
  untouched: boolean;
  /** The home key was pressed and the next key picks (`prefix`). */
  prefix: boolean;
  /** The agent got a button press whose release hasn't come: only then is a drag or release past the interior held at its edge (BUG-240). */
  pressed: boolean;
  /** Row 0 (0-based) and where its tabs are, or null while the strip isn't drawn (`tabSpans`). */
  tabRow: number;
  strip: TabSpans | null;
}

/** Rows a wheel notch scrolls. */
export const WHEEL_ROWS = 3;

/**
 * The session view's key table:
 * - the home key → the prefix: the bottom bar says what the next key does, in every state (scrolled
 *   back, the question up: it stays pending on its tab). ←/→ → the previous / next tab on the ring,
 *   home included (`neighbour`; wrapping); the home key again → home; `z` → zoom (the session gets the
 *   whole terminal but the last row) or back; Esc → nothing; any other key
 *   ends the prefix and is routed as usual (a key let go doesn't: it goes to the agent). The prefix has no timeout: it waits for one of those keys (#113);
 * - plain ← / → on an untouched line (never judged from the screen): ← the previous tab, → the next
 *   (home from the first / last, wrapping); Alt+←/→ there are dropped (Codex switches agent threads
 *   on them, OpenCode its child sessions on ←/→: Gluon owns the sessions). On a touched line they
 *   are the agent's (cursor, word, dialog tabs);
 * - a left click on the tab strip: `◆ gluon` → home, a tab → that session, `‹` / `›` → the nearest
 *   hidden tab on that side (whether or not the agent asked for the mouse; reports only come
 *   while the real terminal tracks it, `effectiveModes`);
 *   the rest of that click goes nowhere (`restOfClick`);
 * - a key with no bytes (a win32 key-up the decoder dropped) → nothing;
 * - Shift+PgUp / Shift+PgDn → scroll the frame a page (when there is something to scroll back to;
 *   else the key goes to the agent); the wheel scrolls too when Gluon captured the mouse;
 * - a mouse report, when the agent asked for the mouse → moved into the frame's interior and
 *   written in the agent's encoding; outside the interior: dropped (a release or a drag is held at
 *   the edge when the agent got its press, so it never misses the end of a drag; a click on the
 *   chrome reaches it as nothing, never as a release without a press: BUG-240);
 * - a focus report → the agent only if it asked for them; terminal replies → dropped;
 * - while the question is up: Enter / Esc / Ctrl+C answer it, other keys are dropped;
 * - while a note is up (`Compositor.note`): Esc hides it; every other key goes on as usual;
 * - while scrolled back: Esc or `q` leave scroll mode; any other key leaves it and goes on;
 * - anything else → the agent (through its interceptor).
 */
export function route(k: Key, c: RouteContext): Action[] {
  const page = Math.max(1, c.interior.rows - 1);
  // No bytes: a key-up the decoder dropped (its key-down was Gluon's, or may be).
  if (!k.raw) return [];
  if (c.prefix && k.name !== "reply" && k.name !== "focus") {
    // A key let go (the Ctrl key-up of win32-input-mode or kitty, right after the home key) or a
    // modifier alone (Ctrl pressed again for the home key's second press) isn't the pick: it goes
    // on to the agent, and the prefix stays (BUG-283).
    if (isKeyUp(k) || isModifierOnly(k)) return [{ kind: "input", key: k }];
    if (k.name === "left" || k.name === "right") return [{ kind: "unprefix" }, { kind: "switch", dir: k.name === "left" ? -1 : 1 }];
    if (k.name === "return-key") return [{ kind: "unprefix" }, { kind: "home" }];
    if (k.name === "text" && k.text === "z" && !k.pasted) return [{ kind: "unprefix" }, { kind: "zoom" }];
    if (k.name === "escape" && !k.pasted) return [{ kind: "unprefix" }];
    return [{ kind: "unprefix" }, ...route(k, { ...c, prefix: false })];
  }
  switch (k.name) {
    case "reply":
      return [];
    case "return-key":
      return [{ kind: "prefix" }];
    case "scroll-up":
      if (c.scrollback > 0 || c.offset > 0) return [{ kind: "scroll", by: page }];
      break;
    case "scroll-down":
      if (c.offset > 0) return [{ kind: "scroll", by: -page }];
      break;
    case "focus":
      return c.modes.focus ? [{ kind: "passthrough", bytes: k.raw }] : [];
    case "mouse": {
      const m = k.mouse;
      if (!m) return [];
      const hit = tabHit(m, c);
      if (hit) return [hit];
      if (c.modes.mouseTracking !== "none") {
        const bytes = shiftMouse(m, c.interior, c.modes.mouseEncoding, c.pressed);
        return bytes ? [{ kind: "mouse", bytes }] : [];
      }
      if (c.capture && m.wheel === "up") return [{ kind: "scroll", by: WHEEL_ROWS }];
      if (c.capture && m.wheel === "down" && c.offset > 0) return [{ kind: "scroll", by: -WHEEL_ROWS }];
      return [];
    }
  }
  if (c.question) return k.pasted ? [] : [{ kind: "answer", key: k }];
  if (c.note && k.name === "escape" && !k.pasted) return [{ kind: "dismiss" }];
  if (c.untouched) {
    if (k.name === "left" || k.name === "right") return [{ kind: "switch", dir: k.name === "left" ? -1 : 1 }];
    if (k.name === "alt-left" || k.name === "alt-right") return [];
  }
  const input: Action = { kind: "input", key: k };
  if (c.offset > 0) {
    if (!k.pasted && (k.name === "escape" || (k.name === "text" && k.text === "q"))) return [{ kind: "unscroll" }];
    return [{ kind: "unscroll" }, input];
  }
  return [input];
}

/**
 * What a left-button press on the tab strip shows: home or a session; null anywhere else (and with
 * the agent's pixel coordinates, mode 1016, which aren't cells).
 */
function tabHit(m: MouseReport, c: RouteContext): Action | null {
  if (!c.strip || m.button !== 0 || m.release || m.motion || m.y - 1 !== c.tabRow) return null;
  if (c.modes.mouseTracking !== "none" && c.modes.mouseEncoding === "sgr-pixels") return null;
  const x = m.x - 1;
  const [h0, h1] = c.strip.home;
  if (x >= h0 && x < h1) return { kind: "home" };
  // `‹` / `›`: the nearest hidden tab on that side (the strip then scrolls to it; BUG-212).
  const t = [...c.strip.tabs, c.strip.prev, c.strip.next].find((t) => t && x >= t.x0 && x < t.x1);
  return t ? { kind: "show", id: t.id } : null;
}

const ENCODING_FOR: Record<ModesState["mouseEncoding"], MouseEncoding> = { default: "x10", utf8: "utf8", sgr: "sgr", urxvt: "urxvt", "sgr-pixels": "sgr" };

/**
 * A mouse report from the real terminal, as the agent in `interior` (0-based on the real terminal)
 * gets it: its cell moved by the frame's offset, in the agent's encoding. Null outside the interior
 * (a release or a drag is held at the edge instead, when the agent got the press: `pressed`) or
 * when the encoding can't carry it.
 */
export function shiftMouse(ev: MouseReport, interior: Rect, encoding: ModesState["mouseEncoding"], pressed: boolean): string | null {
  const x = ev.x - interior.left;
  const y = ev.y - interior.top;
  const inside = x >= 1 && x <= interior.cols && y >= 1 && y <= interior.rows;
  const held = pressed && (ev.release || (ev.motion && ev.button !== 3));
  if (!inside && !held) return null;
  const cx = Math.min(interior.cols, Math.max(1, x));
  const cy = Math.min(interior.rows, Math.max(1, y));
  return encodeMouse(ev, ENCODING_FOR[encoding], cx - ev.x, cy - ev.y);
}

/**
 * The modes the real terminal carries for a session: its own, plus bracketed paste always (a paste
 * is never read as keys — the home key, a typed `/clear` — whatever the agent asked for; the
 * session drops the markers for an agent without it: BUG-172), plus the wheel when Gluon captures it.
 */
export function effectiveModes(modes: ModesState, capture: boolean): ModesState {
  const m = { ...modes, syncOutput: false, bracketedPaste: true };
  if (capture && m.mouseTracking === "none") return { ...m, mouseTracking: "vt200", mouseEncoding: "sgr" };
  return m;
}

/**
 * ←/→: the tab `dir` away from `current` (null: home) on the ring of tabs, home its leftmost —
 * home, then `ids` — wrapping both ways; null is home. From the first session ← is home, from the
 * last → is home. A `current` no longer in `ids` counts as home.
 */
export function neighbour(ids: readonly number[], current: number | null, dir: 1 | -1): number | null {
  const ring: (number | null)[] = [null, ...ids];
  const i = Math.max(0, current === null ? 0 : ring.indexOf(current));
  return ring[(i + dir + ring.length) % ring.length]!;
}

/** A stream Ink reads keys from, as if it were a terminal (raw mode is the compositor's). */
export function homeInput(): NodeJS.ReadStream & PassThrough {
  const s = new PassThrough();
  return Object.assign(s, { isTTY: true, setRawMode: () => s, ref: () => s, unref: () => s }) as unknown as NodeJS.ReadStream & PassThrough;
}

export interface CompositorOptions {
  store: SessionStore;
  home: HomeView;
  /** `handoff.key`: the key that goes home (and names it in the bottom bar). */
  homeKey: string;
  /** `handoff.mouse_capture`. */
  mouseCapture: boolean;
  /** How long "Copied …" stays on the last row (tests shorten it). */
  toastMs?: number;
  truecolor: boolean;
  config?: Pick<Config, "models">;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  now?: () => number;
  /** The home view is shown again, from session `from` (still listed): the list selects its row (BUG-231). */
  onHome?: (from: number) => void;
  /** SIGTERM, SIGHUP or SIGINT: the caller ends the sessions and exits (after `stop`). */
  onSignal?: (sig: "SIGTERM" | "SIGHUP" | "SIGINT") => void;
  decoder?: KeyDecoder;
}

type View = { kind: "home" } | { kind: "session"; id: number };

/** How soon after a change a paint goes out (a frame at most every 16 ms). */
export const PAINT_MS = 16;
/**
 * How long a changed last row (a question up or answered) waits for the home view's frame to go with
 * before it is drawn alone: that frame didn't change (its hint isn't shown), or no home view renders.
 */
const ROW_WAIT_MS = 150;
/** How many times (5 ms apart) the compositor looks whether the home view has read a key it may leave on (`homeRead`). */
const HOME_READ_TRIES = 40;
/** How long keys held behind the Enter that starts a session wait for it to show (`starting`), at most. */
const START_HOLD_MS = 5000;
/** How long after a quiet moment in the home view's output a selection is checked against the screen and painted again. */
const SELECTION_QUIET_MS = 12;
/** How long "Copied …" stays on the last row. */
const TOAST_MS = 2500;

/** Tests only: a typed % in a session view fails Gluon (crash safety). Compiled out of release builds, like `testProbesPath`. */
const failSeam = (): boolean => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? false : !!process.env.GLUON_TEST_PTY_FAIL);
declare const GLUON_BUILD: string | undefined;

export class Compositor {
  private sessions = new Map<number, { s: ViewSession; off: (() => void)[] }>();
  private view: View = { kind: "home" };
  private lay: Layout;
  /** The real terminal's size the layout was made for (the layout itself never goes under its minimum). */
  private size: { cols: number; rows: number };
  private painter: Painter;
  private decoder: KeyDecoder;
  private inText = new TextDecoder();
  /** The real terminal's input (not a test's stream): its raw mode is pinned, and a handoff gives it a fresh reader (`freshStdin`). */
  private readonly real: boolean;
  private stdout: NodeJS.WriteStream;
  private now: () => number;
  private homeIn = homeInput();
  private homeOut: NodeJS.WriteStream;
  /** The home view's screen as Ink wrote it (with `handoff.mouse_capture`): what a drag selects and what the highlight is painted from. */
  private model: TermScreen | null = null;
  /** A left press at home whose click the home view hasn't got yet: on the release it is a click, on a drag it starts a selection (`homeMouse`). */
  private press: MouseReport | null = null;
  /** The selection: its cells, the spans painted on the terminal now, and their text as the screen showed it (`done`: released, copied). */
  private sel: { sel: Selection; painted: Span[]; key: string; done: boolean } | null = null;
  private selTimer: ReturnType<typeof setTimeout> | undefined;
  /** Writes to the model not parsed yet, and what waits for them: mouse reports and keys, in order (`feed`). */
  private parsing = 0;
  private behind: (() => void)[] | null = null;
  /** "Copied …" on the home view's last row, for a moment. */
  private toast: string | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** What a session has to tell its user, drawn over the top of its frame while it is shown, until Esc (`note`). */
  private notes = new Map<number, string[]>();
  /** The note's rows must be drawn again (it changed, or the shown session did). */
  private noteDue = false;
  /** The modes the real terminal is in (what the last transition left). */
  private applied: ModesState = HOME_MODES;
  /** Rows scrolled back in the session view. */
  private offset = 0;
  /** The shown session is zoomed (`setZoom`): no frame, its PTY is the whole terminal but the last row. */
  private zoomed = false;
  /** The home key was pressed in the session view and the next key picks what it does (`route`). */
  private prefix = false;
  /** Each session's typed line since its last Enter (`lineAfter`; none: untouched). Plain ←/→ go to a touched one. */
  private lines = new Map<number, number>();
  /** Mouse reports that already waited for the home view to read the keys before them (`dispatch`). */
  private waited = new WeakSet<Key>();
  /** A press on the tab strip was Gluon's: the rest of that click is too (`restOfClick`). */
  private clickTaken = false;
  /** When a press at home last opened a session (`homeMouse`): a double-click's second press is Gluon's too (`restOfClick`). */
  private openedAt: number | null = null;
  /** The shown agent got a button press whose release hasn't come (`RouteContext.pressed`); a view change ends it. */
  private pressed = false;
  private chrome: Record<string, string> = {};
  private paintTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private clock: ReturnType<typeof setInterval> | undefined;
  private lastPaint = 0;
  private syncSince: number | null = null;
  private overlay: { text: string | readonly string[]; done: (answer: Choice) => void; /** Gluon raised it unasked: the user's typing is not an answer to it. */ selfRaised: boolean; since: number } | null = null;
  /** The overlay as the last row shows it: as of the home view's last frame, which names its keys (BUG-261). */
  private shown: { text: string | readonly string[] } | null = null;
  /** The home view says when it renders (`HomeView.mount`'s `rendered`): the last row waits for its frame. */
  private framed = false;
  /** A changed last row the home view's frame hasn't drawn yet: drawn alone at the end (`ROW_WAIT_MS`). */
  private rowTimer: ReturnType<typeof setTimeout> | undefined;
  /** The home view's own synchronized update is open: its start marker written, its end not yet. */
  private inkOpen = false;
  private started = false;
  private stopped = false;
  private unsubscribe: (() => void) | undefined;
  private signals: [string, () => void][] = [];
  /** The real terminal is an agent's (`handOver`): Ctrl+C there is the agent's SIGINT, not Gluon's. */
  private handedOver = false;
  /** Keys that came after one the home view may leave on, until it has read that one (`homeRead`; BUG-235). */
  private held: Key[] | null = null;
  /** The home view coming back (`home`): it reads nothing until then. */
  private resuming: Promise<void> | null = null;
  /** A session being started from the home view (`starting`): keys held for it wait until it shows. */
  private launching: Promise<void> | null = null;
  /** `home` holds a synchronized update open until the home view's first frame has been written. */
  private inkInSync = false;

  constructor(private o: CompositorOptions) {
    this.real = !o.stdin && !!process.stdin.isTTY;
    this.stdout = o.stdout ?? process.stdout;
    this.now = o.now ?? (() => performance.now());
    this.decoder = o.decoder ?? createKeyDecoder(o.homeKey);
    this.size = { cols: this.stdout.columns || 80, rows: this.stdout.rows || 24 };
    this.lay = layout(this.size.cols, this.size.rows);
    this.painter = createPainter(this.lay.interior);
    const out = this.stdout;
    // Ink writes through this, only on the home view: with each of its frames, the last row (outside
    // its rows − 1 frame) goes back to the overlay, or to the ground: Ink's erase and the terminal's
    // reflow on a resize leave it on the terminal's own background (BUG-245). It goes in the frame's
    // synchronized update, before its end marker (Ink writes its markers apart from the frame), never
    // after it (BUG-261); a write of Ink's outside an update gets one of its own. Suspending, Ink
    // erases its frame (and shows the cursor) outside any synchronized update, and the session's
    // redraw clears the screen anyway (BUG-243). While `home` holds a synchronized update open for
    // Ink's first frame, that frame's opening marker goes and its closing one ends the update, with
    // the frame and the last row in it.
    if (o.mouseCapture) {
      this.model = createScreen(this.size.cols, this.size.rows);
      // The terminal's tty turns Ink's line feeds into CR LF (as the real terminal sees them).
      void this.model.write("\x1b[20h");
      this.model.onChange(() => this.screenChanged());
    }
    const text = new TextDecoder();
    this.homeOut = new Proxy(out, {
      get: (target, prop) => {
        if (prop === "write")
          return (chunk: string | Uint8Array, ...rest: unknown[]) => {
            if (this.view.kind !== "home") {
              const done = rest.find((x) => typeof x === "function") as (() => void) | undefined;
              if (done) queueMicrotask(done);
              return true;
            }
            let data = typeof chunk === "string" ? chunk : text.decode(chunk);
            if (this.inkInSync) data = data.replaceAll(beginSync(), "");
            const open = data.lastIndexOf(beginSync());
            const end = data.lastIndexOf(endSync());
            if (end >= 0) {
              this.inkInSync = false;
              this.inkOpen = open > end;
              data = data.slice(0, end) + this.frameRow() + data.slice(end);
            } else if (open >= 0) this.inkOpen = true;
            else if (data && !this.inkOpen && !this.inkInSync) data = beginSync() + data + this.frameRow() + endSync();
            this.feed(data);
            return (target.write as (...a: unknown[]) => boolean)(data, ...rest);
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  /**
   * The real terminal's modes on the home view: everything off, but SGR mouse reports (clicks,
   * the wheel, and the drags a selection is made of) when Gluon captures the mouse
   * (`handoff.mouse_capture`; BUG-269, BUG-286). Shift+drag still selects text in most terminals.
   */
  private get homeModes(): ModesState {
    return this.o.mouseCapture ? { ...HOME_MODES, mouseTracking: "drag", mouseEncoding: "sgr" } : HOME_MODES;
  }

  /** What brings a real terminal in any state to `homeModes`. */
  private get homeModesBytes(): string {
    return MODES_RESET + modeTransition(HOME_MODES, this.homeModes);
  }

  /** The interior's size: every session's PTY (the zoomed one aside: `shown`). */
  get interior(): Rect {
    return { ...this.lay.interior };
  }

  /** Where the shown session's screen is: the interior, or while zoomed the terminal but its last row. */
  private get area(): Rect {
    return this.zoomed ? zoomLayout(this.size.cols, this.size.rows).interior : this.lay.interior;
  }

  get current(): View {
    return { ...this.view };
  }

  /** Takes the terminal: raw mode, the alternate screen, the reader, the home view. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Raw mode is the real terminal's (a test's streams have none).
    if (this.real) pinRaw();
    // A reader paused by an earlier render: Bun clears the read it left pending on the next tick;
    // a 'readable' listener added before that never fires.
    await new Promise<void>((r) => setImmediate(r));
    this.write(`\x1b[?1049h${this.homeModesBytes}${bg(GLUON_HEX.ground, this.o.truecolor)}\x1b[2J\x1b[H`);
    this.applied = this.homeModes;
    this.homeCleared();
    this.stdin.on("readable", this.onReadable);
    this.stdout.on("resize", this.onResize);
    const win = process.platform === "win32";
    const on = (sig: string, fn: () => void) => {
      process.on(sig as NodeJS.Signals, fn);
      this.signals.push([sig, fn]);
    };
    if (!win) {
      on("SIGWINCH", this.onResize);
      // 0x1c is Ctrl+\, the home key: a moment out of raw mode must never core-dump Gluon.
      on("SIGQUIT", () => {});
      for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
        on(sig, () => {
          if (sig === "SIGINT" && this.handedOver) return;
          if (sig === "SIGHUP") {
            // Writing to a terminal that hung up fails: never as an uncaught error.
            this.stdout.on("error", () => {});
            this.stdin.on("error", () => {});
          }
          this.o.onSignal?.(sig);
        });
    }
    this.unsubscribe = this.o.store.subscribe(() => this.schedule());
    // Elapsed times in the info line move on.
    this.clock = setInterval(() => this.schedule(), 15_000);
    this.clock.unref?.();
    this.o.home.mount(this.homeIn, this.homeOut, () => {
      // The frame being rendered shows the question up now (its hint names its keys): the last row follows it.
      this.framed = true;
      this.shown = this.overlay;
    });
  }

  /** Gives the terminal back: the home view unmounted, modes reset, the normal screen, line mode. */
  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    this.overlay?.done(null);
    clearTimeout(this.rowTimer);
    clearTimeout(this.paintTimer);
    clearTimeout(this.flushTimer);
    clearTimeout(this.selTimer);
    clearTimeout(this.toastTimer);
    this.model?.dispose();
    this.model = null;
    clearInterval(this.clock);
    this.unsubscribe?.();
    this.stdin.off("readable", this.onReadable);
    this.stdout.off("resize", this.onResize);
    for (const [sig, fn] of this.signals) process.off(sig as NodeJS.Signals, fn);
    for (const { off } of this.sessions.values()) off.forEach((f) => f());
    try {
      await this.o.home.unmount();
    } catch {}
    this.write(`${SGR_RESET}${MODES_RESET}\x1b[?1049l`);
    try {
      if (this.real) unpinRaw();
    } catch {}
  }

  /**
   * Gluon is failing (an uncaught error): the terminal back at once, synchronously — modes reset,
   * the normal screen, line mode. The process exits next.
   */
  abort(): void {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    this.write(`${SGR_RESET}${MODES_RESET}\x1b[?1049l`);
    try {
      if (this.real) unpinRaw();
    } catch {}
  }

  /**
   * Gives the real terminal to `run` (an agent with no pseudo-terminal of its own: one session at a
   * time): the home view suspended, the reader off, modes reset, the normal screen, line mode. Then
   * all of it back, the home view redrawn.
   */
  async handOver<T>(run: () => Promise<T>): Promise<T> {
    await this.home();
    this.overlay?.done(null);
    await this.o.home.suspend();
    this.stdin.off("readable", this.onReadable);
    clearTimeout(this.flushTimer);
    this.decoder.flush();
    // On the terminal before anything the agent's launch prints (stderr isn't queued behind stdout).
    await new Promise<void>((r) => {
      try {
        this.stdout.write(`${SGR_RESET}${MODES_RESET}\x1b[?1049l`, () => r());
      } catch {
        r();
      }
    });
    const real = this.real;
    if (real) unpinRaw();
    this.handedOver = true;
    try {
      return await run();
    } finally {
      this.handedOver = false;
      if (!this.stopped) {
        // `inTerminal` already gave the fresh reader (a no-op then); a `run` that ended the reader and didn't, gets it here.
        if (real) await freshStdin();
        if (real) pinRaw();
        // A reader paused meanwhile: listening before the next tick, no key ever comes.
        await new Promise<void>((r) => setImmediate(r));
        this.write(`\x1b[?1049h${this.homeModesBytes}${bg(GLUON_HEX.ground, this.o.truecolor)}\x1b[2J\x1b[H${SGR_RESET}`);
        this.applied = this.homeModes;
        this.homeCleared();
        this.stdin.on("readable", this.onReadable);
        await this.o.home.resume();
      }
    }
  }

  /** A session to show in the frame (it keeps running whichever view is up). */
  add(id: number, s: ViewSession): void {
    s.resize(this.lay.interior.cols, this.lay.interior.rows);
    const active = () => this.view.kind === "session" && this.view.id === id;
    const off = [s.onChange(() => active() && this.schedule()), s.onQuestion(() => active() && this.schedule())];
    this.sessions.set(id, { s, off });
  }

  /** Forgets a session (removed from the list); shows home if it was on screen. */
  async remove(id: number): Promise<void> {
    const e = this.sessions.get(id);
    if (!e) return;
    e.off.forEach((f) => f());
    this.sessions.delete(id);
    this.lines.delete(id);
    this.notes.delete(id);
    if (this.view.kind === "session" && this.view.id === id) await this.home();
  }

  /**
   * Something the session's user must read (the launch's first line couldn't be typed: the note says the
   * line): drawn wrapped over the top rows of its frame, never cut, until Esc. A session not shown shows it
   * when it is next opened. The text is made safe here (control characters); masking is the caller's.
   */
  note(id: number, text: string): void {
    if (!this.sessions.has(id) || this.stopped) return;
    this.notes.set(id, [...(this.notes.get(id) ?? []), text]);
    this.noteDue = true;
    if (this.view.kind === "session" && this.view.id === id) this.schedule(true);
  }

  session(id: number): ViewSession | undefined {
    return this.sessions.get(id)?.s;
  }

  /** The sessions' tabs in strip order (launch order): the ring ←/→ walk, after home. */
  private ring(): number[] {
    return tabs(this.o.store.sessions)
      .map((t) => t.id)
      .filter((t) => this.sessions.has(t));
  }

  /** The home key's wait for the key that picks starts or ends (only a key ends it); the bar says so. */
  private setPrefix(on: boolean): void {
    if (on === this.prefix) return;
    this.prefix = on;
    if (this.view.kind === "session") this.schedule();
  }

  /**
   * Zoom the shown session (or leave zoom): its PTY, and only its, goes to the whole terminal but the
   * last row (the others keep the interior; no SIGWINCH for them), the frame is gone, everything is
   * drawn again. Not below the minimum size, where only `tooSmall` is drawn. Zoom is manual (the screen
   * alone never triggers it), belongs to the session shown, ends with `z` again, a tab switch or home
   * (`unzoom`), and a resize keeps it.
   */
  private setZoom(on: boolean): void {
    if (on === this.zoomed || this.view.kind !== "session" || this.lay.small) return;
    this.zoomed = on;
    this.offset = 0;
    this.painter.resize(this.area);
    this.sessions.get(this.view.id)?.s.resize(this.area.cols, this.area.rows);
    this.redraw();
  }

  /** Back to the frame without drawing (`open` and `home` draw next): the zoomed session's PTY is the interior again. */
  private unzoom(): void {
    if (!this.zoomed) return;
    this.zoomed = false;
    this.painter.resize(this.lay.interior);
    if (this.view.kind === "session") this.sessions.get(this.view.id)?.s.resize(this.lay.interior.cols, this.lay.interior.rows);
  }

  /** The session's typed line is untouched (an exited agent has none: its arrows would go nowhere). */
  private untouched(id: number): boolean {
    return !this.lines.get(id) || !this.sessions.get(id)?.s.alive;
  }

  /** The switch key the bottom bar names for session `id`: the one `route` honours now (BUG-241). */
  private switchKey(id: number): string | null {
    const ids = this.ring();
    return switchKey({ untouched: this.untouched(id), onlyTab: ids.length <= 1 });
  }

  /** Shows session `id` in the frame. */
  async open(id: number): Promise<void> {
    if (!this.sessions.has(id) || this.stopped) return;
    const fromHome = this.view.kind === "home";
    this.setPrefix(false);
    this.unzoom();
    this.view = { kind: "session", id };
    this.offset = 0;
    this.pressed = false;
    this.syncSince = null;
    if (fromHome) {
      this.overlay?.done(null);
      this.dropSelection();
      this.toast = null;
      await this.o.home.suspend();
    }
    // The view may have changed while the home view let go.
    if (this.view.kind !== "session" || this.view.id !== id) return;
    this.redraw();
  }

  /** Shows the home view (the sessions keep running). */
  async home(): Promise<void> {
    if (this.view.kind === "home" || this.stopped) return;
    const from = this.view.id;
    this.setPrefix(false);
    this.unzoom();
    this.view = { kind: "home" };
    this.offset = 0;
    this.pressed = false;
    // A question asked while a session was up shows only now: its guard starts here.
    if (this.overlay) this.overlay.since = this.now();
    clearTimeout(this.paintTimer);
    this.paintTimer = undefined;
    // Ink draws from the top left of a clear screen, on the ground (its frame is rows − 1 tall).
    // The clear and Ink's first frame are one synchronized update: no blank screen between; the
    // frame's own end marker ends it (`homeOut`; BUG-243).
    this.write(`${beginSync()}${SGR_RESET}${this.homeModesBytes}${bg(GLUON_HEX.ground, this.o.truecolor)}\x1b[2J\x1b[H${SGR_RESET}`);
    this.applied = this.homeModes;
    this.homeCleared();
    this.inkInSync = true;
    this.inkOpen = false;
    // However home was reached (the home key twice, ←/→, a click), the session left is selected.
    if (this.o.store.get(from)) this.o.onHome?.(from);
    const resumed = (this.resuming = this.o.home.resume());
    try {
      await resumed;
    } finally {
      if (this.resuming === resumed) this.resuming = null;
      // Ink wrote no frame (or none with markers): the update ends here.
      if (this.inkInSync) {
        this.inkInSync = false;
        this.write(this.frameRow() + endSync());
      }
    }
  }

  /**
   * On the home view: `question` on the last row (Enter yes, Esc or Ctrl+C no; other keys are
   * ignored: BUG-213) until answered; meanwhile no key reaches the home view. `question` may be
   * its forms, longest first (`questionBar`; BUG-264). Only keys pressed once it shows answer it:
   * those still held for the home view (BUG-235) came with or right after the key that asked —
   * Delete and Enter in one read — and go nowhere (BUG-259). `signal`: the question no longer
   * stands (what it asks about went): it closes, answered no (BUG-262).
   */
  confirm(question: string | readonly string[], signal?: AbortSignal): Promise<boolean> {
    return this.choose(question, signal).then((yes) => yes === true);
  }

  /**
   * `confirm`, telling the user's no (Esc, Ctrl+C: false) from the question being taken away
   * (another question, a session opened, a handover, stopping: null).
   *
   * `selfRaised`: Gluon asks it on its own, when the user may be typing in the chat. Then Enter,
   * Esc and Ctrl+C are ignored for `SELF_GUARD_MS`; Ctrl+C is `"keep"` (neither yes nor no, so
   * the caller keeps what it asked about); and any other key, a paste included, is the user's
   * typing: the question closes as `"typed"` and the key goes on to the home view, so a draft is
   * never eaten and an Enter meant for the chat never answers.
   */
  choose(question: string | readonly string[], signal?: AbortSignal, selfRaised = false): Promise<Choice> {
    this.held = null;
    this.overlay?.done(null);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const o = {
        text: question,
        selfRaised,
        since: this.now(),
        done: (answer: Choice) => {
          if (this.overlay !== o) return;
          this.overlay = null;
          signal?.removeEventListener("abort", no);
          this.rowChanged();
          resolve(answer);
        },
      };
      const no = () => o.done(false);
      signal?.addEventListener("abort", no);
      this.overlay = o;
      this.rowChanged();
    });
  }

  /**
   * The overlay changed: the last row changes with the home view's next frame, the one whose hint
   * names the question's keys (or no longer does), in its synchronized update (BUG-261). Drawn alone
   * when no frame comes: one that didn't change, or a home view that doesn't say when it renders.
   */
  private rowChanged() {
    clearTimeout(this.rowTimer);
    if (!this.framed) return this.drawRow();
    this.rowTimer = setTimeout(() => this.drawRow(), ROW_WAIT_MS);
  }

  private drawRow() {
    clearTimeout(this.rowTimer);
    this.shown = this.overlay;
    if (this.view.kind !== "home" || this.stopped || this.handedOver) return;
    this.write(beginSync() + this.lastRowBytes() + endSync());
  }

  /** The last row as the home view's frame being written shows it (no longer due alone once that is the overlay). */
  private frameRow(): string {
    if (this.stopped) return "";
    if (this.shown === this.overlay) clearTimeout(this.rowTimer);
    return this.lastRowBytes();
  }

  /** The real terminal's last row and width (the layout is never under its minimum). */
  private get lastRow(): number {
    return this.stdout.rows || this.lay.rows;
  }
  private get realCols(): number {
    return this.stdout.columns || this.lay.cols;
  }

  /** The same bar as a session's question (`questionBar`), so both name the same keys (BUG-203). */
  private overlayBytes(q: { text: string | readonly string[] }): string {
    return `\x1b7\x1b[${this.lastRow};1H${questionBar(q.text, this.realCols, this.o.truecolor)}\x1b8`;
  }

  /** The home view's last row: the question while one is shown, else blank on the ground (BUG-245). */
  private lastRowBytes(): string {
    if (this.shown) return this.overlayBytes(this.shown);
    const runs = this.toast ? [{ text: ` ${this.toast}`, role: "dim" as const, bg: "ground" as const }] : [];
    return `\x1b7\x1b[${this.lastRow};1H${render(runs, this.realCols, this.o.truecolor)}\x1b8`;
  }

  /** Read through the getter each time: a handoff may leave a fresh stream (`freshStdin`), never a cached one. */
  private get stdin(): NodeJS.ReadStream {
    return this.o.stdin ?? currentStdin();
  }

  private write(s: string) {
    if (!s) return;
    try {
      this.stdout.write(s);
    } catch {}
  }

  private onReadable = () => {
    try {
      let chunk: string | Buffer | null;
      while ((chunk = this.stdin.read()) !== null) {
        const text = typeof chunk === "string" ? chunk : this.inText.decode(chunk, { stream: true });
        this.dispatch(this.decoder.feed(text));
      }
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.dispatch(this.decoder.flush()), this.decoder.wait?.() ?? ESC_TIMEOUT_MS);
    } catch {}
  };

  /**
   * Keys, in order, to the view that is up. At home, after a key the home view may leave on (→ or
   * Enter opens a session: anything but text), the rest wait until it has read that key, then go
   * to the view up then: typed in the same burst as →, they reach the agent, not the hidden
   * composer (BUG-235).
   */
  dispatch(keys: Key[]): void {
    if (this.held) {
      this.held.push(...keys);
      return;
    }
    for (const [i, k] of keys.entries()) {
      if (this.stopped) return;
      if (this.restOfClick(k)) continue;
      if (this.view.kind !== "home") {
        // Esc that Gluon takes (it ends the home key's wait, leaves scroll mode, answers the question), then a
        // key in a later read: that key is its own, not Alt+key (BUG-282). Otherwise the agent gets the bytes as typed.
        const s = this.sessions.get(this.view.id)?.s;
        if (k.apart && (this.prefix || this.offset > 0 || s?.question || this.notes.has(this.view.id))) return this.dispatch([...k.apart, ...keys.slice(i + 1)]);
        this.sessionKey(this.view.id, k);
        continue;
      }
      // Esc, then a key in a later read before the decoder's wait was over: both, not Alt+key (BUG-260).
      if (k.apart) return this.dispatch([...k.apart, ...keys.slice(i + 1)]);
      // A click acts on the home view as the keys before it left it: what it hasn't read yet goes first.
      if (k.name === "mouse" && !this.waited.has(k) && this.homeIn.readableLength > 0 && this.homeReads()) {
        this.waited.add(k);
        const held = (this.held = keys.slice(i));
        void this.homeRead().then(() => {
          if (this.held !== held) return;
          this.held = null;
          this.dispatch(held);
        });
        return;
      }
      if (this.homeKey(k) && k.name !== "text" && this.homeReads()) {
        const held = (this.held = keys.slice(i + 1));
        void this.homeRead().then(() => {
          if (this.held !== held) return;
          this.held = null;
          this.dispatch(held);
        });
        return;
      }
    }
  }

  /** Something reads the home view's stream: Ink, or Ink coming back (a stub in tests reads none). */
  private homeReads(): boolean {
    return this.resuming !== null || this.homeIn.listenerCount("readable") > 0;
  }

  /**
   * Resolves once the home view has read what it was given: Ink reads its stream a turn later and
   * handles every key it read at once (an → it opened a session on has moved the view by then).
   * Bounded: a home view that stops reading (suspended) doesn't hold the keys back for long. An
   * Enter it read that starts a session (`starting`): until that session shows.
   */
  private async homeRead(): Promise<void> {
    await this.resuming;
    for (let i = 0; i < HOME_READ_TRIES; i++) {
      await new Promise<void>((r) => (i === 0 ? setImmediate(r) : setTimeout(r, 5)));
      if (this.homeIn.readableLength === 0 || this.homeIn.listenerCount("readable") === 0) break;
    }
    await this.launching;
  }

  /**
   * The home view starts a session (the agent choice's Enter; `start` in src/gluon.ts takes a
   * while before it shows it). Keys that came after that Enter, held until the home view read it,
   * wait for it too: they reach the new session's agent, as after → (BUG-235), not the hidden
   * composer; one that fails, or takes over `START_HOLD_MS`, lets them go to the view up then
   * (BUG-273). Returns `start`.
   */
  starting<T>(start: Promise<T>): Promise<T> {
    const over = new Promise<void>((r) => setTimeout(r, START_HOLD_MS).unref?.());
    const settled = start.then(
      () => {},
      () => {},
    );
    const launching: Promise<void> = Promise.race([settled, over]).then(() => {
      if (this.launching === launching) this.launching = null;
    });
    this.launching = launching;
    return start;
  }

  /**
   * After a press Gluon took (a click on the tab strip), its drag and release go nowhere: not to
   * the session shown next, not into the home view's input. The next press ends that. A press in
   * a session within `DOUBLE_CLICK_MS` of a press at home that opened it is a double-click's
   * second: aimed at the home view, it and its release go nowhere either, never to the agent
   * (BUG-272).
   */
  private restOfClick(k: Key): boolean {
    const m = k.mouse;
    if (k.name !== "mouse" || !m) return false;
    if (!this.clickTaken && this.openedAt !== null && this.view.kind !== "home" && !m.release && !m.motion && !m.wheel) {
      const second = this.now() - this.openedAt <= DOUBLE_CLICK_MS;
      this.openedAt = null;
      if (second) {
        this.clickTaken = true;
        return true;
      }
    }
    if (!this.clickTaken) return false;
    if (m.release) {
      this.clickTaken = false;
      return true;
    }
    if (m.motion && m.button !== 3) return true;
    if (!m.wheel) this.clickTaken = false;
    return false;
  }

  /**
   * A mouse report at home: the home view's (a click on the list, the wheel), but while a question
   * is up (keys other than its answers go nowhere then either) or when Gluon doesn't capture the
   * mouse (then it is a late one, from the session left). A left press waits for what it turns
   * into: a drag over other cells makes a selection (`drag`), released it is copied (`finish`);
   * released where it was pressed, or a cell away (a trackpad's jitter), it is a click, which the home view gets then (BUG-286, BUG-657). A click
   * is Gluon's: the rest of it goes nowhere, not to a session it opened (`restOfClick`; BUG-240),
   * nor does a double-click's second click (BUG-272).
   */
  private homeMouse(m: MouseReport | undefined) {
    if (!m || !this.o.mouseCapture || this.overlay) return;
    // A drag reads the screen: it waits for what Ink wrote last to be parsed; so does what comes after it.
    const reads = m.button === 0 && !m.wheel && this.press && (m.motion || this.sel || this.cell(this.press) !== this.cell(m));
    if (this.behind || (this.parsing > 0 && reads)) {
      // Replayed once the model has parsed: unless the view moved on meanwhile (a session shown, Gluon stopped).
      (this.behind ??= []).push(() => this.view.kind === "home" && !this.stopped && this.homeMouse(m));
      return;
    }
    if (m.button === 0 && !m.wheel) {
      if (!m.release && !m.motion) {
        this.endSelection();
        this.press = m;
        return;
      }
      if (this.press) {
        if (m.motion) return this.drag(this.press, m);
        const press = this.press;
        this.press = null;
        // Released far from the press with no motion reported (a terminal that coalesces them): a drag all the same.
        // A selection that never began (a trackpad's jitter of a cell) is a click (BUG-657).
        if (this.sel || !this.near(press, m)) {
          this.drag(press, m);
          return this.finish();
        }
        // Its release is this one: nothing of the click is left to take.
        this.deliver(press);
        this.clickTaken = false;
        return;
      }
    }
    this.deliver(m);
  }

  /** `m` to the home view; a press is a click it takes (`clickTaken`, `openedAt`). */
  private deliver(m: MouseReport) {
    const press = !m.release && !m.motion && !m.wheel;
    if (press) this.clickTaken = true;
    this.o.home.mouse?.(m);
    // It opened a session (the home view's `onOpen` shows it at once): a second click may follow.
    if (press) this.openedAt = this.view.kind === "home" ? null : this.now();
  }

  /** The home view's screen was cleared (it draws anew): the model with it, and no selection. */
  private homeCleared() {
    this.dropSelection();
    this.toast = null;
    clearTimeout(this.toastTimer);
    this.feed(`${SGR_RESET}\x1b[2J\x1b[H`);
  }

  /**
   * What Ink wrote, into the model. The model parses a moment later: mouse reports and keys that
   * come meanwhile wait for it (`behind`), so a drag never reads a screen older than what the terminal shows.
   */
  private feed(data: string) {
    if (!this.model) return;
    this.parsing++;
    void this.model.write(data).then(() => {
      if (--this.parsing > 0 || !this.behind) return;
      const waiting = this.behind;
      this.behind = null;
      for (const f of waiting) f();
    });
  }

  /** Forgets the selection and a press waiting; the terminal shows what it shows (a redraw follows). */
  private dropSelection() {
    clearTimeout(this.selTimer);
    this.sel = null;
    this.press = null;
  }

  /** The selection gone, its cells painted as the screen has them. */
  private endSelection() {
    const model = this.model;
    if (model && this.sel) this.write(beginSync() + paintSpans(model, this.sel.painted, false) + endSync());
    this.dropSelection();
  }

  /** The cell of a report, held inside the home view's frame: the last row is the compositor's (a question, the toast), never selected. */
  private at(r: MouseReport): { x: number; y: number } {
    const model = this.model;
    return { x: Math.max(0, Math.min((model?.cols ?? 1) - 1, r.x - 1)), y: Math.max(0, Math.min((model?.rows ?? 2) - 2, r.y - 1)) };
  }

  private cell(r: MouseReport): string {
    const { x, y } = this.at(r);
    return `${x},${y}`;
  }

  /** Within a cell of each other, one way or the other (the diagonal too): a press and release that close are a click that jittered, not a drag (BUG-657). */
  private near(a: MouseReport, b: MouseReport): boolean {
    const [p, q] = [this.at(a), this.at(b)];
    return Math.abs(p.x - q.x) <= 1 && Math.abs(p.y - q.y) <= 1;
  }

  /** The press dragged to `m`: the selection from the press's cell to this one, painted (BUG-286). A selection begins past a cell's jitter (`near`). */
  private drag(press: MouseReport, m: MouseReport) {
    const model = this.model;
    if (!model) return;
    const [from, to] = [this.at(press), this.at(m)];
    if (!this.sel && this.near(press, m)) return;
    const sel: Selection = { anchor: from, head: to };
    const sp = spans(model, sel);
    // Only the cells that changed state are painted again: a drag reports many times a second.
    const { off, on } = diffSpans(this.sel?.painted ?? [], sp);
    this.sel = { sel, painted: sp, key: spansKey(sp), done: false };
    this.write(beginSync() + paintSpans(model, off, false) + paintSpans(model, on, true) + endSync());
  }

  /** The drag ended: its text goes to the terminal's clipboard and the last row says so. The selection stays shown until the next press or key. */
  private finish() {
    const sel = this.sel;
    if (!sel) return;
    sel.done = true;
    const text = copyText(this.model ? spans(this.model, sel.sel) : []);
    if (!text.trim()) return this.endSelection();
    this.write(osc52(text));
    const n = [...text].length;
    this.toast = `Copied ${n} character${n === 1 ? "" : "s"}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.drawLastRow();
    }, this.o.toastMs ?? TOAST_MS);
    this.toastTimer.unref?.();
    this.drawLastRow();
  }

  private drawLastRow() {
    if (this.view.kind !== "home" || this.stopped || this.handedOver) return;
    this.write(beginSync() + this.lastRowBytes() + endSync());
  }

  /**
   * The home view's screen model parsed output (Ink drew a frame over the highlight): once it is quiet
   * the selection is painted again, or — the text under it changed (the chat scrolled, a reply came) —
   * dropped: the frame already drew the new text.
   */
  private screenChanged() {
    if (!this.sel) return;
    clearTimeout(this.selTimer);
    this.selTimer = setTimeout(() => {
      const model = this.model;
      const sel = this.sel;
      if (!model || !sel || this.view.kind !== "home" || this.stopped) return;
      const sp = spans(model, sel.sel);
      if (spansKey(sp) !== sel.key) {
        // Released: the text it copied is gone from the screen. Still dragging: it goes on over what the screen shows now.
        if (sel.done) return this.dropSelection();
        sel.painted = sp;
        sel.key = spansKey(sp);
      }
      this.write(beginSync() + paintSpans(model, sp, true) + endSync());
    }, SELECTION_QUIET_MS);
    this.selTimer.unref?.();
  }

  /** A key at home; true when it went into the home view's stream. */
  private homeKey(k: Key): boolean {
    // The home view asks for no focus reports: one is a late one, from the session left; nor is a
    // mouse report ever text (BUG-238): it goes to the home view's `mouse` (BUG-269).
    if (k.name === "mouse") {
      this.homeMouse(k.mouse);
      return false;
    }
    if (k.name === "reply" || k.name === "focus") return false;
    // A key ends a selection: what it types or does moves the screen (after the mouse reports before it).
    if (this.behind) this.behind.push(() => this.view.kind === "home" && !this.stopped && this.endSelection());
    else this.endSelection();
    if (this.overlay) {
      const q = this.overlay;
      const answers = !k.pasted && (k.name === "enter" || k.name === "escape" || isCtrlC(k));
      // A question that came unasked: whatever else the user presses is their typing, which it gives way to.
      if (q.selfRaised && !answers) q.done("typed");
      else {
        // Enter or Esc only, as the session's question bar says (no y/n: a key typed for the
        // composer must never answer it; BUG-213).
        if (!answers || (q.selfRaised && this.now() - q.since < SELF_GUARD_MS)) return false;
        if (k.name === "enter") q.done(true);
        else q.done(isCtrlC(k) && q.selfRaised ? "keep" : false);
        return false;
      }
    }
    // Ink reads plain VT and the kitty protocol: a win32-input-mode key (on Windows, after a session
    // turned the mode on: the home key's Ctrl key-up, keys typed as the view changes) goes as what
    // it means (BUG-208); xterm's modifyOtherKeys (Shift+Enter) in kitty's form (BUG-237).
    const bytes = forInk(k);
    if (bytes) this.homeIn.write(bytes);
    return !!bytes;
  }

  private sessionKey(id: number, k: Key) {
    const s = this.sessions.get(id)?.s;
    if (!s) return;
    if (k.text === "%" && failSeam())
      setTimeout(() => {
        throw new Error("the compositor failed (test)");
      });
    const ids = this.ring();
    const actions = route(k, {
      modes: s.screen.modes(),
      capture: this.captures(s),
      interior: this.area,
      offset: this.offset,
      scrollback: s.screen.scrollbackLength(),
      question: s.question !== null,
      note: this.notes.has(id),
      untouched: this.untouched(id),
      prefix: this.prefix,
      pressed: this.pressed,
      tabRow: this.lay.tabRow,
      // The spans of the strip as drawn (`chromeBytes`); none while only `tooSmall` is.
      strip: this.lay.small || this.zoomed ? null : tabSpans(tabs(this.o.store.sessions), id, this.lay.cols),
    });
    // A release ends the press, whoever got it.
    if (k.mouse?.release) this.pressed = false;
    for (const a of actions) {
      switch (a.kind) {
        case "home":
          this.clickTaken = k.name === "mouse";
          void this.home();
          return;
        case "prefix":
          this.setPrefix(true);
          return;
        case "unprefix":
          this.setPrefix(false);
          break;
        case "switch": {
          const next = neighbour(ids, id, a.dir);
          if (next === null) void this.home();
          else if (next !== id) void this.open(next);
          return;
        }
        case "show":
          this.clickTaken = true;
          if (a.id !== id) void this.open(a.id);
          return;
        case "scroll":
          this.offset = Math.max(0, Math.min(s.screen.scrollbackLength(), this.offset + a.by));
          this.schedule(true);
          break;
        case "unscroll":
          this.offset = 0;
          this.schedule(true);
          break;
        case "dismiss":
          // The rows the note covered are the agent's again.
          this.notes.delete(id);
          this.painter.invalidate();
          this.schedule(true);
          break;
        case "zoom":
          this.setZoom(!this.zoomed);
          break;
        case "input": {
          const was = this.lines.get(id) ?? 0;
          let line = lineAfter(a.key, was);
          // A key for the agent's own dialog (hooks review, trust, approval) types nothing: an untouched line stays so (BUG-705).
          // Asked only for the key that would touch it (never per keystroke while typing), and Enter ends the line either way.
          if (!was && line && s.awaitsChoice) line = 0;
          if (line) this.lines.set(id, line);
          else this.lines.delete(id);
          // The bottom bar names the switch key that works now.
          if (!line !== !was) this.schedule();
          s.input(a.key);
          break;
        }
        case "answer":
          // A no to a held command: its line stays typed, so ←/→ edit it, not switch (BUG-234).
          if (s.holdsLine && (a.key.name === "escape" || isCtrlC(a.key))) {
            if (!this.lines.get(id)) this.schedule();
            this.lines.set(id, TOUCHED);
          }
          s.input(a.key);
          break;
        case "mouse": {
          const m = k.mouse!;
          // A press the agent gets (it drops reports while the question is up): its drag and release are held at the edge.
          if (!m.release && !m.motion && !m.wheel && s.question === null) this.pressed = true;
          s.mouse(a.bytes);
          break;
        }
        case "passthrough":
          s.passthrough(a.bytes);
          break;
      }
    }
  }

  private onResize = () => {
    const cols = this.stdout.columns || 80;
    const rows = this.stdout.rows || 24;
    if (cols === this.size.cols && rows === this.size.rows) return;
    this.size = { cols, rows };
    this.model?.resize(cols, rows);
    this.dropSelection();
    this.lay = layout(cols, rows);
    this.painter.resize(this.area);
    for (const [id, { s }] of this.sessions) {
      const r = this.zoomed && this.view.kind === "session" && this.view.id === id ? this.area : this.lay.interior;
      s.resize(r.cols, r.rows);
    }
    if (this.view.kind === "session") this.redraw();
    else this.write(this.lastRowBytes());
  };

  /**
   * Everything again: the screen cleared, the chrome and every row of the interior, in one
   * synchronized update (no blank frame between; BUG-243).
   */
  private redraw() {
    this.chrome = {};
    this.painter.invalidate();
    clearTimeout(this.paintTimer);
    this.paintTimer = undefined;
    this.write(`${beginSync()}${SGR_RESET}${bg(GLUON_HEX.ground, this.o.truecolor)}\x1b[2J${SGR_RESET}${this.frameBytes(true)}${endSync()}`);
  }

  /** A paint soon (at most one per `PAINT_MS`); `now`: right away. */
  private schedule(now = false) {
    if (this.view.kind !== "session" || this.stopped) return;
    if (now) {
      clearTimeout(this.paintTimer);
      this.paintTimer = undefined;
      this.paint(true);
      return;
    }
    if (this.paintTimer) return;
    const wait = Math.max(0, PAINT_MS - (this.now() - this.lastPaint));
    this.paintTimer = setTimeout(() => {
      this.paintTimer = undefined;
      this.paint(false);
    }, wait);
  }

  /** Paints the active session: its modes, the chrome that changed, the interior's damage. */
  private paint(force: boolean) {
    const out = this.frameBytes(force);
    if (out) this.write(beginSync() + out + endSync());
  }

  /**
   * What brings the terminal in line with the active session (`paint`, `redraw`): "" when nothing
   * changed, or while the agent is in the middle of a synchronized update (a paint is scheduled).
   */
  private frameBytes(force: boolean): string {
    if (this.view.kind !== "session" || this.stopped) return "";
    const id = this.view.id;
    const s = this.sessions.get(id)?.s;
    const v = this.o.store.get(id);
    if (!s || !v) return "";
    // The agent is in the middle of a synchronized update: wait for its end (a while at most).
    if (!force && syncPending(s.screen)) {
      this.syncSince ??= this.now();
      if (this.now() - this.syncSince < SYNC_WAIT_MS) {
        this.paintTimer = setTimeout(() => {
          this.paintTimer = undefined;
          this.paint(false);
        }, 10);
        return "";
      }
    }
    this.syncSince = null;
    this.lastPaint = this.now();
    // Too small for the frame: one line, never the bottom bar over the frame (BUG-181). A resize
    // back redraws everything.
    if (this.lay.small) {
      const bytes = tooSmall(this.o.homeKey, this.stdout.columns || this.lay.cols, this.o.truecolor, this.stdout.rows || this.lay.rows);
      if (this.chrome.small === bytes) return "";
      this.chrome = { small: bytes };
      this.painter.invalidate();
      return bytes;
    }
    let out = "";
    const modes = effectiveModes(s.screen.modes(), this.captures(s));
    out += modeTransition(this.applied, modes);
    this.applied = modes;
    const chrome = this.chromeBytes(id);
    out += chrome;
    this.offset = Math.min(this.offset, s.screen.scrollbackLength());
    const body = this.painter.paint(s.screen, { scrollOffset: this.offset });
    out += body;
    // The note covers rows the painter draws: whatever it painted, and whenever it changed, it goes on top again.
    const note = body || this.noteDue ? this.noteBytes(id) : "";
    this.noteDue = false;
    out += note;
    // The chrome (or the note) moved the cursor: put it back where the agent has it.
    if (chrome || note) out += this.cursor(s.screen);
    return out;
  }

  /**
   * Gluon takes the wheel for the frame's scrollback (`handoff.mouse_capture`), except while the
   * agent is on its alternate screen: nothing to scroll back there, and the terminal's own
   * wheel-as-arrows reach the agent (BUG-175). Read at every paint, so it follows the agent.
   */
  private captures(s: ViewSession): boolean {
    return this.o.mouseCapture && !s.screen.altScreen();
  }

  private cursor(screen: TermScreen): string {
    const { x, y } = screen.cursor();
    const r = this.area;
    const shown = this.offset === 0 && screen.cursorVisible() && x < r.cols && y < r.rows && y < screen.rows;
    return shown ? `\x1b[${r.top + y + 1};${r.left + x + 1}H\x1b[?25h` : "\x1b[?25l";
  }

  /** The session's notes over the top rows of the frame, in the question bar's colours (none while there is none). */
  private noteBytes(id: number): string {
    const texts = this.notes.get(id);
    if (!texts) return "";
    const r = this.area;
    const rows = noteRows(texts, r.cols, this.o.truecolor, r.rows);
    return rows.map((row, i) => `\x1b[${r.top + i + 1};${r.left + 1}H${row}`).join("");
  }

  /** The chrome rows that changed since the last paint (all of them after a redraw). */
  private chromeBytes(id: number): string {
    const v = this.o.store.get(id)!;
    const s = this.sessions.get(id)!.s;
    const { cols } = this.lay;
    const tc = this.o.truecolor;
    const runs = tabs(this.o.store.sessions);
    const others: Record<SessionState, number> = counts(this.o.store.sessions.filter((x) => x.id !== id && x.state !== "drafting"));
    // Zoomed: the last row is all there is of the chrome (the scroll indicator lives in it).
    const bar = this.prefix
      ? prefixBar(this.o.homeKey, cols, tc, this.zoomed)
      : s.question !== null
        ? questionBar(s.question, cols, tc)
        : this.zoomed
          ? zoomBar(this.o.homeKey, others, cols, tc, this.offset)
          : bottomBar(this.o.homeKey, others, cols, tc, this.switchKey(id));
    const rows: Record<string, string> = this.zoomed
      ? { bar: `\x1b[${this.lay.barRow + 1};1H${bar}` }
      : {
          tabs: `\x1b[${this.lay.tabRow + 1};1H${tabStrip(runs, id, cols, tc)}`,
          info: `\x1b[${this.lay.infoRow + 1};1H${infoLine(v, Date.now(), cols, tc, this.o.config)}`,
          frame: frameBox(this.lay.frame, tripleSegs(v.agent, this.o.config), scrollFooter(this.offset), tc),
          bar: `\x1b[${this.lay.barRow + 1};1H${bar}`,
        };
    let out = "";
    for (const [k, bytes] of Object.entries(rows)) {
      if (this.chrome[k] === bytes) continue;
      this.chrome[k] = bytes;
      out += bytes;
    }
    return out;
  }
}
