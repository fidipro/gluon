/**
 * Throwaway repositories, configs and fake agents, created under one temp dir per test run (a
 * nested .git can't be checked in, and tests must not touch a real repo).
 */
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outsideProfile, parseSid, windowsTool } from "../../src/secrets.ts";
import { FIXTURE_CLAUDE_CATALOG } from "../fixtures/fixture-tables.ts";
import { claudeBinaryText } from "../fixtures/pricing-sources.ts";

export const WIN = process.platform === "win32";

/**
 * Removes a test's state directory from a `finally` while the app that uses it still runs (`scoped` ends it after the body returns).
 * Windows can't delete a file another process holds open (EBUSY): the directory is then left for the run's temp root, which
 * `test/preload.ts` removes at exit.
 */
export function cleanDir(path: string) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (e) {
    if (!WIN || (e as NodeJS.ErrnoException).code !== "EBUSY") throw e;
  }
}

/**
 * Whether a file holding a key is private, as Gluon promises (`storageNote`): `true`, or what is
 * wrong (so a failure says why). On POSIX mode 0600. On Windows the mode means nothing: a file
 * inside the writer's profile (`home`) keeps the profile's ACL, which nothing asserts; one outside
 * it must be limited to the user and administrators — every allow entry of its DACL (read as SDDL,
 * by SID, whatever the system's language) is the user, SYSTEM or Administrators, and the user is
 * one of them. A mandatory integrity label (in the SACL, which icacls lists too) grants nothing.
 */
export function isPrivate(path: string, home: string): true | string {
  if (!WIN) {
    const mode = statSync(path).mode & 0o777;
    return mode === 0o600 || `mode ${mode.toString(8)}`;
  }
  if (!outsideProfile(path, home)) return true;
  const user = parseSid(Bun.spawnSync([windowsTool("whoami"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "pipe" }).stdout.toString());
  if (!user) return "whoami gave no SID";
  const sddl = aclOf(path);
  return sddl ? aclProblem(sddl, user) : "icacls couldn't read the ACL";
}

/** `true` when a DACL (SDDL) grants only `user`, SYSTEM and Administrators, and `user`; else why not. */
export function aclProblem(sddl: string, user: string): true | string {
  const dacl = sddl.match(/(?:^|\))D:[A-Z_]*((?:\([^)]*\))*)/);
  if (!dacl) return `no DACL (anyone can open it): ${sddl}`;
  // SDDL writes the machine's built-in Administrator (RID 500, GitHub's `runneradmin`) as `LA`.
  const me = /^S-1-5-21-.*-500$/.test(user) ? [user, "LA"] : [user];
  const allowed = new Set([...me, "SY", "S-1-5-18", "BA", "S-1-5-32-544"]);
  // Allow entries that apply to the object itself (not inherit-only ones).
  const grants = [...dacl[1]!.matchAll(/\(([^;]*);([^;]*);[^;]*;[^;]*;[^;]*;([^)]*)\)/g)].filter(([, type, flags]) => /^O?A$/.test(type!) && !/IO/.test(flags!)).map((m) => m[3]!);
  const others = grants.filter((sid) => !allowed.has(sid));
  if (others.length) return `readable by ${others.join(", ")}: ${sddl}`;
  return grants.some((sid) => me.includes(sid)) || `not granted to the user (${user}): ${sddl}`;
}

