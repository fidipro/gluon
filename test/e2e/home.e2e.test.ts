/** The sessions home as a whole: first run, fitting the terminal, the hint line, one highlight, the `?` key list, the chat's scroll. */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { wheelDown, wheelUp } from "./actions.ts";
import { config, repo } from "./fixtures.ts";
import { assertInvariants, checkInvariants } from "./gluon-invariants.ts";
import { gluon, home } from "./gluon-kit.ts";
import { type App, FULL_PACE, KEY, SLOW, start, stopAll, toProposal, toQuestion } from "./harness.ts";

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

const FIRST_LINE = "◆ What are we building? I'll ask a few questions first, then start a session with the right harness, model and effort.";
/** The hint line under the header: the keys for what is selected or open. */
const HINT = /(\? for keys|esc cancels|esc dismisses|esc esc clears it|esc interrupts)$/;
const hintLine = (app: App) => app.lines().slice(0, 8).find((l) => HINT.test(l.trim()))?.trim();
/** The hint under the open question or agent choice (indented under its options). */
const underHint = (app: App) => app.lines().find((l) => /^ {6,}(↑↓|enter) /.test(l))?.trim();
/** The highlighted blocks (the selected colour or the bar's) that aren't the user's own messages (`›`): Enter acts on one thing. */
const SELECTED = "#363a46";
const BAR = "#1a1c22";
function highlights(app: App): number[] {
  const rows = app.lines().flatMap((l, y) => {
    if (/^\s*›/.test(l) || !l.trim()) return [];
    const x = l.search(/\S/);
    return [SELECTED, BAR].includes(app.bg(x, y) ?? "") ? [y] : [];
  });
  return rows.filter((y, i) => i === 0 || rows[i - 1] !== y - 1);
}
/**
 * Gluon's home invariants (rows − 1 tall, nothing wider or wrapped, the screen lints) but the header's: with a conversation going
 * on, a short terminal gives the header up for the chat (`home/short-terminal-priority`).
 */
const fitProblems = (app: App) => checkInvariants(app, { view: "home" }).filter((p) => !p.startsWith("home: no header"));
/** No two rules stacked: the chat with no row left gives one rule over the composer. */
const stackedRules = (app: App) => app.lines().some((l, y, ls) => y > 0 && /^\s*─+\s*$/.test(l) && /^\s*─+\s*$/.test(ls[y - 1]!));

describe("first run", () => {
  test("home/first-run: the agents available with each one's readiness, the intake agent's first line and `? for keys`; at 50×20 the greeting stays whole #BUG-250; at 30 columns a name never runs into its readiness", async () => {
    const [wide, short, narrow] = await Promise.all([start({ cwd: repo.tiny() }), start({ cwd: repo.tiny(), cols: 50, rows: 20 }), start({ cwd: repo.tiny(), cols: 30, rows: 30 })]);
    const agentRows = narrow.lines().filter((l) => /^ +[●○◌] /.test(l));
    expect(agentRows.length).toBeGreaterThan(0);
    for (const l of agentRows) expect(l).toMatch(/^ +[●○◌] +(claude code|codex|antigravity|grok build|opencode|kimi code) +\S/);
    const s = wide.screen();
    expect(s).toContain("Agents available");
    expect(s).toMatch(/○ +claude code +sign-in needed/);
    expect(s).toMatch(/○ +codex +not installed/);
    expect(s).toContain("Every session you start shows up here.");
    expect(hintLine(wide)).toBe("? for keys");
    expect(s.replace(/\s+/g, " ")).toContain(FIRST_LINE);
    expect(wide.lines().at(-2)).toMatch(/^ {3}› describe the session you want/);
    // Short: the greeting whole, the agents still named.
    expect(short.screen().replace(/\s+/g, " ")).toContain(FIRST_LINE);
    expect(short.screen()).toContain("Agents available");
    assertInvariants(short, { view: "home" });
  });

  test("home/first-run: an API-key connection whose key isn't set reads `key missing`; one whose key is set is ready on it; OpenCode is the open-weight lane; the agents in the brief's order #BUG-182/F", async () => {
    const yaml = "connections:\n  claude-code: { auth: subscription }\n  codex: { auth: api, provider: openai }\n  grok-build: { auth: api, provider: xai }\n  opencode: { providers: [openrouter] }\n";
    const app = await start({ cwd: repo.tiny(), rows: 40, agents: ["claude", "codex", "grok", "opencode", "kimi"], env: { GLUON_CONFIG: config("first-run-keys", yaml), OPENAI_API_KEY: undefined, XAI_API_KEY: "xai-test-key", OPENROUTER_API_KEY: "sk-or-test" } });
    await app.waitFor(/● +opencode +ready · open-weight models · api key/, 10_000);
    const rows = app.lines().filter((l) => /^ +[●○◌] /.test(l));
    expect(rows.map((l) => l.replace(/^ +[●○◌] +/, "").split(/ {2,}/)[0])).toEqual(["claude code", "codex", "grok build", "antigravity", "opencode", "kimi code"]);
    expect(rows[1]).toMatch(/○ +codex +key missing$/);
    expect(rows[2]).toMatch(/● +grok build +ready · api key$/);
    expect(rows[3]).toMatch(/○ +antigravity +not installed$/);
  });
});

