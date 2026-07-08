import { DelegateSpanRegistry, GEN_AI_AGENT_NAME, endSpanSafely, sessionSpanContext, startDetachedSpan } from "@oh-my-opencode/otel-core"
import { getSessionAgent } from "../features/claude-code-session-state"
import { log } from "../shared/logger"
import { getMcpServerNameForTool } from "../shared/mcp-tool-classifier"
import { markSessionUsedSkill } from "../shared/session-skill-usage-state"
import { TOOL_NAME as SKILL_TOOL_NAME } from "../tools/skill/constants"

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
    // Async — but always called fire-and-forget (`void tracker.start(...)`)
    // from tool-execute-before.ts, never awaited, so a rare pending-bind wait
    // here can't add latency to the actual tool call. Captures the real
    // start time BEFORE that wait so hook.execution_ms still reflects the
    // tool's own duration, not this telemetry bookkeeping.
    async start(input: ToolSpanIdentity & { args?: Record<string, unknown> }): Promise<void> {
      const key = spanKey(input)
      startedAtMs.set(key, Date.now())
      // Recorded regardless of the span/otel-enabled state below — this is
      // plain in-memory bookkeeping read later by gen-ai-completion-span.ts
      // to tag context-usage metrics with gen_ai.skill_used for the
      // with-vs-without-skills A/B comparison in Grafana.
      if (input.tool === SKILL_TOOL_NAME) {
        markSessionUsedSkill(input.sessionID)
      }
      try {
        // Waits out any in-flight bindRoot() for a delegated sub-agent
        // session before falling back to auto-vivifying a generic root —
        // see SessionSpanContext.getContextAwaitingPendingBind's doc comment.
        const parentContext = await sessionSpanContext.getContextAwaitingPendingBind(input.sessionID)
        const mcpServerName = getMcpServerNameForTool(input.tool)
        // "{agent}: hook/{tool}" or "{agent}: mcp/{server}/{tool}" reads at a
        // glance in Jaeger's trace tree/Operation list — which agent did
        // what, AND whether it was a built-in tool or an MCP call — instead
        // of a flat "hook.execute.write" that could be either. The hook/mcp
        // prefixes match the same vocabulary the Grafana dashboards already
        // use (hook_name/mcp_server_name dimensions), just made visible in
        // the operation name too. Falls back to the old "hook.execute.<tool>"
        // shape when the session's agent isn't known yet (e.g. captured
        // before setSessionAgent() has ever run for it), so a span is never
        // named "undefined: ...". hook.name (unchanged, always the raw tool
        // name) is what dashboards/queries key off of, not this display name.
        const agentName = getSessionAgent(input.sessionID)
        const operationName = mcpServerName ? `mcp/${mcpServerName}/${input.tool}` : `hook/${input.tool}`
        const spanName = agentName ? `${agentName}: ${operationName}` : `hook.execute.${input.tool}`
        // OMO calls this mechanism a "hook" (tool.execute.before/after), not
        // a "tool" — the attribute vocabulary follows that (hook.name, not
        // tool.name). Every tool call (built-in or MCP-provided) shares this
        // one span shape; mcp.server_name is the only thing that tells the
        // two apart (see mcp-tool-classifier.ts) — dashboards/queries filter
        // on its presence rather than on a separate "mcp.*" span name, since
        // MCP calls never actually produced their own span kind in practice.
        const span = startDetachedSpan(
          spanName,
          {
            "hook.name": input.tool,
            "hook.input.summary": summarizeArgs(input.args),
            ...(agentName ? { [GEN_AI_AGENT_NAME]: agentName } : {}),
            ...(mcpServerName ? { "mcp.server_name": mcpServerName } : {}),
          },
          parentContext,
        )
        registry.set(key, span)
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
            "hook.error": error !== undefined,
            ...(executionMs !== undefined ? { "hook.execution_ms": executionMs } : {}),
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
