/**
 * The prices the real captures (`test/fixtures/telemetry/`) were verified against, frozen in
 * `telemetry/prices-at-capture.json`. A replay of a captured run prices from these, never from the live
 * `src/cost/tables/*.json`: the daily refresh changes those, and a replay must not (BUG-413). Tests of the
 * live tables themselves (coverage, shape) use `src/cost/tables.ts` directly.
 */
import snapshot from "./telemetry/prices-at-capture.json" with { type: "json" };
import { CostTracker, type TrackerOptions } from "../../src/cost/tracker.ts";
import { priceEntry, type ClaudeCatalog, type GrokModelsTable, type ModelsDevTable, type PriceEntry } from "../../src/cost/tables.ts";

export const FROZEN_TABLE = snapshot.modelsdev as unknown as ModelsDevTable;
export const FROZEN_CLAUDE_CATALOG = snapshot.claudeCatalog as unknown as ClaudeCatalog;
export const FROZEN_GROK_MODELS = snapshot.grokModels as unknown as GrokModelsTable;

/** The three price tables a `CostTracker` reads, as `TrackerOptions` (the seam: nothing in `src/` knows of this file). */
export const FROZEN_PRICES: Required<Pick<TrackerOptions, "table" | "claudeCatalog" | "grokTable">> = { table: FROZEN_TABLE, claudeCatalog: FROZEN_CLAUDE_CATALOG, grokTable: FROZEN_GROK_MODELS };

/** A tracker pricing from the frozen tables; `o` may still override any of them. */
export const frozenTracker = (o: TrackerOptions): CostTracker => new CostTracker({ ...FROZEN_PRICES, ...o });

/** The frozen entry for a `priceKey`. */
export const frozenEntry = (key: string | undefined): PriceEntry | undefined => priceEntry(key, FROZEN_TABLE);

/** The frozen models.dev `limit.context` for a `priceKey`: the window OpenCode and Antigravity size a model by (`ownWindow`, `context.ts`). */
export const frozenWindow = (key: string): number | undefined => frozenEntry(key)?.context ?? undefined;

/** The frozen models.dev table plus entries of a test's own. */
export const frozenTableWith = (extra: Record<string, PriceEntry>): ModelsDevTable => ({ ...FROZEN_TABLE, entries: { ...FROZEN_TABLE.entries, ...extra } });
