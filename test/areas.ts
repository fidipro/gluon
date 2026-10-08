/**
 * The area manifest: every `src/**` file and every unit / e2e test file belongs to one named area.
 * `scripts/regression.ts` (`--area`, `--changed`, `--list`) and `scripts/coverage.ts` read it, and
 * `test/areas.test.ts` fails when a file is missing, listed twice or no longer exists: that test is
 * what keeps the map complete.
 *
 * - `src`: globs of the area's `src/**` files (a leading `!` excludes). Exactly one area owns a file.
 * - `files`: other files that make the area's tests worth running (scripts, fixtures, installers).
 * - `unit`, `e2e`: its test files (`test/*.test.ts(x)`, `test/e2e/*.e2e.test.ts`). One area per file.
 * - `hooks`: heavier suites kept out of `regression` (matrix, monkey, visual, perf), run by hand.
 * - `e2eOnly`: its `src` files that e2e scenarios cover (a unit test reaches little or none of them); the
 *   coverage table marks them `e2e`, not 0 %.
 * - `unmeasured`: `src` files that run where the coverage report can't see (a subprocess, a Worker): glob → why.
 * - `optional`: the area's globs may match nothing yet (a directory another change is adding).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Hook = { cmd: string; files: string[] };
export type Area = {
  doc: string;
  src: string[];
  files?: string[];
  unit: string[];
  e2e: string[];
  hooks?: Record<string, Hook>;
  unmeasured?: Record<string, string>;
  e2eOnly?: string[];
  optional?: boolean;
};

export const AREAS: Record<string, Area> = {
  cli: {
    doc: "the command line, config file, startup, hidden subcommands, doctor, uninstall",
    src: ["src/cli.tsx", "src/main.tsx", "src/usage.ts", "src/startup.ts", "src/self.ts", "src/internal.ts", "src/uninstall.ts", "src/doctor.ts", "src/config.ts", "src/xdg.ts"],
    files: ["test/fixtures/hook-graph/**"],
    unit: ["test/usage.test.ts", "test/hook-import-graph.test.ts", "test/doctor.test.ts"],
    e2e: ["test/e2e/cli.e2e.test.ts", "test/e2e/startup.e2e.test.ts"],
    e2eOnly: ["src/cli.tsx", "src/main.tsx", "src/startup.ts", "src/doctor.ts", "src/uninstall.ts"],
    unmeasured: { "src/internal.ts": "runs as `gluon signal` / `gluon hook` in a subprocess" },
  },
  "onboarding-auth": {
    doc: "connecting the agents: sign-in checks, keys, installs, status of each harness",
    src: ["src/auth.ts", "src/status.ts", "src/verify.ts", "src/install.ts", "src/detect.ts", "src/secrets.ts", "src/harnesses.ts", "src/ui/signin.tsx"],
    unit: ["test/install.test.ts", "test/detect.test.ts", "test/secrets.test.ts", "test/status-login.test.ts"],
    e2e: ["test/e2e/auth.e2e.test.ts", "test/e2e/install.e2e.test.ts"],
    e2eOnly: ["src/auth.ts", "src/verify.ts", "src/install.ts"],
  },
  brain: {
    doc: "the intake agent: its routes (Bedrock, Anthropic, OpenAI, Codex), prompt, effort, choices, session loop",
    src: ["src/brain.ts", "src/agent/bedrock-converse.ts", "src/agent/choices.ts", "src/agent/clients.ts", "src/agent/codex.ts", "src/agent/effort.ts", "src/agent/openai.ts", "src/agent/prompt.ts", "src/agent/session.ts", "src/agent/subscription.ts"],
    unit: ["test/brain.test.ts", "test/brain-clients.test.ts", "test/choices.test.ts", "test/codex.test.ts", "test/converse.test.ts", "test/effort.test.ts", "test/openai.test.ts", "test/route-schema.test.ts", "test/session.test.ts"],
    e2e: [],
  },
  "repo-tools-security": {
    doc: "the brain's read-only repo tools, secret-file and sandbox rules, the hard rules of the vendors",
    src: ["src/agent/forge.ts", "src/agent/git.ts", "src/agent/grep-worker.ts", "src/agent/scan.ts", "src/agent/tools.ts"],
    unit: ["test/forge.test.ts", "test/tools.test.ts", "test/rules.test.ts"],
    e2e: [],
    unmeasured: { "src/agent/grep-worker.ts": "runs in a Worker thread, which the coverage report doesn't see" },
  },
  routing: {
    doc: "routing.yaml, the catalog, the models the brain may offer, the intake seam",
    src: ["src/routing.ts", "src/routing-config.ts", "src/routing.yaml", "src/models.ts", "src/intake.ts"],
    files: ["test/fixtures/route-catalog.ts", "test/fixtures/first-pass-*.yaml"],
    unit: ["test/route.test.ts", "test/routing-upgrade.test.ts", "test/intake.test.ts"],
    e2e: [],
  },
  adapters: {
    doc: "each harness's launch (argv, env, hooks, modes, resume, handoff settings) and its events back to Gluon",
    src: ["src/adapters/**", "src/launchers.ts", "src/handoff.ts", "src/events.ts"],
    unit: [
      "test/adapters-claude-codex.test.ts",
      "test/adapters-opencode.test.ts",
      "test/agy-settings.test.ts",
      "test/permanent.test.ts",
      "test/modes.test.ts",
      "test/resume-argv.test.ts",
      "test/return.test.ts",
      "test/handoff.test.ts",
      "test/status-matrix.test.ts",
      "test/status.test.ts",
      "test/kimi-code.test.ts",
      "test/opencode-plan.test.ts",
      "test/fakes.test.ts",
    ],
    e2e: ["test/e2e/handoff.e2e.test.ts", "test/e2e/launch-line.e2e.test.ts", "test/e2e/launch-modes.e2e.test.ts"],
  },
  pty: {
    doc: "the agent's pseudo-terminal: screen model, readers, keys, modes, paint, selection, intercept",
    src: ["src/pty/**", "!src/pty/chrome.ts", "!src/pty/compositor.ts", "!src/pty/AGENTS.md"],
    files: ["test/fixtures/screens/**", "test/fixtures/screens.ts"],
    unit: [
      "test/pty-first-line.test.ts",
      "test/pty-intercept.test.ts",
      "test/pty-keys.test.ts",
      "test/pty-modes.test.ts",
      "test/pty-paint.test.ts",
      "test/pty-readers.test.ts",
      "test/pty-screen.test.ts",
      "test/pty-selection.test.ts",
      "test/pty-session.test.ts",
      "test/fakes-readers.test.ts",
    ],
    e2e: [],
  },
  "gluon-frame": {
    doc: "Gluon's frame: the app, the compositor and chrome, sessions, tabs, the coverage matrix and the monkey",
    src: ["src/gluon.ts", "src/files-poll.ts", "src/sessions.ts", "src/pty/chrome.ts", "src/pty/compositor.ts"],
    files: ["test/e2e/gluon-*.ts", "test/fixtures/gluon.ts", "test/fixtures/gluon-matrix.ts"],
    unit: [
      "test/gluon.test.ts",
      "test/polling.test.ts",
      "test/gluon-layout.test.ts",
      "test/gluon-matrix.test.ts",
      "test/pty-chrome.test.ts",
      "test/pty-compositor.test.ts",
      "test/pty-route-matrix.test.ts",
      "test/pty-selection-qa.test.ts",
      "test/gluon-qa-frame.test.ts",
      "test/run-sweep.test.ts",
    ],
    e2e: ["test/e2e/gluon.e2e.test.ts", "test/e2e/gluon-more.e2e.test.ts", "test/e2e/gluon-qa-frame.e2e.test.ts", "test/e2e/gluon-matrix.e2e.test.ts", "test/e2e/gluon-monkey.e2e.test.ts", "test/e2e/scoped.e2e.test.ts"],
    e2eOnly: ["src/gluon.ts"],
    hooks: {
      matrix: { cmd: "bun run test:gluon-full", files: ["test/e2e/gluon-matrix.e2e.test.ts"] },
      monkey: { cmd: "bun run test:gluon", files: ["test/e2e/gluon-monkey.e2e.test.ts"] },
      visual: { cmd: "bun run test:visual", files: ["test/visual/scenes.visual.test.ts"] },
    },
  },
  "home-ui": {
    doc: "the home view and chat (Ink): list, composer, markdown, header, layout and theme helpers",
    src: ["src/ui/**", "!src/ui/signin.tsx", "!src/ui/AGENTS.md"],
    files: ["test/fixtures/ink-term.tsx", "patches/**"],
    unit: ["test/home.test.tsx", "test/render.test.tsx", "test/string-width-patch.test.ts", "test/ui.test.tsx"],
    e2e: ["test/e2e/composer.e2e.test.ts", "test/e2e/rendering.e2e.test.ts", "test/e2e/stages.e2e.test.ts"],
    e2eOnly: ["src/ui/bottom.tsx", "src/ui/rawmode.ts"],
  },
  "cost-pricing": {
    doc: "own cost and context figures, price and window tables and their refresh, the ledger, telemetry",
    src: ["src/cost/**", "!src/cost/AGENTS.md", "src/telemetry.ts", "src/otlp-protobuf.ts", "src/kimi-usage.ts", "src/openrouter-billed.ts"],
    files: [
      "scripts/pricing/**",
      "test/fixtures/fixture-tables.ts",
      "test/fixtures/frozen-prices.ts",
      "test/fixtures/pricing-sources.ts",
      "test/fixtures/seed-tables.ts",
      "test/fixtures/otlp-protobuf.ts",
      "test/fixtures/zip.ts",
      "test/fixtures/tables/**",
      "test/fixtures/telemetry/**",
    ],
    unit: [
      "test/claude-otel.test.ts",
      "test/cost.test.ts",
      "test/cost-ledger.test.ts",
      "test/figures.test.ts",
      "test/grok.test.ts",
      "test/harness-config.test.ts",
      "test/kimi-usage.test.ts",
      "test/openrouter-billed.test.ts",
      "test/otlp-protobuf-fuzz.test.ts",
      "test/pending-tables.test.ts",
      "test/pricing-update.test.ts",
      "test/refresh.test.ts",
      "test/tables-hardening.test.ts",
      "test/adversarial-pkg0.test.ts",
      "test/adversarial-pkg-edfb.test.ts",
    ],
    e2e: [
      "test/e2e/kimi-cost.e2e.test.ts",
      "test/e2e/openrouter-billed.e2e.test.ts",
      "test/e2e/tables-refresh.e2e.test.ts",
      "test/e2e/adversarial-pkg0.e2e.test.ts",
      "test/e2e/adversarial-pkg-edfb.e2e.test.ts",
    ],
  },
  "analytics-stats": {
    doc: "local analytics (analytics.db) and `gluon stats`",
    src: ["src/analytics.ts", "src/stats.ts", "src/stats-sql.ts"],
    files: ["test/fixtures/analytics-writer.ts"],
    unit: ["test/analytics.test.ts", "test/stats.test.ts"],
    e2e: ["test/e2e/analytics.e2e.test.ts"],
  },
  "resume-workspaces": {
    doc: "saved workspaces (`gluon sessions`, `gluon resume`) and per-session git worktrees",
    src: ["src/workspaces.ts", "src/worktree.ts"],
    unit: ["test/workspaces.test.ts", "test/worktree.test.ts"],
    e2e: ["test/e2e/resume.e2e.test.ts", "test/e2e/resume-hostile.e2e.test.ts", "test/e2e/resume-qa.e2e.test.ts"],
  },
  "install-dist": {
    doc: "build, pack, release, installers, Docker suite, workflows",
    src: ["src/repo.ts"],
    files: [
      "scripts/build.ts",
      "scripts/pack.ts",
      "scripts/docker-test.sh",
      "scripts/release-notes.ts",
      "scripts/dco.ts",
      "install.sh",
      "install.ps1",
      ".github/workflows/**",
      ".github/dependabot.yml",
      "test/docker/**",
      "test/install-ps1.ps1",
    ],
    unit: ["test/dist.test.ts", "test/release.test.ts", "test/dco.test.ts", "test/live-script.test.ts"],
    e2e: [],
  },
  windows: {
    doc: "Windows paths, shims, ConPTY, key storage and the WSL-driven Windows run",
    src: [],
    files: ["scripts/windows-test.ts"],
    unit: ["test/windows.test.ts", "test/windows-test.test.ts", "test/platform.test.ts"],
    e2e: [],
  },
  docs: {
    doc: "Markdown, the generated reference, the docs site, README, AGENTS.md files; the area manifest's own test",
    src: ["src/**/AGENTS.md"],
    files: ["**/*.md", "**/*.mdx", "docs/**", "site/**", "scripts/docs/**", "scripts/test-health.ts", ".github/ISSUE_TEMPLATE/**", ".github/pull_request_template.md"],
    unit: ["test/areas.test.ts", "test/test-health.test.ts", "test/markdown.test.ts", "test/contributor-docs.test.ts", "test/docs-gen.test.ts", "test/docs-links.test.ts", "test/docs-no-copies.test.ts", "test/docs-site.test.ts", "test/readme.test.ts"],
    e2e: [],
  },
  perf: {
    doc: "the perf suite (`bun run test:perf`): latency, throughput, memory; never in the fast tier",
    src: [],
    files: ["test/perf/**"],
    unit: [],
    e2e: ["test/e2e/perf-smoke.e2e.test.ts"],
    hooks: { perf: { cmd: "bun run test:perf", files: [] } },
  },
};

