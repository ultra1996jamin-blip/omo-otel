import { DelegateSpanRegistry } from "@oh-my-opencode/otel-core"

/**
 * Shared between tools/delegate-task/background-task.ts (creates the span at
 * launch) and features/background-agent/manager.ts (ends it at completion).
 * Keyed by task.id (a string) rather than object identity, because
 * BackgroundManager.launch() returns a shallow copy of its internal task —
 * the same id string is the only stable link between the two sides.
 */
export const backgroundTaskSpanRegistry = new DelegateSpanRegistry()
