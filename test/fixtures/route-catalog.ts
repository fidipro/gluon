// A model catalog for the routing tests: the proposal's (Oct 2026), as facts routing needs.
// Fixed here on purpose: the real catalog (src/harnesses.ts) changes, and these tests are about
// routing's arithmetic and the default routing.yaml, not about which models Gluon ships.
import type { Effort, RouteCatalog } from "../../src/routing.ts";

const CC: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const CODEX: Effort[] = ["low", "medium", "high", "xhigh"];

// Effort levels per model were checked against vendor docs on 2026-10-05:
// Kimi K2.7 Code has none (thinking always on); Kimi K3 takes low, high, max;
// Muse Spark 1.3 takes up to max, Contributor up to xhigh; DeepSeek V4.1 Flash
// takes low, high, max.
export const ROUTE_CATALOG: RouteCatalog = [
  {
    id: "claude-code", name: "Claude Code",
    models: [
      // Haiku 5.5 is first in light (routing.yaml rank), ahead of Luna.
      { id: "haiku",  name: "Haiku 5.5",  efforts: CC, defaultEffort: "medium" },
      { id: "sonnet", name: "Sonnet 5.5", efforts: CC, defaultEffort: "high" },
      { id: "opus",   name: "Opus 5.5",   efforts: CC, defaultEffort: "medium" },
      // Fable shows no AA edge over Opus 5.5 (Opus scores 2-4 points higher at medium
      // effort and above, at 40% of the price). It stays in frontier (routing.yaml rank) by choice.
      { id: "fable",  name: "Fable 5.1",  efforts: CC, defaultEffort: "high" },
    ],
  },
  {
    id: "codex", name: "Codex",
    models: [
      { id: "gpt-6-luna",  name: "GPT-6 Luna",  efforts: CODEX, defaultEffort: "high" },
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: CODEX, defaultEffort: "medium" },
      // Astra is about one effort step above Sol on AA, at 5x the price.
      { id: "gpt-6-astra", name: "GPT-6 Astra", efforts: CODEX, defaultEffort: "medium" },
    ],
  },
  {
    id: "kimi-code", name: "Kimi Code",
    models: [
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", efforts: [] },
      { id: "kimi-k3",        name: "Kimi K3",        efforts: ["low", "high", "max"], defaultEffort: "high" },   // AA measures low and max only
    ],
  },
  {
    id: "grok-build", name: "Grok Build",
    models: [
      { id: "grok-4.7", name: "Grok 4.7", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
    ],
  },
  {
    id: "antigravity", name: "Antigravity",
    models: [
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "high" },
    ],
  },
  {
    id: "opencode", name: "OpenCode",
    delegatesInFamily: true,
    models: [
      // DeepSeek Flash: a stable alias that follows the latest Flash. DeepSeek Pro was
      // dropped: V4.1 Flash beats V4 Pro 0813 at 27% of the price.
      // Muse: pinned versions. Contributor is much cheaper but shares data with
      // Meta, so it is used only with allow_muse_contributor: true.
      { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", family: "muse",
        efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "xhigh", sharesDataWith: "Meta", optIn: "allow_muse_contributor" },   // no max
      // DeepSeek accepts low, high and max (medium and xhigh map to high). Max is its
      // only measured reasoning variant (AA 39.5) and costs little, so it's the default.
      { id: "deepseek-flash", name: "DeepSeek Flash (latest)", family: "deepseek", current: "deepseek-v4.1-flash",
        efforts: ["low", "high", "max"], defaultEffort: "max" },
      // Muse max costs about the same latency as xhigh (40 s) for +3 points.
      { id: "muse-spark-1.3",             name: "Muse Spark 1.3",             family: "muse",
        efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "max" },
    ],
  },
];
