/**
 * A fake GitHub releases page on loopback, for the updater's tests (`test/update.test.ts`, `test/e2e/update.e2e.test.ts`,
 * `test/dist.test.ts`): never the network. Like github.com, `/releases/latest` redirects to the tag and a download redirects
 * to a file host (here `/cdn/…` on the same origin).
 *
 *   GET /releases/latest                      302 → /releases/tag/v<latest>
 *   GET /releases/download/v<ver>/<file>      302 → /cdn/v<ver>/<file>
 *   GET /cdn/v<ver>/<file>                    the file of that version, or 404
 *
 * `requests` lists every path asked for; `redirectTo` sends downloads elsewhere instead (a hop the updater must refuse); `gate`
 * holds every answer until it resolves.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeRelease {
  base: string;
  requests: string[];
  latest: string;
  files: Record<string, Record<string, Uint8Array | string>>;
  redirectTo?: string;
  /** While set, every request waits for it (a test holds the answer until its app is up). */
  gate?: Promise<void>;
  /** A seam file (`GLUON_TEST_UPDATE`) naming this server, with the given options. */
  seam(options?: Record<string, unknown>): string;
  stop(): void;
}

export const sha256 = (bytes: Uint8Array | string): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A release's SHA256SUMS for these files (`<hash>  <name>`). */
export const sumsOf = (files: Record<string, Uint8Array | string>): string =>
  Object.entries(files)
    .map(([n, b]) => `${sha256(b)}  ${n}`)
    .join("\n") + "\n";

export function fakeRelease(latest: string, files: Record<string, Record<string, Uint8Array | string>>): FakeRelease {
  const requests: string[] = [];
  const state: FakeRelease = {
    base: "",
    requests,
    latest,
    files,
    seam(options = {}) {
      const dir = mkdtempSync(join(tmpdir(), "gluon-update-seam-"));
      const path = join(dir, "seam.json");
      writeFileSync(path, JSON.stringify({ base: state.base, ...options }));
      return path;
    },
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      await state.gate;
      if (path === "/releases/latest") return new Response(null, { status: 302, headers: { location: `/releases/tag/v${state.latest}` } });
      const dl = /^\/releases\/download\/v([^/]+)\/(.+)$/.exec(path);
      if (dl) return new Response(null, { status: 302, headers: { location: state.redirectTo ? `${state.redirectTo}/cdn/v${dl[1]}/${dl[2]}` : `/cdn/v${dl[1]}/${dl[2]}` } });
      const cdn = /^\/cdn\/v([^/]+)\/(.+)$/.exec(path);
      const body = cdn ? state.files[cdn[1]!]?.[cdn[2]!] : undefined;
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
  state.base = `http://127.0.0.1:${server.port}/releases`;
  return state;
}
