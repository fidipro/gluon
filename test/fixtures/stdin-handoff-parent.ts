/**
 * Stand-in for Gluon across handoffs (test/return.test.ts, BUG-614): per round the UI reads the terminal the way Gluon does
 * (raw mode pinned, a 'readable' reader on `currentStdin()`), lets go of it as `Compositor.handOver` does, then a child that
 * reads one line gets the terminal (`inTerminal`). It reports what it saw on stderr; argv[2]: `natural` ends without
 * `process.exit` (a reader left behind would keep the process alive), `spawnfail` makes the first round's child fail to start.
 */
import { inTerminal } from "../../src/launchers.ts";
import { currentStdin, pinRaw, unpinRaw } from "../../src/ui/rawmode.ts";

const mode = process.argv[2] ?? "";
const say = (s: string) => process.stderr.write(`${s}\n`);
const ROUNDS = Number(process.argv[3] ?? 3);
const first = currentStdin();

for (let i = 0; i < ROUNDS; i++) {
  // The UI: a key typed after the handoff must come out of the reader it reads now.
  const stdin = currentStdin();
  say(`stdin${i} fresh=${!stdin.destroyed} same=${stdin === first}`);
  pinRaw();
  let keys = "";
  const onReadable = () => {
    let c: Buffer | string | null;
    while ((c = stdin.read()) !== null) keys += c.toString();
  };
  stdin.on("readable", onReadable);
  say(`ui${i}>`);
  const end = Date.now() + 5000;
  while (!keys.includes(`k${i}`) && Date.now() < end) await Bun.sleep(5);
  say(`KEYS${i} <${keys}>`);
  stdin.off("readable", onReadable);
  unpinRaw();
  // The child gets the terminal; whether the old reader is gone is sampled while it runs.
  let destroyed = false;
  const sample = setInterval(() => void (destroyed ||= first.destroyed), 2);
  const argv = mode === "spawnfail" && i === 0 ? ["/nonexistent/gluon-test-child"] : ["/bin/bash", "-c", `printf "ready${i}> "; read -r l; echo "GOT${i} <$l>"`];
  let code: number | string;
  try {
    code = await inTerminal(argv, process.env, undefined);
  } catch {
    code = "threw";
  }
  clearInterval(sample);
  say(`CHILD${i} code=${code} oldReaderEndedWhileItRan=${destroyed}`);
}
say("done");
if (mode !== "natural") process.exit(0);
