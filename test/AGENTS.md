# test/ — instructions for coding agents

Unit tests (`*.test.ts(x)`), e2e scenarios (`e2e/`, how-to in `e2e/README.md`), fakes
(`fixtures/`), Docker suite (`docker/`).

- **Never reach the real `claude` / `codex`** or any real installer: use the fakes and
  `fakeInstaller()`; real installers only in a throwaway container. Probes come from
  `GLUON_TEST_PROBES`.
- **`Bun.which` and `Bun.spawn` without `env` see the startup PATH**: spawn `git`/`rg` with
  `env: process.env`.
- **Wait for states, don't sleep**: `press`, `type`, `waitFor`, `exitCode()` handle half-drawn
  frames and slow machines; a late OSC reply: `oscReplied()`. A sleep is only a window in which
  something must *not* happen. CI uses `GLUON_TEST_SLOW` and concurrency 3. Install offers: wait `GUARD_MS` first.
- **No bare millisecond bound**: a deadline a test's own steps must meet is `ms * SLOW` (`test/fixtures/slow.ts`);
  a perception limit belongs in `test/perf/`. Bare bounds were the CI flakes on macOS and Windows.
- **A flaky test is fixed, or quarantined while it's fixed**: `@quarantine BUG-nn until:YYYY-MM-DD` (≤ 30 days;
  `test:health` breaks past it). Never a retry inside a test: CI's `--retry-failed` reports flakes (`qa/logs/flaky.json`).
- **Replays of captured runs price from `test/fixtures/telemetry/prices-at-capture.json`, never the
  seeded tables** (a refresh changes them; `frozenTracker` in `test/fixtures/frozen-prices.ts`;
  BUG-413).
- **Tables are seeded, never fetched**: `test/preload.ts` and the e2e harness copy `test/fixtures/tables/` into the
  run's state dir; the refresh sees a network only through `GLUON_TEST_PRICING`'s loopback server, and a
  `scripts/pricing/*.ts` run takes files, never `--live` (BUG-500, 520).
- **A raw `Bun.spawn` of the app goes through `tracked()` with `baseEnv`** (`test/e2e/harness.ts`): a timeout kills gluon alone and its agent
  outlives the run (BUG-573; the run's sweep: `test/fixtures/run-sweep.ts`).
- **A new test file goes into `test/areas.ts`** (its area's `unit` or `e2e` list; a new `src/` file into an
  area's `src` globs): `test/areas.test.ts` fails otherwise, and `regression --area/--changed` can't see it.
- **`@full` in a title leaves a test out of `bun run regression`** (`regression:full` and CI run it):
  for a test slower than ~3 s (the meter's list at the end of a run; e2e measured with its 4 apps at once); keep it off a `BUG-nn` test whose only check is cheap.
- **Windows tests**: PATH joined by `path.delimiter`; fakes are compiled `<name>.exe`;
  `SYSTEM_ENV` passed on; symlink cases gated by `canSymlink`; privacy via `isPrivate` (SDDL by
  SID, never icacls' listing); timeouts × `SLOW`; `writeFileSync` when the next line reads the
  file. ConPTY holds a lone Esc (the harness sends win32-input-mode Esc) and drops OSC 11 replies
  (light theme is manual: `windows-manual-qa.md`).
- **Windows traps** (found by `bun run test:windows`): `test.failing` has no `.skipIf` (use
  `(WIN ? test.skip : test.failing)`); `Bun.sleep(0)` is a 15 ms timer and an await that only an
  `AbortSignal.timeout` can end spins forever (keep a ref'd `setInterval`); ConPTY reports full-width
  rows as wrapped and keeps focus reports on (`gluon-invariants.ts`); a `finally` that removes a state
  directory an app still holds gets EBUSY (`cleanDir`); no `mkdir`/`sh`/`ps` spawns, no `/dev/null`
  (`BUN_FLAGS`); deadlines a test's own steps must meet scale with `SLOW`; a runner's temp dir is 8.3 (`RUNNER~1`): `realpathSync`
  keeps it, git names it long, so `test/preload.ts` uses `.native` (QA-win-04: ~30 `windows-latest` git failures).
- **The "real Windows" test in `windows.test.ts` proves Bun's shim quoting** — if it fails, Bun
  changed.
- **Don't assume the host arch** (macOS runners are arm64): pass it (`nativeExe`'s `arch`).
- **A `GLUON_TEST_NO_PTY` scenario that types for the agent skips on macOS** (`MAC_STEALS`, `test/e2e/harness.ts`): Bun's
  stale stdin reader took the line (#29). BUG-614 ends it (`inTerminal`), unverified on macOS until its test in `test/return.test.ts`
  passes on CI; `GLUON_QA_MAC_NOPTY=1` (in the CI regression job's env, on a branch) runs them, and when they pass
  `MAC_STEALS` goes. F10, F13, F17, F19, BUG-290 and the analytics one skip on Windows too (`|| WIN`: output stops after the agent's first prompt; cause not established).
- **`path.win32` sandbox cases run on Linux.**
- **`install-ps1.ps1`** runs on Windows CI or by hand; never `-AddToPath`.

## Keeping this file fresh

Follow "Keeping AGENTS.md files fresh" in the root `AGENTS.md`. In short: update it in the change
that makes a line wrong; delete what stops being true or a test now enforces; add only what an
agent would get wrong; every name must exist; ≤ 70 lines, overflow to `docs/`.
