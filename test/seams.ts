/**
 * The seams: the only places a test may reach below Gluon's surface (docs/contributing/testing.md, rule 3). Each one's
 * contract is a type or an outside format, so its tests survive a refactor behind it; a test of any other `src/` module
 * restates the code. `test/catalog.test.ts` holds every unit test file to these modules (a shrinking baseline for the files
 * that aren't yet). Adding, changing or removing a seam is a maintainer's decision (`tests-reviewed`, `scripts/test-guard.ts`).
 */

export type Seam = {
  /** The contract: what goes in, what comes out. */
  says: string;
  /** The `src/` modules a test of this seam imports values from. */
  modules: string[];
};

export const SEAMS: Record<string, Seam> = {
  routing: {
    says: "routing.yaml, the model catalog and the brain's classification → agent · model · effort, and why; the intake's proposal checked against them",
    modules: ["src/routing.ts", "src/routing-config.ts", "src/intake.ts", "src/models.ts"],
  },
  adapters: {
    says: "a launch's context → the harness's argv, env and files; a hook's call → its result (`Adapter`, src/adapters/types.ts, and each harness's own hook, plugin and settings formats)",
    modules: [
      "src/adapters/index.ts",
      "src/adapters/types.ts",
      "src/adapters/common.ts",
      "src/adapters/claude-code.ts",
      "src/adapters/codex.ts",
      "src/adapters/opencode.ts",
      "src/adapters/grok-build.ts",
      "src/adapters/kimi-code.ts",
      "src/adapters/antigravity.ts",
      "src/adapters/permanent.ts",
      "src/adapters/agy-settings.ts",
    ],
  },
  readers: {
    says: "a harness's screen → its state (the input line, ready, awaiting a choice, plan mode), the Enter held or forwarded, and the bytes that paint it",
    modules: ["src/pty/readers/index.ts", "src/pty/screen.ts", "src/pty/intercept.ts", "src/pty/paint.ts"],
  },
  keys: {
    says: "the terminal's bytes → keys → what Gluon does with each (forward, home, a menu), the terminal modes it asks for and a drag's selection",
    modules: ["src/pty/keys.ts", "src/pty/compositor.ts", "src/pty/modes.ts", "src/pty/selection.ts"],
  },
  session: {
    says: "an agent's PTY output, its hooks' events and the user's keys → what reaches the agent, its state and activity, the launch's first line, the /clear and compaction question",
    modules: ["src/pty/session.ts"],
  },
  brain: {
    says: "the user's messages, with a model client → the intake's questions, its spec and its classification",
    modules: ["src/agent/session.ts"],
  },
  "brain-clients": {
    says: "Gluon's requests → each provider's wire format (against the loopback model API)",
    modules: ["src/agent/clients.ts", "src/agent/openai.ts", "src/agent/bedrock-converse.ts", "src/agent/codex.ts"],
  },
  "repo-tools": {
    says: "a tool call → its result: read-only, inside the repository, secret files refused",
    modules: ["src/agent/tools.ts"],
  },
  cost: {
    says: "captured real telemetry and the price tables → the cost figures",
    modules: ["src/cost/claude.ts", "src/cost/codex.ts", "src/cost/opencode.ts", "src/cost/grok.ts", "src/cost/kimi.ts", "src/cost/antigravity.ts", "src/cost/tables.ts", "src/telemetry.ts"],
  },
  secrets: {
    says: "text and environments → masked, or refused when a key or token would leak",
    modules: ["src/secrets.ts"],
  },
  files: {
    says: "a file an older (or this) version wrote → today's state: the config, the sessions, the workspaces, the cost ledger",
    modules: ["src/config.ts", "src/sessions.ts", "src/workspaces.ts", "src/cost/ledger-file.ts"],
  },
  "text-layout": {
    says: "text, a theme and a width → the rows it is drawn in: wrapped at words with no separator left dangling, Markdown's rows counted as drawn; the home list's columns, header and key list, the frame's tab strip, info line and bars",
    modules: ["src/ui/width.tsx", "src/ui/markdown.tsx", "src/ui/theme.ts", "src/ui/layout.ts", "src/pty/chrome.ts"],
  },
  polling: {
    says: "a work tree and an events directory over time → the files changed and the events read, and the processes and listings each poll costs",
    modules: ["src/files-poll.ts", "src/events.ts"],
  },
  doctor: {
    says: "a config, the probes' answers (`GLUON_TEST_PROBES`) and the agents on PATH → the lines `gluon doctor` and `gluon brain` print, and their exit code",
    modules: ["src/doctor.ts"],
  },
  update: {
    says: "a release (GitHub's `/latest` redirect, `SHA256SUMS`, its Sigstore bundle, a binary) and an executable → verified or refused, replaced or left as it was, and what is said at start",
    modules: ["src/update/update.ts", "src/update/verify.ts", "src/update/fetch.ts", "src/update/target.ts", "src/update/apply.ts"],
  },
  launch: {
    says: "a spec, a harness and the OS → the command line and the spec's hand-off; a Windows shim's safe arguments, the neutral directory, the stale sweep and the command a harness runs to reach Gluon (`GLUON_SELF`)",
    modules: ["src/launchers.ts", "src/handoff.ts", "src/detect.ts", "src/self.ts"],
  },
};

