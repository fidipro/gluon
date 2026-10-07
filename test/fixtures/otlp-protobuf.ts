/**
 * Test helper: encodes OTLP logs as protobuf (the other direction of `src/otlp-protobuf.ts`), so a
 * real harness capture kept as decoded JSON (`test/fixtures/telemetry/grok-*.decoded.json`, whose raw
 * bytes were not kept) can be replayed through the listener as the bytes it sent.
 */
const enc = new TextEncoder();
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) (out.set(p, i), (i += p.length));
  return out;
};
export function varint(n: bigint | number): Uint8Array {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Uint8Array.from(out);
}
const tag = (n: number, w: number) => varint((n << 3) | w);
export const lenField = (n: number, body: Uint8Array) => concat([tag(n, 2), varint(body.length), body]);
const strField = (n: number, s: string) => lenField(n, enc.encode(s));
const fixed64 = (n: number, v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return concat([tag(n, 1), b]);
};
function anyValue(v: string | number | boolean): Uint8Array {
  if (typeof v === "string") return strField(1, v);
  if (typeof v === "boolean") return concat([tag(2, 0), varint(v ? 1 : 0)]);
  return concat([tag(3, 0), varint(v)]);
}
export interface LogRecord {
  eventName?: string;
  time?: bigint;
  attributes: Record<string, string | number | boolean>;
}
export function encodeLogs(records: LogRecord[]): Uint8Array {
  const recs = records.map((r) =>
    lenField(
      2,
      concat([
        fixed64(1, r.time ?? 0n),
        ...Object.entries(r.attributes).map(([k, v]) => lenField(6, concat([strField(1, k), lenField(2, anyValue(v))]))),
        ...(r.eventName ? [strField(12, r.eventName)] : []),
      ]),
    ),
  );
  return lenField(1, lenField(2, concat(recs)));
}

/** A decoded capture (`{eventName, attributes: {k: "str" | {int: "n"} | bool}}[]`) as records: the spike's decoder wrote ints as `{int}`, strings that were ints as numbers' text. */
export function fromDecoded(decoded: { eventName?: string; attributes: Record<string, unknown> }[], t0 = 1_000n): LogRecord[] {
  return decoded.map((r, i) => ({
    ...(r.eventName ? { eventName: r.eventName } : {}),
    time: t0 + BigInt(i) * 1_000_000n,
    attributes: Object.fromEntries(Object.entries(r.attributes).map(([k, v]) => [k, typeof v === "object" && v !== null && "int" in v ? Number((v as { int: string }).int) : (v as string | number | boolean)])),
  }));
}
