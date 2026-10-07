/**
 * The guides link to the generated reference instead of copying what code already says
 * ("Markdown files" in the root AGENTS.md): no model id from `DEFAULT_MODELS` and no long flag from
 * `CLI_OPTIONS`, `usageText` or `PRICING_HELP` (every source of the generated command-line page) and no
 * installer variable of `docs/reference/env.md` in `docs/getting-started/`, `docs/guides/` or `docs/index.mdx`. A genuine example
 * (a command the reader types) goes in a fenced block preceded by the line `<!-- example -->`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODELS } from "../src/harnesses.ts";
import { defaults } from "../src/config.ts";
import { PRICING_HELP } from "../src/cost/pricing-update.ts";
import { DEFAULT_KEY } from "../src/handoff.ts";
import { CLI_OPTIONS, usageText } from "../src/usage.ts";

const ROOT = join(import.meta.dir, "..");

/**
 * Ids that are ordinary words or too short to tell from prose ("haiku", "opus", "sonnet", "fable"
 * are model families the guides name in plain text) are not searched for; every longer id is.
 */
const ENGLISH = new Set(["haiku", "sonnet", "opus", "fable"]);
const IDS = [...new Set(Object.values(DEFAULT_MODELS).flat().flatMap((m) => [m.id, ...Object.values(m.ids)]))]
  .filter((id): id is string => !!id && id.length >= 6 && !ENGLISH.has(id.toLowerCase()));
/** Every long flag the generated command-line page shows: the parsed options, the usage text and `gluon pricing update`'s help (BUG-546). */
export const LONG_FLAGS = (usage: string, pricing: string): string[] => [
  ...new Set([...Object.keys(CLI_OPTIONS).map((n) => `--${n}`), ...((usage + "\n" + pricing).match(/(?<![\w-])--[a-z]+(?:-[a-z]+)*/g) ?? [])]),
];
const FLAGS = LONG_FLAGS(usageText(defaults(), "<version>"), PRICING_HELP);
/** The environment variables `docs/reference/env.md` owns: guides say what they do in words and link it (BUG-547). Provider key names (`ANTHROPIC_API_KEY`) stay allowed. */
export const GLUON_VARS = (envPage: string): string[] => [...new Set(envPage.match(/\bGLUON_[A-Z0-9_]+/g) ?? [])];
const ENV_VARS = GLUON_VARS(readFileSync(join(ROOT, "docs/reference/env.md"), "utf8"));

const walk = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : /\.mdx?$/.test(p) ? [p] : []);
const FILES = ["docs/getting-started", "docs/guides", "docs/index.mdx"].flatMap((p) => walk(join(ROOT, p))).map((p) => p.slice(ROOT.length + 1).replaceAll("\\", "/"));

/** The page without its marked examples: a fenced block right after an `<!-- example -->` line. */
export const withoutExamples = (md: string): string =>
  md.replace(/^<!-- example -->[ \t]*\n```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, "");

const occurs = (text: string, needle: string) => new RegExp(`(?<![\\w.\\-/:])${needle.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w.\\-])`).test(text);

test("withoutExamples removes only a fence marked as an example", () => {
  const md = "a --x\n<!-- example -->\n```sh\ngluon --x\n```\nb\n```sh\ngluon --y\n```\n";
  const out = withoutExamples(md);
  expect(out).not.toContain("gluon --x\n");
  expect(out).toContain("gluon --y");
});

test("the guides are found (the test would pass vacuously otherwise)", () => {
  expect(FILES.length).toBeGreaterThan(10);
  expect(IDS.length).toBeGreaterThan(10);
  expect(ENV_VARS).toContain("GLUON_RELEASE_URL");
});

test("BUG-546/flags from every source of the command-line page: the parsed options, the usage text and the pricing help", () => {
  expect(FLAGS).toContain("--launch");
  expect(FLAGS).toContain("--dry-run");
  expect(FLAGS).not.toContain("--accept-large");
  expect(LONG_FLAGS("gluon --a-b [--c]", "x --d-e\n  --f")).toEqual(expect.arrayContaining(["--a-b", "--c", "--d-e", "--f"]));
  expect(occurs("take it with --dry-run now", "--dry-run")).toBe(true);
});

test("BUG-547/installer variables: GLUON_* names owned by env.md are found", () => {
  expect(GLUON_VARS("| `GLUON_VERSION` | a |\n| `GLUON_ADD_TO_PATH` | b | `HOME` `GLUON_VERSION`")).toEqual(["GLUON_VERSION", "GLUON_ADD_TO_PATH"]);
  expect(ENV_VARS).toEqual(expect.arrayContaining(["GLUON_INSTALL_DIR", "GLUON_VERSION", "GLUON_CONFIG"]));
});

test("BUG-548/the home key's default is in the config reference and the keyboard guide, not restated in other guides", () => {
  const others = FILES.filter((f) => f.startsWith("docs/guides/") && f !== "docs/guides/keyboard.md");
  expect(others.filter((f) => readFileSync(join(ROOT, f), "utf8").toLowerCase().includes(DEFAULT_KEY))).toEqual([]);
});

describe.each(FILES.map((f) => [f]))("%s", (file) => {
  const text = withoutExamples(readFileSync(join(ROOT, file), "utf8"));

  test("copies no model id (say it in words and link ../reference/models.md, or mark a real example with <!-- example -->)", () => {
    expect(IDS.filter((id) => occurs(text, id))).toEqual([]);
  });

  test("copies no CLI flag (link ../reference/cli.md, or mark a real example with <!-- example -->)", () => {
    expect(FLAGS.filter((f) => occurs(text, f))).toEqual([]);
  });

  test("copies no installer variable (say what it does and link ../reference/env.md, or mark a real example with <!-- example -->)", () => {
    expect(ENV_VARS.filter((v) => occurs(text, v))).toEqual([]);
  });
});
