import {
  __resetPendingBindMaxWaitForTesting,
  __setPendingBindMaxWaitForTesting,
  getPendingBindMaxWaitMs,
  recordGenAiUsage,
  resolveTracer,
  sessionSpanContext,
} from "@oh-my-opencode/otel-core"
import type { Attributes } from "@opentelemetry/api"
import { isRealUserTextPart, stripInternalInitiatorMarkers } from "../shared/internal-initiator-marker"
import { log } from "../shared/logger"
import { normalizeSDKResponse } from "../shared/normalize-sdk-response"

const MAX_TRACKED_MESSAGE_IDS = 5000
const recordedMessageIds = new Set<string>()
// Deduped by MESSAGE id, not sessionID. SessionSpanContext's root expires
// after DEFAULT_SESSION_IDLE_MS of inactivity — a long conversation with a
// gap longer than that gets a fresh root (a new trace) for its next turn.
// Deduping by sessionID forever would permanently block that next turn from
// ever re-establishing user.prompt as the new root (observed live: the same
// session.id later resumed under a brand new TraceId with only an anonymous
// session.turn root, never user.prompt again). Per-message dedup still
// prevents reprocessing the same message if message.updated fires more than
// once for it, while letting every new message get its own chance.
const recordedFirstPromptMessageIds = new Set<string>()

// Prompt/response text is genuinely sensitive (QA-05 in the original design
// doc says span attributes should NOT carry raw prompt/code content) — this
// capture is opt-in-by-request (the user explicitly asked to see it in
// Jaeger) and every value is truncated so a huge message can't balloon
// ClickHouse/Jaeger storage or make the trace UI unusable.
const MAX_TEXT_ATTRIBUTE_LENGTH = 4000

function shouldRecord(messageId: string): boolean {
  if (recordedMessageIds.has(messageId)) return false
  if (recordedMessageIds.size >= MAX_TRACKED_MESSAGE_IDS) {
    recordedMessageIds.clear()
  }
  recordedMessageIds.add(messageId)
  return true
}

function shouldCaptureFirstPrompt(messageId: string): boolean {
  if (recordedFirstPromptMessageIds.has(messageId)) return false
  if (recordedFirstPromptMessageIds.size >= MAX_TRACKED_MESSAGE_IDS) {
    recordedFirstPromptMessageIds.clear()
  }
  recordedFirstPromptMessageIds.add(messageId)
  return true
}

type AssistantMessageInfo = {
  readonly id?: unknown
  readonly parentID?: unknown
  readonly providerID?: unknown
  readonly modelID?: unknown
  readonly cost?: unknown
  readonly tokens?: {
    readonly input?: unknown
    readonly output?: unknown
    readonly reasoning?: unknown
  }
  readonly time?: {
    readonly created?: unknown
    readonly completed?: unknown
  }
}

export type OpencodeMessagesClient = {
  readonly session: {
    readonly messages: (input: { readonly path: { readonly id: string } }) => Promise<unknown>
    readonly get?: (input: { readonly path: { readonly id: string } }) => Promise<unknown>
  }
}

// Ceiling for the event-driven wait below. Sync delegation's bindRoot() runs
// synchronously right after session creation (a handful of ms is plenty),
// but BACKGROUND delegation (delegate-task/background-task.ts,
// call-omo-agent/background-executor.ts) binds root only after
// waitForBackgroundSessionStart() reports the session as started — a
// poll loop at WAIT_FOR_SESSION_INTERVAL_MS=100ms with
// WAIT_FOR_SESSION_TIMEOUT_MS=60000ms (see tools/delegate-task/timing.ts),
// and in practice observed to run noticeably longer than that (model
// fallback retries after a quota error, each restarting its own
// session-creation wait — on the order of ~2 minutes live). A fixed retry
// schedule tuned for the common case kept losing that race for slower
// background dispatches. Since every caller here is fire-and-forget (this
// whole capture path runs via `void captureFirstUserPrompt(...)` from
// event.ts), there's no tool-execution latency at stake in waiting — so
// instead of polling on a schedule, wait on the actual event
// (sessionSpanContext.waitForBind resolves the instant bindRoot() fires)
// with a generous ceiling as a backstop for the case bindRoot() never comes.
//
// This ceiling lives in otel-core (shared) because hook.execute/gen_ai spans
// (tool-span-tracker.ts, recordGenAiCompletionSpan below) need the SAME
// value via markPendingBind/getContextAwaitingPendingBind — they have no
// cheap way to run isDelegatedSubSession themselves, so they instead just
// check the pending marker THIS function sets while it waits.
function rootRaceMaxWaitMs(): number {
  return getPendingBindMaxWaitMs()
}

