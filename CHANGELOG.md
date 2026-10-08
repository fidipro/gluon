# Changelog

All notable changes to Gluon are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
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
