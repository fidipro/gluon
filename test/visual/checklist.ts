/**
 * What a reviewer checks on each contact sheet of the visual suite (`GLUON_REVIEW=1 bun run
 * test:visual` prints it after the sheets' paths): what the lints (`lint.ts`) can't judge.
 */
export const CHECKS: { name: string; ask: string }[] = [
  { name: "alignment", ask: "Columns line up across rows (the list's ctx · cost · time, the key list, option labels); margins equal left and right; nothing off by one cell next to wide characters." },
  { name: "truncation", ask: "What is cut ends in …, cuts the least important part first (activity before name, name before nothing), and nothing is cut while blank room sits next to it." },
  { name: "colours / contrast", ask: "Every text readable in both themes; the amber accent marks one thing at a time; status colours (amber awaiting, blue working, green done) agree between the list, the tabs and the info line." },
  { name: "overlap", ask: "No row drawn over another: the chat, the spec box, the options and the composer each in their own rows; the question bar never over the frame." },
  { name: "borders", ask: "Every box and rule whole at every size: corners, sides, titles and footers (↑ n · esc back, … n more lines) inside the border." },
  { name: "cursor", ask: "The cursor is where the user types (the composer or the agent's input), hidden while a question waits, never on the chrome." },
  { name: "focus", ask: "Exactly one thing looks selected: one highlighted list row or one option, one underlined tab, matching the info line." },
  { name: "empty states", ask: "A first run, no sessions, a collapsed group, a session with no output yet: each says what to do next, with no stray blank block." },
  { name: "hint accuracy", ask: "Every hint names keys that do what it says in that state (enter opens / sends / answers, ←/→ or the ctrl+\\ menu, y/n on questions, tab model only when there is one)." },
];

export const CHECKLIST = ["Visual review checklist (each sheet, both themes, smallest to largest):", ...CHECKS.map((c, i) => `  ${i + 1}. ${c.name}: ${c.ask}`)].join("\n");
