---
title: "Platforms"
description: "What runs where, how to test on your platform, and the notes for each platform."
---

What Gluon builds for, what CI runs, how to test on your own machine, and what differs per platform.

## Support matrix

CI (`.github/workflows/ci.yml`) runs the tests of the changed areas (`bun run regression --changed`) on Ubuntu 24.04, macOS 15
and Windows 2025 for every pull request and push to main; the full suite, `docker-test`, `build:all` and
`test:dist` run by hand before a release (`gh workflow run ci.yml --ref main -f suite=full`). `CONTRIBUTING.md` ("When to
run what") says what to run locally.

| Platform | Build | What CI runs (the full suite and Docker, by hand) |
|---|---|---|
| Linux x64, glibc | `gluon-bun-linux-x64` | `ubuntu-24.04`: typecheck, unit, end-to-end, the compiled binary; `docker-test`; `build:all` |
| Linux x64, musl (Alpine) | `gluon-bun-linux-x64-musl` | `docker-test` |
| Linux arm64 (glibc, musl) | `gluon-bun-linux-arm64[-musl]` | cross-built; started once (`--version`) on an arm64 runner at release |
| macOS arm64 / x64 | `gluon-bun-darwin-{arm64,x64}` | `macos-15` (arm64): the full suite and the compiled binary; x64 built and started once at release |
| Windows 11 x64 | `gluon-bun-windows-x64.exe` | `windows-2025`: the full suite, the compiled exe, `install.ps1` under Windows PowerShell 5.1 |
| WSL 2 (x64) | the Linux build | none; use it as Linux |

Not built: Windows on arm64, 32-bit systems, FreeBSD.

## Testing on your platform

`CONTRIBUTING.md` ("When to run what") says which suite to run for a change. The ones that depend on
the platform:

| Command | What it does |
|---|---|
| `bun run regression` | the fast tier, offline; on Windows the end-to-end scenarios run through ConPTY |
| `bun run test:windows` | from WSL, CI's Windows job on the same machine's Windows; `-t <pattern>` runs only matching tests, `-f <file>` named files, `perf` the perf stage. Read `test/AGENTS.md` ("Windows traps") first |
| `bun run docker-test` | the regression on Debian and Alpine, the npm tarball and `install.sh`, offline |
| `bun run test:dist` | the compiled binary, on the platform you built it on |
| `gh workflow run ci.yml --ref <branch> -f os=macos -f extras=false` | macOS has no local route: open a pull request, or run it through CI by hand |
| [windows-manual-qa.md](../../test/windows-manual-qa.md) | by hand on a real Windows machine: key events, themes, paste, shims, login handoff |

A few end-to-end scenarios are skipped where the platform can't do what they need (each marked in
the test file): on macOS and Windows those that run a session without a pseudo-terminal, and on
Windows those that need what ConPTY doesn't pass through (exact output bytes, wide characters, an
agent's kitty keyboard flags and mouse reports, focus reports, signals).

## Linux

- The x64 executables need a CPU with AVX2 (2013 or later).
- musl (Alpine and others) needs `apk add libstdc++ libgcc`; `install.sh` picks the musl build
  itself and says so.
- The npm-style tarball needs `bun` and an `env` with `-S`: GNU coreutils has it, BusyBox's (Alpine's
  default) doesn't, so `apk add coreutils`.
- Nothing needs POSIX tools at runtime: without `rg` or `git` the intake agent's search and listing
  fall back to JavaScript, and a missing `git` just means "not a repository".

## macOS

- Both architectures are built on a runner of their own kind; the binaries are signed ad hoc. A
  binary cross-built on another OS must be signed on a Mac (`codesign --sign - <file>`) before it
  runs there.
