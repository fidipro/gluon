---
title: "OpenCode"
description: "The open-source coding agent in Gluon: the OpenCode Go plan and OpenRouter, how Gluon launches it, and what to know about it."
sidebar:
  order: 5
---

OpenCode (the `opencode` binary) is an open-source harness that runs on OpenRouter or the OpenCode Go plan. It is good for well-scoped tasks when an open or cheaper model is enough. Gluon supports OpenCode 2 and refuses an older major version.

Vendor docs: [OpenCode 2](https://opencode.ai/v2/docs).

## Connections

OpenCode is the one agent that takes several connections at once.

| Connection | Supported |
|---|---|
| API key | OpenRouter |
| Subscription | The OpenCode Go plan, personal use. Gluon runs `opencode auth login opencode-go`. OpenCode asks for the plan's key and keeps it itself, and Gluon only asks `opencode auth list` whether one is stored. |
| Amazon Bedrock | No |

You can connect the plan and OpenRouter together. The plan comes first: it is prepaid, so a model that both serve goes through it. See [Connections](../connections.md).

## How Gluon launches it

Gluon starts `opencode` in its own pseudo-terminal with its own server (`--standalone`), because the shared background server would not see a launch's key. OpenCode 2's interface takes no model flag, so Gluon passes the model and its effort in OpenCode's inline config for that launch. Nothing is written to its config or your repository.

OpenCode reads `AGENTS.md` itself. Gluon tells it to read any other instruction file.

On Windows OpenCode 2 has no installer script, so Gluon offers the official npm package. See [Connect your agents](../../getting-started/connect-agents.md) for how installs are offered.

## Modes

- **`explore`** starts it in an agent that may only read: no edit, shell, subagent or outside directory. Top-level permissions back this up in case OpenCode restores a previous tab's agent.
- **`plan`** starts it in its `plan` agent.

See [Modes](../modes.md).

## Sessions, cost and context

- **Resume.** OpenCode makes its own session id, which Gluon's plugin sends back, so `gluon resume` works. Without a pseudo-terminal Gluon never sees the id.
- **Plugin.** For `/gluon`, the sessions list's status and the cost figures, Gluon loads a small plugin for this launch only, through OpenCode's inline CLI config.
- **Cost and context.** From that plugin following OpenCode's own events, with no telemetry. Every step is priced by itself, at the model that step reports, so a model you switch to by hand is priced as itself (a free one at $0). A model Gluon has no price for is not priced at the launched model: the figure then falls to the agent's own total, marked `*`, or `—`. Context is the main session's last step over the model's window.

See [Cost and context](../cost-and-context.md).

## Quirks

- One cheaper Muse Spark variant sends the session's code and prompts to its maker. It is never offered unless `allow_muse_contributor` is `true` in your [routing.yaml](../routing.md).
- OpenCode's permission selector (Allow once, Allow always, Reject) is normally driven by `←` and `→`, but with two or more sessions open those keys switch Gluon's sessions while your line is empty. Use `tab` to move through the options (`enter` picks); the home key's menu still switches sessions.
- OpenCode has no hook that can wait before an auto-compaction, so Gluon cannot ask first about that one. A typed `/compact` still asks.

## Next steps

- [Connections](../connections.md): how the plan and OpenRouter work together.
- [Routing](../routing.md): the opt-in for the cheaper variant.
- [Kimi Code](kimi-code.md): the next agent.

<!-- Keeping this file fresh: update in the change that alters OpenCode's entry in src/harnesses.ts (connections, modes, resume, minimum version) or its plugin (src/adapters/opencode.ts, src/cost/). -->
