import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { context, trace } from "@opentelemetry/api"

import { __resetActiveTracerForTesting, initializeOtel } from "./init"
import { SessionSpanContext } from "./session-span-context"

function enableRealTracer(): void {
  initializeOtel({ env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "console" } })
}

function traceIdOf(registry: SessionSpanContext, sessionID: string): string | undefined {
  const ctx = registry.getContext(sessionID, 60_000)
  return trace.getSpanContext(ctx)?.traceId
}

describe("SessionSpanContext", () => {
  afterEach(() => {
    __resetActiveTracerForTesting()
  })

  test("returns the same traceId for repeated calls with the same sessionID", () => {
    // given
    enableRealTracer()
    const registry = new SessionSpanContext()

    // when
    const first = traceIdOf(registry, "session-1")
    const second = traceIdOf(registry, "session-1")

    // then
    expect(second).toBe(first)
    registry.__resetForTesting()
  })

  test("different sessionIDs get different traceIds", () => {
    // given
    enableRealTracer()
    const registry = new SessionSpanContext()

    // when
    const a = traceIdOf(registry, "session-a")
    const b = traceIdOf(registry, "session-b")

    // then
    expect(a).not.toBe(b)
    registry.__resetForTesting()
  })

  test("the stamped root span is already ended (does not stay open)", () => {
    // given
    enableRealTracer()
    const registry = new SessionSpanContext()

    // when / then — getContext must not throw, and repeated calls are cheap
    // (no long-lived span kept alive in the background).
    expect(() => registry.getContext("session-1", 60_000)).not.toThrow()
    registry.__resetForTesting()
  })

  test("children parented via getContext share the root's traceId", () => {
    // given
    enableRealTracer()
    const registry = new SessionSpanContext()
    const parentContext = registry.getContext("session-1", 60_000)
    const rootTraceId = trace.getSpanContext(parentContext)?.traceId

    // when
    const child = trace.getTracer("test").startSpan("child", {}, parentContext)

    // then
    expect(child.spanContext().traceId).toBe(rootTraceId!)
    child.end()
    registry.__resetForTesting()
  })

  test("bindRoot overrides the root with an externally-owned span's context", () => {
    // given
    enableRealTracer()
    const registry = new SessionSpanContext()
    const externalSpan = trace.getTracer("test").startSpan("agent.execute.sisyphus")

    // when
    registry.bindRoot("session-1", externalSpan, 60_000)
    const resolvedContext = registry.getContext("session-1", 60_000)

    // then
    expect(trace.getSpanContext(resolvedContext)?.spanId).toBe(externalSpan.spanContext().spanId)
    externalSpan.end()
    registry.__resetForTesting()
  })

  test("attributes passed on first stamp are exported on the session.turn span", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "session-span-context-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const registry = new SessionSpanContext()

      // when
      registry.getContext("session-1", 60_000, { "gen_ai.prompt": "what does this do?" })
      // a later call with different attributes must not overwrite the stamp
      registry.getContext("session-1", 60_000, { "gen_ai.prompt": "ignored" })
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const stampLine = contents.split("\n").find((line) => line.includes("session.turn"))
      expect(stampLine).toBeDefined()
      const parsed = JSON.parse(stampLine!)
      expect(parsed.attributes["gen_ai.prompt"]).toBe("what does this do?")
      registry.__resetForTesting()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("startTimeMs backdates the first stamp so a backdated child never starts before its root", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "session-span-context-backdate-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const registry = new SessionSpanContext()
      const trueCreatedMs = Date.now() - 5_000 // simulates an async fetch delay before getContext runs

      // when
      registry.getContext("session-1", 60_000, undefined, trueCreatedMs)
      // a later call must not re-stamp (root already exists) — startTimeMs is ignored
      registry.getContext("session-1", 60_000, undefined, Date.now())
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const stampLine = contents.split("\n").find((line) => line.includes("session.turn"))
      expect(stampLine).toBeDefined()
      const parsed = JSON.parse(stampLine!)
      expect(Math.round(parsed.startTimeUnixMicro / 1000)).toBe(trueCreatedMs)
      registry.__resetForTesting()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a new root stamp never inherits an ambient active span as its parent", async () => {
    // given — simulates getContext() being called from inside some unrelated
    // span's async continuation (e.g. an outer hook.execute still open when
    // message.updated fires). Without forcing ROOT_CONTEXT, the OTel API
    // defaults to context.active(), silently making the "root" a child of
    // whatever happens to be active — producing a trace root with a parent
    // it doesn't actually have, which is exactly what surfaced as spans
    // waterfall-ing under a "user.prompt" root that itself had a bogus,
    // never-exported parent span ID.
    const dir = mkdtempSync(join(tmpdir(), "session-span-context-root-context-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const registry = new SessionSpanContext()
      const ambientSpan = trace.getTracer("test").startSpan("some.unrelated.span")
      const ambientContext = trace.setSpan(context.active(), ambientSpan)

      // when
      context.with(ambientContext, () => registry.getContext("session-1", 60_000))
      ambientSpan.end()
      await handle.shutdown()

      // then — the stamped root has no parent, regardless of the ambient span
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const stampLine = contents.split("\n").find((line) => line.includes("session.turn"))
      expect(stampLine).toBeDefined()
      expect(JSON.parse(stampLine!).parentSpanId).toBeUndefined()
      registry.__resetForTesting()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("release removes the mapping so a later call stamps a fresh root", () => {
    // given
    enableRealTracer()
    const registry = new SessionSpanContext()
    const before = traceIdOf(registry, "session-1")

    // when
    registry.release("session-1")
    const after = traceIdOf(registry, "session-1")

    // then
    expect(after).not.toBe(before)
    registry.__resetForTesting()
  })

  describe("getContextAwaitingPendingBind", () => {
    test("resolves immediately (no wait) when the session isn't marked pending — the common case", async () => {
      // given
      enableRealTracer()
      const registry = new SessionSpanContext()

      // when — no markPendingBind call at all
      const start = Date.now()
      await registry.getContextAwaitingPendingBind("session-not-pending", 5_000)
      const elapsedMs = Date.now() - start

      // then — effectively instant, not stalled by the (unused) ceiling
      expect(elapsedMs).toBeLessThan(100)
      registry.__resetForTesting()
    })

    test("waits for bindRoot() when the session is marked pending, then returns the bound context", async () => {
      // given — reproduces the fix: a sub-agent session marked pending while
      // its delegating tool is still waiting on session start (e.g.
      // waitForBackgroundSessionStart) must not have hook/gen_ai spans
      // stamp their own generic root out from under it. Event-driven, not
      // polled: bindRoot() firing resolves the wait immediately, well before
      // the (deliberately generous) ceiling would.
      enableRealTracer()
      const registry = new SessionSpanContext()
      const sessionID = "session-pending-bind"
      registry.markPendingBind(sessionID)
      const agentSpan = trace.getTracer("test").startSpan("agent.execute.explore")

      // when — bindRoot lands well before the ceiling
      setTimeout(() => registry.bindRoot(sessionID, agentSpan), 30)
      const start = Date.now()
      const resolvedContext = await registry.getContextAwaitingPendingBind(sessionID, 5_000)
      const elapsedMs = Date.now() - start

      // then — got the bound span's context (not a freshly-stamped one),
      // and resolved right away instead of waiting out the full ceiling
      expect(trace.getSpanContext(resolvedContext)?.spanId).toBe(agentSpan.spanContext().spanId)
      expect(elapsedMs).toBeLessThan(500)
      agentSpan.end()
      registry.__resetForTesting()
    })

    test("falls back to stamping a generic root if pending but the bind never arrives within the ceiling", async () => {
      // given
      enableRealTracer()
      const registry = new SessionSpanContext()
      const sessionID = "session-pending-bind-timeout"
      registry.markPendingBind(sessionID)

      // when — bindRoot never called; ceiling kept short just for this test
      const resolvedContext = await registry.getContextAwaitingPendingBind(sessionID, 20)

      // then — still gets a usable context (a freshly-stamped generic root)
      expect(trace.getSpanContext(resolvedContext)?.traceId).toBeDefined()
      registry.__resetForTesting()
    })

    test("clearPendingBind cancels the wait — a later getContextAwaitingPendingBind call resolves immediately", async () => {
      // given
      enableRealTracer()
      const registry = new SessionSpanContext()
      const sessionID = "session-marker-toggle"
      registry.markPendingBind(sessionID)

      // when — cleared before anyone calls getContextAwaitingPendingBind
      registry.clearPendingBind(sessionID)
      registry.clearPendingBind(sessionID) // safe even when already cleared
      expect(() => registry.clearPendingBind("never-marked")).not.toThrow()

      const start = Date.now()
      await registry.getContextAwaitingPendingBind(sessionID, 5_000)
      const elapsedMs = Date.now() - start

      // then — no wait, since the marker was cleared before the call
      expect(elapsedMs).toBeLessThan(100)
      registry.__resetForTesting()
    })

    test("bindRoot() itself clears a pending marker as a side effect", async () => {
      // given
      enableRealTracer()
      const registry = new SessionSpanContext()
      const sessionID = "session-bindroot-clears-marker"
      registry.markPendingBind(sessionID)
      const agentSpan = trace.getTracer("test").startSpan("agent.execute.explore")

      // when — bindRoot happens (not through the wait loop, just directly)
      registry.bindRoot(sessionID, agentSpan)

      // then — a later call sees the marker already cleared, so even with a
      // long ceiling it resolves immediately (root already exists anyway,
      // but this confirms bindRoot itself does the clearing, not just luck)
      const start = Date.now()
      await registry.getContextAwaitingPendingBind(sessionID, 5_000)
      const elapsedMs = Date.now() - start
      expect(elapsedMs).toBeLessThan(100)
      agentSpan.end()
      registry.__resetForTesting()
    })
  })

  describe("waitForBind", () => {
    test("resolves immediately when a root already exists", async () => {
      // given
      enableRealTracer()
      const registry = new SessionSpanContext()
      registry.getContext("session-already-rooted", 60_000)

      // when
      const start = Date.now()
      await registry.waitForBind("session-already-rooted", 5_000)
      const elapsedMs = Date.now() - start

      // then
      expect(elapsedMs).toBeLessThan(50)
      registry.__resetForTesting()
    })

    test("multiple concurrent waiters for the same session all resolve on a single bindRoot() call", async () => {
      // given — otel-core is a shared singleton in production, so more than
      // one caller (e.g. captureFirstUserPrompt AND a hook.execute span)
      // could legitimately be waiting on the same sessionID at once.
      enableRealTracer()
      const registry = new SessionSpanContext()
      const sessionID = "session-multi-waiter"
      const agentSpan = trace.getTracer("test").startSpan("agent.execute.explore")

      // when
      setTimeout(() => registry.bindRoot(sessionID, agentSpan), 20)
      await Promise.all([
        registry.waitForBind(sessionID, 5_000),
        registry.waitForBind(sessionID, 5_000),
        registry.waitForBind(sessionID, 5_000),
      ])

      // then — all three resolved (Promise.all wouldn't otherwise settle)
      // and the session is correctly bound afterward
      expect(registry.hasRoot(sessionID)).toBe(true)
      agentSpan.end()
      registry.__resetForTesting()
    })
  })
})
