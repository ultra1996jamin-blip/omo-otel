import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetActiveTracerForTesting, initializeOtel, sessionSpanContext } from "@oh-my-opencode/otel-core"

import { createEventHookRunner } from "./event-hook-dispatcher"
import type { EventInput } from "./event-types"

describe("createEventHookRunner", () => {
  afterEach(() => {
    __resetActiveTracerForTesting()
    sessionSpanContext.__resetForTesting()
  })

  test("does nothing when the handler is null/undefined", async () => {
    const runner = createEventHookRunner()
    const input: EventInput = { event: { type: "session.idle", properties: {} } as EventInput["event"] }

    await expect(runner("someHook", undefined, input)).resolves.toBeUndefined()
    await expect(runner("someHook", null, input)).resolves.toBeUndefined()
  })

  test("wraps the handler in an opencode.event.<hookName> span tagged with event.source=opencode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "event-hook-dispatcher-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const runner = createEventHookRunner()
      const input: EventInput = {
        event: {
          type: "message.updated",
          properties: { info: { sessionID: "session-event-hook" } },
        } as EventInput["event"],
      }

      // when
      await runner("preemptiveCompaction", () => "handled", input)
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spanLine = contents.split("\n").find((line) => line.includes("opencode.event.preemptiveCompaction"))
      expect(spanLine).toBeDefined()
      const span = JSON.parse(spanLine!)
      expect(span.attributes["event.type"]).toBe("message.updated")
      expect(span.attributes["event.source"]).toBe("opencode")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does NOT auto-vivify a session.turn root as a side effect (regression: this raced ahead of captureFirstUserPrompt and silently dropped the real user.prompt root)", async () => {
    // given — no root exists yet for this session
    const dir = mkdtempSync(join(tmpdir(), "event-hook-dispatcher-no-vivify-test-"))
    try {
      initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const runner = createEventHookRunner()
      const sessionID = "session-no-premature-root"
      const input: EventInput = {
        event: { type: "message.updated", properties: { info: { sessionID } } } as EventInput["event"],
      }

      // when
      await runner("rulesInjector", () => "handled", input)

      // then — sessionSpanContext must NOT have vivified a root for this
      // session just because an event hook ran. If it had, the session's
      // real root-establishing call (captureFirstUserPrompt) would see
      // "root already exists" and fall back to a demoted child instead of
      // becoming the trace root.
      expect(sessionSpanContext.hasRoot(sessionID)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("attaches under the session's root as a child when one already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "event-hook-dispatcher-attaches-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const runner = createEventHookRunner()
      const sessionID = "session-with-real-root"
      // given — a real root already exists (e.g. captureFirstUserPrompt ran first)
      const rootContext = sessionSpanContext.getOrCreateNamedRootContext(sessionID, "user.prompt").context
      const input: EventInput = {
        event: { type: "message.updated", properties: { info: { sessionID } } } as EventInput["event"],
      }

      // when
      await runner("rulesInjector", () => "handled", input)
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spans = contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
      const rootSpan = spans.find((s) => s.name === "user.prompt")
      const eventSpan = spans.find((s) => s.name === "opencode.event.rulesInjector")
      expect(rootSpan).toBeDefined()
      expect(eventSpan).toBeDefined()
      expect(eventSpan.traceId).toBe(rootSpan.traceId)
      expect(eventSpan.parentSpanId).toBe(rootSpan.spanId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("still logs and swallows the error (does not throw) when the handler rejects, after recording it on the span", async () => {
    const dir = mkdtempSync(join(tmpdir(), "event-hook-dispatcher-error-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const runner = createEventHookRunner()
      const input: EventInput = { event: { type: "session.idle", properties: {} } as EventInput["event"] }

      // when / then — matches the pre-existing contract: hook failures never
      // propagate out of the dispatcher.
      await expect(
        runner("failingHook", () => {
          throw new Error("boom")
        }, input),
      ).resolves.toBeUndefined()
      await handle.shutdown()

      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spanLine = contents.split("\n").find((line) => line.includes("opencode.event.failingHook"))
      expect(spanLine).toBeDefined()
      expect(JSON.parse(spanLine!).status.code).toBe(2) // SpanStatusCode.ERROR
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
