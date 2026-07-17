import type { PluginInput } from "@opencode-ai/plugin";
import type { OhMyOpenCodeConfig } from "../config";
import type { CreatedHooks } from "../create-hooks";
import type { Managers } from "../create-managers";
import type { PluginContext } from "./types";

import { getMainSessionID, subagentSessions, syncSubagentSessions } from "../features/claude-code-session-state";
import { invalidateContextWindowUsageCache } from "../shared/dynamic-truncator";
import { resolveSessionEventID } from "../shared/event-session-id";
import { log } from "../shared/logger";
import { captureFirstUserPrompt, recordGenAiCompletionSpan } from "./gen-ai-completion-span";
import { normalizeSessionStatusToIdle } from "./session-status-normalizer";
import { pruneRecentSyntheticIdles } from "./recent-synthetic-idles";
import { extractErrorMessage, extractErrorName } from "./event-error-utils";
import { createEventHookDispatcher, createEventHookRunner, getEventSessionID } from "./event-hook-dispatcher";
import { createModelFallbackEventHandler } from "./event-model-fallback";
import {
  dispatchOpenClawSessionEvent,
  handleMessageRemovedEvent,
  handleMessageUpdatedSessionState,
  handleSessionCreatedEvent,
  handleSessionDeletedEvent,
  TMUX_ACTIVITY_EVENT_TYPES,
} from "./event-session-lifecycle";
import { createEventTeamHandlers } from "./event-team-handlers";
import type { EventInput, FirstMessageVariantGate, PluginEventContext } from "./event-types";
import type { ToolSpanTracker } from "./tool-span-tracker";

export { extractErrorMessage } from "./event-error-utils";

