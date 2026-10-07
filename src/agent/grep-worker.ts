/** Runs `scan` off the main thread, so `grepFallback` can terminate it (abort, time budget). */
import { scan } from "./scan.ts";

declare const self: Worker;

self.onmessage = async (e: MessageEvent<{ root: string; rel: string; pattern: string; max: number }>) => {
  const { root, rel, pattern, max } = e.data;
  postMessage(await scan(root, rel, pattern, max));
};
