/**
 * The fakes stay faithful: each fake agent's TUI (`FAKE_TUI`, `test/fixtures/fake-tui.ts`) is drawn
 * into Gluon's screen model, and the harness's `READERS` entry reads its input line and highlighted
 * menu item as it reads the real harness's recorded screens (`test/pty-readers.test.ts`). A fake
 * that drifted from its harness's layout would make the e2e scenarios test nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Harness } from "../src/harnesses.ts";
import { READERS } from "../src/pty/readers/index.ts";
import { createScreen, type TermScreen } from "../src/pty/screen.ts";
import { WIN, type FakeAgent } from "./e2e/fixtures.ts";

const TUI = join(import.meta.dir, "fixtures/fake-tui.ts");
const HARNESS: Record<FakeAgent, Harness> = { claude: "claude-code", codex: "codex", opencode: "opencode", agy: "antigravity", grok: "grok-build", kimi: "kimi-code" };

/** A fake's TUI in a PTY, its output fed to a screen model. */
async function fake(name: FakeAgent, cols = 80, rows = 24) {
  const screen: TermScreen = createScreen(cols, rows);
  let out = "";
  let parsed = Promise.resolve();
  const text = new TextDecoder();
  const p = Bun.spawn([process.execPath, "--no-env-file", TUI], {
    env: { PATH: process.env.PATH!, FAKE_AGENT_NAME: name },
    terminal: {
      cols,
      rows,
      data: (_t, d) => {
        const s = text.decode(d, { stream: true });
        out += s;
        parsed = parsed.then(() => screen.write(s));
      },
    },
  });
  running.push(p);
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 300 && !ok(); i++) await Bun.sleep(10);
    if (!ok()) throw new Error(`${name}: timed out; output:\n${out}`);
  };
  /** Output stopped for a moment and the screen took it all in. */
  const quiet = async () => {
    for (let n = -1; n !== out.length; ) {
      n = out.length;
      await Bun.sleep(40);
    }
    await parsed;
  };
  await until(() => out.includes("TUI ready"));
  await quiet();
  return {
    screen,
    /** Writes each key once the last one was answered. */
    async keys(...ks: string[]) {
      for (const k of ks) {
        const n = out.length;
        p.terminal!.write(k);
        await until(() => out.length > n);
        await quiet();
      }
    },
    read: () => ({ input: READERS[HARNESS[name]].inputLine(screen), selected: READERS[HARNESS[name]].selectedCommand(screen) }),
  };
}

const running: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of running) {
    p.kill();
    p.terminal?.close();
  }
});

// ConPTY re-renders a program's output with its own cursor moves (`src/pty/AGENTS.md`): POSIX only.
// `@full` (in the title): `bun run regression` reads claude's fake only; the others run in `regression:full`.
describe.concurrent.skipIf(WIN).each(["claude", "codex @full", "opencode @full", "agy @full", "grok @full", "kimi @full"] as const)("the fake %s, read by its harness's reader", (title) => {
  const name = title.split(" ")[0] as FakeAgent;
  test("idle: an empty input line (a placeholder is not input), no menu", async () => {
    const f = await fake(name);
    expect(f.read()).toEqual({ input: "", selected: null });
  });

  test("a typed line is the input; no menu", async () => {
    const f = await fake(name);
    await f.keys(..."hello world");
    expect(f.read()).toEqual({ input: "hello world", selected: null });
  });

  // Antigravity has no /compact (`COMMANDS` in src/pty/readers/index.ts): the fake `agy` neither.
  const second = name === "agy" || name === "kimi" ? "/help" : "/compact";
  // Kimi's menu lists /compact first (and /clear only as the alias of /new: `new (clear)`, read as the alias the typed text begins).
  const first = name === "kimi" ? "/compact" : "/clear";

  test("/ opens the menu on its first item; /c and Down highlight the second; /cl the only match", async () => {
    const f = await fake(name);
    await f.keys("/");
    expect(f.read()).toEqual({ input: "/", selected: first });
    await f.keys("c", "\x1b[B");
    expect(f.read()).toEqual({ input: "/c", selected: name === "agy" || name === "kimi" ? "/clear" : "/compact" });
    await f.keys("l");
    expect(f.read()).toEqual({ input: "/cl", selected: "/clear" });
  });

  test("←/→ move the cursor in the line (text goes in at it), Ctrl+U clears it", async () => {
    const f = await fake(name);
    await f.keys(..."helo", "\x1b[D");
    await f.keys("l");
    expect(f.read()).toEqual({ input: "hello", selected: null });
    await f.keys("\x1b[C", "!");
    expect(f.read()).toEqual({ input: "hello!", selected: null });
    await f.keys("\x15");
    expect(f.read()).toEqual({ input: "", selected: null });
  });

  test("!menu: the menu stays open on an empty line, nothing typed", async () => {
    const f = await fake(name);
    await f.keys(..."!menu", "\r");
    expect(f.read()).toEqual({ input: "", selected: first });
    await f.keys("\x1b[B");
    expect(f.read()).toEqual({ input: "", selected: second });
    await f.keys("\x1b");
    expect(f.read()).toEqual({ input: "", selected: null });
  });

  test.if(name === "agy")("/compact: `No matches`, as Antigravity's menu says (no item); Enter runs nothing", async () => {
    const f = await fake(name);
    await f.keys(..."/compact");
    expect(f.read()).toEqual({ input: "/compact", selected: null });
    const all = () => Array.from({ length: f.screen.rows }, (_, y) => f.screen.line(y).text).join("\n");
    expect(all()).toContain("No matches");
    await f.keys("\r");
    expect(f.read()).toEqual({ input: "/compact", selected: null });
    expect(all()).not.toContain("COMPACTED");
  });

  test("at the narrow width of a small frame the reader still reads it", async () => {
    const f = await fake(name, 40, 12);
    await f.keys("/", "c");
    expect(f.read()).toEqual({ input: "/c", selected: name === "kimi" ? "/compact" : "/clear" });
  });
});
