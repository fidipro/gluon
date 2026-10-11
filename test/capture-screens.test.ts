/** The pure parts of the screen capture (scripts/capture-screens.ts): the fixtures' key names as bytes, the states it takes. */
import { describe, expect, test } from "bun:test";
import { capturable, keyBytes } from "../scripts/capture-screens.ts";
import { loadFixtures } from "./fixtures/screens.ts";

describe("the screen capture", () => {
  test("every key name the fixtures use has its terminal bytes; a character is itself; an unknown name throws", () => {
    const names = new Set(loadFixtures().flatMap((f) => f.states.flatMap((s) => s.keys)));
    expect([...names].filter((k) => { try { keyBytes(k); return false; } catch { return true; } })).toEqual([]);
    expect(["a", "/", " ", "tab", "down", "esc", "enter", "shift-tab"].map(keyBytes)).toEqual(["a", "/", " ", "\t", "\x1b[B", "\x1b", "\r", "\x1b[Z"]);
    expect(() => keyBytes("ctrl-q")).toThrow(/unknown key/);
  });

  test("it takes the states recorded from the harness alone; ones inside Gluon's frame (`size`) or kept from another version (`version`) stay", () => {
    const f = { harness: "codex", version: "1", cols: 100, rows: 30, notes: "", states: [{ name: "idle" }, { name: "frame-x", size: { cols: 98, rows: 24 } }, { name: "old", version: "0.9" }] } as never;
    expect(capturable(f).map((s) => s.name)).toEqual(["idle"]);
  });
});
