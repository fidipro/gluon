import { Unicode11Addon } from "@xterm/addon-unicode11";
import xterm from "@xterm/headless";
import { type ModesState, trackModes } from "./modes.ts";
import type { Cell, Screen } from "./types.ts";

type XCell = NonNullable<ReturnType<NonNullable<ReturnType<xterm.Terminal["buffer"]["active"]["getLine"]>>["getCell"]>>;
type XLine = NonNullable<ReturnType<xterm.Terminal["buffer"]["active"]["getLine"]>>;

export type Rgb = readonly [number, number, number];

export interface ScreenOptions {
  /** Rows kept above the screen for scrolling back (`viewLine`, `cells`); default 0. */
  scrollback?: number;
  /**
   * The real terminal's colours (cached at startup): OSC 10 / 11 / 12 queries are answered from
   * them. A colour not given leaves its query unanswered.
   */
  colours?: { fg?: Rgb; bg?: Rgb; cursor?: Rgb };
  /** The real terminal speaks the kitty keyboard protocol: answer `CSI ? u` (else no answer). */
  kitty?: boolean;
}

export type ColourMode = "default" | "palette" | "rgb";

/** One cell with every attribute a painter needs; one per column (a wide character's right half has `width` 0). */
export interface PaintCell {
  char: string;
  width: number;
  fg: number;
  bg: number;
  fgMode: ColourMode;
  bgMode: ColourMode;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strike: boolean;
  overline: boolean;
  /** SGR parameters giving these attributes from a reset ("0;1;38;5;200"). */
  sgr: string;
}

/** The screen model with what Gluon's compositor needs on top of the readers' `Screen`. */
export interface TermScreen extends Screen {
  /** Row `y` of the view scrolled back `scrollOffset` rows (0 = the live screen, as `line`). */
  viewLine(y: number, scrollOffset?: number): { text: string; cells: Cell[]; wrapped?: boolean };
  /** Every column of row `y` of the view scrolled back `scrollOffset` rows; [] outside the screen. */
  cells(y: number, scrollOffset?: number): PaintCell[];
  /** Rows above the live screen that can be scrolled back to (0 on the alternate screen). */
  scrollbackLength(): number;
  /** DECTCEM. */
  cursorVisible(): boolean;
  altScreen(): boolean;
  title(): string;
  modes(): ModesState;
  /**
   * The terminal's replies to the agent's queries (DA1, CPR, DECRQM from xterm; OSC 10/11/12 and
   * kitty's `CSI ? u` from `ScreenOptions`), in the order the queries came: write each into the agent.
   */
  onReply(cb: (data: string) => void): () => void;
  /** After output was parsed (the screen may have changed). */
  onChange(cb: () => void): () => void;
  onBell(cb: () => void): () => void;
  onTitle(cb: (title: string) => void): () => void;
}

/**
 * The agent's screen model: a headless xterm fed with the agent's output, Unicode 11 widths (emoji,
 * CJK as real terminals draw them). Keeps the screen (and `scrollback` rows) in memory only; never
 * logs or writes it.
 */
