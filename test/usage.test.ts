import { expect, test } from "bun:test";
import { defaults } from "../src/config.ts";
import { usageText } from "../src/usage.ts";

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
