/**
 * The poll behind "n files changed" (Gluon's header count, and each session's own since its start).
 * One `git status` snapshot of the work tree Gluon runs in per poll, shared by every session. A snapshot costs three
 * git processes (`statusSnapshot`: the repository check and the filter check run again at every
 * one on purpose, since the agent can rewrite the repository's config between polls: BUG-139).
 */
import { changedSince, statusSnapshot } from "./agent/tools.ts";

export interface PolledSession {
  id: number;
  /** The status when the session started: its figure counts the paths that differ from it. */
  base: Map<string, string>;
}

export interface FilesPoll {
  /** The work tree Gluon runs in. */
  header: Map<string, string>;
  /** Per session id: its files changed since its start. */
  changed: Map<number, number>;
}

/** Null when the work tree Gluon runs in can't be read (nothing is updated then). */
export async function pollChanges(cwd: string, sessions: Iterable<PolledSession>, snapshot: (root: string) => Promise<Map<string, string> | null> = statusSnapshot): Promise<FilesPoll | null> {
  const header = await snapshot(cwd);
  if (!header) return null;
  const changed = new Map<number, number>();
  for (const s of sessions) changed.set(s.id, changedSince(s.base, header));
  return { header, changed };
}
