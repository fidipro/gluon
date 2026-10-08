/**
 * `src/secrets.ts` on its own: the `.env` reader and writer, the private-file helpers, and the masks.
 * (rules.test.ts checks the rules these serve; this file is the module's edges.) Security QA pass.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecrets, knownSecretValues, maskSecrets, maskValue, outsideProfile, parseEnv, parseSid, privateDir, renameOver, restrictToUser, saveSecret, saveSecrets, secret, SECRET_ENV, secretSource, storageNote, useSecrets, withoutSavedKeys, writePrivate } from "../src/secrets.ts";
import { canSymlink, isPrivate } from "./e2e/fixtures.ts";

const POSIX = process.platform !== "win32";
// The linear-time bounds scale with a slow CI machine (GLUON_TEST_SLOW): a quadratic pattern on these runs of
// millions of characters takes minutes, so a loose bound still catches it.
const SLOW = Number(process.env.GLUON_TEST_SLOW) || 1;
const TMP = mkdtempSync(join(tmpdir(), "gluon-secrets-"));
const saved = { ...process.env };
const env = () => join(TMP, ".env");

beforeAll(() => {
  process.env.GLUON_CONFIG = join(TMP, "config.yaml");
});
afterEach(() => {
  rmSync(env(), { force: true });
  loadSecrets();
  for (const k of ["XAI_API_KEY", "OPENAI_API_KEY", "MY_PLAIN_TOKEN", "AWS_SESSION_TOKEN"]) delete process.env[k];
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(TMP, { recursive: true, force: true });
});

describe("parseEnv", () => {
  test("assignments, `export`, quotes, CRLF, spaces around =; comments, blank lines and junk are not assignments", () => {
    writeFileSync(env(), ['# comment', "", "A=1", "export B=two", 'C="three"', "D='four'", "  E = five", "F=", "not an assignment", "1BAD=x", "G=a=b", 'H="unbalanced', "I=\"x\"y\""].join("\r\n"));
    expect(parseEnv(env())).toEqual([["A", "1"], ["B", "two"], ["C", "three"], ["D", "four"], ["E", "five"], ["F", ""], ["G", "a=b"], ["H", '"unbalanced'], ["I", 'x"y']]);
  });
  test("BUG-587/trailing-space: trailing whitespace after a value is not part of the key (`XAI_API_KEY=xai-... ` in a hand-edited .env would be sent as an HTTP header with the space; dotenv trims it)", () => {
    writeFileSync(env(), "XAI_API_KEY=xai-abc123  \nOTHER = spaced \n");
    expect(parseEnv(env())).toEqual([["XAI_API_KEY", "xai-abc123"], ["OTHER", "spaced"]]);
  });
  test("BUG-587/linear: a value followed by tens of thousands of spaces, and a line of nothing but spaces, are read in linear time", () => {
    writeFileSync(env(), `A=x${" ".repeat(400_000)}y\n${" ".repeat(400_000)}B=1\nC${" ".repeat(400_000)}\nD=z${" ".repeat(400_000)}\n`);
    const t0 = performance.now();
    expect(parseEnv(env())).toEqual([["A", `x${" ".repeat(400_000)}y`], ["B", "1"], ["D", "z"]]);
    expect(performance.now() - t0).toBeLessThan(1000 * SLOW);
  });
  test("BUG-587/quoted: a quoted value keeps the spaces inside the quotes, loses those around them; tabs and CRLF count as trailing too", () => {
    writeFileSync(env(), 'A="  inner  spaces "  \r\nB=\'x y\'\t\r\nC=plain \t \nD="kept" # not a comment handler\nE=   \n');
    expect(parseEnv(env())).toEqual([["A", "  inner  spaces "], ["B", "x y"], ["C", "plain"], ["D", '"kept" # not a comment handler'], ["E", ""]]);
  });
  test("a missing file is no assignments, and an empty value is no secret", () => {
    expect(parseEnv(join(TMP, "absent.env"))).toEqual([]);
    writeFileSync(env(), "XAI_API_KEY=\n");
    loadSecrets();
    expect(secret("XAI_API_KEY")).toBeUndefined();
    expect(secretSource("XAI_API_KEY")).toBeNull();
  });
});

describe("what a key is, and where it came from", () => {
  test("saved beats the environment; the source names the file or the environment, never the value; a development key file counts as saved but is never written", () => {
    process.env.XAI_API_KEY = "xai-from-the-environment-0000";
    expect(secretSource("XAI_API_KEY")).toBe("your environment");
    writeFileSync(env(), "XAI_API_KEY=xai-from-the-env-file-1111\n");
    loadSecrets();
    expect(secret("XAI_API_KEY")).toBe("xai-from-the-env-file-1111");
    expect(secretSource("XAI_API_KEY")).toBe(env());
    useSecrets([["XAI_API_KEY", "xai-development-key-22222"], ["OPENAI_API_KEY", ""]], "/dev/keys.env");
    expect(secret("XAI_API_KEY")).toBe("xai-development-key-22222");
    expect(secretSource("XAI_API_KEY")).toBe("/dev/keys.env");
    expect(secret("OPENAI_API_KEY")).toBeUndefined();
    // Reloading drops what was handed in; a save of the same name makes it Gluon's own again.
    loadSecrets();
    expect(secretSource("XAI_API_KEY")).toBe(env());
  });
  test("loading a .env never touches process.env", () => {
    writeFileSync(env(), "OPENAI_API_KEY=sk-proj-fromfilefromfilefromfile\n");
    delete process.env.OPENAI_API_KEY;
    loadSecrets();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(secret("OPENAI_API_KEY")).toBe("sk-proj-fromfilefromfilefromfile");
  });
});

describe("saveSecrets", () => {
  test("replaces a name's lines (also `export NAME =`), keeps every other line, ends with a newline, and the secret is in memory at once", () => {
    writeFileSync(env(), "KEEP=1\nexport XAI_API_KEY = old\nXAI_API_KEY=older\n# note\n");
    saveSecrets([["XAI_API_KEY", "xai-new-value-00000000"], ["OPENAI_API_KEY", "sk-proj-newnewnewnewnewnew"]]);
    expect(readFileSync(env(), "utf8")).toBe("KEEP=1\n# note\nXAI_API_KEY=xai-new-value-00000000\nOPENAI_API_KEY=sk-proj-newnewnewnewnewnew\n");
    expect(secret("XAI_API_KEY")).toBe("xai-new-value-00000000");
  });
  test("a name that is a prefix of another leaves the other alone (XAI_API_KEY vs XAI_API_KEY_2)", () => {
    writeFileSync(env(), "XAI_API_KEY_2=other\n");
    saveSecret("XAI_API_KEY", "xai-new-value-00000000");
    expect(readFileSync(env(), "utf8")).toBe("XAI_API_KEY_2=other\nXAI_API_KEY=xai-new-value-00000000\n");
  });
  test.skipIf(!POSIX)("0600 whatever the umask or the old file's mode, and the directory of a fresh config is created too", () => {
    const old = process.umask(0);
    try {
      writeFileSync(env(), "A=1\n", { mode: 0o666 });
      chmodSync(env(), 0o666);
      saveSecret("XAI_API_KEY", "xai-new-value-00000000");
      expect(statSync(env()).mode & 0o777).toBe(0o600);
      expect(isPrivate(env(), homedir())).toBe(true);
    } finally {
      process.umask(old);
    }
  });
  test("a rename that fails leaves no directory and no copy of the key, and the old file as it was", () => {
    writeFileSync(env(), "KEEP=1\n");
    const before = readdirSync(TMP).sort();
    expect(() =>
      saveSecrets([["XAI_API_KEY", "xai-new-value-00000000"]], () => {
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(readdirSync(TMP).sort()).toEqual(before);
    expect(readFileSync(env(), "utf8")).toBe("KEEP=1\n");
    expect(secret("XAI_API_KEY")).toBeUndefined();
  });
  test.skipIf(!canSymlink)("a symlink planted at the .env is replaced, not followed: its target is never written", () => {
    const target = join(TMP, "victim.txt");
    writeFileSync(target, "untouched\n");
    symlinkSync(target, env());
    saveSecret("XAI_API_KEY", "xai-new-value-00000000");
    expect(readFileSync(target, "utf8")).toBe("untouched\n");
    expect(lstatSync(env()).isSymbolicLink()).toBe(false);
    expect(readFileSync(env(), "utf8")).toContain("XAI_API_KEY=xai-new-value-00000000\n");
  });
  test("withoutSavedKeys drops only Gluon's own key lines, keeps the line ending, and says null when nothing else is left", () => {
    expect(withoutSavedKeys("XAI_API_KEY=a\r\nMINE=1\r\nexport OPENAI_API_KEY=b\r\n")).toBe("MINE=1\r\n");
    expect(withoutSavedKeys("XAI_API_KEY=a\n\n")).toBeNull();
    expect(withoutSavedKeys("MINE=1\n")).toBe("MINE=1\n");
  });
});

describe("private files", () => {
  test.skipIf(!POSIX)("privateDir is 0700 under an umask of 0, its name is random, and a parent that doesn't exist throws (nothing is made)", () => {
    const old = process.umask(0);
    try {
      const a = privateDir(TMP, "p-");
      const b = privateDir(TMP, "p-");
      expect(a.dir).not.toBe(b.dir);
      expect(statSync(a.dir).mode & 0o777).toBe(0o700);
      expect(a.warning).toBeUndefined();
      expect(() => privateDir(join(TMP, "no", "such", "parent"), "p-")).toThrow();
      expect(existsSync(join(TMP, "no"))).toBe(false);
    } finally {
      process.umask(old);
    }
  });
  test.skipIf(!POSIX)("restricting for Windows where there is no whoami.exe / icacls.exe is a warning naming the path, never a throw", () => {
    const dir = join(TMP, "w");
    mkdirSync(dir);
    expect(restrictToUser(dir, true)).toBe(`could not limit ${dir} to your account (icacls); check who can read it`);
    expect(privateDir(TMP, "w-", true).warning).toContain("could not limit");
  });
  test("writePrivate creates the parent directories, replaces an existing file, and leaves no .gluon- directory behind, even when the rename fails", () => {
    const path = join(TMP, "a", "b", "file.json");
    expect(writePrivate(path, "one\n")).toBeUndefined();
    writePrivate(path, "two\n");
    expect(readFileSync(path, "utf8")).toBe("two\n");
    expect(readdirSync(join(TMP, "a", "b"))).toEqual(["file.json"]);
    expect(() =>
      writePrivate(path, "three\n", () => {
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(readdirSync(join(TMP, "a", "b"))).toEqual(["file.json"]);
    if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  test("renameOver retries a busy file a few times, then gives up with its own error; another error is not retried", () => {
    let calls = 0;
    renameOver("a", "b", () => {
      if (++calls < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    });
    expect(calls).toBe(3);
    calls = 0;
    expect(() =>
      renameOver("a", "b", () => {
        calls++;
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }, 2),
    ).toThrow("denied");
    expect(calls).toBe(2);
    calls = 0;
    expect(() =>
      renameOver("a", "b", () => {
        calls++;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
    ).toThrow("missing");
    expect(calls).toBe(1);
  });
});

describe("Windows' side, as pure functions", () => {
  test("parseSid takes the SID from whoami's CSV and nothing else", () => {
    expect(parseSid('"HOST\\me","S-1-5-21-111-222-333-1001"\r\n')).toBe("S-1-5-21-111-222-333-1001");
    expect(parseSid("")).toBeNull();
    expect(parseSid("ERROR: Access denied")).toBeNull();
    expect(parseSid('"HOST\\me","S-1-"\n')).toBeNull();
  });
  test("outsideProfile: inside the profile, beside it, another drive, case-insensitive", () => {
    const same = (p: string) => p;
    expect(outsideProfile("C:\\Users\\me\\.config\\gluon\\.env", "C:\\Users\\me", same)).toBe(false);
    expect(outsideProfile("c:\\USERS\\ME\\x", "C:\\Users\\me", same)).toBe(false);
    expect(outsideProfile("C:\\Users\\other\\x", "C:\\Users\\me", same)).toBe(true);
    expect(outsideProfile("D:\\keys\\.env", "C:\\Users\\me", same)).toBe(true);
    expect(outsideProfile("C:\\Users\\me2\\x", "C:\\Users\\me", same)).toBe(true);
  });
  test("storageNote is honest per platform", () => {
    expect(storageNote("linux")).toBe("readable only by you (mode 600)");
    expect(storageNote("darwin")).toBe("readable only by you (mode 600)");
    expect(storageNote("win32", "C:\\Users\\me\\x\\.env", "C:\\Users\\me")).toContain("in your Windows profile");
    expect(storageNote("win32", "D:\\keys\\.env", "C:\\Users\\me")).toContain("icacls");
  });
});

describe("masking edges", () => {
  test("a known value is masked wherever it occurs, longest first, with regex characters in it, and a value under 8 characters is not (too short to tell from text)", () => {
    saveSecret("XAI_API_KEY", "a.b*c+d?e(f)g[h]");
    saveSecret("OPENAI_API_KEY", "a.b*c+d?e(f)g[h]-longer-one");
    expect(maskSecrets("x a.b*c+d?e(f)g[h]-longer-one y a.b*c+d?e(f)g[h] z")).toBe("x •••• y •••• z");
    expect(maskSecrets("axbbc")).toBe("axbbc");
    saveSecret("MY_PLAIN_TOKEN", "short");
    expect(maskSecrets("a short one")).toBe("a short one");
  });
  test("a secret-named variable in the .env is masked by value; the environment's only for the names Gluon hands out", () => {
    writeFileSync(env(), "MY_PLAIN_TOKEN=plain-token-value-1\nREGION=us-east-1-long\n");
    loadSecrets();
    process.env.AWS_SESSION_TOKEN = "plain-session-value-2";
    process.env.UNRELATED_PASSWORD = "plain-env-password-3";
    try {
      expect(maskSecrets("a plain-token-value-1 b plain-session-value-2 c us-east-1-long d plain-env-password-3")).toBe("a •••• b •••• c us-east-1-long d plain-env-password-3");
    } finally {
      delete process.env.UNRELATED_PASSWORD;
    }
    expect(knownSecretValues(SECRET_ENV)).toEqual(expect.arrayContaining(["plain-token-value-1", "plain-session-value-2"]));
  });
  test("maskValue keeps a known vendor's prefix and shows nothing of an unknown shape", () => {
    expect(maskValue("sk-ant-api03-abcdefghijklmnop")).toBe("sk-ant-••••");
    expect(maskValue("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("ghp_••••");
    expect(maskValue("plain")).toBe("••••");
  });
  test("Bearer values, JWTs and text with a key twice: every occurrence goes; text around stays", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(maskSecrets(`Authorization: Bearer abcdefghijklmnop1234 and ${jwt} and sk-ant-api03-abcdefghijklmnop sk-ant-api03-abcdefghijklmnop`)).toBe("Authorization: Bearer •••• and eyJ•••• and sk-ant-•••• sk-ant-••••");
  });
  test("an empty string, and text with nothing to hide, come back unchanged", () => {
    expect(maskSecrets("")).toBe("");
    expect(maskSecrets("model gpt-6 failed: 429 rate limit (retry in 20 s)")).toBe("model gpt-6 failed: 429 rate limit (retry in 20 s)");
  });

  test("BUG-583/vendor-tokens: the tokens GitHub, GitLab, npm, Slack and Hugging Face hand out today are masked (github_pat_…, glpat-…, npm_…, xox*-…, hf_…): an error, an issue text from `forge`, a spec saved to analytics or a workspace carries them as they are", () => {
    const tokens = [
      "github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ",
      "glpat-abcdefghij0123456789",
      "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx",
      "hf_abcdefghijklmnopqrstuvwxyzABCDEFGH",
    ];
    expect(tokens.filter((t) => maskSecrets(`error ${t} end`).includes(t.slice(-12)))).toEqual([]);
  });
  test("BUG-584/url-password-and-pem: a password in a URL (https://user:password@host, a git remote or a database DSN) and a PEM private key block are masked", () => {
    const text = "fatal: unable to access 'https://user:s3cretPassw0rd@example.com/x.git'";
    expect(maskSecrets(text)).not.toContain("s3cretPassw0rd");
    expect(maskSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7abcdefgh\n-----END RSA PRIVATE KEY-----")).not.toContain("MIIEowIBAAKCAQEA7abcdefgh");
  });

  describe("the vendor tokens, in text", () => {
    const TOKENS: Record<string, [string, string]> = {
      "github_pat_": ["github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ", "github_pat_••••"],
      "glpat-": ["glpat-abcdefghij0123456789", "glpat-••••"],
      "npm_": ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm_••••"],
      "xoxb-": ["xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx", "xoxb-••••"],
      "xoxp-": ["xoxp-123456789012-abcdefghijklmnopqrstuvwx", "xoxp-••••"],
      "hf_": ["hf_abcdefghijklmnopqrstuvwxyzABCDEFGH", "hf_••••"],
      "sk_live_": ["sk_live_abcdefghijklmnopqrstuvwx", "sk_live_••••"],
      "rk_live_": ["rk_live_abcdefghijklmnopqrstuvwx", "rk_live_••••"],
      "gsk_": ["gsk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN", "gsk_••••"],
      "pplx-": ["pplx-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF", "pplx-••••"],
      "xapp-": ["xapp-1-A0123456789-1234567890123-abcdef0123456789abcdef", "xapp-••••"],
      "hooks.slack.com": ["hooks.slack.com/services/T0123456789/B0123456789/abcdef0123456789abcdef0123", "hooks.slack.com/services/••••"],
      "SG.": ["SG.abcdef0123456789abcdef.abcdef0123456789abcdef0123456789abcdef01234", "SG.••••"],
    };
    for (const [name, [token, shown]] of Object.entries(TOKENS)) {
      test(`BUG-583/${name}: masked in a sentence, at the end of a line and in JSON; only the prefix stays`, () => {
        expect(maskSecrets(`I pasted ${token} by mistake, sorry`)).toBe(`I pasted ${shown} by mistake, sorry`);
        expect(maskSecrets(`line one\nTOKEN=${token}\nline three`)).toBe(`line one\nTOKEN=${shown}\nline three`);
        expect(maskSecrets(`{"auth":"${token}"}`)).toBe(`{"auth":"${shown}"}`);
        expect(maskValue(token)).toBe(shown);
      });
    }
    test("BUG-583/authorization: an Authorization header's Basic and Bearer credentials go (16+ characters), the scheme stays; the word Basic in prose does not count", () => {
      expect(maskSecrets("-H 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Njc4' -H \"Authorization: Bearer abcdef0123456789abcdef\"")).toBe("-H 'Authorization: Basic ••••' -H \"Authorization: Bearer ••••\"");
      expect(maskSecrets('{"Authorization":"Basic dXNlcjpwYXNzd29yZDEyMzQ1Njc4"}')).toBe('{"Authorization":"Basic ••••"}');
      expect(maskSecrets("curl https://hooks.slack.com/services/T0123456789/B0123456789/abcdef0123456789abcdef0123 now")).toBe("curl https://hooks.slack.com/services/•••• now");
      const prose = "Basic configuration infrastructure; Authorization: Basic abc; Authorization: Bearer short";
      expect(maskSecrets(prose)).toBe(prose);
    });
    test("BUG-583/not-tokens: words that only start like a token, and tokens too short to be one, stay as they are", () => {
      const prose = "run npm_modules or npm_config_cache; hf_ and gsk_ prefixes, glpat-x, xoxb-short, pplx-1, github_pat_ alone, sk_live_ keys, the hf_hub cache, an npm_ var";
      expect(maskSecrets(prose)).toBe(prose);
    });
  });

  describe("a password in a URL", () => {
    test("BUG-584/url: the password goes; scheme, user and host stay, whatever the scheme (a git remote, a DSN) and what follows", () => {
      expect(maskSecrets("fatal: unable to access 'https://user:s3cretPassw0rd@example.com/x.git'")).toBe("fatal: unable to access 'https://user:••••@example.com/x.git'");
      expect(maskSecrets("DATABASE_URL=postgres://app:pa55-abcdef-0123@db.internal:5432/app?sslmode=require")).toBe("DATABASE_URL=postgres://app:••••@db.internal:5432/app?sslmode=require");
      expect(maskSecrets("redis://:abcdef0123@cache:6379")).toBe("redis://:••••@cache:6379");
      expect(maskSecrets('{"remote":"git+https://ci:pw-abcdef-0123456789@git.example.com/org/repo"}')).toBe('{"remote":"git+https://ci:••••@git.example.com/org/repo"}');
      expect(maskSecrets("clone https://u:p%40ss-abcdef@host.example, then ssh://u:abcdef0123@h:22/x.")).toBe("clone https://u:••••@host.example, then ssh://u:••••@h:22/x.");
    });
    test("BUG-584/url-at-sign: a raw @ in the password does not leave its tail visible (the password runs to the last @ before the host)", () => {
      expect(maskSecrets("https://user:pa@ss-word99@host/x")).toBe("https://user:••••@host/x");
      expect(maskSecrets("mysql://root:pa@ss-word99@db:3306/x, then")).toBe("mysql://root:••••@db:3306/x, then");
      expect(maskSecrets('{"u":"postgres://a:b@c-abcdef@h"}')).toBe('{"u":"postgres://a:••••@h"}');
    });
    test("BUG-584/url-placeholder: a placeholder or an already masked password stays as it is", () => {
      const text = "https://u:${T}@h https://u:<pw>@h https://u:{{x}}@h https://u:$VAR@h https://u:%s@h https://u:••••@h";
      expect(maskSecrets(text)).toBe(text);
    });
    test("BUG-584/url-unchanged: a URL without a password stays whole (user only, port, query, e-mail, scp-style remote)", () => {
      const text = "see https://github.com/org/repo, https://user@host/x, http://localhost:3000/a?b=c@d, http://localhost:3000 me@x.com, git@github.com:org/repo.git, ssh://git@host:22/x.git";
      expect(maskSecrets(text)).toBe(text);
    });
    test("BUG-584/url-linear: hostile URLs take linear time (a long https:// with many ':' and no '@', a password that never ends, thousands of schemes)", () => {
      for (const text of ["https://" + ":".repeat(2_000_000), "https://user:" + "x".repeat(2_000_000), "https://a:b".repeat(300_000), "https://u:" + "a@".repeat(1_000_000), "https://u:".repeat(300_000), "a.".repeat(1_000_000) + "://" + "u:".repeat(500_000)]) {
        const t0 = performance.now();
        maskSecrets(text);
        expect(performance.now() - t0).toBeLessThan(1500 * SLOW);
      }
    });
  });

  describe("a private key block", () => {
    const BODY = "MIIEowIBAAKCAQEA7abcdefghABCDEFGHIJ0123456789abcdefghABCDEFGHIJ0123456789==";
    // Built at run time so no secret scanner sees a PEM header in this file.
    const B = "-----BEGIN ";
    test("BUG-584/pem: the body goes, the header and end line stay, for each kind of key and in a sentence, JSON or CRLF text", () => {
      for (const kind of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
        const pem = `${B}${kind}-----\n${BODY}\n${BODY}\n-----END ${kind}-----`;
        expect(maskSecrets(`use this key:\n${pem}\nthen deploy`)).toBe(`use this key:\n${B}${kind}-----\n••••\n-----END ${kind}-----\nthen deploy`);
      }
      const crlf = maskSecrets(`${B}PRIVATE KEY-----\r\n${BODY}\r\n-----END PRIVATE KEY-----\r\nafter`);
      expect(crlf).not.toContain("abcdefgh");
      expect(crlf).toContain("after");
      const json = maskSecrets(JSON.stringify({ key: `${B}PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY-----\n`, other: "kept" }));
      expect(json).not.toContain("abcdefgh");
      expect(json).toContain('"other":"kept"');
      expect(maskSecrets(`a ${B}PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY----- b ${B}EC PRIVATE KEY-----\n${BODY}\n-----END EC PRIVATE KEY----- c`)).toBe(
        `a ${B}PRIVATE KEY-----\n••••\n-----END PRIVATE KEY----- b ${B}EC PRIVATE KEY-----\n••••\n-----END EC PRIVATE KEY----- c`,
      );
    });
    test("BUG-584/pem-cut: a block whose end line was cut off hides the key lines after the header, and not the text after them", () => {
      expect(maskSecrets(`${B}RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n${BODY}\n${BODY}\n\nthen test the thing`)).toBe(`${B}RSA PRIVATE KEY-----\n••••\n\nthen test the thing`);
      const prose = `a private key starts with ${B}PRIVATE KEY----- and ends with the matching line`;
      expect(maskSecrets(prose)).toBe(prose);
    });
    test("BUG-584/pem-unchanged: a certificate or a public key is not a private key", () => {
      const cert = `-----BEGIN CERTIFICATE-----\n${BODY}\n-----END CERTIFICATE-----`;
      expect(maskSecrets(cert)).toBe(cert);
      const pub = `-----BEGIN PUBLIC KEY-----\n${BODY}\n-----END PUBLIC KEY-----`;
      expect(maskSecrets(pub)).toBe(pub);
    });
    test("BUG-584/pem-linear: a BEGIN with no END, thousands of BEGINs, a body that never stops, a header of spaces take linear time", () => {
      const cases = [
        `${B}PRIVATE KEY-----\n`.repeat(150_000),
        `${B}PRIVATE KEY-----` + "\nAAAAAAAAAAAAAAAA".repeat(200_000),
        `${B}PRIVATE KEY-----\n` + BODY + "\nx".repeat(1_000_000),
        "-----BEGIN " + " ".repeat(2_000_000),
        (`${B}PRIVATE KEY-----\n` + BODY + "\n").repeat(30_000),
      ];
      for (const text of cases) {
        const t0 = performance.now();
        maskSecrets(text);
        expect(performance.now() - t0).toBeLessThan(1500 * SLOW);
      }
    });
  });

  describe("a value after a key that names a secret", () => {
    test("BUG-588/key-value: password=, passwd=, secret=, token= (also in a longer name, quoted, in JSON): the value goes, the key stays", () => {
      expect(maskSecrets("password=hunter2-abcdef and passwd = pw0123456789 then")).toBe("password=•••• and passwd = •••• then");
      expect(maskSecrets("export DB_PASSWORD=\"correct horse abcdef\"\nAPI_TOKEN='abcdef0123456789'")).toBe("export DB_PASSWORD=••••\nAPI_TOKEN=••••");
      expect(maskSecrets('{"password": "correct horse abcdef", "client_secret":"abcdef0123456789", "name": "ann"}')).toBe('{"password": ••••, "client_secret":••••, "name": "ann"}');
      expect(maskSecrets("curl 'https://x.example/api?access_token=abcdef0123456789&page=2'")).toBe("curl 'https://x.example/api?access_token=••••&page=2'");
      expect(maskSecrets("SECRET=abcdef0123456789")).toBe("SECRET=••••");
    });
    test("BUG-588/key-value-unchanged: prose, placeholders, short values and other names stay", () => {
      const text = "secret: none; token: abcdefghi (prose); password=short; max_tokens=100000; passwordless=abcdefghij; tokens=abcdefghij; token=$TOKEN; secret=<your secret>; password={{pw}}; token=%s; password=••••";
      expect(maskSecrets(text)).toBe(text);
    });
    test("BUG-588/key-value-code: code in a spec survives (a call, a member, an index, a comparison, a keyword value); a value that looks real still goes", () => {
      const code = [
        "password=getPassword()", "password = config.password", "if (token==abcdefg) {}", "if (token === abcdefghij)", "if (token!=abcdefghij)", 'password=os.environ["X"]',
        "token=undefined", "token=null", "password=string", "password=None", "secret=required", "api_key=optional", "token=true", "password=password", "token=token",
      ];
      for (const c of code) expect([c, maskSecrets(c)]).toEqual([c, c]);
      expect(maskSecrets("password=stringified-abc123 and password=Required-value-123")).toBe("password=•••• and password=••••");
      expect(maskSecrets("DB_PASSWORD=Xy7kQ9pLm2 password=hunter2hunter2")).toBe("DB_PASSWORD=•••• password=••••");
    });
    test("BUG-588/key-value-names: api_key, apikey, api-key, client_secret, MYSQL_PWD count like password", () => {
      expect(maskSecrets("api_key=abcdef0123456789 apikey=abcdef0123456789 api-key = abcdef0123456789 client_secret=abcdef0123456789 MYSQL_PWD=abcdef0123")).toBe(
        "api_key=•••• apikey=•••• api-key = •••• client_secret=•••• MYSQL_PWD=••••",
      );
      const same = "api_key=undefined; apikey=getKey(); api_keys=abcdef0123456789; pwd=/home/abcdef0123";
      expect(maskSecrets(same)).toBe(same);
    });
    test("BUG-588/key-value-linear: long runs of the keywords, of spaces and of an open quote take linear time", () => {
      for (const text of ["password=".repeat(500_000), "token" + " ".repeat(2_000_000) + "=", 'secret="' + "a ".repeat(1_000_000), 'passwd="'.repeat(300_000), "token=" + "a".repeat(2_000_000), "api_key=a.".repeat(300_000), "Authorization: Basic " + "A".repeat(2_000_000), "Authorization: Basic ".repeat(100_000), 'token"='.repeat(500_000)]) {
        const t0 = performance.now();
        maskSecrets(text);
        expect(performance.now() - t0).toBeLessThan(1500 * SLOW);
      }
    });
  });

  test("BUG-583/linear: every token pattern takes linear time on a long run of its own prefix and on prefixes in a row", () => {
    const prefixes = ["github_pat_", "glpat-", "npm_", "xoxb-", "hf_", "sk_live_", "rk_test_", "gsk_", "pplx-"];
    const cases = [...prefixes.map((p) => p + "a".repeat(2_000_000)), prefixes.join(" ").repeat(100_000), prefixes.map((p) => p.repeat(100_000)).join(" ")];
    for (const text of cases) {
      const t0 = performance.now();
      maskSecrets(text);
      expect(performance.now() - t0).toBeLessThan(1500 * SLOW);
    }
  });
});

describe("the config directory under a loose umask", () => {
  const under = (umask: number, fn: () => void) => {
    const old = process.umask(umask);
    try {
      fn();
    } finally {
      process.umask(old);
    }
  };
  (POSIX ? test : test.skip)("BUG-585/config-dir-umask: the directory that holds the .env is never writable by group or others, whatever the umask (umask 000, as WSL1 and some containers start: 0777, so another user can replace or unlink the .env)", () => {
    const dir = join(TMP, "fresh-config-dir");
    process.env.GLUON_CONFIG = join(dir, "config.yaml");
    try {
      under(0, () => saveSecret("XAI_API_KEY", "xai-new-value-00000000"));
      expect(statSync(dir).mode & 0o022).toBe(0);
    } finally {
      process.env.GLUON_CONFIG = join(TMP, "config.yaml");
    }
  });
  (POSIX ? test : test.skip)("BUG-586/config-file-umask: config.yaml is not writable by group or others, whatever the umask (saveConfig writes it with the default mode: 0666 under umask 000)", async () => {
    const { saveConfig } = await import("../src/config.ts");
    const path = join(TMP, "umask-config.yaml");
    process.env.GLUON_CONFIG = path;
    try {
      under(0, () => saveConfig([[["analytics"], true]]));
      expect(statSync(path).mode & 0o022).toBe(0);
    } finally {
      process.env.GLUON_CONFIG = join(TMP, "config.yaml");
    }
  });
  (POSIX ? test : test.skip)("BUG-585/dirs-and-modes: under umask 000 a new config directory is 0700 and a new config.yaml 0600, a looser existing config.yaml loses the write bits for others and keeps its read bits, a 0600 one stays", async () => {
    const { saveConfig } = await import("../src/config.ts");
    const dir = join(TMP, "deep", "new", "config-dir");
    const path = join(dir, "config.yaml");
    process.env.GLUON_CONFIG = path;
    try {
      expect(path.startsWith(TMP)).toBe(true);
      under(0, () => saveConfig([[["analytics"], true]]));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      for (const [before, after] of [[0o666, 0o644], [0o664, 0o644], [0o644, 0o644], [0o600, 0o600], [0o777, 0o755]] as const) {
        chmodSync(path, before);
        under(0, () => saveConfig([[["analytics"], false]]));
        expect([before, statSync(path).mode & 0o777]).toEqual([before, after]);
      }
    } finally {
      process.env.GLUON_CONFIG = join(TMP, "config.yaml");
    }
  });
  test.skipIf(!POSIX)("under umask 077 and 000 the keys stay 0600 and their temp directory is gone (what rules.test.ts checks for 022)", () => {
    for (const u of [0o077, 0]) {
      under(u, () => saveSecret("XAI_API_KEY", `xai-new-value-0000000${u}`));
      expect(statSync(env()).mode & 0o777).toBe(0o600);
      expect(readdirSync(TMP).filter((f) => f.startsWith(".gluon-"))).toEqual([]);
    }
  });
});
