import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canSymlink } from "./e2e/fixtures.ts";
import { freeBranchPrefix, planWorktree, reusableWorktree, samePath, withWorktree, worktreeBrief, worktreeNames, type WorktreePlan } from "../src/worktree.ts";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repo with one commit; `git(...)` runs plain git in it (the test's own, never Gluon's). `d` is its real path (macOS: /var → /private/var). */
function repo() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "gluon-wt-")));
  made.push(d);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: d, stdout: "pipe", stderr: "pipe", env: process.env });
    return r.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  mkdirSync(join(d, "pkg", "a"), { recursive: true });
  writeFileSync(join(d, "pkg", "a", "x.txt"), "1\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return { d, git };
}

const plan: WorktreePlan = { path: "/r/.gluon/worktrees/gluon-fix-it", branch: "gluon/fix-it", start: "" };

describe("issue 52: worktreeNames", () => {
  test("the directory and branch come from the session name", () => {
    expect(worktreeNames("Gluon-fix-flaky", [], [])).toEqual({ dir: "gluon-fix-flaky", branch: "gluon/fix-flaky" });
    expect(worktreeNames("gluon-fix-flaky", [], [])).toEqual({ dir: "gluon-fix-flaky", branch: "gluon/fix-flaky" });
    // A name that is a reserved Windows device name is still safe behind the prefix.
    expect(worktreeNames("Gluon-con", [], []).dir).toBe("gluon-con");
    expect(worktreeNames("???", [], [])).toEqual({ dir: "gluon-session", branch: "gluon/session" });
  });
  test("a taken directory or branch moves on to -2, -3 …, without regard to case", () => {
    expect(worktreeNames("Gluon-x", ["Gluon-X"], [])).toEqual({ dir: "gluon-x-2", branch: "gluon/x-2" });
    expect(worktreeNames("Gluon-x", [], ["GLUON/x"])).toEqual({ dir: "gluon-x-2", branch: "gluon/x-2" });
    expect(worktreeNames("Gluon-x", ["gluon-x", "gluon-x-2"], ["gluon/x-3"])).toEqual({ dir: "gluon-x-4", branch: "gluon/x-4" });
  });
});

describe("issue 52: the block in the spec", () => {
  test("names the path and branch, tells the agent to create it and work in it", () => {
    const b = worktreeBrief(plan, "linux");
    expect(b).toContain("`/r/.gluon/worktrees/gluon-fix-it`");
    expect(b).toContain('git worktree add -b gluon/fix-it "/r/.gluon/worktrees/gluon-fix-it" HEAD');
    expect(b).toContain("`.gluon/`");
    expect(b).toContain("Never edit the checkout you were started in");
    expect(b).toContain("Don't work in the original checkout on your own");
    expect(b).not.toContain("started in is");
  });
  test("cleanup after a merge: the agent suggests, and removes only when the developer agrees", () => {
    const b = worktreeBrief(plan, "linux");
    expect(b).toContain("tell the developer and suggest removing the worktree and its branch");
    expect(b).toContain("Do nothing until the developer agrees: never remove it on your own, and never remove any other worktree");
    expect(b).toContain('git worktree remove "/r/.gluon/worktrees/gluon-fix-it"` (without `--force`)');
    expect(b).toContain("git branch -d gluon/fix-it");
    expect(b).toContain("ask once more before `git branch -D`");
  });
  test("a start directory below the top is named; Windows paths take forward slashes", () => {
    const b = worktreeBrief({ path: "C:\\r\\.gluon\\worktrees\\gluon-x", branch: "gluon/x", start: "pkg\\a" }, "win32");
    expect(b).toContain('git worktree add -b gluon/x "C:/r/.gluon/worktrees/gluon-x" HEAD');
    expect(b).toContain("The directory you were started in is `pkg/a` there.");
    expect(b).not.toContain("\\");
  });
  test("BUG-660/variants: a worktree the session already made is named as it is, not created again; the cleanup rule stays", () => {
    const b = worktreeBrief({ ...plan, existing: true }, "linux");
    expect(b).toContain("- Worktree: `/r/.gluon/worktrees/gluon-fix-it`");
    expect(b).toContain("uncommitted work");
    expect(b).toContain("Don't create it");
    expect(b).not.toContain("git worktree add");
    expect(b).toContain("Never edit the checkout you were started in");
    expect(b).toContain("Do nothing until the developer agrees");
    expect(b).toContain('git worktree remove "/r/.gluon/worktrees/gluon-fix-it"` (without `--force`)');
  });
  test("the spec comes first, the block after it", () => {
    const s = withWorktree("  Fix the launcher.\n", plan, "linux");
    expect(s.startsWith("Fix the launcher.\n\n## Where to work\n")).toBe(true);
  });
});

