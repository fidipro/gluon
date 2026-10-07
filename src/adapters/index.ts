import type { Harness } from "../harnesses.ts";
import { antigravity } from "./antigravity.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { grokBuild } from "./grok-build.ts";
import { kimiCode } from "./kimi-code.ts";
import { opencode } from "./opencode.ts";
import { NO_ADAPTER, type Adapter, type AdapterContext, type AdapterOutput } from "./types.ts";

export const ADAPTERS: Record<Harness, Adapter> = { "claude-code": claudeCode, codex, opencode, "grok-build": grokBuild, antigravity, "kimi-code": kimiCode };

/** `1.2.3` vs `1.10` by numeric parts; a missing part is 0. */
export function versionAtLeast(version: string, min: string): boolean {
  const parts = (v: string) => (v.match(/\d+(\.\d+)*/)?.[0] ?? "").split(".").map(Number);
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

/** What to add to this launch: nothing when the installed version is below the adapter's minimum or unknown. */
export function adapterOutput(ctx: AdapterContext): AdapterOutput {
  const a = ADAPTERS[ctx.harness];
  if (a.minVersion && (!ctx.version || !versionAtLeast(ctx.version, a.minVersion))) return NO_ADAPTER;
  return a.build(ctx);
}
