---
title: "Codex"
description: "OpenAI's coding agent in Gluon: the connections it supports, how Gluon launches it, and what to know about it."
sidebar:
  order: 2
---

Codex (the `codex` binary) is OpenAI's harness. It is strong at well-specified implementation work and careful, test-driven changes. Gluon's intake agent can also run on your ChatGPT plan through `codex app-server`.

Vendor docs: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli).

## Connections

| Connection | Supported |
|---|---|
| Subscription | ChatGPT plan, personal use. Gluon offers `codex login`. |
| API key | OpenAI |
| Amazon Bedrock | Yes |
| OpenRouter | Yes |

On an OpenAI key Codex gets a model provider of its own that reads the key, because its built-in one prefers the ChatGPT login. That provider points at OpenAI's own API endpoint. It is the one base URL Gluon sets besides OpenRouter's, and only on this API-key connection. On Bedrock, Codex reaches the models through its own Bedrock provider. See [Connections](../connections.md).

## How Gluon launches it

Gluon starts `codex` in its own pseudo-terminal with the model, the effort and the spec, which follows `--`. For hooks Gluon passes one setting per event on the command line and writes nothing anywhere.

Codex asks once for a "Hooks need review" approval of those hooks. The set is always the same bytes, so you review it once and not again until Gluon changes it on purpose.

Codex reads `AGENTS.md` itself. Gluon tells it to read `CLAUDE.md` or `GEMINI.md` when your repository has one.

## Modes

- **`explore`** starts it in its read-only sandbox, with approvals set to never.
- **`plan`** has no flag in Codex, so Gluon types `/plan` into it once it is up. It works only in Gluon's frame: a direct launch from the command line and a terminal without a pseudo-terminal refuse it.

See [Modes](../modes.md).

## Sessions, cost and context

- **Resume.** Codex makes its own session id, which its hook sends back to Gluon. Without a pseudo-terminal Gluon never sees the id, so that session cannot be resumed.
- **Cost.** From Codex's OpenTelemetry logs, priced at the table's price. An estimate (`~$`): Codex never reports the service tier that was served, so Gluon assumes the one requested.
- **Context.** From the main conversation's last response, over the model's window.

See [Cost and context](../cost-and-context.md).

## Quirks

- Codex uses `ctrl+]` itself, so don't set that as Gluon's home key for it (the [config reference](../../reference/config.md) has the key and its default).
- A ChatGPT account may refuse some models. `gluon doctor` shows Codex's refusal and routing moves on.
- A newer Codex doesn't stop the intake agent on the ChatGPT plan. Gluon turns off every Codex feature it hasn't checked. Anything it can't turn off is a warning in `gluon doctor`, and a Gluon update covers it. If the model still uses a tool of Codex's own, Gluon interrupts the turn and tells it to use Gluon's tools. The tool may already have run by then: Codex runs what needs no approval without asking.

## Next steps

- [Connections](../connections.md): compare a plan, a key, Bedrock and OpenRouter.
- [Modes](../modes.md): why Codex's plan mode needs Gluon's frame.
- [Antigravity](antigravity.md): the next agent.

<!-- Keeping this file fresh: update in the change that alters Codex's entry in src/harnesses.ts (connections, modes, resume, instruction files) or its adapter and telemetry (src/adapters/codex.ts, src/agent/codex.ts, src/telemetry.ts). -->
