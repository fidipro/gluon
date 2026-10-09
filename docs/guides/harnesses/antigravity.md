---
title: "Antigravity"
description: "Google's coding agent in Gluon: the connections it supports, how Gluon launches it, and what to know about it."
sidebar:
  order: 3
---

Antigravity (the `agy` binary) is Google's harness, built on Gemini. It is fast and cheap, and good for well-scoped edits and quick fixes.

Vendor docs: [antigravity-cli](https://github.com/google-antigravity/antigravity-cli).

## Connections

| Connection | Supported |
|---|---|
| Subscription | Google account, personal use. Antigravity signs in from its own screen: sign in there, then quit it with `ctrl+c` to come back to Gluon. |
| API key | Gemini API, with a condition below |
| Amazon Bedrock | No |
| OpenRouter | No: Antigravity speaks only Gemini's own API, and OpenRouter has no endpoint for it. |

:::caution
Antigravity uses `GEMINI_API_KEY` only when its own settings say `modelProvider: gemini`. Gluon never edits another tool's settings. It tells you what to set, and you set it in Antigravity's `settings.json`.
:::

## How Gluon launches it

Gluon starts `agy` in its own pseudo-terminal. The model and effort go in one option, because Antigravity's model ids carry the effort. The spec goes in a prompt option written with `=`, so a spec that starts with a dash stays a value.

Antigravity reads `AGENTS.md` and `GEMINI.md` itself. Gluon tells it to read `CLAUDE.md` when your repository has one.

## Modes

Antigravity has no read-only mode, only plan mode and accept-edits. So:

- **`explore`** starts it in its plan mode, and the row says `explore (plan mode)`.
- **`plan`** starts it in its plan mode.
- **Permissions.** In build mode `ctrl+p` sets accept edits (edits only; commands still ask) or never ask (every request approved).

See [Modes](../modes.md).

## Sessions, cost and context

- **Resume.** It cannot be resumed: it has no hooks, and its `--continue` would take the newest session in the directory. A saved Antigravity session is offered to start again from its spec.
- **Cost.** `—` always. Antigravity reports no cost, and the token totals in its status line are the conversation's size, not what requests billed. A per-request source is not available yet.
- **Context.** Shown only when you turn on `cost.antigravity_statusline` in the config. Gluon then sets one key, `statusLine`, in Antigravity's own settings file. It touches nothing else, never writes through a symlink or over a status line of your own, and `gluon uninstall` removes only that key. It does not work on Windows, where context shows `—`.

See [Cost and context](../cost-and-context.md).

## Next steps

- [Connections](../connections.md): why Antigravity needs its own setting for a key.
- [Cost and context](../cost-and-context.md): what Antigravity shows and why.
- [Grok Build](grok-build.md): the next agent.

<!-- Keeping this file fresh: update in the change that alters Antigravity's entry in src/harnesses.ts (connections, modes, instruction files) or its status-line handling (src/adapters/antigravity.ts, src/adapters/agy-settings.ts, the cost.antigravity_statusline key in src/config.ts). -->
