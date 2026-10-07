/**
 * The poll behind "n files changed" (Gluon's header count, and each session's own since its start).
 * One `git status` snapshot per work tree per poll, shared by every session in it; sessions in
 * their own worktree (`worktree.ts`) each have a work tree of their own. A snapshot costs three
 * git processes (`statusSnapshot`: the repository check and the filter check run again at every
 * one on purpose, since the agent can rewrite the repository's config between polls: BUG-139).
 */
import { resolve } from "node:path";
import { changedSince, statusSnapshot } from "./agent/tools.ts";

export interface PolledSession {
  id: number;
  /** The status when the session started: its figure counts the paths that differ from it. */
  base: Map<string, string>;
  /** The session's own work tree; none: the work tree Gluon runs in. */
  worktree?: string;
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
  // Keyed by resolved path: two names for one work tree take one snapshot.
  const taken = new Map<string, Promise<Map<string, string> | null>>([[resolve(cwd), Promise.resolve(header)]]);
  const changed = new Map<number, number>();
  for (const s of sessions) {
    const root = resolve(s.worktree ?? cwd);
    let now = taken.get(root);
    if (!now) taken.set(root, (now = snapshot(root)));
    const snap = await now;
    // The agent creates its worktree: until it does, nothing has changed.
    changed.set(s.id, snap ? changedSince(s.base, snap) : 0);
  }
  return { header, changed };
}
