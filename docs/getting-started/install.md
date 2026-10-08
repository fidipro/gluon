---
title: "Install Gluon"
description: "Install Gluon on Linux, macOS, WSL or Windows, verify a download, and uninstall."
---

Gluon ships as one standalone executable per platform (no Bun needed), plus an npm-style
tarball for machines that already have Bun. Every release carries a `SHA256SUMS` file; the
installers refuse to install anything that doesn't match it.

:::note[Installing from a release directory]
The installers can also install from a directory you downloaded or built yourself: point the
installer at it (the release-URL variable, see [Environment variables](../reference/env.md)). To
make one from source, [build a release directory locally](#a-release-directory-built-locally).
:::

## Release files

| File | Platform |
|---|---|
| `gluon-bun-linux-x64` / `gluon-bun-linux-arm64` | Linux, glibc |
| `gluon-bun-linux-x64-musl` / `gluon-bun-linux-arm64-musl` | Alpine and other musl Linux (needs `apk add libstdc++ libgcc`) |
| `gluon-bun-darwin-x64` / `gluon-bun-darwin-arm64` | macOS (signed ad hoc) |
| `gluon-bun-windows-x64.exe` | Windows x64 (unsigned: SmartScreen may ask) |
| `gluon-<version>.tgz` | the npm-style package (Linux / macOS, with Bun) |
| `gluon-<version>.cdx.json` | CycloneDX SBOM |
| `install.sh` / `install.ps1` | the installers of this release |
| `SHA256SUMS` | SHA-256 of every file above |
| `SHA256SUMS.sigstore.json` | keyless cosign signature of `SHA256SUMS` |

The x64 executables need a CPU with AVX2 (2013 or later).

## Linux and macOS: install.sh

```sh
curl -fsSL https://github.com/fidipro/gluon/releases/latest/download/install.sh | sh
```

The installers are release files, listed in the release's `SHA256SUMS`: the one-liner runs the
installer that shipped with the release, not whatever is on a branch. For one version, take the
installer from that release and pin the version too:

<!-- example -->
```sh
curl -fsSL https://github.com/fidipro/gluon/releases/download/v<version>/install.sh | GLUON_VERSION=<version> sh
```

From a release you downloaded:

<!-- example -->
```sh
gh release download v<version> -R fidipro/gluon -D gluon-release
GLUON_RELEASE_URL=./gluon-release sh gluon-release/install.sh
```

`install.sh` picks the file for your OS, CPU and libc, checks it against `SHA256SUMS` (a missing
file, a missing entry or a mismatch stops it with nothing installed), checks the signature when
`cosign` is installed, and installs `~/.local/bin/gluon` (no sudo).

Environment variables choose the release to install, where its files come from (an https URL, a
`file://` URL or a local directory) and the install directory: each is listed, for both installers, in
[Environment variables](../reference/env.md). Downloads need `curl`, run as
`curl --proto '=https' --proto-redir '=https' --tlsv1.2`: https only, redirects included; plain
`http://` is refused. A pinned version must be a version (`1.2.3`, `v1.2.3`) or `latest`, and a relative
install directory is made absolute.

## Windows: install.ps1

```powershell
irm https://github.com/fidipro/gluon/releases/latest/download/install.ps1 | iex
```

From a release you downloaded:

<!-- example -->
```powershell
gh release download v<version> -R fidipro/gluon -D gluon-release
$env:GLUON_RELEASE_URL = "$PWD\gluon-release"
powershell -ExecutionPolicy Bypass -File .\gluon-release\install.ps1
```

A downloaded script doesn't run under Windows' default execution policy, hence
`-ExecutionPolicy Bypass` (for this one run only). `irm … | iex` isn't affected.

Installs `%LOCALAPPDATA%\Programs\gluon\gluon.exe` after the same `SHA256SUMS` check
(`Get-FileHash`). It changes your user PATH only with `-AddToPath` (or its environment variable, which also works with `irm … | iex`); otherwise it
prints the command. The version, release and directory variables work as for install.sh. Windows PowerShell 5.1
and PowerShell 7 both work. Downloads are https only, redirects included (each hop is checked).
Run through `iex`, it leaves your session as it was: no strict mode, preferences or variables
left behind.

The executable isn't code-signed: SmartScreen or Defender may warn the first time it runs.
Check it against `SHA256SUMS` (below) before choosing "Run anyway".

## npm-style package (Linux / macOS, with Bun)

```sh
bun add -g "$PWD/gluon-<version>.tgz"   # downloaded from the release first
```

The package is one bundled file (`gluon.js`, no dependencies) plus its grep worker. Its bin runs
`#!/usr/bin/env -S bun --no-env-file --config=/dev/null`, so `bun` must be on your PATH, and `env`
must support `-S`: GNU coreutils and macOS do; on Alpine, `apk add coreutils` (BusyBox `env` has no
`-S`). It doesn't run on Windows: use the `.exe` there. The package is marked `"private": true`, so
it can't be published to a registry by accident.

## A release directory built locally

To install without a published release, build one from a clone of the repository the way `bun run docker-test` stages it
(Linux shown; [CONTRIBUTING.md](../../CONTRIBUTING.md) has the setup, including Bun). Clone it first:

<!-- example -->
```sh
git clone https://github.com/fidipro/gluon gluon && cd gluon
bun install
bun run build                                  # this machine's executable in dist/ (build:all: every target)
mkdir -p gluon-release
cp dist/gluon-bun-* install.sh install.ps1 gluon-release/
(cd gluon-release && sha256sum -- * > SHA256SUMS)
GLUON_RELEASE_URL=./gluon-release sh gluon-release/install.sh
```

A macOS binary cross-built on another OS must be signed on a Mac (`codesign --sign - <file>`)
before it runs there.

## Verifying by hand

Checksums (in the directory holding the downloads):

<!-- example -->
```sh
sha256sum --ignore-missing -c SHA256SUMS          # Linux
shasum -a 256 --ignore-missing -c SHA256SUMS      # macOS
```

```powershell
(Get-FileHash .\gluon-bun-windows-x64.exe -Algorithm SHA256).Hash.ToLower()
Select-String gluon-bun-windows-x64.exe .\SHA256SUMS
```

Signature (`SHA256SUMS.sigstore.json`, on every release), with
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 2.4 or later (cosign 2 needs `--new-bundle-format` added to the command; cosign 3 needs nothing):

<!-- example -->
```sh
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity https://github.com/fidipro/gluon/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A good signature means `SHA256SUMS` was produced by the Release workflow on `main` of
`fidipro/gluon`; the checksum check then ties each file to it. Keyless signing records the
repository and workflow in Sigstore's public transparency log.

## Uninstall

<!-- example -->
```sh
gluon uninstall          # asks first; --yes to skip the question
```

It refuses while a Gluon is running: it names that Gluon's process and removes nothing (a running Gluon would write its saved session back). Quit it and run the command again. Otherwise it removes the config file, the saved API keys and saved sessions (`workspaces/`) next to it, Gluon's files in the agents'
directories (and Antigravity's `statusLine` key, if Gluon set it), the cost audit ledger (`<state>/gluon/cost-audit`) and the
price tables Gluon built (`<state>/gluon/tables`), the local analytics database (`<state>/gluon/analytics.db` with its `-wal` and `-shm`), and its temporary directories, then the config directory if it's the default one and
empty (never a directory a custom config path points into). On Linux and macOS it also deletes a
standalone binary. What it can't remove, it prints:

- npm install: `bun remove -g gluon`
- Windows: `Remove-Item "$env:LOCALAPPDATA\Programs\gluon" -Recurse`, and take the directory out
  of your user PATH if you added it (`-AddToPath`).

By hand, without Gluon: delete the binary, `${XDG_CONFIG_HOME:-$HOME/.config}/gluon`
(`$env:APPDATA\gluon` on Windows), `${XDG_STATE_HOME:-$HOME/.local/state}/gluon` (the ledger, the
tables and the analytics database; `$env:LOCALAPPDATA\gluon` on Windows) and Gluon's hooks file in Grok Build's hooks directory
(`~/.grok/hooks/gluon.json`, or under `$GROK_HOME`).

## Next steps

- [Quickstart](quickstart.md): run Gluon in a repository and start your first session.
- [Connect your agents](connect-agents.md): install the coding agents and connect each one with a key or a plan.
- [Platforms](../concepts/platforms.md): what is tested where, and the notes for each platform.

<!-- Keeping this file fresh: update in the change that alters install.sh, install.ps1, the release files (scripts/build.ts, .github/workflows/release.yml) or verification. Release status lives only on this page. -->
