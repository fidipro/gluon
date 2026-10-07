---
title: "Connections"
description: "Subscription, API key, Amazon Bedrock or OpenRouter: how each agent reaches its models, where keys and config live, and which models Gluon offers."
---

A connection is how one agent reaches a model: through your own subscription, or through a provider's API key. You choose it per agent in [setup](../getting-started/connect-agents.md) and can change it with `gluon connect`. This page compares the ways in, says where keys and settings live, and explains which models Gluon offers on each.

## Compare the ways in

| Connection | What it is | Agents that take it |
|---|---|---|
| Subscription | Your own plan, signed in through the agent's own login. Personal use only. | Claude Code (Claude plan), Codex (ChatGPT plan), Antigravity (Google account), Grok Build (SuperGrok or X account), OpenCode (OpenCode Go plan), Kimi Code (Kimi Code plan) |
| API key | A key for the model's own provider: Anthropic, OpenAI, Gemini API, xAI, Moonshot AI | Claude Code, Codex, Antigravity, Grok Build, Kimi Code |
| Amazon Bedrock | Your AWS profile and region, never credentials saved by Gluon | Claude Code, Codex |
| OpenRouter | One OpenRouter key for models of other makers | Claude Code, Codex, OpenCode, Kimi Code |

Each [agent page](harnesses/claude-code.md) lists what that agent supports and how Gluon launches it. Every agent but OpenCode uses one connection at a time. OpenCode can use its plan and OpenRouter together.

## Use a subscription

Subscriptions are opt-in, for you alone, and on your machine. Gluon follows these rules:

- Only the vendor's own program signs you in or checks the login. Sign-in checks and logins are always the agent's own commands, and `gluon doctor` shows the result.
- Gluon never reads a credential file or a keychain, and never adds a login token to an agent's environment.
- Gluon never points a subscription at another server.
- Gluon has no way to share a session, run a bot or a webhook, or run remotely, and any such feature would be blocked on a subscription.

On the Claude and ChatGPT plans, the intake agent itself may also run on that plan, through your own `claude` or `codex`. Its questions then count toward your plan's usage. [Architecture](../concepts/architecture.md#the-intake-agent-on-a-plan) has the details.

## Use an API key

Keys come from the `.env` next to the config (what `setup` and `connect` save) or from your environment. A key saved through Gluon wins over the same variable in your environment. Gluon reads no other `.env`, and never the one in the directory it runs in. `gluon doctor` says where each key comes from. The variable each provider reads is in the [environment reference](../reference/env.md).

Gluon keeps the keys it saved in its own memory, never in its environment. A launched agent's environment is yours, plus only the saved key of the provider its model runs on. Gluon sets a base URL only on an API-key connection, and only two: OpenRouter's documented endpoint, and OpenAI's own for Codex on an OpenAI key. Your own variables, such as `ANTHROPIC_API_KEY` or `OPENAI_BASE_URL`, are left as they are. When one would change what a plan connection does, Gluon warns you.

:::note
A key connection runs on the key even when the agent is also signed in to its plan. The mechanism differs per agent. For example, Codex gets a model provider of its own that reads the key, and Grok Build is pointed at an empty login file so it never touches your Grok login. The [agent pages](harnesses/codex.md) say what applies.
:::

## Use Amazon Bedrock

Bedrock is offered for Claude Code and Codex. Setup asks for your AWS profile and region and stores only those, never credentials. If you leave them empty, Bedrock uses your AWS environment (the profile and region variables), then the `region` of your profile in the AWS config (`~/.aws/config`, or `$AWS_CONFIG_FILE`; Gluon reads that one key), then `us-east-1`, and the prompt shows which region that is. The model ids are the `global.` inference profiles, the cheapest, with no regional premium. `aws bedrock list-inference-profiles` lists yours, and it is free.

## Use OpenRouter

