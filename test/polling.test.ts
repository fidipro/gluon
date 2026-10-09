/** The per-session polls (QA-perf-03): files changed share one git snapshot per work tree; an events directory that did not change is not listed again. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS_PER_READ, EventsWatch, FULL_LIST_MS, RACY_MS, createEventsDir, removeEventsDir, scanEvents, writeEvent } from "../src/events.ts";
import { pollChanges, type PolledSession } from "../src/files-poll.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-polling-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const WIN = process.platform === "win32";

const snap = (...paths: string[]) => new Map(paths.map((p) => [p, " M"]));

/** A `snapshot` seam that counts the roots it is asked for. */
function counting(by: Record<string, Map<string, string> | null>) {
  const asked: string[] = [];
  return { asked, snapshot: async (root: string) => (asked.push(root), by[root] ?? null) };
}

describe("files changed: one snapshot per work tree", () => {
  test("BUG-668/QA-perf-03: sessions in the work tree Gluon runs in share one snapshot, each counted from its own start", async () => {
    const c = counting({ "/repo": snap("a", "b", "c") });
    const sessions: PolledSession[] = [1, 2, 3, 4, 5].map((id) => ({ id, base: id === 1 ? new Map() : snap("a") }));
    const r = await pollChanges("/repo", sessions, c.snapshot);
    expect(c.asked).toEqual(["/repo"]);
    expect(r!.header.size).toBe(3);
    expect([...r!.changed]).toEqual([[1, 3], [2, 2], [3, 2], [4, 2], [5, 2]]);
  });

  test("an unreadable work tree for Gluon polls nothing", async () => {
    const none = counting({});
    expect(await pollChanges("/repo", [{ id: 1, base: new Map() }], none.snapshot)).toBeNull();
    expect(none.asked).toEqual(["/repo"]);
  });

  test.skipIf(WIN)("BUG-668/QA-perf-03: git processes per poll: three for the work tree, whatever the number of sessions", async () => {
    const real = Bun.which("git")!;
    const repo = join(TMP, "repo");
    mkdirSync(repo);
    const g = (...a: string[]) => Bun.spawnSync([real, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env: process.env });
    g("init", "-q");
    writeFileSync(join(repo, "a.txt"), "1\n");
    g("add", ".");
    g("commit", "-qm", "init");
    const bin = join(TMP, "bin");
    const log = join(TMP, "git.log");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho x >> '${log}'\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const was = process.env.PATH;
    process.env.PATH = `${bin}:${was}`;
    const spawned = () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").length;
      } catch {
        return 0;
      }
    };
    try {
      const sessions = (n: number): PolledSession[] => Array.from({ length: n }, (_, i) => ({ id: 1 + i, base: new Map() }));
      await pollChanges(repo, sessions(6));
      expect(spawned()).toBe(3);
      rmSync(log);
      writeFileSync(join(repo, "new.txt"), "x\n");
      const r = await pollChanges(repo, sessions(12));
      expect(spawned()).toBe(3);
      expect(r!.changed.get(1)).toBe(1);
      expect(r!.changed.get(12)).toBe(1);
    } finally {
      process.env.PATH = was;
    }
  });
});

