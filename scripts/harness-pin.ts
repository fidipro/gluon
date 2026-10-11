#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * The harness versions the tests run on (`test/harnesses.json`, scripts/harness-cache.ts):
 *
 *   bun scripts/harness-pin.ts            each harness: pinned version, newest release, behind or not
 *   bun scripts/harness-pin.ts --check    the same; exits 1 when a pin is behind (a release's preflight)
 *   bun scripts/harness-pin.ts --bump     rewrites the pin to the newest releases (harness-watch.yml; by hand)
 *   bun scripts/harness-pin.ts --install [--newest]   downloads and verifies this host's binaries into the cache
 *   bun scripts/harness-pin.ts --install --harness codex --path   the same, printing only the binary's path
 *
 * `--harness a,b` narrows any of them. Reads the vendors' release sources over the network; never part of the suite.
 */
import { existsSync } from "node:fs";
import type { Harness } from "../src/harnesses.ts";
import { cacheDir, HARNESS_IDS, hostOf, install, PIN_PATH, readPin, resolveNewest, writePin, type Pin } from "./harness-cache.ts";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const value = (f: string) => {
  const i = argv.findIndex((a) => a === f || a.startsWith(`${f}=`));
  if (i < 0) return undefined;
  return argv[i]!.includes("=") ? argv[i]!.slice(f.length + 1) : argv[i + 1];
};
const pick = value("--harness")?.split(",").filter(Boolean) as Harness[] | undefined;
for (const h of pick ?? []) if (!(HARNESS_IDS as readonly string[]).includes(h)) throw new Error(`unknown harness: ${h} (one of ${HARNESS_IDS.join(", ")})`);
const harnesses = pick ?? [...HARNESS_IDS];
// A first `--bump` writes the pin from nothing.
const pin = existsSync(PIN_PATH) || !has("--bump") ? readPin() : ({} as Pin);

if (has("--install")) {
  const newest = has("--newest") ? await resolveNewest(harnesses, undefined, hostOf() ? [hostOf()!] : []) : pin;
  const pathOnly = has("--path");
  if (pathOnly && harnesses.length !== 1) throw new Error("--path goes with one --harness");
  if (!pathOnly) console.log(`cache: ${cacheDir()}`);
  for (const h of harnesses) {
    const bin = await install(h, newest[h]!, { log: (s) => console.error(`  ${s}`) });
    console.log(pathOnly ? bin : `${h} ${newest[h]!.version}: ${bin}`);
  }
  process.exit(0);
}

if (has("--bump")) {
  const next = { ...pin, ...(await resolveNewest(harnesses)) } as Pin;
  const changed = harnesses.filter((h) => next[h].version !== pin[h]?.version);
  writePin(next);
  console.log(changed.length ? changed.map((h) => `${h}: ${pin[h]?.version ?? "none"} → ${next[h].version}`).join("\n") : "every harness is on its newest release");
  process.exit(0);
}

const newest = await resolveNewest(harnesses, undefined, []);
let behind = 0;
for (const h of harnesses) {
  const late = newest[h]!.version !== pin[h].version;
  behind += late ? 1 : 0;
  console.log(`${h.padEnd(12)} pinned ${pin[h].version.padEnd(10)} newest ${newest[h]!.version}${late ? "  ← behind: bun scripts/harness-pin.ts --bump" : ""}`);
}
process.exit(has("--check") && behind ? 1 : 0);
