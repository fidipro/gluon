---
title: "Worktrees"
description: "Each session in a git repository works in its own git worktree and branch, so sessions on one repository do not affect one another."
---

In a git repository, a new session works in its own git worktree, on its own branch. Sessions on the same repository then do not affect one another. The intake agent says so in its proposal.

## How it works

Gluon only decides where the worktree goes and tells the agent in the spec. The agent creates it, works in it, and removes it only if you agree.

- **Where.** The worktree is `.gluon/worktrees/gluon-<name>` inside your checkout, so it is in the agent's working directory. Many agent sandboxes guard what is outside it.
- **Which branch.** A new branch `gluon/<name>`. If the name is taken, Gluon uses the next free one. If you have a branch named `gluon` (which makes every `gluon/…` branch impossible), it uses `gluon-2/<name>` instead.
- **The instructions.** Gluon puts the same instructions at the end of every spec.
- **Cleanup.** After the work is merged, the agent suggests removing the worktree and its branch, and does it only if you agree.

Gluon itself runs read-only git queries there. It creates and deletes nothing.

## Keep a session in your checkout

Say "no worktree" in your reply to the intake agent, and the session stays in your checkout.

A worktree is not created when:

- the session is in `explore` mode, because creating one is a change and explore is [read-only](modes.md),
- the directory is not a git repository, or one with no commit yet (a worktree starts from `HEAD`),
- the session is reopened with `gluon resume`: it keeps the worktree its record names, if it is still there. A session that cannot be resumed and is started again from its spec (see [Sessions](sessions.md)) goes on in that worktree too: its brief says the worktree is already there, with whatever work it holds, and not to create it. Only a worktree that is gone gets a new one. A worktree is reused only when this checkout's own worktree list names that exact directory under `.gluon/worktrees` on the recorded branch; a saved record that names anything else (another directory, another repository's worktree, a path with shell characters) is ignored and a new worktree is planned.

If Gluon cannot plan a worktree, it tells you in the chat and the agent works in place.

## Files changed

The files-changed count on a session's row is read from its worktree. Without one, it counts changes in your checkout since the session started, and the work tree is shared with other sessions. See [Sessions](sessions.md#what-each-row-shows).

## Next steps

- [Modes](modes.md): why explore never gets a worktree.
- [Sessions](sessions.md): resume a session in the worktree it had.
- [Architecture](../concepts/architecture.md): how the spec's worktree instructions are added.

<!-- Keeping this file fresh: update in the change that alters where worktrees go, their branch names or when one is planned (src/worktree.ts, src/gluon.ts) or the instructions added to a spec (src/intake.ts). -->
