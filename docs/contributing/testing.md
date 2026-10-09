---
title: "Writing tests"
description: "How to write a test for Gluon that is worth keeping: the cheapest layer that catches the bug, waits for states, assertions on meaning, and the checks that hold every change to it."
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

**3. The cheapest layer that can catch the bug, and only one.** A pure function: a unit test. Files, processes, git: a
unit test with a temporary directory. The terminal (what the screen shows, which bytes reach the agent): an end-to-end
scenario. The same bug tested in a unit file and in an end-to-end file costs twice and catches once.
*Checked:* `test/test-style.test.ts` fails on a new bug tested at both layers (the ones that already are can only go).

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

**7. Fast by default.** A test in the fast tier takes under ~3 s; a slower one is made faster (wait for a state; one
test per variant, so they run at once) or tagged `@full`. *Checked:* `bun run test:health` lists the slow ones and
breaks on any far over the threshold.

**8. Extend before adding.** Search for the bug's id or the behaviour first; a new case often belongs in an existing
test. One behaviour per test, named for what it checks: `BUG-<n>/<case>: <what holds>`.

**9. A failure says what to do.** A check that fails names the file, what is wrong and how to fix it, so the next
person, or agent, acts on it without reading the check.

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

## Live checks

The regression suite is offline and free. Checks against real models and real agents (`bun run test:live`) spend
money: they run only when a person asks, never in CI, and each one has a hard budget in code.

## Next steps

- [Contributing](contributing.md): running the tests, what CI runs.
- [Maintenance](maintenance.md): keeping the tests fresh.

<!-- Keeping this file fresh: update when a rule above changes or a check that enforces one does: test/test-style.test.ts (and its baseline), scripts/red-check.ts, scripts/test-guard.ts, the quarantine and slow-test checks in scripts/test-health.ts, or CI's jobs in .github/workflows/ci.yml. test/AGENTS.md holds the same rules in one line each, for agents: change both together. -->
