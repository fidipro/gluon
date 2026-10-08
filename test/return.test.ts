/** Returning to Gluon (issue #13): the UI launch's channel, how events end the agent, the stale sweep. */
import { SLOW } from "./fixtures/slow.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ADAPTER_DIR, SELF } from "../src/adapters/types.ts";
import { cleanStaleSpecs, neutralCwd } from "../src/detect.ts";
import { handoffDefaults } from "../src/handoff.ts";
import { handOffSession, launchPlan, substituteTokens, writeAdapterFiles, type Command } from "../src/launchers.ts";

const WIN = process.platform === "win32";
const TMP = mkdtempSync(join(tmpdir(), "gluon-return-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("the adapter's tokens and files", () => {
  test("ADAPTER_DIR and SELF are replaced in argv, env and files, never in the spec", () => {
    const cmd: Command = {
      argv: ["claude", `--plugin-dir=${ADAPTER_DIR}/p`, "--", `spec ${SELF} ${ADAPTER_DIR}`],
      env: { X: `${SELF} hook` },
      spec: `spec ${SELF} ${ADAPTER_DIR}`,
      adapter: { argv: [], env: {}, files: { "p/a.json": `{"cmd":"${SELF}","dir":"${ADAPTER_DIR}"}` } },
    };
    const r = substituteTokens(cmd, "/ad", "/self");
    expect(r.argv).toEqual(["claude", "--plugin-dir=/ad/p", "--", `spec ${SELF} ${ADAPTER_DIR}`]);
    expect(r.env).toEqual({ X: "/self hook" });
    expect(r.adapter!.files).toEqual({ "p/a.json": '{"cmd":"/self","dir":"/ad"}' });
  });

  test("files are written private, inside their directory only", () => {
    const dir = mkdtempSync(join(TMP, "files-"));
    writeAdapterFiles(dir, { "a/b/c.json": "{}", "d.txt": "x" });
    expect(readFileSync(join(dir, "a/b/c.json"), "utf8")).toBe("{}");
    if (!WIN) {
      expect(statSync(join(dir, "d.txt")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "a/b")).mode & 0o777).toBe(0o700);
    }
    for (const bad of ["../x", "/etc/x", "a/../../x", "."]) expect(() => writeAdapterFiles(dir, { [bad]: "" })).toThrow("outside its directory");
  });
});

