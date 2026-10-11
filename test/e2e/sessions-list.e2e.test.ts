/**
 * The sessions home's list (`sessions-list/…`, `mouse/…` in test/catalog.ts): its groups and rows, the drafting row, moving
 * over it, folding a group, removing a row, and clicks on it. Every row but the drafting one is a session of a TUI fake started
 * through the demo's agent choice (`gluon-kit.ts`), so these are `@full` but for the drafting row's.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { HOME_TWICE, KEYS, mouseReports } from "./actions.ts";
import { freshConfig, repo } from "./fixtures.ts";
import { gluon, home, launch, say } from "./gluon-kit.ts";
import { type App, HOME_VIEW, SLOW, start, stopAll, toLaunch } from "./harness.ts";
import { GLUON_HEX } from "../../src/ui/theme.ts";

setDefaultTimeout(120_000 * SLOW);
afterAll(stopAll);

/** The row whose line holds `text` is the selected one: a full-width bar from the margin to the last cell before it. */
const selected = (app: App, text: string) => {
  const y = app.row(text);
  return y >= 0 && app.bg(4, y) === GLUON_HEX.selected;
};
/** The selected line's text (the bar), or "" when none is drawn. */
const bar = (app: App) => app.lines().find((_, y) => app.bg(4, y) === GLUON_HEX.selected) ?? "";
/** The hint line under the header (the home view's row 5 from 24 rows). */
const hint = (app: App) => app.lines().find((l) => /\? for keys|enter sends|esc no|esc keeps it|esc stays/.test(l))?.trim() ?? "";
/** A left click as a terminal sends it (press and release, SGR), 1-based cells. */
const clickAt = (x: number, y: number) => mouseReports({ op: "click", button: "left", x, y }).join("");
/** The composer's cursor: its first cell drawn inverse (the composer is the last `›` line; the chat's messages have them too). */
const composerCursor = (app: App) => {
  const y = app.lines().findLastIndex((l) => /^ {3}› /.test(l));
  return !!app.term.buffer.active.getLine(app.term.buffer.active.viewportY + y)?.getCell(5)?.isInverse();
};

/** Presses ↑ or ↓ until the bar is on a line matching `re` (at most `n` presses), then the other way if it wasn't that way. */
async function moveTo(app: App, key: string, re: RegExp, n = 12) {
  for (let i = 0; i < n && !re.test(bar(app)); i++) await app.press(key);
  const back = key === KEYS.up ? KEYS.down : KEYS.up;
  for (let i = 0; i < 2 * n && !re.test(bar(app)); i++) await app.press(back);
  if (!re.test(bar(app))) throw new Error(`no line matching ${re} selected; screen:\n${app.screen()}`);
}

/**
 * Starts a session of `task` and goes home with it awaiting input (the fake says its turn is done): a row that stays in one
 * group (left alone, a fake's row goes from Working to awaiting input when it falls quiet).
 */
async function awaiting(app: App, task: string) {
  await launch(app, task);
  await say(app, "!event status done", "EVENT status done");
  await home(app);
}

/** Starts a chat and leaves its question open with the options hidden (esc): the Drafting row. */
async function draft(app: App, task: string) {
  await app.enter(task);
  await app.press(KEYS.enter);
  await app.waitFor((s) => s.replace(/\s+/g, " ").includes("Should the fix include a regression test"), 20_000);
  await app.idle();
}

