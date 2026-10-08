---
title: "Security and privacy"
description: "What Gluon sends where, how it stores your keys, and how it protects you from a hostile repository."
---

Gluon holds your API keys and runs inside repositories you did not write, so it keeps tight limits on what it reads, sends and runs. This page lists them. To report a vulnerability, see [SECURITY.md](../../SECURITY.md).

## What is sent where

The intake agent's provider, the one step of `brain.order` in use, receives:

- what you type in its chat and your answers,
- the repository's path, branch and top-level file names,
- what the intake agent reads or searches.

Repository content goes nowhere else. Gluon has no telemetry of its own: the agents' cost and context figures go only to a listener on `127.0.0.1`. The agent you launch works under its own vendor's rules.

Gluon also builds its price and window tables on your machine: plain unauthenticated requests to `models.dev` and `openrouter.ai` with nothing of yours in them, at start and at an agent launch (at most every 10 minutes), which cannot be turned off. See [Pricing sources](../reference/pricing-sources.md).

## Secret files stay out

The intake agent's tools are read-only and stay inside the repository. They cannot read or search secret files, or see their diffs, including through symlinks. That covers:

- `.env*`, except `.env.example`, `.env.sample` and `.env.template`,
- keys, certificates and key stores (`*.pem`, `*.key`, `*.ppk`, `*.p8`, `*.jks`, `*.kdbx`, `id_rsa` and the other SSH keys, `_sk` ones too),
- credential stores: `.npmrc`, `.netrc` and `_netrc`, `.pgpass`, `.git-credentials`, `.pypirc`, `.dockercfg`, `.docker/config.json`, `credentials` and `credentials.json`,
- infrastructure secrets: Terraform state and variables (`*.tfstate`, `*.tfvars`, `*.tfvars.json`), `service-account*.json`, `client_secret*.json`, `kubeconfig`, `.kube/config`, `secrets.yaml`, `secrets.yml` and `secrets.json`,
- `.git/config`, whose remote URLs can carry a token.

The same file under another spelling is refused too: another case, a Windows alternate data stream (`id_rsa::$DATA`), trailing dots or spaces, a Windows 8.3 short name. What the tools return is capped: a line at 300 characters (2000 in `read_file`), a result at 64 000 (`read_file` says where it cut).

The intake agent cannot write, run a shell or leave the repository. It can read issues and pull or merge requests of GitHub and GitLab through your own `gh` or `glab`, read-only, on github.com and gitlab.com (the CLI is told that host, whatever `GH_HOST` or `GITLAB_HOST` your environment holds, so a repository's `origin` cannot name a repository on your company's instance; a `GITLAB_TOKEN` meant for another GitLab host is not passed on).

## Your keys

- **Where they live.** API keys you save through Gluon go to `.env` next to the config. On Linux and macOS it is readable only by you (mode 600). On Windows it is in your profile and readable by your account and administrators, or, for a config outside your profile, limited to your account and administrators (icacls).
- **In memory only.** Gluon keeps saved keys out of its own environment.
- **Only to their provider.** The intake agent's own clients on an OpenAI, Anthropic or Bedrock key use the provider's endpoint, not `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL` or `AWS_ENDPOINT_URL*` from your environment; your variables stay as they are. `ANTHROPIC_AUTH_TOKEN` is not sent next to the key, and on OpenRouter your OpenAI organization and project ids and `OPENAI_CUSTOM_HEADERS` stay home. `ANTHROPIC_CUSTOM_HEADERS`, `OPENAI_CUSTOM_HEADERS` and `AWS_BEARER_TOKEN_BEDROCK` are left alone on their own provider; `gluon doctor` and a notice at start tell you they are set.
- **Into an agent.** A launched agent's environment is yours, plus only the saved key of the provider its model runs on.
- **In output.** Keys and tokens are masked in everything Gluon prints, and in the specs it saves: by name and by shape (vendor tokens, a password in a URL, `password=`-style values, private key blocks). A masked value keeps at most its prefix. A config directory Gluon creates is 0700 and `config.yaml` is 0600, whatever your umask.

