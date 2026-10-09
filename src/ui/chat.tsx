/**
 * The intake chat in Gluon's home view, drawn the way agent CLIs draw a transcript (brief
 * 5.2): `›` user lines on a full-width bar, `◇` tool activity, `◆` assistant text with no name
 * label, numbered options with `❯` on a full-width bar. No cards, no speaker labels.
 */
import { Box, Text, useAnimation, type DOMElement } from "ink";
import type { MutableRefObject } from "react";
import { cycleEffort, cycleModel, type AgentTriple } from "../agent/choices.ts";
import type { Item, Pending, ShownProposal, State } from "../agent/session.ts";
import type { Question } from "../agent/tools.ts";
import type { AgentOption, Config } from "../config.ts";
import { permissionLevels, type Mode } from "../harnesses.ts";
import { composerRows, elapsed } from "./bottom.tsx";
import type { Draft } from "./editor.ts";
import { summarizeExplored, truncate, tripleSegs, type Seg } from "./layout.ts";
import { inline, Markdown, markdownRows } from "./markdown.tsx";
import { paint, type GluonPalette, type Theme } from "./theme.ts";
import { Indent, TextColor, useWidth, Width, wrap, Wrapped } from "./width.tsx";

/** Columns before chat text: ` ◆  ` (the glyph in column 1, text from column 4, as the list's names). */
export const CHAT_INDENT = 4;

export const FIRST_LINE = "What are we building? I'll ask a few questions first, then start a session with the right harness, model and effort.";

/** A glyph in column 1 and `children` hanging from column 4. */
function Glyph({ glyph, color, bold, children }: { glyph: string; color: string; bold?: boolean; children: React.ReactNode }) {
  return (
    <Box flexShrink={0}>
      <Box width={CHAT_INDENT} flexShrink={0}>
        <Text color={color} bold={bold}>
          {` ${glyph}`}
        </Text>
      </Box>
      <Box flexDirection="column" flexShrink={1} flexGrow={1}>
        <Indent by={CHAT_INDENT}>{children}</Indent>
      </Box>
    </Box>
  );
}

// Codex: history_cell/messages.rs — the user's message on a full-width bar (here `bar`, one row, no padding rows).
export function UserLine({ text, palette }: { text: string; palette: GluonPalette }) {
  return (
    <Box width="100%" backgroundColor={palette.bar} flexShrink={0}>
      <Glyph glyph="›" color={palette.blue}>
        <Wrapped text={text} color={palette.bright} />
      </Glyph>
    </Box>
  );
}

// Codex: exec_cell/render.rs — one exploration group, summarised on one dim line.
export function ToolLine({ rows, palette }: { rows: Extract<Item, { kind: "explored" }>["rows"]; palette: GluonPalette }) {
  const width = useWidth() - CHAT_INDENT;
  return (
    <Glyph glyph="◇" color={palette.dim}>
      <Text color={palette.dim}>{truncate(summarizeExplored(rows), width)}</Text>
    </Glyph>
  );
}

// Codex: history_cell/messages.rs — assistant: a glyph, then markdown with a hanging indent.
export function AssistantLine({ text, palette, theme }: { text: string; palette: GluonPalette; theme: Theme }) {
  return (
    <Glyph glyph="◆" color={palette.amber}>
      <TextColor color={palette.text}>
        <Markdown text={text} theme={theme} />
      </TextColor>
    </Glyph>
  );
}

export function NoticeLine({ text, tone, palette, theme }: { text: string; tone: "error" | "info"; palette: GluonPalette; theme: Theme }) {
  return tone === "error" ? (
    <Glyph glyph="!" color={palette.amber} bold>
      <Wrapped text={inline(text, theme)} color={palette.amber} />
    </Glyph>
  ) : (
    <Glyph glyph="◇" color={palette.dim}>
      <Wrapped text={inline(text, theme)} color={palette.dim} />
    </Glyph>
  );
}

/** `<reason> I'd start it with:` */
export const proposalLead = (reason: string) => `${reason.trim() ? `${reason.trim()} ` : ""}I'd start it with:`;

