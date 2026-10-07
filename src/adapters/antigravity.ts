/**
 * Antigravity: nothing per launch. `/clear`, `/compact` and the return key are the PTY's
 * (`src/pty/`); agy has no event that could wait before an auto-compaction. Gluon writes no plugin
 * for it (`permanent.ts` removes v1's). Its token total comes from its status line (Gluon's own context
 * is computed from it; agy's own percentage only audits; agy has no cost, so Gluon shows none), only when
 * `cost.antigravity_statusline` is on (`agy-settings.ts`: one key in agy's own settings, the owner's
 * exception): the command runs `hook antigravity statusline`.
 */
import type { StatusInfo } from "../events.ts";
import { hookInput, statusEvent } from "./common.ts";
import { NO_ADAPTER, type Adapter } from "./types.ts";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Antigravity's status-line JSON (checked on 1.2.16, live) as a status. What Gluon COUNTS from it: the
 * conversation's size (`context_window.total_input_tokens`, which is what agy's own percentage is a share
 * of: not the billed input, and not `current_usage`, which is the last request's prompt) and the model
 * (absent when agy names it with a display name, `Gemini 3.8 Flash (Low)`: the launched one stands in).
 * What agy REPORTS: its percentage of its window (`used_percentage` of `context_window_size`, 0 until the
 * window is known) as `contextTokens` / `contextWindow`, and a cost it has none of (`cost.total_usd`): those go to the
 * audit ledger only, and are never shown (`src/gluon.ts`: the row's figures are Gluon's own). The command
 * runs on agent state changes, not per request; a `/clear` is a new conversation whose totals are zero.
 */
export function agyStatus(input: Record<string, unknown>): StatusInfo {
  const out: StatusInfo = {};
  const usd = num(rec(input.cost).total_usd);
  if (usd !== undefined) out.costUsd = usd;
  const ctx = rec(input.context_window);
  const size = num(ctx.context_window_size);
  const used = num(ctx.used_percentage);
  if (size && size > 0 && used !== undefined && used <= 100) {
    out.contextWindow = Math.round(size);
    out.contextTokens = Math.round((size * used) / 100);
  }
  const tin = num(ctx.total_input_tokens);
  const tout = num(ctx.total_output_tokens);
  if (tin !== undefined && tout !== undefined) out.totals = { input: Math.round(tin), output: Math.round(tout) };
  const model = rec(input.model).id;
  if (typeof model === "string" && /^[A-Za-z0-9._:/@[\]-]{1,128}$/.test(model)) out.model = model;
  return out;
}

export const antigravity: Adapter = {
  harness: "antigravity",
  build: () => NO_ADAPTER,
  notes: ({ handoff }) => [...(handoff.on_compact === "ask" ? ["auto-compaction: Antigravity compacts without asking (it has no hook that can wait)"] : [])],
  /** The status line's command (`agy-settings.ts`) calls `gluon hook antigravity statusline`; nothing else here is a hook. */
  async hook(name, input) {
    if (name !== "statusline") return {};
    const status = agyStatus(hookInput(input));
    return Object.keys(status).length ? { events: [statusEvent(status)] } : {};
  },
};
