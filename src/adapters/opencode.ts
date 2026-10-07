/**
 * OpenCode 2: a CLI plugin of Gluon's own, loaded for this launch only through
 * `OPENCODE_CLI_CONFIG_CONTENT` (documented: CLI settings as inline JSON, "plugins" takes package
 * directories; nothing is written to OpenCode's config or the repository). Its jobs are
 * `/gluon` and the status (`pluginSource`); `/new`, `/clear`, `/compact` and the return key are
 * the PTY's (`src/pty/`), and OpenCode has no hook that could wait before an auto-compaction.
 *
 * Found by hand on OpenCode 2.0.21 (2026-10-01; isolated HOME, no model calls):
 * - A keymap layer command (with `slash` and `palette: true`) adds a slash command and a palette
 *   entry. `keymap.layer` must be called inside a render (`ui.slot({ append: "app" })`): in
 *   `setup` it fails with "Keymap.Provider is missing".
 * - The plugin runs in OpenCode's Bun (`Bun.spawn`, `process.env` work); it may import
 *   `@opencode/plugin/tui` without bundling it.
 * - A "plugins" list in the variable replaces the one in the user's `cli.json` (arrays replace,
 *   objects merge); plugins in OpenCode's plugin directories and in `opencode.json` still load.
 *   A value the user set in the variable is kept: our plugin is appended to it.
 * - OpenCode updates itself at start unless `OPENCODE_DISABLE_AUTOUPDATE` is set.
 */
import { SESSION_ID } from "../events.ts";
import { RETURN_COMMAND_RE } from "./common.ts";
import { ADAPTER_DIR_JSON, NO_ADAPTER, type Adapter, type AdapterContext, type AdapterOutput } from "./types.ts";

/** What the plugin reports as a step's model when no event named one; the cost code prices it at the launched model's price, an assumption (BUG-671). Here, not in `src/cost/`, so `gluon hook` stays light (BUG-358). */
export const OPENCODE_NO_MODEL = "unknown/unknown";

export const CLI_CONFIG_ENV = "OPENCODE_CLI_CONFIG_CONTENT";
/**
 * The model families OpenCode 2.0.21 picks its small model from (session titles) when the config names none (`small_model`,
 * `agents.title.model`): the first family, in this order, that the session's provider has an active text model of (read from the
 * binary's bytes, `Model.small`; a model's own `family` is its models.dev one). The plugin can't see the config: a user's `small_model` is the one thing this misses.
 */
export const SMALL_MODEL_FAMILIES = ["gpt-luna", "gemini-flash-lite", "gemini-flash", "claude-haiku"] as const;
/** The plugin package, relative to the adapter directory. */
export const PLUGIN_DIR = "opencode-plugin";

