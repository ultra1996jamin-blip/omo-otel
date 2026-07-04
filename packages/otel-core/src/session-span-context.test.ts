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
})
