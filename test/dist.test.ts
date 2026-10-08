/**
 * The compiled binary (`bun run test:dist`: scripts/build.ts --check builds the host's release and
 * test flavors, then runs this file). Skipped unless GLUON_TEST_BINARY names a test-flavor
 * binary (it keeps the GLUON_TEST_PROBES seam); GLUON_TEST_RELEASE_BINARY, when set, names
 * the release one. The e2e harness runs GLUON_TEST_BINARY instead of Bun on the source.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { MIGRATIONS } from "../src/analytics.ts";
import { STRING_WIDTH_PATCHED } from "../scripts/build.ts";
import { config, fakeAgents, repo } from "./e2e/fixtures.ts";
import { App, cli, HOME, HOME_VIEW, KEY, SLOW, start, stopAll, SYSTEM_ENV, SYSTEM_PATH, toLaunch, toQuestion } from "./e2e/harness.ts";

const BIN = process.env.GLUON_TEST_BINARY;
const RELEASE = process.env.GLUON_TEST_RELEASE_BINARY;

setDefaultTimeout(30_000 * SLOW);
afterAll(stopAll);

describe.skipIf(!BIN)("compiled binary", () => {
  test("--version and --help", async () => {
    const v = await cli(["--version"]);
    expect([v.code, v.stdout.trim(), v.stderr]).toEqual([0, pkg.version, ""]);
    const h = await cli(["--help"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain(`gluon ${pkg.version} — Gluon, a control platform for coding agents`);
  });

  test("doctor with a temp config and fake agents", async () => {
    const r = await cli(["doctor"], { env: { GLUON_CONFIG: config("dist-doctor", "connections: { claude-code: { auth: subscription } }\n") } });
    expect(r.stdout).toContain("✓ Claude Code (claude 2.1.284)");
    expect(r.stdout).toContain("✓ 1. Sonnet 5.5 on your Claude plan (personal)   ← in use");
    expect(r.code).toBe(0);
  });

  test("--launch --dry-run", async () => {
    const r = await cli(["--launch", "codex", "--model", "gpt-6.1-sol", "--dry-run", "--", "- a spec"], { env: { GLUON_CONFIG: config("dist-dry", "connections: { codex: { auth: api, provider: openai } }\n"), OPENAI_API_KEY: "sk-proj-0123456789abcdef0123" } });
    expect(r.code).toBe(0);
    const c = JSON.parse(r.stdout);
    expect(c.argv.at(-2)).toBe("--");
    expect(c.argv.at(-1)).toBe("- a spec");
    expect(c.env).toEqual({ OPENAI_API_KEY: "sk-proj-••••" });
  });

  test("the fallback grep runs in its worker (no rg, not a git repo)", async () => {
    // PATH holds only the fake agents: no rg, no git, so grep falls back to the bundled worker
    // (a repo with a package.json: the demo reads it, so any failure is the search's).
    const app = await start({ cwd: repo.withSpace(), rows: 50, env: { PATH: fakeAgents(["claude", "opencode"]) } });
    await toQuestion(app);
    const h = app.screen();
    expect(h).toContain('searched for "test"');
    expect(h).not.toContain("failed");
  });

  test("`gluon stats sql` runs its query in a child (the binary itself), cuts its rows and, where the seam exists, stops at the deadline (BUG-597)", async () => {
    const state = mkdtempSync(join(tmpdir(), "gluon-dist-stats-"));
    try {
      mkdirSync(join(state, "gluon"));
      const db = new Database(join(state, "gluon", "analytics.db"), { create: true });
      for (const m of MIGRATIONS) db.exec(m);
      db.run(`PRAGMA user_version=${MIGRATIONS.length}`);
      db.close();
      const env = { XDG_STATE_HOME: state, LOCALAPPDATA: state };
      const ok = await cli(["stats", "sql", "SELECT count(*) AS n FROM sessions"], { env });
      expect([ok.code, ok.stdout.trimEnd().split("\n"), ok.stderr]).toEqual([0, ["n", "0", "(1 row)"], ""]);
      const rows = await cli(["stats", "sql", "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 10500) SELECT x FROM c", "--json"], { env });
      expect([rows.code, JSON.parse(rows.stdout).length, rows.stderr.trim()]).toEqual([0, 10_000, "gluon: first 10000 rows; add LIMIT"]);
      // The npm bundle, like the release binary, has no test seam: its deadline is the real 10 s.
      if (readFileSync(BIN!).includes("GLUON_TEST_SQL_DEADLINE_MS")) {
        const slow = await cli(["stats", "sql", "SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 20000000) SELECT x FROM c)"], { env: { ...env, GLUON_TEST_SQL_DEADLINE_MS: "700" }, timeoutMs: 20_000 * SLOW });
        expect([slow.code, slow.stderr]).toEqual([1, expect.stringContaining("stopped after 0.7 s")]);
      }
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("a UI launch runs the agent in Gluon's frame, in the bundled pseudo-terminal; Ctrl+\\ twice shows home", async () => {
    // The demo intake agent's Claude Code proposal, launched with the fake's raw-mode TUI: only a
    // session (the bundled @xterm/headless screen, with its Unicode 11 addon) draws a frame.
    const app = await start({ cwd: repo.tiny(), rows: 60, cols: 100, env: { FAKE_TUI: "1" } });
    await toLaunch(app, "TUI ready");
    expect(app.screen()).toContain("◆ gluon");
    expect(app.history()).not.toContain("no pseudo-terminal here");
    await app.type("!wide");
    await app.press(KEY.enter);
    await app.waitFor("WIDE 你好世界");
    // Ctrl+\ is a prefix in a session: the first names it in the bar, the second shows home.
    app.write("\x1c");
    await app.waitFor((s) => /ctrl\+\\ home · esc cancel/.test(s));
    app.write("\x1c");
    await app.waitFor(HOME_VIEW);
  });

  describe("a hostile working directory (BUG-56 class)", () => {
    const outer = mkdtempSync(join(tmpdir(), "gluon-hostile-"));
    const dir = join(outer, "repo");
    mkdirSync(dir);
    const marker = join(dir, "PRELOAD-RAN");
    const KEY = "sk-ant-hostile-0123456789abcdefghij";
    writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./p.ts"]\n');
    writeFileSync(join(dir, "p.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
    writeFileSync(join(dir, ".env"), `ANTHROPIC_API_KEY=${KEY}\nOPENAI_API_KEY=${KEY}\n`);
    writeFileSync(join(dir, "package.json"), '{ "name": "hostile", "type": "module" }\n');
    writeFileSync(join(dir, "tsconfig.json"), '{ "compilerOptions": { "paths": { "react": ["./p.ts"] } } }\n');
    const cfg = config("dist-hostile", "connections: { claude-code: { auth: subscription } }\n");
    // A react-devtools-core in the repo's and its parent's node_modules, for Ink's DEV=true (BUG-99).
    const devtoolsMarker = join(outer, "DEVTOOLS-RAN");
    for (const d of [dir, outer]) {
      const pkgDir = join(d, "node_modules", "react-devtools-core");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), '{ "name": "react-devtools-core", "version": "9.9.9", "main": "index.js" }\n');
      writeFileSync(join(pkgDir, "index.js"), `require("node:fs").writeFileSync(${JSON.stringify(devtoolsMarker)}, "x"); module.exports = { initialize() {}, connectToDevTools() {} };\n`);
    }
    // A grep worker in the cwd, where Bun looks for a worker that isn't embedded (BUG-101).
    const workerMarker = join(outer, "WORKER-RAN");
    mkdirSync(join(dir, "agent"));
    for (const f of ["grep-worker.ts", "grep-worker.js"]) writeFileSync(join(dir, "agent", f), `require("node:fs").writeFileSync(${JSON.stringify(workerMarker)}, "x");\n`);
    afterAll(() => {
      try {
        rmSync(outer, { recursive: true, force: true });
      } catch (e) {
        // Windows may keep a just-run exe locked (antivirus); the temp dir goes with the runner.
        if (process.platform !== "win32") throw e;
      }
    });

    test("BUG-102: a git / rg planted in the repository never runs (Windows looks in the cwd first; POSIX with . on PATH)", async () => {
      const planted = join(outer, "planted");
      mkdirSync(planted);
      writeFileSync(join(planted, "notes.txt"), "a test note\n");
      const git = Bun.which("git")!;
      for (const args of [["-c", "init.defaultBranch=main", "init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]]) Bun.spawnSync([git, ...args], { cwd: planted });
      const marker = join(outer, "PLANTED-RAN");
      if (process.platform === "win32") {
        const src = join(outer, "planted.ts");
        writeFileSync(src, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
        const b = Bun.spawnSync([process.execPath, "build", "--compile", src, "--outfile", join(planted, "git.exe")], { stdout: "pipe", stderr: "pipe" });
        expect([b.exitCode, b.stderr.toString()]).toEqual([0, ""]);
        require("node:fs").copyFileSync(join(planted, "git.exe"), join(planted, "rg.exe"));
      } else
        for (const b of ["git", "rg"]) {
          writeFileSync(join(planted, b), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
          require("node:fs").chmodSync(join(planted, b), 0o755);
        }
      const path = [".", fakeAgents(["claude", "opencode"]), ...SYSTEM_PATH].join(delimiter);
      // Windows spells it "Path", as a user's environment does (with it, Bun given an env searched the cwd first).
      const env = { GLUON_CONFIG: cfg, ...(process.platform === "win32" ? { PATH: undefined, Path: path } : { PATH: path }) };
      expect((await cli(["doctor"], { cwd: planted, env })).code).toBe(0);
      const app = await start({ cwd: planted, rows: 50, env });
      expect(app.screen()).toContain("planted · main");
      await toQuestion(app);
      expect(app.screen()).toContain('searched for "test"');
      app.kill();
      expect(existsSync(marker)).toBe(false);
    });

    test("BUG-101: the grep worker is the embedded one (it was missing on Windows), never a copy in the cwd", async () => {
      const app = await start({ cwd: dir, rows: 50, env: { GLUON_CONFIG: cfg, PATH: fakeAgents(["claude", "opencode"]) } });
      await toQuestion(app);
      const h = app.screen();
      expect(h).toContain('searched for "test"');
      expect(h).not.toContain("failed");
      expect(existsSync(workerMarker)).toBe(false);
    });

    test("BUG-99: DEV=true never loads react-devtools-core from the cwd's node_modules", async () => {
      for (const args of [["--version"], ["doctor"]]) expect((await cli(args, { cwd: dir, env: { GLUON_CONFIG: cfg, DEV: "true" } })).code).toBe(0);
      const app = await start({ cwd: dir, env: { GLUON_CONFIG: cfg, DEV: "true" } });
      app.kill();
      if (RELEASE) expect(Bun.spawnSync([RELEASE, "--version"], { cwd: dir, env: { ...SYSTEM_ENV, PATH: SYSTEM_PATH.join(delimiter), DEV: "true" } }).exitCode).toBe(0);
      expect(existsSync(devtoolsMarker)).toBe(false);
    });

    test("doctor, a dry run and a launch: no preload, no key from .env", async () => {
      const doc = await cli(["doctor"], { cwd: dir, env: { GLUON_CONFIG: cfg } });
      expect(doc.code).toBe(0);
      // The Claude-plan warning would name ANTHROPIC_API_KEY had the .env reached process.env.
      expect(doc.stdout + doc.stderr).not.toContain("ANTHROPIC_API_KEY is set in your environment");
      const dry = await cli(["--launch", "claude-code", "--model", "sonnet", "--dry-run", "--", "x"], { cwd: dir, env: { GLUON_CONFIG: cfg } });
      expect(dry.code).toBe(0);
      expect(JSON.parse(dry.stdout).env).toEqual({});
      const app = new App({ cwd: dir, args: ["--launch", "claude-code", "--model", "sonnet", "fix it"], env: { GLUON_CONFIG: cfg }, agents: ["claude"], noDemo: true, rows: 40, cols: 120 });
      await app.waitFor("type a line>");
      const h = app.history();
      expect(h).toContain("ENV ANTHROPIC_API_KEY=unset");
      expect(h).toContain("ENV OPENAI_API_KEY=unset");
      expect(h).not.toContain(KEY);
      expect(existsSync(marker)).toBe(false);
    });

    test.skipIf(!RELEASE)("the release binary too", async () => {
      const r = Bun.spawnSync([RELEASE!, "--launch", "claude-code", "--model", "sonnet", "--dry-run", "--", "x"], { cwd: dir, env: { ...SYSTEM_ENV, PATH: fakeAgents(["claude"]), HOME, USERPROFILE: HOME, GLUON_CONFIG: cfg } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.toString()).env).toEqual({});
      expect(existsSync(marker)).toBe(false);
    });

    test("control: a binary compiled with Bun's defaults does load them", async () => {
      const src = join(outer, "control.ts");
      const exe = `${src}.bin${process.platform === "win32" ? ".exe" : ""}`;
      writeFileSync(src, "console.log(process.env.ANTHROPIC_API_KEY ?? 'none');\n");
      try {
        // Built in a child process: on Windows the building process keeps the exe open.
        const b = Bun.spawnSync([process.execPath, "build", "--compile", src, "--outfile", exe], { stdout: "pipe", stderr: "pipe" });
        expect([b.exitCode, b.stderr.toString()]).toEqual([0, ""]);
        const r = Bun.spawnSync([exe], { cwd: dir, env: { ...SYSTEM_ENV, PATH: SYSTEM_PATH.join(delimiter) } });
        expect(r.stdout.toString().trim()).toBe(KEY);
        expect(existsSync(marker)).toBe(true);
      } finally {
        rmSync(marker, { force: true });
        rmSync(src, { force: true });
        try {
          rmSync(exe, { force: true });
        } catch (e) {
          // Windows may keep a just-run exe locked (antivirus); the temp dir goes with the runner.
          if (process.platform !== "win32") throw e;
        }
      }
    });
  });
});

describe.skipIf(!RELEASE)("release binary", () => {
  test("BUG-615: the binary carries the patched string-width (the emoji pre-check)", async () => {
    expect(STRING_WIDTH_PATCHED.test(Buffer.from(await Bun.file(RELEASE!).arrayBuffer()).toString("latin1"))).toBe(true);
  });

  test.each(["GLUON_TEST_PROBES", "GLUON_TEST_PTY_FAIL", "GLUON_TEST_COMPACT_TIMEOUT_MS", "GLUON_TEST_NO_PTY", "GLUON_TEST_DEMO_PACE", "GLUON_TEST_MAINTAINER_MODELS", "GLUON_TEST_OPENROUTER", "GLUON_TEST_PRICING", "GLUON_TEST_SQL_DEADLINE_MS", "GLUON_TEST_UPDATE"])("the %s seam is compiled out", async (seam) => {
    const bytes = new Uint8Array(await Bun.file(RELEASE!).arrayBuffer());
    expect(Buffer.from(bytes).includes(seam)).toBe(false);
    expect(Buffer.from(await Bun.file(BIN ?? RELEASE!).arrayBuffer()).includes(seam)).toBe(!!BIN);
  });
});
