# Gluon — instructions for coding agents

Gluon is a control platform for coding agents. Its brain
(the intake agent: an LLM with read-only repo tools) asks a few questions, writes a spec and classifies
the session; code (`route`, from the user's `routing.yaml`) turns that into agent · model · effort;
each choice starts a session of one of six harnesses — Claude Code,
Codex, Antigravity, Grok Build, OpenCode, Kimi Code — on the user's API key or own subscription, several at
once in Gluon's frame. UI: Ink, modelled on Codex's TUI. How it works: `docs/concepts/architecture.md`.

Editing any `AGENTS.md`: follow "Keeping AGENTS.md files fresh" at the end of this file.

## Commands

```bash
bun run regression    # fast tier: typecheck + unit + e2e minus `@full` tests (~2.5 min); `regression:full` is all (~12 min)
bun run test:area <a,b>  # one area's tests (test/areas.ts; `regression --changed|--list`); `test:coverage`: unit coverage
bun run test:health   # what in the tests is stale + the action (offline, seconds; docs/contributing/maintenance.md)
bun run test:unit     # unit tests, one process (`regression` shards them)
bun run test:e2e      # e2e scenarios, all of them (~13 min)
bun run test:visual   # Gluon's goldens + lints, local only (~6 min; -u updates; test/e2e/README.md)
bun run test:visual-must  # the short visual batch, local only (~2 min; read-only goldens)
bun run test:gluon    # Gluon's monkey, 50 seeds × 400 steps, local only (test/e2e/README.md)
bun run test:gluon-full  # every e2e cell of Gluon's coverage matrix, local only (~12 min)
bun test -t "BUG-01"  # tests for one bug
bun run typecheck
bun run demo          # UI with the scripted demo brain (no API calls)
bun run start         # the real thing (first working step of brain.order)
bun run test:live     # real, budgeted checks; never in regression; --dry-run, --tier=regression|harness: CONTRIBUTING.md
bun run build         # standalone binary for this host → dist/gluon-<target>[.exe]
bun run build:all     # every target (linux x64/arm64 glibc+musl, darwin x64/arm64, windows-x64)
bun run test:dist     # build release + test binaries, run test/dist.test.ts on them and the npm bundle
bun run pack          # npm-style package → dist/npm/, dist/gluon-<version>.tgz
bun run docker-test   # offline Docker suite (~7 min): shellcheck, regression on debian+alpine,
                      # tarball install, release binaries + install.sh, install.sh over https
bun run test:windows  # from WSL: the CI Windows job on this machine's Windows (stages, or -t <pattern>)
```

Use Bun, not Node tooling (no node, npm, npx, jest, vitest, dotenv). Prefer `Bun.spawn`,
`Bun.file`, `Bun.stringWidth`. API docs: `node_modules/bun-types/docs/**.mdx`.

## Workflow

- **Done means `bun run regression --changed` passes** (it runs the whole fast tier itself when a core file
  changed; `regression:full` for a big change; `@full`: `test/AGENTS.md`). CI and the nightly run are the net.
- **Every fixed bug gets a regression test** named `BUG-nn/<plan case>: …` (e2e in `test/e2e/`,
  or a unit test in `test/` if it needs no terminal).
- **The regression suite is offline and free.** Never call a real brain, agent, API or installer.
- **Paid runs only when the user asked for one; if a change needs one, ask first and wait** — this
  includes `gluon doctor`, `bun run start` and a real `--launch` (they call real models).
  `test:live` enforces its own budgets and ledger (gitignored; budgets: the maintainers' private
  notes); log any manual paid call there.
- **Git**: unless told otherwise, work on a new branch; commit and push as you go; don't merge or
  open a PR unless asked.
- **Publishing to npm, publishing a release and changing release signing are the owner's decision
  alone.**
- **CI** runs the tests of the changed areas for every pull request (`regression --changed`; macOS and Windows unless
  every area says `platforms: "linux"` in `test/areas.ts`) and on Linux for a push to main; `gate` is the one required
  check. The full suite, Docker and builds run nightly (a failure opens an issue) and by hand before a release
  (`gh workflow run ci.yml --ref main -f suite=full`). `gh workflow run ci.yml --ref <branch>` runs one off (`-f os=… -f filter=… -f extras=false`);
  Windows locally first (`bun run test:windows`).
- **Keep `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `README.md`, `docs/` true** when
  behaviour changes.

## Invariants

Break none of these. Tests enforce them (`test/rules.test.ts`, `windows.test.ts`, `tools.test.ts`,
`dist.test.ts`); full wording in the area's `AGENTS.md`.

- **Subscriptions** (opt-in, personal use): only official binaries sign in or check login; never
  read another tool's credentials or edit its files (exceptions: `src/adapters/permanent.ts`,
  `agy-settings.ts`, inert unless `GLUON_EVENTS` is set; named config keys, `src/cost/harness-config.ts`
  alone); no token forwarding (`assertSafeEnv`);
  no base URL except OpenRouter (Claude Code; Kimi Code's `KIMI_MODEL_BASE_URL`) and Codex + OpenAI key; no impersonation; any future sharing,
  bot, webhook or remote run is blocked on a subscription. → `src/AGENTS.md`
- **The user's repo is untrusted**: spawn only via `binPath`/`windowsTool`, never `Bun.which`;
  git only via `gitArgv`; checks/probes/logins in `neutralCwd()`; Bun autoloads nothing from the
  cwd; no POSIX tools at runtime. → `src/AGENTS.md`
- **Repo tools are read-only**, sandboxed by `within()`; secret files by `isSecretPath` alone.
  → `src/agent/AGENTS.md`
- **Keys never go into `process.env`**; mask anything printed (`maskSecrets`); private files are
  written directory-first. → `src/AGENTS.md`
- **What the PTY sees stays in memory**; the screen alone never triggers; unsure → forward;
  into an agent only the user's bytes, its model's replies and shifted mouse reports.
  → `src/pty/AGENTS.md`
- **A harness installer runs only on an explicit "Run it" + Enter**, verbatim, never with sudo.
  → `src/AGENTS.md`
- **A compiled binary has no `external` and no autoload.** → `scripts/AGENTS.md`

## Before you edit

Read the area's file first: open it before you change anything there.

| Editing | Read first |
|---|---|
| anything in `src/` | `src/AGENTS.md` — subscriptions, spawning, keys, installs, launches, Windows |
| `src/agent/**` (brain, repo tools) | `src/agent/AGENTS.md` |
| `src/ui/**` (Ink UI, menus, onboarding screens) | `src/ui/AGENTS.md` |
| `src/cost/**` (own cost and context figures, price tables, audit ledger) | `src/cost/AGENTS.md` |
| `src/pty/**` (the agent's pseudo-terminal, readers, question bar) | `src/pty/AGENTS.md` |
| `test/**` | `test/AGENTS.md`; e2e harness: `test/e2e/README.md` |
| `scripts/`, `install.sh`, `install.ps1`, `.github/workflows/` | `scripts/AGENTS.md` |
| after any harness update (screens, hooks, flags) | the "Harness update runbook" in the maintainers' private notes (not in this repository) |

## Markdown files

**Prefer code.** A fact about the code lives in the code: a comment next to what it describes, a
test (an executable spec), a constant, or a command's output (`--help`, `doctor`, `brain`,
`--launch … --dry-run`). Write Markdown only for what code can't hold:

| Kind | Where |
|---|---|
| Guides for users | `README.md` (landing page), `docs/getting-started/`, `docs/guides/`, `docs/concepts/` |
| Reference pages | `docs/reference/`: generated by `bun run docs:gen`, never edited by hand |
| How it works, how to contribute | `docs/concepts/architecture.md`, `docs/contributing/maintenance.md`, `CONTRIBUTING.md` |
| Instructions for coding agents | `AGENTS.md`, one per area |
| Files GitHub expects | `SECURITY.md`, `CHANGELOG.md`, `.github/` templates |
| A check a person runs by hand, a test harness's how-to | next to the tests (`test/`) |

- **Before opening a new `.md`**: no existing file can hold it and no code form fits. Link it from
  where its reader will need it; a file nothing links to gets deleted.
- **No copies of code**: no lists of ids, argv, defaults, file layouts or code-to-file maps; name
  the command or the file that shows them. Guides link to `docs/reference/` instead of copying model
  ids or flags (`test/docs-no-copies.test.ts`).
- **The docs site** is `site/` (`bun run docs:dev`, `bun run docs:build`; not in regression): a page
  goes in a `docs/` folder its sidebar names (`test/docs-site.test.ts`). Maintainer-only notes
  (paid runs, going public, dev-machine status) go in the maintainers' private
  notes, never in this repository; a page with `published: false` stays off the site (`site/published.mjs`).
- **Status in one place**: what CI covers in `docs/concepts/platforms.md`, the dated log of what has run
  where in the maintainers' private notes, release status in `docs/getting-started/install.md`,
  history in `CHANGELOG.md`.
- **Every `.md` ends with "Keeping this file fresh"**: which changes make it stale, what to check.
  In pages users read, put it in an HTML comment. `test/markdown.test.ts` checks this and links.
- **Public pages** (`CONTRIBUTING.md`, `docs/contributing/maintenance.md`, `SECURITY.md`): only what an outsider can act
  on; bug ids, budgets, machine specs and dated status go in the maintainers' private notes, never here (`test/contributor-docs.test.ts`).
- **Same change**: a change that makes a line wrong updates it in the same commit. **Delete** a
  file, or a section, when what it describes is gone.

## Keeping AGENTS.md files fresh

On top of the above, for every `AGENTS.md`. Every line costs every agent context.

- **Delete rules a test or the code now enforces by itself** (the failure message carries the
  detail). No "previously", no changelog (`CHANGELOG.md`).
- **Add only what an agent would get wrong**: a mistake made twice, a review catch, a trap with a
  `BUG-nn`. Not what the code, a README or the language makes obvious; no file-by-file layout.
- **Names must exist**: every `file`, symbol and `bun run` script named resolves
  (`test/markdown.test.ts` checks).
- **One fact, one place**: search all `AGENTS.md` first and extend the existing entry; a rule
  lives in the deepest directory it applies to. Root keeps one-line invariants pointing down.
- **Entries are rules, not stories**: imperative sentence, then where (`file`) and why (`BUG-nn`);
  ≤ 3 lines. How and history go in code comments or `docs/`.
- **Budget**: root ~150 lines, nested ≤ 70. Over it, move detail to `docs/` before adding more.
- **Neutral to the agent**: write for any coding agent; no tool-specific files or wording.

A new `AGENTS.md` only for a directory with ~5+ non-obvious rules that apply nowhere else; copy the
template in the maintainers' private notes ("Starting a new AGENTS.md") and add its row to "Before you edit".
