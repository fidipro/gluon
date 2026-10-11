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
    says: "routing.yaml + the brain's classification → agent · model · effort, and why",
    modules: ["src/routing.ts", "src/routing-config.ts"],
  },
  adapters: {
    says: "a launch's context → the harness's argv, env and files; a hook's call → its result",
    modules: ["src/adapters/index.ts"],
  },
  readers: {
    says: "a harness's screen → its state (the input line, ready, awaiting a choice, plan mode)",
    modules: ["src/pty/readers/index.ts", "src/pty/screen.ts"],
  },
  keys: {
    says: "the terminal's bytes → keys → what Gluon does with each (forward, home, a menu)",
    modules: ["src/pty/keys.ts", "src/pty/compositor.ts"],
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
    says: "a file an older (or this) version wrote → today's state: the config, the sessions, the cost ledger",
    modules: ["src/config.ts", "src/sessions.ts", "src/cost/ledger-file.ts"],
  },
  launch: {
    says: "a spec, a harness and the OS → the command line and the spec's hand-off",
    modules: ["src/launchers.ts", "src/handoff.ts"],
  },
};

/** Imported for a test's setup, not tested through: the harness list and the state paths. */
export const SUPPORT = ["src/harnesses.ts", "src/xdg.ts"];

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
