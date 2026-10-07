---
title: "Connect your agents"
description: "Install the coding agents you use and connect each one to Gluon with an API key or your own subscription."
---

Gluon starts agents; it does not replace them. Setup installs the ones you are missing and connects each to a model source: an API key, or your own subscription. The first run opens it, and `gluon setup` opens it any time.

## Run setup

The first screen, "Connect your coding agents", is a checklist of the six agents (Claude Code, Codex, Antigravity, Grok Build, OpenCode and Kimi Code). Each is marked installed or missing, with its official install command. Check the ones you use. To skip an agent, leave it unchecked.

To redo a single agent, run `gluon connect` with its name, for example `gluon connect codex`.

## Install a missing agent

An agent you check that is missing is offered an install first. Gluon shows the exact command, where it downloads from and the vendor's docs, with three choices: Skip (the default), Show the command only, or Run it.

:::caution
An installer runs only on "Run it", pressed on its own, after the command is on screen. A paste or keys typed ahead never run an installer, and no option skips the question. Installers run as you, never with sudo, in an empty directory, exactly as shown.
:::

You can also install agents outside setup: `gluon install` offers a checklist of the agents that are not installed, and `gluon install opencode claude` names them. Without a terminal it only prints the commands.

If an installer puts the agent in a directory that is not on your PATH, Gluon names the directory. Add it to your PATH, or open a new terminal if the installer already did. Gluon never runs an agent from a directory that is not on your PATH.

## Connect each agent

For each agent you check, pick one of two ways in.

### With an API key

Pick the provider, then paste the key, or reuse one that is already set in your environment or in the `.env` next to the config. A key you paste into Gluon is the one Gluon uses, even when the same variable is also exported in your shell.

Amazon Bedrock asks for your AWS profile and region, never the credentials. Enter on an empty line pins neither, and Bedrock then uses your environment's setup.

A key connection really runs on the key, even when the agent is also signed in to its plan. How that works differs per agent, and each [agent page](../guides/harnesses/claude-code.md) says what applies.

### With a subscription

Subscriptions are for personal use. Gluon runs the agent's own status check. If you are signed out, it offers the agent's own login command (a terminal handoff) and checks again. Once you are signed in, the agent is connected on your plan. It is for you only, on this machine, and Gluon never sees your token.

OpenCode takes a checklist of providers and "add another". OpenRouter takes a key and its Go plan is a subscription. [Connections](../guides/connections.md) compares the ways in and says which agent supports which.

:::tip
Use an OpenRouter key that only Gluon uses. Gluon reads the key's usage to show what each session was billed, which only means something if nothing else spends on the key.
:::

## Move around the screens

- A digit moves the selection and Enter confirms it.
- A checklist toggles rows with Space or their number; on a list of ten or more rows, `1` then `0` within a second is row 10.
- Esc goes back one screen with your earlier answer selected. On the first screen it leaves setup.
- Ctrl+C quits setup at once (exit code 130, nothing checked).

Nothing is saved, neither config nor keys, until the last screen is answered. Leaving or quitting changes nothing. Unchecking a connected agent in `gluon setup` disconnects it, after asking.

## Let Gluon check

After the last screen, if any agent was connected, Gluon checks every model of every connection and the intake agent's order, prints a summary and starts. If nothing was chosen, nothing is checked and no paid call is made.

The check is real, so it makes tiny billable calls (on a plan, they count toward its usage). `gluon doctor` repeats it whenever you want to see what works and why something does not. [Connections](../guides/connections.md#how-gluon-decides-a-model-is-reachable) explains what a check changes.

## Next steps

- [Quickstart](quickstart.md): start your first session.
- [Connections](../guides/connections.md): subscription, API key, Bedrock and OpenRouter compared, and where keys and config live.
- [Troubleshooting](../guides/troubleshooting.md): "not installed" right after installing, WSL and PATH problems.

<!-- Keeping this file fresh: update in the change that alters onboarding or installs (src/auth.ts, src/install.ts, src/ui/signin.tsx), which agents or providers can connect (src/harnesses.ts), or what a launched agent's environment gets (src/secrets.ts, src/launchers.ts). -->
