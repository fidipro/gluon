/**
 * `gluon pricing update` (issue #39, #89): the refresh Gluon runs in the background at start and at each launch (`refresh.ts`), in the
 * foreground: the network tables (models.dev, OpenRouter), then the tables of every installed harness's binary
 * (Codex's windows, Grok's, Claude's fast-mode rows), each validated by `table-schema.ts` and written to the local store in the user's state
 * (`tables-store.ts`: private, directory first). It prints what it wrote and what moved: a big move is taken and said, never refused; a table
 * that fails its checks is refused and the exit code is 1. It never edits the repository or the install directory.
 *
 * Harness binaries are only spawned for `--version` or a catalog dump (`codex debug models`), by `binPath`, in `neutralCwd()`,
 * with a timeout and `killTree` (`grok-usage.ts`'s `defaultSpawn`).
 */
import { HARNESS_INFO, type Harness } from "../harnesses.ts";
import { installedVersion, refreshBinaryTables, refreshNetworkTables, type RefreshDeps, type RefreshResult, type TableReport } from "./refresh.ts";
import { tablesDir } from "./tables-store.ts";

export { defaultFetch, FETCH_TIMEOUT_MS, SPAWN_TIMEOUT_MS, type FetchText } from "./refresh.ts";

/** The harnesses with a table built from their binary, in the order they are refreshed. */
export const BINARY_HARNESSES: Harness[] = ["claude-code", "codex", "grok-build"];

export interface PricingUpdateOptions extends RefreshDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** How many moved prices are printed per table. */
  maxMoved?: number;
}

/** Runs `gluon pricing update`; returns the exit code (1: a table failed its checks or its build, or no source could be reached). */
export async function pricingUpdate(o: PricingUpdateOptions = {}): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  const error = o.error ?? ((l: string) => console.error(l));
  const maxMoved = o.maxMoved ?? 50;
  let failed = false;
  let wrote = 0;
  let reached = 0;
  const unreached: string[] = [];
  const say = (r: TableReport) => {
    if (r.status === "refused") {
      failed = true;
      error(`${r.table}: refused, ${r.detail}`);
      return;
    }
    if (r.status === "written") wrote++;
    if (r.status === "unreachable") unreached.push(r.detail);
    else if (r.status !== "skipped" && r.status !== "unreadable") reached++;
    log(`${r.table}: ${r.status}, ${r.detail}${r.status === "unreadable" ? " (the stored table stays)" : ""}`);
    if (r.problems.length) log(`  a big move, taken: ${r.problems.slice(0, 5).join("; ")}${r.problems.length > 5 ? `; and ${r.problems.length - 5} more` : ""}`);
    for (const c of r.changes.slice(0, maxMoved)) log(`  moved ${c.key}: ${c.from} -> ${c.to}`);
    if (r.changes.length > maxMoved) log(`  and ${r.changes.length - maxMoved} more`);
  };
  const show = (res: RefreshResult) => res.reports.forEach(say);
  const network = await refreshNetworkTables(o);
  if (network.skipped) {
    log(`Nothing to update: ${network.skipped}.`);
    return 0;
  }
  show(network);
  // Each installed harness's own tables, built from its binary (a version already stored is not read again), after models.dev's: Grok's seeded prices are its.
  for (const harness of BINARY_HARNESSES) {
    const found = await installedVersion(harness, o);
    if (!found.installed) log(`${HARNESS_INFO[harness].label}: not installed, no table to build from it`);
    else show(await refreshBinaryTables(harness, found.version, o));
  }
  // Offline: nothing was reached, and saying "current" would be false.
  if (unreached.length && !reached) {
    error(`Could not reach ${unreached.map((d) => d.replace(/ didn't answer$/, "")).join(" or ")}; kept the stored tables.`);
    return 1;
  }
  if (!wrote && !failed) log(unreached.length ? `Nothing to update; could not reach ${unreached.map((d) => d.replace(/ didn't answer$/, "")).join(" or ")}, kept those stored tables.` : "Nothing to update: every table is current.");
  return failed ? 1 : 0;
}

export const PRICING_HELP = `gluon pricing update

Rebuilds Gluon's price and window tables now, as Gluon does in the background when it starts and when it launches an agent: prices from
models.dev and OpenRouter's public listing (the only network use: models.dev and openrouter.ai), windows and Claude's catalog and
prices from your own installed Codex, Grok Build and Claude Code. Prints what was written and which prices moved;
a big move is taken, a malformed row is skipped and named, a table that fails its checks (or has lost most of its models) is refused (exit 1). Offline, the tables you have stay (exit 1, it says so). They are kept in Gluon's state
directory (${tablesDir()}), where Gluon reads them. It never edits the Gluon install or any repository; 'gluon uninstall' removes them.`;