describe("an events directory", () => {
  const fresh = () => createEventsDir(TMP).dir;
  /** A watch whose scans are counted; its clock runs `ahead` ms after the real one (the directory's own times then count as old). */
  function watch(dir: string, ahead = 10_000, skipping = true) {
    const scans = { n: 0 };
    const w = new EventsWatch(dir, { scan: (d, seen, limit) => (scans.n++, scanEvents(d, seen, limit)), now: () => Date.now() + ahead, skipping });
    return { w, scans };
  }
  const names = (es: { name: string }[]) => es.map((e) => e.name);
  /** Past the file system's timestamp tick, so the next change leaves a different time (the clock above is fake; in Gluon a change within `RACY_MS` is never trusted). */
  const tick = () => Bun.sleep(25);

  test("BUG-668/QA-perf-03: a directory that did not change is not listed again; a new event is read at once", async () => {
    const dir = fresh();
    try {
      const { w, scans } = watch(dir);
      writeEvent(dir, { name: "back" });
      expect(names(w.read())).toEqual(["back"]);
      expect(scans.n).toBe(1);
      for (let i = 0; i < 50; i++) expect(w.read()).toEqual([]);
      expect(scans.n).toBe(1);
      await tick();
      writeEvent(dir, { name: "compact", id: "abc" });
      expect(names(w.read())).toEqual(["compact"]);
      expect(scans.n).toBe(2);
    } finally {
      removeEventsDir(dir);
    }
  });

  test("BUG-668/QA-perf-03: a status file is removed once read; the listing that follows is the last one until something changes", async () => {
    const dir = fresh();
    try {
      const { w, scans } = watch(dir);
      writeEvent(dir, { name: "status", status: { state: "working" } });
      await tick();
      expect(names(w.read())).toEqual(["status"]);
      w.read(); // the removal changed the directory: one more listing
      const after = scans.n;
      for (let i = 0; i < 20; i++) w.read();
      expect(scans.n).toBe(after);
      expect(after).toBe(2);
    } finally {
      removeEventsDir(dir);
    }
  });

  test("BUG-668/QA-perf-03: a change within the racy window is never taken as 'nothing new' (same clock tick as the listing)", () => {
    const dir = fresh();
    try {
      const { w, scans } = watch(dir, 0); // the clock is the real one: the directory changed just now
      writeEvent(dir, { name: "back" });
      expect(names(w.read())).toEqual(["back"]);
      writeEvent(dir, { name: "compact", id: "abc" }); // lands in the same tick, after the listing
      expect(names(w.read())).toEqual(["compact"]);
      expect(scans.n).toBe(2);
      const { w: later, scans: laterScans } = watch(dir, RACY_MS + 50);
      later.read();
      later.read();
      expect(laterScans.n).toBe(1);
    } finally {
      removeEventsDir(dir);
    }
  });

  test("BUG-668/QA-perf-03: a backlog cut by the limit keeps being read although the directory does not change", () => {
    const dir = fresh();
    try {
      const { w, scans } = watch(dir);
      for (let i = 0; i < EVENTS_PER_READ + 30; i++) writeEvent(dir, { name: "back" });
      expect(w.read().length).toBe(EVENTS_PER_READ);
      expect(w.read().length).toBe(30);
      expect(scans.n).toBe(2);
      w.read();
      w.read();
      expect(scans.n).toBe(2);
    } finally {
      removeEventsDir(dir);
    }
  });

  test.each([1000, 2000])("BUG-668/QA-perf-03: on a file system with %i ms timestamps an event written after a listing is read within the forced-listing interval", (GRAN) => {
    const dir = fresh();
    try {
      let t = 10 * GRAN; // a fake clock, ms
      let changed = t;
      const trunc = (ms: number) => BigInt(Math.floor(ms / GRAN) * GRAN) * 1_000_000n;
      const w = new EventsWatch(dir, { now: () => t, stat: () => ({ dev: 1n, ino: 1n, mtimeNs: trunc(changed), ctimeNs: trunc(changed) }) });
      const put = (e: Parameters<typeof writeEvent>[1]) => (writeEvent(dir, e), (changed = t));
      t += 50; // A: just after a tick
      put({ name: "back" });
      t += 400;
      expect(names(w.read())).toEqual(["back"]);
      t += 100; // B: the same truncated time as A
      put({ name: "compact", id: "abc" });
      const got: string[] = [];
      for (let waited = 0; waited <= 5000; waited += 100) {
        t += 100;
        got.push(...names(w.read()));
        if (got.length) break;
      }
      expect(got).toEqual(["compact"]);
      expect(t - changed).toBeLessThanOrEqual(Math.max(FULL_LIST_MS, RACY_MS) + 100);
    } finally {
      removeEventsDir(dir);
    }
  });

  test("an unchanged directory is listed at least every FULL_LIST_MS, and not more often than the poll", () => {
    const dir = fresh();
    try {
      let t = 1_000_000;
      const scans = { n: 0 };
      const old = { dev: 1n, ino: 1n, mtimeNs: 1n, ctimeNs: 1n };
      const w = new EventsWatch(dir, { scan: (d, seen, limit) => (scans.n++, scanEvents(d, seen, limit)), now: () => t, stat: () => old, skipping: true }); // skipping is off by default on Windows, which lists at every poll
      for (let i = 0; i < 100; i++, t += 100) w.read(); // 10 s of 100 ms polls
      expect(scans.n).toBe(Math.ceil(10_000 / FULL_LIST_MS));
    } finally {
      removeEventsDir(dir);
    }
  });

  test("the wiring: the files-changed poll goes through pollChanges and a session's events through EventsWatch (both live inside closures a unit test can't reach)", () => {
    const gluon = readFileSync(join(import.meta.dir, "..", "src", "gluon.ts"), "utf8");
    expect(gluon).toMatch(/await pollChanges\(cwd,/);
    expect(gluon).not.toMatch(/statusSnapshot\(wt/);
    const session = readFileSync(join(import.meta.dir, "..", "src", "pty", "session.ts"), "utf8");
    expect(session).toMatch(/new EventsWatch\(dir\)/);
    expect(session).toMatch(/watch\.read\(\)/);
    expect(session).not.toMatch(/readEvents\(/);
  });

  test("a missing directory gives nothing and never throws; with skipping off every read lists (Windows)", () => {
    const dir = fresh();
    try {
      const gone = watch(join(dir, "nope"));
      expect(gone.w.read()).toEqual([]);
      expect(gone.w.read()).toEqual([]);
      expect(gone.scans.n).toBe(2);
      const off = watch(dir, 10_000, false);
      off.w.read();
      off.w.read();
      expect(off.scans.n).toBe(2);
    } finally {
      removeEventsDir(dir);
    }
  });
});
