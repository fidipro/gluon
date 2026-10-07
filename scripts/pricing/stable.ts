/**
 * The `generatedAt` day of a table a generator writes: today's, unless the table already at `out` is the
 * same in everything else (then its own day stays), so a day with nothing new leaves the file as it was and
 * a table does not change just because the date did (BUG-362). An explicit `--generated-at`
 * is taken as given.
 */
import { existsSync, readFileSync } from "node:fs";

export function generatedDay(out: string, next: object, explicit?: string): string {
  if (explicit) return explicit;
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (!existsSync(out)) return today;
    const { generatedAt: before, ...old } = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    const { generatedAt: _now, ...fresh } = next as Record<string, unknown>;
    return typeof before === "string" && JSON.stringify(old) === JSON.stringify(fresh) ? before : today;
  } catch {
    return today;
  }
}
