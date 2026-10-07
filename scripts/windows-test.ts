#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun run test:windows`: the CI Windows job on this machine's own Windows, from WSL (interop).
 * Offline and free, like the regression it runs.
 *
 *   bun scripts/windows-test.ts [stage ...]     default: every CI stage, in this order
 *   bun scripts/windows-test.ts -t <pattern>    only `bun test -t <pattern>` (unit, then e2e)
 *   bun scripts/windows-test.ts -f <file> [-f ...] [-t <pattern>]
 *                                               only those test files (one `bun test` for the unit files, one for e2e files with --concurrent,
 *                                               one for test/perf/ files serially, with GLUON_PERF)
 *
 *   install     bun install --frozen-lockfile, then `git add -A` in the copy (tests that grep the checkout need a repository)
 *   typecheck   bun run typecheck
 *   unit        bun run test:unit
 *   e2e         bun run test:e2e, GLUON_E2E_CONCURRENCY apps at once (default: scripts/e2e-concurrency.ts, by cores and free RAM)
 *   dist        bun run test:dist (the compiled exe)
 *   ps1         test\install-ps1.ps1 under Windows PowerShell 5.1, with the https fixture
 *   perf        bun run test:perf (not in CI, so only when named): GLUON_PERF_QUICK, GLUON_PERF_UPDATE
 *               GLUON_PERF_SOAK_MIN and GLUON_PERF_MAX_SESSIONS are passed on; an update's test/perf/baseline.json is copied back
 *
 * Each stage's summary line ends with the peak working set of its process tree (sampled every 3 s).
 *
 * The tracked and unignored files (what `git ls-files -co --exclude-standard` lists, as
 * docker-test's context) are copied to %LOCALAPPDATA%\gluon-test\repo on NTFS: ConPTY and file
 * locking misbehave on a \\wsl$ path. Only changed files are copied, files gone from the list are
 * deleted, and node_modules stays between runs. Needs Windows Bun at the version in .bun-version
 * (%USERPROFILE%\.bun\bin\bun.exe); when it's missing this prints the install command and stops.
 * GLUON_TEST_SLOW is passed on.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultApps } from "./e2e-concurrency.ts";

const ROOT = resolve(import.meta.dir, "..");
const SYSTEM32 = "/mnt/c/WINDOWS/System32";
const POWERSHELL = `${SYSTEM32}/WindowsPowerShell/v1.0/powershell.exe`;
const POWERSHELL_WIN = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const CMD = `${SYSTEM32}/cmd.exe`;

/** CI's Windows job, in its order: what no argument runs. */
export const STAGES = ["install", "typecheck", "unit", "e2e", "dist", "ps1"] as const;
/** Stages CI doesn't have: run only when named. */
export const EXTRA_STAGES = ["perf"] as const;
export type Stage = (typeof STAGES)[number] | (typeof EXTRA_STAGES)[number];
const NAMED: readonly Stage[] = [...STAGES, ...EXTRA_STAGES];
/** Variables the perf stage reads, passed through to Windows. */
export const PERF_ENV = ["GLUON_PERF_QUICK", "GLUON_PERF_UPDATE", "GLUON_PERF_SOAK_MIN", "GLUON_PERF_MAX_SESSIONS"] as const;

/** Stages to run, or test files and/or a test-name filter (which runs install, then only the matching tests). */
export function parseArgs(argv: string[]): { stages: Stage[]; filter?: string; files: string[] } {
  let filter: string | undefined;
  const files: string[] = [];
  const stages: Stage[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-t" || a === "--filter") {
      filter = argv[++i];
      if (!filter) throw new Error(`${a} needs a test-name pattern`);
    } else if (a === "-f" || a === "--file") {
      const f = argv[++i];
      if (!f) throw new Error(`${a} needs a test file`);
      if (!/^test[\\/][\w./\\-]+$/.test(f)) throw new Error(`${a} takes a path under test/, got "${f}"`);
      files.push(f.replaceAll("\\", "/"));
    } else if ((NAMED as readonly string[]).includes(a)) stages.push(a as Stage);
    else throw new Error(`unknown stage "${a}" (one of ${NAMED.join(", ")}, or -t <pattern>, -f <file>)`);
  }
  const narrowed = filter !== undefined || files.length > 0;
  if (narrowed && stages.length) throw new Error("-t and -f run the matching tests alone: no stages with them");
  return { stages: narrowed ? ["install"] : stages.length ? NAMED.filter((s) => stages.includes(s)) : [...STAGES], filter, files };
}

/** A file's size and mtime: what decides whether it's copied again. */
export type Signature = string;
export type Manifest = Record<string, Signature>;

/** What to copy (new or changed since the last sync) and what to delete (no longer listed). */
export function syncPlan(previous: Manifest, current: Manifest): { copy: string[]; remove: string[] } {
  return {
    copy: Object.keys(current).filter((f) => previous[f] !== current[f]),
    remove: Object.keys(previous).filter((f) => !(f in current)),
  };
}

