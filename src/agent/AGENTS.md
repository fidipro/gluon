# src/agent/ — instructions for coding agents

The brain: conversation, LLM clients, read-only repo tools.

## Repo tools (`tools.ts`, `scan.ts`, `grep-worker.ts`, `git.ts`)

- **Read-only, sandboxed by `within()`**: an absolute `relative()` result (other drive, UNC) is
  outside. **Compare real paths from `realRoot`** (`.native` on Windows expands 8.3 names: BUG-579, 582).
- **Secret files by one rule, `isSecretPath`**: case-insensitive, name, `SECRET_PATH` (the git config) and any
  `.env*` dir; also the name without an NTFS stream and trailing dots (BUG-578). `read_file` and `grep` check path and real path (BUG-92, BUG-130); every search backend's output
  is filtered, paths NUL-terminated (BUG-93); rg always gets `--no-config --with-filename --null`.
- **Git on the repo only via `gitCmd` / `gitQuery`** (`gitSync`: startup only): `gitArgv` disables fsmonitor etc. (BUG-131);
  `gitEnv` stops lazy fetch, whose remote can be a command; queries time out (BUG-138). Repo =
  `isGitRepo`, which checks the work tree is the root or above (BUG-139). `diff`/`show` take
  `SAFE_DIFF`, `log`/`show` `NO_SIGNATURES`, worktree commands `noFilters`; never `diff HEAD` or
  plain `diff`: they rewrite the repo's index despite `--no-optional-locks` (BUG-139). Check
  secrets on whole lines, cut after (`CUT`): a cut header would hide a long secret path.
- **JS search runs in a Worker** with abort and a 10 s budget (BUG-90), skips files > 2 MB (BUG-91).
  No `rg` / git → JS fallback; no `git` → "not a repo".
- **The worker is named by source path string** (`new Worker("./agent/grep-worker.ts")`), not
  `new URL` (BUG-101), and stays a `scripts/build.ts` entrypoint; the npm bundle uses
  `new URL("./agent/grep-worker.js", import.meta.url)`.

- **`forge` stays view/list-only on github.com and gitlab.com**: fixed argv (`forgeArgv`), never `gh api`;
  another host would get `glab`'s token from a hostile `origin`; output through `maskSecrets` (`forge.ts`); the child gets `GH_HOST` / `GITLAB_HOST` of the origin's host, never the user's, and no GitLab token when the user's names another host (BUG-592).
  The CLI leads its own process group on POSIX and Esc / the timeout race the call and kill the group (a wrapper's child holds the pipes: BUG-654).

## The brain

- **The brain's own SDK clients pass their endpoint and null what isn't theirs**: `ANTHROPIC_API_BASE`, `OPENAI_API_BASE`, `bedrockRuntimeBase`
  (`harnesses.ts`), AWS `ignoreConfiguredEndpointUrls`, `authToken: null`; on OpenRouter no OpenAI org, project or custom headers
  (BUG-590, 591). The user's variables stay in the process: warn (`envWarnings`), don't strip. A new client does the same.
- **Probes change `verified`/`unreached`/`checked` only on definitive answers**; transient failures show ✗
  and keep the last results (BUG-77). **`modelUnavailable` classifies the raw error object and
  text** (BUG-76). A prompt that is too long is not "unavailable" (BUG-627): the next step would refuse it too.
- **The brain elucidates the session, it doesn't plan**: the launched agent runs a whole session
  (several tasks, exploration); a spec is its goal, files found, constraints, decisions — no
  acceptance criteria, steps or test plans. The prompt's wording is the intake proposal's: change it
  deliberately.
- **The brain only says whether a session gets a worktree** (`worktree` of `propose_launch`; no word
  about it in the spec; explore never gets one, `confirm` and `start`: BUG-410): Gluon picks the path and appends the block (`worktree.ts`, issue 52), runs
  only read-only `gitQuery` there, creates and deletes nothing; the agent removes it only on a yes.
- **A mode comes from `route` and belongs to the proposal, not to an option**: the developer's ctrl+t
  picks one for every option (`pickChoice`); don't put it in the options (`choices`).
- **Code, not the model, picks the agent**: `propose_launch` takes no agent fields; `Session` keeps the last
  `route` result and `parseProposal` offers only it, and clears it when a proposal is shown (a reply routes
  again). No route → tool error. One `ask_user` batch per proposal round, enforced in `session.ts` (`askedBatch`).
- **The repo's `AGENTS.md` / `CLAUDE.md` go into the prompt** as untrusted text, sandboxed like
  `read_file` and capped (`projectInstructions`); nested ones are appended to a repo tool's result by
  `Session`, not left to the model (`pathInstructions`; BUG-136); text goes into the prompt through `fenced`, and any name
  the repo controls (path, branch, file) through `fencedName` (a repo file must not close a tag or open a trusted block: BUG-459, 593, 594). Check the size before reading (BUG-595). The no-impersonation test checks
  Gluon's text. The spec doesn't repeat them: the harness loads them, or the launcher adds a "read it" line
  for one it doesn't (`unloadedInstructionFiles` in `src/intake.ts`, from `HARNESS_INFO[h].instructionFiles`).
- **Plan-brain `ask_user` / `propose_launch` block; only one may wait** — re-check after await
  (BUG-78). Sessions are ephemeral; a restart fires `restarted` (BUG-85).
- **`codex app-server` and `dynamicTools` are experimental**; doctor probes, the brain order falls
  through.
- **Codex tools come from features, the model catalog and the thread** (codex 0.161). The denylist
  fails closed (BUG-79): only `CODEX_FEATURES_KEPT` may be enabled, only `CATALOG_FIELDS` set, only `BRAIN_ITEMS` in a turn
  (BUG-709); a new one → decide and list it (`scripts/codex-drift.ts` finds it). `--disable` only names codex lists: it refuses
  others (`knownFeatures`; BUG-708). `code_mode_host` stays on. After a codex update: the harness-update runbook (private notes).

## Keeping this file fresh

Follow "Keeping AGENTS.md files fresh" in the root `AGENTS.md`. In short: update it in the change
that makes a line wrong; delete what stops being true or a test now enforces; add only what an
agent would get wrong; every name must exist; ≤ 70 lines, overflow to `docs/`.