/**
 * Files whose change means "run the whole fast tier": shared by every area (config, the harness table,
 * events, sessions, launching, detection, shared types), the toolchain, and the test harness itself.
 */
export const CORE: string[] = [
  "src/config.ts",
  "src/harnesses.ts",
  "src/models.ts",
  "src/events.ts",
  "src/sessions.ts",
  "src/secrets.ts",
  "src/launchers.ts",
  "src/handoff.ts",
  "src/detect.ts",
  "src/adapters/types.ts",
  "src/pty/types.ts",
  "src/cost/types.ts",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "bunfig.toml",
  ".bun-version",
  "scripts/empty-bunfig.toml",
  "scripts/regression.ts",
  "test/areas.ts",
  "test/preload.ts",
  "test/e2e/harness.ts",
  "test/e2e/fixtures.ts",
  "test/e2e/actions.ts",
  "test/e2e/scoped-test.ts",
  "test/fixtures/run-sweep.ts",
  "test/fixtures/fake-agent.ts",
  "test/fixtures/fake-tui.ts",
  "test/fixtures/fake-codex-app-server.ts",
  "test/fixtures/write-event.ts",
];

/** Files no test reads: a change to one runs nothing. */
export const IGNORED: string[] = ["qa/**", ".claude/**", ".gitignore", ".gitleaks.toml", ".github/CODEOWNERS", ".env.example", "scripts/coverage.ts", "scripts/live.ts", "scripts/live-lib.ts", "scripts/live-harness.ts", "scripts/live-driver.ts", "scripts/drive.py"];