/** A proposal the developer answered by typing: the lead and the recommended agent, on one line. */
function PastProposal({ item, palette, theme, config }: { item: Extract<Item, { kind: "proposal" }>; palette: GluonPalette; theme: Theme; config?: Pick<Config, "models"> }) {
  const main = item.choices[0];
  const agent = main ? tripleSegs({ ...main, mode: item.mode }, config).map((s) => paint(palette[s.role], s.text)).join("") : "";
  return (
    <Glyph glyph="◆" color={palette.amber}>
      <Wrapped text={`${paint(palette.text, inline(proposalLead(item.reason), theme))} ${agent}`} />
    </Glyph>
  );
}

/** One history item. `null`: drawn elsewhere (the open proposal is the choice list). */
export function ChatItem({ item, palette, theme, config }: { item: Item; palette: GluonPalette; theme: Theme; config?: Pick<Config, "models"> }) {
  switch (item.kind) {
    case "user":
      return <UserLine text={item.text} palette={palette} />;
    case "assistant":
      return <AssistantLine text={item.text} palette={palette} theme={theme} />;
    case "explored":
      return <ToolLine rows={item.rows} palette={palette} />;
    case "question":
      return <AssistantLine text={item.question} palette={palette} theme={theme} />;
    case "proposal":
      return <PastProposal item={item} palette={palette} theme={theme} config={config} />;
    case "notice":
      return <NoticeLine text={item.text} tone={item.tone} palette={palette} theme={theme} />;
  }
}

/** One numbered option: its text as segments, and a dim note after it. */
export interface OptionView {
  segs: Seg[];
  note?: string;
}

const OPTIONS_INDENT = 3;