/** @internal test-only: override the wait ceiling so race tests don't have
 * to wait out several real minutes. Thin wrapper over otel-core's shared
 * value, kept under this name so existing tests don't need to change. */
export function __setRootRaceRetryDelaysForTesting(maxWaitMs: number): void {
  __setPendingBindMaxWaitForTesting(maxWaitMs)
}

/** @internal test-only: restore the production wait ceiling. */
export function __resetRootRaceRetryDelaysForTesting(): void {
  __resetPendingBindMaxWaitForTesting()
}

async function isDelegatedSubSession(client: OpencodeMessagesClient, sessionID: string): Promise<boolean> {
  if (typeof client.session.get !== "function") return false
  try {
    const raw = await client.session.get({ path: { id: sessionID } })
    const data = normalizeSDKResponse<{ readonly parentID?: unknown }>(raw, {})
    return typeof data?.parentID === "string" && data.parentID.length > 0
  } catch {
    return false
  }
}

type SDKMessagePart = { readonly type?: unknown; readonly text?: unknown; readonly synthetic?: unknown }
type SDKMessage = {
  readonly id?: unknown
  readonly info?: { readonly id?: unknown; readonly parentID?: unknown; readonly role?: unknown; readonly sessionID?: unknown }
  readonly parts?: readonly SDKMessagePart[]
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT_ATTRIBUTE_LENGTH ? text : `${text.slice(0, MAX_TEXT_ATTRIBUTE_LENGTH)}…[truncated]`
}

const INJECTED_DIRECTIVE_SEPARATOR = "\n\n---\n\n"

// The keyword-detector hook prepends mode directives into the user's own
// text part as `${directives}\n\n---\n\n${originalText}` (see
// hooks/keyword-detector/hook.ts:241), with the separator appended *last*,
// after joining all directive messages. The directive bodies themselves
// (packages/prompts-core/prompts/ultrawork/*.md) turned out to contain their
// own standalone "---" markdown rules, so the FIRST occurrence of the
// separator can land inside the banner instead of at the real boundary —
// that's why a raw banner kept surviving. The hook's own appended separator
// is always the LAST one in the string (barring a user message that itself
// contains "\n\n---\n\n", an accepted rare edge case), so search from the end.
function stripInjectedDirectives(text: string): string {
  const separatorIndex = text.lastIndexOf(INJECTED_DIRECTIVE_SEPARATOR)
  if (separatorIndex === -1) return text
  const stripped = text.slice(separatorIndex + INJECTED_DIRECTIVE_SEPARATOR.length).trim()
  return stripped.length > 0 ? stripped : text
}

const USER_REQUEST_WRAPPER_PATTERN = /<user-request>\s*([\s\S]*?)\s*<\/user-request>/i

// Slash commands / skills (e.g. "/init-deep ulw") get expanded into a much
// larger constructed prompt: the invoked skill's own instructions wrapped in
// <skill-instruction>...</skill-instruction> (often a long template — see
// tools/skill/skill-body.ts), followed by the human's actual typed argument
// wrapped in <user-request>...</user-request> — the SAME convention
// hooks/start-work/parse-user-request.ts already relies on for its own
// parsing. Extracting just the <user-request> inner text is what actually
// reflects what the human typed; the skill-instruction dump is synthetic
// template content that swamped the truncation budget and buried it.
function extractUserRequestWrapper(text: string): string {
  const match = text.match(USER_REQUEST_WRAPPER_PATTERN)
  if (!match) return text
  const inner = match[1]?.trim()
  return inner && inner.length > 0 ? inner : text
}

