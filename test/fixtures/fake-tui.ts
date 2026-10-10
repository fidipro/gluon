/**
 * The fake agents' raw-mode TUI (`FAKE_TUI=1`), shared by both fakes: the bash fake execs this
 * script after printing what it was given, `fake-agent.ts` calls `runTui()`. Like a real agent's
 * prompt, small: an input line with editing (printables and Backspace at the cursor, ←/→ move
 * it, Ctrl+U clears the line), a slash-command menu while
 * the input starts with "/" (Up/Down move the highlight, Enter runs the highlighted item), Tab
 * completes a unique prefix (the fake `opencode`'s Tab runs the highlighted item, the fake `agy`'s
 * completes it, as theirs do; the fake `agy` has no /compact, as Antigravity: its menu says
 * `No matches` and Enter runs nothing), Esc closes the menu (the input stays) or else clears the input,
 * ←/→ on an empty line (and a modified ←/→ anywhere) print ARROW LEFT / ARROW RIGHT. /clear and /new print CLEARED, /compact COMPACTED (after `$FAKE_HOOK`,
 * as a PreCompact hook: exit 2 blocks it, COMPACT BLOCKED), `!compact` stands for an
 * auto-compaction (the hook first, then AUTO COMPACTED or COMPACT BLOCKED), /exit (or Ctrl+D on an
 * empty line) exits `$FAKE_EXIT`, anything else `GOT <line>`; Ctrl+C prints CTRL-C, twice exits 130.
 * `FAKE_KITTY=1`: asks for the kitty keyboard protocol (`CSI >1u`) and reads it; `FAKE_ALT=1`:
 * draws on the alternate screen and never leaves it. Prints its size at start and on every resize,
 * and a red word (colours pass through). `FAKE_PID_FILE`: its pid goes there. `FAKE_KILL_LOG`: /clear
 * and /new append CLEARED to it, a SIGTERM KILLED. `FAKE_CLEAR_DELAY_MS`:
 * /clear and /new take that long before they run (and print anything). `FAKE_RESIZE_DELAY_MS`: its
 * redraw after a resize (the SIZE line) comes that much later, as a TUI that debounces it. `FAKE_INPUT_LOG`: its pid
 * alone on a line at start, then every chunk read from stdin as `<pid> <chunk>`, hex-escaped
 * (`hexEscape`; `inputLog` in `test/e2e/harness.ts` reads it back): what each agent got, byte for byte.
 * `FAKE_SESSIONS=<dir>`: the fake `codex` and `opencode` keep their conversation per session id there, as the real ones do on disk: a
 * start with a spec prints it and `OK`, saves them under a new id and sends it as the harness's hook does (`$FAKE_EVENT_HOOK session <id>`);
 * a start with `codex resume … -- <id>` / `opencode --session=<id>` prints `RESUMED <id>` and the saved exchange (else `NO CONVERSATION FOUND`).
 *
 * The fake `codex` goes to Plan mode on a typed `/plan <text>` (its footer ends with a magenta `Plan mode`, a history line says
 * the model changed for it, then `GOT </plan …>`), as Codex 0.160 does; the fake `grok` on `/plan`, with or without text.
 *
 * Each fake draws its harness's prompt as the recorded screens show it (`test/fixtures/screens/`),
 * so `READERS` reads the fake as it reads the real one (`test/fakes-readers.test.ts`): the fake
 * `claude` Claude Code's, `codex` Codex's, `opencode` OpenCode's, `agy` Antigravity's, `grok` Grok
 * Build's (a rounded composer box with the menu panel above it; Tab completes; `/plan` puts
 * ` · plan` in the box's bottom border, with or without text after it), `kimi` Kimi Code's (a rounded box
 * `│ > <input> │` with the menu panel BELOW it, `→` marking the item, `/clear` listed as `new (clear)`; Tab completes).
 *
 * For Gluon's frame (each a line typed and run): `!mouse` turns on SGR mouse reporting and prints
 * each report as `MOUSE <b;x;y>M`; `!focus` asks for focus reports (`FOCUS IN`/`FOCUS OUT`);
 * `!kitty` pushes the kitty keyboard flags now; `!lines N` prints LINE 1…N; `!tick [ms]` prints
 * `TICK n` every 200 ms (or every `ms`); `!flood <KB> [cols]` writes that many KB of varied
 * printable output as fast as it can (full-width rows of `cols` cells, default the terminal's less one, SGR colours, a row break each;
 * the perf suite, `test/perf/`), then prints `FLOOD-DONE <rows>` (and appends `<rows> <epoch ms>` to `$FAKE_FLOOD_LOG`); `!wide` prints emoji and CJK; `!da` asks the terminal for its device
 * attributes (the answer prints as `DA1 <params>`); `!kq` asks for the kitty keyboard flags, then
 * DA1 (`KITTYQ <params>` before `DA1` when answered); `!codex response|turn|start …` posts Codex's OTel logs to the endpoint its argv names (`CODEX response 200`); `!event <args>` runs `$FAKE_EVENT_HOOK <args>`
 * (a harness's hook: `write-event.ts status working`, `write-event.ts back`); `!otel <usd> <tokens> [model]`
 * posts Claude Code's cost metric and an `api_request` log to `$OTEL_EXPORTER_OTLP_ENDPOINT`
 * (`OTEL 200,200`); with `compact` for the tokens, the metric and the `compaction` event of a
 * `/compact` instead; `!menu` keeps the slash menu open on any line, every command listed (filtered by
 * a typed `/…`), the first highlighted, until Esc or a run: a menu on screen the user never typed a
 * `/` for.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TUI_COMMANDS = ["/clear", "/compact", "/help", "/new", "/exit"];
let codexClock = 0;

/** The fake `codex`'s menu descriptions (Codex's own for its commands). */
const CODEX_ABOUT: Record<string, string> = {
  "/clear": "clear the terminal and start a new chat",
  "/compact": "summarize conversation to prevent hitting the context limit",
  "/new": "start a new chat during a conversation",
  "/exit": "exit Codex",
};
/** The fake `opencode`'s and `agy`'s menu descriptions (their own for these commands). */
const OPENCODE_ABOUT: Record<string, string> = { "/clear": "Clear session", "/compact": "Compact session", "/help": "Help", "/new": "New session", "/exit": "Exit the app" };
const GROK_ABOUT: Record<string, string> = { "/clear": "Start a new session", "/compact": "Compact conversation history", "/help": "Browse commands and keyboard shortcuts", "/new": "Start a new session", "/exit": "Quit the application" };
const KIMI_ABOUT: Record<string, string> = { "/compact": "<instruction> — Compact the conversation context", "/help": "Show available commands and shortcuts", "/new": "Start a fresh session in the current workspace", "/exit": "Exit Kimi Code" };
const AGY_ABOUT: Record<string, string> = { "/clear": "Clear conversation and start a new one", "/compact": "Compact the conversation", "/help": "Show help", "/new": "Clear conversation and start a new one", "/exit": "Exit Antigravity" };

