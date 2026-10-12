/**
 * The catalog: what Gluon promises, one entry per behaviour, invariant and perf limit, each tested at least once
 * (docs/contributing/testing.md). A test names its entry at the start of its title, and a bug it guards as a tag:
 *   test("keys/never-in-process-env: keys from Gluon's .env stay out of process.env #BUG-82", …)
 * `test/catalog.test.ts` checks that every entry has a test and every test names a known entry (the files that don't yet
 * are in `test/catalog.baseline.json`, which only shrinks). Entries are written from what a user is promised (the guides,
 * `AGENTS.md`'s invariants), not from the code. Adding, changing or removing one is a maintainer's decision
 * (`tests-reviewed`, `scripts/test-guard.ts`).
 */

/**
 * Where an entry's tests run: `e2e` (`test/e2e/`, Gluon in a terminal with the fakes), `real` (`test/real/`, the real
 * harness on a loopback model API), `perf` (`test/perf/`), `seam` (`test/*.test.ts`, through a seam in `test/seams.ts`) and
 * `code` (`test/*.test.ts`, a check that reads the source: a rule no run could show).
 */
export type Layer = "e2e" | "real" | "perf" | "seam" | "code";
export type Kind = "behaviour" | "invariant" | "perf" | "fidelity";
export type Entry = {
  kind: Kind;
  /** Given …, when …, then …: what holds, as a user (or a reviewer of a rule) would check it. */
  says: string;
  at: Layer[];
  /** Where it differs by platform: the platforms whose CI job checks it (the rest don't run it). */
  platforms?: ("linux" | "macos" | "windows")[];
};
export type Feature = { says: string; entries: Record<string, Entry> };

const b = (says: string, at: Layer[] = ["e2e"], platforms?: Entry["platforms"]): Entry => ({ kind: "behaviour", says, at, ...(platforms ? { platforms } : {}) });
const rule = (says: string, at: Layer[] = ["code", "seam"], platforms?: Entry["platforms"]): Entry => ({ kind: "invariant", says, at, ...(platforms ? { platforms } : {}) });
const perf = (says: string, at: Layer[] = ["perf"], platforms?: Entry["platforms"]): Entry => ({ kind: "perf", says, at, ...(platforms ? { platforms } : {}) });

