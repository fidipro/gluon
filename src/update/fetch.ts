/**
 * Reading Gluon's GitHub releases: which version is the latest, and a release's files. Plain GETs of the release pages, no API
 * (no token, no header of Gluon's own). Every redirect is followed by hand: each hop must be https and on `RELEASES.hosts`
 * (github.com sends a download on to its file host), or, for the test seam, on its loopback origin. Sizes are capped on the
 * bytes on the wire (no compression), a download has a deadline, and the binary goes straight to disk, hashed as it arrives.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { REPO_URL } from "../repo.ts";

export class UpdateError extends Error {}

/** Where releases are read: `<base>/latest` redirects to `<base>/tag/v<version>`, `<base>/download/v<version>/<file>` is a file. */
export interface ReleaseSource {
  base: string;
  /** The https hosts a request may be redirected to; empty for a loopback seam (its own origin only). */
  hosts: ReadonlySet<string>;
}

export const RELEASES: ReleaseSource = {
  base: `${REPO_URL}/releases`,
  hosts: new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]),
};

export const MAX_SUMS_BYTES = 256 * 1024;
export const MAX_BINARY_BYTES = 300 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 20_000;
export const BINARY_TIMEOUT_MS = 15 * 60_000;
const MAX_HOPS = 5;

/** Whether a request may go to `url`: https on the allowed hosts, or the seam's own loopback origin. */
export function allowedUrl(url: URL, src: ReleaseSource): boolean {
  const base = new URL(src.base);
  if (base.protocol === "http:") return url.origin === base.origin;
  return url.protocol === "https:" && src.hosts.has(url.hostname);
}

/** A version of ours: `1.2.3` (a pre-release is never offered). */
export const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Whether `a` is newer than `b` (both `x.y.z`); false when either isn't one. */
export function newer(a: string, b: string): boolean {
  const x = VERSION_RE.exec(a);
  const y = VERSION_RE.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

/** A deadline: its signal aborts after `ms` (a ref'd timer, cleared by `done`: on Windows a wait only an `AbortSignal.timeout` can end may never end). */
function deadline(ms: number): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

/** The final response of a GET, redirects followed by hand (each hop checked); a redirect is returned when `follow` is false. */
async function get(url: string, src: ReleaseSource, signal: AbortSignal, follow = true): Promise<Response> {
  let at = new URL(url);
  for (let hop = 0; ; hop++) {
    if (!allowedUrl(at, src)) throw new UpdateError(`refused to fetch ${at.origin}: not one of the release hosts`);
    let res: Response;
    try {
      // No compression (`accept-encoding: identity`, Bun told not to decode): the size cap counts the bytes on the wire.
      res = await fetch(at, { signal, redirect: "manual", headers: { "accept-encoding": "identity" }, decompress: false } as RequestInit);
    } catch (e) {
      throw new UpdateError(signal.aborted ? `${at.origin} took too long` : `can't reach ${at.origin} (${(e as Error).message})`);
    }
    if (res.status < 300 || res.status >= 400 || !follow) return res;
    const location = res.headers.get("location");
    if (!location || hop + 1 >= MAX_HOPS) throw new UpdateError(`${at.origin} redirected badly`);
    at = new URL(location, at);
  }
}

/** The latest release's version (`<base>/latest` redirects to its tag). */
export async function latestVersion(src: ReleaseSource, timeoutMs = PAGE_TIMEOUT_MS): Promise<string> {
  const { signal, done } = deadline(timeoutMs);
  let res: Response;
  try {
    res = await get(`${src.base}/latest`, src, signal, false);
  } finally {
    done();
  }
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) throw new UpdateError(`couldn't read the latest release (HTTP ${res.status})`);
  const tag = /\/releases\/tag\/v([^/?#]+)$/.exec(new URL(location, src.base).pathname)?.[1];
  if (!tag || !VERSION_RE.test(tag)) throw new UpdateError("couldn't read the latest release's version");
  return tag;
}

/** A release file's URL. */
export const fileUrl = (src: ReleaseSource, version: string, name: string): string => `${src.base}/download/v${version}/${name}`;

/** Reads a response's body chunk by chunk, stopping past `maxBytes`. */
async function eachChunk(res: Response, url: string, maxBytes: number, each: (chunk: Uint8Array) => void): Promise<void> {
  if (res.status !== 200 || !res.body) throw new UpdateError(`couldn't download ${url} (HTTP ${res.status})`);
  const encoding = (res.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "") throw new UpdateError(`${url} came compressed`);
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new UpdateError(`${url} is larger than ${maxBytes} bytes`);
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new UpdateError(`${url} is larger than ${maxBytes} bytes`);
    each(chunk);
  }
}

/** A small file of a release, whole. */
export async function fetchFile(src: ReleaseSource, version: string, name: string, maxBytes = MAX_SUMS_BYTES, timeoutMs = PAGE_TIMEOUT_MS): Promise<Buffer> {
  const url = fileUrl(src, version, name);
  const { signal, done } = deadline(timeoutMs);
  const chunks: Uint8Array[] = [];
  try {
    await eachChunk(await get(url, src, signal), url, maxBytes, (c) => chunks.push(c));
  } catch (e) {
    throw e instanceof UpdateError ? e : new UpdateError(signal.aborted ? `${url} took too long` : `couldn't download ${url} (${(e as Error).message})`);
  } finally {
    done();
  }
  return Buffer.concat(chunks);
}

/** A release file written to `path` (created new, owner-only until it is checked); returns its SHA-256 (hex). */
export async function downloadTo(src: ReleaseSource, version: string, name: string, path: string, maxBytes = MAX_BINARY_BYTES, timeoutMs = BINARY_TIMEOUT_MS): Promise<string> {
  const url = fileUrl(src, version, name);
  const { signal, done } = deadline(timeoutMs);
  const hash = new Bun.CryptoHasher("sha256");
  const fd = openSync(path, "wx", 0o700);
  try {
    await eachChunk(await get(url, src, signal), url, maxBytes, (c) => {
      hash.update(c);
      for (let off = 0; off < c.byteLength; ) off += writeSync(fd, c, off);
    });
  } catch (e) {
    throw e instanceof UpdateError ? e : new UpdateError(signal.aborted ? `${url} took too long` : `couldn't download ${url} (${(e as Error).message})`);
  } finally {
    done();
    closeSync(fd);
  }
  return hash.digest("hex");
}
