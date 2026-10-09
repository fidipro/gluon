/**
 * Local analytics (`src/analytics.ts`): a launched session is one row in `<state dir>/gluon/analytics.db`, read here directly
 * (read-only), with the fakes as agents. The state directory is the test's own (`XDG_STATE_HOME`, `LOCALAPPDATA`).
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FLUSH_MS, type SessionRow } from "../../src/analytics.ts";
import { KEYS } from "./actions.ts";
import { cleanDir, freshConfig, repo, WIN } from "./fixtures.ts";
import { ASK_YAML, gluon, home, launch, launchAs, say } from "./gluon-kit.ts";
import { baseEnv, cli, GLUON, HOME_VIEW, MAC_STEALS, SLOW, start, stopAll, toLaunch, tracked, type App } from "./harness.ts";
import { EVENT_HOOK } from "./gluon-kit.ts";

setDefaultTimeout(90_000 * SLOW);
afterAll(stopAll);

/** A state directory of the test's own, removed when `f` is done. */
async function withState<T>(f: (state: string, env: Record<string, string>) => Promise<T>): Promise<T> {
  const state = mkdtempSync(join(tmpdir(), "gluon-analytics-"));
  try {
    return await f(state, { XDG_STATE_HOME: state, LOCALAPPDATA: state });
  } finally {
    cleanDir(state);
  }
}

