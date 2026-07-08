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
    await expect(runner("someHook", null, input, { traced: true })).resolves.toBeUndefined()
  })

  test("runs untraced hooks (the default) without creating any span", async () => {
    const dir = mkdtempSync(join(tmpdir(), "event-hook-dispatcher-untraced-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const runner = createEventHookRunner()
      const input: EventInput = { event: { type: "message.updated", properties: {} } as EventInput["event"] }

      // when — no `{ traced: true }`, matching the ~20 routine hooks
      await runner("autoUpdateChecker", () => "handled", input)
      await handle.shutdown()

      // then — no span was ever created, so the exporter never even wrote
      // the file
      let contents = ""
      try {
        contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      } catch {
        // file not existing at all is the expected outcome here
      }
      expect(contents.trim()).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("wraps a traced hook in an opencode.event.<hookName> span tagged with event.source=opencode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "event-hook-dispatcher-traced-test-"))
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
      await runner("preemptiveCompaction", () => "handled", input, { traced: true })
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

  test("a traced hook does NOT auto-vivify a session.turn root as a side effect", async () => {
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
      await runner("writeExistingFileGuard", () => "handled", input, { traced: true })

      // then — the real root-establishing call (captureFirstUserPrompt) must
      // still see "no root yet" afterward, or it would fall back to a
      // demoted child instead of becoming the trace root.
      expect(sessionSpanContext.hasRoot(sessionID)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a traced hook attaches under the session's root as a child when one already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "event-hook-dispatcher-attaches-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const runner = createEventHookRunner()
      const sessionID = "session-with-real-root"
      const rootContext = sessionSpanContext.getOrCreateNamedRootContext(sessionID, "user.prompt").context
      const input: EventInput = {
        event: { type: "message.updated", properties: { info: { sessionID } } } as EventInput["event"],
      }

      // when
      await runner("autoSlashCommand", () => "handled", input, { traced: true })
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spans = contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
      const rootSpan = spans.find((s) => s.name === "user.prompt")
      const eventSpan = spans.find((s) => s.name === "opencode.event.autoSlashCommand")
      expect(rootSpan).toBeDefined()
      expect(eventSpan).toBeDefined()
      expect(eventSpan.traceId).toBe(rootSpan.traceId)
      expect(eventSpan.parentSpanId).toBe(rootSpan.spanId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("still logs and swallows the error (does not throw) when a traced handler rejects, after recording it on the span", async () => {
    const dir = mkdtempSync(join(tmpdir(), "event-hook-dispatcher-error-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const runner = createEventHookRunner()
      const input: EventInput = { event: { type: "session.idle", properties: {} } as EventInput["event"] }

      // when / then — matches the pre-existing contract: hook failures never
      // propagate out of the dispatcher, traced or not.
      await expect(
        runner("anthropicContextWindowLimitRecovery", () => {
          throw new Error("boom")
        }, input, { traced: true }),
      ).resolves.toBeUndefined()
      await handle.shutdown()

      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spanLine = contents.split("\n").find((line) => line.includes("opencode.event.anthropicContextWindowLimitRecovery"))
      expect(spanLine).toBeDefined()
      expect(JSON.parse(spanLine!).status.code).toBe(2) // SpanStatusCode.ERROR
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("still logs and swallows the error (does not throw) when an UNtraced handler rejects", async () => {
    const runner = createEventHookRunner()
    const input: EventInput = { event: { type: "session.idle", properties: {} } as EventInput["event"] }

    await expect(
      runner("categorySkillReminder", () => {
        throw new Error("boom")
      }, input),
    ).resolves.toBeUndefined()
  })
})
