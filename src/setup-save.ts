/**
 * What the setup writes when it finishes, all or nothing: the config is checked first (not valid
 * YAML: nothing is saved), then every key goes to the .env in one replace, then config.yaml in one
 * write. A failure before the config write leaves both files as they were and nothing changed in
 * memory. `SetupFlow.commit` (`src/auth.ts`) says what changed.
 */
import { homedir } from "node:os";
import { configDocument, ConfigError, saveConfig, type Config, type Connection, type Harness } from "./config.ts";
import { saveSecrets, secretsPath } from "./secrets.ts";

/** The setup's answers that are written. */
export interface SetupAnswers {
  connections: Partial<Record<Harness, Connection>>;
  /** Connected in this run, in order. */
  connected: Harness[];
  /** Connected before and unchecked, confirmed. */
  dropped: Harness[];
  bedrock: Config["bedrock"];
  /** Pasted keys: variable → key. */
  secrets: Record<string, string>;
}

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

/** Writes the answers and applies them to `config`; returns the private write's warning, if any. */
export function saveSetup(config: Config, d: SetupAnswers): string | undefined {
  const changes: [string[], unknown][] = [];
  const bedrock = JSON.stringify(d.bedrock) !== JSON.stringify(config.bedrock);
  if (bedrock) changes.push([["bedrock"], d.bedrock]);
  for (const h of d.dropped) changes.push([["connections", h], undefined]);
  for (const h of d.connected) changes.push([["connections", h], d.connections[h]]);
  if (changes.length) configDocument();
  const keys = Object.entries(d.secrets);
  let warning: string | undefined;
  try {
    if (keys.length) warning = saveSecrets(keys);
  } catch (e) {
    throw new ConfigError(`couldn't save the keys to ${tilde(secretsPath())}: ${(e as Error).message}. Nothing was saved`);
  }
  if (changes.length) saveConfig(changes);
  if (bedrock) config.bedrock = d.bedrock;
  for (const h of d.dropped) delete config.connections[h];
  for (const h of d.connected) config.connections[h] = d.connections[h];
  return warning;
}
