import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { resolveOtelConfig } from "./config"

describe("resolveOtelConfig defaults", () => {
  test("is disabled by default (opt-in only)", () => {
    // given / when
    const config = resolveOtelConfig({ env: {} })

    // then
    expect(config.enabled).toBe(false)
    expect(config.exporter).toBe("otlp")
    expect(config.otlpEndpoint).toBe("http://localhost:14318/v1/traces")
    expect(config.serviceName).toBe("oh-my-openagent")
    expect(config.samplingRate).toBe(1.0)
  })

  test("honors OMO_OTEL_ENABLED=true", () => {
    // given / when
    const config = resolveOtelConfig({ env: { OMO_OTEL_ENABLED: "true" } })

    // then
    expect(config.enabled).toBe(true)
  })

  test("falls back to fileConfig when env is unset", () => {
    // given / when
    const config = resolveOtelConfig({
      env: {},
      fileConfig: { enabled: true, exporter_type: "file", sampling_rate: 0.25 },
    })

    // then
    expect(config.enabled).toBe(true)
    expect(config.exporter).toBe("file")
    expect(config.samplingRate).toBe(0.25)
  })

  test("env overrides fileConfig", () => {
    // given / when
    const config = resolveOtelConfig({
      env: { OMO_OTEL_ENABLED: "false", OMO_OTEL_EXPORTER: "console" },
      fileConfig: { enabled: true, exporter_type: "file" },
    })

    // then
    expect(config.enabled).toBe(false)
    expect(config.exporter).toBe("console")
  })

  test("ignores an unknown exporter value", () => {
    // given / when
    const config = resolveOtelConfig({ env: { OMO_OTEL_EXPORTER: "nope" } })

    // then
    expect(config.exporter).toBe("otlp")
  })

  test("clamps an out-of-range sampling rate", () => {
    // given / when
    const config = resolveOtelConfig({ env: { OMO_OTEL_SAMPLING_RATE: "5" } })

    // then
    expect(config.samplingRate).toBe(1)
  })

  test("expands the default local storage path under homedir", () => {
    // given / when
    const config = resolveOtelConfig({ env: {}, homedir: () => "/home/test-user" })

    // then
    expect(config.localStoragePath).toBe(join("/home/test-user", ".cache/oh-my-openagent"))
  })

  test("honors an explicit OMO_OTEL_LOCAL_STORAGE_PATH", () => {
    // given / when
    const config = resolveOtelConfig({ env: { OMO_OTEL_LOCAL_STORAGE_PATH: "C:\\traces" } })

    // then
    expect(config.localStoragePath).toBe("C:\\traces")
  })
})
