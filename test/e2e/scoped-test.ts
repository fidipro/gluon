/**
 * `bun:test` with every `test` / `it` body scoped to the apps it starts (`scoped` in harness.ts): when the body
 * ends, its apps and their agents end. `test/preload.ts` points the e2e test files at this module (they say
 * `from "bun:test"`); anything else of bun:test is re-exported as it is. A test that declares a parameter is
 * left alone as written, and so is any call that doesn't register a test (`skipIf(cond)`, `each(table)`).
 */
import * as real from "bun:test";
import { scoped } from "./harness.ts";

type Fn = (...args: any[]) => any;

/**
 * The same function, with a test body among its arguments scoped; what it returns (`skipIf(c)` → a test function) wrapped the same way.
 * `self` is what a method of `test` (`failing`, `skipIf`…) must be called on: Bun checks its `this`.
 */
function wrap<F extends Fn>(f: F, self?: unknown): F {
  return new Proxy(f, {
    apply(target, thisArg, args: unknown[]) {
      const at = typeof args[0] === "string" ? args.findIndex((a, i) => i > 0 && typeof a === "function") : -1;
      const out = Reflect.apply(target, self ?? thisArg, at < 0 ? args : args.map((a, i) => (i === at ? scoped(a as Fn) : a)));
      return typeof out === "function" ? wrap(out) : out;
    },
    get(target, key) {
      const v = Reflect.get(target, key);
      return typeof v === "function" && key !== "constructor" ? wrap(v as Fn, target) : v;
    },
  });
}

export * from "bun:test";
export const test = wrap(real.test);
export const it = wrap(real.it);