const globs = new Map<string, Bun.Glob>();
const glob = (p: string) => globs.get(p) ?? (globs.set(p, new Bun.Glob(p)), globs.get(p)!);

/** Does a path match one of the globs (`!`-prefixed ones exclude)? Paths use forward slashes. */
export function matches(patterns: string[], file: string): boolean {
  const yes = patterns.filter((p) => !p.startsWith("!")).some((p) => glob(p).match(file));
  return yes && !patterns.filter((p) => p.startsWith("!")).some((p) => glob(p.slice(1)).match(file));
}

const testFile = (file: string) => /^test\/(e2e\/)?[^/]+\.(e2e\.)?test\.tsx?$/.test(file) || /^test\/visual\/[^/]+\.visual\.test\.ts$/.test(file);

/** The area that owns a `src/**` file, if any. */
export function srcOwner(file: string): string | undefined {
  return Object.keys(AREAS).find((a) => matches(AREAS[a]!.src, file));
}

/** The area a test file is listed under (unit, e2e or a hook's file). */
export function testOwner(file: string): string | undefined {
  return Object.keys(AREAS).find((a) => {
    const x = AREAS[a]!;
    return x.unit.includes(file) || x.e2e.includes(file) || Object.values(x.hooks ?? {}).some((h) => h.files.includes(file));
  });
}

