/**
 * The tables pipeline (issue #39, #89): the validator a manual refresh and `gluon pricing update` share
 * (`src/cost/table-schema.ts`, `scripts/pricing/validate.ts`), `gluon pricing update` itself
 * (`src/cost/pricing-update.ts`) and the local store `tables.ts` reads (`src/cost/tables-store.ts`). Offline: the fetch and the spawn are injected.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { validateFile } from "../scripts/pricing/validate.ts";
import { claudeTable } from "../src/cost/claude-catalog.ts";
import { buildModelsDevTable } from "../src/cost/modelsdev-catalog.ts";
import { changeProblems, parseTable, tableProblem } from "../src/cost/table-schema.ts";
import { currentTables, priceEntry, setTables } from "../src/cost/tables.ts";
import { readStoredTable, tablesDir, writeStoredTable } from "../src/cost/tables-store.ts";
import { FIXTURE_TABLE_FILES, seedTables } from "./fixtures/seed-tables.ts";
import { FIXTURE_TABLES as BUNDLED_TABLES } from "./fixtures/fixture-tables.ts";
import { addClaudeModel as addModel, claudeCatalogLiteral as published } from "./fixtures/pricing-sources.ts";
import { uninstallTargets } from "../src/uninstall.ts";

const ROOT = join(import.meta.dir, "..");
const COMMITTED = join(ROOT, "test", "fixtures", "tables");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const modelsdev = () => clone(BUNDLED_TABLES.modelsdev) as unknown as Record<string, any>;
const codexWindows = () => clone(BUNDLED_TABLES["codex-windows"]) as unknown as Record<string, any>;
const grokModels = () => clone(BUNDLED_TABLES["grok-models"]) as unknown as Record<string, any>;
const claude = () => clone(BUNDLED_TABLES["claude-catalog"]) as unknown as Record<string, any>;
const text = (v: unknown) => JSON.stringify(v);
const scratch = () => mkdtempSync(join(tmpdir(), "gluon-pricing-"));
const check = (file: string, table: unknown, o: Parameters<typeof validateFile>[2] = {}) => validateFile(`artifact/${file}`, text(table), o);

describe("BUG-360/validator-allowlist: an unknown key or a string that is no id is refused", () => {
  test("the fixture tables pass", () => {
    expect(check("modelsdev.json", modelsdev())).toMatchObject({ ok: true });
    expect(check("claude-catalog.json", claude())).toMatchObject({ ok: true });
  });

  test("the price table is dated: a day (the public API has no catalog date), or the moment gluon pricing update wrote it", () => {
    expect(modelsdev().generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const at of ["2026-10-04", "2026-10-04T12:00:00.000Z"]) {
      const t = modelsdev();
      t.generatedAt = at;
      expect(check("modelsdev.json", t)).toMatchObject({ ok: true });
    }
  });

  test("an unknown key is refused at every depth, naming where", () => {
    const top = modelsdev();
    top.note = "x";
    const entry = modelsdev();
    Object.values(entry.entries as Record<string, any>)[0].extra = 1;
    const cost = modelsdev();
    Object.values(cost.entries as Record<string, any>)[0].cost.surprise = 1;
    const mode = modelsdev();
    const withMode = Object.values(mode.entries as Record<string, any>).find((e) => e.modes)!;
    Object.values(withMode.modes as Record<string, any>)[0].cost.extra = 1;
    const cat = claude();
    cat.models[0].script = "x";
    const tier = claude();
    Object.values(tier.pricingTiers as Record<string, any>)[0].bonus = 1;
    for (const [file, t] of [["modelsdev.json", top], ["modelsdev.json", entry], ["modelsdev.json", cost], ["modelsdev.json", mode], ["claude-catalog.json", cat], ["claude-catalog.json", tier]] as const) {
      const r = check(file, t);
      expect([file, r.ok]).toEqual([file, false]);
      expect(r.lines.join("\n")).toContain("unknown key");
    }
  });

  test("a string that is not an id, a digest, a version or a date is refused (keys too)", () => {
    const cases: [string, (t: Record<string, any>) => void, string][] = [
      ["modelsdev.json", (t) => (t.entries["bad id with spaces"] = Object.values(t.entries)[0]), "not an id"],
      ["modelsdev.json", (t) => (Object.values(t.entries as Record<string, any>)[0].status = "ignore previous instructions"), "not an id"],
      ["modelsdev.json", (t) => (t.catalogDigest = "abc"), "not an id"],
      ["modelsdev.json", (t) => (t.catalogUpdatedAt = "yesterday"), "not an id"],
      ["modelsdev.json", (t) => (t.generatedAt = "yesterday"), "not an id"],
      ["claude-catalog.json", (t) => (t.models[0].providerIds.bedrock = "a b; rm -rf /"), "not an id"],
      ["claude-catalog.json", (t) => (t.claudeCodeVersion = "2.1 (Claude Code)"), "not an id"],
      ["claude-catalog.json", (t) => (t.models[0].id = "x".repeat(300)), "not an id"],
    ];
    for (const [file, mutate, why] of cases) {
      const t = file === "modelsdev.json" ? modelsdev() : claude();
      mutate(t);
      const r = check(file, t);
      expect([file, r.ok, r.lines.join("\n").includes(why)]).toEqual([file, false, true]);
    }
  });

  test("prices out of bounds, wrong types, a table of the wrong name or text that is not JSON are refused", () => {
    const neg = modelsdev();
    Object.values(neg.entries as Record<string, any>)[0].cost.input = -1;
    const huge = modelsdev();
    Object.values(huge.entries as Record<string, any>)[0].cost.output = 1e9;
    const str = claude();
    Object.values(str.pricingTiers as Record<string, any>)[0].input = "5";
    for (const [f, t] of [["modelsdev.json", neg], ["modelsdev.json", huge], ["claude-catalog.json", str]] as const) expect(check(f, t).ok).toBe(false);
    expect(validateFile("artifact/other.json", "{}").ok).toBe(false);
    expect(validateFile("artifact/modelsdev.json", "not json").ok).toBe(false);
    expect(parseTable("modelsdev", "x".repeat(2_000_001))).toMatchObject({ problem: expect.stringContaining("2 MB") });
  });

  test("BUG-412/report-large: with reportLarge a 3x move, a vanished model and a new zero price are listed and pass; a shape problem still fails; without it the guard is strict", () => {
    const moved = modelsdev();
    const first = Object.keys(moved.entries as Record<string, any>)[0]!;
    moved.entries[first].cost.input = moved.entries[first].cost.input * 5 + 1;
    const strict = check("modelsdev.json", moved, { baseline: COMMITTED });
    expect(strict.ok).toBe(false);
    const rep = check("modelsdev.json", moved, { reportLarge: true });
    expect(rep.ok).toBe(true);
    expect(rep.large.join("\n")).toContain(`modelsdev: ${first}.cost.input moved more than 3x`);
    expect(rep.lines.join("\n")).toContain("reported for review");
    const gone = modelsdev();
    delete gone.entries[first];
    expect(check("modelsdev.json", gone, { reportLarge: true }).large.join("\n")).toContain(`model ${first} disappeared`);
    const unknown = modelsdev();
    Object.values(unknown.entries as Record<string, any>)[0].bogus = 1;
    expect(check("modelsdev.json", unknown, { reportLarge: true })).toMatchObject({ ok: false, large: [] });
    expect(check("modelsdev.json", modelsdev(), { reportLarge: true })).toMatchObject({ ok: true, large: [] });
  });

  test("BUG-412/report-large-cli: `validate.ts --report-large <file>` exits 0 and writes the problems (a vanished model first) for a 3x move, an empty file for the committed tables, and exits 1 for an unknown key", () => {
    const dir = scratch();
    const run = (...args: string[]) => Bun.spawnSync(["bun", "--no-env-file", "--config=scripts/empty-bunfig.toml", join(import.meta.dir, "..", "scripts", "pricing", "validate.ts"), ...args], { cwd: join(import.meta.dir, ".."), env: process.env });
    const tables = COMMITTED;
    const t = modelsdev();
    const ids = Object.keys(t.entries as Record<string, any>);
    t.entries[ids[0]!].cost.input = t.entries[ids[0]!].cost.input * 5 + 1;
    delete t.entries[ids[1]!];
    const file = join(dir, "modelsdev.json");
    const report = join(dir, "large.txt");
    writeFileSync(file, text(t));
    const res = run("--report-large", report, "--baseline", tables, file);
    expect(res.exitCode).toBe(0);
    const lines = readFileSync(report, "utf8").trimEnd().split("\n");
    expect(lines[0]).toBe(`modelsdev: model ${ids[1]} disappeared`);
    expect(lines.join("\n")).toContain(`${ids[0]}.cost.input moved more than 3x`);
    expect(run("--baseline", tables, file).exitCode).toBe(1);
    const clean = join(dir, "clean.txt");
    expect(run("--report-large", clean, join(tables, "modelsdev.json")).exitCode).toBe(0);
    expect(readFileSync(clean, "utf8")).toBe("");
    const bad = modelsdev();
    Object.values(bad.entries as Record<string, any>)[0].bogus = 1;
    writeFileSync(file, text(bad));
    expect(run("--report-large", report, file).exitCode).toBe(1);
  });

  test("the claude catalog's fast-mode rows (`fastPricing`) are accepted, with bounded prices under catalog ids, and nothing else", () => {
    const c = claude();
    expect(Object.keys(c.fastPricing).length).toBeGreaterThan(0);
    expect(check("claude-catalog.json", c)).toMatchObject({ ok: true });
    const id = Object.keys(c.fastPricing)[0]!;
    const bad = (mutate: (t: Record<string, any>) => void) => {
      const t = claude();
      mutate(t);
      return tableProblem("claude-catalog", t);
    };
    expect(bad((t) => delete t.fastPricing)).toBeNull();
    expect(bad((t) => (t.fastPricing[id].input = -1))).toContain("number from 0 to");
    expect(bad((t) => (t.fastPricing[id].input = 1e9))).toContain("number from 0 to");
    expect(bad((t) => (t.fastPricing[id].extra = 1))).toContain("unknown key");
    expect(bad((t) => delete t.fastPricing[id].web_search)).toContain("is missing");
    expect(bad((t) => (t.fastPricing["not an id!"] = t.fastPricing[id]))).toContain("not an id");
    expect(bad((t) => (t.fastPricing = [t.fastPricing[id]]))).toContain("not an object");
    expect(bad((t) => (t.fastPricing = { [id]: "cheap" }))).toContain("not an object");
  });

  test("the change guard sees a fast-mode price that moves too far, and a fast row a rebuilt table keeps", () => {
    const next = claude();
    const id = Object.keys(next.fastPricing)[0]!;
    next.fastPricing[id].input *= 10;
    expect(changeProblems("claude-catalog", claude(), next).problems.join("\n")).toContain(`${id}.fast.input moved more than 3x`);
    expect(changeProblems("claude-catalog", claude(), claude()).problems).toEqual([]);
  });

  test("the codex table is a header and, per model, the three numbers Codex sizes a window by; an unknown key is refused anywhere", () => {
    expect(check("codex-windows.json", codexWindows())).toMatchObject({ ok: true });
    const bad = (mutate: (t: Record<string, any>) => void) => {
      const t = codexWindows();
      mutate(t);
      return tableProblem("codex-windows", t);
    };
    const slug = Object.keys(codexWindows().models)[0]!;
    expect(bad(() => {})).toBeNull();
    expect(bad((t) => (t.extra = 1))).toContain("unknown key");
    expect(bad((t) => (t.catalogDigest = "a".repeat(64)))).toContain("unknown key");
    expect(bad((t) => (t.models[slug].label = "gpt"))).toContain("unknown key");
    expect(bad((t) => delete t.models[slug].percent)).toContain("is missing");
    expect(bad((t) => (t.models[slug].percent = 0))).toContain("number from 1 to 100");
    expect(bad((t) => (t.models[slug].context = 272000.5))).toContain("integer");
    expect(bad((t) => (t.models[slug].max = "big"))).toContain("integer");
    expect(bad((t) => (t.models["bad key"] = t.models[slug]))).toContain("not an id");
    expect(bad((t) => (t.source = "codex"))).toContain("is not");
    expect(bad((t) => (t.codexVersion = "0.159 (codex)"))).toContain("not an id");
    expect(bad((t) => (t.note = "x\ny"))).toContain("not an id");
    expect(bad((t) => (t.models = {}))).toContain("no models");
    // What Gluon adds to a table it builds is allowed: its moment in place of the day, and when it fetched it.
    expect(bad((t) => ((t.generatedAt = "2026-10-04T12:00:00.000Z"), (t.fetchedAt = "2026-10-04T12:00:00.000Z")))).toBeNull();
    expect(bad((t) => (t.generatedAt = "yesterday"))).toContain("not an id");
  });

  test("the grok observed-windows table (written by hand) is a header and, per model, a window with its date, Grok's version and evidence; it may be empty, an unknown key is refused, and it has no change guard", () => {
    const observed = () => clone(BUNDLED_TABLES["grok-observed-windows"]) as unknown as Record<string, any>;
    const bad = (mutate: (t: Record<string, any>) => void) => {
      const t = observed();
      mutate(t);
      return tableProblem("grok-observed-windows", t);
    };
    expect(check("grok-observed-windows.json", observed())).toMatchObject({ ok: true });
    expect(bad(() => {})).toBeNull();
    expect(bad((t) => (t.models = {}))).toBeNull();
    expect(bad((t) => (t.source = "grok binary default_models.json"))).toContain("is not");
    expect(bad((t) => (t.digest = "a".repeat(64)))).toContain("unknown key");
    expect(bad((t) => delete t.models["grok-4.7"].evidence)).toContain("is missing");
    expect(bad((t) => (t.models["grok-4.7"].observedAt = "yesterday"))).toContain("not an id");
    expect(bad((t) => (t.models["grok-4.7"].context = 256.5))).toContain("integer");
    expect(changeProblems("grok-observed-windows", observed(), { ...observed(), models: {} }).problems).toEqual([]);
  });

  test("the grok table is a header and, per model, a window, where it came from (the binary or a marked models.dev seed) and a price shaped as models.dev's; an unknown key is refused anywhere", () => {
    expect(check("grok-models.json", grokModels())).toMatchObject({ ok: true });
    const bad = (mutate: (t: Record<string, any>) => void) => {
      const t = grokModels();
      mutate(t);
      return tableProblem("grok-models", t);
    };
    const priced = Object.keys(grokModels().models).find((k) => grokModels().models[k].cost)!;
    const slug = Object.keys(grokModels().models)[0]!;
    expect(bad(() => {})).toBeNull();
    expect(bad((t) => (t.extra = 1))).toContain("unknown key");
    expect(bad((t) => (t.catalogDigest = "a".repeat(64)))).toContain("unknown key");
    expect(bad((t) => (t.source = "grok"))).toContain("is not");
    expect(bad((t) => (t.models[slug].label = "x"))).toContain("unknown key");
    expect(bad((t) => (t.models[slug].source = "guess"))).toContain("is not");
    expect(bad((t) => (t.models[priced].costSource = "guess"))).toContain("is not");
    // models.dev's window is no window (BUG-396): a seed marks a price only; a model may have a price and no window.
    expect(bad((t) => (t.models[slug].source = "models.dev-seed"))).toContain("is not");
    expect(bad((t) => (delete t.models[slug].context, delete t.models[slug].source))).toBeNull();
    expect(bad((t) => (t.models[slug].context = 12.5))).toContain("integer");
    expect(bad((t) => (t.models[slug].autoCompactPercent = 0))).toContain("number from 1 to 100");
    expect(bad((t) => (t.models[priced].cost.input = -1))).toContain("number from 0 to");
    expect(bad((t) => (t.models[priced].cost.extra = 1))).toContain("unknown key");
    expect(bad((t) => (t.models["bad key"] = t.models[slug]))).toContain("not an id");
    expect(bad((t) => (t.models = {}))).toContain("no models");
    expect(bad((t) => ((t.generatedAt = "2026-10-04T12:00:00.000Z"), (t.fetchedAt = "2026-10-04T12:00:00.000Z")))).toBeNull();
  });

  test("the change guard sees a Grok price that moves too far, and a Grok model that disappears", () => {
    const next = grokModels();
    const priced = Object.keys(next.models).find((k) => next.models[k].cost)!;
    next.models[priced].cost.input *= 10;
    expect(changeProblems("grok-models", grokModels(), next).problems.join("\n")).toContain(`${priced}.cost.input moved more than 3x`);
    delete next.models[Object.keys(next.models)[0]!];
    expect(changeProblems("grok-models", grokModels(), next).problems.join("\n")).toContain("disappeared");
    expect(changeProblems("grok-models", grokModels(), grokModels()).problems).toEqual([]);
  });
});

describe("BUG-470/openrouter-disagreement: models.dev against OpenRouter's listing is reported in the daily PR, never a failure", () => {
  const withDisagreement = () => {
    const t = modelsdev();
    const key = "openrouter/deepseek/deepseek-v4.1-flash";
    t.entries[key] = { ...t.entries[key], cost: { input: 0.003, output: 2.4, cache_read: 0.003 }, priceSource: "openrouter", modelsdevCost: { input: 0.3, output: 1.2, cache_read: 0.006 } };
    return { t, key };
  };

  test("the schema takes priceSource and modelsdevCost, and nothing else new", () => {
    const { t, key } = withDisagreement();
    expect(check("modelsdev.json", t)).toMatchObject({ ok: true });
    t.entries[key].priceSource = "somewhere";
    expect(check("modelsdev.json", t).ok).toBe(false);
  });

  test("a disagreement of more than 3x on a price is a line of the report; models.dev's within 3x is not; the run passes either way", () => {
    const { t, key } = withDisagreement();
    const dir = scratch();
    try {
      // The committed table as the baseline, without the disagreement.
      const base = modelsdev();
      writeFileSync(join(dir, "modelsdev.json"), text(base));
      const r = check("modelsdev.json", t, { baseline: dir, reportLarge: true });
      expect(r.ok).toBe(true);
      const line = r.large.find((l) => l.includes("disagree"))!;
      expect(line).toContain(key);
      expect(line).toContain("input 0.3 (models.dev) vs 0.003 (OpenRouter)");
      // Output (2x) and cache read (2x) are within 3x: not named.
      expect(line).not.toContain("output");
      expect(line).not.toContain("cache_read");
      // Without the report flag the strict guard is unchanged and the disagreement alone is no failure.
      expect(check("modelsdev.json", t, { baseline: dir }).ok).toBe(true);
      // Reported once: a committed table that already carries the same models.dev row reports nothing.
      writeFileSync(join(dir, "modelsdev.json"), text(t));
      expect(check("modelsdev.json", t, { baseline: dir, reportLarge: true }).large.filter((l) => l.includes("disagree"))).toEqual([]);
      // A disagreement under 3x is kept in the table but not reported.
      t.entries[key].modelsdevCost = { input: 0.005, output: 1.2, cache_read: 0.005 };
      writeFileSync(join(dir, "modelsdev.json"), text(base));
      expect(check("modelsdev.json", t, { baseline: dir, reportLarge: true }).large.filter((l) => l.includes("disagree"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("BUG-361/max-change-guard: a large change is refused; --accept-large takes it and prints what moved", () => {
  const priceLeaves = (t: Record<string, any>) => Object.values(t.entries as Record<string, any>);

  test("a small honest change passes (and says how many prices moved)", () => {
    const t = modelsdev();
    priceLeaves(t)[0].cost.input *= 1.1;
    const r = check("modelsdev.json", t);
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("1 price moved");
  });

  test("more than 15% of the prices changed is refused, even when no one price moved much", () => {
    const t = modelsdev();
    for (const e of priceLeaves(t)) e.cost.input *= 1.5;
    const r = check("modelsdev.json", t);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/prices changed \(more than 15%\)/);
    expect(check("modelsdev.json", t, { acceptLarge: true }).ok).toBe(true);
  });

  test("one price moving by more than 3x is refused; --accept-large passes and prints it", () => {
    const t = modelsdev();
    const [key, e] = Object.entries(t.entries as Record<string, any>)[0]!;
    const was = e.cost.output;
    e.cost.output = was * 4;
    const refused = check("modelsdev.json", t);
    expect(refused.ok).toBe(false);
    expect(refused.lines.join("\n")).toContain(`${key}.cost.output moved more than 3x`);
    const taken = check("modelsdev.json", t, { acceptLarge: true });
    expect(taken.ok).toBe(true);
    expect(taken.lines.join("\n")).toContain(`moved ${key}.cost.output: ${was} -> ${was * 4}`);
    // The shape is never overridable.
    t.extra = 1;
    expect(check("modelsdev.json", t, { acceptLarge: true }).ok).toBe(false);
  });

  test("a model that disappears is refused (both tables); a Claude tier change moves every model on it", () => {
    const t = modelsdev();
    const gone = Object.keys(t.entries)[0]!;
    delete t.entries[gone];
    expect(check("modelsdev.json", t).lines.join("\n")).toContain(`model ${gone} disappeared`);
    const c = claude();
    const id = c.models[0].id;
    c.models.shift();
    expect(check("claude-catalog.json", c).lines.join("\n")).toContain(`model ${id} disappeared`);
    const tier = claude();
    tier.pricingTiers[tier.models[0].pricing].input *= 5;
    expect(check("claude-catalog.json", tier).ok).toBe(false);
  });

  test("a zero price is allowed only where the committed table already had zero", () => {
    const base = scratch();
    try {
      const committed = modelsdev();
      const [k0, k1] = Object.keys(committed.entries);
      committed.entries[k0!].cost.cache_write = 0;
      writeFileSync(join(base, "modelsdev.json"), text(committed));
      // Zero in both: fine.
      expect(check("modelsdev.json", committed, { baseline: base })).toMatchObject({ ok: true });
      // A price that became zero, or a zero the committed table had no price for.
      const next = clone(committed);
      next.entries[k1!].cost.output = 0;
      const r = check("modelsdev.json", next, { baseline: base });
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toContain("became zero");
      const first = modelsdev();
      first.entries[k1!].cost.cache_read = 0;
      expect(check("modelsdev.json", first, { baseline: join(base, "nowhere") }).lines.join("\n")).toContain("zero price");
      // A model new to the table may be free (models.dev lists free models, and a widened table gains them); a zero on a model it already had is refused.
      const grown = clone(committed);
      grown.entries["free/new-model"] = { cost: { input: 0, output: 0, cache_read: 0 }, context: 100_000 };
      expect(check("modelsdev.json", grown, { baseline: base })).toMatchObject({ ok: true });
      const existing = clone(committed);
      delete existing.entries[k1!].cost.cache_write;
      existing.entries[k1!].cost.cache_read = 0;
      existing.entries[k1!].cost.cache_write = 0;
      const zeroed = check("modelsdev.json", existing, { baseline: base });
      expect(zeroed.ok).toBe(false);
      expect(zeroed.lines.join("\n")).toMatch(/zero price|became zero/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/** Every file and directory under `root`, relative. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      out.push(relative(root, p));
      if (lstatSync(p).isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

describe("BUG-363/pricing-update: writes only the local store; the store reads back only a valid table", () => {
  describe("the local store (tables-store.ts)", () => {
    const fixture = BUNDLED_TABLES["claude-catalog"];
    const good = () => ({ ...claudeTable(published(addModel), { version: "2.9.9" }), generatedAt: "2026-10-04T12:00:00.000Z", fetchedAt: "2026-10-04T12:00:00.000Z" });
    const withTable = (t: unknown, body = text(t)) => {
      const dir = scratch();
      writeFileSync(join(dir, "claude-catalog.json"), body);
      return dir;
    };
    const read = (dir: string) => readStoredTable("claude-catalog", dir);

    test("a valid stored table is read, whatever its date (there is no bundled table to be newer than)", () => {
      for (const t of [good(), { ...good(), generatedAt: "2000-01-01T00:00:00.000Z" }, (({ generatedAt: _, fetchedAt: __, ...rest }) => rest)(good())]) {
        const dir = withTable(t);
        try {
          expect(read(dir)).toMatchObject({ source: "claude-code binary" });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    test("an invalid, other-schema, linked, oversized or missing stored table is no table", () => {
      const cases: [string, unknown][] = [
        ["unknown key", { ...good(), extra: 1 }],
        ["a key of the old overlay", { ...good(), basedOn: "0".repeat(64) }],
        ["bad id string", { ...good(), claudeCodeVersion: "two point one" }],
        ["another schema", { ...good(), schema: 2 }],
        ["another table's source", { ...good(), source: "models.dev" }],
        ["a moment that is not one", { ...good(), fetchedAt: "yesterday" }],
        ["not JSON", "{nope"],
      ];
      for (const [why, t] of cases) {
        const dir = withTable(t, typeof t === "string" ? t : text(t));
        try {
          expect([why, read(dir)]).toEqual([why, undefined]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      const big = withTable(null, `${text(good())}${" ".repeat(2_100_000)}`);
      expect(read(big)).toBeUndefined();
      expect(read(join(big, "nowhere"))).toBeUndefined();
      rmSync(big, { recursive: true, force: true });
      if (process.platform !== "win32") {
        const dir = scratch();
        try {
          writeFileSync(join(dir, "real.json"), text(good()));
          symlinkSync(join(dir, "real.json"), join(dir, "claude-catalog.json"));
          expect(read(dir)).toBeUndefined();
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    test("a models.dev table may list models it has no price for, and needs only one entry", () => {
      const t = { ...modelsdev(), missing: ["openrouter/vendor/new-model"], entries: { "anthropic/claude-haiku-4-5": Object.values(modelsdev().entries as Record<string, any>)[0] } };
      expect(tableProblem("modelsdev", t)).toBeNull();
      expect(tableProblem("modelsdev", { ...t, entries: {} })).toContain("no entries");
      expect(tableProblem("modelsdev", { ...modelsdev(), fetchedAt: "2026-10-04T12:00:00.000Z" })).toBeNull();
    });

    test("buildModelsDevTable (the one builder of the CLI and the run-time refresh): sources in, a valid table out, models it has no price for listed in `missing`, not refused", () => {
      const catalog = { anthropic: { models: { "claude-haiku-4-5": { cost: { input: 1, output: 5 }, limit: { context: 200_000 } } } } };
      const listing = { data: [{ id: "vendor/model", context_length: 8000, pricing: { prompt: "0.000001", completion: "0.000002" } }] };
      const table = buildModelsDevTable({ catalog, openrouterListing: listing, endpoints: {}, generatedAt: "2026-10-06T10:00:00.000Z", fetchedAt: "2026-10-06T10:00:00.000Z" });
      expect(table).toMatchObject({ schema: 1, source: "models.dev", catalogUpdatedAt: null, generatedAt: "2026-10-06T10:00:00.000Z", fetchedAt: "2026-10-06T10:00:00.000Z" });
      expect(table.entries["anthropic/claude-haiku-4-5"]).toMatchObject({ cost: { input: 1, output: 5 }, context: 200_000 });
      expect(table.missing.length).toBeGreaterThan(0);
      expect(tableProblem("modelsdev", table)).toBeNull();
      // The same inputs give the same table; an empty OpenRouter listing fails the build (BUG-477), it never leaves models.dev's prices in.
      expect(buildModelsDevTable({ catalog, openrouterListing: listing, endpoints: {}, generatedAt: "2026-10-06T10:00:00.000Z", fetchedAt: "2026-10-06T10:00:00.000Z" })).toEqual(table);
      expect(() => buildModelsDevTable({ catalog, openrouterListing: { data: [] }, endpoints: {}, generatedAt: "x" })).toThrow("no models");
    });

    test("writing: a valid table lands in a private directory, nothing else is left beside it, and it reads back", () => {
      const root = scratch();
      try {
        const dir = join(root, "state", "gluon", "tables");
        expect(writeStoredTable("claude-catalog", good(), dir, false)).toBeUndefined();
        expect(tree(root)).toEqual(["state", join("state", "gluon"), join("state", "gluon", "tables"), join("state", "gluon", "tables", "claude-catalog.json")]);
        if (process.platform !== "win32") {
          expect(lstatSync(dir).mode & 0o777).toBe(0o700);
          expect(lstatSync(join(dir, "claude-catalog.json")).mode & 0o777).toBe(0o600);
        }
        expect(read(dir)).toMatchObject({ claudeCodeVersion: "2.9.9" });
        // A newer table replaces it whole.
        writeStoredTable("claude-catalog", { ...good(), claudeCodeVersion: "second" }, dir, false);
        expect(read(dir)).toMatchObject({ claudeCodeVersion: "second" });
        expect(readdirSync(dir)).toEqual(["claude-catalog.json"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("writing is atomic: a failure on the way leaves the old table whole and no partial file", () => {
      const root = scratch();
      try {
        const dir = join(root, "tables");
        writeStoredTable("claude-catalog", good(), dir, false);
        const before = readFileSync(join(dir, "claude-catalog.json"), "utf8");
        expect(() =>
          writeStoredTable("claude-catalog", { ...good(), claudeCodeVersion: "second" }, dir, false, () => {
            throw new Error("disk full");
          }),
        ).toThrow("disk full");
        expect(readFileSync(join(dir, "claude-catalog.json"), "utf8")).toBe(before);
        expect(readdirSync(dir)).toEqual(["claude-catalog.json"]);
        // A first write that fails leaves nothing but the (empty) directory.
        const fresh = join(root, "fresh");
        expect(() =>
          writeStoredTable("claude-catalog", good(), fresh, false, () => {
            throw new Error("disk full");
          }),
        ).toThrow("disk full");
        expect(readdirSync(fresh)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("an invalid table is refused before anything is written", () => {
      const root = scratch();
      try {
        const dir = join(root, "tables");
        expect(() => writeStoredTable("claude-catalog", { ...good(), extra: 1 }, dir, false)).toThrow(/not stored.*unknown key/);
        expect(() => writeStoredTable("modelsdev", good(), dir, false)).toThrow(/not stored/);
        expect(existsSync(dir)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("the registry: setTables replaces the tables named (undefined removes one) and tells the listeners; the store is read once, at import", async () => {
      const { onTablesChanged } = await import("../src/cost/tables.ts");
      const was = currentTables();
      let calls = 0;
      const off = onTablesChanged(() => calls++);
      try {
        // The preload seeded the run's store with the fixtures.
        expect(was.modelsdev?.source).toBe("models.dev");
        expect(was.claudeCatalog?.catalogDigest).toBe(fixture.catalogDigest);
        const next = { ...fixture, claudeCodeVersion: "9.9.9" };
        setTables({ claudeCatalog: next });
        expect([calls, currentTables().claudeCatalog?.claudeCodeVersion, currentTables().modelsdev]).toEqual([1, "9.9.9", was.modelsdev]);
        // The earlier snapshot is not mutated: a holder of it keeps the tables it priced with.
        expect(was.claudeCatalog?.claudeCodeVersion).toBe(fixture.claudeCodeVersion);
        setTables({ modelsdev: undefined });
        expect("modelsdev" in currentTables()).toBe(false);
        expect(priceEntry("anthropic/claude-haiku-4-5")).toBeUndefined();
        off();
        setTables({});
        expect(calls).toBe(2);
      } finally {
        off();
        setTables({ ...was, ...(was.modelsdev ? {} : { modelsdev: undefined }) });
      }
      expect(currentTables().modelsdev).toBe(was.modelsdev);
    });

    test("the module a Gluon starts with takes the tables from the state directory: each one valid there, and none for one that is absent or invalid", () => {
      const run = (state: string) => {
        const r = Bun.spawnSync([process.execPath, "--no-env-file", "--config=scripts/empty-bunfig.toml", "-e", 'import { currentTables, tableInfos } from "./src/cost/tables.ts"; const t = currentTables(); console.log(t.claudeCatalog ? `${t.claudeCatalog.source} ${t.claudeCatalog.models.length}` : "none", t.modelsdev ? "dev" : "nodev", tableInfos().length)'], { cwd: ROOT, env: { ...process.env, XDG_STATE_HOME: state }, stdout: "pipe", stderr: "pipe" });
        return r.stdout.toString().trim();
      };
      const state = scratch();
      try {
        expect(run(state)).toBe("none nodev 0");
        const dir = join(state, "gluon", "tables");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "claude-catalog.json"), text(good()));
        expect(run(state)).toBe(`claude-code binary ${fixture.models.length + 1} nodev 1`);
        writeFileSync(join(dir, "claude-catalog.json"), text({ ...good(), extra: 1 }));
        expect(run(state)).toBe("none nodev 0");
      } finally {
        rmSync(state, { recursive: true, force: true });
      }
    });
  });

  test("the store is light: Node builtins, the private-file writer and the pure validator only (nothing `gluon hook` could pull in)", () => {
    for (const f of ["src/cost/tables-store.ts", "src/cost/table-schema.ts"]) {
      const imports = [...readFileSync(join(ROOT, f), "utf8").matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]!);
      expect(imports.filter((i) => !i.startsWith("node:") && i !== "./table-schema.ts" && i !== "../secrets.ts" && i !== "../xdg.ts")).toEqual([]);
    }
    // `../xdg.ts` (a relative XDG_STATE_HOME is ignored: BUG-620) is as light as the store itself: Node builtins only.
    const xdg = [...readFileSync(join(ROOT, "src/xdg.ts"), "utf8").matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]!);
    expect(xdg.filter((i) => !i.startsWith("node:"))).toEqual([]);
  });
});

describe("BUG-364/uninstall: the overlay goes with the rest of Gluon's files", () => {
  test("uninstallTargets names the tables directory when it exists, and not before", () => {
    const state = scratch();
    const was = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    try {
      const dir = tablesDir();
      expect(dir).toBe(join(state, "gluon", "tables"));
      expect(uninstallTargets(join(state, "no-tmp"))).not.toContain(dir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "claude-catalog.json"), "{}");
      expect(uninstallTargets(join(state, "no-tmp"))).toContain(dir);
    } finally {
      if (was === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = was;
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("BUG-362/generators: the daily job's scripts keep a table's day when nothing else changed, and never find a binary on PATH", () => {
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    const r = Bun.spawnSync([process.execPath, "--no-env-file", "--config=scripts/empty-bunfig.toml", join("scripts", "pricing", script), ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const day = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { generatedAt: string }).generatedAt;
  /** The two OpenRouter sources as files (a listing of one unrelated model) in `dir`: modelsdev.ts never fetches without `--live` (BUG-520). */
  const orFiles = (dir: string) => {
    writeFileSync(join(dir, "or-listing.json"), JSON.stringify({ data: [{ id: "x/unused", context_length: 1000, pricing: { prompt: "0.000001", completion: "0.000002" } }] }));
    writeFileSync(join(dir, "or-endpoints.json"), "{}");
    return ["--openrouter-from", join(dir, "or-listing.json"), "--openrouter-endpoints-from", join(dir, "or-endpoints.json")];
  };

  test("modelsdev.ts: the same catalog on a later day leaves the file's day; a changed catalog gets today's; an explicit --generated-at is taken as given", () => {
    const dir = scratch();
    try {
      const out = join(dir, "m.json");
      const from = join(dir, "c.json");
      writeFileSync(from, "{}");
      expect(run("modelsdev.ts", ["--from", from, ...orFiles(dir), "--out", out, "--generated-at", "2020-01-02"]).code).toBe(0);
      expect(day(out)).toBe("2020-01-02");
      const before = readFileSync(out, "utf8");
      expect(run("modelsdev.ts", ["--from", from, ...orFiles(dir), "--out", out]).code).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(before);
      // A change outside the bundled entries leaves the table as it was; one inside it gets today's day.
      writeFileSync(from, '{"unrelated":{"models":{}}}');
      expect(run("modelsdev.ts", ["--from", from, ...orFiles(dir), "--out", out]).code).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(before);
      writeFileSync(from, '{"xai":{"models":{"grok-4.6":{"cost":{"input":2,"output":4},"limit":{"context":200000}}}}}');
      expect(run("modelsdev.ts", ["--from", from, ...orFiles(dir), "--out", out]).code).toBe(0);
      expect(day(out)).toBe(new Date().toISOString().slice(0, 10));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("BUG-520/offline-generator: modelsdev.ts without --live refuses to fetch: each missing source is an error naming the flag, and a live fetch is never attempted", () => {
    const dir = scratch();
    try {
      const out = join(dir, "m.json");
      const from = join(dir, "c.json");
      writeFileSync(from, "{}");
      // The script has no host override, so the proof is the refusal itself (before any request) for each source in turn, with the other two given.
      const or = orFiles(dir);
      const [orFrom, orFile, epFrom, epFile] = or as [string, string, string, string];
      for (const [missing, args] of [
        ["--from", [orFrom, orFile, epFrom, epFile]],
        ["--openrouter-from", ["--from", from, epFrom, epFile]],
        ["--openrouter-endpoints-from", ["--from", from, orFrom, orFile]],
      ] as const) {
        const r = run("modelsdev.ts", [...args, "--out", out]);
        expect(r.code).not.toBe(0);
        expect(r.err).toContain(`no ${missing}`);
        expect(existsSync(out)).toBe(false);
      }
      // With every source a file, `--live` changes nothing (nothing is missing, so nothing is fetched).
      expect(run("modelsdev.ts", ["--from", from, ...or, "--out", out, "--live"]).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("modelsdev.ts: two upstream catalogs that differ only outside the trimmed set give identical bytes; a change inside it changes the digest", () => {
    const dir = scratch();
    try {
      const model = (input: number) => ({ cost: { input, output: input * 2 }, limit: { context: 200_000 } });
      const write = (name: string, catalog: unknown) => {
        const from = join(dir, `${name}-in.json`);
        const out = join(dir, `${name}-out.json`);
        writeFileSync(from, JSON.stringify(catalog));
        expect(run("modelsdev.ts", ["--from", from, ...orFiles(dir), "--out", out, "--generated-at", "2020-01-02"]).code).toBe(0);
        return readFileSync(out, "utf8");
      };
      const a = write("a", { xai: { models: { "grok-4.6": model(2) } }, "other-provider": { models: { x: model(1) } } });
      const b = write("b", { xai: { models: { "grok-4.6": model(2) } }, "other-provider": { models: { x: model(9), y: model(3) } }, "brand-new": { models: { z: model(4) } } });
      expect(b).toBe(a);
      const c = write("c", { xai: { models: { "grok-4.6": model(3) } } });
      expect(JSON.parse(c).catalogDigest).not.toBe(JSON.parse(a).catalogDigest);
      expect(JSON.parse(a).catalogDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("codex.ts and grok.ts: the same catalog or binary leaves the file as it was; a changed one gets today's day", () => {
    const dir = scratch();
    try {
      const today = new Date().toISOString().slice(0, 10);
      const catalog = (extra = 0) => JSON.stringify({ models: [{ slug: "gpt-t", context_window: 272_000 + extra }] });
      const cx = join(dir, "codex.json");
      const cat = join(dir, "cat.json");
      writeFileSync(cat, catalog());
      expect(run("codex.ts", ["--catalog", cat, "--codex-version", "1.0.0", "--out", cx, "--generated-at", "2020-01-02"]).code).toBe(0);
      const cxBefore = readFileSync(cx, "utf8");
      expect(run("codex.ts", ["--catalog", cat, "--codex-version", "1.0.0", "--out", cx]).code).toBe(0);
      expect(readFileSync(cx, "utf8")).toBe(cxBefore);
      writeFileSync(cat, catalog(1000));
      expect(run("codex.ts", ["--catalog", cat, "--codex-version", "1.0.0", "--out", cx]).code).toBe(0);
      expect(day(cx)).toBe(today);

      const gk = join(dir, "grok.json");
      const bin = join(dir, "grok-bin");
      const binary = (window: number) => Buffer.from(`\0junk {"models":[1]}\0${JSON.stringify({ models: [{ id: "grok-t", context_window: window }] })}\0`);
      writeFileSync(bin, binary(500_000));
      expect(run("grok.ts", ["--binary", bin, "--grok-version", "1.0.1", "--out", gk, "--generated-at", "2020-01-02"]).code).toBe(0);
      const gkBefore = readFileSync(gk, "utf8");
      expect(run("grok.ts", ["--binary", bin, "--grok-version", "1.0.1", "--out", gk]).code).toBe(0);
      expect(readFileSync(gk, "utf8")).toBe(gkBefore);
      writeFileSync(bin, binary(600_000));
      expect(run("grok.ts", ["--binary", bin, "--grok-version", "1.0.1", "--out", gk]).code).toBe(0);
      expect(day(gk)).toBe(today);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("claude.ts, codex.ts, grok.ts and oracle-claude.ts refuse to run without --binary, even with a binary of that name on PATH", () => {
    const dir = scratch();
    try {
      for (const name of ["claude", "codex", "grok"]) writeFileSync(join(dir, name), "#!/bin/sh\necho should-never-run\n", { mode: 0o755 });
      for (const script of ["claude.ts", "codex.ts", "grok.ts", "oracle-claude.ts"]) {
        const r = run(script, ["--out", join(dir, "x.json")], { PATH: `${dir}:${process.env.PATH}` });
        expect([script, r.code === 0, r.err.includes("pass --binary"), r.out.includes("should-never-run")]).toEqual([script, false, true, false]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("BUG-521/tables-from: GLUON_TEST_TABLES_FROM seeds a test's store from freshly built tables, all four required", () => {
  test("the named directory's tables are copied, not the fixtures'; a missing one fails loudly", () => {
    const from = scratch();
    const to = scratch();
    const was = process.env.GLUON_TEST_TABLES_FROM;
    try {
      for (const f of FIXTURE_TABLE_FILES) writeFileSync(join(from, f), `{"from":"${f}"}`);
      process.env.GLUON_TEST_TABLES_FROM = from;
      seedTables(join(to, "tables"));
      expect(readFileSync(join(to, "tables", "modelsdev.json"), "utf8")).toBe('{"from":"modelsdev.json"}');
      rmSync(join(from, "grok-models.json"));
      expect(() => seedTables(join(to, "again"))).toThrow();
    } finally {
      if (was === undefined) delete process.env.GLUON_TEST_TABLES_FROM;
      else process.env.GLUON_TEST_TABLES_FROM = was;
      rmSync(from, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });
});

describe("BUG-522/shape-only: validate.ts --shape-only refuses a table Gluon would refuse and nothing else", () => {
  test("a 100x move and a new zero price pass; an unknown key does not", () => {
    const moved = modelsdev();
    const key = Object.keys(moved.entries)[0]!;
    moved.entries[key].cost.input = moved.entries[key].cost.input * 100 + 1;
    moved.entries[key].cost.output = 0;
    const r = check("modelsdev.json", moved, { shapeOnly: true, baseline: COMMITTED });
    expect([r.ok, r.large]).toEqual([true, []]);
    expect(check("modelsdev.json", moved, { baseline: COMMITTED }).ok).toBe(false);
    const bad = modelsdev();
    bad.surprise = 1;
    expect(check("modelsdev.json", bad, { shapeOnly: true }).ok).toBe(false);
  });
});
