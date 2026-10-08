/**
 * Drives the real gluon in a pseudo-terminal and reads the screen through a headless xterm,
 * so scenarios see what a developer would see. Everything runs offline: the demo brain, fake
 * agents (see fixtures.ts) and a PATH that hides the real `claude` / `opencode`.
 */
import xterm from "@xterm/headless";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { tablesDir } from "../../src/cost/tables-store.ts";
import { trackModes, type ModeTracker, type ModesState } from "../../src/pty/modes.ts";
import type { Cell } from "../../src/pty/types.ts";
import { recordRow, type ScreenState } from "../fixtures/screens.ts";
import { RUN_ENV } from "../fixtures/run-sweep.ts";
import { SLOW } from "../fixtures/slow.ts";
import { seedTables } from "../fixtures/seed-tables.ts";
import { KEYS } from "./actions.ts";
import { fakeAgents, probes, WIN, type FakeAgent } from "./fixtures.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli.tsx");
/**
 * Bun's flags from the entry's shebang, so tests run gluon exactly as the installed command does.
 * Windows has no /dev/null for `--config` (EINVAL): there the package scripts' empty bunfig stands in.
 */
export const BUN_FLAGS = readFileSync(CLI, "utf8").split(/\r?\n/)[0]!.replace(/^#!.*?\bbun\s+/, "").split(/\s+/).filter(Boolean)
  .map((f) => (WIN && f === "--config=/dev/null" ? `--config=${join(ROOT, "scripts", "empty-bunfig.toml")}` : f));
/** How gluon is run: Bun on the source, or the compiled binary GLUON_TEST_BINARY names (`bun run test:dist`). */
export const GLUON = process.env.GLUON_TEST_BINARY ? [resolve(process.env.GLUON_TEST_BINARY)] : [process.execPath, ...BUN_FLAGS, CLI];

export { SLOW };

/**
 * The screen counts as drawn once no output has arrived for this long. A frame is one write but can
 * reach us in several reads (and ConPTY repaints in pieces); the spinner redraws every 80 ms, so this
 * stays under that.
 */
const QUIET_MS = Math.min(40 * SLOW, 70);
/** The longest a wait for a quiet screen takes (a spinner never goes quiet). */
const QUIET_MAX_MS = 600 * SLOW;
/** How long `press` / `type` wait for the app to answer a key (some keys draw nothing). */
const ANSWER_MS = 600 * SLOW;

/** The named keys (`KEYS` in `actions.ts`, the action vocabulary): `KEY.enter`, `KEY.esc`, … */
export { KEYS as KEY };

export interface AppOptions {
  cols?: number;
  rows?: number;
  cwd: string;
  /** gluon's arguments; `--demo` is added unless `real` is set. */
  args?: string[];
  env?: Record<string, string | undefined>;
  /** Which fake agents are on PATH. */
  agents?: FakeAgent[];
  /** How the "terminal" answers the background-colour query. */
  /** Late: answered after gluon stopped waiting (`splitMs`: its ESC first, the rest later; `light`: ST-terminated, as light terminals answer). */
  osc11?: "dark" | "light" | "none" | { delayMs: number; splitMs?: number; light?: boolean };
  /** Use the real brain (needs AWS / API credentials and costs money). */
  real?: boolean;
  /** Run without `--demo` but still offline (the sign-in flows, with the fake `claude`). */
  noDemo?: boolean;
  /** The "terminal" speaks the kitty keyboard protocol: answers Gluon's startup probe (`CSI ? u`, then DA1). */
  kitty?: boolean;
  /** Run this command in the pty instead of gluon (the perf suite's measurement floor: a fake agent's TUI with nothing in between). */
  argv?: string[];
}

/** What a Windows process needs from the environment to work at all (none on POSIX). */
export const SYSTEM_ENV: Record<string, string> = WIN ? Object.fromEntries(["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "SystemDrive", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))) : {};

/** The system's own directories for PATH: never the developer's, where a real agent lives. */
export const SYSTEM_PATH = WIN ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), process.env.SystemRoot ?? "C:\\Windows", ...gitDir()] : ["/usr/local/bin", "/usr/bin", "/bin"];

/** The directory of the git that runs the tests (Windows: git isn't in System32), so fixtures and tools find git and nothing else. */
function gitDir(): string[] {
  const git = Bun.which("git");
  return git ? [resolve(git, "..")] : [];
}

/** A home for gluon and the fakes: never the developer's (HOME, and on Windows USERPROFILE / APPDATA / LOCALAPPDATA). */
export const HOME = (() => {
  const home = mkdtempSync(join(tmpdir(), "gluon-home-"));
  for (const d of ["AppData/Roaming", "AppData/Local"]) mkdirSync(join(home, d), { recursive: true });
  return home;
})();

/** `env` for a test that acts while the demo intake agent works (`esc to interrupt`): its full pace, a second or so a turn. */
export const FULL_PACE = { GLUON_TEST_DEMO_PACE: undefined };

/** Environment shared by UI and CLI runs: nothing from the developer's shell leaks in. */
export function baseEnv(agents: FakeAgent[] = ["claude", "opencode"], extra: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {
    ...SYSTEM_ENV,
    // The run's marker (`test/preload.ts`): gluon and its agents carry it, so the run's end finds them wherever they are by then.
    ...(process.env[RUN_ENV] ? { [RUN_ENV]: process.env[RUN_ENV] } : {}),
    // Temp dirs gluon makes land in the run's own (test/preload.ts), removed at the end.
    ...(WIN ? {} : { TMPDIR: tmpdir() }),
    PATH: [fakeAgents(agents), ...SYSTEM_PATH].join(delimiter),
    HOME,
    USERPROFILE: HOME,
    APPDATA: join(HOME, "AppData", "Roaming"),
    LOCALAPPDATA: join(HOME, "AppData", "Local"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    GLUON_CONFIG: "/nonexistent/gluon.yaml",
    // Offline and free: API probes answered by a file, never the network.
    GLUON_TEST_PROBES: probes("default", {}),
    // The demo brain at a twentieth of its pace (its pauses only; `src/agent/clients.ts`): a walk to a
    // session is that much faster. A test that acts while it works passes `FULL_PACE`.
    GLUON_TEST_DEMO_PACE: "0.05",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  // Gluon ships no price tables: the app (source or compiled) reads the fixture ones from the local store of the state directory it runs with.
  // `GLUON_TEST_EMPTY_TABLES` (a test's own switch, never passed on): a first run, the store empty until the app's refresh fills it.
  const empty = env.GLUON_TEST_EMPTY_TABLES !== undefined;
  delete env.GLUON_TEST_EMPTY_TABLES;
  if (!empty) seedTables(tablesDir(env, process.platform, HOME));
  return env;
}

/** The developer's environment with the fakes on PATH, for QA runs on the real brain (never the regression suite). */
function realEnv(opts: AppOptions): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...baseEnv(opts.agents, opts.env) };
  delete env.GLUON_TEST_PROBES;
  // The developer's own home: the real brain's AWS profile lives there.
  for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

export class App {
  readonly term: xterm.Terminal;
  private proc: ReturnType<typeof Bun.spawn>;
  private raw = "";
  private decoder = new TextDecoder();
  private answered = false;
  private marked = 0;
  private pending = Promise.resolve();
  /** When the last output arrived (performance.now()). */
  private lastData = performance.now();
  private eof = Promise.withResolvers<void>();
  private osc = Promise.withResolvers<void>();
  /** Set once gluon has exited and its last output is on the screen: a wait for more is over. */
  private ended: { code: number } | null = null;
  private trigger: { text: string; keys: string; from: number; done: () => void } | null = null;
  /** The exit code, once the process has exited and its output has reached the screen. */
  readonly exited: Promise<number>;
  /** Where the fake agents append what they were given (`FAKE_ARGV_LOG`). */
  readonly argvLog: string;
  /** Where the fake agents' TUIs append every chunk they read (`FAKE_INPUT_LOG`). */
  readonly inputLogPath: string;
  private probed = false;
  private disposed = false;
  /** The modes the real terminal is in, as Gluon set them (`trackModes`, as a session's screen model does). */
  private tracker: ModeTracker;
  /** DECTCEM: xterm keeps it private. */
  private cursorHidden = false;

  constructor(private opts: AppOptions) {
    running.add(this);
    owner.getStore()?.add(this);
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 30;
    this.term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
    this.tracker = trackModes(this.term);
    const tcem = (on: boolean) => (params: (number | number[])[]) => {
      if (params.includes(25)) this.cursorHidden = !on;
      return false;
    };
    this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, tcem(true));
    this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, tcem(false));
    const osc = opts.osc11 ?? "dark";
    const args = opts.real || opts.noDemo ? (opts.args ?? []) : ["--demo", ...(opts.args ?? [])];
    const logs = mkdtempSync(join(tmpdir(), "gluon-argv-"));
    this.argvLog = join(logs, "argv.log");
    this.inputLogPath = join(logs, "input.log");
    const env = { FAKE_ARGV_LOG: this.argvLog, FAKE_INPUT_LOG: this.inputLogPath, ...opts.env };
    this.proc = Bun.spawn(opts.argv ?? [...GLUON, ...args], {
      cwd: opts.cwd,
      // The real brain needs the developer's AWS / API credentials from the environment.
      env: opts.real ? realEnv({ ...opts, env }) : baseEnv(opts.agents, env),
      terminal: {
        cols,
        rows,
        exit: () => this.eof.resolve(),
        data: (_t, data) => {
          if (this.disposed) return;
          this.lastData = performance.now();
          // One decoder for the stream: a character split across reads isn't garbled.
          const text = this.decoder.decode(data, { stream: true });
          this.raw += text;
          // The query can be split across reads: look for it in everything printed so far, and answer once.
          if (!this.answered && this.raw.includes("\x1b]11;?")) {
            this.answered = true;
            const dark = "\x1b]11;rgb:0c0c/0c0c/0c0c\x07";
            const light = "\x1b]11;rgb:ffff/ffff/ffff\x1b\\";
            if (osc === "dark") this.write(dark);
            else if (osc === "light") this.write(light);
            else if (typeof osc === "object") {
              const reply = osc.light ? light : dark;
              // `splitMs`: the ESC arrives alone, the rest that much later (some terminals split the reply).
              const last = (text: string) => {
                this.write(text);
                this.osc.resolve();
              };
              if (osc.splitMs === undefined) setTimeout(() => last(reply), osc.delayMs);
              else {
                setTimeout(() => this.write(reply.slice(0, 1)), osc.delayMs);
                setTimeout(() => last(reply.slice(1)), osc.delayMs + osc.splitMs);
              }
            }
            if (typeof osc !== "object") this.osc.resolve();
          }
          if (opts.kitty && !this.probed && this.raw.includes("\x1b[?u\x1b[c")) {
            this.probed = true;
            this.write("\x1b[?0u\x1b[?62;22c");
          }
          if (this.trigger && this.raw.slice(this.trigger.from).includes(this.trigger.text)) {
            const { keys, done } = this.trigger;
            this.trigger = null;
            this.write(keys);
            done();
          }
          this.pending = this.pending.then(() => new Promise<void>((r) => this.term.write(data, r)));
        },
      },
    });
    this.exited = this.proc.exited.then(async (code) => {
      await this.drain();
      this.ended = { code };
      return code;
    });
  }

  /**
   * After the process exited: waits for the rest of its output (the pty's end of file; Windows' ConPTY
   * sends none until it's closed, and closing it flushes what conhost still holds) and for the
   * screen to take it in, so `history()` / `screen()` read after `exitCode()` see everything.
   */
  private async drain() {
    if (WIN) {
      try {
        this.proc.terminal?.close();
      } catch {}
    }
    // Bounded well below exitCode()'s budget (2000 ms × SLOW): a pty that never reports its end
    // must not turn an exit into a null.
    await Promise.race([this.eof.promise, Bun.sleep(1000 * SLOW)]);
    await this.quiet();
  }

  /**
   * Waits until the background-colour reply (late with `osc11: { delayMs }`) is written whole and the app has drawn its answer.
   * Bounded by the reply's own schedule: where the query never reaches the terminal (Windows' ConPTY keeps it), there is no reply to wait for.
   */
  async oscReplied() {
    const osc = this.opts.osc11;
    const late = typeof osc === "object" ? osc.delayMs + (osc.splitMs ?? 0) : 0;
    await Promise.race([this.osc.promise, Bun.sleep(late + 2_000 * SLOW)]);
    await this.quiet();
  }

  /** gluon's process id. */
  get pid(): number {
    return this.proc.pid;
  }

  /** Sends gluon a signal (POSIX), as a `kill` from another terminal would. */
  signal(sig: NodeJS.Signals) {
    this.proc.kill(sig);
  }

  /** The terminal's local modes (termios `c_lflag`): whether it's in line mode (ICANON, ECHO). */
  get localFlags(): number {
    return this.proc.terminal!.localFlags;
  }

  /** Writes bytes as one read (like a paste without bracketing, or keys typed while busy). */
  write(s: string) {
    // Windows' ConPTY holds a lone ESC written as input, waiting for the rest of a sequence; Windows
    // Terminal sends the Esc key in win32-input-mode (which ConPTY asks for), so the harness does too.
    this.proc.terminal!.write(WIN && s === KEYS.esc ? "\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_" : s);
  }

  /**
   * Writes `keys` the moment output containing `text` arrives (from now on), before the screen is
   * even drawn: a key pressed as soon as something shows. Resolves once written.
   */
  writeWhen(text: string, keys: string, timeoutMs = 10_000): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      this.trigger = null;
      reject(new Error(`timed out waiting for output ${JSON.stringify(text)}; screen:\n${this.screen()}`));
    }, timeoutMs * SLOW);
    this.trigger = { text, keys, from: this.raw.length, done: () => (clearTimeout(timer), resolve()) };
    return promise;
  }

  /**
   * Presses keys one at a time: after each, waits for the app to answer it and the screen to be
   * drawn before the next. On a loaded machine a fixed pause isn't enough: the answer to one key
   * would pass for the answer to the next, and the screen would be read before the last one landed.
   */
  async press(...keys: string[]) {
    for (const k of keys) {
      const at = performance.now();
      this.write(k);
      await this.answer(at);
      await this.quiet();
    }
  }

  /** Types text one character at a time, as a person would: each once the last was answered. */
  async type(text: string) {
    for (const ch of text) {
      const at = performance.now();
      this.write(ch);
      await this.answer(at);
    }
    await this.quiet();
  }

  /**
   * Types `text` in one write, then waits for the app to answer and the screen to be drawn: the
   * walks' task lines, where a person's keystroke pace is no part of what is tested (`type()` costs
   * an app turn per character). The bytes stay in order, so a later key can't overtake them.
   */
  async enter(text: string) {
    const at = performance.now();
    this.write(text);
    await this.answer(at);
    await this.quiet();
  }

  async paste(text: string) {
    const at = performance.now();
    this.write(`\x1b[200~${text}\x1b[201~`);
    await this.answer(at);
    await this.settle(300);
  }

  /** Waits for output that came after `at`: the app's answer to input written then (bounded: some keys draw nothing). */
  private async answer(at: number) {
    const end = performance.now() + ANSWER_MS;
    while (this.lastData <= at && performance.now() < end) await Bun.sleep(5);
  }

  /** Lets output arrive and the screen catch up: waits `ms`, then until the screen is drawn. */
  async settle(ms = 150) {
    if (ms > 0) await Bun.sleep(ms);
    await this.quiet();
  }

  /**
   * Waits until no output has arrived for QUIET_MS (bounded by QUIET_MAX_MS) and the xterm has parsed
   * all of it, so a read never sees a half-drawn frame.
   */
  async quiet() {
    const end = performance.now() + QUIET_MAX_MS;
    for (;;) {
      await this.pending;
      const idle = performance.now() - this.lastData;
      if (idle >= QUIET_MS) {
        // A timer can fire before the event loop reads output that is already waiting: give it a turn.
        const last = this.lastData;
        await Bun.sleep(1);
        await this.pending;
        if (this.lastData === last) return;
      } else if (performance.now() >= end) return;
      else await Bun.sleep(Math.max(5, QUIET_MS - idle));
    }
  }

  /** The visible screen, one string per row, trailing blank rows dropped. */
  lines(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < this.term.rows; y++) out.push((buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "").trimEnd());
    while (out.length && !out.at(-1)!.trim()) out.pop();
    return out;
  }

  screen(): string {
    return this.lines().join("\n");
  }

  /**
   * What the fake agents were given (argv, tty, environment), every launch so far: the agent's own
   * printout of it may have scrolled out of Gluon's frame, which keeps no scrollback.
   */
  agentLog(): string {
    return existsSync(this.argvLog) ? readFileSync(this.argvLog, "utf8") : "";
  }

  /**
   * What each fake agent's TUI read from its terminal (`FAKE_INPUT_LOG`), in the order the agents
   * started: every chunk, byte for byte, joined. Exactly the bytes Gluon wrote into the agent.
   */
  inputLogs(): { pid: number; bytes: string }[] {
    if (!existsSync(this.inputLogPath)) return [];
    const agents = new Map<number, string>();
    const unescape = (s: string) => {
      const bytes: number[] = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "\\" && s[i + 1] === "\\") bytes.push(0x5c), i++;
        else if (s[i] === "\\" && s[i + 1] === "x") bytes.push(parseInt(s.slice(i + 2, i + 4), 16)), (i += 3);
        else bytes.push(s.charCodeAt(i));
      }
      return new TextDecoder().decode(new Uint8Array(bytes));
    };
    for (const line of readFileSync(this.inputLogPath, "utf8").split("\n")) {
      const at = line.indexOf(" ");
      const pid = Number(at < 0 ? line : line.slice(0, at));
      if (!line || !Number.isInteger(pid)) continue;
      agents.set(pid, (agents.get(pid) ?? "") + (at < 0 ? "" : unescape(line.slice(at + 1))));
    }
    return [...agents].map(([pid, bytes]) => ({ pid, bytes }));
  }

  /** Every byte the fake agents read (`inputLogs`), all agents' in the order they started. */
  inputLog(): string {
    return this.inputLogs().map((a) => a.bytes).join("");
  }

  /**
   * The modes the "real terminal" is in, as Gluon left them: mouse tracking and encoding, focus
   * reports, bracketed paste, the kitty flags in effect, … (`ModesState`), the alternate screen, the cursor shown.
   */
  modes(): ModesState & { altScreen: boolean; cursorVisible: boolean } {
    return { ...this.tracker.state(), altScreen: this.term.buffer.active.type === "alternate", cursorVisible: !this.cursorHidden };
  }

  /**
   * How many kitty keyboard entries are pushed on the active screen's stack, counted in everything
   * printed since the start: `CSI > f u` pushes, `CSI < n u` pops n (an empty stack stays empty);
   * kitty keeps one stack per screen (as `trackModes` does).
   */
  kittyDepth(): number {
    const depth = { normal: 0, alternate: 0 };
    let screen: keyof typeof depth = "normal";
    for (const m of this.raw.matchAll(/\x1b\[(?:\?(1049|1047|47)([hl])|([<>])(\d*)u)/g)) {
      if (m[1]) screen = m[2] === "h" ? "alternate" : "normal";
      else if (m[3] === ">") depth[screen]++;
      else depth[screen] = Math.max(0, depth[screen] - Math.max(1, Number(m[4] || 1)));
    }
    return depth[screen];
  }

  /** The cursor on the visible screen (0-based) and whether it is shown. */
  cursor(): { x: number; y: number; visible: boolean } {
    const buf = this.term.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY, visible: !this.cursorHidden };
  }

  /** The visible screen in the recorded screens' shape (`test/fixtures/screens.ts`): per row, its text and runs of styled cells. */
  cells(): ScreenState["rows"] {
    const buf = this.term.buffer.active;
    const rows: ScreenState["rows"] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      const cells: Cell[] = [];
      for (let x = 0; line && x < this.term.cols; x++) {
        const c = line.getCell(x);
        if (!c || c.getWidth() === 0) continue; // the right half of a wide character
        cells.push({ char: c.getChars() || " ", inverse: !!c.isInverse(), bold: !!c.isBold(), dim: !!c.isDim(), fg: c.isFgDefault() ? -1 : c.getFgColor(), bg: c.isBgDefault() ? -1 : c.getBgColor() });
      }
      rows.push(recordRow((line?.translateToString(true) ?? "").trimEnd(), cells));
    }
    return rows;
  }

  /**
   * Everything printed so far, scrollback included: the normal screen's, then (while Gluon is on
   * the alternate screen, which keeps no scrollback) what the alternate screen shows. `normal`: the
   * normal screen's only.
   */
  history({ normal = false }: { normal?: boolean } = {}): string {
    const read = (buf: xterm.IBuffer) => {
      const out: string[] = [];
      for (let y = 0; y < buf.length; y++) out.push((buf.getLine(y)?.translateToString(true) ?? "").trimEnd());
      return out.join("\n");
    };
    const b = this.term.buffer;
    return normal || b.active.type === "normal" ? read(b.normal) : `${read(b.normal)}\n${read(b.alternate)}`;
  }

  /** Waits until the screen matches; throws with the screen when it doesn't. */
  async waitFor(pattern: RegExp | string | ((screen: string) => boolean), timeoutMs = 10_000): Promise<void> {
    const ok =
      typeof pattern === "function"
        ? pattern
        : (s: string) => (typeof pattern === "string" ? s.includes(pattern) : pattern.test(s));
    const end = Date.now() + timeoutMs * SLOW;
    while (Date.now() < end) {
      // Read before the check: an exit seen here had its last output drawn, so a screen that still doesn't match never will.
      const ended = this.ended;
      await Bun.sleep(50);
      await this.pending;
      if (!ok(this.screen())) {
        if (ended) throw new Error(`gluon exited (code ${ended.code}) while waiting for ${pattern}; screen:\n${this.screen()}`);
        continue;
      }
      // Matched: let the frame (and anything printed right after) finish, then check it still holds.
      await this.quiet();
      if (ok(this.screen())) return;
    }
    throw new Error(`timed out waiting for ${pattern}; screen:\n${this.screen()}`);
  }

  /** Waits until the intake agent isn't working (no "esc to interrupt" line) for a moment. */
  async idle(timeoutMs = 10_000): Promise<void> {
    const working = (s: string) => /esc to interrupt/.test(s);
    await this.waitFor((s) => !working(s), timeoutMs);
    await this.settle(200);
    if (working(this.screen())) return this.idle(timeoutMs);
  }

  /** The background colour of a cell as #rrggbb, or null for the default. */
  bg(x: number, y: number): string | null {
    const cell = this.term.buffer.active.getLine(this.term.buffer.active.viewportY + y)?.getCell(x);
    if (!cell || cell.isBgDefault()) return null;
    return `#${cell.getBgColor().toString(16).padStart(6, "0")}`;
  }

  /** The foreground colour of a cell as #rrggbb, or null for the default (or a palette colour). */
  fg(x: number, y: number): string | null {
    const cell = this.term.buffer.active.getLine(this.term.buffer.active.viewportY + y)?.getCell(x);
    if (!cell || !cell.isFgRGB()) return null;
    return `#${cell.getFgColor().toString(16).padStart(6, "0")}`;
  }

  /** Row index of the first visible line matching. */
  row(pattern: RegExp | string): number {
    return this.lines().findIndex((l) => (typeof pattern === "string" ? l.includes(pattern) : pattern.test(l)));
  }

  /** Starts counting output (for full-screen clears). */
  mark() {
    this.marked = this.raw.length;
  }

  /** Output since `mark()`. */
  since(): string {
    return this.raw.slice(this.marked);
  }

  /** How often the screen / the scrollback was wiped since `mark()`. */
  clears() {
    const out = this.since();
    return { screen: out.split("\x1b[2J").length - 1, scrollback: out.split("\x1b[3J").length - 1 };
  }

  resize(cols: number, rows: number) {
    this.term.resize(cols, rows);
    this.proc.terminal!.resize(cols, rows);
  }

  /** The exit code, or null if still running after `ms`. */
  async exitCode(ms = WIN ? 10_000 : 2000): Promise<number | null> {
    return Promise.race([this.exited, Bun.sleep(ms >= 1000 ? ms * SLOW : ms).then(() => null)]);
  }

  kill() {
    try {
      this.proc.kill(9);
      this.proc.terminal?.close();
    } catch {}
  }

  /**
   * Ends the app for good: gluon and everything it started (the fake agents have sessions of their own, so
   * killing gluon alone leaves them), then the screen model's memory. Safe to call twice.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    running.delete(this);
    killTree(this.proc.pid);
    this.kill();
    try {
      this.term.dispose();
    } catch {}
    this.raw = "";
  }
}

/** The ids of every process below `pid` (from `ps`; on Windows from the process table, a second or so: `killTree` has taskkill). */
export function descendants(pid: number): number[] {
  try {
    const table = WIN
      ? Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"], { env: process.env, stdout: "pipe", stderr: "ignore" }).stdout.toString()
      : Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { env: process.env, stdout: "pipe", stderr: "ignore" }).stdout.toString();
    const kids = new Map<number, number[]>();
    for (const line of table.split("\n")) {
      const [c, p] = line.trim().split(/\s+/).map(Number);
      if (c && p !== undefined) kids.set(p, [...(kids.get(p) ?? []), c]);
    }
    const all: number[] = [];
    for (const todo = [pid]; todo.length; ) for (const k of kids.get(todo.pop()!) ?? []) (all.push(k), todo.push(k));
    return all;
  } catch {
    return [];
  }
}

