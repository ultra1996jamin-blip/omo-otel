import { context, trace, SpanStatusCode, type Attributes, type Span, type Tracer } from "@opentelemetry/api"
import { getActiveTracer } from "./init"
import type { OtelDiagnostics } from "./types"

export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name"
export const GEN_AI_SYSTEM_ATTR = "gen_ai.system"
export const GEN_AI_AGENT_NAME = "gen_ai.agent.name"

export function resolveTracer(): Tracer {
  return getActiveTracer()
}

/**
 * Starts a span, runs `fn` inside its context, and always ends the span —
 * even when `fn` throws or the tracer is a no-op. Span bookkeeping failures
 * are swallowed via `diagnostics` so telemetry never breaks agent execution.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T> | T,
  diagnostics?: OtelDiagnostics,
): Promise<T> {
  const tracer = resolveTracer()
  const span = tracer.startSpan(name, { attributes })

  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span))
  } catch (error) {
    try {
      span.recordException(error instanceof Error ? error : String(error))
      span.setStatus({ code: SpanStatusCode.ERROR })
    } catch (diagError) {
      diagnostics?.({ event: "otel_span_failed", error: diagError })
    }
    throw error
  } finally {
    try {
      span.end()
    } catch (endError) {
      diagnostics?.({ event: "otel_span_failed", error: endError })
    }
  }
}

/**
 * Starts a span that outlives the current call stack (e.g. a background task
 * launch whose completion is observed by a different hook later). Callers
 * must end the span themselves — see DelegateSpanRegistry for the handoff.
 */
export function startDetachedSpan(name: string, attributes: Attributes): Span {
  return resolveTracer().startSpan(name, { attributes })
}

export function endSpanSafely(span: Span | undefined, attributes?: Attributes, error?: unknown): void {
  if (!span) return
  try {
    if (attributes) span.setAttributes(attributes)
    if (error !== undefined) {
      span.recordException(error instanceof Error ? error : String(error))
      span.setStatus({ code: SpanStatusCode.ERROR })
    }
    span.end()
  } catch {
    // Telemetry bookkeeping must never affect agent execution.
  }
}
