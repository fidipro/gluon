#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun run build` / `build:all`: standalone executables (`Bun.build` with `compile`) in `dist/`.
 *
 *   bun scripts/build.ts                 the host's target → dist/gluon-<target>[.exe]
 *   bun scripts/build.ts --all           every target in TARGETS
 *   bun scripts/build.ts --target=<t>    one target (repeatable)
 *   bun scripts/build.ts --test          the test flavor → dist/test/gluon-<target>: keeps the
 *                                        GLUON_TEST_PROBES seam (test:dist needs it); never shipped
 *   bun scripts/build.ts --check         `bun run test:dist`: both flavors for the host, then
 *                                        test/dist.test.ts against them
 *
 * A compiled binary would load `.env` and `bunfig.toml` from the directory it runs in (a repo's
 * preload running inside Gluon, its keys in process.env: BUG-56): every cwd autoload is off.
 * The grep worker is a second entrypoint (a compiled binary can only start a bundled worker).
 * `process.env.GLUON_BUILD` is defined as "release" (or "test"), which compiles the probe seam
 * out of release builds. Darwin binaries are signed ad hoc when built on a Mac; one cross-built
 * elsewhere must be signed on a Mac (`codesign --sign - <file>`) before it runs there.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");

export const TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-linux-x64-musl", "bun-linux-arm64-musl", "bun-darwin-x64", "bun-darwin-arm64", "bun-windows-x64"] as const;
type Target = (typeof TARGETS)[number];

/** The host's target (musl when Bun itself was built for musl). */
function hostTarget(): Target {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const musl = os === "linux" && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  const t = `bun-${os}-${process.arch}${musl ? "-musl" : ""}`;
  if (!(TARGETS as readonly string[]).includes(t)) throw new Error(`no build target for this host (${t})`);
  return t as Target;
}

/**
 * Ink's development mode (DEV=true: React devtools, reading its package.json) is compiled out, its
 * devtools module stubbed, and `react-devtools-core` resolves to an empty module at build time: never
 * external, which a compiled binary would resolve from the cwd's node_modules at run time.
 */
export const noInkDev: Bun.BunPlugin = {
  name: "no-ink-dev",
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core(\/|$)/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {};", loader: "js" }));
    b.onLoad({ filter: /[\\/]node_modules[\\/]ink[\\/]build[\\/].*\.js$/ }, async ({ path }) => {
      if (/[\\/]devtools\.js$/.test(path)) return { contents: "export {};", loader: "js" };
      const contents = (await Bun.file(path).text()).replaceAll("process.env['DEV'] === 'true'", "false");
      // Any other read of DEV (process.env.DEV, ?.DEV, destructured) is new: look at it before building.
      if (/\bDEV\b(?!\s+(may|is set))/.test(contents)) throw new Error(`${path}: Ink reads DEV in a new way; update scripts/build.ts`);
      return { contents, loader: "js" };
    });
  },
};

/** The patched string-width as the minifier leaves it: the pre-check regex right after the RGI emoji one (BUG-615). */
export const STRING_WIDTH_PATCHED = /\^\\p\{RGI_Emoji\}\$\/v,[\w$]+=\/\\p\{Emoji\}\/u/;

