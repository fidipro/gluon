/**
 * J. Installing a missing agent: `gluon install`, and the offer in the setup. A fake installer
 * (fixtures.ts `fakeInstaller`: `curl` on POSIX, `npm.cmd` on Windows) "installs" the fake opencode;
 * nothing reaches the network or a real installer.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { installHint } from "../../src/harnesses.ts";
import { fakeAgents, fakeInstaller, freshConfig, repo, WIN } from "./fixtures.ts";
import { GUARD_MS } from "../../src/ui/signin.tsx";
import { App, baseEnv, cli, GLUON, KEY, SLOW, stopAll, SYSTEM_PATH, tracked } from "./harness.ts";

setDefaultTimeout(40_000 * SLOW);
afterAll(stopAll);

const OFFER = "OpenCode (opencode) isn't installed. Install it?";

/** Waits for an install offer, then past the time it ignores keys (typed ahead). */
async function offer(app: App, title = OFFER) {
  await app.waitFor(title);
  await app.settle(GUARD_MS + 150);
}
const HINT = installHint("opencode");

/** A home of its own, the fake installer first on PATH, and where it installs to (on PATH unless `offPath`). */
function setup(name: string, { offPath = false, extra = {} as Record<string, string>, rows = 45, cols = 220 } = {}) {
  const home = mkdtempSync(join(tmpdir(), `gluon-install-${name}-`));
  for (const d of ["AppData/Roaming", "AppData/Local"]) mkdirSync(join(home, d), { recursive: true });
  const onPath = join(home, "on-path");
  mkdirSync(onPath);
  // Off PATH: where the installer puts it (opencode's install dir; on Windows npm's prefix).
  const to = offPath ? (WIN ? join(home, "npm-prefix") : join(home, ".opencode", "bin")) : onPath;
  const log = join(home, "install.log");
  const env = {
    PATH: [fakeInstaller(), onPath, fakeAgents(["claude"]), ...SYSTEM_PATH].join(delimiter),
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    GLUON_CONFIG: freshConfig(`install-${name}`),
    FAKE_INSTALL_LOG: log,
    FAKE_INSTALL_TO: to,
    FAKE_INSTALL_SRC: join(fakeAgents(["opencode"]), WIN ? "opencode.exe" : "opencode"),
    FAKE_NPM_PREFIX: to,
    ...extra,
  };
  const logged = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const app = (args: string[]) => new App({ cwd: repo.tiny(), args, env, noDemo: true, agents: ["claude"], rows, cols });
  return { env, logged, app, to, home };
}

