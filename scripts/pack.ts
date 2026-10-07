#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun run pack`: the npm-style package, for a local install on Linux / macOS with Bun
 * (`bun add -g ./dist/gluon-<version>.tgz`). Never published: the generated package.json keeps
 * `"private": true`, which `bun pm pack` accepts and `npm publish` / `bun publish` refuse.
 *
 *   dist/npm/gluon.js                  the CLI bundled for Bun (`--target=bun`, no runtime deps),
 *                                      the `-S` shebang kept: no `.env`, no cwd `bunfig.toml`
 *   dist/npm/agent/grep-worker.js      the grep worker (a second entrypoint)
 *   dist/npm/LICENSE, NOTICE           copied from the repo root
 *   dist/npm/package.json              generated: name, version, bin, files, engines, os
 *   dist/gluon-<version>.tgz           `bun pm pack` of dist/npm
 *
 * The build reuses scripts/build.ts's Ink plugin; GLUON_BUILD is "npm": the test probe seam is
 * compiled out, and the grep worker is loaded by a URL next to the bundle (`tools.ts`), never by a
 * string, which Bun would resolve from the cwd (BUG-101's class). POSIX only: the bin's `-S` shebang doesn't run on Windows (the
 * standalone .exe is the Windows route).
 */
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { noInkDev } from "./build.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "dist", "npm");
const SHEBANG = "#!/usr/bin/env -S bun --no-env-file --config=/dev/null";
export async function pack(): Promise<string> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const r = await Bun.build({
    entrypoints: [join(ROOT, "src/cli.tsx"), join(ROOT, "src/agent/grep-worker.ts")],
    root: join(ROOT, "src"),
    outdir: OUT,
    naming: "[dir]/[name].[ext]",
    target: "bun",
    format: "esm",
    plugins: [noInkDev],
    minify: false,
    define: { GLUON_BUILD: JSON.stringify("npm"), "process.env.NODE_ENV": JSON.stringify("production") },
    throw: false,
  });
  if (!r.success) throw new AggregateError(r.logs, `pack build failed:\n${r.logs.join("\n")}`);
  const bin = join(OUT, "gluon.js");
  renameSync(join(OUT, "cli.js"), bin);
  chmodSync(bin, 0o755);

  const text = await Bun.file(bin).text();
  if (text.split("\n", 1)[0] !== SHEBANG) throw new Error(`${bin}: the first line isn't ${SHEBANG}`);
  if (text.includes("react-devtools-core")) throw new Error(`${bin} names react-devtools-core`);
  if (!text.includes("canBeRgiEmoji")) throw new Error(`${bin} lacks the string-width patch (BUG-615: bun install applies patches/)`);
  if (text.includes("GLUON_TEST_PROBES")) throw new Error(`${bin} keeps the test probe seam`);
  if (text.includes("GLUON_TEST_MAINTAINER_MODELS")) throw new Error(`${bin} keeps the maintainer models seam`);
  if (text.includes("GLUON_TEST_OPENROUTER")) throw new Error(`${bin} keeps the OpenRouter usage seam`);
  if (text.includes("GLUON_TEST_PRICING")) throw new Error(`${bin} keeps the price tables seam`);
  // The worker is found next to the bundle (tools.ts, GLUON_BUILD "npm"); a cwd-relative string would load the user's repo's copy.
  if (!text.includes('new URL("./agent/grep-worker.js", import.meta.url)')) throw new Error(`${bin} doesn't load the grep worker next to itself`);
  if (!(await Bun.file(join(OUT, "agent", "grep-worker.js")).exists())) throw new Error("the grep worker wasn't built");

  const manifest = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    private: true,
    license: pkg.license,
    type: "module",
    bin: { gluon: "gluon.js" },
    files: ["gluon.js", "agent/grep-worker.js", "NOTICE"],
    engines: pkg.engines,
    os: ["linux", "darwin"],
    keywords: pkg.keywords,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    repository: pkg.repository,
  };
  await Bun.write(join(OUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const f of ["LICENSE", "NOTICE"]) await Bun.write(join(OUT, f), Bun.file(join(ROOT, f)));

  const tgz = join(ROOT, "dist", `gluon-${pkg.version}.tgz`);
  rmSync(tgz, { force: true });
  const p = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", join(ROOT, "dist"), "--quiet"], { cwd: OUT, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  if (p.exitCode !== 0 || !(await Bun.file(tgz).exists())) throw new Error(`bun pm pack failed:\n${p.stdout}${p.stderr}`);
  return tgz;
}

if (import.meta.main) {
  const tgz = await pack();
  console.log(`${tgz.slice(ROOT.length + 1)}  ${((await Bun.file(tgz).size) / 1024 / 1024).toFixed(1)} MB`);
}
