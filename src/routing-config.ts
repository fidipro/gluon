import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { configPath } from "./config.ts";
import { writePrivate } from "./secrets.ts";
import DEFAULT_ROUTING from "./routing.yaml" with { type: "text" };
import type { Config } from "./routing.ts";

/** routing.yaml as shipped: the file `loadRouting` writes when there is none. Embedded in the binary. */
export const DEFAULT_ROUTING_YAML: string = DEFAULT_ROUTING;

export class RoutingError extends Error {}

/** The hash of a routing.yaml's text (line endings aside): what `SHIPPED_ROUTING` lists. */
export const routingHash = (text: string): string => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

/**
 * Every routing.yaml Gluon has shipped as its default, the current one included (with the `version:` it carries).
 * A user's file that is byte for byte one of these was never edited, so `loadRouting` replaces it with the current
 * default; one that was edited is kept and `gluon routing check` says it predates the default.
 * Changing `src/routing.yaml`: bump its `version:` and add its hash here; never remove a line (a test checks both).
 */
export const SHIPPED_ROUTING: readonly { hash: string; version: number }[] = [
  { hash: "39e3552ba3135b8b55cca3f0e5549c875ffb98b01ccc21188b877836ae2ac55a", version: 2 },
  { hash: "8ad31b29e7e731313f3a2a773cde59aa6bc7546d2d1472bf9de15d3c3b952991", version: 3 },
];

/** The shipped routing.yaml as a config (what a session uses when a test or a caller names none). */
export const defaultRouting = (): Config => parseRouting(DEFAULT_ROUTING_YAML, "routing.yaml");

/** `routing.yaml` next to config.yaml (the same directory as `configPath()`, so GLUON_CONFIG moves both). */
export function routingPath(): string {
  return join(dirname(configPath()), "routing.yaml");
}

/** The most values an alias may stand for in all (the library's own default): far more than any real routing.yaml reuses. */
const MAX_ALIAS_COUNT = 100;

/** Parses routing.yaml text. Throws RoutingError naming `path` and the line of a YAML mistake. */
export function parseRouting(text: string, path: string): Config {
  const doc = parseDocument(text, { merge: true }); // `<<: *anchor` is expanded (BUG-648)
  const err = doc.errors[0];
  if (err) {
    const line = err.linePos?.[0].line;
    throw new RoutingError(`${path}${line ? `:${line}` : ""}: not valid YAML: ${err.message.split("\n")[0]}`);
  }
  let value: unknown;
  // An alias bomb (a few lines that expand to billions of values) is refused by the library with a bare ReferenceError (BUG-646).
  try { value = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT }) ?? {}; } catch (e) { throw new RoutingError(`${path}: can't be used: ${(e as Error).message}`); }
  if (typeof value !== "object" || Array.isArray(value)) throw new RoutingError(`${path}: expected a mapping (rank, limits, types, ...)`);
  const cfg = value as Config;
  return { ...cfg, rank: cfg.rank ?? {}, types: cfg.types ?? {} };
}

/**
 * What `gluon routing check` adds for an edited file from an older default: its `version:` is below the current
 * default's. A file with no `version:` is the user's own and isn't compared.
 */
export function predatesDefault(cfg: Config, current: string = DEFAULT_ROUTING_YAML): string | undefined {
  const now = parseRouting(current, "routing.yaml").version;
  if (typeof cfg.version !== "number" || typeof now !== "number" || cfg.version >= now) return undefined;
  return "your routing.yaml predates this Gluon's default; compare with `gluon routing default`";
}

/**
 * The user's routing.yaml. When there is none, the default is written (directory first, readable
 * only by the user, like the other private files) and returned; one that is a shipped default but not the
 * current one is replaced by the current (same way, said once through `warn`); a file Gluon can't write (read-only,
 * say) is a warning, and the default still applies for this run. Throws RoutingError for a file
 * that isn't valid YAML (the message names the path and line). Doesn't check the values: `checkConfig`.
 */
export function loadRouting(
  warn: (message: string) => void = (m) => console.error(`gluon: ${m}`),
  shipped: readonly { hash: string }[] = SHIPPED_ROUTING,
  current: string = DEFAULT_ROUTING_YAML,
): Config {
  const path = routingPath();
  if (existsSync(path)) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch (e) { throw new RoutingError(`${path}: can't be read: ${(e as Error).message}`); }
    const mine = routingHash(text);
    // A file nobody edited, from an older Gluon: its ranks would stay stale after a catalog change.
    if (mine !== routingHash(current) && shipped.some((s) => s.hash === mine)) {
      try {
        const warning = writePrivate(path, current);
        if (warning) warn(warning);
        warn(`${path} was an older default; replaced with this version's default (you hadn't edited it).`);
      } catch (e) {
        warn(`${path} is an older default and couldn't be replaced: ${(e as Error).message}. Using this version's default for this run.`);
      }
      return parseRouting(current, path);
    }
    return parseRouting(text, path);
  }
  try {
    const warning = writePrivate(path, DEFAULT_ROUTING_YAML);
    if (warning) warn(warning);
  } catch (e) {
    warn(`couldn't write ${path}: ${(e as Error).message}. Using the default routing for this run.`);
  }
  return parseRouting(DEFAULT_ROUTING_YAML, path);
}
