import { chmodSync, existsSync, mkdirSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { configPath } from "./config.ts";
import { longPath, windowsTool } from "./detect.ts";
import { PROVIDERS } from "./harnesses.ts";

export { windowsTool };

/**
 * API keys Gluon keeps for the user: its own `.env` files, read into these maps and never into
 * process.env, so an agent launched on its own login doesn't silently bill a key Gluon loaded.
 * A key is handed only to the SDK that needs it or to an agent set to use it.
 *
 * Precedence: a key saved by `gluon setup` / `connect` (the `.env` next to the config) wins over
 * the environment. A key the user pasted into Gluon is what they asked Gluon to use.
 */
const saved = new Map<string, string>();
/** Keys handed in by `useSecrets` (the live checks' dev key file): name → the file they came from. */
const given = new Map<string, string>();

/** Next to the config file: ~/.config/gluon/.env by default. */
export function secretsPath(): string {
  return join(dirname(configPath()), ".env");
}

/** The assignments in a `.env` file (none when it doesn't exist). */
export function parseEnv(path: string): [string, string][] {
  if (!existsSync(path)) return [];
  const out: [string, string][] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    // `trimEnd`, not a lazy `(.*?)\s*$`: the spaces after a value are not part of it (BUG-587), and the regex form is quadratic on a long run of them.
    const m = line.trimEnd().match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out.push([m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, "$2")]);
  }
  return out;
}

/** Reads the `.env` next to the config file. */
export function loadSecrets(): void {
  saved.clear();
  given.clear();
  for (const [k, v] of parseEnv(secretsPath())) if (v) saved.set(k, v);
}

/** Keys read from `from` by the caller (a development key file), used like saved ones; never written. */
export function useSecrets(entries: [string, string][], from: string): void {
  for (const [k, v] of entries)
    if (v) {
      saved.set(k, v);
      given.set(k, from);
    }
}

/** A key: saved by Gluon, else from the environment. */
export function secret(name: string): string | undefined {
  return saved.get(name) || process.env[name] || undefined;
}

/** Where a key comes from, for messages (never the key itself). */
export function secretSource(name: string): string | null {
  if (saved.has(name)) return given.get(name) ?? secretsPath();
  if (process.env[name]) return "your environment";
  return null;
}

/** A variable whose value is a secret: one of `names`, or one named like a secret (…_KEY, _TOKEN, _SECRET, _PASSWORD). */
const isSecretName = (name: string, names: string[]) => names.includes(name) || /_(KEY|TOKEN|SECRET|PASSWORD)$/i.test(name);

/**
 * Every secret value Gluon knows, for masking: the secret variables (by name) in its `.env`
 * files and the environment's for `names`. Other settings in those files (AWS_REGION=us-east-1)
 * are not secrets and stay readable.
 */
export function knownSecretValues(names: string[]): string[] {
  const out = new Set<string>();
  for (const [k, v] of saved) if (isSecretName(k, names)) out.add(v);
  for (const n of names) if (process.env[n]) out.add(process.env[n]!);
  return [...out].filter((v) => v.length >= 8);
}

/** Who can read a saved key, as the setup says it (honest per OS). */
export function storageNote(platform: NodeJS.Platform = process.platform, path = secretsPath(), home = homedir()): string {
  if (platform !== "win32") return "readable only by you (mode 600)";
  return outsideProfile(path, home) ? "limited to your account and administrators (icacls)" : "in your Windows profile, readable by your account and administrators";
}

/** The SID in `whoami /user /fo csv /nh` output (`"host\user","S-1-5-21-…"`), or null. */
export function parseSid(csv: string): string | null {
  return csv.match(/"(S-1-\d+(?:-\d+)+)"\s*$/m)?.[1] ?? null;
}

/**
 * Whether a Windows path is outside the user's profile directory: both in their long form (a TEMP
 * of `C:\Users\RUNNER~1\…` is inside `C:\Users\runneradmin`, BUG-132), compared without case.
 */
export function outsideProfile(path: string, home: string, long: (path: string) => string = longPath): boolean {
  const rel = win32.relative(long(home).toLowerCase(), long(path).toLowerCase());
  return rel === ".." || rel.startsWith(`..${win32.sep}`) || win32.isAbsolute(rel);
}

/**
 * Limits a file, or a directory and everything created in it (`dir`), to the current user (by SID,
 * never %USERNAME%) with icacls. A problem is returned as a warning.
 */