/** A PowerShell single-quoted string. */
export const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** The PowerShell line for a stage (the filter, when set, is read from $env:GLUON_WT_FILTER). */
export function stageCommand(stage: Stage, filter?: string, files: string[] = []): string[] {
  const e2e = `--max-concurrency=${defaultApps()}`;
  if (files.length) {
    // One `bun test` per kind: --concurrent is for e2e files only (unit files share state: BUG-664); perf files run alone, serially.
    const tail = filter !== undefined ? " -t $env:GLUON_WT_FILTER" : "";
    const list = (fs: string[]) => fs.map(psQuote).join(" ");
    const perf = files.filter((f) => f.startsWith("test/perf/"));
    const e2eFiles = files.filter((f) => f.startsWith("test/e2e/"));
    const unit = files.filter((f) => !perf.includes(f) && !e2eFiles.includes(f));
    return [
      ...(unit.length ? [`bun test ${list(unit)}${tail}`] : []),
      ...(e2eFiles.length ? [`bun test --concurrent ${e2e} ${list(e2eFiles)}${tail}`] : []),
      ...(perf.length ? ["$env:GLUON_PERF = '1'", `bun test --max-concurrency=1 ${list(perf)}${tail}`] : []),
    ];
  }
  if (filter !== undefined) return [`bun test --path-ignore-patterns='test/e2e/**' -t $env:GLUON_WT_FILTER`, `bun test --concurrent ${e2e} test/e2e -t $env:GLUON_WT_FILTER`];
  switch (stage) {
    // The synced copy has no .git: a repository of its own (index only, never a commit) for the tests that run `git grep` and `git ls-files` on the checkout.
    case "install": return ["bun install --frozen-lockfile", "if (-not (Test-Path -LiteralPath .git)) { git init -q }", "git add -A"];
    case "typecheck": return ["bun run typecheck"];
    case "unit": return ["bun run test:unit"];
    case "e2e": return [`bun run test:e2e ${e2e}`];
    case "dist": return ["bun run test:dist"];
    case "perf": return ["$env:GLUON_PERF = '1'", "bun test --max-concurrency=1 ./test/perf"];
    case "ps1": return [`& ${psQuote(POWERSHELL_WIN)} -NoProfile -ExecutionPolicy Bypass -File test\\install-ps1.ps1 -Exe dist\\gluon-bun-windows-x64.exe -Fixture test\\fixtures\\https-release.ts`];
  }
}

