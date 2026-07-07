import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { ExportResultCode, hrTimeToMicroseconds, type ExportResult } from "@opentelemetry/core"
import { DataPointType, type PushMetricExporter, type ResourceMetrics } from "@opentelemetry/sdk-metrics"
import type { OtelDiagnostics } from "./types"

function serializeMetric(metric: import("@opentelemetry/sdk-metrics").MetricData): Record<string, unknown> | undefined {
  if (metric.dataPointType !== DataPointType.SUM) return undefined
  return {
    name: metric.descriptor.name,
    unit: metric.descriptor.unit,
    isMonotonic: metric.isMonotonic,
    dataPoints: metric.dataPoints.map((point) => ({
      attributes: point.attributes,
      startTimeUnixMicro: hrTimeToMicroseconds(point.startTime),
      endTimeUnixMicro: hrTimeToMicroseconds(point.endTime),
      value: point.value,
    })),
  }
}

/** File counterpart to OtlpHttpMetricExporter — same JSONL pattern as FileSpanExporter, for polyglot-network-free (e.g. test) environments. */
export class FileMetricExporter implements PushMetricExporter {
  private readonly filePath: string
  private readonly diagnostics?: OtelDiagnostics

  constructor(directory: string, diagnostics?: OtelDiagnostics) {
    this.filePath = join(directory, "metrics.jsonl")
    this.diagnostics = diagnostics
    try {
      mkdirSync(directory, { recursive: true })
    } catch (error) {
      this.diagnostics?.({ event: "otel_export_failed", error })
    }
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    try {
      const lines: string[] = []
      for (const scopeMetrics of metrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          const serialized = serializeMetric(metric)
          if (serialized) lines.push(JSON.stringify(serialized))
        }
      }
      if (lines.length > 0) {
        appendFileSync(this.filePath, `${lines.join("\n")}\n`)
      }
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      this.diagnostics?.({ event: "otel_export_failed", error })
      resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : undefined })
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
