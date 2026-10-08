---
title: "Maintenance"
description: "How Gluon is kept current: what to check when a harness or provider changes, how the price tables are built, regenerating the reference pages, and keeping the tests fresh."
---

What to do when something Gluon builds on changes, and which files to update. Setting up and running the tests is in
[Contributing](contributing.md).

## When a harness or provider changes

Harnesses (Claude Code, Codex, Antigravity, Grok Build, OpenCode, Kimi Code) change their flags, screens and hooks between releases.
After an update, with the new version installed:

1. Run `gluon doctor` to catch drift in login and status checks.
2. Compare the harness's `--help` with its entry in `src/harnesses.ts` (argv, `modes`, `instructionFiles`, `resume`) and the checks
   in `src/status.ts`. Explore mode must stay strictly read-only: writes fail and nothing asks to escalate.
3. Start a session from Gluon, quit, and `gluon resume <id>`: the conversation must come back.
4. Run `bun run test:area adapters,pty,cost-pricing`. A failing screen test usually means the harness's screen changed: update the
   reader in `src/pty/readers/` and the captured screen in `test/fixtures/screens/`.
5. Update the guide in `docs/guides/harnesses/` if a flag, connection or limit changed.

The same applies when a provider changes a model, route or limit: update what Gluon offers (`DEFAULT_MODELS`, the catalog sources
below) and the tests that expect it.

## Price and window tables

No price or window table ships in the repository. Gluon builds its own on the user's machine (`src/cost/refresh.ts`), in the
background at start and at a harness launch, and keeps them in `<state>/gluon/tables/`. `gluon pricing update` is the same refresh in
the foreground, `gluon cost-report` lists each table's source and age, and `gluon uninstall` removes the directory. A big price move is
accepted and logged; a table of the wrong shape is refused (`src/cost/table-schema.ts`: add a key a builder now writes there first).

| Table | Built from | Builder |
|---|---|---|
| `modelsdev.json` | the public models.dev catalog, with OpenRouter's own listing for `openrouter/*` models | `src/cost/modelsdev-catalog.ts` |
| `claude-catalog.json` | the installed Claude Code binary (read as bytes, never run) | `src/cost/claude-catalog.ts` |
| `codex-windows.json` | the installed `codex debug models` (no model is called) | `src/cost/codex-catalog.ts` |
| `grok-models.json` | the model list embedded in the installed Grok Build binary | `src/cost/grok-catalog.ts` |

`scripts/pricing/` holds thin command lines over the same builders (each header shows its options). A generator that reads a harness
takes `--binary <path>` and never looks one up on `PATH`. `test/cost.test.ts` fails when a model Gluon offers has no price or window in
the frozen copies under `test/fixtures/tables/`: add the model to the catalog source or `DEFAULT_MODELS` deliberately, and refresh the
fixtures from a real run when a test needs newer data.

To check that the builders still read the latest harness releases, run the generators by hand against them (`--binary <path>`, and
`--live` for models.dev and OpenRouter), validate what they wrote with `bun scripts/pricing/validate.ts --shape-only <table>…`, and run
`scripts/pricing/oracle-claude.ts` for Claude Code's cost. When a vendor's format changed, fix the builder for it, with a test.

## Reference pages

After a CLI, config, routing or model change, run `bun run docs:gen` and commit `docs/reference/`: those pages are generated from the
code and `test/docs-gen.test.ts` fails while they are stale. A new flag, key or route needs a short description in `scripts/docs/gen.ts`.
Never edit a reference page by hand.

## Adding or changing a guide

- A guide is a Markdown page in `docs/getting-started/`, `docs/guides/` or `docs/concepts/` with `title` and `description`
  frontmatter. A page in a folder the sidebar names (`site/astro.config.mjs`) appears by existing; restart `bun run docs:dev` to
  see a new one.
- Link to `docs/reference/` instead of copying model ids or flags; a real example goes in a fence preceded by `<!-- example -->`.
- End a getting-started page or guide with a `## Next steps` list, then a "Keeping this file fresh" HTML comment naming the source
  files it describes.

## Keeping the tests fresh

`bun run test:health` is a cheap, offline check-up (it runs no test): it prints what has gone stale, with the action for each, and
exits 1 only for something definitely broken. Run it before a release.

| When | Do |
|---|---|
| a new `src/` or test file | add it to an area in `test/areas.ts` (`test/areas.test.ts` fails until you do) |
| a harness update | re-capture `test/fixtures/screens/` and check the readers (above) |
| a UI or frame change | review the visual goldens (`bun run test:visual-must`; for an intended change `bun run test:visual -u`) |
| a change in `src/pty/`, `src/gluon.ts`, `src/ui/` or `src/sessions.ts` | `GLUON_PERF_QUICK=1 bun run test:perf` |
| a price source or table builder changes | refresh `test/fixtures/tables/` |
| a test slower than the fast tier's threshold | put `@full` in its title |
| a Bun upgrade | `bun run test:windows` and `bun run test:dist` |
| a change in `.github/workflows/` | one targeted run of that workflow, not a full one |

## After an installer changes

Re-check `installDirs` in `src/harnesses.ts`: a binary landing off `PATH` is named, not used. Never run a real installer outside a
throwaway container.

## Next steps

- [Architecture](../concepts/architecture.md): how the pieces fit, before you change one.
- [Contributing](contributing.md): set up a checkout, run the tests and keep the rules.
- [Platforms](../concepts/platforms.md): what is tested where.

<!-- Keeping this file fresh: update in the change that alters a procedure above: a harness's entry in src/harnesses.ts or src/status.ts, a price table's builder or source (src/cost/, scripts/pricing/), the docs generator (scripts/docs/gen.ts), or a check in scripts/test-health.ts. After following a procedure, fix any step that was wrong. Keep it to what an outside contributor can act on and under its line budget: maintainer-only steps are not kept in this repository (test/contributor-docs.test.ts checks it). -->