export function createEventHandler(args: {
  ctx: PluginContext;
  pluginConfig: OhMyOpenCodeConfig;
  firstMessageVariantGate: FirstMessageVariantGate;
  managers: Managers;
  hooks: CreatedHooks;
  toolSpanTracker?: ToolSpanTracker;
}): (input: EventInput) => Promise<void> {
  const { ctx, pluginConfig, firstMessageVariantGate, managers, hooks, toolSpanTracker } = args;
  const tmuxIntegrationEnabled = pluginConfig.tmux?.enabled ?? false;
  const pluginContext = ctx as PluginEventContext;
  const isRuntimeFallbackEnabled =
    hooks.runtimeFallback !== null &&
    hooks.runtimeFallback !== undefined &&
    (typeof pluginConfig.runtime_fallback === "boolean"
      ? pluginConfig.runtime_fallback
      : (pluginConfig.runtime_fallback?.enabled ?? false));
  const isModelFallbackEnabled = hooks.modelFallback !== null && hooks.modelFallback !== undefined;
  const runEventHookSafely = createEventHookRunner();
  const dispatchToHooks = createEventHookDispatcher(hooks, runEventHookSafely);
  const recentSyntheticIdles = new Map<string, number>();
  const recentRealIdles = new Map<string, number>();
  const recentAnyIdles = new Map<string, number>();
  const dedupWindowMs = 500;
  const teamHandlers = createEventTeamHandlers({ pluginConfig, pluginContext, managers });

  const shouldAutoRetrySession = (sessionID: string): boolean => {
    if (syncSubagentSessions.has(sessionID)) return true;
    const mainSessionID = getMainSessionID();
    if (mainSessionID) return sessionID === mainSessionID;
    return !subagentSessions.has(sessionID);
  };

  const modelFallbackHandler = createModelFallbackEventHandler({
    pluginConfig,
    pluginContext,
    modelFallback: hooks.modelFallback,
    isModelFallbackEnabled,
    isRuntimeFallbackEnabled,
    shouldAutoRetrySession,
    isSessionStopped: (sessionID) => hooks.stopContinuationGuard?.isStopped(sessionID) ?? false,
  });

  const shouldDispatchIdleEvent = (sessionID: string, now: number): boolean => {
    const lastDispatchedAt = recentAnyIdles.get(sessionID);
    if (lastDispatchedAt !== undefined && now - lastDispatchedAt < dedupWindowMs) return false;
    recentAnyIdles.set(sessionID, now);
    return true;
  };

  const dispatchIdleOnlyHooks = async (input: EventInput): Promise<void> => {
    managers.tmuxSessionManager?.onEvent?.(input.event);
    await runEventHookSafely("teamIdleWakeHint", teamHandlers.teamIdleWakeHint, input);
    await runEventHookSafely("teamMemberStatusHandler", teamHandlers.teamMemberStatusHandler, input);
  };

  const dispatchSyntheticIdle = async (syntheticIdle: EventInput): Promise<void> => {
    const sessionID = (syntheticIdle.event.properties as Record<string, unknown>)?.sessionID as string;
    const now = Date.now();
    const emittedAt = recentRealIdles.get(sessionID);
    if (emittedAt !== undefined && now - emittedAt < dedupWindowMs) {
      recentRealIdles.delete(sessionID);
      return;
    }
    recentSyntheticIdles.set(sessionID, now);
    if (!shouldDispatchIdleEvent(sessionID, now)) return;

    await dispatchToHooks(syntheticIdle);
    await dispatchOpenClawSessionEvent({
      pluginConfig,
      pluginContext,
      managers,
      rawEvent: "session.idle",
      sessionID,
    });
    await dispatchIdleOnlyHooks(syntheticIdle);
  };

  return async (input): Promise<void> => {
    pruneRecentSyntheticIdles({
      recentSyntheticIdles,
      recentRealIdles,
      recentAnyIdles,
      now: Date.now(),
      dedupWindowMs,
    });
    const syntheticIdle = normalizeSessionStatusToIdle(input) as EventInput | undefined;

    if (input.event.type === "session.idle") {
      const sessionID = getEventSessionID(input);
      if (sessionID) {
        modelFallbackHandler.clearRetryDedupeAfterIdle(sessionID);
        const now = Date.now();
        const emittedAt = recentSyntheticIdles.get(sessionID);
        if (emittedAt !== undefined && now - emittedAt < dedupWindowMs) recentSyntheticIdles.delete(sessionID);
      }
      if (sessionID) {
        const now = Date.now();
        recentRealIdles.set(sessionID, now);
        if (!shouldDispatchIdleEvent(sessionID, now)) return;
      }
    }

    await dispatchToHooks(input);
    if (syntheticIdle) await dispatchSyntheticIdle(syntheticIdle);

    const { event } = input;
    managers.tuiStateMirror?.onEvent(event);
    const props = event.properties as Record<string, unknown> | undefined;

    if (tmuxIntegrationEnabled && TMUX_ACTIVITY_EVENT_TYPES.has(event.type)) {
      managers.tmuxSessionManager.onEvent?.(event as { type: string; properties?: Record<string, unknown> });
    }

    if (event.type === "session.created") {
      await handleSessionCreatedEvent({
        event,
        props,
        tmuxIntegrationEnabled,
        pluginConfig,
        pluginContext,
        managers,
        firstMessageVariantGate,
      });
    }

    if (event.type === "session.deleted") {
      await handleSessionDeletedEvent({
        props,
        tmuxIntegrationEnabled,
        pluginConfig,
        pluginContext,
        managers,
        firstMessageVariantGate,
        clearModelFallbackSession: modelFallbackHandler.clearSession,
      });
      await runEventHookSafely("teamLeadOrphanHandler", teamHandlers.teamLeadOrphanHandler, input);
      await runEventHookSafely("teamMemberStatusHandler", teamHandlers.teamMemberStatusHandler, input);
    }

    if (event.type === "message.part.updated") {
      // tool.execute.after never fires for failed tools, so their spans ended
      // (or leaked) without error status — every span in ClickHouse showed
      // STATUS_CODE_UNSET. The tool part's state transition to "error" is the
      // only signal OpenCode gives us, so close the span from here.
      const part = props?.part as
        | { type?: string; tool?: string; sessionID?: string; callID?: string; state?: { status?: string; error?: string } }
        | undefined;
      if (part?.type === "tool" && part.state?.status === "error" && part.sessionID && part.callID && part.tool) {
        toolSpanTracker?.end(
          { tool: part.tool, sessionID: part.sessionID, callID: part.callID },
          new Error(part.state.error ?? "tool execution failed"),
        );
      }
    }

    if (event.type === "message.removed") handleMessageRemovedEvent(props);

    if (event.type === "session.idle") {
      const sessionID = resolveSessionEventID(props);
      if (sessionID) {
        await dispatchOpenClawSessionEvent({ pluginConfig, pluginContext, managers, rawEvent: event.type, sessionID });
      }
      await dispatchIdleOnlyHooks(input);
      await Promise.resolve().then(() => managers.monitorManager?.handleEvent({
        type: "session.idle",
        sessionId: resolveSessionEventID(props) ?? "",
      }));
    }

    if (event.type === "message.updated") {
      const state = handleMessageUpdatedSessionState({
        props,
        noteSessionModel: modelFallbackHandler.setLastKnownModel,
      });
      const messageFinished =
        typeof state.info?.finish === "string" ? state.info.finish.length > 0 : state.info?.finish === true;
      // A failed LLM call (auth error, rate limit, aborted, ...) may never set
      // `finish` — OpenCode's AssistantMessage carries the failure on a
      // separate `error` field instead. Gating span recording on
      // messageFinished alone meant errored completions never produced a
      // span at all (not even one with UNSET status), so recordGenAiCompletionSpan
      // couldn't mark it ERROR — there was nothing to mark.
      const messageErrored = state.info?.error !== undefined;
      if (state.sessionID && messageFinished) {
        invalidateContextWindowUsageCache(pluginContext as PluginInput, state.sessionID);
      }
      if (state.sessionID && state.role === "assistant" && (messageFinished || messageErrored)) {
        void recordGenAiCompletionSpan(state.info ?? {}, state.sessionID, pluginContext.client);
      }
      if (state.sessionID && state.role === "user") {
        void captureFirstUserPrompt(state.info ?? {}, state.sessionID, pluginContext.client);
      }
      if (state.sessionID && state.role === "assistant") {
        try {
          const shouldStop = await modelFallbackHandler.handleAssistantMessageUpdated({
            sessionID: state.sessionID,
            info: state.info ?? {},
            agent: state.agent,
          });
          if (shouldStop) return;
        } catch (err) {
          log("[event] model-fallback error in message.updated:", {
            sessionID: state.sessionID,
            error: err instanceof Error ? err : String(err),
          });
        }
      }
    }

    if (event.type === "session.status") {
      const sessionID = resolveSessionEventID(props);
      const status = props?.status as { type?: string; attempt?: number; message?: string; next?: number } | undefined;
      if (sessionID) {
        try {
          if (await modelFallbackHandler.handleSessionStatus({ sessionID, status })) return;
        } catch (err) {
          log("[event] model-fallback error in session.status:", {
            sessionID,
            error: err instanceof Error ? err : String(err),
          });
        }
      }
    }

    if (event.type === "session.error") {
      try {
        const sessionID = resolveSessionEventID(props);
        const error = props?.error;
        const errorName = extractErrorName(error);
        const errorMessage = extractErrorMessage(error);
        if (sessionID) {
          await modelFallbackHandler.handleSessionError({ sessionID, errorName, errorMessage, props });
        }
      } catch (err) {
        const sessionID = resolveSessionEventID(props);
        log("[event] model-fallback error in session.error:", {
          sessionID,
          error: err instanceof Error ? err : String(err),
        });
      }

      await runEventHookSafely("teamMemberErrorHandler", teamHandlers.teamMemberErrorHandler, input);
    }
  };
}
