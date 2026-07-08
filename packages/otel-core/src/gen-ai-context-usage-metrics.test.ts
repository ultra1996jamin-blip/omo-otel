import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { __resetActiveTracerForTesting, initializeOtel } from "./init"
import { recordGenAiContextUsage } from "./gen-ai-context-usage-metrics"

describe("recordGenAiContextUsage", () => {
  afterEach(() => {
    __resetActiveTracerForTesting()
  })

  test("does not throw when otel is disabled (no-op meter)", () => {
    initializeOtel({ env: {} })

    expect(() =>
      recordGenAiContextUsage({ model: "claude-opus-4-7", usageRatio: 0.5, usedTokens: 100_000, limit: 200_000 }),
    ).not.toThrow()
  })

  test("records the usage ratio as a gauge, tagged by model/provider/agent/skill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-ai-context-usage-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })

      recordGenAiContextUsage({
        model: "claude-opus-4-7",
        usageRatio: 0.42,
        usedTokens: 84_000,
        limit: 200_000,
        system: "anthropic",
        agentName: "sisyphus",
        skillUsed: true,
      })

      await handle.shutdown()

      const contents = readFileSync(join(dir, "metrics.jsonl"), "utf8")
      const lines = contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))

      const gauge = lines.find((l) => l.name === "gen_ai.context.usage_ratio")
      expect(gauge).toBeDefined()
      expect(gauge.dataPoints[0].value).toBeCloseTo(0.42)
      expect(gauge.dataPoints[0].attributes["gen_ai.request.model"]).toBe("claude-opus-4-7")
      expect(gauge.dataPoints[0].attributes["gen_ai.system"]).toBe("anthropic")
      expect(gauge.dataPoints[0].attributes["gen_ai.agent.name"]).toBe("sisyphus")
      expect(gauge.dataPoints[0].attributes["gen_ai.skill_used"]).toBe("true")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("omits optional attributes when not provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-ai-context-usage-minimal-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })

      recordGenAiContextUsage({ model: "gpt-5.5", usageRatio: 0.1, usedTokens: 10_000, limit: 100_000 })

      await handle.shutdown()

      const contents = readFileSync(join(dir, "metrics.jsonl"), "utf8")
      expect(contents).not.toContain("gen_ai.system")
      expect(contents).not.toContain("gen_ai.agent.name")
      expect(contents).not.toContain("gen_ai.skill_used")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
