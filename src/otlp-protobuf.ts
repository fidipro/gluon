/**
 * A minimal OTLP/HTTP protobuf decoder for LOGS (issue #39): Grok Build exports only
 * `http/protobuf`. No dependency; it turns an `ExportLogsServiceRequest` into the OTLP/JSON shape
 * the telemetry listener already reads (`resourceLogs[].scopeLogs[].logRecords[]`), nothing else:
 * time, severity, attributes (strings, bools, ints, doubles) and the record's event name (field 12,
 * which Grok sends instead of an `event.name` attribute; it is added as that attribute).
 * The bytes come from a process the agent started and are untrusted: depth, length and field counts
 * are bounded and a varint is at most 10 bytes; anything malformed throws (the listener answers 400).
 */

const MAX_FIELDS = 4096;
const MAX_ATTRIBUTES = 256;

interface Field {
  n: number;
  w: number;
  v: bigint | Uint8Array;
}

function varint(b: Uint8Array, i: number): [bigint, number] {
  let r = 0n;
  let shift = 0n;
  for (let k = 0; k < 10; k++) {
    const x = b[i++];
    if (x === undefined) throw new Error("truncated varint");
    r |= BigInt(x & 0x7f) << shift;
    if (!(x & 0x80)) return [BigInt.asUintN(64, r), i];
    shift += 7n;
  }
  throw new Error("varint too long");
}

function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    if (out.length >= MAX_FIELDS) throw new Error("too many fields");
    const [tag, j] = varint(b, i);
    i = j;
    const n = Number(tag >> 3n);
    const w = Number(tag & 7n);
    if (n === 0) throw new Error("field number 0");
    if (w === 0) {
      const [v, k] = varint(b, i);
      i = k;
      out.push({ n, w, v });
    } else if (w === 1) {
      if (i + 8 > b.length) throw new Error("truncated fixed64");
      out.push({ n, w, v: new DataView(b.buffer, b.byteOffset + i, 8).getBigUint64(0, true) });
      i += 8;
    } else if (w === 5) {
      if (i + 4 > b.length) throw new Error("truncated fixed32");
      out.push({ n, w, v: BigInt(new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0, true)) });
      i += 4;
    } else if (w === 2) {
      const [len, k] = varint(b, i);
      i = k;
      if (len > BigInt(b.length - i)) throw new Error("truncated length-delimited field");
      const L = Number(len);
      out.push({ n, w, v: b.subarray(i, i + L) });
      i += L;
    } else throw new Error(`unsupported wire type ${w}`);
  }
  return out;
}

const td = new TextDecoder("utf-8", { fatal: false });
const bytes = (f: Field | undefined): Uint8Array => (f && f.v instanceof Uint8Array ? f.v : new Uint8Array());
const all = (fs: Field[], n: number) => fs.filter((f) => f.n === n && f.v instanceof Uint8Array).map((f) => f.v as Uint8Array);
const first = (fs: Field[], n: number) => fs.find((f) => f.n === n);
const text = (f: Field | undefined) => td.decode(bytes(f));

/** An AnyValue as OTLP/JSON writes it (int64 as a string); arrays and key-value lists are dropped. */
function anyValue(b: Uint8Array): Record<string, unknown> | undefined {
  const f = fields(b)[0];
  if (!f) return undefined;
  switch (f.n) {
    case 1:
      return { stringValue: text(f) };
    case 2:
      return { boolValue: f.v !== 0n };
    case 3:
      return { intValue: String(BigInt.asIntN(64, f.v as bigint)) };
    case 4:
      return { doubleValue: new DataView(new BigUint64Array([f.v as bigint]).buffer).getFloat64(0, true) };
    default:
      return undefined;
  }
}

function attributes(list: Uint8Array[]): { key: string; value: Record<string, unknown> }[] {
  if (list.length > MAX_ATTRIBUTES) throw new Error("too many attributes");
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const kv of list) {
    const f = fields(kv);
    const value = anyValue(bytes(first(f, 2)));
    if (value) out.push({ key: text(first(f, 1)), value });
  }
  return out;
}

/** The OTLP/JSON `ExportLogsServiceRequest` of a protobuf body; throws on anything malformed. */
export function decodeLogs(body: Uint8Array): { resourceLogs: object[] } {
  const resourceLogs: object[] = [];
  for (const rl of all(fields(body), 1)) {
    const rf = fields(rl);
    const scopeLogs: object[] = [];
    for (const sl of all(rf, 2)) {
      const logRecords: object[] = [];
      for (const lr of all(fields(sl), 2)) {
        const lf = fields(lr);
        const attrs = attributes(all(lf, 6));
        // Grok names the event in field 12 (no `event.name` attribute): the shape the listener reads.
        const name = first(lf, 12) ? text(first(lf, 12)) : "";
        if (name && !attrs.some((a) => a.key === "event.name")) attrs.push({ key: "event.name", value: { stringValue: name } });
        logRecords.push({ timeUnixNano: String(first(lf, 1)?.v ?? "0"), observedTimeUnixNano: String(first(lf, 11)?.v ?? "0"), attributes: attrs });
      }
      scopeLogs.push({ logRecords });
    }
    resourceLogs.push({ scopeLogs });
  }
  return { resourceLogs };
}