describe.skipIf(WIN)("a UI launch (handOffSession)", () => {
  const bin = join(TMP, "bin");
  mkdirSync(bin, { recursive: true });
  /** A fake agent: prints its channel to $OUT, runs $ACT, then waits (or exits 9). */
  writeFileSync(
    join(bin, "fakeagent"),
    `#!/bin/sh
{ echo "EVENTS=$GLUON_EVENTS"; echo "HANDOFF=$GLUON_HANDOFF"; echo "SELF=$GLUON_SELF"; echo "ARGS=$*"; echo "X=$X"; } > "$OUT"
[ -n "$FILE" ] && cat "$FILE" >> "$OUT"
eval "$ACT"
`,
  );
  chmodSync(join(bin, "fakeagent"), 0o755);

  async function run(act: string, extra: Partial<Command> = {}, settings = handoffDefaults()) {
    const out = join(TMP, `out-${Math.random().toString(36).slice(2)}`);
    const tmp = mkdtempSync(join(TMP, "tmp-"));
    const saved = { PATH: process.env.PATH, OUT: process.env.OUT, ACT: process.env.ACT };
    Object.assign(process.env, { PATH: `${bin}:/usr/bin:/bin`, OUT: out, ACT: act });
    try {
      const at = performance.now();
      const end = await handOffSession({ argv: ["fakeagent", "a"], env: {}, ...extra }, settings, TMP, tmp);
      return { end, ms: performance.now() - at, out: readFileSync(out, "utf8"), left: readdirSync(tmp) };
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  test("the agent gets the channel; it exits on its own: reason exit, its code, nothing left behind", async () => {
    const r = await run("exit 9");
    expect(r.end).toEqual({ code: 9, reason: "exit" });
    expect(r.out).toMatch(/^EVENTS=.*gluon-events-/m);
    expect(r.out).toContain("HANDOFF=clear,compact");
    expect(r.out).toMatch(/^SELF=\/.+gluon$/m);
    expect(r.left).toEqual([]);
  });

  test("`back` ends it within a poll or two: SIGTERM", async () => {
    const r = await run(`printf back > "$GLUON_EVENTS/1.event"; sleep 10`);
    expect(r.end).toEqual({ code: 143, reason: "back" });
    expect(r.ms).toBeLessThan(1500 * SLOW);
    expect(r.left).toEqual([]);
  });

  test("an event that isn't one is ignored (v1's clear and session-start included)", async () => {
    const r = await run(`printf 'nope' > "$GLUON_EVENTS/0.event"; printf clear > "$GLUON_EVENTS/01.event"; printf 'session-start b' > "$GLUON_EVENTS/02.event"; sleep 0.3; printf back > "$GLUON_EVENTS/1.event"; sleep 10`);
    expect(r.end.reason).toBe("back");
  });

  test("a status event (display only) never ends the agent; `back` after it still does", async () => {
    const r = await run(`printf 'status {"state":"working","activity":"Bash: ls"}' > "$GLUON_EVENTS/1.event"; sleep 0.4; echo ALIVE >> "$OUT"; printf back > "$GLUON_EVENTS/2.event"; sleep 10`);
    expect(r.out).toContain("ALIVE");
    expect(r.end).toEqual({ code: 143, reason: "back" });
  });

  test("without a PTY a waiting hook's compaction gets no at once (nothing can ask); on_clear: stay is passed on", async () => {
    const settings = { ...handoffDefaults(), on_clear: "stay" as const };
    const r = await run(`printf 'compact c1' > "$GLUON_EVENTS/1.event"; for i in 1 2 3 4 5 6 7 8 9 10; do [ -f "$GLUON_EVENTS/c1.answer" ] && break; sleep 0.1; done; cat "$GLUON_EVENTS/c1.answer" >> "$OUT"; exit 3`, {}, settings);
    expect(r.end).toEqual({ code: 3, reason: "exit" });
    expect(r.out).toContain("HANDOFF=compact");
    expect(r.out).toEndWith("no");
  });

  test("SIGTERM ignored: SIGKILL after the grace @full", async () => {
    const r = await run(`trap '' TERM; printf back > "$GLUON_EVENTS/1.event"; while :; do sleep 1; done`);
    expect(r.end).toEqual({ code: 137, reason: "back" });
    expect(r.ms).toBeGreaterThan(2900);
  }, 10_000);

  test("the adapter's files go to their own private directory, named in argv and env; removed after", async () => {
    const r = await run("exit 0", {
      argv: ["fakeagent", `--dir=${ADAPTER_DIR}`],
      env: { X: `${SELF}`, FILE: `${ADAPTER_DIR}/sub/f.json` },
      adapter: { argv: [], env: {}, files: { "sub/f.json": `{"self":"${SELF}"}` } },
    });
    const dir = r.out.match(/ARGS=--dir=(\S+)/)![1]!;
    expect(dir).toContain("gluon-adapter-");
    const self = r.out.match(/^SELF=(.+)$/m)![1]!;
    expect(self).toBe(join(dir, "gluon"));
    expect(r.out).toContain(`X=${self}`);
    expect(r.out).toContain(`{"self":"${self}"}`);
    expect(existsSync(dir)).toBe(false);
    expect(r.left).toEqual([]);
  });
});

/**
 * Issue #29. On macOS Bun's stdin reader (a read-only, non-blocking reopen of the tty) outlives `pause()`: a line typed for
 * a child that has the terminal is taken by the parent now and then (2 to 3 in 20 in a bare script, about half of Gluon's
 * one-at-a-time scenarios). Reached by every `inTerminal` launch after the UI read the terminal: a login, `gluon install`,
 * `--launch` after the startup probe. Never seen on Linux, so it runs on macOS only. The fix (`endStdinReader` in `inTerminal`: the
 * stale reader destroyed before the spawn, 0 in 20 where the bare pause lost 2 to 3; `freshStdin` for the UI afterwards) was made without
 * a Mac: unverified there until this test passes on macOS CI. Its mechanism, on every platform: "after a handoff" below.
 */
const macOnly = process.platform === "darwin" ? test : test.skip;
macOnly("BUG-614/QA-mac-01: a line typed for a child that has the terminal is never taken by the parent's stale stdin reader (macOS) @full", async () => {
  const parent = join(import.meta.dir, "fixtures/stdin-steal-parent.ts");
  const TRIES = 60;
  let stolen = 0;
  for (let i = 0; i < TRIES && !stolen; i++) {
    let out = "";
    const proc = Bun.spawn([process.execPath, "--no-env-file", parent], { terminal: { cols: 80, rows: 24, data: (_t, d) => void (out += Buffer.from(d).toString("latin1")) } });
    const until = async (text: string, ms: number) => {
      const end = performance.now() + ms;
      while (!out.includes(text) && performance.now() < end) await Bun.sleep(5);
      return out.includes(text);
    };
    await until("ready> ", 10_000);
    await Bun.sleep(100);
    proc.terminal!.write("hello\r");
    if (!(await until("GOT <hello>", 2500))) stolen++;
    proc.kill("SIGKILL");
    await proc.exited;
    proc.terminal?.close();
  }
  expect(stolen).toBe(0);
}, 120_000);

/**
 * The mechanism of BUG-614 on any POSIX platform (macOS's stale reader can only be seen there; Linux shows the rest): across
 * handoffs the child gets every line, the reader the UI had is ended while the child runs, and what the UI reads next is fresh and
 * delivers the keys typed after it. Windows keeps the plain pause (BUG-100) and has no `/bin/bash`.
 */
describe("after a handoff", () => {
  const parent = join(import.meta.dir, "fixtures/stdin-handoff-parent.ts");
  const posix = WIN ? test.skip : test;

  /** Runs the fixture in a pseudo-terminal and types what each round waits for: a key for the UI, then a line for the child. */
  async function run(mode: string, rounds: number, spawnFail = false) {
    let out = "";
    const proc = Bun.spawn([process.execPath, "--no-env-file", parent, mode, String(rounds)], { terminal: { cols: 80, rows: 24, data: (_t, d) => void (out += Buffer.from(d).toString("latin1")) } });
    const until = async (text: string, ms = 10_000) => {
      const end = performance.now() + ms;
      while (!out.includes(text) && performance.now() < end) await Bun.sleep(5);
      return out.includes(text);
    };
    try {
      for (let i = 0; i < rounds; i++) {
        await until(`ui${i}>`);
        await Bun.sleep(100);
        proc.terminal!.write(`k${i}`);
        await until(`KEYS${i} <`);
        if (spawnFail && i === 0) continue;
        await until(`ready${i}> `);
        await Bun.sleep(100);
        proc.terminal!.write(`line${i}\r`);
        await until(`GOT${i} <line${i}>`);
      }
      await until("done");
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
      return { out: out.replace(/\r/g, ""), exited };
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
      proc.terminal?.close();
    }
  }

  posix("BUG-614/handoff: every line reaches the child, the stale reader is ended while it runs, and the UI's keys come from a fresh one (3 rounds)", async () => {
    const { out, exited } = await run("", 3);
    for (let i = 0; i < 3; i++) {
      expect(out).toContain(`KEYS${i} <k${i}>`);
      expect(out).toContain(`GOT${i} <line${i}>`);
      expect(out).toContain(`CHILD${i} code=0 oldReaderEndedWhileItRan=true`);
      // What the UI reads from: usable (not destroyed), and never the previous round's dead reader.
      expect(out).toContain(`stdin${i} fresh=true`);
    }
    expect(exited).toBe(true);
  }, 30_000);

  posix("BUG-614/handoff: a child that cannot start still leaves the UI a fresh reader", async () => {
    const { out } = await run("spawnfail", 2, true);
    expect(out).toContain("CHILD0 code=threw");
    expect(out).toContain("stdin1 fresh=true");
    expect(out).toContain("KEYS1 <k1>");
    expect(out).toContain("GOT1 <line1>");
  }, 30_000);

  posix("BUG-614/handoff: the fresh reader does not hold the process open (it ends by itself once the UI is done)", async () => {
    const { out, exited } = await run("natural", 2);
    expect(out).toContain("done");
    expect(exited).toBe(true);
  }, 30_000);
});

describe("the stale sweep", () => {
  test("events, adapter and neutral-cwd dirs go once their Gluon is gone (or, without a pid, a day old); spec dirs a day old", () => {
    const dir = mkdtempSync(join(TMP, "sweep-"));
    const make = (name: string, pid?: string, old = false) => {
      mkdirSync(join(dir, name));
      if (pid !== undefined) writeFileSync(join(dir, name, "pid"), pid);
      if (old) utimesSync(join(dir, name), new Date(0), new Date(0));
    };
    make("gluon-events-dead", "111");
    make("gluon-adapter-dead", "111");
    make("gluon-events-live", "222");
    make("gluon-cwd-dead", "111");
    make("gluon-cwd-live", "222");
    make("gluon-events-mine", String(process.pid));
    make("gluon-events-nopid");
    make("gluon-adapter-nopid-old", undefined, true);
    make("gluon-events-junkpid", "x; rm", true);
    make("gluon-spec-new");
    make("gluon-spec-old", undefined, true);
    make("other-old", "111", true);
    cleanStaleSpecs(dir, Date.now(), (pid) => pid === 222);
    expect(readdirSync(dir).sort()).toEqual(["gluon-cwd-live", "gluon-events-live", "gluon-events-mine", "gluon-events-nopid", "gluon-spec-new", "other-old"]);
  });

  test("BUG-143/v1 fixes: spec and neutral-cwd dirs carry their Gluon's pid; a running one's spec dir survives the sweep", () => {
    const tmp = mkdtempSync(join(TMP, "spec-"));
    const plan = launchPlan({ argv: ["claude", "--", "x"], env: {}, spec: "x" }, "C:\\npm\\claude.cmd", { tmp, platform: "linux" });
    expect(readFileSync(join(dirname(plan.specFile!), "pid"), "utf8")).toBe(String(process.pid));
    expect(readFileSync(join(neutralCwd(), "pid"), "utf8")).toBe(String(process.pid));
    const dir = mkdtempSync(join(TMP, "sweep-"));
    for (const [name, pid] of [["gluon-spec-live", "222"], ["gluon-spec-dead", "111"]]) {
      mkdirSync(join(dir, name!));
      writeFileSync(join(dir, name!, "pid"), pid!);
      utimesSync(join(dir, name!), new Date(0), new Date(0));
    }
    cleanStaleSpecs(dir, Date.now(), (pid) => pid === 222);
    expect(readdirSync(dir)).toEqual(["gluon-spec-live"]);
  });
});