describe("the drafting row", () => {
  test("sessions-list/draft-row: the chat being drafted has a Drafting row — waiting for your answer (amber) while a question waits, options shown or not, for your pick while the agent choice is open, talking it through otherwise; Enter on it says it is this chat, Delete asks to discard it with its keys named and no cursor in the composer #BUG-224 #BUG-226 #BUG-227 #BUG-239", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 40 });
    expect(app.screen()).toContain("no sessions yet");
    await draft(app, "fix the add bug");
    await app.waitFor(/◌  \(untitled\) +agent not chosen yet +Waiting for your answer/);
    const answer = app.row("Waiting for your answer");
    expect(app.fg(app.lines()[answer]!.indexOf("Waiting for your answer"), answer)).toBe(GLUON_HEX.amber);
    // Esc hides the options; the question still waits, and a typed reply answers it.
    await app.press(KEYS.esc);
    await app.waitFor((s) => !s.includes("type your own answer"));
    expect(app.screen()).toContain("Waiting for your answer");
    await app.enter("Just the fix");
    await app.press(KEYS.enter);
    await app.waitFor("keep talking", 20_000);
    await app.idle();
    // Named from the proposal now, waiting for the pick.
    await app.waitFor(/◌  Gluon-fix-add-bug +agent not chosen yet +Waiting for your pick/);
    await app.press(KEYS.esc);
    await app.waitFor("Talking it through");
    expect(app.screen()).not.toContain("Waiting for your pick");
    expect(app.lines().at(-2)).toMatch(/^ {3}› reply to the intake agent/);
    // On the row: Enter says it is this chat; Delete asks to discard it.
    await moveTo(app, KEYS.down, /Gluon-fix-add-bug/);
    await app.waitFor((s) => hint(app) === "del discards it · ? for keys");
    await app.press(KEYS.enter);
    await app.waitFor("That's this chat: type below");
    expect(app.lines().at(-2)).toMatch(/^ {3}› reply to the intake agent/);
    expect(composerCursor(app)).toBe(true);
    await app.press(KEYS.delete);
    await app.waitFor("Discard this chat?");
    expect(hint(app)).toBe("enter discards it · esc keeps it");
    expect(composerCursor(app)).toBe(false);
    await app.press(KEYS.esc);
    await app.waitFor((s) => !s.includes("Discard this chat?"));
    expect(app.screen()).toContain("Gluon-fix-add-bug");
  });
});

/** The header's third line: the counts by state (beside the mark's last row). */
const counts = (screen: string) => screen.split("\n").find((l) => l.includes("⠑●")) ?? "";
/** The widest line on screen. */
const widest = (app: App) => Math.max(...app.lines().map((l) => Bun.stringWidth(l)));

