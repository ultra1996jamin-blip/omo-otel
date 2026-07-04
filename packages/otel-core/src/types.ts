import type { OtelExporterKind } from "./constants"

export type OtelEnv = Readonly<Record<string, string | undefined>>

export type OtelFileConfig = {
  readonly enabled?: boolean
  readonly exporter_type?: OtelExporterKind
  readonly exporters?: {
    readonly otlp?: string
  }
  readonly sampling_rate?: number
}

export type OtelConfig = {
  readonly enabled: boolean
  readonly exporter: OtelExporterKind
  readonly otlpEndpoint: string
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly samplingRate: number
  readonly localStoragePath: string
}

export type ResolveOtelConfigInput = {
  readonly env?: OtelEnv
  readonly fileConfig?: OtelFileConfig
  readonly serviceVersion?: string
  readonly homedir?: () => string
}

export type OtelDiagnosticEvent =
  | "otel_init_failed"
  | "otel_export_failed"
  | "otel_shutdown_failed"
  | "otel_span_failed"

export type OtelDiagnosticInput = {
  readonly event: OtelDiagnosticEvent
  readonly error?: unknown
}

export type OtelDiagnostics = (input: OtelDiagnosticInput) => void
