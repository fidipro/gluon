/**
 * Grok Build: nothing per launch. Gluon's own hooks file in grok's hooks directory
 * (`permanent.ts`) calls `hook grok-build pre-compact` here, only inside a Gluon launch, so an
 * auto-compaction asks first (`/clear`, a typed `/compact` and the return key are the PTY's).
 * grok's `PreCompact` can't stop a compaction (its hooks guide: passive): on a yes Gluon ends
 * grok, which is what stops it. The same file's status hooks land in `statusHook` (display only).
 */
import { askBeforeCompact, hookInput, statusHook } from "./common.ts";
import { NO_ADAPTER, type Adapter } from "./types.ts";

export const grokBuild: Adapter = {
  harness: "grok-build",
  // The hooks file's format, as checked (`permanent.ts`).
  minVersion: "1.0.46",
  build: () => NO_ADAPTER,
  notes: ({ handoff }) => [
    handoff.on_compact === "ask"
      ? "auto-compaction asks first whether to end the session instead, through Gluon's hook file in Grok Build's hooks directory"
      : "auto-compaction: Grok Build compacts (on_compact: stay)",
    "its status and latest activity show in Gluon, through the same hook file",
  ],
  async hook(name, input, { eventsDir, pieces, answerTimeoutMs }) {
    if (name === "pre-compact") {
      await askBeforeCompact(eventsDir, pieces, answerTimeoutMs);
      return {};
    }
    return statusHook(name, hookInput(input)) ?? {};
  },
};