describe("the rows", () => {
  test("sessions-list/groups: sessions in every state are grouped under Awaiting input, Working, Done and Drafting with their glyphs, under a column header, the header counting them; nothing wraps at 110 or 80 columns, the selected row is a full-width bar; the hint names the keys for what is selected and keeps `? for keys` at 60×20; a digit on the home composer is text, never a tab #BUG-216 #BUG-228 #BUG-233 @full", async () => {
    const app = await gluon(110, 30);
    await launch(app, "alpha task");
    await say(app, "!event status done", "EVENT status done");
    await home(app);
    await launch(app, "bravo task");
    await say(app, "!event status working Editing a.ts", "EVENT status working");
    await home(app);
    await launch(app, "charlie task");
    await home(app);
    // Back home the row left is selected (BUG-231): Ctrl+D marks charlie done.
    await app.press("\x04");
    await app.waitFor(/▾ Done\n {3}✓  Gluon-charlie-task/);
    await draft(app, "delta thing");
    await app.press(KEYS.esc);
    await app.waitFor((s) => !s.includes("type your own answer"));
    await app.waitFor("1 awaiting input · 1 working · 1 done · 1 drafting");
    const s = app.screen();
    expect(s).toMatch(/context +cost +time\n {3}▾ Awaiting input\n {3}\?  Gluon-alpha-task/);
    expect(s).toMatch(/▾ Working\n {3}●  Gluon-bravo-task .*Editing a\.ts/);
    expect(s).toMatch(/▾ Drafting\n {3}◌  \(untitled\) +agent not chosen yet/);
    expect(widest(app)).toBeLessThanOrEqual(110);
    // The hint per selection, the bar across the whole width.
    await moveTo(app, KEYS.up, /Gluon-alpha-task/);
    expect(hint(app)).toBe("enter opens it · ctrl+d marks done · del ends it · ? for keys");
    const y = app.row("Gluon-alpha-task");
    expect([app.bg(2, y), app.bg(107, y)]).toEqual([GLUON_HEX.selected, GLUON_HEX.selected]);
    await moveTo(app, KEYS.up, /▾ Awaiting input/);
    expect(hint(app)).toBe("enter collapses the group · ? for keys");
    await moveTo(app, KEYS.down, /Gluon-charlie-task/);
    expect(hint(app)).toBe("enter opens it · ctrl+d unmarks done · del ends it · ? for keys");
    await moveTo(app, KEYS.down, /◌ /);
    expect(hint(app)).toBe("del discards it · ? for keys");
    // 80 columns: the same groups, nothing wider.
    app.resize(80, 30);
    await app.waitFor((x) => x.includes("▾ Done") && widest(app) <= 80);
    for (const g of ["Awaiting input", "Working", "Done", "Drafting"]) expect(app.screen()).toContain(`▾ ${g}`);
    app.resize(100, 30);
    await app.waitFor(() => widest(app) > 80);
    // A digit is text: `2 bugs to fix` is typed and sent whole (the reply to the open question), no tab opened.
    await app.type("2");
    await app.waitFor("› 2");
    expect(app.lines()[0]).not.toContain("◆ gluon");
    await app.type(" bugs to fix");
    await app.press(KEYS.enter);
    await app.waitFor("keep talking", 20_000);
    await app.idle();
    // Sent whole: the answer the spec records.
    expect(app.screen()).toContain("│ • 2 bugs to fix");
    expect(app.lines()[0]).not.toContain("◆ gluon");
    // The draft discarded: the composer describes another session.
    await app.press(KEYS.esc);
    await app.waitFor((x) => !x.includes("keep talking"));
    await moveTo(app, KEYS.down, /◌ /);
    await app.press(KEYS.delete);
    await app.waitFor("Discard this chat?");
    await app.press(KEYS.enter);
    await app.waitFor((x) => !x.includes("▾ Drafting") && x.includes("› describe another session"));
    // 60×20 (no conversation going, so the list has the rows): the hint keeps `? for keys`, other keys go first.
    app.resize(60, 20);
    await app.waitFor(() => app.lines().length <= 19 && widest(app) <= 60);
    await moveTo(app, KEYS.up, /Gluon-bravo-task/);
    await app.waitFor(() => /^enter opens it · .*\? for keys$/.test(hint(app)));
    expect(app.lines().at(-2)).toMatch(/^ {3}› describe another session/);
  });

  test("home/header-counts: the header counts the sessions by state — `no sessions yet` before the first, `1 awaiting input · 1 working · 1 drafting` with a chat drafted — and once every session ended and the chat is discarded, `no sessions running` @full", async () => {
    const app = await gluon(100, 30);
    expect(counts(app.screen())).toContain("no sessions yet");
    await awaiting(app, "alpha task");
    await launch(app, "bravo task");
    await say(app, "!event status working Editing a.ts", "EVENT status working");
    await home(app);
    await draft(app, "charlie thing");
    await app.press(KEYS.esc);
    await app.waitFor((s) => counts(s).includes("1 awaiting input · 1 working · 1 drafting"));
    await moveTo(app, KEYS.down, /◌ /);
    await app.press(KEYS.delete);
    await app.waitFor("Discard this chat?");
    await app.press(KEYS.enter);
    await app.waitFor((s) => counts(s).trim().endsWith("1 awaiting input · 1 working"));
    for (const name of ["alpha", "bravo"]) {
      await moveTo(app, KEYS.up, new RegExp(`Gluon-${name}-task`));
      await app.press(KEYS.delete);
      await app.waitFor(`End Gluon-${name}-task?`);
      await app.press(KEYS.enter);
      await app.waitFor((x) => !x.includes(`Gluon-${name}-task`));
    }
    await app.waitFor((s) => counts(s).includes("no sessions running"));
    expect(app.screen()).not.toContain("no sessions yet");
  });

  test("sessions-list/row-columns: a session's row shows its name, triple, activity, its mode (`· explore`; nothing for build) and Gluon's own cost and context figures under the column header @full", async () => {
    const app = await gluon(110, 30);
    await launch(app, "alpha task", ["\x14"]);
    await say(app, "!otel 1.23 380000", "OTEL 200,200");
    await home(app);
    await launch(app, "bravo task");
    await say(app, "!event status working Editing a.ts", "EVENT status working");
    await home(app);
    await app.waitFor(/Gluon-alpha-task +claude code × sonnet 5\.5 × high · explore +\S.*38% +~?\$1\.23 +\S+/);
    expect(app.screen()).toMatch(/context +cost +time/);
    expect(app.lines()[app.row("Gluon-bravo-task")]).toMatch(/Gluon-bravo-task +claude code × sonnet 5\.5 × high +Editing a\.ts +— +— +\S+/);
  });

  test("home/short-terminal-priority: at 80×24 a Done session, the drafting row and an open question all show — every row, no `… more`, the gaps around the list going first @full", async () => {
    const app = await gluon(80, 24);
    await launch(app, "alpha task");
    await home(app);
    await app.press("\x04");
    await app.waitFor(/▾ Done\n {3}✓  Gluon-alpha-task/);
    await draft(app, "fix the add bug");
    const s = app.screen();
    expect(s).not.toContain("more");
    expect(s).toMatch(/▾ Done *\n {3}✓  Gluon-alpha-task  claude code × son/);
    expect(s).toContain("▾ Drafting");
    expect(s).toContain("type your own answer");
    expect(app.lines()).toHaveLength(23);
  });
});

