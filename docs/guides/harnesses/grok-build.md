---
title: "Grok Build"
description: "xAI's coding agent in Gluon: the connections it supports, how Gluon launches it, and what to know about it."
sidebar:
  order: 4
---

Grok Build (the `grok` binary) is xAI's harness on Grok. It is a quick, capable generalist and good value for everyday coding tasks.

Vendor docs: [Grok Build](https://docs.x.ai/build/overview).

## Connections

| Connection | Supported |
|---|---|
| Subscription | SuperGrok or X account, personal use. Gluon offers `grok login`. |
| API key | xAI |
| Amazon Bedrock | No |
| OpenRouter | No |

On a key connection Gluon points Grok Build at an empty login file so it uses `XAI_API_KEY` and never touches your Grok login. That setting is undocumented by xAI.

OpenRouter is not offered: Grok Build has no setting for another provider's endpoint that works without a grok.com sign-in, and a signed-in login could end up sent to that endpoint (issue #109). Its custom-models endpoint (`GROK_MODELS_BASE_URL`) still asks for the sign-in, so it is not used. This is worth rechecking after a Grok Build update.

## How Gluon launches it

Gluon starts `grok` in its own pseudo-terminal with the model, the effort and the spec after `--`. It starts under an id Gluon makes and is reopened with it, so `gluon resume` works.

Grok Build reads `AGENTS.md` and `CLAUDE.md` itself. Gluon tells it to read any other instruction file the repository has.

Grok Build's installer never edits your shell profile, so a fresh install may not be on your PATH. See [Troubleshooting](../troubleshooting.md#an-agent-is-not-installed-right-after-installing-it).

## Modes

Grok Build's interface ignores the permission flag, so a mode is not a flag.

- **`explore`** starts it in its read-only sandbox with `Edit`, `Write` and `Bash` denied. It can read, search and list files but run no shell commands. Denying is what stops the prompts.
- **`plan`** has no flag, so Gluon types `/plan` into it once it is up. It works only in Gluon's frame: a direct launch from the command line and a terminal without a pseudo-terminal refuse it.

See [Modes](../modes.md).

## Sessions, cost and context

- **Status and compaction.** Gluon keeps one hooks file in Grok Build's hooks directory. It holds the same bytes on every machine, does nothing unless the launch comes from Gluon, and `gluon uninstall` removes it. It lets the sessions list show Grok Build's state and lets Gluon ask before an auto-compaction.
- **Cost.** From its OpenTelemetry export, priced from Grok's own table. A plan is priced as the API (`~$`).
- **Context.** From the last main request, over the window in Grok's table. Unknown while a subagent runs, and after a compaction.

See [Cost and context](../cost-and-context.md).

## Next steps

- [Modes](../modes.md): explore without a shell, and plan through `/plan`.
- [Cost and context](../cost-and-context.md): how Grok Build's figures are counted.
- [OpenCode](opencode.md): the next agent.

<!-- Keeping this file fresh: update in the change that alters Grok Build's entry in src/harnesses.ts (connections, modes, resume, instruction files), its hooks file (src/adapters/permanent.ts, src/adapters/grok-build.ts) or its telemetry (src/otlp-protobuf.ts, src/cost/). -->
