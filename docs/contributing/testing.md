---
title: "Writing tests"
description: "How to write a test for Gluon that is worth keeping: tested at the product's surface, waits for states, assertions on meaning, and the checks that hold every change to it."
---

Most of Gluon's code, and of its tests, is written by coding agents. A test suite written that way grows fast and
rots in known ways: tests that pass whatever the code does, tests that mirror the implementation, sleeps that flake on
a slow runner, the same bug tested three times, a failing test made green by deleting it. These rules keep the suite
small, fast and trustworthy. Each one is checked by code where code can check it; the rest is review.
How to run the tests is in [Contributing](contributing.md).

## The rules

**1. A bug's test fails before its fix.** Write the test first, watch it fail, then fix. A test that passes without
the fix proves nothing about it. *Checked:* CI's `red-check` runs each test a pull request adds for a newly tested bug
against the base's `src/`; it must fail there. A fix with no `src/` change (a script, a workflow) takes the `red-exempt` label.

**2. Never weaken a test to get green.** Fix the code, or stop and say what fails. Deleting a test or an assertion,
skipping one, tagging it `@full` or `@quarantine`, or loosening a matcher is a decision for a person.
*Checked:* CI's `test-guard` lists every such change; it passes only with a maintainer's `tests-reviewed` label.

**3. Test at the product's surface; below it only at a typed seam; one layer.** Test a behaviour the way a user meets it:
an end-to-end scenario through Gluon's terminal with the fake agents; the real-harness tier when it depends on a harness's
screens, flags or hooks; a live check when only a real model, or a harness with no loopback, shows it. A test below the
surface is right only at a seam, a module whose contract is a type or an outside format (`test/seams.ts` lists them:
routing, the adapters, the screen readers, the agent session, the cost functions…), never at an internal helper. The
agent that writes the code writes the test: a test of a helper restates the code and breaks with every refactor. The
same bug tested at two layers costs twice and catches once.
*Checked:* `test/catalog.test.ts`: a test below the surface imports from `src/` only seams; `test/test-style.test.ts`: no
new bug tested at both layers (the files and bugs that already break these can only go).

**4. Wait for a state, never for a time.** Wait for what the step should produce (`waitFor`, `until`, `exitCode()`);
a fixed sleep is too short on a loaded runner and too long everywhere else. A sleep is right only as a window in
which something must *not* happen; say what, with `// sleep-ok: <what>`. A deadline the test's own steps must meet is
scaled for slow runners (`ms * SLOW`); a limit a person would notice belongs in the perf suite (`test/perf/`).
*Checked:* `test/test-style.test.ts`: no bare time bound; fixed waits only go down, file by file.

**5. Assert the meaning, not the copy or the whole screen.** Check the state, the region or the phrase that matters.
A whole-screen snapshot gets re-recorded without being read; screen goldens live in the visual suite only.
*Checked:* no snapshot outside `test/visual/`.

**6. Fakes at the boundary, not mocks inside.** Gluon's tests run real processes against fake agents, a fake brain
and loopback servers (`test/fixtures/`). Mocking a module couples the test to how the code is split today.
*Checked:* module mocks only go down.

**7. Fast by default.** Agents verify many times a day: `bun run verify` runs the tests that import what changed, in
seconds, and `bun run regression --changed` is the gate. A test in the fast tier takes under ~3 s; a slower one is made
faster (wait for a state; one test per variant, so they run at once) or tagged `@full`. *Checked:* `bun run test:health`
lists the slow ones, breaks on any far over the threshold, and on the fast tier as a whole over its budget.

**8. Every test names what it promises; a bug strengthens that test.** A test's title starts with the id of its entry in
the catalog (`test/catalog.ts`): `feature/entry: <what holds>`. A bug fix makes the test of the entry that should have
caught it fail, then fixes the code, and tags the test `#BUG-<n>`; when no entry could have caught it, the fix adds the
missing one. Search the catalog before adding a test: a new case often belongs in an existing one.
*Checked:* `test/catalog.test.ts`: every entry has a test and every test a known entry (today's untagged tests are a
baseline that only goes down); `red-check` runs a newly tagged test against the base.

