/** scripts/dco.ts: the DCO sign-off check for outside contributions (ci.yml's `dco` job). Pure logic plus one run on a throwaway repo. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Commit, dcoFailures, parseLog, signoffEmails } from "../scripts/dco.ts";

const commit = (message: string, over: Partial<Commit> = {}): Commit => ({
  sha: "a".repeat(40), authorName: "Ada Lovelace", authorEmail: "ada@example.com", message, parents: ["b".repeat(40)], ...over,
});
const failing = (c: Commit) => dcoFailures([c]).map((f) => f.reason);

describe("dcoFailures", () => {
  test("a commit with a matching Signed-off-by trailer passes", () => {
    expect(failing(commit("Fix a thing\n\nWhy.\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n"))).toEqual([]);
  });

  test("a commit with no trailer fails", () => {
    expect(failing(commit("Fix a thing\n\nWhy.\n"))).toEqual(["no Signed-off-by trailer"]);
  });

  test("a trailer with another email fails", () => {
    const r = failing(commit("Fix\n\nSigned-off-by: Ada Lovelace <other@example.com>\n"));
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("not the author's");
  });

  test("the email match ignores case, in the trailer key and the address", () => {
    expect(failing(commit("Fix\n\nsigned-off-by: Ada <ADA@Example.COM>\n"))).toEqual([]);
    expect(failing(commit("Fix\n\nSigned-off-by: Ada <ada@example.com>\n", { authorEmail: "Ada@EXAMPLE.com" }))).toEqual([]);
  });

  test("a merge commit (two parents) is skipped, a root commit is not", () => {
    expect(failing(commit("Merge branch 'main'", { parents: ["b".repeat(40), "c".repeat(40)] }))).toEqual([]);
    expect(failing(commit("Initial", { parents: [] }))).toEqual(["no Signed-off-by trailer"]);
  });

  test("a sign-off by a co-author passes next to other trailers, as long as one matches the author", () => {
    const msg = "Fix\n\nSigned-off-by: Bob <bob@example.com>\nCo-authored-by: Ada <ada@example.com>\nSigned-off-by: Ada <ada@example.com>\n";
    expect(failing(commit(msg))).toEqual([]);
  });

  test("reports the short subject on one line, without control characters", () => {
    const [f] = dcoFailures([commit("Subject\u001b[31mred\r\n\nbody")]);
    expect(f!.subject).toBe("Subject [31mred");
  });
});

describe("signoffEmails: a sign-off must be a trailer", () => {
  // The choice (documented in scripts/dco.ts): like `git interpret-trailers --parse`, only the message's last paragraph
  // counts, it is not the subject paragraph, and every line in it is trailer-shaped. Looser than that and a quote in the
  // body would pass; stricter than git, so a sign-off after prose in the same paragraph does not count either.
  test("a sign-off quoted mid-paragraph is not a trailer", () => {
    expect(signoffEmails("Fix\n\nThe old text said Signed-off-by: Ada <ada@example.com> and was wrong.\nMore prose.\n")).toEqual([]);
  });

  test("a sign-off line inside an earlier paragraph is not a trailer", () => {
    expect(signoffEmails("Fix\n\nSigned-off-by: Ada <ada@example.com>\n\nThe rest of the body.\n")).toEqual([]);
  });

  test("a sign-off line after prose in the last paragraph is not a trailer", () => {
    expect(signoffEmails("Fix\n\nSome closing words\nSigned-off-by: Ada <ada@example.com>\n")).toEqual([]);
  });

  test("a sign-off in the subject paragraph is not a trailer", () => {
    expect(signoffEmails("Signed-off-by: Ada <ada@example.com>\n")).toEqual([]);
    expect(signoffEmails("Fix\nSigned-off-by: Ada <ada@example.com>\n")).toEqual([]);
  });

  test("a trailer block with several kinds of trailers, CRLF line ends and a folded value counts", () => {
    const msg = "Fix\r\n\r\nFixes: #12\r\nSigned-off-by: Ada <ada@example.com>\r\nCo-authored-by: Bob\r\n <bob@example.com>\r\n";
    expect(signoffEmails(msg)).toEqual(["ada@example.com"]);
  });

  test("a trailer without an address is no sign-off", () => {
    expect(signoffEmails("Fix\n\nSigned-off-by: Ada Lovelace\n")).toEqual([]);
  });
});

describe("parseLog and the CLI", () => {
  test("parseLog reads NUL-separated records", () => {
    const raw = ["s1", "A", "a@x", "p1 p2", "Subject\n\nBody\n", "s2", "B", "b@x", "", "Root\n"].join("\0") + "\0";
    expect(parseLog(raw)).toEqual([
      { sha: "s1", authorName: "A", authorEmail: "a@x", parents: ["p1", "p2"], message: "Subject\n\nBody\n" },
      { sha: "s2", authorName: "B", authorEmail: "b@x", parents: [], message: "Root\n" },
    ]);
  });

  test("on a throwaway repository: a signed range passes, an unsigned commit fails with the fix, a bad ref is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-dco-"));
    try {
      const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" };
      const git = (...a: string[]) => {
        const p = Bun.spawnSync(["git", ...a], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
        if (p.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${p.stderr}`);
      };
      const dco = (...a: string[]) => {
        const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "scripts", "dco.ts"), ...a], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
        return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
      };
      git("init", "-q", "-b", "main");
      writeFileSync(join(dir, "f"), "0");
      git("add", "f");
      git("commit", "-q", "-m", "base");
      git("branch", "base");
      for (const [i, flag] of [[1, "-s"], [2, "-s"]] as const) {
        writeFileSync(join(dir, "f"), String(i));
        git("commit", "-q", flag, "-am", `signed ${i}`);
      }
      expect(dco("base", "HEAD")).toMatchObject({ code: 0 });
      writeFileSync(join(dir, "f"), "3");
      git("commit", "-q", "-am", "unsigned three");
      const bad = dco("base", "HEAD");
      expect(bad.code).toBe(1);
      expect(bad.out).toContain("unsigned three");
      expect(bad.out).not.toContain("signed 1");
      expect(bad.out).toContain("git rebase --signoff");
      expect(bad.out).toContain("git commit --amend -s");
      expect(dco("--output=x", "HEAD").code).toBe(2);
      expect(dco("nope", "HEAD").code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
