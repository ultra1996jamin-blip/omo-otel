import { context, ROOT_CONTEXT, trace, type Attributes, type Context, type SpanContext } from "@opentelemetry/api"
import { resolveTracer } from "./context"

export const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000

// Ceiling for waitForBind() below. A fixed short retry schedule turned out
// to be the wrong tool: real background delegations can take on the order
// of MINUTES to actually start (model fallback retries after a quota error,
// each restarting its own session-creation wait — see
// tools/delegate-task/timing.ts's WAIT_FOR_SESSION_TIMEOUT_MS=60000, and
// live observation of a background task retrying to a fallback model that
// took noticeably longer than that). Every caller of waitForBind is
// fire-and-forget (never awaited by whatever triggered it — see
// captureFirstUserPrompt, recordGenAiCompletionSpan, and
// tool-span-tracker.ts's start(), all called `void`-style) and the wait
// itself is event-driven (resolves the instant bindRoot() fires, not on a
// poll timer), so there's no real cost to a generous ceiling: nothing
// user-facing is blocked, and no CPU is spent while idly waiting. A single
// shared, mutable value (not a hardcoded literal per call site) so every
// caller stays in sync and tests can shrink it.
let pendingBindMaxWaitMs = 3 * 60 * 1000

export function getPendingBindMaxWaitMs(): number {
  return pendingBindMaxWaitMs
}

/** @internal test-only: override the shared ceiling so race tests don't have
 * to wait out several real minutes. */
export function __setPendingBindMaxWaitForTesting(maxWaitMs: number): void {
  pendingBindMaxWaitMs = maxWaitMs
}

/** @internal test-only: restore the production ceiling. */
export function __resetPendingBindMaxWaitForTesting(): void {
  pendingBindMaxWaitMs = 3 * 60 * 1000
}

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
  // Sessions currently known to be delegated sub-agents whose root hasn't
  // been bound yet (see markPendingBind doc comment below).
  private readonly pendingBinds = new Set<string>()
  // Callbacks to fire the instant bindRoot() lands for a given sessionID —
  // event-driven, not polled. See waitForBind().
  private readonly bindWaiters = new Map<string, Array<() => void>>()

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
    this.pendingBinds.delete(sessionID)
    const waiters = this.bindWaiters.get(sessionID)
    if (waiters) {
      this.bindWaiters.delete(sessionID)
      for (const notify of waiters) notify()
    }
  }

  /** Reports whether `sessionID` already has a bound/stamped root, without
   * creating one — a pure peek. Used to detect a delegation race: a
   * sub-agent session's root is normally bound (via bindRoot) moments after
   * its first message lands, but if a caller reaches getContext() first, it
   * would eagerly stamp a standalone root that the later bindRoot() call
   * then silently supersedes, leaving the stamp as an orphaned single-span
   * trace. Callers who know they're on a sub-agent session can use this to
   * wait briefly for the real bind instead. */
  hasRoot(sessionID: string): boolean {
    return this.roots.has(sessionID)
  }

  /** Marks `sessionID` as a delegated sub-agent session whose root is
   * expected to arrive via `bindRoot()` soon, but hasn't yet. Call this
   * before a caller-side retry loop (e.g. captureFirstUserPrompt's) starts
   * waiting for the bind, and clear it via `clearPendingBind()` once the
   * wait ends (bind arrived or gave up).
   *
   * This exists so OTHER span-creating call sites (hook.execute.*,
   * gen_ai.completion.*) — which have no cheap way to check "is this
   * sessionID a delegated sub-agent?" themselves, and can't afford to check
   * on every call without risking real tool-execution latency — can instead
   * do a single cheap `hasPendingBind()` Set lookup and only pay a short
   * wait in the specific case where a bind is actually expected. Without
   * this, those call sites would eagerly stamp their own generic root the
   * instant they see no root yet, permanently splitting the trace the
   * moment bindRoot() finally lands moments later (observed live for
   * BACKGROUND delegation specifically, whose bindRoot can lag well behind
   * session creation — see waitForBackgroundSessionStart in
   * tools/delegate-task/timing.ts). */
  markPendingBind(sessionID: string): void {
    this.pendingBinds.add(sessionID)
  }

  /** Clears the pending-bind marker for `sessionID` (bind arrived, or the
   * caller gave up waiting). Safe to call even if never marked. */
  clearPendingBind(sessionID: string): void {
    this.pendingBinds.delete(sessionID)
  }

  /** Resolves the instant `bindRoot(sessionID, ...)` is called, or after
   * `maxWaitMs` elapses, whichever comes first — event-driven, not polled,
   * so it costs nothing while waiting (no repeated checks). Resolves
   * immediately if the root already exists. Safe to await for a long
   * ceiling: every real caller is fire-and-forget (see
   * getContextAwaitingPendingBind's callers), so nothing user-facing is
   * blocked by a long wait here. */
  waitForBind(sessionID: string, maxWaitMs: number): Promise<void> {
    if (this.hasRoot(sessionID)) return Promise.resolve()
    return new Promise((resolve) => {
      const onBind = (): void => {
        clearTimeout(timer)
        resolve()
      }
      // Deliberately NOT unref'd, unlike scheduleTimer's idle-expiry timers:
      // this one gates a Promise every caller actually awaits (the whole
      // point of waitForBind), so it must reliably fire. scheduleTimer's
      // timers are pure fire-and-forget cleanup that nothing ever awaits, so
      // unref'ing those is safe; doing the same here was found (via a real
      // hang in this file's own tests) to silently stop this timer from ever
      // firing in at least one runtime, defeating the ceiling entirely. In
      // the real fire-and-forget production call sites (captureFirstUserPrompt
      // et al., all called `void`-style), other long-lived handles already
      // keep the process alive regardless, so this ref costs nothing extra
      // there; it only matters for the (short, test-controlled) ceiling here.
      const timer = setTimeout(() => {
        const waiters = this.bindWaiters.get(sessionID)
        if (waiters) {
          const idx = waiters.indexOf(onBind)
          if (idx >= 0) waiters.splice(idx, 1)
          if (waiters.length === 0) this.bindWaiters.delete(sessionID)
        }
        resolve()
      }, maxWaitMs)
      const list = this.bindWaiters.get(sessionID) ?? []
      list.push(onBind)
      this.bindWaiters.set(sessionID, list)
    })
  }

  /** Like `getContext`, but if `sessionID` has no root yet AND is marked
   * pending (see `markPendingBind`), waits for the real bind (event-driven,
   * up to `maxWaitMs`) before falling through to `getContext()`'s normal
   * auto-vivify behavior. Zero cost for the overwhelmingly common case (no
   * pending marker): resolves immediately, no wait at all. */
  async getContextAwaitingPendingBind(
    sessionID: string,
    maxWaitMs: number = pendingBindMaxWaitMs,
    idleMs = DEFAULT_SESSION_IDLE_MS,
    attributes?: Attributes,
    startTimeMs?: number,
  ): Promise<Context> {
    if (this.pendingBinds.has(sessionID) && !this.hasRoot(sessionID)) {
      await this.waitForBind(sessionID, maxWaitMs)
    }
    return this.getContext(sessionID, idleMs, attributes, startTimeMs)
  }

  /** Removes the mapping for `sessionID`. Never ends any span — there's
   * nothing to end; only a SpanContext is stored. */
  release(sessionID: string): void {
    const entry = this.roots.get(sessionID)
    this.pendingBinds.delete(sessionID)
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
    this.pendingBinds.clear()
    this.bindWaiters.clear()
  }
}

export const sessionSpanContext = new SessionSpanContext()
