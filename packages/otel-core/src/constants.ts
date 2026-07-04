export type OtelExporterKind = "otlp" | "jaeger" | "file" | "console"

export const OTEL_EXPORTER_KINDS: readonly OtelExporterKind[] = ["otlp", "jaeger", "file", "console"]

export const DEFAULT_OTEL_ENABLED = false
export const DEFAULT_OTEL_EXPORTER: OtelExporterKind = "otlp"
export const DEFAULT_OTLP_ENDPOINT = "http://localhost:14318/v1/traces"
export const DEFAULT_SERVICE_NAME = "oh-my-openagent"
export const DEFAULT_SAMPLING_RATE = 1.0
export const DEFAULT_LOCAL_STORAGE_DIRNAME = ".cache/oh-my-openagent"
export const GEN_AI_SYSTEM = "oh-my-openagent"
