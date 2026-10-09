# Security

Gluon sits between you, your API keys and subscriptions, and the coding agents it launches. This page says what
it protects, what it doesn't, and how to report a problem. The details a user may want are in
[Security and privacy](docs/guides/security-privacy.md).

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/fidipro/gluon/security/advisories/new)
(Security → Report a vulnerability). Include what you found, how to reproduce it, and the version
(`gluon --version`) and platform. We aim to acknowledge within 3 working days and to agree on a fix and
disclosure date with you. Only the latest release gets security fixes.

## What Gluon protects

| Asset | How |
|---|---|
| API keys | Keys you save through Gluon stay out of `process.env`; they go to `.env` next to its config, readable only by you (mode 600; on Windows limited to your account and administrators). A launched agent gets only the saved key of its model's provider, plus your own shell environment. Token-like values are masked in everything Gluon prints or saves, by name and by shape. Gluon's own clients for the OpenAI, Anthropic and Bedrock APIs always use their provider's endpoint, so a `*_BASE_URL` or `AWS_ENDPOINT_URL*` in your environment (a repository's `.envrc` can set one) never receives a key or the conversation. |
| Subscriptions (Claude, ChatGPT, Google, SuperGrok / X, OpenCode Go, Kimi Code plans) | Opt-in, for you alone. Only the vendor's official binary signs in or checks login. Gluon never reads a credential file or the keychain, never adds a login token to an agent's environment, sets no base URL on a subscription, and never edits another tool's files. The one exception is a file of its own in Grok Build's hooks directory (`~/.grok/hooks/gluon.json`), inert unless Gluon started the session; `gluon uninstall` removes it. |
| Your repository | The intake agent (the brain) gets **read-only** tools sandboxed to the repository: no writes, no shell, no paths outside it, even through a symlink. Secret files (`.env*`, private keys, certificate and key stores, credential stores, Terraform state, service-account files, `kubeconfig`, `.git/config`; the list is `SECRET` in `src/agent/scan.ts`) can't be read, searched or diffed, under any spelling of the name. Results are size-capped. It can also read issues and pull / merge requests on github.com and gitlab.com through your own `gh` / `glab`, read-only, and it can read your uncommitted changes and history. |
| Gluon itself | It never loads the `.env` or `bunfig.toml` of the directory it runs in, so a repository's code can't run inside the process that holds your keys. Programs are found on `PATH` and run by absolute path; status checks, logins and installers run in an empty private directory. git runs with hooks, `core.fsmonitor`, network transports, external diff drivers, textconv and filter drivers switched off, and a repository whose work tree lies elsewhere is treated as no repository. |
| Keystrokes and agent screens | Agents run in a pseudo-terminal of Gluon's own, so it sees what you type and what they draw. Both stay in memory and are never logged, written to disk or sent anywhere. The screen alone never triggers anything. Gluon writes into an agent only your own keys, the terminal's answers to the agent's own queries, your mouse reports, and, for a launch mode with no flag (Codex's plan mode) or an agent that takes no prompt on its command line (Kimi Code), one line Gluon made for the launch. A drag over Gluon's own home view copies the covered text to your terminal's clipboard (OSC 52). |
| Saved sessions | `gluon resume` keeps one private file per workspace in `workspaces/` next to the config: repository path, the id and start time of the Gluon that has it open (with a small private `<id>.lock` claim file while a resumed Gluon runs), and per session its name, agent, model, mode, spec (keys masked) and the agent's session id. Never the intake chat, a key, an environment or a screen. The file is read back as untrusted text and every field is validated. `gluon uninstall` removes it. |
| Your machine | An agent installer runs only when you pick "Run it" on the exact command shown, pressed on its own; there is no `--yes`, and Gluon never uses sudo. |
| Releases | Every release carries `SHA256SUMS`; `install.sh` and `install.ps1` install nothing that doesn't match, download over https only and carry no token. `SHA256SUMS` is signed with keyless cosign by the Release workflow on `main` of this repository, and `install.sh` checks that signature when `cosign` is installed ([how to verify](docs/getting-started/install.md#verifying-by-hand)). Gluon's own updater always checks it, with the Sigstore libraries built in, and installs nothing unless both the signature and the checksum verify. |

`test/rules.test.ts` and the tests named in the code check most of these.

## What Gluon doesn't protect, and what it reads or writes

