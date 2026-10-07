/** Paths and key storage per platform: the config's place, saved keys on Windows, no source-dir .env. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { aclProblem, isPrivate, WIN } from "./e2e/fixtures.ts";
import { longPath, shortPath } from "../src/detect.ts";
import { configPath } from "../src/config.ts";
import { ledgerDir, stateDir } from "../src/cost/ledger-file.ts";
import { tablesDir } from "../src/cost/tables-store.ts";
import { loadSecrets, outsideProfile, windowsTool, parseEnv, parseSid, renameOver, saveSecrets, secret, secretSource, storageNote, useSecrets } from "../src/secrets.ts";

describe("configPath", () => {
  test("GLUON_CONFIG > XDG_CONFIG_HOME > %APPDATA% on Windows > ~/.config", () => {
    expect(configPath({ GLUON_CONFIG: "/x/c.yaml", XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me")).toBe("/x/c.yaml");
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me")).toBe("/xdg/gluon/config.yaml");
    expect(configPath({}, "linux", "/home/me")).toBe("/home/me/.config/gluon/config.yaml");
    expect(configPath({}, "darwin", "/Users/me")).toBe("/Users/me/.config/gluon/config.yaml");
    expect(configPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\AppData\\Roaming\\gluon\\config.yaml");
    expect(configPath({}, "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\AppData\\Roaming\\gluon\\config.yaml");
    expect(configPath({ XDG_CONFIG_HOME: "D:\\cfg", APPDATA: "C:\\a" }, "win32", "C:\\Users\\me")).toBe("D:\\cfg\\gluon\\config.yaml");
  });

  test("BUG-620/variants: a relative XDG_CONFIG_HOME or XDG_STATE_HOME is ignored, on every platform", () => {
    expect(configPath({ XDG_CONFIG_HOME: "rel" }, "linux", "/home/me")).toBe("/home/me/.config/gluon/config.yaml");
    expect(configPath({ XDG_CONFIG_HOME: "." }, "darwin", "/Users/me")).toBe("/Users/me/.config/gluon/config.yaml");
    expect(configPath({ XDG_CONFIG_HOME: "rel", APPDATA: "C:\\a" }, "win32", "C:\\Users\\me")).toBe("C:\\a\\gluon\\config.yaml");
    expect(configPath({ XDG_CONFIG_HOME: "/abs" }, "linux", "/home/me")).toBe("/abs/gluon/config.yaml");
    expect(stateDir({ XDG_STATE_HOME: "rel/state" }, "linux", "/home/me")).toBe("/home/me/.local/state/gluon");
    expect(stateDir({ XDG_STATE_HOME: "rel", LOCALAPPDATA: "C:\\l" }, "win32", "C:\\Users\\me")).toBe("C:\\l\\gluon");
    expect(tablesDir({ XDG_STATE_HOME: "rel" }, "linux", "/home/me")).toBe("/home/me/.local/state/gluon/tables");
    expect(tablesDir({ XDG_STATE_HOME: "/s" }, "linux", "/home/me")).toBe("/s/gluon/tables");
    // A path built for a platform uses that platform's separator, whichever host runs this.
    expect(tablesDir({ LOCALAPPDATA: "C:\\l" }, "win32", "C:\\Users\\me")).toBe("C:\\l\\gluon\\tables");
    expect(ledgerDir({}, "win32", "C:\\Users\\me")).toBe("C:\\Users\\me\\AppData\\Local\\gluon\\cost-audit");
  });
});

describe("saved keys on Windows", () => {
  test("the SID comes from whoami's CSV, never the user name", () => {
    expect(parseSid('"desktop-1\\\\me","S-1-5-21-1004336348-1177238915-682003330-1001"\r\n')).toBe("S-1-5-21-1004336348-1177238915-682003330-1001");
    expect(parseSid('"me","S-1-5-18"')).toBe("S-1-5-18");
    expect(parseSid("ERROR: access denied")).toBeNull();
    expect(parseSid('"S-1-5-21-1","x"')).toBeNull();
  });
  test("outside the profile: another drive, a UNC share, a sibling; inside: under it, in any case", () => {
    const home = "C:\\Users\\me";
    const outside = (path: string) => outsideProfile(path, home, (p) => p);
    expect(outside("C:\\Users\\me\\AppData\\Roaming\\gluon\\.env")).toBe(false);
    expect(outside("c:\\users\\ME\\cfg\\.env")).toBe(false);
    expect(outside("D:\\cfg\\.env")).toBe(true);
    expect(outside("\\\\server\\share\\.env")).toBe(true);
    expect(outside("C:\\Users\\me2\\.env")).toBe(true);
    expect(outside("C:\\ProgramData\\gluon\\.env")).toBe(true);
  });
  test("BUG-132: an 8.3 short path is compared in its long form (GitHub's TEMP is C:\\Users\\RUNNER~1\\…, the profile C:\\Users\\runneradmin)", () => {
    const long = (p: string) => p.replace(/^C:\\Users\\RUNNER~1(?=\\|$)/i, "C:\\Users\\runneradmin");
    const temp = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\gluon-keys-x\\.env";
    expect(outsideProfile(temp, "C:\\Users\\runneradmin", long)).toBe(false);
    expect(outsideProfile("C:\\Users\\runneradmin\\cfg\\.env", "C:\\Users\\RUNNER~1", long)).toBe(false);
    expect(outsideProfile("C:\\Users\\RUNNER~2\\.env", "C:\\Users\\runneradmin", long)).toBe(true);
    // Elsewhere, paths are left as they are.
    if (!WIN) expect(longPath(temp)).toBe(temp);
  });
  test.skipIf(!WIN)("BUG-132: on Windows, a real short name and its long name are the same place", () => {
    const home = mkdtempSync(join(tmpdir(), "gluon long profile name-"));
    mkdirSync(join(home, "a long directory name"));
    const short = shortPath(join(home, "a long directory name"));
    try {
      // No 8.3 names on this volume: nothing to compare.
      if (!short || short === join(home, "a long directory name")) return;
      expect(longPath(join(short, "not yet", ".env")).toLowerCase()).toBe(join(longPath(join(home, "a long directory name")), "not yet", ".env").toLowerCase());
      expect(longPath(join(home, "a long directory name"))).not.toContain("~");
      expect(outsideProfile(join(short, ".env"), home)).toBe(false);
      expect(outsideProfile(join(home, "a long directory name", ".env"), shortPath(home) ?? home)).toBe(false);
      expect(outsideProfile(join(tmpdir(), ".env"), join(home, "a long directory name"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("BUG-132: the tests' privacy check reads the DACL by SID: the user, SYSTEM and Administrators only; a label grants nothing", () => {
    const me = "S-1-5-21-1-2-3-1001";
    expect(aclProblem(`D:PAI(A;;FA;;;${me})`, me)).toBe(true);
    // Elevated (GitHub's runneradmin): an integrity label, listed by icacls, is no access.
    expect(aclProblem(`D:PAI(A;ID;FA;;;${me})S:AI(ML;ID;NW;;;HI)`, me)).toBe(true);
    expect(aclProblem(`D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${me})`, me)).toBe(true);
    expect(aclProblem(`D:PAI(A;OICIIO;FA;;;CO)(A;;FA;;;${me})`, me)).toBe(true);
    for (const who of ["WD", "BU", "AU", "S-1-5-21-1-2-3-1002"]) expect(aclProblem(`D:AI(A;ID;FA;;;${me})(A;ID;0x1200a9;;;${who})`, me)).toStartWith(`readable by ${who}`);
    // The built-in Administrator (RID 500, GitHub's runneradmin) is written LA; only for that account.
    expect(aclProblem("D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;LA)", "S-1-5-21-1-2-3-500")).toBe(true);
    expect(aclProblem("D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;LA)", "S-1-5-21-1-2-3-1001")).toStartWith("readable by LA");
    expect(aclProblem("D:NO_ACCESS_CONTROL", me)).not.toBe(true);
    expect(aclProblem("D:PAI(A;;FA;;;SY)", me)).toStartWith("not granted to the user");
    expect(aclProblem("", me)).toStartWith("no DACL");
  });
  test("BUG-96/P1: whoami and icacls run from System32 by full path, never by bare name from the repo", () => {
    expect(windowsTool("whoami", { SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\whoami.exe");
    expect(windowsTool("icacls", {})).toBe("C:\\Windows\\System32\\icacls.exe");
    const src = readFileSync(join(import.meta.dir, "../src/secrets.ts"), "utf8");
    expect(src).not.toMatch(/spawnSync\(\[\s*"(whoami|icacls)"/);
  });
  test("the wording says what each OS actually does", () => {
    expect(storageNote("linux")).toBe("readable only by you (mode 600)");
    expect(storageNote("darwin")).toBe("readable only by you (mode 600)");
    expect(storageNote("win32", "C:\\Users\\me\\AppData\\Roaming\\gluon\\.env", "C:\\Users\\me")).toBe("in your Windows profile, readable by your account and administrators");
    expect(storageNote("win32", "D:\\cfg\\.env", "C:\\Users\\me")).toBe("limited to your account and administrators (icacls)");
  });
  test("a rename refused for a moment (EPERM/EBUSY) is retried; anything else, or too many, throws", () => {
    const fail = (codes: string[]) => {
      let calls = 0;
      const rename = () => {
        const code = codes[calls++];
        if (code) throw Object.assign(new Error(code), { code });
      };
      return { rename, calls: () => calls };
    };
    const busy = fail(["EPERM", "EBUSY"]);
    renameOver("a", "b", busy.rename);
    expect(busy.calls()).toBe(3);
    const other = fail(["ENOENT"]);
    expect(() => renameOver("a", "b", other.rename)).toThrow("ENOENT");
    expect(other.calls()).toBe(1);
    const stuck = fail(["EBUSY", "EBUSY", "EBUSY"]);
    expect(() => renameOver("a", "b", stuck.rename, 3)).toThrow("EBUSY");
    expect(stuck.calls()).toBe(3);
  });
});

describe("keys: saved > environment, and nothing from Gluon's source directory", () => {
  const saved = process.env.GLUON_CONFIG;
  afterAll(() => {
    if (saved === undefined) delete process.env.GLUON_CONFIG;
    else process.env.GLUON_CONFIG = saved;
    loadSecrets();
  });
  test("a dev key file is used only when handed in, and named as the source", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-keys-"));
    process.env.GLUON_CONFIG = join(dir, "config.yaml");
    loadSecrets();
    expect(secret("MOONSHOT_API_KEY")).toBeUndefined();
    const dev = join(dir, "dev.env");
    writeFileSync(dev, "MOONSHOT_API_KEY=sk-devdevdevdevdevdevdev\r\nEMPTY=\n");
    useSecrets(parseEnv(dev), dev);
    expect(secret("MOONSHOT_API_KEY")).toBe("sk-devdevdevdevdevdevdev");
    expect(secretSource("MOONSHOT_API_KEY")).toBe(dev);
    loadSecrets();
    expect(secret("MOONSHOT_API_KEY")).toBeUndefined();
  });
});

describe("saving keys (review of phase 3)", () => {
  const savedConfig = process.env.GLUON_CONFIG;
  afterAll(() => {
    if (savedConfig === undefined) delete process.env.GLUON_CONFIG;
    else process.env.GLUON_CONFIG = savedConfig;
    loadSecrets();
  });

  test("BUG-104: a rename that fails leaves the .env as it was and no copy of the keys anywhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-keys-"));
    process.env.GLUON_CONFIG = join(dir, "config.yaml");
    writeFileSync(join(dir, ".env"), "OLD_KEY=1\n");
    const busy = () => {
      throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    };
    expect(() => saveSecrets([["XAI_API_KEY", "xai-neverleftbehind000000"]], busy)).toThrow("EBUSY");
    expect(readdirSync(dir)).toEqual([".env"]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("OLD_KEY=1\n");
  });

  test("BUG-105: the key file is private before the key is in it (made inside a private directory), with a random name", () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-keys-"));
    process.env.GLUON_CONFIG = join(dir, "config.yaml");
    const seen: string[] = [];
    const warning = saveSecrets([["XAI_API_KEY", "xai-privatebeforewritten0"], ["GEMINI_API_KEY", "AIza-privatebeforewritten00000000000"]], (from, to) => {
      seen.push(from);
      // Where the keys are first written: a fresh private directory (0700; on Windows, icacls
      // when outside the profile), so the file inherits a tight ACL from its first byte.
      if (process.platform !== "win32") expect(statSync(dirname(from)).mode & 0o777).toBe(0o700);
      expect(isPrivate(from, homedir())).toBe(true);
      renameOver(from, to);
    });
    expect(warning).toBeUndefined();
    expect(dirname(seen[0]!)).not.toBe(dir);
    expect(basename(dirname(seen[0]!))).toMatch(/^\.gluon-\w{6}$/);
    expect(readdirSync(dir)).toEqual([".env"]);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("XAI_API_KEY=xai-privatebeforewritten0\nGEMINI_API_KEY=AIza-privatebeforewritten00000000000\n");
    expect(isPrivate(join(dir, ".env"), homedir())).toBe(true);
  });

  test("BUG-104: the setup saves the keys before the config; keys that can't be saved leave the config untouched and say so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gluon-keys-"));
    process.env.GLUON_CONFIG = join(dir, "config.yaml");
    writeFileSync(process.env.GLUON_CONFIG, "# mine\n");
    // The .env's place is taken by a directory: the rename fails.
    mkdirSync(join(dir, ".env"));
    const { SetupFlow } = await import("../src/auth.ts");
    const { makeTheme } = await import("../src/ui/theme.ts");
    const { defaults } = await import("../src/config.ts");
    const config = { ...defaults(), connections: {} };
    const flow = new SetupFlow(config, makeTheme(null), ["grok-build"]);
    flow.draft.connections["grok-build"] = { auth: "api", provider: "xai" };
    flow.draft.connected = ["grok-build"];
    flow.draft.secrets = { XAI_API_KEY: "xai-pastedkey4444444444444" };
    expect(() => flow.commit()).toThrow(/couldn't save the keys to .*Nothing was saved/);
    expect(readFileSync(process.env.GLUON_CONFIG, "utf8")).toBe("# mine\n");
    expect(config.connections).toEqual({});
    expect(readdirSync(dir).sort()).toEqual([".env", "config.yaml"]);
  });
});
