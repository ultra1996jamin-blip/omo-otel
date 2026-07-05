import { resolveTracer, sessionSpanContext } from "@oh-my-opencode/otel-core"
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const ROOT_RACE_RETRY_DELAYS_MS = [20, 40, 60]

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
  return truncate(stripInjectedDirectives(text))
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
      lastOutgoingPromptBySession.set(sessionID, truncate(stripInjectedDirectives(text)))
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
      ...(prompt ? { "gen_ai.prompt": prompt } : {}),
      ...(response ? { "gen_ai.completion": response } : {}),
    }

    const parentContext = sessionSpanContext.getContext(sessionID)
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
 * Runs once per MESSAGE (not once per session — see the dedup Set's comment):
 * whenever `sessionSpanContext` currently has no root for this sessionID,
 * this call establishes one, named `user.prompt`. That covers both the
 * session's true first message AND a later message that arrives after the
 * previous root expired from 10 minutes of inactivity (`DEFAULT_SESSION_IDLE_MS`)
 * — otherwise that next turn would silently fall back to an anonymous
 * `session.turn` stamp with no visible prompt at all.
 *
 * If a root already exists for a DELEGATED sub-agent session (bound via
 * `bindRoot()` to its dispatching `agent.execute.*` span — see
 * delegate-task/call-omo-agent), this attaches a child named `agent.prompt`
 * instead: the text a sub-agent receives is NOT something the human typed
 * (it's the orchestrator's own delegation prompt, e.g. "This is a test
 * invocation. Respond with..."), so it's kept visually distinct from real
 * human input.
 *
 * If a root already exists for a NON-delegated (top-level) session, this is
 * just a later turn of a still-alive conversation (well within the idle
 * window) — intentionally not re-recorded here; that turn's prompt is
 * already covered by `gen_ai.completion`'s own `gen_ai.prompt` (captured at
 * LLM-call time, see `captureOutgoingPrompt`).
 *
 * bindRoot() for a sub-agent session always runs synchronously right after
 * its sessionID is known, strictly before the delegating tool sends that
 * session's first prompt — but this function's own async message fetch can
 * still occasionally resolve first (observed live: a handful of sub-agent
 * test-invocation prompts each landed in their own orphaned single-span
 * trace instead of nesting under agent.execute.*). When the session turns
 * out to have a parentID and no root is bound yet, briefly retry before
 * deciding — long enough for the synchronous bindRoot() call to land.
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
      for (const delayMs of ROOT_RACE_RETRY_DELAYS_MS) {
        if (sessionSpanContext.hasRoot(sessionID)) break
        await sleep(delayMs)
      }
    }

    const createdMs = num(info.time?.created)
    const attributes: Attributes = { "gen_ai.prompt": prompt, "session.id": sessionID }
    const { context: parentContext, created } = sessionSpanContext.getOrCreateNamedRootContext(
      sessionID,
      "user.prompt",
      undefined,
      attributes,
      createdMs,
    )
    if (created) {
      // This call established the root — either the session's true first
      // message, or the first message of a fresh trace segment after the
      // previous root expired. It already IS the "user.prompt" stamp with
      // the prompt attribute attached, so there's nothing further to record.
      return
    }

    if (!isDelegated && !isSessionsFirstMessage) {
      // A root already existed, this isn't a delegated sub-session, and this
      // isn't even the session's first message — a later turn of a
      // still-alive top-level conversation. Its prompt is covered separately
      // by gen_ai.completion's own gen_ai.prompt; adding another span here
      // would misleadingly look like a second person.
      return
    }

    // Either a delegated sub-session (root bound to its dispatching
    // agent.execute span) or a non-delegated session whose genuine first
    // message lost the root race to an unrelated span — either way, attach
    // a visible child. Only the delegated case is *not* the human speaking.
    const span = resolveTracer().startSpan(
      isDelegated ? "agent.prompt" : "user.prompt",
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
