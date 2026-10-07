/**
 * `bun run docs:dev` / `docs:build`: runs the docs site's Astro (`site/`) with an absolute `--root`.
 * A relative `--root site` breaks Astro 7's dev server: its detached child resolves it again from
 * inside `site/` and creates `site/site/` (BUG-540). Usage: `scripts/docs/astro.ts dev|build [astro args]`.
 */
import { join, resolve } from "node:path";

export const SITE = resolve(import.meta.dir, "../../site");

/** The argv that starts Astro for `site/`: absolute paths only, so the cwd decides nothing. */
export const astroArgv = (cmd: string, rest: string[] = []): string[] => [
  process.execPath,
  "--no-env-file",
  `--config=${resolve(import.meta.dir, "../empty-bunfig.toml")}`,
  "--bun",
  join(SITE, "node_modules/astro/bin/astro.mjs"),
  cmd,
  "--root",
  SITE,
  ...rest,
];

if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2);
  if (cmd !== "dev" && cmd !== "build") {
    console.error("usage: scripts/docs/astro.ts dev|build [astro args]");
    process.exit(2);
  }
  const child = Bun.spawn(astroArgv(cmd, rest), { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  process.exit(await child.exited);
}
