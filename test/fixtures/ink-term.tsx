/**
 * An Ink render in memory, for key-driven component tests: a fake stdout of a given size (each
 * frame captured; `debug` mode writes whole frames), a fake stdin keys are written to, and the
 * last frame as plain text or ANSI. No terminal, no process.stdin.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactNode } from "react";

export interface InkTerm {
  /** The last frame, ANSI styles kept. */
  ansi(): string;
  /** Every frame so far, ANSI styles kept, oldest first (each render in debug mode writes a whole frame). */
  frames(): string[];
  /** The last frame as plain text. */
  text(): string;
  /** Writes bytes to the app's stdin and waits for the frame they cause. */
  keys(bytes: string): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  /** Waits until the frame contains `text`. */
  waitFor(text: string, ms?: number): Promise<void>;
  unmount(): void;
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  frames: string[] = [];
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
  write(s: string) {
    // A write of terminal modes alone (bracketed paste on, the cursor hidden) isn't a frame.
    if (!/^(\x1b\[[?\d;]*[a-zA-Z])+$/.test(s)) this.frames.push(s);
    return true;
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** Until no frame follows for `ms` (a frame follows its cause within a turn or two of the event loop, whatever the load: timers run in order). */
const quiet = async (frames: () => number, ms = 8) => {
  for (let n = -1; n !== frames(); ) {
    n = frames();
    await tick(ms);
  }
};

export async function inkTerm(node: ReactNode, { columns = 110, rows = 40 } = {}): Promise<InkTerm> {
  const stdout = new FakeStdout(columns, rows);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin }) as unknown as NodeJS.ReadStream;
  const app = render(node, { stdout: stdout as unknown as NodeJS.WriteStream, stdin, debug: true, exitOnCtrlC: false, patchConsole: false });
  for (const until = Date.now() + 2000; stdout.frames.length === 0 && Date.now() < until; ) await tick(5);
  await quiet(() => stdout.frames.length);
  const ansi = () => stdout.frames.at(-1) ?? "";
  return {
    ansi,
    frames: () => [...stdout.frames],
    text: () => Bun.stripANSI(ansi()),
    async keys(bytes) {
      stdin.write(bytes);
      await quiet(() => stdout.frames.length);
    },
    async resize(c, r) {
      const before = stdout.frames.length;
      stdout.columns = c;
      stdout.rows = r;
      stdout.emit("resize");
      // The frame for the new size, however slow the machine (a fixed pause lost it on Windows CI),
      // then until no other frame follows for a moment.
      for (const until = Date.now() + 2000; stdout.frames.length === before && Date.now() < until; ) await tick(10);
      await quiet(() => stdout.frames.length);
    },
    async waitFor(text, ms = 2000) {
      const until = Date.now() + ms;
      while (!Bun.stripANSI(ansi()).includes(text)) {
        if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(text)}; frame:\n${Bun.stripANSI(ansi())}`);
        await tick(10);
      }
    },
    unmount: () => app.unmount(),
  };
}
