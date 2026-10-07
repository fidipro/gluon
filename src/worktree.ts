/**
 * Where a session's git worktree goes, the same for every agent (issue 52). Gluon only decides
 * the path and the branch and tells the agent in the spec (`withWorktree`); the agent creates the
 * worktree, works in it and, once the work is merged and the developer agrees, removes it. Gluon
 * runs read-only git queries here and creates and deletes nothing. Gluon decides, not the harness
 * or the model, so the place is the same for all six agents.
 *
 * The path is under the main checkout, hence on the same file system, drive and OS flavour as the
 * repository (WSL under `/mnt/c` included). A worktree made by WSL's git isn't usable by Windows git
 * or an IDE, and the reverse: git records absolute paths. `git worktree repair` fixes the links
 * after a move. With no plan (not a work tree, bare, submodule, git missing) the session starts in
 * place with a note.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, win32 } from "node:path";
import { gitQuery } from "./agent/git.ts";
import { slugName } from "./agent/choices.ts";
import { binPath, longPath } from "./detect.ts";

/** Under the main checkout, so it is inside the agent's working directory (sandboxes guard what is outside). */
export const WORKTREES_DIR = [".gluon", "worktrees"] as const;
/** Branch names are `<prefix><slug>`; a branch named `gluon` blocks every `gluon/…` ref, so then `gluon-2/` is used, and so on (BUG-641). */
export const BRANCH_PREFIX = "gluon/";
export const branchPrefix = (n: number): string => (n === 1 ? BRANCH_PREFIX : `gluon-${n}/`);
/** Saved records accept `gluon-2/` … `gluon-999/` (`src/workspaces.ts`): no prefix beyond it is planned. */
export const MAX_PREFIX = 999;

/** The first prefix no branch blocks (a branch named `gluon`, `gluon-2` …), or null past `MAX_PREFIX`. */
export function freeBranchPrefix(takenBranches: Iterable<string>): string | null {
  const branches = new Set([...takenBranches].map((b) => b.toLowerCase()));
  for (let n = 1; n <= MAX_PREFIX; n++) if (!branches.has(branchPrefix(n).slice(0, -1))) return branchPrefix(n);
  return null;
}
const DIR_PREFIX = "gluon-";

export interface WorktreePlan {
  /** Absolute path of the worktree to create. */
  path: string;
  /** The new branch. */
  branch: string;
  /** The directory the agent was started in, relative to the checkout's top ("" at the top). */
  start: string;
  /** The worktree is one this session already made, on an earlier run: the agent goes on in it and creates nothing (QA-resume-13). */
  existing?: boolean;
}

/**
 * The first free directory (`gluon-<slug>`, then `-2`, `-3` …) and branch (`gluon/<slug>`) for a
 * session called `name`: neither may be taken, compared without case (macOS and Windows file
 * systems ignore it). `takenBranches` is every local branch: one named like the prefix (`gluon`)
 * or below the new name (`gluon/x/y` under `gluon/x`) makes the ref impossible (BUG-641).
 */
export function worktreeNames(name: string, takenDirs: Iterable<string>, takenBranches: Iterable<string>): { dir: string; branch: string } {
  const dirs = new Set([...takenDirs].map((d) => d.toLowerCase()));
  const branches = new Set([...takenBranches].map((b) => b.toLowerCase()));
  const prefix = freeBranchPrefix(branches);
  if (prefix === null) throw new RangeError("no free branch prefix");
  const below = [...branches];
  const slug = slugName(name) ?? "session";
  const first = slug.startsWith(DIR_PREFIX) ? slug : DIR_PREFIX + slug;
  for (let i = 1; ; i++) {
    const dir = i === 1 ? first : `${first}-${i}`;
    const branch = prefix + dir.slice(DIR_PREFIX.length);
    if (!dirs.has(dir) && !branches.has(branch) && !below.some((b) => b.startsWith(`${branch}/`))) return { dir, branch };
  }
}

