import { resolveTracer, sessionSpanContext } from "@oh-my-opencode/otel-core"
import type { Attributes } from "@opentelemetry/api"
import { isRealUserTextPart, stripInternalInitiatorMarkers } from "../shared/internal-initiator-marker"
import { log } from "../shared/logger"
import { normalizeSDKResponse } from "../shared/normalize-sdk-response"

const MAX_TRACKED_MESSAGE_IDS = 5000
const recordedMessageIds = new Set<string>()
const recordedFirstPromptSessionIds = new Set<string>()

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

function shouldCaptureFirstPrompt(sessionID: string): boolean {
  if (recordedFirstPromptSessionIds.has(sessionID)) return false
  if (recordedFirstPromptSessionIds.size >= MAX_TRACKED_MESSAGE_IDS) {
    recordedFirstPromptSessionIds.clear()
  }
  recordedFirstPromptSessionIds.add(sessionID)
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
 * Records the first user-role message of a session, making it the trace's
 * root span (named `user.prompt`) whenever this call wins the race to
 * create the session — which is the common case for a top-level session,
 * since this fires right as the human's message lands, before any tool/agent
 * span could exist yet. Being the root means it's guaranteed to render first
 * in the trace waterfall, not nested under a generic stamp.
 *
 * If some other span already created the root first (`created` is false),
 * this attaches a child instead — that stamp has already ended and can't be
 * renamed or amended. In practice this fallback path is what fires for a
 * DELEGATED sub-agent session: its root was already bound to the dispatching
 * `agent.execute.*` span (see delegate-task/call-omo-agent) before this
 * async fetch resolves, every single time. The text a sub-agent received is
 * NOT something the human typed (it's the orchestrator's own delegation
 * prompt, e.g. "This is a test invocation. Respond with...") — naming this
 * fallback span `agent.prompt` instead of `user.prompt` keeps that visually
 * distinct in Jaeger, instead of every sub-agent hop looking like a second
 * human message.
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
    if (!shouldCaptureFirstPrompt(sessionID)) return

    const raw = await client.session.messages({ path: { id: sessionID } })
    const messages = normalizeSDKResponse<SDKMessage[]>(raw, [])
    if (!Array.isArray(messages)) return

    const userMessage = messages.find((m) => messageId(m) === id)
    const prompt = extractText(userMessage)
    if (!prompt) return

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
      // This call created the session's root — it already IS the
      // "user.prompt" stamp with the prompt attribute attached, so there's
      // nothing further to record.
      return
    }

    // Some other span raced ahead and already created the root — in
    // practice, always a sub-agent session whose root is the dispatching
    // agent.execute span (see doc comment above). Name it agent.prompt so
    // it reads as "what this agent received", not "what the human typed".
    const span = resolveTracer().startSpan(
      "agent.prompt",
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
