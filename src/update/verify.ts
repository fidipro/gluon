/**
 * What makes a downloaded release trusted: its `SHA256SUMS` carries a Sigstore signature (`SHA256SUMS.sigstore.json`, made by
 * `.github/workflows/release.yml`) whose certificate names that workflow on `main` of this repository, issued to GitHub Actions;
 * the binary's SHA-256 is then the one `SHA256SUMS` lists for it. The same identity `install.sh` gives cosign
 * (`test/update.test.ts` keeps them equal). The Sigstore trusted root comes from Sigstore's TUF repository, cached in Gluon's
 * state directory. Bun's crypto needs two lines of the Sigstore libraries changed (`patches/`, see their comments).
 */
import { bundleFromJSON } from "@sigstore/bundle";
import type { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { REPO_URL } from "../repo.ts";
import { UpdateError } from "./fetch.ts";

export const CERT_IDENTITY = `${REPO_URL}/.github/workflows/release.yml@refs/heads/main`;
export const CERT_ISSUER = "https://token.actions.githubusercontent.com";

/** Throws unless `bundle` is a valid Sigstore signature over `sums` by `identity` (the release workflow on main), checked against `root`. */
export function verifySignature(sums: Uint8Array, bundle: unknown, root: TrustedRoot, identity = CERT_IDENTITY): void {
  try {
    const verifier = new Verifier(toTrustMaterial(root));
    verifier.verify(toSignedEntity(bundleFromJSON(bundle), Buffer.from(sums)), { subjectAlternativeName: identity, extensions: { issuer: CERT_ISSUER } });
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new UpdateError(`the release's signature doesn't verify${code ? ` (${code})` : ""}: ${(e as Error).message}`);
  }
}

/** Sigstore's trusted root, through TUF (its keys are checked against the root shipped in `@sigstore/tuf`); `cacheDir` keeps it between runs. */
export async function sigstoreRoot(cacheDir: string): Promise<TrustedRoot> {
  try {
    return await getTrustedRoot({ cachePath: cacheDir, retry: 1, timeout: 20_000 });
  } catch (e) {
    throw new UpdateError(`couldn't get Sigstore's trusted root: ${(e as Error).message}`);
  }
}

/** The SHA-256 (lowercase hex) `SHA256SUMS` lists for `name` (`<hash>  <name>` or `<hash> *<name>`, CRLF or LF), or null. */
export function expectedHash(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return null;
}