const AUTO_SLASH_COMMAND_TAG_OPEN_MARKER = "<auto-slash-command>"
const AUTO_SLASH_COMMAND_TAG_CLOSE_MARKER = "</auto-slash-command>"
const AUTO_SLASH_COMMAND_TAG_PATTERN = /<\/?auto-slash-command>/gi
// executor.ts's formatCommandTemplate() always puts the human's raw
// arguments last, under a "## User Request" heading, when any arguments were
// given (hooks/auto-slash-command/executor.ts:117-121) — everything before
// that (command name, description, scope, then the full "## Command
// Instructions" template body) is synthetic. This is a THIRD, independent
// wrapping mechanism from extractUserRequestWrapper's <user-request> tags
// and stripInjectedDirectives' mode-directive banner — a general slash
// command (e.g. "/init-deep ulw") uses this one instead, wrapped in
// <auto-slash-command>...</auto-slash-command> (hooks/auto-slash-command/hook.ts).
const AUTO_SLASH_COMMAND_USER_REQUEST_PATTERN = /##\s*User Request\s*\n+([\s\S]*?)(?:<\/auto-slash-command>|$)/i

function extractAutoSlashCommandUserRequest(text: string): string {
  if (!text.includes(AUTO_SLASH_COMMAND_TAG_CLOSE_MARKER) && !text.includes(AUTO_SLASH_COMMAND_TAG_OPEN_MARKER)) {
    return text
  }
  const match = text.match(AUTO_SLASH_COMMAND_USER_REQUEST_PATTERN)
  const inner = match?.[1]?.trim()
  if (inner && inner.length > 0) return inner
  // No "## User Request" section — the command was invoked with no free-text
  // argument, so there's nothing more specific to extract. Just drop the
  // wrapper tags rather than showing the raw <auto-slash-command> markup.
  return text.replace(AUTO_SLASH_COMMAND_TAG_PATTERN, "").trim()
}

// Applied everywhere a captured prompt is about to be stored/displayed, in
// order from outermost wrapper to innermost: a general slash command's
// <auto-slash-command> template (down to its "## User Request" section),
// then a skill's <user-request> tag (discarding its <skill-instruction>
// dump), then any mode directive banner left in what remains — covers a
// message wrapped by any one of these, or several at once.
function cleanCapturedPromptText(text: string): string {
  return stripInjectedDirectives(extractUserRequestWrapper(extractAutoSlashCommandUserRequest(text)))
}

// A part only counts as "real user input" when it's neither flagged
// `synthetic: true` nor carries the OMO_INTERNAL_INITIATOR marker — internal
// delegation/continuation prompts use that marker specifically so display
// code can tell them apart from what a human actually typed (see
// packages/utils/src/internal-initiator-marker.ts). Stripping the marker
// text itself (stripInternalInitiatorMarkers) also covers the fallback pass,
// where an internal-only message is still shown but without the raw HTML
// comment leaking into the displayed prompt.
function joinTextParts(parts: readonly SDKMessagePart[], excludeSynthetic: boolean): string {
  return parts
    .filter((p): p is SDKMessagePart & { text: string } => p?.type === "text" && typeof p.text === "string")
    .filter((p) => !excludeSynthetic || isRealUserTextPart({ type: "text", text: p.text, synthetic: p.synthetic === true }))
    .map((p) => stripInternalInitiatorMarkers(p.text))
    .join("\n")
    .trim()
}

function extractText(message: SDKMessage | undefined): string | undefined {
  const parts = message?.parts
  if (!Array.isArray(parts)) return undefined
  // Prefer the human-typed parts; fall back to synthetic/internal ones so
  // internally dispatched prompts (e.g. subagent task prompts) still surface
  // when there's no real human text to show instead.
  const text = joinTextParts(parts, true) || joinTextParts(parts, false)
  if (text.length === 0) return undefined
  return truncate(cleanCapturedPromptText(text))
}

// sessionID → prompt text captured at LLM-request time (see
// captureOutgoingPrompt). Bounded like recordedMessageIds.
const lastOutgoingPromptBySession = new Map<string, string>()

type OutgoingMessage = { readonly info?: { readonly role?: unknown; readonly sessionID?: unknown }; readonly parts?: readonly SDKMessagePart[] }

