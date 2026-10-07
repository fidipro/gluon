// Launch one harness from Gluon's demo brain in a scratch world, then PARK: the operator drives the tmux session by hand
// (tmux -L <socket> send-keys -t gluon:0.0 … / capture-pane -p -t gluon:0.0) until <scratch>/STOP exists (its content: the USD spent).
//   bun --no-env-file scripts/live-park.ts --harness opencode [--conn openrouter] [--model "DeepSeek Flash"] [--mode explore] [--task "..."] [--std] [--prompts 6]
//        [--opencode-recent provider/model] [--claude-settings '<json>'] [--codex-toml 'key = v\\nkey2 = v2']
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaults, loadConfig, saveConfig } from "../src/config.ts";
import { BINARY } from "./live-lib.ts";
import { awsSetupFromHost, availableHere, checkHarness, loadDevKeys, planHarness } from "./live-harness.ts";
import { parseCaps, Spend } from "./live-lib.ts";
import type { Harness } from "../src/harnesses.ts";

const argv = process.argv.slice(2);
const multi = (n: string) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]!] : []));
const flag = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
const h = flag("--harness") as Harness;
const ROOT = resolve(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "park-"));
process.env.GLUON_CONFIG = join(tmp, "config.yaml");
const keys = loadDevKeys(tmp);
const aws = awsSetupFromHost();
if (aws.region || aws.profile) saveConfig([[["bedrock"], { ...(aws.region ? { region: aws.region } : {}), ...(aws.profile ? { profile: aws.profile } : {}) }]]);
const config = loadConfig();
const ledger = process.env.GLUON_CAMPAIGN_LEDGER ?? join(ROOT, "qa/logs/live-park-spend.json");
const spend = new Spend(ledger, parseCaps("bedrock=30,other=10,openrouter=0.5"), 3, true, true);
const plan = planHarness(h, config, availableHere(config), { conn: flag("--conn"), model: flag("--model"), campaign: true });
console.log(JSON.stringify({ harness: h, conn: plan.pick.ok ? plan.pick.conn : plan.pick, model: plan.model?.label, worst: plan.worst }));
const r = await checkHarness(plan, config, {
  spend, campaign: true, home: "scratch", screens: true, say: (s) => console.log(s),
  standard: argv.includes("--std"), maxPrompts: Number(flag("--prompts") ?? 1),
  ...(flag("--mode") ? { mode: flag("--mode") as "explore" | "plan" | "build" } : {}),
  ...(flag("--task") ? { task: flag("--task")! } : {}),
  prepare: (w) => {
    // The agent's own scratch settings (a lowered auto-compact threshold, for the compaction checks).
    const cs = flag("--claude-settings");
    if (cs && h === "claude-code") {
      mkdirSync(join(w.home, ".claude"), { recursive: true });
      writeFileSync(join(w.home, ".claude/settings.json"), cs);
    }
    const cx = flag("--codex-toml");
    if (cx && h === "codex") {
      mkdirSync(join(w.home, ".codex"), { recursive: true });
      writeFileSync(join(w.home, ".codex/config.toml"), cx.replace(/\\n/g, "\n"));
    }
    // Environment for the agent alone, through a wrapper in the scratch bin (Gluon's environment allowlist stays as it is).
    const wrap = multi("--agent-env");
    if (wrap.length) {
      const real = realpathSync(join(w.bin, BINARY[h]));
      rmSync(join(w.bin, BINARY[h]));
      writeFileSync(join(w.bin, BINARY[h]), `#!/bin/bash\n${wrap.map((e) => `export ${e.split("=")[0]}=${JSON.stringify(e.slice(e.indexOf("=") + 1))}`).join("\n")}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
    }
    const rec = flag("--opencode-recent");
    if (rec && h === "opencode") {
      // OpenCode's own scratch state: a recent model that is not Gluon's (PR #78).
      const dir = join(w.home, ".local/state/opencode");
      mkdirSync(dir, { recursive: true });
      const [providerID, ...m] = rec.split("/");
      writeFileSync(join(dir, "model.json"), JSON.stringify({ recent: [{ providerID, modelID: m.join("/") }], favorite: [], variant: {} }));
    }
  },
  scenario: async (c) => {
    const stop = join(c.scratch, "STOP");
    console.log(`PARKED socket=${c.tmux.socket} session=${c.tmux.session} scratch=${c.scratch} repo=${c.repo} home=${c.home}`);
    writeFileSync(join(tmp, "PARK_INFO"), JSON.stringify({ socket: c.tmux.socket, session: c.tmux.session, scratch: c.scratch, repo: c.repo, home: c.home }));
    for (const end = Date.now() + 40 * 60_000; Date.now() < end && !existsSync(stop); ) await Bun.sleep(1000);
    const usd = existsSync(stop) ? Number(readFileSync(stop, "utf8").trim()) || 0 : 0;
    c.setCharged(usd);
    c.say(`parked session ended; charged $${usd}`);
  },
});
console.log(JSON.stringify(r.asserts.map((a) => `${a.status} ${a.name}`)));
spend.save();
rmSync(tmp, { recursive: true, force: true });