/** Builds one target; returns the executable's path. */
export async function build(target: Target, flavor: "release" | "test" = "release"): Promise<string> {
  const outfile = join(ROOT, "dist", flavor === "test" ? "test" : "", `gluon-${target}${target.startsWith("bun-windows") ? ".exe" : ""}`);
  rmSync(outfile, { force: true });
  const r = await Bun.build({
    entrypoints: [join(ROOT, "src/cli.tsx"), join(ROOT, "src/agent/grep-worker.ts")],
    compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false },
    plugins: [noInkDev],
    minify: true,
    sourcemap: "linked",
    // Bytecode only for the host's own target: a Windows exe cross-built with it on Linux segfaults at start (Bun 1.3.14).
    bytecode: target === hostTarget(),
    format: "esm",
    define: { GLUON_BUILD: JSON.stringify(flavor), "process.env.NODE_ENV": JSON.stringify("production") },
    throw: false,
  });
  if (!r.success) throw new AggregateError(r.logs, `build of ${target} failed:\n${r.logs.join("\n")}`);
  // The sourcemap is embedded in the executable (stack traces point at the source); the copies written next to it aren't needed.
  for (const o of r.outputs) if (o.path.endsWith(".map")) rmSync(o.path, { force: true });
  const bytes = Buffer.from(await Bun.file(outfile).arrayBuffer());
  if (bytes.includes("react-devtools-core")) throw new Error(`${outfile} names react-devtools-core: something could load it from the cwd at run time`);
  // patches/string-width@8.3.0.patch (BUG-615) must be in what ships: the bundler reads node_modules, which only a `bun install` patches.
  if (!STRING_WIDTH_PATCHED.test(bytes.toString("latin1"))) throw new Error(`${outfile} lacks the string-width patch (bun install applies patches/)`);
  if (target.startsWith("bun-darwin") && process.platform === "darwin") {
    const s = Bun.spawnSync(["codesign", "--force", "--sign", "-", outfile], { stdout: "inherit", stderr: "inherit" });
    if (s.exitCode !== 0) throw new Error(`codesign failed for ${outfile}`);
  }
  return outfile;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { all: { type: "boolean" }, target: { type: "string", multiple: true }, test: { type: "boolean" }, check: { type: "boolean" } } });
  for (const t of values.target ?? []) if (!(TARGETS as readonly string[]).includes(t)) throw new Error(`unknown target "${t}" (one of ${TARGETS.join(", ")})`);
  const targets: Target[] = values.all ? [...TARGETS] : values.target?.length ? (values.target as Target[]) : [hostTarget()];
  const report = async (t: Target, flavor: "release" | "test") => {
    const start = performance.now();
    const out = await build(t, flavor);
    const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
    console.log(`${out.slice(ROOT.length + 1)}  ${mb} MB  ${((performance.now() - start) / 1000).toFixed(1)} s${t.startsWith("bun-darwin") && process.platform !== "darwin" ? "  (unsigned: sign it on a Mac)" : ""}`);
    return out;
  };
  if (values.check) {
    const env = { ...process.env, GLUON_TEST_RELEASE_BINARY: await report(hostTarget(), "release"), GLUON_TEST_BINARY: await report(hostTarget(), "test") };
    const t = Bun.spawnSync([process.execPath, "test", "test/dist.test.ts"], { cwd: ROOT, env, stdout: "inherit", stderr: "inherit" });
    if (t.exitCode !== 0 || process.platform === "win32") process.exit(t.exitCode ?? 1);
    // The npm bundle too (POSIX: its bin is `env -S bun …`), through a wrapper that adds Bun's own
    // directory to the tests' PATH of fake agents; the hostile-cwd cases cover its grep worker.
    const { pack } = await import("./pack.ts");
    await pack();
    const dir = mkdtempSync(join(tmpdir(), "gluon-npm-check-"));
    const wrapper = join(dir, "gluon");
    writeFileSync(wrapper, `#!/bin/sh\nPATH="$PATH:${dirname(process.execPath)}" exec ${JSON.stringify(join(ROOT, "dist", "npm", "gluon.js"))} "$@"\n`, { mode: 0o755 });
    console.log("npm bundle: dist/npm/gluon.js");
    const n = Bun.spawnSync([process.execPath, "test", "test/dist.test.ts"], { cwd: ROOT, env: { ...process.env, GLUON_TEST_BINARY: wrapper }, stdout: "inherit", stderr: "inherit" });
    rmSync(dir, { recursive: true, force: true });
    process.exit(n.exitCode ?? 1);
  }
  for (const t of targets) await report(t, values.test ? "test" : "release");
}