/** SIGKILLs every descendant of `pid` (taskkill /T on Windows); the process itself is the caller's. */
function killTree(pid: number) {
  if (WIN) {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { env: process.env, stdout: "ignore", stderr: "ignore" });
    } catch {}
    return;
  }
  for (const k of descendants(pid)) {
    try {
      process.kill(k, "SIGKILL");
    } catch {}
  }
}

/** The apps the running test started (set by `scoped`). */
const owner = new AsyncLocalStorage<Set<Disposable>>();

/** What a test's scope ends with it: an `App`, or a process started by `spawnTracked`. */
interface Disposable {
  dispose(): void;
}
/** Whether the caller runs inside a `scoped` test body. */
export const inScope = () => owner.getStore() !== undefined;
/** Runs `fn` outside the running test's scope: the apps it starts outlive that test (a pool another test reads, `test/visual/`). */
export const unscoped = <T>(fn: () => T): T => owner.exit(fn);

/**
 * A test body that ends its apps (and their agents) when it ends, so a finished test's processes don't
 * pile up until the file's afterAll: `test/e2e/scoped-test.ts` wraps every `test` that reaches this harness
 * (installed by `test/preload.ts`). The apps of a test are the ones made inside it, `await`ed or not.
 */
export function scoped<A extends unknown[], R>(fn: (...a: A) => R | Promise<R>): (...a: A) => Promise<R> {
  const wrapped = async (...a: A) => {
    const mine = new Set<Disposable>();
    try {
      return await owner.run(mine, () => fn(...a));
    } finally {
      for (const app of mine) app.dispose();
    }
  };
  // Bun treats a test function that declares a parameter as taking a `done` callback: keep what it declared.
  Object.defineProperty(wrapped, "length", { value: fn.length });
  return wrapped;
}

