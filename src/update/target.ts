/**
 * The release's executables: one per target, named `gluon-<target>[.exe]`. `scripts/build.ts` builds them, `install.sh` /
 * `install.ps1` pick one, and the updater (`src/update/update.ts`) downloads the one this Gluon is.
 */

export const TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-linux-x64-musl", "bun-linux-arm64-musl", "bun-darwin-x64", "bun-darwin-arm64", "bun-windows-x64"] as const;
export type Target = (typeof TARGETS)[number];

/** Whether this process's Bun was built for musl: it has no glibc runtime version (no `ldd` run: no POSIX tool at run time). */
export const hostMusl = (): boolean => !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;

/** The target of this platform and CPU (musl when Bun itself was built for musl), or null when no release has one. */
export function hostTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch, musl = platform === "linux" && hostMusl()): Target | null {
  const os = platform === "win32" ? "windows" : platform;
  const t = `bun-${os}-${arch}${os === "linux" && musl ? "-musl" : ""}`;
  return (TARGETS as readonly string[]).includes(t) ? (t as Target) : null;
}

/** The release file of a target. */
export const assetName = (t: Target): string => `gluon-${t}${t.startsWith("bun-windows") ? ".exe" : ""}`;
