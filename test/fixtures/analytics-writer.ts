/**
 * One writer process of the multi-process analytics test: `bun analytics-writer.ts <db path> <tag> <count>`
 * records `count` sessions (begin, a context reading, end) with its own `Analytics` on the shared file.
 */
import { Analytics } from "../../src/analytics.ts";

const [path, tag, count] = process.argv.slice(2);
const a = new Analytics({ enabled: true, path: path! });
for (let i = 0; i < Number(count); i++) {
  const run = a.begin({ kind: "new", name: `${tag}-${i}`, harness: "claude-code", model: "sonnet", spec: `${tag} spec ${i}` });
  run?.set({ contextPct: i });
  run?.end({ code: 0, reason: "exit" });
}
a.close();