const dbPath = (state: string) => join(state, "gluon", "analytics.db");
/** The rows now (the file is written by another process). */
function rows(state: string): SessionRow[] {
  if (!existsSync(dbPath(state))) return [];
  const db = new Database(dbPath(state), { readonly: true });
  try {
    return db.query("SELECT * FROM sessions ORDER BY started_at").all() as SessionRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}
/** Polls until the rows satisfy `ok` (the recorder is another process). */
async function waitRows(state: string, ok: (r: SessionRow[]) => boolean, ms = 10_000 * SLOW): Promise<SessionRow[]> {
  for (const end = Date.now() + ms; !ok(rows(state)); await Bun.sleep(50)) if (Date.now() > end) throw new Error(`timed out waiting for the analytics rows: ${JSON.stringify(rows(state))}`);
  return rows(state);
}
/** Quits from the home view: Ctrl+C twice, yes to ending the sessions. */
async function quit(app: App) {
  await app.press(KEYS.ctrlC, KEYS.ctrlC);
  await app.waitFor("quit and end");
  await app.press(KEYS.enter);
  return app.exitCode();
}

describe("local analytics", () => {
  test("a launched session is one row from the start (agent, spec, the id Gluon minted, routing); when the agent exits it has its end and exit code @full", async () => {
    await withState(async (state, env) => {
      const app = await gluon(100, 30, { ...env, FAKE_EXIT: "3" });
      await launch(app, "alpha task");
      const [row, ...more] = await waitRows(state, (r) => r.length === 1);
      expect(more).toEqual([]);
      expect(row).toMatchObject({
        kind: "new",
        name: "Gluon-alpha-task",
        harness: "claude-code",
        model: "sonnet",
        effort: "high",
        mode: "build",
        conn: "plan",
        agent_session_source: "minted",
        cwd: repo.tiny(),
        ended_at: null,
        exit_code: null,
        end_reason: null,
      });
      expect(row!.spec.length).toBeGreaterThan(10);
      expect(row!.agent_session_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(row!.routing_types!)).toEqual(expect.arrayContaining([expect.any(String)]));
      expect(JSON.parse(row!.routing_why!).length).toBeGreaterThan(0);
      expect(row!.worktree_path).toBeNull();
      expect(row!.started_at).toBeGreaterThan(0);
      // The agent was started under that very id.
      expect(app.agentLog()).toContain(row!.agent_session_id!);
      await app.type("/exit");
      await app.press(KEYS.enter);
      await app.waitFor(HOME_VIEW);
      const [ended] = await waitRows(state, (r) => r[0]?.ended_at != null);
      expect(ended).toMatchObject({ id: row!.id, exit_code: 3, end_reason: "exit" });
      expect(ended!.duration_ms).toBe(ended!.ended_at! - ended!.started_at);
      await quit(app).catch(() => {});
    });
  });

  test("`gluon resume` records its sessions as resume rows with the saved agent session id, beside the first run's new row @full", async () => {
    await withState(async (state, env) => {
      const cfg = freshConfig("analytics-resume", ASK_YAML);
      const first = await gluon(100, 30, { ...env, GLUON_CONFIG: cfg });
      await launch(first, "alpha task");
      const [before] = await waitRows(state, (r) => r.length === 1);
      await home(first);
      expect(await quit(first)).toBe(130);
      const id = readdirSync(join(dirname(cfg), "workspaces")).find((f) => f.endsWith(".json"))!.replace(/\.json$/, "");
      const app = await start({ cwd: repo.tiny(), cols: 110, rows: 30, args: ["resume", id], agents: ["claude"], env: { ...env, GLUON_CONFIG: cfg, FAKE_TUI: "1", FAKE_EVENT_HOOK: EVENT_HOOK } });
      const all = await waitRows(state, (r) => r.length === 2);
      expect(all.map((r) => r.kind)).toEqual(["new", "resume"]);
      expect(all[1]).toMatchObject({ harness: "claude-code", model: "sonnet", agent_session_id: before!.agent_session_id, agent_session_source: "minted", workspace_id: id, ended_at: null });
      expect(all[1]!.id).not.toBe(before!.id);
      app.kill();
    });
  });

  test("Codex's session id arrives by hook and is recorded as captured; quitting Gluon ends the open session as quit @full", async () => {
    await withState(async (state, env) => {
      const app = await launchAs("codex", { env });
      await say(app, "!event session 019a1b2c-d3e4-test", "EVENT session");
      await home(app);
      expect(await quit(app)).toBe(130);
      const [row] = await waitRows(state, (r) => r[0]?.ended_at != null);
      expect(row).toMatchObject({ harness: "codex", agent_session_id: "019a1b2c-d3e4-test", agent_session_source: "captured", end_reason: "quit", exit_code: expect.anything() });
      expect(rows(state)).toHaveLength(1);
    });
  });

  test.skipIf(MAC_STEALS || WIN)("without a pseudo-terminal (the agent has the terminal, one at a time) the row is written at the start and ended with the agent's exit code @full", async () => {
    await withState(async (state, env) => {
      const app = await start({ cwd: repo.tiny(), rows: 60, env: { ...env, GLUON_CONFIG: freshConfig("analytics-direct", "handoff:\n  on_clear: stay\n"), GLUON_TEST_NO_PTY: "1", FAKE_EXIT: "3" } });
      await toLaunch(app);
      const [row] = await waitRows(state, (r) => r.length === 1);
      expect(row).toMatchObject({ kind: "new", harness: "claude-code", model: "sonnet", ended_at: null });
      expect(row!.agent_session_id).toMatch(/^[0-9a-f-]{36}$/);
      await app.press(KEYS.enter);
      const [ended] = await waitRows(state, (r) => r[0]?.ended_at != null);
      expect(ended).toMatchObject({ id: row!.id, exit_code: 3, end_reason: "exit", cost_usd: null });
      await app.press(KEYS.ctrlC, KEYS.ctrlC);
      expect(await app.exitCode()).toBe(130);
    });
  });

  test("`analytics: off` records nothing: no database, however many sessions run @full", async () => {
    await withState(async (state, env) => {
      const app = await gluon(100, 30, { ...env, FAKE_EXIT: "0" }, `${ASK_YAML}analytics: off\n`);
      await launch(app, "alpha task");
      await app.type("/exit");
      await app.press(KEYS.enter);
      await app.waitFor(HOME_VIEW);
      await Bun.sleep(300 * SLOW);
      expect(existsSync(dbPath(state))).toBe(false);
      expect(existsSync(`${dbPath(state)}-wal`)).toBe(false);
    });
  });

  test("a one-shot --launch records a launch row with the agent's exit code; its --dry-run records nothing", async () => {
    await withState(async (state, env) => {
      const dry = await cli(["--launch", "claude-code", "--model", "sonnet", "--dry-run", "fix it"], { env, agents: ["claude"], cwd: repo.tiny() });
      expect(dry.code).toBe(0);
      expect(existsSync(dbPath(state))).toBe(false);
      const r = await cli(["--launch", "claude-code", "--model", "sonnet", "--effort", "high", "fix it"], { env: { ...env, FAKE_EXIT: "4" }, agents: ["claude"], cwd: repo.tiny() });
      expect(r.code).toBe(4);
      const [row, ...more] = rows(state);
      expect(more).toEqual([]);
      expect(row).toMatchObject({ kind: "launch", harness: "claude-code", model: "sonnet", effort: "high", mode: "build", spec: "fix it", exit_code: 4, end_reason: "exit", cwd: repo.tiny() });
      expect(row!.ended_at).not.toBeNull();
    });
  });

  test("BUG-567/analytics: a long --launch session keeps its row's heartbeat (updated_at moves), so `gluon stats` does not call it unfinished while it runs @full", async () => {
    await withState(async (state, env) => {
      // FAKE_HANG: the fake agent stays up until it is killed.
      // Tracked: a failed wait must not leave gluon's agent running (BUG-573).
      const proc = tracked(
        Bun.spawn([...GLUON, "--launch", "claude-code", "--model", "sonnet", "fix it"], {
          cwd: repo.tiny(),
          env: baseEnv(["claude"], { ...env, FAKE_HANG: "1" }),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      try {
        const [first] = await waitRows(state, (r) => r.length === 1, 15_000 * SLOW);
        expect(first!.ended_at).toBeNull();
        // A running Gluon touches its open rows at least every FLUSH_MS (plus the timer's step).
        let beat = first!.updated_at;
        for (const end = Date.now() + (FLUSH_MS + 20_000) * SLOW; beat - first!.started_at < FLUSH_MS - 1_000 && Date.now() < end; await Bun.sleep(500)) beat = rows(state)[0]!.updated_at;
        expect(beat - first!.started_at).toBeGreaterThanOrEqual(FLUSH_MS - 1_000);
      } finally {
        proc.dispose(); // its whole tree: the agent as well as gluon
        await proc.exited;
      }
    });
  });

  test("BUG-569/analytics: a crash of Gluon ends the open sessions as quit instead of leaving them running @full", async () => {
    await withState(async (state, env) => {
      const app = await gluon(100, 30, { ...env, GLUON_TEST_PTY_FAIL: "1" });
      await launch(app, "alpha task");
      await waitRows(state, (r) => r.length === 1);
      app.write("%");
      expect(await app.exitCode()).toBe(1);
      const [row] = await waitRows(state, (r) => r[0]?.ended_at != null);
      expect(row).toMatchObject({ end_reason: "quit", exit_code: null });
    });
  });

  test("a --launch with analytics off records nothing", async () => {
    await withState(async (state, env) => {
      const r = await cli(["--launch", "claude-code", "--model", "sonnet", "fix it"], { env: { ...env, FAKE_EXIT: "0", GLUON_CONFIG: freshConfig("analytics-off-launch", "analytics: off\n") }, agents: ["claude"], cwd: repo.tiny() });
      expect(r.code).toBe(0);
      expect(existsSync(dbPath(state))).toBe(false);
    });
  });
});
