/**
 * Building the Codex window table (`codex-windows`) from Codex's model catalog (the output of
 * `codex debug models`). Pure (text in, table out): `scripts/pricing/codex.ts` (a manual refresh) and
 * `gluon pricing update` (`pricing-update.ts`) both call it, so a table is built one way wherever it is built.
 */
import { createHash } from "node:crypto";
import { codexCatalogWindows } from "./context.ts";
import type { CodexWindowsTable } from "./tables.ts";

/** The table from a catalog's text; throws when it has no model (a codex whose catalog moved must fail the job, not empty the table). */
export function buildTable(catalogJson: string, { codexVersion, generatedAt, note }: { codexVersion: string; generatedAt: string; note?: string }): CodexWindowsTable {
  const windows = codexCatalogWindows(catalogJson);
  const slugs = Object.keys(windows).sort();
  if (!slugs.length) throw new Error("the codex catalog has no model with a window (`codex debug models` changed shape: update src/cost/codex-catalog.ts)");
  return { schema: 1, source: "codex debug models", codexVersion, generatedAt, digest: createHash("sha256").update(catalogJson).digest("hex"), ...(note ? { note } : {}), models: Object.fromEntries(slugs.map((s) => [s, windows[s]!])) };
}
