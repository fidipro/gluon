/**
 * A seeded mutation fuzz of the OTLP protobuf decoder (`src/otlp-protobuf.ts`), whose bytes come from a
 * process the agent started and are untrusted (issue #39). It starts from the canonical bodies (the real
 * captured Grok 1.0.46 body, `test/fixtures/otlp-protobuf.ts`'s encodings, and the other Grok captures
 * re-encoded) and bends them: bit flips, truncation, length-field inflation, varint overflow, deep nesting.
 * The PRNG is fixed, so a failure reproduces from its seed and iteration; the whole run stays under 2 s.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeLogs } from "../src/otlp-protobuf.ts";
import { encodeLogs, fromDecoded, lenField, varint } from "./fixtures/otlp-protobuf.ts";

const DIR = join(import.meta.dir, "fixtures", "telemetry");
const decoded = (name: string) => Object.values(JSON.parse(readFileSync(join(DIR, name), "utf8")) as Record<string, { eventName?: string; attributes: Record<string, unknown> }[]>).flat();

const corpus: { name: string; body: Uint8Array }[] = [
  { name: "canon", body: new Uint8Array(readFileSync(join(DIR, "grok-1.0.46-canon-logs.bin"))) },
  { name: "subagent", body: encodeLogs(fromDecoded(decoded("grok-1.0.46-subagent.decoded.json"))) },
  { name: "compaction", body: encodeLogs(fromDecoded(decoded("grok-1.0.46-tui-300k-compaction.decoded.json"))) },
  { name: "tiny", body: encodeLogs([{ eventName: "e.one", attributes: { a: "x", b: 7, c: true } }, { attributes: { "event.name": "e.two" } }]) },
];

/** mulberry32: a small deterministic PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where every length prefix of a (well-formed) body sits, down to `depth` levels of nesting. */
function lengthPrefixes(b: Uint8Array, base = 0, depth = 4): { at: number; size: number; len: number }[] {
  const out: { at: number; size: number; len: number }[] = [];
  const read = (i: number): [number, number] | null => {
    let r = 0;
    for (let k = 0, shift = 0; k < 5; k++, shift += 7) {
      const x = b[i + k];
      if (x === undefined) return null;
      r += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) return [r, k + 1];
    }
    return null;
  };
  for (let i = 0; i < b.length; ) {
    const tag = read(i);
    if (!tag) break;
    i += tag[1];
    const w = tag[0] & 7;
    if (w === 0) {
      const v = read(i);
      if (!v) break;
      i += v[1];
    } else if (w === 1) i += 8;
    else if (w === 5) i += 4;
    else if (w === 2) {
      const len = read(i);
      if (!len || i + len[1] + len[0] > b.length) break;
      out.push({ at: base + i, size: len[1], len: len[0] });
      if (depth > 0) out.push(...lengthPrefixes(b.subarray(i + len[1], i + len[1] + len[0]), base + i + len[1], depth - 1));
      i += len[1] + len[0];
    } else break;
  }
  return out;
}

const splice = (b: Uint8Array, at: number, remove: number, insert: ArrayLike<number>) => {
  remove = Math.min(remove, b.length - at);
  const out = new Uint8Array(b.length - remove + insert.length);
  out.set(b.subarray(0, at), 0);
  out.set(insert, at);
  out.set(b.subarray(at + remove), at + insert.length);
  return out;
};

type Mutation = (b: Uint8Array, rnd: () => number) => Uint8Array;
const pick = (rnd: () => number, n: number) => Math.floor(rnd() * n);

const MUTATIONS: Record<string, Mutation> = {
  // A few bits or whole bytes changed at random places.
  flip: (b, rnd) => {
    const out = b.slice();
    for (let k = 1 + pick(rnd, 8); k > 0 && out.length; k--) {
      const i = pick(rnd, out.length);
      out[i] = rnd() < 0.5 ? out[i]! ^ (1 << pick(rnd, 8)) : pick(rnd, 256);
    }
    return out;
  },
  // Cut anywhere, the empty body included.
  truncate: (b, rnd) => b.slice(0, pick(rnd, b.length + 1)),
  // A length prefix made larger than the bytes there are (by a little, by a lot, to 2^32 and past).
  inflate: (b, rnd) => {
    const at = lengthPrefixes(b);
    if (!at.length) return b;
    const p = at[pick(rnd, at.length)]!;
    const len = [p.len + 1 + pick(rnd, 64), p.len * 2 + 1, 2 ** 31, 2 ** 32 + 5, 2 ** 53][pick(rnd, 5)]!;
    return splice(b, p.at, p.size, varint(BigInt(len)));
  },
  // A varint that never ends, or ends after more than 10 bytes, or is all ones.
  varintOverflow: (b, rnd) => {
    const run = new Uint8Array(9 + pick(rnd, 40)).fill(rnd() < 0.5 ? 0xff : 0x80);
    return splice(b, pick(rnd, b.length + 1), pick(rnd, 3), rnd() < 0.5 ? run : Uint8Array.from([...run, 0x01]));
  },
  // The body wrapped in layers of length-delimited fields, or junk nested that deep.
  nest: (b, rnd) => {
    let out = rnd() < 0.5 ? b : Uint8Array.from({ length: 1 + pick(rnd, 16) }, () => pick(rnd, 256));
    for (let k = 10 + pick(rnd, 1500); k > 0; k--) out = lenField(1 + pick(rnd, 2), out);
    return out;
  },
  // The same field over and over: past the field and attribute limits.
  repeat: (b, rnd) => {
    const part = b.subarray(0, 2 + pick(rnd, Math.min(40, b.length)));
    const out = new Uint8Array(part.length * (1000 + pick(rnd, 6000)));
    for (let i = 0; i < out.length; i += part.length) out.set(part, i);
    return out;
  },
};

