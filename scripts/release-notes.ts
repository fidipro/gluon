#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * `bun scripts/release-notes.ts <version> [CHANGELOG.md]`: prints the changelog section of a release,
 * the body of the draft release (release.yml). No `## [<version>]` section: the `[Unreleased]` one,
 * under a note saying so. Relative Markdown links become absolute ones at the version's tag (a release
 * body has no folder to resolve them against). Reads one file, writes stdout; nothing else.
 */
import { readFileSync } from "node:fs";
import { REPO_URL } from "../src/repo.ts";

/** The text under the `## [heading]` line, up to the next `## ` heading; null when there is no such section. */
function section(changelog: string, heading: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^## \\[${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "i").test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

/**
 * Inline links and images, `[t](docs/x.md#a "title")`, outside code fences: a relative target becomes
 * `<repo>/blob/v<version>/<path>`. `https:`/`mailto:`/any scheme, `//host`, `#anchor` and empty targets stay.
 */
export function absoluteLinks(markdown: string, version: string): string {
  const base = `${REPO_URL}/blob/v${version.replace(/^v/, "")}/`;
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/(\]\()(<?)([^)\s>]*)/g, (all, open: string, angle: string, target: string) => {
        if (!target || target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return all;
        return `${open}${angle}${new URL(target.replace(/^\/+/, ""), base).href}`;
      });
    })
    .join("\n");
}

export function releaseNotes(changelog: string, version: string): string {
  const own = section(changelog, version);
  if (own) return absoluteLinks(own, version);
  const unreleased = section(changelog, "Unreleased");
  const note = `No CHANGELOG.md section for ${version}; these are the unreleased changes.`;
  return absoluteLinks(unreleased ? `${note}\n\n${unreleased}` : note, version);
}

if (import.meta.main) {
  const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
  if (!version) {
    console.error("usage: release-notes.ts <version> [CHANGELOG.md]");
    process.exit(2);
  }
  console.log(releaseNotes(readFileSync(file, "utf8"), version));
}
