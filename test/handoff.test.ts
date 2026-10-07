/** The handoff settings, the channel's events and adapter version gates (issue #13). */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionAtLeast } from "../src/adapters/index.ts";
import { ensureHandoffSection, loadConfig } from "../src/config.ts";
import { createEventsDir, parseEvent, readEvents, removeEventsDir, SESSION_ID, writeEvent } from "../src/events.ts";
import { RESUME_ID } from "../src/workspaces.ts";
import { handoffFor, handoffPieces, parsePieces } from "../src/handoff.ts";

const TMP = mkdtempSync(join(tmpdir(), "gluon-handoff-test-"));
const saved = process.env.GLUON_CONFIG;
const cfg = join(TMP, "config.yaml");
beforeEach(() => {
  process.env.GLUON_CONFIG = cfg;
  rmSync(cfg, { force: true });
});
afterAll(() => {
  if (saved === undefined) delete process.env.GLUON_CONFIG;
  else process.env.GLUON_CONFIG = saved;
  rmSync(TMP, { recursive: true, force: true });
});

describe("handoff settings", () => {
  test("defaults: return on exit, ask on /clear and /compact, ctrl+\\ (Codex binds ctrl+])", () => {
    const h = loadConfig().handoff;
    expect(handoffFor(h, "codex")).toEqual({ on_exit: "return", on_clear: "ask", on_compact: "ask", key: "ctrl+\\" });
    expect(handoffPieces(handoffFor(h, "codex"))).toEqual(["clear", "compact"]);
  });

  test("a saved ctrl+] (the old default, in configs Gluon wrote) is kept", () => {
    writeFileSync(cfg, "handoff:\n  key: ctrl+]      # returns to Gluon at once\n");
    expect(handoffFor(loadConfig().handoff, "codex").key).toBe("ctrl+]");
    expect(readFileSync(cfg, "utf8")).toContain("key: ctrl+]");
  });

  test("an agent's own values win", () => {
    writeFileSync(cfg, "handoff:\n  on_compact: stay\n  agents:\n    codex: { on_clear: stay }\n");
    const h = loadConfig().handoff;
    expect(handoffFor(h, "codex")).toEqual({ on_exit: "return", on_clear: "stay", on_compact: "stay", key: "ctrl+\\" });
    expect(handoffFor(h, "claude-code").on_clear).toBe("ask");
    expect(parsePieces(handoffPieces(handoffFor(h, "codex")).join(","))).toEqual([]);
  });

  test("bad values, unknown settings and unknown agents are refused with the allowed ones", () => {
    const bad = (yaml: string) => {
      writeFileSync(cfg, yaml);
      return () => loadConfig();
    };
    expect(bad("handoff: { on_exit: later }\n")).toThrow("handoff.on_exit must be one of return, quit");
    expect(bad("handoff: { on_clear: true }\n")).toThrow("handoff.on_clear must be one of ask, stay");
    expect(bad("handoff: { key: ctrl+a }\n")).toThrow("handoff.key must be a key like ctrl+\\ or ctrl+]");
    expect(bad("handoff: { on_quit: return }\n")).toThrow("handoff.on_quit: unknown setting");
    expect(bad("handoff: { agents: { claude: { on_clear: stay } } }\n")).toThrow("handoff.agents.claude: unknown agent (one of claude-code, codex");
    expect(bad("handoff: { agents: { codex: { agents: {} } } }\n")).toThrow("handoff.agents.codex.agents: unknown setting");
    expect(bad("handoff: [1]\n")).toThrow("handoff must be a mapping");
  });

  test("the section is added, with its comments, only to an existing config that has none", () => {
    ensureHandoffSection(cfg);
    expect(existsSync(cfg)).toBe(false);
    writeFileSync(cfg, "# mine\nbedrock: { region: eu-west-1 } # keep\n");
    ensureHandoffSection(cfg);
    const text = readFileSync(cfg, "utf8");
    expect(text).toStartWith("# mine\nbedrock: { region: eu-west-1 } # keep\n");
    expect(text).toContain("on_clear: ask    # ask: the agent's /clear asks whether to end the session");
    expect(text).toContain("mouse_capture: true  # clicks on the sessions home's rows; the wheel scrolls");
    expect(loadConfig().handoff.on_compact).toBe("ask");
    ensureHandoffSection(cfg);
    expect(readFileSync(cfg, "utf8")).toBe(text);
  });

  test("BUG-154/v1 fixes: adding the section never makes a valid config invalid (flow, JSON, `...`)", () => {
    const cases: Record<string, boolean> = {
      '{"brain": {"active": null}}\n': false,
      "{brain: {active: null}}": false,
      "brain:\n  active: null\n...\n": false,
      "": true,
      "# just a comment": true,
      "brain:\r\n  active: null\r\n": true,
      "brain:\n  active: null\n  # trailing comment": true,
    };
    for (const [text, added] of Object.entries(cases)) {
      writeFileSync(cfg, text);
      ensureHandoffSection(cfg);
      const after = readFileSync(cfg, "utf8");
      if (added) expect(after).toStartWith(text);
      else expect(after).toBe(text);
      expect(loadConfig().handoff.on_clear).toBe("ask");
    }
  });

  test("an earlier version's `nudge` is still accepted, in the section and per agent, and ignored", () => {
    writeFileSync(cfg, "handoff:\n  nudge: false\n  agents:\n    codex: { nudge: true }\n");
    const h = loadConfig().handoff;
    expect(handoffFor(h, "codex")).toEqual({ on_exit: "return", on_clear: "ask", on_compact: "ask", key: "ctrl+\\" });
  });
});

