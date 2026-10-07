/**
 * The launch's first line into a real pseudo-terminal (`spawnInPty`) with the fake Codex TUI (`FAKE_TUI`, `test/fixtures/fake-tui.ts`):
 * the text, then after a pause its own write, the Enter; the fake leaves them as it read them in `FAKE_INPUT_LOG`, chunk by chunk.
 * The unit cases on a fake process: `test/pty-session.test.ts`; the frame end to end: `test/e2e/launch-line.e2e.test.ts`.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffDefaults, handoffFor } from "../src/handoff.ts";
import { AgentSession } from "../src/pty/session.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-first-line-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const SLOW = process.env.GLUON_TEST_SLOW ? 3 : 1;

const LINE = "/plan Read the session brief in /tmp/brief.md and start.";
const hasPty = typeof (Bun as { Terminal?: unknown }).Terminal === "function";

/** The chunks the fake read (after its pid line), un-escaped as `hexEscape` wrote them. */
const chunks = (log: string) =>
  (existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(1) : [])
    .filter(Boolean)
    .map((l) => l.slice(l.indexOf(" ") + 1).replace(/\\x([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));

async function until(ok: () => boolean, ms = 15_000 * SLOW) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(20);
  expect(ok()).toBe(true);
}

test.skipIf(!hasPty)("the first line reaches a Codex-shaped TUI as the text, then, apart, its Enter: it runs, the agent shows Plan mode, and nobody is told anything", async () => {
  const log = join(TMP, "input.log");
  const s = new AgentSession({
    argv: [process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/fake-tui.ts")],
    env: { ...process.env, FAKE_AGENT_NAME: "codex", FAKE_INPUT_LOG: log, TERM: "xterm-256color" },
    harness: "codex",
    settings: handoffFor(handoffDefaults(), "codex"),
    cols: 100,
    rows: 30,
    firstLine: LINE,
    screen: { colours: { bg: [12, 12, 12] as const } },
  });
  const notes: string[] = [];
  s.onNote((n) => notes.push(n));
  try {
    await until(() => Array.from({ length: s.screen.rows }, (_, y) => s.screen.line(y).text).some((t) => t.includes(`GOT <${LINE}>`)));
    // The fake read the text and the Enter in chunks of their own, the text first and no byte after.
    expect(chunks(log)).toEqual([LINE, "\r"]);
    // Plan mode's footer shows (the fake draws it after /plan), so the check passes silently.
    await Bun.sleep(300);
    expect(notes).toEqual([]);
  } finally {
    await s.end(200);
    s.dispose();
  }
});
