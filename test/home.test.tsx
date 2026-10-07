/**
 * Gluon's home view: its cells rendered at several widths, and the whole view driven by keys in
 * an in-memory Ink render (`fixtures/ink-term.tsx`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { renderToString } from "ink";
import { loadConfig, type AgentOption, type ModelOption } from "../src/config.ts";
import { offeredAgents } from "../src/models.ts";
import { SessionStore, tabs } from "../src/sessions.ts";
import { choiceHints, ChoiceBlock, FIRST_LINE, openBlockRows, QuestionBlock, questionHints, Transcript } from "../src/ui/chat.tsx";
import { Header } from "../src/ui/header.tsx";
import { Home, type HomeProps } from "../src/ui/Home.tsx";
import { DOUBLE_CLICK_MS, rowKey, type Readiness } from "../src/ui/layout.ts";
import { AgentsAvailable, fitHint, HOME_HINT, homeHint, KEYS_HINT, SessionList } from "../src/ui/list.tsx";
import { Mark } from "../src/ui/mark.tsx";
import { Markdown, markdownRows } from "../src/ui/markdown.tsx";
import { makeTheme } from "../src/ui/theme.ts";
import { Width, wrap } from "../src/ui/width.tsx";
import { createScreen } from "../src/pty/screen.ts";
import type { MouseReport } from "../src/pty/types.ts";
import { inkTerm } from "./fixtures/ink-term.tsx";
import { mockupChat, mockupStore, NOW, PROPOSAL, StubSession } from "./fixtures/gluon.ts";

const config = loadConfig();
const theme = makeTheme(null, { COLORTERM: "truecolor" });
const palette = theme.gluon;
const agents = offeredAgents(config, { installed: () => true, demo: true });
const header = { version: "1.0.0", repo: "fidius/gluon", branch: "issue-13-return", modified: 2 };
const readiness: Readiness[] = [
  { harness: "claude-code", state: "ready", note: "claude plan" },
  { harness: "codex", state: "ready", note: "chatgpt plan" },
  { harness: "grok-build", state: "ready", note: "api key" },
  { harness: "antigravity", state: "signin" },
  { harness: "opencode", state: "ready", note: "open-weight models" },
];
/** The ANSI of a truecolor background / foreground. */
const BG = (hex: string) => `48;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
const FG = (hex: string) => `38;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
const plain = (s: string) => Bun.stripANSI(s);
const lines = (s: string) => plain(s).split("\n");
const fits = (out: string, columns: number) => {
  for (const l of lines(out)) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(columns);
};

// Colours are asserted: chalk at truecolor whatever the test's terminal (Docker and CI have none),
// Ink's own copy too (it bundles another chalk version).
const inkChalk = (await import(Bun.resolveSync("chalk", Bun.resolveSync("ink", import.meta.dir)))).default as typeof chalk;
const levels = [chalk.level, inkChalk.level] as const;
beforeAll(() => {
  chalk.level = 3;
  inkChalk.level = 3;
});
afterAll(() => {
  chalk.level = levels[0];
  inkChalk.level = levels[1];
});

const at = (columns: number, node: React.ReactNode) => renderToString(<Width columns={columns}>{node}</Width>, { columns });

test("the mark is amber, three rows", () => {
  const out = renderToString(<Mark palette={palette} />, { columns: 20 });
  expect(lines(out).map((l) => l.trimEnd())).toEqual(["   ⡠●", "──⢎──●", "   ⠑●"]);
  expect(out).toContain(FG(palette.amber));
});

describe("header", () => {
  const counts = { awaiting: 1, working: 2, done: 1, drafting: 1 };
  test("wide: version, repo line, counts with awaiting in amber", () => {
    const out = at(106, <Header info={header} counts={counts} palette={palette} />);
    const [l1, l2, l3] = lines(out);
    expect(l1).toMatch(/⡠● {3}Gluon v1\.0\.0$/);
    expect(plain(out)).not.toContain("intake agent");
    expect(l2).toContain("fidius/gluon · issue-13-return · 2 modified");
    expect(l3).toContain("1 awaiting input · 2 working · 1 done · 1 drafting");
    expect(out).toContain(`${FG(palette.amber)}1 awaiting input`);
    fits(out, 106);
  });

  test("narrow: lines are cut, nothing wraps", () => {
    for (const columns of [56, 40, 30]) {
      const out = at(columns, <Header info={{ ...header, repo: "some-owner/a-rather-long-repository-name" }} counts={counts} palette={palette} />);
      expect(lines(out)).toHaveLength(3);
      fits(out, columns);
    }
    expect(lines(at(106, <Header info={header} counts={{ awaiting: 0, working: 0, done: 0, drafting: 0 }} palette={palette} />))[2]).toContain("no sessions yet");
  });
});

describe("session list", () => {
  const store = mockupStore();
  for (const columns of [60, 80, 110, 160]) {
    test(`${columns} columns: groups, glyphs, nothing wraps, the selected row is a full-width bar`, () => {
      const width = columns - 4;
      const selected = store.sessions[1]!.id;
      const out = at(width, <SessionList sessions={store.sessions} selected={rowKey(selected)} maxRows={40} palette={palette} config={config} now={NOW} />);
      const ls = lines(out);
      // The column header, then 4 labels, 5 rows and the 3 blanks between groups.
      expect(ls).toHaveLength(13);
      fits(out, width);
      expect(ls.filter((l) => /^ ▾ (Awaiting input|Working|Done|Drafting)$/.test(l.trimEnd()))).toHaveLength(4);
      for (const g of ["?", "●", "✓", "◌"]) expect(ls.some((l) => l.startsWith(` ${g}  `))).toBe(true);
      const bar = out.split("\n").find((l) => l.includes(BG(palette.selected)))!;
      expect(plain(bar)).toContain("flaky-launcher-test");
      expect(Bun.stringWidth(plain(bar))).toBe(width);
      if (columns >= 110) expect(plain(out)).toContain("84%");
    });
  }

  test("a short list window keeps the selected row", () => {
    const last = store.sessions.find((s) => s.state === "drafting")!.id;
    const out = at(106, <SessionList sessions={store.sessions} selected={rowKey(last)} maxRows={3} palette={palette} now={NOW} />);
    expect(lines(out)).toHaveLength(3);
    expect(plain(out)).toContain("(untitled)");
  });
});

test("first run: agents available with readiness, then the note", () => {
  const out = at(106, <AgentsAvailable readiness={readiness} palette={palette} />);
  const ls = lines(out).map((l) => l.trimEnd());
  expect(ls[0]).toBe(" Agents available");
  expect(ls[1]).toMatch(/^ ●  claude code +ready · claude plan$/);
  expect(ls[4]).toMatch(/^ ○  antigravity +sign-in needed$/);
  expect(ls.at(-1)).toBe("Every session you start shows up here. Switch between them any time.");
  expect(out).toContain(FG(palette.green));
});

