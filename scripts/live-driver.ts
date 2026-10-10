/**
 * How the live checks touch Gluon: a `Driver` sends what a terminal would send (actions.ts `bytesOf`,
 * so key names are actions.ts `KEYS`) and reads the screen back.
 *
 * - `TmuxDriver`: Gluon in a private tmux server (`tmux -L gluonlive -f /dev/null`, `window-size
 *   manual`), started from an allowlisted environment (`scrubEnv`): a tmux server copies the
 *   environment of the client that starts it, and the runner's own environment holds the Claude
 *   plan's token. After start, `show-environment` is checked for anything token-like
 *   (`assertCleanTmuxEnv`). Watch it read-only with `tmux -L gluonlive attach -r`.
 * - `FakeDriver`: an in-memory screen for tests; records the actions.
 * - `GuardedDriver`: the `real` mode's safety net around a driver: a hard cap on prompts sent to
 *   agents, and an abort the moment a sign-in / login / API-key screen shows.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { bytesOf, KEYS, mouseReports, type Action, type KeyName, type MouseButton, type MouseOp } from "../test/e2e/actions.ts";
import { fakeScript, repo, type FakeAgent } from "../test/e2e/fixtures.ts";
import { parseDocument } from "yaml";
import { configPath } from "../src/config.ts";

export const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src/cli.tsx");
/** Bun's flags from gluon's shebang: Gluon runs exactly as the installed command does. */
const BUN_FLAGS = readFileSync(CLI, "utf8").split(/\r?\n/)[0]!.replace(/^#!.*?\bbun\s+/, "").split(/\s+/).filter(Boolean);
/** The system's own directories: never the developer's, where a real agent lives. */
const SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];
/** Every harness binary name; `real` mode links only `REAL_AGENTS`. */
const AGENT_NAMES = ["claude", "codex", "opencode", "agy", "grok"];
export const REAL_AGENTS = ["claude", "codex", "opencode"] as const;
/** The fakes put on PATH in `fakes` mode: all five. */
export const ALL_FAKES: FakeAgent[] = ["claude", "codex", "opencode", "agy", "grok"];
/** `handoff.on_clear: ask` (gluon-kit's ASK_YAML): a typed /clear asks before ending the session. */
export const DEFAULT_YAML = "handoff:\n  on_clear: ask\n";
/** `real`: the same, with Claude Code and Codex on the user's own plans (their logins). */
export const REAL_YAML = `${DEFAULT_YAML}connections: { claude-code: { auth: subscription }, codex: { auth: subscription } }\n`;

export type Mode = "fakes" | "real";

/** `handoff.key`'s values (config.ts allows these four) as actions.ts key names. */
export const HOME_KEYS: Record<string, KeyName> = { "ctrl+\\": "ctrlBackslash", "ctrl+]": "ctrlBracket", "ctrl+^": "ctrlCaret", "ctrl+_": "ctrlUnderscore" };
const DEFAULT_HOME_KEY = "ctrl+\\";

/** What a run needs to know of a Gluon config: the home key, and OpenCode's providers (for the spend bucket). */
export interface ConfigFacts {
  /** `handoff.key`: Gluon's frame goes home on it, whatever the agent (an agent's own `key` there doesn't count). */
  homeKey: KeyName;
  /** As the config writes it (`ctrl+]`), as Gluon's bar shows it. */
  homeKeyLabel: string;
  /** `connections.opencode.providers` (empty: not connected). */
  opencodeProviders: string[];
}