describe("gluon install <agent>", () => {
  test("the offer shows the exact command, its host and docs; Skip is the default and runs nothing", async () => {
    const s = setup("skip");
    const app = s.app(["install", "opencode"]);
    await offer(app);
    const screen = app.screen();
    expect(screen).toContain(HINT);
    expect(screen).toContain(WIN ? "official npm package @opencode/cli from registry.npmjs.org" : "official installer from opencode.ai and runs it");
    expect(screen).toContain("Docs: https://opencode.ai/v2/docs");
    expect(screen).toMatch(/› 1\. Skip[\s\S]*2\. Show the command only[\s\S]*3\. Run it/);
    expect(screen).toContain("esc to skip");
    await app.press(KEY.enter);
    await app.waitFor(() => app.history().includes(`Skipped OpenCode. To install it later: \`${HINT}\` (or \`gluon install opencode\`).`));
    expect(await app.exitCode()).toBe(1);
    expect(s.logged()).toBe("");
  });

  test("a digit only moves the selection; Esc skips: nothing runs", async () => {
    const s = setup("digit");
    const app = s.app(["install", "opencode"]);
    await offer(app);
    await app.press("3");
    await app.settle(300);
    expect(s.logged()).toBe("");
    await app.press(KEY.esc);
    expect(await app.exitCode()).toBe(1);
    expect(s.logged()).toBe("");
  });

  test("Show the command only prints it and runs nothing", async () => {
    const s = setup("show");
    const app = s.app(["install", "opencode"]);
    await offer(app);
    await app.press("2", KEY.enter);
    await app.waitFor(() => app.history().includes(`    ${HINT}`));
    expect(await app.exitCode()).toBe(1);
    expect(s.logged()).toBe("");
  });

  test("Run it: runs the command in an empty directory (not the repository), then finds the agent on PATH", async () => {
    const s = setup("run");
    const app = s.app(["install", "opencode"]);
    await offer(app);
    await app.press("3", KEY.enter);
    await app.waitFor("✓ OpenCode is installed");
    expect(await app.exitCode()).toBe(0);
    expect(app.history()).toContain(`Running: ${HINT}`);
    expect(app.history()).toContain("fake installer: installed opencode");
    const log = s.logged().trim().split(/\r?\n/);
    expect(log).toHaveLength(1);
    expect(log[0]).toStartWith(WIN ? "npm install -g @opencode/cli @ " : "curl -fsSL https://opencode.ai/v2/install @ ");
    expect(log[0]).toContain("gluon-cwd-");
    expect(log[0]).not.toContain(repo.tiny());
  });

  test("installed where PATH doesn't reach: says where and to open a new terminal; not used", async () => {
    const s = setup("offpath", { offPath: true });
    const app = s.app(["install", "opencode"]);
    await offer(app);
    await app.press("3", KEY.enter);
    await app.waitFor("isn't on your PATH yet");
    expect(app.history().replace(/\s+/g, "")).toContain(`OpenCode was installed to ${s.to}, which isn't on your PATH yet: add ${s.to} to your PATH (or open a new terminal, if the installer added it).`.replace(/\s+/g, ""));
    expect(await app.exitCode()).toBe(1);
  });

  test("Ctrl+C in the offer: exit 130, nothing runs", async () => {
    const s = setup("ctrlc");
    const app = s.app(["install", "opencode"]);
    await offer(app);
    await app.press("3", KEY.ctrlC);
    expect(await app.exitCode()).toBe(130);
    expect(s.logged()).toBe("");
  });

  test("without a terminal: prints the command, never runs it", async () => {
    const s = setup("notty");
    const r = await cli(["install", "opencode"], { env: s.env });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`    ${HINT}`);
    expect(r.stdout).toContain("from OpenCode's docs (https://opencode.ai/v2/docs)");
    expect(s.logged()).toBe("");
  });

  test("an agent already installed, by its binary's name; an unknown one", async () => {
    const s = setup("names");
    const ok = await cli(["install", "claude"], { env: s.env });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("✓ Claude Code is installed");
    // A broken config doesn't stop an install.
    const broken = await cli(["install", "claude"], { env: { ...s.env, GLUON_CONFIG: freshConfig("install-broken", "connections: [\n") } });
    expect(broken.code).toBe(0);
    const bad = await cli(["install", "gemini"], { env: s.env });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("install which agent? gemini isn't one of: claude-code (claude), codex, antigravity (agy), grok-build (grok), opencode, kimi-code (kimi). (To give it as a session, quote it: gluon \"install gemini\")");
  });
});

describe("gluon install (no agent named)", () => {
  test("a checklist of the missing agents; Esc installs nothing", async () => {
    const s = setup("list-esc");
    const app = s.app(["install"]);
    await app.waitFor("Install coding agents");
    const screen = app.screen();
    expect(screen).toMatch(/1\. \[ \] Codex[\s\S]*2\. \[ \] Antigravity[\s\S]*3\. \[ \] Grok Build[\s\S]*4\. \[ \] OpenCode/);
    expect(screen).not.toContain("Claude Code");
    await app.press(KEY.esc);
    await app.waitFor(() => app.history().includes("Nothing installed."));
    expect(await app.exitCode()).toBe(0);
  });

  test("the checked ones are offered in turn", async () => {
    const s = setup("list-run");
    const app = s.app(["install"]);
    await app.waitFor("Install coding agents");
    await app.press("4", KEY.enter);
    await offer(app);
    await app.press("3", KEY.enter);
    await app.waitFor("✓ OpenCode is installed");
    expect(await app.exitCode()).toBe(0);
  });
});

