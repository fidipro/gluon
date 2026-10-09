# Windows: manual checks

The regression suite runs on Windows, pty scenarios included (through ConPTY). What it can't see
is a real terminal's key events and replies. Walk this by hand (10 to 15 minutes) after a change to input handling,
the theme, the frame or a launch, on a machine with Gluon installed (`install.ps1`, or `bun run build` and
`dist\gluon-bun-windows-x64.exe` renamed `gluon.exe`) and at least one harness installed natively
(Claude Code's `install.ps1`) and one by npm (`npm i -g @openai/codex`). `gluon doctor` and every
launch call real models (a few cents): pick the cheapest model.

Run steps 1 to 13 in **Windows Terminal** (PowerShell profile), then repeat 1 to 4 and 9 in the
**legacy console** (`conhost.exe` → `powershell`) and in a **cmd** profile. Record the date and the result in
the maintainers' private notes, not here.

1. **Theme.** Dark and light terminal themes: Gluon paints its own dark ground over both; the setup
   menus use the light colours on a light terminal. (ConPTY in the test harness drops OSC 11
   replies, so only the dark fallback is checked automatically.) No stray `]11;rgb:…` or `\` in
   the composer at start, nor after pressing Esc quickly at start.
2. **Newline and Esc.** `ctrl+j` adds a line in the intake chat. Alt+Enter: Windows Terminal toggles
   full screen (expected); in the legacy console it adds a line. Shift+Enter is a known gap (#35): note
   whether it adds a line or sends the draft. One Esc shows "Press esc again to clear the draft"; a second
   clears it. Esc interrupts the intake agent while it works.
3. **Paste.** A multi-line paste (right click and Ctrl+V) lands as one draft, not sent line by line. A 50 KB paste (a log)
   into a launched Claude Code session arrives within a few seconds (the test fakes read a paste at 1.5 KB/s through ConPTY: only a real agent tells).
4. **Ctrl+C.** On Gluon's home view, twice quits (asking first while sessions run); in a setup menu
   it leaves with nothing written (exit 130).
5. **Launch, native exe.** Launch Claude Code with a spec containing `& | % ^ " !` and a newline: the
   agent gets it verbatim. After quitting Gluon, the terminal is usable (echo on, line editing).
6. **Launch, npm shim.** With only npm's `codex.cmd` for Codex, `gluon doctor` shows it
   installed and a launch reaches the native `codex.exe` (Task Manager: no `node.exe` parent).
   Rename that exe away to force the shim route: the agent gets "Read the session brief in … and start.",
   the file holds the spec and is gone after the agent exits.
7. **Login handoff.** `gluon connect claude-code` → Subscription → Sign in now: the first key
   typed goes to `claude auth login` (BUG-100), and the setup goes on after it. Then `gluon connect opencode`
   (the Go plan) and `gluon connect kimi-code` (needs Git for Windows): each shows its own sign-in or
   "sign-in not checked", and nothing is written to the agent's own config.
8. **Keys file.** Save a key with the config on another drive (`GLUON_CONFIG=D:\…`): the setup
   says "limited to your account and administrators (icacls)", and `icacls <file>` shows one entry.
9. **Agents in Gluon's frame (ConPTY; Windows Terminal sends win32-input-mode).** In launched
   Claude Code and Codex sessions: typing, arrows, Esc, a paste and Ctrl+C behave as in the agent
   run directly; resizing the window resizes every session; emoji and CJK keep the frame's border
   in place. `Ctrl+\` (and Ctrl+4) then ←/→ switch sessions and Ctrl+\ twice shows the home view, from a US and a non-US keyboard layout (AltGr characters still type).
   Typed `/clear` + Enter shows "/clear ends this session in Gluon — end it?  enter yes · esc no" in the bottom bar: Esc runs its /clear;
   Enter ends the session within a second or so, its last screen still shown. The mouse wheel
   scrolls the frame back; Shift+drag selects text. On the sessions home a drag over text highlights it and copies it (paste it elsewhere), a click on a row selects
   it and a second opens it. Click out of the window and back in at the sessions home (after a session ran): nothing
   is typed into the composer (ConPTY keeps focus reports on).
10. **Zoom.** In a session, `Ctrl+\` then `z`: the frame goes and the agent has the whole window but the
    last row (the zoom bar); `Ctrl+\` `z` again brings the frame back with no stale rows. Resize while zoomed.
11. **Quitting.** Quit while the intake agent searches a large repo (no rg) and while sessions run: no `gluon`, `bun`,
    `rg` or agent process is left in Task Manager; the cursor is visible and mouse clicks don't print escape codes.
12. **History.** After a launch, `gluon stats` shows the session and `gluon stats sessions` lists it.
    `gluon stats --delete` asks, then empties it (the file stays) while Gluon is still open in another window.
    `analytics.db` and its `-wal` in `%LOCALAPPDATA%\gluon` are readable only by you (Properties → Security).
13. **Return from a source or npm install** (`GLUON_SELF` is a `.cmd`: BUG-144). Run Gluon
    with `bun run demo` (and once from the npm package), launch OpenCode and type `/gluon`: it
    shows the sessions home; then in Claude Code type `/clear` and answer Enter: that session ends.

## Keeping this file fresh

Add or adjust a step in the change that alters input handling, the theme, Gluon's frame, a shim
launch, key storage or the analytics files on Windows. Keep it a 10 to 15 minute walk: fold a new step
into the one it belongs with. Record walking it only in the maintainers' private notes, not here.
