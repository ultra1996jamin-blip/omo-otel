import type { Counter } from "@opentelemetry/api"
import { getActiveMeter } from "./init"

// Counters are (re)created lazily off getActiveMeter() rather than cached at
// module load — initializeOtel() can be called again (config reload, tests),
// swapping the active Meter, and a Counter created against a stale Meter
// keeps writing to a MeterProvider nothing reads from anymore.
function getCounters(): {
  inputTokens: Counter
  outputTokens: Counter
  totalTokens: Counter
  cost: Counter
} {
  const meter = getActiveMeter()
  return {
    inputTokens: meter.createCounter("gen_ai.usage.input_tokens", { description: "LLM input (prompt) tokens consumed", unit: "{token}" }),
    outputTokens: meter.createCounter("gen_ai.usage.output_tokens", { description: "LLM output (completion) tokens consumed", unit: "{token}" }),
    totalTokens: meter.createCounter("gen_ai.usage.total_tokens", { description: "LLM total tokens consumed (input + output + reasoning)", unit: "{token}" }),
    cost: meter.createCounter("gen_ai.usage.cost", { description: "Estimated LLM cost, as reported by the harness", unit: "{USD}" }),
  }
}

/**
 * Records one LLM call's token/cost usage as Prometheus-queryable counters —
 * separate from (and in addition to) the same numbers already recorded as
 * gen_ai.completion.* span attributes. Spans answer "what happened on this
 * specific call"; these counters answer "what's the total/rate over time,
 * queryable without scanning ClickHouse" (Cost & Token / KPI dashboards).
 * Attributed by model (and, when known, agent) — not session/prompt, since
 * those dashboards aggregate across all calls and per-session labels would
 * blow up cardinality for no dashboard benefit. Agent name is a small,
 * bounded set (one label value per configured agent), same reasoning as
 * gen_ai.reasoning_present, so it's safe to add as a dimension.
 */
export function recordGenAiUsage(input: {
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cost?: number
  readonly agentName?: string
}): void {
  const counters = getCounters()
  const attributes = {
    "gen_ai.request.model": input.model,
    ...(input.agentName ? { "gen_ai.agent.name": input.agentName } : {}),
  }
  counters.inputTokens.add(input.inputTokens, attributes)
  counters.outputTokens.add(input.outputTokens, attributes)
  counters.totalTokens.add(input.totalTokens, attributes)
  if (input.cost !== undefined) {
    counters.cost.add(input.cost, attributes)
  }
}
