import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { __resetActiveTracerForTesting, getActiveTracer, initializeOtel } from "./init"

describe("initializeOtel", () => {
  afterEach(() => {
    __resetActiveTracerForTesting()
  })

  test("stays disabled and returns a usable no-op tracer when not enabled", async () => {
    // given / when
    const handle = initializeOtel({ env: {} })

    // then
    expect(handle.enabled).toBe(false)
    expect(() => handle.tracer.startSpan("noop").end()).not.toThrow()
    await expect(handle.shutdown()).resolves.toBeUndefined()
    expect(getActiveTracer()).toBe(handle.tracer)
  })

  test("initializes a real tracer and writes spans to the file exporter", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "otel-core-test-"))

    try {
      // when
      const handle = initializeOtel({
        env: {
          OMO_OTEL_ENABLED: "true",
          OMO_OTEL_EXPORTER: "file",
          OMO_OTEL_LOCAL_STORAGE_PATH: dir,
        },
      })
      expect(handle.enabled).toBe(true)

      const span = handle.tracer.startSpan("test.span", { attributes: { "tool.name": "grep" } })
      span.end()

      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      expect(contents).toContain("test.span")
      expect(contents).toContain("tool.name")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to a no-op tracer if config resolution throws", async () => {
    // given
    const throwingHomedir = (): string => {
      throw new Error("homedir unavailable")
    }

    // when
    const handle = initializeOtel({ env: { OMO_OTEL_ENABLED: "true" }, homedir: throwingHomedir })

    // then
    expect(handle.enabled).toBe(false)
    expect(() => handle.tracer.startSpan("noop").end()).not.toThrow()
  })
})
