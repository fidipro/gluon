/**
 * Before any test. Every temp dir a run makes — the tests', the fixtures', and those of the
 * processes they start (gluon's `gluon-cwd-*`, killed apps included) — goes under one
 * per-run directory, removed when the run ends. On Windows the compiled fake agent (seconds, cached
 * outside that directory across runs) is built outside every test's timeout. Every test file gets a default timeout scaled by
 * GLUON_TEST_SLOW (the plugin below).
 * The run's state directory also gets the fixture price tables (`test/fixtures/seed-tables.ts`): Gluon ships none, so
 * every test process reads them from its local store, as the app does.
 * The run marks itself (`GLUON_TEST_RUN`, test/fixtures/run-sweep.ts): every process a test starts inherits it, and when the run ends,
 * on a signal too, whatever still carries it (an agent orphaned by a killed gluon) is ended; a killed run's leftovers go at the next start.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marker, RUN_ENV, sweepDeadRuns, sweepRun } from "./fixtures/run-sweep.ts";
import { seedTables } from "./fixtures/seed-tables.ts";
import { SLOW } from "./fixtures/slow.ts";

process.env.GLUON_TEST_REAL_TMP ??= tmpdir();
// `.native` on Windows: `realpathSync` keeps an 8.3 name (`C:\Users\RUNNER~1`, as on a runner), where git
// spells the same directory long, and Gluon's repository check compares the two (BUG-CANDIDATE/QA-win-04).
const root = (process.platform === "win32" ? realpathSync.native : realpathSync)(mkdtempSync(join(tmpdir(), "gluon-test-run-")));
for (const k of process.platform === "win32" ? ["TEMP", "TMP"] : ["TMPDIR"]) process.env[k] = root;
// Never the developer's own config (a test that needs one sets GLUON_CONFIG itself).
process.env.GLUON_CONFIG ??= join(root, "no-config.yaml");
// Never the developer's own state (cost-audit ledger, the local price tables).
process.env.XDG_STATE_HOME = join(root, "state");
// Never the developer's terminal's colours: with FORCE_COLOR (some terminals and agent shells set it) a Bun child colours a number it
// `console.log`s, and a test comparing that output exactly reads another text (`test/pricing-update.test.ts`).
delete process.env.FORCE_COLOR;
seedTables(join(process.env.XDG_STATE_HOME, "gluon", "tables"));
// Run from inside a Gluon session, these would point tests at its event file and return command.
for (const k of ["GLUON_EVENTS", "GLUON_SELF", "GLUON_HANDOFF"]) delete process.env[k];
// The run's marker (before any test starts a process): this run's own processes, wherever they are by then.
const own = marker(process.pid, root);
process.env[RUN_ENV] = own;
sweepDeadRuns(own); // a run that was killed outright could not sweep
const clean = () => {
  sweepRun(own); // first: a process still running in the directory may hold it (Windows: a locked exe)
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {} // Windows may keep a just-run exe locked a moment.
};
// A global hook (in a preload: after the last file); "exit" as a fallback.
afterAll(clean);
process.on("exit", clean);
// A killed run (Ctrl+C, `kill`, a CI timeout, a closed terminal) doesn't reach "exit": end its processes and directory here.
for (const [signal, n] of [["SIGINT", 2], ["SIGHUP", 1], ["SIGTERM", 15]] as const) {
  try {
    process.on(signal, () => {
      clean();
      process.exit(128 + n);
    });
  } catch {} // a platform without the signal
}

// The e2e scenarios' `test` ends the apps a test started when the test ends (test/e2e/scoped-test.ts): their files
// reach `bun:test` through it. Only files that use the e2e harness, and only the module specifier changes.
const SCOPED = join(import.meta.dir, "e2e", "scoped-test.ts");
// Each test file's default timeout (the plugin below). Windows keeps at least its 30 s (slow process starts, 15 ms timers).
const WIN32 = process.platform === "win32";
const UNIT_MS = Math.max(5_000 * SLOW, WIN32 ? 30_000 : 0);
const E2E_MS = 20_000 * SLOW;
Bun.plugin({
  name: "e2e-scoped-test",
  setup(build) {
    build.onLoad({ filter: /[\\/]test[\\/].*\.test\.tsx?$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const scoped = /harness\.ts"/.test(source) && source.includes('from "bun:test"');
      // (A plugin that returns nothing breaks the file's own `mock.module`s: the others go through as they are.)
      // Bun gives a preload's `setDefaultTimeout` to the first test file only: the others get 5 s again. So every file, on every
      // OS, sets its own on its first line (the stack traces keep their line numbers): a slow runner (GLUON_TEST_SLOW) gets
      // proportionally longer, and a scenario longer than the harness's own 10 s × SLOW waits, so a stuck wait reports itself.
      const text = scoped ? source.replace('from "bun:test"', `from ${JSON.stringify(SCOPED)}`) : source;
      const ms = /[\\/]test[\\/](e2e|visual|perf)[\\/]/.test(path) ? E2E_MS : UNIT_MS;
      const contents = `import { setDefaultTimeout as __gluonTimeout } from "bun:test"; __gluonTimeout(${ms}); ${text}`;
      return { contents, loader: path.endsWith("x") ? "tsx" : "ts" };
    });
  },
});

const { fakeExe, WIN } = await import("./e2e/fixtures.ts");
if (WIN) fakeExe();