describe("moving over the list", () => {
  test("sessions-list/collapse: ↑↓ move over the group labels too; Enter on a label collapses its group to `▸ Awaiting input (2)` and expands it again, never opening a session; on a row Enter opens it @full", async () => {
    const app = await gluon(100, 30);
    await awaiting(app, "alpha task");
    await awaiting(app, "bravo task");
    await app.waitFor(/▾ Awaiting input\n {3}\?  Gluon-alpha-task.*\n {3}\?  Gluon-bravo-task/);
    await moveTo(app, KEYS.up, /▾ Awaiting input/);
    expect(hint(app)).toBe("enter collapses the group · ? for keys");
    await app.press(KEYS.enter);
    await app.waitFor("▸ Awaiting input (2)");
    expect(app.screen()).not.toContain("Gluon-alpha-task");
    expect(bar(app)).toContain("▸ Awaiting input (2)");
    expect(hint(app)).toBe("enter expands the group · ? for keys");
    await app.press(KEYS.enter);
    await app.waitFor("Gluon-bravo-task");
    expect(HOME_VIEW.test(app.screen())).toBe(true);
    await moveTo(app, KEYS.down, /Gluon-alpha-task/);
    await app.press(KEYS.enter);
    await app.waitFor((s) => s.includes("◆ gluon") && !HOME_VIEW.test(s));
  });

  test("mouse/click-group: a click on a group label folds it and a later click unfolds it; a double-click folds it once, its second click doing nothing more; no session opens #BUG-269/GLUON-52 #BUG-274/GLUON-58 @full", async () => {
    const app = await gluon(100, 30);
    await awaiting(app, "alpha task");
    await awaiting(app, "bravo task");
    await app.waitFor(/▾ Awaiting input\n {3}\?  Gluon-alpha-task.*\n {3}\?  Gluon-bravo-task/);
    const label = app.row("▾ Awaiting input") + 1;
    // A double-click (both clicks in one read): folded once.
    app.write(clickAt(6, label) + clickAt(6, label));
    await app.waitFor("▸ Awaiting input (2)");
    await app.settle(300); // sleep-ok: the second click must not unfold it again
    expect(app.screen()).toContain("▸ Awaiting input (2)");
    expect(app.screen()).not.toContain("Gluon-alpha-task");
    // A click of its own, past the double-click's window: unfolded.
    await Bun.sleep(500); // sleep-ok: past the double-click window (400 ms), so the next click is one of its own
    await app.press(clickAt(6, app.row("▸ Awaiting input") + 1));
    await app.waitFor("Gluon-alpha-task");
    // A single click folds it again.
    await Bun.sleep(500); // sleep-ok: past the double-click window
    await app.press(clickAt(6, app.row("▾ Awaiting input") + 1));
    await app.waitFor("▸ Awaiting input (2)");
    expect(HOME_VIEW.test(app.screen())).toBe(true);
  });

  test("sessions-list/selection-after-remove: after a row goes the next row is selected — the next in its group, the next group's after its group's last, the previous one after the list's last row — never the first @full", async () => {
    const app = await gluon(100, 34);
    for (const t of ["alpha task", "bravo task", "charlie task"]) await awaiting(app, t);
    await draft(app, "delta thing");
    await app.press(KEYS.esc);
    await app.waitFor((s) => !s.includes("type your own answer"));
    await app.waitFor(/▾ Awaiting input\n {3}\?  Gluon-alpha-task.*\n {3}\?  Gluon-bravo-task.*\n {3}\?  Gluon-charlie-task/);
    const end = async (name: string) => {
      await app.press(KEYS.delete);
      await app.waitFor(`End ${name}?`);
      await app.press(KEYS.enter);
      await app.waitFor((s) => !s.includes(name));
    };
    // The middle row: the next one.
    await moveTo(app, KEYS.up, /Gluon-bravo-task/);
    await end("Gluon-bravo-task");
    await app.waitFor(() => selected(app, "Gluon-charlie-task"));
    // The last of its group: the next group's row.
    await end("Gluon-charlie-task");
    await app.waitFor(() => selected(app, "◌  (untitled)"));
    // The list's last row: the previous one.
    await app.press(KEYS.delete);
    await app.waitFor("Discard this chat?");
    await app.press(KEYS.enter);
    await app.waitFor((s) => !s.includes("(untitled)"));
    await app.waitFor(() => selected(app, "Gluon-alpha-task"));
  });

  test("sessions-list/select: on a list longer than its rows (`… N more`) a click two rows below selects that row without scrolling the list, a second click opens it; ↓ past the window's last row moves the list one line, the selection kept in view @full", async () => {
    const app = await gluon(100, 22);
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
    for (const n of names) await awaiting(app, `${n} task`);
    const list = () => app.lines().filter((l) => /Gluon-\w+-task |▾ |… \d+ more/.test(l));
    const run = (l: string) => /Gluon-\w+-task/.exec(l)?.[0] ?? "";
    await app.waitFor(() => /… \d+ more/.test(list().at(-1) ?? ""));
    // From the top of the list: two rows below the selected one.
    await moveTo(app, KEYS.up, /▾ Awaiting input/, 20);
    await app.press(KEYS.down);
    const shown = list();
    const at = shown.findIndex((l) => run(l) && bar(app).includes(run(l))) + 2;
    const name = run(shown[at]!);
    expect(name).not.toBe("");
    const y = app.row(`${name} `) + 1;
    await app.press(clickAt(10, y));
    await app.waitFor(() => selected(app, `${name} `));
    expect(list()).toEqual(shown);
    expect(HOME_VIEW.test(app.screen())).toBe(true);
    app.write(clickAt(10, y));
    await app.waitFor((s) => s.includes("◆ gluon") && !HOME_VIEW.test(s));
    expect(app.lines()[1]).toBeDefined();
    await app.press(...HOME_TWICE);
    await app.waitFor(HOME_VIEW);
    // ↓ to the window's last row, then once more: the list moves one line.
    await moveTo(app, KEYS.up, /▾ Awaiting input/, 20);
    const top = list();
    const last = run(top.at(-2)!);
    await moveTo(app, KEYS.down, new RegExp(last), 20);
    expect(list()).toEqual(top);
    await app.press(KEYS.down);
    const moved = list();
    expect(moved.at(-3)).toContain(last);
    expect(bar(app)).toContain(run(moved.at(-2)!));
  });

  test("sessions-list/open: without a pseudo-terminal sessions run one at a time — one that ended leaves no row to open, and the key list names no key that opens a session (Enter only folds a group, no →, no In a session) #BUG-180 @full", async () => {
    const app = await start({ cwd: repo.tiny(), cols: 100, rows: 40, env: { GLUON_CONFIG: freshConfig("sessions-list-no-pty", "handoff:\n  on_clear: stay\n"), GLUON_TEST_NO_PTY: "1" } });
    await toLaunch(app);
    await app.type("bye");
    await app.press(KEYS.enter);
    await app.waitFor((s) => HOME_VIEW.test(s) && s.includes("No pseudo-terminal here, so sessions run one at a time."), 20_000);
    expect(app.screen()).toContain("no sessions running");
    expect(app.screen()).not.toContain("Gluon-fix-add-bug");
    await app.press("?");
    await app.waitFor("fold a group");
    const s = app.screen();
    expect(s).not.toContain("open it");
    expect(s).not.toContain("open the first tab");
    expect(s).not.toContain("In a session");
    expect(s).toContain("select a row");
  });
});
