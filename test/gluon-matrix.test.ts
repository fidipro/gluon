/**
 * Gluon's coverage matrix is whole (`test/fixtures/gluon-matrix.ts`): every cell resolved, every
 * `na` with its reason, every hand-written case a test that exists and every such test known; and
 * nothing Gluon reads is missing from its inputs — the keys `route()` decides on, the `?` key
 * list's keys, the return keys, the readers. `GLUON_MATRIX_REPORT=1` prints the coverage per state.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createKeyDecoder, RETURN_KEYS } from "../src/pty/keys.ts";
import { READERS } from "../src/pty/readers/index.ts";
import { keyGroups } from "../src/ui/layout.ts";
import { bytesOf } from "./e2e/actions.ts";
import { BEYOND, HARNESS_OF_ID, INPUTS, inputAction, KEY_GROUP_INPUTS, matches, REF, resolve, rules, screenOf, STATES, type Cell } from "./fixtures/gluon-matrix.ts";

const table = resolve();
const cells = [...table].flatMap(([s, row]) => [...row].map(([i, cell]) => ({ s, i, cell })));

/** Every test title under test/: the first argument of `test(`, `test.skipIf(…)(`, … */
const TITLES = (() => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
  const titles: string[] = [];
  for (const file of walk(import.meta.dir)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\btest(?:\.\w+(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) titles.push(m[2]!);
  }
  return titles;
})();

/** The case ids a text names: `GLUON-12`, `GM-…`, `BUG-50/4.2`. */
const PLAN_IDS = /\b(GLUON-\d+|GM-[\w.]*\w)(?![\w-])/g;
const named = (id: string) => {
  const re = new RegExp(`(^|[^\\w-])${id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}($|[^\\w-])`);
  return TITLES.some((t) => re.test(t));
};

test("the test titles are found (the scan works)", () => {
  expect(TITLES.length).toBeGreaterThan(500);
  expect(TITLES.some((t) => t.startsWith("GLUON-1:"))).toBe(true);
});

test("every cell is resolved", () => {
  expect(cells.filter((c) => !c.cell).map((c) => `${c.s} × ${c.i}`).slice(0, 20)).toEqual([]);
});

test("every na says why", () => {
  expect(cells.filter((c) => c.cell && "na" in c.cell && c.cell.na.trim().length < 15).map((c) => `${c.s} × ${c.i}`)).toEqual([]);
});

test("every expectation's input can be done on its state's screen: a mouse input has a target there, its report an encoding that carries it", () => {
  // The runners would fail such a cell (`no target for this input on this screen`): only
  // `bun run test:gluon-full` reaches most of them, so a wrong rule must fail here first.
  const bad = cells.flatMap(({ s, i, cell }) => {
    if (!cell || !("expect" in cell)) return [];
    const at = screenOf(s);
    const a = at && inputAction(i, at);
    if (!a) return [`${s} × ${i}: no target for this input on this screen`];
    try {
      bytesOf(a.action, a.encoding);
    } catch (e) {
      return [`${s} × ${i}: ${(e as Error).message}`];
    }
    return [];
  });
  expect(bad.length ? [`${bad.length} cells`, ...bad.slice(0, 20)] : []).toEqual([]);
});

test("every rule's selectors match something (a selector that matches nothing is a typo)", () => {
  const dead = rules().flatMap((r, n) => [
    ...(matches(r.states, STATES).length ? [] : [`rule ${n}: states ${String(r.states)}`]),
    ...(matches(r.inputs, INPUTS).length ? [] : [`rule ${n}: inputs ${String(r.inputs)}`]),
  ]);
  expect(dead).toEqual([]);
});

test("every case cell names a test that exists", () => {
  const cases = new Set([...cells.flatMap((c) => (c.cell && "case" in c.cell ? [c.cell.case] : [])), ...Object.keys(BEYOND)]);
  expect([...cases].filter((id) => !named(id))).toEqual([]);
});