/** A path the agent will put between double quotes in a shell command: nothing there may be acted on. */
const shellUnsafe = /["`$\n\r]/;

/** The text of the spec's worktree block: what the agent does, and the cleanup rule (it suggests, the developer decides). */
export function worktreeBrief(plan: WorktreePlan, platform: NodeJS.Platform = process.platform): string {
  // git takes forward slashes on Windows too, and a backslash in a Git Bash command is an escape.
  const path = platform === "win32" ? plan.path.replaceAll("\\", "/") : plan.path;
  const there = plan.start ? ` The directory you were started in is \`${plan.start.replaceAll("\\", "/")}\` there.` : "";
  if (plan.existing) {
    return `## Where to work

Gluon runs several sessions on this repository at once, so this session works in its own git worktree. Never edit the checkout you were started in.

- Worktree: \`${path}\` (made by an earlier run of this session; it may hold uncommitted work)
- Branch: \`${plan.branch}\`

1. Don't create it: it is already there. Look at what it holds (\`git status\`, \`git log\`) before you start, and carry on from it.
2. Do all the work there: every command runs with the worktree as its working directory, and every file you read or edit is a path under it. If it isn't a usable worktree any more, say so and ask the developer; don't work in the original checkout on your own.
3. When the work is merged (the pull request, or the branch into its base), tell the developer and suggest removing the worktree and its branch. Do nothing until the developer agrees: never remove it on your own, and never remove any other worktree. When they agree, from outside the worktree run \`git worktree remove "${path}"\` (without \`--force\`) and \`git branch -d ${plan.branch}\`. A squash merge leaves the branch looking unmerged: check that it was merged, and ask once more before \`git branch -D\`.`;
  }
  return `## Where to work

Gluon runs several sessions on this repository at once, so this session works in its own git worktree. Never edit the checkout you were started in.

- Worktree: \`${path}\`
- Branch: \`${plan.branch}\` (new), from the current HEAD

1. First create it. Unless it is already there, add \`.gluon/\` to the checkout's local exclude file (\`git rev-parse --git-path info/exclude\`; it is never committed), then run \`git worktree add -b ${plan.branch} "${path}" HEAD\`.
2. Do all the work there: every command runs with the worktree as its working directory, and every file you read or edit is a path under it.${there} It holds only tracked files: set up what the work needs, and ask the developer before copying a secret such as \`.env\` into it.
3. If you can't create it (a sandbox or permission refusal, the path or branch already exists), say so and ask the developer. Don't work in the original checkout on your own.
4. When the work is merged (the pull request, or the branch into its base), tell the developer and suggest removing the worktree and its branch. Do nothing until the developer agrees: never remove it on your own, and never remove any other worktree. When they agree, from outside the worktree run \`git worktree remove "${path}"\` (without \`--force\`) and \`git branch -d ${plan.branch}\`. A squash merge leaves the branch looking unmerged: check that it was merged, and ask once more before \`git branch -D\`.`;
}

/** The spec with the worktree block after it (the goal comes first). */
export const withWorktree = (spec: string, plan: WorktreePlan, platform?: NodeJS.Platform): string => `${spec.trim()}\n\n${worktreeBrief(plan, platform)}`;

/** The names under `dir`, or none when it isn't there. */
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The plan for session `name` started in `cwd`, or why there is no worktree (a message for the
 * developer). Works from a linked worktree too: the new one goes under the main checkout, never
 * nested in another. Read-only git queries through `gitQuery` (the repository is untrusted).
 */
export async function planWorktree(name: string, cwd: string, { git = binPath("git"), signal }: { git?: string | null; signal?: AbortSignal } = {}): Promise<WorktreePlan | string> {
  if (!git) return "git isn't installed";
  const q = (args: string[]) => gitQuery(git, args, cwd, signal);
  const dirs = await q(["rev-parse", "--git-common-dir", "--show-toplevel"]);
  const [common, top] = dirs.stdout.split("\n").map((l) => l.trim());
  if (dirs.code !== 0 || !common || !top) return "this isn't a git repository with a work tree";
  const gitDir = resolve(cwd, common);
  // A bare repository, or a submodule (its git directory sits under the superproject's `.git/modules`).
  if (basename(gitDir) !== ".git") return "this repository's git directory isn't a .git inside a checkout (a bare repository or a submodule)";
  const main = dirname(gitDir);
  const root = join(main, ...WORKTREES_DIR);
  if (shellUnsafe.test(root)) return "the repository's path has a character a shell would act on";
  const rel = relative(longPath(resolve(top)), longPath(resolve(cwd)));
  const start = rel.startsWith("..") ? "" : rel;
  // A repository with no commit has no HEAD for `git worktree add … HEAD` to start from (BUG-640).
  const head = await q(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.code !== 0) return "this repository has no commit yet, so a worktree has nothing to start from";
  // `lstrip=2`, not `short`: a tag of the same name makes `short` print `heads/gluon`.
  const branches = await q(["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"]);
  const listed = await q(["worktree", "list", "--porcelain"]);
  const registered = listed.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => basename(l.slice(9).trim()));
  const taken = branches.stdout.split("\n").map((b) => b.trim()).filter(Boolean);
  if (freeBranchPrefix(taken) === null) return `branches named gluon, gluon-2 … gluon-${MAX_PREFIX} all exist, so no session branch can be created`;
  const { dir, branch } = worktreeNames(name, [...listDir(root), ...registered], taken);
  return { path: join(root, dir), branch, start };
}

