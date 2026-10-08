# Regression suite

Run it after every change, before committing:

```bash
bun run regression        # the fast tier: typecheck + unit + e2e without the tests titled `@full` (~3 min)
bun run regression:full   # everything: typecheck + all unit + all e2e (~14 min)
bun run test:area home-ui # one area's unit + e2e tests (areas: test/areas.ts); `bun run regression --changed` picks them from your diff
bun run test:unit         # just the unit tests (~1.5 min)
bun test test/e2e/stages  # one scenario file
bun test -t "BUG-01"      # scenarios for one bug
```

A test titled with `@full` (`test("F32: … @full", …)`) is left out of `regression`: `-t '^(?!.*@(?:full|quarantine))'`
in its script, no code. So is a flaky one, quarantined: `@quarantine BUG-nn until:YYYY-MM-DD` in its title, at most 30 days,
then fixed or deleted (`bun run test:health` breaks past the date; `regression:full` still runs it). The fast tier keeps the tests under ~3 s (e2e measured with the apps at once), and `BUG-149`, `BUG-160` and the claude monkey; cc's matrix line and the perf smoke are tagged: each ran alone in its file, three of the four apps idle for 13 to 21 s;
anything slower is tagged, a `BUG-nn` one too: its fix is then checked by `regression:full` (run it for a big change)
and CI. `regression:full`, CI and `docker-test` run them.
`scripts/regression.ts` runs both tiers: typecheck, the unit tests in shards (3 in the fast tier, 4 in
the full one, `GLUON_UNIT_SHARDS`; separate processes, `bun test --parallel` can't run Ink's Yoga twice), then
the e2e scenarios (`GLUON_E2E_CONCURRENCY` apps, default `min(4, cores/3, free GB/0.25)`, `scripts/e2e-concurrency.ts`, which `scripts/docker-test.sh` and `scripts/windows-test.ts` use too). The unit files are grouped by the
times the last run measured (`qa/logs/test-times.json`, from Bun's JUnit report; `SECONDS` in `scripts/test-times.ts` when there are none).
Bun runs the e2e files one after the other and the tests of a file concurrently, so a file with fewer tests than apps leaves apps idle (why a lone 20 s test costs 20 s of the run). `--stages typecheck,unit,e2e` runs only some stages and `GLUON_TEST_CASES=<file>` writes every test run (file, title, seconds) as JSON, to count a tier per area.
It ends by printing each stage's wall time, the ten slowest files, the tests over 3 s that lack `@full` (candidates for it), and the
peak memory of its whole process tree (Linux, by stage). `--area a,b`, `--changed [ref]` and `--list` narrow it to
the areas of `test/areas.ts`; a new test file must be listed there (`test/areas.test.ts`). `--retry-failed` (CI) runs a
stage's failed tests once more: passing then, they are flaky, not failures (a warning, and `qa/logs/flaky.json`, which CI
uploads). Tests never retry themselves.

