/**
 * Parses a minified JavaScript object literal (the shape a bundler emits: unquoted keys, `!0` and
 * `!1`, `1e6`, double-quoted strings, arrays, objects, `null`) into a plain value, without ever
 * evaluating it: the text comes from a vendor's binary and runs nowhere. Anything else (a call, a
 * reference, a template string, a comment) throws.
 */
export function parseJsLiteral(text: string): unknown {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`unsupported JavaScript literal at ${i}: ${what} (${JSON.stringify(text.slice(i, i + 24))})`);
  };
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  function string(): string {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (text[i] !== '"') fail("unterminated string");
    i++;
    // JSON's escapes are JavaScript's for what a catalog holds (\uXXXX, \n, \", \\).
    return JSON.parse(text.slice(start, i)) as string;
  }
  function value(): unknown {
    ws();
    const c = text[i]!;
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return string();
    if (text.startsWith("!0", i)) return (i += 2), true;
    if (text.startsWith("!1", i)) return (i += 2), false;
    if (text.startsWith("null", i)) return (i += 4), null;
    const num = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 32));
    if (num) return (i += num[0].length), Number(num[0]);
    return fail("value");
  }
  function array(): unknown[] {
    const out: unknown[] = [];
    i++;
    ws();
    while (text[i] !== "]") {
      out.push(value());
      ws();
      if (text[i] === ",") i++;
      else if (text[i] !== "]") fail("expected , or ]");
      ws();
    }
    i++;
    return out;
  }
  function object(): Record<string, unknown> {
    const out: Record<string, unknown> = Object.create(null);
    i++;
    ws();
    while (text[i] !== "}") {
      let key: string;
      if (text[i] === '"') key = string();
      else {
        const id = /^[A-Za-z_$][\w$]*|^\d+/.exec(text.slice(i, i + 64));
        if (!id) return fail("key");
        key = id![0];
        i += key.length;
      }
      ws();
      if (text[i] !== ":") fail("expected :");
      i++;
      out[key] = value();
      ws();
      if (text[i] === ",") i++;
      else if (text[i] !== "}") fail("expected , or }");
      ws();
    }
    i++;
    return out;
  }
  const v = value();
  ws();
  if (i !== text.length) fail("trailing text");
  return v;
}

/** The balanced `{…}` starting at `from` (string-aware): its text, or null when it never closes within `limit` characters. */
export function balancedObject(text: string, from: number, limit = 400_000): string | null {
  let depth = 0;
  for (let i = from; i < Math.min(text.length, from + limit); i++) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}
