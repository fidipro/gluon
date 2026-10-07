---
title: "Troubleshooting"
description: "Fixes for the common problems: agents not found on PATH, WSL, Windows keys and warnings, Alpine, and a config Gluon cannot write."
---

Start with `gluon doctor`. It checks each agent (installed, version, signed in), every model of every connection and every intake agent step, and says why something fails.

:::caution
`gluon doctor` checks for real, so it makes tiny billable calls. On a plan they count toward its usage.
:::

## An agent is "not installed" right after installing it

The installer put it in a directory that is not on your PATH yet. Grok Build's installer never edits your shell profile, and the others do not on every system. `gluon install` names the directory. Add it to your PATH, or open a new terminal if the installer already did.

## WSL says "a Windows install of … was found"

A Windows agent, under `/mnt/c/…`, cannot run inside WSL. Install the agent inside WSL with `gluon install`. A Linux install anywhere on PATH wins over a Windows one, and Gluon never runs the Windows one. See [Platforms](../concepts/platforms.md#wsl).

## The binary will not start on Alpine

Run `apk add libstdc++ libgcc`. The npm-style package also needs a full `env`, so run `apk add coreutils` for it. Kimi Code is not supported on musl systems like Alpine: its installer refuses them.

## Alt+Enter goes full screen on Windows

Windows Terminal takes Alt+Enter. Use `ctrl+j` for a newline in the intake chat.

## SmartScreen or Defender warns about gluon.exe

The executable is not code-signed yet. Check its checksum against `SHA256SUMS` (see [Install Gluon](../getting-started/install.md#verifying-by-hand)), then choose "More info" and "Run anyway".

## There is nothing to scroll back after quitting

Gluon draws on the alternate screen, so the agents' output is not in your terminal's scrollback. While a session is open, scroll inside the frame with the wheel or Shift+PgUp. See [Keyboard and mouse](keyboard.md#inside-a-session).

## A figure shows a dash

A dash means Gluon does not know. Antigravity shows no cost by design, a context figure is unknown after a compaction until the next request, and your own telemetry settings can make Claude Code, Codex and Grok Build show a dash. See [Cost and context](cost-and-context.md).

## Gluon cannot write the config

A config Gluon cannot write, for example a read-only one managed by a dotfile manager, is left alone with a warning. Checks and choices then last for that run only.

## Get more help

If this does not fix it, see [SUPPORT.md](../../SUPPORT.md) for where to ask, and run `gluon doctor` first so you can say what it showed.

## Next steps

- [Connect your agents](../getting-started/connect-agents.md): redo a connection that fails its check.
- [Platforms](../concepts/platforms.md): notes for each system.
- [Install Gluon](../getting-started/install.md): verify a download, or install without a release.

<!-- Keeping this file fresh: update in the change that adds, fixes or removes a known problem or its workaround: install and PATH handling (src/install.ts, src/detect.ts), the Windows and WSL notes (docs/concepts/platforms.md), the installers (install.sh, install.ps1) or `gluon doctor` (src/doctor.ts). -->
