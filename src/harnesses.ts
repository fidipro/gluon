/**
 * The coding agents Gluon fronts, one descriptor each: binary, how to install it, how it signs
 * in (an API key from a provider, or the user's own subscription through the agent's own login),
 * its model catalog (`DEFAULT_MODELS`: facts, not configuration) and how it is launched. Config, launchers,
 * onboarding and doctor all read from here.
 *
 * CLI flags were checked against each binary's `--help` (claude 2.1, codex 0.159, agy 1.2,
 * grok 1.0, opencode 2.0, kimi 2.1); `doctor` catches drift.
 */


export type Harness = "claude-code" | "codex" | "antigravity" | "grok-build" | "opencode" | "kimi-code";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/**
 * How a session starts: `build` is the harness as it is (no flags added); `explore` strictly
 * read-only (writes fail, nothing asks to escalate); `plan` the harness's own plan mode.
 */
export type Mode = "build" | "explore" | "plan";
export const MODES: readonly Mode[] = ["build", "explore", "plan"];

/** A mode the harness can't run (`ModeLaunch.unavailable`), said to the developer and to the brain. */
export const modeUnavailable = (label: string, mode: Mode, why: string): string => `${label} can't start in ${mode} mode: ${why}`;

/** What a harness needs to start in a mode other than build (`HarnessInfo.modes`). */
export interface ModeLaunch {
  /** Options before the spec (with the connection's and the adapter's). */
  argv?: string[];
  /** Merged into the OpenCode config Gluon passes in `OPENCODE_CONFIG_CONTENT`. */
  opencodeConfig?: Record<string, unknown>;
  /**
   * The harness has no flag for it: Gluon types this slash command into the agent's PTY once its
   * composer is up, before anything else (the spec then goes in a file the typed line names).
   * Needs Gluon's frame: refused for `--launch` and without a pseudo-terminal.
   */
  typed?: "/plan";
  /** Shown with the mode when the harness does it another way (Antigravity's explore is its plan mode). */
  note?: string;
  /**
   * The harness keeps at least part of this mode in its own session (Claude Code's `dontAsk` permission mode survived a resume,
   * live, QA-live-02; its `--disallowedTools` was not seen to). A resume still applies explore's `argv` and `opencodeConfig` again,
   * as defence in depth (`buildCommand`), but a saved session with no mode is not refused (`modeLostOnResume`: the session
   * itself still holds the main part). Plan is never applied again: it is a state of the conversation.
   */
  partlyKeptOnResume?: true;
  /**
   * The harness can't run this mode (Kimi Code's explore): why. Gluon never starts it (`buildCommand`, `validateChoice`
   * refuse), the brain is told, and routing leaves the harness out of a session in that mode (`RouteHarness.noModes`).
   */
  unavailable?: string;
}
/** Whose subscription a harness signs in with. */
export type Vendor = "claude" | "chatgpt" | "google" | "xai" | "opencode" | "moonshot";

export type ProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "xai"
  | "moonshot"
  | "bedrock"
  | "openrouter"
  | "opencode-go";