**9. A failure says what to do.** A check that fails names the file, what is wrong and how to fix it, so the next
person, or agent, acts on it without reading the check.

## The catalog

The catalog (`test/catalog.ts`) lists what Gluon promises, so that every promise is tested and every test checks one.

- A **feature** is something a user can name: the composer, resume, the cost figure, routing.
- A **behaviour** is one observable rule of a feature: given this, when that, then this holds. Observable means through
  the product's surface (the screen, the bytes that reach the agent, files, the exit code) or a seam's contract, never an
  internal function.
- An **invariant** holds everywhere (the rules in `AGENTS.md`); a **perf limit** is how fast Gluon must feel.

A change that adds a behaviour adds its entry and its test in the same pull request, the entry written from the guide or
the spec before the code. Adding, changing or removing an entry or a seam (`test/seams.ts`) is a maintainer's decision:
`test-guard` lists it until the pull request has the `tests-reviewed` label. A test may be deleted when it names no entry,
or when another test checks its entry at the same layer or a better one; the pull request says which, for each test.

## Pruning

A test is deleted on evidence, never on a hunch. `bun run test:value <area>` (local, minutes) puts small bugs into the
area's source one at a time (a comparison flipped, a `!` dropped) and runs its tests after each: a bug no test notices is
a gap to close; a test that catches nothing no other test catches is a candidate to delete, the slow ones first. It also
lists the bugs the area tests at both layers. Candidates need a large sample (hundreds of mutants) before they mean much;
a pull request that deletes tests says why for each, and waits for a maintainer's `tests-reviewed` label.

## Flaky tests

CI runs a failed test once more. If it passes then, the run passes and the test is reported as flaky (a warning on
the run, and a `flaky.json` artifact). A flaky test is fixed, or quarantined while it is fixed:
`@quarantine <bug> until:<date>` in its title, at most 30 days, keeps it out of the blocking runs; the nightly full run
still runs it, and `bun run test:health` breaks once the date has passed. Tests never retry themselves.

## Real harnesses

The fakes in `test/fixtures/` stand in for the harnesses where a test needs speed or a case a real harness rarely shows (a
failure, a flood of input, a sign-in screen). What a fake can't tell is whether the newest harness still works in Gluon's
frame, so `bun run regression` also runs the real-harness tier (`test/real/`, `scripts/real-stage.ts`): Gluon launches the
real Claude Code, Codex, OpenCode and Kimi Code binaries, on the versions in `test/harnesses.json`, and their model traffic
goes to a model API on loopback (`test/fixtures/fake-model-api.ts`). It is free and offline but for installing the
binaries, runs only for a change that touches the harnesses, and needs tmux (it is skipped on Windows). CI runs it on each
harness's newest release, so a harness release that breaks Gluon is found before a merge.

## Live checks

The tests themselves are offline and free. After them, `bun run regression` runs the live checks the change needs
(`scripts/live-stage.ts`): the real brain and the real harnesses, on the versions in `test/harnesses.json`, with your
own credentials (an AWS setup for Bedrock first, then a plan you're signed in to, then an API key). Each run is capped
per bucket in code (`REGRESSION_LIVE_CAPS` in `scripts/live-lib.ts`: your plans in tokens; Bedrock, OpenRouter and other API
keys in dollars); a check over a cap is skipped and says so, and `--live-caps` raises a cap for one run. A check that passed isn't run again until `src/` or the harness changes, and without
credentials or a network each one is skipped, never failed. They never run in CI. `--no-live` leaves them out;
`--newest` runs them on each harness's newest release. Wider checks (`bun run test:live`) run only when a person asks.

## Next steps

- [Contributing](contributing.md): running the tests, what CI runs.
- [Maintenance](maintenance.md): keeping the tests fresh.

<!-- Keeping this file fresh: update when a rule above changes or a check that enforces one does: test/test-style.test.ts (and its baseline), test/catalog.test.ts (the catalog, the seams and their baseline), scripts/red-check.ts, scripts/test-guard.ts, the quarantine and slow-test checks in scripts/test-health.ts, or CI's jobs in .github/workflows/ci.yml. test/AGENTS.md holds the same rules in one line each, for agents: change both together. -->
