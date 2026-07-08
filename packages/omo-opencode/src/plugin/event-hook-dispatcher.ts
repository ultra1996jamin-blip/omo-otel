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

// Tracing every internal event hook (all ~27 of them) was tried and reverted —
// most (autoUpdateChecker, sessionNotification, directoryReadmeInjector, etc.)
// fire on nearly every event and almost always no-op, producing dozens of
// sub-millisecond spans per turn with no diagnostic value (observed live).
// `options.traced` opts specific hooks in instead — call sites below mark
// only the handful that represent an actual decision/event worth seeing in a
// trace (context compaction, a safety guard actually firing, a background
// task finishing), not routine bookkeeping.
export function createEventHookRunner(): EventHookRunner {
  return async (hookName, handler, input, options): Promise<void> => {
    if (!handler) return;

    if (!options?.traced) {
      try {
        await Promise.resolve(handler(input));
      } catch (error) {
        log("[event] hook execution failed", {
          hook: hookName,
          eventType: input.event.type,
          sessionID: getEventSessionID(input),
          error: error instanceof Error ? error : String(error),
        });
      }
      return;
    }

    const sessionID = getEventSessionID(input);
    // hasRoot() peek, not the auto-vivifying getContext() — see the "no
    // premature root" test for why: stamping a root here if none exists yet
    // was observed to race ahead of and silently drop the session's real
    // user.prompt/agent.execute.* root.
    const parentContext = sessionID && sessionSpanContext.hasRoot(sessionID)
      ? sessionSpanContext.getContext(sessionID)
      : undefined;
    try {
      await withSpan(
        `opencode.event.${hookName}`,
        { "event.type": input.event.type, "event.source": "opencode" },
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

// traced: true is reserved for hooks whose firing IS the interesting event
// (a decision or state change worth seeing in a trace) — not routine
// per-event bookkeeping:
//   - preemptiveCompaction/compactionContextInjector/compactionTodoPreserver:
//     context compaction actually happening — directly relevant to the
//     context-usage-ratio work (gen-ai-completion-span.ts).
//   - anthropicContextWindowLimitRecovery: recovering from a context-limit
//     error — rare, and worth knowing happened.
//   - writeExistingFileGuard: actually intervened to guard a file overwrite.
//   - autoSlashCommand: a slash command auto-fired.
//   - backgroundNotificationHook: a background task's completion was
//     surfaced to the parent session.
// Everything else stays untraced (see createEventHookRunner's doc comment
// for why blanket tracing all ~27 was tried and reverted).
export function createEventHookDispatcher(hooks: CreatedHooks, runEventHookSafely: EventHookRunner) {
  return async (input: EventInput): Promise<void> => {
    await runEventHookSafely("autoUpdateChecker", hooks.autoUpdateChecker?.event, input);
    await runEventHookSafely("codegraphBootstrap", hooks.codegraphBootstrap?.event, input);
    await runEventHookSafely("astGrepSgProvision", hooks.astGrepSgProvision?.event, input);
    await runEventHookSafely("legacyPluginToast", hooks.legacyPluginToast?.event, input);
    await runEventHookSafely("claudeCodeHooks", hooks.claudeCodeHooks?.event, input);
    await runEventHookSafely("backgroundNotificationHook", hooks.backgroundNotificationHook?.event, input, { traced: true });
    await runEventHookSafely("sessionNotification", hooks.sessionNotification, input);
    await runEventHookSafely("todoContinuationEnforcer", hooks.todoContinuationEnforcer?.handler, input);
    await runEventHookSafely("unstableAgentBabysitter", hooks.unstableAgentBabysitter?.event, input);
    await runEventHookSafely("preemptiveCompaction", hooks.preemptiveCompaction?.event, input, { traced: true });
    await runEventHookSafely("directoryAgentsInjector", hooks.directoryAgentsInjector?.event, input);
    await runEventHookSafely("directoryReadmeInjector", hooks.directoryReadmeInjector?.event, input);
    await runEventHookSafely("rulesInjector", hooks.rulesInjector?.event, input);
    await runEventHookSafely("hephaestusAgentsMdInjector", hooks.hephaestusAgentsMdInjector?.event, input);
    await runEventHookSafely("thinkMode", hooks.thinkMode?.event, input);
    await runEventHookSafely(
      "anthropicContextWindowLimitRecovery",
      hooks.anthropicContextWindowLimitRecovery?.event,
      input,
      { traced: true },
    );
    await runEventHookSafely("runtimeFallback", hooks.runtimeFallback?.event, input);
    await runEventHookSafely("agentUsageReminder", hooks.agentUsageReminder?.event, input);
    await runEventHookSafely("categorySkillReminder", hooks.categorySkillReminder?.event, input);
    await runEventHookSafely("interactiveBashSession", hooks.interactiveBashSession?.event, input);
    await runEventHookSafely("ralphLoop", hooks.ralphLoop?.event, input);
    await runEventHookSafely("stopContinuationGuard", hooks.stopContinuationGuard?.event, input);
    await runEventHookSafely("compactionContextInjector", hooks.compactionContextInjector?.event, input, { traced: true });
    await runEventHookSafely("compactionTodoPreserver", hooks.compactionTodoPreserver?.event, input, { traced: true });
    await runEventHookSafely("writeExistingFileGuard", hooks.writeExistingFileGuard?.event, input, { traced: true });
    await runEventHookSafely("atlasHook", hooks.atlasHook?.handler, input);
    await runEventHookSafely("autoSlashCommand", hooks.autoSlashCommand?.event, input, { traced: true });
  };
}