/**
 * A no-pseudo-terminal scenario types a line for an agent that has the terminal itself. On macOS about half of those lines were lost
 * (issue #29: Bun's stdin reader outlives `pause()` and takes them). BUG-614 ends that reader (`inTerminal`), but without a Mac to
 * see it: until `BUG-614/QA-mac-01` in test/return.test.ts and these pass on macOS CI (`GLUON_QA_MAC_NOPTY=1` in the regression job's env
 * on a branch) they are skipped there.
 */
export const MAC_STEALS = process.platform === "darwin" && !process.env.GLUON_QA_MAC_NOPTY;

/** Gluon's home view is up: its composer's placeholder (or a draft) between its rules. */
export const HOME_VIEW = /› (describe (the|another) session|reply to the intake agent)/;

/**
 * Starts gluon (demo brain unless `real`) and waits for the home view: the header and the composer (and the first line, where it fits).
 * With arguments (`resume`, a task) the first line is no promise: the resumed sessions or the task's chat may be up before the first
 * frame is read, as they were on a CI runner (macOS), so it isn't waited for.
 */
export async function start(opts: AppOptions): Promise<App> {
  const app = new App(opts);
  await app.waitFor((s) => /Gluon v\d/.test(s) && HOME_VIEW.test(s) && ((opts.rows ?? 30) < 24 || !!opts.args?.length || /What are we building\?/.test(s)), 10_000);
  return app;
}