/** Reads a config's home key and OpenCode's providers (a small YAML read: the repo's loader reads only GLUON_CONFIG and may rewrite the file). */
export function configFacts(yaml: string): ConfigFacts {
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw new Error(`the Gluon config is not valid YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  const js = (doc.toJS() ?? {}) as { handoff?: { key?: unknown }; connections?: { opencode?: { providers?: unknown } } };
  const label = js.handoff?.key == null ? DEFAULT_HOME_KEY : String(js.handoff.key);
  const homeKey = HOME_KEYS[label];
  if (!homeKey) throw new Error(`handoff.key is ${JSON.stringify(label)}: not one of ${Object.keys(HOME_KEYS).join(", ")}`);
  const providers = js.connections?.opencode?.providers;
  return { homeKey, homeKeyLabel: label, opencodeProviders: Array.isArray(providers) ? providers.map(String) : [] };
}

/**
 * The config with `handoff.on_clear` / `on_compact` (and any agent's override) set to `ask` where
 * they say otherwise, so a typed /clear and a compaction ask first; everything else (comments
 * too) kept. Unchanged text when nothing needed it.
 */
export function askingHandoff(yaml: string): string {
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw new Error(`the Gluon config is not valid YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  let changed = false;
  const fix = (path: (string | number)[]) => {
    for (const k of ["on_clear", "on_compact"]) {
      const v = doc.getIn([...path, k]);
      if (v != null && v !== "ask") {
        doc.setIn([...path, k], "ask");
        changed = true;
      }
    }
  };
  fix(["handoff"]);
  const agents = (doc.toJS() as { handoff?: { agents?: Record<string, unknown> } } | null)?.handoff?.agents ?? {};
  for (const a of Object.keys(agents)) if (agents[a] && typeof agents[a] === "object") fix(["handoff", "agents", a]);
  return changed ? doc.toString() : yaml;
}

/** What the screen shows: rows as text, the cursor (0-based), the size. */
export interface Screen {
  lines: string[];
  /** The rows numbered (1-based), a column ruler on top, the cursor and size in a header: what the model reads. */
  text: string;
  cursor: { x: number; y: number; visible: boolean };
  cols: number;
  rows: number;
  /** Gluon's process ended (the pane is kept, so its last screen still shows). */
  exited?: boolean;
}

export interface Driver {
  keys(names: KeyName[]): Promise<void>;
  type(text: string): Promise<void>;
  paste(text: string): Promise<void>;
  /** A mouse action at a 1-based cell (`to`: a drag's end). */
  mouse(op: MouseOp, button: MouseButton, col: number, row: number, to?: { col: number; row: number }): Promise<void>;
  wheel(dir: "up" | "down", col: number, row: number): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  screen(): Promise<Screen>;
  /** Writes a PNG of the screen to `path`; resolves with its path, or "" when no renderer is available (`note` says why). */
  screenshot(path: string): Promise<string>;
  /** Waits `ms`, or until the screen matches; resolves whether it matched (a plain wait: true). */
  wait(what: number | RegExp, timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
  /** Why the last screenshot has no PNG. */
  note?: string;
}

// ——— the screen as the model reads it ———

/** A column ruler: a dot per cell, `+` every 5, the tens digit every 10. */
const ruler = (cols: number) => Array.from({ length: cols }, (_, i) => ((i + 1) % 10 === 0 ? String(((i + 1) / 10) % 10) : (i + 1) % 5 === 0 ? "+" : ".")).join("");

/** The screen as text: a header (size, cursor 1-based), a ruler, each row numbered 1-based after a `|`. */
export function formatScreen(lines: string[], cursor: Screen["cursor"], cols: number, rows: number, exited = false): string {
  const w = String(rows).length;
  const head = `screen ${cols}×${rows} · cursor at col ${cursor.x + 1}, row ${cursor.y + 1} (${cursor.visible ? "shown" : "hidden"})${exited ? " · GLUON HAS EXITED" : ""}`;
  return [head, `${" ".repeat(w)}|${ruler(cols)}`, ...Array.from({ length: rows }, (_, y) => `${String(y + 1).padStart(w)}|${lines[y] ?? ""}`)].join("\n");
}

// ——— environments ———

/** Variables a Gluon server may get: nothing else of the runner's environment reaches tmux. */
const ALLOWED = new Set(["PATH", "HOME", "TERM", "COLORTERM", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "SHELL", "GLUON_CONFIG", "GLUON_TEST_PROBES", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "CODEX_HOME"]);
/** Never in a Gluon server's environment, whatever the allowlist says: the plan's token, keys, endpoints. */
export const FORBIDDEN = /OAUTH|ANTHROPIC|TOKEN|API_KEY|SECRET|PASSWORD|BASE_URL|AWS_|BEDROCK/i;

/** The allowlisted part of `env` (`ALLOWED` and `FAKE_*`), with anything `FORBIDDEN` dropped. */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (ALLOWED.has(k) || k.startsWith("FAKE_")) && !FORBIDDEN.test(k)) out[k] = v;
  return out;
}

/** A program's absolute path on `path` (a PATH value), or null. Research code: never in src/ (`binPath` there). */
export function onPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/** How Gluon starts in tmux: recorded in the run directory, so a finding can be replayed (a run record). */
export interface Launch {
  mode: Mode;
  cols: number;
  rows: number;
  cwd: string;
  argv: string[];
  /** The whole environment Gluon gets (allowlisted). */
  env: Record<string, string>;
  /** Gluon's config file's content (a user config's stays in memory: `launchRecord` drops it). */
  yaml: string;
  /** `fakes`: the fake agents on PATH. */
  fakes: FakeAgent[];
  /** `fakes`: those drawing on the alternate screen. */
  alt: FakeAgent[];
  /** `real`: the agents linked on PATH. */
  agents: string[];
  /** Temp directories to remove at the end. */
  scratch: string[];
  /** The key that goes home from a session, per the config (`handoff.key`): in `real` mode the user's own. */
  homeKey: KeyName;
  homeKeyLabel: string;
  /** `real`: Gluon runs on a private copy of the user's own Gluon config (and its `.env`), not `REAL_YAML`. */
  userConfig: boolean;
}

export interface LaunchOptions {
  cols?: number;
  rows?: number;
  yaml?: string;
  /** Where the fakes' argv and input logs go (`FAKE_ARGV_LOG`, `FAKE_INPUT_LOG`). */
  logDir?: string;
  /** Extra environment for Gluon (allowlisted like the rest). */
  env?: Record<string, string>;
  /** `fakes`: these fakes draw on the alternate screen (`FAKE_ALT=1` in their script alone). */
  alt?: FakeAgent[];
  /**
   * `real`: the user's own Gluon config to run on, copied (with the `.env` next to it) into the
   * launch's private scratch dir. Default: `configPath(from)` when that file exists and no `yaml`
   * was given; `false`: `yaml` (default `REAL_YAML`).
   */
  userConfig?: string | false;
}

/** The fake's `!event` hook (gluon-kit's EVENT_HOOK): writes an event as a harness's hook does. */
export const EVENT_HOOK = `"${process.execPath}" --no-env-file "${join(ROOT, "test/fixtures/write-event.ts")}"`;

/** The fixed part of a fakes launch's environment: what a replay needs to start the same Gluon (no paths of this run). */
export const FAKE_ENV = { FAKE_TUI: "1", FAKE_EXIT: "0" } as const;

/**
 * `fakes`: Gluon on the demo brain with the five fake TUI agents (`fakeScript`) first on PATH, then
 * only the system's directories; a scratch HOME, config and probes file. Refuses when a real agent
 * would be found on that PATH.
 */
