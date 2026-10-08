#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun scripts/codex-drift.ts --binary <codex>`: whether a codex release has anything the ChatGPT-plan
 * intake agent (`src/agent/codex.ts`) hasn't classified: an enabled feature outside CODEX_FEATURES_OFF
 * and CODEX_FEATURES_KEPT, a catalog field `catalogWithoutTools` refuses, or a thread-item type outside
 * BRAIN_ITEMS and FOREIGN_ITEMS. codex-watch.yml runs it on every new codex release. Prints a Markdown
 * report; exits 0 (nothing new), 1 (drift: classify it in codex.ts) or 2 (couldn't check).
 *
 * Only the given binary runs, never one from PATH, in a temp directory with an empty CODEX_HOME: it sees
 * codex's defaults, never a user's config or sign-in. Commands that need no sign-in and make no model
 * call: `--version`, `features list`, `debug models --bundled`, `app-server generate-json-schema`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAIN_ITEMS, catalogWithoutTools, CODEX_FEATURES_OFF, FOREIGN_ITEMS, knownFeatures, uncheckedFeatures } from "../src/agent/codex.ts";

export type Drift = {
  version: string;
  /** Enabled, with every known name of CODEX_FEATURES_OFF turned off, and not kept on purpose. */
  features: string[];
  /** The catalog's refusal, if any. */
  catalog: string | null;
  /** Item types neither allowed nor known to be foreign (the brain already refuses them). */
  items: string[];
  /** Names of CODEX_FEATURES_OFF this codex doesn't list (harmless: only known names are passed). */
  gone: string[];
};

/** The thread-item types in `generate-json-schema`'s bundle: each `ThreadItem` variant's `type`. */
export function itemTypes(schema: unknown): string[] {
  const find = (o: unknown): any => {
    if (!o || typeof o !== "object") return null;
    if ("ThreadItem" in o) return (o as Record<string, unknown>).ThreadItem;
    for (const v of Object.values(o)) {
      const r = find(v);
      if (r) return r;
    }
    return null;
  };
  const variants = find(schema)?.oneOf ?? find(schema)?.anyOf;
  if (!Array.isArray(variants)) throw new Error("the app-server schema has no ThreadItem variants");
  return variants.map((v: any) => v?.properties?.type?.enum?.[0]).filter((t: unknown): t is string => typeof t === "string");
}

/**
 * What a codex has that Gluon hasn't classified. `list` is the plain `features list`, `listOff` the same
 * with CODEX_FEATURES_OFF's known names turned off (codex forces some on), `catalog` `debug models --bundled`.
 */
export function drift(version: string, list: string, listOff: string, catalog: string, items: string[]): Drift {
  const known = new Set(knownFeatures(list));
  let refusal: string | null = null;
  try {
    catalogWithoutTools(catalog);
  } catch (e) {
    refusal = (e as Error).message;
  }
  return {
    version,
    features: uncheckedFeatures(listOff),
    catalog: refusal,
    items: [...new Set(items)].filter((t) => !BRAIN_ITEMS.has(t) && !FOREIGN_ITEMS.has(t)),
    gone: CODEX_FEATURES_OFF.filter((f) => !known.has(f)),
  };
}

export const drifted = (d: Drift) => d.features.length > 0 || d.catalog !== null || d.items.length > 0;

/** A name codex printed, as a code span: it goes into an issue, so nothing in it can format, link or mention. */
const code = (s: string) => `\`${s.replace(/[^\w.:-]/g, "?")}\``;

/** The report: what is new and where it goes in `src/agent/codex.ts`. */
export function report(d: Drift): string {
  const lines = [`## codex ${d.version.replace(/[^\w.+-]/g, "?")}`, ""];
  if (!drifted(d)) lines.push("Nothing new for the intake agent: every enabled feature, catalog field and item type is classified.");
  if (d.features.length) lines.push(`- **Features on that Gluon hasn't checked**: ${d.features.map(code).join(", ")}. Each goes in \`CODEX_FEATURES_OFF\` (it gives the model a tool, or it's unclear) or \`CODEX_FEATURES_KEPT\` (with why it gives none). Until then the intake agent refuses this codex.`);
  if (d.catalog) lines.push(`- **Model catalog**: ${d.catalog.replace(/[`@<>\[\]\n]/g, "?")}. A field goes in \`CATALOG_FIELDS\`, or in \`CATALOG_TOOLS_OFF\` if it adds tools.`);
  if (d.items.length) lines.push(`- **New thread-item types**: ${d.items.map(code).join(", ")}. Each goes in \`BRAIN_ITEMS\` or \`FOREIGN_ITEMS\`; until then a turn that has one is stopped.`);
  if (d.gone.length) lines.push(`- Names of \`CODEX_FEATURES_OFF\` this codex doesn't list (harmless; delete them once no supported codex has them): ${d.gone.map(code).join(", ")}.`);
  if (drifted(d)) lines.push("", "Then refresh `test/fixtures/codex-features-list.txt` from `codex features list` and run `bun run test:area brain`.");
  return lines.join("\n");
}

function run(binary: string, args: string[], cwd: string, home: string): string {
  const p = Bun.spawnSync([binary, ...args], { cwd, env: { ...process.env, CODEX_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  if (p.exitCode !== 0) throw new Error(`\`codex ${args.join(" ")}\` failed (exit code ${p.exitCode}): ${p.stderr.toString().trim().split("\n").at(-1) ?? ""}`);
  return p.stdout.toString();
}

function main(argv: string[]): number {
  const i = argv.indexOf("--binary");
  const binary = i >= 0 ? argv[i + 1] : undefined;
  if (!binary || binary.startsWith("-")) {
    console.error("usage: bun scripts/codex-drift.ts --binary <path to codex>");
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), "gluon-codex-drift-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home);
    const version = run(binary, ["--version"], dir, home).trim().replace(/^codex-cli\s+/, "");
    const list = run(binary, ["features", "list"], dir, home);
    const listOff = run(binary, ["features", "list", ...knownFeatures(list).flatMap((f) => ["--disable", f])], dir, home);
    const catalog = run(binary, ["debug", "models", "--bundled"], dir, home);
    const out = join(dir, "schema");
    run(binary, ["app-server", "generate-json-schema", "--out", out], dir, home);
    const items = itemTypes(JSON.parse(readFileSync(join(out, "codex_app_server_protocol.schemas.json"), "utf8")));
    const d = drift(version, list, listOff, catalog, items);
    console.log(report(d));
    return drifted(d) ? 1 : 0;
  } catch (e) {
    console.log(`## codex: couldn't check\n\n${(e as Error).message}`);
    return 2;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
