import type { Harness } from "../../harnesses.ts";
import type { ScreenReader } from "../types.ts";
import { antigravity } from "./antigravity.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { grok } from "./grok.ts";
import { kimiCode } from "./kimi-code.ts";
import { opencode } from "./opencode.ts";

/**
 * One reader per harness, each written against screens captured from the real harness
 * (`test/fixtures/screens/<harness>/<version>.json`; re-capture after a harness update).
 */
export const READERS: Record<Harness, ScreenReader> = {
  "claude-code": claudeCode,
  codex,
  opencode,
  "grok-build": grok,
  antigravity,
  "kimi-code": kimiCode,
};

/**
 * The slash commands that mean /clear and /compact in each harness. OpenCode 2.0 has no
 * `/summarize` (1.x's alias) and lists `/compact` only inside a session. Antigravity 1.2.14 has
 * no manual compaction (its menu says "No matches" for /compact) and shows /new as "/clear (new)".
 */
export const COMMANDS: Record<Harness, { clear: string[]; compact: string[] }> = {
  "claude-code": { clear: ["/clear", "/new", "/reset"], compact: ["/compact"] },
  codex: { clear: ["/clear", "/new"], compact: ["/compact"] },
  opencode: { clear: ["/clear", "/new"], compact: ["/compact"] },
  "grok-build": { clear: ["/clear", "/new"], compact: ["/compact"] },
  antigravity: { clear: ["/clear", "/new"], compact: [] },
  // /clear is /new's alias: the menu lists "new (clear)".
  "kimi-code": { clear: ["/clear", "/new"], compact: ["/compact"] },
};

/** Harnesses whose slash menu runs the highlighted item on Tab as well as on Enter. */
export const TAB_RUNS: ReadonlySet<Harness> = new Set<Harness>(["opencode"]);
