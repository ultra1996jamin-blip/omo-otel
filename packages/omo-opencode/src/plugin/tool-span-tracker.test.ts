import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetActiveTracerForTesting, initializeOtel } from "@oh-my-opencode/otel-core"

import { _resetForTesting, setSessionAgent } from "../features/claude-code-session-state"
import { __resetKnownMcpServerNamesForTesting, setKnownMcpServerNames } from "../shared/mcp-tool-classifier"
import { clearAllSessionSkillUsage, hasSessionUsedSkill } from "../shared/session-skill-usage-state"
import { createToolSpanTracker } from "./tool-span-tracker"

describe("createToolSpanTracker", () => {
  afterEach(() => {
    __resetActiveTracerForTesting()
    clearAllSessionSkillUsage()
    _resetForTesting()
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

  test("start() is async but fire-and-forget in production — awaiting it still registers a real span end() closes with hook attributes", async () => {
    // given — start() now awaits getContextAwaitingPendingBind (may briefly
    // wait on a delegated sub-agent's bindRoot), so it's called
    // fire-and-forget from tool-execute-before.ts. This test awaits it
    // directly to confirm the underlying span registration still works once
    // the promise settles — checking exported span content, not just that
    // nothing throws (which would also pass if end() silently no-oped on a
    // never-registered span).
    const dir = mkdtempSync(join(tmpdir(), "tool-span-tracker-async-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const tracker = createToolSpanTracker()
      const identity = { tool: "grep", sessionID: "session-await", callID: "call-await" }

      // when
      await tracker.start({ ...identity, args: { pattern: "x", path: "y" } })
      tracker.end(identity)
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spans = contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
      const hookSpan = spans.find((s) => s.name === "hook.execute.grep")
      expect(hookSpan).toBeDefined()
      expect(hookSpan.attributes["hook.name"]).toBe("grep")
      expect(hookSpan.attributes["hook.input.summary"]).toBe("path,pattern")
      expect(hookSpan.attributes["hook.error"]).toBe(false)
      expect(typeof hookSpan.attributes["hook.execution_ms"]).toBe("number")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("tags the span with mcp.server_name when the tool belongs to a known MCP server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-span-tracker-mcp-test-"))
    try {
      setKnownMcpServerNames(["context7"])
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const tracker = createToolSpanTracker()
      const identity = { tool: "context7_resolve-library-id", sessionID: "session-mcp", callID: "call-mcp" }

      await tracker.start(identity)
      tracker.end(identity)
      await handle.shutdown()

      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spans = contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
      const hookSpan = spans.find((s) => s.name === "hook.execute.context7_resolve-library-id")
      expect(hookSpan).toBeDefined()
      expect(hookSpan.attributes["mcp.server_name"]).toBe("context7")
    } finally {
      __resetKnownMcpServerNamesForTesting()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("marks the session as having used skill when the skill tool is invoked", async () => {
    const tracker = createToolSpanTracker()
    const identity = { tool: "skill", sessionID: "session-skill-used", callID: "call-skill" }

    await tracker.start(identity)
    tracker.end(identity)

    expect(hasSessionUsedSkill("session-skill-used")).toBe(true)
  })

  test("does not mark skill usage for an unrelated tool", async () => {
    const tracker = createToolSpanTracker()
    const identity = { tool: "grep", sessionID: "session-no-skill", callID: "call-no-skill" }

    await tracker.start(identity)
    tracker.end(identity)

    expect(hasSessionUsedSkill("session-no-skill")).toBe(false)
  })

  test("names the span '{agent}: {tool}' and tags gen_ai.agent.name when the session's active agent is known", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-span-tracker-agent-name-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const sessionID = "session-hook-agent-named"
      setSessionAgent(sessionID, "sisyphus")
      const tracker = createToolSpanTracker()
      const identity = { tool: "write", sessionID, callID: "call-agent-named" }

      await tracker.start(identity)
      tracker.end(identity)
      await handle.shutdown()

      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spans = contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
      const hookSpan = spans.find((s) => s.name === "sisyphus: write")
      expect(hookSpan).toBeDefined()
      // hook.name stays the raw tool name regardless of the span's display
      // name — this is what dashboards/queries key off of.
      expect(hookSpan.attributes["hook.name"]).toBe("write")
      expect(hookSpan.attributes["gen_ai.agent.name"]).toBe("sisyphus")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to 'hook.execute.<tool>' when the session's active agent is unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-span-tracker-agent-unknown-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const tracker = createToolSpanTracker()
      const identity = { tool: "write", sessionID: "session-hook-agent-unknown", callID: "call-agent-unknown" }

      await tracker.start(identity)
      tracker.end(identity)
      await handle.shutdown()

      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spans = contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
      const hookSpan = spans.find((s) => s.name === "hook.execute.write")
      expect(hookSpan).toBeDefined()
      expect(hookSpan.attributes["gen_ai.agent.name"]).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not add mcp.server_name for a built-in tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tool-span-tracker-builtin-test-"))
    try {
      setKnownMcpServerNames(["context7"])
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const tracker = createToolSpanTracker()
      const identity = { tool: "grep", sessionID: "session-builtin", callID: "call-builtin" }

      await tracker.start(identity)
      tracker.end(identity)
      await handle.shutdown()

      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spans = contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
      const hookSpan = spans.find((s) => s.name === "hook.execute.grep")
      expect(hookSpan).toBeDefined()
      expect(hookSpan.attributes["mcp.server_name"]).toBeUndefined()
    } finally {
      __resetKnownMcpServerNamesForTesting()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