test("every GLUON-… / GM-… id a test title names is in the matrix", () => {
  const known = new Set([...cells.flatMap((c) => (c.cell && "case" in c.cell ? [...c.cell.case.matchAll(PLAN_IDS)].map((m) => m[1]!) : [])), ...Object.keys(BEYOND)]);
  const inTitles = new Set(TITLES.flatMap((t) => [...t.matchAll(PLAN_IDS)].map((m) => m[1]!)));
  expect([...inTitles].filter((id) => !known.has(id)).sort()).toEqual([]);
});

describe("nothing Gluon reads is missing from the inputs", () => {
  /** What the decoder makes of each input that sends bytes: the key names the inputs cover. */
  const decoded = (() => {
    const names = new Set<string>();
    for (const id of INPUTS) {
      const a = inputAction(id, { ...REF, strip: { home: [0, 9], tabs: [{ id: 1, x0: 9, x1: 30 }], prev: { id: 0, x0: 9, x1: 12 }, next: { id: 2, x0: 95, x1: 100 } } });
      if (!a) continue;
      let bytes = "";
      try {
        bytes = bytesOf(a.action, a.encoding);
      } catch {
        continue; // a report the encoding can't carry (X10 past column 95)
      }
      const d = createKeyDecoder("ctrl+\\");
      for (const k of [...d.feed(bytes), ...d.flush()]) names.add(k.name);
    }
    return names;
  })();

  test("every key name route() decides on", () => {
    const src = readFileSync(join(import.meta.dir, "../src/pty/compositor.ts"), "utf8");
    const body = src.slice(src.indexOf("export function route("), src.indexOf("\n}\n", src.indexOf("export function route(")));
    const routed = new Set([...body.matchAll(/case "([\w-]+)":/g), ...body.matchAll(/k\.name === "([\w-]+)"/g)].map((m) => m[1]!));
    expect(routed.size).toBeGreaterThan(8);
    expect([...routed].filter((n) => !decoded.has(n))).toEqual([]);
  });

  test("every key the `?` key list names", () => {
    const labels = new Set(keyGroups("ctrl+\\", true).flatMap((g) => g.keys.map(([key]) => key)));
    expect([...labels].filter((l) => !KEY_GROUP_INPUTS[l])).toEqual([]);
    const all = new Set<string>(INPUTS);
    expect(Object.values(KEY_GROUP_INPUTS).flat().filter((i) => !all.has(i))).toEqual([]);
  });

  test("every return key `handoff.key` may name", () => {
    const sent = new Set(INPUTS.flatMap((id) => (id.startsWith("k.") ? [bytesOf(inputAction(id)!.action)] : [])));
    expect(Object.entries(RETURN_KEYS).filter(([, byte]) => !sent.has(String.fromCharCode(byte))).map(([spec]) => spec)).toEqual([]);
  });

  test("every harness with a reader has its session states", () => {
    const covered = new Set(Object.values(HARNESS_OF_ID));
    // Kimi Code's frame behaviour (the typed brief, /clear and /compact asking, its menu) is in `test/e2e/gluon-more.e2e.test.ts` ("Kimi Code:" scenarios), not yet cells of the matrix.
    expect(Object.keys(READERS).filter((h) => !covered.has(h as never) && h !== "kimi-code")).toEqual([]);
    for (const [id] of Object.entries(HARNESS_OF_ID)) expect(STATES.some((s) => s.startsWith(`s.${id}.`))).toBe(true);
  });
});

test.if(!!process.env.GLUON_MATRIX_REPORT)("the coverage report", () => {
  const kind = (c: Cell | undefined) => (!c ? "unresolved" : "na" in c ? "na" : "case" in c ? "case" : c.tier);
  const rows: Record<string, Record<string, number>> = {};
  for (const { s, cell } of cells) {
    const row = (rows[s] ??= { unit: 0, e2e: 0, smoke: 0, case: 0, na: 0, unresolved: 0 });
    row[kind(cell)]!++;
  }
  console.table(rows);
  const total: Record<string, number> = {};
  for (const r of Object.values(rows)) for (const [k, n] of Object.entries(r)) total[k] = (total[k] ?? 0) + n;
  console.log(`${STATES.length} states × ${INPUTS.length} inputs = ${cells.length} cells:`, total);
});
