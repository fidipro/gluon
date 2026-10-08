/** scripts/codex-drift.ts: what a codex release has that the ChatGPT-plan intake agent hasn't classified (codex-watch.yml). Pure logic; no codex runs. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drift, drifted, itemTypes, report } from "../scripts/codex-drift.ts";
import { BRAIN_ITEMS, CODEX_FEATURES_OFF, FOREIGN_ITEMS } from "../src/agent/codex.ts";

const LIST = readFileSync(join(import.meta.dir, "fixtures", "codex-features-list.txt"), "utf8");
/** The list as codex prints it with these names turned off (unified_exec stays on, as codex forces it). */
const withOff = (list: string, off: string[]) =>
  list
    .trim()
    .split("\n")
    .map((row) => {
      const [name, stage, on] = row.trim().split(/\s{2,}/);
      return `${name!.padEnd(40)} ${stage!.padEnd(18)} ${off.includes(name!) && name !== "unified_exec" ? "false" : on}`;
    })
    .join("\n");
const CATALOG = JSON.stringify({ models: [{ slug: "gpt-6-luna", display_name: "x", tool_mode: "code_mode_only" }] });
const ITEMS = [...BRAIN_ITEMS, ...FOREIGN_ITEMS];

test("the checked codex (the fixture's list, a known catalog, known item types) has no drift", () => {
  const d = drift("0.161.0", LIST, withOff(LIST, CODEX_FEATURES_OFF), CATALOG, ITEMS);
  expect(d).toEqual({ version: "0.161.0", features: [], catalog: null, items: [], gone: [] });
  expect(drifted(d)).toBe(false);
  expect(report(d)).toContain("Nothing new for the intake agent");
});

test("a new enabled feature, catalog field or item type is drift, and the report says where each goes", () => {
  const list = `${LIST.trim()}\nhosted_agent_tools                       stable             true`;
  const catalog = JSON.stringify({ models: [{ slug: "gpt-6-luna", hosted_tools: ["computer"] }] });
  const d = drift("0.170.0", list, withOff(list, CODEX_FEATURES_OFF), catalog, [...ITEMS, "remoteShell"]);
  expect(d.features).toEqual(["hosted_agent_tools"]);
  expect(d.catalog).toContain("hosted_tools");
  expect(d.items).toEqual(["remoteShell"]);
  expect(drifted(d)).toBe(true);
  const text = report(d);
  for (const s of ["## codex 0.170.0", "`hosted_agent_tools`", "CODEX_FEATURES_OFF", "CATALOG_FIELDS", "`remoteShell`", "FOREIGN_ITEMS", "codex-features-list.txt"]) expect(text).toContain(s);
});

test("a name of CODEX_FEATURES_OFF the codex no longer lists is noted, not drift (only known names are passed)", () => {
  const list = LIST.split("\n")
    .filter((row) => !row.startsWith("chronicle "))
    .join("\n");
  const d = drift("0.170.0", list, withOff(list, CODEX_FEATURES_OFF), CATALOG, ITEMS);
  expect(d.gone).toEqual(["chronicle"]);
  expect(drifted(d)).toBe(false);
  expect(report(d)).toContain("`chronicle`");
});

test("names codex printed can't format, link or mention in the issue", () => {
  const d = { version: "0.170.0", features: ["x`<b>@team"], catalog: "fields (`a`, @b)", items: ["[link](http://x)"], gone: [] };
  const text = report(d);
  expect(text).toContain("`x??b??team`");
  expect(text).not.toMatch(/@team|@b|\]\(/);
});

test("item types are read from generate-json-schema's bundle, wherever ThreadItem sits", () => {
  const variant = (type: string) => ({ type: "object", properties: { type: { type: "string", enum: [type] } } });
  expect(itemTypes({ definitions: { v2: { ThreadItem: { oneOf: [variant("agentMessage"), variant("commandExecution")] } } } })).toEqual(["agentMessage", "commandExecution"]);
  expect(() => itemTypes({ definitions: {} })).toThrow(/no ThreadItem/);
});
