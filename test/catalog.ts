/**
 * The catalog: what Gluon promises, one entry per behaviour, invariant and perf limit, each tested at least once
 * (docs/contributing/testing.md). A test names its entry at the start of its title, and a bug it guards as a tag:
 *   test("keys/never-in-process-env: keys from Gluon's .env stay out of process.env #BUG-82", …)
 * `test/catalog.test.ts` checks that every entry has a test and every test names a known entry (the files that don't yet
 * are in `test/catalog.baseline.json`, which only shrinks). Entries are written from what a user is promised (the guides,
 * `AGENTS.md`'s invariants), not from the code. Adding, changing or removing one is a maintainer's decision
 * (`tests-reviewed`, `scripts/test-guard.ts`).
 */

/**
 * Where an entry's tests run: `e2e` (`test/e2e/`, Gluon in a terminal with the fakes), `real` (`test/real/`, the real
 * harness on a loopback model API), `perf` (`test/perf/`), `seam` (`test/*.test.ts`, through a seam in `test/seams.ts`) and
 * `code` (`test/*.test.ts`, a check that reads the source: a rule no run could show).
 */
export type Layer = "e2e" | "real" | "perf" | "seam" | "code";
export type Kind = "behaviour" | "invariant" | "perf";
export type Entry = {
  kind: Kind;
  /** Given …, when …, then …: what holds, as a user (or a reviewer of a rule) would check it. */
  says: string;
  at: Layer[];
  /** Where it differs by platform: the platforms whose CI job checks it (the rest don't run it). */
  platforms?: ("linux" | "macos" | "windows")[];
};
export type Feature = { says: string; entries: Record<string, Entry> };

const rule = (says: string, at: Layer[] = ["code", "seam"]): Entry => ({ kind: "invariant", says, at });
const perf = (says: string, at: Layer[] = ["perf"], platforms?: Entry["platforms"]): Entry => ({ kind: "perf", says, at, ...(platforms ? { platforms } : {}) });

