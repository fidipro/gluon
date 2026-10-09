---
title: "Keyboard and mouse"
description: "Every key and mouse action on the sessions home, in the intake chat and inside an agent session."
---

On the home view, the hint line names the keys for what is selected. Press `?` with an empty chat to list them all in Gluon itself. `pgdn` and `pgup` scroll the list when it does not fit, and `esc` closes it.

## On the home view

- **Select.** `↑` and `↓` select a session or a group's label.
- **Open.** `enter` opens the selected session. On a group's label it collapses or expands the group. `→` with an empty chat opens the first tab. Digits are always text.
- **Mark done.** `ctrl+d` marks the selected session done, and again marks it not done. Only you decide what is done.
- **Remove.** `del` removes any row. For a running agent it asks "End Gluon-fix-add-bug?" (the session's name), and for the one being drafted "Discard this chat?". Only `enter` says yes. `esc` or `ctrl+c` says no, as the hint line then says.
- **Interrupt and clear.** `esc` interrupts the intake agent, and `esc esc` clears the draft.
- **Newline.** `alt+enter` or `ctrl+j` inserts a newline.
- **Quit.** `ctrl+c` clears the draft, and twice quits. While sessions run, Gluon asks first: they end with Gluon, and `gluon resume` brings them back.

## In the intake chat

- `enter` sends your message.
- `↑` and `↓`, or a digit, then `enter`, pick an option.
- `enter` on an agent starts the session. Type instead to change it.
- `tab` and `shift+tab` adjust the highlighted agent's model and effort. The hint names them when it has another.
- `ctrl+t` cycles the [mode](modes.md) (build, explore, plan) of the proposal.
- `ctrl+p` cycles the highlighted agent's [permissions](modes.md#permissions) in build mode, for an agent that asks before every command or edit. The hint names it then.
- `pgup` and `pgdn` scroll the spec when it is cut to fit. While the agents are shown, they scroll only the spec. `esc` closes the agents, then they scroll the chat.
- `ctrl+o` folds the spec to one line and back.

## Inside a session

Every key is the agent's, except these.

**The home key**, `ctrl+\`, opens a one-key menu. It works in every state: a typed line, scrolled back, a question up. Then:

- `←` or `→` goes to the previous or next tab,
- `z` zooms the session, so the frame goes and the agent gets the whole terminal but the last row (press again to bring the frame back),
- `ctrl+\` again goes home.

The menu waits until you press a key, however long that takes. `esc` or any other key cancels it, and that other key goes on as usual. The zoom helps for a dialog that needs the rows, such as Claude Code's plan or subagent panel on a small terminal.

**Arrow keys on an empty line.** `←` and `→` switch tabs when you have typed nothing since the last `enter`, `esc` or `ctrl+c`, or only erased it with as many backspaces. Keys you press to answer a dialog of the agent's own (Codex's hooks review or folder trust, an approval) do not count as typing. They wrap: `←` from the first tab and `→` from the last tab go home. `alt+←` and `alt+→` are dropped there, since some agents switch their own agents or sessions on them: Gluon owns the sessions. The bottom bar names the switch keys that work right now. This includes OpenCode's permission selector: use `tab` there, not `←`/`→` ([OpenCode](harnesses/opencode.md)).

**Scroll back.** The mouse wheel or `shift+pgup` scrolls the frame back when the agent does not use the mouse. `esc` or `q` returns.

**`/clear`, `/new` and `/compact`.** Gluon asks before they end the session: see [Sessions](sessions.md#work-in-the-frame).

The agent's own `/gluon` (Claude Code and OpenCode), or its offer when the work looks done, shows the home view too.

## Mouse

- A click on a row selects it. A click on the selected row, or a double click, opens it.
- A click on a group's label collapses or expands it.
- A click on an option of the intake agent's question or agent choice picks it.
- A click on a tab shows it. A click on `◆ gluon` shows the home view. A click on `‹2` or `3›` (counting the tabs that do not fit) goes to the nearest hidden tab.
- The mouse wheel scrolls the chat, and a session's frame when its agent does not use the mouse.
- Dragging over the text on the home view selects it and copies it to your clipboard. A press and release within a cell of each other is a click, so a trackpad's jitter does not turn a click into a selection.

:::note
Copying uses the OSC 52 sequence, so your terminal must allow it. In tmux, set `set-clipboard on`. Shift-drag, or Option-drag on macOS, is the terminal's own selection and works inside a session too. Set `handoff.mouse_capture` to `false` to leave the mouse to the terminal. See [Sessions](sessions.md#settings-for-sessions-in-gluon).
:::

:::tip
On Windows, Windows Terminal takes `alt+enter` for full screen. Use `ctrl+j` for a newline in the chat.
:::

## Next steps

- [Sessions](sessions.md): the rows, saved sessions and the settings that change these keys.
- [Quickstart](../getting-started/quickstart.md): the first session, key by key.
- [Troubleshooting](troubleshooting.md): keys that do not reach Gluon.

<!-- Keeping this file fresh: update in the change that alters a key or a mouse action (src/ui/keys.ts, src/ui/Home.tsx, src/pty/compositor.ts, src/pty/intercept.ts) or the home key setting (src/handoff.ts). -->