/** A path's security descriptor as SDDL (`icacls /save`, UTF-16), or null. */
function aclOf(path: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "gluon-acl-"));
  try {
    const out = join(dir, "acl");
    const r = Bun.spawnSync([windowsTool("icacls"), path, "/save", out], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return null;
    return readFileSync(out, "utf16le").replace(/^\uFEFF/, "").split(/\r?\n/)[1]?.trim() || null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TMP = mkdtempSync(join(tmpdir(), "gluon-e2e-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

const cache = new Map<string, string>();
const once = (key: string, make: (dir: string) => void): string => {
  let dir = cache.get(key);
  if (!dir) {
    dir = join(TMP, key);
    mkdirSync(dir, { recursive: true });
    make(dir);
    cache.set(key, dir);
  }
  return dir;
};

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

const files = (dir: string, map: Record<string, string>) => {
  for (const [path, body] of Object.entries(map)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
};

const TINY = {
  "README.md": "# tiny\n",
  "package.json": '{ "name": "tiny", "type": "module", "scripts": { "test": "bun test" } }\n',
  "src/math.ts": "export function add(a: number, b: number): number {\n  return a - b; // BUG: should be a + b\n}\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n",
  "test/math.test.ts": 'import { test, expect } from "bun:test";\nimport { add, mul } from "../src/math.ts";\ntest("add", () => expect(add(2, 3)).toBe(5));\ntest("mul", () => expect(mul(2, 3)).toBe(6));\n',
};

export const repo = {
  /** A git repo on `main` with a tiny TypeScript library that has a bug in `add`. */
  tiny: () =>
    once("tiny", (d) => {
      files(d, TINY);
      git(d, "init", "-q");
      git(d, "add", ".");
      git(d, "commit", "-qm", "init");
    }),
  /** `tiny`, with an AGENTS.md and a CLAUDE.md at the root. */
  withInstructions: () =>
    once("with-instructions", (d) => {
      files(d, { ...TINY, "AGENTS.md": "# Rules\nUse bun.\n", "CLAUDE.md": "@AGENTS.md\n" });
      git(d, "init", "-q");
      git(d, "add", ".");
      git(d, "commit", "-qm", "init");
    }),
  /** `git init` with no commits. */
  emptyGit: () => once("emptygit", (d) => git(d, "init", "-q")),
  /** A repo with HEAD detached at its commit; returns [dir, short sha]. */
  detached: (): [string, string] => {
    const d = once("detached", (d) => {
      files(d, { a: "1\n" });
      git(d, "init", "-q");
      git(d, "add", ".");
      git(d, "commit", "-qm", "init");
      git(d, "checkout", "-q", "--detach");
    });
    return [d, git(d, "rev-parse", "--short", "HEAD")];
  },
  /** Not a git repo, no package.json. */
  noGit: () => once("nogit", (d) => files(d, { "notes.txt": "hello\n" })),
  /** A path with a space in it. */
  withSpace: () => once("with space", (d) => files(d, TINY)),
  /** Symlinks out of the repo (where the OS lets the user make them: see `canSymlink`), a secret and a binary. */
  hazards: () =>
    once("hazards", (d) => {
      files(d, { ".env": "secret=1\n", "a.txt": "hello secret world\n", ".env.example": "secret=\n" });
      writeFileSync(join(d, "bin.dat"), new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
      if (!canSymlink) return;
      const outside = once("outside", (o) => files(o, { hostname: "host\n", passwd: "root:x:0:0\n" }));
      symlinkSync(join(outside, "hostname"), join(d, "host-link"));
      symlinkSync(outside, join(d, "etc-link"), "dir");
    }),
};

/**
 * Whether this user may create symlinks: always on POSIX; on Windows only with Developer Mode or
 * the privilege (EPERM otherwise). Symlink scenarios are skipped where it can't.
 */
export const canSymlink = (() => {
  const d = mkdtempSync(join(TMP, "symlink-"));
  try {
    symlinkSync(join(d, "x"), join(d, "y"));
    return true;
  } catch {
    return false;
  }
})();

/** A config file with this YAML; returns its path. */
export function config(name: string, yaml: string): string {
  const path = join(once("configs", () => {}), `${name}.yaml`);
  writeFileSync(path, yaml);
  return path;
}

/** The fake binaries, one per harness. */
export type FakeAgent = "claude" | "codex" | "agy" | "grok" | "opencode" | "kimi";

/** Signed in unless FAKE_<NAME>_LOGGED_OUT is set and the FAKE_<NAME>_STATE file (made by the login) doesn't exist. */
const signedIn = (name: string) => `signed_in() { [ -z "$FAKE_${name}_LOGGED_OUT" ] || { [ -n "$FAKE_${name}_STATE" ] && [ -f "$FAKE_${name}_STATE" ]; }; }
login() { printf 'FAKE-%s LOGIN press enter> ' "${name}"; read -r line; [ -n "$FAKE_${name}_STATE" ] && touch "$FAKE_${name}_STATE"; echo "Login successful."; exit 0; }
`;

/**
 * `claude auth status|login` and `claude -p`. FAKE_PING_FAIL makes `-p` fail with a token-like
 * value in its message (it must come out masked); FAKE_CLAUDE_BAD_MODELS (space-separated) makes
 * `-p --model <m>` fail as an unavailable model.
 */
const CLAUDE = `${signedIn("CLAUDE")}
if [ "$1" = auth ] && [ "$2" = status ]; then
  [ -n "$FAKE_CLAUDE_STATUS_FAIL" ] && { echo "Error: connect ECONNRESET" >&2; exit 1; }
  if signed_in; then echo '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "dev@example.com", "orgId": "org-123", "subscriptionType": "max"}'; exit 0; fi
  echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'; exit 1
fi
if [ "$1" = auth ] && [ "$2" = login ]; then login; fi
if [ "$1" = -p ]; then
  [ -n "$FAKE_CLAUDE_LOG" ] && printf '%s\\n' "$*" >> "$FAKE_CLAUDE_LOG"
  if [ -n "$FAKE_PING_FAIL" ]; then echo '{"type":"result","is_error":true,"result":"Invalid token sk-ant-oat01-abcdefghijklmnop · Please run /login"}'; exit 1; fi
  if ! signed_in; then echo '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}'; exit 1; fi
  for m in $FAKE_CLAUDE_BAD_MODELS; do [ "$m" = "$3" ] && { echo "{\\"type\\":\\"result\\",\\"is_error\\":true,\\"result\\":\\"There's an issue with the selected model ($3). It may not exist or you may not have access to it.\\"}"; exit 1; }; done
  echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'; exit 0
fi
`;

/**
 * `codex login status|login`, and `codex app-server`, `debug models` and `features list` (the
 * scripted JSON-RPC fake). FAKE_CODEX_METHOD=api-key: signed in with a key; FAKE_CODEX_LOGIN_HANG:
 * `login status` never answers.
 */
const CODEX = (bun: string, server: string) => `${signedIn("CODEX")}
if [ "$1" = login ] && [ "$2" = status ]; then
  [ -n "$FAKE_CODEX_LOGIN_HANG" ] && exec sleep 60
  if signed_in; then [ "$FAKE_CODEX_METHOD" = api-key ] && echo "Logged in using an API key - sk-proj-***abcd" || echo "Logged in using ChatGPT"; exit 0; fi
  echo "Not logged in"; exit 1
fi
if [ "$1" = login ]; then login; fi
if [ "$1" = app-server ] || [ "$1" = debug ] || [ "$1" = features ]; then exec "${bun}" "${server}" "$@"; fi
`;

/** `agy models` (the status check) and plain `agy` (its sign-in screen). FAKE_AGY_MODELS: the families it lists. */
const AGY = `${signedIn("AGY")}
if [ "$#" = 0 ]; then login; fi
if [ "$1" = models ]; then
  echo "Fetching available models..."
  signed_in || { echo "Error: you are not signed in. Run agy to sign in."; exit 1; }
  for m in \${FAKE_AGY_MODELS:-gemini-3.8-flash}; do for e in high medium low; do printf '%s-%s\\tModel (%s)\\n' "$m" "$e" "$e"; done; done
  exit 0
fi
`;

/** `grok models` (the status check) and `grok login`. FAKE_GROK_MODELS: the models the account lists. */
const GROK = `${signedIn("GROK")}
if [ "$1" = login ]; then login; fi
if [ "$1" = models ]; then
  signed_in || { echo "You are not logged in. Run grok login."; exit 1; }
  echo "You are logged in with grok.com."; echo; echo "Available models:"
  for m in \${FAKE_GROK_MODELS:-grok-4.7}; do echo "  * $m"; done
  exit 0
fi
`;

const OPENCODE = `${signedIn("OPENCODE")}
if [ "$1" = auth ] && [ "$2" = login ]; then login; fi
if [ "$1" = auth ] && [ "$2" = list ]; then
  s=""
  if [ -n "$FAKE_OPENCODE_ENV_ONLY" ]; then s='{"id":"opencode-go","name":"OpenCode Go","connections":[{"type":"env","name":"OPENCODE_API_KEY"}]}'
  elif signed_in; then
    st=""; [ -n "$FAKE_OPENCODE_NEEDS_AUTH" ] && st=',"status":{"status":"needs_auth","message":"Reconnect"}'
    s="{\\"id\\":\\"opencode-go\\",\\"name\\":\\"OpenCode Go\\",\\"connections\\":[{\\"type\\":\\"credential\\",\\"id\\":\\"c1\\",\\"label\\":\\"key\\",\\"method\\":\\"key\\"$st}]}"
  fi
  n=\${FAKE_OPENCODE_CREDENTIALS:-0}; for ((i=0; i<n; i++)); do s="$s\${s:+,}{\\"id\\":\\"login-$i\\",\\"name\\":\\"Login $i\\",\\"connections\\":[{\\"type\\":\\"credential\\",\\"id\\":\\"c$i\\",\\"label\\":\\"x\\",\\"method\\":\\"key\\"}]}"; done
  echo "[$s]"; exit 0
fi
if [ "$1" = models ]; then echo "opencode/big-pickle"; exit 0; fi
`;

/**
 * `kimi provider list` (the plan's status: Kimi has no login-status command) and `kimi login`. Signed in, the list has the managed
 * OAuth provider; signed out, `No providers configured.`. FAKE_KIMI_LIST_ODD: an answer Gluon can't read.
 */
const KIMI = `${signedIn("KIMI")}
if [ "$1" = login ]; then login; fi
if [ "$1" = provider ] && [ "$2" = list ]; then
  [ -n "$FAKE_KIMI_LIST_ODD" ] && { echo "kimi: something else entirely"; exit 0; }
  signed_in || { echo "No providers configured."; exit 0; }
  echo "managed:kimi-code  type=kimi  models=2  source=oauth"; exit 0
fi
# \`session list --cwd <dir> --json\`: FAKE_KIMI_SESSIONS (the JSON, as is), else one session created just now when FAKE_KIMI_ZIP is set.
# \`export <id> -o <zip> -y --no-include-global-log\`: copies FAKE_KIMI_ZIP there; FAKE_KIMI_LOG gets its argv and the output directory's mode.
if [ "$1" = session ] && [ "$2" = list ]; then
  [ -n "$FAKE_KIMI_SESSIONS" ] && { echo "$FAKE_KIMI_SESSIONS"; exit 0; }
  [ -n "$FAKE_KIMI_ZIP" ] || { echo "[]"; exit 0; }
  now=$(( $(date +%s) * 1000 + 999 ))
  echo "[{\\"id\\":\\"session_fake1\\",\\"workDir\\":\\"$4\\",\\"createdAt\\":$now,\\"updatedAt\\":$now,\\"archived\\":false,\\"metadata\\":{}}]"; exit 0
fi
if [ "$1" = export ]; then
  out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done
  [ -n "$FAKE_KIMI_LOG" ] && echo "$* mode=$(stat -c %a "$(dirname "$out")" 2>/dev/null || stat -f %Lp "$(dirname "$out")")" >> "$FAKE_KIMI_LOG"
  [ -n "$FAKE_KIMI_ZIP" ] && cp "$FAKE_KIMI_ZIP" "$out" && echo "$out"; exit 0
fi
`;

const VERSIONS: Record<FakeAgent, string> = { claude: "2.1.284 (Claude Code)", codex: "codex-cli 0.158.0", agy: "1.2.13", grok: "grok 1.0.44 (fake) [stable]", opencode: "opencode v2.0.21", kimi: "2.1.1" };

/**
 * What a real Claude Code binary holds that Gluon reads (its baked-in model catalog and its price function), as a here-document the script never runs: Claude's
 * table is built from the installed binary alone (no source on the network), so a refresh that reads the fake finds the fixture's catalog.
 */
const CLAUDE_BINARY_TEXT = `: <<'GLUON_FAKE_CLAUDE_BINARY'\n${claudeBinaryText(FIXTURE_CLAUDE_CATALOG.fastPricing!).replaceAll("\0", "")}\nGLUON_FAKE_CLAUDE_BINARY`;

const FAKE = (name: FakeAgent) => `#!/bin/bash
# fake ${name} for tests: prints its argv, tty state and env, reads a line, exits $FAKE_EXIT (default 7)
[ -n "$FAKE_CWD_LOG" ] && echo "${name} $* @ $PWD" >> "$FAKE_CWD_LOG"
[ "$1" = --version ] && { echo "\${FAKE_VERSION:-${VERSIONS[name]}}"; exit 0; }
${name === "claude" ? CLAUDE_BINARY_TEXT : ""}
${{ claude: CLAUDE, codex: CODEX(process.execPath, join(import.meta.dir, "../fixtures/fake-codex-app-server.ts")), agy: AGY, grok: GROK, opencode: OPENCODE, kimi: KIMI }[name]}
# What it was given (argv, tty, environment); also appended to $FAKE_ARGV_LOG, where a test reads it
# when the screen can't keep it all (Gluon's frame has no scrollback).
report() {
echo "FAKE-${name.toUpperCase()} argc=$#"
i=0; for a in "$@"; do i=$((i+1)); printf 'ARG%d=<%s>\\n' "$i" "$a"; done
# isig icanon echo, in that order, as \`stty -a\` shows them (GNU and BSD order them differently).
tty=" $(stty -a < /dev/tty 2>/dev/null | tr '\\n;' '  ') "; flags=""
for w in isig icanon echo; do case "$tty" in *" -$w "*) flags="$flags-$w ";; *" $w "*) flags="$flags$w ";; esac; done
echo "STTY: $flags"
echo "ENV AWS_PROFILE=\${AWS_PROFILE:-unset} AWS_REGION=\${AWS_REGION:-unset}"
for v in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY XAI_API_KEY OPENCODE_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK; do [ -n "$(printenv "$v")" ] && echo "ENV $v=set" || echo "ENV $v=unset"; done
for v in ANTHROPIC_BASE_URL OPENAI_BASE_URL; do val=$(printenv "$v"); echo "ENV $v=\${val:-unset}"; done
# The last 4 characters of a key: which key the agent got, without printing it.
for v in ANTHROPIC_API_KEY OPENAI_API_KEY XAI_API_KEY; do val=$(printenv "$v"); [ -n "$val" ] && echo "TAIL $v=\${val: -4}"; done
[ -n "$GROK_AUTH_PATH" ] && echo "ENV GROK_AUTH_PATH=set"
[ -n "$OPENCODE_CONFIG_CONTENT" ] && echo "ENV OPENCODE_CONFIG_CONTENT=$OPENCODE_CONFIG_CONTENT"
# Kimi Code's environment model: the name, endpoint and effort, and the key's last 4 characters.
for v in KIMI_MODEL_NAME KIMI_MODEL_BASE_URL KIMI_MODEL_THINKING_EFFORT KIMI_CODE_NO_AUTO_UPDATE; do val=$(printenv "$v"); [ -n "$val" ] && echo "ENV $v=$val"; done
val=$(printenv KIMI_MODEL_API_KEY); [ -n "$val" ] && echo "TAIL KIMI_MODEL_API_KEY=\${val: -4}"
# The channel back to Gluon (a UI launch only).
[ -n "$GLUON_EVENTS" ] && echo "ENV GLUON_EVENTS=set" || echo "ENV GLUON_EVENTS=unset"
echo "ENV GLUON_HANDOFF=\${GLUON_HANDOFF-unset}"
}
if [ -n "$FAKE_ARGV_LOG" ]; then report "$@" | tee -a "$FAKE_ARGV_LOG"; else report "$@"; fi
# FAKE_REFUSE_RESUME=<code>: a resume, as the harness's argv names it, is refused: exits <code> at once (as a harness refuses an unknown session id).
if [ -n "$FAKE_REFUSE_RESUME" ]; then for a in "$@"; do case "$a" in --resume=*|--session=*|resume) exit "$FAKE_REFUSE_RESUME";; esac; done; fi
# FAKE_TUI: a raw-mode prompt with a slash menu instead of the line (fixtures/fake-tui.ts, shared with fake-agent.ts).
[ -n "$FAKE_TUI" ] && FAKE_AGENT_NAME=${name} exec "${process.execPath}" --no-env-file "${join(import.meta.dir, "../fixtures/fake-tui.ts")}" "$@"
# FAKE_HANG=ignore-term: SIGTERM does nothing; FAKE_KILL_LOG: SIGTERM is logged there.
if [ "$FAKE_HANG" = ignore-term ]; then trap '' TERM
elif [ -n "$FAKE_KILL_LOG" ]; then trap 'echo KILLED >> "$FAKE_KILL_LOG"; exit 143' TERM; fi
# A typed /clear runs $FAKE_HOOK (as a harness runs its hook) and asks again.
while :; do
  printf 'type a line> '
  read -r line
  [ "$line" = /clear ] || break
  sh -c "$FAKE_HOOK" < /dev/null
  echo "HOOK ran"
done
echo "GOT <$line>"
# FAKE_HANG: alive until killed.
if [ -n "$FAKE_HANG" ]; then while :; do sleep 1 < /dev/null > /dev/null 2>&1 & wait $!; done; fi
exit \${FAKE_EXIT:-7}
`;

const FAKE_TS = join(import.meta.dir, "../fixtures/fake-agent.ts");

/**
 * The fake agent compiled to an exe (Windows has no bash): built once per version of its sources
 * and Bun, and kept in the temp dir across runs. No cwd `.env` / `bunfig.toml` autoload, like a
 * real agent Gluon must not leak keys into.
 */
export function fakeExe(): string {
  const fixtures = join(import.meta.dir, "../fixtures");
  const hash = Bun.hash([FAKE_TS, join(fixtures, "fake-codex-app-server.ts"), join(fixtures, "fake-tui.ts"), join(fixtures, "codex-features-list.txt")].map((f) => readFileSync(f, "utf8")).join("\0") + Bun.version).toString(36);
  // Kept across runs: outside the per-run temp dir (test/preload.ts).
  const cache = process.env.GLUON_TEST_REAL_TMP ?? tmpdir();
  const exe = join(cache, `gluon-fake-agent-${hash}.exe`);
  if (existsSync(exe)) return exe;
  const tmp = join(cache, `gluon-fake-agent-${hash}.${process.pid}.exe`);
  const r = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", FAKE_TS, "--outfile", tmp], { cwd: fixtures, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`building the fake agent failed: ${r.stderr}`);
  try {
    renameSync(tmp, exe);
  } catch {
    rmSync(tmp, { force: true });
  }
  return exe;
}

/** A directory holding fake agent binaries, to put first on PATH: bash scripts on POSIX, `<name>.exe` (the compiled fake-agent.ts) on Windows. */
export function fakeAgents(agents: FakeAgent[]): string {
  return once(`bin-${[...agents].sort().join("-") || "none"}`, (d) => {
    for (const a of agents) {
      if (WIN) {
        const exe = fakeExe();
        try {
          linkSync(exe, join(d, `${a}.exe`));
        } catch {
          copyFileSync(exe, join(d, `${a}.exe`));
        }
        continue;
      }
      writeFileSync(join(d, a), FAKE(a));
      chmodSync(join(d, a), 0o755);
    }
  });
}

/** The bash fake's script for one agent (POSIX), for `test/fakes.test.ts`. */
export const fakeScript = FAKE;

/** Answers for API probes (GLUON_TEST_PROBES): "<provider or route>/<model>" → true or an error. */
export function probes(name: string, answers: Record<string, true | string>): string {
  const path = join(once("probes", () => {}), `${name}.json`);
  writeFileSync(path, JSON.stringify(answers));
  return path;
}

/** A fresh, empty directory for one test's config file (and the `.env` next to it); returns the config path. */
export function freshConfig(name: string, yaml?: string): string {
  const dir = join(TMP, `cfg-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.yaml");
  if (yaml !== undefined) writeFileSync(path, yaml);
  return path;
}

/**
 * A fake of the installers' first step, for `gluon install opencode`: `curl` (POSIX; the real
 * `bash` runs what it prints) or `npm.cmd` (Windows). It logs its arguments and working directory to
 * FAKE_INSTALL_LOG and "installs" the fake opencode into FAKE_INSTALL_TO; `npm prefix -g` prints
 * FAKE_NPM_PREFIX. FAKE_INSTALL_FAIL: installs nothing, exits 3; FAKE_INSTALL_WAIT (POSIX): waits
 * for Ctrl+C first. Never the network.
 */
export function fakeInstaller(): string {
  return once("installer", (d) => {
    if (WIN) {
      writeFileSync(
        join(d, "npm.cmd"),
        [
          "@echo off",
          'if "%1"=="prefix" (echo %FAKE_NPM_PREFIX%& exit /b 0)',
          'echo npm %* @ %CD%>>"%FAKE_INSTALL_LOG%"',
          "if defined FAKE_INSTALL_FAIL (echo fake installer: failed& exit /b 3)",
          'if not exist "%FAKE_INSTALL_TO%" mkdir "%FAKE_INSTALL_TO%"',
          'copy /y "%FAKE_INSTALL_SRC%" "%FAKE_INSTALL_TO%\\opencode.exe" >nul',
          "echo fake installer: installed opencode",
          "",
        ].join("\r\n"),
      );
      return;
    }
    writeFileSync(
      join(d, "curl"),
      `#!/bin/sh
echo "curl $* @ $PWD" >> "$FAKE_INSTALL_LOG"
cat <<'EOS'
set -e
[ -n "$FAKE_INSTALL_FAIL" ] && { echo "fake installer: failed"; exit 3; }
[ -n "$FAKE_INSTALL_WAIT" ] && { echo "fake installer: waiting"; sleep 30; }
mkdir -p "$FAKE_INSTALL_TO"
cp "$FAKE_INSTALL_SRC" "$FAKE_INSTALL_TO/opencode"
chmod 755 "$FAKE_INSTALL_TO/opencode"
echo "fake installer: installed opencode"
EOS
`,
    );
    chmodSync(join(d, "curl"), 0o755);
  });
}
