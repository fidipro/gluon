#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun scripts/capture-screens.ts --harness <id> (--binary <path> --version <v> | --pinned | --fake) [--states a,b] [--out <file> | --update]`: a harness's
 * own screens, as Gluon's screen model reads them, for the states of its screen fixture (`test/fixtures/screens/`): each state is
 * a fresh launch through Gluon's own launch (`buildCommand`, `launchSession`), on the loopback model API (no prompt reaches it),
 * then the state's keys, one at a time, each waited out. Writes the fixture format (`test/fixtures/screens.ts`).
 *
 * - `--binary`: the real harness (the pinned one from the cache, `bun scripts/harness-pin.ts --install`); `--update` writes it as
 *   the harness's fixture for that version (replacing the older one), keeping the states this tool can't capture (inside Gluon's
 *   frame, `size`; another version's, `version`). The Harness watch does this on a release; a person reviews the diff.
 * - `--pinned`: the pinned binary (test/harnesses.json; installed into the cache if it isn't), with `--update` only when the
 *   fixture is of another version: what the Harness watch runs for a release.
 * - `--fake`: the fake agent (`test/fixtures/fake-tui.ts`), for the fidelity test (`test/real/fidelity.real.test.ts`).
 *
 * One harness and one binary per process: the binary is found on PATH (`binPath`), as Gluon finds it. Only the harnesses on a
 * loopback model API (`REAL_HARNESSES`, test/fixtures/real-harness.ts).
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { adapterOutput } from "../src/adapters/index.ts";
import { loadConfig } from "../src/config.ts";
import { handoffFor } from "../src/handoff.ts";
import type { Harness } from "../src/harnesses.ts";
import { buildCommand } from "../src/launchers.ts";
import { READERS } from "../src/pty/readers/index.ts";
import { launchSession } from "../src/pty/session.ts";
import { useSecrets } from "../src/secrets.ts";
import { fakeAgents } from "../test/e2e/fixtures.ts";
import { fakeModelApi } from "../test/fixtures/fake-model-api.ts";
import { firstRunDone, KEY_VALUE, KEYS, QUIET, REAL_HARNESSES, type RealHarness } from "../test/fixtures/real-harness.ts";
import { fixture, recordRow, type ScreenFixture, type ScreenState } from "../test/fixtures/screens.ts";
import { seedTables } from "../test/fixtures/seed-tables.ts";
import { tablesDir } from "../src/cost/tables-store.ts";
import { harnessBin } from "./harness-cache.ts";
import { checkConfig, DialogAnswerer } from "./live-harness.ts";
import { cheapestModel } from "./live-lib.ts";

/** The fixtures' key names, as the bytes a terminal sends. */
export const KEY_BYTES: Record<string, string> = { tab: "\t", down: "\x1b[B", up: "\x1b[A", backspace: "\x7f", esc: "\x1b", enter: "\r", "shift-tab": "\x1b[Z" };
export const keyBytes = (k: string): string => KEY_BYTES[k] ?? (k.length === 1 ? k : (() => { throw new Error(`unknown key "${k}"`); })());

/** A dark terminal's colours, as the fixtures were taken (the harnesses ask with OSC 10/11). */
const DARK = { fg: [204, 204, 204] as const, bg: [0, 0, 0] as const };
/** What the capture keeps of its own environment; the rest goes, and PATH is the binary's directory and the system's. */
const KEEP_ENV = /^(LANG|LC_\w+|TERM|COLORTERM|USER|LOGNAME|SHELL|TMPDIR|TZ)$/;
const SYSTEM_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];
/** The fake agents' bash scripts (`fakeAgents`) by harness. */
const FAKE_NAME: Record<RealHarness, "claude" | "codex" | "opencode" | "kimi"> = { "claude-code": "claude", codex: "codex", opencode: "opencode", "kimi-code": "kimi" };

/** The states this tool takes: the ones captured from the harness alone at the fixture's size and version. */
export const capturable = (f: ScreenFixture): ScreenState[] => f.states.filter((s) => !s.size && !s.version);

/** Resolves once the screen has stayed the same for `quietMs` (and `minMs` has passed), or at `maxMs`. */
async function settle(serialize: () => string, quietMs: number, minMs: number, maxMs: number): Promise<void> {
  const start = Date.now();
  let last = serialize();
  let since = Date.now();
  while (Date.now() - start < maxMs) {
    await Bun.sleep(50);
    const now = serialize();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs && Date.now() - start >= minMs) return;
  }
}

