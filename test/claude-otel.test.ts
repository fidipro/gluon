/**
 * BUG-675: Claude Code's usage must reach Gluon within seconds of a request (the cost figure), on every Claude Code version.
 * The env Gluon launches it with is pinned here; and, where a `claude` is installed, the real binary runs offline against a
 * fake Messages API and Gluon's own OTLP listener (no login, no key, no network beyond loopback).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onPath } from "../src/detect.ts";
import { startTelemetry, TELEMETRY_HEADER, telemetryLaunch, type UsageEvent } from "../src/telemetry.ts";

const SESSION = { token: "ab".repeat(24), endpoint: "http://127.0.0.1:4318" };

describe("BUG-675/claude-otel", () => {
  test("BUG-675/claude-otel: the env Gluon passes Claude Code (2.1.139 to 2.1.293) turns telemetry on, exports logs and metrics as OTLP http/json to the loopback listener every 2 s and 5 s, and exports no content", () => {
    const l = telemetryLaunch("claude-code", SESSION, { PATH: "/bin" })!;
    expect(l.argv).toEqual([]);
    expect(l.env).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_EXPORTER_OTLP_HEADERS: `${TELEMETRY_HEADER}=${SESSION.token}`,
      OTEL_METRIC_EXPORT_INTERVAL: "5000",
      OTEL_LOGS_EXPORT_INTERVAL: "2000",
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_ASSISTANT_RESPONSES: "0",
      OTEL_LOG_TOOL_DETAILS: "0",
      OTEL_LOG_TOOL_CONTENT: "0",
      OTEL_LOG_RAW_API_BODIES: "0",
    });
    // The `api_request` event that carries a request's usage is a log: its interval is what makes the figure arrive in seconds, not a minute (the default).
    expect(Number(l.env.OTEL_LOGS_EXPORT_INTERVAL)).toBeLessThanOrEqual(2000);
    expect(Number(l.env.OTEL_METRIC_EXPORT_INTERVAL)).toBeLessThanOrEqual(5000);
    // A variable of the user's own turns Gluon's off whole (theirs stay), whichever version.
    expect(telemetryLaunch("claude-code", SESSION, { OTEL_LOGS_EXPORT_INTERVAL: "60000" })).toBeNull();
  });

  const CLAUDE = onPath("claude");
  const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  test.skipIf(!CLAUDE)(
    "BUG-675/claude-otel: the installed claude sends a request's usage to Gluon's listener within seconds, while it is still running (offline: a fake Messages API) @full",
    async () => {
      const usage = { input_tokens: 1000, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const api = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          if (new URL(req.url).pathname !== "/v1/messages") return Response.json({});
          const j = (await req.json()) as { model: string };
          const message = { id: "msg_1", type: "message", role: "assistant", model: j.model, content: [] as unknown[], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } };
          const body =
            sse("message_start", { type: "message_start", message }) +
            sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
            sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }) +
            sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
            sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }) +
            sse("message_stop", { type: "message_stop" });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        },
      });
      const server = startTelemetry();
      const got: { usage: UsageEvent; at: number }[] = [];
      const session = server.session({ onUsage: (u) => got.push({ usage: u, at: Date.now() }) });
      const home = mkdtempSync(join(tmpdir(), "gluon-claude-otel-"));
      mkdirSync(join(home, "work"));
      mkdirSync(join(home, "cfg"));
      writeFileSync(join(home, "cfg", ".claude.json"), "{}");
      const proc = Bun.spawn([CLAUDE!, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-4-5"], {
        cwd: join(home, "work"),
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          CLAUDE_CONFIG_DIR: join(home, "cfg"),
          ANTHROPIC_API_KEY: "sk-ant-dummy00000000000000",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          // Exactly what Gluon passes a launch.
          ...telemetryLaunch("claude-code", session, {})!.env,
        },
      });
      try {
        const sent = Date.now();
        proc.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`);
        proc.stdin.flush();
        // The process stays up (it waits for more input): the usage must come from the periodic export, not from an exit flush.
        while (!got.length && Date.now() - sent < 20_000 && proc.exitCode === null) await Bun.sleep(100);
        const version = Bun.spawnSync([CLAUDE!, "--version"], { stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "", HOME: home, DISABLE_AUTOUPDATER: "1" } }).stdout.toString().trim();
        expect([version, got.length > 0]).toEqual([version, true]);
        expect(proc.exitCode).toBeNull();
        expect(got[0]!.at - sent).toBeLessThan(15_000);
        expect(got[0]!.usage).toMatchObject({ harness: "claude-code", model: "claude-sonnet-4-5", input: 1000, output: 20, cacheRead: 0, cacheWrite: 0 });
      } finally {
        proc.kill();
        await proc.exited;
        session.close();
        server.stop();
        api.stop(true);
        rmSync(home, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