describe("chat cells", () => {
  test("user on a full-width bar with a blue ›; one ◇ line for tools; ◆ then text, no speaker label", () => {
    const s = new StubSession();
    mockupChat(s);
    s.set({ pending: null, items: s.state.items.slice(0, 3) });
    const out = at(106, <Transcript state={s.state} palette={palette} theme={theme} config={config} />);
    const ls = lines(out).filter((l) => l.trim());
    expect(ls[0]).toMatch(/^ › {2}add a resume flag/);
    expect(ls[1]).toBe(' ◇  Searched src/cli for "session" · read 3 files');
    expect(ls[2]).toMatch(/^ ◆ {2}Same agent or a different one\?/);
    const bar = out.split("\n").find((l) => l.includes("add a resume flag"))!;
    expect(bar).toContain(BG(palette.bar));
    expect(Bun.stringWidth(plain(bar))).toBe(106);
    expect(bar).toContain(`${FG(palette.blue)} ›`);
    expect(plain(out)).not.toMatch(/Gluon asks|Ready to launch|Explored/);
  });

  const OPTIONS = [
    "    ❯ 1. claude code × sonnet 5.5 × medium · recommended",
    "      2. codex × gpt-6.1 sol × medium",
    "      3. opencode × deepseek flash × low",
    "      4. keep talking",
    "     ↑↓ choose · enter starts the session · esc cancels · tab model · shift+tab effort · ctrl+t mode",
  ];

  test("BUG-197/C: the agent choice: lead line, the spec in its titled box, full triples, recommended first, keep talking, the hint", () => {
    const out = at(106, <ChoiceBlock proposal={PROPOSAL} triples={PROPOSAL.choices} selected={0} showSpec palette={palette} theme={theme} config={config} />);
    const ls = lines(out).map((l) => l.trimEnd());
    const row = (text: string) => `   │ ${text.padEnd(106 - 3 - 4)} │`;
    expect(ls).toEqual([
      " ◆  A small scoped edit, about 3 files in src/cli. I'd start it with:",
      `   ╭─ spec — what the agent will get ${"─".repeat(106 - 3 - 34 - 18)} ctrl+o to hide ─╮`,
      row("Add a --resume flag so a finished session can be reopened."),
      row(""),
      row("• keep the conversation"),
      row("• restore the working tree"),
      `   ╰${"─".repeat(106 - 3 - 2)}╯`,
      ...OPTIONS,
    ]);
    // The box in the frame colour, its text in the chat's.
    const edge = out.split("\n").find((l) => l.includes("╭─"))!;
    expect(edge).toContain(FG(palette.frame));
    expect(out.split("\n").find((l) => l.includes("keep the conversation"))).toContain(FG(palette.text));
    const bar = out.split("\n").find((l) => l.includes("❯"))!;
    expect(bar).toContain(BG(palette.selected));
    expect(Bun.stringWidth(plain(bar))).toBe(106);
    // Ctrl+O: the spec on one line, still above the agents.
    const folded = lines(at(106, <ChoiceBlock proposal={PROPOSAL} triples={PROPOSAL.choices} selected={0} showSpec={false} palette={palette} theme={theme} config={config} />)).map((l) => l.trimEnd());
    expect(folded).toEqual([" ◆  A small scoped edit, about 3 files in src/cli. I'd start it with:", "     spec: Add a --resume flag so a finished session can be reopened.  (ctrl+o to view)", ...OPTIONS]);
    // BUG-183/hint: key caps bold and bright, labels dim.
    const hint = out.split("\n").find((l) => l.includes("shift+tab"))!;
    expect(hint).toContain(`${FG(palette.bright)}`);
    expect(hint.indexOf(FG(palette.bright))).toBeLessThan(hint.indexOf("↑↓"));
  });

  test("BUG-197/C: a spec cut to its rows shows the top first, says what's left out, and scrolls", () => {
    const cut = (view: { rows: number; offset?: number }) => lines(at(80, <ChoiceBlock proposal={PROPOSAL} triples={PROPOSAL.choices} selected={0} showSpec spec={view} palette={palette} theme={theme} config={config} />)).map((l) => l.trimEnd());
    const top = cut({ rows: 2 });
    expect(top.slice(2, 5)).toEqual([`   │ ${"Add a --resume flag so a finished session can be reopened.".padEnd(80 - 7)} │`, `   │ ${"".padEnd(80 - 7)} │`, expect.stringMatching(/^ {3}╰─+ … 2 more lines \(pgdn\) ─╯$/)]);
    // At 80 columns the hint drops its last key whole (BUG-225).
    expect(top.slice(5)).toEqual([...OPTIONS.slice(0, -1), "     ↑↓ choose · enter starts the session · esc cancels · tab model"]);
    const end = cut({ rows: 2, offset: 9 });
    expect(end.slice(2, 5).join("\n")).toMatch(/│ • keep the conversation +│\n.*│ • restore the working tree +│\n {3}╰─+ 2 lines above \(pgup\) ─╯/);
    const middle = cut({ rows: 1, offset: 1 });
    expect(middle[3]).toMatch(/╰─+ 1 line above \(pgup\) · … 2 more lines \(pgdn\) ─╯$/);
    // No row for the text: the one line, which says why.
    expect(cut({ rows: 0 })[1]).toMatch(/^ {5}spec: Add a --resume flag .*  \(a taller terminal shows it\)$/);
    for (const w of [30, 40, 60]) fits(at(w, <ChoiceBlock proposal={PROPOSAL} triples={PROPOSAL.choices} selected={0} showSpec spec={{ rows: 1, offset: 1 }} palette={palette} theme={theme} config={config} />), w);
  });

  test("BUG-197/C: markdownRows counts the rows Markdown draws, so the spec box can be cut without measuring", () => {
    const text = [
      "# Title that is long enough to wrap at a narrow width",
      "",
      "A paragraph with **bold**, `code` and _italic_ words that wraps over several lines here.",
      "",
      "",
      "- a bullet that also wraps when the width is small enough",
      "  - a nested bullet, deeper, that wraps as well at narrow widths",
      "1. an ordered item with some words",
      "- [ ] a task",
      "> a quote that runs long enough to wrap at most widths",
      "---",
      "| a | b |",
      "|---|---|",
      "| one | a longer cell here |",
      "```",
      "const code = 'a long line of code that is wrapped, never truncated';",
      "",
      "```",
      "\tindented paragraph",
    ].join("\n");
    // From 20 columns: narrower, `Indent` keeps 10 for a nested item and Ink wraps it again.
    for (const w of [20, 24, 29, 33, 47, 80]) {
      const drawn = lines(at(w, <Markdown text={text} theme={theme} />)).length;
      expect(`${w}: ${markdownRows(text, theme, w)}`).toBe(`${w}: ${drawn}`);
    }
  });

  test("BUG-221/C: Tab and Shift+Tab are in the choice's hint only when the highlighted agent has a model / effort to switch to", () => {
    const keys = (h: [string, string][]) => h.map(([k]) => k);
    // Efforts are the model's: [] on a model that takes none.
    const opt = (harness: AgentOption["harness"], models: string[], efforts: ModelOption["efforts"]): AgentOption => ({ harness, label: harness, note: "", models: models.map((id) => ({ id, label: id, note: "", efforts })) });
    const offered = [opt("codex", ["gpt-6.1-sol"], ["low", "medium", "high"]), opt("opencode", ["muse-spark-1.3", "deepseek-flash"], []), opt("claude-code", ["sonnet", "opus"], ["low", "medium"])];
    // Codex on a plan with one model: no `tab model`.
    expect(keys(choiceHints({ harness: "codex", model: "gpt-6.1-sol", effort: "medium" }, offered))).toEqual(["↑↓", "enter", "esc", "shift+tab", "ctrl+t"]);
    // OpenCode, whose models take no effort: no `shift+tab effort`.
    expect(keys(choiceHints({ harness: "opencode", model: "muse-spark-1.3" }, offered))).toEqual(["↑↓", "enter", "esc", "tab", "ctrl+t"]);
    expect(keys(choiceHints({ harness: "claude-code", model: "sonnet", effort: "low" }, offered))).toEqual(["↑↓", "enter", "esc", "tab", "shift+tab", "ctrl+t"]);
    // `keep talking` highlighted: neither.
    expect(keys(choiceHints(undefined, offered))).toEqual(["↑↓", "enter", "esc"]);
  });

  test("BUG-225/C: the choice's hint says what Enter does — starts the session, keeps talking, or sends what is typed — enter and esc before the optional tab keys; the question's in the hint line's words", () => {
    const pairs = (h: [string, string][]) => h.map(([k, l]) => `${k} ${l}`);
    const t = { harness: "claude-code" as const, model: "sonnet", effort: "medium" as const };
    expect(pairs(choiceHints(t, agents))).toEqual(["↑↓ choose", "enter starts the session", "esc cancels", "tab model", "shift+tab effort", "ctrl+t mode"]);
    expect(pairs(choiceHints(undefined, agents))).toEqual(["↑↓ choose", "enter keeps talking", "esc cancels"]);
    expect(pairs(choiceHints(t, agents, "text"))).toEqual(["enter sends", "esc esc clears it"]);
    expect(pairs(choiceHints(t, agents, 2))).toEqual(["enter picks 2", "esc esc clears it"]);
    expect(pairs(questionHints())).toEqual(["↑↓ choose", "enter answers", "esc dismisses", "tab adds your words to it", "type to answer in your words"]);
    // The hint line says the same, without the optional keys.
    expect(homeHint("choice")).toBe("↑↓ choose · enter starts the session · esc cancels");
    expect(homeHint("talk")).toBe("↑↓ choose · enter keeps talking · esc cancels");
    expect(homeHint("question")).toBe("↑↓ choose · enter answers · esc dismisses");
    expect(homeHint("typing")).toBe("enter sends · esc esc clears it");
    // Short of columns, whole keys go from the end: never enter or esc cut in the middle.
    for (const w of [56, 60, 76]) {
      const out = plain(at(w, <ChoiceBlock proposal={PROPOSAL} triples={PROPOSAL.choices} selected={0} showSpec={false} hints={choiceHints(t, agents)} palette={palette} theme={theme} config={config} />));
      const hint = out.split("\n").find((l) => l.includes("↑↓ choose"))!;
      expect(hint).toContain("enter starts the session · esc cancels");
      expect(hint).not.toContain("…");
      fits(out, w);
    }
  });

  test("BUG-183/recommended: the first option is marked recommended only while it is the intake agent's own", () => {
    const changed = [{ ...PROPOSAL.choices[0]!, effort: "high" as const }, ...PROPOSAL.choices.slice(1)];
    const out = plain(at(106, <ChoiceBlock proposal={PROPOSAL} triples={changed} selected={0} showSpec={false} palette={palette} theme={theme} config={config} />));
    expect(out).toContain("1. claude code × sonnet 5.5 × high");
    expect(out).not.toContain("recommended");
    const back = plain(at(106, <ChoiceBlock proposal={PROPOSAL} triples={PROPOSAL.choices} selected={0} showSpec={false} palette={palette} theme={theme} config={config} />));
    expect(back).toContain("× medium · recommended");
  });

  test("BUG-267/GLUON-49: a wrapped option never ends a line in its separator — at 50 columns `· recommended` starts the next line; no width leaves a dangling `·` or `×`", () => {
    const options = (w: number) => {
      const out = plain(at(w, <ChoiceBlock proposal={PROPOSAL} triples={PROPOSAL.choices} selected={0} showSpec={false} palette={palette} theme={theme} config={config} />));
      const ls = out.split("\n").map((l) => l.trimEnd());
      return ls.slice(ls.findIndex((l) => l.includes("❯ 1.")), ls.findIndex((l) => l.includes("4. keep talking")));
    };
    // The home view at 50 columns gives the chat 46.
    expect(options(46).slice(0, 2)).toEqual(["    ❯ 1. claude code × sonnet 5.5 × medium", "         · recommended"]);
    for (let w = 24; w <= 110; w++) {
      const ls = options(w);
      for (const l of ls) expect(l).not.toMatch(/ [·×]$/);
      expect(ls.join(" ").replace(/ +/g, " ")).toContain("claude code × sonnet 5.5 × medium");
      expect(ls.join(" ")).toContain("recommended");
    }
    // The same in any wrapped text (the chat's proposal line); a word too long to go with its separator drops it at the break.
    expect(wrap("I'd start it with: claude code × sonnet 5.5 × medium", 28)).toBe("I'd start it with: claude\ncode × sonnet 5.5 × medium");
    expect(wrap("medium · recommended", 12)).toBe("medium\nrecommended");
  });
});

/** The home view, the mockup's sessions and chat, at a size; with what its callbacks got. */
async function home({ columns = 110, rows = 40, store = mockupStore(), chat = true, extra = {} }: { columns?: number; rows?: number; store?: SessionStore; chat?: boolean; extra?: Partial<HomeProps> } = {}) {
  const s = new StubSession();
  if (chat) mockupChat(s);
  const got = { opened: [] as number[], started: [] as unknown[], quit: 0, ended: [] as number[], discarded: 0 };
  const props: HomeProps = {
    store,
    session: s.asSession(),
    theme,
    header,
    readiness,
    offeredAgents: agents,
    config,
    onOpen: (id) => got.opened.push(id),
    onStart: (c) => got.started.push(c),
    onQuit: () => got.quit++,
    onEnd: (id) => got.ended.push(id),
    onDiscard: () => got.discarded++,
    now: () => NOW,
    ...extra,
  };
  const t = await inkTerm(<Home {...props} />, { columns, rows });
  return { t, s, got, store };
}

