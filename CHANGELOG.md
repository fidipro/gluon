# Changelog

All notable changes to Gluon are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-08

### Added
- Gluon updates itself. At start, at most once a day, it checks for a newer release and by default installs it in the
  background for your next start; `gluon update` does it now and `gluon update --check` only says whether there is one.
  Nothing is installed unless the release's `SHA256SUMS` carries a valid Sigstore signature by the Release workflow on
  `main` (checked by Gluon itself, no `cosign` needed) and the binary matches it. The config key `updates` (`auto`,
  `notify`, `off`) and the variable `GLUON_UPDATES` choose what happens. This contacts `github.com` and Sigstore's
  `tuf-repo-cdn.sigstore.dev`. 1.0.0 has no updater: run the installer once more to get it ([Updating](docs/getting-started/install.md#updating)).
- Pull requests from outside contributors need every commit signed off (`git commit -s`, the Developer Certificate of Origin); CI checks it. See `CONTRIBUTING.md`.

### Changed
- On the ChatGPT plan the intake agent runs on GPT-6.1 Sol (`gpt-6.1-sol`) instead of GPT-6 Luna: step 2 of the default `brain.order`. An order you set yourself is kept.

### Fixed
- The intake agent on the ChatGPT plan works with a codex that doesn't know every feature Gluon turns off: `codex features list` failed with exit code 1 (seen on Windows). Gluon now turns off only the features the installed codex lists, and a failure shows codex's own reason. Codex 0.161 is supported.
- On the ChatGPT plan, a tool of Codex's own that reaches the intake agent's turn (a command, a file change, a web search, a type Gluon doesn't know) stops `codex app-server` at once, and the turn fails saying so.
- The documented tarball install is `bun add -g "$PWD/gluon-<version>.tgz"`: `bun add -g ./gluon-<version>.tgz` failed, because `bun add -g` resolves a relative path against Bun's global directory.

## [1.0.0] - 2026-10-08

First public release.

Gluon is a control platform for coding agents: a terminal app (`gluon`) that runs Claude Code, Codex,
Antigravity, Grok Build, OpenCode and Kimi Code side by side, each on your own API key or your own
subscription.

### Added
- The intake agent: an LLM with read-only access to your repository asks a few questions, writes a spec and
  classifies the session.
- Routing: `routing.yaml` (yours, or the default) turns that classification into an agent, a model and an
  effort, by code and not by the LLM. Sessions start in build, explore or plan mode, and each session in a git
  repository can work in its own worktree and branch.
- Six harnesses, each started in its own UI inside Gluon's frame: start several sessions, switch between them
  and go home with one key. Connections: a subscription, an API key, Amazon Bedrock or OpenRouter, depending on
  the agent.
- Cost and context figures that Gluon calculates itself; what a harness reports about its own cost or window is
  only compared. Price and window tables are built on your machine, never shipped.
- Saved sessions (`gluon sessions`, `gluon resume`), a local history of the sessions you launched
  (`gluon stats`, off with `analytics: off`) and `gluon doctor`, `gluon uninstall` and the other commands in the
  [CLI reference](docs/reference/cli.md).
- Installers and executables for Linux x64 and arm64 (glibc and musl), macOS x64 and arm64 and Windows x64
  (`install.sh`, `install.ps1`), plus an npm-style tarball for machines with Bun. Every release carries
  `SHA256SUMS`, a CycloneDX SBOM and a keyless cosign signature of `SHA256SUMS`; the installers refuse a
  download that does not match.
- Documentation: [getting started](docs/getting-started/install.md), [guides](docs/guides/sessions.md), a
  generated [reference](docs/reference/index.md) and [concepts](docs/concepts/architecture.md).

<!-- Keeping this file fresh: add a line under [Unreleased] for every change a user would notice, and rename that section to the version
when a release is cut (scripts/release-notes.ts prints the section of the release's version as the release notes). Check package.json's version
and docs/getting-started/install.md. -->
