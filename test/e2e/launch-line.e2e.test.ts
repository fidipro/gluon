/**
 * Launch modes, the typed first line end to end: Codex and Grok Build have no flag for Plan mode (Grok's
 * `--permission-mode plan` does nothing in its TUI), so Gluon types
 * `/plan Read the session brief in <file> and start.` into its composer (`AgentSession`'s first line,
 * `src/pty/session.ts`), the text and then, apart, its Enter. The fake Codex TUI (`FAKE_TUI`) logs
 * what it read, chunk by chunk (`FAKE_INPUT_LOG`).
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { KEYS } from "./actions.ts";
import { ASK_YAML, gluon, launch, openSessions, toChoice } from "./gluon-kit.ts";
import { SLOW, stopAll } from "./harness.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

test("BUG-408/launch-modes: Codex started in Plan mode at 100 columns (the line wraps in its composer) gets `/plan Read the session brief in <file> and start.` typed, then its Enter apart; the file holds the spec, and the spec is not in argv @full", async () => {
  // 100 columns: the line (a temp path in it) wraps in the composer.
  const app = await gluon(100, 30, {}, undefined, ["codex"]);
  // The demo brain proposes build for this task; ctrl+t twice: explore, then plan.
  await launch(app, "fix the thing", [KEYS.ctrlT, KEYS.ctrlT]);
  // The fake echoes a run line as `GOT <line>`; the line is long, so read what it was given instead.
  const end = performance.now() + 20_000 * SLOW;
  const chunks = () =>
    readFileSync(app.inputLogPath, "utf8")
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((l) => l.slice(l.indexOf(" ") + 1));
  while (chunks().length < 2 && performance.now() < end) await Bun.sleep(50);
  const [text, enter] = chunks();
  expect(text).toMatch(/^\/plan Read the session brief in \S+ and start\.$/);
  expect(enter).toBe("\\x0d"); // hex-escaped, as the fake logs it
  const file = /in (\S+) and start/.exec(text!)![1]!.replaceAll("\\\\", "\\");
  expect(existsSync(file)).toBe(true);
  const spec = readFileSync(file, "utf8").trim();
  expect(spec.length).toBeGreaterThan(0);
  expect(chunks()).toHaveLength(2);
  // Codex's argv has no spec (the brief is in the file).
  expect(app.agentLog()).not.toContain(spec.slice(0, 40));
});

test("BUG-411/launch-modes: Grok Build started in Plan mode gets the same line typed in its composer box, then its Enter apart; its border shows ` · plan` and no note is posted @full", async () => {
  const app = await gluon(100, 30, {}, undefined, ["grok"]);
  await launch(app, "fix the thing", [KEYS.ctrlT, KEYS.ctrlT]);
  const end = performance.now() + 20_000 * SLOW;
  const chunks = () =>
    readFileSync(app.inputLogPath, "utf8")
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((l) => l.slice(l.indexOf(" ") + 1));
  while (chunks().length < 2 && performance.now() < end) await Bun.sleep(50);
  const [text, enter] = chunks();
  expect(text).toMatch(/^\/plan Read the session brief in \S+ and start\.$/);
  expect(enter).toBe("\\x0d");
  await app.waitFor("· plan");
  await app.settle(1500);
  expect(chunks()).toHaveLength(2);
  expect(app.screen()).not.toContain("couldn't type");
  expect(app.screen()).not.toContain("may not be in Plan mode");
  // Grok's argv has no spec and no --permission-mode (the brief is in the file).
  expect(app.agentLog()).not.toContain("--permission-mode");
});

/** Kimi Code on OpenRouter (the demo brain routes to the only connected harness: K3 for its first proposal, a step up from standard): a key from the environment, no network. */
const KIMI = { yaml: `${ASK_YAML}connections:\n  kimi-code: { auth: api, provider: openrouter }\n`, env: { OPENROUTER_API_KEY: "sk-or-v1-test-0123456789abcdef" } };

