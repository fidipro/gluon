/**
 * scripts/codex-drift.ts: what a codex release gives the ChatGPT-plan intake agent of its own (codex-watch.yml).
 * Logic on fixtures, and the tool check against the fake codex (never a real one).
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTools, drift, drifted, itemTypes, report, requestTools, toolCheck, type ToolCheck } from "../scripts/codex-drift.ts";
import { BRAIN_ITEMS, CODEX_FEATURES_KEPT, CODEX_FEATURES_OFF, featuresToDisable, FOREIGN_ITEMS } from "../src/agent/codex.ts";
import { TOOLS } from "../src/agent/tools.ts";
import { SLOW } from "./fixtures/slow.ts";

const LIST = readFileSync(join(import.meta.dir, "fixtures", "codex-features-list.txt"), "utf8");
/** The list as codex prints it with these names turned off, but for `forced` (codex forces unified_exec on). */
const withOff = (list: string, off: string[], forced = ["unified_exec"]) =>
  list
    .trim()
    .split("\n")
    .map((row) => {
      const [name, stage, on] = row.trim().split(/\s{2,}/);
      return `${name!.padEnd(40)} ${stage!.padEnd(18)} ${off.includes(name!) && !forced.includes(name!) ? "false" : on}`;
    })
    .join("\n");
const OWN = TOOLS.map((t) => t.name);
/** A request body in codex's shape: Gluon's tools in `input` (as gpt-6-astra gets them), `top` as tools of its own. */
const body = (names = OWN, top: object[] = []) => ({ model: "m", input: [{ type: "additional_tools", tools: [{ type: "namespace", name: "functions", tools: names.map((name) => ({ type: "function", name })) }] }], tools: top });
const CATALOG = JSON.stringify({ models: [{ slug: "gpt-6-luna", display_name: "x", tool_mode: "code_mode_only" }] });
const ITEMS = [...BRAIN_ITEMS, ...FOREIGN_ITEMS];

test("the checked codex (the fixture's list, a known catalog, known item types, Gluon's tools only) has no drift; its new features are noted", () => {
  const d = drift("0.162.1", LIST, withOff(LIST, featuresToDisable(LIST)), CATALOG, ITEMS, [checkTools("gpt-6.1-sol", [body()], null)]);
  // The fixture's features that are on and in neither of Gluon's lists: noted as turned off.
  const fresh = LIST.trim().split("\n").map((l) => l.trim().split(/\s{2,}/)).filter(([n, stage, on]) => on === "true" && stage !== "removed" && !CODEX_FEATURES_OFF.includes(n!) && !(n! in CODEX_FEATURES_KEPT)).map(([n]) => n!);
  expect(d).toEqual({ version: "0.162.1", features: [], catalogFields: [], newOff: fresh, tools: [], catalog: null, items: [], gone: [] });
  expect(drifted(d)).toBe(false);
  expect(report(d)).toContain("Nothing to do for the intake agent");
  expect(report(d)).toContain("turned off unchecked");
});

test("a catalog Gluon can't read or a new item type is drift; a feature codex keeps on, an unchecked catalog field and a new feature are noted, as the brain runs with them", () => {
  const list = `${LIST.trim()}\nhosted_agent_tools                       stable             true\nnext_new_mode                            stable             true`;
  const catalog = JSON.stringify({ models: [{ slug: "gpt-6-luna", hosted_tools: ["computer"] }] });
  const noted = drift("0.170.0", list, withOff(list, featuresToDisable(list), ["unified_exec", "hosted_agent_tools"]), catalog, ITEMS);
  expect(noted.features).toEqual(["hosted_agent_tools"]);
  expect(noted.catalogFields).toEqual(["hosted_tools"]);
  expect(noted.newOff).toContain("next_new_mode");
  expect(drifted(noted)).toBe(false);
  for (const s of ["`hosted_agent_tools`", "CODEX_FEATURES_KEPT", "`hosted_tools`", "CATALOG_FIELDS", "`next_new_mode`"]) expect(report(noted)).toContain(s);
  const d = drift("0.170.0", list, withOff(list, featuresToDisable(list)), "not json", [...ITEMS, "remoteShell"]);
  expect(d.catalog).toContain("isn't JSON");
  expect(d.items).toEqual(["remoteShell"]);
  expect(drifted(d)).toBe(true);
  const text = report(d);
  for (const s of ["## codex 0.170.0", "Model catalog", "`remoteShell`", "FOREIGN_ITEMS", "codex-features-list.txt"]) expect(text).toContain(s);
});