export const CATALOG: Record<string, Feature> = {
  fidelity: {
    says: "the fakes the tests run on behave like the real harnesses, as Gluon reads them (test/real/fidelity.real.test.ts)",
    entries: {
      screens: { kind: "fidelity", says: "given a harness's states (its screen fixture, re-captured on each release), when its fake is driven through them, then Gluon's readers read the fake as they read the real harness", at: ["real"] },
    },
  },
  home: {
    says: "the sessions home: header, list, hint line and chat in one terminal-sized view (docs/guides/sessions.md, keyboard.md)",
    entries: {
      header: b("given a repository (git, no commits, a detached HEAD, no git), when Gluon starts, then the header shows the mark, `Gluon v<version>`, repo · branch (or commit) · n modified, then `workspace <id>` once a session launched; short of columns its lines are cut, never wrapped"),
      "header-counts": b("given sessions, then the header counts them by state (`1 awaiting input · 2 working · …`), `no sessions yet` before the first, `no sessions running` once all ended"),
      "first-run": b("given no session yet, when Gluon starts, then it shows the agents available with each one's readiness, the intake agent's first line and `› describe the session you want`; on a short terminal the greeting stays whole and the agent list is cut first"),
      "fits-terminal": b("given any terminal size (down to a few cells) and any resize, then the home view is exactly rows − 1 tall, nothing wider than the terminal or wrapped, the composer on screen with one rule over it", ["e2e", "seam"]),
      "short-terminal-priority": b("given a short terminal and a conversation going on, then the open question or agent choice (lead, options, hint) wins over the list; the list keeps its column header and group label before its blank rows go; at 80×24 two groups and a question show every row"),
      "no-full-redraw": b("when keys are typed, a turn runs or a huge draft is edited, then Gluon never clears the screen or the scrollback"),
      theme: b("given a dark or a light terminal (its OSC 11 answer, else COLORFGBG), then Gluon picks the matching theme and paints its own ground on every cell, the spec box's borders included", ["e2e", "seam"]),
      "hint-line": b("given what is selected or open (a run, a group label, the draft, text typed, the intake agent working, a question, the agent choice, an ended run without a terminal), then the hint line names only the keys that act on it, ending in `? for keys`; short of columns whole keys go from the end, never enter/esc or `? for keys`"),
      "one-highlight": b("while a question or the agent choice is open, then only the option Enter acts on is highlighted, never the list's row too; closed, the list's row is again"),
      "key-list": b("given an empty composer, when `?` is pressed, then every key is listed (sessions, in a session with the configured home key, the intake chat) in columns that fit; cut, it says `↓ N more` and pgdn/pgup scroll it; esc or `?` close it, any other key closes it and acts; with text typed or options open `?` is text", ["e2e", "seam"]),
      "key-list-mouse": b("given `handoff.mouse_capture: false`, then the key list names no click, wheel or text selection; with it on, it names them"),
      "own-question": b("given Gluon's own question at home (end a session, discard the chat, quit, resume, start again), then the hint line names its keys, the composer shows no cursor, and only keys pressed once it shows answer it: Enter yes; esc or ctrl+c no; y/n nothing", ["e2e", "seam"]),
      quit: b("given a draft, ctrl+c clears it; twice on an empty composer quits with 130 and gives the terminal back (cursor, paste mode, main screen); with sessions running it asks first"),
      "text-widths-exact": { kind: "invariant", says: "given any text (emoji, CJK, marks, box glyphs), then the patched string-width (its speed pre-check, patches/) measures it exactly as the unpatched module", at: ["code"] },
      readable: b("in either theme, on truecolor or 256 colours, then box borders stand at least 3:1 off the ground and dim text on the selection bar stays readable", ["seam"]),
      "cut-marked": b("given text too wide for its place, then it is cut by display width (never inside a wide character) and ends in `…`, never after a dash, a separator or a blank", ["seam"]),
    },
  },
  "sessions-list": {
    says: "the rows of the sessions home (docs/guides/sessions.md)",
    entries: {
      groups: b("given sessions in several states, then rows are grouped under Awaiting input, Working, Done, Drafting (`?` `●` `✓` `◌`), a column header names the right-hand columns, nothing wraps at any width, the selected row is a full-width bar", ["e2e", "seam"]),
      "row-columns": b("given a session, then its row shows its name, triple, latest activity, its mode (`· explore`, `· plan`, nothing for build), cost and context, as the width allows", ["e2e", "seam"]),
      "row-live": b("when a session's state or activity changes (a hook or its screen), then its row, its group and the header counts follow; a finished turn reads awaiting input, never Done"),
      "draft-row": b("given a chat being drafted, then a Drafting row named from the proposal (`(untitled)` before) reads `Waiting for your pick` while the agent choice is open, `Waiting for your answer` while a question waits, `Talking it through` otherwise; Enter on it says `That's this chat`"),
      select: b("when ↑↓ are pressed, then the selection moves over rows and group labels; a list longer than its rows shows `… N more`, and ↓ past the window moves it one line, the selection kept in view", ["e2e", "seam"]),
      open: b("when Enter is pressed on a row, then that session opens; → on an empty composer opens the first tab; digits on the home composer are text, never a tab; without a pseudo-terminal a session that ended leaves no row, and nothing offers to open one"),
      collapse: b("when Enter is pressed on a group label, then it collapses to `▸ Working (N)` and expands again"),
      "mark-done": b("when ctrl+d is pressed, then the selected session is marked done, again not done, the selection following its row; never with text in the composer, never the drafting row"),
      remove: b("when del is pressed, then Gluon asks `End <name>?` for a running session, `Discard this chat?` for the drafting row; only Enter says yes, esc or ctrl+c no; never with text typed"),
      "selection-after-remove": b("when a row goes (removed, or its session ended), then the next row is selected (the previous one after the last), not the first"),
      "back-home-selects": b("when coming home from a session, then its row is selected (its group unfolded), and a ctrl+d at once acts on it"),
      "unique-names": b("given two sessions with the same name, then the newer is numbered (the draft too), unique among those listed", ["seam"]),
    },
  },
  composer: {
    says: "the chat box at the bottom of home (docs/guides/keyboard.md)",
    entries: {
      editing: b("when typing, backspace, delete, ←→, home/end and ctrl+a/e/u/w are pressed, then they edit at the cursor", ["e2e", "seam"]),
      graphemes: b("when the cursor moves, backspace deletes or text is inserted, then an emoji or a combined character is one character", ["e2e", "seam"]),
      newline: b("when alt+enter, ctrl+j or shift+enter (any encoding) is pressed, then a newline is inserted, never text; ↑↓ move between the lines", ["e2e", "seam"]),
      wrap: b("given a draft wider than the composer, then it wraps at words, a word longer than a row is broken there, and the cursor stays where the user types"),
      "tall-draft": b("given a draft taller than the composer's rows, then the rows around the cursor show, with how many more"),
      paste: b("when text is pasted, then it is taken whole, keeps its line breaks (CRLF, CR), indentation and tabs, drops escape sequences and control characters as typing does, and never sends by itself"),
      "esc-esc-clears": b("when esc is pressed on a draft, then it stays and Gluon says `Press esc again to clear the draft`; a second esc clears it"),
      "batched-keys": b("given keys arriving in one read, then they act as keys (Enter submits, control keys edit); a double Enter sends once"),
      placeholder: b("given an empty composer, then its placeholder says what Enter does: `describe the session you want`, `describe another session`, `reply to the intake agent`"),
      "terminal-noise": b("given a late terminal reply (OSC 11) or a focus report, then it is never typed into the composer; a typed `]` still is", ["e2e", "seam"]),
    },
  },
  "intake-chat": {
    says: "talking to the intake agent at home (docs/getting-started/quickstart.md)",
    entries: {
      send: b("when Enter is pressed on a draft, then it shows in the chat on a full-width bar after `›`, hanging under its text; an empty or blank draft sends nothing"),
      working: b("while the intake agent works, then a line says what it does and `esc to interrupt`; once it speaks, its tool calls show as one `◇` line (reads, searches, git commands, failures counted)", ["e2e", "seam"]),
      queue: b("when Enter is pressed while it works, then the message is queued above the box and sent when the turn ends; esc cancels it before it interrupts; a question or proposal at the turn's end keeps it queued and Enter sends it as the answer; a draft left as a question arrives is flagged"),
      interrupt: b("when esc or ctrl+c is pressed while it works, then it is interrupted (`Interrupted — tell the intake agent what to do instead.`) without quitting, and the chat goes on"),
      scroll: b("when pgup/pgdn or the wheel are used, then the chat scrolls back to its first line and forward again"),
    },
  },
  question: {
    says: "the intake agent's question (docs/getting-started/quickstart.md)",
    entries: {
      pick: b("given a question, when ↑↓ (wrapping) or a digit then Enter are pressed, then that option is the answer; a digit alone only highlights; the answer shows under the question, which stays in the chat"),
      "own-words": b("given a question, when a reply starts with a digit or names an option out of range, then it is text sent whole; Enter on `type your own answer` says to type it; esc hides the options and a typed reply still answers"),
      "tab-adds-words": b("given a question, when Tab is pressed on an option, then it goes into the composer to add words to, and Enter sends the whole; with text typed Tab does nothing"),
      "batch-step": b("given several questions asked together, then they come one at a time, each saying which it is: `(2/3) …`, and the answers go back together"),
      fits: b("given long options, then they wrap inside the terminal, hanging under their text, not under `❯`"),
    },
  },
  "agent-choice": {
    says: "the proposal: the spec, the recommended agent and its alternatives (docs/getting-started/quickstart.md, docs/guides/routing.md, modes.md)",
    entries: {
      shows: b("given a proposal, then the lead line with its reason, the spec box (`spec — what the agent will get`), the recommended harness × model × effort first, up to two alternatives, `keep talking` and the hint show; its first frame already lists the agents and names the drafting row"),
      "recommended-mark": b("given a proposal, then `· recommended` marks the first option only while it is the intake agent's own"),
      start: b("when Enter is pressed on an option, then that harness × model × effort starts (with its mode and permissions) in Gluon's frame; ↑↓ wrap through the options"),
      "model-effort": b("when Tab or Shift+Tab is pressed, then the highlighted option's model or effort cycles, the others keep theirs; the hint names each key only when the highlighted agent has another", ["e2e", "seam"]),
      mode: b("when ctrl+t is pressed at the choice, then build → explore → plan cycles for every option, shown on each row (a proposal's own mode shown from the start), and Enter starts in it; with no choice open ctrl+t does nothing", ["e2e", "seam"]),
      "mode-unsupported": b("given a mode the highlighted agent can't run, then ctrl+t skips it (explore for Kimi Code), and Enter on an agent that can't run the chosen mode is refused with its advice first, nothing started", ["e2e", "seam"]),
      permissions: b("when ctrl+p is pressed, then the highlighted agent's permissions cycle (its own first), shown on its row and started with; an agent with none, or explore/plan, says why and changes nothing; the hint names ctrl+p only where it acts"),
      "keep-talking": b("when `keep talking` + Enter or esc is pressed, then the choice closes (`Tell the intake agent what to change`) and ↑↓ move on the list again"),
      "typed-reply": b("when text is typed at the choice (starting with a digit too; not just spaces), then it is a reply that gets a revised proposal; a lone digit + Enter picks that option"),
      "spec-fold": b("when ctrl+o is pressed, then the spec folds to one line (`(ctrl+o to view)`) and back, the agents staying"),
      "spec-scroll": b("given a spec too tall for the chat, then it is cut above the agents saying what is left out, and pgup/pgdn (and the wheel) scroll only the spec, never taking the options off screen; with the whole box in view they do nothing; after esc they scroll the chat"),
      fits: b("given any width, then the options and the hint fit: a wrapped option never ends a line in `·` or `×`, and the hint drops whole keys from its end", ["e2e", "seam"]),
    },
  },
  mouse: {
    says: "the mouse on the home view (docs/guides/keyboard.md)",
    entries: {
      "click-row": b("when a row is clicked, then it is selected; a click on the selected row, or a double-click, opens it, never scrolling the list; a click anywhere else, a release or another button does nothing and types nothing", ["e2e", "seam"]),
      "click-group": b("when a group label is clicked, then it folds or unfolds; a double-click folds it once"),
      "click-option": b("when an option of the question or the agent choice is clicked, then it is picked as its digit + Enter would; a click on `keep talking` closes the choice"),
      "drag-copy": b("when home text is dragged over, then it is copied with OSC 52 (the spec box's edges left out), highlighted, and Gluon says so; a key ends the selection", ["e2e", "seam"]),
      "capture-setting": b("given `handoff.mouse_capture` (on by default), then false leaves clicks and the wheel to the terminal, anything else is refused, and it is never per agent", ["seam", "e2e"]),
    },
  },
  markdown: {
    says: "how the chat's and the spec's text is drawn",
    entries: {
      inline: b("given bold, italic or inline code (nested too) in the agent's text or the spec, then it shows styled, never with its markers"),
      blocks: b("given headings, bullets (nested), numbered items, tasks, quotes, rules, tables and code blocks, then they render and wrap within the width (code wrapped, never cut), and a spec box cut to fit shows exactly its rows", ["e2e", "seam"]),
      fits: b("given chat text (the agent's, the user's, the spec), then it never overflows the terminal: wrapped lines hang under the text, keep their indentation, and tabs become spaces"),
    },
  },
  demo: {
    says: "Gluon's demo mode (`gluon --demo`, docs/getting-started/quickstart.md)",
    entries: {
      "scripted-intake": b("given `gluon --demo`, then the whole UI runs with a scripted intake agent whose spec is built from the task and the repository, with no API call", ["e2e", "seam"]),
    },
  },
  frame: {
    says: "a session in Gluon's frame: tab strip, info line, the agent's own UI in a box, the keys bar (docs/guides/sessions.md, keyboard.md, docs/concepts/architecture.md)",
    entries: {
      layout: b("given a session started, then the frame shows the tab strip at the top, an info line, a box with the session's triple in its top border holding the agent's own UI (its terminal exactly the box's interior), and the keys bar at the bottom; from 24 rows a blank row over the box"),
      "info-line": b("the info line shows the triple (with its mode and permissions), elapsed time, cost, context, files changed and the state, amber where it needs the user; unknown figures are left out; short of columns the figures go first and the state last, the triple cut but never dropped while it fits", ["e2e", "seam"]),
      "agent-screen": b("the agent's output (colours, emoji, CJK) is drawn in the box cell for cell with its cursor, the border never moved; a session off screen keeps running and, opened, shows what it printed meanwhile", ["e2e", "seam"]),
      "terminal-queries": b("given the agent asks the terminal something (DA1, cursor position, colours), then Gluon's screen model answers it and only the agent sees the answer", ["e2e", "seam"]),
      "keys-to-agent": b("every key but the home key and the switch arrows goes to the agent as the terminal sent it (ctrl+c, alt+pgup/pgdn too); a paste goes whole and in order (1 MB too; its own end marker ends it), never as Gluon's keys; a terminal reply or focus report reaches it only if it asked", ["e2e", "seam"]),
      "key-protocols": b("given any key protocol (VT, win32-input-mode, kitty CSI u) or a key split across reads (SSH), then the home view and Gluon's own keys read the keys they are; esc and a key in a later read are esc and that key, not alt+key", ["e2e", "seam"]),
      "mouse-to-agent": b("given an agent that asked for the mouse, then its reports reach it in its encoding, moved into its screen; a press outside its box is dropped, a release or drag after a press it got is held at the edge; below 20×6 it gets none", ["e2e", "seam"]),
      modes: b("the real terminal carries the shown agent's modes (mouse, focus, kitty keys), switched as sessions are shown and reset at home; bracketed paste stays on; on the agent's alternate screen the wheel is not captured; quitting, or an agent killed mid-output, leaves none on", ["e2e", "seam"]),
      scrollback: b("when the agent doesn't use the mouse, the wheel (3 rows) and shift+pgup/pgdn scroll the frame back with an indicator in its border; esc or q return; any other key leaves scroll mode and goes on to the agent", ["e2e", "seam"]),
      zoom: b("the home key then z gives the shown session the whole terminal but the last row (Gluon's: zoomed, how to leave, the counts, the scroll indicator, a question, the prefix bar, never the agent's); z again frames it; switching or going home ends it; a resize keeps it", ["e2e", "seam"]),
      resize: b("given any resize, a storm of them too, then every session's terminal gets the new size, the frame is redrawn whole at the last one, an idle session doesn't turn Working from its redraw, and the screen is what a fresh start at that size draws", ["e2e", "seam"]),
      "too-small": b("below 20×6 only one `too small` line naming the home key is drawn, on Gluon's ground, every cell; the agents keep 20×6; growing back redraws the frame", ["e2e", "seam"]),
      "one-update": b("each view change (session → session, → home, home → session) and each home question come as one synchronized update holding the clear and the whole new view; nothing is erased outside one"),
      note: b("a session's note (what its launch or mode couldn't do) is drawn over its frame, wrapped, never cut; short of rows its hint goes first; esc hides it without reaching the agent", ["e2e", "seam"]),
      "files-changed": b("given files changed in the checkout since a session started, then its info line counts them (new and changed; back to clean uncounted; a rename one path); outside a repository nothing", ["seam"]),
      "events-read": b("an agent's event (status, back, its session id) is read on the next poll whatever the file system's timestamp granularity; a backlog is read through; a missing directory gives nothing", ["seam"]),
      "no-console-writes": rule("while Gluon's views are up nothing is written to the console: a failure (a telemetry listener that can't start, a config it can't save) is one notice in the chat; without a pseudo-terminal what Gluon prints before the agent goes to stderr"),
      // Its tests are on `AgentSession` (src/pty/session.ts, no seam yet): the pty area's pilot picks the layer.
      "brief-line": b("given an agent that takes its brief as a typed line (Kimi Code; Codex and Grok Build's `/plan`), then Gluon types it once its input box shows, its Enter apart, once; if the user typed first or the box never shows, Gluon says the line and never retries", ["seam", "e2e"]),
    },
  },
  "session-state": {
    says: "a session's state and latest activity on its row and info line (docs/guides/sessions.md, docs/concepts/architecture.md)",
    entries: {
      hooks: b("given an agent with hooks, then its state is what they said (working, awaiting, turn finished) however idle or busy its screen looks; a finished turn reads awaiting input, never done", ["seam"]),
      activity: b("the latest activity is the agent's tool line while it runs; a turn's end says `Turn finished`, which the next turn's working clears; an answered question never leaves its tool line behind", ["seam"]),
      "screen-fallback": b("given an agent without hooks, then its input box on a screen quiet for `QUIET_AWAIT_MS` reads awaiting, output reads working, and a quiet screen with no input box (thinking) stays working", ["seam"]),
      "own-dialog": b("given the agent's own dialog waiting for a pick (folder trust, approvals, a plan approval, a question panel, a model picker), then it reads awaiting, on every harness that draws one; a look-alike in its output (a numbered list, hint-like words) doesn't", ["seam"]),
      interrupted: b("given a turn interrupted with Esc (its screen says so: `Interrupted`, `■ Conversation interrupted`, wrapped too), then the row goes back to awaiting after the quiet period although its hook said working; the words inside what the agent printed don't", ["seam"]),
      "not-work": b("output that isn't work (a redraw after Gluon's resize, late or ConPTY's at once, a key's echo, output that only sets terminal modes) doesn't make an idle session Working; real output after it does", ["seam"]),
    },
  },
  tabs: {
    says: "moving between sessions (docs/guides/keyboard.md, docs/getting-started/quickstart.md)",
    entries: {
      strip: b("`◆ gluon` then one tab per session in launch order (whatever its state), the shown one marked; too many for the width, the strip scrolls to keep the shown one whole and `‹N` `N›` count the hidden ones; a long name is cut with `…`", ["e2e", "seam"]),
      "home-key": b("in a session, in any state (a typed line, scrolled back, a question up), the home key opens a one-key menu whose bar says what the next key does: ←/→ previous/next tab, z zoom, the home key again home; esc cancels; any other key cancels and goes on as usual; it waits however long; a modifier alone picks nothing", ["e2e", "seam"]),
      arrows: b("on an untouched line (nothing typed since enter, esc or ctrl+c, or erased with as many backspaces; answers to the agent's own dialog don't count) ←/→ switch tabs, wrapping through home; alt+←/→ there are dropped; on a touched line all four are the agent's", ["e2e", "seam"]),
      click: b("a click on a tab shows it, on `◆ gluon` home, on `‹N`/`N›` the nearest hidden tab, whether or not the agent asked for the mouse; exactly where the strip draws them", ["e2e", "seam"]),
      bar: b("the bottom bar names the keys that work now: ←/→ only while an arrow would switch (another tab, an untouched line), the home key, and the other sessions' counts; short of columns the words shorten, the counts go, then the switch keys; the home key stays", ["e2e", "seam"]),
      "keys-follow": b("keys in the same burst as the → or Enter that opens a session reach that session's agent in order, never the hidden home composer; the home key twice among them goes home"),
      "back-event": b("the agent's `back` (`/gluon`, or its offer when the work looks done) shows home; the agent keeps running", ["e2e", "seam"]),
    },
  },
  "clear-compact": {
    says: "`/clear`, `/new` and `/compact` ask first (docs/guides/sessions.md, docs/concepts/architecture.md)",
    entries: {
      asks: b("given a typed `/clear` or `/new` (`/compact`), when Enter is pressed (on the agent's slash-menu item too, after edits or Tab, typed as kitty CSI-u keys, longer than 64 characters, after composed input), then the bottom bar asks `… ends this session in Gluon — end it?` (`End this session instead of compacting?`); a paste never asks; per harness (Antigravity has no `/compact`)", ["e2e", "seam"]),
      answer: b("Enter says yes (the session ends; keys typed right after go to the home composer); esc or ctrl+c sends nothing, the command stays typed and the line touched; other keys and pastes are dropped while it is up", ["e2e", "seam"]),
      bar: b("the question says what happens in Gluon; short of columns it keeps the command and what a yes does, its keys shrink then go; never `End G…`; a cut leaves no blank before its `…`; a resize while it is up redraws it", ["seam", "e2e"]),
      "reads-line": b("given any harness's screen as its release draws it (captured), then Gluon reads the typed line (rows the agent wrapped joined; a placeholder, a completion ghost or a grey hint is not input) and the slash menu's highlighted item; a screen it can't read for sure (no box, no highlight, two) is unsure", ["seam"]),
      settings: b("given `on_clear` / `on_compact` set to go on as the agent's own, then that command's Enter is never held and nothing asks", ["seam"]),
      "auto-compact": b("given Claude Code, Codex or Grok Build about to compact on its own (its `PreCompact` hook waits), then Gluon asks the same question; yes ends the session, no (or no answer) lets it compact", ["seam", "e2e"]),
    },
  },
  "session-end": {
    says: "a session that ends closes; quitting and signals end them all (docs/guides/sessions.md, docs/concepts/architecture.md)",
    entries: {
      closes: b("given an agent that exits (before drawing anything too), then its session closes: home shows, its row is gone, the other sessions stay, and the chat says how it ended (`exited (code 3)`); its End question, if up, goes with it", ["e2e", "seam"]),
      "on-exit-quit": b("given `on_exit: quit`, when the last session's agent exits, then Gluon exits with the agent's code"),
      signals: b("SIGTERM, SIGHUP or SIGINT to Gluon ends every agent (a grace, then SIGKILL) and gives the terminal back (normal screen, mouse and focus off, line mode, cursor); a second signal while it waits gives it back at once; in the setup menus a signal restores line mode and the cursor and exits 128 + n"),
      "agent-ends": b("when a session is ended (Delete, a yes at its question, quitting), then its agent gets SIGTERM, then SIGKILL after the grace; nothing is written to it after it exits, and keys for it are dropped", ["seam", "e2e"]),
    },
  },
  brain: {
    says: "where the intake agent runs: the brain order, its clients and the plans (docs/concepts/architecture.md \"The intake agent\", docs/guides/connections.md)",
    entries: {
      "first-working-step": b("the intake agent runs on the first step of `brain.order` that is connected (a plan step: its harness on the plan; a key step: the key) and answers a check, saved as `brain.active` with its effort; a step no longer connected is dropped from it; with nothing connected no step is found and nothing is probed; `gluon doctor` probes every connected step", ["seam"]),
      fallback: b("if the model becomes unavailable mid-chat (the provider's own wording for a missing or refused model, an id it doesn't know, access denied), the chat moves to the next working step and says so, the next brain getting a valid history (a loop brain a fresh one); with no next step the error is shown as before with its hint; a rate limit, an outage, a bad key, a plan limit, a too-long prompt, a connection error, an interrupt or a stream error never moves it; an error keeps its HTTP status and the provider's message", ["seam"]),
      effort: b("every call sends the step's effort explicitly, in its route's own field (`output_config.effort`, `reasoning.effort`, `outputConfig.effort`, the Agent SDK's option, Codex's `turn/start`), clamped to the nearest level the model takes (the cheaper on a tie), nothing for a model that takes none; a step without one runs at medium; the ChatGPT plan's levels come from Codex's catalog; a name that isn't an effort, or a level the model doesn't take, is a config error; the header shows what is sent", ["seam"]),
      labels: b("the step in use is named as a person reads it: the model's name from any provider's id (Bedrock's too) and where it runs; a long provider error keeps the part that matters", ["seam"]),
      requests: b("each route's request is what its provider takes: the prompt (cached where the API caches), Gluon's tools in its own format (route's schema whole on every route), the model, the token cap and the effort, nothing invented; Bedrock signed for the configured region", ["seam"]),
      streams: b("a reply streams its words as they come and returns its tool calls with the input their pieces make (none: empty; not JSON: an input the tool refuses); a cut-off reply says so (max tokens); a stream that errors, ends early or isn't one rejects with the provider's message; an abort stops it at once", ["seam"]),
      "claude-plan": b("on the Claude plan the intake agent runs only through the user's own `claude` (Agent SDK, `claude.exe` on Windows) with Gluon's tools as in-process MCP tools (every schema converts; a bad input refused) and its prompt unchanged; a sub-agent's events aren't its words; a failed result says why; `claude` ending mid-turn: the next message starts it again and says it forgot; not installed: the first message says so; Esc interrupts the query; a model that is gone moves the order on; an abort or close while the SDK loads leaves no live query", ["seam"]),
      "chatgpt-plan": b("on the ChatGPT plan through the user's own `codex app-server`: exploring, questions and proposals look as on any brain; approval requests are denied; Esc sends `turn/interrupt`; a failed turn, a codex without the experimental API, not signed in (or not with ChatGPT), a model the plan doesn't offer are each said plainly, once; `app-server` stopping mid-chat: the next message restarts it and says it forgot; its check is one tiny turn", ["seam"]),
      "chatgpt-plan-features": b("every Codex feature Gluon hasn't checked is turned off (only the names this codex lists; the tool-giving ones always), the catalog's own tools are cleared and the thread has no environment, agents, `request_user_input` or skills; a feature that stays on, an MCP server codex keeps, or a catalog field Gluon hasn't checked is a warning (the check passes, `gluon doctor` says what and why), never a refusal; a features list in a shape Gluon can't read is refused as such; a codex that fails to start after Gluon turned features off is told which; a refusal points at `gluon doctor`, never at retrying", ["seam"]),
      "chatgpt-plan-foreign-tools": b("a tool or item of Codex's own that gets through is interrupted (never killed), the model is told in a next turn of the same thread to use Gluon's tools, and its answer reaches the developer; a question waiting on the developer is interrupted only once answered; names codex sends are cleaned and capped; past `MAX_INTERRUPTS` the answer finishes as it is, with a warning; the check notes it and passes", ["seam"]),
    },
  },
  intake: {
    says: "the intake agent's tool loop: questions, the spec and the proposal (docs/concepts/architecture.md \"The intake chat\", docs/getting-started/quickstart.md)",
    entries: {
      "confirm-first": b("nothing launches until the developer confirms an option; a reply goes back to the intake agent; confirm starts the option picked (by index, adjusted) with the proposal's name, mode (a ctrl+t override wins; build is none) and routing data; the spec launched is the intake agent's, trimmed, with no line about returning to Gluon added", ["seam"]),
      "route-then-propose": b("`propose_launch` can offer only `route`'s last result (its agents, mode and why); without a route it's an error saying to call `route`; a message from the developer after a route needs a new one; a reply goes through `route` again", ["seam"]),
      "proposal-checked": b("an invalid proposal goes back to the intake agent as an error, never shown; after two invalid tries the turn stops and the next message keeps the conversation valid; checked: a launchable recommended agent (a known harness and model, an effort it takes), a spec of text, not blank, no bigger than a workspace saves, at most two valid, distinct alternatives; the input's agent fields are never read, types route wasn't given are dropped", ["seam"]),
      name: b("a session's name is `Gluon-` and a kebab-case ASCII slug, at most 24 characters cut at a word, never prefixed twice; when the intake agent gives none or an invalid one, it comes from the spec's first line without filler words (else `session`); a name another session has gets `-2`, `-3`…", ["seam"]),
      questions: b("`ask_user` asks at most one batch per proposal round (enforced in code), at most four questions (the first and three next) of at most eight options each, trimmed, its own \"Other\" option dropped; they come one at a time and the answers go back together after the last; a bad next question is refused with a reason; an answer typed while a series is open answers the one shown, and one to `keep talking` is a reply; a loop brain asking two at once gets one answered, the other skipped", ["seam"]),
      "turn-limits": b("a turn stops after too many model calls, or a loop brain that goes on, with a notice shown once; past the repo-tool budget (twelve) the rest are answered with a budget error and shown as skipped; a tool call whose input isn't an object is answered as a bad call; the next message is clean", ["seam"]),
      "empty-reply": b("a reply with no words and no tool call (blank, thinking only, after tool calls, after the developer's answer, on a plan brain too) tells the developer and leaves the history so every later request is valid on every route; mid-turn it rewinds the whole turn", ["seam"]),
      "failed-turn": b("an error in the middle of a stream keeps the words shown, masks a key in its message, and the next message goes on from a valid history; Esc while a repo tool runs ends the turn with the Interrupted notice and drops the unanswered call", ["seam"]),
      prompt: b("the intake agent's system prompt says what the spec is (asks for the outcome behind a symptom, keeps unasked scope out of Assumptions, writes only what it saw as Context), how routing works and each mode's route, that an answer it gives itself only read the code (offering a session to verify it), and nothing of worktrees; its slots are routing.yaml's notes, the types, the agents offered and the repository", ["seam"]),
    },
  },
  routing: {
    says: "which agent, model and effort runs a session (docs/guides/routing.md, docs/concepts/architecture.md \"Routing: routing.yaml and route\", docs/reference/routing-yaml.md)",
    entries: {
      rank: b("given a level, then the recommended model is the first in that level's `rank` list that is connected, reachable, allowed and can give the effort; a model in no list is never routed to; moving a model between lists moves the routing", ["seam"]),
      "round-up": b("given a level with no such model, then it rounds up to the next, with one effort step less per level it rounded, and the reason names the steps applied; nothing at or above it is an error naming the level", ["seam", "e2e"]),
      steps: b("each of the intake agent's types moves the model (-2 to +2 levels, never below light) and the effort (0 to +2 steps); a session takes the strongest mode, level and effort across its types; the mode the developer asked for wins; a step out of range is refused", ["seam"]),
      effort: b("the effort is relative to the chosen model's own default (medium = its default, high = one above); a model that can't give it is skipped for the next that can (a model with no effort control included); max only when pinned or the model's default; the session line names the model's default and the effort it gets", ["seam"]),
      limits: b("`never_harnesses`, `never_models`, `max_model` and `max_effort` are never crossed, not by the pick, an alternative, a preference or a pin; `max_effort` defaults to max; limits that leave nothing give an error that says so, never a throw", ["seam"]),
      pins: b("a developer pin (a harness, `harness/model`, `@effort`) is kept with no alternatives; one to a harness not connected, an unknown or another harness's model, a wrong case, a malformed pin (`claude-code/sonnet@`) or an effort its model doesn't take is refused naming what was given; a harness pin with nothing at the level falls back to its best model below; a type's `use:` applies only when every type shares it, and an unavailable one falls back to routing with a why line", ["seam"]),
      prefer: b("a `prefer` note puts a harness first within each level, or a step, and is quoted (`because`); one naming an unavailable harness is dropped and said so; a note never crosses the limits", ["seam"]),
      "opt-in": b("the Contributor variant (`allow_muse_contributor`) is never used, offered or pinned unless the key is `true`; on, it is first in its rank at xhigh at most; a value that isn't true or false is flagged; a denied model isn't blamed on the opt-in", ["seam"]),
      "mode-capable": b("a session in a mode a harness can't run (Kimi Code's explore) never goes to it: not the pick, an alternative, a preference or a pin, and `use:` falls back; the intake agent is told which harness can't run which mode", ["seam"]),
      catalog: b("route works on the models Gluon offers: harnesses connected, models reachable (a probe that failed hides one; one never probed is offered), from this build's catalog with each model's id and efforts on the connection that serves it (a plan before a key for the same model); a maintainer's test model never reaches a user", ["seam"]),
      "available-agents": b("the intake agent's prompt lists the agents Gluon offers (ids and names, the opt-in model first once on, models in no rank list last) and says why each other one isn't offered (not connected, denied, above a limit); a model route would refuse is never listed", ["seam"]),
      "subagent-note": b("an OpenCode launch whose model family has several ranked models gets a line naming them for its subagents, cheapest first, by concrete id, never above `max_model`; none for a one-model family or another harness", ["seam"]),
      file: b("`routing.yaml` is next to `config.yaml`; a missing one is written from the embedded default, privately; an existing one is read, never overwritten; an empty one gives empty sections; one that isn't valid YAML, isn't a mapping, has a duplicate key, can't be read or is an alias bomb is refused naming its path (and line); anchors, aliases and merge keys work; a directory Gluon can't write warns and the default applies", ["seam", "e2e"]),
      check: b("`routing check`'s findings: an unknown model or level, a bad limit, a pin to nothing or a malformed one, a wrong shape, a key that looks like a typo of one routing.yaml has (top level, in limits, in a type; such a key is ignored); the shipped default has none; a file with wrong shapes never crashes route, the prompt or the check", ["seam"]),
      commands: b("`gluon routing path` says where the file is (writing nothing), `check` prints its findings and exits 1 (0 and `ok` when clean, 2 when the file is unusable) and says when an edited file predates this Gluon's default, `default` prints the embedded default (writing nothing); a bad subcommand is refused"),
      upgrade: b("an unedited older shipped default (line endings aside) is replaced by the current one at load, privately, and said once; an edited file is never touched; a read-only one is not replaced and the current default applies for the run, said once; the embedded default is the last shipped one", ["seam"]),
      "default-valid": rule("whatever the shipped `routing.yaml` and this build's catalog route to is valid: a connected, allowed agent within the limits, with an effort its model takes, and a launch a proposal accepts, for every type × steps × mode × limits × connected set; the default names only this build's models, every type lists the same fields at medium effort, and its commented examples parse", ["seam"]),
    },
  },
  setup: {
    says: "the setup screens (docs/getting-started/connect-agents.md \"Run setup\", \"Move around the screens\")",
    entries: {
      checklist: b("the first screen, \"Connect your coding agents\", lists the six agents, each marked installed or missing with its official install command; Esc on it leaves setup"),
      keys: b("a digit moves the selection and Enter confirms; a digit and Enter in one menu answer that menu only; keys that arrive in one read are handled one by one; a digit pressed the moment the next menu appears is honoured"),
      back: b("Esc goes back one screen with the earlier answer selected, within an agent and across agents, from a key or AWS prompt, past a login handoff (never running it again); the footers say `esc to cancel` on the first screen and `esc to go back` after it"),
      quit: b("Ctrl+C in a menu or a key prompt quits setup at once: exit 130, nothing probed, nothing written"),
      "nothing-until-done": b("nothing (config or keys) is saved until the last screen is answered; leaving or quitting changes nothing, a pasted key included; unchecking a connected agent disconnects it after asking (`Keep connected` keeps it)"),
      "terminal-replies": b("a terminal's late reply (OSC 11, either terminator, its rest coming later) never closes a menu, types into a key prompt or counts as Esc; a real Esc still does"),
      "menus-fit": b("a menu fits the terminal: its margins go first, then its body is cut at whole lines from the first (the install command first), then its list scrolls with the cursor; the title stays and the screen is never cleared", ["seam", "e2e"]),
    },
  },
  detection: {
    says: "finding the agents (docs/getting-started/connect-agents.md, docs/guides/troubleshooting.md)",
    entries: {
      "on-path": b("an agent is installed when its binary is on the PATH (an explicit PATH searched instead of the environment's), resolved to an absolute path; otherwise it says why not", ["seam"]),
      "wsl-windows-install": b("on WSL a Windows install alone (under `/mnt/<drive>/`, `.exe` / `.cmd`) is found but not used: setup, `gluon doctor` and `gluon brain` name it as a Windows install to redo inside WSL, never \"not installed\"; a Linux one later on PATH wins", ["seam", "e2e"]),
    },
  },
  "sign-in": {
    says: "a subscription's sign-in (docs/getting-started/connect-agents.md \"With a subscription\", docs/guides/connections.md, the agent pages)",
    entries: {
      "status-check": b("given a subscription, then Gluon runs the agent's own status check: signed in, no notice and straight to the check; signed out, it offers the agent's own login (a terminal handoff) and checks again; not now, nothing is connected; an agent without a status command (Kimi Code) is asked after its login"),
      "plan-only": b("only a sign-in to the plan counts as the subscription: an agent signed in with an API key (Claude Code, Codex) is not on the plan, which it says, offering the login; an `OPENCODE_API_KEY` variable or a sign-in OpenCode wants redone isn't the OpenCode Go plan", ["e2e", "seam"]),
      "handoff-input": b("a login handoff gets the terminal: the first line typed reaches the login"),
      "status-read": b("an agent's own status, list and version output is read as the vendor prints it: a plan by its label and nothing of the account (an email never comes through); signed out is a definitive answer; garbage, an empty answer, a non-object JSON or a crash is a transient failure saying what the binary printed, keys masked; a check that hangs is killed at its timeout, and a child holding the pipe doesn't hold it", ["seam"]),
    },
  },
  connections: {
    says: "the ways in: plans, API keys, Bedrock, OpenRouter (docs/guides/connections.md)",
    entries: {
      choice: b("for each checked agent, the ways in it takes (connections.md's table), the API-key providers above the plan, the model maker's own key provider first", ["e2e", "seam"]),
      "api-key": b("pick the provider, then paste the key or reuse one already set (the environment, the `.env` next to the config); a pasted key is saved next to the config (0600), never shown, and is what Gluon and the agent use, even when the same variable is exported; nothing of the agent's own is written"),
      bedrock: b("Bedrock asks for the AWS profile and region, never credentials; Enter on an empty line pins neither and shows what Bedrock will use; a configured profile and region are pre-filled, typing one pins it"),
      "env-warning": b("a variable of the user's that would change what a plan connection does (`ANTHROPIC_API_KEY`) is pointed out, never removed"),
      "told-what-to-set": b("where an agent takes a setting Gluon must not write (Antigravity's Gemini key), setup says what to set in the agent's own settings"),
      "opencode-providers": b("OpenCode takes a checklist of providers and `Add another`: its plan through OpenCode's own login, OpenRouter by its key, both together (a launch gets only its model's key, the plan none); Esc at `Done / Add another` goes back, never Done, and leaving keeps the previous connection"),
      reachable: b("a check's results are kept with their date: a model found unreachable is left out, one never checked is offered; only a definitive answer (signed out, a key rejected, a model not listed or refused) changes them, a passing failure (timeout, network, limit, 5xx) shows ✗ with its reason and keeps the last results; Bedrock's refused models are named and the rest still offered", ["e2e", "seam"]),
      "check-at-end": b("after the last screen, with any agent connected, Gluon checks every model of every connection and the intake agent's order, prints a summary and starts; with nothing chosen nothing is checked, no config is written, and it says what to do"),
      "aws-setup": b("Bedrock uses one AWS profile and region for the intake agent, the checks and the launches; with no region configured or in the environment, the profile's region from the AWS config (not us-east-1); the profile goes to the SDK's credential chain, never into the environment", ["seam"]),
      "check-method": b("a check asks each connection the true, cheap way: a subscription through the agent's own binary, a key through the provider's model listing (OpenRouter's key endpoint, since its listing is public; the OpenCode plan's public listing, no key sent), Bedrock a tiny call that returns its usage and a readable error; a listing counts an alias by its dated snapshot, agy's by its own id plus an effort", ["seam"]),
    },
  },
  launch: {
    says: "how Gluon starts each harness: its argv, environment, adapter and private files (docs/guides/harnesses/*, docs/concepts/architecture.md, src/AGENTS.md)",
    entries: {
      "spec-last": b("given any spec (one starting with `-` too), then the harness gets it as its prompt's value, last (after `--`, or as `--prompt=` / `--prompt-interactive=`), the adapter's and the mode's options before it; Gluon's tokens are replaced in argv, env and files, never in the spec", ["seam", "e2e"]),
      environment: b("given a harness and a connection, then the launch's environment is the user's plus only the saved key of the model's provider and what makes the harness use it (its own variable names, the model and its window; OpenCode's inline config); an effort only where the connection takes one", ["seam", "e2e"]),
      "instruction-file": b("given a repository with an instruction file the chosen harness doesn't load itself (`CLAUDE.md` for Codex…), then the spec ends with a line telling it to read that file; only then", ["e2e", "seam"]),
      adapter: b("given a launch from Gluon, then the harness gets Gluon's adapter for that launch only (Claude Code's plugin and settings, Codex's `-c` per hook event, OpenCode's inline plugin), nothing written to the user's settings or workspace; Codex's hook set is one constant; the only command allowed is Gluon's own return command, exactly", ["seam"]),
      "version-gate": b("given a harness older than its adapter supports (or a version Gluon can't tell), then it gets no adapter; OpenCode before 2.x isn't started and the spec is printed with the command that installs 2.x", ["seam", "e2e"]),
      "windows-shim": b("given a harness installed as an npm `.cmd` shim, then the native exe behind it runs when there is one (inside the shim's own `node_modules`, for this machine's arch: Claude Code, OpenCode, Codex's platform package); otherwise its arguments pass `assertShimArgs` (nothing cmd.exe acts on: refused naming the character, no file left) and the spec goes in a private file named by a one-line prompt, as it does on an exe for a spec too long for a command line; a temp path cmd.exe would act on goes by its 8.3 short name", ["seam"], ["windows"]),
      "self-command": b("given a launch, then the harness's hooks and plugin reach this Gluon through `GLUON_SELF`; on Windows a `.cmd` wrapper that quotes every word, doubles `%` and turns delayed expansion off runs Gluon with exactly its words from cmd.exe, PowerShell and `Bun.spawn`, whatever its path holds; a word it can't quote is refused", ["seam"], ["windows"]),
      "private-dirs": b("a launch's private directories (events, adapter files, a typed line's spec, the neutral cwd) are 0700 outside the repository and go when the agent ends; a stale one (its Gluon gone, or a day old) is swept, never a running Gluon's", ["seam", "e2e"]),
      "model-effort": b("given a harness × model × effort, then the harness starts with its own options for them before the spec (`--model`/`--effort`, `-m` + `model_reasoning_effort`, `--model=<id>-<effort>`, `--reasoning-effort`; OpenCode through its inline config), the model's concrete id; an effort the model doesn't take is refused before the launch", ["seam"]),
    },
  },
  modes: {
    says: "build, explore and plan per harness, and the permissions (docs/guides/modes.md)",
    entries: {
      "per-harness": b("given explore or plan, then each harness starts as modes.md says, its own flags or settings before the spec (Kimi Code: `--plan`, no explore); build adds nothing; a mode's config never replaces the model's", ["seam"]),
      "needs-frame": b("given a launch that needs a typed line (Codex and Grok Build plan, Kimi Code always), then where nothing can type (`--launch`, no pseudo-terminal) it is refused before anything starts, a dry run too, naming the harness", ["seam", "e2e"]),
      "brief-block": b("given explore or plan, then the spec ends with a short block saying what the mode allows, whatever the spec said and naming no harness; build adds none", ["seam"]),
      "explore-read-only": b("given explore, then the brief says commands that write (tests and builds too) may be refused or fail, so the agent reads the code and says what it couldn't run; the intake keeps the session's Done to what reading can show", ["seam"]),
      permissions: b("given a permission level, then the harness starts with its own flag for it (its own: nothing); a level it doesn't have is refused; explore and plan keep their own flags; a resumed build session gets its level again", ["seam"]),
      "on-resume": b("given a resumed session, then explore's launch-time enforcement is applied again, plan and build nothing, never a typed line, a spec or a brief; a Codex, Grok Build or OpenCode session saved with no mode is refused (a Claude Code one resumes)", ["seam", "e2e"]),
    },
  },
  resume: {
    says: "saved workspaces and reopening a harness's own session (docs/guides/sessions.md \"Save and resume sessions\", docs/concepts/architecture.md \"Saved sessions and resume\", docs/reference/cli.md, the harness guides)",
    entries: {
      argv: b("given a saved session, then it is reopened with its harness's own resume under its id, with no spec; Antigravity and Kimi Code can't be resumed; an id that could read as an option never reaches argv", ["seam"]),
      "session-id": b("given a harness that makes its own session id (Codex, OpenCode), then its hook or plugin sends it as a `session` event (the top-level session's only; before a compaction waits); an id outside the fixed pattern is dropped", ["seam"]),
      saved: b("given a launch, then a workspace with a fresh six-character id is made at the first session (never before; an empty Gluon saves nothing and prints no resume line), the header and the chat name it, and it records per session the name, harness, model, effort, mode, permissions, directory, the spec (keys masked) and the harness's own resume id; quitting prints `Resume this session: gluon resume <id>`", ["seam", "e2e"]),
      "record-lifecycle": b("a session the user ends, or whose agent exits, leaves the record, and the last one takes the file (the id kept for the next); a session marked done stays, marked; quitting, a SIGTERM (a question up too) or a crash keep the record (a crash says how to resume on stderr); a change is written once, whole; a resumed workspace continues the same file and keys; two Gluons on one file never lose each other's sessions; a failed save never throws and is said once", ["seam", "e2e"]),
      limits: b("Gluon records only what it can read back: at most 200 sessions, a spec of 1,000,000 characters, a 4 MB file, a name cut to fit with its day; a session past a limit still runs, unrecorded, and is refused out loud; the sessions saved stay readable; a field or a resume id the reader would drop is never written", ["seam"]),
      "private-file": b("the workspace file is private (0600, written directory-first, a warning from the private write said once); keys in a spec or a name are masked on disk and when read (URL passwords, `password=`, PEM blocks, a key known only later), a model id is kept; a symlinked file is replaced by a save, never written through", ["seam"]),
      "untrusted-file": b("a workspace file is untrusted text: a corrupt, foreign, oversized or linked file is skipped, a bad session dropped and the others kept; names become one safe line, controls refused; a directory that is not absolute, a UNC share, or a file is never entered; a time a Date can't show refuses the file; odd keys (`__proto__`) reach nothing; a copy under another name isn't listed as that one; an escape from the file never reaches the terminal (`gluon sessions`, errors, the home view, the chat, the question); an older Gluon's record (a worktree) loads", ["seam", "e2e"]),
      "unreadable-listed": b("a saved file that can't be read (a hand edit, a crash mid-write, a newer Gluon, a copy, a dangling link) is no session: `gluon sessions` names it with the way to remove it, and `--delete` with its file's id removes it alone; a readable one beside it stays listed", ["seam", "e2e"]),
      list: b("`gluon sessions` lists every directory's workspaces, newest first, this directory's first and marked (directories compared as the OS does), each named for its directory and day, with the time it last changed in local time and its offset from UTC (`UTC` alone at 0); with none it says so", ["seam", "e2e"]),
      find: b("`gluon resume <id>` (a unique prefix is enough), from any directory, runs in the saved one and says so; an unknown or ambiguous id, or a saved directory gone, moved or not one, stops before anything starts (exit 1) with what to do next; with no id: on a terminal a picker of this directory's workspaces (`--all`: every one's), newest first, Enter reopens, Esc exits 130; without one it prints them and exits 2 (none: 1); `resume` takes one id, `--all` only with resume and sessions"),
      reopens: b("when a workspace is resumed, then Gluon starts with a fresh intake chat and reopens each session with its harness's own resume, no spec sent, in the saved directory (a relative `GLUON_CONFIG` still names the same files); sessions with one name are both reopened; an effort its model no longer takes is dropped; without a pseudo-terminal each one is asked about in turn and gets the terminal itself"),
      "cannot-resume": b("a session that can't be reopened (Antigravity, Kimi Code, no id from its hook, a harness that refuses soon after starting) is asked about on the home view, one at a time once the others are up: Enter starts it again from its spec (same key, the refused id forgotten), Esc drops it from the record, Ctrl+C keeps it; it never comes while the chat holds text and gives way to typing; an agent not connected or a model gone: the chat says neither is possible, names the delete option, and the record stays; a refusal that exits 0 is an ordinary end"),
      "one-gluon": b("a workspace another live Gluon has open is refused naming its process, `--force` opens it; two resumes at the same moment: exactly one gets in (a private claim taken at once, gone at exit); a pid reused by another process, a dead or garbled claim, or a crashed takeover never blocks (macOS: the pid alone)", ["seam", "e2e"]),
      delete: b("`gluon sessions --delete <id>` removes that workspace's file and claim only; on a terminal it asks first (anything but y deletes nothing), without one it needs `--yes`; an unknown or ambiguous id stops; a workspace another live Gluon has open needs `--force`; `--force`, `--delete` and `--yes` go only where they belong", ["seam", "e2e"]),
      "unsaveable-dir": b("given a directory that can't be saved (a network path, control or direction characters), then nothing is recorded: no workspace in the header, no resume line on quit, and the chat says why once; spaces or a drive are fine", ["seam", "e2e"]),
      "uninstall-waits": b("`gluon uninstall` while a Gluon runs (its pid in a workspace or a claim) refuses naming that process, removes nothing, asks nothing and exits 1; once it has quit, uninstall removes the workspaces and claims", ["seam", "e2e"]),
    },
  },
  events: {
    says: "the events channel between a launched agent and Gluon (docs/concepts/architecture.md \"The events channel\")",
    entries: {
      "inert-outside-launch": rule("given a hook, plugin or command of Gluon's run outside a launch from Gluon (no `GLUON_EVENTS` or `GLUON_SELF`, or half of them), then it does nothing and prints nothing (exit 0); inside one it runs this Gluon with the harness's input", ["seam", "e2e"]),
      strict: b("an event is read strictly: fixed names, bounded sizes (a larger file is never read), known fields of the right types; a FIFO, a symlink or a directory is never read or followed; the activity line is made safe to draw (no escapes, controls, bidi or format characters, at most 120 characters); anything else is ignored", ["seam"]),
    },
  },
  "session-settings": {
    says: "the config's `handoff` section (docs/guides/sessions.md \"Settings for sessions in Gluon\")",
    entries: {
      defaults: b("the defaults are: close the session on exit, ask at `/clear` and `/compact`, `ctrl+\\` (a saved `ctrl+]` kept); a mapping under `agents` overrides any of them for that agent; first-version values are updated, the user's other values and comments kept", ["seam"]),
      refused: b("a bad value, an unknown setting or an unknown agent is refused naming the allowed ones; an earlier version's `nudge` is accepted and ignored", ["seam"]),
      "added-at-first-launch": b("the section is added, with a comment for each value, at the first launch from the UI, never before, only to a config that has none, never making a valid config invalid", ["seam", "e2e"]),
      doctor: b("`gluon doctor` shows, per connected agent, the settings in effect and what its adapter does with them, and the permanent files; never a ✗ for them", ["seam"]),
    },
  },
  "no-pty": {
    says: "a session without a pseudo-terminal (docs/concepts/architecture.md \"Without a pseudo-terminal\")",
    entries: {
      "hands-terminal": b("given no pseudo-terminal, when a session starts, then the agent gets the terminal itself and the home view comes back when it ends (its exit code said, the terminal reset, keys it never read kept from the composer); `back` ends it at once with a note; a status event never ends it", ["seam", "e2e"]),
      "no-questions": b("given no pseudo-terminal, then `/clear` and `/compact` don't ask, and a waiting compaction hook gets no at once", ["seam"]),
    },
  },
  "direct-launch": {
    says: "`gluon --launch` (docs/reference/cli.md, docs/guides/modes.md)",
    entries: {
      terminal: b("`gluon --launch` gives the agent the terminal directly: no events channel, no adapter files, no line about returning, the handoff settings ignored; Gluon exits with the agent's code; a signal to Gluon ends the agent too"),
      mode: b("`--mode` takes build, explore or plan, and only with `--launch`; explore and plan add the harness's own options before the spec; build adds nothing"),
      refused: b("a bad model, harness or effort is refused naming the valid choices; an agent that isn't installed fails with 127 and prints the spec"),
      "dry-run": b("`--dry-run` prints the exact command (argv) and environment as JSON and starts nothing; every key in it is masked, whatever its shape, for every provider"),
    },
  },
  cli: {
    says: "the command line: `gluon --help`, its flags and subcommands (docs/reference/cli.md, docs/getting-started/quickstart.md)",
    entries: {
      help: b("`gluon --help` (and `-h`; after a subcommand such as `cost-report` or `uninstall` too; with a broken config too) prints the usage and exits 0: the version, every subcommand and flag, and every harness with its models and their efforts from the built-in catalog, never the config's"),
      version: b("`gluon --version` prints the version alone and exits 0"),
      "bad-args": b("an unknown flag, a flag without its value (`--launch=`, an empty `--effort` or `--model`), a launch flag (`--model`, `--effort`, `--dry-run`, `--mode`) without `--launch`, `--launch` without `--model`, or extra words after a subcommand: one `gluon: …` line naming the flag or the subcommand's form, exit 2, no stack trace, nothing started"),
      "did-you-mean": b("a word close to a subcommand (any of them: `stats`, `pricing`, `cost-report` too) gets `did you mean \"gluon <it>\"`, exit 2, and no chat starts with the typo"),
      "task-words": b("words that aren't a subcommand are the intake chat's first message (`gluon \"fix the add bug\"`; `gluon mcp` too); a prompt that starts with `- ` is the prompt and flags around it stay flags, `--` ends the options; typed in a terminal, words starting with `signal` or `hook` say how to quote them (inside an agent they stay silent)"),
      "needs-terminal": b("Gluon's UI (the chat, `--demo`) without an interactive terminal refuses, saying it needs one, exit 2"),
      "no-agents": b("with none of the agents' binaries on PATH, Gluon says which it looked for and exits 2"),
    },
  },
  config: {
    says: "the config file (docs/guides/connections.md \"Know where things live\", docs/reference/config.md)",
    entries: {
      refused: b("a config that is no valid config (not YAML, not a mapping, a wrong type, an unknown harness, route or provider, a first version's `auth:` with a malformed `connections:`, a path that can't be read) is refused naming the key and what is allowed (or that it's unreadable), exit 2, no stack trace"),
      "defaults-and-migration": b("an empty config uses the defaults; a first version's config is migrated (on disk; in memory with one warning when the file can't be written, the output and exit code as usual); a key no longer read (`models:`) is ignored with one notice", ["e2e", "seam"]),
      paths: b("the config is at `GLUON_CONFIG` (made absolute at start) or under `XDG_CONFIG_HOME` (a relative one ignored, as the XDG spec says), else `%APPDATA%\\gluon` on Windows, `~/.config/gluon` elsewhere; the keys and `routing.yaml` go next to it, never into the repository Gluon runs in; the state (the ledger, the tables) under `XDG_STATE_HOME` (a relative one ignored), `%LOCALAPPDATA%\\gluon` on Windows, else `~/.local/state/gluon`", ["e2e", "seam"]),
      "written-in-place": b("when Gluon writes the config (setup, connect, doctor, the intake), then only the keys it sets change: the user's comments and other values are kept", ["seam"]),
    },
  },
  doctor: {
    says: "`gluon doctor` and `gluon brain` (docs/concepts/architecture.md \"Checks: gluon doctor\", docs/guides/troubleshooting.md)",
    entries: {
      checks: b("`gluon doctor` checks each agent (installed with its version, connected), each connection's models (✓, or ✗ with the reason) and the brain order with the step in use marked; what's missing gets its install command; a key's source is named (the environment, Gluon's `.env`, an AWS profile and region), never the key; exit 1 on any ✗, or with no working brain step or no launchable agent (`·` lines and `!` notes don't count); each run starts clean", ["seam", "e2e"]),
      brain: b("`gluon brain` prints the brain order: each step ✓, ✗ with its reason, `·` not connected, or not tried (naming the step in use), the step in use marked with its effort (its own, the default marked, or none); exit 1 and the hint to run doctor when no step works", ["seam", "e2e"]),
      warnings: b("given a Codex with features on that Gluon hasn't checked, then the ChatGPT-plan step still shows ✓ with a `!` warning under it, and `gluon doctor` says it once per harness, not once per model", ["seam"]),
    },
  },
  uninstall: {
    says: "`gluon uninstall` (docs/getting-started/install.md \"Uninstall\")",
    entries: {
      asks: b("in a terminal it lists what it removes and asks `[y/N]` (anything but y keeps everything); without one it needs `--yes` and removes nothing; it takes only `--yes` (and `--help`)"),
      removes: b("it removes the config, the saved keys, `routing.yaml` and the saved sessions next to it, Gluon's files in the agents' directories, the cost audit ledger, the price tables, the analytics database (with `-wal`, `-shm`) and its stale temporary directories, then the default config directory once empty, saying `Removed <path>` for each; with nothing left to remove it still succeeds"),
      "only-gluons": b("it never removes anything else: with `GLUON_CONFIG`, only Gluon's files there (never that directory, the user's own files, their `.env` minus Gluon's keys, their own `.gluon-*` or workspace-named files), the state directory around Gluon's, a running launch's spec and neutral directories; a symlink at a path it removes is never followed; it says it removed only what it removed"),
    },
  },
  windows: {
    says: "Gluon on native Windows (docs/concepts/platforms.md \"Windows\", src/AGENTS.md \"Windows\")",
    entries: {
      "process-trees": b("on Windows, a process Gluon stops or times out (an agent, a check, a probe, a tool) is ended with its children: `taskkill /T /F` by full path, `kill()` when that can't run; a process that already exited is left alone (its PID may be reused)", ["seam"], ["windows"]),
      "private-keys": b("on Windows, the saved keys and every private file are limited to the user: inside the profile by its ACL, outside it (another drive, a UNC share, a sibling profile) by `icacls` to the user's SID (from `whoami`'s CSV, never the user name), set before a key is written; an 8.3 short path is compared in its long form; the setup says what each OS does (`storageNote`), never \"readable only by you\" on Windows", ["seam"], ["windows"]),
    },
  },
  analytics: {
    says: "what Gluon records about sessions (docs/guides/analytics.md, docs/guides/security-privacy.md \"Session analytics\", docs/concepts/architecture.md \"Session analytics\")",
    entries: {
      "row-per-session": b("given a session started, resumed, restarted or launched directly (`--launch`; never a dry run), then it is one row from its start (no file or directory before the first one): its id, name and kind (new, resume, restart, launch), directory, repository and branch, the agent with its version, model, effort, mode and connection, the intake's classification and why, the spec, the agent's own session id (Gluon's, or captured by hook), the times, the exit code and why it ended, and Gluon's own cost and context (the last real reading); a resumed session starts a new row each time; the first end counts and a late cost still lands", ["seam", "e2e"]),
      status: b("a row's status is worked out when read: running while refreshed within `HEARTBEAT_MS` (a minute), ended once it has an end, unfinished otherwise (Gluon died); a running Gluon refreshes its open rows (a long `--launch` too); quitting, or a crash Gluon survives long enough to see, ends its open sessions as quit with no exit code; an unfinished session's time counts to its last refresh", ["seam", "e2e"]),
      masked: b("given keys in a spec, a name, a path or the routing lines (every documented shape, pasted however), then the file holds them masked and never the key; a spec is cut at 100,000 characters, a key straddling the cut masked first; a 5 MB spec is masked in well under two seconds; no environment and nothing an agent's screen showed is ever recorded", ["seam"]),
      "private-file": b("the state directory is 0700 and `analytics.db` with its `-wal` and `-shm` 0600 however loose the umask (Windows: the user, SYSTEM and Administrators only, each file once it exists and before a row is written), a looser one already there made private again; a state directory that is a symlink (a dotfiles setup) records into its checked, private target; a link to someone else's directory, or a link at the database file, is refused, never followed; a failing ACL call never stops recording", ["seam"]),
      off: b("`analytics` is `on` by default; `on`, `off`, `true` and `false` are read, anything else is refused naming the key; given `off`, then nothing is recorded and no file or directory is made, however many sessions run (`--launch` too); a file already there stays", ["seam", "e2e"]),
      "never-breaks": b("recording never gets in the way of work: a write that fails is dropped and the next one heals the row; three failures in a row switch recording off for the run (and close the file); a file that is no database, or of a newer schema, is left as it was; a locked file doesn't count as a failure: one tick waits for it once (well under a second), and a row or an end skipped for it is written once it is free, at the latest at close; close leaves no `-wal` or `-shm` of this process and the file free", ["seam"]),
      "two-gluons": b("given two or three Gluons recording into one file at once, then every session and every figure is there", ["seam"]),
    },
  },
  stats: {
    says: "`gluon stats`: reading what was recorded (docs/guides/analytics.md, docs/reference/cli.md)",
    entries: {
      summary: b("`gluon stats` groups by agent (sessions, time, cost, unfinished), or `--by` model, day (local days, newest first, right in a zone with a 23- or 25-hour day or a half-hour offset) or repository (else the directory), with a header and a total; a cost is `$` counted, `~$` with an estimate in it, `—` with no figure, and a summary adds only the figures it has; `--limit` cuts the groups and says so, the total whole", ["seam", "e2e"]),
      filters: b("`--agent`, `--repo` (any part of its name or path, any case; wildcards and quotes literal), `--since`/`--until` (a local day, as `--until` the end of it; a day and time; a span back from now: `7d`, `24h`, `2w`, `30m`) narrow the summary and the list; a day that doesn't exist is refused; `--since` after `--until` is an empty answer; a filter that matches nothing says so", ["seam"]),
      sessions: b("`gluon stats sessions` lists the newest sessions (50 by default, the limit in SQL), each with an 8-character id, start, time, `agent/model/effort/mode`, cost, status, repository and name; neither it nor the summary reads a spec", ["seam"]),
      "one-session": b("`gluon stats <id>` shows one session in full with its spec: found by its id, by a start of it of 4 or more characters, or by the agent's own session id; one that matches several rows (an ambiguous start, a resumed session's agent id) lists them and exits 1", ["seam"]),
      json: b("`--json` prints the summary (groups and total), the list and one session (its JSON columns parsed, with a status) with keys a script can rely on; one session with no database is `null` (exit 0)", ["seam"]),
      sql: b("`gluon stats sql` runs one read-only `SELECT`, `WITH`, `EXPLAIN` or `VALUES` against `sessions` (quotes and comments don't count): a table of aligned columns (NULL shown, duplicate names kept), `--json` an array; anything else (several statements, `ATTACH`, `writable_schema`, `VACUUM INTO`, `load_extension`, a CTE that writes) exits 2 and changes nothing, no file written; a bad query exits 1; the handle itself can't write", ["seam"]),
      "sql-limits": b("the query runs in a separate process: stopped after 10 s, at most 10,000 rows and 32 MB of text, saying when it cut (JSON: on stderr, the array valid), at most 256 MB (where SQLite ignores its heap limit, the child's watchdog); Ctrl+C ends it and its child at once; a killed command leaves no query running; a normal query (blobs, long text, `EXPLAIN`, `VALUES`, no rows) comes back as it would in process", ["seam"]),
      delete: b("`gluon stats --delete` asks first with the count (a no deletes nothing); without a terminal it needs `--yes`; it empties the table through a write connection and never removes the file (a newer Gluon's schema version left alone); a Gluon that has the file open keeps recording, but a session it was running doesn't write its row back, and no old spec is left in the file or its `-wal`", ["seam", "e2e"]),
      "no-database": b("with nothing recorded `gluon stats` says `No analytics recorded yet.`, exits 0 and never creates the file; it needs no config; a newer Gluon's database is still read; a file that is no database exits 1 naming it; one without the table is nothing recorded", ["seam", "e2e"]),
      output: b("a bad argument is `gluon: <message>` on stderr, exit 2, nothing on stdout; `--help` prints the help and exits 0; text from the database is printed without control characters", ["seam"]),
    },
  },
  cost: {
    says: "the cost on a session's row and info line (docs/guides/cost-and-context.md, docs/concepts/architecture.md \"Status, cost and context\", src/cost/AGENTS.md)",
    entries: {
      "own-figure": b("the cost shown is Gluon's own: each request the harness reports is priced from Gluon's table and summed; the harness's own cost, tokens or window only audit it (the ledger) and are never shown while Gluon's figure exists", ["seam"]),
      markers: b("`$` is counted from a known price; `~$` an estimate: a plan's API-equivalent price (even when every request is priced), a figure that needed an assumption; `*` the harness's own total standing in for a model with no price of ours (and only then); `—` unknown or none reported", ["seam"]),
      "unpriced-model": b("a model with no price entry has no figure of ours: the harness's own total is shown marked, or none; a model named that Gluon doesn't offer, or a request naming none, is priced at the launched model's price and says so; with no launched model it is unknown; junk counts or rates give 0, never NaN", ["seam"]),
      "by-connection": b("the connection decides the price: the same model on the API, Bedrock (AWS's own list, models.dev's `amazon-bedrock` row; Claude's list price only audits) and OpenRouter (its listing) differ; a plan is priced as the vendor's API (`~`); Kimi on Moonshot's key is Moonshot's price, exact", ["seam", "e2e"]),
      "claude-code": b("a Claude Code request is priced as Claude Code prices it (its own `cost_usd`, to the micro-dollar): main thread, title, `/compact` and subagents; 5m and 1h cache writes (the TTL from the user's settings and environment, key by key, else Claude's automatic rule, named as assumed), US inference, web searches, fast mode, a prompt over a tier's long-prompt row billed wholly at it", ["seam"]),
      codex: b("a Codex response is priced from the table (Codex reports no cost): every conversation's response (the title thread's too), at the service tier Codex requested (a named assumption), the context tier above 272k prompt tokens; a tier with no price is priced at the base and flagged; the session is an estimate (`~`)", ["seam"]),
      opencode: b("an OpenCode step is priced as OpenCode prices it (its own step cost, bit for bit) at the model the step reports (a model switched to by hand, a free one at $0, one with no entry unknown, never the launched price); each step and compaction is its own record; the request OpenCode bills with no step (the title) is priced at the provider's small model", ["seam"]),
      grok: b("a Grok Build request is priced from its table (Grok's own price before models.dev's): uncached input, cache reads, output with the reasoning; no cache-write price; the 200k tier a named assumption; subagents' requests count; a compaction is not priced; each request equals Grok's own `cost_usd_micros`", ["seam"]),
      kimi: b("a Kimi Code session's cost is its export's `usage.record`s (a subagent's too) at the connection's price: OpenRouter's price (`~` while it runs), Moonshot's own, the plan as Moonshot's API price (`~`); a missing cache price is the input price", ["seam", "e2e"]),
      "antigravity-none": b("Antigravity's cost is `—`: its status line's token totals are the conversation's size, not what was billed, and are never priced", ["seam", "e2e"]),
      "counted-once": b("each request counts once: a re-sent telemetry batch, a replayed request (the dedup bounded), the whole Kimi export again; a shorter export never counts back", ["seam"]),
      "this-launch-only": b("a resumed or forked session's inherited history is a baseline, never this launch's cost", ["seam"]),
      "every-model-priced": rule("every model Gluon offers, on every connection that serves it, has a price key, a price and a window: a gap is a failing test, never a silent `—`", ["seam"]),
      sources: b("each harness's figures are read as it sends them: Claude Code's `api_request` events and cost metric (cumulative series summed at their latest), Codex's `response.completed` and `turn_cost`, Grok's protobuf OTLP, OpenCode's plugin steps (an unknown window: its tokens and model), Claude's `session.measure`, Antigravity's status line (its own figures as reported fields only; a gateway model: no figure of agy's, never 0%); a bad or absent figure sends nothing, never an error", ["seam"]),
      "listener-strict": b("the telemetry listener refuses what isn't a launch's: no token or a wrong one, another path or method, not JSON or protobuf, too large (a gzip bomb too); a malformed protobuf throws a bounded error, fast, never hangs or allocates without bound; a callback that throws doesn't break it", ["seam"]),
      "telemetry-setup": b("a launch's telemetry goes to a loopback listener on a free port with its own token: Claude Code OTLP http/json, Codex's log exporter by `-c`, Grok protobuf OTLP; prompts, responses and tool content are never exported; options go before the spec; with telemetry settings of the user's own Gluon adds none (theirs stay), says so, and the figures show `—`; Antigravity gets none", ["seam"]),
      "kimi-export": b("Kimi's usage comes only from `kimi export` of the launch's session (the one created since the launch, never another launch's or an ambiguous pick) into a fresh 0700 directory of Gluon's: only `usage.record`'s numbers are kept, read in memory, the zip and its directory deleted whatever happens (a stale one swept); a hostile zip is bounded; refreshed at least 30 s apart and once at the end; a failing export is said once", ["seam"]),
    },
  },
  context: {
    says: "how full the model's context window is (docs/guides/cost-and-context.md \"Context\", src/cost/AGENTS.md)",
    entries: {
      percentage: b("the context is a percentage of the window counted as the harness's own display counts it (Claude Code: the main thread's prompt; Codex: the last response's input + output, its 12k baseline off both sides; OpenCode: the last step's input + cache + output + reasoning; Grok: the last main request's input + output; Antigravity: `total_input_tokens`), at most 100, `—` when unknown", ["seam"]),
      window: b("the window is Gluon's own: Claude Code's catalog or the model's name (1M natively or with `[1m]`; a prompt past 200k proves 1M; the disable variable keeps 200k); Codex's usable window from its catalog (the config's override capped by the maximum, its percent, its 272k fallback); OpenCode's and Antigravity's models.dev limit; Grok's binary's, then the observed table's; models.dev's `limit.context` is never Claude's or Grok's; a harness's own window lands only in the ledger", ["seam", "e2e"]),
      "after-compact": b("after a compaction that worked (`/compact`, Codex's own, Grok's, OpenCode's) the context is `—` until the next request; a failed one changes nothing; after Antigravity's `/clear` (a new conversation) the next reading shows at once", ["seam", "e2e"]),
      "main-thread-only": b("only the session's own conversation moves the context: a subagent's, a title thread's or a side conversation's requests don't (they still cost); after Codex's `/fork` it follows the new thread; a subagent's record that never ends is cleared at the turn's end or after a timeout", ["seam", "e2e"]),
    },
  },
  pricing: {
    says: "the price and window tables (docs/reference/pricing-sources.md, docs/guides/cost-and-context.md \"Price tables\", SECURITY.md)",
    entries: {
      sources: b("each table comes from where pricing-sources.md says: models.dev's catalog; OpenRouter's listing and the per-model endpoints of the models Gluon offers on it (a few at a time; a failed one keeps the stored range); Claude's catalog and fast rows from the installed binary's bytes only (never fetched, nothing asked of downloads.claude.ai); Codex's windows from `codex debug models` in a neutral directory; Grok's models from its binary, scanned in chunks (never read whole), with models.dev's prices as a marked seed. A binary's table is read again only when its version changes, and a build that failed is not retried in the run. Only the hand-written observed-windows table ships", ["seam"]),
      when: b("at start in the background (the first screen never waits); at each harness launch its binary table, the network tables when none is running and the last success is over 10 minutes old, and the launched `openrouter/*` model's row; a launch never waits for any of it; one network refresh at a time (a second ask is the same work), and a row refresh and a network one land in order, the newer data winning; the demo never refreshes", ["seam", "e2e"]),
      command: b("`gluon pricing update` runs the network refresh, then every installed harness's binary tables, in the foreground, and prints what it wrote and what moved; nothing reachable is said and exits 1 (never \"every table is current\"), while a table built from a binary with the network down is exit 0; a source's ids and text reach the output short, plain and on one line; it has its own help, takes no other words and needs no config", ["seam", "e2e"]),
      offline: b("a source that doesn't answer keeps the last stored table, whatever its age; a first run offline has none; models.dev answering without OpenRouter builds the table with the stored OpenRouter rows kept, marked since when they were not priced (the date goes when OpenRouter answers); OpenRouter alone writes nothing", ["seam"]),
      validated: b("every table is checked against an allowlist of keys and shapes before it is read or kept: names that are an `Object.prototype` member, ids with a space or a quote, prices outside 0–5000 or not finite, too few models, a window under 100k, more than 2000 entries, a non-ISO date, a 2 MB text are refused; a source's answer that isn't what it should be (not JSON, an error body, an HTML page, a wrong content type, no usable model) is refused and the store left as it is; a single odd row (a NaN, an Infinity, a null, a bound crossed) is skipped and named, never a reason to refuse every price; every committed table passes the validator", ["seam"]),
      "big-move": b("a table where more than 15% of the prices change, one price moves more than 3×, or a model disappears is taken, and the move is logged in the audit ledger (its largest moves, the rows skipped); a table that has lost more than half its models is an outage: refused, the stored table stays, the exit code says so, and the way out it names (remove the stored file) works; a first table is never a wipe", ["seam"]),
      store: b("the tables live in `<state>/gluon/tables/`, one file each, in a private directory: 0700 (a loose one tightened), written privately, a symlinked directory or a file in its place refused, a killed write's temporary directory removed an hour later; a stored table that is truncated, empty, of a newer schema, oversized, a symlink or a directory is no table; three writers and a reader never see a torn table; a table checked today stays current for six hours, a future date is rewritten at once; an identical rebuild is not rewritten; a directory that can't be written still gives the run its new prices; the registry's listeners hear a new table", ["seam"]),
      fetch: b("the requests to models.dev and OpenRouter are plain GETs with nothing of the user's in them: a timeout (a server that drips its body is cut there), a size cap counted on the wire (a compressed answer is refused unread), no redirect off the origin, a lying content-length no help", ["seam"]),
      pending: b("a session launched before its table exists is priced when the table lands, in order and to the last digit, and keeps the first table that priced it (a later refresh moves none of its figures); its window is unknown until then; the first session after a Claude Code upgrade waits for the new catalog and falls back to the stored one if the build fails; Grok's requests fall back to models.dev's seed price, marked, when its table can't be built; a request no table can ever price is `unknown-model`, never pending; a session that ends still waiting leaves a dropped marker with its reason, a buffer past its cap drops the oldest with a marker, a throw while pricing one is a marker, and no listener is left behind", ["seam", "e2e"]),
      "offline-under-test": rule("under a test (`bun test`, `NODE_ENV=test`, a test build, the probes seam) no table reaches the network or runs a harness binary unless the test names its own loopback server; the seam is compiled out of a release build, and a user's `NODE_ENV=test` doesn't switch a release build's refresh off", ["seam", "e2e"]),
    },
  },
  ledger: {
    says: "the cost audit ledger and `gluon cost-report` (docs/guides/cost-and-context.md \"Compare with the agent's own figures\", SECURITY.md)",
    entries: {
      entries: rule("a ledger entry holds counts and names only: whitelisted fields per kind (usage, context, observation, dropped, tables), names that aren't names `?`, bounded integers, a cause from the list; never a prompt, a user id, a host, a path or free text", ["seam"]),
      audit: b("each harness's own figure is compared with Gluon's: a difference beyond rounding is an observation with the likeliest cause (the hypothesis whose delta equals the residual; nothing fits is `unexplained`), rounding is none; a sink that throws never breaks the launch", ["seam", "e2e"]),
      file: b("the ledger is in the state directory (by platform), private from the start (0700, 0600), one line per entry and readable back; a partial or junk line is skipped; it is never written through a symlink, a loose directory is set back to 0700, one owned by someone else or a symlink in its place is refused; a failure returns nothing and never throws", ["seam"]),
      caps: b("a launch writes at most `MAX_PER_MINUTE` entries a minute, a file at most `MAX_FILE_BYTES`, at most `MAX_FILES` files (the oldest go); what a cap refuses leaves one dropped marker (context or cost, as it stood for), inside the file's budget, and the count of the rest at the next minute's first write or at quit", ["seam"]),
      report: b("`gluon cost-report` (no model calls) shows per harness and model the audit and its causes by scope (request, turn, cumulative), unknown models, each table with its source, date, fetch time, age (stale past 14 days, a future date not \"old\", undated said) and how many requests it priced, and the table refreshes summed; a ledger of only context, dropped or observation entries still reports; an empty one says so and where it would be; an OpenRouter session's `billed` scope is read as what OpenRouter billed", ["seam", "e2e"]),
      off: b("given `cost.audit: off`, then no ledger is kept and the one an earlier launch wrote is removed; the figures are unaffected"),
    },
  },
  openrouter: {
    says: "what OpenRouter billed (docs/guides/cost-and-context.md \"What OpenRouter billed\", docs/guides/connections.md)",
    entries: {
      billed: b("after an OpenRouter session ends, Gluon reads the key's usage before and after, waits until two readings agree after the settle time and not before the session's last request could have landed (a lagged usage settles at the moved amount, never $0), and says in the chat what OpenRouter billed (`$x✓`, four decimals under a cent), audited against Gluon's own; no baseline, no final reading, a usage that never stops moving or never moves, or $0 for a session that spent is no figure, said; a reading that isn't a plain non-negative number is no reading", ["seam", "e2e"]),
      "shared-key": b("two Gluon sessions on one key at once (in this process, or another Gluon's through the registry files) get no figure each, and Gluon says so; another key is no overlap; a session after another's usage settled doesn't overlap it; a gone process's window ends at its last touch plus the lag tail (never later than now plus the tail), a reused pid's untouched file too; a registry file that is junk, oversized or of another shape is no window", ["seam"]),
      "quit-early": b("quitting before the figure settles leaves an unsettled record and no figure, the window keeping its lag tail for the next session, and no timer behind; a launch that failed leaves no window and no record", ["seam"]),
      "key-private": rule("the key travels only in the Authorization header of a request that follows no redirect: never in a file, the ledger, a note, `process.env` or an error; a registry file holds the key's hash, in a private directory", ["seam"]),
      estimate: b("while the session runs its figure is `~$`, calibrated against the lagged usage (k from a moved usage and our estimate one lag ago, kept within 0.05–20, none while a request waits for its price or the usage hasn't moved, none with another OpenRouter session on the key); a model with one endpoint price is unmarked once the session is billed, several or unknown prices keep `~`; the final k, and a cause when it is far from 1, are in the ledger", ["seam"]),
      "brain-on-key": b("the intake agent's replies on the session's key (this Gluon's or another's, through its private `<pid>.brain` file, bounded) have their exact cost taken off the session's figure; a reply of unknown cost (an error, a stopped stream, a retried request) leaves the estimate `~` and says why; a reply outside the window changes nothing, one that may have landed before the baseline leaves no figure; an unreadable, FIFO or directory file makes the window unknown, never a throw; the brain's code imports nothing that makes a session's figure", ["seam", "code"]),
      "offline-under-test": rule("under a test the key's usage is never read from openrouter.ai unless a test names its own server; only an environment that says nothing of tests reaches it", ["seam"]),
    },
  },
  "whole-app": {
    says: "Gluon as a whole: every state × every input, random walks, every screen",
    entries: {
      "input-matrix": rule("given any of Gluon's states (home's, and a session's per harness) and any input (key, paste, mouse, terminal reply), then it does what the coverage matrix says (test/fixtures/gluon-matrix.ts)", ["seam", "e2e"]),
      "random-walk": rule("given any sequence of a user's actions, then the screen invariants hold after each (test/e2e/gluon-invariants.ts)", ["e2e"]),
      "screens-lint": rule("every scene (home and session, every size, dark and light) passes the screen lint: nothing cut without `…`, margins kept, nothing off Gluon's ground", ["e2e"]),
    },
  },
  copy: {
    says: "what Gluon says",
    entries: {
      words: rule("what Gluon shows calls itself Gluon and the intake agent, never \"brain\" or \"task\"", ["code"]),
    },
  },
  subscriptions: {
    says: "a user's own plan stays theirs: official binaries only, nothing of another tool's read or forwarded (AGENTS.md, src/AGENTS.md)",
    entries: {
      "official-binaries-only": rule("given a plan, when Gluon checks or starts a login, then it runs only the vendor's own binary and command"),
      "plan-brain-official-only": rule("given a plan brain, when it runs, then it is the user's own claude (Agent SDK) or codex app-server, with no HTTP client of Gluon's"),
      "never-read-credentials": rule("given another tool's token files, config directory or keychain, then no source reads them; a harness's config is read for its named keys alone"),
      "never-edit-other-tools-files": rule("when Gluon needs another tool's setting, then it tells the user; it writes only its own hook (permanent.ts, inert without GLUON_EVENTS) and agy's statusLine (agy-settings.ts)"),
      "no-token-forwarding": rule("when a launch's environment is built, then it carries no login token (assertSafeEnv refuses one)"),
      "base-url-allowlist": rule("given any harness and connection, then a base URL is set only for OpenRouter, Codex on an OpenAI key, or the tests' loopback seam"),
      "no-impersonation": rule("when Gluon sends a prompt to claude or codex app-server, then it is Gluon's own prompt, with no harness's identity"),
      "user-env-as-is": rule("given the user's own key in the environment, when Gluon launches, then it is used as it is, never stripped"),
    },
  },
  repo: {
    says: "the user's repository is untrusted: nothing in it runs inside Gluon (src/AGENTS.md)",
    entries: {
      "spawn-via-binpath": rule("given a binary planted in the repository or a bare name, when Gluon spawns, then it runs an absolute path from binPath or windowsTool, never the planted one", ["code", "seam", "e2e"]),
      "never-bun-which": rule("given any source but detect.ts, then it never calls Bun.which: every lookup goes through detect.ts"),
      "git-via-gitargv": rule("given a hostile .git/config (fsmonitor, filters, textconv, a promisor), when a repo tool runs git, then it goes through gitArgv and nothing the config names runs"),
      "neutral-cwd": rule("when Gluon runs a status check, a probe, a version check, a login or an installer, then it runs in a neutral directory, never the repository", ["code", "seam", "e2e"]),
      "bun-autoloads-nothing": rule("given a repository with a bunfig.toml preload or a .env, when Gluon starts from source or a package script runs, then nothing of the repository's loads", ["code", "seam", "e2e"]),
      "no-posix-tools": rule("given no rg, git or ps, when the tools run, then Gluon's own fallbacks answer and no POSIX tool is spawned"),
    },
  },
  "repo-tools": {
    says: "the brain's tools read the repository and nothing else (src/agent/AGENTS.md, docs/guides/security-privacy.md, docs/concepts/architecture.md \"Repository tools\")",
    entries: {
      "read-only": rule("when the brain's repo tools run, then nothing in the repository is written, the git index included"),
      "sandbox-within": rule("given a path outside the repository (.., a symlink, another drive, a UNC share), when a tool resolves it, then it is refused"),
      "secret-files": rule("given a secret file by name or by its real path, when any tool reads, greps or diffs, then the one isSecretPath rule leaves it out"),
      search: b("`list_files` and `grep` answer the same on every backend (rg, git grep, the JS fallback): paths relative and sorted, a subdirectory keeping its prefix, `.git`, `node_modules` and an old `.gluon` left out; `grep` is `path:line:text` with ERE patterns (one starting with `-` is a pattern), no binaries; a path is taken literally (pathspec magic is a name); a NUL in a match reaches the brain as `␀`; the environment (`GLUON_BUILD`) changes nothing", ["seam"]),
      "git-tools": b("`git_status` shows the branch, modified and untracked files; `git_log` lists commits newest first, by count and path; `git_diff` shows uncommitted changes or what a commit changed (an empty or merge commit: its message), with a summary; an unborn branch works; they see only the directory Gluon runs in (a subdirectory root its own changes, history and paths; one opened by its 8.3 path too)", ["seam"]),
      limits: b("what a tool returns is capped: a line at 300 characters (2000 in `read_file`, a cut never splitting a character), a result under 64 000 (`read_file` says where it cut and the offset to go on from); a list or search is capped and its scan stops after 100× the cap; a file over 2 MB isn't searched; a line past its cut costs no budget", ["seam"]),
      "tool-errors": b("a binary file, a directory, a missing file, an invalid regex, not a repository, a FIFO (never waited on) is a tool error the intake reads, never an exception; invalid UTF-8 reads with replacement characters", ["seam"]),
      stops: b("a tool call ends at once on Esc, the processes it started with it (a forge CLI's children too), and within its time budget without one: a catastrophic pattern, a git config include that never ends; a call that ends by itself returns its output", ["seam"]),
      forge: b("`forge` reads issues and pull or merge requests through the user's own `gh` or `glab`: view and list only, a fixed argv (no input makes a write or an option), the count and number bounded, run in a neutral directory; its output masked (stdout and the error), NUL bytes and a huge output cut; an empty answer says so; a CLI failure names the sign-in, no CLI installed is a clear error", ["seam"]),
      "forge-hosts": b("`forge` works on github.com and gitlab.com only: an origin or a `repo` naming another host, a lookalike, a path, a flag or a second line never starts the CLI; the CLI is told the origin's host whatever `GH_HOST` / `GITLAB_HOST` hold, a `GITLAB_TOKEN` meant for another host is not passed on, and the process's own environment stays the user's", ["seam"]),
      "instruction-files": b("the repository's `AGENTS.md` and `CLAUDE.md` go into the intake's prompt as the repository's text (after the layout, explained as no instruction to it; no section when there are none), read as `read_file` would (a link out or to a secret file, a directory, a binary skipped; a link inside followed), the size checked before reading and the text capped with how to read the rest; nested ones on a tool's path are added to its result, once per session, never outside the root", ["seam"]),
      "untrusted-text": b("text the repository controls (a file's text, a file or directory name, the branch, a top-level name) can't close its tag or open a trusted block in the intake's prompt or a tool's result (`<instructions>`, `<system>`, `<tool_result>`, `</file>`…): it is escaped, and stays readable", ["seam"]),
    },
  },
  keys: {
    says: "the user's keys stay where they are put and are never shown (src/AGENTS.md)",
    entries: {
      "never-in-process-env": rule("given keys in Gluon's .env or an AWS profile, when they are loaded, then process.env stays as it was"),
      "masked-when-printed": rule("given a key or token in text Gluon prints (an error, a probe's output), then it is masked, by shape and by value"),
      "private-files-directory-first": rule("when a private file is written, then it is made in a fresh 0700 directory and renamed into place, and nothing is left behind on a failure"),
      "only-next-to-config": rule("the keys are read only from the `.env` next to the config (a saved key beats the environment); a dev key file is used only when handed in, and named as the source; nothing comes from Gluon's own source directory"),
      "env-file": b("the `.env` next to the config is read as dotenv reads it: assignments, `export`, quotes, CRLF, spaces around `=`; a value's trailing whitespace is not part of the key, spaces inside quotes are; comments, blank lines and junk are not assignments; an empty value is no key; any line is read in linear time", ["seam"]),
      saved: b("saving a key replaces only that name's lines of the `.env` (a name that is a prefix of another leaves the other alone), keeps every other line, and is in effect at once; the file is 0600 whatever the umask, a fresh config's directory made too; a symlink planted at the `.env` is replaced, never followed; uninstall drops only Gluon's own key lines", ["seam"]),
      "only-to-their-provider": rule("the intake agent's clients on an OpenAI, Anthropic or Bedrock key (and their checks) use the provider's endpoint, never `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL` or `AWS_ENDPOINT_URL*` (China's regions under `amazonaws.com.cn`); `ANTHROPIC_AUTH_TOKEN` is not sent next to the key; on OpenRouter the OpenAI organization, project and custom headers stay home, Gluon's own go; on its own route a custom header or a Bedrock bearer token is warned about, never stripped", ["code", "seam"]),
    },
  },
  pty: {
    says: "what the agent's terminal shows stays in memory and never acts on its own (src/pty/AGENTS.md)",
    entries: {
      "screen-stays-in-memory": rule("given the agent's screen, then the screen, modes, painter, readers and interceptor use no file, network or process API"),
      "screen-never-triggers": rule("given a menu or a /clear drawn by the agent's output or pasted, when Enter is pressed without a typed /, then nothing is held"),
      "unsure-forward": rule("given a screen, line or key the reader can't read for sure, when it comes, then it is forwarded and nothing is held"),
      "only-user-bytes-into-agent": rule("when anything is written to the agent's terminal, then it is the user's bytes (unchanged, in order), the screen model's replies or shifted mouse reports"),
    },
  },
  install: {
    says: "a harness installer runs only when the user says so (src/AGENTS.md)",
    entries: {
      "run-it-enter-only": rule("given the install offer, when the user pastes, presses a digit, holds Enter, presses Esc or has no terminal, then nothing runs; only Run it + Enter runs it", ["e2e"]),
      "verbatim-no-sudo": rule("when an installer is shown and run, then it is the vendor's constant https or npm command, shown as it runs, with nothing interpolated, no --yes and no sudo", ["code", "seam", "e2e"]),
      offer: b("the offer shows the exact command, where it downloads from and the vendor's docs, with Skip (the default), Show the command only (prints it, runs nothing) and Run it; Ctrl+C at it exits 130 and runs nothing"),
      after: b("after Run it, Gluon finds the agent on PATH; installed in a directory PATH doesn't reach, it names the directory and says to open a new terminal, and never runs it from there; an installer that fails is a failure (an old binary in its directory named, not used); Ctrl+C during it exits 130, nothing written", ["e2e", "seam"]),
      command: b("`gluon install` offers a checklist of the agents not installed (Esc installs nothing), `gluon install <agents>` names them by id or binary name (an unknown one is refused, an installed one said so), each checked one offered in turn", ["e2e", "seam"]),
      "in-setup": b("a checked agent that is missing is offered an install first; installed, its screens follow and going back never offers or runs it again; skipped, the summary gives its install command and it isn't offered again; installed off PATH, the summary says where and how to finish"),
      "official-commands": b("each agent's official commands per platform, the recommended first, an npm alternative where there is one (`or` before it); a method runs only when all it needs is on PATH (a relative PATH entry doesn't count; on WSL a Windows npm is named as not usable), what is missing is named, an unchecked method never runs; on Windows PowerShell by its full path, `-NoProfile`, the command as one argument", ["seam", "e2e"]),
    },
  },
  update: {
    says: "Gluon's own updates (docs/getting-started/install.md \"Updating\", docs/concepts/security-privacy.md \"Updates\", SECURITY.md, docs/reference/cli.md, docs/reference/config.md)",
    entries: {
      "signed-only": b("given a release, then nothing is installed unless its `SHA256SUMS` carries a valid Sigstore signature by the Release workflow on `main` of this repository, and the binary matches that `SHA256SUMS`. Refused: one changed byte, another workflow, branch or repository, a bundle that isn't one, a binary it doesn't list. The signature is checked before the binary, with the identity and issuer `install.sh` checks; Gluon checks it itself, no `cosign` needed", ["seam"]),
      hosts: b("a request goes only to GitHub's release hosts over https: a redirect off them is refused, and each file has a size cap. The requests are plain GETs with nothing of the user's in them. Without the test seam a test run reaches no network; the seam is loopback http only, kept in a test build and compiled out of a release build", ["seam", "e2e", "code"]),
      releases: b("the latest version is the one GitHub's `/latest` redirect names. x.y.z compares numerically; a pre-release or junk is never newer. `SHA256SUMS` reads in either line form, CRLF or LF. This host's release file is picked (musl only on Linux)", ["seam"]),
      replace: b("a verified download takes the executable's place and leaves nothing beside it (Windows: the running `.exe` moves aside to `.old`, swept at a later start). A new binary that doesn't answer `--version` with its version, or doesn't match, is not put in place; the executable stays as it was. A staged file a crashed update left is swept once it is a day old. One update runs at a time; a crashed one's lock is taken over after 30 minutes", ["seam", "e2e"]),
      "at-start": b("at start, in the background and never before the first screen. `off` checks nothing. `notify` says a newer release exists, confirmed with GitHub at each start; while up to date GitHub is asked once a day. `auto` installs a newer release for the next start and says so; a failure says why, and that version isn't tried again for a day. Nothing is said when Gluon is up to date or GitHub can't be reached. A remembered version GitHub doesn't confirm is never said or downloaded. Another Gluon's update (its lock) is left alone. A state file that isn't one reads as no check", ["seam", "e2e"]),
      "cannot-replace": b("given no executable Gluon can replace (the npm package, a source checkout), then `auto` says how to update instead", ["seam"]),
      command: b("`gluon update` installs the latest release now and says where. `--check` only says whether there is one, and installs nothing. A failure says nothing was changed; a bad argument is refused", ["seam", "e2e"]),
      setting: b("the config key `updates` is `auto` by default. It reads `auto`, `notify` and `off` (false as off, true as auto); anything else is refused naming the key. `GLUON_UPDATES` wins over it; anything else in that variable is ignored", ["seam"]),
    },
  },
  installers: {
    says: "`install.sh` (docs/getting-started/install.md \"Linux and macOS: install.sh\", SECURITY.md \"Releases\")",
    entries: {
      signature: b("given `cosign` on the PATH, then `install.sh` checks `SHA256SUMS`'s signature. A cosign 2 that needs `--new-bundle-format` is retried with it and installs. A signature that fails both ways dies `does not verify`, and a cosign older than 2.4 dies asking for an upgrade; in both cases nothing is installed"),
      checksum: b("given a release whose binary doesn't match `SHA256SUMS`, or that `SHA256SUMS` doesn't list, then `install.sh` stops with nothing installed"),
    },
  },
  dist: {
    says: "the standalone executable: it runs without Bun and loads only what is built into it (docs/getting-started/install.md, scripts/AGENTS.md)",
    entries: {
      "no-autoload": rule("given a hostile working directory (a bunfig preload, a .env, tsconfig paths), when the compiled or release binary runs, then nothing of it loads", ["e2e"]),
      "no-external": rule("given node_modules in the working directory or its parent, when the compiled binary runs, then its own embedded modules are used, nothing from the directory", ["e2e"]),
      standalone: b("the compiled binary runs without Bun as the source does: `--version` and `--help`, `doctor`, a `--launch` dry run, the UI with a session in its bundled pseudo-terminal (the frame, the home key twice), the bundled grep worker, and `gluon stats sql`'s query child (the binary itself)"),
      "patched-modules": b("the release binary carries Gluon's patched modules: string-width with its pre-check (`patches/`), and the patched Sigstore libraries, which verify a real signature inside the binary"),
      "no-test-seams": rule("the release binary contains none of Gluon's test seams (`GLUON_TEST_*`); the test build keeps them", ["e2e"]),
    },
  },
  perf: {
    says: "how fast Gluon feels: the perception limits (test/perf/perf-kit.ts) and the baselines (test/perf/baseline.json)",
    entries: {
      startup: perf("when Gluon starts, first run or after, then the home view is up within its baseline, and the idle home view costs no CPU"),
      "key-home": perf("when a key is typed at the home composer, then its frame is drawn within the noticeable limit, alone and at key repeat", ["perf", "e2e"]),
      "key-session": perf("when a key is typed in a session, then it reaches the agent and its echo is drawn within the noticeable limit (on Windows, the accepted two-ConPTY ceiling)"),
      "burst-typing": perf("given 1, 10 or 40 sessions, or another session flooding, when keys come in a burst, then none is lost or queued and the latency stays under the limit"),
      sessions: perf("given 1 to 40 sessions, each with a full scrollback, then memory and frame time stay within their baselines"),
      flood: perf("when a session floods output, shown or in the background, then keys and a tab switch meanwhile stay within their limits"),
      soak: perf("given 5 sessions printing for minutes, then nothing grows without bound"),
      smoke: perf("when Gluon starts, opens three sessions and takes keys and tab switches, then each stays under the noticeable limit (the fast check of the perf suite)", ["e2e"]),
      polling: perf("given N sessions in one work tree, then a files-changed poll runs three git processes; an unchanged events directory is not listed again (at least every `FULL_LIST_MS`), and a read event is removed", ["seam"]),
      "hook-light": perf("`gluon hook` and `gluon signal` run on every tool call or status change of a launched agent, so nothing under `src/cost/` and not `src/models.ts` is reachable by an import from `src/internal.ts`", ["code"]),
    },
  },
};

