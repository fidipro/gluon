/**
 * Kimi Code: nothing per launch. `/clear` (an alias of `/new`), `/compact` and the return key are the PTY's (`src/pty/`);
 * Kimi's hooks (`SessionStart`, `Stop`, …) exist only in its own config.toml, which Gluon never edits, so there is no
 * hook that could wait before an auto-compaction, report the session's id or the agent's status. Its modes ride with the
 * launch (`HARNESS_INFO["kimi-code"].modes`), not here.
 */
import { NO_ADAPTER, type Adapter } from "./types.ts";

export const kimiCode: Adapter = {
  harness: "kimi-code",
  build: () => NO_ADAPTER,
  notes: ({ handoff }) => [
    ...(handoff.on_compact === "ask" ? ["auto-compaction: Kimi Code compacts without asking (its hooks live in its own config, which Gluon doesn't edit)"] : []),
    "its status and activity don't show in Gluon (no hook Gluon may set), and it can't be resumed from Gluon",
  ],
};
