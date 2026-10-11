/**
 * The fakes against the real harnesses: each fake agent (test/fixtures/fake-tui.ts) is driven through the states of its harness's
 * screen fixture (test/fixtures/screens/, the real harness's screens, re-captured on each release by the Harness watch with
 * scripts/capture-screens.ts), and Gluon's readers must read the fake as they read the real one: the input line, the highlighted
 * command, a question waiting, ready. A fake that drifts from its harness fails here before a test built on it lies.
 *
 * Offline and free (the fakes only; the real side is the committed fixture). Runs in `bun run regression`'s real stage, beside
 * test/real/harness.real.test.ts. A highlighted command the fake doesn't have (`TUI_COMMANDS`) is the real menu's: not compared.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READERS } from "../../src/pty/readers/index.ts";
import { TUI_COMMANDS } from "../fixtures/fake-tui.ts";
import { REAL_HARNESSES, type RealHarness } from "../fixtures/real-harness.ts";
import { fixture, screenOf, type ScreenFixture, type ScreenState } from "../fixtures/screens.ts";
import { capturable } from "../../scripts/capture-screens.ts";

/**
 * Where a fake reads differently from its harness today, `harness/state/field` → why. Each is a fake to fix; a line that no
 * longer differs fails until it goes (the list only shrinks).
 */
const KNOWN: Record<string, string> = {
  "claude-code/cl-tab/selected": "Tab completes /clear and the real menu drops its highlight; the fake keeps /clear highlighted",
  "claude-code/new/selected": "the real menu shows /new as /clear's alias, highlighting /clear; the fake has its own /new",
  "codex/c/selected": "the real menu puts /compact first for /c; the fake keeps its own order, /clear first",
  "codex/c-down3/selected": "the real menu's order under /c (/compact, /copy, /cd, /clear …); the fake's is /clear, /compact",
  "codex/cl-tab/selected": "Tab completes /clear and the real menu closes; the fake keeps it open",
  "codex/help/selected": "the real Codex has no /help: nothing is highlighted; the fake has one",
  "kimi-code/cl-tab/selected": "the real menu closes after Tab; the fake keeps /new highlighted",
  "kimi-code/long/input": "the real composer wraps a long line at a word; the fake cuts it mid-word",
  "opencode/c-down1/selected": "the real menu's order under /c (/cd, /clear, /connect …); the fake's is /clear, /compact",
};

type Read = { input: string | null; selected: string | null; choice: boolean; ready?: boolean };

async function read(h: RealHarness, f: Pick<ScreenFixture, "cols" | "rows">, s: ScreenState): Promise<Read> {
  const screen = await screenOf(f as ScreenFixture, s);
  const r = READERS[h];
  const out: Read = { input: r.inputLine(screen), selected: r.selectedCommand(screen), choice: !!r.awaitsChoice?.(screen), ...(r.ready ? { ready: !!r.ready(screen) } : {}) };
  screen.dispose();
  return out;
}

/** The fields where the fake reads differently from the real screen: `state/field` → `real ≠ fake`. */
export function differences(h: RealHarness, real: Read, fake: Read, state: string): Record<string, string> {
  const out: Record<string, string> = {};
  const flat = (t: string | null) => (t === null ? null : t.replace(/\s+/g, " ").trim());
  const put = (field: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) out[`${h}/${state}/${field}`] = `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  };
  put("input", flat(real.input), flat(fake.input));
  if (real.selected === null || TUI_COMMANDS.includes(real.selected)) put("selected", real.selected, fake.selected);
  put("choice", real.choice, fake.choice);
  if (real.ready !== undefined) put("ready", real.ready, fake.ready);
  return out;
}

const wanted = (process.env.GLUON_REAL_HARNESSES ?? Object.keys(REAL_HARNESSES).join(",")).split(",").filter((h): h is RealHarness => h in REAL_HARNESSES);

describe("the fakes read like the real harnesses (their recorded screens)", () => {
  for (const h of wanted) {
    test.concurrent(`fidelity/screens: ${h}: Gluon's readers read the fake as they read the real one, state by state`, async () => {
      const real = fixture(h);
      const out = join(mkdtempSync(join(tmpdir(), `fidelity-${h}-`)), "fake.json");
      // Its own process: the capture sets PATH, the config and the keys for one harness (scripts/capture-screens.ts).
      const p = Bun.spawn([process.execPath, "--no-env-file", "--config=scripts/empty-bunfig.toml", "scripts/capture-screens.ts", "--harness", h, "--fake", "--out", out], { cwd: join(import.meta.dir, "../.."), env: process.env, stdout: "pipe", stderr: "pipe" });
      const err = await new Response(p.stderr).text();
      expect([h, await p.exited, err.slice(-2000)]).toEqual([h, 0, expect.anything()]);
      const fake = JSON.parse(readFileSync(out, "utf8")) as ScreenFixture;
      const found: Record<string, string> = {};
      for (const s of capturable(real)) {
        const f = fake.states.find((x) => x.name === s.name)!;
        Object.assign(found, differences(h, await read(h, real, s), await read(h, fake, f), s.name));
      }
      const mine = Object.keys(KNOWN).filter((k) => k.startsWith(`${h}/`));
      expect(Object.entries(found).filter(([k]) => !(k in KNOWN)).map(([k, v]) => `${k}: real ${v} fake (fix the fake, test/fixtures/fake-tui.ts)`)).toEqual([]);
      expect(mine.filter((k) => !(k in found)).map((k) => `${k}: reads like the real one now: remove it from KNOWN`)).toEqual([]);
    }, 180_000);
  }
});