/**
 * Writes the five fakes into `bin` (`alt`: those that draw on the alternate screen) and returns the
 * PATH they go first on, then only the system's directories. Refuses when a real agent is on it.
 */
export function fakeBin(bin: string, alt: FakeAgent[] = []): string {
  mkdirSync(bin, { recursive: true });
  for (const a of ALL_FAKES) {
    const script = fakeScript(a);
    writeFileSync(join(bin, a), alt.includes(a) ? script.replace("\n", "\nexport FAKE_ALT=1\n") : script);
    chmodSync(join(bin, a), 0o755);
  }
  for (const dir of SYSTEM_PATH) for (const a of AGENT_NAMES) if (existsSync(join(dir, a))) throw new Error(`a real ${a} is in ${dir}: fakes mode would not be offline`);
  return [bin, ...SYSTEM_PATH].join(delimiter);
}

export function fakesLaunch({ cols = 100, rows = 30, yaml = DEFAULT_YAML, logDir, env = {}, alt = [] }: LaunchOptions = {}): Launch {
  const scratch = mkdtempSync(join(tmpdir(), "gluonlive-"));
  const home = join(scratch, "home");
  mkdirSync(home);
  const PATH = fakeBin(join(scratch, "bin"), alt);
  writeFileSync(join(scratch, "config.yaml"), yaml);
  writeFileSync(join(scratch, "probes.json"), "{}");
  const logs = logDir ?? scratch;
  mkdirSync(logs, { recursive: true });
  const full = scrubEnv({
    PATH,
    HOME: home,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    TMPDIR: scratch,
    GLUON_CONFIG: join(scratch, "config.yaml"),
    // Offline and free: API probes answered by a file, never the network.
    GLUON_TEST_PROBES: join(scratch, "probes.json"),
    ...FAKE_ENV,
    FAKE_EVENT_HOOK: EVENT_HOOK,
    FAKE_ARGV_LOG: join(logs, "fake-argv.log"),
    FAKE_INPUT_LOG: join(logs, "fake-input.log"),
    ...env,
  });
  const facts = configFacts(yaml);
  return { mode: "fakes", cols, rows, cwd: repo.tiny(), argv: [process.execPath, ...BUN_FLAGS, CLI, "--demo"], env: full, yaml, fakes: [...ALL_FAKES], alt: [...alt], agents: [], scratch: [scratch], homeKey: facts.homeKey, homeKeyLabel: facts.homeKeyLabel, userConfig: false };
}

/**
 * `real` (for the paid real pass): the demo brain, the user's own home (their logins), and a PATH
 * of a scratch directory with links to ONLY `claude`, `codex` and `opencode` (from the runner's
 * PATH), bun (and node, which an npm-installed agent's script runs on), then the system's
 * directories. Refuses when agy or grok would be found on it. API probes are answered by an empty
 * file (never the network).
 *
 * The config: by default a private copy of the user's own Gluon config (`configPath(from)`), and
 * the `.env` next to it when there is one: Gluon's own files only, never another tool's. The
 * scratch dir is 0700, the copies 0600; the copy's `handoff.on_clear` / `on_compact` are made
 * `ask`. The scratch dir (copies included) goes when the driver closes (`TmuxDriver`), or with
 * `dropLaunch`. Without a user config (none, or `userConfig: false`): `yaml`, default `REAL_YAML`.
 */
