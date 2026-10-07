import { Box, Text } from "ink";
import type { GluonPalette } from "./theme.ts";

/**
 * Gluon's mark in three text rows (`qa/gluon-design/gluon-logo.png`): a stem in from the left, a
 * junction a third of the way across, three branches (up-right and down-right at 45°, straight)
 * ending in dots, the middle dot a column further right, as in the logo. The diagonals are braille
 * dots (2×4 per cell, so they leave the junction at the logo's angle); the stem and the straight
 * branch are `─`, the dots `●`. Box diagonals (`╱`) were tried: they can't meet the stem, which
 * runs through the middle of its row, and right-angle boxes (`╭─`) lose the logo's diagonals.
 */
export const MARK = ["   ⡠●", "──⢎──●", "   ⠑●"] as const;

/** Columns the mark takes (the header's text starts after it and a gap). */
export const MARK_WIDTH = Math.max(...MARK.map((l) => Bun.stringWidth(l)));

export function Mark({ palette }: { palette: GluonPalette }) {
  return (
    <Box flexDirection="column" width={MARK_WIDTH} flexShrink={0}>
      {MARK.map((line, i) => (
        <Text key={i} color={palette.amber}>
          {line.padEnd(MARK_WIDTH)}
        </Text>
      ))}
    </Box>
  );
}
