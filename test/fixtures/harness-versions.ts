/**
 * The harness versions the fakes claim to be: the pinned ones (`test/harnesses.json`, written by
 * `bun scripts/harness-pin.ts --bump`), so a fake is never older than the real binary the live checks run.
 * A test that prints a version reads it from here, never a literal: the pin moves with every harness release.
 */
import pin from "../harnesses.json" with { type: "json" };

/** Each harness's pinned version, by the fake's binary name. */
export const PINNED = {
  claude: pin["claude-code"].version,
  codex: pin.codex.version,
  agy: pin.antigravity.version,
  grok: pin["grok-build"].version,
  opencode: pin.opencode.version,
  kimi: pin["kimi-code"].version,
} as const;

export type FakeName = keyof typeof PINNED;

/** What each fake answers to `--version`: the real binary's wording around the pinned version. */
export const FAKE_VERSIONS: Record<FakeName, string> = {
  claude: `${PINNED.claude} (Claude Code)`,
  codex: `codex-cli ${PINNED.codex}`,
  agy: PINNED.agy,
  grok: `grok ${PINNED.grok} (fake) [stable]`,
  opencode: `opencode v${PINNED.opencode}`,
  kimi: PINNED.kimi,
};