export interface CaptureOptions {
  harness: RealHarness;
  /** The real binary; none: the fake agent. */
  binary?: string;
  /** The binary's version (the fake's: the pin's). */
  version: string;
  states: Pick<ScreenState, "name" | "keys">[];
  cols?: number;
  rows?: number;
  /** States captured at once (each its own launch and HOME). */
  parallel?: number;
}

/** The states' screens. Sets this process's PATH, config and keys for the harness: one harness and one binary per process. */
export async function capture(o: CaptureOptions): Promise<ScreenState[]> {
  const h = o.harness;
  const conn = REAL_HARNESSES[h];
  const cols = o.cols ?? 100;
  const rows = o.rows ?? 30;
  const work = mkdtempSync(join(tmpdir(), `gluon-capture-${h}-`));
  const api = fakeModelApi("OK");
  try {
    const bin = o.binary ? dirname(resolve(o.binary)) : fakeAgents([FAKE_NAME[h]]);
    // Nothing of the developer's environment (a harness's own variables, a session marker, their PATH) reaches the harness.
    for (const k of Object.keys(process.env)) if (!KEEP_ENV.test(k)) delete process.env[k];
    process.env.PATH = [bin, ...SYSTEM_PATH].join(delimiter);
    Object.assign(process.env, QUIET, { GLUON_TEST_MODEL_URL: api.url, GLUON_CONFIG: join(work, "config.yaml") }, o.binary ? {} : { FAKE_TUI: "1" });
    writeFileSync(join(work, "config.yaml"), checkConfig(h, conn, { region: null }));
    useSecrets([[KEYS[conn], KEY_VALUE(KEYS[conn])]], "fake");
    const config = loadConfig();
    const model = cheapestModel(config.models[h], conn);
    if (!model) throw new Error(`${h}: no model on ${conn}`);
    const settings = handoffFor(config.handoff, h);
    const flat = (t: string | null) => (t ?? "").replace(/\s+/g, " ").trim();
    /** The typed text reached the input line: its end is there, and about all of it (a reader may leave out a leading mark). */
    const arrived = (input: string | null, text: string) => flat(input).endsWith(flat(text).slice(-8)) && flat(input).length >= flat(text).length - 2;
    /** The text a state types before its first other key: what its input line must show then (a key lost under load: tried again). */
    const typed = (keys: string[]) => keys.slice(0, (keys.findIndex((k) => k.length !== 1) + 1 || keys.length + 1) - 1).join("");
    const one = async (s: Pick<ScreenState, "name" | "keys">): Promise<ScreenState> => {
      for (let attempt = 1; ; attempt++) {
        const got = await once(s);
        if (got || attempt === 3) return got ?? (await once(s, true))!;
      }
    };
    /** One launch: the state, or null when its typed text didn't reach the input line (`force`: the state as it is). */
    const once = async (s: Pick<ScreenState, "name" | "keys">, force = false): Promise<ScreenState | null> => {
      const dir = mkdtempSync(join(work, `${s.name}-`));
      const home = join(dir, "home");
      const repo = join(dir, "repo");
      mkdirSync(home, { recursive: true });
      mkdirSync(repo, { recursive: true });
      seedTables(tablesDir({ HOME: home }, process.platform, home));
      firstRunDone(h, home, repo, KEY_VALUE(KEYS[conn]));
      const cmd = buildCommand(config, { harness: h, model: model.entry.id, spec: "", reason: "capture" }, adapterOutput({ harness: h, version: o.version, handoff: settings, env: process.env }));
      const { session } = launchSession({ ...cmd, env: { ...cmd.env, HOME: home } }, settings, { cwd: repo, cols, rows, tmp: dir, screen: { colours: DARK } });
      try {
        const ser = () => session.screen.serialize();
        // Ready when Gluon's reader sees an empty input line and no question (Kimi Code: its `ready`), as Gluon itself waits: a quiet screen alone
        // isn't (a harness still starting drops the keys typed meanwhile).
        const reader = READERS[h];
        const ready = () => !reader.awaitsChoice?.(session.screen) && (reader.ready ? reader.ready(session.screen) : reader.inputLine(session.screen) === "");
        // A first-run question (a scratch HOME is always a first run: folder trust, Gluon's hooks): answered as the live checks do.
        let dialogs = new DialogAnswerer();
        let answeredAt = 0;
        for (const end = Date.now() + 45_000; !ready() && Date.now() < end; ) {
          await settle(ser, 300, 0, 3000);
          const a = dialogs.next(Array.from({ length: rows }, (_, y) => session.screen.line(y).text));
          for (const step of a?.steps ?? []) {
            if ("wait" in step) await Bun.sleep(step.wait); // sleep-ok: the answer's own pause, as the live checks make it
            else session.passthrough("type" in step ? step.type : step.keys.map(keyBytes).join(""));
          }
          if (a) answeredAt = Date.now();
          // An answer the harness took before it listened (the question is still up 3 s on): answered again.
          else if (answeredAt && Date.now() - answeredAt > 3000) [dialogs, answeredAt] = [new DialogAnswerer(), 0];
          else await Bun.sleep(100);
        }
        // Long enough for what a harness draws after a pause (Claude Code's faint placeholder in the empty box: BUG-719).
        await settle(ser, o.binary ? 2000 : 300, 0, 10_000);
        const text = typed(s.keys);
        for (const [i, k] of s.keys.entries()) {
          session.passthrough(keyBytes(k));
          await settle(ser, o.binary ? 300 : 80, o.binary ? 150 : 30, 5000);
          if (i === text.length - 1 && !force && !arrived(reader.inputLine(session.screen), text)) return null;
        }
        const lines = Array.from({ length: rows }, (_, y) => session.screen.viewLine(y));
        return { name: s.name, keys: s.keys, cursor: session.screen.cursor(), ansi: ser(), rows: lines.map((l) => recordRow(l.text, l.cells)) };
      } finally {
        session.kill();
        await Promise.race([session.exited, Bun.sleep(3000)]); // sleep-ok: a bound on the exit, not a wait for it
        session.dispose();
      }
    };
    const out: ScreenState[] = new Array(o.states.length);
    const queue = o.states.map((s, i) => [s, i] as const);
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel ?? (o.binary ? 3 : 6), queue.length)) }, async () => {
      for (let q = queue.shift(); q; q = queue.shift()) out[q[1]] = await one(q[0]);
    }));
    return out;
  } finally {
    api.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const h = flag("harness") as RealHarness | undefined;
  if (!h || !(h in REAL_HARNESSES) || (!flag("binary") && !argv.includes("--pinned") && !argv.includes("--fake"))) {
    console.error(`usage: bun scripts/capture-screens.ts --harness <${Object.keys(REAL_HARNESSES).join("|")}> (--binary <path> --version <v> | --pinned | --fake) [--states a,b] [--out <file> | --update]`);
    process.exit(2);
  }
  const old = fixture(h as Harness);
  if (argv.includes("--pinned")) {
    const pinned = await harnessBin(h, { log: (l) => console.error(l) });
    if (pinned.version === old.version && argv.includes("--update")) {
      console.log(`${h} ${old.version}: the fixture is the pinned version's already`);
      process.exit(0);
    }
    argv.push("--binary", pinned.path, "--version", pinned.version);
  }
  const wanted = flag("states")?.split(",");
  const states = capturable(old).filter((s) => !wanted || wanted.includes(s.name));
  const version = flag("version") ?? old.version;
  const captured = await capture({ harness: h, ...(flag("binary") ? { binary: flag("binary")! } : {}), version, states, cols: old.cols, rows: old.rows });
  const keep = old.states.filter((s) => !captured.some((c) => c.name === s.name)).map((s) => (s.version || s.size ? s : { ...s, version: old.version }));
  const file: ScreenFixture = {
    ...old,
    version,
    captured: new Date().toISOString().slice(0, 10),
    notes: `${old.notes.split(" Re-captured by")[0]} Re-captured by scripts/capture-screens.ts (Gluon's launch, the loopback model API, a dark terminal) on ${new Date().toISOString().slice(0, 10)}; states it can't take kept from before.`,
    states: [...captured, ...keep],
  } as ScreenFixture;
  const json = `${JSON.stringify(file)}\n`;
  if (argv.includes("--update")) {
    const dir = join(import.meta.dir, "..", "test", "fixtures", "screens", h);
    for (const f of readdirSync(dir)) if (f !== `${version}.json`) rmSync(join(dir, f));
    writeFileSync(join(dir, `${version}.json`), json);
    console.log(`${h} ${version}: ${captured.length} states captured, ${keep.length} kept → test/fixtures/screens/${h}/${version}.json`);
  } else if (flag("out")) writeFileSync(flag("out")!, json);
  else process.stdout.write(json);
}
