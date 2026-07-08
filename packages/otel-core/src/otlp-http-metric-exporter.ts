import { ExportResultCode, hrTimeToNanoseconds, type ExportResult } from "@opentelemetry/core"
import { DataPointType, type PushMetricExporter, type ResourceMetrics } from "@opentelemetry/sdk-metrics"
import type { OtelDiagnostics } from "./types"

type OtlpAttributeValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number }

function encodeAttributeValue(value: unknown): OtlpAttributeValue {
  if (typeof value === "string") return { stringValue: value }
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  return { stringValue: String(value) }
}

function encodeAttributes(attributes: Record<string, unknown> | undefined): { key: string; value: OtlpAttributeValue }[] {
  if (!attributes) return []
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: encodeAttributeValue(value) }))
}

/**
 * Sum (Counter/UpDownCounter) and Gauge metrics are encoded — Sum for
 * cumulative token/cost usage counters (gen-ai-usage-metrics.ts), Gauge for
 * point-in-time values like context window usage ratio (see
 * gen-ai-context-usage-metrics.ts), which don't make sense as a running sum.
 * Histogram/ExponentialHistogram data points are silently skipped rather
 * than throwing, so adding a new instrument kind later degrades gracefully
 * instead of breaking export entirely.
 */
class UnsupportedInstrumentSkippedError extends Error {}

function encodeDataPoints(dataPoints: readonly import("@opentelemetry/sdk-metrics").DataPoint<number>[]) {
  return dataPoints.map((point) => ({
    attributes: encodeAttributes(point.attributes),
    startTimeUnixNano: String(hrTimeToNanoseconds(point.startTime)),
    timeUnixNano: String(hrTimeToNanoseconds(point.endTime)),
    ...(Number.isInteger(point.value) ? { asInt: String(point.value) } : { asDouble: point.value }),
  }))
}

function encodeMetric(metric: import("@opentelemetry/sdk-metrics").MetricData): Record<string, unknown> {
  const base = {
    name: metric.descriptor.name,
    description: metric.descriptor.description,
    unit: metric.descriptor.unit,
  }
  if (metric.dataPointType === DataPointType.SUM) {
    return {
      ...base,
      sum: {
        dataPoints: encodeDataPoints(metric.dataPoints),
        aggregationTemporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
        isMonotonic: metric.isMonotonic,
      },
    }
  }
  if (metric.dataPointType === DataPointType.GAUGE) {
    return {
      ...base,
      gauge: { dataPoints: encodeDataPoints(metric.dataPoints) },
    }
  }
  throw new UnsupportedInstrumentSkippedError(`unsupported instrument for OTLP export: ${metric.dataPointType}`)
}

/**
 * Minimal OTLP/HTTP JSON metrics exporter — the counterpart to
 * otlp-http-span-exporter.ts, same Bun-compatibility rationale (avoids the
 * official Node http/https + gRPC-based exporter).
 */
export class OtlpHttpMetricExporter implements PushMetricExporter {
  constructor(
    private readonly endpoint: string,
    private readonly diagnostics?: OtelDiagnostics,
  ) {}

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    const encodedMetrics: Record<string, unknown>[] = []
    for (const scopeMetrics of metrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        try {
          encodedMetrics.push(encodeMetric(metric))
        } catch (error) {
          if (!(error instanceof UnsupportedInstrumentSkippedError)) throw error
        }
      }
    }

    if (encodedMetrics.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS })
      return
    }

    const body = JSON.stringify({
      resourceMetrics: [
        {
          resource: { attributes: encodeAttributes(metrics.resource.attributes) },
          scopeMetrics: [
            {
              scope: { name: "oh-my-openagent" },
              metrics: encodedMetrics,
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
          error: new Error(`OTLP metrics export failed: HTTP ${response.status}`),
        })
        resultCallback({ code: ExportResultCode.FAILED })
      })
      .catch((error) => {
        this.diagnostics?.({ event: "otel_export_failed", error })
        resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : undefined })
      })
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