const scan = (pattern: string): string[] => [...new Bun.Glob(pattern).scanSync({ cwd: ROOT })].map((f) => f.replaceAll("\\", "/")).sort();
export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every file under `src/`, every unit test file, every e2e test file, as they are on disk. */
export const srcFiles = () => scan("src/**/*");
export const unitTestFiles = () => scan("test/*.test.{ts,tsx}");
export const e2eTestFiles = () => scan("test/e2e/*.e2e.test.ts");

/**
 * What is wrong with the manifest right now, one line each (empty when it is whole): a `src` file in no area or in
 * two, a test file listed nowhere or twice, a listed path or glob that matches nothing. `bun run test:health` prints it;
 * `test/areas.test.ts` checks the same things one by one.
 */
export function manifestProblems(): string[] {
  const names = Object.keys(AREAS);
  const out: string[] = [];
  for (const f of srcFiles()) {
    const o = names.filter((a) => matches(AREAS[a]!.src, f));
    if (o.length === 0) out.push(`${f}: in no area (add it to an area's src in test/areas.ts)`);
    if (o.length > 1) out.push(`${f}: in several areas (${o.join(", ")})`);
  }
  for (const f of [...unitTestFiles(), ...e2eTestFiles()]) {
    const o = names.filter((a) => AREAS[a]!.unit.includes(f) || AREAS[a]!.e2e.includes(f));
    if (o.length === 0) out.push(`${f}: listed in no area (add it to unit or e2e in test/areas.ts)`);
    if (o.length > 1) out.push(`${f}: listed in several areas (${o.join(", ")})`);
  }
  for (const [a, x] of Object.entries(AREAS)) {
    for (const f of [...x.unit, ...x.e2e, ...Object.values(x.hooks ?? {}).flatMap((h) => h.files)]) if (!existsSync(join(ROOT, f))) out.push(`${a}: ${f} no longer exists`);
    if (x.optional) continue;
    for (const g of [...x.src, ...(x.files ?? []), ...(x.e2eOnly ?? []), ...Object.keys(x.unmeasured ?? {})].filter((g) => !g.startsWith("!"))) {
      if ([...new Bun.Glob(g).scanSync({ cwd: ROOT, dot: true })].length === 0) out.push(`${a}: ${g} matches nothing`);
    }
  }
  return out;
}