## Subscriptions

Subscriptions are opt-in and for you alone, on your machine. Only the vendor's own program signs you in or checks the login. Gluon never reads a credential file or keychain, never adds a login token to an agent's environment, and never points a subscription at another server. See [Connections](connections.md#use-a-subscription).

## Hostile repositories

- Gluon never loads the `.env` or `bunfig.toml` of the directory it runs in.
- It never runs a binary from the repository. Programs are found on PATH and run by absolute path. On Windows the current directory is not searched.
- It runs status checks, logins and installers in an empty private directory.
- Git runs on the repository with its hooks, filters and external programs switched off.

The details are in [Architecture](../concepts/architecture.md#running-in-an-untrusted-repository).

## What Gluon watches and writes

Your keys and the agents' screens stay in Gluon's memory. Gluon watches a screen only for its own keys and a typed `/clear` or `/compact`. The screen alone never triggers anything, and when Gluon is unsure, it forwards your key.

Into an agent Gluon writes only:

- your keys,
- its terminal's answers to the agent's own queries,
- your mouse reports,
- one `/plan …` line it made for the launch, to start Codex or Grok Build in plan mode,
- for Kimi Code, which takes no prompt on its command line, the one line `Read the session brief in <file> and start.`

## Saved sessions

Saved sessions (`workspaces/` next to the config, one file each, readable only by you like the keys) hold each session's name, agent, model, effort, directory, the spec it started with (keys masked) and the agent's session id. They never hold the chat with the intake agent, a key, or what an agent's screen showed. `gluon uninstall` removes them.

## Session analytics

Gluon keeps a local history of the sessions it launches: one row each in `analytics.db` in its state directory (private to you, like the saved sessions). A row holds the spec the session was given (keys masked), the repository's path, the agent and model, the agent's session id, the times and the cost. Unlike the cost audit ledger, it holds a prompt and a path. It never holds a key or what an agent's screen showed, and it is never sent anywhere. It is on by default: `analytics: off` in the config stops it, `gluon stats` can empty it and `gluon uninstall` removes it. See [Your history](sessions.md#your-history).

## Installers

An agent's installer runs only when you pick "Run it" on the exact command shown, pressed on its own. A paste or keys typed ahead do not count. No option skips that question, and Gluon never uses sudo.

Gluon's own installers check the download against the release's `SHA256SUMS` and install nothing that does not match. See [Install Gluon](../getting-started/install.md#verifying-by-hand).

## Updates

Gluon updates itself: at start it asks `github.com` for the latest release (once a day while it is up to date, at each start while an update is pending), and by default (`updates: auto`) installs a newer one in place of the standalone binary, for your next start. The requests are plain and unauthenticated, with nothing of yours in them: to `github.com` and the hosts it serves release files from, and to Sigstore's `tuf-repo-cdn.sigstore.dev` for its trusted root. Nothing is installed unless the release's `SHA256SUMS` carries a valid Sigstore signature by this repository's release workflow on `main`, and the downloaded binary matches it. `updates: notify` only tells you a release exists, `updates: off` never checks, and an environment variable can override the config ([Environment variables](../reference/env.md)). See [Updating](../getting-started/install.md#updating).

## Next steps

- [Connections](connections.md): subscriptions, keys and what a launched agent's environment gets.
- [Architecture](../concepts/architecture.md): how the protections against an untrusted repository work.
- [SECURITY.md](../../SECURITY.md): the policy and how to report a vulnerability.

<!-- Keeping this file fresh: update in the change that alters a security guarantee: what the intake agent sends or may read (src/agent/), how keys are stored or passed (src/secrets.ts, src/config.ts, src/launchers.ts), what is written into an agent (src/pty/), what the analytics database stores (src/analytics.ts), what the updater fetches and installs (src/update/), or how a hostile repository is handled (src/detect.ts, src/agent/git.ts). Keep it equal to SECURITY.md. -->
