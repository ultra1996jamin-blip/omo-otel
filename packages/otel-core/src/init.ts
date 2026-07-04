import { trace, type Tracer } from "@opentelemetry/api"
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  TraceIdRatioBasedSampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import { resolveOtelConfig } from "./config"
import { FileSpanExporter } from "./file-span-exporter"
import { OtlpHttpSpanExporter } from "./otlp-http-span-exporter"
import type { OtelConfig, OtelDiagnostics, ResolveOtelConfigInput } from "./types"

const NOOP_TRACER = trace.getTracer("oh-my-openagent-noop")

let activeTracer: Tracer | null = null

export type InitializeOtelInput = ResolveOtelConfigInput & {
  readonly diagnostics?: OtelDiagnostics
}

export type OtelHandle = {
  readonly enabled: boolean
  readonly tracer: Tracer
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
      return { enabled: false, tracer: NOOP_TRACER, shutdown: async () => {} }
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

    return {
      enabled: true,
      tracer,
      shutdown: async () => {
        try {
          await provider.shutdown()
        } catch (error) {
          input.diagnostics?.({ event: "otel_shutdown_failed", error })
        }
      },
    }
  } catch (error) {
    input.diagnostics?.({ event: "otel_init_failed", error })
    activeTracer = null
    return { enabled: false, tracer: NOOP_TRACER, shutdown: async () => {} }
  }
}

export function getActiveTracer(): Tracer {
  return activeTracer ?? NOOP_TRACER
}

/** @internal test-only seam. */
export function __resetActiveTracerForTesting(): void {
  activeTracer = null
}
