**Gluon** is a control platform for coding agents: run Claude Code, Codex, Antigravity, Grok Build, OpenCode and Kimi Code side by side in one terminal frame, on your own API keys or subscriptions.

Gluon enables two things:

1. **Choosing the most cost-effective agent for each session, within one harness or across several.** An agent is a harness × model × effort. Gluon works out a spec with you, then routes with configurable rules.
2. **Managing your agents' sessions**, with cost and context observability and analytics.

<p align="center"><a href="docs/concepts/manifesto.md">Read our manifesto</a></p>

<p align="center">
  <a href="https://github.com/fidipro/gluon/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/fidipro/gluon/ci.yml?label=CI"></a>
  <a href="https://github.com/fidipro/gluon/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/fidipro/gluon?label=release"></a>
  <img alt="license: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue">
  <img alt="platforms: Linux, macOS, Windows" src="https://img.shields.io/badge/platforms-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-blue">
</p>

<p align="center"><img alt="Gluon's start screen: the six agents ready, and a prompt asking what you are building" src="docs/images/gluon-start.png" width="865"></p>

---

## Quickstart

### Install

> These install the [latest release](https://github.com/fidipro/gluon/releases/latest). To verify a download or install from a
> directory, see [docs/getting-started/install.md](docs/getting-started/install.md).

Linux, macOS, WSL:

```sh
curl -fsSL https://github.com/fidipro/gluon/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/fidipro/gluon/releases/latest/download/install.ps1 | iex
```

<details>
<summary>With Bun, or from source</summary>

Download the npm-style tarball `gluon-<version>.tgz` from the release, then `bun add -g ./gluon-<version>.tgz` (Linux, macOS). To build from a checkout, see [CONTRIBUTING.md](CONTRIBUTING.md).
Checksums, cosign and every installer option: [docs/getting-started/install.md](docs/getting-started/install.md).

</details>

### Run `gluon` in your repo

```sh
cd your-repo && gluon
```

Describe what the session is for. The intake agent reads your repo, asks a few questions and proposes an agent, model and effort with a spec. Enter starts the session in the agent's own UI, inside Gluon's frame; go home with one key and start more. First run walks you through [connecting your agents](docs/getting-started/connect-agents.md); the full tour is the [quickstart](docs/getting-started/quickstart.md).

- **Agents:** Claude Code, Codex, Antigravity, Grok Build, OpenCode, Kimi Code; one guide each in [docs/guides/harnesses/](docs/guides/harnesses/).
- **Platforms:** Linux, macOS, Windows; what is tested where is in [docs/concepts/platforms.md](docs/concepts/platforms.md).

## Docs

- [**Overview**](docs/index.mdx)
- [**Getting started**](docs/getting-started/install.md): [install](docs/getting-started/install.md), [quickstart](docs/getting-started/quickstart.md), [connect your agents](docs/getting-started/connect-agents.md)
- [**Guides**](docs/guides/): sessions, routing, cost and context, analytics, security and privacy, troubleshooting
- [**Reference**](docs/reference/index.md): CLI, config, `routing.yaml`, environment, models (generated)
- [**Concepts**](docs/concepts/architecture.md): [architecture](docs/concepts/architecture.md), [platforms](docs/concepts/platforms.md), [manifesto](docs/concepts/manifesto.md)
- [**Contributing**](CONTRIBUTING.md) · [**Security**](SECURITY.md) · [**Changelog**](CHANGELOG.md) · [**Support**](SUPPORT.md) · [**Code of conduct**](CODE_OF_CONDUCT.md)

`bun run docs:dev` serves the docs site locally.

## License

This repository is licensed under the [Apache-2.0 License](LICENSE). Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

<!-- Keeping this file fresh:
Update when the install one-liners, the supported agents or platforms, the docs layout or the licence status change.
Keep it a landing page of at most 104 lines (test/readme.test.ts): detail lives in docs/, status only in
docs/concepts/platforms.md and docs/getting-started/install.md. The one-liners are checked by test/release.test.ts.
-->