export function realLaunch({ cols = 100, rows = 30, yaml, env = {}, userConfig }: LaunchOptions = {}, from: Record<string, string | undefined> = process.env): Launch {
  const fromHome = from.HOME ?? homedir();
  const defaultConfig = configPath(from, process.platform, fromHome);
  const user = userConfig === false ? null : (userConfig ?? (yaml === undefined && existsSync(defaultConfig) ? defaultConfig : null));
  if (user && !existsSync(user)) throw new Error(`no Gluon config at ${user}`);
  // Read (and checked) before anything is made: a bad config leaves nothing behind.
  const text = user ? askingHandoff(readFileSync(user, "utf8")) : (yaml ?? REAL_YAML);
  const facts = configFacts(text);
  const scratch = mkdtempSync(join(tmpdir(), "gluonlive-real-"));
  try {
    chmodSync(scratch, 0o700);
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const linked: string[] = [];
    let needsNode = false;
    for (const a of REAL_AGENTS) {
      const p = onPath(a, from.PATH);
      if (!p) continue;
      const target = realpathSync(p);
      symlinkSync(target, join(bin, a));
      linked.push(a);
      try {
        if (/^#!.*\bnode\b/.test(readFileSync(target, "utf8").slice(0, 200))) needsNode = true;
      } catch {}
    }
    symlinkSync(process.execPath, join(bin, "bun"));
    const node = needsNode ? onPath("node", from.PATH) : null;
    if (node) symlinkSync(realpathSync(node), join(bin, "node"));
    const PATH = [bin, ...SYSTEM_PATH].join(delimiter);
    for (const dir of PATH.split(delimiter)) for (const a of ["agy", "grok"]) if (existsSync(join(dir, a))) throw new Error(`${a} is in ${dir}: real mode never offers agy or grok`);
    const config = join(scratch, "config.yaml");
    writeFileSync(config, text, { mode: 0o600 });
    chmodSync(config, 0o600);
    if (user) {
      // Gluon keeps its keys in the .env next to its config (secrets.ts): the copy goes next to
      // the copied config. Never printed or logged.
      const dotenv = join(dirname(user), ".env");
      if (existsSync(dotenv)) {
        writeFileSync(join(scratch, ".env"), readFileSync(dotenv), { mode: 0o600 });
        chmodSync(join(scratch, ".env"), 0o600);
      }
    }
    writeFileSync(join(scratch, "probes.json"), "{}");
    const full = scrubEnv({
      ...Object.fromEntries(["USER", "LOGNAME", "SHELL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "CODEX_HOME"].map((k) => [k, from[k]])),
      PATH,
      HOME: fromHome,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "C.UTF-8",
      GLUON_CONFIG: config,
      GLUON_TEST_PROBES: join(scratch, "probes.json"),
      ...env,
    });
    return { mode: "real", cols, rows, cwd: repo.tiny(), argv: [process.execPath, ...BUN_FLAGS, CLI, "--demo"], env: full, yaml: text, fakes: [], alt: [], agents: linked, scratch: [scratch], homeKey: facts.homeKey, homeKeyLabel: facts.homeKeyLabel, userConfig: !!user };
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    throw e;
  }
}

/** Removes a launch's scratch dirs (its config copy too): for a launch whose driver never started. */
export function dropLaunch(l: Launch): void {
  for (const d of l.scratch) rmSync(d, { recursive: true, force: true });
}

/** What a run directory keeps of a launch: no temp paths that die with the run, nothing secret. */
export interface LaunchRecord {
  mode: Mode;
  cols: number;
  rows: number;
  /** The config's content; empty when it was the user's own (`userConfig`): never recorded. */
  yaml: string;
  /** Gluon ran on a copy of the user's own config: all a record says of it. */
  userConfig: boolean;
  fakes: FakeAgent[];
  alt: FakeAgent[];
  agents: string[];
  /** The fakes' switches (`FAKE_TUI`, `FAKE_EXIT`, …): the environment a replay adds. */
  env: Record<string, string>;
}

export function launchRecord(l: Launch): LaunchRecord {
  return { mode: l.mode, cols: l.cols, rows: l.rows, yaml: l.userConfig ? "" : l.yaml, userConfig: l.userConfig, fakes: l.fakes, alt: l.alt, agents: l.agents, env: Object.fromEntries(Object.entries(l.env).filter(([k]) => k.startsWith("FAKE_") && !/_LOG$/.test(k) && k !== "FAKE_EVENT_HOOK" && k !== "FAKE_SESSIONS")) };
}

// ——— screenshots ———

/** The `git` common dir's parent: the main checkout, when this is a worktree (where qa/ lives). */
function mainCheckout(): string | null {
  const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { PATH: SYSTEM_PATH.join(delimiter) } });
  return r.exitCode === 0 ? dirname(r.stdout.toString().trim()) : null;
}

/**
 * The command that turns an ANSI capture into a PNG: test/visual/render.py (`--ansi <file> <cols>
 * <out>`), else the QA round's shot.py (`--file <file> <cols> <out>`); null (and why) without one.
 */
export function renderer(): { argv: (ansi: string, cols: number, out: string) => string[] } | { why: string } {
  const python = onPath("python3");
  if (!python) return { why: "python3 is not on PATH" };
  const render = join(ROOT, "test/visual/render.py");
  if (existsSync(render)) return { argv: (a, c, o) => [python, render, "--ansi", a, String(c), o] };
  const shots = [ROOT, mainCheckout()].filter((d): d is string => !!d).map((d) => join(d, "qa/gluon-followups-live/scripts/shot.py"));
  const shot = shots.find((p) => existsSync(p));
  if (shot) return { argv: (a, c, o) => [python, shot, "--file", a, String(c), o] };
  return { why: "no renderer: neither test/visual/render.py nor qa/gluon-followups-live/scripts/shot.py exists" };
}

/** Renders an ANSI capture to `out`; the PNG's path, or "" and why not. */
export function renderPng(ansi: string, cols: number, out: string): { png: string; note?: string } {
  const r = renderer();
  if ("why" in r) return { png: "", note: r.why };
  // The user's HOME: PIL may be in their site-packages. Nothing else of the runner's environment.
  const p = Bun.spawnSync(r.argv(ansi, cols, out), { stdout: "pipe", stderr: "pipe", env: { PATH: SYSTEM_PATH.join(delimiter), HOME: process.env.HOME ?? homedir(), LANG: "C.UTF-8" } });
  if (p.exitCode !== 0 || !existsSync(out)) return { png: "", note: `the renderer failed: ${(p.stderr.toString() || p.stdout.toString()).trim().slice(0, 300)}` };
  return { png: out };
}

// ——— tmux ———

/** A token-like variable in `show-environment` output (unset markers `-NAME` aside), or null. */
export function tokenVar(showEnvironment: string): string | null {
  for (const line of showEnvironment.split("\n")) {
    if (!line || line.startsWith("-")) continue;
    const name = line.split("=")[0]!;
    if (/OAUTH|ANTHROPIC|TOKEN/i.test(name) || FORBIDDEN.test(name)) return name;
  }
  return null;
}

export interface TmuxOptions {
  /** The tmux server's socket name (`-L`). */
  socket?: string;
  /** The session's name. */
  session?: string;
  /** How long Gluon may take to show its home view. */
  startMs?: number;
  /** What Gluon shows once it is up, when it isn't the home view (a resume opens on a session). */
  ready?: RegExp;
}

const TMUX = () => {
  const t = onPath("tmux") ?? onPath("tmux", SYSTEM_PATH.join(delimiter));
  if (!t) throw new Error("tmux is not installed");
  return t;
};

const sleep = (ms: number) => Bun.sleep(ms);

export class TmuxDriver implements Driver {
  note?: string;
  readonly socket: string;
  readonly session: string;
  private tmuxPath = TMUX();
  private closed = false;
  private socketPath: string | null = null;
  private cleanup = () => this.killSync();

  private constructor(
    readonly launch: Launch,
    o: TmuxOptions,
  ) {
    this.socket = o.socket ?? "gluonlive";
    this.session = o.session ?? "gluon";
  }

  /** Runs tmux on this driver's server, with Gluon's (allowlisted) environment: never the runner's. */
  tmux(args: string[]): { code: number; out: string; err: string } {
    const r = Bun.spawnSync([this.tmuxPath, "-L", this.socket, "-f", "/dev/null", ...args], { env: this.launch.env, cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  private must(args: string[]): string {
    const r = this.tmux(args);
    if (r.code !== 0) throw new Error(`tmux ${args[0]}: ${r.err.trim() || `exit ${r.code}`}`);
    return r.out;
  }

  /**
   * Starts Gluon in a new private tmux server (refuses when one runs on the socket already),
   * checks the server's environment holds no token, and waits for the home view.
   */
  static async start(launch: Launch, o: TmuxOptions = {}): Promise<TmuxDriver> {
    const d = new TmuxDriver(launch, o);
    if (d.tmux(["list-sessions"]).code === 0) throw new Error(`a tmux server already runs on -L ${d.socket}: stop it first (tmux -L ${d.socket} kill-server)`);
    for (const k of Object.keys(launch.env)) if (FORBIDDEN.test(k)) throw new Error(`refusing to start Gluon with ${k} in its environment`);
    const term = Bun.spawnSync(["infocmp", "tmux-256color"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0 ? "tmux-256color" : "screen-256color";
    // The options first (a placeholder session keeps the server up), then Gluon's session at its
    // size. `window-size manual` only after it: set before, tmux 3.4's server dies on the new-session.
    d.must([
      "new-session", "-d", "-s", "hold", "-x", "20", "-y", "5", "sleep 3600", ";",
      "set", "-g", "status", "off", ";",
      "set", "-g", "remain-on-exit", "on", ";",
      "set", "-g", "default-terminal", term, ";",
      "new-session", "-d", "-s", d.session, "-x", String(launch.cols), "-y", String(launch.rows), "-c", launch.cwd, "--", ...launch.argv, ";",
      "set", "-g", "window-size", "manual", ";",
      "kill-session", "-t", "hold",
    ]);
    process.on("exit", d.cleanup);
    d.socketPath = d.tmux(["display-message", "-p", "#{socket_path}"]).out.trim() || null;
    try {
      d.assertCleanEnv();
      await d.resize(launch.cols, launch.rows);
      if (!(await d.wait(o.ready ?? /› (describe (the|another) session|reply to the intake agent)/, o.startMs ?? 30_000))) throw new Error(`Gluon's home view didn't show; screen:\n${(await d.screen()).lines.join("\n")}`);
      // Gluon asks the terminal a few things as it starts (the background colour…); tmux leaves
      // some unanswered, and a key pressed before Gluon stops waiting would be read as the answer.
      await sleep(1500);
    } catch (e) {
      d.killSync();
      throw e;
    }
    return d;
  }

  /** Throws (and stops the server) when the server's or the session's environment has a token-like variable. */
  assertCleanEnv(): void {
    for (const args of [["show-environment", "-g"], ["show-environment", "-t", this.session]]) {
      const name = tokenVar(this.must(args));
      if (name) {
        this.killSync();
        throw new Error(`the Gluon tmux server's environment has ${name}: refusing to continue`);
      }
    }
  }

  private get target() {
    return `${this.session}:0.0`;
  }

  private send(bytes: string) {
    if (!bytes) return;
    const hex = [...new TextEncoder().encode(bytes)].map((b) => b.toString(16).padStart(2, "0"));
    for (let i = 0; i < hex.length; i += 1000) this.must(["send-keys", "-t", this.target, "-H", ...hex.slice(i, i + 1000)]);
  }

  /** With escapes, `-N` too: tmux trims trailing blanks otherwise, and the PNG shows the cells Gluon painted as unpainted. */
  private capture(escapes = false): string {
    return this.must(["capture-pane", "-p", ...(escapes ? ["-e", "-N"] : []), "-t", this.target]);
  }

  /** Waits until the screen stops changing (two equal captures 60 ms apart), at most `maxMs`. */
  private async settle(maxMs = 1500) {
    await sleep(60);
    let last = this.capture();
    let stable = 0;
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      await sleep(60);
      const now = this.capture();
      if (now === last) {
        if (++stable >= 2) return;
      } else {
        stable = 0;
        last = now;
      }
    }
  }

  async keys(names: KeyName[]) {
    for (const n of names) {
      if (!(n in KEYS)) throw new Error(`no key named ${n}`);
      this.send(KEYS[n]);
      // Keys arrive one read each, as typed: an Esc followed at once by a letter would read as Alt+letter.
      await sleep(40);
    }
    await this.settle();
  }

  async type(text: string) {
    for (const ch of text) {
      this.send(bytesOf({ text: ch === "\n" ? "\r" : ch }));
      await sleep(15);
    }
    await this.settle();
  }

  async paste(text: string) {
    this.send(bytesOf({ paste: text }));
    await this.settle();
  }

  async mouse(op: MouseOp, button: MouseButton, col: number, row: number, to?: { col: number; row: number }) {
    for (const r of mouseReports({ op, button, x: col, y: row, ...(to ? { to: { x: to.col, y: to.row } } : {}) })) {
      this.send(r);
      await sleep(40);
    }
    await this.settle();
  }

  async wheel(dir: "up" | "down", col: number, row: number) {
    return this.mouse("wheel", dir, col, row);
  }

  async resize(cols: number, rows: number) {
    this.must(["resize-window", "-t", this.session, "-x", String(cols), "-y", String(rows)]);
    await this.settle();
  }

  async screen(): Promise<Screen> {
    const [x, y, flag, w, h, dead] = this.must(["display-message", "-p", "-t", this.target, "#{cursor_x} #{cursor_y} #{cursor_flag} #{pane_width} #{pane_height} #{pane_dead}"]).trim().split(" ").map(Number);
    const rows = h!;
    const cols = w!;
    const lines = this.capture().replace(/\n$/, "").split("\n").slice(0, rows);
    while (lines.length < rows) lines.push("");
    const cursor = { x: x!, y: y!, visible: flag === 1 };
    return { lines, cursor, cols, rows, exited: dead === 1, text: formatScreen(lines, cursor, cols, rows, dead === 1) };
  }

  async screenshot(path: string): Promise<string> {
    mkdirSync(dirname(path), { recursive: true });
    const { cols } = await this.screen();
    const ansi = path.replace(/\.png$/, "") + ".ansi";
    writeFileSync(ansi, this.capture(true));
    const r = renderPng(ansi, cols, path);
    this.note = r.note;
    return r.png;
  }

  async wait(what: number | RegExp, timeoutMs = 5000): Promise<boolean> {
    if (typeof what === "number") {
      await sleep(Math.max(0, Math.min(what, 5000)));
      await this.settle(500);
      return true;
    }
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (what.test(this.capture())) {
        await this.settle(500);
        return true;
      }
      if (Date.now() >= end) return false;
      await sleep(100);
    }
  }

  private killSync() {
    if (this.closed) return;
    this.closed = true;
    process.off("exit", this.cleanup);
    this.tmux(["kill-server"]);
    // tmux leaves the socket file behind.
    if (this.socketPath) rmSync(this.socketPath, { force: true });
    for (const d of this.launch.scratch) rmSync(d, { recursive: true, force: true });
  }

  async close() {
    this.killSync();
  }
}

// ——— the fake driver (tests) ———

/** An in-memory screen that records every action; `react` changes the screen in answer (a scripted Gluon). */
export class FakeDriver implements Driver {
  note?: string;
  lines: string[] = [];
  cursor = { x: 0, y: 0, visible: true };
  readonly actions: Action[] = [];
  closed = false;
  constructor(
    screen: string | string[] = "",
    public cols = 100,
    public rows = 30,
    public react: (a: Action, d: FakeDriver) => void = () => {},
  ) {
    this.show(screen);
  }
  /** Puts this text on the screen. */
  show(screen: string | string[]) {
    this.lines = typeof screen === "string" ? screen.split("\n") : [...screen];
  }
  private act(a: Action) {
    if (this.closed) throw new Error("the driver is closed");
    this.actions.push(a);
    this.react(a, this);
  }
  async keys(names: KeyName[]) {
    for (const key of names) {
      if (!(key in KEYS)) throw new Error(`no key named ${key}`);
      this.act({ key });
    }
  }
  async type(text: string) {
    this.act({ text });
  }
  async paste(text: string) {
    this.act({ paste: text });
  }
  async mouse(op: MouseOp, button: MouseButton, col: number, row: number, to?: { col: number; row: number }) {
    this.act({ mouse: { op, button, x: col, y: row, ...(to ? { to: { x: to.col, y: to.row } } : {}) } });
  }
  async wheel(dir: "up" | "down", col: number, row: number) {
    return this.mouse("wheel", dir, col, row);
  }
  async resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.act({ resize: { cols, rows } });
  }
  async screen(): Promise<Screen> {
    const lines = Array.from({ length: this.rows }, (_, y) => this.lines[y] ?? "");
    return { lines, cursor: { ...this.cursor }, cols: this.cols, rows: this.rows, text: formatScreen(lines, this.cursor, this.cols, this.rows) };
  }
  async screenshot(path: string): Promise<string> {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `fake screenshot\n${this.lines.join("\n")}\n`);
    return path;
  }
  async wait(what: number | RegExp, timeoutMs = 5000): Promise<boolean> {
    if (typeof what === "number") {
      await sleep(Math.min(what, 20));
      return true;
    }
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (what.test(this.lines.join("\n"))) return true;
      if (Date.now() >= end) return false;
      await sleep(10);
    }
  }
  async close() {
    this.closed = true;
  }
}

// ——— the real mode's guard ———

/** A prompt to an agent past the cap: refused, nothing sent. */
export class PromptCapError extends Error {}
/** A sign-in, login or API-key screen showed: the run stops. */
export class LoginScreenError extends Error {}

const LOGIN = /\b(sign[ -]?in|sign[ -]?up|log[ -]?in|authenticat\w*|oauth|paste (your|the) (code|token))\b/i;
const API_KEY = /\bapi[ -]?key\b/i;

/** Gluon's own agent list (`○  codex  sign-in needed · not connected`, `ready · api key`): a status, not a prompt. */
const READINESS = /\b(sign-in needed|not connected|not installed|key missing|checking…)|ready · /i;
/** Antigravity's start banner names how it signed in, a row of its own beside the logo (`▀▀▀▀▀▀   Gemini API key`): a status. */
const AGY_BANNER = /^[\s│▀▄█]*Gemini API key[\s│]*$/;

/** The first line of a screen that looks like a sign-in, login or API-key prompt, or null. */
export function loginLine(lines: string[]): string | null {
  for (const l of lines) {
    if (READINESS.test(l) || AGY_BANNER.test(l)) continue;
    if (LOGIN.test(l) || API_KEY.test(l)) return l.trim();
  }
  return null;
}

/** Keys that submit a line (and so may send a prompt). */
const ENTER: ReadonlySet<KeyName> = new Set<KeyName>(["enter", "ctrlJ", "kittyEnter", "shiftEnter", "kittyShiftEnter", "altEnter"]);
/** Keys that add nothing to an agent's input line (the rest count as typing: Up recalls history). */
const NEUTRAL: ReadonlySet<KeyName> = new Set<KeyName>(["esc", "kittyEsc", "ctrlC", "kittyCtrlC", "ctrlBackslash", "ctrlBracket", "ctrlCaret", "ctrlUnderscore", "kittyCtrlBackslash", "left", "right", "shiftLeft", "shiftRight", "altLeft", "altRight", "ctrlLeft", "ctrlRight", "kittyLeft", "kittyRight", "kittyLeftRelease", "ssLeft", "pgup", "pgdn", "shiftPgup", "shiftPgdn", "altPgup", "altPgdn", "ctrlPgup", "tab", "shiftTab"]);

/** Neutral keys that leave every agent's input line as it was: Gluon's own (home, switch, scroll), and Esc. */
const LINE_KEEPS: ReadonlySet<KeyName> = new Set<KeyName>(["esc", "kittyEsc", "pgup", "pgdn", "shiftPgup", "shiftPgdn", "ctrlBackslash", "ctrlBracket", "ctrlCaret", "ctrlUnderscore", "kittyCtrlBackslash", "altPgup", "altPgdn", "ctrlPgup"]);
/** ←/→: Gluon's switch on a line untouched since its Enter, else the agent's (they move its cursor). */
const ARROWS: ReadonlySet<KeyName> = new Set<KeyName>(["left", "right", "kittyLeft", "kittyRight", "kittyLeftRelease", "ssLeft", "shiftLeft", "shiftRight"]);
/** A session in the guard's model: typed into since its last Enter; its input line (null: not known). */
interface LineState {
  dirty: boolean;
  line: string | null;
}
/** Which session a session view shows: its info line's triple (`claude code × haiku 4.5 × low`); "" when it can't tell. */
const sessionKey = (lines: string[]) => {
  const k = (lines[1] ?? "").trim().split(" · ")[0]!;
  return k.includes(" × ") ? k : "";
};
/** An agent's own commands that make no model call: an Enter on a line holding one alone isn't a prompt. */
export const LOCAL_COMMANDS = /^\/(clear|new)$/;

/**
 * Whether a screen row shows an input line holding just `text`: the row, its frame border and
 * spaces cut off the end, ends with `text`, with only a prompt mark, a border or nothing before it.
 */
export function inputHolds(lines: string[], text: string): boolean {
  return lines.some((l) => {
    const s = l.replace(/[\s│┃|]+$/, "");
    if (!s.endsWith(text)) return false;
    const before = s.slice(0, -text.length).trimEnd();
    return before === "" || /[│┃|>›❯»]$/.test(before);
  });
}

export interface GuardOptions {
  /** Prompts to agents allowed in all (default 2). */
  maxPrompts?: number;
  /** Called once, the moment a login screen shows (the run's abort). */
  onAbort?: (why: string) => void;
}

/** Gluon's resume question for a saved session with no way back: Enter starts it again from its spec (`Start it again?`, `Start <name> again?`). */
export const RESTART = /\bStart .{0,60}\bagain\b[^?]{0,40}\?/;

/** Which view a screen shows, for the guard: a session (an agent gets keys), the agent choice or the restart question (Enter launches one), else. */
export function guardView(lines: string[]): "session" | "proposal" | "other" {
  // The question first: it may be up over a session view too, and an Enter there answers it.
  if (lines.some((l) => l.includes("keep talking") || RESTART.test(l))) return "proposal";
  if (lines[0]?.includes("◆ gluon")) return "session";
  return "other";
}

/**
 * The `real` mode's guard. Counts prompts to agents and refuses one past `maxPrompts`: an Enter in
 * a session's view after anything was typed or pasted there since the last Enter (conservative:
 * Up, Backspace, a slash command all count as typing), and an Enter while the agent choice is up
 * (a launch hands the agent its spec). The one exception: a line that is just `/clear` or `/new`
 * (`LOCAL_COMMANDS`, no model call), by both the guard's model of that session's line (what was
 * typed there since its last Enter; sessions told apart by their info line) and the screen
 * (`inputHolds`). A session view it can't tell apart makes every line unknown. Aborts (`onAbort`,
 * then `LoginScreenError` from every call) the moment a sign-in, login or API-key screen shows,
 * checked after every call and by `watch`.
 */
export class GuardedDriver implements Driver {
  prompts = 0;
  /** Each session's line, by `sessionKey`. A session not seen yet was just launched: an empty line. */
  private sessions = new Map<string, LineState>();
  /** Typing reached a session the guard couldn't tell apart: no line is known any more. */
  private tainted = false;
  aborted: string | null = null;
  readonly maxPrompts: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    readonly inner: Driver,
    private opts: GuardOptions = {},
  ) {
    this.maxPrompts = opts.maxPrompts ?? 2;
  }
  get note() {
    return this.inner.note;
  }

  /** Polls the screen every `ms` for a login screen, between calls too. */
  watch(ms = 400) {
    this.timer ??= setInterval(() => void this.check().catch(() => {}), ms);
  }

  private listeners: ((why: string) => void)[] = [];
  /** Calls `fn` once, the moment a login screen shows (at once if one already did). */
  onAbort(fn: (why: string) => void) {
    if (this.aborted) fn(this.aborted);
    else this.listeners.push(fn);
  }

  private abort(why: string) {
    if (this.aborted) return;
    this.aborted = why;
    if (this.timer) clearInterval(this.timer);
    this.opts.onAbort?.(why);
    for (const fn of this.listeners) fn(why);
  }

  private hit(lines: string[]) {
    const l = loginLine(lines);
    if (l) this.abort(`a sign-in screen showed: ${JSON.stringify(l.slice(0, 120))}`);
  }

  /** Throws once aborted; checks the screen now. */
  async check(): Promise<void> {
    if (this.aborted) throw new LoginScreenError(this.aborted);
    this.hit((await this.inner.screen()).lines);
    if (this.aborted) throw new LoginScreenError(this.aborted);
  }

  /** The shown session's line state (null: not a session view). */
  private async shown(): Promise<{ lines: string[]; s: LineState | null }> {
    const lines = (await this.inner.screen()).lines;
    if (guardView(lines) !== "session") return { lines, s: null };
    const k = sessionKey(lines);
    if (!k) return { lines, s: { dirty: true, line: null } };
    let s = this.sessions.get(k);
    if (!s) this.sessions.set(k, (s = this.tainted ? { dirty: true, line: null } : { dirty: false, line: "" }));
    return { lines, s };
  }

  /**
   * Typing (`edit`: what it does to the line, null: unknown). In a session it makes the line
   * dirty and updates the guard's model of that session's input line.
   */
  private async typing(edit: ((line: string) => string) | null) {
    if (this.aborted) throw new LoginScreenError(this.aborted);
    const { lines, s } = await this.shown();
    if (!s) return;
    if (!sessionKey(lines)) {
      // Which session got it can't be told: every line is unknown from now on.
      this.tainted = true;
      for (const x of this.sessions.values()) Object.assign(x, { dirty: true, line: null });
      return;
    }
    s.dirty = true;
    s.line = edit === null || s.line === null ? null : edit(s.line);
  }

  /**
   * An Enter: counted (and refused past the cap) when it submits a typed line to an agent or
   * launches one. Not counted: a line that is only an agent's local command (`LOCAL_COMMANDS`: no
   * model call), when both the guard's model of the line and the screen say so.
   */
  private async enter(send: () => Promise<void>) {
    if (this.aborted) throw new LoginScreenError(this.aborted);
    const { lines, s } = await this.shown();
    const v = guardView(lines);
    const local = !!s && s.line !== null && LOCAL_COMMANDS.test(s.line) && inputHolds(lines, s.line);
    const counts = (!!s && s.dirty && !local) || v === "proposal";
    if (counts && this.prompts >= this.maxPrompts)
      throw new PromptCapError(`refused: that Enter would send prompt ${this.prompts + 1} to an agent; this run allows ${this.maxPrompts}. Nothing was sent.`);
    await send();
    if (counts) this.prompts++;
    // The submitted line is empty again.
    if (s) Object.assign(s, { dirty: false, line: "" });
  }

  async keys(names: KeyName[]) {
    for (const n of names) {
      if (this.aborted) throw new LoginScreenError(this.aborted);
      if (ENTER.has(n)) await this.enter(() => this.inner.keys([n]));
      else {
        const ch: string = KEYS[n];
        if (n === "backspace") await this.typing((l) => l.slice(0, -1));
        else if (!NEUTRAL.has(n)) await this.typing(/^[ -~]$/.test(ch) ? (l) => l + ch : null);
        else if (!LINE_KEEPS.has(n)) {
          // ←/→ on an untouched line are Gluon's; any other neutral key (Tab, Ctrl+C…) is the agent's.
          const { s } = await this.shown();
          if (s && (s.dirty || !ARROWS.has(n))) s.line = null;
        }
        await this.inner.keys([n]);
      }
    }
    await this.check();
  }
  async type(text: string) {
    for (const part of text.split(/([\r\n])/)) {
      if (!part) continue;
      if (part === "\r" || part === "\n") await this.enter(() => this.inner.type(part));
      else {
        await this.typing((l) => l + part);
        await this.inner.type(part);
      }
    }
    await this.check();
  }
  async paste(text: string) {
    await this.typing((l) => l + text);
    await this.inner.paste(text);
    await this.check();
  }
  async mouse(op: MouseOp, button: MouseButton, col: number, row: number, to?: { col: number; row: number }) {
    if (this.aborted) throw new LoginScreenError(this.aborted);
    // A click on the tab strip (row 1) switches; anywhere else in a session it may move the agent's cursor.
    if (row !== 1) {
      const { s } = await this.shown();
      if (s) s.line = null;
    }
    await this.inner.mouse(op, button, col, row, to);
    await this.check();
  }
  async wheel(dir: "up" | "down", col: number, row: number) {
    if (this.aborted) throw new LoginScreenError(this.aborted);
    await this.inner.wheel(dir, col, row);
    await this.check();
  }
  async resize(cols: number, rows: number) {
    if (this.aborted) throw new LoginScreenError(this.aborted);
    await this.inner.resize(cols, rows);
    await this.check();
  }
  async screen() {
    if (this.aborted) throw new LoginScreenError(this.aborted);
    const s = await this.inner.screen();
    this.hit(s.lines);
    if (this.aborted) throw new LoginScreenError(this.aborted);
    return s;
  }
  screenshot(path: string) {
    return this.inner.screenshot(path);
  }
  async wait(what: number | RegExp, timeoutMs?: number) {
    if (this.aborted) throw new LoginScreenError(this.aborted);
    const r = await this.inner.wait(what, timeoutMs);
    await this.check();
    return r;
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.inner.close();
  }
}
