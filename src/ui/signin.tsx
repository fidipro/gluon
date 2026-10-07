/**
 * The sign-in screens (`gluon setup`, `gluon connect`, the first run): a picker in the shape
 * of Claude Code's login menu, a checklist, and a text or masked key prompt.
 * Each renders on its own, resolves with the answer and leaves its last frame on screen as a record.
 *
 * - A digit moves the selection and Enter confirms it (as in the session UI), so the Enter never
 *   falls through to the next menu; two-digit numbers work in long lists.
 * - Keys that arrive in one read are handled one by one ("13" checks rows 1 and 3).
 * - Esc answers null: the flow goes back one screen, or leaves on its first (`esc` says which, for
 *   the footer); Ctrl+C quits the whole flow (`Cancelled` is thrown).
 * - Each menu stays shorter than the terminal (margins go, then the body is clipped, then the
 *   list scrolls), so Ink never clears the screen and the scrollback.
 * - All of them ignore a late reply to the terminal's background-colour query (useLateOscFilter).
 * - Raw mode is on before a menu's first frame and held across to the next one (`inkRender`), so
 *   a key pressed as soon as a menu shows is never lost (BUG-133).
 */
import { Box, Text, useApp, useInput, usePaste, useWindowSize, type Key } from "ink";
import { useEffect, useRef, useState } from "react";
import { optionHeight, OptionRow } from "./bottom.tsx";
import { NO_KEY, splitKeys, useLateOscFilter } from "./keys.ts";
import { inkRender } from "./rawmode.ts";
import { inline } from "./markdown.tsx";
import type { Theme } from "./theme.ts";
import { Indent, Width, wrap, Wrapped } from "./width.tsx";

export interface PickOption {
  label: string;
  description?: string;
}

/** Ctrl+C in a menu: the whole flow (setup, connect) stops. */
export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** A menu's answer when Ctrl+C was pressed. */
const QUIT = Symbol("quit");
type Answer<T> = T | null | typeof QUIT;

/** What Esc does in this screen, as the footer says: back one screen, leave (the first screen), or skip (an offer between screens). */
export type EscAction = "back" | "cancel" | "skip";
const escHint = (esc: EscAction = "cancel") => `esc to ${esc === "back" ? "go back" : esc} · ctrl+c to quit`;

interface PickProps {
  theme: Theme;
  title: string;
  /** Lines under the title (markdown inline: `code`, **bold**). */
  body?: string[];
  options: PickOption[];
  initial?: number;
  esc?: EscAction;
  /**
   * A choice that runs something (an installer): only a key pressed on its own counts. Keys in the
   * first GUARD_MS (typed ahead), a paste, a read that holds Enter with other keys, Alt+digit: all
   * ignored; the selection doesn't wrap (Up from the first row doesn't reach the last).
   */
  guard?: boolean;
  onDone: (choice: Answer<number>) => void;
}

/** How long a guarded menu ignores keys after it appears. */
export const GUARD_MS = 250;

/** Keys for a menu, one press each: a batch Ink delivered as one string is split back, plain text included. */
function menuKeys(input: string, key: Key): [string, Key][] {
  if (input.length <= 1) return [[input, key]];
  return splitKeys(input).flatMap(([i, k]): [string, Key][] => (k === NO_KEY && i.length > 1 ? [...i].map((c): [string, Key] => [c, NO_KEY]) : [[i, k]]));
}

/** Keys for a text prompt: control keys split out, text runs kept together. */
const textKeys = (input: string, key: Key): [string, Key][] => (input.length > 1 && /[\x00-\x1f\x7f]/.test(input) ? splitKeys(input) : [[input, key]]);

/**
 * Number keys for a list of `count` rows: "1" then "0" within a second is row 10 (when there is
 * one). Returns the row (1-based) and whether it replaces the row the previous digit picked.
 */
function useNumbers(count: number) {
  const last = useRef<{ digit: string; at: number } | null>(null);
  return (d: string): { n: number; replaces: boolean } | null => {
    if (!/^[0-9]$/.test(d)) return null;
    const prev = last.current && Date.now() - last.current.at < 1000 ? last.current.digit : "";
    last.current = null;
    if (prev && Number(prev + d) <= count) return { n: Number(prev + d), replaces: true };
    if (Number(d) * 10 <= count) last.current = { digit: d, at: Date.now() };
    return Number(d) >= 1 && Number(d) <= count ? { n: Number(d), replaces: false } : null;
  };
}

/** Resolves `onDone` once, then lets the last frame render before Ink lets go of the terminal. */
function useFinish<T>(onDone: (v: T) => void) {
  const { exit } = useApp();
  const [done, setDone] = useState<{ value: T } | null>(null);
  useEffect(() => {
    if (!done) return;
    onDone(done.value);
    const t = setTimeout(() => exit(), 20);
    return () => clearTimeout(t);
  }, [done]);
  return [done, (value: T) => setDone((d) => d ?? { value })] as const;
}

