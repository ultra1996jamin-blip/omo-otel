import { afterEach, describe, expect, test } from "bun:test"
import { __resetActiveTracerForTesting, initializeOtel } from "@oh-my-opencode/otel-core"

import { createToolSpanTracker } from "./tool-span-tracker"

describe("createToolSpanTracker", () => {
  afterEach(() => {
    __resetActiveTracerForTesting()
  })

  test("start/end does not throw when otel is disabled (default no-op tracer)", () => {
    // given
    initializeOtel({ env: {} })
    const tracker = createToolSpanTracker()
    const identity = { tool: "grep", sessionID: "session-1", callID: "call-1" }

    // when / then
    expect(() => tracker.start({ ...identity, args: { pattern: "x", path: "y" } })).not.toThrow()
    expect(() => tracker.end(identity)).not.toThrow()
  })

  test("end() without a matching start() does not throw", () => {
    // given
    const tracker = createToolSpanTracker()

    // when / then
    expect(() => tracker.end({ tool: "grep", sessionID: "s", callID: "unknown-call" })).not.toThrow()
  })

  test("end() with an error still completes without throwing", () => {
    // given
    const tracker = createToolSpanTracker()
    const identity = { tool: "bash", sessionID: "session-1", callID: "call-2" }
    tracker.start(identity)

    // when / then
    expect(() => tracker.end(identity, new Error("boom"))).not.toThrow()
  })
})
