/**
 * The brain on the user's own Claude plan: opt-in, personal use. It runs only through the official
 * Claude Agent SDK, which starts the user's own `claude` program with its own login. Gluon never
 * reads a token, never calls Anthropic's API itself in this mode, never sets ANTHROPIC_BASE_URL and
 * sends its own system prompt unchanged.
 */
import type { EffortLevel, Options, query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { binPath, missingReason } from "../detect.ts";
import type { LoopBrain, LoopHooks, ToolOutput } from "./session.ts";
import { TOOLS } from "./tools.ts";

const SERVER = "gluon";
const PREFIX = `mcp__${SERVER}__`;

/**
 * The environment for `claude`: the user's own, with nothing added but the SDK's documented app
 * name. No login token, no base URL: `claude` signs in on its own.
 */
export function subscriptionEnv(): Record<string, string | undefined> {
  return { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `gluon/${pkg.version}` };
}

/** What in the user's own environment changes how `claude` signs in; told to the user, never stripped. */
export function subscriptionEnvWarnings(): string[] {
  const out: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) out.push("ANTHROPIC_API_KEY is set in your environment, so `claude` may bill that key instead of your plan. Unset it to run on your plan.");
  if (process.env.ANTHROPIC_BASE_URL) out.push("ANTHROPIC_BASE_URL is set in your environment, so `claude` sends its requests there. Unset it to talk to Anthropic directly.");
  return out;
}

/**
 * The `claude` the SDK runs. On Windows it must be a native `claude.exe` (the SDK can't run a
 * `.cmd` shim, and cmd.exe would mangle its arguments); an npm shim counts when its exe is found.
 */
export function claudeExecutable(platform: NodeJS.Platform = process.platform, find: (bin: string) => string | undefined = binPath): string {
  const claude = find("claude");
  if (!claude) throw new Error(missingReason("claude"));
  if (platform === "win32" && !/\.exe$/i.test(claude)) throw new Error(`the intake agent on your Claude plan needs Claude Code's native claude.exe, but ${claude} was found. Install Claude Code with Anthropic's native Windows installer (install.ps1), then try again`);
  return claude;
}

/**
 * The query options: Gluon's prompt and tools only, none of the user's settings, hooks or
 * CLAUDE.md. `effort` goes as the SDK's own `effort` option (`sentEffort`), for this query only.
 */
export function subscriptionOptions(model: string, cwd: string, system: string, server: Options["mcpServers"], effort: EffortLevel | null = null): Options {
  const claude = claudeExecutable();
  return {
    pathToClaudeCodeExecutable: claude,
    model,
    ...(effort ? { effort } : {}),
    cwd,
    env: subscriptionEnv(),
    systemPrompt: system,
    tools: [],
    mcpServers: server,
    strictMcpConfig: true,
    allowedTools: TOOLS.map((t) => PREFIX + t.name),
    permissionMode: "dontAsk",
    settingSources: [],
    includePartialMessages: true,
    persistSession: false,
  };
}

/** A push queue the query reads the developer's messages from. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(text: string) {
    this.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    this.wake?.();
  }

  close() {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.queue.shift();
      if (next) yield next;
      else if (this.closed) return;
      else await new Promise<void>((r) => (this.wake = r));
    }
  }
}

type Turn = { hooks: LoopHooks; resolve: () => void; reject: (e: Error) => void };

/**
 * The brain on the user's plan. One SDK query lives for the whole session (streaming input), so the
 * conversation needs nothing saved to disk. `run` is the SDK's `query`, replaceable in tests.
 */
