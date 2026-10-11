/**
 * The real-harness tier (issue #31): Gluon launches the real, pinned harness binary (test/harnesses.json; `--newest` in
 * `bun run regression`, and CI when the pin is behind: the newest release) in its frame, and the harness's model traffic goes to
 * a model API on loopback (test/fixtures/fake-model-api.ts, through the `GLUON_TEST_MODEL_URL` seam). Offline and free.
 *
 * Each harness gets the live check's assertions (scripts/live-harness.ts `checkHarness`): the frame shows the agent, the status goes
 * working → awaiting, the agent's "OK" is on screen, the reader finds the input line (a typed /clear makes Gluon ask), the home key
 * and back, and the cost figure. What a fake TUI can't tell: whether the newest harness's screens still read right.
 *
 * Runs from `bun run regression`'s real stage (scripts/regression.ts), which installs the binaries first and names them in
 * `GLUON_REAL_BINS`; on its own, the cached pinned binaries (`bun scripts/harness-pin.ts --install`). Needs tmux (not on Windows).
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tablesDir } from "../../src/cost/tables-store.ts";
import { loadConfig } from "../../src/config.ts";
import type { Harness } from "../../src/harnesses.ts";
import { useSecrets } from "../../src/secrets.ts";
import { cachedBin, readPin } from "../../scripts/harness-cache.ts";
import { checkHarness, planHarness } from "../../scripts/live-harness.ts";
import { onPath } from "../../scripts/live-driver.ts";
import { NO_BUCKET_CAPS, Spend, type Available } from "../../scripts/live-lib.ts";
import { fakeModelApi } from "../fixtures/fake-model-api.ts";
import { seedTables } from "../fixtures/seed-tables.ts";

/** The harnesses that can be pointed at a loopback model API, and the API-key connection each uses. */
export const REAL_HARNESSES = { "claude-code": "anthropic", codex: "openai", opencode: "openrouter", "kimi-code": "openrouter" } as const;
const KEYS = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
/** The harnesses' own switches against phoning home (telemetry, updates, error reports): the tier stays on loopback. */
const QUIET = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_TELEMETRY: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_PROXY: "127.0.0.1" };

const wanted = (process.env.GLUON_REAL_HARNESSES ?? Object.keys(REAL_HARNESSES).join(",")).split(",").filter((h): h is keyof typeof REAL_HARNESSES => h in REAL_HARNESSES);
const given = JSON.parse(process.env.GLUON_REAL_BINS ?? "{}") as Partial<Record<Harness, { path: string; version: string }>>;
const pin = readPin();
const binary = (h: Harness) => given[h] ?? (cachedBin(h, pin[h]) ? { path: cachedBin(h, pin[h])!, version: pin[h].version } : null);
const tmux = !!(onPath("tmux") ?? onPath("tmux", "/usr/bin:/usr/local/bin:/opt/homebrew/bin"));

const KEY_VALUE = (k: string) => `sk-fake-${k.toLowerCase()}-0123456789`;
useSecrets(Object.values(KEYS).map((k) => [k, KEY_VALUE(k)]), "fake");

/**
 * The scratch HOME of a user who already went through the harness's first run (its theme, its "use this API key?" and its folder
 * trust): the harness's own files, in the scratch HOME only. What those screens look like is the live checks' (scripts/live-harness.ts).
 */
function firstRunDone(h: Harness, home: string, repo: string, key: string): void {
  if (h === "claude-code")
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects: { [repo]: { hasTrustDialogAccepted: true } } }));
}

describe.skipIf(!tmux)("the real harnesses, on a loopback model API", () => {
  for (const h of wanted) {
    const b = binary(h);
    test.skipIf(!b).concurrent(`${h}: the frame, working → awaiting, the reply, the input line (/clear asks), home and back, the cost`, async () => {
      const api = fakeModelApi("OK");
      const conn = REAL_HARNESSES[h];
      const have: Available = { hasKey: (k) => k === KEYS[conn], bedrock: false };
      const config = loadConfig();
      const plan = { ...planHarness(h, config, have, { conn }), binary: b!.path, version: b!.version };
      const lines: string[] = [];
      try {
        const r = await checkHarness(plan, config, {
          spend: new Spend(null, NO_BUCKET_CAPS, Infinity, false, false),
          home: "scratch",
          screens: false,
          turnMs: 90_000,
          say: (l) => lines.push(l),
          loopback: { url: api.url, env: QUIET },
          prepare: ({ home, repo }) => {
            // The fixture price tables in the scratch HOME's state directory: nothing is fetched.
            seedTables(tablesDir({ HOME: home }, process.platform, home));
            firstRunDone(h, home, repo, KEY_VALUE(KEYS[conn]));
          },
        });
        const fails = r.asserts.filter((a) => a.status === "FAIL");
        expect([h, b!.version, fails.map((a) => `${a.name}: ${a.detail}`), lines.filter((l) => l.startsWith("FAIL")).length ? lines.slice(-40) : []]).toEqual([h, b!.version, [], []]);
        expect([h, r.asserts.filter((a) => a.status === "PASS").map((a) => a.name), lines.slice(-60)]).toEqual([h, expect.arrayContaining(["Gluon's frame shows the agent", "status goes working → awaiting", 'the agent answered "OK"', "the reader finds the input line (/clear asks first)", "return to Gluon (home key) and back (Enter)"]), expect.anything()]);
        // The traffic went to loopback, not the provider.
        expect(api.requests.length).toBeGreaterThan(0);
      } finally {
        api.stop();
      }
    }, 240_000);
  }
});
