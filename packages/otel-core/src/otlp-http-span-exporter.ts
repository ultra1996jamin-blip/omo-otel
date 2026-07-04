import { ExportResultCode, hrTimeToNanoseconds, type ExportResult } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import type { OtelDiagnostics } from "./types"

type OtlpAttributeValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: { value: OtlpAttributeValue }[] } }

function encodeAttributeValue(value: unknown): OtlpAttributeValue {
  if (typeof value === "string") return { stringValue: value }
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => ({ value: encodeAttributeValue(item) })) } }
  }
  return { stringValue: String(value) }
}

function encodeAttributes(attributes: Record<string, unknown> | undefined): { key: string; value: OtlpAttributeValue }[] {
  if (!attributes) return []
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: encodeAttributeValue(value) }))
}

function encodeEvent(event: ReadableSpan["events"][number]): Record<string, unknown> {
  return {
    name: event.name,
    timeUnixNano: String(hrTimeToNanoseconds(event.time)),
    attributes: encodeAttributes(event.attributes as Record<string, unknown> | undefined),
  }
}

function encodeSpan(span: ReadableSpan): Record<string, unknown> {
  const context = span.spanContext()
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    ...(span.parentSpanContext?.spanId ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    name: span.name,
    kind: 1,
    startTimeUnixNano: String(hrTimeToNanoseconds(span.startTime)),
    endTimeUnixNano: String(hrTimeToNanoseconds(span.endTime)),
    attributes: encodeAttributes(span.attributes),
    events: span.events.map(encodeEvent),
    status: { code: span.status.code },
  }
}

/**
 * A minimal OTLP/HTTP JSON exporter built on `fetch` — avoids the Node
 * http/https-based official exporter so the plugin stays Bun-compatible
 * without a gRPC dependency (AS-01/AS-04 in the architecture design).
 */
export class OtlpHttpSpanExporter implements SpanExporter {
  constructor(
    private readonly endpoint: string,
    private readonly diagnostics?: OtelDiagnostics,
  ) {}

  export(spans: readonly ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS })
      return
    }

    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: encodeAttributes(spans[0]?.resource.attributes) },
          scopeSpans: [
            {
              scope: { name: "oh-my-openagent" },
              spans: spans.map(encodeSpan),
            },
          ],
        },
      ],
    })

    fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
      .then((response) => {
        if (response.ok) {
          resultCallback({ code: ExportResultCode.SUCCESS })
          return
        }
        this.diagnostics?.({
          event: "otel_export_failed",
          error: new Error(`OTLP export failed: HTTP ${response.status}`),
        })
        resultCallback({ code: ExportResultCode.FAILED })
      })
      .catch((error) => {
        this.diagnostics?.({ event: "otel_export_failed", error })
        resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : undefined })
      })
  }

  async shutdown(): Promise<void> {}
}
