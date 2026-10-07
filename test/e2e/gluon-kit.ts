/**
 * Gluon scenarios' building blocks: start Gluon on the demo brain with the TUI fakes (`FAKE_TUI`),
 * walk the demo to a session in the frame, talk to the agent, go home. `launchAs` starts Gluon with
 * one harness's fake alone on PATH, so its layout and reader are the ones under test;
 * `openSessions` opens several sessions, for the states with more than one tab.
 */
import { join } from "node:path";
import { HARNESS_INFO, type Harness } from "../../src/harnesses.ts";
import { HOME_TWICE, KEYS } from "./actions.ts";
import { freshConfig, repo, type FakeAgent } from "./fixtures.ts";
import { type App, HOME_VIEW, start } from "./harness.ts";

/** The fake's `!event` hook: writes an event as `gluon signal` / a status hook does. */
export const EVENT_HOOK = `"${process.execPath}" --no-env-file "${join(import.meta.dir, "../fixtures/write-event.ts")}"`;

/** Each fake's harness. */
export const HARNESS_OF: Record<FakeAgent, Harness> = { claude: "claude-code", codex: "codex", opencode: "opencode", agy: "antigravity", grok: "grok-build", kimi: "kimi-code" };
/** The fakes in harness order: the monkey and the visual scenes walk these (Kimi Code's, with its own scenarios, is not yet one of them). */
export const FAKES: readonly FakeAgent[] = ["claude", "codex", "opencode", "agy", "grok"];
/** The harness's name as the info line and the proposal write it (`claude code × …`). */
export const LABEL: Record<FakeAgent, string> = Object.fromEntries((Object.keys(HARNESS_OF) as FakeAgent[]).map((f) => [f, HARNESS_INFO[HARNESS_OF[f]].label.toLowerCase()])) as Record<FakeAgent, string>;

/** `handoff.on_clear: ask`: a typed /clear asks before ending the session. */
export const ASK_YAML = "handoff:\n  on_clear: ask\n";

let n = 0;

/** Gluon on the demo brain with the TUI fakes (`agents` on PATH; by default `claude` and `opencode`), its own config. */
export async function gluon(cols = 100, rows = 30, env: Record<string, string> = {}, yaml = ASK_YAML, agents?: FakeAgent[]): Promise<App> {
  const cfg = freshConfig(`kit-${process.pid}-${++n}`, yaml);
  return start({ cwd: repo.tiny(), cols, rows, agents, env: { GLUON_CONFIG: cfg, FAKE_TUI: "1", FAKE_EVENT_HOOK: EVENT_HOOK, ...env } });
}

/** Walks the demo intake agent to its agent choice (the proposal, `keep talking` last). */
export async function toChoice(app: App, task: string) {
  await app.enter(task);
  await app.press(KEYS.enter);
  // Wrapped on a narrow terminal: compare with the line breaks gone.
  await app.waitFor((s) => s.replace(/\s+/g, " ").includes("Should the fix include a regression test"), 20_000);
  await app.idle();
  await app.press(KEYS.enter);
  await app.waitFor("keep talking", 20_000);
  await app.idle();
}

/** A session's agent is up in the frame: the fake's TUI and the tab strip. */
const inFrame = (s: string) => s.includes("TUI ready") && s.includes("◆ gluon");

/** Walks the demo to its proposal and starts an agent (`pick`: keys pressed first; Enter alone starts the recommended one). */
export async function launch(app: App, task: string, pick: string[] = []) {
  await toChoice(app, task);
  for (const k of pick) await app.press(k);
  await app.press(KEYS.enter);
  await app.waitFor(inFrame, 20_000);
  await app.settle(200);
}

/** Types a line into the agent and waits for its answer. */
export async function say(app: App, line: string, answer: string | RegExp = `GOT <${line}>`) {
  await app.type(line);
  await app.press(KEYS.enter);
  await app.waitFor(answer);
}

/** Back home from a session (the default home key, twice: the first arms the prefix). */
export async function home(app: App) {
  await app.press(...HOME_TWICE);
  await app.waitFor(HOME_VIEW);
  await app.settle(150);
}

export interface LaunchOptions {
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  yaml?: string;
  task?: string;
}

/**
 * Gluon with only `fake` on PATH, walked to a session of it in the frame (the demo proposes the
 * only installed agent). Resolves with the app once the fake's TUI shows.
 */
export async function launchAs(fake: FakeAgent, { cols = 100, rows = 30, env = {}, yaml = ASK_YAML, task = `${fake} task` }: LaunchOptions = {}): Promise<App> {
  const app = await gluon(cols, rows, env, yaml, [fake]);
  await launch(app, task);
  // The info line names the harness (below 20×6 only `too small` is drawn).
  if (cols >= 20 && rows >= 6) await app.waitFor((s) => s.split("\n")[1]?.startsWith(` ${LABEL[fake]} × `) ?? false);
  return app;
}

/**
 * The proposal's option for `fake`: its number (1-based) in the agent choice now on screen, by the
 * label it starts with; null when the demo didn't offer it.
 */
export function optionOf(app: App, fake: FakeAgent): number | null {
  const label = LABEL[fake];
  for (const line of app.lines()) {
    const m = /^\s*(?:❯\s*)?(\d)\.\s+(.*)$/.exec(line);
    if (m && m[2]!.startsWith(`${label} ×`)) return Number(m[1]);
  }
  return null;
}

/**
 * Opens a session of each fake in turn (Gluon started with all of them on PATH: `gluon(…, agents)`),
 * going home between them; the last one stays shown. A fake the first proposal doesn't offer is
 * reached by `keep talking` (the demo's cheaper proposal).
 */
export async function openSessions(app: App, fakes: readonly FakeAgent[], task = "session"): Promise<void> {
  for (const [i, fake] of fakes.entries()) {
    if (i > 0) await home(app);
    await toChoice(app, `${task} ${i + 1}`);
    let option = optionOf(app, fake);
    if (option === null) {
      // `keep talking` with a reply naming the agent: the demo routes again, pinned to it.
      await app.enter(`use ${HARNESS_OF[fake]} please`);
      await app.press(KEYS.enter);
      await app.waitFor((s) => s.includes("cheaper setup") && s.includes("keep talking"), 20_000);
      await app.idle();
      option = optionOf(app, fake);
    }
    if (option === null) throw new Error(`the demo offers no ${fake}; screen:\n${app.screen()}`);
    await app.type(String(option));
    await app.press(KEYS.enter);
    await app.waitFor(inFrame, 20_000);
    await app.waitFor((s) => s.split("\n")[1]?.startsWith(` ${LABEL[fake]} × `) ?? false);
    await app.settle(200);
  }
}
