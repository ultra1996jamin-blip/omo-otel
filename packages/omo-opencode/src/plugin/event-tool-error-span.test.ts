import { describe, expect, it } from "bun:test"

import { createEventHandler } from "./event"
import type { ToolSpanTracker } from "./tool-span-tracker"

function createHandlerWithTracker(tracker: ToolSpanTracker) {
  return createEventHandler({
    ctx: {} as never,
    pluginConfig: {} as never,
    firstMessageVariantGate: {
      markSessionCreated: () => {},
      clear: () => {},
    } as never,
    managers: {
      tmuxSessionManager: {
        onSessionCreated: async () => {},
        onSessionDeleted: async () => {},
      },
      skillMcpManager: {
        disconnectSession: async () => {},
      },
    } as never,
    hooks: {
      autoUpdateChecker: { event: async () => {} },
      claudeCodeHooks: { event: async () => {} },
      backgroundNotificationHook: { event: async () => {} },
      sessionNotification: async () => {},
      todoContinuationEnforcer: { handler: async () => {} },
      unstableAgentBabysitter: { event: async () => {} },
      directoryAgentsInjector: { event: async () => {} },
      directoryReadmeInjector: { event: async () => {} },
      rulesInjector: { event: async () => {} },
      thinkMode: { event: async () => {} },
      anthropicContextWindowLimitRecovery: { event: async () => {} },
      runtimeFallback: undefined,
      modelFallback: undefined,
      agentUsageReminder: { event: async () => {} },
      categorySkillReminder: { event: async () => {} },
      interactiveBashSession: { event: async () => {} },
      ralphLoop: { event: async () => {} },
      stopContinuationGuard: { event: async () => {}, isStopped: () => false },
      compactionTodoPreserver: { event: async () => {} },
      writeExistingFileGuard: { event: async () => {} },
      atlasHook: { handler: async () => {} },
    } as never,
    toolSpanTracker: tracker,
  })
}

function createRecordingTracker() {
  const calls: Array<{ identity: { tool: string; sessionID: string; callID: string }; error?: unknown }> = []
  const tracker = {
    start: () => {},
    end(identity: { tool: string; sessionID: string; callID: string }, error?: unknown) {
      calls.push({ identity, error })
    },
  } as unknown as ToolSpanTracker
  return { tracker, calls }
}

describe("createEventHandler tool error span closing", () => {
  it("ends the tool span with the error when a tool part reports status error", async () => {
    // given
    const { tracker, calls } = createRecordingTracker()
    const eventHandler = createHandlerWithTracker(tracker)

    // when
    await eventHandler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "bash",
            sessionID: "ses_tool_error",
            callID: "call_tool_error",
            state: { status: "error", error: "command exited with code 1" },
          },
        },
      },
    })

    // then
    expect(calls).toHaveLength(1)
    expect(calls[0].identity).toEqual({ tool: "bash", sessionID: "ses_tool_error", callID: "call_tool_error" })
    expect(calls[0].error).toBeInstanceOf(Error)
    expect((calls[0].error as Error).message).toBe("command exited with code 1")
  })

  it("does not end spans for tool parts in non-error states", async () => {
    // given
    const { tracker, calls } = createRecordingTracker()
    const eventHandler = createHandlerWithTracker(tracker)

    // when
    await eventHandler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "bash",
            sessionID: "ses_tool_ok",
            callID: "call_tool_ok",
            state: { status: "completed" },
          },
        },
      },
    })

    // then
    expect(calls).toHaveLength(0)
  })

  it("ignores non-tool parts and malformed payloads", async () => {
    // given
    const { tracker, calls } = createRecordingTracker()
    const eventHandler = createHandlerWithTracker(tracker)

    // when
    await eventHandler({
      event: {
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "ses_text", state: { status: "error" } },
        },
      },
    })
    await eventHandler({
      event: { type: "message.part.updated", properties: {} },
    })

    // then
    expect(calls).toHaveLength(0)
  })
})
