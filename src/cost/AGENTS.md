# src/cost/ — instructions for coding agents

Gluon's own cost and context figures (issue #39): pure per-harness functions, locally built price tables,
the audit ledger. How it fits: "Status, cost and context" in `docs/concepts/architecture.md`.

- **The figure shown is Gluon's own** (`tracker.ts`, `context.ts`); a harness's own cost, tokens, window
  or percentage only audits it: the ledger records both and the likeliest cause of a difference
  (`observeCost`, `observeContext`). The harness's total is shown only for a model the table has no
  price for, and then marked (`*`). Never show a harness's figure instead of ours.
- **On OpenRouter the key's clean billed delta is the session's figure** (user decision 2026-10-06; `src/openrouter-billed.ts`, `✓`): Gluon's
  tokens x price is the live estimate (`~`, calibrated by the lagged usage) and is audited against it (`billed()`: both, and `openrouter-provider-price`
  only for what is observed). Never a delta another OpenRouter session of Gluon overlapped, never a read that isn't settled (a session that spent settles only after the usage moved: $0 is "not landed yet", BUG-494, 496); the key goes in a header only.
  The key's usage (`GET /api/v1/key`) is the one run-time read that uses a key, a user-approved exception (issue #89), and never a test's (`billedSource`
  fails closed). Whether a model has several endpoint prices is the table's (`endpoints`, built at refresh: BUG-493), never a per-request ask.
  **The brain is no part of a session** (decided 2026-10-07): its OpenRouter replies' exact `usage.cost` go to `brainSpend` (`billed.ts`), the meter takes off what certainly landed, and an unknown cost
  or landing leaves no `✓` (`openrouter-brain-spend`); never register the brain as a session, never bill it to one (BUG-631). Other Gluons' brains come from their `<pid>.brain` files
  (`BrainLog`, `Registry.foreignBrain`): never delete a dead process's file at exit; an unreadable one is unknown; a retried SDK attempt makes a reply's cost unknown.
- **Functions are ports** (`claude.ts` of Claude Code's `vx`/`OQe`/`Ex`, `opencode.ts` of `Y0`), with
  the arithmetic in the harness's order: a test reproduces real captured costs to the last digit
  (`test/cost.test.ts`). Where a harness has no function (`codex.ts`), say what is assumed (`Assumption`).
- **Pure**: no file, network or environment access in the functions. The one exception is
  `harness-config.ts`: named keys of a harness's config (Claude's two TTL keys), never credentials, an
  injectable reader; add a key there with a test, nowhere else (`test/rules.test.ts` enforces the files).
