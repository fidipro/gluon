/**
 * Stand-in for Gluon around a handover (test/return.test.ts, BUG-614/QA-mac-01): reads the terminal the way the UI
 * does (raw mode pinned, a 'readable' reader on `currentStdin()`), lets go of it as `Compositor.handOver` does, then runs a child that reads
 * one line in the terminal itself (`inTerminal`, which ends the stale reader before the spawn).
 */
import { inTerminal } from "../../src/launchers.ts";
import { currentStdin, pinRaw, unpinRaw } from "../../src/ui/rawmode.ts";

const stdin = currentStdin();
pinRaw();
const onReadable = () => {
  while (stdin.read() !== null);
};
stdin.on("readable", onReadable);
await Bun.sleep(150);
stdin.off("readable", onReadable);
unpinRaw();
const code = await inTerminal(["/bin/bash", "-c", 'printf "ready> "; read -r l; echo "GOT <$l>"'], process.env, undefined);
process.exit(code);
