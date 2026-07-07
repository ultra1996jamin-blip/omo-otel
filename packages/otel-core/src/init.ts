import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api"
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  TraceIdRatioBasedSampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base"
import { ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import { resolveOtelConfig } from "./config"
import { FileMetricExporter } from "./file-metric-exporter"
import { FileSpanExporter } from "./file-span-exporter"
import { OtlpHttpMetricExporter } from "./otlp-http-metric-exporter"
import { OtlpHttpSpanExporter } from "./otlp-http-span-exporter"
import type { OtelConfig, OtelDiagnostics, ResolveOtelConfigInput } from "./types"

const NOOP_TRACER = trace.getTracer("oh-my-openagent-noop")
const NOOP_METER = metrics.getMeter("oh-my-openagent-noop")

let activeTracer: Tracer | null = null
let activeMeter: Meter | null = null

export type InitializeOtelInput = ResolveOtelConfigInput & {
  readonly diagnostics?: OtelDiagnostics
}

export type OtelHandle = {
  readonly enabled: boolean
  readonly tracer: Tracer
  readonly meter: Meter
  readonly shutdown: () => Promise<void>
}

function createExporter(config: OtelConfig, diagnostics?: OtelDiagnostics): SpanExporter {
  switch (config.exporter) {
    case "file":
      return new FileSpanExporter(config.localStoragePath, diagnostics)
    case "console":
      return new ConsoleSpanExporter()
    case "jaeger":
    case "otlp":
    default:
      // The otel-collector fans out to Jaeger/OpenLIT/Prometheus internally,
      // so "jaeger" mode shares the same OTLP/HTTP ingress as "otlp" (AS-04).
      return new OtlpHttpSpanExporter(config.otlpEndpoint, diagnostics)
  }
}

// config.otlpEndpoint is traces-specific by construction (its default is
// ".../v1/traces", not a bare host:port — see DEFAULT_OTLP_ENDPOINT) — the
// collector's OTLP/HTTP receiver dispatches by URL path (/v1/traces vs
// /v1/metrics on the same host:port), so metrics need that suffix swapped
// rather than reusing the traces URL verbatim. Falls back to appending
// /v1/metrics for a customized endpoint that doesn't end in /v1/traces.
function deriveOtlpMetricsEndpoint(tracesEndpoint: string): string {
  if (tracesEndpoint.endsWith("/v1/traces")) {
    return `${tracesEndpoint.slice(0, -"/v1/traces".length)}/v1/metrics`
  }
  return `${tracesEndpoint.replace(/\/+$/, "")}/v1/metrics`
}

function createMetricExporter(config: OtelConfig, diagnostics?: OtelDiagnostics): PushMetricExporter {
  switch (config.exporter) {
    case "file":
      return new FileMetricExporter(config.localStoragePath, diagnostics)
    case "console":
      return new ConsoleMetricExporter()
    case "jaeger":
    case "otlp":
    default:
      // Metrics share the same OTLP/HTTP collector as traces, just on the
      // sibling /v1/metrics path.
      return new OtlpHttpMetricExporter(deriveOtlpMetricsEndpoint(config.otlpEndpoint), diagnostics)
  }
}

/**
 * Initializes OTEL tracing per AS-01 (graceful degradation): any failure
 * here — bad config, exporter construction errors — falls back to a no-op
 * tracer instead of throwing, so agent execution is never affected.
 */
export function initializeOtel(input: InitializeOtelInput = {}): OtelHandle {
  try {
    const config = resolveOtelConfig(input)

    if (!config.enabled) {
      activeTracer = null
      activeMeter = null
      return { enabled: false, tracer: NOOP_TRACER, meter: NOOP_METER, shutdown: async () => {} }
    }

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      ...(config.serviceVersion ? { [ATTR_SERVICE_VERSION]: config.serviceVersion } : {}),
    })

    const exporter = createExporter(config, input.diagnostics)
    const provider = new BasicTracerProvider({
      resource,
      sampler: new TraceIdRatioBasedSampler(config.samplingRate),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    })

    // @opentelemetry/api's global tracer provider registers only once per
    // process — a second `setGlobalTracerProvider` call silently no-ops. That
    // breaks re-initialization (config reload, or multiple tests in one
    // process), so force the update on the proxy the API already returned.
    trace.setGlobalTracerProvider(provider)
    const proxyProvider = trace.getTracerProvider() as unknown as { setDelegate?: (delegate: unknown) => void }
    proxyProvider.setDelegate?.(provider)
    const tracer = trace.getTracer(config.serviceName, config.serviceVersion)
    activeTracer = tracer

    // Same signal, separate SDK/provider — metrics (token/cost usage
    // counters, see gen-ai-usage-metrics.ts) are independent of the trace
    // pipeline above; a metrics init failure must not affect tracing (or
    // vice versa), so this is deliberately NOT wrapped in the tracer's own
    // try/catch scope — falling through to the outer catch would tear down
    // tracing too. Consuming code only ever calls getActiveMeter() (never
    // metrics.getMeter() directly), so the global registration below is
    // best-effort interop, not load-bearing — no ProxyMeterProvider
    // setDelegate escape hatch exists (unlike traces), and none is needed.
    const metricExporter = createMetricExporter(config, input.diagnostics)
    const meterProvider = new MeterProvider({
      resource,
      readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 15000 })],
    })
    metrics.setGlobalMeterProvider(meterProvider)
    const meter = meterProvider.getMeter(config.serviceName, config.serviceVersion)
    activeMeter = meter

    return {
      enabled: true,
      tracer,
      meter,
      shutdown: async () => {
        try {
          await Promise.all([provider.shutdown(), meterProvider.shutdown()])
        } catch (error) {
          input.diagnostics?.({ event: "otel_shutdown_failed", error })
        }
      },
    }
  } catch (error) {
    input.diagnostics?.({ event: "otel_init_failed", error })
    activeTracer = null
    activeMeter = null
    return { enabled: false, tracer: NOOP_TRACER, meter: NOOP_METER, shutdown: async () => {} }
  }
}

export function getActiveTracer(): Tracer {
  return activeTracer ?? NOOP_TRACER
}

export function getActiveMeter(): Meter {
  return activeMeter ?? NOOP_METER
}

/** @internal test-only seam. */
export function __resetActiveTracerForTesting(): void {
  activeTracer = null
  activeMeter = null
}
