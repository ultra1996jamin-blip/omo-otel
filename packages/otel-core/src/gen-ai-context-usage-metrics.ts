import type { Gauge } from "@opentelemetry/api"
import { getActiveMeter } from "./init"

// Gauges (not Counters) — "how full is the context window right now" only
// makes sense as the latest value, not a running sum. Recreated lazily off
// getActiveMeter() for the same reason as gen-ai-usage-metrics.ts's
// getCounters(): initializeOtel() can swap the active Meter (config reload,
// tests), and an instrument created against a stale Meter keeps writing to a
// MeterProvider nothing reads from anymore.
function getUsedTokensGauge(): Gauge {
  return getActiveMeter().createGauge("gen_ai.context.used_tokens", {
    description: "Input + output tokens for the most recent completion — the numerator for a context-window-usage ratio, however the denominator (the model's limit) is resolved",
    unit: "{token}",
  })
}

function getUsageRatioGauge(): Gauge {
  return getActiveMeter().createGauge("gen_ai.context.usage_ratio", {
    description: "Fraction of the model's resolved context window used by the most recent completion (input + output tokens / limit)",
    unit: "1",
  })
}

/**
 * Records how full a model's context window is after one completion —
 * separate from gen_ai.usage.* (token/cost totals over time): this answers
 * "how close to the limit is this model getting right now", queryable per
 * model/provider/agent in Grafana without scanning ClickHouse.
 *
 * usedTokens is ALWAYS recorded (as its own gauge), even when this project's
 * own model-context-limits-cache couldn't resolve a limit for the model —
 * e.g. a custom/proxy provider (observed live: a corporate "codemate/..."
 * gateway) that OpenCode itself has no metadata for at all. That's exactly
 * the case a Grafana-side "$context_limit" dashboard variable exists for:
 * the operator types in the number themselves and Grafana computes
 * used_tokens / $context_limit directly, instead of this metric being
 * useless for any model this project can't look up on its own.
 *
 * usageRatio/limit are only recorded (as a second gauge) when the caller DID
 * resolve a limit — for those models Grafana can use the ready-made ratio
 * instead of needing the manual variable.
 */
export function recordGenAiContextUsage(input: {
  readonly model: string
  readonly usedTokens: number
  readonly usageRatio?: number
  readonly limit?: number
  readonly system?: string
  readonly agentName?: string
  readonly skillUsed?: boolean
}): void {
  const attributes = {
    "gen_ai.request.model": input.model,
    ...(input.system ? { "gen_ai.system": input.system } : {}),
    ...(input.agentName ? { "gen_ai.agent.name": input.agentName } : {}),
    ...(input.skillUsed !== undefined ? { "gen_ai.skill_used": input.skillUsed ? "true" : "false" } : {}),
  }
  getUsedTokensGauge().record(input.usedTokens, attributes)
  if (input.usageRatio !== undefined) {
    getUsageRatioGauge().record(input.usageRatio, attributes)
  }
}