const running = new Set<Disposable>();

/** Ends every app still running (a safety net: `scoped` ends a test's apps with the test); call from afterAll. */
export function stopAll() {
  for (const app of [...running]) app.dispose();
  running.clear();
}

/**
 * A process a test started from the app (a raw `Bun.spawn` of gluon, without a terminal): it and everything below it end with the
 * test (`scoped`), or with the file (`stopAll`), however the test ended: a timeout kills a gluon alone, and its agent, reparented
 * to init, would outlive the run (BUG-573). Wrap every raw spawn of the app in it. Give it `baseEnv` (the run's marker, which
 * `test/preload.ts` sweeps for what a tracked tree misses: a gluon that exited before its agent).
 */
export function tracked<P extends { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: number | NodeJS.Signals): void }>(proc: P): P & { dispose(): void } {
  const handle = {
    dispose() {
      running.delete(handle);
      owner.getStore()?.delete(handle);
      // Below first: once gluon is gone its agent is no longer below it. (A process that has ended has nothing below it to find: no `ps` for it.)
      if (proc.exitCode === null && !proc.signalCode) killTree(proc.pid);
      try {
        proc.kill(9);
      } catch {}
    },
  };
  running.add(handle);
  owner.getStore()?.add(handle);
  return Object.assign(proc, { dispose: handle.dispose });
}

