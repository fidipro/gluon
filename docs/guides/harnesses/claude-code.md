---
title: "Claude Code"
description: "Anthropic's coding agent in Gluon: the connections it supports, how Gluon launches it, and what to know about it."
sidebar:
  order: 1
---

Claude Code (the `claude` binary) is Anthropic's own harness. It is a strong general coding agent, best for multi-file features, debugging and refactors. It is also the one Gluon's intake agent can run through, on your Claude plan.

Vendor docs: [code.claude.com](https://code.claude.com/docs/en/setup).

## Connections

| Connection | Supported |
|---|---|
| Subscription | Claude plan, personal use. Gluon runs `claude auth status` and offers `claude auth login`. |
| API key | Anthropic |
| Amazon Bedrock | Yes |
| OpenRouter | Yes |

On an Anthropic key, Claude Code asks you itself when it sees the key. On OpenRouter, Gluon sets OpenRouter's documented endpoint for the launch, on an API-key connection only. See [Connections](../connections.md) for how the ways in compare.

## How Gluon launches it

Gluon starts `claude` in its own pseudo-terminal with the model, the effort and the spec. The spec follows `--` so one that starts with a dash stays a value.

For the status line, the cost figures and the questions at `/clear` and `/compact`, Gluon loads a small plugin of its own for this launch only. It is never installed, and nothing is written to your settings or workspace. Its hooks also tell Gluon when a session is working, waiting for you (a permission, a question, a plan to approve, an MCP dialog) or done with its turn, even when the turn ended in an API error. They run only once you have trusted the folder in Claude Code's own dialog.

Claude Code reads `CLAUDE.md` from your repository, and `AGENTS.md` only when there is no `CLAUDE.md`. Gluon tells it to read the other one.

## Modes

- **`explore`** starts it in a read-only permission mode with its write tools, plan mode and worktrees removed.
- **`plan`** starts it in its own plan mode.
- **Permissions.** In build mode `ctrl+p` sets accept edits or auto (Claude Code's own permission modes) for a session; its own start mode is the default.

See [Modes](../modes.md).

## Sessions, cost and context

- **Resume.** Gluon starts it under an id it makes and reopens it with that id, so `gluon resume` works.
- **Cost and context.** From its OpenTelemetry export to a listener on `127.0.0.1`, priced from Claude Code's own catalog. If your environment has telemetry settings of its own, both show `—`. See [Cost and context](../cost-and-context.md).
- **`/gluon`.** Typing it in Claude Code shows Gluon's home view.

## Quirks

- Gluon's intake agent can run on your Claude plan through your own `claude`. Its questions count toward your plan's usage. Nothing it does is saved to Claude Code's history.
- Claude Code asks you to trust a folder the first time you use it there. Trust it for Gluon's hooks to work.

## Next steps

- [Connections](../connections.md): compare a plan, a key, Bedrock and OpenRouter.
- [Modes](../modes.md): what explore and plan do for each agent.
- [Codex](codex.md): the next agent.

<!-- Keeping this file fresh: update in the change that alters Claude Code's entry in src/harnesses.ts (connections, modes, resume, instruction files) or its adapter (src/adapters/claude-code.ts, src/cost/claude.ts). Facts about the install and the vendor's docs come from the same entry. -->
