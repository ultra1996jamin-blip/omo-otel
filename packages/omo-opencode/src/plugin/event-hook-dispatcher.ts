import { sessionSpanContext, withSpan } from "@oh-my-opencode/otel-core";
import type { CreatedHooks } from "../create-hooks";
import { log } from "../shared/logger";
import { resolveMessageEventSessionID, resolveSessionEventID } from "../shared/event-session-id";
import { isRecord } from "./event-error-utils";
import type { EventInput, EventHookRunner } from "./event-types";

export function getEventSessionID(input: EventInput): string | undefined {
  const properties = input.event.properties;
  if (input.event.type.startsWith("session.")) {
    return resolveSessionEventID(properties);
  }
  if (input.event.type.startsWith("message.") || input.event.type.startsWith("tool.")) {
    return resolveMessageEventSessionID(properties);
  }
  const record: Record<string, unknown> | undefined = isRecord(properties) ? properties : undefined;
  const sessionID = record?.sessionID;
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined;
}

export function createEventHookRunner(): EventHookRunner {
  return async (hookName, handler, input): Promise<void> => {
    if (!handler) return;

    const sessionID = getEventSessionID(input);
    // "opencode.event.*" (not "agent.*"/"hook.execute.*") + event.source
    // explicitly says "opencode" — these ~30 internal hooks (auto-update
    // checks, context injectors, compaction, etc.) fire because OpenCode's
    // own event system dispatched session/message/tool events, not because
    // an agent decided to act. Keeping that distinct from agent-initiated
    // tool calls (tool-span-tracker.ts's "{agent}: {tool}" spans) matters
    // for reading a trace: "did the human/agent do this, or did the host
    // engine do it on its own".
    //
    // sessionSpanContext.getContext() auto-vivifies a generic "session.turn"
    // root if none exists yet for this session — fine for a span that KNOWS
    // it's the first thing to touch this session, but these ~30 hooks fire
    // on nearly every event, often before captureFirstUserPrompt/
    // recordGenAiCompletionSpan (event.ts) get a chance to establish the
    // real "user.prompt"/"agent.execute.*" root. Racing ahead of them here
    // was observed live to eagerly stamp the generic root first, silently
    // demoting or dropping the actual user-turn root entirely. hasRoot() is
    // a pure peek (see its own doc comment) — only attach under a root that
    // ALREADY exists; if none does yet, this span is parentless rather than
    // corrupting the session's real root.
    const parentContext = sessionID && sessionSpanContext.hasRoot(sessionID)
      ? sessionSpanContext.getContext(sessionID)
      : undefined;
    try {
      await withSpan(
        `opencode.event.${hookName}`,
        {
          "event.type": input.event.type,
          "event.source": "opencode",
        },
        () => handler(input),
        undefined,
        parentContext,
      );
    } catch (error) {
      log("[event] hook execution failed", {
        hook: hookName,
        eventType: input.event.type,
        sessionID,
        error: error instanceof Error ? error : String(error),
      });
    }
  };
}

export function createEventHookDispatcher(hooks: CreatedHooks, runEventHookSafely: EventHookRunner) {
  return async (input: EventInput): Promise<void> => {
    await runEventHookSafely("autoUpdateChecker", hooks.autoUpdateChecker?.event, input);
    await runEventHookSafely("codegraphBootstrap", hooks.codegraphBootstrap?.event, input);
    await runEventHookSafely("astGrepSgProvision", hooks.astGrepSgProvision?.event, input);
    await runEventHookSafely("legacyPluginToast", hooks.legacyPluginToast?.event, input);
    await runEventHookSafely("claudeCodeHooks", hooks.claudeCodeHooks?.event, input);
    await runEventHookSafely("backgroundNotificationHook", hooks.backgroundNotificationHook?.event, input);
    await runEventHookSafely("sessionNotification", hooks.sessionNotification, input);
    await runEventHookSafely("todoContinuationEnforcer", hooks.todoContinuationEnforcer?.handler, input);
    await runEventHookSafely("unstableAgentBabysitter", hooks.unstableAgentBabysitter?.event, input);
    await runEventHookSafely("preemptiveCompaction", hooks.preemptiveCompaction?.event, input);
    await runEventHookSafely("directoryAgentsInjector", hooks.directoryAgentsInjector?.event, input);
    await runEventHookSafely("directoryReadmeInjector", hooks.directoryReadmeInjector?.event, input);
    await runEventHookSafely("rulesInjector", hooks.rulesInjector?.event, input);
    await runEventHookSafely("hephaestusAgentsMdInjector", hooks.hephaestusAgentsMdInjector?.event, input);
    await runEventHookSafely("thinkMode", hooks.thinkMode?.event, input);
    await runEventHookSafely(
      "anthropicContextWindowLimitRecovery",
      hooks.anthropicContextWindowLimitRecovery?.event,
      input,
    );
    await runEventHookSafely("runtimeFallback", hooks.runtimeFallback?.event, input);
    await runEventHookSafely("agentUsageReminder", hooks.agentUsageReminder?.event, input);
    await runEventHookSafely("categorySkillReminder", hooks.categorySkillReminder?.event, input);
    await runEventHookSafely("interactiveBashSession", hooks.interactiveBashSession?.event, input);
    await runEventHookSafely("ralphLoop", hooks.ralphLoop?.event, input);
    await runEventHookSafely("stopContinuationGuard", hooks.stopContinuationGuard?.event, input);
    await runEventHookSafely("compactionContextInjector", hooks.compactionContextInjector?.event, input);
    await runEventHookSafely("compactionTodoPreserver", hooks.compactionTodoPreserver?.event, input);
    await runEventHookSafely("writeExistingFileGuard", hooks.writeExistingFileGuard?.event, input);
    await runEventHookSafely("atlasHook", hooks.atlasHook?.handler, input);
    await runEventHookSafely("autoSlashCommand", hooks.autoSlashCommand?.event, input);
  };
}
