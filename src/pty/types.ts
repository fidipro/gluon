/**
 * Gluon runs each agent in a PTY of its own (`session.ts`). On the way it sees the user's keys
 * (`KeyDecoder`) and the agent's screen (`Screen`), so it can hold the Enter of a typed `/clear`
 * or `/compact` (`Interceptor`) and ask the user whether to end the session.
 *
 * Security: keys and screen stay in memory, are never logged, written or sent; the screen alone
 * never triggers anything (the repo's text can draw on it); a paste never counts.
 */
import type { Harness } from "../harnesses.ts";

/**
 * What a key is. Gluon's own keys: `return-key` (`handoff.key`, the prefix for switching),
 * `scroll-up` / `scroll-down` (Shift+PgUp / Shift+PgDn); `left` / `right` (plain ←/→) and
 * `alt-left` / `alt-right` (Alt+←/→) are Gluon's only on an untouched line (`route` in `compositor.ts`). Not typed keys:
 * `mouse` (a mouse report, parsed in `mouse`), `focus` (focus in/out), `reply` (the terminal
 * answering a query: OSC, DCS, APC, device attributes, cursor position, …). A key the router
 * doesn't consume goes on as its `raw`, whatever its kind.
 */
export type KeyName =
  | "text"
  | "enter"
  | "backspace"
  | "tab"
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "other"
  | "return-key"
  | "alt-left"
  | "alt-right"
  | "scroll-up"
  | "scroll-down"
  | "mouse"
  | "focus"
  | "reply";

/** How a terminal reports the mouse: SGR (1006), urxvt (1015), UTF-8 (1005) or plain X10/normal (no mode). */
export type MouseEncoding = "sgr" | "urxvt" | "utf8" | "x10";

/** One mouse report, as `keys.ts` parses it (`encodeMouse` writes it again, shifted). */
export interface MouseReport {
  /** The button value as reported (X10/UTF-8/urxvt: minus 32): button, modifier, motion and wheel bits. */
  code: number;
  /** 0 left, 1 middle, 2 right, 3 none (motion with no button, or a release outside SGR), 4–7 wheel, 8–11 extra buttons. */
  button: number;
  /** 1-based cell, as the terminal sent it. */
  x: number;
  y: number;
  release: boolean;
  motion: boolean;
  wheel: "up" | "down" | "left" | "right" | null;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** The encoding it came in. */
  encoding: MouseEncoding;
}

/** One key from the user. `raw` is what goes to the agent (unless held); `text` for printable keys. */
export interface Key {
  name: KeyName;
  raw: string;
  text?: string;
  /** Inside a bracketed paste: never a command, never the return key. */
  pasted?: boolean;
  /** `mouse` only. */
  mouse?: MouseReport;
  /** `focus` only. */
  focus?: "in" | "out";
  /**
   * Alt+key whose ESC came in an earlier read than the key: the Esc key pressed, then that key.
   * The home view gets them apart (BUG-260); an agent gets `raw`, as typed.
   */
  apart?: Key[];
}

/**
 * Splits the user's input into keys: plain bytes, the kitty keyboard protocol (`CSI … u`), Windows
 * win32-input-mode, rxvt's Alt as an ESC prefix, bracketed paste, and mouse, focus and terminal
 * replies as kinds of their own. Chunks may split a sequence anywhere. `returnKey`: `handoff.key`
 * (default `ctrl+\`).
 */
export interface KeyDecoder {
  feed(chunk: string): Key[];
  /** After a short pause with no input (`wait()`): a lone ESC is the Esc key; an unfinished sequence goes on as is. */
  flush(): Key[];
  /** How long to wait for more input before `flush` (`ESC_TIMEOUT_MS`; `CSI_TIMEOUT_MS` for a CSI under way). */
  wait?(): number;
}

/** One screen cell, as far as readers need it. */
export interface Cell {
  char: string;
  inverse: boolean;
  bold: boolean;
  /** Faint (SGR 2): placeholders and hints. */
  dim?: boolean;
  /** Palette or RGB colour as xterm reports it; -1 for the default. */
  fg: number;
  bg: number;
}

/** The agent's screen as a terminal would show it (`@xterm/headless`), fed with its output. */
export interface Screen {
  readonly cols: number;
  readonly rows: number;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): void;
  cursor(): { x: number; y: number };
  /**
   * One visible row: its text (trailing spaces trimmed) and cells; `wrapped`: the terminal wrapped
   * the row above onto this one (it went past the last column), so this row continues it.
   */
  line(y: number): { text: string; cells: Cell[]; wrapped?: boolean };
  /** Escape sequences that redraw the whole visible screen and cursor (after the question bar). */
  serialize(): string;
  dispose(): void;
}