/** Runs gluon without a terminal (for CLI paths). */
export async function cli(args: string[], { cwd = ROOT, env = {}, agents, timeoutMs }: { cwd?: string; env?: Record<string, string | undefined>; agents?: FakeAgent[]; timeoutMs?: number } = {}) {
  const proc = tracked(Bun.spawn([...GLUON, ...args], { cwd, env: baseEnv(agents, env), stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
  // Not Bun's `timeout` (SIGTERM to gluon alone): the whole tree goes, the agent too.
  const timer = timeoutMs ? setTimeout(() => (killTree(proc.pid), proc.kill()), timeoutMs) : undefined;
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
    proc.dispose();
  }
}

/** The demo intake agent's question. */
export const QUESTION = "Should the fix include a regression test";

/** Walks the demo to its question. */
export async function toQuestion(app: App, task = "fix the add bug") {
  await app.enter(task);
  await app.press(KEYS.enter);
  // Wrapped on a narrow terminal: compare with the line breaks gone.
  await app.waitFor((s) => s.replace(/\s+/g, " ").includes(QUESTION), 20_000);
  await app.idle();
}

/** Walks the demo to its first proposal: the agent choice, with `keep talking` last. */
export async function toProposal(app: App, task?: string) {
  await toQuestion(app, task);
  await app.press("1", KEYS.enter);
  await app.waitFor("keep talking", 20_000);
  await app.idle();
}

/** Walks the demo to its proposal and starts the recommended agent (Enter): resolves once `ready` shows (the agent in Gluon's frame). */
export async function toLaunch(app: App, ready: string | RegExp = "type a line>", task?: string) {
  await toProposal(app, task);
  await app.press(KEYS.enter);
  await app.waitFor(ready, 20_000);
}
