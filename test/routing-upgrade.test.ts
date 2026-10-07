import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_ROUTING_YAML, loadRouting, parseRouting, predatesDefault, routingHash, routingPath, SHIPPED_ROUTING } from "../src/routing-config.ts";

// An "older default" for the tests: the current one with a rank changed and the version one lower.
const OLD = DEFAULT_ROUTING_YAML.replace(/^version: \d+$/m, "version: 1").replace("[claude-code/haiku, codex/gpt-6-luna, kimi-code/kimi-k2.7-code]", "[codex/gpt-6-luna, claude-code/haiku]");
const shipped = [...SHIPPED_ROUTING, { hash: routingHash(OLD), version: 1 }];

test("the older default the tests build differs from the current one in its rank, not only its version", () => {
  expect(OLD.replace("version: 1", "version: 0")).not.toBe(DEFAULT_ROUTING_YAML.replace(/^version: \d+$/m, "version: 0"));
});

let dir: string, savedConfig: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gluon-routing-upgrade-"));
  savedConfig = process.env.GLUON_CONFIG;
  process.env.GLUON_CONFIG = join(dir, "sub", "config.yaml");
  mkdirSync(dirname(routingPath()), { recursive: true });
});
afterEach(() => {
  if (savedConfig === undefined) delete process.env.GLUON_CONFIG;
  else process.env.GLUON_CONFIG = savedConfig;
});

test("BUG-461/the embedded default is the last of the shipped defaults: its hash is listed, with its version, and no other version is as high", () => {
  const mine = SHIPPED_ROUTING.find((s) => s.hash === routingHash(DEFAULT_ROUTING_YAML));
  // Failing here: src/routing.yaml changed. Bump its `version:` and add its hash to SHIPPED_ROUTING (keep the old lines).
  expect(mine).toBeDefined();
  expect(mine!.version).toBe(parseRouting(DEFAULT_ROUTING_YAML, "routing.yaml").version!);
  for (const s of SHIPPED_ROUTING) if (s !== mine) expect(s.version).toBeLessThan(mine!.version);
  expect(new Set(SHIPPED_ROUTING.map((s) => s.hash)).size).toBe(SHIPPED_ROUTING.length);
});

test("BUG-461/a routing.yaml that is an older shipped default, unedited, is replaced by the current one, privately, and said once", () => {
  writeFileSync(routingPath(), OLD);
  const warnings: string[] = [];
  const c = loadRouting((m) => warnings.push(m), shipped);
  expect(readFileSync(routingPath(), "utf8")).toBe(DEFAULT_ROUTING_YAML);
  expect(c).toEqual(parseRouting(DEFAULT_ROUTING_YAML, routingPath()));
  expect(warnings).toEqual([expect.stringContaining("was an older default; replaced")]);
  if (process.platform !== "win32") expect(statSync(routingPath()).mode & 0o777).toBe(0o600);
  expect(readdirSync(dirname(routingPath()))).toEqual(["routing.yaml"]);
  // The next start finds the current default: nothing to say.
  const again: string[] = [];
  loadRouting((m) => again.push(m), shipped);
  expect(again).toEqual([]);
});

test("BUG-461/an edited routing.yaml (even one that began as an older default) is kept as it is", () => {
  const edited = OLD.replace("limits:", "# mine\nlimits:");
  writeFileSync(routingPath(), edited);
  const warnings: string[] = [];
  const c = loadRouting((m) => warnings.push(m), shipped);
  expect(readFileSync(routingPath(), "utf8")).toBe(edited);
  expect(warnings).toEqual([]);
  expect(c.version).toBe(1);
  expect(predatesDefault(c)).toBe("your routing.yaml predates this Gluon's default; compare with `gluon routing default`");
});

test("BUG-461/the current default is left alone, and only a lower version predates it", () => {
  writeFileSync(routingPath(), DEFAULT_ROUTING_YAML);
  const warnings: string[] = [];
  loadRouting((m) => warnings.push(m), shipped);
  expect(warnings).toEqual([]);
  const now = parseRouting(DEFAULT_ROUTING_YAML, "x");
  expect(predatesDefault(now)).toBeUndefined();
  expect(predatesDefault({ ...now, version: now.version! + 1 })).toBeUndefined();
  // A file without a version is the user's own, not compared.
  expect(predatesDefault({ rank: {}, types: {} })).toBeUndefined();
});

test("QA: an older shipped default whose line endings were changed (git's autocrlf, a Windows editor) and nothing else is still unedited: replaced; one more character is an edit: kept", () => {
  writeFileSync(routingPath(), OLD.replace(/\n/g, "\r\n"));
  const warnings: string[] = [];
  loadRouting((m) => warnings.push(m), shipped);
  expect(readFileSync(routingPath(), "utf8")).toBe(DEFAULT_ROUTING_YAML);
  expect(warnings).toEqual([expect.stringContaining("was an older default; replaced")]);
  for (const edited of [`${OLD}\n`, OLD.replace(/\n/, " \n"), `﻿${OLD}`, OLD.replace("version: 1", "version: 1 ")]) {
    writeFileSync(routingPath(), edited);
    const again: string[] = [];
    loadRouting((m) => again.push(m), shipped);
    expect(readFileSync(routingPath(), "utf8")).toBe(edited);
    expect(again).toEqual([]);
  }
});

test("QA: a read-only routing.yaml that is an older shipped default is not replaced, and the current default still applies for the run, said once", () => {
  if (process.platform === "win32") return; // directory modes aren't enforced the same way
  writeFileSync(routingPath(), OLD);
  chmodSync(dirname(routingPath()), 0o500);
  try {
    if (process.getuid?.() === 0) return; // root writes anyway
    const warnings: string[] = [];
    const c = loadRouting((m) => warnings.push(m), shipped);
    expect(readFileSync(routingPath(), "utf8")).toBe(OLD);
    expect(c).toEqual(parseRouting(DEFAULT_ROUTING_YAML, routingPath()));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("couldn't be replaced");
  } finally {
    chmodSync(dirname(routingPath()), 0o700);
  }
});