/**
 * Called from experimental.chat.messages.transform — the hook that fires
 * with the full outgoing message array every time an LLM request is made.
 * Captures the latest user message's text as "the prompt for this call",
 * synchronously and directly from the request payload, so
 * gen_ai.completion spans show the prompt that actually drove each call
 * (per turn) instead of a parentID lookup that resolves every loop step
 * back to the session's first message.
 */
export function captureOutgoingPrompt(messages: readonly OutgoingMessage[]): void {
  try {
    if (!Array.isArray(messages)) return
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message?.info?.role !== "user") continue
      const sessionID = typeof message.info.sessionID === "string" ? message.info.sessionID : undefined
      const parts = Array.isArray(message.parts) ? message.parts : []
      const text = joinTextParts(parts, true) || joinTextParts(parts, false)
      if (!sessionID || text.length === 0) continue
      if (lastOutgoingPromptBySession.size >= MAX_TRACKED_MESSAGE_IDS) {
        lastOutgoingPromptBySession.clear()
      }
      lastOutgoingPromptBySession.set(sessionID, truncate(cleanCapturedPromptText(text)))
      return
    }
  } catch (error) {
    log("[otel] failed to capture outgoing prompt", { error })
  }
}

function messageId(message: SDKMessage): string | undefined {
  const id = message.id ?? message.info?.id
  return typeof id === "string" ? id : undefined
}

async function fetchPromptAndResponseText(
  client: OpencodeMessagesClient,
  sessionID: string,
  assistantMessageId: string,
  parentId: string | undefined,
): Promise<{ prompt?: string; response?: string }> {
  try {
    const raw = await client.session.messages({ path: { id: sessionID } })
    const messages = normalizeSDKResponse<SDKMessage[]>(raw, [])
    if (!Array.isArray(messages)) return {}

    const assistantMessage = messages.find((m) => messageId(m) === assistantMessageId)
    const response = extractText(assistantMessage)

    const resolvedParentId = parentId ?? (typeof assistantMessage?.info?.parentID === "string" ? assistantMessage.info.parentID : undefined)
    const promptMessage = resolvedParentId ? messages.find((m) => messageId(m) === resolvedParentId) : undefined
    const prompt = extractText(promptMessage)

    return { prompt, response }
  } catch (error) {
    log("[otel] failed to fetch prompt/response text for gen_ai span", { error })
    return {}
  }
}

/**
 * Records the actual LLM request/response as a gen_ai span — distinct from
 * agent.execute (agent delegation) spans, which represent a hand-off event,
 * not token/cost usage. Uses OpenCode's own reported AssistantMessage.cost
 * and .tokens (no re-derivation), captured once the message truly finishes.
 *
 * The attribute names (gen_ai.usage.input_tokens/output_tokens/total_tokens/
 * cost, gen_ai.system, gen_ai.request.model) match exactly what OpenLIT's
 * bundled dashboards query directly off raw span data — see
 * omo-observability/openlit-seed-data/openlit-dashboard-LLM-dashboard-layout.json.
 *
 * When `client` is provided, also fetches and attaches the prompt/response
 * text (gen_ai.prompt / gen_ai.completion), truncated — see the note above.
 */
