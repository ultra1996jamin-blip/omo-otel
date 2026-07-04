import { getActiveTracer, initializeOtel, type OtelDiagnosticInput, type OtelFileConfig } from "@oh-my-opencode/otel-core"
import type { Tracer } from "@opentelemetry/api"
import packageJson from "../../../../package.json" with { type: "json" }
import type { OtelConfig as OtelPluginConfig } from "../config/schema/otel"
import { log } from "./logger"

function logOtelDiagnostic(input: OtelDiagnosticInput): void {
  log("[otel] diagnostic", {
    event: input.event,
    error: input.error === undefined ? undefined : String(input.error),
  })
}

function toFileConfig(config: OtelPluginConfig | undefined): OtelFileConfig | undefined {
  if (!config) return undefined
  return {
    enabled: config.enabled,
    exporter_type: config.exporter_type,
    exporters: config.exporters,
    sampling_rate: config.sampling_rate,
  }
}

/**
 * Initializes OTEL tracing for the plugin process. Opt-in only
 * (OMO_OTEL_ENABLED / config.otel.enabled) and never throws — telemetry
 * failures must not affect agent execution (QA-02).
 */
export function initializePluginOtel(input: { config?: OtelPluginConfig } = {}): void {
  initializeOtel({
    env: process.env,
    fileConfig: toFileConfig(input.config),
    serviceVersion: packageJson.version,
    diagnostics: logOtelDiagnostic,
  })
}

export function getPluginTracer(): Tracer {
  return getActiveTracer()
}