/** What the fake TUI read, chunk by chunk (`FAKE_INPUT_LOG`, hex-escaped), once `n` chunks came. */
async function chunksOf(app: Awaited<ReturnType<typeof gluon>>, n: number): Promise<string[]> {
  const end = performance.now() + 20_000 * SLOW;
  const chunks = () =>
    readFileSync(app.inputLogPath, "utf8")
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((l) => l.slice(l.indexOf(" ") + 1));
  while (chunks().length < n && performance.now() < end) await Bun.sleep(50);
  return chunks();
}

test("Kimi Code (no prompt in argv): every launch types the brief line alone into its composer box, then its Enter apart; the file holds the spec, which is in no argument; the box answers with it @full", async () => {
  const app = await gluon(100, 30, KIMI.env, KIMI.yaml, ["kimi"]);
  await launch(app, "fix the thing");
  const [text, enter] = await chunksOf(app, 2);
  // Plain words from the first character: no `/plan` (or any command) in front, as the other typed launches have.
  expect(text).toMatch(/^Read the session brief in \S+ and start\.$/);
  expect(enter).toBe("\\x0d");
  const file = /in (\S+) and start/.exec(text!)![1]!.replaceAll("\\\\", "\\");
  expect(existsSync(file)).toBe(true);
  const spec = readFileSync(file, "utf8").trim();
  expect(spec.length).toBeGreaterThan(0);
  expect((await chunksOf(app, 3)).length).toBe(2);
  expect(app.agentLog()).not.toContain(spec.slice(0, 40));
  expect(app.agentLog()).toContain("ENV KIMI_CODE_NO_AUTO_UPDATE=1");
  await app.waitFor((s) => s.replace(/[│\s]+/g, "").includes("GOT<Readthesessionbriefin"));
  expect(app.screen()).not.toContain("couldn't type");
});

test("Kimi Code: plan is `--plan` (before the typed brief); BUG-432/explore (ctrl+t) is refused with its reason and nothing starts, no agent file in any launch @full", async () => {
  const plan = await gluon(100, 30, KIMI.env, KIMI.yaml, ["kimi"]);
  // Kimi Code is the highlighted agent: ctrl+t skips explore (BUG-672), so one press is plan.
  await launch(plan, "fix the thing", [KEYS.ctrlT]);
  await chunksOf(plan, 2);
  expect(plan.agentLog()).toContain("<--plan>");
  expect(plan.agentLog()).not.toContain("--agent-file");
  // ctrl+t never lands on explore with Kimi Code highlighted (BUG-672): explore is picked on Claude Code (option 1), then Kimi Code (option 2) is chosen.
  const explore = await gluon(100, 30, KIMI.env, KIMI.yaml, ["claude", "kimi"]);
  await toChoice(explore, "fix the thing");
  await explore.press(KEYS.ctrlT);
  await explore.waitFor("· explore");
  await explore.press(KEYS.down);
  await explore.press(KEYS.enter);
  // The reason, not "can't start with this model and effort": the agent stays unstarted and the choice stays open.
  await explore.waitFor((s) => s.replace(/[│\s]+/g, "").includes("KimiCodecan'tstartinexploremode"));
  expect(explore.agentLog()).not.toContain("ENV KIMI_MODEL_NAME");
  expect(explore.agentLog()).not.toContain("--agent-file");
});

test("BUG-462/kimi-code: with Claude Code also connected, a reply naming kimi-code pins it: the brain's route offers it and the fake kimi starts on OpenRouter @full", async () => {
  const app = await gluon(100, 30, KIMI.env, KIMI.yaml, ["claude", "kimi"]);
  await openSessions(app, ["kimi"], "pin kimi");
  await chunksOf(app, 2);
  expect(app.agentLog()).toContain("ENV KIMI_MODEL_NAME=moonshotai/kimi-");
});
