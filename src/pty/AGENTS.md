# src/pty/ — instructions for coding agents

Gluon's terminal side: agent sessions in their own pseudo-terminals, the compositor, chrome and
painter, key decoder, screen model, readers, interception. How it fits together: "Gluon: the
sessions and the frame" in `docs/concepts/architecture.md`.

- **The screen alone never triggers anything**: the repository's text can draw a fake menu or
  `/clear`. A hold needs a typed `/` first (`createInterceptor`); a paste never counts. A screen read
  that only changes the status row (`awaitsChoice`, `interrupted`) never starts a hold or sends input.
- **Unsure → forward**: a screen a reader can't read, a line it can't match, a key it doesn't
  know all let the Enter go on. Holding wrongly breaks the agent; missing a question doesn't.
- **Gluon owns session switching; a key a harness uses for its own session or agent views is
  Gluon's to drop**, never to forward, while the line is untouched (←/→, Alt+←/→: `route`;
  BUG-280). Switching never needs a key the agents use: the home key's prefix works everywhere.
  A key typed to an agent's own dialog (`awaitsChoice`) never touches an empty line (BUG-705).
- **Keys and screen stay in memory**: never log, write, send or put them in an error message;
  the typed line is cleared on Enter (`SECURITY.md`).
- **Write into the agent only the user's own bytes**, unchanged (`raw`); never synthesize input.
  The decoder keeps every byte in order however a chunk is split (`test/pty-keys.test.ts`).
  Carve-outs, through `send` only (`test/pty-session.test.ts`): an `AgentSession` also gets its screen
  model's replies to its own queries, the user's mouse reports moved into the frame, and once the
  launch's `firstLine` (`typeFirstLine`: Codex's and Grok's `/plan …`, Kimi Code's brief on every launch; only on the reader's empty composer (and its `ready`, when it has one: Kimi's model must show; BUG-674) with bracketed paste on and no dialog of the agent's own (`awaitsChoice`, also before the Enter; BUG-670),
  before the user typed, text then a paused Enter; else the user is told it, never retried).
- **Bracketed paste stays on on the real terminal in a session** (`effectiveModes`), so a paste is
  never read as keys; an agent that hasn't asked for it gets the paste without markers
  (`unbracketed`; BUG-172). Never decode a paste key by key.
- **A session's note (`Compositor.note`) is drawn over the frame after the painter's rows, at every paint
  that draws any** (`noteBytes`); hiding it invalidates the painter; Esc is Gluon's only while one is up (BUG-409).
- **Zoom resizes only the shown session** and is undone before `open`/`home` draw (`setZoom`,
  `unzoom`; BUG-284): `interior` stays the framed rect for launches, the shown one is `area`.
- **Only the compositor reads stdin or writes the terminal** (`compositor.ts`); a session has no
  stdin, stdout or signals. Its question goes in the bottom bar: never hold its output. To give
  the terminal away (no PTY), go through `handOver`: it leaves the alternate screen and raw mode
  and ignores SIGINT meanwhile.
- **`shutdown` (`src/gluon.ts`) ends on every path with the terminal back**: a second signal while it waits for the agents
  calls `compositor.abort()` before `process.exit` (BUG-666); never exit around it.
- **Change a reader only against a captured screen** (`test/fixtures/screens.ts`); never guess a
  harness's layout. Re-capturing: `docs/contributing/internal.md`.
- **A reader finds the composer by its own rows, not the cursor's row**: Grok moves its cursor
  while it draws (`src/pty/readers/grok.ts`; BUG-411); a screen it can't find the box on is `null`.
- **Windows sends win32-input-mode**: characters with no virtual key are VT bytes to read again,
  not text (`createKeyDecoder`; BUG-153); Ink reads plain VT, so keys into the home view go
  through `forInk` (BUG-208), which turns Shift/Ctrl+Enter into kitty's form (BUG-655) and drops a stray paste
  end `ESC [ 201 ~` (BUG-656; an agent still gets it). ConPTY re-renders output: assert bytes on POSIX only.
- **At home a left press waits for its release** (`homeMouse`): a drag over other cells is a text
  selection (`selection.ts`), so the home view never gets a press that became one (BUG-286). The
  selection reads only the home view's own screen model, never an agent's. A press and release within a
  cell (diagonal too) is a click, not a selection (`near`; BUG-657).
- **`--launch` never goes through here**: no PTY, no events, no adapters. `handOffSession` is
  Gluon's path without a PTY only (one session at a time, `ptyAvailable` false).

## Keeping this file fresh

Follow "Keeping AGENTS.md files fresh" in the root `AGENTS.md`. In short: update it in the change
that makes a line wrong; delete what stops being true or a test now enforces; add only what an
agent would get wrong; every name must exist; ≤ 70 lines, overflow to `docs/`.
