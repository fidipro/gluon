/**
 * Every git command Gluon runs on the user's repository, with the repository's own config kept
 * from running code: a hostile `.git/config` can name a `core.fsmonitor` command that
 * `ls-files` / `grep` would run. Command-line `-c` wins over any config file (includes too).
 * `--no-optional-locks`: `status` / `diff` never rewrite `.git/index`.
 * `git` (like `rg`) is spawned by the absolute path `binPath` finds on PATH, never looked up from the repository.
 */
import { devNull } from "node:os";
import { killTree } from "../detect.ts";
import { isSecretPath } from "./scan.ts";

export const SAFE_GIT_CONFIG = ["core.fsmonitor=false", `core.hooksPath=${devNull}`, "protocol.allow=never"];

/** `git <args>` with the overrides above. On the user's repo, spawn through `gitCmd` / `gitSync`: they add `gitEnv()`. */
export const gitArgv = (git: string, args: string[]) => [git, "--no-pager", "--no-optional-locks", ...SAFE_GIT_CONFIG.flatMap((c) => ["-c", c]), ...args];

/**
 * The environment of every git on the user's repo (BUG-139): in a partial clone, reading a missing
 * object fetches it from the promisor remote, whose `ext::` URL or `uploadpack` is a command, and
 * the repo's own `protocol.<name>.allow` beats `-c protocol.allow=never`. No lazy fetch, and an
 * empty protocol allow-list, which wins over any config.
 */