- **No table ships in the repo** (issue #89): prices and windows are built on the user's machine (`refresh.ts`: background at start and launch, `gluon pricing update` in
  the foreground, no opt-out) into the local store (`tables-store.ts`), which `tables.ts` reads when valid; absent is `undefined`, never a harness's fallback. Unauthenticated GETs of
  models.dev and OpenRouter only (Claude's table is the installed `claude`'s alone: Anthropic's published catalog has no prices, BUG-523); a big move is accepted and logged (`tables` ledger entry). Tests seed `test/fixtures/tables/`; `pricingSource` fails closed
  (only `GLUON_TEST_PRICING`'s loopback server, BUG-500) and the `scripts/pricing/` generators fetch only with `--live` (BUG-520). Only the observed Grok windows are in the repo, by hand.
- **A session is pinned to the tables it was priced with; a table not here yet is pending, never `unknown-model`** (`CostTracker` `tablesChanged`): the request waits (capped), is priced
  when the table lands (a table already here is taken when the session first needs it, not only announced: BUG-704), and a session that ends first leaves `dropped` `no-price-table`. No figure, no OpenRouter calibration on a partial sum (`restate`; BUG-512 to 517).
  A Claude table from another version than the installed one, while its build runs (`tableBuilding`), is pending too, and the stored one stands in if the build fails (BUG-524);
  Grok requests use models.dev's seed when its table can't be built (`tableBuildFailed`, `grok-seed-price`; BUG-530). The demo and a release build's `NODE_ENV` never decide a refresh (`refreshAllowed`, BUG-526, 531).
- **One odd source row is skipped and named, never the table's problem** (`rowProblem`, in `select`/`trim`: BUG-604, 606); a models.dev answer lacking over half the stored models is refused (`MAX_GONE_SHARE`, BUG-605);
  OpenRouter silent builds without its `openrouter/*` rows, never models.dev's (BUG-607); a future `fetchedAt` is old (BUG-608).
- **An `openrouter/*` price is OpenRouter's own listing's**, never models.dev's (`modelsdev-catalog.ts` `applyOpenRouter`; it
  bills by it: BUG-469); a disagreement of more than 3x is reported (`validate.ts --report-large`), not a failure (BUG-470);
  models.dev's long-context tier stays only where the listing has `overrides` (BUG-474).
- **A window is Gluon's too**: models.dev's `limit.context` is not one (it lists 1M where Claude's usable
  window is 200k; OpenCode's equals it, Grok's never does: the binary's, else the observed table's). The 1M proof (`peak`) is per
  model, `override` is Codex's alone, a guessed window (`windowIsGuess`) is never the row's % (BUG-366, 369).
- **Observed Grok windows only with live evidence; removed once the binary lists the model**
  (`tables/grok-observed-windows.json`, hand-maintained; the generator's notice; BUG-396 to 398).
- **A cache TTL is never learned from a harness's cost**: it comes from the settings and environment
  (`cacheTtl`) or Claude Code's automatic rule, assumed; the oracle's disagreement is the recorded cause
  (`cache-ttl-1h`), not a re-price. Claude's plugin cost and window are audit only, even as the one source.
- **Antigravity has no cost** (`—`, issue #76): its status line's totals are the conversation's size, not
  billed input (BUG-387); never price them. Its context is `total_input_tokens` over our window (BUG-388).
- **OpenCode bills requests it sends no step for** (the title): the plugin sends the leftover of a session's
  cumulative usage as a `side` record, Gluon prices it at the provider's small model (`SMALL_MODEL_FAMILIES`), else the session's
  (`side-model-assumed`); only `context`-flagged steps move the context (BUG-345/346, 380).
- **An OpenCode step is priced at the model it reports** (the user may switch by hand): a named model the table lacks is `unknown-model`, never the launched price;
  only a step the plugin named no model for (`OPENCODE_NO_MODEL`) takes it, tagged `launched-model-price` (`opencodeStep`; BUG-671).
- **The ledger keeps counts and names only**: `sanitize` builds each entry from a whitelist (no prompt,
  id, host, path, free text); the file is private, capped and per process; a cap leaves a `dropped`
  marker, never silence; a directory that is a symlink or not ours is refused (`ledger-file.ts`).
- **`grok usage` covers every request (subagents too) and arrives before the last OTLP batch**: compare it at
  its `modelCalls` count, wait for the requests, drop on timeout (`tracker.ts` `settleGrok`; BUG-390/391/392).
- **A running total is compared at its last sample per launch** (`finalCumulative`): earlier samples differ
  by the requests in flight, never a divergence of their own (BUG-381).
- **Kimi's usage comes only from `kimi export`, into Gluon's private dir** (`src/kimi-usage.ts`; never `~/.kimi-code`): keep the `usage.record`
  fields only, delete the zip and its dir whatever happens; a record is one request, never a total (`KimiRecords`). Two launches in one directory never share a session (`pickSession` rivals, BUG-478). No cost of its own: no audit.
- **A harness's total or context reading arrives before the usage record it includes**: one ahead of ours waits (`settleCumulative`,
  `ownContextChanged`, `SETTLE_GRACE_MS`) and `ended()` judges what is left; never compare at arrival (BUG-472, 473).
- **A cause is named only for what is observed**: `harness-unknown-model-price` is Claude's own fallback row for an id its catalog lacks, named, never copied (BUG-471); `harness-list-price` is Claude's list price beside AWS's: Claude on Bedrock is priced from its `amazon-bedrock/` row, the catalog only audits (BUG-717).
- **A re-sent telemetry batch counts once** (`src/telemetry.ts` `once`): cost and usage both.

## Keeping this file fresh

Follow "Keeping AGENTS.md files fresh" in the root `AGENTS.md`. In short: update it in the change
that makes a line wrong; delete what stops being true or a test now enforces; add only what an
agent would get wrong; every name must exist; ≤ 70 lines, overflow to `docs/`.
