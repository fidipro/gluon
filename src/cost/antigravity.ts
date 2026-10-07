/**
 * Antigravity's context (issue #39, live run 2 on agy 1.2.16). agy reports NO cost, and its status line
 * is no source for one: `context_window.total_input_tokens` is the conversation's SIZE (it grows by what
 * each turn adds, not by what the requests billed, which re-send the history), the command runs less often
 * than requests are made, and a subagent's tokens are not in it. So Gluon shows no cost for Antigravity
 * (`—`) until a per-request source exists (issue #76); there is no price here.
 *
 * Its context, though, IS that size: agy's own `used_percentage` is exactly `total_input_tokens` over
 * `context_window_size`, so Gluon counts the same tokens (`ctx.total_input_tokens`) over its own window
 * (`agyWindow`, models.dev) and agy's percentage only audits it. After `/clear` agy starts a new
 * conversation whose totals are zero again: the next reading is the new size, never the old one.
 */
import { priceEntry, type ModelsDevTable } from "./tables.ts";

/** agy names a model with its effort (`gemini-3.8-flash-high`, as it is launched): the table's id has none. */
export const agyModelId = (id: string): string => id.replace(/-(minimal|low|medium|high)$/, "");

/**
 * The window Gluon sizes an Antigravity session by: models.dev's `limit.context` of the Google entry
 * (1,048,576 for Gemini 3.x; agy's own window is whatever it reports, which is only audited), or
 * undefined for a model the table doesn't list.
 */
export const agyWindow = (model: string, table?: ModelsDevTable): number | undefined => priceEntry(`google/${agyModelId(model)}`, table)?.context ?? undefined;

/**
 * The conversation size to show for a status-line reading, or undefined when the row already has it: the reading's
 * `total_input_tokens`, whatever else it holds (a `/clear` reading has no `current_usage` and totals of zero; it is
 * the new conversation's size, not the old one's to keep: BUG-389). `shown`: the tokens the row is computed from now.
 */
export const agyContextTokens = (totals: { input: number }, shown: number | undefined): number | undefined => (totals.input === shown ? undefined : totals.input);