describe("the setup offers to install a missing agent", () => {
  /** How often `text` was printed so far. */
  const printed = (app: App, text: string) => app.history().split(text).length - 1;

  test("installed: its screens follow; going back never offers or runs it again; nothing written @full", async () => {
    const s = setup("setup-run");
    const app = s.app(["setup"]);
    await app.waitFor("Connect your coding agents");
    await app.press("1", "5", KEY.enter);
    await offer(app);
    await app.press("3", KEY.enter);
    await app.waitFor("Which providers should OpenCode use?");
    expect(app.history()).toContain("✓ OpenCode is installed");
    await app.press(KEY.esc);
    await app.waitFor(() => printed(app, "Connect your coding agents") >= 2);
    await app.settle(200);
    await app.press(KEY.enter);
    await app.waitFor(() => printed(app, "Which providers should OpenCode use?") >= 2);
    expect(printed(app, OFFER)).toBe(1);
    expect(s.logged().trim().split(/\r?\n/)).toHaveLength(1);
    await app.press(KEY.esc);
    await app.waitFor(() => printed(app, "Connect your coding agents") >= 3);
    await app.settle(200);
    await app.press(KEY.esc);
    await app.waitFor(() => app.history().includes("Nothing changed."));
    expect(await app.exitCode(5000)).toBe(1);
    expect(existsSync(s.env.GLUON_CONFIG)).toBe(false);
  });

  test("skipped (Esc): the summary says how to install it, and it isn't offered again", async () => {
    const s = setup("setup-skip");
    const app = s.app(["setup"]);
    await app.waitFor("Connect your coding agents");
    await app.press("1", "2", "5", KEY.enter);
    const codex = "Codex (codex) isn't installed. Install it?";
    await offer(app, codex);
    expect(app.screen()).toContain(installHint("codex"));
    await app.press(KEY.esc);
    await offer(app);
    await app.press(KEY.enter);
    // Both lines of the summary: the second can land a frame after the first.
    const opencode = `Install it: \`${HINT}\` (or \`gluon install opencode\`)`;
    await app.waitFor(() => app.history().includes(opencode));
    expect(app.history()).toContain(`Install it: \`${installHint("codex")}\` (or \`gluon install codex\`), then run \`gluon connect codex\`.`);
    expect(app.history()).toContain(opencode);
    expect(printed(app, codex)).toBe(1);
    expect(await app.exitCode(5000)).toBe(1);
    expect(s.logged()).toBe("");
  });
});

