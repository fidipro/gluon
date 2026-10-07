/**
 * The two fake agents agree: the bash fakes (POSIX) and `fixtures/fake-agent.ts` (compiled on
 * Windows) answer every invocation the suite uses with the same output, exit code and side effects.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeScript, WIN, type FakeAgent } from "./e2e/fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "gluon-fakes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const TS = join(import.meta.dir, "fixtures/fake-agent.ts");

type Case = [FakeAgent, string[], Record<string, string>?, string?];
const CASES: Case[] = [
  ...(["claude", "codex", "agy", "grok", "opencode", "kimi"] as const).map((a): Case => [a, ["--version"]]),
  ["claude", ["auth", "status", "--json"]],
  ["claude", ["auth", "status", "--json"], { FAKE_CLAUDE_LOGGED_OUT: "1" }],
  ["claude", ["auth", "status", "--json"], { FAKE_CLAUDE_STATUS_FAIL: "1" }],
  ["claude", ["-p", "--model", "sonnet", "ping"]],
  ["claude", ["-p", "--model", "opus", "ping"], { FAKE_CLAUDE_BAD_MODELS: "haiku opus" }],
  ["claude", ["-p", "--model", "sonnet", "ping"], { FAKE_PING_FAIL: "1" }],
  ["claude", ["-p", "--model", "sonnet", "ping"], { FAKE_CLAUDE_LOGGED_OUT: "1" }],
  ["claude", ["auth", "login"], { FAKE_CLAUDE_STATE: "@state" }, "\n"],
  ["codex", ["login", "status"]],
  ["codex", ["login", "status"], { FAKE_CODEX_METHOD: "api-key" }],
  ["codex", ["login", "status"], { FAKE_CODEX_LOGGED_OUT: "1" }],
  ["codex", ["login"], { FAKE_CODEX_STATE: "@state" }, "\n"],
  ["codex", ["features", "list", "--disable", "shell_tool", "--disable", "unified_exec"]],
  ["codex", ["debug", "models"], { FAKE_CODEX_CATALOG_EXTRA: '{"x":1}' }],
  ["agy", ["models"]],
  ["agy", ["models"], { FAKE_AGY_MODELS: "gemini-9" }],
  ["agy", ["models"], { FAKE_AGY_LOGGED_OUT: "1" }],
  ["agy", [], { FAKE_AGY_STATE: "@state" }, "\n"],
  ["grok", ["models"]],
  ["grok", ["models"], { FAKE_GROK_MODELS: "grok-5 grok-4.7" }],
  ["grok", ["models"], { FAKE_GROK_LOGGED_OUT: "1" }],
  ["grok", ["login"], { FAKE_GROK_LOGGED_OUT: "1", FAKE_GROK_STATE: "@state" }, "\n"],
  ["opencode", ["auth", "list", "--standalone", "--format", "json"], { FAKE_OPENCODE_CREDENTIALS: "2" }],
  ["opencode", ["auth", "login"], {}, "\n"],
  ["opencode", ["models"]],
  ["kimi", ["provider", "list"]],
  ["kimi", ["provider", "list"], { FAKE_KIMI_LOGGED_OUT: "1" }],
  ["kimi", ["provider", "list"], { FAKE_KIMI_LIST_ODD: "1" }],
  // The usage source of Gluon's own cost: the sessions of a directory, and an export copied to the path given (its argv and the directory's mode logged).
  ["kimi", ["session", "list", "--cwd", "/w", "--json"]],
  ["kimi", ["session", "list", "--cwd", "/w", "--json"], { FAKE_KIMI_SESSIONS: '[{"id":"session_a","createdAt":1}]' }],
  ["kimi", ["export", "session_a", "-o", join(dir, "kimi-export.zip"), "-y", "--no-include-global-log"], { FAKE_KIMI_ZIP: TS, FAKE_KIMI_LOG: "@log" }],
  ["kimi", ["login"], { FAKE_KIMI_LOGGED_OUT: "1", FAKE_KIMI_STATE: "@state" }, "\n"],
  ["claude", ["--model", "sonnet", "--", "- a spec\nwith & | %PATH% \"quotes\" \\"], { ANTHROPIC_API_KEY: "sk-ant-api03-abcdWXYZ", AWS_PROFILE: "p", FAKE_EXIT: "3", FAKE_CWD_LOG: "@log" }, "typed line\n"],
  ["grok", ["-m", "grok-4.7", "--", "x"], { XAI_API_KEY: "xai-key-1234", GROK_AUTH_PATH: "/nowhere", OPENAI_BASE_URL: "https://example.test" }, "\n"],
  ["kimi", ["-m", "kimi-code/k3"], { FAKE_EXIT: "0", KIMI_MODEL_NAME: "moonshotai/kimi-k3", KIMI_MODEL_BASE_URL: "https://openrouter.ai/api/v1", KIMI_MODEL_API_KEY: "sk-or-v1-abcdWXYZ", KIMI_MODEL_THINKING_EFFORT: "high", KIMI_CODE_NO_AUTO_UPDATE: "1" }, "hi\n"],
  ["opencode", ["--standalone", "--prompt=spec"], { FAKE_EXIT: "0", OPENCODE_CONFIG_CONTENT: '{"model":"openai/gpt"}' }, "hi\n"],
  // A UI launch: the channel's variables; a typed /clear runs the hook and asks again.
  ["claude", ["--model", "m", "--", "x"], { GLUON_EVENTS: "/somewhere", GLUON_HANDOFF: "clear", FAKE_HOOK: 'echo "hooked $GLUON_HANDOFF" >> "$FAKE_CWD_LOG"', FAKE_CWD_LOG: "@log" }, "/clear\n/clear\nafter\n"],
  ["codex", ["-m", "m", "x"], { GLUON_HANDOFF: "" }, "/clear\n"],
  // What it was given, also in FAKE_ARGV_LOG (Gluon's frame keeps no scrollback).
  ["claude", ["--model", "m", "--", "x"], { FAKE_ARGV_LOG: "@log", GLUON_EVENTS: "/somewhere" }, "\n"],
];

async function run(bin: string[], c: Case, i: number, extra: Record<string, string> = {}) {
  const [, args, env = {}, input] = c;
  const state = join(dir, `${bin.length}-${i}.state`);
  const log = join(dir, `${bin.length}-${i}.log`);
  const e = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === "@state" ? state : v === "@log" ? log : v]));
  const p = Bun.spawn([...bin, ...args], { cwd: dir, env: { PATH: process.env.PATH!, ...e, ...extra }, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined && p.stdin) {
    p.stdin.write(input);
    await p.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  // The tty line depends on the terminal (there is none here).
  return { stdout: stdout.replace(/^STTY:.*$/m, "STTY:"), stderr: stderr.replace(/^.*\/dev\/tty.*\n/m, ""), code, state: existsSync(state), log: existsSync(log) ? readFileSync(log, "utf8") : null };
}

describe.concurrent.skipIf(WIN)("the bash and TypeScript fakes agree", () => {
  // Plain invocations, no timing: all at once.
  CASES.forEach((c, i) =>
    test.concurrent(`${c[0]} ${c[1].join(" ").slice(0, 40)} ${JSON.stringify(c[2] ?? {}).slice(0, 60)}`, async () => {
      const sh = join(dir, c[0]);
      if (!existsSync(sh)) {
        writeFileSync(sh, fakeScript(c[0]));
        chmodSync(sh, 0o755);
      }
      const bash = await run([sh], c, i);
      const ts = await run([process.execPath, TS], c, i + 1000, { FAKE_AGENT_NAME: c[0] });
      expect(ts).toEqual(bash);
    }),
  );

  /** FAKE_HANG: alive after its line until a signal; what SIGTERM did (exit code, the kill log). */
  async function hang(bin: string[], name: string, hangValue: string) {
    const log = join(dir, `hang-${name}.log`);
    const p = Bun.spawn(bin, { cwd: dir, env: { PATH: process.env.PATH!, FAKE_AGENT_NAME: "claude", FAKE_HANG: hangValue, FAKE_KILL_LOG: log }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    p.stdin.write("hi\n");
    await p.stdin.end();
    const reader = p.stdout.getReader();
    let text = "";
    while (!text.includes("GOT <hi>")) text += new TextDecoder().decode((await reader.read()).value);
    await Bun.sleep(300);
    expect(p.exitCode).toBeNull();
    p.kill("SIGTERM");
    const termed = await Promise.race([p.exited.then(() => true), Bun.sleep(500).then(() => false)]);
    if (!termed) p.kill("SIGKILL");
    await p.exited;
    return { termed, signal: p.signalCode, code: p.exitCode, log: existsSync(log) ? readFileSync(log, "utf8") : null };
  }

  for (const value of ["1", "ignore-term"])
    test(`claude FAKE_HANG=${value}: alive until killed; SIGTERM ${value === "1" ? "logged" : "ignored"}`, async () => {
      const sh = join(dir, "claude");
      if (!existsSync(sh)) {
        writeFileSync(sh, fakeScript("claude"));
        chmodSync(sh, 0o755);
      }
      const bash = await hang([sh, "-m", "x"], `sh-${value}`, value);
      const ts = await hang([process.execPath, TS, "-m", "x"], `ts-${value}`, value);
      expect(ts).toEqual(bash);
      expect(bash).toEqual(value === "1" ? { termed: true, signal: null, code: 143, log: "KILLED\n" } : { termed: false, signal: "SIGKILL", code: null, log: null });
    });

  /** FAKE_TUI in a PTY: the output (raw: colours and cursor moves included) and exit code for these keys, each written once the last was answered. */
  async function tui(bin: string[], env: Record<string, string>, keys: string[]) {
    let out = "";
    const text = new TextDecoder();
    const p = Bun.spawn(bin, { cwd: dir, env: { PATH: process.env.PATH!, FAKE_TUI: "1", ...env }, terminal: { cols: 80, rows: 24, data: (_t, d) => void (out += text.decode(d, { stream: true })) } });
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(10);
    };
    await until(() => out.includes("TUI ready"));
    for (const k of keys) {
      const n = out.length;
      p.terminal!.write(k);
      await until(() => out.length > n || p.exitCode !== null);
      await Bun.sleep(20);
    }
    const code = await Promise.race([p.exited, Bun.sleep(3000).then(() => null)]);
    p.kill();
    p.terminal!.close();
    return { out: out.replace(/^STTY:.*$/m, "STTY:"), code };
  }

  const TUI_CASES: [FakeAgent, Record<string, string>, string[], number][] = [
    // Tab on an ambiguous prefix, then a unique one; the menu's Down; editing; Ctrl+C; auto-compaction; /exit.
    ["claude", {}, ["/c", "\t", "l", "\t", "\r", "/", "\x1b[B", "\r", "hix", "\x7f", "\r", "\x03", "!compact", "\r", "/exit", "\r"], 7],
    // The plain look (menu below, reverse video), Up and Down wrap around; Ctrl+D on an empty line.
    ["grok", { FAKE_EXIT: "4" }, ["/he", "\t", "\r", "/", "\x1b[B", "\x1b[A", "\x1b[A", "\x1b[B", "\r", "\x04"], 4],
    // Kitty keys; a paste is text.
    ["claude", { FAKE_KITTY: "1" }, ["\x1b[104u", "\x1b[105u", "\x1b[13u", "\x1b[99;5u", "\x1b[200~/clear\x1b[201~", "\r", "\x1b[100;5u"], 7],
    // The alternate screen; a hook that blocks /compact; Ctrl+C twice.
    ["claude", { FAKE_ALT: "1", FAKE_HOOK: "echo hooked; exit 2" }, ["/compact", "\r", "\x03", "\x03"], 130],
    // Esc closes the menu (the input stays), else clears the input.
    ["grok", {}, ["/he", "\x1b", "\r", "x", "\x1b", "/exit", "\r"], 7],
    // A /clear that takes a moment.
    ["claude", { FAKE_CLEAR_DELAY_MS: "200" }, ["/clear", "\r", "/exit", "\r"], 7],
    // OpenCode's look: Tab runs the highlighted item.
    ["opencode", {}, ["/c", "\t", "hi", "\r", "/exit", "\r"], 7],
    // Antigravity's look; a pinned menu (`!menu`), Tab completes its item.
    ["agy", {}, ["!menu", "\r", "\x1b[B", "\t", "\r", "/exit", "\r"], 7],
    // ←/→ move the cursor in the line (printed on an empty one, a modified one always), text and Backspace at it, Ctrl+U clears it.
    ["codex", {}, ["\x1b[D", "helo", "\x1b[D", "l", "\x1b[1;5D", "\x1b[C", "\x1b[D", "\x1b[D", "\x7f", "\r", "ab", "\x15", "/exit", "\r"], 7],
    // Antigravity has no /compact: `No matches`, Enter runs nothing; Esc closes the menu, Ctrl+U clears the line.
    ["agy", {}, ["/compact", "\r", "\x1b", "\x15", "/exit", "\r"], 7],
    // The perf suite's flood: 8 KB of coloured 40-cell rows (the same on both), then its marker; `!lines` and `!tick`'s interval.
    ["claude", {}, ["!flood 8 40", "\r", "!lines 3", "\r", "/exit", "\r"], 7],
  ];
  for (const [name, env, keys, exit] of TUI_CASES)
    test(`FAKE_TUI ${name} ${JSON.stringify(env)}: the same screen and exit code @full`, async () => {
      const sh = join(dir, name);
      if (!existsSync(sh)) {
        writeFileSync(sh, fakeScript(name));
        chmodSync(sh, 0o755);
      }
      const bash = await tui([sh, "-m", "x"], env, keys);
      const ts = await tui([process.execPath, TS, "-m", "x"], { ...env, FAKE_AGENT_NAME: name }, keys);
      expect(ts).toEqual(bash);
      expect(bash.code).toBe(exit);
    });
});
