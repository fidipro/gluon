import { assertShimArgs, binPath, killTree, neutralCwd } from "../detect.ts";
import { maskSecrets } from "../secrets.ts";
import { gitQuery } from "./git.ts";

/**
 * `forge`: the brain reads issues and pull / merge requests of GitHub and GitLab through the
 * official `gh` / `glab`, with a fixed read-only argv (view and list only, never `api`, never a
 * write). Hosts are github.com and gitlab.com only: `glab` sends `GITLAB_TOKEN` to whatever host
 * `-R` names, and a hostile repo's `origin` could name one.
 */
export const FORGE_ACTIONS = ["issue_view", "issue_list", "pr_view", "pr_list"] as const;
type Action = (typeof FORGE_ACTIONS)[number];
type Host = "github.com" | "gitlab.com";

const FORGE_MS = 20_000;
const FORGE_MAX_CHARS = 30_000;
const FORGE_MAX_READ = 2_000_000;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const STATES = ["open", "closed", "all"];

const CLI: Record<Host, { bin: string; install: string }> = {
  "github.com": { bin: "gh", install: "https://cli.github.com" },
  "gitlab.com": { bin: "glab", install: "https://gitlab.com/gitlab-org/cli" },
};

export interface ForgeRepo {
  host: Host;
  /** `owner/repo`, or `group/subgroup/repo` on GitLab. */
  path: string;
}

/** A repo from a remote URL (https, ssh://, scp-like) or `host/path`; null when it isn't a supported one. */
export function parseForgeRepo(text: string): ForgeRepo | null {
  const s = text.trim();
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/i.exec(s);
  if (!m) return null;
  const host = m[1]!.toLowerCase().replace(/^www\./, "");
  if (host !== "github.com" && host !== "gitlab.com") return null;
  const parts = m[2]!.split("/");
  if (parts.length < 2 || (host === "github.com" && parts.length !== 2) || parts.some((p) => !SEGMENT.test(p) || p === ".." || p.endsWith(".lock"))) return null;
  return { host, path: parts.join("/") };
}

async function resolveRepo(root: string, input: unknown, signal?: AbortSignal): Promise<ForgeRepo> {
  const origin = async (): Promise<ForgeRepo | null> => {
    const git = binPath("git");
    if (!git) return null;
    const r = await gitQuery(git, ["remote", "get-url", "origin"], root, signal);
    return r.code === 0 ? parseForgeRepo(r.stdout) : null;
  };
  if (typeof input === "string" && input.trim()) {
    const given = input.trim();
    const full = parseForgeRepo(given);
    if (full) return full;
    // `owner/repo` without a host: the origin's host.
    if (/^[^/:\s@]+(\/[^/:\s@]+)+$/.test(given) && !/^(github|gitlab)\.com\//i.test(given)) {
      const host = (await origin())?.host ?? "github.com";
      const parsed = parseForgeRepo(`${host}/${given}`);
      if (parsed) return parsed;
    }
    throw new Error(`repo ${JSON.stringify(given.slice(0, 80))} is not a github.com or gitlab.com repository: use owner/repo or a URL`);
  }
  const found = await origin();
  if (!found) throw new Error("the origin remote is not on github.com or gitlab.com (or there is none); pass repo");
  return found;
}

/**
 * `gh issue|pr view` without `--json` asks GraphQL for `projectCards`, which GitHub has sunset:
 * every view fails on a gh before 2.5x (issues 63, 64). Naming the fields skips it; `list` is unaffected.
 */
const GH_VIEW_FIELDS = {
  issue: "number,title,state,author,labels,assignees,createdAt,url,body,comments",
  pr: "number,title,state,isDraft,author,labels,assignees,baseRefName,headRefName,createdAt,url,body,comments,reviews",
};

/** The fixed argv for `action`: every flag here is a read. */
export function forgeArgv(bin: string, host: Host, action: Action, repo: string, input: { number?: number; state?: string; count: number }): string[] {
  const [noun, verb] = action.split("_") as ["issue" | "pr", "view" | "list"];
  const gh = host === "github.com";
  const group = noun === "issue" ? "issue" : gh ? "pr" : "mr";
  if (verb === "view") return [bin, group, "view", String(input.number), "-R", repo, ...(gh ? ["--json", GH_VIEW_FIELDS[noun]] : ["--comments"])];
  const state = input.state ?? "open";
  return gh
    ? [bin, group, "list", "-R", repo, "--state", state, "--limit", String(input.count)]
    : [bin, group, "list", "-R", repo, ...(state === "closed" ? ["--closed"] : state === "all" ? ["--all"] : []), "--per-page", String(input.count)];
}

