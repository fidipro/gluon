# src/ui/ — instructions for coding agents

The Ink (React for terminals) UI — Gluon's home view and the setup menus — modelled on Codex's TUI.

- **Match Codex's TUI**: the reference is reference/codex/codex-rs/tui/src (a gitignored clone
  of github.com/openai/codex); its snapshot tests are the ground truth. Each component names its
  Codex source in a `// Codex:` comment.
- **Gluon's home view (`Home.tsx`) is one frame exactly rows − 1 tall, no `<Static>`**: give its
  flexible region `flexBasis={0}`, or Yoga shrinks the Text rows around it and they overlap.
  It paints its own ground: every Text sets a `theme.gluon` colour (`TextColor` for Markdown), a
  bordered Box `borderBackgroundColor` (BUG-246); its last row is the compositor's (BUG-245).
  Short of rows, cut the list before the chat and the chat before the composer (BUG-162).
- **Reset the home view's per-question state while rendering** (`pendingSeen` in `Home.tsx`), never
  in an effect: an effect lets one frame show the new question with the last one's options (BUG-258).
- **No `overflow="hidden"` inside the chat viewport**: Ink applies only the innermost clip, so a
  clipped box in the scrolled chat paints over the composer; draw only the rows shown
  (`Markdown`'s `from`/`count`; BUG-199).
- **Never `console.*` while Gluon runs**: Ink patches the console and drops it while the home
  view is suspended; write to `process.stdout` / `process.stderr` (`startDirect` in `gluon.ts`), or
  into the chat: config messages go through `setConfigNotices` (BUG-174).
- **Input arrives in batches**: split with `splitKeys`; read draft/selection from refs, not state.
  What the compositor sets just before a key (`back`) comes as a getter the key handler reads,
  never through an effect or the next render: both come after that key (BUG-236).
- **Read stdin with `'readable'` + `read()`**, never `'data'` (under Bun, keys stop: `theme.ts`).
  After `stdin.pause()`, let a turn of the event loop pass before listening again, or no key
  ever comes (`handOver` in `src/pty/compositor.ts`).
- **Get stdin from `currentStdin()` (`rawmode.ts`) each time**, never a cached `process.stdin`: a handoff ends the reader
  and the UI's next one is `freshStdin()` (BUG-614, below). A new reader of the terminal goes through the same two.
- **Late OSC 11 replies arrive as keys**: every menu and the UI go through `LateOscFilter`
  (`keys.ts`; BUG-49, BUG-54, BUG-63).
- **Menus are separate Ink renders**: a finishing key must not reach the next menu — digits only
  move, Enter confirms (BUG-50); Ctrl+C throws `Cancelled`, exit 130 (BUG-57); cap with `fitMenu`
  (BUG-58).
- **Render only through `inkRender`**, never `render`: it keeps raw mode across menus (BUG-133).
  Call `releaseRaw()` before a handoff. While it holds raw mode and no compositor owns the terminal, a signal restores it and
  exits 128+signo (`armSignals`; BUG-667): any new place that holds the terminal gives it back on SIGTERM/SIGHUP too.
- **Stdin before a handoff** (`inTerminal`): paused, or Windows loses the agent's first line (BUG-100); and ended
  (`endStdinReader`, not on Windows), or on macOS Bun's paused reader takes lines typed for the child (BUG-614, #29),
  with `freshStdin()` once the child is gone. Never `tty.ReadStream(0)` as the fresh one: its blocking read steals too.
- **Setup writes nothing until the last screen.** A new `SetupFlow` screen only changes
  `flow.draft` (never `saveConfig`/`saveSecret`) and has a step id unique within the run. Side
  effects (checks, logins, installs) aren't steps and never re-run on Esc; one install offer per
  agent per run (`offered`).
- **A question Gluon raises unasked (not after a key of the user's) is `selfRaised`** in
  `Compositor.choose`: guarded for `SELF_GUARD_MS`, never over a typed draft, closed by any other key
  (typing is not an answer; BUG-299). Ctrl+C there is "keep", not no (BUG-300).
- **Ink measures every Text with string-width on every render**: per glyph, per frame (its emoji regex was half the home view's time:
  BUG-615). Keep `patches/string-width@8.3.0.patch` (pre-check, same widths: `test/string-width-patch.test.ts`); redo it when `ink` or
  `string-width` moves, and add no per-glyph work to a frame.
- **Edit by grapheme cluster** (`editor.ts`), never by UTF-16 unit.

## Keeping this file fresh

Follow "Keeping AGENTS.md files fresh" in the root `AGENTS.md`. In short: update it in the change
that makes a line wrong; delete what stops being true or a test now enforces; add only what an
agent would get wrong; every name must exist; ≤ 70 lines, overflow to `docs/`.
