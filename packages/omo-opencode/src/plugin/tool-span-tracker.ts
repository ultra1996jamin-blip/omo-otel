import { DelegateSpanRegistry, endSpanSafely, startDetachedSpan } from "@oh-my-opencode/otel-core"
import { log } from "../shared/logger"

export type ToolSpanTracker = ReturnType<typeof createToolSpanTracker>

type ToolSpanIdentity = {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
}

function spanKey(input: ToolSpanIdentity): string {
  return `${input.sessionID}:${input.callID}`
}

// Never include raw argument values here (QA-05: no prompt/code content in spans) —
// only the argument key names, which are safe structural metadata.
function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return ""
  return Object.keys(args).sort().join(",")
}

export function createToolSpanTracker() {
  const registry = new DelegateSpanRegistry()
  const startedAtMs = new Map<string, number>()

  return {
    start(input: ToolSpanIdentity & { args?: Record<string, unknown> }): void {
      try {
        const key = spanKey(input)
        const span = startDetachedSpan(`tool.execute.${input.tool}`, {
          "tool.name": input.tool,
          "tool.input.summary": summarizeArgs(input.args),
        })
        registry.set(key, span)
        startedAtMs.set(key, Date.now())
      } catch (error) {
        log("[otel] failed to start tool span", { tool: input.tool, error })
      }
    },

    end(input: ToolSpanIdentity, error?: unknown): void {
      try {
        const key = spanKey(input)
        const span = registry.get(key)
        const startedAt = startedAtMs.get(key)
        const executionMs = startedAt !== undefined ? Date.now() - startedAt : undefined

        endSpanSafely(
          span,
          {
            "tool.error": error !== undefined,
            ...(executionMs !== undefined ? { "tool.execution_ms": executionMs } : {}),
          },
          error,
        )

        registry.delete(key)
        startedAtMs.delete(key)
      } catch (trackerError) {
        log("[otel] failed to end tool span", { tool: input.tool, error: trackerError })
      }
    },
  }
}