It runs offline and costs nothing: the demo intake agent, fake agent binaries that print what they were
given, and throwaway repos made in a temp dir. The real binaries and your credentials are never
used: PATH and the environment are replaced (HOME, and on Windows USERPROFILE / APPDATA / LOCALAPPDATA, point at a temp dir), Bun's `.env` and the cwd's `bunfig.toml` are off (`--no-env-file --config=/dev/null`, from the entry's shebang; on Windows `--config=scripts/empty-bunfig.toml`),
and `GLUON_TEST_PROBES` points API
probes at a JSON file of answers (`probes()` in `fixtures.ts`: `{"bedrock/<model>": "access
denied", "openai-api/*": true}`; unlisted models answer ok) instead of the network. An OpenRouter session reads its key's usage only where a test names a server of its own: `GLUON_TEST_OPENROUTER` is a JSON file `{ "base": "http://127.0.0.1:<port>/api/v1", "timings": { … } }` (`test/e2e/openrouter-billed.e2e.test.ts`; compiled out of release builds). Prices and windows are the same: Gluon ships no table and refreshes its own in the background, so the harness seeds each app's state directory with the frozen `test/fixtures/tables/` (`test/fixtures/seed-tables.ts`; `GLUON_TEST_EMPTY_TABLES` in a test's `env` leaves the store empty: a first run), and the refresh reaches no network unless `GLUON_TEST_PRICING` is a JSON file `{ "base": "http://127.0.0.1:<port>" }` naming a local server (`servePricing`, `test/fixtures/pricing-sources.ts`; `test/e2e/tables-refresh.e2e.test.ts`; compiled out of release builds). The fake `claude` (POSIX) carries Claude Code's catalog and price function as an unrun here-document, because Claude's table is built from the installed binary alone (no network source): a refresh that reads it finds the fixture's catalog.

## The fakes

On POSIX the fakes are bash scripts (`FAKE` in `fixtures.ts`). Windows has no bash: there
`test/fixtures/fake-agent.ts` is compiled once (cached in the temp dir, keyed by its sources and
Bun's version; `test/preload.ts` builds it before any test) and linked as `claude.exe`, `codex.exe`,
…; it knows which agent it is from its own name. `test/fakes.test.ts` runs both on every invocation
the suite uses and checks they agree. On Windows `STTY:` comes from the console input mode.

`fakeAgents([...])` puts fake `claude`, `codex`, `agy`, `grok` and `opencode` on PATH. Launched
normally, each prints its argv, tty state and environment (which keys are set; the base URLs'
values; `TAIL <VAR>=<last 4 chars>` for the Anthropic, OpenAI and xAI keys, to tell which key
an agent got without printing it), reads a line and exits `$FAKE_EXIT` (default 7); it also says whether `GLUON_EVENTS` is set and prints `GLUON_HANDOFF`. A typed `/clear` runs `$FAKE_HOOK` (as a harness runs its hook; `test/fixtures/write-event.ts` stands in for `gluon signal`) and asks again; `FAKE_HANG` keeps it alive after its line until killed (`ignore-term`: SIGTERM does nothing), `FAKE_KILL_LOG` records a SIGTERM. `test/fixtures/write-event.ts compact <id> --wait` stands in for a waiting `PreCompact` hook (prints and logs to `FAKE_ANSWER_LOG` the answer it got). `FAKE_TUI=1` gives the agent a raw-mode TUI instead of the line — an input line (←/→ move its cursor, Ctrl+U clears it), a slash menu, Tab completion, `/clear`, `/compact` (none in `agy`: `No matches`, as Antigravity) and an auto-compaction (`!compact`) that run `$FAKE_HOOK` — for the question and home-key scenarios. Each fake draws its harness's prompt as the recorded screens (`test/fixtures/screens/`) show it — `claude` Claude Code's, `codex` Codex's composer, `opencode` OpenCode's panel (its Tab runs the highlighted item), `agy` Antigravity's box (its Tab completes it), `grok` Grok Build's rounded composer box (its Tab completes; `/plan` puts ` · plan` in the box's border) — and `test/fakes-readers.test.ts` checks each harness's reader reads its fake; `FAKE_KITTY`, `FAKE_ALT`, `FAKE_PID_FILE`, `FAKE_CLEAR_DELAY_MS` and `FAKE_RESIZE_DELAY_MS` change it, and `!` commands drive Gluon's scenarios (mouse, focus, kitty and its query `!kq`, scrollback, `!menu` for a slash menu nobody typed a `/` for, events through `$FAKE_EVENT_HOOK`, an OpenTelemetry export; all described atop `test/fixtures/fake-tui.ts`). `FAKE_REFUSE_RESUME=<code>` makes a fake that is given a resume (`--resume=`, `--session=`, `codex resume`) exit with that code at once, as a harness refuses an unknown session id. `FAKE_INPUT_LOG` records every chunk each fake's TUI read, byte for byte (`app.inputLogs()` per agent, `app.inputLog()` all of it; the harness sets the file per app): what Gluon wrote into the agent. Every fake also appends what it was given (argv, tty, environment) to `FAKE_ARGV_LOG`: Gluon's frame keeps no scrollback, so a scenario reads it there (`app.agentLog()`; the harness sets the file per app). `--version` prints a version
(`FAKE_VERSION` overrides it). Sign-in
states come from environment variables; a login creates the state file:

| Fake | Status / login | Variables |
|---|---|---|
| `claude` | `auth status --json`, `auth login`, `-p` (the ping) | `FAKE_CLAUDE_LOGGED_OUT` + `FAKE_CLAUDE_STATE`; `FAKE_PING_FAIL` (fails with a token-like message); `FAKE_CLAUDE_BAD_MODELS` (models `-p` rejects); `FAKE_CLAUDE_LOG` (argv of `-p` calls); `FAKE_CLAUDE_STATUS_FAIL` (`auth status` fails without an answer) |
| `codex` | `login status`, `login`, `app-server`, `debug models` and `features list` (run `test/fixtures/fake-codex-app-server.ts`) | `FAKE_CODEX_LOGGED_OUT` + `FAKE_CODEX_STATE`; `FAKE_CODEX_METHOD=api-key`; `FAKE_CODEX_LOGIN_HANG` (`login status` never answers); `FAKE_CODEX_SCRIPT` / `FAKE_CODEX_LOG` (the app-server's turns and log); `FAKE_CODEX_FEATURES_EXTRA` / `FAKE_CODEX_CATALOG_EXTRA` (a feature row / catalog fields a newer codex might add) |
| `agy` | `models` (the status check), plain `agy` (its sign-in) | `FAKE_AGY_LOGGED_OUT` + `FAKE_AGY_STATE`; `FAKE_AGY_MODELS` (families listed) |
| `grok` | `models` (the status check), `login` | `FAKE_GROK_LOGGED_OUT` + `FAKE_GROK_STATE`; `FAKE_GROK_MODELS` (default: only `grok-4.7`) |
| `opencode` | `auth list` (a JSON list), `auth login`, `models` | `FAKE_OPENCODE_CREDENTIALS` (logins listed) |

## How it works

`harness.ts` starts `gluon --demo` in a real pseudo-terminal (Bun's `terminal` spawn option)
and feeds its output to a headless xterm (`@xterm/headless`), so a scenario sees the same screen
a developer would, colours included:

```ts
const app = await start({ cwd: repo.tiny(), cols: 80, rows: 24 });   // waits for Gluon's home view
await app.type("fix the add bug");      // one key at a time
await app.press(KEY.enter);
await app.waitFor(QUESTION);
expect(app.screen()).toContain("❯ 1. Add a regression test");
app.mark(); /* … */ expect(app.clears()).toEqual({ screen: 0, scrollback: 0 });
```

Also: `write()` (bytes in one read, like batched input), `writeWhen(text, keys)` (keys written
the moment output containing `text` arrives, before the frame is drawn: a key pressed as a menu
appears), `paste()` (bracketed), `history()` (scrollback included; while Gluon is on the
alternate screen, the normal screen's then what the alternate one shows; `{ normal: true }`: the
normal screen's only), `agentLog()` (what the fakes were given), `bg(x, y)` / `fg(x, y)` (a cell's
colours), `resize()`, `exitCode()`, `pid` and
`signal()` (a `kill` from another terminal), `localFlags` (whether the terminal is back in line
mode), `mark()` / `since()` (the raw bytes since the mark: terminal resets), and `cli()`
for runs without a terminal. `toQuestion()` / `toProposal()` walk the demo to those stages and
`toLaunch()` on to a session in Gluon's frame; `QUESTION` and `HOME_VIEW` match the demo's
question and the home view's composer. The demo runs at a twentieth of its pace
(`GLUON_TEST_DEMO_PACE`, a seam compiled out of release builds): a walk to a session is that much faster.
A test that acts while the intake agent works (`esc to interrupt`) passes `env: FULL_PACE`.
For Gluon, `modes()` (the terminal modes Gluon left on: mouse tracking and encoding, focus,
bracketed paste, kitty flags, the alternate screen, the cursor shown), `kittyDepth()` (kitty
keyboard entries pushed and not popped), `cursor()` and `cells()` (the screen in the recorded
screens' `{ text, runs }` row shape).

The Gluon scenarios build on three modules. `actions.ts` is what a user can do, as data: `KEYS`
(every named key's bytes, `KEY` is the same table), `Action` (a key, text, a paste, a mouse
gesture, a resize, focus, a signal, a late terminal reply, a wait), `bytesOf()` in each mouse
encoding (X10, UTF-8, SGR, urxvt, SGR pixels) and `apply(app, action)`, which does it and waits
for the answer. `gluon-kit.ts` starts Gluon on the demo with the TUI fakes (`gluon()`) and walks
it: `toChoice()`, `launch()`, `say()`, `home()`; `launchAs("agy")` starts it with that fake alone
on PATH and opens its session; `openSessions()` opens one session per fake given (the demo offers
the recommended agent and two others; the rest come with `keep talking`). `gluon-invariants.ts`
checks what must hold after any step (`checkInvariants()` lists the problems,
`assertInvariants()` throws): the chrome where `layout` puts it and unwrapped, the frame's border
whole, one highlighted tab, the home view rows − 1 tall with no session's modes left on, the
cursor in the interior or on the composer, and optionally the agents' input and the screen
clears.

`fixtures.ts` builds the repos (`tiny`, `emptyGit`, `detached`, `noGit`, `withSpace`, `hazards`),
config files (`freshConfig()` gives a test its own config directory), fake agents and probe
answers. `noDemo` starts gluon without `--demo`, still offline, for onboarding, `connect`,
`brain` and `doctor`. `kitty: true` makes the "terminal" answer Gluon's startup probe as a
kitty-keyboard terminal would. `GLUON_TEST_NO_PTY` (compiled out of release builds) runs
Gluon as without a pseudo-terminal: sessions one at a time, with the terminal itself. `osc11: { delayMs, splitMs, light }` answers the background-colour query
late (and split, ESC first; `light`: ESC `\`-terminated, as light terminals answer), as some
terminals do. gluon is started with the Bun flags of its shebang (`BUN_FLAGS`).

### Slow and loaded machines

The suite runs 6 apps at once locally and must also pass on a loaded 2–4 vCPU CI runner, where
every step takes several times longer. The harness never returns a half-drawn screen:

- `press()` waits, after each key, for the app to answer it (output that came after the key,
  bounded: some keys draw nothing) and for the screen to be drawn (`quiet()`: no output for a
  moment); `type()` sends each character once the last one was answered. A fixed pause isn't
  enough under load: the answer to one key passes for the answer to the next.
- `waitFor()` returns only once the matched screen is drawn and still matches; `start()` waits
  for the home view: the header and the composer (and the first line, where it fits; not when `args` are given: resumed sessions or a task's chat may be up first).
- `exitCode()` resolves once the process's output has all reached the screen (the pty's end of
  file; on Windows closing ConPTY flushes it), so `history()` after it is complete.
- A test's apps end with the test: `test/preload.ts` reroutes the e2e files' `bun:test` import to `test/e2e/scoped-test.ts`, which ends the apps a test
  started, and their agents, when its body returns (`scoped` in `harness.ts`); `stopAll` in `afterAll` is the safety net. An app a test means to keep
  past its own end (none now) would need to be made outside a test body. A raw `Bun.spawn` of the app is wrapped in `tracked(…)` (it and its whole
  tree end with the test, a timeout included: `cli()` does it and kills the tree on `timeoutMs`), and takes `baseEnv`.
  Behind both is the run's sweep (BUG-573): `test/preload.ts` sets `GLUON_TEST_RUN=<pid>:<run dir>`, every process inherits it, and when the
  run ends, or gets SIGINT, SIGTERM or SIGHUP, whatever still carries it is killed; a run killed outright (SIGKILL) is swept by the next
  run's start. Only a process with a marker of this run, or of a run whose process is gone, is ever killed (`test/fixtures/run-sweep.ts`).
  The sweep needs `/proc`: on macOS and Windows only the tracked trees end (a gluon that dies before its agent leaves the agent there).
- Waits, test timeouts and every deadline a test's own steps must meet scale with `SLOW`
  (`test/fixtures/slow.ts`): 3 on Windows, 1 elsewhere, `GLUON_TEST_SLOW` overrides it. Every file's default
  timeout is 5 s × `SLOW` (unit; 30 s at least on Windows) or 20 s × `SLOW` (e2e, visual, perf), set by
  `test/preload.ts` on each file's first line. CI sets it (2; 4 on Windows) and runs the e2e files with
  `bun run test:e2e --max-concurrency=3` (`scripts/docker-test.sh` reads
  `GLUON_E2E_CONCURRENCY`, else `scripts/e2e-concurrency.ts`).

So assert after `press` / `type` / `waitFor`, never after a bare `write()` or `Bun.sleep()`: wait
for what the key should produce (`waitFor`) when it's a batch or a timing case. To check a change
against CI-like load, run the suite in the regression image on two pinned cores:

```bash
docker run --rm --init --network none --cpuset-cpus=2,3 -e GLUON_TEST_SLOW=2 gluon-test-bun-debian \
  bun test --concurrent --max-concurrency=3 test/e2e
```

(`bun run docker-test regression` builds the image. `--cpus=2` is harsher than a real 2-vCPU
machine: Bun still sees every host core and the CPU quota throttles it in bursts.)

Files follow the QA test plan's sections: `startup` (A), `composer` (B), `stages` (C),
`rendering` (E), `handoff` (F: starting agents, their own questions, one at a time without a
pseudo-terminal, `--launch`), `gluon` (the frame, several sessions, the mouse, quitting), `cli` (G), `auth` (I: onboarding, each harness × sign-in, the
menus, the brain order, doctor); the repo tools (H) are in `test/tools.test.ts`, the hard rules
for every vendor in `test/rules.test.ts`, the brain order, the offered-models filter and the
config migration in `test/brain.test.ts`. Brain behaviour (D) needs the real model and isn't
covered here; `bun run test:live` checks the real brains and connections on a budget.

## Gluon's coverage matrix

`test/fixtures/gluon-matrix.ts` lists every Gluon state (home, a session of each fake, the setup
menus) × every input (`actions.ts`: each key, pastes, mouse gestures on each part of the frame in
each encoding, resizes, focus, signals, late replies) and what should happen, from ordered rules:
an expectation with the cheapest tier that checks it (`unit`, `e2e`, `smoke` for regression), a
hand-written test's id, or not applicable and why. `test/gluon-matrix.test.ts` keeps it whole: a
cell no rule covers, an `na` with no reason, a case id no test title has, a `GLUON-…` / `GM-…`
test the matrix doesn't know, or a key `route()`, the `?` key list, `RETURN_KEYS` or `READERS`
has that no input covers fails it. `GLUON_MATRIX_REPORT=1 bun test test/gluon-matrix.test.ts`
prints the coverage per state. A new Gluon key, state or test names its cell there.

## Monkey test

`gluon-monkey.e2e.test.ts` drives Gluon with random actions and checks each against a model.
`gluon-model.ts` is the model: a pure restatement of the spec (`route()`'s doc comment, the home
view's keys, the interceptor's rules, the fakes' TUI), never imported from the code it checks.
Where the model can't say what should happen (an unknown scrollback, a selection the list moved,
a key that would quit), `step` answers `unsupported`, and the monkey never takes that step.

Each fake gets one test per seed. A test sets up Gluon from the seed (`configFor`: 1–4 tabs,
claude/codex/opencode mixed, agy and grok alone; the size; the home key; `FAKE_ALT`, `FAKE_KITTY`).
It then takes random actions the model predicts (`gluon-monkey.ts`). After every action it checks:

- the view and the highlighted tab;
- the question bar, the scroll footer, the home key's prefix bar and the bar's ←/→ (named only on an untouched line);
- the home composer and question;
- every agent's input (`inputLogs`);
- `checkInvariants`.

```bash
bun test test/e2e/gluon-monkey.e2e.test.ts      # regression: seed 1 × 60 steps per fake
bun run test:gluon                               # 50 seeds × 400 steps, 12 at a time (local)
GLUON_MONKEY_SEED=7 GLUON_MONKEY_STEPS=400 bun test test/e2e/gluon-monkey.e2e.test.ts -t "codex seed 7( @full)?$"
```

`GLUON_MONKEY_SEEDS` sets how many seeds run and `GLUON_MONKEY_STEPS` how many actions each takes.
`GLUON_MONKEY_SEED` replays one seed, and `GLUON_MONKEY_SHRINK_MS` sets the shrinking budget
(default 4 min).

A failure prints the step, its problems and the screen, and a replay command. It also shrinks the
actions by delta debugging, replaying each candidate from scratch. The minimal list comes out as a
`test(…)` that calls `replay()`, ready to paste. Before you paste it, give the test a `BUG-nn/GM-…`
title and register the `GM-…` id in `test/fixtures/gluon-matrix.ts`.

`KNOWN` in `gluon-monkey.ts` lists patterns the monkey leaves out because they hit a known bug.
Each pattern has a `test.failing("BUG-CANDIDATE/GM-…")` repro in the monkey's file. When the bug
is fixed, clear its flag and turn the repro into a passing test.

## Visual suite

`test/visual/` checks how Gluon looks, locally only: regression, `test` and `test:unit` skip it
(`--path-ignore-patterns='test/visual/**'`). Two batches: `test:visual` (all) and
`test:visual-must` (`GLUON_VISUAL=must`: each chain once at 80×24 dark, tiny chains at their
sizes, the home and session chains light at 120×40, the resize checks marked `must`). The must
batch compares with the stored goldens and never writes them: update goldens with the full
`bun run test:visual -u` only.

```bash
bun run test:visual                    # every scene against its golden, lints, resize checks (~6 min)
bun run test:visual -u                 # accept the new frames as goldens (review the .snap diff first)
bun run test:visual-must               # the short batch (~2 min): every chain at 80×24 dark, a light check, read-only
GLUON_REVIEW=1 bun run test:visual     # also PNGs, contact sheets, test/visual/out/index.html, the checklist
```

- **Scenes** (`scenes.ts`): chains of states walked on the demo brain with the TUI fakes, each
  `shot` a scene, every chain fresh at 50×20, 80×24, 120×40 and 160×50 in the dark theme and at
  50×20 and 120×40 in the light one (the harness's `osc11`); the tiny ones at 30×8 and 19×5.
  Shots wait for idle states (a session's `awaiting your input`, the header's git state, the
  redraw after a resize: `redrawn`), never a fixed pause. `RESIZE_CHECKS` reach a scene, resize,
  and compare with a fresh start at that size (a session's interior is the agent's: chrome only).
- **Goldens** (`frame.ts`, `__snapshots__/`): the text grid with row numbers (`↩` a wrapped
  row), a style table (`s3 fg=#… bg=#… b d i u inv`), the base style, each row's runs
  `[from,to,s#]` by column, the cursor. Snapshot matchers can't run in concurrent tests: the tests
  are serial and the apps run in a pool ahead of them (`GLUON_VISUAL_CONCURRENCY`, default 8).
- **Masks** (`mask.ts`): width-preserving `#` over the version, the intake agent's elapsed time
  and blinking ◆/◇, a session's age, `$` figures, temp paths, pids and the branch. Prefer a wait
  to a new mask.
- **Lints** (`lint.ts`) on every frame: whole borders, no wrapped chrome, no half-cut wide
  characters, cuts ending in `…`, the home view's ground painted, one highlight at home, contrast
  ≥ 3:1. A lint a real Gluon bug breaks is listed in `KNOWN_BUGS` (`scenes.visual.test.ts`) as a
  `BUG-CANDIDATE/V-…` `test.failing`: drop the scene once the bug is fixed.
- **PNGs** (`render.py`, PIL and the DejaVu fonts; without them, one note and no PNGs):
  `python3 test/visual/render.py --cells <cells.json> <out.png>` (a frame as `cellsJson` writes
  it; the shape is atop `render.py`), `--ansi <ansi.txt> <cols> <out.png>` (escape sequences,
  `tmux capture-pane -e -N -p`), `--sheet <dir>` (all frames: PNGs, a contact sheet per scene, the
  index). A screen with a secret-looking string is refused. Output stays in `test/visual/out/`
  (gitignored). What to look for on the sheets: `checklist.ts`.

The runners check the cells. `test/pty-route-matrix.test.ts` checks every `unit` cell against
`route()` (the state as a `RouteContext`, the input through the real key decoder), plus seeded
properties of `route()` and the compositor under random input (`GLUON_FUZZ_SEED` picks the seed).
`gluon-matrix.e2e.test.ts` runs the rest in the real app: one app per group of states (a harness's
line states, its modes, its tabs, the home view), each cell's input applied with `apply`, its
expectation and `checkInvariants` checked, the state reached again; a signal (or a yes that quits)
runs last, on a fresh app. The fast tier runs the `smoke` cells of cc's line-and-modes group and the home-with-a-session group (the rest are `@full`, see `test/e2e/gluon-matrix.e2e.test.ts`);
`bun run test:gluon-full` (`GLUON_FULL=1`) every `e2e` cell, for many minutes (each signal in each
state needs an app of its own). `GLUON_MATRIX_ONLY=<regex>` keeps the cells whose
`<state> <input>` matches; `GLUON_MATRIX_TIMES=1` prints each group's cells, apps and time. The
cases one cell's expectation can't tell (`GLUON-20` on) are in `gluon-more.e2e.test.ts`.

When the app is wrong (a Gluon bug, not a wrong cell), the test still states the behaviour wanted:
a hand-written one is `test.failing(…)` titled `BUG-CANDIDATE/<case>: …` (its cell names that id),
a table cell goes in `KNOWN_FAILING` (in `gluon-matrix.e2e.test.ts`) with a one-line reason. Both
fail once the bug is fixed: then the fix's `BUG-nn` test takes the title, or the entry goes.

## Performance suite

`test/perf/` times Gluon on the demo with the TUI fakes (`bun run test:perf`; local, serial, never part
of `regression`; `GLUON_PERF_QUICK=1` for a short run, about 1.5 min). Latencies come from watching the screen
every millisecond (`perf-kit.ts`: `timed`, `keyLatencies`), never from `press()`. Files:

- `latency` — startup to the home view (first run with an empty transpiler cache, then warm), idle
  home view, key to frame at the home composer and inside a session (key, fake agent's echo, frame);
- `typing` — burst typing at the clock's pace (12 keys a second for 5 s, 25 a second for 4 s) at the home
  composer with no sessions, inside a session with 1, 10 and 40 open, and in a session while another
  floods 64 MB: per-key p50, p95, max, drift (do the keys queue?), lost keys;
  the home composer with 0, 10 and 40 sessions is `BUG-615/QA-perf-01` (fixed by the string-width patch in `patches/`);
- `throughput` — a `!flood` (`fake-tui.ts`) into the shown session, into a background one while keys are typed
  in the shown one, and tab switches;
- `scale` — 1, 5, 10, 20 and 40 sessions: Gluon's and the agents' RSS (`/proc`, `ps` on macOS), idle CPU over
  10 s, key, switch and home-composer latency; then every scrollback full (5000 rows of 200 cells);
- `soak` — 5 sessions printing for `GLUON_PERF_SOAK_MIN` minutes (default 20, at least 6; not in quick mode):
  RSS sampled each minute, the last third's slope must stay flat.

### What a person notices (the latency limits)

Every key-to-screen metric (keys at home and in a session, bursts, during a flood, tab switches) is held to
what a person notices, as Gluon's **added** latency: the measured latency minus the **floor**
(`measureFloor` in `perf-kit.ts`: the same probe on the fake agent's TUI alone in the pty, no Gluon in
between; it is what the pty, the headless xterm, the 1 ms polling and the echo add, a few ms). Constants
and their derivation are in `perf-kit.ts` (`NOTICEABLE_ADDED_MS`, `GOOD_ADDED_MS`); the evidence:

- **Noticeable, 100 ms in total** from keypress to the character on screen (tests fail above it): Boyle and
  Lanzetta 1984, typing a string, delay noticed at about 100 ms (single keystrokes 165 ms); Nielsen's 0.1 s
  ("reacting instantaneously"). Sensitive users go lower: mouse-latency threshold mean 65 ms, median 54 ms,
  range 34 to 137 ms (Forch et al. 2017); indirect dragging 55 ms, tapping 96 ms (Deber et al. 2015).
- **The user's own pipeline** takes 50 ms of it: keyboards 15 to 60 ms, median 30 ([Luu, keyboard
  latency](https://danluu.com/keyboard-latency/)), terminal emulators 6 to 44 ms idle, about 20 typical ([Luu,
  terminal latency](https://danluu.com/term-latency/)). **Gluon's budget, p95: 50 ms added.** Bursts also may
  not queue (the last fifth of the keys at most 25 ms slower than the first) or lose a key.
- **Good, p50 25 ms added** (a target, printed, never fails): a typical setup stays under 75 ms, a fast one
  (about 20 ms of its own) under the 54 ms median threshold; editors that care aim at 1 to 5 ms ([Fatin, Typing
  with pleasure](https://pavelfatin.com/typing-with-pleasure/)).
- Sources: [Deber et al., CHI 2015](https://www.semanticscholar.org/paper/How-Much-Faster-is-Fast-Enough:-User-Perception-of-Deber-Jota/cd4c54600245f906667d469b02ed551350ee64ff),
  [Forch et al. 2017](https://link.springer.com/chapter/10.1007/978-3-319-58475-1_4),
  [Boyle and Lanzetta 1984](https://journals.sagepub.com/doi/10.1177/154193128402800315),
  [Nielsen](https://www.nngroup.com/articles/response-times-3-important-limits/).

Latencies move with the machine's load: the table prints each burst's CPU pressure (`cpuPressure()`: the share
of the last 10 s a task waited for a core), and a run above ~5 % says little. `PERF-SMOKE` holds the
median of Gluon's added latency to the limit and the p95 to twice it, times `loadAllowance()` (1 under 5 % CPU
pressure, 1 more per 10 points, at most 4); the perf suite holds the p95 to the limit itself. A `BUG-CANDIDATE` perf test
is `test.failing` with its own measurement (not shared with a passing test, or a missing measurement would
count as the bug); it is skipped in quick mode. **`SLOW` never scales a perception limit** (`SLOW` is for waits and
timeouts: a person on a slow machine notices latency the same way); a metric added with `perceived` and the
`NOTICEABLE_ADDED_MS` assertions are unscaled. **Windows' accepted cost** (BUG-616, decided 2026-10-07): a key in a session
crosses two ConPTYs and adds about 49 ms (p50) and 64 ms (p95) over the floor, past the 50 ms limit; no fix is planned, so on win32 a key in a session is held
to `WIN_SESSION_ADDED_P95_MS` (80 ms at the p95, `perf-kit.ts`) instead, in `perf-smoke.e2e.test.ts` and `latency.perf.test.ts`, and the session bursts are recorded, not held.
Linux and macOS keep `NOTICEABLE_ADDED_MS`. The cost is written up in `docs/concepts/platforms.md`.
**The home composer at 25 keys a second** (key repeat) is held to `HOME_REPEAT_ADDED_P95_MS` (60 ms at the p95, decided 2026-10-07), not 50: Ink renders at most 30 times a second
(a throttle of about 34 ms), so a key that lands just after a frame waits for the next. Gluon keeps Ink's 30 fps; single keys and 12 keys a second keep the 50 ms limit. Measured on quiet Linux
(CPU pressure 0): 42 / 51 / 48 ms p95 added with 0 / 10 / 40 sessions, so the margin under 60 is thin: a slower machine (about 1.5x) measured 54 / 60 / 110 ms in the development React build.
The time is the frame itself (Ink's render of the home view, about 6 ms with a few sessions and 10 ms once the list fills the screen), not the session count: the per-session polls were measured and cost nothing here.
**The perf suite runs Gluon with `NODE_ENV=production`** (`GLUON_PERF_ENV` in `perf-kit.ts`, used by `perfApp` and the startup test), as every shipped build does (`scripts/build.ts`, `pack.ts`); from source React runs its development build, slower and not what a user runs.
**On Windows** the same single-key and 25 keys/s home limits are the accepted ceiling (`PLATFORM_ADDED_P95_MS`, 80 ms; `PLATFORM_REPEAT_ADDED_P95_MS`), and so are `key_p95_added` in `scale` and `scrollback`
(the home composer's single-key p95 was 47 / 48 ms in the perf suite after the string-width patch, from 64 to 66 before; the smoke's 15 samples read 66 and 80 ms in production mode: it is a noisy test at that ceiling). The home bursts on Windows are over that ceiling and open (`BUG-CANDIDATE/QA-perf-06`, a `test.failing`; p95 added with 0 / 10 / 40 sessions, production build: 50 / 51 / 119 ms at 12 keys/s and 111 / 122 / 156 ms at 25 keys/s). Windows is noisy: `scale.n20.key_p95_added` measured 80 and 100 ms in two runs, `scrollback` 79 and 81.

Each file prints its metrics table. A metric fails above 1.5x its baseline (and above baseline plus a
small slack per unit) or above its absolute ceiling in the test (× `SLOW`, except the perception limits); quick mode and
`PERF-SMOKE` (`test/e2e/perf-smoke.e2e.test.ts`, in the fast tier: startup, three sessions, keys, switches)
check ceilings only (the added-latency rows hold the perception limits; a raw latency row is held to its baseline). `GLUON_PERF_MAX_SESSIONS=20` leaves out the larger session counts. On Windows run `bun run test:windows perf` from WSL (it passes the
`GLUON_PERF_*` variables on, and a `GLUON_PERF_UPDATE` baseline comes back to the checkout): process figures and the soak are skipped there. `baseline.json` holds one entry per platform; after an intended change, or on a
new platform, run `GLUON_PERF_UPDATE=1 bun run test:perf` on an idle machine and review the diff.
Numbers move with the machine: compare runs on the same one, not across them.

## Feeding it from QA

QA passes explore by hand and with their own tools, and report bugs. When a bug is fixed, its
repro becomes a scenario here, so it can't come back:

1. Name the test after the bug and the plan case: `test("BUG-13/B7: Delete removes the character after the cursor", …)`.
2. Put it in the file for its plan section, using the demo brain and the fixtures where possible.
3. Assert what the developer would see (screen text, colours, exit code, the agent's argv), not
   internals. Logic that needs no terminal goes in a unit test in `test/` instead.
4. Check the test fails without the fix, then passes with it.

Cases that need the real brain, a real agent or a specific terminal (Windows Terminal, bidi) stay
in the QA plan.

## Keeping this file fresh

Update in the change that alters the harness API (`harness.ts`, `fixtures.ts`, `actions.ts`,
`gluon-kit.ts`, `gluon-invariants.ts`), the fakes (their variables, layouts and `!` commands), the
perf suite (`test/perf/`: its metrics, ceilings, variables, `!flood`), the
coverage matrix's shape, its runners' variables (`GLUON_FULL`, `GLUON_MATRIX_ONLY`,
`GLUON_MATRIX_TIMES`, `GLUON_FUZZ_SEED`) or the `BUG-CANDIDATE` / `KNOWN_FAILING` convention, the
monkey's knobs, checks or `KNOWN` list (`gluon-monkey.ts`), how CI load is reproduced, or the visual
suite's sizes, themes, masks, lints or `render.py` CLIs (`test/visual/`). How-to only; the rules for
tests are in `test/AGENTS.md`.
