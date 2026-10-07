/**
 * The fixture tables as objects (`test/fixtures/tables/*.json`, frozen copies: Gluon ships no table). What a test reads
 * from the registry (`currentTables()`) is the same data, seeded into the run's local store (`seed-tables.ts`); a test that
 * compares, clones or rebuilds a table takes it from here and never from the process state.
 */
import claudeCatalog from "./tables/claude-catalog.json" with { type: "json" };
import codexWindows from "./tables/codex-windows.json" with { type: "json" };
import grokModels from "./tables/grok-models.json" with { type: "json" };
import modelsdev from "./tables/modelsdev.json" with { type: "json" };
import { GROK_OBSERVED_WINDOWS, type ClaudeCatalog, type CodexWindowsTable, type GrokModelsTable, type GrokObservedWindowsTable, type ModelsDevTable } from "../../src/cost/tables.ts";

export const FIXTURE_MODELS_DEV = modelsdev as unknown as ModelsDevTable;
export const FIXTURE_CLAUDE_CATALOG = claudeCatalog as unknown as ClaudeCatalog;
export const FIXTURE_CODEX_WINDOWS = codexWindows as unknown as CodexWindowsTable;
export const FIXTURE_GROK_MODELS = grokModels as unknown as GrokModelsTable;

/** By table name (`TableName`): the four fixtures and the repository's observed Grok windows. */
export const FIXTURE_TABLES = { modelsdev: FIXTURE_MODELS_DEV, "claude-catalog": FIXTURE_CLAUDE_CATALOG, "codex-windows": FIXTURE_CODEX_WINDOWS, "grok-models": FIXTURE_GROK_MODELS, "grok-observed-windows": GROK_OBSERVED_WINDOWS as GrokObservedWindowsTable };
