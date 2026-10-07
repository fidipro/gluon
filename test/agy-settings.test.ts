/**
 * Antigravity's status line (issue #39; src/adapters/agy-settings.ts, off unless cost.antigravity_statusline):
 * the writer's guards (what agy does to its own settings file was observed on 1.2.16), its removal,
 * and the status the command's hook sends.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyStatusLineInstalled, AGY_SCRIPT, AGY_SCRIPT_TEXT, ensureAgyStatusLine, removeAgyStatusLine } from "../src/adapters/agy-settings.ts";
import { agyStatus, antigravity } from "../src/adapters/antigravity.ts";
import { parseEvent } from "../src/events.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-agy-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
/** A home with agy's settings (when `settings` is given) and a Gluon config dir. */
function setup(settings?: string) {
  const root = join(TMP, `h${++n}`);
  const home = join(root, "home");
  const configDir = join(root, "cfg");
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const file = join(home, ".gemini", "antigravity-cli", "settings.json");
  if (settings !== undefined) writeFileSync(file, settings, { mode: 0o600 });
  return { home, configDir, file, script: join(configDir, AGY_SCRIPT), o: { home, configDir, platform: "linux" as const } };
}
const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;

describe("adding Gluon's status line", () => {
  test.skipIf(process.platform === "win32")("only the statusLine member is spliced in: every other byte of the user's settings stays where it is, mode kept; the script is inert and executable", () => {
    const original = '{"zeta":{"b":1,"a":[1,2]},"theme":"dark","trustedWorkspaces":["/w"]}';
    const s = setup(original);
    chmodSync(s.file, 0o600);
    expect(ensureAgyStatusLine(s.o)).toBeNull();
    expect(read(s.file)).toEqual({ theme: "dark", trustedWorkspaces: ["/w"], zeta: { a: [1, 2], b: 1 }, statusLine: { command: s.script, stack_with_default: true, type: "command" } });
    expect(readFileSync(s.file, "utf8")).toBe(`${original.slice(0, -1)},"statusLine":{"command":${JSON.stringify(s.script)},"stack_with_default":true,"type":"command"}}`);
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect(readFileSync(s.script, "utf8")).toBe(AGY_SCRIPT_TEXT);
    expect(statSync(s.script).mode & 0o777).toBe(0o700);
    // Again: nothing changes.
    const before = readFileSync(s.file, "utf8");
    expect(ensureAgyStatusLine(s.o)).toBeNull();
    expect(readFileSync(s.file, "utf8")).toBe(before);
    // In a file laid out in lines the member is laid out the same way.
    const lines = setup('{\n  "theme": "dark"\n}\n');
    expect(ensureAgyStatusLine(lines.o)).toBeNull();
    expect(readFileSync(lines.file, "utf8")).toBe(`{\n  "theme": "dark",\n  "statusLine": {\n    "command": ${JSON.stringify(lines.script)},\n    "stack_with_default": true,\n    "type": "command"\n  }\n}\n`);
  });

  test.skipIf(process.platform === "win32")("the script does nothing outside a Gluon launch and hands stdin to `gluon hook antigravity statusline` inside one", () => {
    const s = setup("{}");
    ensureAgyStatusLine(s.o);
    const run = (env: Record<string, string>) => Bun.spawnSync(["sh", s.script], { env: { PATH: process.env.PATH ?? "", ...env }, stdin: Buffer.from('{"x":1}'), stdout: "pipe" });
    expect(run({}).exitCode).toBe(0);
    expect(run({ GLUON_EVENTS: "/e" }).exitCode).toBe(0);
    // With both set it runs GLUON_SELF with the hook arguments (here `echo`: they come out).
    expect(run({ GLUON_EVENTS: "/e", GLUON_SELF: "/bin/echo" }).stdout.toString().trim()).toBe("hook antigravity statusline");
  });

  test.skipIf(process.platform === "win32")("a status line of the user's own stays: nothing is written, and the note says so", () => {
    const own = '{"statusLine":{"type":"command","command":"/home/me/mine.sh"}}';
    const s = setup(own);
    expect(ensureAgyStatusLine(s.o)).toContain("a status line of your own");
    expect(readFileSync(s.file, "utf8")).toBe(own);
    expect(existsSync(s.script)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("the guards: not strict JSON (agy stops at startup on it), not an object, a symbolic link, no file yet, Windows, a path with spaces: nothing is written", () => {
    for (const bad of ['{"a":1,}', '{"a":1 /* c */}', "[]", "null", "", "{oops"]) {
      const s = setup(bad);
      expect(ensureAgyStatusLine(s.o)).toMatch(/isn't (strict JSON|a JSON object)/);
      expect(readFileSync(s.file, "utf8")).toBe(bad);
      expect(existsSync(s.script)).toBe(false);
    }
    const none = setup();
    expect(ensureAgyStatusLine(none.o)).toContain("start Antigravity once");
    expect(existsSync(none.file)).toBe(false);
    const link = setup();
    const target = join(TMP, "dotfiles-settings.json");
    writeFileSync(target, "{}");
    symlinkSync(target, link.file);
    expect(ensureAgyStatusLine(link.o)).toContain("symbolic link");
    expect(readFileSync(target, "utf8")).toBe("{}");
    expect(lstatSync(link.file).isSymbolicLink()).toBe(true);
    expect(ensureAgyStatusLine({ ...setup("{}").o, platform: "win32" })).toContain("Windows");
    const spaced = setup("{}");
    expect(ensureAgyStatusLine({ ...spaced.o, configDir: join(TMP, "a dir with spaces") })).toContain("without spaces");
  });

  // The writer is skipped on Windows by design (the status line command is a shell script): the note says so, whatever the file holds.
  test("on Windows nothing is written, and the note says why, before any file is looked at", () => {
    for (const settings of [undefined, "{}", '{"statusLine":{"command":"/home/me/mine.sh"}}', '{"a":1,}']) {
      const s = setup(settings);
      expect(ensureAgyStatusLine({ ...s.o, platform: "win32" })).toContain("aren't shown on Windows");
      expect(existsSync(s.script)).toBe(false);
      expect(existsSync(s.file) ? readFileSync(s.file, "utf8") : undefined).toBe(settings);
    }
  });

  test.skipIf(process.platform === "win32")("agy rewriting the file between the read and the replace is not overwritten (compare and swap): a note, the file as agy left it, no script claimed", () => {
    const s = setup('{"theme":"dark"}');
    const note = ensureAgyStatusLine({ ...s.o, onStaged: () => writeFileSync(s.file, '{"theme":"light"}') });
    expect(note).toContain("changed its settings");
    expect(read(s.file)).toEqual({ theme: "light" });
    // The next launch finds the new state and adds the line.
    expect(ensureAgyStatusLine(s.o)).toBeNull();
    expect(read(s.file)).toMatchObject({ theme: "light", statusLine: { command: s.script } });
  });
});

describe("removing it (gluon uninstall)", () => {
  test.skipIf(process.platform === "win32")("only Gluon's own statusLine goes (the command exactly ours), with its script; the rest of the settings stays; a user's own line stays", () => {
    const s = setup('{"theme":"dark"}');
    ensureAgyStatusLine(s.o);
    expect(agyStatusLineInstalled(s.o)).toBe(s.file);
    expect(removeAgyStatusLine(s.o)).toEqual([`${s.file} (Gluon's statusLine)`, s.script]);
    expect(read(s.file)).toEqual({ theme: "dark" });
    expect(existsSync(s.script)).toBe(false);
    expect(agyStatusLineInstalled(s.o)).toBeNull();
    expect(removeAgyStatusLine(s.o)).toEqual([]);
    const own = setup('{"statusLine":{"command":"/home/me/mine.sh"},"theme":"x"}');
    expect(removeAgyStatusLine(own.o)).toEqual([]);
    expect(read(own.file).statusLine).toEqual({ command: "/home/me/mine.sh" });
    // A file that stopped being strict JSON is left alone (the script still goes).
    const broken = setup('{"a":1,}');
    expect(removeAgyStatusLine(broken.o)).toEqual([]);
    expect(readFileSync(broken.file, "utf8")).toBe('{"a":1,}');
  });
});

describe("BUG-351: install then removal is a splice of one member", () => {
  const inline = (s: ReturnType<typeof setup>) => `{"command":${JSON.stringify(s.script)},"stack_with_default":true,"type":"command"}`;
  test.skipIf(process.platform === "win32")("BUG-351/exact-original-bytes: odd formatting, key order, unicode, CRLF, a nested statusLine, an empty object, a trailing newline or none: removal gives back the original bytes", () => {
    const cases = [
      '{\n\t"zeta" : {"b":1,\n"a":[1,2]} ,\n\t"n\u00e5me":"é ☃ \\u00e9 😀",\n\t"theme" :"dark"\n}\n',
      '{"b":1,"a":2}',
      '  {"x":{"statusLine":"not ours","a":[{"statusLine":1}]},"y":"}"} \n\n',
      '{\r\n  "a": 1,\r\n  "b": [\r\n    2\r\n  ]\r\n}\r\n',
      "{}",
      "{ }\n",
      "{\n}\n",
      '{"a":"\\"statusLine\\": {,}","k":-1.50e+2}',
    ];
    for (const original of cases) {
      const s = setup(original);
      expect(ensureAgyStatusLine(s.o)).toBeNull();
      const installed = readFileSync(s.file, "utf8");
      expect(installed).not.toBe(original);
      expect(read(s.file).statusLine).toEqual({ command: s.script, stack_with_default: true, type: "command" });
      expect(removeAgyStatusLine(s.o)).toEqual([`${s.file} (Gluon's statusLine)`, s.script]);
      expect(readFileSync(s.file, "utf8")).toBe(original);
    }
  });

  test.skipIf(process.platform === "win32")("BUG-351/edits-in-between-stay: what the user changed after the install stays, only statusLine goes (last, middle, first and only member)", () => {
    const s = setup('{\n  "a": 1,\n  "theme": "dark"\n}\n');
    ensureAgyStatusLine(s.o);
    const edited = readFileSync(s.file, "utf8").replace('"theme": "dark"', '"theme": "light", "new": [1,\n 2]').replace('{\n  "a"', '{\n  "editor": "vim",\n  "a"');
    writeFileSync(s.file, edited);
    expect(removeAgyStatusLine(s.o)[0]).toBe(`${s.file} (Gluon's statusLine)`);
    expect(readFileSync(s.file, "utf8")).toBe('{\n  "editor": "vim",\n  "a": 1,\n  "theme": "light", "new": [1,\n 2]\n}\n');
    // agy rewrote the file in its own form (sorted keys) with the line in the middle or first; it goes alone.
    for (const [text, rest] of [
      ['{\n  "a": 1,\n  "statusLine": {"command": "S"},\n  "z": {"k": "v"}\n}\n', '{\n  "a": 1,\n  "z": {"k": "v"}\n}\n'],
      ['{\n  "statusLine": {"command": "S"},\n  "z": 2\n}\n', '{\n  "z": 2\n}\n'],
      ['{"statusLine":{"command":"S"},"z":2}', '{"z":2}'],
      ['{\n  "statusLine": {\n    "command": "S"\n  }\n}\n', "{\n}\n"],
    ] as const) {
      const m = setup(text.replace("S", "PLACEHOLDER"));
      writeFileSync(m.file, text.replace("S", m.script));
      expect(removeAgyStatusLine(m.o)[0]).toBe(`${m.file} (Gluon's statusLine)`);
      expect(readFileSync(m.file, "utf8")).toBe(rest);
    }
  });

  test.skipIf(process.platform === "win32")("a twice-named statusLine, or an install over the user's own, writes nothing; a file changed after the read (content or only its mtime) is not overwritten", () => {
    const twice = '{"statusLine":{"command":"/mine"},"a":1,"statusLine":{"command":"/mine2"}}';
    const t = setup(twice);
    expect(ensureAgyStatusLine(t.o)).toContain("a status line of your own");
    expect(readFileSync(t.file, "utf8")).toBe(twice);
    // Ours (stale form) is replaced in place, the bytes around it stay.
    const old = setup();
    writeFileSync(old.file, `{ "a" : 1 , "statusLine" : {"command":${JSON.stringify(old.script)}} , "b":2 }\n`);
    expect(ensureAgyStatusLine(old.o)).toBeNull();
    expect(readFileSync(old.file, "utf8")).toBe(`{ "a" : 1 , "statusLine" : ${inline(old)} , "b":2 }\n`);
    // Same content, newer mtime (agy rewrote the same bytes): not ours to replace now.
    const touched = setup('{"a":1}');
    const note = ensureAgyStatusLine({ ...touched.o, onStaged: () => utimesSync(touched.file, new Date(), new Date(Date.now() + 5000)) });
    expect(note).toContain("changed its settings");
    expect(readFileSync(touched.file, "utf8")).toBe('{"a":1}');
  });
});

describe("BUG-352: Gluon writes through no symbolic link", () => {
  test.skipIf(process.platform === "win32")("BUG-352/symlinked-parent-refused: a parent directory that is a link leading outside HOME is refused and said so (install writes nothing, removal leaves the file); one inside HOME is fine", () => {
    for (const link of ["gemini", "agy"]) {
      const s = setup();
      rmSync(join(s.home, ".gemini"), { recursive: true });
      const outside = join(TMP, `outside-${link}-${n}`);
      mkdirSync(join(outside, "antigravity-cli"), { recursive: true });
      const real = join(outside, "antigravity-cli", "settings.json");
      writeFileSync(real, '{"theme":"dark"}');
      if (link === "gemini") symlinkSync(outside, join(s.home, ".gemini"));
      else {
        mkdirSync(join(s.home, ".gemini"));
        symlinkSync(join(outside, "antigravity-cli"), join(s.home, ".gemini", "antigravity-cli"));
      }
      expect(ensureAgyStatusLine(s.o)).toMatch(/symbolic link leading outside your home/);
      expect(readFileSync(real, "utf8")).toBe('{"theme":"dark"}');
      expect(existsSync(s.script)).toBe(false);
      expect(agyStatusLineInstalled(s.o)).toBeNull();
      // Removal: the key (even if it is ours) stays; the script goes as always.
      writeFileSync(real, `{"statusLine":{"command":${JSON.stringify(s.script)}}}`);
      expect(removeAgyStatusLine(s.o)).toEqual([]);
      expect(readFileSync(real, "utf8")).toContain("statusLine");
    }
    const inside = setup();
    const dots = join(inside.home, "dotfiles", "gemini");
    mkdirSync(join(dots, "antigravity-cli"), { recursive: true });
    writeFileSync(join(dots, "antigravity-cli", "settings.json"), '{"theme":"dark"}');
    rmSync(join(inside.home, ".gemini"), { recursive: true });
    symlinkSync(dots, join(inside.home, ".gemini"));
    expect(ensureAgyStatusLine(inside.o)).toBeNull();
    expect(readFileSync(join(dots, "antigravity-cli", "settings.json"), "utf8")).toContain('"statusLine"');
  });

  test.skipIf(process.platform === "win32")("BUG-352/symlinked-script-refused: a link at the status-line script's path is refused and said so; its target and the settings stay untouched", () => {
    const s = setup('{"theme":"dark"}');
    mkdirSync(s.configDir, { recursive: true });
    const target = join(TMP, "somebody-elses-file");
    writeFileSync(target, "precious");
    symlinkSync(target, s.script);
    expect(ensureAgyStatusLine(s.o)).toMatch(/agy-statusline\.sh is a symbolic link/);
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(readFileSync(s.file, "utf8")).toBe('{"theme":"dark"}');
    expect(lstatSync(s.script).isSymbolicLink()).toBe(true);
  });

  test("BUG-352/windows-skipped-with-the-note: on Windows nothing is read or written, and the note says why", () => {
    const s = setup('{"theme":"dark"}');
    const note = ensureAgyStatusLine({ ...s.o, platform: "win32" });
    expect(note).toContain("aren't shown on Windows");
    expect(note).toContain("shell script");
    expect(readFileSync(s.file, "utf8")).toBe('{"theme":"dark"}');
    expect(existsSync(s.script)).toBe(false);
  });
});

describe("what the status line's command sends (real stdin of agy 1.2.16 against a mock gateway)", () => {
  const stdin = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "telemetry", "agy-1.2.16-statusline-stdin.json"), "utf8")) as { statusline: Record<string, unknown> }[];

  test("a gateway model has no cost and an unknown window: no figure of agy's own is sent (never a 0%); its token totals (the conversation's size) are, for Gluon to size", () => {
    for (const { statusline } of stdin) {
      const st = agyStatus(statusline);
      expect(st.costUsd).toBeUndefined();
      expect(st.contextTokens).toBeUndefined();
      expect(st.contextWindow).toBeUndefined();
      expect(st.model).toBe("mock-model");
    }
    expect(agyStatus(stdin[0]!.statusline)).toEqual({ model: "mock-model", totals: { input: 0, output: 0 } });
    // current_usage (the last request's prompt) is not read: the size is the total.
    expect(agyStatus(stdin[4]!.statusline)).toEqual({ model: "mock-model", totals: { input: 13_201, output: 200 } });
    expect(agyStatus(stdin.at(-1)!.statusline).totals).toEqual({ input: 13_740, output: 460 });
  });

  test("BUG-350/reported-figures-ledger-only: agy's own cost, percentage and window leave only as the reported fields (the ledger's), beside the totals; a bad or absent one is dropped", () => {
    const real = { model: { id: "gemini-3.8-flash" }, cost: { total_usd: 0.4321 }, context_window: { context_window_size: 1_000_000, used_percentage: 12.5, total_input_tokens: 99, total_output_tokens: 9, current_usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 } } };
    expect(agyStatus(real)).toEqual({ model: "gemini-3.8-flash", costUsd: 0.4321, contextWindow: 1_000_000, contextTokens: 125_000, totals: { input: 99, output: 9 } });
    for (const bad of [{ model: { id: "x y" } }, { model: "x" }, { context_window: { total_input_tokens: 5 } }, { context_window: { total_input_tokens: -5, total_output_tokens: 1 } }]) {
      const st = agyStatus(bad as never);
      expect([st.model, st.totals]).toEqual([undefined, undefined]);
    }
  });

  test("with a window and a cost (agy's own fields): reported as its percentage of its window, and its own cost", () => {
    const real = { cost: { total_usd: 0.4321, subagent_usd: 0.1, estimated: true }, context_window: { context_window_size: 1_000_000, used_percentage: 12.5, total_input_tokens: 99, current_usage: null } };
    expect(agyStatus(real)).toEqual({ costUsd: 0.4321, contextWindow: 1_000_000, contextTokens: 125_000 });
    for (const bad of [{ cost: { total_usd: -1 } }, { cost: null }, { context_window: { context_window_size: 0, used_percentage: 50 } }, { context_window: { context_window_size: 10, used_percentage: 500 } }, { context_window: "x" }, "x"]) expect(agyStatus(bad as never)).toEqual({});
  });

  test("the hook answers `statusline` with one status event, nothing for anything else, and never prints", async () => {
    const r = await antigravity.hook!("statusline", JSON.stringify({ cost: { total_usd: 2 }, context_window: { context_window_size: 200, used_percentage: 50 } }), { eventsDir: "/x", pieces: [] });
    expect(r.stdout).toBeUndefined();
    expect(r.events!.map((e) => parseEvent(`status ${JSON.stringify(e.status)}`)!.status)).toEqual([{ costUsd: 2, contextTokens: 100, contextWindow: 200 }]);
    // The totals survive the event's strict parse; a negative one refuses the event.
    const t = await antigravity.hook!("statusline", JSON.stringify({ model: { id: "m" }, context_window: { total_input_tokens: 7, total_output_tokens: 3, current_usage: { input_tokens: 4 } } }), { eventsDir: "/x", pieces: [] });
    expect(t.events!.map((e) => parseEvent(`status ${JSON.stringify(e.status)}`)!.status)).toEqual([{ model: "m", totals: { input: 7, output: 3 } }]);
    expect(parseEvent(`status ${JSON.stringify({ totals: { input: -1, output: 0 } })}`)).toBeNull();
    expect(await antigravity.hook!("statusline", "not json", { eventsDir: "/x", pieces: [] })).toEqual({});
    expect(await antigravity.hook!("other", "{}", { eventsDir: "/x", pieces: [] })).toEqual({});
  });
});

