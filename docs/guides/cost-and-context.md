---
title: "Cost and context"
description: "How Gluon counts each session's cost and context use, what the markers mean, and how an agent's own figures are only compared."
---

Every session row shows two figures: what the session has cost and how full the model's context window is. Both are Gluon's own. Gluon counts each request the agent reports against price and window tables it builds on your machine. The agent's own figures are only compared with Gluon's, not shown.

## Read the figures

**Cost** is a running total in dollars. A prefix or suffix says how reliable it is:

| Shown | Meaning |
|---|---|
| `$0.38` | Counted by Gluon from the agent's requests and a price it knows. |
| `~$1.12` | An estimate: a plan's API-equivalent price, a figure that needed an assumption (Codex's service tier, for example), or an OpenRouter session's running figure. |
| `$4.12*` | The agent's own total, standing in for a model Gluon has no price for. |
| `$4.12✓` | What OpenRouter billed the session. See below. |
| `—` | Unknown, or the agent reports none. |

**Context** is a percentage of the model's window, counted the way the agent's own display counts it. It shows `—` when unknown, for example after a `/compact` until the next request.

## Where each agent's figures come from

Gluon never exports prompts, responses or tool content. Only the figures are kept.

- **Claude Code, Codex and Grok Build** report each request through their OpenTelemetry export to a listener on `127.0.0.1`. Gluon sets it up for the launch. If your environment has telemetry settings of its own, a note says so and the figures show `—`.
- **OpenCode** reports through a plugin that follows OpenCode's own events.
- **Kimi Code** has no telemetry Gluon may set. Gluon asks the official binary to export the session after it exists, reads the token counts from it in memory and deletes the export at once. It refreshes about every 30 seconds and when Kimi exits. On the plan, the cost is Moonshot's API price (`~$`). Kimi shows no context percentage.
- **Antigravity shows context only.** The context comes from its status line, which needs `cost.antigravity_statusline: on` in the config and does not work on Windows. Its cost is `—`: it reports none, and the token totals its status line holds are the conversation's size, not what the requests billed. A per-request source is not available yet.

How the figures fit together is in [Architecture](../concepts/architecture.md) ("Status, cost and context"); each harness's assumptions are named in the header comment of its file under `src/cost/`, and `gluon cost-report` shows them for your sessions. Where a price comes from is in [Pricing sources](../reference/pricing-sources.md).

## What OpenRouter billed

OpenRouter bills each request at the provider that served it, so Gluon cannot know the exact price while the session runs. It shows a `~$` running figure. After the session ends, Gluon reads the key's usage before and after and says in the chat, a minute or so later, what OpenRouter billed. The cost then shows `$4.12✓`.

:::caution
Use an OpenRouter key that only Gluon uses. The billed figure means something only if nothing else spends on the key. Two Gluon sessions at once on one key get no figure, and Gluon says so. The intake agent on the same OpenRouter key is not part of a session: its replies' exact cost (OpenRouter reports it with each reply) is taken off the session's figure. This holds for an intake agent in another Gluon window on the same key too. If a reply's cost is not known, for example after an error, a stopped answer or a request the network library had to repeat, the session shows the estimate (`~`) and says so.
:::

## Compare with the agent's own figures

`gluon cost-report` shows what Gluon's own figures were audited against, with no model calls. Gluon keeps an audit ledger of its figures next to the agents' own, to find differences. Set `cost.audit: off` in the config to keep no ledger. The figures are unaffected. `gluon uninstall` removes the ledger.

## Price tables

No price table ships with Gluon. It builds its own on your machine: when it starts and when an agent launches, in the background, from models.dev, OpenRouter and your installed agents, and keeps them in its state directory. Offline, it keeps the last ones. `gluon pricing update` does the same in the foreground and says what changed. `gluon cost-report` shows which tables priced a session. There is no switch to turn the refresh off.

## Next steps

- [Sessions](sessions.md): the rest of what a row shows.
- [Connections](connections.md): the OpenRouter key and what each connection reports.
- [Pricing sources](../reference/pricing-sources.md): where each price table comes from.

<!-- Keeping this file fresh: update in the change that alters how a figure is counted or marked (src/cost/, src/telemetry.ts, src/kimi-usage.ts, src/openrouter-billed.ts, src/adapters/) or the cost config keys (src/config.ts). The per-agent detail lives in docs/concepts/architecture.md ("Status, cost and context"). -->
