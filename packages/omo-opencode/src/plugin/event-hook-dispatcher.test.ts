import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetActiveTracerForTesting, initializeOtel } from "@oh-my-opencode/otel-core"

import { createEventHookRunner } from "./event-hook-dispatcher"
import type { EventInput } from "./event-types"

describe("createEventHookRunner", () => {
  afterEach(() => {
    __resetActiveTracerForTesting()
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
