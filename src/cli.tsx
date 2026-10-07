#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// The flags above: Bun loads no `.env` and no `bunfig.toml` from the directory Gluon runs in, so
// a repository's own preload or plugins never run inside Gluon (keys, brain). Keep them in sync
// with package.json's scripts and `selfArgv` (self.ts).

// `signal` and `hook` run inside a launched agent (its hooks and plugins): dispatched
// before anything else loads, so a hook stays fast, and before startup.ts scrubs the channel's
// variables.
const sub = Bun.argv[2];
if (sub === "signal" || sub === "hook") {
  const { internal } = await import("./internal.ts");
  process.exit(await internal(sub, Bun.argv.slice(3)));
}
// `stats-sql` is the child of `gluon stats sql` (`src/stats-sql.ts`): started only with its database named in the environment,
// so typed by a person it is just the start of a session. Loads nothing but its own file.
if (sub === "stats-sql" && process.env.GLUON_STATS_SQL_DB) {
  const { statsSqlChild } = await import("./stats-sql.ts");
  process.exit(await statsSqlChild());
}
// First: before anything that may spawn (see startup.ts).
await import("./startup.ts");
await import("./main.tsx");
