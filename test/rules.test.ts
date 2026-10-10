/**
 * The hard rules, for every vendor, checked on every run: Gluon never touches a harness's
 * credentials (Claude, Codex, Antigravity/Gemini, Grok), never calls a vendor directly on the
 * user's plan, never routes a subscription elsewhere or forwards a token, never impersonates a
 * harness, and masks token-like values.
 */
import type { SDKMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { repoContext, systemPrompt } from "../src/agent/prompt.ts";
import { Session, type State } from "../src/agent/session.ts";
import { codexEnv, threadStartParams } from "../src/agent/codex.ts";
import { subscriptionBrain, subscriptionEnv, subscriptionOptions } from "../src/agent/subscription.ts";
import { defaults, loadConfig, saveConfig, type Config, type Connection } from "../src/config.ts";
import { onPath } from "../src/detect.ts";
import { HARNESS_INFO, HARNESSES, OPENROUTER_ANTHROPIC_BASE, PROVIDERS, type Harness } from "../src/harnesses.ts";
import { ensurePermanentFiles, removePermanentFiles } from "../src/adapters/permanent.ts";
import { assertSafeEnv, BASE_URL_ENV, buildCommand, FORBIDDEN_ENV, TOKEN_ENV } from "../src/launchers.ts";
import { loadSecrets, maskSecrets, saveSecret, secret } from "../src/secrets.ts";
import { fakeAgents, isPrivate } from "./e2e/fixtures.ts";

const ROOT = join(import.meta.dir, "..");
const TMP = mkdtempSync(join(tmpdir(), "gluon-rules-"));
const saved = { ...process.env };

beforeAll(() => {
  process.env.GLUON_CONFIG = join(TMP, "config.yaml");
  process.env.PATH = `${fakeAgents(["claude", "codex", "agy", "grok", "opencode"])}${delimiter}${process.env.PATH}`;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(TMP, { recursive: true, force: true });
});

/** The defaults when the config file isn't readable (a test broke it on purpose). */
const loadConfigSafe = () => {
  try {
    return loadConfig();
  } catch {
    return defaults();
  }
};

const sources = (dir: string): [string, string][] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [[p.slice(ROOT.length + 1).replaceAll("\\", "/"), readFileSync(p, "utf8")] as [string, string]] : [];
  });
const SRC = sources(join(ROOT, "src"));

describe("the old name", () => {
  // `git grep` needs a checkout: docker-test's build context is the tracked files without `.git`, where it finds nothing.
  test.skipIf(!existsSync(join(ROOT, ".git")))("`fidicode` (but issue links, `fidipro/fidicode/issues/N`, which GitHub redirects) stays only where it is history or a legacy path to remove", () => {
    const out = Bun.spawnSync(["git", "grep", "-ilP", "(?<!fidipro/)fidicode"], { cwd: ROOT, env: process.env, stdout: "pipe" }).stdout.toString();
    expect(out.split("\n").filter(Boolean).sort()).toEqual([
      "src/AGENTS.md", // the legacy names, as a rule
      "src/adapters/permanent.ts", // legacy paths written by old versions: removed, never written
      "test/fixtures/screens/claude-code/2.1.296.json", // a captured screen
      "test/permanent.test.ts",
      "test/rules.test.ts",
    ]);
  });

  /** Where the GitHub org and repository name (`fidipro/gluon`) may be spelled out; everywhere else says `REPO_SLUG`. */
  const SLUG_PLACES = new Set([
    "src/repo.ts", // REPO_SLUG, the one name in src/
    "install.sh", // REPO= (and its usage comment)
    "install.ps1", // $Repo (and its usage comment)
    "package.json", // homepage, bugs, repository
    ".github/ISSUE_TEMPLATE/config.yml", // contact links
    "README.md", // install one-liners
    "SECURITY.md", // the advisory form link
    "SUPPORT.md", // the issue chooser link
    "CONTRIBUTING.md", // git clone
    "docs/index.mdx", // install one-liners
    "docs/getting-started/install.md", // install one-liners, `gh release download -R`, the cosign identity
    "docs/reference/env.md", // generated from the installers' own text
    "docs/reference/cli.md", // generated from `gluon update --help`, which names the releases it installs
    "test/rules.test.ts", // this list
  ]);

  test("the repository's slug (`fidipro/...`) is spelled only where it must be: use REPO_SLUG from src/repo.ts, or add the place to SLUG_PLACES with a reason", () => {
    const out = Bun.spawnSync(["git", "grep", "-nIi", "fidipro"], { cwd: ROOT, env: process.env, stdout: "pipe" }).stdout.toString();
    // A link to an issue (`github.com/fidipro/fidicode/issues/76`) is a reference to history, not a copy of the name.
    const hits = out.split("\n").filter(Boolean).filter((l) => /fidipro/i.test(l.replace(/fidipro\/fidicode\/issues\/\d+/gi, "")));
    const files = [...new Set(hits.map((l) => l.slice(0, l.indexOf(":"))))].filter((f) => !SLUG_PLACES.has(f));
    expect(files.sort()).toEqual([]);
  });

  test("the repository's own policy files exist (CODE_OF_CONDUCT.md, SUPPORT.md, SECURITY.md, CONTRIBUTING.md, CHANGELOG.md, the issue-template config)", () => {
    for (const f of ["CODE_OF_CONDUCT.md", "SUPPORT.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", ".github/ISSUE_TEMPLATE/config.yml"]) {
      expect([f, existsSync(join(ROOT, f))]).toEqual([f, true]);
    }
  });
});

/**
 * The allowlist of harness config names (issue #39): the one module that may name a harness's config
 * directory, and the names it may use there. Everything else of rule 1 still holds for it.
 */
