/**
 * What running a real harness binary on the loopback model API needs, for the real tier (test/real/) and the screen capture
 * (scripts/capture-screens.ts): the harnesses that can, the API-key connection and fake key each uses, their switches against
 * phoning home, and the files a user who already went through the harness's first run has.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "../../src/harnesses.ts";

/** The harnesses that can be pointed at a loopback model API, and the API-key connection each uses. */
export const REAL_HARNESSES = { "claude-code": "anthropic", codex: "openai", opencode: "openrouter", "kimi-code": "openrouter" } as const;
export type RealHarness = keyof typeof REAL_HARNESSES;
export const KEYS = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" } as const;
/** The harnesses' own switches against phoning home (telemetry, updates, error reports): the run stays on loopback. */
export const QUIET = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_TELEMETRY: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_PROXY: "127.0.0.1" };

export const KEY_VALUE = (k: string) => `sk-fake-${k.toLowerCase()}-0123456789`;

/**
 * The scratch HOME of a user who already went through the harness's first run (its theme, its "use this API key?" and its folder
 * trust): the harness's own files, in the scratch HOME only.
 */
export function firstRunDone(h: Harness, home: string, repo: string, key: string): void {
  if (h === "claude-code")
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects: { [repo]: { hasTrustDialogAccepted: true } } }));
}
