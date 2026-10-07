/**
 * The fake agents of `fixtures.ts` in TypeScript: on Windows (no bash) it is compiled once to an
 * exe and linked as `claude.exe`, `codex.exe`, … — it knows which one it is from its own name
 * (or FAKE_AGENT_NAME when run as a script). It behaves like the bash fakes (`FAKE` in
 * fixtures.ts), which stay on POSIX; `test/fakes.test.ts` checks the two agree.
 */
import { appendFileSync, copyFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { runHook, runTui } from "./fake-tui.ts";

const name = (process.env.FAKE_AGENT_NAME ?? basename(process.execPath).replace(/\.exe$/i, "")) as "claude" | "codex" | "agy" | "grok" | "opencode" | "kimi";
const NAME = name.toUpperCase();
const args = process.argv.slice(2);
const env = process.env;
const out = (s: string) => process.stdout.write(s);
const say = (s = "") => out(`${s}\n`);

const VERSIONS = { claude: "2.1.284 (Claude Code)", codex: "codex-cli 0.158.0", agy: "1.2.13", grok: "grok 1.0.44 (fake) [stable]", opencode: "opencode v2.0.21", kimi: "2.1.1" };

// One reader for every line: a new `for await` per line would lose what the last one buffered.
const lines = console[Symbol.asyncIterator]();
async function readLine(): Promise<string> {
  const r = await lines.next();
  return r.done ? "" : String(r.value).replace(/\r$/, "");
}

/** Signed in unless FAKE_<NAME>_LOGGED_OUT is set and the FAKE_<NAME>_STATE file (made by the login) doesn't exist. */
const signedIn = () => !env[`FAKE_${NAME}_LOGGED_OUT`] || (!!env[`FAKE_${NAME}_STATE`] && existsSync(env[`FAKE_${NAME}_STATE`]!));

async function login(): Promise<never> {
  out(`FAKE-${NAME} LOGIN press enter> `);
  await readLine();
  if (env[`FAKE_${NAME}_STATE`]) writeFileSync(env[`FAKE_${NAME}_STATE`]!, "");
  say("Login successful.");
  process.exit(0);
}

/** The terminal's line discipline, as `stty -a` names it (POSIX), or the console input mode's equivalents (Windows). */
function stty(): string {
  if (process.platform === "win32") {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const k = dlopen("kernel32.dll", { GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr }, GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
    const mode = new Uint32Array(1);
    if (!k.symbols.GetConsoleMode(k.symbols.GetStdHandle(-10), ptr(mode))) return "";
    // ENABLE_PROCESSED_INPUT (Ctrl+C is a signal), ENABLE_LINE_INPUT, ENABLE_ECHO_INPUT.
    const flag = (bit: number, word: string) => `${mode[0]! & bit ? "" : "-"}${word}`;
    return `${flag(1, "isig")} ${flag(2, "icanon")} ${flag(4, "echo")} `;
  }
  // isig icanon echo, in that order, as `stty -a` shows them (GNU and BSD order them differently).
  const tty = ` ${Bun.spawnSync(["sh", "-c", "stty -a < /dev/tty"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().replace(/[\n;]/g, " ")} `;
  return ["isig", "icanon", "echo"].map((w) => (tty.includes(` -${w} `) ? `-${w} ` : tty.includes(` ${w} `) ? `${w} ` : "")).join("");
}

if (env.FAKE_CWD_LOG) appendFileSync(env.FAKE_CWD_LOG, `${name} ${args.join(" ")} @ ${process.cwd()}\n`);
if (args[0] === "--version") {
  say(env.FAKE_VERSION || VERSIONS[name]);
  process.exit(0);
}

const [a1, a2] = args;
switch (name) {
  case "claude":
    if (a1 === "auth" && a2 === "status") {
      if (env.FAKE_CLAUDE_STATUS_FAIL) {
        process.stderr.write("Error: connect ECONNRESET\n");
        process.exit(1);
      }
      if (signedIn()) {
        say('{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "dev@example.com", "orgId": "org-123", "subscriptionType": "max"}');
        process.exit(0);
      }
      say('{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}');
      process.exit(1);
    }
    if (a1 === "auth" && a2 === "login") await login();
    if (a1 === "-p") {
      if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, `${args.join(" ")}\n`);
      if (env.FAKE_PING_FAIL) {
        say('{"type":"result","is_error":true,"result":"Invalid token sk-ant-oat01-abcdefghijklmnop · Please run /login"}');
        process.exit(1);
      }
      if (!signedIn()) {
        say('{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}');
        process.exit(1);
      }
      for (const m of (env.FAKE_CLAUDE_BAD_MODELS ?? "").split(/\s+/).filter(Boolean))
        if (m === args[2]) {
          say(JSON.stringify({ type: "result", is_error: true, result: `There's an issue with the selected model (${args[2]}). It may not exist or you may not have access to it.` }));
          process.exit(1);
        }
      say('{"type":"result","subtype":"success","is_error":false,"result":"ok"}');
      process.exit(0);
    }
    break;
  case "codex":
    if (a1 === "login" && a2 === "status") {
      if (env.FAKE_CODEX_LOGIN_HANG) {
        await Bun.sleep(60_000);
        process.exit(0);
      }
      if (signedIn()) {
        say(env.FAKE_CODEX_METHOD === "api-key" ? "Logged in using an API key - sk-proj-***abcd" : "Logged in using ChatGPT");
        process.exit(0);
      }
      say("Not logged in");
      process.exit(1);
    }
    if (a1 === "login") await login();
    if (a1 === "app-server" || a1 === "debug" || a1 === "features") {
      await import("./fake-codex-app-server.ts");
      await new Promise(() => {});
    }
    break;
  case "agy":
    if (args.length === 0) await login();
    if (a1 === "models") {
      say("Fetching available models...");
      if (!signedIn()) {
        say("Error: you are not signed in. Run agy to sign in.");
        process.exit(1);
      }
      for (const m of (env.FAKE_AGY_MODELS || "gemini-3.8-flash").split(/\s+/).filter(Boolean)) for (const e of ["high", "medium", "low"]) say(`${m}-${e}\tModel (${e})`);
      process.exit(0);
    }
    break;
  case "grok":
    if (a1 === "login") await login();
    if (a1 === "models") {
      if (!signedIn()) {
        say("You are not logged in. Run grok login.");
        process.exit(1);
      }
      say("You are logged in with grok.com.");
      say();
      say("Available models:");
      for (const m of (env.FAKE_GROK_MODELS || "grok-4.7").split(/\s+/).filter(Boolean)) say(`  * ${m}`);
      process.exit(0);
    }
    break;
  case "kimi":
    if (a1 === "login") await login();
    if (a1 === "provider" && a2 === "list") {
      if (env.FAKE_KIMI_LIST_ODD) say("kimi: something else entirely");
      else say(signedIn() ? "managed:kimi-code  type=kimi  models=2  source=oauth" : "No providers configured.");
      process.exit(0);
    }
    // `session list --cwd <dir> --json` and `export <id> -o <zip> -y --no-include-global-log`: as the bash fake (`test/e2e/fixtures.ts`).
    if (a1 === "session" && a2 === "list") {
      if (env.FAKE_KIMI_SESSIONS) say(env.FAKE_KIMI_SESSIONS);
      else if (!env.FAKE_KIMI_ZIP) say("[]");
      else {
        const now = Date.now() + 999;
        say(JSON.stringify([{ id: "session_fake1", workDir: args[3], createdAt: now, updatedAt: now, archived: false, metadata: {} }]));
      }
      process.exit(0);
    }
    if (a1 === "export") {
      const out = args[args.indexOf("-o") + 1]!;
      if (env.FAKE_KIMI_LOG) appendFileSync(env.FAKE_KIMI_LOG, `${args.join(" ")} mode=${(statSync(dirname(out)).mode & 0o777).toString(8)}\n`);
      if (env.FAKE_KIMI_ZIP) {
        copyFileSync(env.FAKE_KIMI_ZIP, out);
        say(out);
      }
      process.exit(0);
    }
    break;
  case "opencode":
    // `auth login opencode-go` is the plan's sign-in (OpenCode asks for the plan's key itself).
    if (a1 === "auth" && a2 === "login") await login();
    if (a1 === "auth" && a2 === "list") {
      // OpenCode 2: `auth list --format json` lists the integrations that have a connection: the plan's stored sign-in (`type:"credential"`)
      // unless FAKE_OPENCODE_LOGGED_OUT (the login makes FAKE_OPENCODE_STATE); FAKE_OPENCODE_ENV_ONLY: only an OPENCODE_API_KEY variable
      // (`type:"env"`: not the plan); FAKE_OPENCODE_NEEDS_AUTH: a stored sign-in OpenCode wants redone; FAKE_OPENCODE_CREDENTIALS: other stored sign-ins.
      const list: unknown[] = [];
      if (env.FAKE_OPENCODE_ENV_ONLY) list.push({ id: "opencode-go", name: "OpenCode Go", connections: [{ type: "env", name: "OPENCODE_API_KEY" }] });
      else if (signedIn()) list.push({ id: "opencode-go", name: "OpenCode Go", connections: [{ type: "credential", id: "c1", label: "key", method: "key", ...(env.FAKE_OPENCODE_NEEDS_AUTH ? { status: { status: "needs_auth", message: "Reconnect" } } : {}) }] });
      for (let i = 0; i < Number(env.FAKE_OPENCODE_CREDENTIALS || "0"); i++) list.push({ id: `login-${i}`, name: `Login ${i}`, connections: [{ type: "credential", id: `c${i}`, label: "x", method: "key" }] });
      say(JSON.stringify(list));
      process.exit(0);
    }
    if (a1 === "models") {
      say("opencode/big-pickle");
      process.exit(0);
    }
    break;
}

// What it was given (argv, tty, environment); also appended to $FAKE_ARGV_LOG, where a test reads
// it when the screen can't keep it all (Gluon's frame has no scrollback).
const report: string[] = [];
const sayReport = (s: string) => {
  report.push(s);
  say(s);
};
sayReport(`FAKE-${NAME} argc=${args.length}`);
args.forEach((a, i) => sayReport(`ARG${i + 1}=<${a}>`));
sayReport(`STTY: ${stty()}`);
sayReport(`ENV AWS_PROFILE=${env.AWS_PROFILE || "unset"} AWS_REGION=${env.AWS_REGION || "unset"}`);
for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "OPENCODE_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]) sayReport(`ENV ${v}=${env[v] ? "set" : "unset"}`);
for (const v of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) sayReport(`ENV ${v}=${env[v] || "unset"}`);
// The last 4 characters of a key: which key the agent got, without printing it.
for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"]) if (env[v]) sayReport(`TAIL ${v}=${env[v]!.slice(-4)}`);
if (env.GROK_AUTH_PATH) sayReport("ENV GROK_AUTH_PATH=set");
if (env.OPENCODE_CONFIG_CONTENT) sayReport(`ENV OPENCODE_CONFIG_CONTENT=${env.OPENCODE_CONFIG_CONTENT}`);
// Kimi Code's environment model: the name, endpoint and effort, and the key's last 4 characters.
for (const v of ["KIMI_MODEL_NAME", "KIMI_MODEL_BASE_URL", "KIMI_MODEL_THINKING_EFFORT", "KIMI_CODE_NO_AUTO_UPDATE"]) if (env[v]) sayReport(`ENV ${v}=${env[v]}`);
if (env.KIMI_MODEL_API_KEY) sayReport(`TAIL KIMI_MODEL_API_KEY=${env.KIMI_MODEL_API_KEY.slice(-4)}`);
// The channel back to Gluon (a UI launch only).
sayReport(`ENV GLUON_EVENTS=${env.GLUON_EVENTS ? "set" : "unset"}`);
sayReport(`ENV GLUON_HANDOFF=${env.GLUON_HANDOFF ?? "unset"}`);
if (env.FAKE_ARGV_LOG) appendFileSync(env.FAKE_ARGV_LOG, report.map((l) => `${l}\n`).join(""));
// FAKE_REFUSE_RESUME=<code>: a resume, as the harness's argv names it, is refused: exits <code> at once.
if (env.FAKE_REFUSE_RESUME && args.some((a) => /^--(resume|session)=/.test(a) || a === "resume")) process.exit(Number(env.FAKE_REFUSE_RESUME));
// FAKE_TUI: a raw-mode prompt with a slash menu instead of the line (fake-tui.ts, shared with the bash fake).
if (env.FAKE_TUI) {
  runTui(name);
  await new Promise(() => {});
}
// FAKE_HANG=ignore-term: SIGTERM does nothing; FAKE_KILL_LOG: SIGTERM is logged there.
if (env.FAKE_HANG === "ignore-term") process.on("SIGTERM", () => {});
else if (env.FAKE_KILL_LOG)
  process.on("SIGTERM", () => {
    appendFileSync(env.FAKE_KILL_LOG!, "KILLED\n");
    process.exit(143);
  });
// A typed /clear runs $FAKE_HOOK (as a harness runs its hook) and asks again.
let line: string;
for (;;) {
  out("type a line> ");
  line = await readLine();
  if (line !== "/clear") break;
  const hook = env.FAKE_HOOK ?? "";
  runHook(hook, "inherit");
  say("HOOK ran");
}
say(`GOT <${line}>`);
// FAKE_HANG: alive until killed.
if (env.FAKE_HANG) setInterval(() => {}, 1000);
else process.exit(Number(env.FAKE_EXIT || 7));
