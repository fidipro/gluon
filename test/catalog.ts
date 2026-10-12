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

const b = (says: string, at: Layer[] = ["e2e"]): Entry => ({ kind: "behaviour", says, at });
const rule = (says: string, at: Layer[] = ["code", "seam"]): Entry => ({ kind: "invariant", says, at });
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
      "fits-terminal": b("given any terminal size (down to a few cells) and any resize, then the home view is exactly rows − 1 tall, nothing wider than the terminal or wrapped, the composer on screen with one rule over it"),
      "short-terminal-priority": b("given a short terminal and a conversation going on, then the open question or agent choice (lead, options, hint) wins over the list; the list keeps its column header and group label before its blank rows go; at 80×24 two groups and a question show every row"),
      "no-full-redraw": b("when keys are typed, a turn runs or a huge draft is edited, then Gluon never clears the screen or the scrollback"),
      theme: b("given a dark or a light terminal (its OSC 11 answer, else COLORFGBG), then Gluon picks the matching theme and paints its own ground on every cell, the spec box's borders included"),
      "hint-line": b("given what is selected or open (a run, a group label, the draft, text typed, the intake agent working, a question, the agent choice, an ended run without a terminal), then the hint line names only the keys that act on it, ending in `? for keys`; short of columns whole keys go from the end, never enter/esc or `? for keys`"),
      "one-highlight": b("while a question or the agent choice is open, then only the option Enter acts on is highlighted, never the list's row too; closed, the list's row is again"),
      "key-list": b("given an empty composer, when `?` is pressed, then every key is listed (sessions, in a session with the configured home key, the intake chat) in columns that fit; cut, it says `↓ N more` and pgdn/pgup scroll it; esc or `?` close it, any other key closes it and acts; with text typed or options open `?` is text"),
      "key-list-mouse": b("given `handoff.mouse_capture: false`, then the key list names no click, wheel or text selection; with it on, it names them"),
      "own-question": b("given Gluon's own question at home (end a session, discard the chat, quit, resume, start again), then the hint line names its keys, the composer shows no cursor, and only keys pressed once it shows answer it: Enter yes; esc or ctrl+c no; y/n nothing"),
      quit: b("given a draft, ctrl+c clears it; twice on an empty composer quits with 130 and gives the terminal back (cursor, paste mode, main screen); with sessions running it asks first"),
      "text-widths-exact": { kind: "invariant", says: "given any text (emoji, CJK, marks, box glyphs), then the patched string-width (its speed pre-check, patches/) measures it exactly as the unpatched module", at: ["code"] },
      readable: b("in either theme, on truecolor or 256 colours, then box borders stand at least 3:1 off the ground and dim text on the selection bar stays readable", ["seam"]),
      "cut-marked": b("given text too wide for its place, then it is cut by display width (never inside a wide character) and ends in `…`, never after a dash, a separator or a blank", ["seam"]),
    },
  },
  "sessions-list": {
    says: "the rows of the sessions home (docs/guides/sessions.md)",
    entries: {
      groups: b("given sessions in several states, then rows are grouped under Awaiting input, Working, Done, Drafting (`?` `●` `✓` `◌`), a column header names the right-hand columns, nothing wraps at any width, the selected row is a full-width bar"),
      "row-columns": b("given a session, then its row shows its name, triple, latest activity, its mode (`· explore`, `· plan`, nothing for build), cost and context, as the width allows"),
      "row-live": b("when a session's state or activity changes (a hook or its screen), then its row, its group and the header counts follow; a finished turn reads awaiting input, never Done"),
      "draft-row": b("given a chat being drafted, then a Drafting row named from the proposal (`(untitled)` before) reads `Waiting for your pick` while the agent choice is open, `Waiting for your answer` while a question waits, `Talking it through` otherwise; Enter on it says `That's this chat`"),
      select: b("when ↑↓ are pressed, then the selection moves over rows and group labels; a list longer than its rows shows `… N more`, and ↓ past the window moves it one line, the selection kept in view"),
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
      editing: b("when typing, backspace, delete, ←→, home/end and ctrl+a/e/u/w are pressed, then they edit at the cursor"),
      graphemes: b("when the cursor moves, backspace deletes or text is inserted, then an emoji or a combined character is one character"),
      newline: b("when alt+enter, ctrl+j or shift+enter (any encoding) is pressed, then a newline is inserted, never text; ↑↓ move between the lines"),
      wrap: b("given a draft wider than the composer, then it wraps at words, a word longer than a row is broken there, and the cursor stays where the user types"),
      "tall-draft": b("given a draft taller than the composer's rows, then the rows around the cursor show, with how many more"),
      paste: b("when text is pasted, then it is taken whole, keeps its line breaks (CRLF, CR), indentation and tabs, drops escape sequences and control characters as typing does, and never sends by itself"),
      "esc-esc-clears": b("when esc is pressed on a draft, then it stays and Gluon says `Press esc again to clear the draft`; a second esc clears it"),
      "batched-keys": b("given keys arriving in one read, then they act as keys (Enter submits, control keys edit); a double Enter sends once"),
      placeholder: b("given an empty composer, then its placeholder says what Enter does: `describe the session you want`, `describe another session`, `reply to the intake agent`"),
      "terminal-noise": b("given a late terminal reply (OSC 11) or a focus report, then it is never typed into the composer; a typed `]` still is"),
    },
  },
  "intake-chat": {
    says: "talking to the intake agent at home (docs/getting-started/quickstart.md)",
    entries: {
      send: b("when Enter is pressed on a draft, then it shows in the chat on a full-width bar after `›`, hanging under its text; an empty or blank draft sends nothing"),
      working: b("while the intake agent works, then a line says what it does and `esc to interrupt`; once it speaks, its tool calls show as one `◇` line (reads, searches, git commands, failures counted)"),
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
      "model-effort": b("when Tab or Shift+Tab is pressed, then the highlighted option's model or effort cycles, the others keep theirs; the hint names each key only when the highlighted agent has another"),
      mode: b("when ctrl+t is pressed at the choice, then build → explore → plan cycles for every option, shown on each row (a proposal's own mode shown from the start), and Enter starts in it; with no choice open ctrl+t does nothing"),
      "mode-unsupported": b("given a mode the highlighted agent can't run, then ctrl+t skips it (explore for Kimi Code), and Enter on an agent that can't run the chosen mode is refused with its advice first, nothing started"),
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
      "click-row": b("when a row is clicked, then it is selected; a click on the selected row, or a double-click, opens it, never scrolling the list; a click anywhere else, a release or another button does nothing and types nothing"),
      "click-group": b("when a group label is clicked, then it folds or unfolds; a double-click folds it once"),
      "click-option": b("when an option of the question or the agent choice is clicked, then it is picked as its digit + Enter would; a click on `keep talking` closes the choice"),
      "drag-copy": b("when home text is dragged over, then it is copied with OSC 52 (the spec box's edges left out), highlighted, and Gluon says so; a key ends the selection"),
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
      "scripted-intake": b("given `gluon --demo`, then the whole UI runs with a scripted intake agent whose spec is built from the task and the repository, with no API call"),
    },
  },
  frame: {
    says: "a session in Gluon's frame: tab strip, info line, the agent's own UI in a box, the keys bar (docs/guides/sessions.md, keyboard.md, docs/concepts/architecture.md)",
    entries: {
      layout: b("given a session started, then the frame shows the tab strip at the top, an info line, a box with the session's triple in its top border holding the agent's own UI (its terminal exactly the box's interior), and the keys bar at the bottom; from 24 rows a blank row over the box"),
      "info-line": b("the info line shows the triple (with its mode and permissions), elapsed time, cost, context, files changed and the state, amber where it needs the user; unknown figures are left out; short of columns the figures go first and the state last, the triple cut but never dropped while it fits", ["e2e", "seam"]),
      "agent-screen": b("the agent's output (colours, emoji, CJK) is drawn in the box cell for cell with its cursor, the border never moved; a session off screen keeps running and, opened, shows what it printed meanwhile", ["e2e", "seam"]),
      "terminal-queries": b("given the agent asks the terminal something (DA1, cursor position, colours), then Gluon's screen model answers it and only the agent sees the answer"),
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
  tabs: {
    says: "moving between sessions (docs/guides/keyboard.md, docs/getting-started/quickstart.md)",
    entries: {
      strip: b("`◆ gluon` then one tab per session in launch order (whatever its state), the shown one marked; too many for the width, the strip scrolls to keep the shown one whole and `‹N` `N›` count the hidden ones; a long name is cut with `…`", ["e2e", "seam"]),
      "home-key": b("in a session, in any state (a typed line, scrolled back, a question up), the home key opens a one-key menu whose bar says what the next key does: ←/→ previous/next tab, z zoom, the home key again home; esc cancels; any other key cancels and goes on as usual; it waits however long; a modifier alone picks nothing", ["e2e", "seam"]),
      arrows: b("on an untouched line (nothing typed since enter, esc or ctrl+c, or erased with as many backspaces; answers to the agent's own dialog don't count) ←/→ switch tabs, wrapping through home; alt+←/→ there are dropped; on a touched line all four are the agent's", ["e2e", "seam"]),
      click: b("a click on a tab shows it, on `◆ gluon` home, on `‹N`/`N›` the nearest hidden tab, whether or not the agent asked for the mouse; exactly where the strip draws them", ["e2e", "seam"]),
      bar: b("the bottom bar names the keys that work now: ←/→ only while an arrow would switch (another tab, an untouched line), the home key, and the other sessions' counts; short of columns the words shorten, the counts go, then the switch keys; the home key stays", ["e2e", "seam"]),
      "keys-follow": b("keys in the same burst as the → or Enter that opens a session reach that session's agent in order, never the hidden home composer; the home key twice among them goes home"),
      "back-event": b("the agent's `back` (`/gluon`, or its offer when the work looks done) shows home; the agent keeps running"),
    },
  },
  "clear-compact": {
    says: "`/clear`, `/new` and `/compact` ask first (docs/guides/sessions.md, docs/concepts/architecture.md)",
    entries: {
      asks: b("given a typed `/clear` or `/new` (`/compact`), when Enter is pressed (on the agent's slash-menu item too, after edits or Tab, typed as kitty CSI-u keys, longer than 64 characters, after composed input), then the bottom bar asks `… ends this session in Gluon — end it?` (`End this session instead of compacting?`); a paste never asks; per harness (Antigravity has no `/compact`)"),
      answer: b("Enter says yes (the session ends; keys typed right after go to the home composer); esc or ctrl+c sends nothing, the command stays typed and the line touched; other keys and pastes are dropped while it is up", ["e2e", "seam"]),
      bar: b("the question says what happens in Gluon; short of columns it keeps the command and what a yes does, its keys shrink then go; never `End G…`; a cut leaves no blank before its `…`", ["seam"]),
    },
  },
  "session-end": {
    says: "a session that ends closes; quitting and signals end them all (docs/guides/sessions.md, docs/concepts/architecture.md)",
    entries: {
      closes: b("given an agent that exits (before drawing anything too), then its session closes: home shows, its row is gone, the other sessions stay, and the chat says how it ended (`exited (code 3)`); its End question, if up, goes with it", ["e2e", "seam"]),
      "on-exit-quit": b("given `on_exit: quit`, when the last session's agent exits, then Gluon exits with the agent's code"),
      signals: b("SIGTERM, SIGHUP or SIGINT to Gluon ends every agent (a grace, then SIGKILL) and gives the terminal back (normal screen, mouse and focus off, line mode, cursor); a second signal while it waits gives it back at once; in the setup menus a signal restores line mode and the cursor and exits 128 + n"),
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
    says: "the brain's tools read the repository and nothing else (src/agent/AGENTS.md)",
    entries: {
      "read-only": rule("when the brain's repo tools run, then nothing in the repository is written, the git index included"),
      "sandbox-within": rule("given a path outside the repository (.., a symlink, another drive, a UNC share), when a tool resolves it, then it is refused"),
      "secret-files": rule("given a secret file by name or by its real path, when any tool reads, greps or diffs, then the one isSecretPath rule leaves it out"),
    },
  },
  keys: {
    says: "the user's keys stay where they are put and are never shown (src/AGENTS.md)",
    entries: {
      "never-in-process-env": rule("given keys in Gluon's .env or an AWS profile, when they are loaded, then process.env stays as it was"),
      "masked-when-printed": rule("given a key or token in text Gluon prints (an error, a probe's output), then it is masked, by shape and by value"),
      "private-files-directory-first": rule("when a private file is written, then it is made in a fresh 0700 directory and renamed into place, and nothing is left behind on a failure"),
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
    },
  },
  dist: {
    says: "the compiled binary loads only what is built into it (scripts/AGENTS.md)",
    entries: {
      "no-autoload": rule("given a hostile working directory (a bunfig preload, a .env, tsconfig paths), when the compiled or release binary runs, then nothing of it loads", ["e2e"]),
      "no-external": rule("given node_modules in the working directory or its parent, when the compiled binary runs, then its own embedded modules are used, nothing from the directory", ["e2e"]),
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
 * the first `${` of a built one (the entry is at the start, so a built title still names it). Not a `describe`.
 */
export function testTitles(text: string): string[] {
  const re = /\b(?:test|it)(?:\.\w+)*(?:\([^)]*\))?\)?\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;
  return [...text.matchAll(re)].map((m) => (m[1] === "`" ? m[2]!.split("${")[0]! : m[2]!));
}

/** A test file's layer from where it lives (`seam` and `code` share `test/*.test.ts`; `test/dist.test.ts` runs the built binary). */
export function layersOf(file: string): Layer[] {
  if (file === "test/dist.test.ts") return ["e2e"];
  if (file.startsWith("test/e2e/")) return ["e2e"];
  if (file.startsWith("test/real/")) return ["real"];
  if (file.startsWith("test/perf/")) return ["perf"];
  return ["seam", "code"];
}
