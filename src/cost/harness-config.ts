/**
 * The only module that names a harness's config files (issue #39; `test/rules.test.ts` allowlists
 * it). It reads named keys only, never credentials: Claude Code's `promptCacheTtl` and
 * `subagentPromptCacheTtl` from its settings files, and from nothing else (not the `env` block, not
 * another key, not the account or credentials files). The settings of the user's repo are
 * untrusted input: size-capped, parsed in a `try`, and only the literal values `"5m"` / `"1h"` count.
 * The reader is injectable (`readFile`), so a test can prove which files get opened.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type CacheTtl = "5m" | "1h";

/** What Claude Code's settings and environment say of the cache TTL: absent where they say nothing (then its automatic rule applies: `CostTracker`). */
export interface ClaudeCacheTtl {
  main?: CacheTtl;
  subagent?: CacheTtl;
}

/** The most a settings file may weigh to be read at all: a repo's file is not trusted to be small. */
export const MAX_SETTINGS_BYTES = 256 * 1024;

/** Reads a file as text, or undefined when it can't be read, isn't a file, or is over `MAX_SETTINGS_BYTES`. */
export function readSettingsFile(path: string): string | undefined {
  try {
    const s = statSync(path);
    if (!s.isFile() || s.size > MAX_SETTINGS_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const ttl = (v: unknown): CacheTtl | undefined => (v === "5m" || v === "1h" ? v : undefined);
const on = (v: string | undefined) => !!v && !/^(0|false)$/i.test(v);

/** The two TTL keys of one settings file's text; nothing else of it is looked at. */
function keysOf(text: string | undefined): ClaudeCacheTtl {
  if (text === undefined || text.length > MAX_SETTINGS_BYTES) return {};
  try {
    const j: unknown = JSON.parse(text);
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const main = ttl(Object.hasOwn(j, "promptCacheTtl") ? (j as Record<string, unknown>).promptCacheTtl : undefined);
    const subagent = ttl(Object.hasOwn(j, "subagentPromptCacheTtl") ? (j as Record<string, unknown>).subagentPromptCacheTtl : undefined);
    return { ...(main ? { main } : {}), ...(subagent ? { subagent } : {}) };
  } catch {
    return {};
  }
}

/**
 * The cache TTL Claude Code writes its prompt cache at, where the user has said so, in Claude Code's
 * own order (2.1.289): `FORCE_PROMPT_CACHING_5M`; the `CLAUDE_CODE_PROMPT_CACHE_TTL` /
 * `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` variables; the settings (local `<cwd>/.claude/settings.local.json`,
 * then project `<cwd>/.claude/settings.json`, then user `settings.json` in `CLAUDE_CONFIG_DIR` or `<home>/.claude`);
 * then `ENABLE_PROMPT_CACHING_1H` (`bedrock`: its `_BEDROCK` twin). Managed (organisation) settings and
 * `--settings` are not read. A side left undefined is Claude's automatic rule, which the caller assumes.
 */
export function claudeCacheTtl({ home, cwd, env = {}, bedrock = false, readFile = readSettingsFile }: { home: string; cwd: string; env?: Record<string, string | undefined>; bedrock?: boolean; readFile?: (path: string) => string | undefined }): ClaudeCacheTtl {
  if (on(env.FORCE_PROMPT_CACHING_5M)) return { main: "5m", subagent: "5m" };
  let main = ttl(env.CLAUDE_CODE_PROMPT_CACHE_TTL);
  let subagent = ttl(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL);
  if (!main || !subagent) {
    const userDir = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : join(home, ".claude");
    for (const file of [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"), join(userDir, "settings.json")]) {
      const k = keysOf(readFile(file));
      main ??= k.main;
      subagent ??= k.subagent;
    }
  }
  if (on(env.ENABLE_PROMPT_CACHING_1H) || (bedrock && on(env.ENABLE_PROMPT_CACHING_1H_BEDROCK))) {
    main ??= "1h";
    subagent ??= "1h";
  }
  return { ...(main ? { main } : {}), ...(subagent ? { subagent } : {}) };
}