export function createScreen(cols: number, rows: number, opts: ScreenOptions = {}): TermScreen {
  const term = new xterm.Terminal({ cols, rows, scrollback: Math.max(0, opts.scrollback ?? 0), allowProposedApi: true });
  // Typed against @xterm/xterm, which headless's Terminal matches at run time.
  term.loadAddon(new Unicode11Addon() as unknown as Parameters<xterm.Terminal["loadAddon"]>[0]);
  term.unicode.activeVersion = "11";
  const tracker = trackModes(term);

  // One queue for every reply, fed synchronously while the parser walks the input: xterm's own
  // (onData) and ours come out in the order of the queries.
  const replies = new Set<(d: string) => void>();
  const reply = (d: string) => replies.forEach((cb) => cb(d));
  term.onData(reply);
  const hex4 = (v: number) => (Math.round(Math.min(255, Math.max(0, v))) * 257).toString(16).padStart(4, "0");
  const colours = [opts.colours?.fg, opts.colours?.bg, opts.colours?.cursor];
  for (const ident of [10, 11, 12])
    term.parser.registerOscHandler(ident, (data) => {
      // `OSC 10 ; ? ; ?` asks for 10 and 11: each part is the next colour.
      const parts = data.split(";");
      if (!parts.includes("?")) return false; // setting a colour: xterm's business
      parts.forEach((p, i) => {
        const c = colours[ident - 10 + i];
        if (p === "?" && c) reply(`\x1b]${ident + i};rgb:${hex4(c[0])}/${hex4(c[1])}/${hex4(c[2])}\x1b\\`);
      });
      return true;
    });
  term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
    if (opts.kitty) reply(`\x1b[?${tracker.state().kittyFlags}u`);
    return true;
  });

  // DECTCEM isn't in `term.modes`: watch `CSI ? 25 h/l` (returning false lets xterm handle it too).
  let cursorHidden = false;
  const tcem = (on: boolean) => (params: (number | number[])[]) => {
    if (params.includes(25)) cursorHidden = !on;
    return false;
  };
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, tcem(true));
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, tcem(false));
  term.parser.registerEscHandler({ final: "c" }, () => {
    cursorHidden = false;
    return false;
  });
  let title = "";
  term.onTitleChange((t) => (title = t));

  const buf = () => term.buffer.active;
  const view = (y: number, off = 0): XLine | undefined => {
    if (y < 0 || y >= term.rows) return undefined;
    const b = buf();
    return b.getLine(b.baseY + y - Math.min(Math.max(0, off), b.baseY));
  };
  const listen = <T>(ev: (cb: (v: T) => void) => { dispose(): void }) => (cb: (v: T) => void) => {
    const d = ev(cb);
    return () => d.dispose();
  };

  const viewLine = (y: number, off = 0) => {
    const l = view(y, off);
    if (!l) return { text: "", cells: [] };
    const cells: Cell[] = [];
    for (let x = 0; x < term.cols; x++) {
      const c = l.getCell(x);
      if (!c || c.getWidth() === 0) continue; // right half of a wide character
      cells.push({
        char: c.getChars() || " ",
        inverse: !!c.isInverse(),
        bold: !!c.isBold(),
        dim: !!c.isDim(),
        fg: c.isFgDefault() ? -1 : c.getFgColor(),
        bg: c.isBgDefault() ? -1 : c.getBgColor(),
      });
    }
    return { text: l.translateToString(true).trimEnd(), cells, wrapped: l.isWrapped };
  };

  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (data) => new Promise<void>((resolve) => term.write(data, resolve)),
    resize: (c, r) => term.resize(Math.max(1, c), Math.max(1, r)),
    cursor: () => ({ x: Math.min(buf().cursorX, term.cols - 1), y: buf().cursorY }),
    line: (y) => viewLine(y, 0),
    viewLine,
    cells(y, off = 0) {
      const l = view(y, off);
      if (!l) return [];
      const out: PaintCell[] = [];
      const reuse = term.buffer.active.getNullCell();
      for (let x = 0; x < term.cols; x++) {
        const c = l.getCell(x, reuse);
        out.push(c ? paintCell(c) : BLANK);
      }
      return out;
    },
    scrollbackLength: () => buf().baseY,
    cursorVisible: () => !cursorHidden,
    altScreen: () => buf().type === "alternate",
    title: () => title,
    modes: () => tracker.state(),
    onReply(cb) {
      replies.add(cb);
      return () => replies.delete(cb);
    },
    onChange: listen<void>((cb) => term.onWriteParsed(cb)),
    onBell: listen<void>((cb) => term.onBell(cb)),
    onTitle: listen<string>((cb) => term.onTitleChange(cb)),
    serialize() {
      // Default attributes, no insert mode, clear, then every row from its first column.
      let out = "\x1b[0m\x1b[4l\x1b[H\x1b[2J";
      let sgr = "0";
      for (let y = 0; y < term.rows; y++) {
        const l = view(y);
        if (!l) continue;
        // Trailing blank cells with default attributes are already what 2J left.
        let end = term.cols;
        while (end > 0) {
          const c = l.getCell(end - 1);
          if (!c || ((c.getChars() === "" || c.getChars() === " ") && c.isAttributeDefault())) end--;
          else break;
        }
        if (end === 0) continue;
        out += `\x1b[${y + 1};1H`;
        for (let x = 0; x < end; x++) {
          const c = l.getCell(x);
          if (!c || c.getWidth() === 0) continue;
          const s = sgrOf(c);
          if (s !== sgr) {
            out += `\x1b[${s}m`;
            sgr = s;
          }
          out += c.getChars() || " ";
        }
      }
      out += "\x1b[0m";
      if (term.modes.insertMode) out += "\x1b[4h";
      const { x, y } = { x: Math.min(buf().cursorX, term.cols - 1), y: buf().cursorY };
      out += `\x1b[${y + 1};${x + 1}H`;
      out += cursorHidden ? "\x1b[?25l" : "\x1b[?25h";
      return out;
    },
    dispose() {
      replies.clear();
      tracker.dispose();
      term.dispose();
    },
  };
}

const BLANK: PaintCell = Object.freeze({
  char: " ",
  width: 1,
  fg: -1,
  bg: -1,
  fgMode: "default",
  bgMode: "default",
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  blink: false,
  inverse: false,
  invisible: false,
  strike: false,
  overline: false,
  sgr: "0",
}) as PaintCell;

const mode = (palette: boolean, rgb: boolean): ColourMode => (rgb ? "rgb" : palette ? "palette" : "default");

function paintCell(c: XCell): PaintCell {
  const fgMode = mode(c.isFgPalette(), c.isFgRGB());
  const bgMode = mode(c.isBgPalette(), c.isBgRGB());
  return {
    char: c.getChars(),
    width: c.getWidth(),
    fg: fgMode === "default" ? -1 : c.getFgColor(),
    bg: bgMode === "default" ? -1 : c.getBgColor(),
    fgMode,
    bgMode,
    bold: !!c.isBold(),
    dim: !!c.isDim(),
    italic: !!c.isItalic(),
    underline: !!c.isUnderline(),
    blink: !!c.isBlink(),
    inverse: !!c.isInverse(),
    invisible: !!c.isInvisible(),
    strike: !!c.isStrikethrough(),
    overline: !!c.isOverline(),
    sgr: sgrOf(c),
  };
}

/** The SGR parameters that give a cell's attributes, starting from a reset. */
function sgrOf(c: XCell): string {
  const p = ["0"];
  if (c.isBold()) p.push("1");
  if (c.isDim()) p.push("2");
  if (c.isItalic()) p.push("3");
  if (c.isUnderline()) p.push("4");
  if (c.isBlink()) p.push("5");
  if (c.isInverse()) p.push("7");
  if (c.isInvisible()) p.push("8");
  if (c.isStrikethrough()) p.push("9");
  if (c.isOverline()) p.push("53");
  p.push(...colour(c.isFgPalette(), c.isFgRGB(), c.getFgColor(), 30));
  p.push(...colour(c.isBgPalette(), c.isBgRGB(), c.getBgColor(), 40));
  return p.join(";");
}

function colour(palette: boolean, rgb: boolean, n: number, base: 30 | 40): string[] {
  if (rgb) return [`${base + 8};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`];
  if (!palette) return [];
  if (n < 8) return [`${base + n}`];
  if (n < 16) return [`${base + 60 + n - 8}`];
  return [`${base + 8};5;${n}`];
}
