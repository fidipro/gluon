/** How a setup menu fits a short terminal (`src/ui/menu-fit.ts`); the menus themselves are tested end to end (auth.e2e). */
import { expect, test } from "bun:test";
import { fitMenu } from "../src/ui/menu-fit.ts";

test("setup/menus-fit: a menu fits in the terminal: margins go, then the body is clipped, then the list scrolls #BUG-58/4.4", () => {
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
