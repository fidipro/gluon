/**
 * Antigravity's status line (issue #39, owner-approved, off unless `cost.antigravity_statusline`):
 * agy's status-line command is the only place it hands Gluon its token totals (and its own cost and
 * context, which only audit Gluon's), and it lives in agy's own `~/.gemini/antigravity-cli/settings.json`.
 * This is the one module that reads or writes that file, and it touches only the `statusLine` key, only
 * to put Gluon's inert script there (`test/rules.test.ts`). Checked on agy 1.2.16 against a mock gateway
 * (the spike of issue #39): agy takes a plain path as the command; reads the file at startup only;
 * accepts STRICT JSON only (a comment or trailing comma stops it with a "Settings Error" dialog);
 * rewrites the file itself (sorted keys, 2-space indent, mode 0600) and replaces a symlinked one with a
 * regular file; and ignores a `statusLine` in a project config. So Gluon: never writes a file that isn't
 * strict JSON, never through a symlink (the file, its script, or a parent directory that leads out of
 * HOME), never over a status line of the user's own; changes the TEXT by a splice of that one member
 * (every other byte stays: key order, indentation, unicode escapes, the final newline) and writes it
 * atomically after re-reading it (agy may have rewritten it meanwhile: content and mtime must be as
 * read); and removes only its own member, by the same splice, so an install then a removal gives the
 * original bytes back, and whatever the user changed in between stays.
 * The script prints nothing; `stack_with_default` keeps agy's default line (a blank one stacks under it).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { privateDir, renameOver } from "../secrets.ts";

export const AGY_SCRIPT = "agy-statusline.sh";

/** The script agy runs on a status-line update: nothing outside a Gluon launch, else the JSON on stdin goes to Gluon. */
export const AGY_SCRIPT_TEXT = `#!/bin/sh
# Gluon's Antigravity status line: inert outside a Gluon launch. \`gluon uninstall\` removes it.
[ -n "$GLUON_EVENTS" ] && [ -n "$GLUON_SELF" ] || exit 0
exec "$GLUON_SELF" hook antigravity statusline
`;

export interface AgyOptions {
  home?: string;
  /** Gluon's own directory (the config's), where the script lives. */
  configDir: string;
  platform?: NodeJS.Platform;
  /** Tests: runs once the new file is staged, before it is compared and swapped in (agy rewriting the settings meanwhile). */
  onStaged?: () => void;
}

const settingsPath = (home: string) => join(home, ".gemini", "antigravity-cli", "settings.json");
const scriptPath = (configDir: string) => join(configDir, AGY_SCRIPT);

const existsLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Where one top-level member of the settings object sits in its text. */
interface Member {
  key: string;
  /** Right after the `{` or the comma before it: the whitespace before the key starts here. */
  leadStart: number;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
  /** The comma after it, or -1 for the last member. */
  comma: number;
}
interface Layout {
  open: number;
  close: number;
  members: Member[];
}

/** The top-level members of a text `JSON.parse` already took as an object (null if the scan disagrees). */
function layoutOf(text: string): Layout | null {
  const ws = (i: number) => {
    while (i < text.length && " \t\r\n".includes(text[i]!)) i++;
    return i;
  };
  const str = (i: number) => {
    for (i++; i < text.length; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === '"') return i + 1;
    }
    return -1;
  };
  const value = (i: number) => {
    const c = text[i];
    if (c === '"') return str(i);
    if (c === "{" || c === "[") {
      for (let depth = 0; i < text.length; i++) {
        if (text[i] === '"') {
          i = str(i) - 1;
          if (i < 0) return -1;
        } else if (text[i] === "{" || text[i] === "[") depth++;
        else if ((text[i] === "}" || text[i] === "]") && --depth === 0) return i + 1;
      }
      return -1;
    }
    while (i < text.length && !",}] \t\r\n".includes(text[i]!)) i++;
    return i;
  };
  const open = ws(0);
  if (text[open] !== "{") return null;
  const members: Member[] = [];
  let leadStart = open + 1;
  for (;;) {
    const keyStart = ws(leadStart);
    if (text[keyStart] === "}") return { open, close: keyStart, members };
    if (text[keyStart] !== '"') return null;
    const keyEnd = str(keyStart);
    if (keyEnd < 0) return null;
    const colon = ws(keyEnd);
    if (text[colon] !== ":") return null;
    const valueStart = ws(colon + 1);
    const valueEnd = value(valueStart);
    if (valueEnd < 0) return null;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd));
    } catch {
      return null;
    }
    const after = ws(valueEnd);
    const comma = text[after] === "," ? after : -1;
    members.push({ key: key as string, leadStart, keyStart, keyEnd, valueStart, valueEnd, comma });
    if (comma < 0) return text[after] === "}" ? { open, close: after, members } : null;
    leadStart = comma + 1;
  }
}