describe("review of phase 4", () => {
  const printed = (app: App, text: string) => app.history().split(text).length - 1;

  test("BUG-109/A: a paste never answers the offer: '3' + Enter in one read, or bracketed", async () => {
    const s = setup("paste");
    const app = s.app(["install", "opencode"]);
    await offer(app);
    app.write("3\r");
    await app.settle(300);
    app.write("\x1b[200~echo 3\rfoo\x1b[201~");
    await app.settle(300);
    expect(s.logged()).toBe("");
    expect(app.screen()).toContain("› 1. Skip");
    await app.press(KEY.esc);
    expect(await app.exitCode()).toBe(1);
    expect(s.logged()).toBe("");
  });

  test("BUG-109/A: in the setup, a key pasted with a trailing '3' + Enter doesn't run the installer", async () => {
    const s = setup("paste-setup");
    const app = s.app(["setup"]);
    await app.waitFor("Connect your coding agents");
    await app.press("1", "5", KEY.enter);
    await offer(app);
    app.write("sk-deepseek0123456789abcdef3\r");
    await app.settle(300);
    expect(s.logged()).toBe("");
    await app.press(KEY.ctrlC);
    expect(await app.exitCode()).toBe(130);
    expect(existsSync(s.env.GLUON_CONFIG)).toBe(false);
  });

  test("BUG-110/B: keys typed ahead as the offer appears (100 ms after the checklist's Enter) are dropped", async () => {
    const s = setup("typeahead");
    const app = s.app(["setup"]);
    await app.waitFor("Connect your coding agents");
    await app.press("1", "5");
    app.write("\r");
    await Bun.sleep(100);
    app.write("3");
    await Bun.sleep(40);
    app.write("\r");
    await offer(app);
    expect(s.logged()).toBe("");
    expect(app.screen()).toContain("› 1. Skip");
    await app.press(KEY.ctrlC);
    expect(await app.exitCode()).toBe(130);
    expect(s.logged()).toBe("");
  });

  test("BUG-111/C: Alt+3 doesn't select Run it, and Up from Skip doesn't wrap to it @full", async () => {
    const s = setup("alt");
    const app = s.app(["install", "opencode"]);
    await offer(app);
    await app.press(KEY.up);
    expect(app.screen()).toContain("› 1. Skip");
    app.write("\x1b3");
    await app.settle(400);
    if ((await app.exitCode(300)) === null) {
      expect(app.screen()).not.toContain("› 3. Run it");
      await app.press(KEY.enter);
    }
    expect(await app.exitCode()).toBe(1);
    expect(s.logged()).toBe("");
  });

  test("QA-sec: a bracketed paste of `3` + Enter, a paste of `Run it` + Enter and a held Enter (several \\r in one read) never run the installer; the offer stays up and Esc skips @full", async () => {
    const s = setup("qa-paste");
    const app = s.app(["install", "opencode"]);
    await offer(app);
    app.write("\x1b[200~3\r\x1b[201~");
    await app.settle(300);
    app.write("Run it\r");
    await app.settle(300);
    app.write("\r\r\r\r");
    await app.settle(300);
    expect(s.logged()).toBe("");
    expect(await app.exitCode(300)).toBeNull();
    expect(app.screen()).toContain("› 1. Skip");
    await app.press(KEY.esc);
    expect(await app.exitCode()).toBe(1);
    expect(s.logged()).toBe("");
  });

  test("BUG-112/D: an installer that fails is a failure, even with an old binary in its directory (which the offer names)", async () => {
    const s = setup("fail", { offPath: true, extra: { FAKE_INSTALL_FAIL: "1" } });
    if (!WIN) {
      mkdirSync(s.to, { recursive: true });
      copyFileSync(s.env.FAKE_INSTALL_SRC, join(s.to, "opencode"));
    }
    const app = s.app(["install", "opencode"]);
    await offer(app);
    if (!WIN) expect(app.screen()).toContain(`There's already a opencode in ${s.to}`);
    await app.press("3", KEY.enter);
    await app.waitFor("The installer failed (exit code 3)");
    expect(app.history()).not.toContain("was installed to");
    expect(await app.exitCode()).toBe(1);
  });

  test("BUG-113/E: setup, installed off PATH: the summary says where and how to finish, not 'isn't installed'", async () => {
    const s = setup("setup-offpath", { offPath: true });
    const app = s.app(["setup"]);
    await app.waitFor("Connect your coding agents");
    await app.press("1", "5", KEY.enter);
    await offer(app);
    await app.press("3", KEY.enter);
    // Wrapped anywhere (a long path): compared without whitespace.
    const flat = () => app.history().replace(/\s+/g, "");
    await app.waitFor(() => flat().includes("then run `gluon connect opencode`.".replace(/\s+/g, "")));
    expect(flat()).toContain(`OpenCode was installed to ${s.to}, which isn't on your PATH: add ${s.to} to your PATH`.replace(/\s+/g, ""));
    expect(app.history()).not.toContain("OpenCode (`opencode`) isn't installed");
    expect(await app.exitCode(5000)).toBe(1);
  });

  test.skipIf(WIN)("BUG-114: Ctrl+C during the installer: exit 130; in the setup nothing is written @full", async () => {
    const s = setup("ctrlc-run", { extra: { FAKE_INSTALL_WAIT: "1" } });
    const app = s.app(["setup"]);
    await app.waitFor("Connect your coding agents");
    await app.press("1", "5", KEY.enter);
    await offer(app);
    await app.press("3", KEY.enter);
    await app.waitFor("fake installer: waiting");
    await app.press(KEY.ctrlC);
    expect(await app.exitCode()).toBe(130);
    expect(existsSync(s.env.GLUON_CONFIG)).toBe(false);
    const one = setup("ctrlc-install", { extra: { FAKE_INSTALL_WAIT: "1" } });
    const b = one.app(["install", "opencode"]);
    await offer(b);
    await b.press("3", KEY.enter);
    await b.waitFor("fake installer: waiting");
    await b.press(KEY.ctrlC);
    expect(await b.exitCode()).toBe(130);
  });

  test("BUG-115: at 80×12 the offer keeps whole lines, the command first, and never clears the screen", async () => {
    const s = setup("small", { rows: 12, cols: 80 });
    const app = s.app(["install", "codex"]);
    app.mark();
    await offer(app, "Codex (codex) isn't installed");
    const screen = app.screen();
    expect(screen).toContain(installHint("codex"));
    expect(screen).toContain("1. Skip");
    // No line cut off mid-sentence: every body line shown is one of the offer's, whole.
    expect(screen).not.toMatch(/^ (and runs it|registry\.npmjs\.org)/m);
    expect(app.clears().scrollback).toBe(0);
    await app.press(KEY.esc);
    expect(await app.exitCode()).toBe(1);
  });

  test("BUG-116: printed commands put 'or' before the alternative", async () => {
    const s = setup("or");
    const r = await cli(["install", "codex"], { env: s.env });
    expect(r.stdout).toContain(`\n  or  npm install -g @openai/codex`);
    expect(r.stdout).not.toContain("(or");
    expect(printed({ history: () => r.stdout } as unknown as App, installHint("codex"))).toBe(1);
  });
});

