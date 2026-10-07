import { asVt, erases, isCtrlC, isKeyUp } from "./keys.ts";
import { COMMANDS, READERS, TAB_RUNS } from "./readers/index.ts";
import type { Intercepted, Interceptor, InterceptorOptions, Key, Screen } from "./types.ts";

/** Longest typed line kept for the fallback; longer lines can't be a bare command anyway. */
const MAX_TYPED = 64;


/**
 * A key that puts a newline into the agent's input instead of running it: Ctrl+J, Alt+Enter,
 * Shift/Ctrl/Alt+Enter in the kitty protocol, xterm's modifyOtherKeys or win32-input-mode.
 */
const isNewline = (k: Key) =>
  k.name === "other" && (/^\x1b?[\r\n]$/.test(k.raw) || /^\x1b\[13;\d+(:\d+)*u$/.test(k.raw) || /^\x1b\[27;\d+;13~$/.test(k.raw) || /^\x1b\[\d+;\d+;1[03];1;\d+;\d+_$/.test(k.raw));

/** `lineAfter`'s line once a key other than a printable or Backspace went to it, until the next Enter. */
export const TOUCHED = Infinity;

const WIN32_REPEAT = /^\x1b\[\d*;\d*;\d*;\d*;\d*;(\d*)_$/;

/**
 * The agent's typed line since the last Enter, as the user's keys say it (the screen only says that a
 * key went to a dialog, below; never what was typed, like the interceptor's line): 0 untouched (a session starts so), n > 0 printables typed and not
 * backspaced, `TOUCHED` once any other key went to it. Plain ←/→ are Gluon's only on an untouched
 * line (`route` in `compositor.ts`).
 * - an Enter (not pasted) empties it;
 * - a key let go (a key-up; a win32 key with no meaning, Ctrl alone before the home key's `\`:
 *   BUG-209) changes nothing;
 * - Esc and Ctrl+C interrupt the agent (they still go to it): an untouched line stays untouched,
 *   so ← still switches tabs after them (BUG-211); a typed one is `TOUCHED`;
 * - a typed printable (not pasted) adds its code points (a win32 key times its repeat count), a
 *   plain Backspace takes one off, never below 0: `BBB` and three Backspaces leave the line
 *   untouched (BUG-268). Conservative: a Backspace that erased more, or a printable the agent
 *   didn't insert, only keeps the line touched longer;
 * - anything else (Tab, an arrow, Delete, Ctrl+U/W, Alt+Backspace, a paste, …) makes it `TOUCHED`.
 * The compositor skips this for a key typed to the agent's own dialog (`awaitsChoice`; BUG-705): it types nothing.
 */
export function lineAfter(k: Key, line: number): number {
  if (k.name === "enter" && !k.pasted) return 0;
  if (isKeyUp(k) || asVt(k) === "") return line;
  if (k.pasted) return TOUCHED;
  if (k.name === "escape" || isCtrlC(k)) return line === 0 ? 0 : TOUCHED;
  if (k.name === "backspace") return Math.max(0, line - 1);
  if (k.name === "text" && k.text) return line + [...k.text].length * Math.max(1, Number(WIN32_REPEAT.exec(k.raw)?.[1] || 1));
  return TOUCHED;
}

/**
 * Which Enter to hold. Tracks the keys since the last Enter (in memory only, cleared on Enter,
 * Ctrl+C and the return key; Esc, below):
 * - the first printable key must be a typed `/` (a paste anywhere in the line: never);
 * - edits, Tab and arrows are fine: on Enter the screen says what runs — the highlighted
 *   slash-menu item when a menu is shown and the input is a prefix of it, else the input line
 *   (with a menu shown, the item and the input must then agree);
 * - that command (its first word: `/compact focus on x` compacts, `/clear name` clears) must be
 *   one of `COMMANDS[harness]` for a setting that's on;
 * - a screen the reader can't read, or one that shows only part of the line typed key by key
 *   with no edits (the agent hasn't echoed it all yet: `/clear` and Enter in one chunk): only
 *   such a line that is exactly a command counts (BUG-150);
 * - input on several rows: one line the agent wrapped (it draws long input on several rows itself),
 *   unless a key put a newline in it or recalled history (Up/Down): a real multi-line input never
 *   counts (BUG-148); nor does a line ending in `\` (Enter adds a newline there).
 * In OpenCode, Tab runs the highlighted menu item, so a Tab there is judged like an Enter on the
 * menu (`TAB_RUNS`).
 *
 * The screen alone never triggers anything (a repository's text can draw on it): without typed
 * keys that start with `/`, nothing is held, and whenever it is unsure (`null`) the Enter goes on.
 * Keys and screen stay in memory.
 *
 * Esc may only close the slash menu and keep the typed line (Claude Code, Codex), or clear it: a
 * line that started with a typed `/` stays started (the screen tells on Enter what is left), but
 * no longer counts as typed with no edits; any other line starts over (BUG-147).
 *
 * A key that erases (`erases`: Backspace, Delete, Ctrl+U, Ctrl+W, …) may have emptied a line that
 * didn't start with a typed `/`: the next printable may start it again, but only the screen can
 * then say what runs (what each key erased depends on the harness and the cursor), so the line
 * never counts as typed with no edits (BUG-205). A paste in it still never counts.
 */
export function createInterceptor(opts: InterceptorOptions): Interceptor {
  let started = false;
  let pasted = false;
  let plain = true;
  let typed = "";
  /** A key put a newline into the input, or brought back a past one (Up/Down). */
  let multiline = false;
  const reset = () => {
    started = pasted = multiline = false;
    plain = true;
    typed = "";
  };
  /** The line as it was before the key that last returned a command (`unsent`). */
  let held: { started: boolean; pasted: boolean; plain: boolean; typed: string; multiline: boolean } | null = null;
  const hold = (out: Intercepted | null) => {
    held = out ? { started, pasted, plain, typed, multiline } : null;
    reset();
    return out;
  };

  /** The command behind the last `classify` that named one (`command`). */
  let command: string | null = null;
  const classify = (line: string): Intercepted | null => {
    const word = line.trim().split(/\s+/)[0]!;
    const of = (kind: Intercepted) => {
      command = COMMANDS[opts.harness][kind].find((c) => c === word) ?? null;
      return kind;
    };
    if (opts.clear && COMMANDS[opts.harness].clear.includes(word)) return of("clear");
    if (opts.compact && COMMANDS[opts.harness].compact.includes(word)) return of("compact");
    return null;
  };

  const read = (screen: Screen) => {
    const reader = READERS[opts.harness];
    try {
      return { input: reader.inputLine(screen), selected: reader.selectedCommand(screen) };
    } catch {
      return { input: null, selected: null };
    }
  };

  /** What runs now; `menuOnly`: only a highlighted menu item counts (Tab). */
  const resolve = (screen: Screen, menuOnly: boolean): Intercepted | null => {
    if (!started || pasted || (!opts.clear && !opts.compact)) return null;
    const { input, selected } = read(screen);
    if (input === null) return !menuOnly && plain && /^\/\S+$/.test(typed) ? classify(typed) : null;
    if (input.includes("\n") && multiline) return null;
    // Rows the agent wrapped: one line.
    const line = input.replace(/\s*\n\s*/g, " ").trim();
    // The echo lags behind the keys.
    if (!menuOnly && plain && /^\/\S+$/.test(typed) && line !== typed && typed.startsWith(line)) return classify(typed);
    if (!line.startsWith("/") || line.endsWith("\\")) return null;
    // A menu whose highlight can't be read: Enter may run another item.
    if (selected === "" && !/\s/.test(line)) return null;
    if (selected && !/\s/.test(line)) {
      if (selected.startsWith(line)) return classify(selected);
      // The menu runs its highlighted item, which doesn't start with the input (Claude Code's
      // "/clear (new)" for /new; OpenCode's fuzzy "/review" for /compact outside a session):
      // hold only when both say the same.
      const a = classify(selected);
      return a === classify(line) ? a : null;
    }
    return menuOnly ? null : classify(line);
  };

  return {
    key(k, screen) {
      // `unsent` comes before any next key, or never.
      held = null;
      if (k.name === "return-key" || isCtrlC(k)) {
        reset();
        return null;
      }
      if (k.name === "escape") {
        if (started) plain = false;
        else reset();
        return null;
      }
      if (k.name === "enter" && !k.pasted) return hold(resolve(screen, false));
      if (k.name === "tab" && !k.pasted && TAB_RUNS.has(opts.harness)) {
        const out = resolve(screen, true);
        if (out) return hold(out);
      }
      if (isNewline(k) || k.name === "up" || k.name === "down") multiline = true;
      if (erases(k)) {
        plain = false;
        if (!started) typed = "";
        return null;
      }
      if (k.pasted) pasted = true;
      else if (k.name === "text" && k.text !== undefined) {
        if (typed === "") started = k.text.startsWith("/");
        if (typed.length + k.text.length <= MAX_TYPED) typed += k.text;
        else plain = false;
      } else plain = false;
      return null;
    },
    command: () => command,
    unsent() {
      if (!held) return;
      ({ started, pasted, plain, typed, multiline } = held);
      held = null;
    },
  };
}