describe("the terminal's size", () => {
  test("home/fits-terminal: through any resize the home view is rows − 1 tall, nothing wider or wrapped, the composer on screen under one rule; the open choice stays in view #BUG-256", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 110, rows: 40 });
    await toProposal(app);
    for (const [cols, rows] of [[60, 24], [40, 12], [30, 8], [19, 5], [110, 40]] as const) {
      app.resize(cols, rows);
      await app.waitFor((s) => s.split("\n").every((l) => Bun.stringWidth(l) <= cols) && s.includes("›"), 5000);
      // Under load the resize's last frame can come after one that already fits the width: wait for it, then check.
      await app.waitFor(() => fitProblems(app).length === 0 && !stackedRules(app), 3000).catch(() => {});
      expect([cols, rows, fitProblems(app)]).toEqual([cols, rows, []]);
      expect([cols, rows, stackedRules(app)]).toEqual([cols, rows, false]);
      if (cols === 60) expect(app.screen()).toContain("❯ 1. claude code");
    }
  });
});

describe("a short terminal", () => {
  test("home/short-terminal-priority: the conversation wins over the list — the choice's options and the composer stay at 16, 12 and 10 rows; folded at 80×24 the list keeps its column header and group label #BUG-162 #BUG-249", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 80, rows: 24 });
    await toProposal(app);
    await app.press(KEY.ctrlO);
    await app.waitFor("ctrl+o to view");
    const ls = app.lines();
    const head = ls.findIndex((l) => /^ +context +cost +time$/.test(l));
    expect(head).toBeGreaterThan(0);
    expect(ls[head + 1]).toMatch(/^ {3}▾ Drafting/);
    expect(ls[head + 2]).toMatch(/^ {3}◌  Gluon-fix-add-bug/);
    expect(app.screen()).toContain("3. keep talking");
    expect(ls.at(-2)).toMatch(/^ {3}› reply to the intake agent/);
    for (const rows of [16, 12, 10]) {
      app.resize(80, rows);
      await app.waitFor((s) => s.split("\n").length <= rows, 5000);
      expect([rows, fitProblems(app)]).toEqual([rows, []]);
      expect([rows, app.screen().includes("keep talking"), app.lines().at(-2)]).toEqual([rows, true, expect.stringMatching(/^ {3}› reply to the intake agent/)]);
    }
  });
});

