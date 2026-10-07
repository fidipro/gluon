/**
 * `src/cost/harness-config.ts` (issue #39): Claude Code's cache TTL from its settings and environment, named keys only.
 * The user's repo is untrusted: what it reads is capped, parsed defensively and limited to "5m" / "1h".
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCacheTtl, MAX_SETTINGS_BYTES, readSettingsFile } from "../src/cost/harness-config.ts";

const fake = (files: Record<string, string>) => {
  const opened: string[] = [];
  // The keys are written with "/"; on Windows `join` makes the paths with "\\".
  return { opened, readFile: (f: string) => (opened.push(f), files[f.replaceAll("\\", "/")]) };
};

describe("claudeCacheTtl", () => {
  test("precedence: local settings, then project, then user, key by key", () => {
    const { readFile } = fake({
      "/p/.claude/settings.local.json": '{"promptCacheTtl":"5m"}',
      "/p/.claude/settings.json": '{"promptCacheTtl":"1h","subagentPromptCacheTtl":"1h"}',
      "/h/.claude/settings.json": '{"promptCacheTtl":"1h","subagentPromptCacheTtl":"5m"}',
    });
    expect(claudeCacheTtl({ home: "/h", cwd: "/p", readFile })).toEqual({ main: "5m", subagent: "1h" });
    expect(claudeCacheTtl({ home: "/h", cwd: "/q", readFile })).toEqual({ main: "1h", subagent: "5m" });
    expect(claudeCacheTtl({ home: "/none", cwd: "/q", readFile })).toEqual({});
  });

  test("CLAUDE_CONFIG_DIR moves the user settings; the environment goes before the settings, FORCE_PROMPT_CACHING_5M before all, ENABLE_PROMPT_CACHING_1H after", () => {
    const { readFile } = fake({ "/cfg/settings.json": '{"promptCacheTtl":"1h"}', "/h/.claude/settings.json": '{"promptCacheTtl":"5m"}' });
    expect(claudeCacheTtl({ home: "/h", cwd: "/p", env: { CLAUDE_CONFIG_DIR: "/cfg" }, readFile })).toEqual({ main: "1h" });
    expect(claudeCacheTtl({ home: "/h", cwd: "/p", env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h", CLAUDE_CONFIG_DIR: "/cfg" }, readFile })).toEqual({ main: "5m", subagent: "1h" });
    expect(claudeCacheTtl({ home: "/h", cwd: "/p", env: { FORCE_PROMPT_CACHING_5M: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, readFile })).toEqual({ main: "5m", subagent: "5m" });
    expect(claudeCacheTtl({ home: "/h", cwd: "/p", env: { ENABLE_PROMPT_CACHING_1H: "1" }, readFile })).toEqual({ main: "5m", subagent: "1h" });
    expect(claudeCacheTtl({ home: "/h", cwd: "/p", env: { ENABLE_PROMPT_CACHING_1H_BEDROCK: "1" }, readFile })).toEqual({ main: "5m" });
    expect(claudeCacheTtl({ home: "/none", cwd: "/p", env: { ENABLE_PROMPT_CACHING_1H_BEDROCK: "1" }, bedrock: true, readFile })).toEqual({ main: "1h", subagent: "1h" });
    expect(claudeCacheTtl({ home: "/none", cwd: "/p", env: { ENABLE_PROMPT_CACHING_1H: "0" }, readFile })).toEqual({});
  });

  test("a repo's settings are untrusted: only the literal \"5m\" / \"1h\" count; not JSON, not an object, too large, prototype keys and wrong types are ignored", () => {
    const big = `{"promptCacheTtl":"1h","pad":"${"x".repeat(MAX_SETTINGS_BYTES)}"}`;
    for (const text of ["{nope", "[]", "null", "42", '"1h"', big, '{"promptCacheTtl":"2h"}', '{"promptCacheTtl":"1H"}', '{"promptCacheTtl":["1h"]}', '{"promptCacheTtl":1}', '{"__proto__":{"promptCacheTtl":"1h"}}', '{"promptCacheTtl":"1h\\u0000"}', ""]) {
      expect([text.slice(0, 30), claudeCacheTtl({ home: "/h", cwd: "/p", readFile: () => text })]).toEqual([text.slice(0, 30), {}]);
    }
    // An invalid value in a higher file does not hide a valid one below it; a throwing reader is no settings.
    const { readFile } = fake({ "/p/.claude/settings.local.json": '{"promptCacheTtl":"never"}', "/h/.claude/settings.json": '{"promptCacheTtl":"1h"}' });
    expect(claudeCacheTtl({ home: "/h", cwd: "/p", readFile })).toEqual({ main: "1h" });
    expect(readSettingsFile(join(tmpdir(), "gluon-no-such-settings.json"))).toBeUndefined();
  });

  test("the default reader refuses a directory and a file over the cap, reads a small file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-hc-"));
    mkdirSync(join(dir, "a-dir"));
    writeFileSync(join(dir, "small.json"), '{"promptCacheTtl":"1h"}');
    writeFileSync(join(dir, "big.json"), "x".repeat(MAX_SETTINGS_BYTES + 1));
    expect(readSettingsFile(join(dir, "a-dir"))).toBeUndefined();
    expect(readSettingsFile(join(dir, "big.json"))).toBeUndefined();
    expect(readSettingsFile(join(dir, "small.json"))).toBe('{"promptCacheTtl":"1h"}');
  });

  test("BUG-333/never-credentials: over a home holding every credential file, only the three settings files are opened, and no other key (the env block included) is read", () => {
    const home = mkdtempSync(join(tmpdir(), "gluon-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "gluon-cwd-"));
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"sk-ant-oat-secret"}}');
    writeFileSync(join(home, ".claude.json"), '{"oauthAccount":{"emailAddress":"x@example.com"},"promptCacheTtl":"1h"}');
    writeFileSync(join(home, ".codex", "auth.json"), '{"OPENAI_API_KEY":"sk-secret","promptCacheTtl":"1h"}');
    writeFileSync(join(home, ".claude", "settings.json"), '{"env":{"CLAUDE_CODE_PROMPT_CACHE_TTL":"1h","ANTHROPIC_API_KEY":"sk-ant-secret"},"apiKeyHelper":"echo secret","model":"opus","hooks":{"Stop":[]},"promptCacheTtl":"5m","unrelated":"1h"}');
    writeFileSync(join(cwd, ".claude", "settings.json"), '{"env":{"CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL":"1h"},"permissions":{"allow":["Bash"]},"ttl":"1h"}');
    const opened: string[] = [];
    const spy = (f: string) => {
      opened.push(f);
      return readSettingsFile(f);
    };
    const ttl = claudeCacheTtl({ home, cwd, env: {}, readFile: spy });
    // The allowlist: the three settings files, nothing of the credentials, account or other tools' files.
    const allowed = [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"), join(home, ".claude", "settings.json")];
    expect(opened.every((f) => allowed.includes(f))).toBe(true);
    expect(opened.some((f) => /credentials|\.claude\.json$|auth\.json/.test(f))).toBe(false);
    // Only the two keys count: the env block's TTL variables and every other key are ignored.
    expect(ttl).toEqual({ main: "5m" });
    // Even a CLAUDE_CONFIG_DIR pointing at the credentials' folder opens only its settings.json.
    opened.length = 0;
    claudeCacheTtl({ home, cwd, env: { CLAUDE_CONFIG_DIR: join(home, ".claude") }, readFile: spy });
    expect(opened.every((f) => allowed.includes(f))).toBe(true);
  });
});
