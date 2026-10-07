---
title: "Analytics"
description: "The local history Gluon keeps of every session it launches: what it records, how to read and query it with gluon stats, and how to turn it off or delete it."
---

Gluon keeps a history of the sessions it launches: one row per session, in a file on your machine. It answers questions like "what did last week cost, per repository?" or "which agent do I use most?". Nothing in it is sent anywhere: Gluon has no telemetry. It is on by default, and you can turn it off or empty it at any time (see the end of this page).

This is not the same as [saved workspaces](sessions.md#save-and-resume-sessions), which exist to reopen a run, or the cost audit ledger in [Cost and context](cost-and-context.md), which only compares counts.

## What is recorded

Each session you start, resume, restart or launch directly from the command line adds a row. A row holds:

- **Identity.** The session's id, its name, and how it started: new, resumed, restarted (for example after `/clear`) or a one-shot launch.
- **Where.** The directory, the repository, the branch, and the worktree if the session had its own.
- **Which agent.** The agent, its version, the model, the effort, the mode and how it was connected.
- **Why that agent.** What the intake agent classified the work as, and why it chose this agent.
- **The spec.** The prompt the session was given, as you saw it, with keys masked. A very long spec is cut at 100,000 characters.
- **Times.** When it started and ended, how long it ran, the exit code and why it ended.
- **Cost and context.** Gluon's own figures: see [Cost and context](cost-and-context.md).

It never holds a key, an environment or anything an agent's screen showed. Unlike the cost audit ledger, it does hold a prompt and a path, so treat the file like your saved sessions. [Security and privacy](security-privacy.md#session-analytics) has the full statement.

### Status

A session's status is worked out when you read it, not stored. A running Gluon refreshes its open rows every few seconds. A session is:

- **running** while its row was refreshed in the last minute,
- **ended** once it has an end,
- **unfinished** if it has no end and the row has not been refreshed for a minute, which means Gluon died (a crash, a closed terminal, a power cut).

Quitting Gluon ends its open sessions, with no exit code. An unfinished session's time counts up to its last refresh.

## Where it lives

The file is `analytics.db` in Gluon's state directory:

| System | State directory |
|---|---|
| Linux and macOS | `$XDG_STATE_HOME/gluon`, or `~/.local/state/gluon` |
| Windows | `%LOCALAPPDATA%\gluon` |

The directory and the file are readable only by you. It is an ordinary SQLite file, so any SQLite tool can open it, but `gluon stats` is the supported way in.

## Read it with `gluon stats`

`gluon stats` needs no setup and never creates the file. With nothing recorded yet it says so.

<!-- example -->
```sh
gluon stats                 # per agent: sessions, time, cost, unfinished
gluon stats sessions        # the newest sessions, one line each
gluon stats 3f9a1c2e        # one session in full, with its spec
```

- **The summary** groups by agent. Options group it by model, by day (your local time, newest first) or by repository instead, and add a total row.
- **The session list** shows an eight-character id, the start, the time, the agent as `agent/model/effort/mode`, the cost, the status, the repository and the name.
- **One session** is found by its id, by a start of it of four or more characters, or by the agent's own session id. A resumed session starts a new row each time, so an id that matches several rows lists them and exits with an error. Pick one by a longer start of its id.

### Narrow it down

Options filter by agent, by repository (any part of its name or path, any case), and by when the session started. A time is a local day such as `2026-01-31` (as an upper bound, the end of that day), a day and time, or a span back from now such as `7d`, `24h`, `2w` or `30m`. Other options set how many rows are shown (50 by default) and print machine-readable JSON instead of a table. They do not combine with a single session or the SQL command. Every option is in the [command reference](../reference/cli.md#gluon-stats).

<!-- example -->
```sh
gluon stats --by day --since 2w
gluon stats --by repo --agent claude
gluon stats sessions --since 24h --json
```

### Reading the cost

A cost is Gluon's own figure for the session. `$1.20` is a counted figure, `~$1.20` means some part of it is an estimate, and `—` means no session in the row has a figure. In the session list, a trailing mark shows when the figure was billed or is the agent's own total. A summary adds up only the sessions that have a figure.

## Query it with SQL

For anything else, `gluon stats sql` runs one read-only query against the table `sessions`: a `SELECT`, `WITH`, `EXPLAIN` or `VALUES` statement. Times are milliseconds since the epoch, and `duration_ms` is the length of a session in milliseconds.

<!-- example -->
```sh
# Cost per repository over the last week
gluon stats sql "SELECT repo, COUNT(*) AS sessions, ROUND(SUM(cost_usd), 2) AS usd
  FROM sessions
  WHERE started_at > (strftime('%s', 'now', '-7 days') * 1000)
  GROUP BY repo ORDER BY usd DESC LIMIT 20"

# Sessions per model
gluon stats sql "SELECT harness, model, COUNT(*) AS n FROM sessions GROUP BY 1, 2 ORDER BY n DESC"

# Sessions that never reported an end
gluon stats sql "SELECT id, name, repo FROM sessions
  WHERE ended_at IS NULL AND updated_at < (strftime('%s', 'now') * 1000 - 60000)"
```

The query runs in a separate process with limits: it is stopped after 10 seconds, returns at most 10,000 rows and says when it cut, so add a `LIMIT` to large queries. Several statements, and attaching another database, are refused. The columns follow the list under "What is recorded"; run `gluon stats sql "SELECT * FROM sessions LIMIT 1"` to see their names.

## Turn it off, or delete it

- **Stop recording.** Set `analytics: off` in the config (`on` is the default). Nothing more is recorded, and the file already there stays. See the [config reference](../reference/config.md).
- **Empty it.** `gluon stats` has a delete option. It asks first, and a confirm option skips the question when there is no terminal. The file stays, empty, because another Gluon may have it open, and a running session does not write its row back.
- **Remove it.** `gluon uninstall` deletes the file with the rest of Gluon's own files.

Recording never gets in the way of work. A write that fails is dropped, and after three failures in a row Gluon stops recording for that run. A file written by a newer Gluon is left alone.

## Next steps

- [Sessions](sessions.md): saved workspaces, resuming, and what each row on the home view shows.
- [Cost and context](cost-and-context.md): how the cost figures you see here are counted.
- [Security and privacy](security-privacy.md): exactly what is stored, and what never is.
- [Command reference](../reference/cli.md#gluon-stats): every option of `gluon stats`.

<!-- Keeping this file fresh: update in the change that alters what a session row holds or how its status is worked out (src/analytics.ts), the `gluon stats` commands, options or limits (src/stats.ts, src/stats-sql.ts), or the `analytics` config key (src/config.ts). Check the example queries against the columns in `MIGRATIONS`. -->
