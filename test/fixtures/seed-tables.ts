/**
 * The price and window tables of a test (issue #89): none ships in `src/`, Gluon keeps its tables in the local
 * store (`src/cost/tables-store.ts`), so a test that needs prices seeds the store of the state directory it runs
 * with from `test/fixtures/tables/` (frozen copies, test-only: never shipped). `test/preload.ts` seeds the run's
 * own `XDG_STATE_HOME` before anything loads `tables.ts`; the e2e harness (`baseEnv`) seeds the state directory
 * of each app it spawns, source or compiled binary.
 * `GLUON_TEST_TABLES_FROM=<dir>` seeds from that directory instead (the four files, all required): a manual
 * price refresh runs the coverage tests of `test/cost.test.ts` against the tables it just built from the live sources.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const TABLE_FIXTURES_DIR = join(import.meta.dir, "tables");
export const FIXTURE_TABLE_FILES = ["modelsdev.json", "claude-catalog.json", "codex-windows.json", "grok-models.json"] as const;

/** Copies the fixture tables (or `GLUON_TEST_TABLES_FROM`'s) into `dir` (a `tablesDir()`), each unless it is already there. */
export function seedTables(dir: string, from: string = process.env.GLUON_TEST_TABLES_FROM || TABLE_FIXTURES_DIR): void {
  mkdirSync(dir, { recursive: true });
  for (const f of FIXTURE_TABLE_FILES) {
    const to = join(dir, f);
    if (!existsSync(to)) copyFileSync(join(from, f), to);
  }
}

export const fixtureTablePath = (file: (typeof FIXTURE_TABLE_FILES)[number]): string => join(TABLE_FIXTURES_DIR, file);