describe("the hint line and the highlight", () => {
  test("home/hint-line: at the question and the choice it names what Enter does — answers, starts the session, keeps talking, sends, picks N — as the hint under them does; while the intake agent works, `still working`; narrow, both drop other keys before Enter's and Esc's #BUG-217 #BUG-225", async () => {
    const [app, busy, narrow] = await Promise.all([start({ cwd: repo.tiny(), cols: 80, rows: 40 }), start({ cwd: repo.tiny(), cols: 80, rows: 40, env: FULL_PACE }), start({ cwd: repo.tiny(), cols: 56, rows: 40 })]);
    // The narrow one walks to its agent choice meanwhile.
    const narrowAtChoice = toProposal(narrow);
    // The intake agent at work: Enter doesn't send, the hint says so.
    await busy.enter("fix the add bug");
    await busy.press(KEY.enter);
    await busy.waitFor("esc to interrupt");
    await busy.type("more");
    await busy.waitFor(() => hintLine(busy) === "still working · esc interrupts", 3000);

    const agree = async (want: string) => {
      await app.waitFor(() => hintLine(app) === want, 3000);
      expect(underHint(app)!.startsWith(want)).toBe(true);
    };
    await toQuestion(app);
    await agree("↑↓ choose · enter answers · esc dismisses");
    await app.press(KEY.enter);
    await app.waitFor("keep talking", 20_000);
    await app.idle();
    await agree("↑↓ choose · enter starts the session · esc cancels");
    await app.press(KEY.up);
    await app.waitFor(/❯ 3\. keep talking/);
    await agree("↑↓ choose · enter keeps talking · esc cancels");
    await app.type("x");
    await agree("enter sends · esc esc clears it");
    await app.press(KEY.backspace);
    await app.type("2");
    await agree("enter picks 2 · esc esc clears it");

    await narrowAtChoice;
    for (const h of [hintLine(narrow), underHint(narrow)]) expect(h).toMatch(/enter starts the session · esc cancels$/);
  });

  test("home/one-highlight: while the question or the agent choice is open only the option Enter acts on is highlighted, never the list's row too; closed, the row is again #BUG-217 #BUG-247", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 80, rows: 40 });
    await toQuestion(app);
    expect(highlights(app)).toEqual([app.row("❯ 1.")]);
    await app.press(KEY.enter);
    await app.waitFor("keep talking", 20_000);
    await app.idle();
    expect(highlights(app)).toEqual([app.row("❯ 1.")]);
    // Closed: the list's row (the drafting one) is the one highlighted.
    await app.press(KEY.esc);
    await app.waitFor(() => JSON.stringify(highlights(app)) === JSON.stringify([app.row("◌  Gluon-fix-add-bug")]), 3000);
  });
});

describe("the key list (`?`)", () => {
  const ALL = [/↑↓ +select a row or group/, /ctrl\+c twice +quit/, /ctrl\+\\ +then ←\/→ · again: home/, /←\/→ +switch, nothing typed/, /click +a tab, ◆ gluon, ‹ ›/, /shift\+pgup +scroll, wheel too/, /ctrl\+o +fold the spec/, /ctrl\+j +new line/, /Intake chat/];
  /** Everything the key list shows, page by page (pgdn), and whether it was cut. */
  async function pages(app: App): Promise<{ all: string; cut: boolean }> {
    let all = "";
    let cut = false;
    for (let i = 0; i < 8; i++) {
      all += `${app.screen()}\n`;
      if (!/↓ \d+ more/.test(app.screen())) break;
      cut = true;
      await app.press(KEY.pgdn);
    }
    return { all, cut };
  }

  test("home/key-list: `?` on an empty composer lists every key in columns that fit, the configured home key too; esc or `?` close it, another key closes it and acts; with a question open `?` is text; narrow it stacks, short it is cut, the composer stays #BUG-168 #BUG-216", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 80, rows: 24, env: { GLUON_CONFIG: config("home-keylist", "handoff:\n  key: ctrl+]\n") } });
    await app.press("?");
    await app.waitFor("? / esc close");
    const s = app.screen();
    for (const re of [/^ {3}Keys *$/m, /Sessions +Intake chat/, /ctrl\+\] +then ←\/→ · again: home/, /ctrl\+c twice +quit/, /ctrl\+d +mark done, or not/, /shift\+tab +the agent's effort/, /ctrl\+j +new line/]) expect(s).toMatch(re);
    expect(app.lines().at(-2)).toMatch(/^ {3}› describe the session you want/);
    assertInvariants(app, { view: "home" });
    await app.press(KEY.esc);
    await app.waitFor((x) => !x.includes("? / esc close"), 3000);
    await app.press("?");
    await app.waitFor("? / esc close");
    await app.press("?");
    await app.waitFor((x) => !x.includes("? / esc close"), 3000);
    // Any other key closes it and does what it does: here, types; with text typed `?` is text.
    await app.press("?");
    await app.waitFor("? / esc close");
    await app.type("a?");
    await app.waitFor("› a?");
    expect(app.screen()).not.toContain("? / esc close");
    // Narrow: one column, nothing wider. Short: cut, the closing line and the composer kept.
    await app.press(KEY.ctrlU);
    await app.press("?");
    app.resize(50, 40);
    await app.waitFor((x) => x.includes("? / esc close") && !/Sessions +\S/.test(x), 5000);
    for (const l of app.lines()) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(50);
    expect(app.screen()).toContain("Intake chat");
    app.resize(80, 12);
    await app.waitFor((x) => x.split("\n").length <= 12 && x.includes("? / esc close"), 5000);
    expect(app.lines().at(-2)).toMatch(/› describe the session you want/);
    assertInvariants(app, { view: "home" });
    // With a question open `?` answers it.
    await app.press(KEY.esc);
    await app.waitFor((x) => !x.includes("? / esc close"), 3000);
    app.resize(80, 40);
    await toQuestion(app);
    await app.press("?");
    await app.waitFor("› ?");
    expect(app.screen()).not.toContain("? / esc close");
  });

  test("home/key-list: every key is on the list — a session's too — reached with pgdn where it is cut; at 60 columns the groups stack, at 120 they stand side by side #BUG-229", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 120, rows: 40 });
    for (const [cols, rows] of [[120, 40], [60, 20]] as const) {
      app.resize(cols, rows);
      await app.settle(100);
      await app.press("?");
      await app.waitFor("? / esc close");
      if (cols === 120) expect(app.screen()).toMatch(/Sessions +In a session +Intake chat/);
      if (cols === 60) expect(app.screen()).not.toMatch(/Sessions +\S/);
      const { all, cut } = await pages(app);
      if (cut) expect(all).toMatch(/\? \/ esc close · pgup pgdn \/ wheel (↑ \d+ above · )?↓ \d+ more/);
      expect([cols, ALL.filter((re) => !re.test(all)).map(String)]).toEqual([cols, []]);
      for (const l of app.lines()) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(cols);
      // PgUp goes back; the composer stays.
      await app.press(KEY.pgup);
      expect(app.lines().at(-2)).toMatch(/› /);
      await app.press(KEY.esc);
      await app.waitFor((x) => !x.includes("? / esc close"), 3000);
    }
  });

  test("home/key-list-mouse: with `handoff.mouse_capture: false` the key list names no click, wheel or text selection, and its closing line only pgup pgdn #BUG-275/GLUON-59", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 80, rows: 24, env: { GLUON_CONFIG: config("home-nomouse", "handoff:\n  mouse_capture: false\n") } });
    await app.press("?");
    await app.waitFor("? / esc close");
    expect(app.screen()).toContain("pgup pgdn ↓");
    const { all, cut } = await pages(app);
    expect(cut).toBe(true);
    expect(all).toContain("shift+pgup");
    expect([/\bclick\b/.test(all), all.includes("wheel"), all.includes("select and copy text")]).toEqual([false, false, false]);
  });
});