export const gitEnv = (): Record<string, string | undefined> => ({ ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" });

/** A git command on the user's repo, for an async spawn. */
export const gitCmd = (git: string, args: string[]) => ({ argv: gitArgv(git, args), env: gitEnv() });

/** How long a quick git query may take: a config `include.path` naming a FIFO never ends (BUG-138). */
export const GIT_QUERY_MS = 5_000;

export interface GitAnswer {
  /** null: it couldn't run, timed out or was stopped. */
  code: number | null;
  stdout: string;
  stderr: string;
}

const QUERY_OUTPUT = 4_000_000;

/**
 * A quick git query on the user's repo, bounded in time and output, without blocking the UI (a
 * hanging one would freeze it for `GIT_QUERY_MS`: BUG-138).
 */
export async function gitQuery(git: string, args: string[], cwd: string, signal?: AbortSignal): Promise<GitAnswer> {
  signal?.throwIfAborted();
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(gitArgv(git, args), { cwd, env: gitEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: GIT_QUERY_MS });
  } catch {
    return { code: null, stdout: "", stderr: "" };
  }
  const kill = () => killTree(proc);
  signal?.addEventListener("abort", kill);
  try {
    const text = async (s: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let out = "";
      for await (const chunk of s) {
        out += decoder.decode(chunk, { stream: true });
        if (out.length > QUERY_OUTPUT) {
          killTree(proc);
          break;
        }
      }
      return out;
    };
    const [stdout, stderr, code] = await Promise.all([text(proc.stdout), text(proc.stderr), proc.exited]);
    signal?.throwIfAborted();
    return { code: proc.signalCode || stdout.length > QUERY_OUTPUT ? null : code, stdout, stderr };
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}

/**
 * `gitQuery`, blocking: only for startup (`repoContext`), with a shorter limit, since nothing can be
 * drawn meanwhile.
 */
export function gitSync(git: string, args: string[], cwd: string, timeoutMs = 2_000): GitAnswer {
  try {
    const r = Bun.spawnSync(gitArgv(git, args), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe", timeout: timeoutMs, maxBuffer: QUERY_OUTPUT });
    return { code: r.exitedDueToTimeout || r.signalCode ? null : r.exitCode, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
  } catch {
    return { code: null, stdout: "", stderr: "" };
  }
}

/**
 * For `diff` / `show` (BUG-139): no `diff.external` or `diff.<driver>.command` (`--no-ext-diff`),
 * no `diff.<driver>.textconv` (`--no-textconv`), no submodule walk (it would run git in the
 * submodule with its own config), fixed prefixes (`diff.noprefix` etc. would hide paths from
 * `omitSecretDiffs`), no colour.
 */
export const SAFE_DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all", "--src-prefix=a/", "--dst-prefix=b/"];

/** For `log` / `show` (BUG-139): `log.showSignature` would run `gpg.program`. */
export const NO_SIGNATURES = ["-c", "log.showSignature=false"];

export const FILTERS_REFUSED = "this repository configures git filters Gluon can't switch off; use read_file";

/**
 * `-c` overrides that empty every filter driver the config names (BUG-139): `status` and a worktree
 * `diff` run `filter.<name>.clean` / `.process` on files the index doesn't know are unchanged, with
 * the driver named by `.gitattributes` or `.git/info/attributes`. `listing` is the output of
 * `git config --null --get-regexp ^filter\.` (reading config runs nothing; it follows includes).
 * An empty command is "no filter"; `required=false` keeps git from failing on it. A name `-c` can't
 * carry throws `FILTERS_REFUSED`: then the worktree tools refuse rather than run unprotected.
 */
export function neutralFilters(listing: string): string[] {
  const names = new Set<string>();
  for (const entry of listing.split("\0")) {
    if (!entry.trim()) continue;
    const key = entry.split("\n", 1)[0]!;
    const m = /^filter\.(.*)\.[^.]*$/s.exec(key);
    // `filter.<var>` with no driver name is not a driver; anything else odd is refused.
    if (!m) {
      if (/^filter\.[^.]*$/.test(key)) continue;
      throw new Error(FILTERS_REFUSED);
    }
    names.add(m[1]!);
  }
  if (names.size > 100 || [...names].some((n) => !n || /[=\x00-\x1f\x7f]/.test(n))) throw new Error(FILTERS_REFUSED);
  return [...names].flatMap((n) => ["clean", "smudge", "process"].flatMap((v) => ["-c", `filter.${n}.${v}=`]).concat("-c", `filter.${n}.required=false`));
}

/** A C-quoted git path (`"a/caf\303\251"`) → its text. */
function unquote(q: string): string {
  const bytes: number[] = [];
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const enc = new TextEncoder();
  for (let i = 1; i < q.length - 1; i++) {
    const c = q[i]!;
    if (c !== "\\") {
      bytes.push(...enc.encode(c));
      continue;
    }
    const n = q[++i] ?? "";
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(q.slice(i, i + 3), 8) & 0xff);
      i += 2;
    } else bytes.push(esc[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const path = (s: string) => (s.startsWith('"') && s.endsWith('"') && s.length > 1 ? unquote(s) : s);
const strip = (s: string) => s.replace(/^[ab]\//, "");

/** Every name a diff section header could mean; an unquoted `a/x b/y` with spaces is split every way. */
function headerNames(line: string): string[] {
  for (const p of ["diff --cc ", "diff --combined "]) if (line.startsWith(p)) return [path(line.slice(p.length))];
  const rest = line.slice("diff --git ".length);
  const out: string[] = [];
  const q = rest.startsWith('"') ? /^("(?:[^"\\]|\\.)*") (.*)$/s.exec(rest) : /^(.*) ("(?:[^"\\]|\\.)*")$/s.exec(rest);
  if (q) return [strip(path(q[1]!)), strip(path(q[2]!))];
  for (let i = rest.indexOf(" b/"); i >= 0; i = rest.indexOf(" b/", i + 1)) out.push(strip(rest.slice(0, i)), rest.slice(i + 3));
  return out;
}

/** The names a section's header lines (before the first hunk) give: `--- a/x`, `+++ b/y`, `rename from x`, … */
function bodyName(line: string): string | null {
  const m = /^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )(.*)$/s.exec(line);
  if (!m || m[1] === "/dev/null") return null;
  return line.startsWith("---") || line.startsWith("+++") ? strip(path(m[1]!)) : path(m[1]!);
}

/**
 * Replaces each file's section of a `diff` / `show` patch with a note when it is a secret file
 * (`isSecretPath`, the rule every repo tool uses) or its name can't be read. Lines before the first
 * section (the commit, the `--stat` summary) stay: names aren't secret, `list_files` shows them too.
 * Returns how many lines were dropped.
 */
export function omitSecretDiffs(lines: string[]): { lines: string[]; dropped: number } {
  const out: string[] = [];
  let dropped = 0;
  let i = 0;
  const isHeader = (l: string) => l.startsWith("diff --git ") || l.startsWith("diff --cc ") || l.startsWith("diff --combined ");
  while (i < lines.length) {
    if (!isHeader(lines[i]!)) {
      out.push(lines[i++]!);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !isHeader(lines[end]!)) end++;
    const section = lines.slice(i, end);
    const hunk = section.findIndex((l) => l.startsWith("@@"));
    const extended = section.slice(1, hunk < 0 ? undefined : hunk);
    // The header lines' names first: unambiguous, so the note names the real file.
    const names = [...extended.flatMap((l) => bodyName(l) ?? []), ...headerNames(section[0]!)];
    const secret = names.find((n) => isSecretPath(n));
    // A header line the reader cut (it carries a NUL, which git never prints in a patch) can't be trusted.
    if (secret !== undefined || names.length === 0 || [section[0]!, ...extended].some((l) => l.includes("\u0000"))) {
      // A long name keeps its end (the file's own name), so the note survives the line cut.
      const name = secret === undefined ? "a file with an unreadable name" : secret.length > 120 ? `…${secret.slice(-119)}` : secret;
      out.push(`(diff of ${name} omitted: it may hold secrets)`);
      dropped += section.length - 1;
    } else out.push(...section);
    i = end;
  }
  return { lines: out, dropped };
}