/** Every entry, by id (`feature/entry`). */
export const ENTRIES: Map<string, Entry> = new Map(Object.entries(CATALOG).flatMap(([f, { entries }]) => Object.entries(entries).map(([e, v]) => [`${f}/${e}`, v] as const)));

// ——— titles ———

/** The entry a title names: `feature/entry: …` at its start. */
export const entryOf = (title: string): string | undefined => /^([a-z][a-z0-9-]*\/[a-z0-9-]+): /.exec(title)?.[1];

/**
 * Each test (`test(` / `it(`, any modifier, and `(c ? test.skip : test)(`) in a file's text: its title as written, cut at
 * the first `${` of a built one (the entry is at the start, so a built title still names it). Not a `describe`, nor a
 * method of the same name (`re.test(…)`).
 */
export function testTitles(text: string): string[] {
  const re = /(?<![.\w])(?:test|it)(?:\.\w+)*(?:\([^)]*\))?\)?\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;
  return [...text.matchAll(re)].map((m) => (m[1] === "`" ? m[2]!.split("${")[0]! : m[2]!));
}

/** A test file's layer from where it lives (`seam` and `code` share `test/*.test.ts`; `test/dist.test.ts` runs the built binary). */
export function layersOf(file: string): Layer[] {
  if (file === "test/dist.test.ts" || file === "test/installers.test.ts") return ["e2e"];
  if (file.startsWith("test/e2e/")) return ["e2e"];
  if (file.startsWith("test/real/")) return ["real"];
  if (file.startsWith("test/perf/")) return ["perf"];
  return ["seam", "code"];
}
