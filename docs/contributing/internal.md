---
title: "Internal maintenance (not published)"
description: "The maintainers' notes: paid runs, the harness-update runbook and the test-status log. Kept in the repository, not on the docs site."
published: false
---

For the maintainers (`published: false`: in the repository, not on the docs site). The public
procedures are in [maintenance.md](maintenance.md), the contributor guide in `CONTRIBUTING.md`.

## Paid runs

- **`bun run test:live`**: real calls on a budget (Bedrock ≤ $5, other APIs ≤ $3 in total; ledger
  `qa/logs/live-spend.json`). Never part of `regression`. Keys come from `GLUON_DEV_ENV` (default: the gitignored
  `.env`, see `.env.example`); Bedrock needs `AWS_REGION` / `AWS_DEFAULT_REGION` or a profile region, else it is left out.
  Look first with `--dry-run` (every call with its worst-case cost).
  - no flag: every harness's status, every connection probed, one brain session per working step;
  - `--tier=regression`: the fixed set (brain-route probes, one short chat, git-tools and nested-instructions
    checks, the real-harness section), ≤ $3, prints `PASS` / `FAIL` / `SKIP`, exit 1 on `FAIL`;
  - `--tier=harness --harness=<id>` (≤ $1): launches the harness from the demo brain in tmux on its cheapest API-key
    model (never a sign-in), sends "Reply with just OK", asserts frame, status working → awaiting, the reader's input line,
    the return to Gluon and the cost figure; screens go to `qa/logs/screens/<id>-<version>/` and the input-line region is
    diffed against `test/fixtures/screens/<id>/` (printed, never asserted). It builds price tables first with
    `gluon pricing update` in the scratch `HOME` (`scripts/live-harness.ts`);
  - `--only=git-tools` (≤ $1), `--only=nested-instructions` (≤ $0.50).
  - Run `--tier=harness` after a harness update, `--tier=regression` before a release or after a change to a brain
    client, adapter or reader.
