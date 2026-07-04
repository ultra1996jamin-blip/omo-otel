import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { ExportResultCode, hrTimeToMicroseconds, type ExportResult } from "@opentelemetry/core"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"
import type { OtelDiagnostics } from "./types"

function serializeSpan(span: ReadableSpan): Record<string, unknown> {
  const context = span.spanContext()
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    startTimeUnixMicro: hrTimeToMicroseconds(span.startTime),
    endTimeUnixMicro: hrTimeToMicroseconds(span.endTime),
    attributes: span.attributes,
    status: span.status,
  }
}

export class FileSpanExporter implements SpanExporter {
  private readonly filePath: string
  private readonly diagnostics?: OtelDiagnostics

  constructor(directory: string, diagnostics?: OtelDiagnostics) {
    this.filePath = join(directory, "traces.jsonl")
    this.diagnostics = diagnostics
    try {
      mkdirSync(directory, { recursive: true })
    } catch (error) {
      this.diagnostics?.({ event: "otel_export_failed", error })
    }
  }

  export(spans: readonly ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      const lines = spans.map((span) => JSON.stringify(serializeSpan(span))).join("\n")
      appendFileSync(this.filePath, `${lines}\n`)
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      this.diagnostics?.({ event: "otel_export_failed", error })
      resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : undefined })
    }
  }

  async shutdown(): Promise<void> {}
}
