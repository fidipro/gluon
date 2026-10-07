# src/ — instructions for coding agents

Gluon itself. Brain rules: `src/agent/AGENTS.md`; UI rules: `src/ui/AGENTS.md`.

## Subscriptions (Claude plan, ChatGPT plan, Google account, SuperGrok / X, OpenCode Go plan, Kimi Code plan)

- **Only official binaries sign in or check login**: `claude auth status|login`,
  `codex login status|login`, `agy models` / `agy`, `grok models|login`, `opencode auth list|login
  opencode-go` (the plan counts only a stored sign-in, `type: "credential"`: never an `OPENCODE_API_KEY` variable),
  `kimi login` / `kimi provider list` (text, never `--json`: it dumps keys; no status command exists).
  A plan brain runs only through `claude` (Agent SDK) or `codex app-server`.
- **Never read another tool's credentials** (`~/.claude`, `~/.codex/auth.json`, `~/.gemini/…`,
  `~/.grok/…`, OpenCode's auth file, `~/.kimi-code`, the keychain; never set `KIMI_CODE_HOME`) **or edit its files** — tell the user. Exception:
  one file or folder of Gluon's own in Grok Build's hooks dir and Antigravity's plugins dir
  (`src/adapters/permanent.ts` only), inert unless `GLUON_EVENTS` is set; uninstall removes it,
  and the legacy `fidicode` ones (removal only); with `cost.antigravity_statusline` on, also agy's
  `statusLine` key (`agy-settings.ts` only). A config is read for named keys only, never credentials
  (`src/cost/harness-config.ts` only). A resume id is Gluon's own or its hook's (`RESUME_ID`).
- **No base URL on a subscription or plan brain route**; only OpenRouter (its documented endpoint; Kimi Code's
  `KIMI_MODEL_BASE_URL` on it alone: `assertSafeEnv`'s harness argument) and Codex + OpenAI key (`model_providers.openai-api-key`; BUG-81). OTEL: loopback (`telemetryLaunch`).
- **No impersonation**: Gluon's prompt goes unchanged to `claude` and `codex app-server`. **Don't strip
  the user's variables** (`ANTHROPIC_API_KEY`, …): warn (`*EnvWarnings`).

## Spawning and the untrusted repo

- **Never spawn a bare name**: `binPath` (`detect.ts`); Windows system tools via `windowsTool`
  (BUG-102). **Never call `Bun.which`**: `onPath` reads the current PATH.
- **Status checks, probes, version checks, logins, installers run in `neutralCwd()`** (opencode
  would run the repo's `bunfig.toml`: BUG-98); only agent sessions and the brain work in the repo.
- **A pid alone is never "a Gluon"** (reused): compare its start too (`ownerAlive`; no `ps`; BUG-642); a claim two race for is exclusive, taken over under a lock (`claimWorkspace`; BUG-643).
- **Bun loads nothing from the cwd**: `bunfig.toml` `env = false`; shebangs
  `--no-env-file --config=/dev/null` (BUG-56); package scripts `--config=scripts/empty-bunfig.toml`.

## Keys and private files

- **Keys live in `secrets.ts` maps**, read only from the `.env` next to the config (saved beats environment). The
  brain's keys go to the SDK; a launch gets only its model's provider key. AWS profile and region only from `awsSetup()`
  (`config.ts`; BUG-68; the AWS config's `region` alone). A relative `XDG_*_HOME` is ignored (`xdg.ts`), a relative
  `GLUON_CONFIG` made absolute in `main.tsx` before `loadSecrets()` (BUG-620/621).
- **Private files: directory first**: fresh `privateDir` (0700; icacls on Windows), rename into place,
  remove the dir whatever happens (BUG-104/105). Order: check config, save keys, save config.
- **Windows keys outside the profile**: `icacls` to the user's SID (`whoami /user`, never `%USERNAME%`)
  by full path, before writing (BUG-96). Say it via `storageNote()`, never "readable only by you".

## Installing a harness (`install.ts`, `harnesses.ts`)

- Methods are constants (vendor's https installer or official npm package), shown and run
  verbatim, never `--yes`; without a terminal, only printed. Off-PATH binary: named, not used.
- The offer is a `guard`ed `pick`: ignores keys for `GUARD_MS`, pastes, mixed Enter, Alt+digit;
  doesn't wrap (BUG-109/110/111). Non-zero exit = failure (BUG-112); Ctrl+C → `Cancelled` (BUG-114).

## Launches (`launchers.ts`)

- **A spec may start with `-`**: after `--` (Claude Code, Codex, Grok), `--prompt=` (OpenCode),
  `--prompt-interactive=` (Antigravity). Kimi Code has no prompt flag (`typedSpec`): never in argv, only the typed brief line.
- **A harness signed in to its plan ignores an API key in env** (BUG-51): Codex gets its own provider
  with `env_key="OPENAI_API_KEY"` (never `forced_login_method="api"`: logs out); grok `GROK_AUTH_PATH` → nowhere.
- **On WSL, a harness only under `/mnt/<drive>/` is `foreign`**; a Linux one wins. **OpenCode runs
  `--standalone`**, also for `auth list`: its shared server never sees a launch's key (BUG-134).

## Windows

- **`.cmd`/`.bat` shims are BatBadBut**: `binPath` prefers `nativeExe`; a remaining shim gets a
  one-line prompt with the spec in a private temp file (`launchPlan`; BUG-103, BUG-108);
  `assertShimArgs` before every shim spawn. The Claude-plan brain needs `claude.exe`.
- **Kill with `killTree`**, not `proc.kill()`. **Compare long paths** (`longPath`, BUG-132).

## Keeping this file fresh

Follow "Keeping AGENTS.md files fresh" in the root `AGENTS.md`: update in the change that makes a line wrong; every name must exist; ≤ 70 lines.
