---
title: "Routing"
description: "How Gluon turns a session into an agent, model and effort, and how to change it with your own routing.yaml."
---

Routing decides which agent runs a session. The intake agent never picks the agent itself: it decides what the session is, and code turns that into a harness, a model and an effort from your `routing.yaml`.

## How a session is routed

1. **The intake agent classifies the session.** It names the kinds of work the session covers (understand, debug, feature and so on) and how hard each is. It also chooses the session's [mode](modes.md).
2. **Code does the arithmetic.** It takes the strongest model level and effort across the kinds, caps them with your limits, then takes the first model in that level's list that is connected, reachable and can give the effort. A level with no such model rounds up to the next one.
3. **You see the result.** The agent choice shows the recommended harness × model × effort with a reason, up to two alternatives and the spec. Tab and Shift+Tab adjust the highlighted option, and `keep talking` goes back to the chat.

Only models that a check has shown your connections can reach are considered. See [Connections](connections.md#how-gluon-decides-a-model-is-reachable).

## What routing.yaml holds

The file sits next to your config. Gluon writes the default there the first time it needs it, and `gluon routing path` prints where it is. Edit it freely: the next Gluon you start uses it. A file that is not valid YAML stops Gluon at start, with its path and line.

It holds these sections. Every key and its default is in the [routing.yaml reference](../reference/routing-yaml.md).

- **`rank`**: per level, from light to frontier, the models in priority order.
- **`limits`**: harnesses, models, a top model and a top effort that routing never crosses.
- **`allow_muse_contributor`**: opt in to a cheaper model variant whose maker receives the session's code and prompts. It is never used, offered or pinned unless this is `true`.
- **`prefer`**: notes in plain words, for example "use codex for test sessions". The intake agent turns them into a preferred harness or a step in model or effort, within your limits.
- **`instructions`**: what the intake agent should always or never do and ask.
- **`types`**: the kinds of session, each with its mode, its starting level and the examples that tell the intake agent when to go stronger, lighter or deeper.

## Check your file

```sh
gluon routing check     # list mistakes; exit code 1 on any
gluon routing path      # where routing.yaml is
gluon routing default   # print the routing.yaml this Gluon ships
```

`check` lists mistakes such as a model in `rank` that does not exist, a bad level, a pin to nothing or a malformed one (`claude-code/sonnet@`), and a key that looks like a typo of one routing.yaml has (`limit:` for `limits:`): such a key is ignored. YAML anchors, aliases and merge keys (`<<: *anchor`) work; a file that expands to an absurd number of values (an alias bomb) is refused as unusable.

## Upgrades

When a Gluon update changes the default, for example a new model in the ranks, a `routing.yaml` you never edited is replaced by the new default at start, and Gluon says so once. A file you edited is never touched. `gluon routing check` tells you when your file predates this Gluon's default, and `gluon routing default` prints the default so you can compare.

## Next steps

- [routing.yaml reference](../reference/routing-yaml.md): every section and key.
- [Modes](modes.md): build, explore and plan, and how routing uses them.
- [Architecture](../concepts/architecture.md#routing-routingyaml-and-route): the routing model and its defaults in depth.

<!-- Keeping this file fresh: update in the change that alters routing (src/routing.ts, src/routing.yaml, src/routing-config.ts) or the `gluon routing` commands (src/cli.tsx). Keys and defaults live in the generated reference pages, not here. -->