describe("BUG-404/405: the script and the key go together", () => {
  const dup = (s: ReturnType<typeof setup>) => `{"statusLine":{"command":${JSON.stringify(s.script)}},"statusLine":{"command":${JSON.stringify(s.script)}}}`;

  test.skipIf(process.platform === "win32")("BUG-405/no-orphan-script: a layout the splice can't take (the key twice), and a settings file agy rewrites meanwhile, leave no script Gluon just wrote; one that was already there stays", () => {
    const twice = setup("{}");
    writeFileSync(twice.file, dup(twice));
    expect(ensureAgyStatusLine(twice.o)).toContain("a layout Gluon can't add");
    expect(existsSync(twice.script)).toBe(false);
    const raced = setup('{"theme":"dark"}');
    expect(ensureAgyStatusLine({ ...raced.o, onStaged: () => writeFileSync(raced.file, '{"theme":"light"}') })).toContain("changed its settings");
    expect(existsSync(raced.script)).toBe(false);
    // A script from an earlier launch is not this call's to remove.
    const earlier = setup('{"theme":"dark"}');
    ensureAgyStatusLine(earlier.o);
    writeFileSync(earlier.file, '{"theme":"dark"}');
    expect(ensureAgyStatusLine({ ...earlier.o, onStaged: () => writeFileSync(earlier.file, '{"theme":"light"}') })).toContain("changed its settings");
    expect(existsSync(earlier.script)).toBe(true);
  });

  test.skipIf(process.platform === "win32")("BUG-404/script-stays-with-its-key: when the key can't be removed (a layout the splice can't take, or agy rewriting the file meanwhile) the script stays, the key is still reported installed, and a later removal finishes", () => {
    const twice = setup("{}");
    ensureAgyStatusLine(twice.o);
    writeFileSync(twice.file, dup(twice));
    expect(removeAgyStatusLine(twice.o)).toEqual([]);
    expect(existsSync(twice.script)).toBe(true);
    expect(agyStatusLineInstalled(twice.o)).toBe(twice.file);
    const raced = setup('{"theme":"dark"}');
    ensureAgyStatusLine(raced.o);
    expect(removeAgyStatusLine({ ...raced.o, onStaged: () => writeFileSync(raced.file, `{"theme":"light","statusLine":{"command":${JSON.stringify(raced.script)}}}`) })).toEqual([]);
    expect(existsSync(raced.script)).toBe(true);
    expect(agyStatusLineInstalled(raced.o)).toBe(raced.file);
    expect(removeAgyStatusLine(raced.o)).toEqual([`${raced.file} (Gluon's statusLine)`, raced.script]);
  });
});