- **A campaign** has its own ledger and caps: `--ledger <path> --caps bedrock=30,other=10,openrouter=0.5`
  (OpenRouter's cap counts inside `other`; the Claude plan is charged to `other` at API prices, flagged `estimated`).
- **Plan routes** run in a scratch `HOME`. The Claude plan needs your `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`, typed at a `read -rs` prompt, never saved), else its probes are `SKIP`; the ChatGPT plan runs
  only with `GLUON_LIVE_CHATGPT_PLAN=1` (it uses the real `HOME`'s sign-in).

## CI and local suites

- `bun run docker-test [stage…]`, offline, in order: `lint` (shellcheck), `regression` (Bun's Debian and Alpine images),
  `npm` (tarball, `bun add -g`, publishing refused), `smoke` (built binaries and `install.sh` on Ubuntu 24.04, Debian 12,
  Alpine 3.20: good install, tampered binary, no `SHA256SUMS`), `https` (redirects, https → http refused).
- `bun run test:windows [stage…] | -t <pattern> | -f <file>…` copies the checkout to `%LOCALAPPDATA%\gluon-test\repo` and runs
  Windows Bun there (stages: comment atop `scripts/windows-test.ts`); the extra `perf` stage is not in CI.
- A pull request or push to main runs only `suite=changed` (the areas changed since the base, with the typecheck, on 3 OSes);
  docker, `build:all` and the full suite run by hand (`plan` job, `.github/workflows/ci.yml`).
- CI inputs for a one-off `workflow_dispatch` run: `suite=`, `os=`, `area=`, `filter=`, `extras=false` (see `.github/workflows/ci.yml`).
  Windows goes to CI only after `test:windows` passes.
- Local-only suites: `test:perf` (`GLUON_PERF_QUICK=1`; `GLUON_PERF_UPDATE=1` on an idle machine to rebaseline, reason in the
  commit), `test:visual-must` / `test:visual -u` after a UI change (review the diff), `test:gluon` (monkey), `test:gluon-full`.
- **Docs site**: before the first Pages deploy (`pages.yml`), set Settings → Pages → Source to "GitHub Actions".
- **After publishing a release**: `gh workflow run ci.yml -f suite=install-smoke` checks the release's one-line installers on 3 OSes.
- **Before a release**: `test:health`, `regression:full`, `test:dist`, `docker-test`, `test:windows`, one full CI run on all three OSes (`gh workflow run ci.yml --ref main -f suite=full`).

## Harness update runbook

Run `bun run test:live --tier=harness --harness=<id>` (paid), read the screen diff, then work through what applies.

- **codex**: refresh `test/fixtures/codex-features-list.txt` from `codex features list`; for each new feature or catalog
  field decide whether the brain may have it (`CODEX_FEATURES_KEPT`, `CATALOG_FIELDS` in `src/agent/codex.ts`); re-check a
  thread's tools against a local mock provider (`additional_tools`); `gluon doctor` (probes `app-server`, `dynamicTools`).
- **agy, grok, opencode**: no login-status command for agy and grok. `gluon doctor`, then compare `--help` with the argv in
  `src/harnesses.ts` and the checks in `src/status.ts`; `doctor` never starts OpenCode, so launch it by hand.
- **kimi** (read from `--help`, docs and the binary's strings, checked in a scratch `HOME` with `KIMI_MODEL_*` and a local sink):
  compare `kimi --help` with `HARNESS_INFO["kimi-code"]`, and `kimi provider list` with `parseKimiProviders`. Recheck:
  explore is unavailable (the TUI never hands `--agent` to its engine; if `--agent-file` starts dropping Write/Edit/Bash from the
  tools array, bring explore back and update `RouteHarness.noModes`); K3 takes no effort over OpenRouter
  (`ModelEntry.effortConns`); Moonshot's key needs no base URL (`buildCommand`: Kimi's env model defaults to
  `https://api.moonshot.ai/v1`; the no-base-URL invariant holds only while it does). Unchecked live: the real plan,
  a Moonshot key, the brief file outside the repo.
- **Launch modes** (`HARNESS_INFO[h].modes`): explore must stay strictly read-only (writes fail, nothing asks to escalate).
  Codex: still no plan flag? `/plan` still switches without text and `plan_mode_reasoning_effort` is honoured. Grok Build ignores
  `--permission-mode` in its TUI (plan is a typed `/plan`; explore needs `--sandbox read-only` plus `--deny`) and shows
  `· plan` in the composer's bottom border (`planMode` in `src/pty/readers/grok.ts`). Compare each harness's
  `--dry-run --mode explore` argv before and after.
- **Instruction files** (`instructionFiles`): which of `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` it loads itself
  (docs, or `strings <binary> | grep AGENTS.md`).
- **Resume** (`resume`, `argv` in `src/harnesses.ts`): start a session, quit, `gluon resume <id>`; the conversation must come back
  with no spec sent, Codex and OpenCode records must have an id, and an explore session must still be read-only.
- **Screens** (`test/fixtures/screens/<harness>/<version>.json`, format atop `test/fixtures/screens.ts`): re-capture in an
  isolated, signed-out scratch `HOME` with no model reachable: idle, typed text, slash menu, `/cl` + Tab, moving the highlight,
  `/compact` with arguments, an edited `/clear` (never Enter on `/clear` or `/compact`); inside Gluon's frame (`frame-*`
  states) after a turn, during one, and with no colour answer; the trust/approval dialogs read by `awaitsChoice`; the screens after
  Esc cuts a turn off and at Claude Code's context limit (their readers' `interrupted` ends a hook's Working). Type each key after
  the previous echo (Codex reads keys arriving together as a paste). Add the expected input line and menu item to
  `test/pty-readers.test.ts`; fix the reader when they fail; check `COMMANDS` in `src/pty/readers/index.ts`. Grok Build: on the
  user's own login in a trusted folder, never a model prompt; clear the box with Backspace. Kimi Code: scratch `HOME`, `KIMI_MODEL_*`
  at a closed loopback port; `/clear` is `/new`'s alias; its dialogs have no composer, and its `question` panel (`frame-question-panel`, with and without option descriptions; `frame-question-streaming`: the composer stays on screen while Kimi streams) is read by `awaitsChoice`. Its start-up order is read by `ready` (BUG-674): the empty composer comes first, before the model is applied (`frame-early-composer`), then the banner's `Model:` row and the footer (`frame-ready-composer`); re-capture both with the model in `KIMI_MODEL_*`, frame by frame from the trust dialog's Enter.
- **Hooks and permissions**: waiting `PreCompact` hooks (Claude Code block decision, Codex `continue:false`, Grok Build hooks file
  with `$VAR` expansion; update the adapter header's version); Claude Code's `permissions.allow` for `"$GLUON_SELF" signal back`
  and `disableAgentView`; Codex's one-time hook review keyed by bytes (a relaunch must not ask again); Grok's hooks file
  (`src/adapters/permanent.ts`, `minVersion` in `src/adapters/grok-build.ts`).
- **Status and telemetry**: hook event names (adapter headers; Codex's set changes only on purpose), OpenCode's event shapes
  (`pluginSource`), telemetry names (`src/telemetry.ts` header). Find them offline (`strings`, the source). Then walk
  `test/windows-manual-qa.md` with the real harness.
- **Cost figures**: Claude Code, Codex and Grok Build come from OpenTelemetry, OpenCode from its plugin, Antigravity from its status
  line, Kimi from `kimi export` (`src/kimi-usage.ts`; recheck `kimi session list --cwd <dir> --json` and the `usage.record` lines
  in `agents/<agent>/wire.jsonl`). Re-capture into `test/fixtures/telemetry/` against a local fake API on loopback in a signed-out
  `HOME` (`telemetryLaunch` in `src/telemetry.ts`): a turn, `/compact`, a subagent turn, a second turn; save the harness's own
  figure beside it (Claude Code's `statusLine` JSON, Codex's `/status`) and update `test/figures.test.ts`.
- **Oracle** (`bun scripts/pricing/oracle-claude.ts`): runs the real `claude` offline and fails when `src/cost/claude.ts` stops
  reproducing its cost, i.e. Claude Code changed its pricing; re-capture then.
- **Claude's table builds from the new binary** (BUG-675): in a scratch `HOME` with only the new `claude` on `PATH`, `gluon pricing update`
  must say `claude-catalog: written` (a refusal leaves a fresh install with no Claude price, so no cost figure at all; 2.1.293 added a
  `long_prompt` price row and models with no `context`). Then run the oracle with `--catalog` on that table, and
  `bun test ./test/claude-otel.test.ts` (the real `claude` against a fake API: usage arrives while it runs). Compare the OTEL names in the
  binary (`strings <claude> | grep -oE 'OTEL_[A-Z_]+|CLAUDE_CODE_[A-Z_]*TELEMETRY'`) with the previous version's.
- **Observed Grok windows** (`src/cost/tables/grok-observed-windows.json`, hand-written): add a model only with live evidence (the
  footer's `used / window` in Grok Build on your own login; K = 1000) plus `context`, `observedAt`, `grokVersion`, `evidence`.
  The Grok generator (`scripts/pricing/grok.ts`) says when to remove one (the binary's catalog lists it now). Never add a window without evidence.
- **Installers**: re-check `installDirs`; never run a real installer outside a throwaway container.

## Test status (as of 2026-10-07)

What has run where; the public page is [platforms.md](../concepts/platforms.md) and must stay true to this.

- **Linux (WSL 2)**: the full suite regularly. Only here: `build:all`, `docker-test`, `test:gluon`, `test:gluon-full`, `test:visual`,
  `test:visual-must`, and checks by hand with real Claude Code, Codex, OpenCode and Kimi Code.
  Linux arm64 was cross-built and started once under QEMU (`--version`); the macOS x64 binary is built, never run in a suite.
- **Windows 11** (real machine from WSL, `test:windows`): unit, e2e through ConPTY, `test:dist`, `install.ps1` all green. Nobody has
  walked `test/windows-manual-qa.md`. Skipped for what ConPTY doesn't pass through (exact output bytes, wide characters, kitty keyboard
  flags, mouse and focus reports, signals, symlinks without Developer Mode, bash-based fakes). Open findings are the
  `BUG-CANDIDATE/QA-win-nn` tests. Typing latency adds about 49 ms median / 64 ms p95 in a session (accepted, held to 80 ms by the perf
  smoke); the home-view burst latency is open (`BUG-CANDIDATE/QA-perf-06`).
- **macOS**: CI only (`macos-15`, arm64: full suite and `test:dist`). CI skips the scenarios that type a line for the agent
  without a pty (F10, F13–F15, F17, F19, four resume ones, an analytics one; `MAC_STEALS`, `test/e2e/harness.ts`). The fix
  (`BUG-614`, `test/return.test.ts`) is **unverified on a Mac** until those pass on macOS CI. To try them, run CI on a branch with
  `GLUON_QA_MAC_NOPTY=1` added to the regression job's env.
- **Kimi Code**: checked live with OpenRouter on 2.1.1. Not covered: the plan (`kimi login`), a Moonshot key (offline only), macOS, Windows.
- **Perf baselines**: WSL 2 and Windows 11, never macOS.

## Starting a new AGENTS.md

Only for a directory with ~5+ non-obvious rules that apply nowhere else. Copy this, then add its row to "Before you edit" in the root
`AGENTS.md`:

```markdown
# <dir>/ — instructions for coding agents

<One line: what this directory is.>

## <Topic>

- **<Rule, imperative>**: <detail> (`<file>`; BUG-nn).

## Keeping this file fresh

Follow "Keeping AGENTS.md files fresh" in the root `AGENTS.md`. In short: update it in the change
that makes a line wrong; delete what stops being true or a test now enforces; add only what an
agent would get wrong; every name must exist; ≤ 70 lines, overflow to `docs/`.
```

## Next steps

- [Maintenance](maintenance.md): the public procedures for when a harness or a provider changes.
- [Contributing](contributing.md): set up a checkout, run the tests and keep the rules.
- [Platforms](../concepts/platforms.md): the public page on what CI covers.

<!-- Keeping this file fresh: update when a suite first runs somewhere, a checklist item is done or becomes moot, a harness version or the way a harness is checked changes (the runbook), or the paid-run budgets or `test:live` tiers change. Keep it out of the published docs (`published: false`) and under its line budget (test/contributor-docs.test.ts). Check .github/workflows/, package.json (the scripts named here), scripts/live.ts. -->
