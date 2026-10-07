# Contributing to Gluon

Thanks for helping. Bug reports and ideas are as welcome as code. Gluon is licensed under the
Apache License 2.0, and code you contribute is licensed the same way. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md); questions go where [SUPPORT.md](SUPPORT.md) says.
[docs/concepts/architecture.md](docs/concepts/architecture.md) explains how the pieces fit,
[docs/concepts/platforms.md](docs/concepts/platforms.md) what is tested where, and `AGENTS.md` (with the
per-area `AGENTS.md` files it points to) the project's rules and traps: read it before a non-trivial change.

## Set up

You need [Bun](https://bun.sh) (the version in `.bun-version`) and git.

```bash
git clone https://github.com/fidipro/gluon.git gluon
cd gluon
bun install
bun run demo          # the UI with a scripted brain: no keys, no API calls
bun run start         # the real thing, from this checkout
```

Use Bun, not Node tooling (`bun test`, `bun run`, `bunx`, not npm, npx, jest or vitest).

### Run your checkout as `gluon`

Linux and macOS: `ln -s "$PWD/src/cli.tsx" ~/.bun/bin/gluon` (any directory on your `PATH`).
`src/cli.tsx` runs Bun with no `.env` and no `bunfig.toml` from the repository you run Gluon in, so
that repository's code never runs inside Gluon, where your keys are.

Windows: the `-S` shebang doesn't run there, and plain `bun src\cli.tsx` would load the current
directory's `bunfig.toml`. Run

```powershell
bun --no-env-file --config=<gluon>\scripts\empty-bunfig.toml <gluon>\src\cli.tsx
```

or build the executable.

### Build

```bash
bun run build         # the executable for this machine → dist/gluon-<target>[.exe]
bun run build:all     # every release target (Linux glibc/musl x64/arm64, macOS x64/arm64, Windows x64)
bun run pack          # the npm-style tarball → dist/gluon-<version>.tgz (Linux / macOS)
```

## Test

The suite is offline and free: a scripted brain, fake agents, temporary repositories and canned API
probes. Never make a test call a real model, agent or API.

| Situation | Run |
|---|---|
| Editing one area | `bun run test:area <area>` (areas: `test/areas.ts`; several: `a,b`) |
| Before a commit | `bun run regression --changed` (the areas of what you changed since `origin/main`) |
| Done | `bun run regression`: typecheck + unit + end-to-end, without tests titled `@full` (~3 min) |
| A big change | `bun run regression:full`: everything (~14 min) |
| `src/pty/`, the frame, `src/gluon.ts` | `bun run test:area pty,gluon-frame`, then `bun run test:gluon` |
| Platform-specific code | `bun run test:dist` (builds and tests the executable); `bun run test:windows` (from WSL, on the machine's Windows); `bun run docker-test` (Linux in Docker) |

`bun run test:unit` and `bun run test:e2e` run one half each, `bun test -t "<title>"` one test, and
`bun run test:health` lists what in the tests has gone stale. `test/e2e/README.md` explains the
end-to-end harness.

- **A fixed bug gets a regression test** in `test/` (a unit test if it needs no terminal, otherwise an
  end-to-end scenario in the `test/e2e/` file for its area). A maintainer gives it its bug number.
- **CI** (`.github/workflows/ci.yml`) runs on every pull request and every push to main the tests of the
  changed areas (`bun run regression --changed`, with the typecheck) on Ubuntu 24.04, macOS 15 and Windows 2025,
  a secret scan (gitleaks) and the docs build. The full suite, `docker-test`, `build:all` and `test:dist` run by
  hand before a release (`gh workflow run ci.yml --ref main -f suite=full`). A maintainer can start
  one off with `gh workflow run ci.yml --ref <branch>` (`workflow_dispatch`). A fork's pull request runs
  with read-only permissions and no secrets, and a first-time contributor's needs a maintainer's approval
  before Actions run. macOS is tested only in CI.

## Hard rules

These protect users' keys and subscriptions. `test/rules.test.ts` checks them; a pull request that
breaks one won't be merged.

- **Subscriptions are opt-in and personal**: one person, their own machine.
- **Only the vendor's official binary** signs in or checks login (`claude`, `codex`, `agy`, `grok`,
  `opencode`, `kimi`).
- **Never read another tool's credentials** (`~/.claude`, `~/.codex/auth.json`, keychains, …) and never
  edit another tool's files: tell the user what to set. The one exception is a file or folder of Gluon's
  own in Grok Build's hooks dir and Antigravity's plugins dir (`src/adapters/permanent.ts`), inert unless
  `GLUON_EVENTS` is set; `gluon uninstall` removes it.
- **No token forwarding and no base URL on a subscription.** The only base URLs are OpenRouter's, for
  Claude Code and Kimi Code on that connection alone (`assertSafeEnv`), and Codex's OpenAI one.
- **No impersonation**: no prompt claims to be another vendor's product.
- **Keys Gluon holds stay out of `process.env`**; a launched agent gets only the key its model needs;
  anything printed is masked.
- **Never load the working directory's `.env` or `bunfig.toml`** into Gluon.

## Pull requests

- Keep a change focused; say what and why in the description.
- Update `AGENTS.md`, and `README.md` / `docs/` for user-facing changes, in the same change.
- Add a line to `CHANGELOG.md` under *Unreleased*.
- Never commit real keys or tokens: CI scans the full history with gitleaks.
- `AGENTS.md` files are the single source of instructions for coding agents, whichever you use; the
  policy for every Markdown file is at the end of the root `AGENTS.md`.

## Security issues

Don't open an issue: see [SECURITY.md](SECURITY.md).

## Keeping this file fresh

Update in the change that alters a command (`package.json` scripts), what CI runs (`.github/workflows/ci.yml`),
the test policy or the hard rules (`test/rules.test.ts`). Keep this to what an outside contributor needs: no
bug or issue numbers, no paid-run budgets, no machine-specific timings. Maintainer-only procedures go in
`docs/contributing/internal.md`, rules for agents in `AGENTS.md`; link rather than repeat. The scripts and files
named here and the line budget are checked by `test/contributor-docs.test.ts`.