describe("events", () => {
  test("only fixed names, and ids of letters, digits and dashes", () => {
    expect(parseEvent("back")).toEqual({ name: "back" });
    expect(parseEvent("compact abc-123\n")).toEqual({ name: "compact", id: "abc-123" });
    for (const bad of ["", "quit", "back now please", "compact ../x", "compact a/b", `back ${"x".repeat(65)}`]) expect(parseEvent(bad)).toBeNull();
  });

  test("BUG-311/resume: `session <id>` takes a harness's session id (letters, digits, `_`, `-`; never a leading `-`); anything else is dropped", () => {
    expect(parseEvent("session 019f3a2c-7b1e-7c40-9d2a-5e8f01234567\n")).toEqual({ name: "session", id: "019f3a2c-7b1e-7c40-9d2a-5e8f01234567" });
    expect(parseEvent("session ses_2a1B")).toEqual({ name: "session", id: "ses_2a1B" });
    expect(parseEvent(`session ${"a".repeat(64)}`)).not.toBeNull();
    for (const bad of ["session", "session ", "session -x", "session --last", "session _a", "session a b", "session a/b", "session ../x", `session ${"a".repeat(65)}`, "session é"]) expect(parseEvent(bad)).toBeNull();
    // The hook processes keep their own copy of the pattern (they load no config): it is the contract's.
    expect(SESSION_ID.source).toBe(RESUME_ID.source);
    const { dir } = createEventsDir(TMP);
    expect(writeEvent(dir, { name: "session", id: "ses_1" })).toBe(true);
    expect(writeEvent(dir, { name: "session", id: "-x" })).toBe(false);
    expect(writeEvent(dir, { name: "session" })).toBe(false);
    expect(readEvents(dir, new Set())).toEqual([{ name: "session", id: "ses_1" }]);
    removeEventsDir(dir);
  });

  test("a private directory with the pid; events written there are read once, oldest first; junk is ignored", () => {
    const { dir } = createEventsDir(TMP);
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(dir, "pid"), "utf8")).toBe(String(process.pid));
    expect(writeEvent(dir, { name: "compact", id: "s1" })).toBe(true);
    expect(writeEvent(dir, { name: "back" })).toBe(true);
    writeFileSync(join(dir, "zz.event"), "rm -rf /");
    writeFileSync(join(dir, "zzz.event"), "x".repeat(1000));
    const seen = new Set<string>();
    expect(readEvents(dir, seen)).toEqual([{ name: "compact", id: "s1" }, { name: "back" }]);
    expect(readEvents(dir, seen)).toEqual([]);
    removeEventsDir(dir);
    expect(writeEvent(dir, { name: "back" })).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(TMP).some((n) => n.startsWith("gluon-events-"))).toBe(false);
  });

  // Any process the agent starts (the repository's tests, scripts) can write in the events dir. A
  // FIFO named like an event makes readFileSync block until a writer comes: Gluon's whole event
  // loop stops (every session's keys, the screen, even SIGTERM).
  test.skipIf(process.platform === "win32")("BUG-165/F: a FIFO named like an event never blocks reading the events", async () => {
    const { dir } = createEventsDir(TMP);
    expect(writeEvent(dir, { name: "back" })).toBe(true);
    expect(Bun.spawnSync(["mkfifo", join(dir, "000000000000000-000000-1-fifo.event")]).exitCode).toBe(0);
    const script = `const { readEvents } = await import(${JSON.stringify(join(import.meta.dir, "../src/events.ts"))}); console.log(JSON.stringify(readEvents(${JSON.stringify(dir)}, new Set())));`;
    const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { cwd: TMP, stdout: "pipe", stderr: "pipe" });
    const out = await Promise.race([new Response(proc.stdout).text(), Bun.sleep(3000).then(() => null)]);
    proc.kill(9);
    removeEventsDir(dir);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!)).toEqual([{ name: "back" }]);
  });
});

test("adapter version gates compare numeric parts", () => {
  expect(versionAtLeast("2.1.286", "2.1.105")).toBe(true);
  expect(versionAtLeast("2.1.99", "2.1.105")).toBe(false);
  expect(versionAtLeast("codex-cli 0.159.3", "0.159")).toBe(true);
  expect(versionAtLeast("1.10.0", "1.9")).toBe(true);
});

test("BUG-152: a config with the first handoff values is updated to ask | stay, keeping the user's other values and comments", () => {
  writeFileSync(cfg, `# mine\nbedrock: { region: eu-west-1 } # keep\nhandoff:\n  on_exit: quit\n  on_clear: return    # old comment\n  on_compact: off\n  nudge: true\n  agents:\n    codex: { on_compact: suggest }\n`);
  const h = loadConfig().handoff;
  expect(handoffFor(h, "claude-code")).toEqual({ on_exit: "quit", on_clear: "ask", on_compact: "stay", key: "ctrl+\\" });
  expect(handoffFor(h, "codex").on_compact).toBe("ask");
  const text = readFileSync(cfg, "utf8");
  expect(text).toStartWith("# mine\nbedrock: { region: eu-west-1 } # keep\n");
  expect(text).not.toContain("old comment");
  expect(text).toContain("# ask: the agent's /clear asks whether to end the session");
  expect(loadConfig().handoff.on_exit).toBe("quit");
  expect(readFileSync(cfg, "utf8")).toBe(text);
});