describe("issue 52: planWorktree", () => {
  test("a repository: the worktree goes under the checkout's .gluon/worktrees", async () => {
    const { d } = repo();
    expect(await planWorktree("Gluon-fix-it", d)).toEqual({ path: join(d, ".gluon", "worktrees", "gluon-fix-it"), branch: "gluon/fix-it", start: "" });
  });
  test("started in a subdirectory: the same place, and the directory is named", async () => {
    const { d } = repo();
    expect(await planWorktree("Gluon-fix-it", join(d, "pkg", "a"))).toEqual({ path: join(d, ".gluon", "worktrees", "gluon-fix-it"), branch: "gluon/fix-it", start: join("pkg", "a") });
  });
  test("an existing directory, a registered worktree or a branch is never reused", async () => {
    const { d, git } = repo();
    mkdirSync(join(d, ".gluon", "worktrees", "Gluon-Fix-It"), { recursive: true });
    expect(await planWorktree("Gluon-fix-it", d)).toMatchObject({ branch: "gluon/fix-it-2" });
    git("branch", "gluon/fix-it-2");
    expect(await planWorktree("Gluon-fix-it", d)).toMatchObject({ branch: "gluon/fix-it-3" });
    git("worktree", "add", "-q", join(d, ".gluon", "worktrees", "gluon-fix-it-3"), "-b", "other");
    expect(await planWorktree("Gluon-fix-it", d)).toMatchObject({ path: join(d, ".gluon", "worktrees", "gluon-fix-it-4") });
  });
  test("started inside a linked worktree: the new one goes under the main checkout, not nested", async () => {
    const { d, git } = repo();
    const wt = join(d, ".gluon", "worktrees", "gluon-first");
    git("worktree", "add", "-q", wt, "-b", "gluon/first");
    expect(await planWorktree("Gluon-second", wt)).toEqual({ path: join(d, ".gluon", "worktrees", "gluon-second"), branch: "gluon/second", start: "" });
  });
  test("no worktree, with the reason: not a repository, a bare repository, no git", async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "gluon-wt-plain-")));
    made.push(plain);
    expect(await planWorktree("Gluon-x", plain)).toContain("isn't a git repository");
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "gluon-wt-bare-")));
    made.push(bare);
    Bun.spawnSync(["git", "init", "-q", "--bare", bare], { env: process.env });
    expect(await planWorktree("Gluon-x", bare)).toContain("isn't a git repository");
    expect(await planWorktree("Gluon-x", plain, { git: null })).toBe("git isn't installed");
  });
  test("a submodule has no worktree of its own", async () => {
    const lib = repo();
    const sup = repo();
    sup.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.d, "sub");
    expect(await planWorktree("Gluon-x", join(sup.d, "sub"))).toContain("submodule");
  });
  test("a path a shell would act on is refused", async () => {
    const { d } = repo();
    const odd = join(d, "a$b");
    mkdirSync(odd);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: odd, env: process.env });
    expect(await planWorktree("Gluon-x", odd)).toContain("shell would act on");
  });
});

test("issue 52: Gluon only reads the repository: git through gitQuery, nothing created or removed", () => {
  const src = readFileSync(join(import.meta.dir, "../src/worktree.ts"), "utf8");
  expect(src).not.toMatch(/Bun\.(spawn|which)|spawnSync|mkdirSync|rmSync|writeFileSync|"worktree", "(add|remove)"/);
  expect(src).toContain("gitQuery(");
});

