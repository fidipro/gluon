import { posix, win32 } from "node:path";

/**
 * An XDG base directory variable's value, or undefined when it is unset, empty or relative: the XDG spec says a
 * relative one is invalid and ignored, so Gluon's config, keys and state never land in the repository it runs in (BUG-620).
 */
export function xdgBase(value: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  return value && pathFor(platform).isAbsolute(value) ? value : undefined;
}

/** The path module of `platform`: a path built for another platform (a test's, `configPath`'s) uses that one's separator, whatever the host. */
export const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);