const lineCount = (text: string, width: number) => wrap(text, Math.max(10, width)).split("\n").length;

/**
 * How a menu fits in `rows - 1` rows: whether its margins go (`compact`), how many rows its body
 * gets (null: all), and which rows of its list show (a window around the cursor).
 */
export function fitMenu(opts: { columns: number; rows: number; title: string; body: string[]; items: number[]; cursor: number; footer: boolean }) {
  const width = opts.columns - 1;
  const titleRows = lineCount(opts.title, width - 1);
  const bodyRows = opts.body.reduce((n, l) => n + (l ? lineCount(l, width - 2) : 1), 0);
  const itemRows = opts.items.reduce((a, b) => a + b, 0);
  const avail = Math.max(3, opts.rows - 1);
  const size = (compact: boolean, body: number, items: number) =>
    (compact ? 0 : 1) + titleRows + (body ? body + (compact ? 0 : 1) : 0) + items + (compact ? 0 : 1) + (opts.footer ? (compact ? 1 : 2) : 0);
  const all = { start: 0, end: opts.items.length };
  if (size(false, bodyRows, itemRows) <= avail) return { compact: false, bodyRows: null, window: all };
  if (size(true, bodyRows, itemRows) <= avail) return { compact: true, bodyRows: null, window: all };
  // The list first (clipping the body to what's left), unless the list alone doesn't fit.
  const forBody = avail - size(true, 0, itemRows);
  if (forBody >= Math.min(bodyRows, 2)) return { compact: true, bodyRows: Math.min(bodyRows, forBody), window: all };
  const forItems = Math.max(1, avail - size(true, 0, 0) - 1);
  let start = Math.min(opts.cursor, opts.items.length - 1);
  let end = start + 1;
  let used = opts.items[start] ?? 1;
  while (true) {
    if (end < opts.items.length && used + opts.items[end]! <= forItems) used += opts.items[end++]!;
    else if (start > 0 && used + opts.items[start - 1]! <= forItems) used += opts.items[--start]!;
    else break;
  }
  return { compact: true, bodyRows: 0, window: { start, end } };
}

/** The body's first lines that fit in `rows` rows, whole: a line is never cut through (the first ones matter most). */
export function wholeLines(body: string[], rows: number | null, width: number): string[] {
  if (rows === null) return body;
  const out: string[] = [];
  let used = 0;
  for (const l of body) {
    const n = l ? lineCount(l, width) : 1;
    if (used + n > rows) break;
    out.push(l);
    used += n;
  }
  while (out.length && !out.at(-1)) out.pop();
  return out;
}

function Title({ theme, title, body = [], dim = false, bodyRows = null, compact = false, columns }: { theme: Theme; title: string; body?: string[]; dim?: boolean; bodyRows?: number | null; compact?: boolean; columns: number }) {
  const shown = wholeLines(body, bodyRows, columns - 3);
  return (
    <>
      <Box flexShrink={0}>
        <Text bold color={theme.accent}>
          {title}
        </Text>
      </Box>
      {shown.length ? (
        <Box flexDirection="column" marginTop={compact ? 0 : 1} flexShrink={0} {...(bodyRows ? { height: bodyRows, overflow: "hidden" as const } : {})}>
          <Indent by={1}>
            {shown.map((line, i) => (line ? <Wrapped key={i} text={inline(line, theme)} dimColor={dim} /> : <Text key={i}> </Text>))}
          </Indent>
        </Box>
      ) : null}
    </>
  );
}

/** A menu's frame: capped below the terminal's height. */
function Frame({ columns, rows, compact, children }: { columns: number; rows: number; compact: boolean; children: React.ReactNode }) {
  return (
    <Width columns={columns - 1}>
      <Box flexDirection="column" paddingLeft={1} marginTop={compact ? 0 : 1} maxHeight={Math.max(3, rows - 1 - (compact ? 0 : 1))} overflow="hidden">
        {children}
      </Box>
    </Width>
  );
}

function Footer({ text, compact, extra }: { text: string; compact: boolean; extra?: string }) {
  return (
    <Box marginTop={compact ? 0 : 1} flexShrink={0}>
      <Text dimColor wrap="truncate-end">
        {extra ? `${extra} · ${text}` : text}
      </Text>
    </Box>
  );
}

/** "rows 3-9 of 10" when the list scrolls. */
const scrolled = (w: { start: number; end: number }, n: number) => (w.end - w.start < n ? `rows ${w.start + 1}-${w.end} of ${n}` : undefined);