// QA campaign (B6): the plan must be one the agent can carry out (its first step is `git worktree add -b <branch> <path> HEAD`).
describe("QA-resume: a plan the agent can't carry out", () => {
  /**
   * What the brief's first step does with `plan`: its exit code and message. With an identity, as `git()` has: without one, git
   * looks up the host's name for the new branch's reflog, which waits out a DNS timeout (15 s) in a container with no network (Alpine).
   */
  const carryOut = (d: string, plan: WorktreePlan) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "worktree", "add", "-b", plan.branch, plan.path, "HEAD"], { cwd: d, stdout: "pipe", stderr: "pipe", env: process.env });
    return { code: r.exitCode, err: r.stderr.toString().trim() };
  };

  test("BUG-640/QA-resume-07: a repository with no commit yet gets no worktree plan, with the reason (`git worktree add … HEAD` fails: invalid reference: HEAD)", async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "gluon-wt-empty-")));
    made.push(d);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: d, env: process.env });
    const plan = await planWorktree("Gluon-x", d);
    expect(typeof plan === "string" || carryOut(d, plan).code === 0).toBe(true);
  });

  test("BUG-641/QA-resume-08: a user's own branch named `gluon` (or `gluon/x`) doesn't make the plan impossible (a ref `gluon` blocks every `gluon/<name>`)", async () => {
    const { d, git } = repo();
    git("branch", "gluon");
    const plan = await planWorktree("Gluon-x", d);
    expect(typeof plan === "string" || carryOut(d, plan).code === 0).toBe(true);
  });

  test("BUG-640/variants: no commit yet gets the reason; the first commit makes a plan the agent can carry out", async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "gluon-wt-empty-")));
    made.push(d);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: d, env: process.env });
    expect(await planWorktree("Gluon-x", d)).toContain("no commit yet");
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: d, env: process.env });
    const plan = await planWorktree("Gluon-x", d);
    expect(typeof plan).toBe("object");
    expect(carryOut(d, plan as WorktreePlan).code).toBe(0);
  });

  test("BUG-641/variants: a branch `gluon` moves on to `gluon-2/…` (and `gluon-3/…` when that is a branch too); a branch below the name (`gluon/x/y`) moves to the next name; each plan can be carried out", async () => {
    const { d, git } = repo();
    git("branch", "gluon");
    const first = (await planWorktree("Gluon-x", d)) as WorktreePlan;
    expect(first.branch).toBe("gluon-2/x");
    expect(carryOut(d, first).code).toBe(0);
    const both = repo();
    both.git("branch", "gluon");
    both.git("branch", "gluon-2");
    const second = (await planWorktree("Gluon-y", both.d)) as WorktreePlan;
    expect(second.branch).toBe("gluon-3/y");
    expect(carryOut(both.d, second).code).toBe(0);
    const r = repo();
    r.git("branch", "gluon/x/y");
    const next = (await planWorktree("Gluon-x", r.d)) as WorktreePlan;
    expect(next.branch).toBe("gluon/x-2");
    expect(carryOut(r.d, next).code).toBe(0);
  });

  test("BUG-641/variants: a tag of the same name as a branch doesn't hide the branch (`gluon` + tag `gluon`; `gluon` + `gluon-2` + tag `gluon-2`); the plan can be carried out", async () => {
    const one = repo();
    one.git("branch", "gluon");
    one.git("tag", "gluon");
    const p1 = (await planWorktree("Gluon-x", one.d)) as WorktreePlan;
    expect(p1.branch).toBe("gluon-2/x");
    expect(carryOut(one.d, p1).code).toBe(0);
    const two = repo();
    for (const n of ["gluon", "gluon-2"]) {
      two.git("branch", n);
      two.git("tag", n);
    }
    const p2 = (await planWorktree("Gluon-x", two.d)) as WorktreePlan;
    expect(p2.branch).toBe("gluon-3/x");
    expect(carryOut(two.d, p2).code).toBe(0);
  });

  test("BUG-641/variants: past gluon-999 no prefix is free, which planWorktree reports as the reason (saved records accept at most three digits)", () => {
    const all = ["gluon", ...Array.from({ length: 998 }, (_, i) => `gluon-${i + 2}`)];
    expect(freeBranchPrefix(all.slice(0, -1))).toBe("gluon-999/");
    expect(freeBranchPrefix(all)).toBeNull();
    expect(() => worktreeNames("Gluon-x", [], all)).toThrow();
  });

  test("BUG-641/variants: worktreeNames picks the prefix from the branches taken, without regard to case", () => {
    expect(worktreeNames("Gluon-x", [], ["Gluon"])).toEqual({ dir: "gluon-x", branch: "gluon-2/x" });
    expect(worktreeNames("Gluon-x", [], ["gluon", "gluon-2", "gluon-2/x"])).toEqual({ dir: "gluon-x", branch: "gluon-3/x" });
    expect(worktreeNames("Gluon-x", [], ["GLUON/x/deep"])).toEqual({ dir: "gluon-x-2", branch: "gluon/x-2" });
  });
});