/** How a harness reaches a model: its own subscription login ("plan"), or a provider's API key. */
export type Conn = "plan" | ProviderId;

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** The key's environment variable; none for Bedrock (AWS profile and region instead) and for a plan (`subscription`). */
  env?: string;
  /**
   * Not a key: a plan the user signs in to through the harness's own official login (OpenCode's `opencode-go`). It
   * is a subscription like the harness plans: personal use, signed in and checked by the official binary only, launched with no key.
   */
  subscription?: Subscription;
  /** Where to create a key. */
  keyUrl?: string;
  /** Serves other vendors' models (Bedrock, OpenRouter). */
  aggregator?: boolean;
  /** OpenCode's name for this provider (the part before the "/" in `--model`). */
  opencodeId?: string;
  /** An endpoint that lists the models this key can use, free of charge (probes). */
  models?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: { id: "anthropic", label: "Anthropic", env: "ANTHROPIC_API_KEY", keyUrl: "https://console.anthropic.com/settings/keys", opencodeId: "anthropic", models: "https://api.anthropic.com/v1/models?limit=1000" },
  openai: { id: "openai", label: "OpenAI", env: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys", opencodeId: "openai", models: "https://api.openai.com/v1/models" },
  gemini: { id: "gemini", label: "Gemini API", env: "GEMINI_API_KEY", keyUrl: "https://aistudio.google.com/apikey", opencodeId: "google", models: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000" },
  xai: { id: "xai", label: "xAI", env: "XAI_API_KEY", keyUrl: "https://console.x.ai", opencodeId: "xai", models: "https://api.x.ai/v1/models" },
  // Moonshot's global API (`api.moonshot.ai`; the mainland-China endpoint is another host and key). Kimi Code reaches it with no base URL: its environment model defaults there.
  moonshot: { id: "moonshot", label: "Moonshot AI", env: "MOONSHOT_API_KEY", keyUrl: "https://platform.moonshot.ai/console/api-keys", models: "https://api.moonshot.ai/v1/models" },
  bedrock: { id: "bedrock", label: "Amazon Bedrock", aggregator: true, opencodeId: "amazon-bedrock" },
  openrouter: { id: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY", keyUrl: "https://openrouter.ai/settings/keys", aggregator: true, opencodeId: "openrouter", models: "https://openrouter.ai/api/v1/models" },
  // The OpenCode plan: signed in by `opencode auth login opencode-go` (OpenCode asks for the plan's key itself; Gluon never sees it).
  // Its model listing is public: it proves what the plan serves, the binary's own `auth list` proves the sign-in.
  "opencode-go": {
    id: "opencode-go",
    label: "OpenCode Go plan",
    aggregator: true,
    opencodeId: "opencode-go",
    models: "https://opencode.ai/zen/go/v1/models",
    subscription: { vendor: "opencode", plan: "OpenCode Go plan", loginArgv: ["opencode", "auth", "login", "opencode-go"], loginNote: "OpenCode asks for the key of your OpenCode Go plan (opencode.ai/auth) and keeps it itself; Gluon never sees it." },
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** OpenRouter's documented endpoints: with OPENAI_API_BASE and ANTHROPIC_API_BASE (below), the only base URLs Gluon ever sets (API-key connections only). */
/** Said where an OpenRouter key is connected and by `gluon doctor`: Gluon reads the key's usage (`src/openrouter-billed.ts`), which only means something if nothing else spends on it. */
export const OPENROUTER_KEY_NOTICE = "Use an OpenRouter key only Gluon uses: Gluon reads the key's usage to show what each session was billed.";
export const OPENROUTER_ANTHROPIC_BASE = "https://openrouter.ai/api";
export const OPENROUTER_OPENAI_BASE = "https://openrouter.ai/api/v1";
/**
 * OpenAI's own API endpoint. Only for Codex on an OpenAI key: a key provider pointed here makes
 * `codex` use the key even when it is also signed in to ChatGPT (its built-in `openai` provider
 * prefers the ChatGPT login). It is OpenAI's documented endpoint, not a redirect.
 */
export const OPENAI_API_BASE = "https://api.openai.com/v1";
/**
 * Anthropic's own API endpoint. Gluon's own clients (the brain on an Anthropic key, its probe) pass it
 * explicitly: the SDK would take `ANTHROPIC_BASE_URL` from the environment, key and conversation with it (QA-sec-17).
 */
export const ANTHROPIC_API_BASE = "https://api.anthropic.com";
/** Bedrock's runtime endpoint for a region, which the Anthropic Bedrock SDK otherwise takes from `ANTHROPIC_BEDROCK_BASE_URL` (QA-sec-17). */
export const bedrockRuntimeBase = (region: string): string => `https://bedrock-runtime.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;

/** One model a harness can be launched with. `ids`: the id per connection (a missing one: not served there). */
export interface ModelEntry {
  /** What the brain proposes and `--launch --model` takes. */
  id: string;
  label: string;
  note: string;
  ids: Partial<Record<Conn, string>>;
  /** The efforts this model takes, in order; [] = no effort control (omit effort). */
  efforts: Effort[];
  /** The model's sweet spot (effort labels mean different amounts of thinking across models); unset: medium where it takes it. */
  defaultEffort?: Effort;
  /**
   * The connections where the harness can apply `efforts`; unset: every one. On another connection the model takes no effort
   * (`effortsOn`): Kimi K3's effort is Kimi's `KIMI_MODEL_THINKING_EFFORT`, which only its own (plan) provider reads.
   */
  effortConns?: Conn[];
  /** Models of one family can be told to delegate to each other as subagents (OpenCode). */
  family?: string;
  /**
   * For a "latest" alias: the concrete model id it means today. The per-connection `ids` are built from it (an
   * alias isn't priced or listed by every provider), so a new version is one edit here.
   */
  current?: string;
  /** The key (of routing.yaml) that must be true before this model is offered: the maker gets the session's code. */
  optIn?: string;
  /** Who gets the session's code and prompts when this model runs (named to the user). */
  sharesDataWith?: string;
}

export interface Subscription {
  vendor: Vendor;
  /** "Claude plan", "ChatGPT plan", … */
  plan: string;
  /** The harness's own sign-in command (a terminal handoff). */
  loginArgv: string[];
  /** Said with the login offer (e.g. that the agent's own UI signs in). */
  loginNote?: string;
}

/** Where an install method runs: Linux, macOS and WSL ("posix"), or native Windows. */
export type InstallPlatform = "posix" | "win32";

/**
 * One official way to install a harness, as its vendor documents it. Constants only: what is
 * shown is exactly what runs (`install.ts`), never with anything filled in.
 */
export interface InstallMethod {
  /** sh: `sh -c <command>`; powershell: Windows PowerShell `-NoProfile -Command <command>`; exec: `argv` as it is. */
  shell: "sh" | "powershell" | "exec";
  command: string;
  /** exec only: the command as argv (its first word found on PATH). */
  argv?: string[];
  /** Programs it needs on PATH ("powershell": Windows' own). */
  needs: string[];
  /** Where it downloads from. */
  host: string;
  docs: string;
  /** Checked against the vendor's docs; an unchecked method is shown with its docs link only, never run. */
  verified: boolean;
  /** Said with it (e.g. the vendor recommends WSL). */
  note?: string;
}

const curl = (url: string, shell: "bash" | "sh", docs: string): InstallMethod => ({ shell: "sh", command: `curl -fsSL ${url} | ${shell}`, needs: ["curl", shell], host: new URL(url).host, docs, verified: true });
const irm = (url: string, docs: string): InstallMethod => ({ shell: "powershell", command: `irm ${url} | iex`, needs: ["powershell"], host: new URL(url).host, docs, verified: true });
const npm = (pkg: string, docs: string, note?: string): InstallMethod => ({ shell: "exec", command: `npm install -g ${pkg}`, argv: ["npm", "install", "-g", pkg], needs: ["npm"], host: "registry.npmjs.org", docs, verified: true, ...(note ? { note } : {}) });

const DOCS = {
  claude: "https://code.claude.com/docs/en/setup",
  codex: "https://learn.chatgpt.com/docs/codex/cli",
  agy: "https://github.com/google-antigravity/antigravity-cli",
  grok: "https://docs.x.ai/build/overview",
  opencode: "https://opencode.ai/v2/docs",
  kimi: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
};

export interface HarnessInfo {
  id: Harness;
  label: string;
  binary: string;
  /** Who makes it (the installer's publisher). */
  vendor: string;
  /** The official install methods per platform, the vendor's recommended one first (checked 2026-09-30). */
  install: Partial<Record<InstallPlatform, InstallMethod[]>>;
  note: string;
  /**
   * Which of the repository's instruction files the harness loads into its own context (checked against each
   * binary, 2026-10: claude 2.1.289, codex 0.159, agy 1.2, grok 1.0.46, opencode 2.0). The launcher tells the
   * agent to read the others (`unloadedInstructionFiles`, `src/intake.ts`). `firstOnly`: of `files`, only the
   * first one the repository has (Claude Code: CLAUDE.md, and AGENTS.md only when there is no CLAUDE.md).
   */
  instructionFiles: { files: string[]; firstOnly?: boolean };
  /** How it starts in explore and plan (build adds nothing). */
  modes: Record<Exclude<Mode, "build">, ModeLaunch>;
  /** API-key providers, in the order offered. */
  providers: ProviderId[];
  /** Several providers at once (OpenCode: its plan and OpenRouter); otherwise one connection: a provider or the subscription. */
  multiProvider?: boolean;
  subscription?: Subscription;
  /** Said when the harness is connected with an API key (what the user must set themselves). */
  keyNote?: Partial<Record<ProviderId, string>>;
  /**
   * The harness takes no prompt on its command line (Kimi Code): Gluon types the brief line into its terminal once its
   * composer is up (`Command.firstLine`, `launchPlan`), so it starts only in Gluon's frame, never with `--launch`.
   */
  typedSpec?: boolean;
  /** The oldest major version Gluon launches (its argv changed): an older one is refused. */
  minMajor?: number;
  /**
   * How a session of it can be resumed (`workspaces.ts`): `minted` — Gluon names the session at the
   * launch (`session`); `captured` — the agent's hook sends its id (`session` event). None: it
   * can't be resumed reliably (Antigravity: no hooks, and `--continue` takes the newest in the directory).
   */
  resume?: "minted" | "captured";
  /**
   * argv for a launch; `model` is the id for the connection, `extra` the connection's and the adapter's options (before the spec, which stays last).
   * `session`: a minted id to start under (`resume: false`), or the session to resume (`resume: true`, no spec: the
   * argv ends with the id, after `--` where the harness has one).
   */
  argv(model: string, effort: Effort | undefined, spec: string, extra: string[], session?: SessionRef): string[];
}

/** A harness session: to start under this id, or (`resume`) to reopen. */
export interface SessionRef {
  id: string;
  resume: boolean;
}

export const HARNESS_INFO: Record<Harness, HarnessInfo> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    binary: "claude",
    vendor: "Anthropic",
    install: { posix: [curl("https://claude.ai/install.sh", "bash", DOCS.claude)], win32: [irm("https://claude.ai/install.ps1", DOCS.claude)] },
    note: "Anthropic's own harness. Strongest general coding agent; best for multi-file features, debugging and refactors.",
    instructionFiles: { files: ["CLAUDE.md", "AGENTS.md"], firstOnly: true },
    modes: {
      // dontAsk denies whatever would ask (a writing Bash too); the write tools, plan mode and worktrees are gone from the tool list.
      explore: { argv: ["--permission-mode", "dontAsk", "--disallowedTools", "Edit", "Write", "NotebookEdit", "EnterPlanMode", "ExitPlanMode", "EnterWorktree"], partlyKeptOnResume: true },
      plan: { argv: ["--permission-mode", "plan"] },
    },
    providers: ["anthropic", "bedrock", "openrouter"],
    subscription: { vendor: "claude", plan: "Claude plan", loginArgv: ["claude", "auth", "login"] },
    resume: "minted",
    argv: (model, effort, spec, extra, session) => [
      "claude", "--model", model, ...(effort ? ["--effort", effort] : []), ...extra,
      ...(session?.resume ? [`--resume=${session.id}`] : [...(session ? ["--session-id", session.id] : []), "--", spec]),
    ],
  },
  codex: {
    id: "codex",
    label: "Codex",
    binary: "codex",
    vendor: "OpenAI",
    install: {
      posix: [curl("https://chatgpt.com/codex/install.sh", "sh", DOCS.codex), npm("@openai/codex", DOCS.codex)],
      win32: [irm("https://chatgpt.com/codex/install.ps1", DOCS.codex), npm("@openai/codex", DOCS.codex)],
    },
    note: "OpenAI's harness. Strong at well-specified implementation work and careful, test-driven changes.",
    instructionFiles: { files: ["AGENTS.md"] },
    // No flag or setting starts Codex in Plan mode (0.160: the TUI's initial collaboration mode
    // ignores config); `/plan <text>` switches to it and sends <text>. Plan mode has an effort of its
    // own (`plan_mode_reasoning_effort`, `buildCommand` sets it). Checked against a local sink:
    // read-only/never and Plan Mode reach the request; Plan mode alone keeps the sandbox.
    modes: {
      explore: { argv: ["-s", "read-only", "-a", "never"] },
      plan: { typed: "/plan" },
    },
    providers: ["openai", "bedrock", "openrouter"],
    subscription: { vendor: "chatgpt", plan: "ChatGPT plan", loginArgv: ["codex", "login"] },
    resume: "captured",
    // `codex resume` takes the same options; its session id is a positional.
    argv: (model, effort, spec, extra, session) => [
      "codex", ...(session?.resume ? ["resume"] : []), "-m", model, ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []), ...extra,
      "--", session?.resume ? session.id : spec,
    ],
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    binary: "agy",
    vendor: "Google",
    install: { posix: [curl("https://antigravity.google/cli/install.sh", "bash", DOCS.agy)], win32: [irm("https://antigravity.google/cli/install.ps1", DOCS.agy)] },
    note: "Google's harness on Gemini. Fast and cheap; good for well-scoped edits and quick fixes.",
    instructionFiles: { files: ["AGENTS.md", "GEMINI.md"] },
    // agy has no read-only mode (only accept-edits and plan): explore is its plan mode.
    modes: {
      explore: { argv: ["--mode=plan"], note: "plan mode" },
      plan: { argv: ["--mode=plan"] },
    },
    providers: ["gemini"],
    subscription: { vendor: "google", plan: "Google account", loginArgv: ["agy"], loginNote: "Antigravity signs in from its own screen; sign in there, then quit it (ctrl+c) to come back." },
    keyNote: { gemini: "Antigravity uses GEMINI_API_KEY only when its own settings say `modelProvider: gemini`. Gluon doesn't edit Antigravity's settings: set that yourself (Antigravity's settings.json)." },
    // agy's model ids carry the effort: gemini-3.8-flash-high. Go-style flags: `--flag=value` keeps a spec starting with "-" a value.
    argv: (model, effort, spec, extra) => ["agy", `--model=${model}-${effort ?? "medium"}`, ...extra, `--prompt-interactive=${spec}`],
  },
  "grok-build": {
    id: "grok-build",
    label: "Grok Build",
    binary: "grok",
    vendor: "xAI",
    install: { posix: [curl("https://x.ai/cli/install.sh", "bash", DOCS.grok)], win32: [irm("https://x.ai/cli/install.ps1", DOCS.grok)] },
    note: "xAI's harness on Grok. Quick, capable generalist; good value for everyday coding tasks.",
    instructionFiles: { files: ["AGENTS.md", "CLAUDE.md"] },
    modes: {
      // Live-checked on Grok 1.0.46 (2026-10-05). The TUI ignores `--permission-mode` (its docs: "accepted
      // for compatibility"), so neither `dontAsk` nor `plan` does anything there. `--sandbox read-only` is
      // a Landlock/Seatbelt profile that blocks writes even when approved, but alone it still asks "Allow
      // Edit…?"; `--deny` rules stop the prompts (the edit is denied, the model reports it blocked). Bash
      // is denied entirely: no read-only shell commands in explore, Grok's read, grep and list tools stay.
      // Plan mode has no flag: `/plan` types into the composer (`typed`; `<text>` after it starts a turn).
      explore: { argv: ["--sandbox", "read-only", "--deny", "Edit", "--deny", "Write", "--deny", "Bash"] },
      plan: { typed: "/plan" },
    },
    providers: ["xai"],
    subscription: { vendor: "xai", plan: "SuperGrok / X account", loginArgv: ["grok", "login"] },
    resume: "minted",
    argv: (model, effort, spec, extra, session) => [
      "grok", "-m", model, ...(effort ? ["--reasoning-effort", effort] : []), ...extra,
      ...(session?.resume ? [`--resume=${session.id}`] : [...(session ? ["--session-id", session.id] : []), "--", spec]),
    ],
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    vendor: "OpenCode",
    // OpenCode 2 (`@opencode/cli`); `opencode.ai/install` and `opencode-ai` are still 1.x. No v2
    // install.ps1: on Windows, npm.
    install: { posix: [curl("https://opencode.ai/v2/install", "bash", DOCS.opencode), npm("@opencode/cli", DOCS.opencode)], win32: [npm("@opencode/cli", DOCS.opencode)] },
    note: "Open-source harness on OpenRouter or the OpenCode Go plan. Good for well-scoped tasks when an open or cheaper model is enough.",
    instructionFiles: { files: ["AGENTS.md"] },
    // OpenCode 2's TUI takes no --agent: the starting agent is `default_agent` in its config.
    modes: {
      explore: {
        // Deny all, then allow reading (last match wins), as OpenCode's own explore subagent: no
        // edit, shell, subagent or outside directory, and no rule left that asks (checked on /api/agent).
        // The top-level `permissions` are a backstop, live-checked: with them even the `build` agent had
        // no write or shell tool, in case OpenCode restores the agent of a previous tab over `default_agent`.
        opencodeConfig: {
          permissions: [{ action: "edit", resource: "*", effect: "deny" }, { action: "shell", resource: "*", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }],
          default_agent: "gluon-explore",
          agents: {
            "gluon-explore": {
              description: "Read-only exploration",
              mode: "primary",
              permissions: [
                { action: "*", resource: "*", effect: "deny" },
                ...["read", "grep", "glob", "webfetch", "websearch", "question"].map((action) => ({ action, resource: "*", effect: "allow" })),
                { action: "read", resource: "*.env", effect: "deny" },
                { action: "read", resource: "*.env.*", effect: "deny" },
              ],
            },
          },
        },
      },
      plan: { opencodeConfig: { default_agent: "plan" } },
    },
    // Menu order: the API key first, as for every harness. Routing is separate: the prepaid plan wins a model both serve (`resolveModel`).
    providers: ["openrouter", "opencode-go"],
    multiProvider: true,
    minMajor: 2,
    // OpenCode 2's TUI takes no --model: the model and its effort go in OPENCODE_CONFIG_CONTENT (`buildCommand`).
    // --standalone: its own server, which sees the key in env; the shared background one doesn't.
    resume: "captured",
    argv: (_model, _effort, spec, extra, session) => ["opencode", "--standalone", ...extra, ...(session?.resume ? [`--session=${session.id}`] : [`--prompt=${spec}`])],
  },
  "kimi-code": {
    id: "kimi-code",
    label: "Kimi Code",
    binary: "kimi",
    vendor: "Moonshot AI",
    // The installer is glibc only (it refuses Alpine/musl) and edits the shell profile's PATH; it also renames a legacy Python `kimi-cli`
    // shim on PATH to `kimi-legacy`. Run verbatim, never with flags: the note says it.
    install: {
      posix: [{ ...curl("https://code.kimi.com/kimi-code/install.sh", "bash", DOCS.kimi), note: "Linux needs glibc: the installer refuses Alpine (musl). It adds kimi to your shell profile's PATH and renames an old Python `kimi-cli` on PATH to `kimi-legacy`." }],
      win32: [{ ...irm("https://code.kimi.com/kimi-code/install.ps1", DOCS.kimi), note: "Needs Git for Windows (kimi's shell). It renames an old Python `kimi-cli` on PATH to `kimi-legacy`." }],
    },
    note: "Moonshot AI's harness on Kimi K3 and K2.7 Code, on a Moonshot or OpenRouter API key, or the Kimi Code plan. Good for long agentic coding tasks at a modest price.",
    instructionFiles: { files: ["AGENTS.md"] },
    // Kimi 2.1 has no prompt flag: the brief is typed (`typedSpec`). Plan: `--plan` starts a new session in plan mode (Write and Edit limited to the plan file;
    // its Bash still asks). A resume applies no mode anyway. Explore has no way in: checked live on 2.1.1 against a local sink, the interactive TUI
    // ignores `--agent` and `--agent-file` (it binds the default agent whatever they say: the request still carried all 26 tools, Write, Edit and Bash
    // among them), and the other things that shape the tool list (`[tools] disabled`, deny rules, an agents directory) are Kimi's own files, which Gluon
    // never edits or moves. Recheck after a Kimi release (the harness-update runbook in the maintainers' private notes).
    modes: {
      explore: { unavailable: "its interactive mode ignores an agent file, so no flag can take its writing and shell tools away; use plan mode, or build" },
      plan: { argv: ["--plan"] },
    },
    providers: ["moonshot", "openrouter"],
    subscription: {
      vendor: "moonshot",
      plan: "Kimi Code plan",
      loginArgv: ["kimi", "login"],
      loginNote: "Kimi signs in with a code you confirm in your browser. If your plan is on kimi.ai (not mainland China), run `kimi login --region global` yourself instead.",
    },
    typedSpec: true,
    // No resume: Kimi can't be given a session id at the start and has no hook that reports its own; its only listing (`kimi session list`) can't tell
    // two sessions of one directory apart. Its own `kimi -S` picker resumes by hand.
    // The model and its effort go in the environment (`buildCommand`: `KIMI_MODEL_*` for an API key, `-m` and `KIMI_MODEL_THINKING_EFFORT` for the plan).
    argv: (_model, _effort, _spec, extra) => ["kimi", ...extra],
  },
};

export const HARNESSES = Object.keys(HARNESS_INFO) as Harness[];

export const installPlatform = (platform: NodeJS.Platform = process.platform): InstallPlatform => (platform === "win32" ? "win32" : "posix");

/** A harness's official install methods on this platform (none: its docs say how). */
export const installMethods = (h: Harness, platform?: NodeJS.Platform): InstallMethod[] => HARNESS_INFO[h].install[installPlatform(platform)] ?? [];

/** Why this version (`--version`, as `versionOf` reads it) can't be launched, or null; unknown passes. */
export function tooOld(h: Harness, version: string | null, platform?: NodeJS.Platform): string | null {
  const min = HARNESS_INFO[h].minMajor;
  const major = Number(version?.match(/^(\d+)\./)?.[1]);
  if (!min || !(major < min)) return null;
  return `${HARNESS_INFO[h].label} ${version} is too old for Gluon (it needs ${min}.x): ${installHint(h, platform)}`;
}

/** How to install a harness here, in one line: its recommended command (or its docs). */
export function installHint(h: Harness, platform?: NodeJS.Platform): string {
  const m = installMethods(h, platform).find((m) => m.verified);
  return m ? m.command : `see ${installMethods(h, platform)[0]?.docs ?? "its docs"}`;
}

/** Claude Code's `--effort` levels (checked 2026-10 against `claude --help`). */
const CLAUDE_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** Codex's `model_reasoning_effort` levels. */
const CODEX_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh"];

/** A Claude model: its ids per connection (Bedrock's are `global.` inference profiles: the cheapest, no regional premium). */
const claude = (id: string, label: string, note: string, ids: { alias: string; api: string; bedrock: string; openrouter: string }, defaultEffort?: Effort): ModelEntry => ({
  id,
  label,
  note,
  ids: { plan: ids.alias, anthropic: ids.api, bedrock: ids.bedrock, openrouter: ids.openrouter },
  efforts: CLAUDE_EFFORTS,
  ...(defaultEffort ? { defaultEffort } : {}),
});

/** A Codex model: one id on the plan and the API, `global.openai.*` (Bedrock's runtime inference profile) and OpenAI's id on OpenRouter. */
const gpt = (id: string, label: string, note: string, defaultEffort: Effort): ModelEntry => ({
  id,
  label,
  note,
  ids: { plan: id, openai: id, bedrock: `global.openai.${id}`, openrouter: `openai/${id}` },
  efforts: CODEX_EFFORTS,
  defaultEffort,
});

/** DeepSeek Flash's alias and what it means today (OpenRouter and the OpenCode plan both list this id). */
const DEEPSEEK_FLASH = "deepseek-v4.1-flash";

/**
 * The model catalog: facts about each model (efforts, ids per connection), not configuration. Ids are the vendors' published
 * ones, checked 2026-10-08; doctor verifies each. Dropped from earlier catalogs on purpose: the previous generation of each model,
 * GLM, Qwen, Kimi on OpenCode, DeepSeek Pro, gpt-oss and every fallback.
 */
export const DEFAULT_MODELS: Record<Harness, ModelEntry[]> = {
  "claude-code": [
    claude("haiku", "Haiku 5.5", "fast and cheap; small, well-specified edits", { alias: "haiku", api: "claude-haiku-5-5", bedrock: "global.anthropic.claude-haiku-5-5", openrouter: "anthropic/claude-haiku-5.5" }, "medium"),
    claude("sonnet", "Sonnet 5.5", "strong and mid-priced; default for most everyday tasks", { alias: "sonnet", api: "claude-sonnet-5-5", bedrock: "global.anthropic.claude-sonnet-5-5", openrouter: "anthropic/claude-sonnet-5.5" }, "high"),
    claude("opus", "Opus 5.5", "most capable, expensive; hard debugging, design, large changes", { alias: "opus", api: "claude-opus-5-5", bedrock: "global.anthropic.claude-opus-5-5", openrouter: "anthropic/claude-opus-5.5" }, "medium"),
    claude("fable", "Fable 5.1", "frontier model, most expensive; the hardest, longest tasks", { alias: "fable", api: "claude-fable-5-1", bedrock: "global.anthropic.claude-fable-5-1", openrouter: "anthropic/claude-fable-5.1" }, "high"),
  ],
  codex: [
    gpt("gpt-6-luna", "GPT-6 Luna", "fast and cheap; small, well-specified edits", "high"),
    gpt("gpt-6.1-sol", "GPT-6.1 Sol", "strong and mid-priced; everyday implementation work", "medium"),
    gpt("gpt-6-astra", "GPT-6 Astra", "most capable, expensive; hard, ambiguous work", "medium"),
  ],
  antigravity: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", note: "fast Gemini; good quality at a low price", ids: { plan: "gemini-3.8-flash", gemini: "gemini-3.8-flash" }, efforts: ["low", "medium", "high"], defaultEffort: "high" },
  ],
  "grok-build": [
    { id: "grok-4.7", label: "Grok 4.7", note: "xAI's newest; capable generalist", ids: { plan: "grok-4.7", xai: "grok-4.7" }, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
  ],
  opencode: [
    // A model both serve goes through the plan (`resolveModel`). DeepSeek takes low, high and max, so those are its levels; max is
    // its only measured reasoning variant and costs little, so it is the default. The plan's id is OpenCode's own: its live alias
    // `deepseek-flash` is not priced, so the alias never goes in `ids`.
    { id: "deepseek-flash", label: "DeepSeek Flash", note: `very cheap and fast; small, mechanical edits (follows the latest DeepSeek Flash: V4.1 today)`, family: "deepseek", current: DEEPSEEK_FLASH, ids: { "opencode-go": DEEPSEEK_FLASH, openrouter: `deepseek/${DEEPSEEK_FLASH}` }, efforts: ["low", "high", "max"], defaultEffort: "max" },
    // Muse Spark 1.3 is not on the plan (it lists only the contributor variant); max costs about xhigh's latency for a few points.
    { id: "muse-spark-1.3", label: "Muse Spark 1.3", note: "Meta's model; capable generalist", family: "muse", ids: { openrouter: "meta/muse-spark-1.3" }, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "max" },
    // Much cheaper, but the maker gets the session's code and prompts: offered only where routing.yaml's `allow_muse_contributor` is true. No `max`.
    { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor", note: "Meta's coding-tuned variant, very cheap; Meta receives the session's code and prompts", family: "muse", ids: { "opencode-go": "muse-spark-1.3-contributor", openrouter: "meta/muse-spark-1.3-contributor" }, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "xhigh", sharesDataWith: "Meta", optIn: "allow_muse_contributor" },
  ],
  "kimi-code": [
    // The plan's ids are Kimi's own (`kimi login` adds the aliases `kimi-code/<id>`: `buildCommand`). The plan has no K2.7 Code (its ids are k3, k3-256k,
    // kimi-for-coding = K2.8 Preview and the HighSpeed variant of K2.7): the model isn't offered there. K3 takes low, high and max on the plan only:
    // Kimi's effort variable reaches only its own (`kimi`) provider; over OpenRouter (an `openai` provider) nothing can set it, so K3 takes none there
    // (`effortConns`; live-checked on 2.1.1 against a local sink: no `reasoning_effort` in the request whatever the variable).
    { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", note: "Moonshot's coding model; cheap, good for well-scoped coding tasks (not on the plan)", ids: { moonshot: "kimi-k2.7-code", openrouter: "moonshotai/kimi-k2.7-code" }, efforts: [] },
    { id: "kimi-k3", label: "Kimi K3", note: "Moonshot's flagship; long agentic coding tasks, 1M context", ids: { plan: "k3", moonshot: "kimi-k3", openrouter: "moonshotai/kimi-k3" }, efforts: ["low", "high", "max"], defaultEffort: "high", effortConns: ["plan"] },
  ],
};

/**
 * MAINTAINERS ONLY: a cheap model for live tests over Bedrock (`bun run test:live`). Never in `DEFAULT_MODELS`: users never see,
 * route to or pin it. It exists only behind a seam (`GLUON_TEST_MAINTAINER_MODELS`, tests and source runs only: release builds compile it out).
 */
export const MAINTAINER_TEST_MODELS: Partial<Record<Harness, ModelEntry[]>> = {
  "claude-code": [{ id: "sonnet-4.6", label: "Sonnet 4.6", note: "maintainers' cheap live-test model (Bedrock only)", ids: { bedrock: "global.anthropic.claude-sonnet-4-6" }, efforts: ["low", "medium", "high"], defaultEffort: "low" }],
};

/** Whether the maintainer-model seam is on (never in a release build: the bundler folds the check, and the variable's name, away). */
export const maintainerModelsOn = (): boolean => (typeof GLUON_BUILD === "string" && GLUON_BUILD !== "test" ? false : !!process.env.GLUON_TEST_MAINTAINER_MODELS);
declare const GLUON_BUILD: string | undefined;

/** A fresh copy of the catalog a run uses: `DEFAULT_MODELS`, plus the maintainer models when the seam is on. */
export function catalog(): Record<Harness, ModelEntry[]> {
  const models = structuredClone(DEFAULT_MODELS);
  if (maintainerModelsOn()) for (const [h, list] of Object.entries(MAINTAINER_TEST_MODELS) as [Harness, ModelEntry[]][]) models[h].push(...structuredClone(list));
  return models;
}

/** "claude-code/bedrock/global.anthropic.claude-sonnet-5-5": the key a verified model is cached under. */
export const verifiedKey = (harness: Harness, conn: Conn, id: string) => `${harness}/${conn}/${id}`;
/** "claude-code/bedrock": the key a probed connection is recorded under. */
export const checkedKey = (harness: Harness, conn: Conn) => `${harness}/${conn}`;

/** The id a model has on a connection (none: not served there). */
export function idOn(entry: ModelEntry, conn: Conn): string | undefined {
  return entry.ids[conn];
}

/** The efforts this model takes on this connection: its own, or none where the harness can't apply them (`ModelEntry.effortConns`). */
export const effortsOn = (entry: Pick<ModelEntry, "efforts" | "effortConns">, conn: Conn): Effort[] => (!entry.effortConns || entry.effortConns.includes(conn) ? entry.efforts : []);

/** A connection that is a subscription: the harness's own plan, or a provider that is a plan (OpenCode's). Personal use; no key. */
export const isPlanConn = (conn: Conn): boolean => conn === "plan" || !!PROVIDERS[conn].subscription;

/** The sign-in of a subscription connection of this harness: its own plan's, or the plan provider's. */
export const subscriptionOf = (harness: Harness, conn: Conn): Subscription | undefined => (conn === "plan" ? HARNESS_INFO[harness].subscription : PROVIDERS[conn].subscription);