/**
 * Two paths as the OS compares them: the same spelling, or the same place once links are followed (a checkout opened through a
 * symlinked directory: git lists the real path, Gluon planned the one it was started in) and, on Windows, in long form; case counts
 * for nothing on Windows. A path that doesn't exist is compared as written.
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform, real: (p: string) => string = realpathSync): boolean {
  const P = platform === "win32" ? win32 : posix;
  const norm = (p: string) => (platform === "win32" ? P.resolve(p).toLowerCase() : P.resolve(p));
  const canon = (p: string) => {
    let r = P.resolve(p);
    try {
      r = real(r);
    } catch {}
    return norm(longPath(r));
  };
  return norm(a) === norm(b) || canon(a) === canon(b);
}

/**
 * Whether the worktree a saved record names is still the one Gluon planned for this checkout, and may be gone on in (QA-resume-13). A
 * record is a file the user, or anyone who wrote one, can edit: its path is used only when this checkout's own
 * `worktree list` lists exactly that path on exactly that branch, the path is `<main checkout>/.gluon/worktrees/<name>` and no
 * character in it is one a shell would act on (the spec shows it in commands the agent runs). Anything else is planned anew.
 */
export async function reusableWorktree(saved: { path: string; branch: string }, cwd: string, { git = binPath("git"), signal }: { git?: string | null; signal?: AbortSignal } = {}): Promise<boolean> {
  if (!git || shellUnsafe.test(saved.path) || !/^[\w./-]+$/.test(saved.branch)) return false;
  const q = (args: string[]) => gitQuery(git, args, cwd, signal);
  const dirs = await q(["rev-parse", "--git-common-dir", "--show-toplevel"]);
  const [common, top] = dirs.stdout.split("\n").map((l) => l.trim());
  if (dirs.code !== 0 || !common || !top) return false;
  const gitDir = resolve(cwd, common);
  if (basename(gitDir) !== ".git") return false;
  if (!samePath(saved.path, join(dirname(gitDir), ...WORKTREES_DIR, basename(saved.path)))) return false;
  // The directory itself is no link: a listed worktree replaced by a symlink to elsewhere is not the worktree.
  try {
    const leaf = lstatSync(saved.path);
    if (leaf.isSymbolicLink() || !leaf.isDirectory()) return false;
  } catch {
    return false;
  }
  const listed = await q(["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return false;
  return listed.stdout.split(/\r?\n\r?\n/).some((block) => {
    const lines = block.split(/\r?\n/);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9).trim();
    const branch = lines.find((l) => l.startsWith("branch refs/heads/"))?.slice(18).trim();
    return path !== undefined && branch === saved.branch && samePath(path, saved.path);
  });
}
