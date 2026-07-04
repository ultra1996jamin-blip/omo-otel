import { homedir as osHomedir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_LOCAL_STORAGE_DIRNAME,
  DEFAULT_OTEL_ENABLED,
  DEFAULT_OTEL_EXPORTER,
  DEFAULT_OTLP_ENDPOINT,
  DEFAULT_SAMPLING_RATE,
  DEFAULT_SERVICE_NAME,
  OTEL_EXPORTER_KINDS,
  type OtelExporterKind,
} from "./constants"
import type { OtelConfig, OtelEnv, ResolveOtelConfigInput } from "./types"

const TRUTHY_VALUES = ["1", "true", "yes", "on"]
const FALSY_VALUES = ["0", "false", "no", "off"]

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = normalize(value)?.toLowerCase()
  if (normalized === undefined) return undefined
  if (TRUTHY_VALUES.includes(normalized)) return true
  if (FALSY_VALUES.includes(normalized)) return false
  return undefined
}

function parseExporterKind(value: string | undefined): OtelExporterKind | undefined {
  const normalized = normalize(value)?.toLowerCase()
  if (normalized === undefined) return undefined
  return (OTEL_EXPORTER_KINDS as readonly string[]).includes(normalized)
    ? (normalized as OtelExporterKind)
    : undefined
}

function parseSamplingRate(value: string | undefined): number | undefined {
  const normalized = normalize(value)
  if (normalized === undefined) return undefined
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return undefined
  return clampSamplingRate(parsed)
}

function clampSamplingRate(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

export function resolveOtelConfig(input: ResolveOtelConfigInput = {}): OtelConfig {
  const env: OtelEnv = input.env ?? process.env
  const fileConfig = input.fileConfig
  const homedir = input.homedir ?? osHomedir

  const enabled =
    parseBoolean(env.OMO_OTEL_ENABLED) ?? fileConfig?.enabled ?? DEFAULT_OTEL_ENABLED

  const exporter =
    parseExporterKind(env.OMO_OTEL_EXPORTER) ?? fileConfig?.exporter_type ?? DEFAULT_OTEL_EXPORTER

  const otlpEndpoint =
    normalize(env.OTEL_EXPORTER_OTLP_ENDPOINT) ?? fileConfig?.exporters?.otlp ?? DEFAULT_OTLP_ENDPOINT

  const serviceName = normalize(env.OTEL_SERVICE_NAME) ?? DEFAULT_SERVICE_NAME

  const serviceVersion = normalize(env.OTEL_SERVICE_VERSION) ?? input.serviceVersion

  const samplingRate =
    parseSamplingRate(env.OMO_OTEL_SAMPLING_RATE) ?? clampSamplingRate(fileConfig?.sampling_rate ?? DEFAULT_SAMPLING_RATE)

  const localStoragePath =
    normalize(env.OMO_OTEL_LOCAL_STORAGE_PATH) ?? join(homedir(), DEFAULT_LOCAL_STORAGE_DIRNAME)

  return {
    enabled,
    exporter,
    otlpEndpoint,
    serviceName,
    serviceVersion,
    samplingRate,
    localStoragePath,
  }
}