describe("the chat", () => {
  test("intake-chat/scroll: pgup and the wheel scroll the chat back to its first line, pgdn and the wheel forward again #BUG-269", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 30 });
    await toProposal(app);
    // The choice closed: open, pgup scrolls its spec only (BUG-218).
    await app.press(KEY.esc);
    await app.waitFor((x) => !x.includes("❯ 1."), 3000);
    const first = "›  fix the add bug";
    expect(app.screen()).not.toContain(first);
    for (let i = 0; i < 10 && !app.screen().includes(first); i++) await app.press(KEY.pgup);
    expect(app.screen()).toContain(first);
    for (let i = 0; i < 10 && app.screen().includes(first); i++) await app.press(KEY.pgdn);
    expect(app.screen()).not.toContain(first);
    // The wheel over the chat, as the terminal reports it (1-based cells).
    const y = app.lines().findIndex((l) => l.includes("◆")) + 1;
    for (let i = 0; i < 30 && !app.screen().includes(first); i++) await app.press(wheelUp(10, y));
    expect(app.screen()).toContain(first);
    for (let i = 0; i < 30 && app.screen().includes(first); i++) await app.press(wheelDown(10, y));
    expect(app.screen()).not.toContain(first);
  });
});

describe("the composer's placeholder", () => {
  test("composer/placeholder: it says what Enter does: `describe the session you want` first, `reply to the intake agent` in a conversation, `describe another session` once one runs #BUG-227", async () => {
    const app = await gluon();
    const placeholder = () => app.lines().at(-2)?.trim();
    expect(placeholder()).toBe("› describe the session you want");
    await toQuestion(app);
    expect(placeholder()).toBe("› reply to the intake agent");
    await app.press("1", KEY.enter);
    await app.waitFor("keep talking", 20_000);
    await app.idle();
    await app.press(KEY.enter);
    await app.waitFor((s) => s.includes("TUI ready") && s.includes("◆ gluon"), 20_000);
    await home(app);
    await app.waitFor((s) => s.split("\n").at(-2)?.trim() === "› describe another session");
  });
});
