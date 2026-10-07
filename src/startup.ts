/**
 * Imported first by cli.tsx, before any module that could spawn. On Windows a bare name is looked
 * up in the current directory (the user's repository) before PATH unless this is set — for Bun's
 * own lookups and for every process Gluon starts (BUG-102). Gluon spawns by absolute path
 * anyway (`binPath`, `windowsTool`); this closes the door for anything that doesn't.
 */
if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";

// The channel back from a launched agent (`CHANNEL_ENV`, events.ts; named here so this module
// imports nothing) belongs to the Gluon that launched it: a Gluon started inside the agent
// never passes it on to what it launches.
for (const name of ["GLUON_EVENTS", "GLUON_HANDOFF", "GLUON_SELF"]) delete process.env[name];