export function restrictToUser(path: string, dir = false): string | undefined {
  const warning = `could not limit ${path} to your account (icacls); check who can read it`;
  try {
    const who = Bun.spawnSync([windowsTool("whoami"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "ignore", env: process.env });
    const sid = parseSid(who.stdout.toString());
    if (!sid) return warning;
    const r = Bun.spawnSync([windowsTool("icacls"), path, "/inheritance:r", "/grant:r", `*${sid}:${dir ? "(OI)(CI)" : ""}F`], { stdout: "ignore", stderr: "ignore", env: process.env });
    return r.exitCode === 0 ? undefined : warning;
  } catch {
    return warning;
  }
}

/** Renames over `to`; on Windows a file an editor or antivirus has open refuses for a moment, so EPERM/EBUSY/EACCES are retried. */
export function renameOver(from: string, to: string, rename: (from: string, to: string) => void = renameSync, tries = 5): void {
  for (let i = 0; ; i++) {
    try {
      return rename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i + 1 >= tries || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw e;
      Bun.sleepSync(25 * 2 ** i);
    }
  }
}

/**
 * A new directory with a random name in `parent`, private before anything is put in it: 0700, and
 * on Windows (`restrict`) limited to the user with icacls, so files created inside inherit that and
 * never exist with a looser ACL, even for a moment. Returns it and icacls' warning, if any.
 */
export function privateDir(parent: string, prefix: string, restrict = process.platform === "win32"): { dir: string; warning?: string } {
  const dir = mkdtempSync(join(parent, prefix));
  chmodSync(dir, 0o700);
  const warning = restrict ? restrictToUser(dir, true) : undefined;
  return { dir, ...(warning ? { warning } : {}) };
}

/**
 * Writes `text` to `path` readable only by the user, in one replace: inside a private directory
 * (`privateDir`) next to it, then renamed over the old file, the directory removed whatever
 * happens. Returns icacls' warning, if any.
 */
export function writePrivate(path: string, text: string, rename: (from: string, to: string) => void = renameOver): string | undefined {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); // a directory we create is never group- or world-writable, whatever the umask (BUG-585)
  const { dir, warning } = privateDir(dirname(path), ".gluon-", process.platform === "win32" && outsideProfile(path, homedir()));
  try {
    const tmp = join(dir, basename(path));
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    rename(tmp, path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return warning;
}

/**
 * Creates `path` with `text` only if nothing is there: false when it exists. Private like `writePrivate`
 * (the file is written inside a private directory first and appears whole, by a hard link, which fails
 * with EEXIST when the name is taken); on a filesystem without hard links it is created in place
 * with `wx` instead. For claims that two processes race for (`claimWorkspace`).
 */
export function writePrivateExclusive(path: string, text: string): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { dir } = privateDir(dirname(path), ".gluon-", process.platform === "win32" && outsideProfile(path, homedir()));
  try {
    const tmp = join(dir, basename(path));
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    try {
      linkSync(tmp, path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    }
    try {
      writeFileSync(path, text, { mode: 0o600, flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Saves keys to the config directory's `.env`, readable only by the user, in one replace: written
 * inside a private directory (`privateDir`: 0700; on Windows, outside the profile, limited to the
 * user with icacls first), then renamed over the old file — so a key is never in a file others can
 * read (even when an existing `.env` had looser permissions). The directory is removed whatever
 * happens: a failed rename leaves no copy of the keys behind. Returns icacls' warning, if any.
 */
export function saveSecrets(entries: [string, string][], rename: (from: string, to: string) => void = renameOver): string | undefined {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); // BUG-585
  const names = entries.map(([n]) => n);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l && !names.some((name) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l))) : [];
  const warning = writePrivate(path, [...lines, ...entries.map(([n, v]) => `${n}=${v}`), ""].join("\n"), rename);
  for (const [name, value] of entries) {
    saved.set(name, value);
    given.delete(name);
  }
  return warning;
}

/** The names `saveSecrets` writes (`setup` / `connect` save only provider keys): uninstall removes only these lines. */
export const SAVED_KEYS = [...new Set(Object.values(PROVIDERS).flatMap((p) => (p.env ? [p.env] : [])))];

/**
 * A `.env`'s text without Gluon's own key lines (`SAVED_KEYS`): null when nothing else is in it
 * (blank lines aside), so the file can go; the same text when it has none of them.
 */
export function withoutSavedKeys(text: string): string | null {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const keep = text.split(/\r?\n/).filter((l) => !SAVED_KEYS.some((name) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l)));
  return keep.some((l) => l.trim()) ? keep.join(eol) : null;
}

/** Saves one key (`saveSecrets`). */
export const saveSecret = (name: string, value: string) => saveSecrets([[name, value]]);

/**
 * Token-like values and how much of each stays readable (the prefix only, never key material). `keep`
 * gets the whole match and its first group. Every pattern stays linear on hostile text (a cap on each
 * repeat, no nested quantifier, no `.*` up to a closer that may never come): test/secrets.test.ts times them.
 */
const TOKENS: [RegExp, (m: string, g1?: string) => string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, () => "sk-ant-••••"], // Anthropic API keys and OAuth tokens
  [/\bsk-or-v1-[A-Za-z0-9_-]{8,}/g, () => "sk-or-v1-••••"], // OpenRouter
  [/\bsk-proj-[A-Za-z0-9_-]{8,}/g, () => "sk-proj-••••"], // OpenAI project keys
  [/\bsk-(?!ant-|or-v1-|proj-)[A-Za-z0-9_-]{16,}/g, () => "sk-••••"], // OpenAI and other sk- keys (DeepSeek, Moonshot, DashScope, OpenCode, …)
  [/\bxai-[A-Za-z0-9_-]{16,}/g, () => "xai-••••"], // xAI
  [/\bAIza[0-9A-Za-z_-]{30,}/g, () => "AIza••••"], // Google API keys (Gemini)
  [/\bya29\.[\w-]{16,}/g, () => "ya29.••••"], // Google OAuth access tokens
  [/\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g, () => "••••.••••"], // Z.ai (Zhipu)
  [/\bLLM\|?[A-Za-z0-9|_-]{16,}/g, () => "LLM••••"], // Meta (Llama API)
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, (m) => `${m.slice(0, 4)}••••`], // AWS access key ids
  [/\b(?:IQoJ|FwoG)[A-Za-z0-9/+=]{40,}/g, (m) => `${m.slice(0, 4)}••••`], // AWS session tokens
  [/(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]{0,39}[/+])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}[A-Z])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g, () => "••••"], // AWS secret access keys
  [/\bABSK[A-Za-z0-9+/=]{20,}/g, () => "ABSK••••"], // Bedrock API keys (AWS_BEARER_TOKEN_BEDROCK)
  [/\bbedrock-api-key-[A-Za-z0-9+/=_-]{20,}/g, () => "bedrock-api-key-••••"], // Bedrock short-term API keys
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, (m) => `${m.slice(0, 4)}••••`], // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => "github_pat_••••"], // GitHub fine-grained tokens (BUG-583)
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, () => "glpat-••••"], // GitLab personal access tokens
  [/\bnpm_[A-Za-z0-9]{30,}/g, () => "npm_••••"], // npm
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, (m) => `${m.slice(0, 5)}••••`], // Slack
  [/\bhf_[A-Za-z0-9]{30,}/g, () => "hf_••••"], // Hugging Face
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, (m) => `${m.slice(0, m.indexOf("_", 3) + 1)}••••`], // Stripe secret and restricted keys (sk_live_, rk_test_, …)
  [/\bgsk_[A-Za-z0-9]{20,}/g, () => "gsk_••••"], // Groq
  [/\bpplx-[A-Za-z0-9]{20,}/g, () => "pplx-••••"], // Perplexity
  [/\bxapp-[0-9]-[A-Za-z0-9-]{10,}/g, () => "xapp-••••"], // Slack app-level tokens
  [/\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]{16,}/g, () => "hooks.slack.com/services/••••"], // Slack incoming webhooks: the URL is the credential
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, () => "SG.••••"], // SendGrid
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, () => "eyJ••••"], // JWTs
  [/\b(Bearer\s+)[\w.~+/=|-]{16,}/gi, (m) => `${m.split(/\s+/)[0]} ••••`],
  [/\b(Authorization["']?\s*[:=]\s*["']?Basic\s+)[A-Za-z0-9+/=]{16,}/gi, (_m, g1) => `${g1}••••`], // HTTP Basic credentials (Bearer is above); "Basic" alone is a common word
  // A password in a URL (`postgres://user:pw@host`, a git remote): scheme, user and host stay readable (BUG-584). Each part is capped; a space, `/ ? #` end the password, which runs
  // to the last `@` before that (a raw `@` in it), and a placeholder (`${T}`, `<pw>`, `{{x}}`, `$VAR`, `%s`) or an already masked one stays.
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/?#'"<>]{0,128}:)(?![$<{(\[•*]|%[sdv(])[^\s/?#'"<>]{1,128}@/gi, (_m, g1) => `${g1}••••@`],
  // The value after a key that names a secret: `password=hunter22`, `DB_TOKEN="…"`, `"secret": "…"`. At least 6 characters. Not a placeholder (`$VAR`, `<token>`, `{{x}}`), not
  // a word that names a type or a state (`undefined`, `none`, `string`, `required`), not code (`getPassword()`, `config.password`, `os.environ["X"]`: an identifier followed by `( . [`; `token==x`).
  // `max_tokens=` and `passwordless=` don't match. `:` counts only after a quoted key (JSON), so prose like "secret: none" stays.
  [
    /((?:password|passwd|secret|token|api[_-]?key|mysql_pwd)(?:"\s*(?::|=(?!=))|\b\s*=(?!=))\s*)(?!["']?[$<{(\[•*%])(?!["']?[^\s"'&;,<>]{0,300}••••)(?!["']?(?:undefined|null|none|nil|true|false|string|str|int|required|optional|secret|password|token)(?![\w-]))(?![A-Za-z_$][\w$]{0,100}[(.\[])(?:"[^"\n]{4,300}"?|'[^'\n]{4,300}'?|[^\s"'&;,<>]{6,})/gi,
    (_m, g1) => `${g1}••••`,
  ],
];

/** `-----BEGIN … PRIVATE KEY-----` and the end line of the same block, or the base64 lines after a header whose end never came (a cut paste). */
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,30}PRIVATE KEY(?: BLOCK)?-----/y;
const PEM_END = /-----END [A-Z0-9 ]{0,30}PRIVATE KEY(?: BLOCK)?-----/y;
const PEM_LINES = /(?:\r?\n[A-Za-z0-9+/=]{8,}[ \t]*|\r?\n[A-Za-z-]{3,20}: [^\r\n]{1,100})*/y;
/** The longest block read through to its end line (an RSA 16384 key is ~13 kB); past it the header counts as cut. */
const PEM_MAX = 40_000;

/**
 * Hides the body of each private key block, keeping its header and end line. One pass with `indexOf`
 * and sticky regexes, linear: a regex `BEGIN[\s\S]*?END` would rescan to the end of the text for
 * every header that has no end line (BUG-584).
 */
function maskPem(text: string): string {
  let at = text.indexOf("-----BEGIN ");
  if (at < 0) return text;
  let out = "";
  let from = 0;
  let endAt = -2; // the next "-----END " after `at`: -2 not looked up, -1 none left
  while (at >= 0) {
    PEM_BEGIN.lastIndex = at;
    const head = PEM_BEGIN.exec(text);
    if (!head) {
      at = text.indexOf("-----BEGIN ", at + 1);
      continue;
    }
    const bodyStart = at + head[0].length;
    if (endAt !== -1 && endAt < bodyStart) endAt = text.indexOf("-----END ", bodyStart);
    let end = -1; // where the block's end line ends
    let footer = "";
    if (endAt >= 0 && endAt - bodyStart <= PEM_MAX) {
      PEM_END.lastIndex = endAt;
      const f = PEM_END.exec(text);
      if (f) {
        end = endAt + f[0].length;
        footer = f[0];
      }
    }
    let body = ""; // what replaces the text between the header and the end line
    if (end < 0) {
      PEM_LINES.lastIndex = bodyStart;
      PEM_LINES.exec(text);
      end = PEM_LINES.lastIndex;
      if (end === bodyStart) {
        at = text.indexOf("-----BEGIN ", bodyStart); // a header with nothing after it: nothing to hide
        continue;
      }
      body = "\n••••";
    } else body = "\n••••\n";
    out += `${text.slice(from, bodyStart)}${body}${footer}`;
    from = end;
    at = text.indexOf("-----BEGIN ", end);
  }
  return out + text.slice(from);
}

/**
 * Variables whose values are secrets whatever their shape: every provider key Gluon hands out,
 * and AWS's own secrets. Their values (from Gluon's `.env` files or the environment) are masked
 * by value too.
 */
export const SECRET_ENV = [
  ...new Set([
    ...Object.values(PROVIDERS).flatMap((p) => (p.env ? [p.env] : [])),
    "ANTHROPIC_AUTH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLAUDE_CODE_OAUTH_TOKEN",
    // Kimi Code's name for the key of its environment model (an OpenRouter launch hands it the same value).
    "KIMI_MODEL_API_KEY",
  ]),
];

/** Masks one value by its shape, or entirely. */
export function maskValue(value: string): string {
  const shaped = maskByShape(value);
  return shaped !== value ? shaped : "••••";
}

function maskByShape(text: string): string {
  let out = maskPem(text);
  for (const [re, keep] of TOKENS) out = out.replace(re, (m: string, g1: unknown) => keep(m, typeof g1 === "string" ? g1 : undefined));
  return out;
}

/** Masks anything that looks like a key or token, and any value Gluon knows is one, for output, errors and logs. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const v of knownSecretValues(SECRET_ENV).sort((a, b) => b.length - a.length)) if (out.includes(v)) out = out.split(v).join(maskValue(v));
  return maskByShape(out);
}
