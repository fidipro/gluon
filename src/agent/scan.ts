/**
 * The repo tools' pieces that need no external program: the secret-file rule, a bounded file walk
 * (`find`), and a line scanner (`grep -rnIE`), which runs in `grep-worker.ts`.
 */
import { lstat, readdir } from "node:fs/promises";
import { join, sep } from "node:path";

export interface RunResult {
  lines: string[];
  total: number;
  code: number;
  stderr: string;
  /** Reading stopped: the output was too large. */
  cut?: boolean;
}

/**
 * Files the brain may not read or search: whatever is read goes to the brain's provider. By name:
 * `.env*`, private keys and key stores, the credential stores of npm, netrc, pgpass, git, pip and
 * Docker, Terraform state and variables, cloud service-account and OAuth client files, `kubeconfig`
 * and `secrets.*`. By directory and name: `SECRET_PATH`.
 */
export const SECRET = new RegExp(
  `^(${[
    String.raw`\.env(?!\.(example|sample|template)$).*`,
    String.raw`.*\.(pem|key|p12|pfx|keystore|ppk|p8|jks|kdbx|tfvars|tfvars\.json)`,
    String.raw`.*\.tfstate(\.\d+)?(\.backup)?`,
    String.raw`id_(rsa|dsa|ecdsa|ed25519)(_sk)?`,
    String.raw`[._]netrc`,
    String.raw`\.(npmrc|pgpass|git-credentials|pypirc|dockercfg)`,
    String.raw`credentials(\.json)?`,
    String.raw`service[-_]?account.*\.json`,
    String.raw`client_secret.*\.json`,
    "kubeconfig",
    String.raw`secrets\.(ya?ml|json)`,
  ].join("|")})$`,
  "i",
);
/**
 * Files that are secret by the directory they lie in (any depth), by that directory's lower-case
 * name: `.git/config` (and a submodule's under `.git/modules/`) holds remote URLs with tokens (BUG-574;
 * a path rule, as userinfo is not the only place: `http.extraheader`), `.docker/config.json` and
 * `.kube/config` hold auth.
 */
const SECRET_PATH = new Map<string, RegExp>([
  [".git", /^config(\.worktree)?$/i],
  [".docker", /^config\.json$/i],
  [".kube", /^config$/i],
]);
/** A directory whose files are all secret: `.env.d/`, `.ENV/`. */
const SECRET_DIR = /^\.env/i;

/**
 * The spellings of one path segment that name the same file on a filesystem: as written, and with
 * an NTFS stream suffix (`:name`, `::$DATA`, `:name:$DATA`) and trailing dots and spaces removed
 * (Windows ignores both; BUG-578). Tested on every platform: a checkout can be read anywhere.
 */
function spellings(seg: string): string[] {
  const trim = (s: string) => s.replace(/[. ]+$/, "");
  return [...new Set([seg, trim(seg), trim(seg.replace(/:.*$/, ""))])].filter((s) => s && s !== "." && s !== "..");
}

/** Whether a path (relative, either separator) is a secret file or lies in a `.env*` directory. */
export function isSecretPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const names = spellings(parts.pop() ?? "");
  const dirs = parts.flatMap(spellings);
  return names.some((n) => SECRET.test(n) || dirs.some((d) => SECRET_PATH.get(d.toLowerCase())?.test(n))) || dirs.some((d) => SECRET_DIR.test(d));
}

/**
 * Removes results whose path is a secret (whatever the search tool excluded itself), and returns the
 * rest as `path:line:text`. `nul`: the lines are `path\0line:text` (rg `--null`) or
 * `path\0line\0text` (git grep `-z`), the path verbatim — git grep would otherwise C-quote a
 * non-ASCII, tab or quote name, and a `:` in a name misleads the `path:line:` split (BUG-93). Then
 * a line without its NUL (cut, or not a match) is dropped too.
 */
