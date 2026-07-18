import type { ContextLimitModelCacheState } from "./context-limit-resolver"

// Mirrors vision-capable-models-cache.ts's pattern: applyProviderConfig()
// (plugin-handlers/provider-config-handler.ts) owns the canonical
// ModelCacheState and threads it explicitly through the hook call chains
// that already needed it (dynamic-truncator, preemptive-compaction). The
// OTEL completion-span recorder (gen-ai-completion-span.ts) lives on a
// completely different call path with no access to that threaded state, so
// this exposes the same two fields as a small globally-readable mirror
// instead of threading modelCacheState through event.ts as well.
let modelContextLimitsCache = new Map<string, number>()
let anthropicContext1MEnabled = false

export function setModelContextLimitsCache(cache: Map<string, number>): void {
  modelContextLimitsCache = cache
}

export function setAnthropicContext1MEnabled(enabled: boolean): void {
  anthropicContext1MEnabled = enabled
}

export function getModelCacheState(): ContextLimitModelCacheState {
  return { modelContextLimitsCache, anthropicContext1MEnabled }
}

export function clearModelContextLimitsCache(): void {
  modelContextLimitsCache = new Map<string, number>()
  anthropicContext1MEnabled = false
}