function List({ options, labelWidth, theme, window, compact, row }: { options: PickOption[]; labelWidth: number; theme: Theme; window: { start: number; end: number }; compact: boolean; row: (o: PickOption, i: number) => { label: string; selected: boolean } }) {
  return (
    <Box flexDirection="column" marginTop={compact ? 0 : 1} flexShrink={0}>
      <Indent by={1}>
        {options.slice(window.start, window.end).map((o, j) => {
          const i = window.start + j;
          const r = row(o, i);
          return <OptionRow key={i} n={i + 1} count={options.length} label={r.label} description={o.description} labelWidth={labelWidth} theme={theme} selected={r.selected} />;
        })}
      </Indent>
    </Box>
  );
}

function Pick({ theme, title, body = [], options, initial = 0, esc, guard = false, onDone }: PickProps) {
  const { columns, rows } = useWindowSize();
  const [selected, setSelected] = useState(initial);
  const [done, finish] = useFinish(onDone);
  const ref = useRef(initial);
  const shown = useRef(Date.now());
  const select = (i: number) => setSelected((ref.current = i));
  const number = useNumbers(options.length);
  const n = options.length;

  const onKey = useLateOscFilter((input, key) => {
    const keys = menuKeys(input, key);
    const early = guard && Date.now() - shown.current < GUARD_MS;
    // Enter with anything else in one read: a paste, or keys typed ahead.
    const batch = guard && keys.length > 1 && keys.some(([, k]) => k.return);
    for (const [i, k] of keys) {
      if (k.ctrl && i === "c") return finish(QUIT);
      if (k.escape) return finish(null);
      if (early || batch || (guard && k.meta)) continue;
      if (k.return) return finish(ref.current);
      if (k.upArrow) select(guard ? Math.max(0, ref.current - 1) : (ref.current + n - 1) % n);
      else if (k.downArrow || k.tab) select(guard ? Math.min(n - 1, ref.current + 1) : (ref.current + 1) % n);
      else {
        const d = number(i);
        if (d) select(d.n - 1);
      }
    }
  });
  useInput(onKey, { isActive: !done });
  // Guarded: bracketed paste on, and a paste goes nowhere.
  usePaste(() => {}, { isActive: guard && !done });

  const labelWidth = Math.max(...options.map((o) => o.label.length));
  const fit = fitMenu({ columns, rows, title, body, items: options.map((o) => optionHeight(columns - 2, o, labelWidth, options.length)), cursor: selected, footer: !done });
  return (
    <Frame columns={columns} rows={rows} compact={fit.compact}>
      <Title theme={theme} title={title} body={body} bodyRows={fit.bodyRows} compact={fit.compact} columns={columns} />
      <List options={options} labelWidth={labelWidth} theme={theme} window={fit.window} compact={fit.compact} row={(o, i) => ({ label: o.label, selected: done ? i === done.value : i === selected })} />
      {done ? null : <Footer compact={fit.compact} extra={scrolled(fit.window, options.length)} text={`enter to select · ${escHint(esc)}`} />}
    </Frame>
  );
}

/** Throws Cancelled for Ctrl+C. */
function answer<T>(a: Answer<T>): T | null {
  if (a === QUIT) throw new Cancelled();
  return a;
}