export function dropSecretMatches(r: RunResult, nul = false): void {
  const kept = r.lines.flatMap((l) => {
    if (nul) {
      const i = l.indexOf("\0");
      if (i < 0) return [];
      const path = l.slice(0, i);
      // git grep: `line\0text`; rg: `line:text`. A NUL in the text itself is not a separator.
      return isSecretPath(path) ? [] : [`${path}:${l.slice(i + 1).replace(/^(\d+)\0/, "$1:")}`];
    }
    const path = l.match(/^(.*?):\d+:/)?.[1];
    return !path || !isSecretPath(path) ? [l] : [];
  });
  r.total -= r.lines.length - kept.length;
  r.lines = kept;
}

// `.gluon`: an older Gluon put sessions' git worktrees there, whole copies of the repository; a checkout may still have one.
const SKIP_DIRS = new Set([".git", "node_modules", ".gluon"]);

/** The files under `rel` (a file or directory, relative to `root`), "/"-separated, sorted; no symlinks, .git, node_modules, .gluon or `.env*` directories below it. */
export async function* files(root: string, rel: string, signal?: AbortSignal): AsyncGenerator<string> {
  const start = rel.split(sep).join("/");
  const info = await lstat(join(root, rel)).catch(() => null);
  if (info?.isFile()) {
    yield start;
    return;
  }
  if (!info?.isDirectory()) return;
  const walk = async function* (dir: string): AsyncGenerator<string> {
    signal?.throwIfAborted();
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = dir === "." ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !SECRET_DIR.test(e.name)) yield* walk(path);
      else if (e.isFile()) yield path;
    }
  };
  yield* walk(start);
}

/** `find <rel> -type f` without .git, node_modules and .gluon, in JS: bounded like `run`. */
export async function listFallback(root: string, rel: string, max: number, signal?: AbortSignal): Promise<RunResult> {
  const lines: string[] = [];
  let total = 0;
  for await (const f of files(root, rel, signal)) {
    if (lines.length < max) lines.push(f);
    if (++total > max * 100) break;
  }
  return { lines, total, code: 0, stderr: "" };
}

const POSIX_CLASSES: Record<string, string> = { alpha: "a-zA-Z", digit: "0-9", alnum: "a-zA-Z0-9", upper: "A-Z", lower: "a-z", space: "\\s", blank: " \\t", punct: "!-\\/:-@\\[-`{-~", xdigit: "0-9A-Fa-f" };

/** A POSIX extended regex as a JS one: bracket classes ([:alpha:]) and GNU word edges (\< \>). */
export function ereToRegExp(pattern: string): RegExp {
  const js = pattern.replace(/\[:(\w+):\]/g, (m, c: string) => POSIX_CLASSES[c] ?? m).replace(/\\[<>]/g, "\\b");
  return new RegExp(js);
}

/** Files larger than this aren't searched (as read_file won't read them). */
export const MAX_SCAN_BYTES = 2_000_000;

/** The scan behind `grepFallback`: skips secret files, binaries (a NUL in the first 32 KB) and files over MAX_SCAN_BYTES. */
export async function scan(root: string, rel: string, pattern: string, max: number): Promise<RunResult> {
  let re: RegExp;
  try {
    re = ereToRegExp(pattern);
  } catch (e) {
    return { lines: [], total: 0, code: 2, stderr: (e as Error).message };
  }
  const lines: string[] = [];
  let total = 0;
  for await (const f of files(root, rel)) {
    if (isSecretPath(f)) continue;
    const file = Bun.file(join(root, f));
    if (file.size > MAX_SCAN_BYTES) continue;
    const bytes = await file.bytes().catch(() => null);
    if (!bytes || bytes.subarray(0, 32_768).includes(0)) continue;
    const text = new TextDecoder().decode(bytes).split("\n");
    if (text.at(-1) === "") text.pop();
    for (let i = 0; i < text.length; i++) {
      if (!re.test(text[i]!)) continue;
      if (lines.length < max) lines.push(`${f}:${i + 1}:${text[i]}`);
      if (++total > max * 100) return { lines, total, code: 0, stderr: "" };
    }
  }
  return { lines, total, code: total ? 0 : 1, stderr: "" };
}