// Codex: bottom_pane/list_selection_view.rs — `› N. label`, here `❯` on a full-width `selected` bar.
/** Numbered options; the `selected` one on a full-width bar with `❯`, its number and first segment bold. */
export function OptionList({ options, selected, palette, rowsRef }: { options: readonly OptionView[]; selected: number; palette: GluonPalette; rowsRef?: MutableRefObject<(DOMElement | null)[]> }) {
  const digits = String(options.length).length;
  return (
    <Box flexDirection="column" paddingLeft={OPTIONS_INDENT} flexShrink={0}>
      {options.map((o, i) => {
        const on = i === selected;
        const prefix = `${on ? " ❯ " : "   "}${`${i + 1}.`.padStart(digits + 1)} `;
        const label = o.segs.map((s, j) => paint(palette[on && s.role === "dim" ? "text" : s.role], s.text, on && j === 0)).join("");
        const note = o.note ? paint(palette.dim, `${o.segs.length ? " · " : ""}${o.note}`) : "";
        return (
          <Box
            key={i}
            ref={(n: DOMElement | null) => {
              if (rowsRef) rowsRef.current[i] = n;
            }}
            width="100%"
            backgroundColor={on ? palette.selected : undefined}
            flexShrink={0}
          >
            <Text color={on ? palette.bright : palette.text} bold={on}>
              {prefix}
            </Text>
            <Box flexShrink={1}>
              <Indent by={OPTIONS_INDENT + Bun.stringWidth(prefix)}>
                <Wrapped text={label + note} />
              </Indent>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * A hint line: key caps bold and bright, labels dim, ` · ` between (brief, section 4). Short of
 * columns whole keys go from the end (the optional ones come last), never cut in the middle (BUG-225).
 */
export function KeyHint({ hints, palette, indent = OPTIONS_INDENT + 2 }: { hints: [string, string][]; palette: GluonPalette; indent?: number }) {
  const room = useWidth() - indent;
  const shown = hints.filter((_, i) => i === 0 || Bun.stringWidth(hintText(hints.slice(0, i + 1), false)) <= room);
  return (
    <Box paddingLeft={indent} flexShrink={0}>
      <Text wrap="truncate-end">
        {shown.map(([key, label], i) => (
          <Text key={i}>
            {i ? <Text color={palette.dim}> · </Text> : null}
            <Text color={palette.bright} bold>
              {key}
            </Text>
            <Text color={palette.dim}> {label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export const OWN_ANSWER = "type your own answer";

/** A question's lead line; one of several asked together says which: `(2/3) Which …?`. */
export const questionLead = (q: Question) => (q.step ? `(${q.step.n}/${q.step.of}) ${q.question}` : q.question);

/** The rows of an open question: its options, then `type your own answer`. */
export const questionOptions = (q: Question): OptionView[] => [
  ...q.options.map((o) => ({ segs: [{ text: o.label, role: "text" as const }], note: o.description })),
  { segs: [{ text: OWN_ANSWER, role: "dim" as const }] },
];

/**
 * What is typed while a question or the agent choice is open: nothing (null), text (Enter sends
 * it) or a lone digit naming option N (Enter picks it).
 */
export type OptionsTyped = null | "text" | number;

/** With something typed, the open question's or choice's keys are what Enter does with it. */
const typedHints = (typed: "text" | number): [string, string][] => [
  ["enter", typed === "text" ? "sends" : `picks ${typed}`],
  ["esc esc", "clears it"],
];

/** Keys a hint names after the essential ones (Enter, Esc), so a cut drops them first (BUG-225). */
const OPTIONAL_KEYS = new Set(["tab", "shift+tab", "ctrl+t", "ctrl+p", "type"]);

/** A hint's text: `key label · key label`; `essential`: without the optional keys (the home view's hint line). */
export const hintText = (hints: readonly [string, string][], essential = true) =>
  hints
    .filter(([k]) => !essential || !OPTIONAL_KEYS.has(k))
    .map(([k, l]) => `${k} ${l}`)
    .join(" · ");

/** The hint under an open question; the home view's hint line says the same words (BUG-225). */
export function questionHints(typed: OptionsTyped = null): [string, string][] {
  if (typed !== null) return typedHints(typed);
  return [
    ["↑↓", "choose"],
    ["enter", "answers"],
    ["esc", "dismisses"],
    ["tab", "adds your words to it"],
    ["type", "to answer in your words"],
  ];
}

export function QuestionBlock({ question, selected, hints = questionHints(), palette, theme, rowsRef }: { question: Question; selected: number; hints?: [string, string][]; palette: GluonPalette; theme: Theme; rowsRef?: MutableRefObject<(DOMElement | null)[]> }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <AssistantLine text={questionLead(question)} palette={palette} theme={theme} />
      <OptionList options={questionOptions(question)} selected={selected} palette={palette} rowsRef={rowsRef} />
      <KeyHint hints={hints} palette={palette} />
    </Box>
  );
}

export const KEEP_TALKING = "keep talking";

/**
 * The rows of an open proposal: each agent (with its Tab adjust applied), then `keep talking`.
 * `recommended` on the first while it is still the intake agent's (`proposed`: its options as it
 * made them): a Tab adjust makes it the user's choice, no longer the recommendation. The `mode`
 * (explore, plan; for the whole proposal) ends every row and doesn't touch `recommended`:
 * it is the session's, not the agent's.
 */
export function proposalOptions(triples: readonly AgentTriple[], config?: Pick<Config, "models">, proposed: readonly AgentTriple[] = triples, mode?: Mode): OptionView[] {
  const same = (a?: AgentTriple, b?: AgentTriple) => !!a && !!b && a.harness === b.harness && a.model === b.model && (a.effort ?? null) === (b.effort ?? null);
  return [...triples.map((t, i) => ({ segs: tripleSegs({ ...t, mode }, config), note: i === 0 && same(t, proposed[0]) ? "recommended" : undefined })), { segs: [{ text: KEEP_TALKING, role: "text" as const }] }];
}

/** The hint under the agent choice, every key: the essential ones first (BUG-225). */
export const CHOICE_HINTS: [string, string][] = [
  ["↑↓", "choose"],
  ["enter", "starts the session"],
  ["esc", "cancels"],
  ["tab", "model"],
  ["shift+tab", "effort"],
  ["ctrl+t", "mode"],
  ["ctrl+p", "permissions"],
];

/**
 * The hint under the agent choice for the highlighted agent `t` (none: `keep talking`), saying what
 * Enter does (BUG-225): Tab only when it has another model to switch to, Shift+Tab only another
 * effort (`cycleModel`, `cycleEffort` over the offered `agents`; BUG-221), Ctrl+P only an agent with permission levels (`permissionLevels`). With something `typed`,
 * what Enter does with it. The home view's hint line says the same words.
 */
export function choiceHints(t: AgentTriple | undefined, agents: AgentOption[], typed: OptionsTyped = null): [string, string][] {
  if (typed !== null) return typedHints(typed);
  if (!t) return [["↑↓", "choose"], ["enter", "keeps talking"], ["esc", "cancels"]];
  const model = cycleModel(t, agents).model !== t.model;
  const effort = (cycleEffort(t, agents).effort ?? null) !== (t.effort ?? null);
  const permissions = permissionLevels(t.harness).length > 1;
  return CHOICE_HINTS.filter(([key]) => (key === "tab" ? model : key === "shift+tab" ? effort : key === "ctrl+p" ? permissions : true));
}

/** Columns before the spec box's left border. */
const SPEC_INDENT = OPTIONS_INDENT;
/** Columns the box takes around its text: two borders, a column of padding each side. */
const SPEC_CHROME = 4;
export const SPEC_TITLE = "spec — what the agent will get";

/** Columns the spec's text gets in its box at `width`. */
export const specTextWidth = (width: number) => Math.max(10, width - SPEC_INDENT - SPEC_CHROME);

/** Rows the spec's text takes in its box at `width`, all of it. */
export const specRows = (spec: string, width: number, theme: Theme) => markdownRows(spec, theme, specTextWidth(width));

/** Which rows of the spec the box shows: `rows` of them (all when unset) from `offset`. */
export interface SpecView {
  rows?: number;
  offset?: number;
}

/** A box edge: `╭─ label ──── note ─╮`; short of columns the note goes, then the label is cut. */
function BoxEdge({ width, corners, label, note, palette }: { width: number; corners: [string, string]; label?: string; note?: string; palette: GluonPalette }) {
  const inner = Math.max(0, width - 2);
  let l = label ? ` ${label} ` : "";
  let n = note ? ` ${note} ` : "";
  if (1 + Bun.stringWidth(l) + Bun.stringWidth(n) + 1 > inner) n = "";
  if (l && 1 + Bun.stringWidth(l) > inner) l = inner > 4 ? ` ${truncate(label!, inner - 3)} ` : "";
  const fill = Math.max(0, inner - 1 - Bun.stringWidth(l) - (n ? Bun.stringWidth(n) + 1 : 0));
  return (
    <Text wrap="truncate-end">
      <Text color={palette.frame}>{`${corners[0]}─`}</Text>
      <Text color={palette.bright} bold>
        {l}
      </Text>
      <Text color={palette.frame}>{"─".repeat(fill)}</Text>
      <Text color={palette.dim}>{n}</Text>
      <Text color={palette.frame}>{`${n ? "─" : ""}${corners[1]}`}</Text>
    </Text>
  );
}

const lineWord = (n: number) => (n === 1 ? "line" : "lines");

// Codex: none (it never asks before its agent acts) — modelled on Claude Code's plan approval box:
// the plan in a bordered box, titled, above "Would you like to proceed?" and its options.
/**
 * The spec the agent will get, in a bordered box with its title, Markdown inside. Cut to
 * `view.rows` rows from `view.offset` (the top first); the bottom edge says what is left out.
 */
export function SpecBox({ spec, view = {}, palette, theme }: { spec: string; view?: SpecView; palette: GluonPalette; theme: Theme }) {
  const outer = useWidth();
  const width = outer - SPEC_INDENT;
  const total = specRows(spec, outer, theme);
  const shown = Math.max(0, Math.min(total, view.rows ?? total));
  const offset = Math.max(0, Math.min(total - shown, view.offset ?? 0));
  const below = total - shown - offset;
  const more = [offset > 0 ? `${offset} ${lineWord(offset)} above (pgup)` : "", below > 0 ? `… ${below} more ${lineWord(below)} (pgdn)` : ""].filter(Boolean).join(" · ");
  return (
    <Box flexDirection="column" paddingLeft={SPEC_INDENT} flexShrink={0}>
      <BoxEdge width={width} corners={["╭", "╮"]} label={SPEC_TITLE} note="ctrl+o to hide" palette={palette} />
      {/* Only the rows shown are drawn: no `overflow` clip here, the chat's must be the innermost (BUG-199).
          The sides on the ground: Ink paints a border's cells with the border's own background only (BUG-246). */}
      <Box flexDirection="column" width={width} height={shown} borderStyle="round" borderTop={false} borderBottom={false} borderColor={palette.frame} borderBackgroundColor={palette.ground} paddingX={1} flexShrink={0}>
        <Indent by={SPEC_INDENT + SPEC_CHROME}>
          <TextColor color={palette.text}>
            <Markdown text={spec} theme={theme} from={offset} count={shown} />
          </TextColor>
        </Indent>
      </Box>
      <BoxEdge width={width} corners={["╰", "╯"]} note={more || undefined} palette={palette} />
    </Box>
  );
}

/** The spec on one dim line: `spec: <its first line>  (ctrl+o to view)`; `noRoom`: the box didn't fit. */
function SpecLine({ spec, noRoom, palette }: { spec: string; noRoom: boolean; palette: GluonPalette }) {
  const width = useWidth() - OPTIONS_INDENT - 2;
  const first = spec.split("\n").find((l) => l.trim())?.trim() ?? "";
  const tail = noRoom ? "  (a taller terminal shows it)" : "  (ctrl+o to view)";
  return (
    <Box paddingLeft={OPTIONS_INDENT + 2} flexShrink={0}>
      <Text color={palette.dim} wrap="truncate-end">{`spec: ${truncate(first, Math.max(1, width - 6 - tail.length))}${tail}`}</Text>
    </Box>
  );
}

/**
 * The agent choice: `◆ <reason> I'd start it with:`, the spec the agent will get in its box (Ctrl+O:
 * on one dim line), the options (full triples, the recommendation first, then `keep talking`) and
 * the hint. `spec` cuts the box to the rows the chat has, so the options stay below it; with no
 * row for its text, the one line.
 */
export function ChoiceBlock({ proposal, triples, mode, selected, showSpec, spec, hints = CHOICE_HINTS, palette, theme, config, rowsRef }: { proposal: ShownProposal; triples: readonly AgentTriple[]; mode?: Mode; selected: number; showSpec: boolean; spec?: SpecView; hints?: [string, string][]; palette: GluonPalette; theme: Theme; config?: Pick<Config, "models">; rowsRef?: MutableRefObject<(DOMElement | null)[]> }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      <AssistantLine text={proposalLead(proposal.reason)} palette={palette} theme={theme} />
      {showSpec && (spec?.rows ?? 1) > 0 ? <SpecBox spec={proposal.spec} view={spec} palette={palette} theme={theme} /> : <SpecLine spec={proposal.spec} noRoom={showSpec} palette={palette} />}
      <OptionList options={proposalOptions(triples, config, proposal.choices, mode)} selected={selected} palette={palette} rowsRef={rowsRef} />
      <KeyHint hints={hints} palette={palette} />
    </Box>
  );
}

/** Rows `text` takes wrapped at `width` (as `Wrapped` draws it). */
const wrappedRows = (text: string, width: number) => wrap(text, Math.max(10, width)).split("\n").length;

/** Rows the options take at `width` (each wraps under its prefix, as `OptionList` draws them). */
function optionRows(options: readonly OptionView[], width: number): number {
  const digits = String(options.length).length;
  const prefix = 3 + digits + 2;
  return options.reduce((n, o) => n + wrappedRows(o.segs.map((x) => x.text).join("") + (o.note ? `${o.segs.length ? " · " : ""}${o.note}` : ""), width - OPTIONS_INDENT - prefix), 0);
}

/**
 * Rows the open question or agent choice takes at `width`, wrapped lines counted (BUG-167): the
 * blank above it, the lead line, the spec (`specLines` rows of its text in the box; unset: its one
 * line), the options, the hint, the blank below.
 */
export function openBlockRows(pending: Pending, triples: readonly AgentTriple[], width: number, config?: Pick<Config, "models">, specLines?: number, mode?: Mode): number {
  if (pending?.kind === "question") return 1 + wrappedRows(questionLead(pending.question), width - CHAT_INDENT) + optionRows(questionOptions(pending.question), width) + 1 + 1;
  if (pending?.kind === "proposal") {
    const spec = specLines === undefined ? 1 : 2 + specLines;
    return 1 + wrappedRows(proposalLead(pending.reason), width - CHAT_INDENT) + spec + optionRows(proposalOptions(triples.length ? triples : pending.choices, config, undefined, mode), width) + 1 + 1;
  }
  return 0;
}

// Codex: status_indicator_widget.rs — `Working (5s • esc to interrupt)`, in the chat's glyphs.
export function WorkingLine({ since, status, palette }: { since: number; status: string; palette: GluonPalette }) {
  const { time } = useAnimation({ interval: 500 });
  return (
    <Glyph glyph={Math.floor(time / 500) % 2 ? "◇" : "◆"} color={palette.amber}>
      <Text color={palette.dim}>
        {status} ({elapsed(Date.now() - since)} · <Text bold>esc</Text> to interrupt)
      </Text>
    </Glyph>
  );
}

/** The chat's items, then the open question or choice, then the working line. */
export function Transcript({ state, palette, theme, config, choice, greeting }: { state: State; palette: GluonPalette; theme: Theme; config?: Pick<Config, "models">; choice?: { selected: number; triples: readonly AgentTriple[]; mode?: Mode; showSpec: boolean; spec?: SpecView; open: boolean; hints?: [string, string][]; rowsRef?: MutableRefObject<(DOMElement | null)[]> }; greeting?: string }) {
  const pending: Pending = state.pending;
  const busy = state.workingSince !== null;
  const items = state.items.filter((it, i) => !(pending?.kind === "proposal" && it.kind === "proposal" && i === state.items.length - 1));
  const live = state.live.filter((i) => i.kind !== "assistant" || i.text.trim());
  const all = [...items, ...live];
  const open = !busy && choice?.open;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {greeting && !all.length && !pending ? (
        <Box marginTop={1}>
          <AssistantLine text={greeting} palette={palette} theme={theme} />
        </Box>
      ) : null}
      {all.map((item) => (
        <Box key={item.id} marginTop={1} flexShrink={0}>
          <ChatItem item={item} palette={palette} theme={theme} config={config} />
        </Box>
      ))}
      {open && pending?.kind === "question" ? (
        <Box marginTop={1} flexShrink={0}>
          <QuestionBlock question={pending.question} selected={choice!.selected} hints={choice!.hints} palette={palette} theme={theme} rowsRef={choice!.rowsRef} />
        </Box>
      ) : null}
      {pending?.kind === "proposal" && !busy ? (
        <Box marginTop={1} flexShrink={0}>
          {open ? (
            <ChoiceBlock proposal={pending} triples={choice!.triples} mode={choice!.mode} selected={choice!.selected} showSpec={choice!.showSpec} spec={choice!.spec} hints={choice!.hints} palette={palette} theme={theme} config={config} rowsRef={choice!.rowsRef} />
          ) : (
            <PastProposal item={{ ...pending, id: 0 }} palette={palette} theme={theme} config={config} />
          )}
        </Box>
      ) : null}
      {pending?.kind === "question" && !open && !busy ? (
        <Box marginTop={1} flexShrink={0}>
          <AssistantLine text={questionLead(pending.question)} palette={palette} theme={theme} />
        </Box>
      ) : null}
      {busy ? (
        <Box marginTop={1} flexShrink={0}>
          <WorkingLine since={state.workingSince!} status={state.status} palette={palette} />
        </Box>
      ) : null}
    </Box>
  );
}

/** A thin rule across the width, in `rule`. */
export function Rule({ palette }: { palette: GluonPalette }) {
  return <Text color={palette.rule}>{"─".repeat(useWidth())}</Text>;
}

/** Columns before the composer's text: ` › `. */
const COMPOSER_INDENT = 3;

// Codex: bottom_pane/chat_composer.rs — `› ` and the draft; here between two rules, no background.
/** The composer between two rules: `›` blue, the draft bright (the cursor inverse, unless `cursor` is false), or the dim placeholder. */
export function GluonComposer({ draft, placeholder, maxRows, palette, cursor = true }: { draft: Draft; placeholder: string; maxRows: number; palette: GluonPalette; cursor?: boolean }) {
  const width = useWidth() - COMPOSER_INDENT;
  const body =
    draft.text === "" ? (
      <Text wrap="truncate-end">
        <Text color={palette.blue}>{" › "}</Text>
        <Text color={palette.dim} inverse={cursor}>
          {placeholder.slice(0, 1) || " "}
        </Text>
        <Text color={palette.dim}>{placeholder.slice(1)}</Text>
      </Text>
    ) : (
      <ComposerRows draft={draft} width={width} maxRows={maxRows} palette={palette} cursor={cursor} />
    );
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Rule palette={palette} />
      {body}
      <Rule palette={palette} />
    </Box>
  );
}

function ComposerRows({ draft, width, maxRows, palette, cursor }: { draft: Draft; width: number; maxRows: number; palette: GluonPalette; cursor: boolean }) {
  const { rows, first, last, cursorRow, moreAbove, moreBelow } = composerRows(draft, Math.max(1, width), Math.max(1, maxRows));
  return (
    <Width columns={width + COMPOSER_INDENT}>
      {moreAbove > 0 ? <Text color={palette.dim}>{`   ↑ ${moreAbove} more line${moreAbove === 1 ? "" : "s"}`}</Text> : null}
      {rows.slice(first, last).map((r, i) => {
        const here = first + i === cursorRow;
        const at = here ? r.cells.findIndex((c) => c.at === draft.cursor) : -1;
        const text = (cells: typeof r.cells) => cells.map((c) => c.text).join("");
        return (
          <Text key={first + i} wrap="truncate-end">
            <Text color={palette.blue}>{r.from === 0 ? " › " : "   "}</Text>
            {here ? (
              <>
                <Text color={palette.bright}>{text(r.cells.slice(0, at === -1 ? r.cells.length : at))}</Text>
                <Text color={palette.bright} inverse={cursor}>
                  {at === -1 ? " " : r.cells[at]!.text}
                </Text>
                <Text color={palette.bright}>{at === -1 ? "" : text(r.cells.slice(at + 1))}</Text>
              </>
            ) : (
              <Text color={palette.bright}>{text(r.cells) || " "}</Text>
            )}
          </Text>
        );
      })}
      {moreBelow > 0 ? <Text color={palette.dim}>{`   ↓ ${moreBelow} more line${moreBelow === 1 ? "" : "s"}`}</Text> : null}
    </Width>
  );
}

/** Rows the composer block takes for this draft (two rules, the text rows, the "more" markers). */
export function composerHeight(draft: Draft, width: number, maxRows: number): number {
  if (draft.text === "") return 3;
  const { first, last, moreAbove, moreBelow } = composerRows(draft, Math.max(1, width - COMPOSER_INDENT), Math.max(1, maxRows));
  return 2 + (last - first) + (moreAbove > 0 ? 1 : 0) + (moreBelow > 0 ? 1 : 0);
}