interface Decoded {
  resourceLogs: { scopeLogs: { logRecords: { attributes: unknown[] }[] }[] }[];
}

/**
 * CPU time of this process in ms, not wall time: a budget on "how fast is the decoder" must not fail
 * because another test process took the core (the unit shards run side by side). Even CPU time swells on a
 * loaded machine (shared caches, the runtime's GC and JIT threads: 2 to 4 times), so a run over budget is
 * repeated and the best counts: a decoder that is really too slow is slow every time. `GLUON_TEST_SLOW`
 * (CI: 2) widens the budgets for a slower machine, as the e2e harness does.
 */
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const BUDGET = Number(process.env.GLUON_TEST_SLOW) || 1;

/** One decode: an error of the decoder's own (a plain `Error` with its message), or a bounded JSON-able result; within the time budget. */
function check(body: Uint8Array, label: string) {
  const t0 = cpuMs();
  let result: Decoded | undefined;
  try {
    result = decodeLogs(body) as Decoded;
  } catch (e) {
    // Never a TypeError / RangeError / out-of-memory of the runtime's own: only what the decoder throws on purpose.
    expect([label, (e as Error)?.constructor === Error, (e as Error).message]).toEqual([label, true, expect.stringMatching(/^(truncated|varint|field number 0|too many|unsupported wire type)/)]);
  }
  let ms = cpuMs() - t0;
  // Over budget: the same decode again, four times at most; the fastest counts.
  for (let again = 0; again < 4 && ms >= 100 * BUDGET; again++) {
    const t1 = cpuMs();
    try {
      decodeLogs(body);
    } catch {}
    ms = Math.min(ms, cpuMs() - t1);
  }
  expect([label, ms < 100 * BUDGET]).toEqual([label, true]);
  if (!result) return;
  // Within its limits: no more records than bytes, attributes capped (256 plus the event name), and plain data.
  let records = 0;
  for (const rl of result.resourceLogs)
    for (const sl of rl.scopeLogs)
      for (const lr of sl.logRecords) {
        records++;
        expect(lr.attributes.length).toBeLessThanOrEqual(257);
      }
  expect(records).toBeLessThanOrEqual(body.length);
  JSON.stringify(result);
}

describe("BUG-343/protobuf-fuzz: the OTLP protobuf decoder survives seeded mutations of real bodies", () => {
  test("the corpus decodes unmodified", () => {
    for (const { name, body } of corpus) expect([name, decodeLogs(body).resourceLogs.length > 0]).toEqual([name, true]);
  });

  test("bit flips, truncation, length inflation, varint overflow, deep nesting and repetition: only the decoder's own errors or a bounded result, each decode fast; the whole run under 2 s of CPU @full", () => {
    const names = Object.keys(MUTATIONS);
    const fuzz = () => {
      const start = cpuMs();
      let decodedOk = 0;
      let failed = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const rnd = prng(seed);
        for (let i = 0; i < 160; i++) {
          const from = corpus[pick(rnd, corpus.length)]!;
          const mutation = names[pick(rnd, names.length)]!;
          // A second mutation on some: damage on damage.
          let body = MUTATIONS[mutation]!(from.body, rnd);
          let label = `seed ${seed} #${i} ${from.name}/${mutation}`;
          if (rnd() < 0.3) {
            const again = names[pick(rnd, names.length)]!;
            if (again !== "repeat" && again !== "nest") (body = MUTATIONS[again]!(body, rnd)), (label += `+${again}`);
          }
          try {
            decodeLogs(body);
            decodedOk++;
          } catch {
            failed++;
          }
          check(body, label);
        }
      }
      return { decodedOk, failed, ms: cpuMs() - start };
    };
    let run = fuzz();
    for (let again = 0; again < 3 && run.ms >= 2000 * BUDGET; again++) {
      const next = fuzz();
      if (next.ms < run.ms) run = next;
    }
    // Both outcomes occur: the fuzz neither always breaks the body nor never does.
    expect(run.decodedOk).toBeGreaterThan(50);
    expect(run.failed).toBeGreaterThan(50);
    expect(run.ms).toBeLessThan(2000 * BUDGET);
  }, 90_000); // bun's 5 s default is wall time; the budget above is CPU time, the run up to four times

  test("the limits hold at their edges: a varint of 10 bytes reads, 11 does not; a length past the end (also 2^64-1) and field number 0 throw; 4097 fields and 257 attributes are refused", () => {
    const ten = Uint8Array.from([0x08, ...Array(9).fill(0xff), 0x01]);
    expect(() => decodeLogs(ten)).not.toThrow();
    expect(() => decodeLogs(Uint8Array.from([0x08, ...Array(10).fill(0xff), 0x01]))).toThrow(/varint too long/);
    expect(() => decodeLogs(Uint8Array.from([0x0a, 0x02, 0x00]))).toThrow(/truncated/);
    expect(() => decodeLogs(Uint8Array.from([0x0a, ...Array(9).fill(0xff), 0x01, 0x00]))).toThrow(/truncated/);
    expect(() => decodeLogs(Uint8Array.from([0x00, 0x01]))).toThrow(/field number 0/);
    expect(() => decodeLogs(new Uint8Array(4097 * 2).map((_, i) => (i % 2 === 0 ? 0x08 : 0x01)))).toThrow(/too many fields/);
    expect(() => decodeLogs(encodeLogs([{ eventName: "x", attributes: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, i])) }]))).toThrow(/too many attributes/);
  });
});