/** Shows a picker; resolves with the chosen option's index, or null for Esc. Throws Cancelled on Ctrl+C. */
export async function pick(props: Omit<PickProps, "onDone">): Promise<number | null> {
  let choice: Answer<number> = null;
  const app = inkRender(<Pick {...props} onDone={(c) => (choice = c)} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  return answer(choice);
}

export interface PickManyProps {
  theme: Theme;
  title: string;
  body?: string[];
  options: (PickOption & { checked?: boolean })[];
  esc?: EscAction;
  onDone: (chosen: Answer<number[]>) => void;
}

/** The checklist component (exported for the tests; setup goes through `pickMany`). */
export function PickMany({ theme, title, body = [], options, esc, onDone }: PickManyProps) {
  const { columns, rows } = useWindowSize();
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState(() => options.map((o) => !!o.checked));
  const [done, finish] = useFinish(onDone);
  const refs = useRef({ cursor: 0, checked: options.map((o) => !!o.checked) });
  const move = (i: number) => setCursor((refs.current.cursor = i));
  const toggle = (i: number) => {
    refs.current.checked = refs.current.checked.map((c, j) => (j === i ? !c : c));
    setChecked(refs.current.checked);
  };
  const number = useNumbers(options.length);

  const onKey = useLateOscFilter((input, key) => {
    for (const [i, k] of menuKeys(input, key)) {
      const n = options.length;
      if (k.ctrl && i === "c") return finish(QUIT);
      if (k.escape) return finish(null);
      if (k.return) return finish(refs.current.checked.flatMap((c, j) => (c ? [j] : [])));
      if (k.upArrow) move((refs.current.cursor + n - 1) % n);
      else if (k.downArrow || k.tab) move((refs.current.cursor + 1) % n);
      else if (i === " ") toggle(refs.current.cursor);
      else {
        const d = number(i);
        if (!d) continue;
        // "1" then "0": row 10, and row 1 goes back to how it was.
        if (d.replaces) toggle(Number(String(d.n).slice(0, -1)) - 1);
        move(d.n - 1);
        toggle(d.n - 1);
      }
    }
  });
  useInput(onKey, { isActive: !done });

  const labelWidth = Math.max(...options.map((o) => o.label.length)) + 4;
  const fit = fitMenu({ columns, rows, title, body, items: options.map((o) => optionHeight(columns - 2, { ...o, label: `[x] ${o.label}` }, labelWidth, options.length)), cursor, footer: !done });
  return (
    <Frame columns={columns} rows={rows} compact={fit.compact}>
      <Title theme={theme} title={title} body={body} bodyRows={fit.bodyRows} compact={fit.compact} columns={columns} />
      <List options={options} labelWidth={labelWidth} theme={theme} window={fit.window} compact={fit.compact} row={(o, i) => ({ label: `${checked[i] ? "[x]" : "[ ]"} ${o.label}`, selected: !done && i === cursor })} />
      {done ? null : <Footer compact={fit.compact} extra={scrolled(fit.window, options.length)} text={`space or 1-${options.length} to check · enter to continue · ${escHint(esc)}`} />}
    </Frame>
  );
}

/** Shows a checklist; resolves with the checked options' indexes, or null for Esc. Throws Cancelled on Ctrl+C. */
export async function pickMany(props: Omit<PickManyProps, "onDone">): Promise<number[] | null> {
  let chosen: Answer<number[]> = null;
  const app = inkRender(<PickMany {...props} onDone={(c) => (chosen = c)} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  return answer(chosen);
}

interface TextProps {
  theme: Theme;
  title: string;
  body?: string[];
  /** Masked: shown as dots, whitespace dropped (keys). */
  secret?: boolean;
  /** Shown dimmed when empty; Enter on an empty field takes it. */
  placeholder?: string;
  /** Shown dimmed when empty, as information only: Enter on an empty field answers "". */
  hint?: string;
  /** Already typed (going back to this prompt). */
  initial?: string;
  esc?: EscAction;
  onDone: (value: Answer<string>) => void;
}

function TextInput({ theme, title, body = [], secret = false, placeholder, hint, initial = "", esc, onDone }: TextProps) {
  const { columns, rows } = useWindowSize();
  const [value, setValueState] = useState(initial);
  const [done, finish] = useFinish(onDone);
  const ref = useRef(initial);
  const setValue = (v: string) => setValueState((ref.current = v));
  const clean = (s: string) => (secret ? s.replace(/[\x00-\x1f\x7f\s]/g, "") : s.replace(/[\x00-\x1f\x7f]/g, ""));

  const onKey = useLateOscFilter((input, key) => {
    for (const [i, k] of textKeys(input, key)) {
      if (k.ctrl && i === "c") return finish(QUIT);
      if (k.escape) return finish(null);
      if (k.return) {
        const v = ref.current.trim() || (secret ? "" : (placeholder ?? ""));
        if (v || !secret) return finish(v);
        continue;
      }
      if (k.backspace || k.delete) setValue([...ref.current].slice(0, -1).join(""));
      else if (k.ctrl && i === "u") setValue("");
      else if (!k.ctrl && !k.meta) setValue(ref.current + clean(i));
    }
  });
  usePaste((text) => setValue(ref.current + clean(text)), { isActive: !done });
  useInput(onKey, { isActive: !done });

  const shown = secret ? "•".repeat(Math.min(value.length, 40)) : value;
  const fit = fitMenu({ columns, rows, title, body, items: [lineCount(`› ${shown}`, columns - 2)], cursor: 0, footer: !done });
  return (
    <Frame columns={columns} rows={rows} compact={fit.compact}>
      <Title theme={theme} title={title} body={body} dim bodyRows={fit.bodyRows} compact={fit.compact} columns={columns} />
      <Box marginTop={fit.compact ? 0 : 1} flexShrink={0}>
        <Text>
          <Text color={theme.accent}>{"› "}</Text>
          {value ? shown : <Text dimColor>{secret ? "paste it here" : (placeholder ?? hint ?? "")}</Text>}
        </Text>
      </Box>
      {done ? null : <Footer compact={fit.compact} text={`${secret ? "enter to save" : "enter to continue"} · ${escHint(esc)}`} />}
    </Frame>
  );
}

/** Asks for a line of text (`secret`: masked); Enter on an empty line takes the placeholder, if any. Null for Esc; throws Cancelled on Ctrl+C. */
export async function askText(props: Omit<TextProps, "onDone">): Promise<string | null> {
  let value: Answer<string> = null;
  const app = inkRender(<TextInput {...props} onDone={(v) => (value = v)} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  return answer(value);
}