/** The `statusLine` value as text, laid out like the file around it (one line, or indented by the same unit). */
function valueText(value: unknown, lead: string): string {
  if (!lead.includes("\n")) return JSON.stringify(value);
  const indent = lead.slice(lead.lastIndexOf("\n") + 1);
  return JSON.stringify(value, null, indent.includes("\t") ? "\t" : indent || "  ").replaceAll("\n", `\n${indent}`);
}

const sameExcept = (a: Record<string, unknown>, b: Record<string, unknown>, key: string): boolean => {
  const ka = Object.keys(a).filter((k) => k !== key);
  return ka.length === Object.keys(b).filter((k) => k !== key).length && ka.every((k) => k in b && JSON.stringify(a[k]) === JSON.stringify(b[k]));
};

/**
 * `text` with its `statusLine` member set to `value` (or removed when `value` is undefined) and nothing else
 * touched; null when that can't be done safely (a twice-named key, an odd layout, or a result that isn't the
 * same object but for that one key).
 */
export function spliceStatusLine(text: string, value: unknown): string | null {
  const layout = layoutOf(text);
  if (!layout) return null;
  const { open, close, members } = layout;
  const at = members.filter((m) => m.key === "statusLine");
  if (at.length > 1) return null;
  const m = at[0];
  const ref = m ?? members.at(-1);
  const lead = ref ? text.slice(ref.leadStart, ref.keyStart) : text.slice(open + 1, close).includes("\n") ? "\n  " : "";
  const colon = ref ? text.slice(ref.keyEnd, ref.valueStart) : ": ";
  let out: string;
  if (value === undefined) {
    if (!m) return text;
    const i = members.indexOf(m);
    // The last one takes the comma before it along; any other takes the one after it.
    out = m.comma >= 0 ? text.slice(0, m.leadStart) + text.slice(m.comma + 1) : i > 0 ? text.slice(0, members[i - 1]!.valueEnd) + text.slice(m.valueEnd) : text.slice(0, m.leadStart) + text.slice(m.valueEnd);
  } else if (m) out = text.slice(0, m.valueStart) + valueText(value, lead) + text.slice(m.valueEnd);
  else if (members.length === 0) out = `${text.slice(0, open + 1)}${lead}"statusLine"${colon}${valueText(value, lead)}${text.slice(open + 1)}`;
  else {
    const last = members.at(-1)!;
    out = `${text.slice(0, last.valueEnd)},${lead}"statusLine"${colon}${valueText(value, lead)}${text.slice(last.valueEnd)}`;
  }
  try {
    const before = JSON.parse(text) as Record<string, unknown>;
    const after = JSON.parse(out) as unknown;
    if (!isRecord(after) || !sameExcept(before, after, "statusLine")) return null;
    if (JSON.stringify(after.statusLine) !== JSON.stringify(value)) return null;
  } catch {
    return null;
  }
  return out;
}

type Read = { ok: true; text: string; json: Record<string, unknown>; mode: number; mtimeMs: number } | { ok: false; why: string };

/** `dir` with every symbolic link in it resolved, when that leads out of HOME (a parent of the settings file that is a link elsewhere); else null. */
function leavesHome(dir: string, home: string): string | null {
  try {
    const real = realpathSync(dir);
    const base = realpathSync(home);
    const rel = relative(base, real);
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? real : null;
  } catch {
    return null;
  }
}

/** The settings file, or why Gluon leaves it alone. */
function readSettings(path: string, home: string): Read {
  const out = leavesHome(dirname(path), home);
  if (out) return { ok: false, why: `has a parent directory that is a symbolic link leading outside your home (${out}), which Gluon doesn't write through` };
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { ok: false, why: "it isn't there: start Antigravity once, then Gluon can add its status line" };
  }
  if (st.isSymbolicLink()) return { ok: false, why: "it is a symbolic link (Antigravity would replace it with a regular file)" };
  if (!st.isFile()) return { ok: false, why: "it isn't a regular file" };
  const text = readFileSync(path, "utf8");
  try {
    const json: unknown = JSON.parse(text);
    if (!isRecord(json)) return { ok: false, why: "it isn't a JSON object" };
    return { ok: true, text, json, mode: st.mode & 0o777, mtimeMs: st.mtimeMs };
  } catch {
    return { ok: false, why: "it isn't strict JSON (Antigravity refuses to start on a file it can't parse)" };
  }
}

