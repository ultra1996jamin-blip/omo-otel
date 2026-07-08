import type { Gauge } from "@opentelemetry/api"
import { getActiveMeter } from "./init"

// Gauge (not Counter) — a "how full is the context window right now" reading
// only makes sense as the latest value, not a running sum. Recreated lazily
// off getActiveMeter() for the same reason as gen-ai-usage-metrics.ts's
// getCounters(): initializeOtel() can swap the active Meter (config reload,
// tests), and an instrument created against a stale Meter keeps writing to a
// MeterProvider nothing reads from anymore.
function getGauge(): Gauge {
  return getActiveMeter().createGauge("gen_ai.context.usage_ratio", {
    description: "Fraction of the model's resolved context window used by the most recent completion (input + output tokens / limit)",
    unit: "1",
  })
}

/**
 * Records how full a model's context window is after one completion —
 * separate from gen_ai.usage.* (token/cost totals over time): this answers
 * "how close to the limit is this model getting right now", queryable per
 * model/provider/agent in Grafana without scanning ClickHouse. Skipped
 * entirely when the caller couldn't resolve a context limit for the model
 * (e.g. an unrecognized provider/model pair) — a ratio against an unknown
 * denominator isn't meaningful, and this metric is additive convenience, not
 * something any pipeline depends on.
 */
export function recordGenAiContextUsage(input: {
  readonly model: string
  readonly usageRatio: number
  readonly usedTokens: number
  readonly limit: number
  readonly system?: string
  readonly agentName?: string
  readonly skillUsed?: boolean
}): void {
  getGauge().record(input.usageRatio, {
    "gen_ai.request.model": input.model,
    ...(input.system ? { "gen_ai.system": input.system } : {}),
    ...(input.agentName ? { "gen_ai.agent.name": input.agentName } : {}),
    ...(input.skillUsed !== undefined ? { "gen_ai.skill_used": input.skillUsed ? "true" : "false" } : {}),
  })
}