- `install.sh` detects a shell running under Rosetta on Apple silicon and installs the arm64 build.
- Checksums: `shasum -a 256` (see [install.md](../getting-started/install.md#verifying-by-hand)).
- A child that gets the terminal directly (a login, `gluon install`, `--launch`) needs Gluon's own
  stdin reader ended first; macOS is where Bun's paused reader still takes a typed line
  (`inTerminal` in `src/launchers.ts`).

## WSL

Use the Linux build inside WSL, and install the agents inside WSL too. WSL puts Windows' `PATH` after
Linux's, so a Windows agent (`/mnt/c/…/claude.exe`, an npm `codex.cmd`) may be found:

- a Linux install anywhere on `PATH` wins over a Windows one;
- a Windows install alone is reported ("install it inside WSL") and never run;
- `gluon install` doesn't use a Windows `npm` or `curl` seen from WSL.

A git worktree made by WSL's git isn't usable by Windows git or an IDE, and the reverse (git records
absolute paths); `git worktree repair` fixes the links after a move.

## Windows

- Use `gluon.exe` (`install.ps1`, or the release file). The npm-style tarball doesn't run on Windows
  (its bin uses an `env -S` shebang).
- From source, run `bun --no-env-file --config=<gluon>\scripts\empty-bunfig.toml <gluon>\src\cli.tsx`;
  plain `bun src\cli.tsx` would load the current directory's `bunfig.toml`.
- Config and keys are in `%APPDATA%\gluon`. The cost audit ledger and the price tables are in
  `%LOCALAPPDATA%\gluon` (`$XDG_STATE_HOME/gluon/…` or `~/.local/state/gluon/…` elsewhere). Private
  directories are limited to your account with `icacls`.
- **Each agent in Gluon runs in a ConPTY** of its own. Windows Terminal sends keys in
  win32-input-mode; Gluon reads those and plain VT alike. ConPTY re-renders an agent's output and
  keeps some sequences to itself, so the frame may miss an agent's kitty keyboard flags and mouse
  requests, and draws wide characters with ConPTY's widths.
- **Typing in a session is ~50–65 ms slower** than on Linux and macOS (a key crosses two ConPTYs).
  `bun run test:windows perf` holds it to 80 ms at the 95th percentile.
- **Newline in the intake chat:** Windows Terminal takes Alt+Enter (full screen); `ctrl+j` inserts
  a newline. In the legacy console, Alt+Enter works too.
- **Agents installed by npm** are `.cmd` shims. Gluon runs the native exe behind a shim when there is
  one; otherwise it hands the spec over in a private temp file with a one-line prompt naming it, so
  `cmd.exe` never interprets the spec. An argument that still can't pass through `cmd.exe` stops the
  launch, naming the character.
- **Antigravity's context** needs a status line Gluon writes into agy's settings; that writer is
  skipped on Windows, so its context shows `—` there.
- Timed-out and stopped processes are ended with their children (`taskkill /T /F`). The current
  directory is never searched for programs, and system tools run from System32 by full path.
- **SmartScreen / Defender:** `gluon.exe` isn't code-signed, so Windows may warn on first run. Check
  the file against `SHA256SUMS` ([install.md](../getting-started/install.md#verifying-by-hand)) before
  choosing "Run anyway".
- OpenCode has no Windows installer script; `gluon install` offers its npm package. Kimi Code needs
  Git for Windows (its shell). `install.ps1` works in Windows PowerShell 5.1 and PowerShell 7.

## Kimi Code

Supported on glibc Linux; **unsupported on musl** (its installer refuses). It has no explore mode
(its interactive mode ignores an agent file). What has and hasn't been tried against the real service
is in [Kimi Code](../guides/harnesses/kimi-code.md).

## Next steps

- [Install Gluon](../getting-started/install.md): the installers, release files and how to verify a download.
- [Architecture](architecture.md): how the sessions, the frame and the agents fit together.
- [Troubleshooting](../guides/troubleshooting.md): fixes for the problems each platform runs into.

<!-- Keeping this file fresh: update when a platform is added or dropped, when CI's coverage changes (.github/workflows/ci.yml), or when a platform's behaviour changes how Gluon is built, installed or run there. Which suites have run where, with dates, is a maintainer log in docs/contributing/internal.md, not here. Check package.json (the scripts named above) and test/windows-manual-qa.md. -->