/** A chunk of input as one line: printable ASCII as is, `\\` doubled, every other byte `\xHH`. */
export function hexEscape(chunk: Uint8Array | string): string {
  let out = "";
  for (const b of typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk) out += b === 0x5c ? "\\\\" : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  return out;
}

/**
 * Runs a `$FAKE_HOOK` command line as a harness runs its hook: `sh -c` on POSIX, cmd.exe on Windows.
 * cmd.exe gets the line verbatim: Bun's quoting for an .exe would escape its quotes as `\"`, which
 * cmd.exe doesn't understand (`'\"C:\…\bun.exe\"' is not recognized`).
 */
export function runHook(hook: string, stdio: "pipe" | "inherit") {
  const opts = { stdin: "ignore", stdout: stdio, stderr: stdio } as const;
  if (process.platform !== "win32") return Bun.spawnSync(["sh", "-c", hook], opts);
  const cmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
  return Bun.spawnSync([cmd, "/d", "/s", "/c", `"${hook}"`], { ...opts, windowsVerbatimArguments: true });
}

export function runTui(name = process.env.FAKE_AGENT_NAME ?? ""): void {
  const env = process.env;
  const out = (s: string) => process.stdout.write(s);
  let kitty = !!env.FAKE_KITTY;
  const claude = name === "claude";
  const codex = name === "codex";
  const opencode = name === "opencode";
  const agy = name === "agy";
  const grok = name === "grok";
  const kimi = name === "kimi";
  let input = "";
  /** The cursor: how many characters (code points) of the input are after it. */
  let back = 0;
  /** The input before the cursor. */
  const before = () => {
    const chars = [...input];
    return chars.slice(0, Math.max(0, chars.length - back)).join("");
  };
  /** Antigravity has no /compact: its menu says "No matches" for it (`COMMANDS` in src/pty/readers/index.ts). */
  // Kimi's /clear is an alias of /new: one item, `new (clear)`.
  const commands = agy ? TUI_COMMANDS.filter((c) => c !== "/compact") : kimi ? TUI_COMMANDS.filter((c) => c !== "/clear") : TUI_COMMANDS;
  const starts = (c: string) => c.startsWith(input) || (kimi && c === "/new" && "/clear".startsWith(input));
  /** The fake `codex` after `/plan`: Plan mode's footer, as Codex 0.160 draws it; the fake `grok`'s box label. */
  let planMode = false;
  let sel = 0;
  let ctrlC = 0;
  /** Esc closed the menu: it stays closed until the input changes. */
  let menuClosed = false;
  /** `!menu`: the menu stays open whatever the input, until Esc or a run. */
  let pinned = false;

  if (env.FAKE_PID_FILE) writeFileSync(env.FAKE_PID_FILE, String(process.pid));
  if (env.FAKE_INPUT_LOG) appendFileSync(env.FAKE_INPUT_LOG, `${process.pid}\n`);
  if (env.FAKE_HANG === "ignore-term") process.on("SIGTERM", () => {});
  else if (env.FAKE_KILL_LOG)
    process.on("SIGTERM", () => {
      appendFileSync(env.FAKE_KILL_LOG!, "KILLED\n");
      process.exit(143);
    });

  /** A `/` word typed and the menu not closed: the menu is up, its items those the word starts. */
  const slashWord = () => !menuClosed && input.startsWith("/") && !input.includes(" ");
  const matches = () => {
    if (pinned) return commands.filter((c) => !input.startsWith("/") || starts(c));
    return slashWord() ? commands.filter(starts) : [];
  };
  /** The fake `agy`'s menu with no item (`/compact`): `No matches`, Enter runs nothing, Esc closes it. */
  const noMatches = () => agy && !pinned && slashWord() && !matches().length;
  /** Which line of the block drawn last holds the cursor (the input line). */
  let at = 0;
  /**
   * The prompt block (`at`: the line with the cursor, `col`: its column). The fake `claude` looks
   * like Claude Code 2.1.296 (`test/fixtures/screens/claude-code/`): the menu above a `────` border, `❯ <input>`,
   * a border below; the highlighted item marked `❯ ` in an accent colour, the others indented four cells, grey with the typed
   * letters bold. The fake `codex` looks like Codex 0.159 (`test/fixtures/screens/codex/`): the menu above,
   * items `  /name  description`, the highlighted one `› ` bold on a coloured background; the
   * composer `› <input>` (a faint placeholder when empty) on a shaded background with a shaded blank
   * row above and below; a footer. The fake `opencode` looks like OpenCode 2.0
   * (`test/fixtures/screens/opencode/`): a panel with a `┃` left border, the menu's rows
   * `┃ /name  description` right above the composer's blank top row, the highlighted one on an
   * accent background; the composer `┃  <input>` (a grey placeholder, the cursor at its start), a
   * blank row, the agent · model row, a footer. The fake `agy` looks like Antigravity 1.2
   * (`test/fixtures/screens/antigravity/`): `> <input>` between two full-width `────` borders, the
   * menu below, the highlighted item marked `> `, then the menu's key hint; a footer. The fake `grok`
   * looks like Grok Build 1.0.46 (`test/fixtures/screens/grok-build/`): the menu panel above (between two
   * rules, items `    ❯ /name  description`, the highlighted one with the `❯`), a rounded box with
   * `│ ❯ <input> │` rows, a bottom border carrying the model (and ` · plan`), a hint row. Other fakes:
   * `> <input>` with the menu below, the highlighted item in reverse video.
   */
  function block(): { lines: string[]; at: number; col: number } {
    const m = matches();
    if (sel >= m.length) sel = Math.max(0, m.length - 1);
    const cols = process.stdout.columns || 80;
    const w = Math.max(...m.map((c) => c.length), 0);
    if (codex) {
      const shade = (text: string) => `\x1b[48;5;236m${text}\x1b[K\x1b[0m`;
      const items = m.map((c, i) => {
        const row = `${c.padEnd(w)}  ${CODEX_ABOUT[c] ?? ""}`;
        return i === sel ? `\x1b[1;36;48;5;24m› ${row}\x1b[K\x1b[0m` : `  ${row}`;
      });
      // A long input wraps onto continuation rows indented two spaces, as Codex's composer does.
      const fit = Math.max(8, cols - 3);
      const parts = input ? Array.from({ length: Math.floor(input.length / fit) + 1 }, (_, i) => input.slice(i * fit, (i + 1) * fit)) : [""];
      const composer = parts.map((part, i) => shade(i ? `  ${part}` : `\x1b[1m›\x1b[22m ${part || "\x1b[2mAsk Codex to do anything\x1b[22m"}`));
      const typed = before().length;
      // The footer is two rows below the composer, as in the captures (`frame-turn-idle`); `/plan` adds Plan mode's mark.
      return { lines: [...items, shade(""), ...composer, shade(""), `  gpt-6 · ~/proj${planMode ? " \x1b[35mPlan mode\x1b[0m" : ""}`], at: items.length + 1 + Math.floor(typed / fit), col: 2 + (typed % fit) };
    }
    if (claude) {
      const border = "─".repeat(Math.min(40, cols - 1));
      // Claude Code 2.1.296: the items indented four cells, the highlighted one marked `❯ `.
      const items = m.map((c, i) => (i === sel ? `  ❯ \x1b[38;5;153m${c}\x1b[0m` : `    \x1b[1m${input}\x1b[22m\x1b[38;5;246m${c.slice(input.length)}\x1b[0m`));
      return { lines: [...items, border, `❯ ${input}`, border], at: items.length + 1, col: 2 + before().length };
    }
    if (opencode) {
      // Two cells of margin, the border, the panel: what the reader measures from the border.
      const width = Math.max(12, Math.min(60, cols - 4));
      const panel = (text: string, colour = "") => `  \x1b[38;5;69m┃\x1b[0m\x1b[48;5;235m${colour}${text}${" ".repeat(Math.max(0, width - text.length))}\x1b[0m`;
      const items = m.map((c, i) => (i === sel ? `  \x1b[38;5;69m┃\x1b[0m\x1b[38;5;16;48;5;209m ${`${c.padEnd(w)}  ${OPENCODE_ABOUT[c] ?? ""}`.padEnd(width - 1)}\x1b[0m` : panel(` ${c.padEnd(w)}  ${OPENCODE_ABOUT[c] ?? ""}`)));
      const composer = input ? panel(`  ${input}`) : `  \x1b[38;5;69m┃\x1b[0m\x1b[48;5;235m  \x1b[38;5;244mAsk anything…${" ".repeat(Math.max(0, width - 15))}\x1b[0m`;
      const lines = [...items, panel(""), composer, panel(""), panel("  Build · fake-model"), `  \x1b[38;5;69m╹\x1b[38;5;235m${"▀".repeat(width)}\x1b[0m`, "  ~/proj  ctrl+p commands"];
      return { lines, at: items.length + 1, col: 5 + before().length };
    }
    if (grok) {
      // The box's inner width: its right border is two cells inside what `clip` keeps.
      const inner = Math.max(12, Math.min(100, cols - 5));
      const fit = inner - 4;
      const label = `Grok 4.7 (low)${planMode ? " · plan" : ""}`;
      const rule = `  ${"─".repeat(inner + 2)}`;
      const items = m.map((c, i) => (i === sel ? `    \x1b[1m❯ ${c.padEnd(w)}  ${GROK_ABOUT[c] ?? ""}\x1b[22m` : `      ${c.padEnd(w)}  ${GROK_ABOUT[c] ?? ""}`));
      const parts = input ? Array.from({ length: Math.floor(input.length / fit) + 1 }, (_, i) => input.slice(i * fit, (i + 1) * fit)) : [""];
      const rows = parts.map((part, i) => `  │${` ${i ? " " : "❯"} ${part}`.padEnd(inner)}│`);
      const top = m.length ? items.length + 2 : 0;
      const typed = before().length;
      const hint = input ? "  Enter:send  │  Alt+Enter:newline  │  Shift+Tab:mode  │  Ctrl+x:shortcuts" : "  Shift+Tab:mode  │  Ctrl+x:shortcuts";
      const lines = [...(m.length ? [rule, ...items, rule] : []), `  ╭${"─".repeat(inner)}╮`, ...rows, `  ╰${"─".repeat(Math.max(1, inner - label.length - 3))} ${label} ─╯`, hint];
      return { lines, at: top + 1 + Math.floor(typed / fit), col: 6 + (typed % fit) };
    }
    if (kimi) {
      // Kimi Code 2.1.1 (`test/fixtures/screens/kimi-code/`): a rounded box `│ > <input> │` (continuation rows `│   `), the menu panel right below it.
      const inner = Math.max(12, Math.min(100, cols - 4));
      const fit = inner - 4;
      const parts = input ? Array.from({ length: Math.floor(input.length / fit) + 1 }, (_, i) => input.slice(i * fit, (i + 1) * fit)) : [""];
      const rows = parts.map((part, i) => ` │${(i ? `   ${part}` : ` > ${part}`).padEnd(inner)}│`);
      const label = (c: string) => (c === "/new" ? "new (clear)" : c.slice(1));
      const wide = Math.max(...m.map((c) => label(c).length), 0);
      // A description too long for the box is cut with an ellipsis before the border, as Kimi does.
      const cut = (t: string) => (t.length > inner ? `${t.slice(0, inner - 1)}…` : t.padEnd(inner));
      const items = m.map((c, i) => ` │${cut(`   ${i === sel ? "→" : " "} ${label(c).padEnd(wide)}  ${KIMI_ABOUT[c] ?? ""}`)}│`);
      const typed = before().length;
      return { lines: [` ╭${"─".repeat(inner)}╮`, ...rows, ` ╰${"─".repeat(inner)}╯`, ...items, " moonshotai/kimi-k3 thinking  ~/proj  master"], at: 1 + Math.floor(typed / fit), col: 5 + (typed % fit) };
    }
    if (agy) {
      const border = `\x1b[38;5;8m${"─".repeat(Math.max(11, cols - 1))}\x1b[0m`;
      const items = m.map((c, i) => {
        const about = `\x1b[2m${AGY_ABOUT[c] ?? ""}\x1b[22m`;
        return i === sel ? `\x1b[38;5;12m> ${c.padEnd(w)}\x1b[0m  ${about}` : `  ${c.padEnd(w)}  ${about}`;
      });
      const hint = ["  ↑/↓ Navigate · enter Select · tab Complete", "esc to cancel"];
      const menu = m.length ? [...items, "", ...hint] : noMatches() ? ["   No matches", ...hint] : [input ? "" : "\x1b[38;5;8m? for shortcuts\x1b[0m"];
      return { lines: [border, `\x1b[38;5;12m>\x1b[0m ${input}`, border, ...menu], at: 1, col: 2 + before().length };
    }
    return { lines: [`> ${input}`, ...m.map((c, i) => `  ${i === sel ? `\x1b[7m${c}\x1b[0m` : c}`)], at: 0, col: 2 + before().length };
  }
  /**
   * A block line cut to the terminal's width less one (escape sequences kept), as the harnesses cut
   * their menus: a wrapped line would put the cursor moves off by a row.
   */
  function clip(line: string): string {
    const room = (process.stdout.columns || 80) - 1;
    let used = 0;
    let s = "";
    for (const part of line.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
      if (part.startsWith("\x1b[")) s += part;
      else for (const ch of part) if (used++ < room) s += ch;
    }
    return used > room ? `${s}\x1b[0m` : s;
  }
  /** Redraws the block where it was; `line`: printed above it first. */
  function draw(line?: string) {
    const b = block();
    let s = `${at ? `\x1b[${at}A` : ""}\r\x1b[J`;
    if (line !== undefined) s += `${line}\r\n`;
    s += b.lines.map(clip).join("\r\n");
    const up = b.lines.length - 1 - b.at;
    if (up) s += `\x1b[${up}A`;
    s += `\r\x1b[${b.col}C`;
    at = b.at;
    out(s);
  }
  const say = (line: string) => draw(line);
  function quit(code: number) {
    out(`${at ? `\x1b[${at}A` : ""}\r\x1b[J${kitty ? "\x1b[<u" : ""}\x1b[?2004l`);
    process.stdin.setRawMode(false);
    process.exit(code);
  }

  /** `$FAKE_HOOK`, as a harness runs its hook (its output shown); its exit code. */
  function hook(): number {
    const r = runHook(env.FAKE_HOOK!, "pipe");
    const text = (String(r.stdout) + String(r.stderr)).trim();
    for (const l of text ? text.split(/\r?\n/) : []) say(`HOOK: ${l}`);
    return r.exitCode ?? 1;
  }

  /** Gluon's checks (see the file's comment); true when `line` was one. */
  function gluon(line: string): boolean {
    const [cmd, arg] = line.split(" ");
    switch (cmd) {
      case "!mouse":
        out("\x1b[?1000h\x1b[?1006h");
        say("MOUSE ON");
        return true;
      case "!focus":
        out("\x1b[?1004h");
        say("FOCUS ON");
        return true;
      case "!menu":
        pinned = true;
        draw();
        return true;
      case "!kitty":
        kitty = true;
        out("\x1b[>1u");
        say("KITTY ON");
        return true;
      case "!lines":
        for (let i = 1; i <= Number(arg || 10); i++) say(`LINE ${i}`);
        return true;
      case "!tick": {
        let n = 0;
        setInterval(() => say(`TICK ${++n}`), Number(arg) || 200);
        return true;
      }
      case "!flood": {
        const width = Math.max(12, Number(line.split(" ")[2]) || (process.stdout.columns || 80) - 1);
        const budget = Math.max(1, Number(arg || 100)) * 1024;
        // The prompt block goes first, as a harness's output scrolls above its prompt; `FLOOD-DONE` redraws it.
        out(`${at ? `\x1b[${at}A` : ""}\r\x1b[J`);
        at = 0;
        let seed = 0x9e3779b9;
        const next = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x1234567) >>> 0), seed);
        const letters = "abcdefghijklmnopqrstuvwxyz0123456789 _-./";
        let rows = 0;
        let bytes = 0;
        let chunk = "";
        while (bytes < budget) {
          let row = `\x1b[1;3${(rows % 6) + 1}mROW ${++rows}\x1b[0m `;
          let cells = `ROW ${rows} `.length;
          while (cells < width) {
            // A word in a random colour (256 palette, or true colour every fifth), each 3 to 10 cells.
            const r = next();
            const len = Math.min(width - cells, 3 + (r % 8));
            let word = "";
            for (let i = 0; i < len; i++) word += letters[(next() >>> 5) % letters.length];
            row += r % 5 === 0 ? `\x1b[38;2;${r & 255};${(r >>> 8) & 255};${(r >>> 16) & 255}m${word}` : `\x1b[38;5;${16 + (r % 216)}m${word}`;
            cells += len;
          }
          row += "\x1b[0m\r\n";
          chunk += row;
          bytes += row.length;
          if (chunk.length > 65_536) (out(chunk), (chunk = ""));
        }
        if (chunk) out(chunk);
        if (env.FAKE_FLOOD_LOG) appendFileSync(env.FAKE_FLOOD_LOG, `${rows} ${Date.now()}\n`);
        say(`FLOOD-DONE ${rows}`);
        return true;
      }
      case "!wide":
        say("WIDE 你好世界 🙂👍 end");
        return true;
      case "!da":
        out("\x1b[c");
        return true;
      case "!kq":
        // Kitty's flags query, then DA1: a terminal without kitty answers only the second.
        out("\x1b[?u\x1b[c");
        return true;
      case "!otel": {
        // Claude Code's export: the cost metric and one main-thread api_request (its prompt's tokens).
        const [, usd = "0", tokens = "0", otelModel = "claude-sonnet-5-5"] = line.split(" ");
        const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
        const [hk = "", hv = ""] = (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split("=");
        if (!base) {
          say("OTEL OFF");
          return true;
        }
        const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", [hk]: hv }, body: JSON.stringify(body) }).then((r) => r.status);
        const attr = (key: string, v: string | number) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v } });
        // Gluon prices the request itself (claude-sonnet-5-5: $2 in / $10 out per million): the output that makes it the metric's cost.
        const outputFor = (total: number, input: number) => Math.max(0, Math.round(((total - (input * 2) / 1e6) / 10) * 1e6));
        const record = tokens === "compact" ? [attr("event.name", "compaction"), attr("trigger", "manual"), attr("success", "true"), attr("pre_tokens", 380000), attr("post_tokens", 9000)] : [attr("event.name", "api_request"), attr("model", otelModel), attr("input_tokens", Number(tokens)), attr("output_tokens", outputFor(Number(usd), Number(tokens))), attr("query_source", "repl_main_thread")];
        void Promise.all([
          post("/v1/metrics", { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "claude_code.cost.usage", sum: { aggregationTemporality: 2, dataPoints: [{ asDouble: Number(usd), attributes: [], startTimeUnixNano: "1" }] } }] }] }] }),
          post("/v1/logs", { resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: String(Date.now() * 1e6), attributes: record }] }] }] }),
        ]).then((s) => say(`OTEL ${s.join(",")}`), () => say("OTEL FAILED"));
        return true;
      }
      case "!codex": {
        // Codex's OTel logs, to the endpoint its `-c otel.exporter=…` argv names: `!codex response <conversation> <input> <output>`,
        // `!codex turn <conversation> <input> <output> <usd>` (a `codex.turn_cost`), `!codex start <conversation> [window]`.
        const [, kind = "", conversation = "c0", a = "0", b = "0", c = "0"] = line.split(" ");
        const exporter = process.argv.find((x) => x.startsWith("otel.exporter="));
        const m = exporter?.match(/endpoint="([^"]+)".*?headers=\{([^=]+)="([^"]+)"/);
        if (!m) {
          say("CODEX OFF");
          return true;
        }
        const attr = (key: string, v: string | number) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v } });
        const common = [attr("conversation.id", conversation), attr("model", "gpt-6-sol")];
        const record = kind === "start" ? [attr("event.name", "codex.conversation_starts"), ...common, ...(Number(a) ? [attr("context_window", Number(a))] : [])] : kind === "turn" ? [attr("event.name", "codex.turn_cost"), ...common, attr("input_token_count", Number(a)), attr("output_token_count", Number(b)), attr("usage.estimated_usd", Number(c))] : [attr("event.name", "codex.sse_event"), attr("event.kind", "response.completed"), ...common, attr("input_token_count", Number(a)), attr("output_token_count", Number(b))];
        codexClock += 1;
        void fetch(m[1]!, { method: "POST", headers: { "content-type": "application/json", [m[2]!]: m[3]! }, body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ observedTimeUnixNano: String(BigInt(Date.now()) * 1000000n + BigInt(codexClock)), attributes: record }] }] }] }) }).then((r) => say(`CODEX ${kind} ${r.status}`), () => say("CODEX FAILED"));
        return true;
      }
      case "!event": {
        const args = line.slice("!event ".length);
        if (env.FAKE_EVENT_HOOK) runHook(`${env.FAKE_EVENT_HOOK} ${args}`, "pipe");
        say(`EVENT ${args}`);
        return true;
      }
    }
    return false;
  }

  /** `FAKE_SESSIONS`: a conversation saved per session id, resumed by the harness's own argv (see the file's comment). */
  function fakeSession() {
    const args = process.argv.slice(2);
    const file = (id: string) => join(env.FAKE_SESSIONS!, `${id}.txt`);
    const resumed = codex ? (args[0] === "resume" ? args.at(-1) : undefined) : args.find((a) => a.startsWith("--session="))?.slice("--session=".length);
    if (resumed) {
      say(existsSync(file(resumed)) ? `RESUMED ${resumed}` : `NO CONVERSATION FOUND ${resumed}`);
      if (existsSync(file(resumed))) for (const l of readFileSync(file(resumed), "utf8").trimEnd().split("\n")) say(l);
      return;
    }
    const spec = codex ? args.at(-1) : args.find((a) => a.startsWith("--prompt="))?.slice("--prompt=".length);
    if (!spec) return;
    const id = codex ? crypto.randomUUID() : `ses_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    writeFileSync(file(id), `> ${spec}\nOK\n`);
    say(`> ${spec}`);
    say("OK");
    if (env.FAKE_EVENT_HOOK) runHook(`${env.FAKE_EVENT_HOOK} session ${id}`, "pipe");
  }

  function run(line: string) {
    menuClosed = false;
    pinned = false;
    back = 0;
    if (line.startsWith("!") && line !== "!compact") {
      const typed = input;
      input = "";
      sel = 0;
      if (gluon(line)) return;
      input = typed;
    }
    // The hook runs before anything is redrawn: the screen is the user's line while it waits.
    if (line === "!compact") {
      const code = env.FAKE_HOOK ? hook() : 0;
      input = "";
      return say(code === 2 ? "COMPACT BLOCKED" : "AUTO COMPACTED");
    }
    input = "";
    sel = 0;
    if (line === "/clear" || line === "/new") {
      const clear = () => {
        if (env.FAKE_HOOK) hook();
        if (env.FAKE_KILL_LOG) appendFileSync(env.FAKE_KILL_LOG, "CLEARED\n");
        say("CLEARED");
      };
      const delay = Number(env.FAKE_CLEAR_DELAY_MS) || 0;
      return delay ? void setTimeout(clear, delay) : clear();
    }
    if (line === "/compact") {
      const code = env.FAKE_HOOK ? hook() : 0;
      return say(code === 2 ? "COMPACT BLOCKED" : "COMPACTED");
    }
    if (line === "/exit") quit(Number(env.FAKE_EXIT || 7));
    if (codex && /^\/plan(\s|$)/.test(line)) {
      planMode = true;
      say("\x1b[2m• \x1b[0mModel changed to gpt-6 for Plan mode.");
    }
    // Grok's `/plan` alone only switches the mode (nothing runs); with text it starts a turn on it.
    if (grok && /^\/plan(\s|$)/.test(line)) {
      planMode = true;
      if (line.trim() === "/plan") return say("✓ Plan mode: on");
    }
    say(`GOT <${line}>`);
  }

  type K = { k: "char"; ch: string } | { k: "report"; text: string } | { k: "enter" | "tab" | "backspace" | "up" | "down" | "left" | "right" | "esc" | "ctrl-c" | "ctrl-d" | "ctrl-u" | "none" };
  /** The keys in a chunk: legacy bytes, and kitty `CSI code;mods u` when asked for. A paste is text. */
  function keys(s: string): K[] {
    const ks: K[] = [];
    for (let i = 0; i < s.length; ) {
      if (s.startsWith("\x1b[200~", i)) {
        const end = s.indexOf("\x1b[201~", i);
        const text = s.slice(i + 6, end < 0 ? s.length : end);
        for (const ch of text.replace(/[\r\n]+/g, " ")) ks.push({ k: "char", ch });
        i = end < 0 ? s.length : end + 6;
        continue;
      }
      const csi = /^\x1b\[([0-9;:?<]*)([ -/]*[@-~])/.exec(s.slice(i));
      if (csi) {
        i += csi[0].length;
        const [, params, final] = csi;
        if (params!.startsWith("<") && (final === "M" || final === "m")) ks.push({ k: "report", text: `MOUSE <${params!.slice(1)}>${final}` });
        else if (params === "" && (final === "I" || final === "O")) ks.push({ k: "report", text: final === "I" ? "FOCUS IN" : "FOCUS OUT" });
        else if (params!.startsWith("?") && final === "c") ks.push({ k: "report", text: `DA1 ${params}` });
        else if (params!.startsWith("?") && final === "u") ks.push({ k: "report", text: `KITTYQ ${params}` });
        else if (final === "A") ks.push({ k: "up" });
        else if (final === "B") ks.push({ k: "down" });
        // A plain ←/→ (kitty's has no modifiers) moves the cursor; a modified one, or a key release, is printed.
        else if ((final === "C" || final === "D") && (params === "" || params === "1;1")) ks.push({ k: final === "C" ? "right" : "left" });
        else if (final === "C" || final === "D") ks.push({ k: "report", text: `ARROW ${final === "C" ? "RIGHT" : "LEFT"}` });
        else if (final === "u" && kitty) {
          const [code, mods] = params!.split(";").map((p) => Number(p.split(":")[0]));
          const ctrl = (((mods || 1) - 1) & 4) !== 0;
          if (ctrl && code === 99) ks.push({ k: "ctrl-c" });
          else if (ctrl && code === 100) ks.push({ k: "ctrl-d" });
          else if (ctrl && code === 117) ks.push({ k: "ctrl-u" });
          else if (code === 13) ks.push({ k: "enter" });
          else if (code === 9) ks.push({ k: "tab" });
          else if (code === 127) ks.push({ k: "backspace" });
          else if (code === 27) ks.push({ k: "esc" });
          else if (!ctrl && code! >= 32) ks.push({ k: "char", ch: String.fromCodePoint(code!) });
          else ks.push({ k: "none" });
        } else ks.push({ k: "none" });
        continue;
      }
      const ch = String.fromCodePoint(s.codePointAt(i)!);
      i += ch.length;
      if (ch === "\x1b") {
        if (s[i] === "O" && i + 1 < s.length) {
          const f = s[i + 1];
          ks.push(f === "A" ? { k: "up" } : f === "B" ? { k: "down" } : f === "C" ? { k: "right" } : f === "D" ? { k: "left" } : { k: "none" });
          i += 2;
        } else ks.push({ k: "esc" });
      } else if (ch === "\r" || ch === "\n") ks.push({ k: "enter" });
      else if (ch === "\t") ks.push({ k: "tab" });
      else if (ch === "\x7f" || ch === "\b") ks.push({ k: "backspace" });
      else if (ch === "\x03") ks.push({ k: "ctrl-c" });
      else if (ch === "\x04") ks.push({ k: "ctrl-d" });
      else if (ch === "\x15") ks.push({ k: "ctrl-u" });
      else if (ch >= " ") ks.push({ k: "char", ch });
      else ks.push({ k: "none" });
    }
    return ks;
  }

  function onKey(key: K) {
    if (key.k === "report") return say(key.text);
    // ←/→ move the cursor in the line, printed on an empty one; either way the Ctrl+C count stays.
    if (key.k === "left" || key.k === "right") {
      if (!input) return say(`ARROW ${key.k === "right" ? "RIGHT" : "LEFT"}`);
      back = Math.max(0, Math.min([...input].length, back + (key.k === "left" ? 1 : -1)));
      return draw();
    }
    if (key.k !== "ctrl-c") ctrlC = 0;
    if (key.k === "char" || key.k === "backspace" || key.k === "tab" || key.k === "ctrl-c" || key.k === "ctrl-u") menuClosed = false;
    switch (key.k) {
      case "char":
        input = before() + key.ch + [...input].slice([...before()].length).join("");
        sel = 0;
        return draw();
      case "backspace": {
        const head = [...before()];
        input = head.slice(0, -1).join("") + [...input].slice(head.length).join("");
        sel = 0;
        return draw();
      }
      case "ctrl-u":
        input = "";
        back = 0;
        sel = 0;
        return draw();
      case "tab": {
        const m = matches();
        // OpenCode's Tab runs the highlighted item, Antigravity's completes it.
        if (opencode && m.length) return run(m[sel]!);
        if ((agy || grok || kimi) && m.length) input = m[sel]!;
        else if (m.length === 1) input = m[0]!;
        back = 0;
        return draw();
      }
      case "up":
      case "down": {
        const n = matches().length;
        if (n) sel = (sel + (key.k === "up" ? n - 1 : 1)) % n;
        return draw();
      }
      case "enter": {
        const m = matches();
        // Antigravity's menu with no item (`/compact`): nothing to run.
        if (noMatches()) return draw();
        // A pinned menu (`!menu`) runs its item for an empty line or a `/…`, else the line.
        return run(m.length && (!pinned || !input || input.startsWith("/")) ? m[sel]! : input);
      }
      case "esc":
        if (pinned) pinned = false;
        else if (matches().length || noMatches()) menuClosed = true;
        else {
          input = "";
          back = 0;
        }
        return draw();
      case "ctrl-c":
        input = "";
        back = 0;
        if (++ctrlC === 2) quit(130);
        return say("CTRL-C");
      case "ctrl-d":
        if (!input) quit(Number(env.FAKE_EXIT || 7));
        return;
    }
  }

  process.stdin.setRawMode(true);
  const decoder = new TextDecoder();
  process.stdin.on("readable", () => {
    let c: string | Buffer | null;
    while ((c = process.stdin.read()) !== null) {
      if (env.FAKE_INPUT_LOG) appendFileSync(env.FAKE_INPUT_LOG, `${process.pid} ${hexEscape(c)}\n`);
      for (const k of keys(typeof c === "string" ? c : decoder.decode(c, { stream: true }))) onKey(k);
    }
  });
  const resized = () => say(`SIZE ${process.stdout.columns}x${process.stdout.rows}`);
  const redrawDelay = Number(env.FAKE_RESIZE_DELAY_MS) || 0;
  process.stdout.on("resize", () => (redrawDelay ? void setTimeout(resized, redrawDelay) : resized()));
  out(`${env.FAKE_ALT ? "\x1b[?1049h\x1b[H" : ""}${kitty ? "\x1b[>1u" : ""}\x1b[?2004h`);
  say(`SIZE ${process.stdout.columns}x${process.stdout.rows}`);
  say("\x1b[31mRED\x1b[0m TUI ready");
  if (env.FAKE_SESSIONS && (codex || opencode)) fakeSession();
}

if (import.meta.main) runTui();