describe("BUG-660/variants: a saved worktree is gone on in only when this checkout lists it where Gluon planned it", () => {
  const WT = (d: string, name: string) => join(d, ".gluon", "worktrees", name);

  test("a worktree of this checkout, at its planned place and on its branch, is reused (also from inside it)", async () => {
    const { d, git } = repo();
    git("worktree", "add", "-q", WT(d, "gluon-ok"), "-b", "gluon/ok");
    expect(await reusableWorktree({ path: WT(d, "gluon-ok"), branch: "gluon/ok" }, d)).toBe(true);
    expect(await reusableWorktree({ path: WT(d, "gluon-ok"), branch: "gluon/ok" }, WT(d, "gluon-ok"))).toBe(true);
  });

  test("a branch other than the one the worktree is on is planned anew", async () => {
    const { d, git } = repo();
    git("worktree", "add", "-q", WT(d, "gluon-ok"), "-b", "gluon/ok");
    expect(await reusableWorktree({ path: WT(d, "gluon-ok"), branch: "gluon/other" }, d)).toBe(false);
  });

  test("a directory of the right shape that is not listed as a worktree is planned anew, and so is one that is gone", async () => {
    const { d } = repo();
    mkdirSync(WT(d, "gluon-plain"), { recursive: true });
    expect(await reusableWorktree({ path: WT(d, "gluon-plain"), branch: "gluon/plain" }, d)).toBe(false);
    expect(await reusableWorktree({ path: WT(d, "gluon-gone"), branch: "gluon/gone" }, d)).toBe(false);
  });

  test("a path outside the checkout is planned anew, even a real worktree of another repository", async () => {
    const { d } = repo();
    const other = repo();
    other.git("worktree", "add", "-q", WT(other.d, "gluon-x"), "-b", "gluon/x");
    expect(await reusableWorktree({ path: WT(other.d, "gluon-x"), branch: "gluon/x" }, d)).toBe(false);
    const loose = realpathSync(mkdtempSync(join(tmpdir(), "gluon-wt-loose-")));
    made.push(loose);
    mkdirSync(WT(loose, "gluon-evil"), { recursive: true });
    expect(await reusableWorktree({ path: WT(loose, "gluon-evil"), branch: "gluon/evil" }, d)).toBe(false);
  });

  test("a path a shell would act on is planned anew, whatever it is", async () => {
    const { d } = repo();
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gluon-wt-quote-")));
    made.push(base);
    // A Windows file name can't hold a double quote: a single one stands in there.
    const q = process.platform === "win32" ? "'" : '"';
    for (const bad of [`out$(touch pwned)${q}-X`, "out`id`", `a${q}b`]) {
      const path = WT(join(base, bad), "gluon-evil");
      mkdirSync(path, { recursive: true });
      expect(await reusableWorktree({ path, branch: "gluon/evil" }, d)).toBe(false);
    }
  });

  test.skipIf(!canSymlink)("a checkout opened through a symlinked directory still reuses its worktree (git lists the real path, the record has the one it was started in)", async () => {
    const { d, git } = repo();
    git("worktree", "add", "-q", WT(d, "gluon-ok"), "-b", "gluon/ok");
    const holder = realpathSync(mkdtempSync(join(tmpdir(), "gluon-wt-link-")));
    made.push(holder);
    const link = join(holder, "link");
    symlinkSync(d, link);
    const planned = await planWorktree("Gluon-new", link);
    expect(planned).toMatchObject({ path: WT(link, "gluon-new") });
    expect(await reusableWorktree({ path: WT(link, "gluon-ok"), branch: "gluon/ok" }, link)).toBe(true);
    expect(await reusableWorktree({ path: WT(link, "gluon-ok"), branch: "gluon/ok" }, d)).toBe(true);
    expect(await reusableWorktree({ path: WT(d, "gluon-ok"), branch: "gluon/ok" }, link)).toBe(true);
    // From a directory below the top, where git prints the real path.
    expect(await reusableWorktree({ path: WT(link, "gluon-ok"), branch: "gluon/ok" }, join(link, "pkg", "a"))).toBe(true);
  });

  test.skipIf(!canSymlink)("a listed worktree replaced by a symlink to elsewhere is planned anew, and so is a worktree directory that is itself a link", async () => {
    const { d, git } = repo();
    git("worktree", "add", "-q", WT(d, "gluon-ok"), "-b", "gluon/ok");
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "gluon-wt-else-")));
    made.push(elsewhere);
    const moved = join(elsewhere, "moved");
    renameSync(WT(d, "gluon-ok"), moved);
    symlinkSync(moved, WT(d, "gluon-ok"));
    expect(await reusableWorktree({ path: WT(d, "gluon-ok"), branch: "gluon/ok" }, d)).toBe(false);
    // A link that points at a directory that holds nothing of git's.
    symlinkSync(elsewhere, WT(d, "gluon-link"));
    expect(await reusableWorktree({ path: WT(d, "gluon-link"), branch: "gluon/ok" }, d)).toBe(false);
  });

  test("the Windows comparison: case and the kind of slash count for nothing, another drive or directory is another place", () => {
    const none = (p: string): string => {
      throw new Error(`ENOENT ${p}`);
    };
    expect(samePath("C:\\Repo\\.gluon\\worktrees\\gluon-x", "c:/repo/.gluon/worktrees/gluon-x", "win32", none)).toBe(true);
    expect(samePath("C:\\Repo\\.gluon\\worktrees\\gluon-x", "D:\\Repo\\.gluon\\worktrees\\gluon-x", "win32", none)).toBe(false);
    expect(samePath("C:\\Repo\\.gluon\\worktrees\\gluon-x", "C:\\Repo\\.gluon\\worktrees\\gluon-y", "win32", none)).toBe(false);
    // A link followed (the injected real path), and elsewhere case does count.
    const real = (p: string) => (p.toLowerCase().startsWith("c:\\link") ? p.replace(/^c:\\link/i, "C:\\Repo") : p);
    expect(samePath("C:\\link\\.gluon\\worktrees\\gluon-x", "c:/repo/.gluon/worktrees/gluon-x", "win32", real)).toBe(true);
    expect(samePath("/a/Repo", "/a/repo", "linux", none)).toBe(false);
  });

  test("not in a repository, or a branch a shell would act on: planned anew", async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "gluon-wt-plain-")));
    made.push(plain);
    expect(await reusableWorktree({ path: WT(plain, "gluon-x"), branch: "gluon/x" }, plain)).toBe(false);
    const { d, git } = repo();
    git("worktree", "add", "-q", WT(d, "gluon-ok"), "-b", "gluon/ok");
    expect(await reusableWorktree({ path: WT(d, "gluon-ok"), branch: 'gluon/ok"; id' }, d)).toBe(false);
  });
});
