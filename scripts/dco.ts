#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun scripts/dco.ts <base> <head>`: the Developer Certificate of Origin check (ci.yml's `dco` job, for pull
 * requests from outside contributors). Every non-merge commit in `<base>..<head>` needs a
 * `Signed-off-by: Name <email>` trailer whose email is the commit author's (case-insensitive). Prints each
 * failing commit with how to fix it and exits 1. Commit text is untrusted: it is only parsed and printed (control
 * characters stripped, never at the start of a log line), never run or interpolated into a shell.
 */

export type Commit = { sha: string; authorName: string; authorEmail: string; message: string; parents: string[] };
export type Failure = { sha: string; subject: string; reason: string };

const SIGNOFF = /^signed-off-by:[ \t]*(.+?)[ \t]*<([^<>\s]+)>[ \t]*$/i;
/** A line git's trailer parser accepts in a trailer block: `Token: value`, a folded continuation, or a cherry-pick note. */
const TRAILER_LINE = /^(?:[A-Za-z][A-Za-z0-9-]*[ \t]*:.*|[ \t]+\S.*|\(cherry picked from commit [0-9a-f]+\))$/;

/**
 * The `Signed-off-by` emails of a commit message. Trailer semantics (like `git interpret-trailers --parse`, but
 * stricter): only the message's last paragraph counts, it must not be the subject paragraph, and every line of it
 * must be trailer-shaped. A sign-off quoted mid-paragraph, in an earlier paragraph or after prose is not a sign-off.
 */
export function signoffEmails(message: string): string[] {
  const paragraphs = message.replace(/\r\n?/g, "\n").trim().split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return [];
  const lines = paragraphs[paragraphs.length - 1]!.split("\n");
  if (!lines.every((l) => TRAILER_LINE.test(l))) return [];
  return lines.flatMap((l) => SIGNOFF.exec(l)?.[2]?.toLowerCase() ?? []);
}

const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim();

/** The commits that fail the check; merge commits (two or more parents) are skipped. */
export function dcoFailures(commits: Commit[]): Failure[] {
  const out: Failure[] = [];
  for (const c of commits) {
    if (c.parents.length >= 2) continue;
    const subject = oneLine(c.message.split("\n")[0] ?? "");
    const emails = signoffEmails(c.message);
    if (emails.length === 0) out.push({ sha: c.sha, subject, reason: "no Signed-off-by trailer" });
    else if (!emails.includes(c.authorEmail.trim().toLowerCase())) out.push({ sha: c.sha, subject, reason: `Signed-off-by email is not the author's (${oneLine(c.authorEmail)})` });
  }
  return out;
}

/** `git log -z` records: sha, author name, author email, parents, message (NUL cannot occur in a commit). */
export function parseLog(raw: string): Commit[] {
  const f = raw.split("\0");
  if (f[f.length - 1] === "") f.pop();
  const commits: Commit[] = [];
  for (let i = 0; i + 4 < f.length; i += 5)
    commits.push({ sha: f[i]!.trim(), authorName: f[i + 1]!, authorEmail: f[i + 2]!, parents: f[i + 3]!.split(" ").filter(Boolean), message: f[i + 4]! });
  return commits;
}

const FORMAT = "%H%x00%an%x00%ae%x00%P%x00%B";

function main(argv: string[]): number {
  const [base, head] = argv;
  if (!base || !head || base.startsWith("-") || head.startsWith("-")) {
    console.error("usage: bun scripts/dco.ts <base> <head>");
    return 2;
  }
  const p = Bun.spawnSync(["git", "--no-pager", "log", "-z", `--format=${FORMAT}`, `${base}..${head}`, "--"], { env: process.env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    console.error(`git log ${oneLine(base)}..${oneLine(head)} failed: ${oneLine(p.stderr.toString())}`);
    return 2;
  }
  const commits = parseLog(p.stdout.toString());
  const failures = dcoFailures(commits);
  if (failures.length === 0) {
    console.log(`DCO: ${commits.length} commit(s) checked, all signed off.`);
    return 0;
  }
  console.log(`DCO: ${failures.length} commit(s) lack a matching sign-off:\n`);
  for (const f of failures) console.log(`  ${f.sha.slice(0, 8)}  ${f.subject}\n    ${f.reason}`);
  console.log(`
Every commit needs a "Signed-off-by: Your Name <email>" line with the email you commit with
(it certifies https://developercertificate.org). To fix:
  - all commits of the branch:  git rebase --signoff <base branch>   (for example origin/main), then git push --force-with-lease
  - the last commit only:       git commit --amend -s --no-edit        then git push --force-with-lease
  - from now on:                git commit -s`);
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