export async function recordGenAiCompletionSpan(
  info: AssistantMessageInfo,
  sessionID: string,
  client?: OpencodeMessagesClient,
): Promise<void> {
  try {
    const id = typeof info.id === "string" ? info.id : undefined
    const parentID = typeof info.parentID === "string" ? info.parentID : undefined
    const modelID = typeof info.modelID === "string" ? info.modelID : undefined
    const providerID = typeof info.providerID === "string" ? info.providerID : undefined
    const inputTokens = num(info.tokens?.input)
    const outputTokens = num(info.tokens?.output)
    const reasoningTokens = num(info.tokens?.reasoning)
    const cost = num(info.cost)
    const createdMs = num(info.time?.created)
    const completedMs = num(info.time?.completed)

    if (!id || !modelID || inputTokens === undefined || outputTokens === undefined) return
    if (!shouldRecord(id)) return

    const fetched = client ? await fetchPromptAndResponseText(client, sessionID, id, parentID) : {}
    // Prefer the prompt captured directly at LLM-request time; the fetched
    // parentID lookup is only a fallback (it resolves every agentic-loop
    // step back to the session's first message).
    const prompt = lastOutgoingPromptBySession.get(sessionID) ?? fetched.prompt
    const response = fetched.response

    const totalTokens = inputTokens + outputTokens + (reasoningTokens ?? 0)
    const attributes: Attributes = {
      "gen_ai.operation.name": "chat",
      "gen_ai.system": providerID ?? "unknown",
      "gen_ai.request.model": modelID,
      "gen_ai.usage.input_tokens": inputTokens,
      "gen_ai.usage.output_tokens": outputTokens,
      "gen_ai.usage.total_tokens": totalTokens,
      ...(cost !== undefined ? { "gen_ai.usage.cost": cost } : {}),
      ...(reasoningTokens !== undefined ? { "gen_ai.usage.reasoning_tokens": reasoningTokens } : {}),
      // A string (not the raw numeric token count) specifically so it can be
      // promoted as a low-cardinality spanmetrics dimension — Grafana's KPI
      // dashboard computes a "CoT capture rate" as a ratio of spans, which
      // needs a boolean-ish label to filter/group by, not a high-cardinality
      // number.
      "gen_ai.reasoning_present": reasoningTokens !== undefined && reasoningTokens > 0 ? "true" : "false",
      ...(prompt ? { "gen_ai.prompt": prompt } : {}),
      ...(response ? { "gen_ai.completion": response } : {}),
    }

    // Same numbers as the span attributes above, also recorded as OTLP
    // counters — spans answer "what happened on this call"; these answer
    // "what's the total/rate over time" for the Cost & Token / KPI
    // dashboards, which query Prometheus rather than scanning ClickHouse.
    recordGenAiUsage({ model: modelID, inputTokens, outputTokens, totalTokens, cost })

    // Awaits the pending-bind marker (set by captureFirstUserPrompt while it
    // waits on a delegated sub-agent's bindRoot) instead of a plain
    // getContext() — safe to wait here since this whole function is already
    // fire-and-forget from event.ts (`void recordGenAiCompletionSpan(...)`),
    // so there's no tool-execution latency to protect.
    const parentContext = await sessionSpanContext.getContextAwaitingPendingBind(sessionID)
    const span = resolveTracer().startSpan(
      `gen_ai.completion.${modelID}`,
      { attributes, ...(createdMs !== undefined ? { startTime: createdMs } : {}) },
      parentContext,
    )
    // gen_ai.prompt/gen_ai.completion also live as plain attributes above (for
    // direct ClickHouse/OpenLIT querying), but sitting side by side with
    // numeric usage attributes makes them hard to tell apart at a glance in
    // Jaeger's flat attribute list. Span events give each its own clearly
    // named, separately timestamped entry in the "Logs" panel instead.
    if (prompt) span.addEvent("gen_ai.user.message", { content: prompt }, createdMs)
    if (response) span.addEvent("gen_ai.assistant.message", { content: response }, completedMs ?? Date.now())
    span.end(completedMs ?? Date.now())
  } catch (error) {
    log("[otel] failed to record gen_ai completion span", { error })
  }
}

type UserMessageInfo = {
  readonly id?: unknown
  readonly time?: {
    readonly created?: unknown
  }
}

