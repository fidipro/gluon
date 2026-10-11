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
import { tablesDir } from "../../src/cost/tables-store.ts";
import { loadConfig } from "../../src/config.ts";
import type { Harness } from "../../src/harnesses.ts";
import { useSecrets } from "../../src/secrets.ts";
import { firstRunDone, KEY_VALUE, KEYS, QUIET, REAL_HARNESSES } from "../fixtures/real-harness.ts";
import { cachedBin, readPin } from "../../scripts/harness-cache.ts";
import { checkHarness, planHarness } from "../../scripts/live-harness.ts";
import { onPath } from "../../scripts/live-driver.ts";
import { NO_BUCKET_CAPS, Spend, type Available } from "../../scripts/live-lib.ts";
import { fakeModelApi } from "../fixtures/fake-model-api.ts";
import { seedTables } from "../fixtures/seed-tables.ts";

const wanted = (process.env.GLUON_REAL_HARNESSES ?? Object.keys(REAL_HARNESSES).join(",")).split(",").filter((h): h is keyof typeof REAL_HARNESSES => h in REAL_HARNESSES);
const given = JSON.parse(process.env.GLUON_REAL_BINS ?? "{}") as Partial<Record<Harness, { path: string; version: string }>>;
const pin = readPin();
const binary = (h: Harness) => given[h] ?? (cachedBin(h, pin[h]) ? { path: cachedBin(h, pin[h])!, version: pin[h].version } : null);
const tmux = !!(onPath("tmux") ?? onPath("tmux", "/usr/bin:/usr/local/bin:/opt/homebrew/bin"));

useSecrets(Object.values(KEYS).map((k) => [k, KEY_VALUE(k)]), "fake");

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
