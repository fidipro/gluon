import { expect, test } from "bun:test";
import { defaults } from "../src/config.ts";
import { CLI_OPTIONS, SUBCOMMANDS, usageText } from "../src/usage.ts";

test("usageText: the version, every subcommand, every flag and every agent's models", () => {
  const text = usageText(defaults(), "9.9.9");
  expect(text.startsWith("gluon 9.9.9 — Gluon, a control platform for coding agents\n")).toBe(true);
  for (const c of SUBCOMMANDS) expect(text).toContain(`gluon ${c}`);
  for (const name of ["launch", "model", "effort", "mode", "dry-run", "all", "force", "delete", "demo", "version"]) expect(text).toContain(`--${name}`);
  expect(Object.keys(CLI_OPTIONS)).toContain("help");
  for (const a of defaults().agents) for (const m of a.models) expect(text).toContain(m.id);
  expect(text).not.toContain("undefined");
  expect(text).toContain("gluon stats");
  for (const form of ["gluon stats sessions", "gluon stats <id>", "gluon stats sql", "gluon stats --delete"]) expect(text).toContain(form);
});

// #96. `gluon pricing update` is `src/cost/refresh.ts`: models.dev and OpenRouter over the network, the installed
// binaries for Claude, Codex and Grok; nothing is asked of Claude's public catalog (BUG-523).
test("BUG-603/QA-cli-01: the `gluon pricing update` help text names only price sources src/cost/refresh.ts uses (#96)", async () => {
  const text = usageText(defaults(), "9.9.9");
  const at = text.indexOf("gluon pricing update");
  const entry = text.slice(at, text.indexOf("\n  gluon ", at + 1)).replace(/\s+/g, " ");
  const refresh = await Bun.file(new URL("../src/cost/refresh.ts", import.meta.url)).text();
  // The hosts refresh.ts fetches from are all named, and no download host it never calls is.
  expect(refresh).toContain('"https://models.dev/');
  expect(refresh).toContain('"https://openrouter.ai/');
  expect(entry).toContain("models.dev");
  expect(entry).toContain("OpenRouter");
  expect(refresh).not.toContain("downloads.claude.ai");
  expect(entry.toLowerCase()).not.toContain("public catalog");
});