/** Writes `text` over `path` atomically, only if the file still holds `expected`, with the mtime it had when read (agy rewrites it too). */
function replaceIfUnchanged(path: string, expected: string, mtimeMs: number, text: string, mode: number, onStaged?: () => void): boolean {
  const { dir } = privateDir(dirname(path), ".gluon-", false);
  try {
    const tmp = join(dir, "settings.json");
    writeFileSync(tmp, text, { mode, flag: "wx" });
    chmodSync(tmp, mode);
    onStaged?.();
    if (readFileSync(path, "utf8") !== expected || statSync(path).mtimeMs !== mtimeMs) return false;
    renameOver(tmp, path);
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Puts Gluon's status line in; returns a note when it can't or won't (the launch goes on), null when it is there. */
export function ensureAgyStatusLine(o: AgyOptions): string | null {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? homedir();
  if (platform === "win32") return "Antigravity's cost and context aren't shown on Windows (its status line command is a shell script)";
  const script = scriptPath(o.configDir);
  if (/[\s"'\\$`]/.test(script)) return `Antigravity's status line needs a Gluon directory without spaces or quotes in its path (${script})`;
  const file = settingsPath(home);
  try {
    const read = readSettings(file, home);
    if (!read.ok) return `Antigravity's cost and context aren't shown: ${file} ${read.why}`;
    const own = read.json.statusLine;
    const ours = isRecord(own) && own.command === script;
    if (own !== undefined && !ours) return "Antigravity's cost and context aren't shown: you have a status line of your own, which Gluon leaves as it is";
    // The settings first: a layout the splice can't take leaves no script behind (BUG-405).
    const ready = ours && isRecord(own) && own.type === "command" && own.stack_with_default === true;
    const text = ready ? read.text : spliceStatusLine(read.text, { command: script, stack_with_default: true, type: "command" });
    if (text === null) return `Antigravity's cost and context aren't shown: ${file} has a layout Gluon can't add its status line to without rewriting your settings`;
    // Our script, executable, as it should be (never through a symbolic link at its path).
    mkdirSync(o.configDir, { recursive: true });
    if (existsLink(script)) return `Antigravity's cost and context aren't shown: ${script} is a symbolic link, which Gluon doesn't write through`;
    const current = existsSync(script) ? readFileSync(script, "utf8") : null;
    if (current !== AGY_SCRIPT_TEXT) {
      writeFileSync(script, AGY_SCRIPT_TEXT, { mode: 0o700 });
      chmodSync(script, 0o700);
    }
    if (ready) return null;
    // A script this call created and no settings point to is an orphan: removed when the settings are not written.
    const orphan = () => {
      if (current === null) rmSync(script, { force: true });
    };
    try {
      if (!replaceIfUnchanged(file, read.text, read.mtimeMs, text, read.mode, o.onStaged)) {
        orphan();
        return "Antigravity changed its settings while Gluon was adding its status line: it will try again at the next launch";
      }
    } catch (e) {
      orphan();
      throw e;
    }
    return null;
  } catch (e) {
    return `couldn't add Antigravity's status line (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
  }
}

/** The settings file when it holds Gluon's status line (for `gluon uninstall` to list), else null. */
export function agyStatusLineInstalled(o: AgyOptions): string | null {
  const home = o.home ?? homedir();
  const file = settingsPath(home);
  const read = readSettings(file, home);
  return read.ok && isRecord(read.json.statusLine) && read.json.statusLine.command === scriptPath(o.configDir) ? file : null;
}

/**
 * Removes Gluon's status line (only if the command is exactly ours) and its script; returns what it removed. The script goes only once the
 * key is known to be gone: a key that stays (a layout the splice can't take, agy rewriting the file meanwhile) would point at a script that is
 * not there, so it stays too, and `agyStatusLineInstalled` still names the file (BUG-404).
 */
export function removeAgyStatusLine(o: AgyOptions): string[] {
  const removed: string[] = [];
  const home = o.home ?? homedir();
  const file = settingsPath(home);
  const script = scriptPath(o.configDir);
  let keyGone = true;
  try {
    const read = readSettings(file, home);
    if (read.ok) {
      if (isRecord(read.json.statusLine) && read.json.statusLine.command === script) {
        // Only the member goes, by the same splice that put it there: the rest of the text, and whatever the user changed since, stays.
        const text = spliceStatusLine(read.text, undefined);
        keyGone = text !== null && replaceIfUnchanged(file, read.text, read.mtimeMs, text, read.mode, o.onStaged);
        if (keyGone) removed.push(`${file} (Gluon's statusLine)`);
      }
    }
  } catch {
    keyGone = false;
  }
  try {
    if (keyGone && existsSync(script) && statSync(script).isFile()) {
      rmSync(script, { force: true });
      removed.push(script);
    }
  } catch {}
  return removed;
}