/** A `GITLAB_HOST`-style value (a host or a URL) that names a host other than gitlab.com. */
const namesOtherGitlab = (v: string | undefined): boolean => {
  const host = (v ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:?#].*$/, "").replace(/^www\./, "");
  return host !== "" && host !== "gitlab.com";
};

export async function runForge(root: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const action = input.action as Action;
  if (!FORGE_ACTIONS.includes(action)) throw new Error(`action must be one of ${FORGE_ACTIONS.join(", ")}`);
  const number = input.number;
  if (action.endsWith("_view") && !(typeof number === "number" && Number.isInteger(number) && number > 0 && number < 1e9)) throw new Error("number must be a positive integer");
  const state = input.state === undefined || input.state === "" ? undefined : String(input.state);
  if (state !== undefined && !STATES.includes(state)) throw new Error(`state must be one of ${STATES.join(", ")}`);
  const count = typeof input.count === "number" && Number.isFinite(input.count) ? Math.min(50, Math.max(1, Math.floor(input.count))) : 20;

  const repo = await resolveRepo(root, input.repo, signal);
  const cli = CLI[repo.host];
  const bin = binPath(cli.bin);
  if (!bin) throw new Error(`${cli.bin} is not installed (${cli.install}); the developer can install it and sign in`);
  const argv = forgeArgv(bin, repo.host, action, repo.path, { number: number as number | undefined, state, count });
  assertShimArgs(argv);

  signal?.throwIfAborted();
  // `-R owner/repo` goes to GH_HOST / GITLAB_HOST when the user's environment holds one (a company instance; glab's aliases and API host too): the origin named github.com or gitlab.com, so the CLI is told that (BUG-592). The user's variables stay in the process.
  const hostEnv = repo.host === "github.com" ? { GH_HOST: "github.com" } : { GITLAB_HOST: "gitlab.com", GL_HOST: "gitlab.com", GITLAB_URI: "gitlab.com", GITLAB_API_HOST: "gitlab.com" };
  // A token in the environment belongs to the host it names: when that is not gitlab.com, glab must not send it there.
  const other = repo.host === "gitlab.com" && ["GITLAB_HOST", "GL_HOST", "GITLAB_URI"].some((k) => namesOtherGitlab(process.env[k]));
  const env: Record<string, string | undefined> = { ...process.env, ...hostEnv, NO_COLOR: "1", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1", GLAB_CHECK_UPDATE: "false", GLAB_SEND_TELEMETRY: "false", GIT_TERMINAL_PROMPT: "0", PAGER: "cat", GH_PAGER: "cat", GLAB_PAGER: "cat" };
  if (other) for (const k of ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "GITLAB_API_PROTOCOL"]) delete env[k];
  // POSIX: the CLI leads its own process group, so Esc, the timeout and a runaway output end it and everything it started (a wrapper's child holds the pipes open: QA-brain-11, BUG-654). Windows: `killTree`.
  const group = process.platform !== "win32";
  const proc = Bun.spawn(argv, { cwd: neutralCwd(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: group });
  let done = false;
  const kill = () => {
    if (done) return;
    // The group is ours (its leader is `proc`) and exists while any member runs, so its id is not reused; once our reads have ended (`done`) it is never signalled.
    if (group && proc.pid) {
      try {
        process.kill(-proc.pid, "SIGKILL");
        return;
      } catch {}
    }
    killTree(proc);
  };
  let stop!: (e: Error) => void;
  const stopped = new Promise<never>((_, reject) => (stop = reject));
  stopped.catch(() => {});
  const onAbort = () => {
    kill();
    stop(signal?.reason instanceof Error ? signal.reason : new Error(`${cli.bin} was stopped`));
  };
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => {
    kill();
    stop(new Error(`${cli.bin} timed out or was stopped`));
  }, FORGE_MS);
  try {
    const read = async (s: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let out = "";
      for await (const chunk of s) {
        out += decoder.decode(chunk, { stream: true });
        if (out.length > FORGE_MAX_READ) {
          kill();
          break;
        }
      }
      return out;
    };
    const [stdout, stderr, code] = await Promise.race([Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]), stopped]);
    signal?.throwIfAborted();
    if (proc.signalCode && !stdout) throw new Error(`${cli.bin} timed out or was stopped`);
    if (code !== 0) {
      const why = stderr.trim().split("\n").slice(0, 3).join(" ").slice(0, 300) || `exit ${code}`;
      throw new Error(maskSecrets(`${cli.bin} failed: ${why}${/auth|login|401|403|404/i.test(why) ? " (the developer may need to sign in: `" + cli.bin + " auth login`)" : ""}`));
    }
    const text = maskSecrets(stdout.replaceAll("\0", "␀").trim());
    if (!text) return "(nothing found)";
    return text.length > FORGE_MAX_CHARS ? `${text.slice(0, FORGE_MAX_CHARS)}\n… cut at ${FORGE_MAX_CHARS} characters` : text;
  } finally {
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