/** The home view's mouse (`HomeProps.mouse`) and a report sent to it (a left press unless `over` says otherwise). */
function mice() {
  const fns = new Set<(m: MouseReport) => void>();
  return {
    mouse: (fn: (m: MouseReport) => void) => {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    async send(x: number, y: number, over: Partial<MouseReport> = {}) {
      const r: MouseReport = { code: 0, button: 0, x, y, release: false, motion: false, wheel: null, shift: false, alt: false, ctrl: false, encoding: "sgr", ...over };
      for (const f of fns) f(r);
      await new Promise((ok) => setTimeout(ok, 30));
    },
  };
}

const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", enter: "\r", tab: "\t", shiftTab: "\x1b[Z", esc: "\x1b", ctrlC: "\x03", ctrlO: "\x0f", ctrlT: "\x14", pgUp: "\x1b[5~", pgDn: "\x1b[6~" };
/** Esc is held a moment to tell it from a late OSC 11 reply (`LateOscFilter`). */
const escWait = () => new Promise((r) => setTimeout(r, 250));

describe("home view", () => {
  test("110×40: the mockup's layout, exactly rows − 1 tall, nothing wider than the terminal", async () => {
    const { t } = await home();
    const ls = t.text().split("\n");
    expect(ls).toHaveLength(39);
    fits(t.text(), 110);
    const at = (re: RegExp) => ls.findIndex((l) => re.test(l));
    // Top to bottom: header, hint, list, rule, chat, composer between rules.
    expect(at(/Gluon v1\.0\.0\s*$/)).toBe(1);
    expect(at(/1 awaiting input · 2 working · 1 done · 1 drafting/)).toBe(3);
    expect(ls[5]!.trim()).toBe(homeHint("choice"));
    // BUG-194: a column header over the list names the right-hand columns.
    expect(ls[7]).toMatch(/^ +context +cost +time {4}$/);
    expect(at(/^ {3}▾ Awaiting input/)).toBe(8);
    expect(at(/❯ 1\. claude code × sonnet 5\.5 × medium · recommended/)).toBeGreaterThan(at(/Drafting/));
    expect(ls[36]).toMatch(/^ {2}─+ {2}$/);
    expect(ls[37]).toMatch(/^ {3}› reply to the intake agent/);
    expect(ls[38]).toMatch(/^ {2}─+ {2}$/);
    // The drafting row took the session's name from the proposal.
    expect(t.text()).toMatch(/◌  resume-flag +agent not chosen yet/);
    // The ground is painted everywhere.
    for (const l of t.ansi().split("\n")) expect(l.startsWith(`\x1b[${BG(palette.ground)}`)).toBe(true);
    t.unmount();
  });

  test("first run: agents available, no sessions yet, the first line, and its own placeholder", async () => {
    const { t } = await home({ store: new SessionStore(), chat: false });
    const text = t.text();
    expect(text.split("\n")).toHaveLength(39);
    expect(text).toContain("no sessions yet");
    expect(text).toContain("Agents available");
    expect(text).not.toContain(HOME_HINT);
    expect(text.replace(/\s+/g, " ")).toContain(`◆ ${FIRST_LINE}`);
    expect(text).toContain("› describe the session you want");
    t.unmount();
  });

  test("never taller than rows − 1 nor wider than the terminal, and it follows a resize", async () => {
    const { t } = await home();
    for (const [c, r] of [[60, 24], [80, 30], [160, 50], [40, 12]] as const) {
      await t.resize(c, r);
      expect(t.text().split("\n")).toHaveLength(r - 1);
      fits(t.text(), c);
    }
    // An open choice stays in view on a small terminal.
    await t.resize(60, 24);
    expect(t.text()).toContain("❯ 1. claude code");
    t.unmount();
  });

  test("a store change redraws the list", async () => {
    const { t, store } = await home();
    const id = store.sessions.find((s) => s.name === "flaky-launcher-test")!.id;
    store.update(id, { activity: "Running 15 tests" });
    await t.waitFor("Running 15 tests");
    store.toggleDone(id);
    await t.waitFor("2 done");
    t.unmount();
  });

  test("agent choice: digits move, Tab cycles the model, Shift+Tab the effort, Enter starts it", async () => {
    const { t, s, got } = await home();
    await t.keys("2");
    expect(t.text()).toMatch(/❯ 2\. codex × gpt-6.1 sol × medium/);
    await t.keys(KEY.tab);
    expect(t.text()).toMatch(/❯ 2\. codex × gpt-6 astra × medium/);
    await t.keys(KEY.shiftTab);
    expect(t.text()).toMatch(/❯ 2\. codex × gpt-6 astra × high/);
    // The other options keep theirs.
    expect(t.text()).toMatch(/1\. claude code × sonnet 5\.5 × medium/);
    await t.keys(KEY.enter);
    expect(s.confirmed).toEqual([{ index: 1, override: { model: "gpt-6-astra", effort: "high" } }]);
    expect(got.started).toEqual([expect.objectContaining({ harness: "codex", model: "gpt-6-astra", effort: "high", name: "resume-flag" })]);
    t.unmount();
  });

  test("launch modes: ctrl+t cycles the proposal's mode build, explore, plan, build; every option shows it; Enter starts the session in it", async () => {
    const { t, s, got } = await home();
    expect(t.text()).not.toMatch(/· (explore|plan)/);
    await t.keys(KEY.ctrlT);
    expect(t.text()).toMatch(/1\. claude code × sonnet 5\.5 × medium · explore · recommended/);
    expect(t.text()).toMatch(/2\. codex × gpt-6.1 sol × medium · explore/);
    expect(t.text()).toMatch(/3\. opencode × deepseek flash × low · explore/);
    await t.keys(KEY.ctrlT);
    expect(t.text()).toMatch(/1\. claude code × sonnet 5\.5 × medium · plan · recommended/);
    await t.keys(KEY.ctrlT);
    expect(t.text()).not.toMatch(/· (explore|plan)/);
    await t.keys(KEY.ctrlT);
    await t.keys(KEY.down);
    await t.keys(KEY.enter);
    expect(s.confirmed).toEqual([{ index: 1, override: { mode: "explore" } }]);
    expect(got.started).toEqual([expect.objectContaining({ harness: "codex", mode: "explore" })]);
    t.unmount();
  });

  test("launch modes: a proposal's own mode shows and is not an override; ctrl+t from it goes on, and back to build is an override", async () => {
    const { t, s } = await home({ chat: false });
    s.set({ pending: { kind: "proposal", ...PROPOSAL, mode: "plan" } });
    await t.waitFor("2. codex × gpt-6.1 sol × medium · plan");
    await t.keys(KEY.enter);
    expect(s.confirmed).toEqual([{ index: 0, override: {} }]);
    t.unmount();
    const again = await home({ chat: false });
    again.s.set({ pending: { kind: "proposal", ...PROPOSAL, mode: "plan" } });
    await again.t.waitFor("· plan");
    await again.t.keys(KEY.ctrlT);
    expect(again.t.text()).not.toMatch(/· (explore|plan)/);
    await again.t.keys(KEY.enter);
    expect(again.s.confirmed).toEqual([{ index: 0, override: { mode: "build" } }]);
    again.t.unmount();
  });

  test("BUG-672/F08: ctrl+t on a Kimi Code proposal never lands on explore (plan, then build); a refusal says its advice first, so a narrow line never cuts it", async () => {
    const kimi = { harness: "kimi-code" as const, model: "kimi-k3" };
    const { t, s } = await home({ chat: false });
    s.set({ pending: { kind: "proposal", ...PROPOSAL, choices: [kimi] } });
    await t.waitFor("kimi code × kimi k3");
    await t.keys(KEY.ctrlT);
    expect(t.text()).toMatch(/1\. kimi code × kimi k3 .*· plan/);
    expect(t.text()).not.toMatch(/explore/);
    await t.keys(KEY.ctrlT);
    expect(t.text()).not.toMatch(/· (explore|plan)/);
    t.unmount();
    // Claude Code takes explore; moving to Kimi Code afterwards and pressing enter is refused (the session says so by returning nothing), advice first.
    const mixed = await home({ chat: false, columns: 100 });
    mixed.s.confirm = () => null;
    mixed.s.set({ pending: { kind: "proposal", ...PROPOSAL, choices: [PROPOSAL.choices[0]!, kimi] } });
    await mixed.t.waitFor("2. kimi code");
    await mixed.t.keys(KEY.ctrlT);
    expect(mixed.t.text()).toMatch(/1\. claude code .*· explore/);
    await mixed.t.keys(KEY.down);
    await mixed.t.keys(KEY.enter);
    const nudge = mixed.t.text().split("\n").find((l) => /Kimi Code can't start in explore mode|pick another agent/i.test(l));
    expect(nudge).toBeDefined();
    expect(nudge!.trim()).toMatch(/^pick another agent/i);
    mixed.t.unmount();
  });

  test("launch modes: ctrl+t does nothing with no agent choice open, and its hint is in the choice's keys", async () => {
    const { t, s } = await home({ chat: false });
    await t.keys(KEY.ctrlT);
    expect(t.text()).not.toMatch(/explore/);
    s.set({ pending: { kind: "proposal", ...PROPOSAL } });
    await t.waitFor("ctrl+t mode");
    t.unmount();
  });

  test("BUG-221/C: the choice's hint follows the highlighted agent's model (efforts are the model's: DeepSeek takes some), neither key on keep talking", async () => {
    const { t } = await home();
    const hint = () => t.text().split("\n").find((l) => /^ {6,}↑↓ choose · enter /.test(l))!;
    expect(hint()).toContain("tab model · shift+tab effort");
    // (A typed digit would make it `enter picks 3`: BUG-225.)
    await t.keys(KEY.down);
    await t.keys(KEY.down);
    expect(t.text()).toMatch(/❯ 3\. opencode/);
    expect(hint()).toContain("tab model · shift+tab effort");
    await t.keys(KEY.down);
    expect(t.text()).toMatch(/❯ 4\. keep talking/);
    expect(hint()).not.toMatch(/tab/);
    t.unmount();
  });

  test("BUG-225/home: the hint under the agent choice and the hint line agree on what Enter does — keep talking, text typed, an option", async () => {
    const { t } = await home({ columns: 80, rows: 40 });
    const top = () => t.text().split("\n")[5]!.trim();
    const under = () => t.text().split("\n").find((l) => /^ {6,}(↑↓|enter) /.test(l))!.trim();
    expect(top()).toBe("↑↓ choose · enter starts the session · esc cancels");
    expect(under().startsWith(top())).toBe(true);
    await t.keys(KEY.up);
    expect(t.text()).toMatch(/❯ 4\. keep talking/);
    expect(top()).toBe("↑↓ choose · enter keeps talking · esc cancels");
    expect(under()).toBe(top());
    await t.keys("x");
    expect(top()).toBe("enter sends · esc esc clears it");
    expect(under()).toBe(top());
    await t.keys("\x7f");
    await t.keys("2");
    expect(top()).toBe("enter picks 2 · esc esc clears it");
    expect(under()).toBe(top());
    t.unmount();
  });

  test("↑↓ wrap through the options; Enter on the recommendation starts it unchanged", async () => {
    const { t, s } = await home();
    await t.keys(KEY.up);
    expect(t.text()).toMatch(/❯ 4\. keep talking/);
    await t.keys(KEY.down);
    await t.keys(KEY.enter);
    expect(s.confirmed).toEqual([{ index: 0, override: {} }]);
    t.unmount();
  });

  test("BUG-197/C: the whole spec that will be sent shows above the agents; Ctrl+O folds it to one line, and back", async () => {
    const { t } = await home({ rows: 50 });
    const text = t.text();
    expect(text).toContain("restore the working tree");
    expect(text.indexOf("restore the working tree")).toBeLessThan(text.indexOf("❯ 1."));
    await t.keys(KEY.ctrlO);
    expect(t.text()).not.toContain("restore the working tree");
    expect(t.text()).toContain("spec: Add a --resume flag so a finished session can be reopened.  (ctrl+o to view)");
    await t.keys(KEY.ctrlO);
    expect(t.text()).toContain("restore the working tree");
    t.unmount();
  });

  test("BUG-197/C: a spec taller than the chat: the list goes, the box is cut above the agents, PgDn/PgUp scroll it, never the chat (BUG-218)", async () => {
    const { t, s } = await home({ rows: 24, columns: 80, chat: false });
    const spec = ["Line one of a long spec.", ...Array.from({ length: 30 }, (_, i) => `- point ${i + 2}`)].join("\n");
    s.set({ items: [{ id: 1, kind: "user", text: "the first message" }], pending: { kind: "proposal", ...PROPOSAL, spec } });
    await t.waitFor("4. keep talking");
    const ls = () => t.text().split("\n");
    const at = (needle: string) => ls().findIndex((l) => l.includes(needle));
    // Every row the frame has, the options and the hint on screen below the box's top.
    expect(ls()).toHaveLength(23);
    expect(t.text()).not.toContain("Awaiting input");
    expect(at("Line one of a long spec.")).toBeGreaterThan(at("╭─ spec — what the agent will get"));
    expect(at("╰─")).toBeLessThan(at("❯ 1."));
    expect(t.text()).toContain("4. keep talking");
    expect(t.text()).toContain("enter starts the session");
    expect(ls()[at("╰─")]).toMatch(/… \d+ more lines \(pgdn\) ─╯/);
    expect(t.text()).not.toContain("point 31");
    // PgDn to the end of the spec; PgUp back to its top, then on into the chat.
    for (let i = 0; i < 10; i++) await t.keys(KEY.pgDn);
    expect(t.text()).toContain("point 31");
    expect(t.text()).not.toContain("Line one");
    expect(ls()[at("╰─")]).toMatch(/\d+ lines above \(pgup\) ─╯/);
    expect(t.text()).toContain("4. keep talking");
    for (let i = 0; i < 10 && !t.text().includes("Line one"); i++) await t.keys(KEY.pgUp);
    expect(t.text()).toContain("Line one");
    expect(t.text()).not.toContain("the first message");
    // At the spec's top PgUp stays there: the options never leave the screen (BUG-218).
    await t.keys(KEY.pgUp);
    expect(t.text()).not.toContain("the first message");
    expect(t.text()).toContain("Line one");
    expect(t.text()).toContain("4. keep talking");
    // Folded, the list is back (its first row, and how many more: BUG-231).
    await t.keys(KEY.ctrlO);
    expect(t.text()).toContain("pty-return-flow");
    expect(t.text()).toContain("… 4 more");
    t.unmount();
  });

  test("BUG-199/C: PgUp with the whole spec box in the chat: no line of the box is left below the chat, on the composer or its rules", async () => {
    for (const [columns, rows] of [[100, 40], [120, 40], [110, 40], [100, 30], [80, 24], [140, 40]] as const) {
      const { t } = await home({ columns, rows });
      await t.waitFor("4. keep talking");
      const before = t.text().split("\n");
      const composer = before.findLastIndex((l) => l.trim().startsWith("› describe"));
      const below = (ls: string[]) => ls.slice(composer - 1);
      for (let i = 0; i < 3; i++) {
        await t.keys(KEY.pgUp);
        expect(below(t.text().split("\n"))).toEqual(below(before));
      }
      t.unmount();
    }
  });

  test("keep talking (or Esc) closes the options: ↑↓ then select sessions, Enter opens one, → the first tab; digits are text (BUG-233)", async () => {
    const { t, got, store } = await home();
    await t.keys("4");
    await t.keys(KEY.enter);
    expect(t.text()).not.toContain("❯");
    expect(t.text()).toContain("Tell the intake agent what to change");
    // The first row is selected; ↓ moves over the Working label to its first row.
    await t.keys(KEY.down);
    await t.keys(KEY.down);
    const bar = t.ansi().split("\n").find((l) => l.includes(BG(palette.selected)))!;
    expect(plain(bar)).toContain("flaky-launcher-test");
    await t.keys(KEY.enter);
    const order = tabs(store.sessions);
    const flaky = store.sessions.find((x) => x.name === "flaky-launcher-test")!.id;
    expect(got.opened).toEqual([flaky]);
    // → follows the tabs (launch order), not the grouped list.
    await t.keys(KEY.right);
    expect(got.opened).toEqual([flaky, order[0]!.id]);
    // A digit is typed.
    await t.keys("3");
    expect(got.opened).toEqual([flaky, order[0]!.id]);
    expect(t.text()).toContain("› 3");
    t.unmount();

    const again = await home();
    await again.t.keys(KEY.esc);
    await escWait();
    await again.t.keys("x");
    expect(again.t.text()).not.toContain("❯ 1.");
    again.t.unmount();
  });

  test("Enter on the drafting row doesn't open it: it is this chat", async () => {
    const { t, got, s } = await home();
    s.set({ pending: null });
    // The last line: the drafting row (↓ stops there).
    for (let i = 0; i < 10; i++) await t.keys(KEY.down);
    await t.keys(KEY.enter);
    expect(got.opened).toEqual([]);
    expect(t.text()).toContain("That's this chat");
    t.unmount();
  });

  test("BUG-162/E: on a short terminal the composer stays on screen; with a conversation going on the chat wins over the list", async () => {
    for (const rows of [10, 12, 16]) {
      const first = await home({ rows, store: new SessionStore(), chat: false });
      const ls = first.t.text().split("\n");
      expect(ls).toHaveLength(rows - 1);
      expect(ls.at(-2)).toMatch(/^ {3}› describe the session you want/);
      expect(ls.at(-1)).toMatch(/^ {2}─+/);
      first.t.unmount();
      const busy = await home({ rows });
      const text = busy.t.text();
      expect(text.split("\n").at(-2)).toMatch(/^ {3}› reply to the intake agent/);
      expect(text).toContain("keep talking");
      busy.t.unmount();
    }
  });

  test("BUG-181/E: a tiny terminal (10×5, 20×6) still shows the composer, nothing wider or taller than it", async () => {
    for (const [columns, rows] of [[10, 5], [20, 6], [12, 4]] as const) {
      for (const opts of [{ store: new SessionStore(), chat: false }, {}]) {
        const { t } = await home({ columns, rows, ...opts });
        const ls = t.text().split("\n");
        expect(ls).toHaveLength(rows - 1);
        fits(t.text(), columns);
        expect(t.text()).toContain("›");
        t.unmount();
      }
    }
  });

  test("BUG-159/C12: a reply starting with a digit is sent whole; a lone digit + Enter picks that option", async () => {
    const { t, s } = await home();
    await t.keys("2");
    await t.waitFor("❯ 2.");
    await t.keys(" more tests");
    await t.waitFor("❯ 4. keep talking");
    await t.keys(KEY.enter);
    expect(s.sent).toEqual(["2 more tests"]);
    expect(s.confirmed).toEqual([]);
    t.unmount();
    const again = await home();
    await again.t.keys("2");
    await again.t.keys(KEY.enter);
    expect(again.s.confirmed.map((c) => c.index)).toEqual([1]);
    expect(again.s.sent).toEqual([]);
    again.t.unmount();
  });

  test("BUG-193/home: Ctrl+D marks the selected run done and back (the hint says which); never with text in the composer, never the drafting row", async () => {
    const { t, s, store } = await home();
    s.set({ pending: null });
    const first = store.sessions.find((x) => x.name === "pty-return-flow")!;
    await t.waitFor("ctrl+d marks done · del ends it · ? for keys");
    await t.keys("\x04");
    expect(store.get(first.id)!.markedDone).toBe(true);
    await t.waitFor("2 done");
    // The selection stays on it, now under Done.
    await t.waitFor("ctrl+d unmarks done");
    await t.keys("\x04");
    expect(store.get(first.id)!.markedDone).toBe(false);
    await t.waitFor("1 awaiting input");
    // Text in the composer: Ctrl+D edits it.
    await t.keys("x");
    await t.keys("\x1b[D");
    await t.keys("\x04");
    expect(store.get(first.id)!.markedDone).toBe(false);
    expect(t.text()).not.toContain("› x");
    // The drafting row (the last line) is never done.
    for (let i = 0; i < 10; i++) await t.keys(KEY.down);
    await t.waitFor("del discards it");
    await t.keys("\x04");
    expect(store.draft()!.markedDone).toBeUndefined();
    t.unmount();
  });

  test("BUG-193/delete: Delete on any row — a run asks the caller to end it, the drafting row to discard the chat; a run whose agent is gone just goes", async () => {
    const store = mockupStore();
    // (A launch takes the draft over: a new one after it.)
    const gone = store.launched("gone-run", { harness: "codex", model: "gpt-6-sol" }, { alive: false, end: async () => {} }, NOW - 1);
    store.ensureDraft(NOW);
    const { t, s, got } = await home({ store });
    s.set({ pending: null });
    const flaky = store.sessions.find((x) => x.name === "flaky-launcher-test")!;
    // Awaiting's row, then the Working label and its first row: flaky-launcher-test.
    await t.keys(KEY.down);
    await t.keys(KEY.down);
    await t.keys("\x1b[3~");
    expect(got.ended).toEqual([flaky.id]);
    expect(store.get(flaky.id)).toBeDefined();
    // Working: config-docs-scan, gone-run; Done and its row; Drafting and its row.
    for (let i = 0; i < 6; i++) await t.keys(KEY.down);
    await t.waitFor("del discards it");
    await t.keys("\x1b[3~");
    expect(got.discarded).toBe(1);
    expect(store.draft()).toBeDefined();
    for (let i = 0; i < 4; i++) await t.keys(KEY.up);
    await t.keys("\x1b[3~");
    for (let i = 0; i < 40 && store.get(gone.id); i++) await new Promise((r) => setTimeout(r, 50));
    expect(store.get(gone.id)).toBeUndefined();
    expect(got.ended).toEqual([flaky.id]);
    // Never while the composer has text.
    await t.keys("x");
    await t.keys("\x1b[3~");
    expect(got.ended).toEqual([flaky.id]);
    t.unmount();
  });

  test("BUG-220/home: after Delete removes a row, or its session ends, the selection moves to the next row (the previous one after the last), not the first", async () => {
    const store = mockupStore();
    const gone = (name: string, ago: number) => store.launched(name, { harness: "codex", model: "gpt-6-sol" }, { alive: false, end: async () => {} }, NOW - ago);
    // (A launch takes the draft over: a new one after it.)
    gone("gone-one", 2);
    gone("gone-two", 1);
    store.ensureDraft(NOW);
    const { t, s } = await home({ store });
    s.set({ pending: null });
    const bar = () => plain(t.ansi().split("\n").find((l) => l.includes(BG(palette.selected))) ?? "");
    // Working: flaky-launcher-test, config-docs-scan, gone-one, gone-two. Delete on gone-one.
    for (let i = 0; i < 4; i++) await t.keys(KEY.down);
    expect(bar()).toContain("gone-one");
    await t.keys("\x1b[3~");
    await t.waitFor("gone-two");
    expect(t.text()).not.toContain("gone-one");
    expect(bar()).toContain("gone-two");
    // The last of its group: on to the next group's row.
    await t.keys("\x1b[3~");
    await new Promise((r) => setTimeout(r, 100));
    expect(t.text()).not.toContain("gone-two");
    expect(bar()).toContain("spawn-tty-explainer");
    // A session that ends (its row goes from the store): the next row.
    await t.keys(KEY.up);
    await t.keys(KEY.up);
    expect(bar()).toContain("config-docs-scan");
    store.remove(store.sessions.find((x) => x.name === "config-docs-scan")!.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(bar()).toContain("spawn-tty-explainer");
    // The last row (the draft) goes: the previous one.
    for (let i = 0; i < 4; i++) await t.keys(KEY.down);
    expect(bar()).toContain("resume-flag");
    store.dropDraft();
    await new Promise((r) => setTimeout(r, 100));
    expect(bar()).toContain("spawn-tty-explainer");
    t.unmount();
  });

  test("BUG-194/home: ↑↓ move over the group labels too, so the selection moves with one session; Enter on a label collapses and expands its group, on a row opens it", async () => {
    const store = new SessionStore();
    const run = store.launched("only-run", { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: true, end: async () => {} }, NOW - 60_000);
    const { t, got } = await home({ store, chat: false });
    const bar = () => plain(t.ansi().split("\n").find((l) => l.includes(BG(palette.selected))) ?? "");
    expect(bar()).toContain("only-run");
    await t.keys(KEY.up);
    expect(bar()).toMatch(/^ {3}▾ Working +$/);
    await t.waitFor("enter collapses the group");
    await t.keys(KEY.enter);
    await t.waitFor("▸ Working (1)");
    expect(t.text()).not.toContain("only-run");
    expect(bar()).toContain("▸ Working (1)");
    expect(got.opened).toEqual([]);
    // Nothing below a collapsed last group: ↓ stays on its label.
    await t.keys(KEY.down);
    await t.waitFor("enter expands the group");
    await t.keys(KEY.enter);
    await t.waitFor("only-run");
    await t.keys(KEY.down);
    expect(bar()).toContain("only-run");
    await t.keys(KEY.enter);
    expect(got.opened).toEqual([run.id]);
    t.unmount();
  });

  test("BUG-263/GLUON-45: back home from a session whose group is folded, the group opens and that session's row is selected — Ctrl+D right after acts on it, as on a render", async () => {
    const store = new SessionStore();
    const one = store.launched("one-run", { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: true, end: async () => {} }, NOW - 60_000);
    const two = store.launched("two-run", { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: true, end: async () => {} }, NOW - 30_000);
    let back: { id: number } | null = null;
    const { t } = await home({ store, chat: false, extra: { back: () => back } });
    const bar = () => plain(t.ansi().split("\n").find((l) => l.includes(BG(palette.selected))) ?? "");
    for (let i = 0; i < 3 && !/▾ Working/.test(bar()); i++) await t.keys(KEY.up);
    await t.keys(KEY.enter);
    await t.waitFor("▸ Working (2)");
    // Back from two-run (the home key's burst: the key comes before a render).
    back = { id: two.id };
    await t.keys("\x04");
    expect(store.get(two.id)!.markedDone).toBe(true);
    expect(store.get(one.id)!.markedDone).toBeFalsy();
    await t.waitFor("one-run");
    expect(bar()).toContain("two-run");
    // Folded again, back from one-run, shown by a render this time.
    for (let i = 0; i < 4 && !/▾ Working/.test(bar()); i++) await t.keys(KEY.up);
    await t.keys(KEY.enter);
    await t.waitFor("▸ Working (1)");
    back = { id: one.id };
    store.update(one.id, { activity: "Reading files" });
    await t.waitFor("one-run");
    expect(bar()).toContain("one-run");
    t.unmount();
  });

  test("BUG-168/home: the key list names the configured home key", async () => {
    const { t, s } = await home({ extra: { homeKey: "Ctrl+]" } });
    s.set({ pending: null });
    await t.keys("?");
    expect(t.text()).toMatch(/ctrl\+\] +then ←\/→ · again: home/);
    t.unmount();
  });

  test("BUG-216/hint: the hint names only the keys for what is selected, then `? for keys`; it fits 80 columns", async () => {
    for (const canOpen of [true, false]) {
      for (const about of ["run", "done", "draft", "group", "collapsed", "empty", "typing"] as const) {
        const hint = homeHint(about, canOpen);
        expect(Bun.stringWidth(hint)).toBeLessThanOrEqual(76);
        // With text typed `?` is text: no key list from there.
        if (about === "typing") expect(hint).toBe("enter sends · esc esc clears it");
        else expect(hint.endsWith(KEYS_HINT)).toBe(true);
      }
    }
    expect(homeHint("run")).toBe("enter opens it · ctrl+d marks done · del ends it · ? for keys");
    expect(homeHint("done", false)).toBe("ctrl+d unmarks done · del ends it · ? for keys");
    expect(homeHint("draft")).toBe("del discards it · ? for keys");
    expect(homeHint("collapsed")).toBe("enter expands the group · ? for keys");
    const store = new SessionStore();
    store.launched("only-run", { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: true, end: async () => {} }, NOW - 60_000);
    store.ensureDraft(NOW);
    const { t } = await home({ columns: 80, rows: 24, store, chat: false });
    const hint = () => t.text().split("\n")[5]!.trim();
    expect(hint()).toBe("enter opens it · ctrl+d marks done · del ends it · ? for keys");
    await t.keys(KEY.up);
    expect(hint()).toBe("enter collapses the group · ? for keys");
    for (let i = 0; i < 4; i++) await t.keys(KEY.down);
    expect(hint()).toBe("del discards it · ? for keys");
    await t.keys("x");
    expect(hint()).toBe("enter sends · esc esc clears it");
    t.unmount();
    // An empty list (first run): the agents available, under `? for keys`, the note still in view.
    const first = await home({ columns: 80, rows: 24, store: new SessionStore(), chat: false });
    expect(first.t.text().split("\n")[5]!.trim()).toBe(KEYS_HINT);
    expect(first.t.text()).toContain("Every session you start shows up here.");
    first.t.unmount();
  });

  test("BUG-216/keys: `?` on an empty composer shows every key (home key and quitting too) at 80×24; esc or ? closes it; typed after text, or with options open, `?` is text", async () => {
    const { t, s } = await home({ columns: 80, rows: 24 });
    // The agent choice is open: `?` answers it.
    await t.keys("?");
    expect(t.text()).toContain("› ?");
    expect(t.text()).not.toContain("? / esc close");
    await t.keys("\x7f");
    s.set({ pending: null });
    await t.keys("?");
    const text = t.text();
    expect(text.split("\n")).toHaveLength(23);
    fits(text, 80);
    for (const re of [/^ {3}Keys *$/m, /Sessions +Intake chat/, /ctrl\+\\ +then ←\/→ · again: home/, /ctrl\+c twice +quit/, /ctrl\+d +mark done, or not/, /shift\+tab +the agent's effort/, /ctrl\+j +new line/, /^ {3}\? \/ esc close/m]) expect(text).toMatch(re);
    // The composer stays.
    expect(text.split("\n").at(-2)).toMatch(/^ {3}› reply to the intake agent/);
    expect(text).not.toContain("Awaiting input");
    await t.keys(KEY.esc);
    await escWait();
    expect(t.text()).not.toContain("? / esc close");
    expect(t.text()).toContain("Awaiting input");
    await t.keys("?");
    expect(t.text()).toContain("? / esc close");
    await t.keys("?");
    expect(t.text()).not.toContain("? / esc close");
    // Any other key closes it and does what it does: here, types.
    await t.keys("?");
    await t.keys("a?");
    expect(t.text()).not.toContain("? / esc close");
    expect(t.text()).toContain("› a?");
    t.unmount();
    // Short of rows the list is cut, its closing line kept.
    const short = await home({ columns: 80, rows: 12 });
    short.s.set({ pending: null });
    await short.t.keys("?");
    expect(short.t.text().split("\n")).toHaveLength(11);
    expect(short.t.text()).toContain("? / esc close");
    expect(short.t.text().split("\n").at(-2)).toMatch(/› reply to the intake agent/);
    short.t.unmount();
    // One column when two don't fit.
    const narrow = await home({ columns: 50, rows: 40 });
    narrow.s.set({ pending: null });
    await narrow.t.keys("?");
    fits(narrow.t.text(), 50);
    expect(narrow.t.text()).not.toMatch(/Sessions +Intake chat/);
    expect(narrow.t.text()).toContain("Intake chat");
    narrow.t.unmount();
  });

  test("BUG-229/keys: the key list has every key — a session's too (the home key then ←/→, ←/→, clicks, scrolling back); cut, it says so and PgDn shows the rest; at 60 columns the groups stack", async () => {
    const all = [/↑↓ +select a row or group/, /ctrl\+c twice +quit/, /ctrl\+\\ +then ←\/→ · again: home/, /←\/→ +switch, nothing typed/, /click +a tab, ◆ gluon, ‹ ›/, /shift\+pgup +scroll, wheel too/, /ctrl\+o +fold the spec/, /ctrl\+j +new line/, /Intake chat/];
    for (const [columns, rows] of [[120, 40], [80, 24], [60, 20]] as const) {
      // Gluon captures the mouse (`handoff.mouse_capture`, the default): the clicks and the wheel are named.
      const { t, s } = await home({ columns, rows, extra: { mouse: mice().mouse } });
      s.set({ pending: null });
      await t.keys("?");
      fits(t.text(), columns);
      expect(t.text().split("\n")).toHaveLength(rows - 1);
      // Every key, on screen at once or after PgDn; a cut says what is left out (the wheel scrolls it too: BUG-276).
      const seen = new Set<string>();
      for (let i = 0; i < 6; i++) {
        for (const re of all) if (re.test(t.text())) seen.add(String(re));
        if (!t.text().includes("more")) break;
        expect(t.text()).toMatch(/\? \/ esc close · pgup pgdn \/ wheel (↑ \d+ above · )?↓ \d+ more/);
        await t.keys(KEY.pgDn);
      }
      expect([...seen].sort()).toEqual(all.map(String).sort());
      if (columns === 120) expect(t.text()).toMatch(/Sessions +In a session +Intake chat/);
      if (columns === 60) expect(t.text()).not.toMatch(/Sessions +\S/);
      // PgUp goes back; the composer stays.
      await t.keys(KEY.pgUp);
      expect(t.text().split("\n").at(-2)).toMatch(/› /);
      expect(t.text()).toContain("? / esc close");
      t.unmount();
    }
  });

  test("BUG-275/GLUON-59: with `handoff.mouse_capture: false` the key list names no click and no wheel — at home or in a session — and its closing line only pgup pgdn; with it, both (BUG-276)", async () => {
    for (const mouse of [false, true]) {
      const { t, s } = await home({ columns: 80, rows: 24, extra: mouse ? { mouse: mice().mouse } : {} });
      s.set({ pending: null });
      await t.keys("?");
      let all = "";
      let cut = false;
      for (let i = 0; i < 6; i++) {
        all += `${t.text()}\n`;
        if (!t.text().includes("more")) break;
        cut = true;
        expect(t.text()).toContain(mouse ? "pgup pgdn / wheel ↓" : "pgup pgdn ↓");
        await t.keys(KEY.pgDn);
      }
      expect(cut).toBe(true);
      expect(all).toContain("shift+pgup");
      expect(/\bclick\b/.test(all)).toBe(mouse);
      expect(all.includes("wheel")).toBe(mouse);
      expect(all.includes("select and copy text")).toBe(mouse);
      t.unmount();
    }
  });

  test("BUG-217/C: while the agent choice or a question is open the list's selection isn't highlighted and the hint shows its keys; with text typed, `enter sends` @full", async () => {
    const { t, s } = await home({ columns: 80, rows: 40 });
    const hint = () => t.text().split("\n")[5]!.trim();
    const rowBar = () => t.ansi().split("\n").find((l) => l.includes("pty-return-flow"))!;
    const option = () => t.ansi().split("\n").find((l) => l.includes("❯ 1."))!;
    expect(hint()).toBe("↑↓ choose · enter starts the session · esc cancels");
    // The selected row on no bar (BUG-247); the option alone on the selected one.
    expect(rowBar()).not.toContain(BG(palette.bar));
    expect(rowBar()).not.toContain(BG(palette.selected));
    expect(option()).toContain(BG(palette.selected));
    await t.keys("2");
    expect(hint()).toBe("enter picks 2 · esc esc clears it");
    await t.keys(" tests");
    expect(hint()).toBe("enter sends · esc esc clears it");
    for (let i = 0; i < 8; i++) await t.keys("\x7f");
    s.set({ pending: { kind: "question", question: { question: "Which one?", options: [{ label: "this" }, { label: "that" }] } } });
    await t.waitFor("Which one?");
    expect(hint()).toBe("↑↓ choose · enter answers · esc dismisses");
    expect(rowBar()).not.toContain(BG(palette.selected));
    // Closed: the list's keys and its selection again.
    await t.keys(KEY.esc);
    await escWait();
    expect(hint()).toBe(HOME_HINT);
    expect(rowBar()).toContain(BG(palette.selected));
    // The intake agent at work: Enter doesn't send.
    s.set({ pending: null, workingSince: Date.now(), status: "Exploring" });
    await t.keys("more");
    expect(hint()).toBe("still working · esc interrupts");
    t.unmount();
  });

  test("issue-55/tab: Tab on a question's option puts it in the composer to add your words, and enter sends the whole; with text typed or with Shift it does nothing", async () => {
    const { t, s } = await home({ columns: 80, rows: 40 });
    s.set({ pending: { kind: "question", question: { question: "Which one?", options: [{ label: "this" }, { label: "that" }] } } });
    await t.waitFor("Which one?");
    await t.keys(KEY.down);
    await t.keys(KEY.tab);
    await t.waitFor("enter sends");
    expect(t.text()).toContain("that");
    await t.keys("but safely");
    await t.keys(KEY.enter);
    expect(s.sent).toEqual(["that but safely"]);
    // Typed text stays as it is; Shift+Tab is the agents' effort, not this.
    s.set({ pending: { kind: "question", question: { question: "Which one?", options: [{ label: "this" }, { label: "that" }] } } });
    await t.waitFor("Which one?");
    await t.keys("x");
    await t.keys(KEY.tab);
    await t.keys(KEY.enter);
    expect(s.sent.at(-1)).toBe("x");
    s.set({ pending: { kind: "question", question: { question: "Which one?", options: [{ label: "this" }, { label: "that" }] } } });
    await t.waitFor("Which one?");
    await t.keys(KEY.shiftTab);
    await t.keys(KEY.enter);
    expect(s.sent.at(-1)).toBe("this"); // Enter picked the option as it is: nothing was put in the composer
    t.unmount();
  });

  test("issue-55/step: one of several questions asked together says which: `(2/3) …`, in the open question and its row count", () => {
    const q = { question: "Which one?", options: [{ label: "this" }, { label: "that" }], step: { n: 2, of: 3 } };
    expect(plain(at(80, <QuestionBlock question={q} selected={0} palette={palette} theme={theme} />))).toContain("(2/3) Which one?");
    expect(plain(at(80, <QuestionBlock question={{ ...q, step: undefined }} selected={0} palette={palette} theme={theme} />))).not.toContain("(2/3)");
    expect(openBlockRows({ kind: "question", question: q }, [], 10)).toBeGreaterThan(openBlockRows({ kind: "question", question: { ...q, step: undefined } }, [], 10));
  });

  test("BUG-222/home: the drafting row waits for your pick while the agent choice is open, talks it through otherwise; every session ended: `no sessions running`", async () => {
    const { t, s, store } = await home();
    await t.waitFor("Waiting for your pick");
    expect(t.text()).toMatch(/◌  resume-flag +agent not chosen yet +Waiting for your pick/);
    s.set({ pending: null, workingSince: Date.now(), status: "Thinking" });
    await t.waitFor("Talking it through");
    // Every run ended (their rows go) and the draft discarded: the header says none are running.
    for (const x of [...store.sessions]) store.remove(x.id);
    await t.waitFor("no sessions running");
    expect(t.text()).not.toContain("no sessions yet");
    t.unmount();
  });

  test("BUG-224/home: while the home view's own question is up the hint names its keys (end, discard, quit) and the composer shows no cursor", async () => {
    const store = new SessionStore();
    store.launched("only-run", { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: true, end: async () => {} }, NOW - 60_000);
    const composer = (t: Awaited<ReturnType<typeof home>>["t"]) => t.ansi().split("\n").find((l) => plain(l).includes("› describe"))!;
    const free = await home({ columns: 80, rows: 24, store, chat: false });
    expect(composer(free.t)).toContain("\x1b[7m");
    free.t.unmount();
    for (const [asking, hint] of [["end", "enter ends it · esc keeps it"], ["discard", "enter discards it · esc keeps it"], ["quit", "enter quits · esc stays"], ["resume", "enter yes · esc no"], ["again", "enter starts it again · esc drops it · ctrl+c keeps it"]] as const) {
      const { t } = await home({ columns: 80, rows: 24, store, chat: false, extra: { asking } });
      expect(t.text().split("\n")[5]!.trim()).toBe(hint);
      expect(composer(t)).not.toContain("\x1b[7m");
      t.unmount();
    }
  });

  test("BUG-299/resume: the home view says whether the composer holds text, as it changes (Gluon's own questions wait for it to be empty)", async () => {
    const heard: boolean[] = [];
    const { t } = await home({ chat: false, extra: { onDraft: (typed) => void heard.push(typed) } });
    expect(heard).toEqual([false]);
    await t.keys("hi");
    expect(heard).toEqual([false, true]);
    await t.keys("\x7f\x7f");
    expect(heard).toEqual([false, true, false]);
    t.unmount();
  });

  test("BUG-226/home: the drafting row waits for your pick only while the agent choice is open: after Esc or keep talking it talks it through", async () => {
    for (const close of [[KEY.esc], [KEY.up, KEY.enter]]) {
      const { t } = await home();
      await t.waitFor("Waiting for your pick");
      for (const k of close) await t.keys(k);
      await escWait();
      await t.waitFor("Talking it through");
      expect(t.text()).not.toContain("Waiting for your pick");
      t.unmount();
    }
  });

  test("BUG-239/NF-3: while the intake agent's question waits for the user's answer the drafting row says so (amber, as the pick), its options shown or not; at work it talks it through", async () => {
    const { t, s } = await home();
    s.set({ pending: { kind: "question", question: { question: "Which one?", options: [{ label: "this" }, { label: "that" }] } } });
    await t.waitFor("Waiting for your answer");
    expect(t.text()).toMatch(/◌  resume-flag +agent not chosen yet +Waiting for your answer/);
    const row = t.ansi().split("\n").find((l) => plain(l).includes("Waiting for your answer"))!;
    const before = row.slice(0, row.indexOf("Waiting for your answer"));
    expect(before.slice(before.lastIndexOf("\x1b[38;"))).toStartWith(`\x1b[${FG(palette.amber)}`);
    expect(t.text()).not.toContain("Talking it through");
    // Esc hides the options; a typed reply still answers the question.
    await t.keys(KEY.esc);
    await escWait();
    expect(t.text()).toContain("Waiting for your answer");
    s.set({ pending: null, workingSince: Date.now(), status: "Thinking" });
    await t.waitFor("Talking it through");
    t.unmount();
  });

  test("BUG-227/home: while a chat is being drafted the composer replies to the intake agent (keep talking, Enter on the draft row); with none, it describes another session", async () => {
    const composer = (t: Awaited<ReturnType<typeof home>>["t"]) => t.text().split("\n").at(-2)!.trim();
    const { t } = await home({ columns: 80, rows: 30 });
    await t.keys(KEY.up);
    await t.keys(KEY.enter);
    await t.waitFor("Tell the intake agent what to change");
    expect(composer(t)).toBe("› reply to the intake agent");
    t.unmount();
    const store = new SessionStore();
    store.launched("only-run", { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: true, end: async () => {} }, NOW - 60_000);
    const quiet = await home({ columns: 80, rows: 30, store, chat: false });
    expect(composer(quiet.t)).toBe("› describe another session");
    store.ensureDraft(NOW);
    await quiet.t.waitFor("Drafting");
    for (let i = 0; i < 4; i++) await quiet.t.keys(KEY.down);
    await quiet.t.keys(KEY.enter);
    await quiet.t.waitFor("That's this chat: type below");
    expect(composer(quiet.t)).toBe("› reply to the intake agent");
    quiet.t.unmount();
  });

  test("BUG-228/home: `? for keys` stays — at 60 columns other keys go first, at 20 rows and fewer the hint keeps a row the list gives up", async () => {
    expect(fitHint(homeHint("run"), 56)).toBe("enter opens it · ctrl+d marks done · ? for keys");
    expect(fitHint(homeHint("run"), 30)).toBe("enter opens it · ? for keys");
    expect(fitHint(homeHint("run"), 12)).toBe(KEYS_HINT);
    expect(fitHint(homeHint("question"), 34)).toBe("enter answers · esc dismisses");
    expect(fitHint(homeHint("run"), 80)).toBe(homeHint("run"));
    const store = new SessionStore();
    store.launched("Gluon-fix-add-bug", { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: true, end: async () => {} }, NOW - 60_000);
    for (const [columns, rows] of [[60, 20], [100, 20], [80, 14], [60, 24]] as const) {
      const { t } = await home({ columns, rows, store, chat: false });
      const ls = t.text().split("\n");
      expect(ls).toHaveLength(rows - 1);
      fits(t.text(), columns);
      const hint = ls.find((l) => l.includes(KEYS_HINT));
      expect(`${columns}x${rows}: ${hint?.trim()}`).toMatch(/: enter opens it · .*\? for keys$/);
      expect(t.text()).toContain("Gluon-fix-add-bug");
      expect(ls.at(-2)).toMatch(/› describe another session/);
      t.unmount();
    }
  });

  test("BUG-233/home: digits on an empty composer are text, never a tab — `2 bugs to fix` types and sends whole", async () => {
    const store = new SessionStore();
    for (const n of ["one", "two", "three"]) store.launched(n, { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: true, end: async () => {} }, NOW - 60_000);
    const { t, s, got } = await home({ columns: 80, rows: 30, store, chat: false });
    await t.keys("2");
    expect(got.opened).toEqual([]);
    expect(t.text()).toContain("› 2");
    await t.keys(" bugs to fix");
    await t.keys(KEY.enter);
    expect(s.sent).toEqual(["2 bugs to fix"]);
    expect(got.opened).toEqual([]);
    // Opening one stays: → the first tab, Enter on its row.
    await t.keys(KEY.right);
    expect(got.opened).toEqual([store.sessions[0]!.id]);
    t.unmount();
  });

  test("BUG-180/no-PTY: an ended session can't be opened again — the hint has no enter, Enter and → say why", async () => {
    const store = new SessionStore();
    store.launched("direct-run", { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: false, end: async () => {} }, NOW - 60_000);
    const { t, got } = await home({ store, chat: false, extra: { canOpen: false } });
    expect(t.text()).toContain("ctrl+d marks done · del ends it · ? for keys");
    expect(t.text()).not.toContain("enter opens it");
    await t.keys("?");
    expect(t.text()).not.toContain("open tab N");
    await t.keys(KEY.esc);
    await escWait();
    await t.keys(KEY.enter);
    await t.waitFor("No pseudo-terminal here");
    await t.keys(KEY.right);
    expect(got.opened).toEqual([]);
    t.unmount();
  });

  test("typing goes to the composer; Enter sends it and the drafting row appears", async () => {
    const store = new SessionStore();
    const { t, s } = await home({ store, chat: false });
    await t.keys("fix the flaky test");
    expect(t.text()).toContain("› fix the flaky test");
    await t.keys(KEY.enter);
    expect(s.sent).toEqual(["fix the flaky test"]);
    await t.waitFor("Drafting");
    expect(t.text()).toContain("› reply to the intake agent");
    t.unmount();
  });

  test("BUG-266/GLUON-48: the composer wraps at words, as Codex's does — a word longer than a row alone is broken; the cursor and the frame's height stay exact", async () => {
    const rows = 24;
    const draft = "fix the flaky test in the parser module so that it passes on every run of the suite";
    const { t } = await home({ columns: 40, rows, store: new SessionStore(), chat: false });
    await t.keys(draft);
    // The composer's rows: between its two rules, the side padding and ` › ` / `   ` off.
    const composer = () => {
      const ls = t.text().split("\n");
      const top = ls.findLastIndex((l, i) => i < ls.length - 1 && /^ +─+ *$/.test(l));
      return { all: ls, shown: ls.slice(top + 1, -1).map((l) => l.slice(5).trimEnd()) };
    };
    const { all, shown } = composer();
    expect(all).toHaveLength(rows - 1);
    expect(shown.length).toBeGreaterThan(1);
    // Every row ends at a word's end and the next starts a word: the words, in order, none split.
    expect(shown.join(" ").split(/ +/)).toEqual(draft.split(" "));
    for (const r of shown) expect(Bun.stringWidth(r)).toBeLessThanOrEqual(40 - 5);
    // The cursor (inverse) sits after the last word; three ← put it on the `i` of `suite`.
    const inverse = () => /\x1b\[7m(.)/.exec(t.ansi().split("\n").slice(-shown.length - 2).join("\n"))?.[1];
    expect(inverse()).toBe(" ");
    for (let i = 0; i < 3; i++) await t.keys("\x1b[D");
    expect(inverse()).toBe("i");
    // Edits land where the cursor is, by grapheme: the rows re-wrap around the new word.
    await t.keys("👍🏽");
    expect(composer().shown.join(" ")).toContain("of the su👍🏽ite");
    t.unmount();
    // A word longer than a row is cut where the row ends; nothing is lost.
    const long = await home({ columns: 30, rows, store: new SessionStore(), chat: false });
    const word = "x".repeat(60);
    await long.t.keys(`see ${word}`);
    const ls = long.t.text().split("\n");
    expect(ls).toHaveLength(rows - 1);
    const top = ls.findLastIndex((l, i) => i < ls.length - 1 && /^ +─+ *$/.test(l));
    const got = ls.slice(top + 1, -1).map((l) => l.slice(5).trimEnd());
    expect(got[0]).toBe("see");
    expect(got.slice(1).join("")).toBe(word);
    long.t.unmount();
  });

  test("BUG-218/C: at the agent choice PgUp/PgDn scroll only the spec: the whole box in view, they do nothing; after Esc they scroll the chat", async () => {
    for (const [columns, rows] of [[110, 40], [100, 30]] as const) {
      const { t } = await home({ columns, rows });
      await t.waitFor("4. keep talking");
      const before = t.text();
      for (const k of [KEY.pgUp, KEY.pgUp, KEY.pgDn, KEY.pgUp]) {
        await t.keys(k);
        expect(t.text()).toBe(before);
      }
      // Esc: the choice closes, PgUp scrolls the chat (when it is taller than its rows).
      await t.keys(KEY.esc);
      await escWait();
      const closed = t.text();
      await t.keys(KEY.pgUp);
      if (rows === 30) expect(t.text()).not.toBe(closed);
      expect(t.text().split("\n").at(-2)).toMatch(/› reply to the intake agent/);
      t.unmount();
    }
  });

  test("BUG-269/GLUON-52: a click on a row selects it, on the selected one opens it as Enter does; on a group label it folds the group; anywhere else, or not a left press, nothing; nothing is typed", async () => {
    const store = new SessionStore();
    const one = store.launched("one-run", { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: true, end: async () => {} }, NOW - 60_000);
    const two = store.launched("two-run", { harness: "claude-code", model: "sonnet", effort: "low" }, { alive: true, end: async () => {} }, NOW - 30_000);
    const m = mice();
    const { t, got } = await home({ store, chat: false, extra: { mouse: m.mouse } });
    const bar = () => plain(t.ansi().split("\n").find((l) => l.includes(BG(palette.selected))) ?? "");
    const y = (text: string) => t.text().split("\n").findIndex((l) => l.includes(text)) + 1;
    const [selected, other] = bar().includes("one-run") ? [one, two] : [two, one];
    // Not a left press (a release, a drag, the right button), or left of the list: nothing.
    for (const r of [{ release: true }, { motion: true }, { button: 2 }]) await m.send(10, y(other.name), r);
    await m.send(1, y(other.name));
    expect(bar()).toContain(selected.name);
    // A click selects; on the selected row it opens.
    await m.send(10, y(other.name));
    expect(bar()).toContain(other.name);
    expect(got.opened).toEqual([]);
    await m.send(30, y(other.name));
    expect(got.opened).toEqual([other.id]);
    // On a group label: folded, then unfolded, never opened.
    await m.send(6, y("▾ Working"));
    await t.waitFor("▸ Working (2)");
    expect(t.text()).not.toContain("one-run");
    // A click of its own, not a double-click's second (that does nothing more: BUG-274).
    await Bun.sleep(DOUBLE_CLICK_MS + 50);
    await m.send(6, y("▸ Working"));
    await t.waitFor("one-run");
    // The header, the hint, the composer: nothing, and nothing typed.
    for (const text of ["Gluon v", "? for keys", "› describe another session"]) await m.send(8, y(text));
    expect(t.text()).toContain("› describe another session");
    expect(got.opened).toEqual([other.id]);
    t.unmount();
  });

  test("BUG-269/GLUON-52: while the agent choice is open (its selection not shown) a click selects; two within DOUBLE_CLICK_MS open it", async () => {
    const m = mice();
    const { t, got, store } = await home({ extra: { mouse: m.mouse } });
    const y = (text: string) => t.text().split("\n").findIndex((l) => l.includes(text)) + 1;
    const flaky = store.sessions.find((s) => s.name === "flaky-launcher-test")!;
    await m.send(10, y("flaky-launcher-test"));
    expect(got.opened).toEqual([]);
    await m.send(10, y("flaky-launcher-test"));
    expect(got.opened).toEqual([flaky.id]);
    t.unmount();
  });

  test("BUG-277/GLUON-60: a click on an option of the intake agent's question or agent choice picks it as its digit and Enter do; on `keep talking` it closes the choice; anywhere else, nothing", async () => {
    const m = mice();
    const { t, s, got } = await home({ columns: 100, rows: 40, extra: { mouse: m.mouse } });
    const y = (text: string) => t.text().split("\n").findIndex((l) => l.includes(text)) + 1;
    // The agent choice: the second agent.
    const second = t.text().split("\n").find((l) => l.includes("2."))!;
    await m.send(second.indexOf("2.") + 3, y(second.trim().slice(0, 12)));
    expect(s.confirmed.map((c) => c.index)).toEqual([1]);
    expect(got.started.length).toBe(1);
    // A question: the second option is sent as the answer; the hint line's row picks nothing.
    s.set({ pending: { kind: "question", question: { question: "Which one?", options: [{ label: "this" }, { label: "that" }] } } });
    await t.waitFor("Which one?");
    await m.send(8, y("enter answers"));
    expect(s.sent).toEqual([]);
    await m.send(12, y("that"));
    expect(s.sent).toEqual(["that"]);
    t.unmount();
  });

  test("BUG-271/GLUON-55: on a list too long for its rows (`… N more`) a click never scrolls it: a double-click on a row opens that row; ↓ past the window moves it one line", async () => {
    const store = new SessionStore();
    const handle = { alive: true, end: async () => {} };
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    for (const [i, n] of names.entries()) store.update(store.launched(`${n}-run`, { harness: "claude-code", model: "sonnet", effort: "low" }, handle, NOW - (i + 1) * 60_000).id, { state: "awaiting" });
    const m = mice();
    const { t, got } = await home({ columns: 100, rows: 22, store, chat: false, extra: { mouse: m.mouse } });
    const list = () => t.text().split("\n").filter((l) => /-run |▾ |… \d+ more/.test(l));
    const y = (text: string) => t.text().split("\n").findIndex((l) => l.includes(text)) + 1;
    const bar = () => plain(t.ansi().split("\n").find((l) => l.includes(BG(palette.selected))) ?? "");
    const run = (l: string) => /\w+-run/.exec(l)?.[0] ?? "";
    const shown = list();
    expect(shown.at(-1)).toMatch(/… \d+ more/);
    expect(shown.length).toBeGreaterThanOrEqual(5);
    // A row two lines below the selected one: the first click selects it, the list stays put.
    const target = shown.findIndex((l) => run(l) && bar().includes(run(l))) + 2;
    const name = run(shown[target]!);
    expect(name).not.toBe("");
    const at = y(name);
    await m.send(10, at);
    expect(bar()).toContain(name);
    expect(list()).toEqual(shown);
    expect(got.opened).toEqual([]);
    // The second click of the double-click, on the same cell: that row opens.
    await m.send(10, at);
    expect(got.opened).toEqual([store.sessions.find((s) => s.name === name)!.id]);
    // ↓ to the window's last row and once more: the list moves one line, not the selection to its top.
    const last = run(list().at(-2)!);
    while (!bar().includes(last)) await t.keys(KEY.down);
    expect(list()).toEqual(shown);
    await t.keys(KEY.down);
    const moved = list();
    expect(moved.at(-2)).not.toContain(last);
    expect(moved.at(-3)).toContain(last);
    expect(bar()).toContain(run(moved.at(-2)!));
    t.unmount();
  });

  test("BUG-274/GLUON-58: a double-click on a group label folds it once (its second click does nothing more); a click of its own unfolds it", async () => {
    const store = new SessionStore();
    const handle = { alive: true, end: async () => {} };
    for (const n of ["one-run", "two-run"]) store.launched(n, { harness: "claude-code", model: "sonnet", effort: "low" }, handle, NOW - 60_000);
    const m = mice();
    const { t, got } = await home({ store, chat: false, extra: { mouse: m.mouse } });
    const y = (text: string) => t.text().split("\n").findIndex((l) => l.includes(text)) + 1;
    const at = y("▾ Working");
    await m.send(6, at);
    await m.send(6, at);
    await t.waitFor("▸ Working (2)");
    await Bun.sleep(100);
    expect(t.text()).toContain("▸ Working (2)");
    expect(t.text()).not.toContain("one-run");
    // Folded, the label's row may now hold another line: the second click was on the label still.
    await Bun.sleep(DOUBLE_CLICK_MS + 50);
    await m.send(6, at);
    await t.waitFor("one-run");
    expect(t.text()).toContain("▾ Working");
    expect(got.opened).toEqual([]);
    t.unmount();
  });

  test("BUG-269/GLUON-52: the wheel scrolls the chat back to its first line and forward again, as PgUp/PgDn do", async () => {
    const m = mice();
    // The agent choice closed (open, the wheel scrolls its spec only: BUG-218).
    const { t } = await home({ columns: 100, rows: 30, extra: { mouse: m.mouse } });
    await t.keys(KEY.esc);
    await escWait();
    const first = "add a resume flag so a finished session can be reopened";
    expect(t.text()).not.toContain(first);
    for (let i = 0; i < 30 && !t.text().includes(first); i++) await m.send(10, 20, { wheel: "up", button: 4 });
    expect(t.text()).toContain(first);
    for (let i = 0; i < 30 && t.text().includes(first); i++) await m.send(10, 20, { wheel: "down", button: 5 });
    expect(t.text()).not.toContain(first);
    t.unmount();
  });

  test("PgUp scrolls the chat back to its first line; PgDn returns", async () => {
    // The agent choice closed (open, PgUp scrolls its spec only: BUG-218).
    const { t } = await home({ columns: 100, rows: 30 });
    await t.keys(KEY.esc);
    await escWait();
    const first = "add a resume flag so a finished session can be reopened";
    expect(t.text()).not.toContain(first);
    for (let i = 0; i < 10 && !t.text().includes(first); i++) await t.keys(KEY.pgUp);
    expect(t.text()).toContain(first);
    for (let i = 0; i < 10 && t.text().includes(first); i++) await t.keys(KEY.pgDn);
    expect(t.text()).not.toContain(first);
    t.unmount();
  });

  test("Ctrl+C clears the draft, then twice quits", async () => {
    const { t, got } = await home();
    await t.keys("abc");
    await t.keys(KEY.ctrlC);
    expect(t.text()).toContain("› reply to the intake agent");
    expect(got.quit).toBe(0);
    await t.keys(KEY.ctrlC);
    expect(t.text()).toContain("Press ctrl+c again to quit");
    await t.keys(KEY.ctrlC);
    expect(got.quit).toBe(1);
    t.unmount();
  });

  test("BUG-247/V-03: while a question or the agent choice is open, one thing is highlighted — the option Enter acts on, not the list's row too", async () => {
    /** Rows on a highlight (the selected or the bar colour) that aren't the user's own messages (`›`), in blocks. */
    const blocks = (ansi: string) => {
      const rows = ansi.split("\n").flatMap((l, y) => ((l.includes(BG(palette.selected)) || l.includes(BG(palette.bar))) && !/^\s*›/.test(plain(l)) ? [y] : []));
      return rows.filter((y, i) => i === 0 || rows[i - 1] !== y - 1).length;
    };
    const { t, s } = await home({ columns: 80, rows: 40 });
    await t.waitFor("4. keep talking");
    expect(blocks(t.ansi())).toBe(1);
    s.set({ pending: { kind: "question", question: { question: "Which one?", options: [{ label: "this" }, { label: "that" }] } } });
    await t.waitFor("Which one?");
    expect(blocks(t.ansi())).toBe(1);
    // Closed: the list's row is the one highlighted again.
    await t.keys(KEY.esc);
    await escWait();
    expect(blocks(t.ansi())).toBe(1);
    expect(plain(t.ansi().split("\n").find((l) => l.includes(BG(palette.selected)))!)).toContain("pty-return-flow");
    t.unmount();
  });

  test("BUG-246/V-02: the spec box's side borders are on the ground, as every other cell of the home view", async () => {
    const { t } = await home({ columns: 110, rows: 40 });
    await t.waitFor("4. keep talking");
    const screen = createScreen(110, 40);
    await screen.write(t.ansi().replaceAll("\n", "\r\n"));
    const ground = parseInt(palette.ground.slice(1), 16);
    let sides = 0;
    for (let y = 0; y < 39; y++) {
      const cells = screen.cells(y);
      for (const c of cells.filter((c) => c.char === "│")) {
        sides++;
        expect(c.bgMode).toBe("rgb");
        expect(c.bg).toBe(ground);
      }
    }
    expect(sides).toBeGreaterThan(4);
    screen.dispose();
    t.unmount();
  });

  test("BUG-249/NF-4: at 80×24 the folded agent choice leaves the list its column header and group label: the blank rows around the list go first", async () => {
    const store = new SessionStore();
    store.ensureDraft(NOW);
    const { t } = await home({ columns: 80, rows: 24, store });
    await t.waitFor("4. keep talking");
    await t.keys(KEY.ctrlO);
    await t.waitFor("ctrl+o to view");
    const ls = t.text().split("\n");
    expect(ls).toHaveLength(23);
    const head = ls.findIndex((l) => /^ +context +cost +time {4}$/.test(l));
    expect(head).toBeGreaterThan(0);
    expect(ls[head + 1]).toMatch(/^ {3}▾ Drafting/);
    expect(ls[head + 2]).toMatch(/^ {3}◌  resume-flag/);
    // The options are all there, the composer at the bottom.
    expect(t.text()).toContain("4. keep talking");
    expect(ls[21]).toMatch(/^ {3}› reply to the intake agent/);
    t.unmount();
  });

  test("BUG-251/home: two groups at 80×24 with a question open: every row shows (no `… 1 more`), the gaps around the list going first", async () => {
    const store = new SessionStore();
    const run = store.launched("Gluon-fix-add-bug", { harness: "claude-code", model: "sonnet", effort: "medium" }, { alive: true, end: async () => {} }, NOW - 60_000);
    store.update(run.id, { state: "awaiting", activity: "" });
    store.toggleDone(run.id);
    store.ensureDraft(NOW);
    const s0 = { pending: { kind: "question" as const, question: { question: "Should the fix include a regression test, or just the change?", options: [{ label: "Add a regression test", description: "Reproduce the bug in a test first, then fix" }, { label: "Just the fix", description: "Smallest change that works" }] } } };
    const { t, s } = await home({ columns: 80, rows: 24, store, chat: false });
    s.set(s0);
    await t.waitFor("type your own answer");
    const text = t.text();
    expect(text).not.toContain("more");
    expect(text).toMatch(/▾ Done *\n {3}✓  Gluon-fix-add-bug  claude code × sonnet 5\.5 × m/);
    expect(text).toContain("▾ Drafting");
    expect(text.split("\n")).toHaveLength(23);
    t.unmount();
  });

  test("BUG-250/home: a first run at 50×20 shows the greeting whole: the agents available are cut first", async () => {
    const { t } = await home({ columns: 50, rows: 20, store: new SessionStore(), chat: false });
    const text = t.text();
    expect(text.replace(/\s+/g, " ")).toContain(FIRST_LINE);
    expect(text.split("\n")).toHaveLength(19);
    expect(text).toContain("Agents available");
    t.unmount();
  });

  test("BUG-256/home: at 30×8 the chat has no row: one rule over the composer, never two stacked", async () => {
    for (const [columns, rows] of [[30, 8], [19, 5]] as const) {
      const { t } = await home({ columns, rows, store: new SessionStore(), chat: false });
      const ls = t.text().split("\n");
      const rule = (l: string | undefined) => !!l && /^\s*─+\s*$/.test(l);
      for (let y = 1; y < ls.length; y++) expect(rule(ls[y - 1]) && rule(ls[y])).toBe(false);
      expect(ls.findIndex((l) => l.includes("› describe"))).toBe(ls.length - 2);
      t.unmount();
    }
  });

  test("BUG-258/V-05: the agent choice's first frame already lists the agents and names the drafting row — never `keep talking` alone with `(untitled)`", async () => {
    const store = new SessionStore();
    store.ensureDraft(NOW);
    const { t, s } = await home({ columns: 100, rows: 40, store, chat: false });
    s.set({ items: [{ id: 1, kind: "user", text: "add a resume flag" }] });
    await t.waitFor("add a resume flag");
    const from = t.frames().length;
    s.set({ pending: { kind: "proposal", ...PROPOSAL } });
    await t.waitFor("recommended");
    const shown = t.frames().slice(from).map(plain).filter((f) => f.includes("keep talking"));
    expect(shown.length).toBeGreaterThan(0);
    for (const f of shown) {
      expect(f).toContain("1. claude code × sonnet 5.5 × medium · recommended");
      expect(f).toContain("resume-flag");
      expect(f).not.toContain("(untitled)");
    }
    t.unmount();
  });

  test("while the intake agent works: a working line, Esc interrupts, Enter doesn't send", async () => {
    const { t, s } = await home();
    s.set({ pending: null, workingSince: Date.now(), status: "Exploring" });
    await t.waitFor("Exploring (");
    await t.keys("more");
    await t.keys(KEY.enter);
    expect(s.sent).toEqual([]);
    expect(t.text()).toContain("Still working");
    await t.keys(KEY.esc);
    // The held Esc is sent on a timer: on a loaded machine it can fire after a fixed pause (the macOS run's flake).
    for (const until = Date.now() + 5000; s.interrupted < 1 && Date.now() < until; ) await Bun.sleep(25);
    expect(s.interrupted).toBe(1);
    t.unmount();
  });
});