test("the tools in a model request are read wherever codex puts them: top-level `tools`, inside `input`, in namespaces", () => {
  expect(requestTools(body(["grep"], [{ type: "web_search" }, { type: "function", name: "exec_command" }]))).toEqual(["function:grep", "web_search:", "function:exec_command"]);
  expect(requestTools({ model: "m", input: [{ type: "message", content: [{ type: "input_text", text: "tools" }] }] })).toEqual([]);
});

test("a model request with a tool of codex's own, without one of Gluon's, or none at all is drift, and models with the same result share a line", () => {
  expect(checkTools("a", [body()], null)).toEqual({ model: "a", extra: [], missing: [], error: null });
  expect(checkTools("a", [body(OWN, [{ type: "function", name: "get_goal" }])], null).extra).toEqual(["function:get_goal"]);
  expect(checkTools("a", [body(OWN.slice(1))], null).missing).toEqual([`function:${OWN[0]}`]);
  expect(checkTools("a", [], null).error).toBe("codex sent no model request");
  expect(checkTools("a", [], "codex app-server stopped").error).toBe("codex app-server stopped");
  const goal = (m: string): ToolCheck => checkTools(m, [body(OWN, [{ type: "function", name: "get_goal" }])], null);
  const d = drift("0.170.0", LIST, withOff(LIST, featuresToDisable(LIST)), CATALOG, ITEMS, [goal("gpt-6.1-sol"), goal("gpt-6-luna"), checkTools("gpt-5.5", [body()], null)]);
  expect(drifted(d)).toBe(true);
  expect(d.tools.map((t) => t.model)).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
  const lines = report(d).split("\n").filter((l) => l.includes("get_goal"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("`gpt-6.1-sol`, `gpt-6-luna`");
});

test("the tool check runs the brain against a local provider and reads what codex sent: Gluon's tools pass, a tool of codex's own is caught", async () => {
  const FAKE = join(import.meta.dir, "fixtures", "fake-codex-app-server.ts");
  const dir = mkdtempSync(join(tmpdir(), "gluon-drift-test-"));
  const home = join(dir, "home");
  mkdirSync(home);
  try {
    expect(await toolCheck(["bun", FAKE], ["gpt-6-sol"], dir, home)).toEqual([{ model: "gpt-6-sol", extra: [], missing: [], error: null }]);
    const own = await toolCheck(["bun", FAKE], ["gpt-6-sol"], dir, home, { extraEnv: { FAKE_CODEX_EXTRA_TOOLS: "exec_command" } });
    expect(own).toEqual([{ model: "gpt-6-sol", extra: ["function:exec_command"], missing: [], error: null }]);
    // A model whose turn never ends is that model's error; the next model is still checked, and passes.
    const hang = await toolCheck(["bun", FAKE], ["gpt-6-sol", "gpt-6-luna"], dir, home, { timeoutMs: 1500 * SLOW, extraEnv: { FAKE_CODEX_HANG_MODEL: "gpt-6-sol" } });
    expect(hang).toEqual([
      { model: "gpt-6-sol", extra: [], missing: [], error: expect.stringContaining("no answer from codex") },
      { model: "gpt-6-luna", extra: [], missing: [], error: null },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name of CODEX_FEATURES_OFF the codex no longer lists is noted, not drift (only known names are passed)", () => {
  const list = LIST.split("\n")
    .filter((row) => !row.startsWith("chronicle "))
    .join("\n");
  const d = drift("0.170.0", list, withOff(list, featuresToDisable(list)), CATALOG, ITEMS);
  expect(d.gone).toEqual(["chronicle"]);
  expect(drifted(d)).toBe(false);
  expect(report(d)).toContain("`chronicle`");
});

test("names codex printed can't format, link or mention in the issue", () => {
  const d = { version: "0.170.0", features: ["x`<b>@team"], catalogFields: ["y@team"], newOff: [], tools: [{ model: "m@team", extra: ["function:<b>"], missing: [], error: "[x](http://y) @z" }], catalog: "fields (`a`, @b)", items: ["[link](http://x)"], gone: [] };
  const text = report(d);
  expect(text).toContain("`x??b??team`");
  expect(text).not.toMatch(/@team|@b|\]\(/);
});

test("item types are read from generate-json-schema's bundle, wherever ThreadItem sits", () => {
  const variant = (type: string) => ({ type: "object", properties: { type: { type: "string", enum: [type] } } });
  expect(itemTypes({ definitions: { v2: { ThreadItem: { oneOf: [variant("agentMessage"), variant("commandExecution")] } } } })).toEqual(["agentMessage", "commandExecution"]);
  expect(() => itemTypes({ definitions: {} })).toThrow(/no ThreadItem/);
});
