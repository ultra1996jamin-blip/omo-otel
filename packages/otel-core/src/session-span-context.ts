import { context, ROOT_CONTEXT, trace, type Attributes, type Context, type SpanContext } from "@opentelemetry/api"
import { resolveTracer } from "./context"

export const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000

type SpanContextLike = { spanContext(): SpanContext }

type RootEntry = {
  readonly spanContext: SpanContext
  timer: ReturnType<typeof setTimeout>
}

function scheduleTimer(onExpire: () => void, idleMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(onExpire, idleMs)
  // Idle housekeeping must never keep the process alive on its own.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return timer
}

/**
 * Links spans that belong to the same session/turn into one trace.
 *
 * Separate hook.execute.before/after (and delegate-task) invocations don't
 * share a call stack, so ambient AsyncContext propagation alone can't
 * connect them — this registry remembers a SpanContext per session that
 * later spans attach to as their parent.
 *
 * A generic root is only *stamped*: started and ended immediately, so it
 * exports right away instead of staying open for up to `idleMs`. A long-open
 * root would otherwise arrive at the backend well after its (quick) children
 * do, which is exactly what produced Jaeger's "invalid parent span IDs —
 * skipping clock skew adjustment" warning. Only the resulting SpanContext is
 * kept, never the Span object — this registry never ends a span. A bound
 * root (e.g. an agent.execute span someone else owns) works the same way:
 * only its SpanContext is captured here; ending it remains the caller's job.
 */
export class SessionSpanContext {
  private readonly roots = new Map<string, RootEntry>()

  /** Returns the parent Context for `sessionID`, stamping a root span (named
   * `session.turn`) on first use if none exists or was bound. `attributes`
   * (e.g. the first user prompt) are only applied on that first stamp — a
   * later call with different attributes is a no-op if a root already
   * exists, since the stamp span has already ended and can't be amended.
   * `startTimeMs`, when given, backdates that first stamp (e.g. to the real
   * user message's `time.created`) instead of using "now" — the caller may
   * only reach this path after an async fetch, so "now" would otherwise
   * record the root as starting *after* a child span backdated to the
   * message's true creation time, producing an inverted parent/child
   * ordering in the trace waterfall. */
  getContext(sessionID: string, idleMs = DEFAULT_SESSION_IDLE_MS, attributes?: Attributes, startTimeMs?: number): Context {
    return trace.setSpanContext(
      context.active(),
      this.getOrCreateRootContext(sessionID, idleMs, attributes, startTimeMs).spanContext,
    )
  }

  /** Like `getContext`, but (a) names the very first stamp `rootName` instead
   * of the generic "session.turn", and (b) reports whether this call is the
   * one that actually created it. Used so the session's first user prompt
   * becomes the trace's root span — visible first in the waterfall — rather
   * than a child nested under a separate anonymous stamp. If some other span
   * (e.g. an early-firing hook) already raced in and created the root first,
   * `created` is false and the caller should attach its own child span
   * instead, since an already-ended stamp can't be renamed or amended. */
  getOrCreateNamedRootContext(
    sessionID: string,
    rootName: string,
    idleMs = DEFAULT_SESSION_IDLE_MS,
    attributes?: Attributes,
    startTimeMs?: number,
  ): { context: Context; created: boolean } {
    const { spanContext, created } = this.getOrCreateRootContext(sessionID, idleMs, attributes, startTimeMs, rootName)
    return { context: trace.setSpanContext(context.active(), spanContext), created }
  }

  private getOrCreateRootContext(
    sessionID: string,
    idleMs: number,
    attributes?: Attributes,
    startTimeMs?: number,
    rootName = "session.turn",
  ): { spanContext: SpanContext; created: boolean } {
    const existing = this.roots.get(sessionID)
    if (existing) {
      clearTimeout(existing.timer)
      existing.timer = scheduleTimer(() => this.roots.delete(sessionID), idleMs)
      return { spanContext: existing.spanContext, created: false }
    }

    // Explicit ROOT_CONTEXT, not the ambient context.active() — this stamp
    // must never inherit whatever span happens to be "active" in the caller's
    // async chain at this moment (e.g. an unrelated hook.execute still open
    // around the same message.updated handling), or the trace root ends up
    // with a bogus parent it doesn't actually have, breaking exactly the
    // guarantee this stamp exists to provide.
    const stamp = resolveTracer().startSpan(
      rootName,
      {
        attributes: { "session.id": sessionID, ...attributes } satisfies Attributes,
        ...(startTimeMs !== undefined ? { startTime: startTimeMs } : {}),
      },
      ROOT_CONTEXT,
    )
    stamp.end(startTimeMs)
    const spanContext = stamp.spanContext()
    this.roots.set(sessionID, {
      spanContext,
      timer: scheduleTimer(() => this.roots.delete(sessionID), idleMs),
    })
    return { spanContext, created: true }
  }

  /** Binds an externally-owned span (e.g. an agent.execute span) as the root
   * for `sessionID`, so descendants of that call attach under it. Only its
   * SpanContext is captured — the span's lifecycle remains the caller's
   * responsibility. */
  bindRoot(sessionID: string, span: SpanContextLike, idleMs = DEFAULT_SESSION_IDLE_MS): void {
    const existing = this.roots.get(sessionID)
    if (existing) clearTimeout(existing.timer)
    this.roots.set(sessionID, {
      spanContext: span.spanContext(),
      timer: scheduleTimer(() => this.roots.delete(sessionID), idleMs),
    })
  }

  /** Removes the mapping for `sessionID`. Never ends any span — there's
   * nothing to end; only a SpanContext is stored. */
  release(sessionID: string): void {
    const entry = this.roots.get(sessionID)
    if (!entry) return
    clearTimeout(entry.timer)
    this.roots.delete(sessionID)
  }

  /** @internal test-only: force-clear all roots without waiting on timers. */
  __resetForTesting(): void {
    for (const entry of this.roots.values()) {
      clearTimeout(entry.timer)
    }
    this.roots.clear()
  }
}

export const sessionSpanContext = new SessionSpanContext()