/**
 * Records a user-role message as either the trace's root span (`user.prompt`)
 * or, for a delegated sub-agent session, a child of the dispatching
 * `agent.execute.*` span (`agent.prompt`).
 *
 * Runs once per MESSAGE (not once per session — see the dedup Set's comment).
 * Every REAL top-level (non-delegated) user turn gets its OWN trace: turn 2,
 * 3, ... each start a brand-new `user.prompt` root instead of nesting under
 * the previous turn's still-alive root, so a multi-prompt session shows up
 * in Jaeger as several distinct traces rather than one trace that keeps
 * accumulating every turn. This also naturally covers the case where the
 * previous root already expired from 10 minutes of inactivity
 * (`DEFAULT_SESSION_IDLE_MS`) — that path now looks identical to "explicitly
 * start a new turn" instead of needing separate handling.
 *
 * If a root already exists for a DELEGATED sub-agent session (bound via
 * `bindRoot()` to its dispatching `agent.execute.*` span — see
 * delegate-task/call-omo-agent), this attaches a child named `agent.prompt`
 * instead: the text a sub-agent receives is NOT something the human typed
 * (it's the orchestrator's own delegation prompt, e.g. "This is a test
 * invocation. Respond with..."), so it's kept visually distinct from real
 * human input. A delegated session's root is NEVER forcibly released here —
 * only the dispatching `agent.execute.*` span (via bindRoot) owns that
 * lifecycle.
 *
 * A THIRD case, orthogonal to isDelegated: the message can arrive on the
 * TOP-LEVEL session itself but carry no real human text at all — e.g. a
 * background task's completion notice, injected via
 * `createInternalAgentTextPart` (background-agent/parent-wake-prompt-dispatch.ts)
 * as a `<system-reminder>[BACKGROUND TASK COMPLETED]...` user-role message so
 * the agent picks it up as its next turn. That marker is exactly what
 * `joinTextParts(parts, true)` already filters out — if filtering it leaves
 * nothing, this message has no genuine human content (`hasRealUserText`
 * below). Observed live: without this check, the per-turn trace-separation
 * logic above treated it like any other new human turn — forcing a fresh
 * `user.prompt` root for a message the user never typed. Such a message
 * never forces a new trace (no `release()`) and never gets the `user.prompt`
 * name; it rides along on whatever root is already active, falling back to
 * the generic `session.turn` stamp only if none exists (e.g. the previous
 * root already expired).
 *
 * bindRoot() for a sub-agent session always runs synchronously right after
 * its sessionID is known, strictly before the delegating tool sends that
 * session's first prompt — but this function's own async message fetch can
 * still occasionally resolve first (observed live: a handful of sub-agent
 * test-invocation prompts each landed in their own orphaned single-span
 * trace instead of nesting under agent.execute.*). When the session turns
 * out to have a parentID and no root is bound yet, wait for that bindRoot()
 * event before deciding — see rootRaceMaxWaitMs's comment for why this is
 * an event-driven wait with a generous ceiling rather than a short retry.
 */