// QA pass B5: a WSL box with only a Windows install of Claude Code (a `claude.exe` under /mnt/<drive>/). `doctor` and `--launch` name it ("a Windows install … install it inside WSL");
// `gluon brain` and the brain's own check say the same through `missingReason` (BUG-629).
// Needs a mount namespace (`unshare -rm`) to put a fake /mnt/<drive>: skipped where it can't be made.
const canUnshare = !WIN && process.platform === "linux" && Bun.spawnSync(["unshare", "-rm", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
describe.skipIf(!canUnshare)("QA B5: WSL, only a Windows install", () => {
  const foreign = async (args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-wsl-"));
    writeFileSync(join(dir, "config.yaml"), "connections: { claude-code: { auth: subscription } }\n");
    const script = `mount -t tmpfs tmpfs /mnt && mkdir -p /mnt/z/bin && cp "$1" /mnt/z/bin/claude.exe && shift && exec "$@"`;
    const p = tracked(Bun.spawn(["unshare", "-rm", "sh", "-c", script, "sh", join(fakeAgents(["claude"]), "claude"), ...GLUON, ...args], {
      cwd: dir,
      env: { ...baseEnv([], { GLUON_CONFIG: join(dir, "config.yaml"), WSL_DISTRO_NAME: "Test" }), PATH: ["/mnt/z/bin", ...SYSTEM_PATH].join(delimiter) },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    }));
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  };

  test("doctor names the Windows install (the baseline: this works)", async () => {
    const r = await foreign(["doctor"]);
    expect(r.stdout).toContain("a Windows install was found on PATH; install it inside WSL");
  });

  test("BUG-629/QA-onb-06: `gluon brain` says a Windows-only claude is a Windows install to redo inside WSL, not \"not installed (not found on PATH)\"", async () => {
    const r = await foreign(["brain"]);
    expect(r.stdout).toContain("1. Sonnet");
    expect(r.stdout).not.toContain("claude is not installed (not found on PATH)");
  });
});
