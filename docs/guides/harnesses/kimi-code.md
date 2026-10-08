---
title: "Kimi Code"
description: "Moonshot AI's coding agent in Gluon: the connections it supports, how Gluon launches it, and what it cannot do."
sidebar:
  order: 6
---

Kimi Code (the `kimi` binary) is Moonshot AI's harness, on a Moonshot or OpenRouter API key, or the Kimi Code plan. It is good for long agentic coding tasks at a modest price.

Vendor docs: [Kimi Code](https://moonshotai.github.io/kimi-code/en/guides/getting-started.html).

## Connections

| Connection | Supported |
|---|---|
| Subscription | Kimi Code plan, personal use, through `kimi login`. |
| API key | Moonshot AI (its global API, `api.moonshot.ai`), OpenRouter |
| Amazon Bedrock | No |

For an API key, Gluon sets Kimi's own environment model for each launch and writes nothing to Kimi's config. On a Moonshot key it sets no base URL, because Kimi's default is Moonshot's global API; the mainland-China endpoint is not supported, and a `KIMI_MODEL_BASE_URL` of your own is yours, not Gluon's. For the plan, Kimi has no login-status command, so Gluon asks `kimi provider list` (it never reads Kimi's files). A provider with the source `oauth` is the plan. If the answer cannot be read, Gluon shows "sign-in not checked" and still offers the plan's models, so you can launch and sign in with Kimi's own `/login`.

`kimi login` signs in on the region Kimi's installer chose. For a plan on kimi.ai, run `kimi login --region global` yourself.

## How Gluon launches it

Kimi Code takes no prompt on its command line. In every mode Gluon types a brief line (`Read the session brief in <file> and start.`) into it once its composer is up and Kimi Code shows the model it runs (it draws the composer a moment before it has applied the model, and a line sent then draws `Error: LLM not set, send "/login" to login`), so it starts only in Gluon's frame, never when launched straight from the command line. If the line cannot be typed, because you typed first or its input box (or its model line) never showed within 60 seconds, Gluon shows the line in the chat and over the top of the agent's frame until you press Esc. You can then type it yourself.

Gluon sets `KIMI_CODE_NO_AUTO_UPDATE=1` for each launch. Kimi Code reads `AGENTS.md` itself.

## Install

Kimi's installer needs Linux with glibc (it refuses Alpine) or macOS. On Windows it needs Git for Windows, which is Kimi's shell. The installer adds `kimi` to your shell profile's PATH and renames an old Python `kimi-cli` on PATH to `kimi-legacy`. Gluon shows these notes before you choose "Run it".

## Modes

- **`plan`** starts it in its plan mode: writing and editing are limited to the plan file, but its shell still asks.
- **There is no `explore`.** Its interactive mode ignores an agent file, so nothing can make it read-only, and Gluon never starts it in explore. `ctrl+t` skips it while Kimi Code is the highlighted agent; a proposal or an Enter that would start it is refused with the reason, and routing leaves Kimi Code out of an explore session.

See [Modes](../modes.md).

## Sessions, cost and context

- **Resume.** It cannot be resumed from Gluon: Kimi cannot be given a session id at the start, and has no hook that reports its own. Its own `kimi -S` picker resumes by hand.
- **Status.** Its working state and activity do not show in Gluon, since Kimi's hooks live only in its own config, which Gluon never edits.
- **Cost.** From Kimi's own export of the session, which Gluon reads for token counts and deletes at once. On the plan it is Moonshot's API price (`~$`).
- **Context.** `—`. Gluon only knows the window, and tells Kimi that size on an API key.
- **Effort.** Kimi takes an effort only on its own plan's provider. On an API key (Moonshot or OpenRouter) the model is offered without efforts, and Tab and Shift+Tab skip it.

See [Cost and context](../cost-and-context.md).

:::caution
Kimi Code's OpenRouter route is checked live. The Moonshot key route is only tested offline. The plan, macOS and Windows are not covered by tests, and Kimi Code is unsupported on musl. Platform notes: [Platforms](../../concepts/platforms.md#kimi-code).
:::

## Next steps

- [Modes](../modes.md): why there is no explore for Kimi Code.
- [Platforms](../../concepts/platforms.md#kimi-code): where Kimi Code is supported.
- [Connections](../connections.md): compare the plan and the API keys.

<!-- Keeping this file fresh: update in the change that alters Kimi Code's entry in src/harnesses.ts (connections, modes, typed brief, install notes), its usage reading (src/kimi-usage.ts, src/cost/kimi.ts) or its status check (src/status.ts). After a kimi update follow docs/contributing/maintenance.md. -->