export type Selection =
  | { kind: "fast"; why: string[] }
  | { kind: "areas"; areas: string[]; unit: string[]; e2e: string[]; hooks: { area: string; name: string; cmd: string }[]; why: string[] }
  | { kind: "none"; why: string[] };

const uniq = (xs: string[]) => [...new Set(xs)];

/** The tests of the named areas (unit and e2e, in manifest order); the by-hand hooks are returned apart. */
export function selectAreas(areas: string[], extra: { unit?: string[]; e2e?: string[]; hookAreas?: string[] } = {}): Selection & { kind: "areas" } {
  const ok = areas.filter((a) => a in AREAS);
  return {
    kind: "areas",
    areas: ok,
    unit: uniq([...ok.flatMap((a) => AREAS[a]!.unit), ...(extra.unit ?? [])]),
    e2e: uniq([...ok.flatMap((a) => AREAS[a]!.e2e), ...(extra.e2e ?? [])]),
    hooks: uniq([...ok, ...(extra.hookAreas ?? [])]).flatMap((a) => Object.entries(AREAS[a]!.hooks ?? {}).map(([name, h]) => ({ area: a, name, cmd: h.cmd }))),
    why: [],
  };
}

/**
 * From the files a change touches to what runs. A core or unknown file means the fast tier; a source
 * file means its area; a changed test file is included itself; docs alone mean the docs tests.
 */
export function selectChanged(changed: string[]): Selection {
  const areas = new Set<string>();
  const unit: string[] = [];
  const e2e: string[] = [];
  const hookAreas: string[] = [];
  const why: string[] = [];
  for (const raw of changed) {
    const f = raw.replaceAll("\\", "/");
    if (matches(IGNORED, f)) continue;
    if (matches(CORE, f)) return { kind: "fast", why: [`core file: ${f}`] };
    if (testFile(f)) {
      const owner = testOwner(f);
      if (!owner) return { kind: "fast", why: [`test file in no area: ${f}`] };
      if (/\.e2e\.test\.ts$/.test(f)) {
        if (AREAS[owner]!.e2e.includes(f)) e2e.push(f);
      } else if (AREAS[owner]!.unit.includes(f)) unit.push(f);
      else hookAreas.push(owner);
      why.push(`${f}: test file (area ${owner})`);
      continue;
    }
    if (f.startsWith("src/")) {
      const owner = srcOwner(f);
      if (!owner) return { kind: "fast", why: [`src file in no area: ${f}`] };
      areas.add(owner);
      why.push(`${f}: ${owner}`);
      continue;
    }
    const owners = Object.keys(AREAS).filter((a) => matches(AREAS[a]!.files ?? [], f));
    if (!owners.length) return { kind: "fast", why: [`unclassified file: ${f}`] };
    for (const o of owners) areas.add(o);
    why.push(`${f}: ${owners.join(", ")}`);
  }
  if (!areas.size && !unit.length && !e2e.length && !hookAreas.length) return { kind: "none", why: ["no change that a test reads"] };
  const sel = selectAreas([...areas], { unit, e2e, hookAreas });
  return { ...sel, why };
}