- **The agents Gluon launches** run with your permissions and their own security model; Gluon hands over the
  terminal. **Vendor installers** are the vendor's own commands, shown verbatim and run only after you confirm;
  Gluon can't pin or verify them.
- **The intake agent's LLM provider** (the step of `brain.order` in use) sees what you type in its chat, the
  repository's path, branch and top-level names, and whatever the agent lists, searches or reads. Gluon sends no telemetry.
- **The events channel.** A launched agent gets a private events directory (`GLUON_EVENTS`) that any process it
  starts inherits and can write to. The worst a forged event does is show a wrong status or answer the agent's own
  compaction question: events carry nothing Gluon runs, only plain files are read, and a status is size-capped, stripped of
  terminal escapes and masked before it is shown.
- **Cost and context figures** (display only). Claude Code and Codex export usage by OpenTelemetry to a listener of
  Gluon's on `127.0.0.1`, accepted only with a per-launch random token; prompts and tool content are switched off and only
  counts are kept. Codex takes the token on its command line, visible to other users of the machine (`ps`); with it they
  could only send that session false figures. Grok Build's export is decoded by the same listener, and after a turn Gluon
  runs Grok's own `grok usage <session id>`. Kimi Code's figure comes from its `kimi export`, read in memory from a fresh
  private directory that is removed at once; only token counts, model and agent ids are kept. Antigravity's needs one key
  in its own settings file, written only if you turn on `cost.antigravity_statusline` (never on Windows) and removed by
  `gluon uninstall`.
- **The cost audit ledger** (on by default; `cost.audit: off` keeps none) holds counts and names only, from a
  whitelist: never a prompt, a response, an id, a host or a path. It lives in a private directory under the state
  directory (`$XDG_STATE_HOME/gluon/cost-audit/`, `%LOCALAPPDATA%\gluon\cost-audit\` on Windows). `gluon cost-report`
  reads it; `gluon uninstall` removes it.
- **The session analytics database** (on by default; `analytics: off` stops it) holds one row per launched session in
  `analytics.db` in the state directory: the spec (keys masked), the repository's path, harness, model, session id, times
  and cost. **Unlike the cost ledger, it holds a prompt and a path.** It never holds a key, an environment or a screen,
  never leaves your machine, and is private to you. `gluon stats --delete` empties it; `gluon uninstall` removes it.
- **Price and window tables.** Gluon builds its own on your machine; none ships with it. They need plain
  unauthenticated `GET`s with nothing of yours in them to exactly two hosts, `models.dev` and `openrouter.ai`, at start and
  at a harness launch (at most every 10 minutes) or with `gluon pricing update`; there is no switch to turn them off.
  Responses are size-capped, https to the same host (a redirect is an error), and validated before use. Gluon also runs
  your installed `claude`, `codex` and `grok` to read a version or model catalog, never to call a model.
- **Gluon's own updates** (`updates: auto` by default; `notify` only says, `off` never checks; `GLUON_UPDATES` wins). At start
  (once a day while up to date, at each start while an update is pending) and with `gluon update`, plain unauthenticated `GET`s with nothing of yours in them go to
  `github.com` (the latest release's version, then its files, served from `objects.githubusercontent.com` or
  `release-assets.githubusercontent.com`) and to Sigstore's `tuf-repo-cdn.sigstore.dev` (its trusted root). `auto` replaces
  the standalone binary in place: it runs from your next start.
- **What Gluon reads of other tools' settings**, and nothing else of them: two cache-TTL keys (`promptCacheTtl`,
  `subagentPromptCacheTtl`) from Claude Code's settings files, which are treated as untrusted
  (`src/cost/harness-config.ts`); and the `region` of your AWS profile when no region is set (`awsConfigRegion`,
  `src/config.ts`), never `~/.aws/credentials`. Gluon never reads `~/.kimi-code`.
- Anyone with access to your user account can read files your user can read, including saved keys.

<!-- Keeping this file fresh:
Update in the change that alters a guarantee it states (keys, subscriptions, the untrusted repository, what Gluon
sees and writes into an agent, the events channel, the telemetry listener, saved sessions, the cost ledger, the
analytics database, the price tables, Gluon's own updates, the settings Gluon reads, releases). Keep it equal to
docs/guides/security-privacy.md. Keep it to guarantees and disclosures an outside reader can use: no bug or issue
numbers; mechanism detail belongs in code comments and tests (test/contributor-docs.test.ts checks the markers,
the names and the line budget). test/rules.test.ts enforces most guarantees.
-->