/** Per harness: where its input line and its slash-command menu are on its screen. */
export interface ScreenReader {
  /** The text in the agent's input box (prompt marker stripped), or null when it can't tell. */
  inputLine(screen: Screen): string | null;
  /**
   * The highlighted item of the slash-command menu ("/clear"), or null when there's no menu; ""
   * when a menu is shown whose highlight can't be read (NO_COLOR) and Enter may run another item
   * than the input names: nothing is held then.
   */
  selectedCommand(screen: Screen): string | null;
  /**
   * The harness's own dialog is up, waiting for the user to pick an option (Claude Code's first-run
   * "trust this folder" question): with no input box, the session still awaits the user. Display
   * only (`AgentSession`'s status); a reader that can't tell leaves it out.
   */
  awaitsChoice?(screen: Screen): boolean;
  /**
   * The agent's own UI says the turn was cut off and it now waits for the user (Claude Code's
   * `Interrupted · What should Claude do instead?` and its "Context limit reached", Codex's
   * `Conversation interrupted`): the marker is the last thing in the transcript, right above the
   * composer, on the agent's own rows. Those harnesses send no hook on Esc, so a hook's `working`
   * would never end. Display only, and it only ENDS a Working state (`AgentSession`'s `fallback`);
   * a reader that can't tell leaves it out.
   */
  interrupted?(screen: Screen): boolean;
  /**
   * The harness shows it is in Plan mode (Codex: `Plan mode` in the footer, "Model changed to … for
   * Plan mode." in the history). Display only: Gluon checks that a `/plan` it typed took
   * (`AgentSession`'s first line) and tells the user when not; a reader that can't tell leaves it out.
   */
  planMode?(screen: Screen): boolean;
  /**
   * The agent has started up far enough to take its first line: its composer can be on screen before that (Kimi Code
   * draws it before it has applied its env model, and a line sent then draws `Error: LLM not set`; BUG-674). Only
   * `AgentSession`'s first line asks, on top of an empty composer: it waits (up to its bound) for this; the user's own
   * typing and the status never do. Absent: always ready.
   */
  ready?(screen: Screen): boolean;
}

/** What a held Enter would have run. */
export type Intercepted = "clear" | "compact";

/**
 * Sees every key before it's forwarded (and the screen as it is at that moment). Returns what an
 * Enter would run when that's `/clear` (or `/new`) or `/compact` and the user typed the `/`
 * (not pasted) — the Enter is then held; null otherwise (forward it). OpenCode runs the
 * highlighted slash-menu item on Tab too, so there a Tab can be held: whatever key is held, its
 * own `raw` is what goes on when the user stays.
 */
export interface Interceptor {
  key(k: Key, screen: Screen): Intercepted | null;
  /** The command (one of `COMMANDS`) behind what `key` last returned: `/clear`, `/new`, … (BUG-270). */
  command(): string | null;
  /**
   * The key `key` last returned a command for was never sent (the user said no): the typed line
   * is as it was before it, so the next Enter on it is judged the same way (BUG-234).
   */
  unsent(): void;
}

export interface InterceptorOptions {
  harness: Harness;
  clear: boolean;
  compact: boolean;
}

/** An unanswered compaction question lets the agent compact. */
export const COMPACT_TIMEOUT_MS = 120_000;

/**
 * Gluon's questions (in the bottom bar): a yes ends the session, the agent keeps nothing. A held
 * `/clear` (`/new`, `/reset`) says what it does in Gluon, so a no reads as keeping the session, not
 * as losing work (BUG-270).
 */
export const endQuestion = (command: string) => `${command} ends this session in Gluon — end it?`;
export const END_QUESTION = endQuestion("/clear");
export const END_COMPACT_QUESTION = "End this session instead of compacting?";

/**
 * A question's shorter forms, longest first, for a bar too narrow for it and its keys
 * (`questionBar`): each still says what a yes does (BUG-254, BUG-264).
 */
export const SHORTER_QUESTIONS: Readonly<Record<string, readonly string[]>> = {
  [END_COMPACT_QUESTION]: ["End instead of compacting?", "End instead?"],
};

/** `question`'s shorter forms (`SHORTER_QUESTIONS`; an `endQuestion` for any command), longest first. */
export function shorterQuestions(question: string): readonly string[] {
  const end = /^(\/\S+) ends this session in Gluon — end it\?$/.exec(question);
  if (end) return [`${end[1]} ends this session — end it?`, "End this session?", "End session?"];
  return SHORTER_QUESTIONS[question] ?? [];
}
