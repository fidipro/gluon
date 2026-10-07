import { expect, test } from "bun:test";
import { renderToString } from "ink";
import { loadConfig } from "../src/config.ts";
import { ChatItem, QuestionBlock } from "../src/ui/chat.tsx";
import { makeTheme } from "../src/ui/theme.ts";
import { Width } from "../src/ui/width.tsx";

const theme = makeTheme(null);
const palette = theme.gluon;
const config = loadConfig();

test("assistant text with inline code never overflows the terminal width", () => {
  const text =
    "Clear picture. `pkg` is already imported, the `parseArgs` options block just needs a `version` entry, and a handler similar to `--help`. Small, well-scoped edit.";
  for (const columns of [60, 80, 110]) {
    const out = renderToString(
      <Width columns={columns}>
        <ChatItem item={{ id: 1, kind: "assistant", text }} palette={palette} theme={theme} config={config} />
      </Width>,
      { columns },
    );
    for (const line of out.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
    // Wrapped lines hang under the text, after the ◆.
    for (const line of out.split("\n").slice(1)) expect(Bun.stripANSI(line)).toMatch(/^ {4}\S/);
  }
});

test("question options with long labels stay inside the terminal", () => {
  const question = {
    question: "Where should the demo YAML live?",
    options: [
      { label: "Same config file (~/.config/gluon/config.yaml)", description: "Add a `demo` key to the existing config" },
      { label: "In-repo file (e.g. demo/script.yaml in the gluon repo)", description: "Checked-in alongside the source" },
    ],
  };
  for (const columns of [50, 90, 140]) {
    const out = renderToString(
      <Width columns={columns}>
        <QuestionBlock question={question} selected={0} palette={palette} theme={theme} />
      </Width>,
      { columns },
    );
    for (const line of out.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
  }
});

test("git tool calls show in the chat's tool line (issue #17)", () => {
  const rows = [
    { kind: "read" as const, text: "src/math.ts" },
    { kind: "git" as const, text: "log src/math.ts" },
    { kind: "git" as const, text: "diff HEAD~1" },
  ];
  const out = Bun.stripANSI(renderToString(<Width columns={80}><ChatItem item={{ id: 1, kind: "explored", rows }} palette={palette} theme={theme} config={config} /></Width>, { columns: 80 }));
  expect(out).toContain("◇  Read src/math.ts · ran 2 git commands");
});
