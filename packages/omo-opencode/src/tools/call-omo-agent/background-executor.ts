import type { CallOmoAgentArgs } from "./types"
import type { BackgroundManager } from "../../features/background-agent"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  GEN_AI_AGENT_NAME,
  GEN_AI_OPERATION_NAME,
  GEN_AI_SYSTEM,
  GEN_AI_SYSTEM_ATTR,
  sessionSpanContext,
  startDetachedSpan,
} from "@oh-my-opencode/otel-core"
import { log } from "../../shared"
import { backgroundTaskSpanRegistry } from "../../shared/background-task-span-registry"
import type { DelegatedModelConfig } from "../../shared/model-resolution-types"
import type { FallbackEntry } from "../../shared/model-requirements"
import { resolveMessageContext } from "../../features/hook-message-injector"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { getMessageDir } from "./message-dir"
import { getSessionTools } from "../../shared/session-tools-store"
import { sanitizeSubagentType } from "../delegate-task/subagent-discovery"
import { getAgentDisplayName, stripAgentListSortPrefix } from "../../shared/agent-display-names"

export async function executeBackground(
  args: CallOmoAgentArgs,
  toolContext: {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  },
  manager: BackgroundManager,
  client: PluginInput["client"],
  fallbackChain?: FallbackEntry[],
  model?: DelegatedModelConfig,
): Promise<string> {
  try {
    const messageDir = getMessageDir(toolContext.sessionID)
    const { prevMessage, firstMessageAgent } = await resolveMessageContext(
      toolContext.sessionID,
      client,
      messageDir
    )

    const sessionAgent = getSessionAgent(toolContext.sessionID)
    const parentAgent = toolContext.agent ?? sessionAgent ?? firstMessageAgent ?? prevMessage?.agent
    
    log("[call_omo_agent] parentAgent resolution", {
      sessionID: toolContext.sessionID,
      messageDir,
      ctxAgent: toolContext.agent,
      sessionAgent,
      firstMessageAgent,
      prevMessageAgent: prevMessage?.agent,
      resolvedParentAgent: parentAgent,
    })

    const normalizedAgent = getAgentDisplayName(stripAgentListSortPrefix(sanitizeSubagentType(args.subagent_type)))
    const task = await manager.launch({
      description: args.description,
      prompt: args.prompt,
      agent: normalizedAgent,
      parentSessionId: toolContext.sessionID,
      parentMessageId: toolContext.messageID,
      parentAgent,
      parentTools: getSessionTools(toolContext.sessionID),
      model,
      fallbackChain,
    })

    // Span is ended in BackgroundManager.notifyParentSession() — the single
    // choke point every terminal task state funnels through — since this
    // function returns long before the background task actually finishes.
    const agentSpan = startDetachedSpan(
      `agent.execute.${normalizedAgent}`,
      {
        [GEN_AI_OPERATION_NAME]: "agent_delegation",
        [GEN_AI_SYSTEM_ATTR]: GEN_AI_SYSTEM,
        [GEN_AI_AGENT_NAME]: normalizedAgent,
        "agent.task_id": task.id,
        "agent.task_type": "background",
      },
      sessionSpanContext.getContext(toolContext.sessionID),
    )
    backgroundTaskSpanRegistry.set(task.id, agentSpan)

    const WAIT_FOR_SESSION_INTERVAL_MS = 50
    const WAIT_FOR_SESSION_TIMEOUT_MS = 30000
    const waitStart = Date.now()
    let sessionId = task.sessionId
    while (!sessionId && Date.now() - waitStart < WAIT_FOR_SESSION_TIMEOUT_MS) {
      const updated = manager.getTask(task.id)
      if (updated?.status === "error" || updated?.status === "cancelled" || updated?.status === "interrupt") {
        return `Task failed to start (status: ${updated.status}).\n\nTask ID: ${task.id}`
      }
      sessionId = updated?.sessionId
      if (sessionId) {
        break
      }
      if (toolContext.abort?.aborted) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, WAIT_FOR_SESSION_INTERVAL_MS))
    }

    if (sessionId) {
      // Tool calls the background sub-agent makes in its own session should
      // nest under this agent span rather than starting a new trace.
      sessionSpanContext.bindRoot(sessionId, agentSpan)
    }

    await toolContext.metadata?.({
      title: args.description,
      metadata: { sessionId: sessionId ?? "pending" },
    })

		return `Background agent task launched successfully.

Task ID: ${task.id}
Session ID: ${sessionId ?? "pending"}
Description: ${task.description}
Agent: ${task.agent} (subagent)
Status: ${task.status}

Do NOT call background_output now. Wait for <system-reminder> notification first. The system will deliver the result when the task completes; you do not need to poll for it.`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Failed to launch background agent task: ${message}`
  }
}