export async function captureFirstUserPrompt(
  info: UserMessageInfo,
  sessionID: string,
  client?: OpencodeMessagesClient,
): Promise<void> {
  try {
    if (!client) return
    const id = typeof info.id === "string" ? info.id : undefined
    if (!id) return
    if (!shouldCaptureFirstPrompt(id)) return

    const raw = await client.session.messages({ path: { id: sessionID } })
    const messages = normalizeSDKResponse<SDKMessage[]>(raw, [])
    if (!Array.isArray(messages)) return

    const userMessage = messages.find((m) => messageId(m) === id)
    const prompt = extractText(userMessage)
    if (!prompt) return

    // Whether this message has any genuinely human-typed text, as opposed to
    // being entirely synthetic/internal (background-wake notifications,
    // compaction continuations, etc. — see the doc comment above). Mirrors
    // extractText's own "prefer real, fall back to synthetic" precedence:
    // `prompt` may still be non-empty here via that fallback even when this
    // is false.
    const messageParts = Array.isArray(userMessage?.parts) ? userMessage.parts : []
    const hasRealUserText = joinTextParts(messageParts, true).length > 0

    // Whether `id` is the session's chronologically first message (vs a
    // later turn of an already-live conversation) — the only way to tell
    // apart, for a NON-delegated session with an existing root, "an unrelated
    // span raced ahead of this genuinely-first message" (should still surface
    // as a child) from "this is turn 2/3/... of an ongoing chat" (already
    // covered by gen_ai.completion's own gen_ai.prompt; skip). A session's
    // history always opens with the user's own message, so the first entry
    // client.session.messages() returns is that message — no role field
    // needed (and not always present on every message shape seen in practice).
    const isSessionsFirstMessage = messages.length > 0 && messageId(messages[0]) === id

    // Always determined (not just when a root is missing) — needed below to
    // decide whether an *existing* root means "later turn of the same
    // top-level conversation" (skip) or "bound to a delegating agent.execute
    // span" (attach as agent.prompt). Only worth the extra RPC when there's
    // actually a decision to make; shouldCaptureFirstPrompt already limits
    // this to once per distinct message.
    const isDelegated = await isDelegatedSubSession(client, sessionID)
    if (isDelegated && !sessionSpanContext.hasRoot(sessionID)) {
      // Mark this session as awaiting a bind so hook.execute/gen_ai code
      // (which has no cheap way to run the isDelegatedSubSession check
      // itself) knows to wait too, instead of eagerly stamping its own
      // generic root the instant it sees none yet — see
      // getContextAwaitingPendingBind's doc comment for why that matters.
      sessionSpanContext.markPendingBind(sessionID)
      const waitStartedAt = Date.now()
      try {
        await sessionSpanContext.waitForBind(sessionID, rootRaceMaxWaitMs())
      } finally {
        sessionSpanContext.clearPendingBind(sessionID)
      }
      // @debug-temp: pin down a live orphan-trace repro (delegated session
      // still has no bound root after the wait) — remove once root-caused.
      if (!sessionSpanContext.hasRoot(sessionID)) {
        log("[otel][debug] pending-bind wait ended WITHOUT a bound root", {
          sessionID,
          messageID: id,
          waitedMs: Date.now() - waitStartedAt,
        })
      }
    }

    // Every later turn of a non-delegated (top-level) conversation gets its
    // OWN trace: force the next getOrCreateNamedRootContext call below to
    // create a fresh root instead of reusing the previous turn's still-alive
    // one. Delegated sub-agent sessions are untouched — their root lifecycle
    // belongs entirely to bindRoot()/the dispatching agent.execute.* span,
    // never to this per-turn release. Entirely-synthetic messages (no real
    // human text) are ALSO excluded: a background-wake notification isn't a
    // new "turn" from the user's perspective, so it must not fork a new
    // trace — it stays attached to whatever root is already active.
    if (!isDelegated && !isSessionsFirstMessage && hasRealUserText) {
      sessionSpanContext.release(sessionID)
    }

    const createdMs = num(info.time?.created)
    const attributes: Attributes = { "gen_ai.prompt": prompt, "session.id": sessionID }
    // Named by isDelegated/hasRealUserText even in the create-a-new-root
    // case:
    // - isDelegated but bindRoot() never arrived even after the full retry
    //   above (the timeout fallback): self-rooting it as "user.prompt" would
    //   mislabel a synthetic delegation prompt as real human input — exactly
    //   what was observed live for a background sub-agent test prompt
    //   ("Return a simple JSON response...") that ended up as its own
    //   standalone "user.prompt"-rooted trace instead of "agent.prompt".
    // - !hasRealUserText (and not delegated): a background-wake notification
    //   arriving after the previous root already expired. Falls back to the
    //   generic anonymous `session.turn` stamp rather than "user.prompt" —
    //   observed live: a "<system-reminder>[BACKGROUND TASK COMPLETED]..."
    //   notification became a brand-new root literally named "user.prompt"
    //   with that synthetic text as its prompt, indistinguishable in Jaeger
    //   from something the human actually typed.
    const rootName = isDelegated ? "agent.prompt" : hasRealUserText ? "user.prompt" : "session.turn"
    const { context: parentContext, created } = sessionSpanContext.getOrCreateNamedRootContext(
      sessionID,
      rootName,
      undefined,
      attributes,
      createdMs,
    )
    if (created) {
      // This call established the root — the session's true first message,
      // the start of a brand-new per-turn trace (the release above just
      // cleared the previous turn's root), or (rootName === "agent.prompt")
      // a delegated sub-agent whose bindRoot() never arrived within the
      // retry window. It already IS the stamp with the prompt attribute
      // attached, so there's nothing further to record.
      return
    }

    if (!isDelegated && !isSessionsFirstMessage) {
      // Unreachable in practice: the release() above guarantees the call
      // just above always creates a fresh root for this case, so `created`
      // is always true here. Kept as a defensive no-op in case release()
      // and getOrCreateNamedRootContext's existing-root check ever drift.
      return
    }

    // Either a delegated sub-session (root bound to its dispatching
    // agent.execute span) or a non-delegated session whose genuine first
    // message lost the root race to an unrelated span — either way, attach
    // a visible child, reusing the same name resolved above.
    const span = resolveTracer().startSpan(
      rootName,
      {
        attributes,
        ...(createdMs !== undefined ? { startTime: createdMs } : {}),
      },
      parentContext,
    )
    span.end(createdMs ?? Date.now())
  } catch (error) {
    log("[otel] failed to capture first user prompt", { error })
  }
}
