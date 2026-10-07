/**
 * Width-preserving masks for what differs from run to run although nothing is wrong: each matched
 * character becomes `#` in place (its cell keeps its style, so colours and layout are still
 * checked). One exception, `width`: a session's age in the info line is `now` or `1m`, and the
 * rest of the line moves with it; that mask writes a fixed-width `###` and moves the rest back. The scenes wait for idle states first (a session's `awaiting your input`, the
 * intake agent done): mask only what no wait can pin down.
 */
import { tmpdir } from "node:os";
import type { Cell, Frame } from "./frame.ts";

export interface Mask {
  name: string;
  /** Matched against each row's text (one character per column: a wide one's right half is ""). The masked part: group 1 if any, else the whole match. */
  pattern: RegExp;
  /** The masked part becomes exactly this many `#` cells, the rest of the row moved to follow (padded or cut at its end). */
  width?: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Every temp dir a run can show: the run's own (`test/preload.ts`), the real one, the OS default. */
const TEMP_ROOTS = [...new Set([tmpdir(), process.env.GLUON_TEST_REAL_TMP ?? "", "/tmp"].filter(Boolean))].map(esc).join("|");

export const MASKS: Mask[] = [
  // `Gluon v1.0.0` in the home header: the package's version.
  { name: "version", pattern: /Gluon v(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/g },
  // The intake agent's working line: `◆  Working (12s · esc to interrupt)`; ◆/◇ blink every 500 ms.
  { name: "spinner", pattern: /([◆◇])(?=\s+\S.*\(\d)/g },
  { name: "elapsed", pattern: /\((\d+(?:[smh] ?\d*)*s?) · esc to interrupt/g },
  // A session's age: the info line's `· now ·` / `· 3m ·`, the home list's time column (last on the row).
  { name: "age", pattern: / · ((?:now|\d+[mhd]))(?= · |$)/g, width: 3 },
  // Right-aligned in three cells: `now`, ` 1m`, `12m`; after `—`, a cost, or an activity that took the empty cells (BUG-265).
  { name: "ageColumn", pattern: /(?:—|\$[\d.#]+|\S {2})\s*((?:now| \d[mhd]|\d\d[mhd]))\s*$/g },
  // Cost figures (`$0.50`, `~$1.23`).
  { name: "dollars", pattern: /~?\$(\d+\.\d{2})/g },
  // Temp paths: the run's dirs (mkdtemp suffixes differ every run).
  { name: "tempPath", pattern: new RegExp(`((?:${TEMP_ROOTS})/[^\\s│'"<>]*)`, "g") },
  // A temp path the screen wrapped (the worktree command an agent is told): the part on a later row has no temp root left
  // for `tempPath`, but still ends in the repo's fixed `/tiny/.gluon/` (its random dir names are what differ).
  { name: "wrappedTempPath", pattern: /([\w.-]+(?:\/[\w.-]+)*)(?=\/tiny\/\.gluon\/)/g },
  // The OpenTelemetry receiver an agent is given (`telemetry.ts`): its port, and its token, which
  // the agent's printed argv may wrap across rows (the head after `="`, the tail before `"}}}`).
  { name: "otelPort", pattern: /127\.0\.0\.1:(\d+)/g },
  { name: "otelTokenHead", pattern: /="([0-9a-f]{2,})(?=$|\s|│|")/g },
  { name: "otelTokenTail", pattern: /^│?([0-9a-f]+)(?="\}\}\})/g },
  // Process ids, wherever a line names one.
  { name: "pid", pattern: /\bpid[ =:](\d+)/gi },
  // A saved workspace's id (`gluon resume <id>`): random per run; in the home header.
  { name: "workspace", pattern: /workspace ([a-z2-7]{1,6})/g },
  // The repo line of the home header: `tiny · main · clean` (the branch).
  { name: "branch", pattern: /^\s+──⢎──●\s+\S+ · ([\w./-]+)/g },
];

/** The row's text with one string per column, for matching: UTF-16 indexes mapped to columns (a wide character's right half adds nothing). */
function columnText(row: readonly Cell[]): { text: string; col: number[] } {
  let text = "";
  const col: number[] = [];
  row.forEach((c, x) => {
    for (let i = 0; i < c.ch.length; i++) col.push(x);
    text += c.ch;
  });
  col.push(row.length);
  return { text, col };
}

/** Applies `masks` to a copy of the frame: matched characters become `#`, styles kept. */
export function mask(f: Frame, masks: readonly Mask[] = MASKS): Frame {
  const cells = f.cells.map((row) => row.map((c) => ({ ...c })));
  cells.forEach((row, y) => {
    for (const m of masks) {
      const { text, col } = columnText(row);
      // Right to left: a `width` mask moves what follows its match, not what precedes it.
      for (const hit of [...text.matchAll(m.pattern)].reverse()) {
        const part = hit[1] ?? hit[0];
        const at = hit.index! + (hit[1] === undefined ? 0 : hit[0].indexOf(part));
        const from = col[at]!;
        const to = col[at + part.length] ?? row.length;
        if (m.width !== undefined) {
          const filler = Array.from({ length: m.width }, () => ({ ...row[from]!, ch: "#", w: 1 }));
          const moved = [...row.slice(0, from), ...filler, ...row.slice(to)];
          while (moved.length < row.length) moved.push({ ...moved.at(-1)!, ch: " ", w: 1 });
          row = cells[y] = moved.slice(0, row.length);
          continue;
        }
        for (let x = from; x < to; x++) if (row[x]!.w !== 0) row[x]!.ch = "#".repeat(row[x]!.w === 2 ? 2 : 1);
      }
    }
  });
  return { ...f, cells };
}