/** Imported for a test's setup, not tested through: the harness list, the state paths and the repository's slug. */
export const SUPPORT = ["src/harnesses.ts", "src/xdg.ts", "src/repo.ts"];

/**
 * Tests of the repository itself, not of Gluon: its tooling, docs and test infrastructure. Outside the catalog and the
 * seam rule; they still keep every other test rule.
 */
export const REPO_TESTS = [
  "test/areas.test.ts",
  "test/capture-screens.test.ts",
  "test/catalog.test.ts",
  "test/codex-drift.test.ts",
  "test/contributor-docs.test.ts",
  "test/dco.test.ts",
  "test/docs-gen.test.ts",
  "test/docs-links.test.ts",
  "test/docs-no-copies.test.ts",
  "test/docs-site.test.ts",
  "test/fakes.test.ts",
  "test/fakes-readers.test.ts",
  "test/gluon-matrix.test.ts",
  "test/harness-cache.test.ts",
  "test/live-script.test.ts",
  "test/live-stage.test.ts",
  "test/markdown.test.ts",
  "test/pricing-update.test.ts",
  "test/readme.test.ts",
  "test/real-stage.test.ts",
  "test/release.test.ts",
  "test/run-sweep.test.ts",
  "test/screen-lint.test.ts",
  "test/test-guards.test.ts",
  "test/test-health.test.ts",
  "test/test-style.test.ts",
  "test/test-value.test.ts",
  "test/windows-test.test.ts",
  "test/e2e/scoped.e2e.test.ts",
];

const SEAM_MODULES = new Set(Object.values(SEAMS).flatMap((s) => s.modules));

/**
 * The `src/` modules a test file imports values from (type-only imports are left out) that are neither a seam nor
 * support. `file` is the test's path from the repository root, so `../src/x.ts` resolves.
 */
export function pastSeams(file: string, text: string): string[] {
  const t = new Bun.Transpiler({ loader: file.endsWith("x") ? "tsx" : "ts" });
  const dir = file.split("/").slice(0, -1);
  const out = new Set<string>();
  for (const { path } of t.scanImports(text)) {
    if (!path.startsWith(".")) continue;
    const parts = [...dir];
    for (const p of path.split("/")) {
      if (p === "..") parts.pop();
      else if (p !== ".") parts.push(p);
    }
    const mod = parts.join("/");
    if (mod.startsWith("src/") && !SEAM_MODULES.has(mod) && !SUPPORT.includes(mod)) out.add(mod);
  }
  return [...out].sort();
}