OpenRouter takes one key and reaches models of several makers. Use a key that only Gluon uses. Gluon reads the key's usage (OpenRouter's free key endpoint) before and after each OpenRouter session to show what the session was billed. OpenRouter sets that per request, by the provider that served it, so spending on the key from anywhere else cannot be told apart from the session's. Two Gluon sessions on the same key at the same time get no billed figure, and Gluon says so. `gluon doctor` repeats the notice. See [Cost and context](cost-and-context.md#what-openrouter-billed).

## Know where things live

| | Linux, macOS, WSL | Windows |
|---|---|---|
| Config | `~/.config/gluon/config.yaml`, or under `$XDG_CONFIG_HOME` | `%APPDATA%\gluon\config.yaml` |
| Saved keys | `.env` next to the config, readable only by you | `.env` next to the config, in your Windows profile and readable by your account and administrators |
| Routing | `routing.yaml` next to the config | `routing.yaml` next to the config |

An environment variable sets the config file's path ([Environment variables](../reference/env.md)), and the keys file goes next to it. `XDG_CONFIG_HOME` is honoured on Windows too, when it is an absolute path (a relative one is ignored, as the XDG spec says, so Gluon never writes into the repository you run it in); a relative config path is taken from the directory you start Gluon in. For a config outside your Windows profile, the keys file is limited to your account and administrators (icacls).

`setup`, `connect`, `doctor` and the intake agent write the config for you and keep your comments. A config Gluon cannot write, for example one managed by a dotfile manager, is left alone with a warning, and checks and choices then last for that run only. Every key of the file is in the [config reference](../reference/config.md). `routing.yaml` is the one file you are meant to edit: see [Routing](routing.md).

Settings for sessions in Gluon, such as the home key and what happens at `/clear`, are the `handoff` section: see [Sessions](sessions.md#settings-for-sessions-in-gluon).

## How Gluon decides a model is reachable

The intake agent is offered only models that a check (`gluon doctor`, or the end of setup) verified one of the agent's connections can reach. The results are cached in the config with a date. A model a check found unreachable is left out. A model a connection never checked, either the whole connection before its first check or an id that is new in a later release, is offered until a check says otherwise.

Only a definitive answer changes the results: signed out, a key rejected, a model not listed or refused. A check that fails in passing (a timeout, the network, a rate limit, a server error) shows ✗ with the reason and keeps the last results.

## Models and efforts

The catalog is Gluon's own: facts about each model, not configuration. [Models](../reference/models.md) lists each agent's models and the efforts each takes. After setup the summary says what each connection reaches.

- **Each model appears under one agent.** A model is offered where a connection of its agent serves it, so some models are on OpenRouter only and others on a plan only.
- **Effort belongs to the model, not the agent.** Each model takes its own levels and has a default, its sweet spot, because the same label does not mean the same amount of thinking on two models. Tab and Shift+Tab in the agent choice step through the highlighted model's levels. Switching model keeps the effort when the new model takes it, otherwise it starts that model's default.
- **Some connections take no effort.** Where an agent has no way to apply an effort on a connection, the model is offered there without efforts and Tab and Shift+Tab skip it. The agent pages say where.
- **A direct launch from the command line takes a model only when the agent's connection serves it.**
- **The old `models:` key is gone.** Earlier versions let `models:` in the config replace an agent's list. Gluon tells you once and ignores it. A model that is not in the catalog cannot be launched.

:::caution
One model has a cheaper variant, but its maker receives the session's code and prompts. Gluon never uses, offers or pins it unless `allow_muse_contributor` in your `routing.yaml` is `true`.
:::

## Next steps

- [Routing](routing.md): decide which agent and model each kind of session gets.
- [Cost and context](cost-and-context.md): what each connection shows for cost.
- [Security and privacy](security-privacy.md): what is sent where, and how keys are stored.
- [Models](../reference/models.md): the catalog, per agent and connection.

<!-- Keeping this file fresh: update in the change that alters onboarding (src/auth.ts), the config shape (src/config.ts), where keys come from or what a launched agent's environment gets (src/secrets.ts, src/launchers.ts), how models are checked and offered (src/verify.ts, src/models.ts), or the providers and model set (src/harnesses.ts). Point to the reference pages and .env.example; no copies of ids, defaults or lists from code. -->
