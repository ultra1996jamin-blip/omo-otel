import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { __resetActiveTracerForTesting, initializeOtel } from "./init"
import { recordGenAiUsage } from "./gen-ai-usage-metrics"

describe("recordGenAiUsage", () => {
  afterEach(() => {
    __resetActiveTracerForTesting()
  })

  test("does not throw when otel is disabled (no-op meter)", () => {
    initializeOtel({ env: {} })

    expect(() =>
      recordGenAiUsage({ model: "gpt-5.5", inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0.01 }),
    ).not.toThrow()
  })

  test("records input/output/total token counters and cost, tagged by model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-ai-usage-metrics-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })

      recordGenAiUsage({ model: "gpt-5.5", inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.02 })

      await handle.shutdown()

      const contents = readFileSync(join(dir, "metrics.jsonl"), "utf8")
      const lines = contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))

      const byName = Object.fromEntries(lines.map((l) => [l.name, l]))
      expect(byName["gen_ai.usage.input_tokens"].dataPoints[0].value).toBe(100)
      expect(byName["gen_ai.usage.output_tokens"].dataPoints[0].value).toBe(50)
      expect(byName["gen_ai.usage.total_tokens"].dataPoints[0].value).toBe(150)
      expect(byName["gen_ai.usage.cost"].dataPoints[0].value).toBeCloseTo(0.02)
      expect(byName["gen_ai.usage.input_tokens"].dataPoints[0].attributes["gen_ai.request.model"]).toBe("gpt-5.5")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("skips the cost counter when cost is not provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-ai-usage-metrics-no-cost-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })

      recordGenAiUsage({ model: "big-pickle", inputTokens: 1, outputTokens: 1, totalTokens: 2 })

      await handle.shutdown()

      const contents = readFileSync(join(dir, "metrics.jsonl"), "utf8")
      expect(contents).not.toContain("gen_ai.usage.cost")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
