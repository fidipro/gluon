/**
 * `gluon cost-report` (issue #39): what the audit ledger holds, as plain lines. Per harness and
 * model, how many requests Gluon priced and what they came to; how many requests a harness also
 * reported a figure for, how many of those differ beyond rounding, and the likeliest cause of each
 * difference (a table per scope: request, turn, running total); the context % beside the harness's own
 * by cause; the records a cap or a side conversation kept out; which assumptions were needed; and
 * how old each local table is, when it was fetched and how many requests it priced. A ledger with only context or no usage entries (Antigravity) reports too.
 */
import { differs, finalCumulative, type ContextEntry, type DroppedEntry, type LedgerEntry, type ObservationEntry, type TablesEntry, type UsageEntry } from "./ledger.ts";
import type { TableInfo } from "./tables.ts";

const usd = (micros: number) => `$${(micros / 1e6).toFixed(micros < 10_000 ? 4 : 2)}`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const byName = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : 1);
const SCOPES = [["request", "per request"], ["turn", "per turn"], ["cumulative", "running total"], ["billed", "what OpenRouter billed the session"]] as const;

export function reportLines(entries: LedgerEntry[], { now = Date.now(), tables = [], dir = "" }: { now?: number; tables?: TableInfo[]; dir?: string } = {}): string[] {
  const usage = entries.filter((e): e is UsageEntry => e.kind === "usage");
  // A running total is compared at its last sample per launch: the earlier ones differ by the requests in flight (BUG-381).
  const { kept, inFlight } = finalCumulative(entries);
  const observed = kept.filter((e): e is ObservationEntry => e.kind === "observation" && e.what === "cost");
  const lines: string[] = [];
  // Every local table, with its age (its own date) or the version it was read from, and how many priced requests it priced here.
  for (const t of tables) {
    const days = t.updatedAt ? Math.floor((now - Date.parse(t.updatedAt)) / 86_400_000) : NaN;
    const used = usage.filter((u) => u.table && t.digest.startsWith(u.table)).length;
    const age = t.updatedAt ? `${t.updatedAt.slice(0, 10)}${Number.isFinite(days) && days >= 0 ? ` (${count(days, "day")} old${days > 14 ? ": stale" : ""})` : ""}` : t.version ? `version ${t.version} (undated)` : "undated";
    const fetched = t.fetchedAt && Number.isFinite(Date.parse(t.fetchedAt)) ? `; fetched ${t.fetchedAt.slice(0, 16).replace("T", " ")}Z` : "";
    lines.push(`price table: ${t.source} of ${age}${usage.length ? `; priced ${count(used, "request")} here` : ""}${fetched}`);
  }
  if (!entries.length) return [...lines, `no cost audit entries${dir ? ` in ${dir}` : ""} yet: they are written while Gluon runs agents (cost.audit: on)`];

  if (usage.length) {
    lines.push("", "priced by Gluon, per harness and model:");
    const by = new Map<string, { requests: number; micros: number; assumptions: Set<string>; versions: Set<string> }>();
    for (const e of usage) {
      const k = `${e.harness} ${e.model} (${e.connection})`;
      const row = by.get(k) ?? { requests: 0, micros: 0, assumptions: new Set(), versions: new Set() };
      row.requests++;
      row.micros += e.ownMicros;
      for (const a of e.assumptions) row.assumptions.add(a);
      if (e.harnessVersion) row.versions.add(e.harnessVersion);
      by.set(k, row);
    }
    for (const [k, r] of [...by].sort(byName)) lines.push(`  ${k}: ${count(r.requests, "request")}, ${usd(r.micros)}${r.versions.size ? ` [${[...r.versions].join(", ")}]` : ""}${r.assumptions.size ? `; assumed: ${[...r.assumptions].join(", ")}` : ""}`);
  }

  // What each harness reported itself, a table of causes per scope (a request, a turn, its running total).
  for (const [scope, label] of SCOPES) {
    const seen = observed.filter((o) => o.scope === scope && o.ownMicros !== undefined);
    if (!seen.length) continue;
    const diverge = seen.filter(differs);
    const billed = scope === "billed";
    lines.push("", `audited against ${billed ? "" : "the harness's own figure, "}${label}: ${count(seen.length, "observation")}, ${diverge.length} differ`);
    const causes = new Map<string, { n: number; micros: number }>();
    for (const o of diverge) {
      const k = `${o.harness} ${o.cause ?? "unexplained"}`;
      const c = causes.get(k) ?? { n: 0, micros: 0 };
      c.n++;
      c.micros += o.reportedMicros - o.ownMicros!;
      causes.set(k, c);
    }
    for (const [cause, c] of [...causes].sort(byName)) lines.push(`  ${cause}: ${count(c.n, "observation")}, ${c.micros >= 0 ? "+" : "-"}${usd(Math.abs(c.micros))} (${billed ? "OpenRouter's" : "the harness's"} figure minus ours)`);
  }
  if (inFlight) lines.push("", `${count(inFlight, "earlier running-total sample")} left out (in flight when taken): each launch's last sample is the one compared`);
  const reportedOnly = observed.filter((o) => o.ownMicros === undefined);
  if (reportedOnly.length) lines.push("", `reported by a harness with no figure of ours to compare: ${count(reportedOnly.length, "observation")}`);

  // The context %: Gluon's own beside the harness's, per harness, by the cause of a difference.
  const contexts = entries.filter((e): e is ContextEntry => e.kind === "context");
  if (contexts.length) {
    const audited = contexts.filter((c) => c.cause !== undefined);
    const differ = audited.filter((c) => c.cause !== "none");
    lines.push("", `context % audited against the harness's own: ${count(audited.length, "reading")}, ${differ.length} differ by more than a point${contexts.length > audited.length ? `; ${count(contexts.length - audited.length, "reading")} had only one side` : ""}`);
    const rows = new Map<string, { n: number; own: number[]; reported: number[]; ownWin: Set<number>; reportedWin: Set<number> }>();
    for (const c of contexts) {
      const k = `${c.harness} ${c.cause ?? (c.ownPct === undefined ? "reported-only" : "own-only")}`;
      const r = rows.get(k) ?? { n: 0, own: [], reported: [], ownWin: new Set(), reportedWin: new Set() };
      r.n++;
      if (c.ownPct !== undefined) r.own.push(c.ownPct);
      if (c.reportedPct !== undefined) r.reported.push(c.reportedPct);
      if (c.ownWindow !== undefined) r.ownWin.add(c.ownWindow);
      if (c.reportedWindow !== undefined) r.reportedWin.add(c.reportedWindow);
      rows.set(k, r);
    }
    const mean = (v: number[]) => Math.round(v.reduce((a, b) => a + b, 0) / v.length);
    const wins = (w: Set<number>) => [...w].sort((a, b) => a - b).join("/");
    for (const [k, r] of [...rows].sort(byName)) {
      const detail = [r.own.length ? `own ${mean(r.own)}%${r.ownWin.size ? ` of ${wins(r.ownWin)}` : ""}` : "", r.reported.length ? `reported ${mean(r.reported)}%${r.reportedWin.size ? ` of ${wins(r.reportedWin)}` : ""}` : ""].filter(Boolean).join(", ");
      lines.push(`  ${k}: ${count(r.n, "reading")}${detail ? ` (${detail}, on average)` : ""}`);
    }
  }
  const dropped = entries.filter((e): e is DroppedEntry => e.kind === "dropped");
  if (dropped.length) {
    const by = new Map<string, number>();
    for (const d of dropped) {
      const k = `${d.harness ?? "no harness"} ${d.what}: ${d.reason}`;
      by.set(k, (by.get(k) ?? 0) + d.count);
    }
    lines.push("", "records Gluon did not count:");
    for (const [k, n] of [...by].sort(byName)) lines.push(`  ${k}: ${n}`);
  }
  // The tables' own refreshes (`tables` entries): how often each was rebuilt on this machine and how far its prices moved.
  const refreshes = entries.filter((e): e is TablesEntry => e.kind === "tables");
  if (refreshes.length) {
    const by = new Map<string, { n: number; moved: number; gone: number; big: number; skipped: number }>();
    for (const r of refreshes) {
      const row = by.get(`${r.table} (${r.via})`) ?? { n: 0, moved: 0, gone: 0, big: 0, skipped: 0 };
      row.n++;
      row.moved += r.moved;
      row.gone += r.gone;
      row.skipped += r.skipped ?? 0;
      if (r.big) row.big++;
      by.set(`${r.table} (${r.via})`, row);
    }
    lines.push("", "table refreshes that changed a table:");
    for (const [k, r] of [...by].sort(byName)) lines.push(`  ${k}: ${count(r.n, "refresh", "refreshes")}, ${count(r.moved, "price")} moved${r.gone ? `, ${r.gone} gone` : ""}${r.big ? `, ${count(r.big, "big move")}` : ""}${r.skipped ? `, ${count(r.skipped, "malformed row")} skipped` : ""}`);
  }
  const unknown = [...new Set(usage.filter((e) => e.assumptions.includes("unknown-model")).map((e) => `${e.harness} ${e.model}`))];
  if (unknown.length) lines.push("", `no price in the table for: ${unknown.join(", ")} (the harness's own figure is shown for these)`);
  return lines;
}