export const CATALOG: Record<string, Feature> = {
  subscriptions: {
    says: "a user's own plan stays theirs: official binaries only, nothing of another tool's read or forwarded (AGENTS.md, src/AGENTS.md)",
    entries: {
      "official-binaries-only": rule("given a plan, when Gluon checks or starts a login, then it runs only the vendor's own binary and command"),
      "plan-brain-official-only": rule("given a plan brain, when it runs, then it is the user's own claude (Agent SDK) or codex app-server, with no HTTP client of Gluon's"),
      "never-read-credentials": rule("given another tool's token files, config directory or keychain, then no source reads them; a harness's config is read for its named keys alone"),
      "never-edit-other-tools-files": rule("when Gluon needs another tool's setting, then it tells the user; it writes only its own hook (permanent.ts, inert without GLUON_EVENTS) and agy's statusLine (agy-settings.ts)"),
      "no-token-forwarding": rule("when a launch's environment is built, then it carries no login token (assertSafeEnv refuses one)"),
      "base-url-allowlist": rule("given any harness and connection, then a base URL is set only for OpenRouter, Codex on an OpenAI key, or the tests' loopback seam"),
      "no-impersonation": rule("when Gluon sends a prompt to claude or codex app-server, then it is Gluon's own prompt, with no harness's identity"),
      "user-env-as-is": rule("given the user's own key in the environment, when Gluon launches, then it is used as it is, never stripped"),
    },
  },
  repo: {
    says: "the user's repository is untrusted: nothing in it runs inside Gluon (src/AGENTS.md)",
    entries: {
      "spawn-via-binpath": rule("given a binary planted in the repository or a bare name, when Gluon spawns, then it runs an absolute path from binPath or windowsTool, never the planted one", ["code", "seam", "e2e"]),
      "never-bun-which": rule("given any source but detect.ts, then it never calls Bun.which: every lookup goes through detect.ts"),
      "git-via-gitargv": rule("given a hostile .git/config (fsmonitor, filters, textconv, a promisor), when a repo tool runs git, then it goes through gitArgv and nothing the config names runs"),
      "neutral-cwd": rule("when Gluon runs a status check, a probe, a version check, a login or an installer, then it runs in a neutral directory, never the repository", ["code", "seam", "e2e"]),
      "bun-autoloads-nothing": rule("given a repository with a bunfig.toml preload or a .env, when Gluon starts from source or a package script runs, then nothing of the repository's loads", ["code", "seam", "e2e"]),
      "no-posix-tools": rule("given no rg, git or ps, when the tools run, then Gluon's own fallbacks answer and no POSIX tool is spawned"),
    },
  },
  "repo-tools": {
    says: "the brain's tools read the repository and nothing else (src/agent/AGENTS.md)",
    entries: {
      "read-only": rule("when the brain's repo tools run, then nothing in the repository is written, the git index included"),
      "sandbox-within": rule("given a path outside the repository (.., a symlink, another drive, a UNC share), when a tool resolves it, then it is refused"),
      "secret-files": rule("given a secret file by name or by its real path, when any tool reads, greps or diffs, then the one isSecretPath rule leaves it out"),
    },
  },
  keys: {
    says: "the user's keys stay where they are put and are never shown (src/AGENTS.md)",
    entries: {
      "never-in-process-env": rule("given keys in Gluon's .env or an AWS profile, when they are loaded, then process.env stays as it was"),
      "masked-when-printed": rule("given a key or token in text Gluon prints (an error, a probe's output), then it is masked, by shape and by value"),
      "private-files-directory-first": rule("when a private file is written, then it is made in a fresh 0700 directory and renamed into place, and nothing is left behind on a failure"),
    },
  },
  pty: {
    says: "what the agent's terminal shows stays in memory and never acts on its own (src/pty/AGENTS.md)",
    entries: {
      "screen-stays-in-memory": rule("given the agent's screen, then the screen, modes, painter, readers and interceptor use no file, network or process API"),
      "screen-never-triggers": rule("given a menu or a /clear drawn by the agent's output or pasted, when Enter is pressed without a typed /, then nothing is held"),
      "unsure-forward": rule("given a screen, line or key the reader can't read for sure, when it comes, then it is forwarded and nothing is held"),
      "only-user-bytes-into-agent": rule("when anything is written to the agent's terminal, then it is the user's bytes (unchanged, in order), the screen model's replies or shifted mouse reports"),
    },
  },
  install: {
    says: "a harness installer runs only when the user says so (src/AGENTS.md)",
    entries: {
      "run-it-enter-only": rule("given the install offer, when the user pastes, presses a digit, holds Enter, presses Esc or has no terminal, then nothing runs; only Run it + Enter runs it", ["e2e"]),
      "verbatim-no-sudo": rule("when an installer is shown and run, then it is the vendor's constant https or npm command, shown as it runs, with nothing interpolated, no --yes and no sudo", ["code", "seam", "e2e"]),
    },
  },
  dist: {
    says: "the compiled binary loads only what is built into it (scripts/AGENTS.md)",
    entries: {
      "no-autoload": rule("given a hostile working directory (a bunfig preload, a .env, tsconfig paths), when the compiled or release binary runs, then nothing of it loads", ["e2e"]),
      "no-external": rule("given node_modules in the working directory or its parent, when the compiled binary runs, then its own embedded modules are used, nothing from the directory", ["e2e"]),
    },
  },
  perf: {
    says: "how fast Gluon feels: the perception limits (test/perf/perf-kit.ts) and the baselines (test/perf/baseline.json)",
    entries: {
      startup: perf("when Gluon starts, first run or after, then the home view is up within its baseline, and the idle home view costs no CPU"),
      "key-home": perf("when a key is typed at the home composer, then its frame is drawn within the noticeable limit, alone and at key repeat", ["perf", "e2e"]),
      "key-session": perf("when a key is typed in a session, then it reaches the agent and its echo is drawn within the noticeable limit (on Windows, the accepted two-ConPTY ceiling)"),
      "burst-typing": perf("given 1, 10 or 40 sessions, or another session flooding, when keys come in a burst, then none is lost or queued and the latency stays under the limit"),
      sessions: perf("given 1 to 40 sessions, each with a full scrollback, then memory and frame time stay within their baselines"),
      flood: perf("when a session floods output, shown or in the background, then keys and a tab switch meanwhile stay within their limits"),
      soak: perf("given 5 sessions printing for minutes, then nothing grows without bound"),
      smoke: perf("when Gluon starts, opens three sessions and takes keys and tab switches, then each stays under the noticeable limit (the fast check of the perf suite)", ["e2e"]),
    },
  },
};

/** Every entry, by id (`feature/entry`). */
export const ENTRIES: Map<string, Entry> = new Map(Object.entries(CATALOG).flatMap(([f, { entries }]) => Object.entries(entries).map(([e, v]) => [`${f}/${e}`, v] as const)));

// ——— titles ———

/** The entry a title names: `feature/entry: …` at its start. */
export const entryOf = (title: string): string | undefined => /^([a-z][a-z0-9-]*\/[a-z0-9-]+): /.exec(title)?.[1];

/**
 * Each test (`test(` / `it(`, any modifier, and `(c ? test.skip : test)(`) in a file's text: its title as written, cut at
 * the first `${` of a built one (the entry is at the start, so a built title still names it). Not a `describe`.
 */
export function testTitles(text: string): string[] {
  const re = /\b(?:test|it)(?:\.\w+)*(?:\([^)]*\))?\)?\(\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;
  return [...text.matchAll(re)].map((m) => (m[1] === "`" ? m[2]!.split("${")[0]! : m[2]!));
}

/** A test file's layer from where it lives (`seam` and `code` share `test/*.test.ts`; `test/dist.test.ts` runs the built binary). */
export function layersOf(file: string): Layer[] {
  if (file === "test/dist.test.ts") return ["e2e"];
  if (file.startsWith("test/e2e/")) return ["e2e"];
  if (file.startsWith("test/real/")) return ["real"];
  if (file.startsWith("test/perf/")) return ["perf"];
  return ["seam", "code"];
}
