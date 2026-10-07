/** A zip writer for tests (the export Kimi Code's `kimi export` makes): deflated entries, or stored ones named in `stored`. */
import { deflateRawSync } from "node:zlib";

export function makeZip(files: Record<string, string>, stored: string[] = []): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const le = (n: number, bytes: number) => {
    const b = Buffer.alloc(bytes);
    b.writeUIntLE(n, 0, bytes);
    return b;
  };
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const method = stored.includes(name) ? 0 : 8;
    const data = method === 0 ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const crc = Bun.hash.crc32(raw) >>> 0;
    const common = Buffer.concat([le(20, 2), le(0, 2), le(method, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(data.length, 4), le(raw.length, 4), le(nameBytes.length, 2), le(0, 2)]);
    const local = Buffer.concat([le(0x04034b50, 4), common, nameBytes, data]);
    central.push(Buffer.concat([le(0x02014b50, 4), le(20, 2), common, le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(offset, 4), nameBytes]));
    parts.push(local);
    offset += local.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.concat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(central.length, 2), le(central.length, 2), le(dir.length, 4), le(offset, 4), le(0, 2)]);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

/** One `usage.record` line as Kimi Code 2.1.1 writes it (captured on a mock turn; the numbers are the request's own). */
export const usageLine = (u: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number }, o: { agentId?: string; model?: string; usageScope?: string } = {}): string =>
  JSON.stringify({ type: "usage.record", agentId: o.agentId ?? "main", model: o.model ?? "__kimi_env_model__", usage: u, usageScope: o.usageScope ?? "turn", time: 1791260583471 });