const CONFIG_ALLOWLIST: Record<string, RegExp> = { "src/cost/harness-config.ts": /(["'`/])\.claude(?=["'`/])/g };

describe("rule 1: never touch any harness's credentials", () => {
  test("no source reads a token file, a harness's config directory or the keychain", () => {
    for (const [file, source] of SRC) {
      // install.ts looks for grok's binary in the installer's bin directory (~/.grok/bin): a path it checks exists, never reads.
      let text = file.endsWith("install.ts") ? source.replaceAll('".grok", "bin"', "") : source;
      // The allowlisted module's allowed names are set aside; every other name and the credential patterns still count.
      if (CONFIG_ALLOWLIST[file]) text = text.replace(CONFIG_ALLOWLIST[file]!, "$1<allowed-config-dir>");
      expect([file, text]).not.toEqual([file, expect.stringMatching(/\.credentials\.json|["'`/]\.claude["'`/]|find-generic-password|keychain|libsecret|oauthAccount/i)]);
      expect([file, text]).not.toEqual([file, expect.stringMatching(/["'`/]\.codex["'`/]|auth\.json|oauth_creds|google_accounts|\.local\/share\/opencode/i)]);
      // The one exception (owner-approved, issue #13): Gluon's own hook file / plugin folder.
      if (!["src/adapters/permanent.ts", "src/adapters/agy-settings.ts"].includes(file)) expect([file, text]).not.toEqual([file, expect.stringMatching(/["'`/]\.gemini["'`/]|["'`/]\.grok["'`/]/i)]);
    }
  });

  test("the third exception (issue #39): harness-config.ts alone names Claude's settings files, joins only the local, project and user settings, reads only the two TTL keys, and names no credential, account file or other harness's config", () => {
    const text = SRC.find(([f]) => f === "src/cost/harness-config.ts")![1];
    expect([...text.matchAll(/join\(([^()]*)\)/g)].map((m) => m[1]).filter((a) => /claude|settings/.test(a!))).toEqual([
      'home, ".claude"',
      'cwd, ".claude", "settings.local.json"',
      'cwd, ".claude", "settings.json"',
      'userDir, "settings.json"',
    ]);
    expect(text).not.toMatch(/\.credentials|\.claude\.json|auth\.json|oauth|keychain|libsecret|\.codex|\.grok|\.gemini|opencode|["']env["']/i);
    expect([...text.matchAll(/Object\.hasOwn\(j, "(\w+)"\)/g)].map((m) => m[1])).toEqual(["promptCacheTtl", "subagentPromptCacheTtl"]);
    for (const [file, other] of SRC) if (file !== "src/cost/harness-config.ts") expect([file, /settings\.local\.json|promptCacheTtl/i.test(other)]).toEqual([file, false]);
  });

  test("the second exception (owner-approved, issue #39; off unless cost.antigravity_statusline): agy-settings.ts is the only file that names agy's settings.json, touches only its statusLine key and Gluon's own script, and nothing else of the harnesses'", () => {
    const text = SRC.find(([f]) => f === "src/adapters/agy-settings.ts")![1];
    expect([...text.matchAll(/join\(([^()]*)\)/g)].map((m) => m[1]).filter((a) => /gemini/.test(a!))).toEqual(['home, ".gemini", "antigravity-cli", "settings.json"']);
    // Only the statusLine key is ever set or removed; the rest of the user's settings is written back as it was parsed.
    expect([...text.matchAll(/statusLine/g)].length).toBeGreaterThan(3);
    expect(text).not.toMatch(/trustedWorkspaces|auth|credential|oauth|\.grok|\.claude|\.codex|keychain/i);
    for (const [file, other] of SRC) if (file !== "src/adapters/agy-settings.ts" && file !== "src/adapters/permanent.ts") expect([file, other.includes(`"antigravity-cli", "settings.json"`)]).toEqual([file, false]);
  });

  test("the exception: permanent.ts writes only ~/.grok/hooks/gluon.json (and removes ~/.grok/hooks/fidicode.json and v1's ~/.gemini/config/plugins/fidicode, the names before the rename), inert without GLUON_EVENTS", () => {
    const text = SRC.find(([f]) => f === "src/adapters/permanent.ts")![1];
    // Every path it names under those directories is its own.
    expect([...text.matchAll(/join\(([^()]*(\([^()]*\))?[^()]*)\)/g)].map((m) => m[1]).filter((a) => /grok|gemini/.test(a!))).toEqual([
      'env.GROK_HOME || join(home, ".grok"), "hooks", "gluon.json"',
      'env.GROK_HOME || join(home, ".grok"), "hooks", "fidicode.json"',
      'home, ".gemini", "config", "plugins", "fidicode"',
    ]);
    expect(text).not.toMatch(/settings\.json|config\.toml|hooks-paths|disabled-hooks|readdirSync|config\.json/);
    const home = mkdtempSync(join(TMP, "home-"));
    for (const h of HARNESSES) expect(ensurePermanentFiles(h, { home, env: {} })).toBeNull();
    const files = readdirSync(home, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(home.length + 1).replaceAll("\\", "/")).sort();
    expect(files).toEqual([".grok/hooks/gluon.json"]);
    // Inert: every command starts by checking GLUON_EVENTS (test/permanent.test.ts runs them).
    for (const f of files) for (const [, cmd] of readFileSync(join(home, f), "utf8").matchAll(/"command": "((?:[^"\\]|\\.)*)"/g)) expect(JSON.parse(`"${cmd}"`)).toMatch(/^\[ -z "\$\{GLUON_EVENTS:-\}" \] \|\||^if \(\$\{env:GLUON_EVENTS\}/);
    expect(removePermanentFiles({ home, env: {} })).toHaveLength(1);
  });

  test("status and login go only through the official binaries' own commands", () => {
    for (const h of HARNESSES) {
      const sub = HARNESS_INFO[h].subscription;
      if (sub) expect(sub.loginArgv[0]).toBe(HARNESS_INFO[h].binary);
    }
    const status = SRC.find(([f]) => f === "src/status.ts")![1];
    expect(status).toContain('binPath("claude")');
    expect(status).toContain('[claude, "auth", "status", "--json"]');
    expect(status).toContain('binPath(binary)');
    expect(status).toContain('[bin, "models"]');
    expect(status).toContain('binPath("opencode")');
    expect(status).toContain('[opencode, "auth", "list", "--standalone", "--format", "json"]');
    expect(SRC.find(([f]) => f === "src/agent/codex.ts")![1]).toContain('[codex, "login", "status"]');
  });

  test("Gluon never edits another tool's settings file: it tells the user what to set", () => {
    for (const [file, text] of SRC) expect([file, text]).not.toEqual([file, expect.stringMatching(/writeFileSync\([^)]*(settings\.json|config\.toml)/)]);
    expect(HARNESS_INFO.antigravity.keyNote?.gemini).toContain("set that yourself");
  });

  test("#108: Antigravity takes only the Gemini API as a key: its base-URL override speaks Gemini's wire format, which OpenRouter does not serve", () => {
    expect(HARNESS_INFO.antigravity.providers).toEqual(["gemini"]);
    expect(BASE_URL_ENV).toContain("GOOGLE_GEMINI_BASE_URL");
  });

  test("the subscription brain never builds an HTTP client: no Anthropic SDK or fetch at runtime", () => {
    const text = SRC.find(([f]) => f === "src/agent/subscription.ts")![1];
    expect(text).not.toMatch(/^import (?!type )[^\n]*"@anthropic-ai\/(sdk|bedrock-sdk)"/m);
    expect(text).not.toMatch(/\bfetch\(|https?:\/\//);
  });

  test("only the updater (src/update/) reads GitHub's releases or Sigstore's TUF repository", () => {
    for (const [file, text] of SRC) {
      if (file.startsWith("src/update/")) continue;
      expect([file, text]).not.toEqual([file, expect.stringMatching(/releases\/(latest|download)|githubusercontent\.com|tuf-repo-cdn|@sigstore\//)]);
    }
  });

  test("no impersonation of any harness in any prompt Gluon sends", () => {
    // Gluon's own text: the repository's AGENTS.md / CLAUDE.md shown after it are the project's words, not Gluon's.
    const prompt = systemPrompt(loadConfig(), { ...repoContext(ROOT), instructions: [] });
    expect(prompt).not.toMatch(/you are claude code|claude code, anthropic's official|claude-cli|x-app|you are codex|you are (antigravity|gemini cli|grok)/i);
    expect(prompt).toStartWith("You are Gluon's intake agent");
    for (const [file, text] of SRC) expect([file, text]).not.toEqual([file, expect.stringMatching(/You are (Claude Code|Codex|Antigravity|Grok)|anthropic-beta|x-app:|user-agent|originator/i)]);
    // The ChatGPT-plan brain sends Gluon's own prompt as the thread's instructions, unchanged.
    expect(threadStartParams("gpt-6-sol", ROOT, prompt).baseInstructions).toBe(prompt);
  });

  test("the SDK runs the user's own claude with Gluon's prompt and tools only, none of the user's settings", () => {
    const opts = subscriptionOptions("claude-sonnet-5-5", ROOT, "You are Gluon.", {});
    expect(opts.pathToClaudeCodeExecutable).toBe(onPath("claude")!);
    expect(opts.pathToClaudeCodeExecutable).toContain("gluon-e2e-");
    expect(opts.systemPrompt).toBe("You are Gluon.");
    expect(opts.tools).toEqual([]);
    expect(opts.settingSources).toEqual([]);
    expect(opts.allowedTools!.every((t) => t.startsWith("mcp__gluon__"))).toBe(true);
  });
});

describe("rules 1 and 4: no base URL on a subscription, no token forwarding", () => {
  test("the env for claude and codex is the user's own (plus only the SDK's app name for claude)", () => {
    const env = subscriptionEnv();
    expect(Object.keys(env).filter((k) => !(k in process.env))).toEqual(["CLAUDE_AGENT_SDK_CLIENT_APP"]);
    expect(Object.keys(codexEnv()).filter((k) => !(k in process.env))).toEqual([]);
    for (const k of FORBIDDEN_ENV) {
      expect(env[k]).toBeUndefined();
      expect(codexEnv()[k]).toBeUndefined();
    }
  });

  test("no source sets a login token, and only the OpenRouter path sets a base URL (OpenRouter's endpoint)", () => {
    for (const [file, text] of SRC) {
      expect([file, text]).not.toEqual([file, expect.stringMatching(/(CLAUDE_CODE_OAUTH_TOKEN|CODEX_ACCESS_TOKEN|XAI_ACCESS_TOKEN|GOOGLE_OAUTH_ACCESS_TOKEN)["']?\s*(:|=[^=])/)]);
      const sets = [...text.matchAll(/\b([A-Z_]*BASE_URL)\s*=\s*([^;\n]+)/g)];
      for (const [, name, value] of sets) {
        // Claude Code's and Kimi Code's OpenRouter launches (Kimi's `KIMI_MODEL_BASE_URL`: its documented environment model), nothing else.
        expect([file, name, value!.trim()]).toEqual(["src/launchers.ts", name, name === "ANTHROPIC_BASE_URL" ? "OPENROUTER_ANTHROPIC_BASE" : "OPENROUTER_OPENAI_BASE"]);
        expect(["ANTHROPIC_BASE_URL", "KIMI_MODEL_BASE_URL"]).toContain(name!);
      }
    }
    expect(OPENROUTER_ANTHROPIC_BASE).toBe("https://openrouter.ai/api");
  });

  test("every connection of every harness: no token, a base URL only on OpenRouter, only the chosen provider's key", () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "MOONSHOT_API_KEY"];
    for (const k of keys) process.env[k] = `sk-test-${k.toLowerCase()}-0123456789abcdef`;
    try {
      for (const h of HARNESSES) {
        const info = HARNESS_INFO[h];
        const connections: Connection[] = [...(info.subscription ? [{ auth: "subscription" } as Connection] : []), ...info.providers.map((p) => (info.multiProvider ? { auth: "api", providers: [p] } : { auth: "api", provider: p }) as Connection)];
        for (const c of connections) {
          const config = { ...loadConfig(), connections: { [h]: c } };
          const p = c.provider ?? c.providers?.[0];
          const entry = config.models[h].find((m) => m.ids[p ?? "plan"]);
          if (!entry) continue;
          const { env } = buildCommand(config, { harness: h, model: entry.id, spec: "x", reason: "" });
          for (const k of TOKEN_ENV) expect(env[k]).toBeUndefined();
          for (const k of BASE_URL_ENV) if (p !== "openrouter") expect([h, p, k, env[k]]).toEqual([h, p, k, undefined]);
          // A subscription gets no key, token or URL: its environment is empty (Kimi Code's plan only turns its auto-update off, per launch).
          if (c.auth === "subscription") expect([h, env]).toEqual([h, h === "kimi-code" ? { KIMI_CODE_NO_AUTO_UPDATE: "1" } : {}]);
          const given = keys.filter((k) => env[k]);
          const own = p && p !== "openrouter" ? PROVIDERS[p].env : undefined;
          if (p === "openrouter" && h === "claude-code") {
            expect(env).toEqual({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: process.env.OPENROUTER_API_KEY!, ANTHROPIC_API_KEY: "" });
          } else if (p === "openrouter" && h === "kimi-code") {
            // Kimi's environment model: the key under Kimi's own name, OpenRouter's endpoint, no OPENROUTER_API_KEY.
            expect(env).toEqual({ KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_MODEL_PROVIDER_TYPE: "openai", KIMI_MODEL_BASE_URL: "https://openrouter.ai/api/v1", KIMI_MODEL_API_KEY: process.env.OPENROUTER_API_KEY!, KIMI_MODEL_MAX_CONTEXT_SIZE: expect.stringMatching(/^\d+$/), KIMI_MODEL_NAME: expect.stringMatching(/^moonshotai\/kimi-/) });
            expect(given).toEqual([]);
          } else if (p === "moonshot" && h === "kimi-code") {
            // Moonshot's key under Kimi's own name too; no base URL (Kimi's default endpoint), no MOONSHOT_API_KEY.
            expect(env).toEqual({ KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_MODEL_PROVIDER_TYPE: "kimi", KIMI_MODEL_API_KEY: process.env.MOONSHOT_API_KEY!, KIMI_MODEL_MAX_CONTEXT_SIZE: expect.stringMatching(/^\d+$/), KIMI_MODEL_NAME: expect.stringMatching(/^kimi-/) });
            expect(given).toEqual([]);
          } else if (p === "openrouter") expect(given).toEqual(["OPENROUTER_API_KEY"]);
          else expect(given).toEqual(own && keys.includes(own) ? [own] : []);
        }
      }
    } finally {
      for (const k of keys) delete process.env[k];
    }
  });

  test("BUG-81/6: every harness × connection, argv and env: a base URL only on OpenRouter (its endpoints) and Codex on an OpenAI key (OpenAI's own)", () => {
    const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "OPENCODE_API_KEY", "MOONSHOT_API_KEY"];
    for (const k of keys) process.env[k] = `sk-test-${k.toLowerCase()}-0123456789abcdef`;
    // The only endpoints Gluon may point an agent at, and where.
    const allowed = (h: Harness, conn: string): string[] =>
      conn === "openrouter" ? ["https://openrouter.ai/api", "https://openrouter.ai/api/v1"] : h === "codex" && conn === "openai" ? ["https://api.openai.com/v1"] : [];
    let checked = 0;
    try {
      for (const h of HARNESSES) {
        const info = HARNESS_INFO[h];
        const conns: [Connection, string][] = [...(info.subscription ? [[{ auth: "subscription" }, "plan"] as [Connection, string]] : []), ...info.providers.map((p) => [info.multiProvider ? { auth: "api", providers: [p] } : { auth: "api", provider: p }, p] as [Connection, string])];
        for (const [c, conn] of conns) {
          const config = { ...loadConfig(), connections: { [h]: c } };
          for (const entry of config.models[h].filter((m) => m.ids[conn as keyof typeof m.ids])) {
            const { argv, env } = buildCommand(config, { harness: h, model: entry.id, spec: "x", reason: "" });
            // TOML in `-c` values (base_url="…", any case), --base-url flags, and the environment.
            const urls = [
              ...argv.join("\n").matchAll(/base[_-]?url"?\s*[=:]\s*"?([^",}\s]+)/gi),
              ...argv.join("\n").matchAll(/--(?:api-)?base[_-]?url[= ]([^\s]+)/gi),
            ].map((m) => m[1]!);
            for (const [k, v] of Object.entries(env)) if (/BASE_URL|_API_BASE$|ENDPOINT/i.test(k)) urls.push(v);
            for (const u of urls) expect([h, conn, u, allowed(h, conn).includes(u)]).toEqual([h, conn, u, true]);
            if (conn === "plan") expect([h, urls]).toEqual([h, []]);
            checked++;
          }
        }
      }
    } finally {
      for (const k of keys) delete process.env[k];
    }
    expect(checked).toBeGreaterThan(30);
    // Codex on an OpenAI key is the one non-aggregator endpoint, and it is OpenAI's own.
    process.env.OPENAI_API_KEY = "sk-test-openai-0123456789abcdef";
    try {
      const { argv } = buildCommand({ ...loadConfig(), connections: { codex: { auth: "api", provider: "openai" } } }, { harness: "codex", model: "gpt-6.1-sol", spec: "x", reason: "" });
      expect(argv.join(" ")).toContain('base_url="https://api.openai.com/v1"');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  test("a token or a base URL is refused, except OpenRouter's own endpoint on an OpenRouter connection", () => {
    for (const k of TOKEN_ENV) for (const conn of [undefined, "plan", "openrouter", "anthropic"] as const) expect(() => assertSafeEnv({ [k]: "x" }, conn)).toThrow(k);
    expect(() => assertSafeEnv({ SOME_OAUTH_TOKEN: "x" }, "openrouter")).toThrow();
    for (const k of BASE_URL_ENV) {
      expect(() => assertSafeEnv({ [k]: "https://example.com" })).toThrow(k);
      expect(() => assertSafeEnv({ [k]: "https://openrouter.ai/api" }, "plan")).toThrow(k);
      expect(() => assertSafeEnv({ [k]: "https://example.com" }, "openrouter")).toThrow(k);
    }
    expect(() => assertSafeEnv({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api" }, "bedrock")).toThrow();
    expect(() => assertSafeEnv({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: "k" }, "openrouter")).not.toThrow();
    expect(() => assertSafeEnv({ ANTHROPIC_AUTH_TOKEN: "k" }, "anthropic")).toThrow();
  });

  test("Kimi Code's KIMI_MODEL_BASE_URL: OpenRouter's endpoint on kimi-code + openrouter only; nowhere else, no other value, no Kimi plan endpoint", () => {
    const openrouter = { KIMI_MODEL_BASE_URL: "https://openrouter.ai/api/v1" };
    expect(() => assertSafeEnv(openrouter, "openrouter", "kimi-code")).not.toThrow();
    // Not for another harness, another connection, or no harness named (the subscription and login callers).
    for (const [conn, harness] of [["openrouter", "claude-code"], ["openrouter", "codex"], ["openrouter", "opencode"], ["openrouter", undefined], ["plan", "kimi-code"], [undefined, "kimi-code"], ["anthropic", "kimi-code"], ["bedrock", "kimi-code"], ["moonshot", "kimi-code"]] as const) {
      expect(() => assertSafeEnv(openrouter, conn, harness), `${harness}/${conn}`).toThrow("KIMI_MODEL_BASE_URL");
    }
    for (const value of ["https://example.com", "https://openrouter.ai/api", "https://api.moonshot.ai/v1", "https://api.kimi.com/coding/v1"]) expect(() => assertSafeEnv({ KIMI_MODEL_BASE_URL: value }, "openrouter", "kimi-code")).toThrow("KIMI_MODEL_BASE_URL");
    // Kimi's own plan endpoints and OAuth host are base URLs too (never set; the pattern refuses them).
    for (const k of ["KIMI_CODE_BASE_URL", "KIMI_CODE_OAUTH_HOST", "KIMI_BASE_URL"]) expect(() => assertSafeEnv({ [k]: "https://api.kimi.com/coding/v1" }, "plan", "kimi-code"), k).toThrow();
    // The key's name is Kimi's own, and no token is forwarded.
    expect(() => assertSafeEnv({ ...openrouter, KIMI_MODEL_API_KEY: "sk-or-v1-x", KIMI_MODEL_NAME: "moonshotai/kimi-k3", KIMI_CODE_NO_AUTO_UPDATE: "1" }, "openrouter", "kimi-code")).not.toThrow();
  });

  test("the brain's plan routes never get a key, token or base URL", () => {
    const brain = SRC.find(([f]) => f === "src/brain.ts")![1];
    const plan = brain.slice(brain.indexOf('case "claude-plan":\n      return subscriptionBrain'), brain.indexOf('case "anthropic-api":\n      return anthropicBrain'));
    expect(plan).toContain("subscriptionBrain(model, cwd, undefined, effort as Effort | null)");
    expect(plan).toContain("chatgptPlanBrain({ model, cwd, ...(step.effort ? { effort: step.effort } : {}), ...(onEffort ? { onEffort } : {}) })");
    expect(plan).not.toMatch(/secret\(|BASE|apiKey|token/i);
  });
});

describe("rule 2: keys", () => {
  test("keys from Gluon's .env stay out of process.env (so an agent on its own login isn't billed)", () => {
    saveSecret("ANTHROPIC_API_KEY", "sk-ant-api03-savedsavedsavedsaved");
    loadSecrets();
    expect(secret("ANTHROPIC_API_KEY")).toBe("sk-ant-api03-savedsavedsavedsaved");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(isPrivate(join(TMP, ".env"), homedir())).toBe(true);
    rmSync(join(TMP, ".env"));
    loadSecrets();
  });

  test("BUG-82/7: .env.example states the precedence secrets.ts implements (saved > environment, no other .env)", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(example).not.toMatch(/environment wins/i);
    expect(example).toContain("Precedence: a key in that file wins over your\n# environment. Gluon reads no other .env.");
    // …as the code does it.
    process.env.GEMINI_API_KEY = "AIza-from-the-environment-000000000";
    try {
      saveSecret("GEMINI_API_KEY", "AIza-saved-by-gluon-1111111111111");
      expect(secret("GEMINI_API_KEY")).toBe("AIza-saved-by-gluon-1111111111111");
    } finally {
      delete process.env.GEMINI_API_KEY;
      rmSync(join(TMP, ".env"), { force: true });
      loadSecrets();
    }
  });

  test("BUG-89: a key is never written into a looser existing .env, and a config that can't be saved saves no key", async () => {
    const env = join(TMP, ".env");
    writeFileSync(env, "OTHER_SETTING=1\n", { mode: 0o644 });
    const before = statSync(env).ino;
    saveSecret("XAI_API_KEY", "xai-savedbygluon2222222222");
    // A new 0600 file replaced the old one (the key never went into the 0644 file).
    expect(statSync(env).ino).not.toBe(before);
    expect(isPrivate(env, homedir())).toBe(true);
    expect(readFileSync(env, "utf8")).toBe("OTHER_SETTING=1\nXAI_API_KEY=xai-savedbygluon2222222222\n");
    expect(readdirSync(TMP).filter((f) => f.includes(".tmp"))).toEqual([]);
    rmSync(env);
    loadSecrets();
    // The setup's commit: config first; when it fails, no key is saved and nothing changes.
    const { SetupFlow } = await import("../src/auth.ts");
    const { makeTheme } = await import("../src/ui/theme.ts");
    writeFileSync(process.env.GLUON_CONFIG!, "connections: [unclosed\n");
    const config = { ...loadConfigSafe(), connections: {} };
    const flow = new SetupFlow(config, makeTheme(null), ["grok-build"]);
    flow.draft.connections["grok-build"] = { auth: "api", provider: "xai" };
    flow.draft.connected = ["grok-build"];
    flow.draft.secrets = { XAI_API_KEY: "xai-pastedkey3333333333333" };
    expect(() => flow.commit()).toThrow(/not valid YAML/);
    expect(statSync(env, { throwIfNoEntry: false })).toBeUndefined();
    expect(config.connections).toEqual({});
    rmSync(process.env.GLUON_CONFIG!);
  });

  test("the environment's key is used as is, never stripped", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-fromenvfromenvfromenv";
    try {
      expect(subscriptionEnv().ANTHROPIC_API_KEY).toBe("sk-ant-api03-fromenvfromenvfromenv");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

test("token-like values are masked, for every vendor", () => {
  const out = maskSecrets("key sk-ant-api03-AbCdEfGhIjKlMnOp, oauth sk-ant-oat01-ZyXwVuTsRqPo, aws AKIAABCDEFGHIJKLMNOP, Bearer abcdefghijklmnopqrstu");
  expect(out).not.toMatch(/AbCdEfGh|ZyXwVuTs|ABCDEFGHIJKLMNOP|abcdefghijklmnopqrstu/);
  expect(out).toContain("sk-ant-••••");
  const cases: [string, string, string][] = [
    ["OpenAI project", "sk-proj-Abc123Def456Ghi789Jkl012", "sk-proj-••••"],
    ["OpenAI", "sk-Abc123Def456Ghi789Jkl012Mno", "sk-••••"],
    ["OpenRouter", "sk-or-v1-0123456789abcdef0123456789abcdef", "sk-or-v1-••••"],
    ["xAI", "xai-AbCdEf0123456789GhIjKl0123456789", "xai-••••"],
    ["Google", "AIzaSyA0123456789abcdefghijklmnopqrstuv", "AIza••••"],
  ];
  for (const [, key, masked] of cases) {
    const m = maskSecrets(`the key ${key} failed`);
    expect(m).toBe(`the key ${masked} failed`);
  }
});

test("saveConfig changes only the keys it sets and keeps comments", () => {
  const path = process.env.GLUON_CONFIG!;
  writeFileSync(path, "# mine\nconnections: { claude-code: { auth: subscription } } # keep\nbedrock: { region: eu-west-1 }\n");
  saveConfig([[["connections", "codex"], { auth: "api", provider: "openai" }], [["brain", "active"], 2]]);
  const text = readFileSync(path, "utf8");
  expect(text).toContain("# mine");
  expect(text).toContain("region: eu-west-1");
  const config = loadConfig();
  expect(config.connections).toEqual({ "claude-code": { auth: "subscription" }, codex: { auth: "api", provider: "openai" } });
  expect(config.brain.active).toBe(2);
  rmSync(path);
});

/**
 * A fake SDK `query`: plays a script against the session's in-process tools, the way `claude`
 * would, and records every tool result. Nothing leaves the process.
 */
function fakeQuery(script: { text?: string; tool?: { name: string; input: Record<string, unknown> } }[][]) {
  const results: string[] = [];
  const run = (({ prompt, options }: Parameters<typeof sdkQuery>[0]) => {
    const tools = (options!.mcpServers!.gluon as unknown as { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }> } }).instance._registeredTools;
    async function* messages(): AsyncGenerator<SDKMessage> {
      const ev = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null, session_id: "s", uuid: crypto.randomUUID() }) as unknown as SDKMessage;
      for await (const _ of prompt as AsyncIterable<unknown>) {
        for (const step of script.shift() ?? []) {
          yield ev({ type: "message_start", message: {} });
          if (step.text) {
            yield ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
            yield ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } });
          }
          if (step.tool) yield ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: `mcp__gluon__${step.tool.name}`, input: {} } });
          yield ev({ type: "message_stop" });
          if (step.tool) results.push((await tools[step.tool.name]!.handler(step.tool.input, {})).content[0]!.text);
        }
        yield { type: "result", subtype: "success", is_error: false, result: "", session_id: "s" } as unknown as SDKMessage;
      }
    }
    return Object.assign(messages(), { interrupt: async () => {}, close: () => {} });
  }) as unknown as typeof sdkQuery;
  return { run, results };
}

test("on the plan, questions, proposals and exploring look the same, and nothing calls the network", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("no network in subscription mode");
  }) as unknown as typeof fetch;
  try {
    const choice = { harness: "claude-code", model: "sonnet", effort: "low", reason: "small", spec: "Fix add." };
    const routeInput = { types: [{ type: "feature", model_steps: 0, effort_steps: 0 }], pinned: "claude-code/sonnet@low" };
    const proposeInput = { name: "fix-add", spec: choice.spec, types: ["feature"], reason: choice.reason };
    const { run, results } = fakeQuery([
      [
        { text: "Let me look.", tool: { name: "list_files", input: {} } },
        { tool: { name: "ask_user", input: { question: "Add a test?", options: [{ label: "Yes" }, { label: "No" }] } } },
        { tool: { name: "route", input: routeInput } },
        { text: "Here's the plan.", tool: { name: "propose_launch", input: proposeInput } },
        { text: "Done." },
      ],
    ]);
    const config = loadConfig();
    const session = new Session(subscriptionBrain("claude-sonnet-5-5", ROOT, run), config, "You are Gluon.", ROOT);
    let state: State = session.snapshot;
    session.subscribe((s) => (state = s));

    await session.submit("fix the add bug");
    expect(state.pending).toMatchObject({ kind: "question", question: { question: "Add a test?" } });
    expect(state.items.map((i) => i.kind)).toEqual(["user", "assistant", "explored"]);
    expect(results[0]).toContain("package.json");

    await session.submit("Yes");
    expect(results[1]).toBe("The developer answered: Yes");
    expect(JSON.parse(results[2]!)).toMatchObject({ mode: "build", recommended: { harness: "claude-code", model: "sonnet", effort: "low" } });
    expect(state.pending).toMatchObject({ kind: "proposal", choice: { model: "sonnet" } });
    expect(session.confirm()).toMatchObject({ ...choice, spec: choice.spec });

    await session.submit("cheaper");
    expect(results[3]).toBe("The developer did not launch. They replied: cheaper");
    expect(state.pending).toBeNull();
    expect(state.workingSince).toBeNull();
    expect(state.items.map((i) => i.kind)).toEqual(["user", "assistant", "explored", "question", "user", "assistant", "proposal", "user", "assistant"]);
    session.close();
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("BUG-85/10: when `claude` stops mid-session, the next message restarts it and says the brain forgot", async () => {
  let starts = 0;
  const run = (({ prompt }: Parameters<typeof sdkQuery>[0]) => {
    starts++;
    async function* messages(): AsyncGenerator<SDKMessage> {
      for await (const _ of prompt as AsyncIterable<unknown>) {
        // The turn says something (a silent one gets its own notice, BUG-630).
        const ev = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null, session_id: "s", uuid: crypto.randomUUID() }) as unknown as SDKMessage;
        yield ev({ type: "message_start", message: {} });
        yield ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        yield ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi." } });
        yield ev({ type: "message_stop" });
        yield { type: "result", subtype: "success", is_error: false, result: "", session_id: "s" } as unknown as SDKMessage;
        return; // `claude` exits after one turn
      }
    }
    return Object.assign(messages(), { interrupt: async () => {}, close: () => {} });
  }) as unknown as typeof sdkQuery;
  const session = new Session(subscriptionBrain("claude-sonnet-5-5", ROOT, run), loadConfig(), "You are Gluon.", ROOT);
  await session.submit("hello");
  expect(session.snapshot.items.filter((i) => i.kind === "notice")).toEqual([]);
  await Bun.sleep(50);
  await session.submit("again");
  expect(starts).toBe(2);
  expect(session.snapshot.items.filter((i) => i.kind === "notice")).toEqual([expect.objectContaining({ tone: "info", text: expect.stringContaining("doesn't remember this conversation") })]);
  session.close();
});

describe("the plan brain's start-up (the SDK loads lazily)", () => {
  const noHooks = { begin() {}, text() {}, end() {}, tool: async () => ({ content: "" }) } as unknown as Parameters<ReturnType<typeof subscriptionBrain>["send"]>[2];
  function fake() {
    const log: string[] = [];
    const run = (({ prompt }: Parameters<typeof sdkQuery>[0]) => {
      log.push("run");
      let closed = false;
      async function* messages(): AsyncGenerator<SDKMessage> {
        for await (const _ of prompt as AsyncIterable<unknown>) log.push("got");
        if (closed) return;
      }
      return Object.assign(messages(), { interrupt: async () => void log.push("interrupt"), close: () => (closed = true, void log.push("close")) });
    }) as unknown as typeof sdkQuery;
    return { log, brain: subscriptionBrain("claude-sonnet-5-5", ROOT, run) };
  }

  test("an abort while the SDK loads still interrupts the query", async () => {
    const { log, brain } = fake();
    const ac = new AbortController();
    void brain.send("hello", "sys", noHooks, ac.signal).catch(() => {});
    ac.abort();
    await Bun.sleep(100);
    expect(log).toContain("interrupt");
    brain.close?.();
  });

  test("close() while the SDK loads leaves no live query, and a later send starts a fresh one", async () => {
    const { log, brain } = fake();
    const first = brain.send("hello", "sys", noHooks, new AbortController().signal);
    first.catch(() => {});
    brain.close?.();
    await expect(first).rejects.toThrow("closed");
    expect(log).not.toContain("run");
    void brain.send("again", "sys", noHooks, new AbortController().signal).catch(() => {});
    await Bun.sleep(100);
    expect(log.filter((l) => l === "run")).toHaveLength(1);
    expect(log).toContain("got");
    brain.close?.();
  });

  test("two sends before the query exists share one query", async () => {
    const { log, brain } = fake();
    void brain.send("one", "sys", noHooks, new AbortController().signal).catch(() => {});
    void brain.send("two", "sys", noHooks, new AbortController().signal).catch(() => {});
    await Bun.sleep(100);
    expect(log.filter((l) => l === "run")).toHaveLength(1);
    brain.close?.();
  });
});

describe("masking (QA pass 2)", () => {
  test("BUG-55/5.4: every key shape the providers table hands out is masked", () => {
    const samples: Record<string, string> = {
      anthropic: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      openai: "sk-proj-abcdefghijklmnopqrstuvwxyz0123",
      openrouter: "sk-or-v1-0123456789abcdef0123456789abcdef",
      "sk- keys (DeepSeek, Moonshot, DashScope, OpenCode)": "sk-0123456789abcdef0123456789abcdef",
      xai: "xai-abcdefghijklmnopqrstuvwxyz012345",
      gemini: "AIzaSyA1234567890abcdefghijklmnopqrstu",
      zai: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp",
      meta: "LLM|1234567890123456|AbCdEfGhIjKlMnOpQrStUvWxYz",
      "google oauth": "ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz",
      "aws access key id": "AKIAABCDEFGHIJKLMNOP",
      "aws secret key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "aws session token": "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD",
      "bedrock api key": "ABSKQmVkcm9ja0FQSUtleS1hYmNkZWZnaGlqa2xtbm9w",
      github: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    };
    for (const [name, key] of Object.entries(samples)) {
      const out = maskSecrets(`error: ${key} end`);
      expect([name, out.includes(key.slice(-10))]).toEqual([name, false]);
      expect(out).toStartWith("error: ");
    }
    // Ordinary text stays as it is.
    expect(maskSecrets("src/agent/codex.ts line 42: model gpt-6-luna")).toBe("src/agent/codex.ts line 42: model gpt-6-luna");
  });

  test("BUG-55/5.4: a key Gluon knows is masked by value, whatever its shape", () => {
    saveSecret("DASHSCOPE_API_KEY", "plainKEYwithNoKnownShape42");
    process.env.AWS_BEARER_TOKEN_BEDROCK = "anotherPlainValueNoShape99";
    try {
      expect(maskSecrets("got plainKEYwithNoKnownShape42 and anotherPlainValueNoShape99")).toBe("got •••• and ••••");
    } finally {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    }
  });

  test("BUG-86/11: only secrets in Gluon's .env files are masked by value, not its other settings", () => {
    writeFileSync(join(TMP, ".env"), "AWS_REGION=us-east-1-long\nAWS_PROFILE=my-work-profile\nMY_SERVICE_TOKEN=plainTokenValueNoShape7\nDEEPSEEK_API_KEY=plainKeyValueNoShape123\n");
    loadSecrets();
    try {
      expect(maskSecrets("region us-east-1-long, profile my-work-profile")).toBe("region us-east-1-long, profile my-work-profile");
      expect(maskSecrets("got plainTokenValueNoShape7 and plainKeyValueNoShape123")).toBe("got •••• and ••••");
    } finally {
      rmSync(join(TMP, ".env"), { force: true });
      loadSecrets();
    }
  });

  test("BUG-52/2.7: a key saved by Gluon wins over the environment's", () => {
    process.env.XAI_API_KEY = "xai-fromtheenvironment0000";
    try {
      expect(secret("XAI_API_KEY")).toBe("xai-fromtheenvironment0000");
      saveSecret("XAI_API_KEY", "xai-savedbygluon111111");
      expect(secret("XAI_API_KEY")).toBe("xai-savedbygluon111111");
      loadSecrets();
      expect(secret("XAI_API_KEY")).toBe("xai-savedbygluon111111");
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });
});

describe("installing a harness (Phase 4)", () => {
  /** Each vendor's own hosts, and its official npm package where it publishes one. */
  const ALLOWED: Record<Harness, { hosts: string[]; npm?: string }> = {
    "claude-code": { hosts: ["claude.ai"] },
    codex: { hosts: ["chatgpt.com", "registry.npmjs.org"], npm: "@openai/codex" },
    antigravity: { hosts: ["antigravity.google"] },
    "grok-build": { hosts: ["x.ai"] },
    opencode: { hosts: ["opencode.ai", "registry.npmjs.org"], npm: "@opencode/cli" },
    "kimi-code": { hosts: ["code.kimi.com"] },
  };
  const all = HARNESSES.flatMap((h) => (["posix", "win32"] as const).flatMap((p) => (HARNESS_INFO[h].install[p] ?? []).map((m) => ({ h, p, m }))));

  test("every harness has a method on each platform, the vendor's docs on https", () => {
    for (const h of HARNESSES) for (const p of ["posix", "win32"] as const) expect(HARNESS_INFO[h].install[p]?.length).toBeGreaterThan(0);
    for (const { m } of all) expect(new URL(m.docs).protocol).toBe("https:");
  });

  test("the vendor's own installer over https from its own host, or its official npm package; no sudo, nothing interpolated", () => {
    for (const { h, p, m } of all) {
      const at = `${h}/${p}: ${m.command}`;
      expect(ALLOWED[h].hosts, at).toContain(m.host);
      expect(m.command, at).not.toMatch(/sudo|\$|`|;|&|>|<|\bhttp:/);
      if (m.shell === "sh") {
        const [, url, shell] = m.command.match(/^curl -fsSL (https:\/\/\S+) \| (bash|sh)$/) ?? [];
        expect(url, at).toBeDefined();
        expect(new URL(url!).host, at).toBe(m.host);
        expect(m.needs, at).toEqual(["curl", shell!]);
        expect(p, at).toBe("posix");
      } else if (m.shell === "powershell") {
        const [, url] = m.command.match(/^irm (https:\/\/\S+\.ps1) \| iex$/) ?? [];
        expect(url, at).toBeDefined();
        expect(new URL(url!).host, at).toBe(m.host);
        expect(m.needs, at).toEqual(["powershell"]);
        expect(p, at).toBe("win32");
      } else {
        expect(m.shell, at).toBe("exec");
        expect(m.argv, at).toEqual(["npm", "install", "-g", ALLOWED[h].npm!]);
        expect(m.command, at).toBe(m.argv!.join(" "));
        expect(m.host, at).toBe("registry.npmjs.org");
      }
    }
  });

  test("only install.ts runs an installer, through the shell it names (sh, Windows PowerShell by path, npm): no --yes", () => {
    const src = readFileSync(join(ROOT, "src/install.ts"), "utf8");
    expect(src).toContain('[bin, "-c", m.command]');
    expect(src).toContain('[ps, "-NoProfile", "-Command", m.command]');
    expect(src).not.toMatch(/ExecutionPolicy|"--yes"|"sudo"|readFileSync|Bun\.file/);
    for (const f of readdirSync(join(ROOT, "src"), { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(f) || f === "install.ts" || f === "harnesses.ts") continue;
      expect(readFileSync(join(ROOT, "src", f), "utf8"), f).not.toMatch(/\b(curl|irm|npm install) [^\n]*|\| (bash|sh|iex)\b/);
    }
    const cli = readFileSync(join(ROOT, "src/main.tsx"), "utf8");
    expect(cli).not.toMatch(/\byes\b.*type: "boolean"/);
  });
});
