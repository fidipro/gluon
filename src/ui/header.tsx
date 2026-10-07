import { Box, Text } from "ink";
import type { SessionState } from "../sessions.ts";
import { countsSegs, fitSegs, headerTop, whereSegs, type Seg } from "./layout.ts";
import { Mark, MARK_WIDTH } from "./mark.tsx";
import type { GluonPalette } from "./theme.ts";
import { useWidth } from "./width.tsx";

/** Segments as one line of text, each in its colour role. */
export function Segs({ segs, palette, wrap = "truncate-end" }: { segs: readonly Seg[]; palette: GluonPalette; wrap?: "truncate-end" | "wrap" }) {
  return (
    <Text wrap={wrap}>
      {segs.map((s, i) => (
        <Text key={i} color={palette[s.role]} bold={s.bold}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** What the header shows. */
export interface HeaderInfo {
  /** Gluon's version (package.json). */
  version: string;
  /** `owner/name` from the git remote, else the directory's name. */
  repo: string;
  branch?: string | null;
  /** Files modified in the work tree (`git status`); unknown: left out. */
  modified?: number;
  /** The saved workspace's id, once a session was launched (`gluon resume <id>`); nothing before. */
  workspace?: string;
}

/** Columns between the mark and the header's text. */
const MARK_GAP = 2;

/**
 * Gluon's header: the mark, then `Gluon v1.0.0`,
 * `<repo> · <branch> · <n> modified`, and the sessions' counts, `no sessions yet` or (`ran`: one
 * was launched) `no sessions running`.
 * On a narrow terminal lines are cut with `…`.
 */
export function Header({ info, counts, ran = false, palette }: { info: HeaderInfo; counts: Record<SessionState, number>; ran?: boolean; palette: GluonPalette }) {
  const width = useWidth() - MARK_WIDTH - MARK_GAP;
  return (
    <Box flexShrink={0}>
      <Mark palette={palette} />
      <Box flexDirection="column" marginLeft={MARK_GAP} width={width} flexShrink={0}>
        <Segs segs={headerTop(width, info.version)} palette={palette} />
        <Segs segs={fitSegs(whereSegs(info.repo, info.branch, info.modified, info.workspace), width)} palette={palette} />
        <Segs segs={fitSegs(countsSegs(counts, ran), width)} palette={palette} />
      </Box>
    </Box>
  );
}
