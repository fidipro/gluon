/**
 * A stand-in for `gluon signal <event> [id]` in the e2e tests (a fake agent's `FAKE_HOOK`):
 * writes one event into `$GLUON_EVENTS` as `writeEvent` does. Nothing outside a UI launch.
 * `compact <id> --wait [ms]`: then waits for Gluon's answer as a waiting `PreCompact` hook does
 * (`waitAnswer`; none when the events dir is gone), prints `ANSWER yes|no|none` (also appended to `$FAKE_ANSWER_LOG`) and exits 2 on
 * yes (the compaction is blocked). `status <state>`: a status event (`{"state":"<state>"}`), as a
 * harness's status hook sends (more words after the state are its activity, a tool line); `figures cost=<usd> tokens=<n> window=<n>`: one with cost and
 * context figures, as OpenCode's plugin sends; `step <model> <input> <output> [cost]`: one with a
 * single OpenCode step's counts (`steps`, priced by Gluon); `compacting`: a status with `compacting: true`; `totals <input> <output> [model]`: Antigravity's status line.
 */
import { appendFileSync } from "node:fs";
import { waitAnswer, writeEvent, type AgentState, type EventName } from "../../src/events.ts";

const dir = process.env.GLUON_EVENTS;
const [name, id, wait, ms] = process.argv.slice(2);
// `status working Editing a.ts`: with the activity (a tool line) the harness's hook reports.
if (dir && name === "status") writeEvent(dir, { name: "status", status: { state: id as AgentState, ...(process.argv[4] ? { activity: process.argv.slice(4).join(" ") } : {}) } });
// `figures cost=0.5 tokens=1000 window=200000`: a status with the harness's own figures (as OpenCode's plugin sends).
else if (dir && name === "figures") {
  const kv = Object.fromEntries(process.argv.slice(3).map((a) => a.split("=")).map(([k, v]) => [k, Number(v)]));
  writeEvent(dir, { name: "status", status: { ...(kv.cost !== undefined ? { costUsd: kv.cost } : {}), ...(kv.tokens !== undefined ? { contextTokens: kv.tokens } : {}), ...(kv.window !== undefined ? { contextWindow: kv.window } : {}) } });
}
// `compacting`: a status with `compacting: true`, as Codex's PreCompact hook sends it.
else if (dir && name === "compacting") writeEvent(dir, { name: "status", status: { compacting: true } });
// `totals <input> <output> [model]`: Antigravity's status line (the conversation's token totals: the input is its size, the context).
else if (dir && name === "totals") {
  const [, input = "0", output = "0", model] = process.argv.slice(2);
  writeEvent(dir, { name: "status", status: { totals: { input: Number(input), output: Number(output) }, ...(model ? { model } : {}) } });
}
// `step openrouter/deepseek/deepseek-v4-flash 1000000 100000 0.5`: one step record (as OpenCode's plugin sends them).
else if (dir && name === "step") {
  const [, model = "", input = "0", output = "0", cost] = process.argv.slice(2);
  writeEvent(dir, { name: "status", status: { steps: [{ n: Date.now() % 1e9, model, input: Number(input), output: Number(output), reasoning: 0, cacheRead: 0, cacheWrite: 0, ...(cost !== undefined ? { cost: Number(cost) } : {}) }] } });
} else if (dir && name) writeEvent(dir, { name: name as EventName, ...(id ? { id } : {}) });
if (dir && id && wait === "--wait") {
  const answer = await waitAnswer(dir, id, Number(ms || 10_000));
  const word = answer === null ? "none" : answer ? "yes" : "no";
  console.log(`ANSWER ${word}`);
  if (process.env.FAKE_ANSWER_LOG) appendFileSync(process.env.FAKE_ANSWER_LOG, `${word}\n`);
  process.exit(answer ? 2 : 0);
}