function capture(argv: string[]): string {
  const r = Bun.spawnSync(argv, { cwd: "/mnt/c", stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

const winEnv = (name: string) => capture([CMD, "/d", "/c", `echo %${name}%`]);
const toWsl = (win: string) => capture(["wslpath", "-u", win]);

function sync(dest: string): number {
  const ls = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, env: process.env, stdout: "pipe" });
  if (ls.exitCode !== 0) throw new Error("git ls-files failed");
  const current: Manifest = {};
  for (const f of ls.stdout.toString().split("\0").filter(Boolean)) {
    const st = statSync(join(ROOT, f), { throwIfNoEntry: false });
    if (st?.isFile()) current[f] = `${st.size}:${Math.floor(st.mtimeMs)}`;
  }
  const manifestFile = join(dest, "..", "manifest.json");
  const previous: Manifest = existsSync(manifestFile) && existsSync(dest) ? JSON.parse(readFileSync(manifestFile, "utf8")) : {};
  const { copy, remove } = syncPlan(previous, current);
  for (const f of remove) rmSync(join(dest, f), { force: true });
  for (const f of copy) {
    const to = join(dest, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(ROOT, f), to);
    const st = statSync(join(ROOT, f));
    utimesSync(to, st.atime, st.mtime);
  }
  writeFileSync(manifestFile, JSON.stringify(current));
  return copy.length + remove.length;
}

/** Peak working set of the stage's process tree, in bytes, from the sampler's file; undefined when it wrote none. */
export function parsePeak(text: string): number | undefined {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
export const formatPeak = (bytes: number | undefined) => (bytes === undefined ? "peak ?" : `peak ${Math.round(bytes / 1048576)} MB`);

/**
 * The PowerShell for one stage: PATH, the repo, a background job that writes the biggest working set
 * of this process's tree to `peakFile` (so the peak survives a failing stage), the stage's lines (the
 * first failure stops them), then the stage's exit code. The job's own process is left out.
 */
export function stageScript(lines: string[], winRepo: string, bunDir: string, peakFile: string): string {
  const sampler = [
    "try {",
    `  $sampler = Start-Job -ArgumentList $PID, ${psQuote(peakFile)} -ScriptBlock {`,
    "    param($root, $out)",
    "    $me = $PID; $max = 0",
    "    while ($true) {",
    "      $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize)",
    "      $seen = @{ $root = $true }; $sum = [int64]0; $grew = $true",
    "      while ($grew) { $grew = $false; foreach ($p in $all) { if (-not $seen.ContainsKey([int]$p.ProcessId) -and $seen.ContainsKey([int]$p.ParentProcessId) -and $p.ParentProcessId -ne $me -and $p.ProcessId -ne $me) { $seen[[int]$p.ProcessId] = $true; $grew = $true } } }",
    "      foreach ($p in $all) { if ($seen.ContainsKey([int]$p.ProcessId) -and $p.ProcessId -ne $me -and $p.ParentProcessId -ne $me) { $sum += [int64]$p.WorkingSetSize } }",
    "      if ($sum -gt $max) { $max = $sum; Set-Content -LiteralPath $out -Value $max }",
    "      Start-Sleep -Seconds 3",
    "    }",
    "  }",
    "} catch { }",
  ];
  return [
    `$env:PATH = ${psQuote(bunDir + ";")} + $env:PATH`,
    `Set-Location -LiteralPath ${psQuote(winRepo)}`,
    ...sampler,
    "$rc = 0",
    // A line that runs no program (`$env:X = '1'`) must not read as a failure: $LASTEXITCODE starts unset.
    "$global:LASTEXITCODE = 0",
    "do {",
    ...lines.map((l) => `  ${l}; if ($LASTEXITCODE -ne 0) { $rc = $LASTEXITCODE; break }`),
    "} while ($false)",
    "if ($sampler) { Start-Sleep -Milliseconds 300; Stop-Job $sampler -ErrorAction SilentlyContinue; Remove-Job $sampler -Force -ErrorAction SilentlyContinue }",
    "exit $rc",
  ].join("\n");
}

function run(stage: string, lines: string[], winRepo: string, bunDir: string, peakFile: string, filter?: string): boolean {
  console.log(`\n==== ${stage}`);
  const script = stageScript(lines, winRepo, bunDir, peakFile);
  // Interop hands Windows only the variables WSLENV names.
  const passed = [process.env.GLUON_TEST_SLOW && "GLUON_TEST_SLOW", filter !== undefined && "GLUON_WT_FILTER", ...PERF_ENV.filter((v) => process.env[v])];
  const env = { ...process.env, GLUON_WT_FILTER: filter ?? "", WSLENV: [process.env.WSLENV, ...passed].filter(Boolean).join(":") };
  const r = Bun.spawnSync([POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { cwd: "/mnt/c", env, stdout: "inherit", stderr: "inherit" });
  return r.exitCode === 0;
}

if (import.meta.main) {
  const { stages, filter, files } = parseArgs(process.argv.slice(2));
  if (!existsSync(POWERSHELL)) throw new Error(`no ${POWERSHELL}: run this from WSL on Windows, with interop on`);
  const want = readFileSync(join(ROOT, ".bun-version"), "utf8").trim();
  const bunDir = `${winEnv("USERPROFILE")}\\.bun\\bin`;
  const bunExe = toWsl(`${bunDir}\\bun.exe`);
  const have = existsSync(bunExe) ? Bun.spawnSync([bunExe, "--version"], { cwd: "/mnt/c", stdout: "pipe" }).stdout.toString().trim() : undefined;
  if (have !== want) {
    console.error(`test:windows needs Windows Bun ${want} in ${bunDir} (${have ? `found ${have}` : "not installed"}). In PowerShell:\n  & ([scriptblock]::Create((irm bun.sh/install.ps1))) -Version ${want}`);
    process.exit(1);
  }
  const winRepo = `${winEnv("LOCALAPPDATA")}\\gluon-test\\repo`;
  const winPeak = `${winEnv("LOCALAPPDATA")}\\gluon-test\\peak.txt`;
  const dest = toWsl(winRepo);
  const peakFile = toWsl(winPeak);
  mkdirSync(dest, { recursive: true });
  console.log(`synced ${sync(dest)} file(s) to ${winRepo}`);

  const summary: string[] = [];
  let failed = false;
  const step = (name: string, lines: string[]) => {
    const start = performance.now();
    rmSync(peakFile, { force: true });
    const ok = run(name, lines, winRepo, bunDir, winPeak, filter);
    failed ||= !ok;
    const peak = formatPeak(existsSync(peakFile) ? parsePeak(readFileSync(peakFile, "utf8")) : undefined);
    summary.push(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(44)} ${Math.round((performance.now() - start) / 1000).toString().padStart(4)}s  ${peak}`);
    return ok;
  };
  for (const s of stages) if (!step(s, stageCommand(s)) && s === "install") break;
  // A perf baseline written on Windows (GLUON_PERF_UPDATE) comes back to the checkout.
  if (stages.includes("perf") && process.env.GLUON_PERF_UPDATE === "1") copyFileSync(join(dest, "test/perf/baseline.json"), join(ROOT, "test/perf/baseline.json"));
  if (files.length && !failed) step(`${files.join(" ")}${filter !== undefined ? ` -t ${JSON.stringify(filter)}` : ""}`, stageCommand("unit", filter, files));
  else if (filter !== undefined && !failed) step(`tests matching ${JSON.stringify(filter)}`, stageCommand("unit", filter));
  console.log(`\n==== summary\n${summary.join("\n")}`);
  process.exit(failed ? 1 : 0);
}
