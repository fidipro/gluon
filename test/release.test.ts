/**
 * The distribution machinery's rules, read from the files: the Release workflow's permissions
 * (BUG-121), pinned actions and images (BUG-126), the installers shipped in each release and the
 * documented one-liners pinned to a release (BUG-129), and what may trigger and write in each workflow
 * (CI, Release, Pages). Nothing here runs a workflow.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { REPO_SLUG, REPO_URL } from "../src/repo.ts";
import { releaseNotes } from "../scripts/release-notes.ts";
import pkg from "../package.json" with { type: "json" };

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const WORKFLOWS = readdirSync(join(ROOT, ".github/workflows")).filter((f) => f.endsWith(".yml")).map((f) => `.github/workflows/${f}`);

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, unknown> };
type Job = { permissions?: Record<string, string>; steps: Step[]; if?: string; needs?: string | string[] };
const release = parse(read(".github/workflows/release.yml")) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };

describe("BUG-121: the Release workflow's permissions", () => {
  test("run by hand only, read-only by default", () => {
    expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
    expect(release.permissions).toEqual({ contents: "read" });
  });

  test("only `sign` (id-token, when asked) and `release` (contents) can write", () => {
    for (const [name, job] of Object.entries(release.jobs)) {
      const writes = Object.entries(job.permissions ?? {}).filter(([, v]) => v === "write").map(([k]) => k);
      if (name === "sign") expect(writes).toEqual(["id-token"]);
      else if (name === "release") expect(writes).toEqual(["contents"]);
      else expect([name, writes]).toEqual([name, []]);
    }
    expect(release.jobs.sign!.if).toContain("inputs.sign");
    expect(release.jobs.sign!.permissions).toEqual({ "id-token": "write" });
  });

  test("signing is on by default", () => {
    const sign = (release.on.workflow_dispatch as { inputs: Record<string, { default: unknown; type: string }> }).inputs.sign!;
    expect(sign).toMatchObject({ type: "boolean", default: true });
  });

  test("the writing jobs run no third-party action and check nothing out; the SBOM runs read-only", () => {
    for (const s of release.jobs.release!.steps) if (s.uses) expect(s.uses).toMatch(/^actions\/download-artifact@/);
    for (const s of release.jobs.sign!.steps) if (s.uses) expect(s.uses).toMatch(/^(actions\/(download|upload)-artifact|sigstore\/cosign-installer)@/);
    const sbomJobs = Object.entries(release.jobs).filter(([, j]) => j.steps.some((s) => s.uses?.startsWith("anchore/sbom-action@")));
    expect(sbomJobs.map(([n]) => n)).toEqual(["sbom"]);
    expect(release.jobs.sbom!.permissions).toEqual({ contents: "read" });
  });

  test("a draft, never published; no registry publish anywhere", () => {
    const run = release.jobs.release!.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("gh release create");
    expect(run).toContain("--draft");
    for (const w of WORKFLOWS) {
      const code = read(w).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      expect([w, /\b(npm|bun|yarn|pnpm) publish\b/.test(code)]).toEqual([w, false]);
    }
  });
});

describe("BUG-126: actions and images are pinned", () => {
  test("every `uses:` names a commit SHA", () => {
    for (const w of WORKFLOWS)
      for (const m of read(w).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) expect([w, m[1]]).toEqual([w, expect.stringMatching(/@[0-9a-f]{40}$/)]);
  });

  test("every container image names a digest", () => {
    const files = [...WORKFLOWS, "scripts/docker-test.sh", ...readdirSync(join(ROOT, "test/docker")).filter((f) => f.startsWith("Dockerfile")).map((f) => `test/docker/${f}`)];
    const image = /\b(oven\/bun|ubuntu|debian|alpine|koalaman\/shellcheck|zricethezav\/gitleaks|rhysd\/actionlint|mcr\.microsoft\.com\/powershell):[\w.-]+(@sha256:[0-9a-f]{64})?/g;
    let seen = 0;
    for (const f of files)
      for (const line of read(f).split("\n")) {
        if (/^\s*#/.test(line)) continue;
        for (const m of line.matchAll(image)) {
          seen++;
          expect([f, m[0], !!m[2]]).toEqual([f, m[0], true]);
        }
      }
    expect(seen).toBeGreaterThan(5);
  });
});

describe.skipIf(process.platform === "win32")("docker-test's build context", () => {
  test("tracked and unignored files, never a node_modules (a worktree's is a symlink .gitignore doesn't match)", () => {
    const cmd = /^\s*(git ls-files [^|]*)\|/m.exec(read("scripts/docker-test.sh"))?.[1];
    expect(cmd).toBeDefined();
    const repo = mkdtempSync(join(tmpdir(), "gluon-ctx-"));
    try {
      const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo, env: process.env, stdout: "pipe", stderr: "pipe" });
      git("init", "-q");
      writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
      writeFileSync(join(repo, "a.ts"), "");
      mkdirSync(join(repo, "real", "node_modules"), { recursive: true });
      writeFileSync(join(repo, "real", "node_modules", "x.js"), "");
      mkdirSync(join(repo, "elsewhere", "pkg"), { recursive: true });
      symlinkSync(join(repo, "elsewhere"), join(repo, "node_modules"));
      symlinkSync(join(repo, "elsewhere"), join(repo, "real", "node_modules2"));
      mkdirSync(join(repo, "sub"));
      symlinkSync(join(repo, "elsewhere"), join(repo, "sub", "node_modules"));
      git("add", ".gitignore", "a.ts");
      const r = Bun.spawnSync(["sh", "-c", cmd!], { cwd: repo, env: process.env, stdout: "pipe" });
      const files = r.stdout.toString().split("\0").filter(Boolean).sort();
      expect(files).toEqual([".gitignore", "a.ts", "real/node_modules2"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("install.sh: the signature check with cosign 2 and 3", () => {
  // A release directory with the asset under every name install.sh may pick, and a fake cosign: "v2" needs
  // --new-bundle-format (cosign 2.4 or later), "bad" rejects the bundle either way, "old" has no such flag.
  function install(cosign: "v2" | "bad" | "old") {
    const dir = mkdtempSync(join(tmpdir(), "gluon-cosign-"));
    try {
      const rel = join(dir, "rel");
      const bin = join(dir, "bin");
      mkdirSync(rel);
      mkdirSync(bin);
      const body = "#!/bin/sh\necho 1.0.0\n";
      const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
      const names = ["linux", "darwin"].flatMap((os) => ["x64", "arm64"].flatMap((a) => [`gluon-bun-${os}-${a}`, `gluon-bun-${os}-${a}-musl`]));
      for (const n of names) writeFileSync(join(rel, n), body);
      writeFileSync(join(rel, "SHA256SUMS"), names.map((n) => `${hash}  ${n}\n`).join(""));
      writeFileSync(join(rel, "SHA256SUMS.sigstore.json"), "{}");
      const script = {
        v2: 'case "$*" in *--new-bundle-format*) exit 0 ;; esac\necho "Error: bundle does not contain cert for verification, please provide public key" >&2\nexit 1\n',
        bad: 'echo "Error: none of the expected identities matched what was in the certificate" >&2\nexit 1\n',
        old: 'case "$*" in *--new-bundle-format*) echo "Error: unknown flag: --new-bundle-format" >&2 ;; *) echo "Error: bundle does not contain cert" >&2 ;; esac\nexit 1\n',
      }[cosign];
      writeFileSync(join(bin, "cosign"), `#!/bin/sh\n${script}`, { mode: 0o755 });
      const r = Bun.spawnSync(["sh", join(ROOT, "install.sh")], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, GLUON_RELEASE_URL: rel, GLUON_INSTALL_DIR: join(dir, "out") },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), installed: readdirSync(dir).includes("out") && readdirSync(join(dir, "out")).includes("gluon") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("BUG-676/cosign-v2: a cosign that needs --new-bundle-format is retried with it and installs", () => {
    const r = install("v2");
    expect(r.out).toContain("signature ok");
    expect(r.code).toBe(0);
    expect(r.installed).toBe(true);
  });

  test("BUG-676/cosign-v2: a signature that fails both ways still dies 'does not verify', nothing installed", () => {
    const r = install("bad");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("does not verify");
    expect(r.out).not.toContain("older than 2.4");
    expect(r.installed).toBe(false);
  });

  test("BUG-676/cosign-v2: a cosign without the flag dies asking for an upgrade, nothing installed", () => {
    const r = install("old");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("older than 2.4");
    expect(r.out).toContain("upgrade cosign");
    expect(r.out).not.toContain("signature ok");
    expect(r.installed).toBe(false);
  });
});

describe("BUG-129: the installers ship in each release; the docs' one-liners take them from it", () => {
  test("release.yml puts install.sh and install.ps1 next to the builds, before SHA256SUMS", () => {
    const run = release.jobs.files!.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toMatch(/cp install\.sh install\.ps1 release\/[\s\S]*sha256sum -- \* > SHA256SUMS/);
  });

  test("README and docs/getting-started/install.md: release URLs, never a branch", () => {
    for (const doc of ["README.md", "docs/getting-started/install.md"]) {
      const text = read(doc);
      expect([doc, text.includes(`raw.githubusercontent.com/${REPO_SLUG}`)]).toEqual([doc, false]);
      expect(text).toContain(`curl -fsSL https://github.com/${REPO_SLUG}/releases/latest/download/install.sh | sh`);
      expect(text).toContain(`irm https://github.com/${REPO_SLUG}/releases/latest/download/install.ps1 | iex`);
    }
  });
});

describe("the draft release's body is the changelog section", () => {
  const log = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n- next\n\n## [0.2.0] - 2026-01-02\n\n### Added\n- two\n\n## [0.1.0]\n- one\n";

  test("the section of the version, up to the next heading", () => {
    expect(releaseNotes(log, "0.2.0")).toBe("### Added\n- two");
    expect(releaseNotes(log, "0.1.0")).toBe("- one");
  });

  test("no section for the version: [Unreleased], under a note", () => {
    const out = releaseNotes(log, "0.3.0");
    expect(out).toStartWith("No CHANGELOG.md section for 0.3.0");
    expect(out).toContain("- next");
    expect(out).not.toContain("two");
    expect(releaseNotes("# Changelog\n", "1.0.0")).toStartWith("No CHANGELOG.md section for 1.0.0");
  });

  test("a version is matched literally, not as a pattern", () => {
    expect(releaseNotes("## [1x2y3]\n- wrong\n## [1.2.3]\n- right\n", "1.2.3")).toBe("- right");
  });

  test("release.yml builds it in `files`, ships it as its own artifact (not a hashed release file) and the draft reads it", () => {
    expect(release.jobs.files!.steps.some((s) => s.run?.includes("scripts/release-notes.ts"))).toBe(true);
    const run = release.jobs.release!.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("--notes-file");
    expect(run).not.toMatch(/--notes /);
    expect(JSON.stringify(release.jobs.release!.steps)).toContain("notes-${{ inputs.version }}");
  });

  test("relative links become absolute ones at the version's tag; absolute, anchor and mailto links and code fences stay", () => {
    const base = `${REPO_URL}/blob/v1.2.3/`;
    const md = [
      "- [cli](docs/reference/cli.md), [anchor](docs/a.md#x \"t\"), [dot](./SECURITY.md), [up](../x), [root](/CONTRIBUTING.md), ![img](docs/i.png)",
      "- [web](https://example.com/a), [plain](http://example.com), [mail](mailto:a@b.c), [here](#top), [proto](//example.com/x), [empty]()",
      "```",
      "[code](docs/not-a-link.md)",
      "```",
      "[after](README.md)",
    ].join("\n");
    const out = releaseNotes(`## [1.2.3]\n\n${md}\n`, "1.2.3");
    expect(out).toBe(
      [
        `- [cli](${base}docs/reference/cli.md), [anchor](${base}docs/a.md#x "t"), [dot](${base}SECURITY.md), [up](${REPO_URL}/blob/x), [root](${base}CONTRIBUTING.md), ![img](${base}docs/i.png)`,
        ...md.split("\n").slice(1, 5),
        `[after](${base}README.md)`,
      ].join("\n"),
    );
    expect(releaseNotes("## [Unreleased]\n[a](b.md)\n", "1.2.3")).toContain(`[a](${base}b.md)`);
  });

  test("the real CHANGELOG's 1.0.0 body has no relative link left", () => {
    const targets = [...releaseNotes(read("CHANGELOG.md"), "1.0.0").matchAll(/\]\(<?([^)\s>]*)/g)].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect(t).toMatch(/^(https?:|mailto:|#)/);
  });

  test("the real CHANGELOG has a section for package.json's version: a release's draft body is never the fallback note", () => {
    expect(releaseNotes(read("CHANGELOG.md"), pkg.version)).not.toStartWith("No CHANGELOG.md section");
  });

  test("the real CHANGELOG has a 1.0.0 section: the draft's body is that section, not the fallback note", () => {
    const notes = releaseNotes(read("CHANGELOG.md"), "1.0.0");
    expect(notes).toContain("First public release");
    expect(notes).not.toStartWith("No CHANGELOG.md section");
  });
});

describe("the repository's slug: every place that spells it", () => {
  // The one list of places to change when the project moves (the maintainers' private notes, "Going public").
  test("src/repo.ts, the installers, package.json and the issue-template config agree", () => {
    expect(REPO_URL).toBe(`https://github.com/${REPO_SLUG}`);
    expect(read("install.sh")).toMatch(new RegExp(`^REPO="${REPO_SLUG}"$`, "m"));
    expect(read("install.ps1")).toContain(`$Repo = '${REPO_SLUG}'`);
    const pkg = JSON.parse(read("package.json")) as { homepage: string; bugs: { url: string }; repository: { url: string } };
    for (const url of [pkg.homepage, pkg.bugs.url, pkg.repository.url]) expect(url).toContain(REPO_SLUG);
    const config = parse(read(".github/ISSUE_TEMPLATE/config.yml")) as { contact_links: { name: string; url: string }[] };
    for (const link of config.contact_links) expect(link.url).toContain(`github.com/${REPO_SLUG}/`);
    expect(config.contact_links.find((l) => l.name === "Questions and docs")?.url).toBe(`${REPO_URL}/blob/main/SUPPORT.md`);
  });

  test("docs/getting-started/install.md: the cosign identity and the gh commands name the slug", () => {
    const text = read("docs/getting-started/install.md");
    expect(text).toContain(`--certificate-identity ${REPO_URL}/.github/workflows/release.yml@refs/heads/main`);
    expect(text).toContain(`-R ${REPO_SLUG}`);
  });
});

describe("what triggers and what writes: every workflow", () => {
  const all = WORKFLOWS.map((w) => [w, parse(read(w)) as { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> }] as const);
  const wf = (name: string) => all.find(([w]) => w.endsWith(`/${name}`))![1];

  test("there are exactly the workflows these rules know: ci, codex-watch, pages, release", () => {
    expect(WORKFLOWS.map((w) => w.replace(".github/workflows/", "")).sort()).toEqual(["ci.yml", "codex-watch.yml", "pages.yml", "release.yml"]);
  });

  test("no workflow but the Codex watch is scheduled; none is chained or runs a pull request's code with the base repository's token", () => {
    for (const [w, y] of all) {
      const on = Object.keys(y.on);
      const banned = w.endsWith("/codex-watch.yml") ? ["pull_request_target", "workflow_run"] : ["schedule", "pull_request_target", "workflow_run"];
      expect([w, on.filter((k) => banned.includes(k))]).toEqual([w, []]);
    }
    for (const w of WORKFLOWS) {
      const code = read(w).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      expect([w, /pull_request_target|workflow_run/.test(code)]).toEqual([w, false]);
      if (!w.endsWith("/codex-watch.yml")) expect([w, /^\s*schedule:|^\s*cron:/m.test(code)]).toEqual([w, false]);
    }
  });

  test("codex-watch.yml runs hourly and by hand; nothing else", () => {
    const { on } = wf("codex-watch.yml");
    expect(Object.keys(on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(on.schedule).toEqual([{ cron: "17 * * * *" }]);
  });

  test("the Codex watch: `check`, which runs the downloaded codex, writes nothing; `report` writes issues alone and runs no action, checkout or codex", () => {
    const { jobs } = wf("codex-watch.yml");
    expect(Object.keys(jobs).sort()).toEqual(["check", "report"]);
    expect(jobs.check!.permissions).toBeUndefined();
    expect(jobs.report!.permissions).toEqual({ issues: "write" });
    expect(jobs.report!.steps.filter((s) => s.uses)).toEqual([]);
    expect(JSON.stringify(jobs.report!.steps)).not.toMatch(/codex-drift|bun |npm |@openai\/codex/);
  });

  test("every workflow's top-level permissions are `contents: read`", () => {
    for (const [w, y] of all) expect([w, y.permissions]).toEqual([w, { contents: "read" }]);
  });

  test("ci.yml runs on pull requests and pushes to main, and by hand; nothing else", () => {
    const { on } = wf("ci.yml");
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(on.pull_request).toEqual({ branches: ["main"] });
    expect(on.push).toEqual({ branches: ["main"] });
  });

  test("pages.yml runs on pushes to main and by hand; nothing else", () => {
    const { on } = wf("pages.yml");
    expect(Object.keys(on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect((on.push as { branches: string[] }).branches).toEqual(["main"]);
  });

  test("only Pages' `deploy` job writes there: pages + id-token, no checkout, and only GitHub's own deploy action", () => {
    const { jobs } = wf("pages.yml");
    expect(Object.keys(jobs).sort()).toEqual(["build", "deploy"]);
    expect(jobs.build!.permissions).toBeUndefined();
    expect(jobs.deploy!.permissions).toEqual({ pages: "write", "id-token": "write" });
    expect(jobs.deploy!.steps.map((s) => s.uses?.replace(/@.*/, ""))).toEqual(["actions/deploy-pages"]);
    expect(JSON.stringify(jobs.deploy)).toContain("github-pages");
  });

  test("no workflow but Release, Pages' `deploy` and the Codex watch's `report` has a job that writes anything", () => {
    for (const [w, y] of all)
      for (const [name, job] of Object.entries(y.jobs)) {
        const writes = Object.entries(job.permissions ?? {}).filter(([, v]) => v === "write").map(([k]) => k);
        if (w.endsWith("/release.yml") || (w.endsWith("/pages.yml") && name === "deploy") || (w.endsWith("/codex-watch.yml") && name === "report")) continue;
        expect([w, name, writes]).toEqual([w, name, []]);
      }
  });

  test("runners are pinned to an image version, never `-latest`", () => {
    for (const w of WORKFLOWS) expect([w, /-latest\b/.test(read(w).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"))]).toEqual([w, false]);
  });

  test("every checkout leaves no token in the git config", () => {
    for (const [w, y] of all)
      for (const [name, job] of Object.entries(y.jobs))
        for (const s of job.steps.filter((x) => x.uses?.startsWith("actions/checkout@"))) expect([w, name, s.with?.["persist-credentials"]]).toEqual([w, name, false]);
  });

  test("no workflow holds a secret, and no run script interpolates event text (inputs and refs reach a shell as variables)", () => {
    for (const w of WORKFLOWS) {
      const code = read(w).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      expect([w, /secrets\.(?!GITHUB_TOKEN)/.test(code)]).toEqual([w, false]);
    }
    for (const [w, y] of all)
      for (const [name, job] of Object.entries(y.jobs))
        for (const s of job.steps) expect([w, name, /\$\{\{\s*(github\.(event|head_ref)|inputs\.)/.test(s.run ?? "")]).toEqual([w, name, false]);
  });
});

describe("ci.yml: one plan per event", () => {
  const ci = parse(read(".github/workflows/ci.yml")) as { jobs: Record<string, Job & { strategy?: unknown; env?: Record<string, string>; "runs-on"?: string }> };

  test("a `plan` job decides the suite, the OSes and the extras; the others read it", () => {
    for (const [name, job] of Object.entries(ci.jobs)) if (name !== "plan") expect([name, job.needs]).toEqual([name, "plan"]);
    const run = ci.jobs.plan!.steps.map((s) => s.run ?? "").join("\n");
    expect(JSON.stringify(ci.jobs.regression)).not.toContain("inputs.suite");
  });

  /** The plan step's arm for `event` in its `case "$EVENT"`: what it assigns, as {name: value}. */
  const arm = (event: string) => {
    const run = ci.jobs.plan!.steps.map((s) => s.run ?? "").join("\n");
    const m = new RegExp(`^\\s*${event}\\) (.*?) ;;`, "m").exec(run);
    expect([event, !!m]).toEqual([event, true]);
    return Object.fromEntries([...m![1]!.matchAll(/\b(\w+)=("[^"]*"|\S+?)(?:;|$)/g)].map((x) => [x[1]!, x[2]!.replaceAll('"', "")]));
  };

  test("a pull request and a push test the changed areas on every OS, with no extras; no docker-test, build:all or regression:full", () => {
    expect(arm("pull_request")).toEqual({ suite: "changed", os: "all", heavy: "false", light: "true", base: "origin/$BASE_REF" });
    expect(arm("push")).toEqual({ suite: "changed", os: "all", heavy: "false", light: "true", base: "$BEFORE" });
    // Only `heavy` starts docker-test and build:all, and only the full suite runs regression:full or test:dist.
    for (const j of ["docker", "build-all"]) expect([j, ci.jobs[j]!["if"]]).toEqual([j, "needs.plan.outputs.heavy == 'true'"]);
    const run = ci.jobs.plan!.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toMatch(/if \[ "\$suite" = full \] && \[ "\$\{IN_EXTRAS:-true\}" = true \]; then heavy=true/);
    expect(run.match(/heavy=true/g)).toHaveLength(1);
  });

  test("the base reaches the shell as a variable, is validated, and falls back to the fast tier; the typecheck always runs", () => {
    const plan = ci.jobs.plan!;
    expect(plan.env).toMatchObject({ BASE_REF: "${{ github.base_ref }}", BEFORE: "${{ github.event.before }}" });
    const run = plan.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain("'^[0-9a-f]{40}$'");
    expect(run).toContain("'^0{40}$'");
    expect(run).toContain("suite=quick; base=");
    const reg = ci.jobs.regression!;
    expect(reg.env).toMatchObject({ BASE: "${{ needs.plan.outputs.base }}" });
    const checkout = reg.steps.find((s) => s.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with).toMatchObject({ "fetch-depth": 0, "persist-credentials": false });
    const tests = reg.steps.map((s) => s.run ?? "").join("\n");
    expect(tests).toContain('bun run regression --changed "$BASE"');
    expect(tests).toContain('git rev-parse --verify --quiet "$BASE^{commit}"');
  });

  test("by hand, suite `changed` compares with origin/main and the default stays full with extras", () => {
    const { on } = parse(read(".github/workflows/ci.yml")) as { on: Record<string, unknown> };
    const suite = (on.workflow_dispatch as { inputs: Record<string, { options?: string[]; default?: unknown }> }).inputs.suite!;
    expect(suite.options).toContain("changed");
    expect(suite.default).toBe("full");
    expect((on.workflow_dispatch as { inputs: Record<string, { default?: unknown }> }).inputs.extras!.default).toBe(true);
    const run = ci.jobs.plan!.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain('if [ "$suite" = changed ]; then base=origin/main; fi');
  });

  test("the plan's matrix names pinned runners, for every OS", () => {
    const run = ci.jobs.plan!.steps.map((s) => s.run ?? "").join("\n");
    expect(run).toContain('["ubuntu-24.04","macos-15","windows-2025"]');
  });

  test("install-smoke checks nothing out, installs no Bun, and runs the released one-liners", () => {
    const steps = ci.jobs["install-smoke"]!.steps;
    expect(steps.filter((s) => /^(actions\/checkout|oven-sh\/setup-bun)@/.test(s.uses ?? ""))).toEqual([]);
    const run = steps.map((s) => s.run ?? "").join("\n");
    expect(ci.jobs["install-smoke"]!.env).toEqual({ RELEASES: "https://github.com/${{ github.repository }}/releases/latest" });
    expect(run).toContain('curl -fsSL "$RELEASES/download/install.sh" | sh');
    expect(run).toContain('irm "$env:RELEASES/download/install.ps1" | iex');
  });
});


describe("BUG-707/tarball: the documented tarball install works from any directory", () => {
  // `bun add -g` resolves a relative path (`./gluon-1.0.0.tgz`) against Bun's global dir, not the cwd, and fails
  // with ENOENT. Every documented form must be absolute: `bun add -g "$PWD/gluon-<version>.tgz"`.
  const RELATIVE = /bun add -g\s+["']?(\.{1,2}\/|gluon-[^\s"']*\.tgz)/;
  const files = (): string[] => {
    const out = ["README.md", "CONTRIBUTING.md"];
    for (const dir of ["docs", "scripts"]) {
      for (const f of new Bun.Glob("**/*").scanSync({ cwd: join(ROOT, dir), onlyFiles: true })) {
        if (!f.includes("node_modules/")) out.push(`${dir}/${f}`);
      }
    }
    return out;
  };

  test("the pattern catches a relative tarball path", () => {
    for (const bad of ["bun add -g ./gluon-1.0.0.tgz", 'bun add -g "./dist/gluon-<version>.tgz"', "bun add -g ../gluon.tgz", "bun add -g gluon-1.0.0.tgz"]) {
      expect(RELATIVE.test(bad), bad).toBe(true);
    }
    for (const good of ['bun add -g "$PWD/gluon-<version>.tgz"', "bun add -g /tmp/gluon-1.0.0.tgz", "bun add -g in oven/bun"]) {
      expect(RELATIVE.test(good), good).toBe(false);
    }
  });

  test("no doc or script installs a tarball by a relative path", () => {
    const hits: string[] = [];
    for (const f of files()) {
      const text = readFileSync(join(ROOT, f), "utf8");
      text.split("\n").forEach((line, i) => {
        if (RELATIVE.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits, `use bun add -g "$PWD/gluon-<version>.tgz" (absolute):\n${hits.join("\n")}`).toEqual([]);
  });
});
