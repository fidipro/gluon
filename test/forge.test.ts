/** The brain's read-only `forge` tool (issue #41): fake gh / glab on PATH, no network. */
import { SLOW } from "./fixtures/slow.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgeArgv, parseForgeRepo } from "../src/agent/forge.ts";
import { runRepoTool, REPO_TOOLS, TOOLS } from "../src/agent/tools.ts";

const posix = process.platform !== "win32";
const dirs: string[] = [];
const PATH = process.env.PATH;
afterEach(() => {
  process.env.PATH = PATH;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** gh and glab that log their argv and print `out` (or fail with `fail`). */
function fakes(out: string, fail?: string) {
  const d = mkdtempSync(join(tmpdir(), "forge-"));
  dirs.push(d);
  const log = join(d, "argv.log");
  for (const bin of ["gh", "glab"]) {
    const body = fail ? `echo ${JSON.stringify(fail)} >&2\nexit 1` : `printf '%b' ${JSON.stringify(out)}`;
    writeFileSync(join(d, bin), `#!/bin/sh\necho "${bin} $*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(join(d, bin), 0o755);
  }
  process.env.PATH = `${d}:${PATH}`;
  return () => (Bun.file(log).size ? readFileSync(log, "utf8").trim().split("\n") : []);
}

const origin = (url: string) => {
  const d = mkdtempSync(join(tmpdir(), "forge-repo-"));
  dirs.push(d);
  Bun.spawnSync(["git", "init", "-q", d]);
  Bun.spawnSync(["git", "-C", d, "remote", "add", "origin", url]);
  return d;
};

describe("issue #41: forge", () => {
  test("it is a repo tool, read-only by schema", () => {
    expect(REPO_TOOLS.has("forge")).toBe(true);
    const t = TOOLS.find((x) => x.name === "forge")!;
    expect((t.input_schema as { properties: { action: { enum: string[] } } }).properties.action.enum).toEqual(["issue_view", "issue_list", "pr_view", "pr_list"]);
  });

  test("remote URLs: github and gitlab only", () => {
    expect(parseForgeRepo("git@github.com:o/r.git")).toEqual({ host: "github.com", path: "o/r" });
    expect(parseForgeRepo("https://github.com/o/r")).toEqual({ host: "github.com", path: "o/r" });
    expect(parseForgeRepo("ssh://git@gitlab.com:22/g/sub/r.git\n")).toEqual({ host: "gitlab.com", path: "g/sub/r" });
    expect(parseForgeRepo("https://evil.example/o/r")).toBeNull();
    expect(parseForgeRepo("https://github.com/o")).toBeNull();
    expect(parseForgeRepo("https://github.com/o/--exec")).toBeNull();
    expect(parseForgeRepo("https://github.com/../r")).toBeNull();
  });

  test("argv is view / list only; a gh view names its --json fields (issues #63, #64)", () => {
    expect(forgeArgv("gh", "github.com", "issue_view", "o/r", { number: 4, count: 20 })).toEqual(["gh", "issue", "view", "4", "-R", "o/r", "--json", expect.stringContaining("comments")]);
    // a gh view without --json fails on the sunset `projectCards` (issues #63, #64)
    for (const a of ["issue_view", "pr_view"] as const) expect(forgeArgv("gh", "github.com", a, "o/r", { number: 4, count: 20 })).toContain("--json");
    expect(forgeArgv("gh", "github.com", "pr_list", "o/r", { state: "all", count: 5 })).toEqual(["gh", "pr", "list", "-R", "o/r", "--state", "all", "--limit", "5"]);
    expect(forgeArgv("glab", "gitlab.com", "pr_view", "g/r", { number: 2, count: 20 })).toEqual(["glab", "mr", "view", "2", "-R", "g/r", "--comments"]);
    expect(forgeArgv("glab", "gitlab.com", "issue_list", "g/r", { state: "closed", count: 3 })).toEqual(["glab", "issue", "list", "-R", "g/r", "--closed", "--per-page", "3"]);
  });

  test.skipIf(!posix)("reads the origin's host with the matching CLI, in a neutral cwd", async () => {
    const calls = fakes("#4 the title\nbody");
    expect(await runRepoTool(origin("git@github.com:o/r.git"), "forge", { action: "issue_view", number: 4 })).toBe("#4 the title\nbody");
    expect(await runRepoTool(origin("https://gitlab.com/g/s/r.git"), "forge", { action: "pr_list", state: "open", count: 2 })).toContain("the title");
    expect(calls()).toEqual([expect.stringMatching(/^gh issue view 4 -R o\/r --json .*comments/), "glab mr list -R g/s/r --per-page 2"]);
  });

  test.skipIf(!posix)("a secret in the output is masked", async () => {
    fakes("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here");
    const out = await runRepoTool(origin("git@github.com:o/r.git"), "forge", { action: "issue_view", number: 1 });
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test.skipIf(!posix)("bad input never reaches a CLI", async () => {
    const calls = fakes("x");
    const d = origin("git@github.com:o/r.git");
    for (const input of [{ action: "issue_comment", number: 1 }, { action: "issue_view" }, { action: "issue_view", number: "1; rm" }, { action: "issue_list", state: "--web" }, { action: "issue_list", repo: "-R/x" }, { action: "issue_list", repo: "https://evil.example/o/r" }])
      await expect(runRepoTool(d, "forge", input)).rejects.toThrow();
    await expect(runRepoTool(origin("https://evil.example/o/r"), "forge", { action: "issue_list" })).rejects.toThrow("not on github.com or gitlab.com");
    expect(calls()).toEqual([]);
  });

  test.skipIf(!posix)("a CLI failure is a tool error naming the sign-in", async () => {
    fakes("", "HTTP 404: Not Found");
    await expect(runRepoTool(origin("git@github.com:o/r.git"), "forge", { action: "issue_view", number: 9 })).rejects.toThrow("gh auth login");
  });

  test.skipIf(!posix)("no gh installed: a clear error", async () => {
    process.env.PATH = "/nonexistent";
    await expect(runRepoTool(tmpdir(), "forge", { action: "issue_list", repo: "o/r" })).rejects.toThrow("gh is not installed");
  });
});

// --- QA pass (brain, offline): hosts, hostile remotes, writes, masking

/** gh and glab that log their argv and the host variables they were started with, and print `out` on stdout and `err` on stderr. */
function loggingFakes(out = "ok", err = "") {
  const d = mkdtempSync(join(tmpdir(), "forge-qa-"));
  dirs.push(d);
  const log = join(d, "calls.log");
  for (const bin of ["gh", "glab"]) {
    writeFileSync(join(d, bin), `#!/bin/sh\necho "${bin} GH_HOST=$GH_HOST GITLAB_HOST=$GITLAB_HOST GL_HOST=$GL_HOST GITLAB_URI=$GITLAB_URI GITLAB_API_HOST=$GITLAB_API_HOST :: $*" >> ${JSON.stringify(log)}\nprintf '%b' ${JSON.stringify(out)}\n${err ? `printf '%b' ${JSON.stringify(err)} >&2\n` : ""}`);
    chmodSync(join(d, bin), 0o755);
  }
  process.env.PATH = `${d}:${PATH}`;
  return () => (Bun.file(log).size ? readFileSync(log, "utf8").trim().split("\n") : []);
}

// The candidates are top-level so that their titles start with BUG-CANDIDATE.
const HOST_VARS = ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "GITLAB_API_PROTOCOL", "GH_HOST", "GITLAB_HOST", "GL_HOST", "GITLAB_URI", "GITLAB_API_HOST", "GH_ENTERPRISE_TOKEN"];
let savedHosts: Record<string, string | undefined> | null = null;
afterEach(() => {
  if (savedHosts) for (const k of HOST_VARS) (savedHosts[k] === undefined ? delete process.env[k] : (process.env[k] = savedHosts[k]));
  savedHosts = null;
});
/** The host variables of the user's environment for this test: exactly `v`, the rest unset (restored after the test). */
const setHosts = (v: Record<string, string>) => {
  savedHosts ??= Object.fromEntries(HOST_VARS.map((k) => [k, process.env[k]]));
  for (const k of HOST_VARS) delete process.env[k];
  Object.assign(process.env, v);
};

const HOSTILE = { GH_HOST: "github.corp.example", GITLAB_HOST: "https://gitlab.corp.example", GL_HOST: "gitlab.corp.example", GITLAB_URI: "https://gitlab.corp.example", GITLAB_API_HOST: "gitlab.corp.example" };

// The fakes are `#!/bin/sh` scripts, which Windows can't run: skipped there, as the BUG-592 tests below.
test.skipIf(!posix)("BUG-592/QA-brain-10: gh and glab are told which host (github.com / gitlab.com), whatever GH_HOST / GITLAB_HOST the user's environment holds: a hostile origin must not reach the user's company instance", async () => {
  setHosts({ GH_HOST: "github.corp.example", GITLAB_HOST: "https://gitlab.corp.example" });
  const calls = loggingFakes("x");
  await runRepoTool(origin("git@github.com:victim/secret-repo.git"), "forge", { action: "issue_list" });
  await runRepoTool(origin("https://gitlab.com/victim/secret-project.git"), "forge", { action: "issue_list" });
  const [gh, glab] = calls();
  // `-R owner/repo` without a host goes to GH_HOST / GITLAB_HOST: the call must carry the host in -R, or run without those variables.
  const pinned = (line: string, host: string, variable: string) => new RegExp(`-R ${host.replace(".", "\\.")}/`).test(line) || new RegExp(`${variable}=( |$)`).test(line.split(" :: ")[0]!) || line.includes(`${variable}=${host}`);
  expect([gh, pinned(gh!, "github.com", "GH_HOST")]).toEqual([gh, true]);
  expect([glab, pinned(glab!, "gitlab.com", "GITLAB_HOST")]).toEqual([glab, true]);
});

describe("BUG-592: the forge CLIs run with the origin's host, and the user's variables stay", () => {
  test.skipIf(!posix)("a gitlab.com origin: every GitLab host variable of the CLI names gitlab.com, the GitHub one is left alone", async () => {
    setHosts(HOSTILE);
    const calls = loggingFakes("x");
    await runRepoTool(origin("https://gitlab.com/g/sub/r.git"), "forge", { action: "pr_list" });
    expect(calls()).toEqual(["glab GH_HOST=github.corp.example GITLAB_HOST=gitlab.com GL_HOST=gitlab.com GITLAB_URI=gitlab.com GITLAB_API_HOST=gitlab.com :: mr list -R g/sub/r --per-page 20"]);
  });

  test.skipIf(!posix)("a github.com origin: GH_HOST is github.com (also for a `repo` given without a host), the GitLab variables are left alone", async () => {
    setHosts(HOSTILE);
    const calls = loggingFakes("x");
    const dir = origin("https://github.com/o/r.git");
    await runRepoTool(dir, "forge", { action: "issue_list" });
    await runRepoTool(dir, "forge", { action: "issue_list", repo: "other/repo" });
    const lines = calls();
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toStartWith("gh GH_HOST=github.com GITLAB_HOST=https://gitlab.corp.example GL_HOST=gitlab.corp.example GITLAB_URI=https://gitlab.corp.example GITLAB_API_HOST=gitlab.corp.example :: ");
    expect(lines[1]).toContain("-R other/repo");
  });

  /** A glab that logs the token variables it was started with. */
  function tokenGlab() {
    const d = mkdtempSync(join(tmpdir(), "forge-tok-"));
    dirs.push(d);
    const log = join(d, "tokens.log");
    writeFileSync(join(d, "glab"), `#!/bin/sh\necho "GITLAB_TOKEN=$GITLAB_TOKEN GITLAB_ACCESS_TOKEN=$GITLAB_ACCESS_TOKEN OAUTH_TOKEN=$OAUTH_TOKEN GITLAB_API_PROTOCOL=$GITLAB_API_PROTOCOL" >> ${JSON.stringify(log)}\n`);
    chmodSync(join(d, "glab"), 0o755);
    process.env.PATH = `${d}:${PATH}`;
    return () => readFileSync(log, "utf8").trim();
  }
  const TOKENS = { GITLAB_TOKEN: "glpat-corp", GITLAB_ACCESS_TOKEN: "glpat-corp2", OAUTH_TOKEN: "oauth-corp", GITLAB_API_PROTOCOL: "http" };

  test.skipIf(!posix)("a token of the user's other GitLab host is not sent to gitlab.com: the host variables name the other host, the token variables are dropped", async () => {
    for (const host of [{ GITLAB_HOST: "https://gitlab.corp.example" } as Record<string, string>, { GL_HOST: "gitlab.corp.example" }, { GITLAB_URI: "http://GitLab.Corp.Example:8443/x" }]) {
      setHosts({ ...TOKENS, ...host });
      const out = tokenGlab();
      await runRepoTool(origin("https://gitlab.com/g/r.git"), "forge", { action: "issue_list" });
      expect([host, out()]).toEqual([host, "GITLAB_TOKEN= GITLAB_ACCESS_TOKEN= OAUTH_TOKEN= GITLAB_API_PROTOCOL="]);
      for (const k of Object.keys(TOKENS)) expect(process.env[k]).toBe(TOKENS[k as keyof typeof TOKENS]); // the user's own stay
    }
  });

  test.skipIf(!posix)("without a host variable, or one that names gitlab.com, the user's GitLab token is kept", async () => {
    for (const host of [{} as Record<string, string>, { GITLAB_HOST: "gitlab.com" }, { GITLAB_HOST: "https://www.gitlab.com/" }, { GL_HOST: "gitlab.com:443" }]) {
      setHosts({ ...TOKENS, ...host });
      const out = tokenGlab();
      await runRepoTool(origin("https://gitlab.com/g/r.git"), "forge", { action: "issue_list" });
      expect([host, out()]).toEqual([host, "GITLAB_TOKEN=glpat-corp GITLAB_ACCESS_TOKEN=glpat-corp2 OAUTH_TOKEN=oauth-corp GITLAB_API_PROTOCOL=http"]);
    }
  });

  test.skipIf(!posix)("the variables are the child's: the process environment keeps the user's own", async () => {
    setHosts(HOSTILE);
    loggingFakes("x");
    await runRepoTool(origin("git@github.com:o/r.git"), "forge", { action: "issue_list" });
    expect([process.env.GH_HOST, process.env.GITLAB_HOST]).toEqual(["github.corp.example", "https://gitlab.corp.example"]);
  });
});

/** A `gh` that is a wrapper script: it starts the real work as a child (a company's sandbox or 1Password wrapper does). */
function wrapperGh(seconds: number) {
  const dir = mkdtempSync(join(tmpdir(), "forge-slow-"));
  dirs.push(dir);
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nsleep ${seconds}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${PATH}`;
}

test.skipIf(!posix)("BUG-654/QA-brain-11: Esc while forge runs ends the tool call at once, also when the CLI started a child that still holds its output", async () => {
  wrapperGh(2);
  const ac = new AbortController();
  const started = Date.now();
  const p = runRepoTool(origin("git@github.com:o/r.git"), "forge", { action: "issue_list" }, ac.signal).catch(() => "rejected");
  setTimeout(() => ac.abort(), 100);
  await p;
  expect(Date.now() - started).toBeLessThan(1500 * SLOW);
});

/** A `gh` that starts `sleep` in the background and records its pid; it waits for it, or (`exit`) ends at once while the child keeps the pipes. */
function pidGh(exit: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "forge-pid-"));
  dirs.push(dir);
  const pidFile = join(dir, "child.pid");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\n${exit ? "exit 0" : "wait"}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${PATH}`;
  return async () => {
    for (let i = 0; i < 100 && !Bun.file(pidFile).size; i++) await Bun.sleep(20);
    return Number(readFileSync(pidFile, "utf8").trim());
  };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(20);
  return !alive(pid);
};

describe("BUG-654/variants: forge abort", () => {
  test.skipIf(!posix)("BUG-654/variants: Esc kills the CLI's child too, not only the CLI", async () => {
    const childPid = pidGh(false);
    const ac = new AbortController();
    const p = runRepoTool(origin("git@github.com:o/r.git"), "forge", { action: "issue_list" }, ac.signal).catch((e: Error) => e);
    const pid = await childPid();
    expect(alive(pid)).toBe(true);
    ac.abort();
    expect(await p).toBeInstanceOf(Error);
    try {
      expect(await gone(pid)).toBe(true);
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL"); // the test's own sleep
    }
  });

  test.skipIf(!posix)("BUG-654/variants: the CLI already gone but its child still holds the pipe: Esc still ends the call at once", async () => {
    const childPid = pidGh(true);
    const ac = new AbortController();
    const p = runRepoTool(origin("git@github.com:o/r.git"), "forge", { action: "issue_list" }, ac.signal).catch((e: Error) => e);
    const pid = await childPid();
    const started = Date.now();
    setTimeout(() => ac.abort(), 100);
    expect(await p).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(3000 * SLOW);
    try {
      expect(await gone(pid)).toBe(true);
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  test.skipIf(!posix)("BUG-654/variants: a call that ends by itself, with a signal given, still returns its output", async () => {
    fakes("hello\\n");
    expect(await runRepoTool(origin("git@github.com:o/r.git"), "forge", { action: "issue_list" }, new AbortController().signal)).toBe("hello");
  });
});


describe("QA: forge", () => {
  test.skipIf(!posix)("a hostile origin that names another host, a lookalike, a path, a flag or a second line never starts gh or glab", async () => {
    const calls = loggingFakes("x");
    for (const url of ["https://github.com.evil.example/o/r", "https://evil.example/github.com/o/r", "https://github.com@evil.example/o/r", "git@evil.example:o/r.git", "https://github.com/o/r/extra", "https://github.com/--web/r", "https://gitlab.com/g/-/r", "/srv/git/github.com/o/r", "ssh://git@gitlab.corp.example/g/r"]) {
      await expect(runRepoTool(origin(url), "forge", { action: "issue_list" })).rejects.toThrow("not on github.com or gitlab.com");
    }
    expect(calls()).toEqual([]);
  });

  test.skipIf(!posix)("`repo` is checked as the origin is: another host, a lookalike, a flag or a path is refused on GitHub; without a host it takes the origin's", async () => {
    const calls = loggingFakes("x");
    const gh = origin("git@github.com:o/r.git");
    for (const repo of ["github.com.evil.example/o/r", "evil.example/o/r", "https://evil.example/o/r", "o/r --web", "o/r;id", "../r", "o/../r", "-R/x", "o", "o/r/extra"])
      await expect(runRepoTool(gh, "forge", { action: "pr_list", repo })).rejects.toThrow();
    expect(calls()).toEqual([]);
    // A GitLab origin: `owner/repo` without a host takes it, and a group path of any depth is fine there.
    await runRepoTool(origin("git@gitlab.com:g/r.git"), "forge", { action: "pr_list", repo: "grp/sub/proj" });
    expect(calls()).toEqual([expect.stringMatching(/^glab .* :: mr list -R grp\/sub\/proj --per-page 20$/)]);
  });

  test.skipIf(!posix)("no input makes a write: only the four view and list actions exist, and every argv word that isn't data is fixed", async () => {
    const calls = loggingFakes("x");
    const d = origin("git@github.com:o/r.git");
    for (const action of ["issue_create", "issue_comment", "issue_close", "pr_merge", "pr_create", "pr_review", "pr_checkout", "api", "repo_delete", "issue_view; rm -rf /", "ISSUE_VIEW", "", null, 5]) {
      await expect(runRepoTool(d, "forge", { action, number: 1 })).rejects.toThrow("action must be one of");
    }
    // Extra keys that look like flags or subcommands are not read.
    await runRepoTool(d, "forge", { action: "issue_list", state: "closed", count: 3, web: true, args: ["--web"], flags: "--json", body: "hi", extra: "--repo=x/y" });
    await runRepoTool(d, "forge", { action: "pr_view", number: 7, comment: "LGTM", method: "squash" });
    expect(calls().map((l) => l.split(" :: ")[1])).toEqual(["issue list -R o/r --state closed --limit 3", expect.stringMatching(/^pr view 7 -R o\/r --json number,title,state,isDraft/)]);
  });

  test.skipIf(!posix)("the count and number are bounded; a non-integer or huge number is refused", async () => {
    const calls = loggingFakes("x");
    const d = origin("git@github.com:o/r.git");
    for (const n of [0, -1, 1.5, 1e9, Number.NaN, Number.POSITIVE_INFINITY, "7", null]) await expect(runRepoTool(d, "forge", { action: "issue_view", number: n })).rejects.toThrow("number must be a positive integer");
    await runRepoTool(d, "forge", { action: "issue_list", count: 10_000 });
    await runRepoTool(d, "forge", { action: "issue_list", count: -5 });
    await runRepoTool(d, "forge", { action: "issue_list", count: Number.NaN });
    expect(calls().map((l) => l.split("--limit ")[1])).toEqual(["50", "1", "20"]);
  });

  test.skipIf(!posix)("secrets are masked on stdout and in the error from stderr; NUL bytes and a huge output are cut", async () => {
    loggingFakes(`token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\\0end\\n${"x".repeat(40_000)}`);
    const d = origin("git@github.com:o/r.git");
    const out = await runRepoTool(d, "forge", { action: "issue_view", number: 1 });
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(out).not.toContain("\0");
    expect(out.length).toBeLessThan(30_100);
    expect(out).toContain("… cut at 30000 characters");
    // stderr of a failing CLI is masked too.
    fakes("", "HTTP 401: bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123456789 (try gh auth login)");
    const err = await runRepoTool(d, "forge", { action: "issue_view", number: 1 }).catch((e: Error) => e.message);
    expect(err).toContain("gh failed");
    expect(err).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test.skipIf(!posix)("an empty answer says so", async () => {
    loggingFakes("");
    expect(await runRepoTool(origin("git@github.com:o/r.git"), "forge", { action: "issue_list" })).toBe("(nothing found)");
  });

  test.skipIf(!posix)("an abort while the CLI itself runs kills it and rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-exec-"));
    dirs.push(dir);
    writeFileSync(join(dir, "gh"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(dir, "gh"), 0o755);
    process.env.PATH = `${dir}:${PATH}`;
    const ac = new AbortController();
    const started = Date.now();
    const p = runRepoTool(origin("git@github.com:o/r.git"), "forge", { action: "issue_list" }, ac.signal);
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000 * SLOW);
  });
});