/** The user's `OPENCODE_CLI_CONFIG_CONTENT` with our plugin appended, or null when it isn't a JSON object (left alone). */
export function mergeCliConfig(user: string | undefined, plugin: string): string | null {
  let base: Record<string, unknown> = {};
  if (user !== undefined && user.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(user);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      base = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const plugins = Array.isArray(base.plugins) ? base.plugins : [];
  return JSON.stringify({ ...base, plugins: [...plugins, plugin] });
}

/**
 * The CLI plugin (plain JavaScript, loaded by OpenCode's runtime): the `/gluon` command, and the
 * status (display only, `events.ts`): it follows OpenCode's event stream (`context.client.event
 * .subscribe`) and writes `status` events itself, as `gluon hook` would (no process per event).
 *
 * OpenCode 2.x events, as seen on 2.0.21 (a diagnostic plugin, shapes only, 2026-10-02): every
 * event is `{id, created, type, location?, data, durable?}`; what the plugin reads in `data`:
 * - `session.execution.started` {sessionID} → working; `session.execution.succeeded` (and the
 *   likely siblings `.failed` / `.cancelled` / `.aborted`) {sessionID} → done once no session runs;
 * - `form.created` {form} (OpenCode's question and permission forms) → awaiting;
 *   `form.replied` {id, sessionID, answer} → working;
 * - `session.tool.input.started` {sessionID, assistantMessageID, id, name} → the tool's name by id;
 *   `session.tool.called` {…, id, input, executed} → the activity line (`input` is {path}, {command}
 *   or the question tool's {questions}: no line for that one, its form says awaiting);
 * - `session.usage.updated` {sessionID, cost, tokens}: `cost` is the session's CUMULATIVE cost in
 *   USD (and its tokens cumulative totals, not used): the launch's cost is the sum over sessions of
 *   each one's latest `cost`;
 * - `session.created` / `session.step.started` {sessionID, model, …}: the session's model, a
 *   "provider/model" string or {providerID, modelID | id};
 * - `session.step.ended` {sessionID, cost (that step), tokens: {input, output, reasoning, cache}}:
 *   for the session on screen (`context.ui.router.current()`), the context in use is the LAST
 *   step's `input` + cache read + cache write (`cache` an object {read, write}, or a number) +
 *   `output` + `reasoning` (`input` is the non-cached part; what OpenCode's own footer counts, and
 *   what the next request will carry), with the model's `limit.context` from `client.model.list`;
 *   an unknown window: Gluon works it out;
 * - `session.compaction.ended` {sessionID, reason, tokens, cost} (a compaction that worked; `.failed`
 *   changes nothing): OpenCode shows no context until its next step, and so does Gluon
 *   (`contextTokens: null`). A model without a price has cost 0: no cost is sent then (OpenCode
 *   shows none either), never `$0.00`. Captured from a real 2.0.21 (`test/fixtures/telemetry/`).
 * - every `session.step.ended` (any session: a subagent's cost counts) and `session.compaction.ended` /
 *   `.failed` also go out as one record each in `steps` (`events.ts` `StepUsage`): never merged and at
 *   most a second late, because Gluon prices each step itself and a context tier is chosen by one
 *   step's prompt (spike of issue #39: two steps 22 ms apart lost the first when merged). A record
 *   of the conversation on screen (a session with no `parentID`) says `context`: "step" (its tokens
 *   are the context) or "compacted" (the context is unknown); subagents' and the others carry none;
 * - a request OpenCode bills but sends no step for (the session title: captured on 2.0.21, where
 *   `session.usage.updated` moves by a request's tokens and cost before the first step) is the part of
 *   a session's cumulative `session.usage.updated` that its step and compaction records don't
 *   explain: sent as its own record (`side`, on the provider's small model as OpenCode 2.0.21 picks it
 *   by `family` from `client.model.list` (`SMALL_MODEL_FAMILIES`), else the session's model: an assumption either
 *   way, the config's `small_model` is not visible here), a second after the update so that a
 *   compaction's late event can claim its part first. In a resumed launch
 *   (Gluon sets `GLUON_RESUMED`) a session first seen without a `session.created` holds history
 *   from before this launch: what its first update shows beyond its records is a baseline, taken off
 *   its tokens and its cost;
 * - `session.created` {sessionID, parentID?, …} (1.x: {sessionID, info: {id, parentID?}}): the first
 *   one without a `parentID` is the conversation's own session; its id goes out as a `session`
 *   event (`gluon resume` reopens it). Sub-sessions (with a parent) are never sent.
 * Others (`server.connected`, `session.text.*`, `session.reasoning.*`, `session.step.streamed`,
 * `session.inbox.*`, …) are ignored. OpenCode 1.x names (`session.status`, `session.idle`,
 * `permission.asked|replied`, `message.part.updated`, `message.updated` with per-message cost)
 * are still handled. Every step is guarded: whatever doesn't fit is skipped (no status), never an
 * error in OpenCode or `/gluon`. Figures are written at most once a second. Gluon's own return
 * command is no activity (BUG-186).
 */
export function pluginSource(): string {
  return `// Gluon's plugin for this OpenCode launch: brings the user back to Gluon and tells it what OpenCode is doing. Written by Gluon, removed after the launch.
import { Plugin } from "@opencode/plugin/tui"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

// Runs \`gluon signal back\`; outside a Gluon launch (no GLUON_EVENTS) it does nothing.
function back() {
  const self = process.env.GLUON_SELF
  if (!self || !process.env.GLUON_EVENTS) return
  try {
    Bun.spawn([self, "signal", "back"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  } catch {}
}

let written = 0
// One event file in the launch's events directory (the format gluon hook writes).
function send(line) {
  const dir = process.env.GLUON_EVENTS
  if (!dir) return
  try {
    const name = String(Date.now()).padStart(15, "0") + "-" + String(++written).padStart(6, "0") + "-" + process.pid + "-" + Math.random().toString(36).slice(2, 8) + ".event"
    writeFileSync(join(dir, name), line, { mode: 0o600, flag: "wx" })
  } catch {}
}
const status = (info) => send("status " + JSON.stringify(info))
// What Gluon accepts as a session id (events.ts); anything else would drop the event.
const SESSION_ID = new RegExp(${JSON.stringify(SESSION_ID.source)})

const text = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined)
// Gluon's own return command: not the agent's work.
const RETURN = new RegExp(${JSON.stringify(RETURN_COMMAND_RE.source)}, "i")
// A running tool as one line: "bash: bun test", "read src/x.ts".
function activity(tool, input) {
  if (!text(tool)) return undefined
  const a = input && typeof input === "object" ? input : {}
  const command = text(a.command)
  if (command) return RETURN.test(command) ? undefined : tool + ": " + command
  if (Array.isArray(a.questions)) return undefined
  const target = text(a.pattern) || text(a.query) || text(a.url)
  const path = text(a.filePath) || text(a.file_path) || text(a.path)
  if (target) return tool + " " + target + (path ? " in " + path : "")
  if (path) return tool + " " + path
  return text(a.description) ? tool + ": " + text(a.description) : tool
}

// What Gluon accepts as a model name (events.ts); anything else would drop the whole event.
const MODEL = /^[A-Za-z0-9._:\\/@[\\]-]{1,128}$/
// "provider/model" from a string or an object; undefined when it isn't one.
function modelName(m, provider) {
  let name
  if (typeof m === "string") name = text(provider) && !m.startsWith(text(provider) + "/") ? text(provider) + "/" + m : m
  else if (m && typeof m === "object") {
    const p = text(m.providerID) || text(provider)
    const id = text(m.modelID) || text(m.id)
    if (p && id) name = p + "/" + id
  }
  return typeof name === "string" && MODEL.test(name) ? name : undefined
}
// The small model OpenCode titles with (\`Model.small\`, 2.0.21): the first of these families the provider has an active model of.
const SMALL_FAMILIES = ${JSON.stringify(SMALL_MODEL_FAMILIES)}
const ENDED = /^session\\.execution\\.(succeeded|failed|cancelled|canceled|aborted|errored|interrupted)$/

function follower(context) {
  const busy = new Set()
  const sessionCosts = new Map()
  const messageCosts = new Map()
  const models = new Map()
  const tools = new Map()
  const windows = new Map()
  const smalls = new Map()
  const created = new Set()
  const children = new Set()
  const usage = new Map()
  const recorded = new Map()
  const baseline = new Map()
  const stepQueue = []
  let stepCount = 0
  let stepTimer
  let modelsAsked = false
  let sessionSent = false
  let shownModel
  let lastActivity
  let pending
  let timer
  const flush = () => {
    timer = undefined
    if (pending) status(pending)
    pending = undefined
  }
  const figures = (info) => {
    pending = { ...pending, ...info }
    if (!timer) timer = setTimeout(flush, 1000)
  }
  const COUNTS = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "cost"]
  const zero = () => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
  const addTo = (map, sessionID, rec) => {
    if (!sessionID) return
    const sum = map.get(sessionID) || zero()
    for (const k of COUNTS) sum[k] += rec[k] || 0
    map.set(sessionID, sum)
  }
  // The part of a session's cumulative usage its records (and its baseline) don't explain: a request OpenCode bills without a step (the title).
  const settle = () => {
    for (const [sessionID, u] of usage) {
      const r = recorded.get(sessionID) || zero()
      const b = baseline.get(sessionID) || zero()
      const left = {}
      for (const k of COUNTS) left[k] = Math.max(0, u[k] - b[k] - r[k])
      // Tokens alone could be OpenCode counting them its own way: its cost must have moved too (unless it prices nothing).
      if (!(left.input + left.output + left.reasoning + left.cacheRead + left.cacheWrite > 0) || !(left.cost > 1e-9 || u.cost <= 1e-12)) continue
      const session = (sessionID && models.get(sessionID)) || ${JSON.stringify(OPENCODE_NO_MODEL)}
      // The title is not the session's model: the provider's small model when the models list named it, else the session's (an assumption).
      const rec = { n: ++stepCount, model: smalls.get(session.split("/")[0]) || session, input: left.input, output: left.output, reasoning: left.reasoning, cacheRead: left.cacheRead, cacheWrite: left.cacheWrite, side: true }
      if (left.cost > 1e-9) rec.cost = left.cost
      addTo(recorded, sessionID, rec)
      stepQueue.push(rec)
    }
  }
  // Records are sent as they are, in order, within a second: a batch is a status event of its own (the events directory holds each, and a file is read once).
  const flushSteps = () => {
    stepTimer = undefined
    settle()
    while (stepQueue.length) status({ steps: stepQueue.splice(0, 12) })
  }
  const armSteps = () => {
    if (!stepTimer) stepTimer = setTimeout(flushSteps, 1000)
  }
  // The conversation the user is looking at: a session on screen that no other session started. \`ctx\`: what its record does to the context.
  const isMain = (sessionID) => !!sessionID && !children.has(sessionID) && onScreen(sessionID)
  const recordStep = (sessionID, data, model, ctx) => {
    const t = data && data.tokens
    if (!t || typeof t !== "object") return
    const c = t.cache
    const read = c && typeof c === "object" ? nonNegative(c.read) : nonNegative(c)
    const write = c && typeof c === "object" ? nonNegative(c.write) : 0
    const rec = { n: ++stepCount, model: model || (sessionID && models.get(sessionID)) || ${JSON.stringify(OPENCODE_NO_MODEL)}, input: nonNegative(t.input), output: nonNegative(t.output), reasoning: nonNegative(t.reasoning), cacheRead: read, cacheWrite: write }
    if (typeof data.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0) rec.cost = data.cost
    if (ctx && isMain(sessionID)) rec.context = ctx
    addTo(recorded, sessionID, rec)
    stepQueue.push(rec)
    armSteps()
  }
  // A session's cumulative usage: for title detection (\`settle\`), and its baseline when the session was already there when this launch began.
  const noteUsage = (sessionID, data) => {
    const t = data.tokens && typeof data.tokens === "object" ? data.tokens : {}
    const c = t.cache
    const now = { input: nonNegative(t.input), output: nonNegative(t.output), reasoning: nonNegative(t.reasoning), cacheRead: c && typeof c === "object" ? nonNegative(c.read) : nonNegative(c), cacheWrite: c && typeof c === "object" ? nonNegative(c.write) : 0, cost: data.cost }
    if (!usage.has(sessionID) && !created.has(sessionID) && process.env.GLUON_RESUMED) {
      const r = recorded.get(sessionID) || zero()
      const b = zero()
      for (const k of COUNTS) b[k] = Math.max(0, now[k] - r[k])
      baseline.set(sessionID, b)
    }
    usage.set(sessionID, now)
    armSteps()
  }
  // A state change; the activity line starts over (the same tool may run again).
  const state = (s) => {
    lastActivity = undefined
    status({ state: s })
  }
  const nonNegative = (n) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0)
  const id = (v) => (typeof v === "string" && v ? v : undefined)
  // The launch's cost, once there is one: a model without a price costs 0, which is no figure.
  const totalCost = () => {
    let total = 0
    for (const [sessionID, c] of sessionCosts) total += Math.max(0, c - ((baseline.get(sessionID) || {}).cost || 0))
    for (const c of messageCosts.values()) total += c
    return total
  }
  const costFigure = () => {
    const total = totalCost()
    return total > 0 ? { costUsd: total } : {}
  }
  async function askModels() {
    if (modelsAsked) return
    modelsAsked = true
    try {
      const r = await context.client.model.list({})
      const families = new Map()
      for (const m of (Array.isArray(r) ? r : r && r.data) || []) {
        const limit = m && m.limit && m.limit.context
        const name = modelName(m)
        if (typeof limit === "number" && limit > 0 && name) windows.set(name, limit)
        const provider = m && text(m.providerID)
        if (name && provider && typeof m.family === "string" && (m.status === undefined || m.status === "active")) {
          const byFamily = families.get(provider) || new Map()
          if (!byFamily.has(m.family)) byFamily.set(m.family, name)
          families.set(provider, byFamily)
        }
      }
      for (const [provider, byFamily] of families) {
        for (const family of SMALL_FAMILIES) {
          if (byFamily.has(family)) {
            smalls.set(provider, byFamily.get(family))
            break
          }
        }
      }
      const w = shownModel && windows.get(shownModel)
      if (w) figures({ contextWindow: w })
    } catch {}
  }
  // The model of the session on screen, with its window when known.
  function modelFigures(name) {
    if (!name) return {}
    shownModel = name
    const w = windows.get(name)
    if (!w) void askModels()
    return w ? { model: name, contextWindow: w } : { model: name }
  }
  function onScreen(sessionID) {
    try {
      const route = context.ui.router.current()
      return !route || route.type !== "session" || !sessionID || route.sessionID === sessionID
    } catch {
      return true
    }
  }
  function tool(line) {
    if (line && line !== lastActivity) {
      lastActivity = line
      status({ state: "working", activity: line })
    }
  }
  function onEvent(ev) {
    const type = ev && ev.type
    if (typeof type !== "string") return
    const data = (ev && (ev.data || ev.properties)) || {}
    const sessionID = id(data.sessionID)
    // The first top-level session's id, for \`gluon resume\`: a sub-session has a parentID. 2.x: {sessionID, parentID?}; 1.x: {sessionID, info: {id, parentID?}}.
    if (type === "session.created") {
      const info = data.info && typeof data.info === "object" ? data.info : data
      const sid = id(info.id) || sessionID
      // Every session created in this launch is a new one (no history to baseline); a sub-session is no conversation of the user's.
      if (sid) {
        if (created.size > 500) created.clear()
        created.add(sid)
        if (id(info.parentID) || id(data.parentID)) children.add(sid)
      }
      if (!sessionSent && sid && !id(info.parentID) && !id(data.parentID) && SESSION_ID.test(sid)) {
        sessionSent = true
        send("session " + sid)
      }
    }
    // OpenCode 2.x
    if (type === "session.execution.started") {
      if (sessionID) busy.add(sessionID)
      state("working")
    } else if (ENDED.test(type)) {
      if (sessionID) busy.delete(sessionID)
      if (!busy.size) state("done")
    } else if (type === "form.created") {
      state("awaiting")
    } else if (type === "form.replied" || type === "form.rejected" || type === "form.cancelled") {
      state("working")
    } else if (type === "session.tool.input.started") {
      const key = id(data.id)
      if (key && text(data.name)) {
        if (tools.size > 200) tools.clear()
        tools.set(key, text(data.name))
      }
    } else if (type === "session.tool.called") {
      const key = id(data.id)
      const name = text(data.name) || text(data.tool) || (key && tools.get(key))
      if (key) tools.delete(key)
      if (name === "question") return
      tool(activity(name, data.input))
    } else if (type === "session.usage.updated") {
      if (!sessionID || typeof data.cost !== "number" || !Number.isFinite(data.cost) || data.cost < 0) return
      noteUsage(sessionID, data)
      sessionCosts.set(sessionID, data.cost)
      figures(costFigure())
    } else if (type === "session.created" || type === "session.step.started") {
      const name = modelName(data.model, data.providerID)
      if (!sessionID || !name) return
      models.set(sessionID, name)
      // The models list also names the provider's small model, which a title request may need before the first step.
      void askModels()
      if (type === "session.step.started" && onScreen(sessionID)) figures(modelFigures(name))
    } else if (type === "session.step.ended") {
      recordStep(sessionID, data, undefined, "step")
      const t = data.tokens
      if (!t || typeof t !== "object" || !onScreen(sessionID)) return
      const c = t.cache
      const cached = c && typeof c === "object" ? nonNegative(c.read) + nonNegative(c.write) : nonNegative(c)
      const tokens = nonNegative(t.input) + cached + nonNegative(t.output) + nonNegative(t.reasoning)
      if (tokens > 0) figures({ contextTokens: tokens, ...modelFigures(sessionID && models.get(sessionID)) })
    } else if (type === "session.compaction.ended" || type === "session.compacted") {
      if (type === "session.compaction.ended") recordStep(sessionID, data, modelName(data.model, data.providerID), "compacted")
      if (onScreen(sessionID)) figures({ contextTokens: null })
    } else if (type === "session.compaction.failed") {
      // It still cost (OpenCode counts it) but names no model: the session's.
      recordStep(sessionID, data)
    }
    // OpenCode 1.x
    else if (type === "session.status") {
      const t = data.status && data.status.type
      if (t === "busy" || t === "retry") {
        busy.add(sessionID)
        state("working")
      } else if (t === "idle") {
        busy.delete(sessionID)
        if (!busy.size) state("done")
      }
    } else if (type === "session.idle") {
      busy.delete(sessionID)
      if (!busy.size) state("done")
    } else if (type === "permission.asked") {
      state("awaiting")
    } else if (type === "permission.replied") {
      state("working")
    } else if (type === "message.part.updated") {
      const part = data.part || {}
      if (part.type !== "tool" || !part.state || part.state.status !== "running") return
      tool(activity(part.tool, part.state.input))
    } else if (type === "message.updated") {
      const info = data.info || data
      if (!info || (info.role && info.role !== "assistant")) return
      const out = {}
      if (typeof info.cost === "number" && Number.isFinite(info.cost) && info.cost >= 0 && info.id) {
        messageCosts.set(info.id, info.cost)
        Object.assign(out, costFigure())
      }
      const t = info.tokens
      if (t && typeof t === "object" && onScreen(data.sessionID || info.sessionID)) {
        const tokens = nonNegative(t.input) + nonNegative(t.cache && t.cache.read) + nonNegative(t.cache && t.cache.write) + nonNegative(t.output) + nonNegative(t.reasoning)
        if (tokens > 0) out.contextTokens = tokens
        Object.assign(out, modelFigures(modelName(info.modelID ? { providerID: info.providerID, modelID: info.modelID } : info.model, info.providerID)))
      }
      if (Object.keys(out).length) figures(out)
    }
  }
  // Stopped (the plugin is unloaded): what is waiting goes out now, not a second late.
  onEvent.close = () => {
    if (stepTimer) clearTimeout(stepTimer)
    if (timer) clearTimeout(timer)
    flushSteps()
    flush()
  }
  return onEvent
}

// Follows OpenCode's events until stopped; quietly does nothing when the stream isn't there.
function follow(context, signal) {
  const events = context.client && context.client.event
  if (!events || typeof events.subscribe !== "function") return
  const onEvent = follower(context)
  signal.addEventListener("abort", () => { try { onEvent.close() } catch {} })
  ;(async () => {
    try {
      const sub = await events.subscribe({ signal })
      const stream = sub && (sub.stream || sub)
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return
      for await (const ev of stream) {
        try {
          onEvent(ev)
        } catch {}
      }
    } catch {}
  })()
}

export default Plugin.define({
  id: "gluon.handoff",
  setup(context) {
    const stops = []
    // A keymap layer works only inside a render.
    stops.push(context.ui.slot({ append: "app", render: () => {
      context.keymap.layer(() => ({ mode: "global", priority: 100, commands: [
        { id: "gluon.back", title: "Back to Gluon", group: "Gluon", palette: true, slash: { name: "gluon" }, run: () => { back() } },
      ] }))
      return null
    } }))
    if (process.env.GLUON_EVENTS) {
      const abort = new AbortController()
      try {
        follow(context, abort.signal)
      } catch {}
      stops.push(() => abort.abort())
    }
    return () => { for (const stop of stops) stop() }
  },
})
`;
}

const PACKAGE_JSON = `${JSON.stringify({ name: "gluon-opencode", private: true, type: "module", exports: { "./tui": "./tui.js" } })}\n`;

export const opencode: Adapter = {
  harness: "opencode",
  // The plugin API used here, verified on 2.0.21.
  minVersion: "2.0.21",
  build(ctx: AdapterContext): AdapterOutput {
    // The directory sits inside a JSON string here: substituted JSON-escaped (a Windows path; BUG-140).
    const value = mergeCliConfig(ctx.env?.[CLI_CONFIG_ENV], `${ADAPTER_DIR_JSON}/${PLUGIN_DIR}`);
    if (value === null) return NO_ADAPTER;
    return {
      argv: [],
      env: { [CLI_CONFIG_ENV]: value, OPENCODE_DISABLE_AUTOUPDATE: "1" },
      files: { [`${PLUGIN_DIR}/package.json`]: PACKAGE_JSON, [`${PLUGIN_DIR}/tui.js`]: pluginSource() },
    };
  },
  notes(ctx: AdapterContext): string[] {
    const user = ctx.env?.[CLI_CONFIG_ENV];
    if (mergeCliConfig(user, "") === null) return [`${CLI_CONFIG_ENV} in your environment isn't a JSON object: Gluon adds nothing to OpenCode (no /gluon).`];
    const ownList = user?.trim() && Array.isArray(JSON.parse(user).plugins);
    return [
      "/gluon shows Gluon's sessions home.",
      "Its status, latest activity, cost and context use show in Gluon (from OpenCode's own events).",
      ...(ctx.handoff.on_compact === "ask" ? ["auto-compaction: OpenCode compacts without asking (it has no hook that can wait)."] : []),
      ...(ownList ? [] : ["Plugins listed in OpenCode's cli.json are off in Gluon's launches (its plugin directories and opencode.json still load)."]),
      "OpenCode doesn't update itself in Gluon's launches (OPENCODE_DISABLE_AUTOUPDATE); run it on its own to update.",
    ];
  },
};
