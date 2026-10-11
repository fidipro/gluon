/** The setup screens' menus (`src/ui/signin.tsx`): fitting a short terminal, a long checklist. */
import { describe, expect, test } from "bun:test";
import { fitMenu, PickMany } from "../src/ui/signin.tsx";
import { makeTheme } from "../src/ui/theme.ts";
import { inkTerm } from "./fixtures/ink-term.tsx";

const theme = makeTheme(null);

test("BUG-58/4.4: a menu fits in the terminal: margins go, then the body is clipped, then the list scrolls", () => {
  const body = Array.from({ length: 8 }, (_, i) => `line ${i}`);
  const items = Array(10).fill(1);
  expect(fitMenu({ columns: 80, rows: 40, title: "T", body, items, cursor: 0, footer: true })).toEqual({ compact: false, bodyRows: null, window: { start: 0, end: 10 } });
  const tight = fitMenu({ columns: 80, rows: 15, title: "T", body, items, cursor: 0, footer: true });
  expect(tight.compact).toBe(true);
  expect(tight.bodyRows).toBe(2);
  const tiny = fitMenu({ columns: 80, rows: 8, title: "T", body, items, cursor: 9, footer: true });
  expect(tiny.bodyRows).toBe(0);
  expect(tiny.window.end).toBe(10);
  expect(tiny.window.end - tiny.window.start).toBeLessThanOrEqual(8 - 1 - 2 - 1);
});

describe("a long checklist (a list of twelve: no setup list has that many rows any more)", () => {
  const options = Array.from({ length: 12 }, (_, i) => ({ label: `Provider ${i + 1}`, description: `KEY_${i + 1}` }));
  const shown = (columns: number, rows: number) => inkTerm(<PickMany theme={theme} title="Which providers?" options={options} onDone={() => {}} />, { columns, rows });

  test("BUG-62/2.6: numbers right-aligned, '1' then '0' checks row 10, the hint is true", async () => {
    const t = await shown(80, 30);
    expect(t.text()).toContain("space or 1-12 to check");
    const col = (label: string) => t.text().split("\n").find((l) => l.includes(label))!.indexOf("[ ]");
    expect(col("Provider 1 ")).toBe(col("Provider 10"));
    await t.keys("1");
    await t.keys("0");
    expect(t.text()).toMatch(/10\. \[x\] Provider 10/);
    expect(t.text()).toMatch(/ 1\. \[ \] Provider 1 /);
    t.unmount();
  });

  test("BUG-58/4.4: at 60×12 the list scrolls with the cursor, the title stays", async () => {
    const t = await shown(60, 12);
    for (let i = 0; i < 9; i++) await t.keys("\x1b[B");
    expect(t.text()).toMatch(/› 10\. \[ \] Provider 10/);
    expect(t.text()).toContain("Which providers?");
    t.unmount();
  });
});