export function subscriptionBrain(model: string, cwd: string, run?: typeof query, effort: EffortLevel | null = null): LoopBrain {
  type Live = { inbox: Inbox; interrupt: () => Promise<unknown>; close: () => void; used: boolean };
  let live: Live | null = null;
  let turn: Turn | null = null;
  /** `claude` stopped after a conversation: the next one starts without it (the developer is told). */
  let lost = false;

  // The SDK is imported when the first turn starts, not with this module: a start-up that never asks the
  // plan brain (the demo, most e2e runs) doesn't pay for it.
  let sdk: Promise<{ run: typeof query; server: NonNullable<Options["mcpServers"]>[string] }> | null = null;
  const load = () =>
    (sdk ??= import("@anthropic-ai/claude-agent-sdk").then(({ createSdkMcpServer, query, tool }) => ({
      run: run ?? query,
      server: createSdkMcpServer({
        name: SERVER,
        version: pkg.version,
        tools: TOOLS.map((t) =>
          tool(t.name, t.description ?? "", (z.fromJSONSchema(t.input_schema as never) as z.ZodObject).shape, async (args) => {
            const out: ToolOutput = turn ? await turn.hooks.tool(t.name, args as Record<string, unknown>) : { content: "No turn in progress.", error: true };
            return { content: [{ type: "text", text: out.content }], ...(out.error ? { isError: true } : {}) };
          }),
        ),
      }),
    })));

  /** Bumped by `close()`: a start that began before it must not outlive it. */
  let generation = 0;
  /** The start in flight, so sends before `live` is set share one query. */
  let starting: Promise<Live> | null = null;

  const begin = (system: string) => {
    const p: Promise<Live> = start(system).finally(() => {
      if (starting === p) starting = null;
    });
    return p;
  };

  const start = async (system: string) => {
    const born = generation;
    const { run, server } = await load();
    if (born !== generation) throw new Error("the intake agent was closed");
    const inbox = new Inbox();
    const q = run({ prompt: inbox, options: subscriptionOptions(model, cwd, system, { [SERVER]: server }, effort) });
    const session = { inbox, interrupt: () => q.interrupt(), close: () => (inbox.close(), q.close()), used: false };
    live = session;
    void (async () => {
      let content: Anthropic.ContentBlock[] = [];
      try {
        for await (const m of q as AsyncIterable<SDKMessage>) {
          if (m.type === "stream_event" && !m.parent_tool_use_id) {
            const e = m.event;
            if (e.type === "message_start") {
              content = [];
              turn?.hooks.begin();
            } else if (e.type === "content_block_start") {
              const b = e.content_block;
              if (b.type === "text") content.push({ type: "text", text: "", citations: null });
              else if (b.type === "tool_use") content.push({ ...b, name: b.name.replace(PREFIX, "") } as Anthropic.ContentBlock);
            } else if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
              const last = content.at(-1);
              if (last?.type === "text") last.text += e.delta.text;
              turn?.hooks.text(e.delta.text);
            } else if (e.type === "message_stop") {
              turn?.hooks.end(content);
            }
          } else if (m.type === "result") {
            const t = turn;
            turn = null;
            if (m.subtype === "success" && !m.is_error) t?.resolve();
            else t?.reject(new Error(resultError(m)));
          }
        }
        throw new Error("the intake agent stopped");
      } catch (e) {
        if (live === session) {
          live = null;
          lost ||= session.used;
        }
        const t = turn;
        turn = null;
        t?.reject(e as Error);
      }
    })();
    return session;
  };

  return {
    send(text, system, hooks, signal) {
      return new Promise<void>((resolve, reject) => {
        const restarted = !live && lost;
        const mine: Turn = { hooks, resolve, reject };
        turn = mine;
        if (restarted) {
          lost = false;
          hooks.restarted?.();
        }
        void (async () => {
          const session = live ?? (await (starting ??= begin(system)));
          const stop = () => void session.interrupt().catch(() => {});
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
          session.used = true;
          session.inbox.push(text);
        })().catch((e) => {
          if (turn === mine) turn = null;
          reject(e as Error);
        });
      });
    },
    close() {
      generation++;
      starting = null;
      live?.close();
      live = null;
    },
  };
}

/** A readable reason from a failed result. */
function resultError(m: Extract<SDKMessage, { type: "result" }>): string {
  if ("result" in m && typeof m.result === "string" && m.result.trim()) return m.result.trim();
  if ("errors" in m && Array.isArray(m.errors) && m.errors.length) return m.errors.join("; ");
  return m.subtype === "error_max_turns" ? "the intake agent took too many steps" : "the intake agent's turn failed";
}
