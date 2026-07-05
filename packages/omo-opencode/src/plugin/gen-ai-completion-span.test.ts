import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetActiveTracerForTesting, initializeOtel, sessionSpanContext } from "@oh-my-opencode/otel-core"
import { trace } from "@opentelemetry/api"

import {
  __resetRootRaceRetryDelaysForTesting,
  __setRootRaceRetryDelaysForTesting,
  captureFirstUserPrompt,
  captureOutgoingPrompt,
  recordGenAiCompletionSpan,
} from "./gen-ai-completion-span"

describe("recordGenAiCompletionSpan", () => {
  afterEach(() => {
    __resetActiveTracerForTesting()
  })

  test("does not throw when otel is disabled", async () => {
    // given
    initializeOtel({ env: {} })

    // when / then
    await expect(
      recordGenAiCompletionSpan(
        {
          id: "msg_1",
          providerID: "anthropic",
          modelID: "claude-opus-4-7",
          cost: 0.05,
          tokens: { input: 100, output: 50, reasoning: 10 },
          time: { created: Date.now(), completed: Date.now() + 500 },
        },
        "session-1",
      ),
    ).resolves.toBeUndefined()
  })

  test("does not throw when required fields are missing", async () => {
    // given
    initializeOtel({ env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "console" } })

    // when / then
    await expect(recordGenAiCompletionSpan({}, "session-1")).resolves.toBeUndefined()
    await expect(recordGenAiCompletionSpan({ id: "msg_2", modelID: "gpt-5.5" }, "session-1")).resolves.toBeUndefined()
  })

  test("does not record the same messageId twice", async () => {
    // given
    initializeOtel({ env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "console" } })
    const info = {
      id: "msg_dedupe",
      providerID: "opencode",
      modelID: "gpt-5.5",
      cost: 0.01,
      tokens: { input: 10, output: 5 },
    }

    // when / then — second call is a silent no-op, not an error
    await expect(recordGenAiCompletionSpan(info, "session-1")).resolves.toBeUndefined()
    await expect(recordGenAiCompletionSpan(info, "session-1")).resolves.toBeUndefined()
  })

  test("fetches and attaches prompt/response text when a client is provided", async () => {
    // given
    initializeOtel({ env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "console" } })
    const client = {
      session: {
        messages: async () => [
          { id: "user_1", parts: [{ type: "text", text: "what does this function do?" }] },
          { id: "asst_1", info: { parentID: "user_1" }, parts: [{ type: "text", text: "it does X." }] },
        ],
      },
    }

    // when / then
    await expect(
      recordGenAiCompletionSpan(
        { id: "asst_1", parentID: "user_1", modelID: "gpt-5.5", providerID: "opencode", tokens: { input: 5, output: 3 } },
        "session-1",
        client,
      ),
    ).resolves.toBeUndefined()
  })

  test("does not throw when the client fetch fails", async () => {
    // given
    initializeOtel({ env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "console" } })
    const failingClient = {
      session: {
        messages: async () => {
          throw new Error("network down")
        },
      },
    }

    // when / then
    await expect(
      recordGenAiCompletionSpan(
        { id: "asst_fail", modelID: "gpt-5.5", providerID: "opencode", tokens: { input: 1, output: 1 } },
        "session-1",
        failingClient,
      ),
    ).resolves.toBeUndefined()
  })

  test("prompt captured at LLM-request time wins over the parentID fallback", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "outgoing-prompt-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const sessionID = "session-outgoing"
      // simulates experimental.chat.messages.transform firing right before the LLM call
      captureOutgoingPrompt([
        { info: { role: "user", sessionID }, parts: [{ type: "text", text: "첫 번째 턴 프롬프트" }] },
        { info: { role: "assistant", sessionID }, parts: [{ type: "text", text: "이전 응답" }] },
        { info: { role: "user", sessionID }, parts: [{ type: "text", text: "두 번째 턴 프롬프트" }] },
      ])
      const client = {
        session: {
          messages: async () => [
            { id: "user_old", parts: [{ type: "text", text: "세션 최초 프롬프트 (fallback이 찾는 것)" }] },
            { id: "asst_x", info: { parentID: "user_old" }, parts: [{ type: "text", text: "응답 텍스트" }] },
          ],
        },
      }

      // when
      await recordGenAiCompletionSpan(
        { id: "asst_x", parentID: "user_old", modelID: "gpt-5.5", providerID: "opencode", tokens: { input: 5, output: 3 } },
        sessionID,
        client,
      )
      await handle.shutdown()

      // then — the latest outgoing user turn, not the session's first message
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spanLine = contents.split("\n").find((line) => line.includes("gen_ai.completion.gpt-5.5"))
      expect(spanLine).toBeDefined()
      const attrs = JSON.parse(spanLine!).attributes
      expect(attrs["gen_ai.prompt"]).toBe("두 번째 턴 프롬프트")
      expect(attrs["gen_ai.completion"]).toBe("응답 텍스트")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("records the prompt and response as separately named span events, not just attributes", async () => {
    // given — distinct events make user vs. assistant content visually
    // distinguishable in Jaeger's Logs panel, instead of two long text
    // attributes sitting next to numeric usage attributes.
    const dir = mkdtempSync(join(tmpdir(), "gen-ai-events-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const client = {
        session: {
          messages: async () => [
            { id: "user_evt", parts: [{ type: "text", text: "질문입니다" }] },
            { id: "asst_evt", info: { parentID: "user_evt" }, parts: [{ type: "text", text: "답변입니다" }] },
          ],
        },
      }

      // when
      await recordGenAiCompletionSpan(
        { id: "asst_evt", parentID: "user_evt", modelID: "gpt-5.5", providerID: "opencode", tokens: { input: 5, output: 3 } },
        "session-events",
        client,
      )
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spanLine = contents.split("\n").find((line) => line.includes("gen_ai.completion.gpt-5.5"))
      expect(spanLine).toBeDefined()
      const events = JSON.parse(spanLine!).events as Array<{ name: string; attributes: Record<string, unknown> }>
      expect(events).toHaveLength(2)
      expect(events.find((e) => e.name === "gen_ai.user.message")?.attributes.content).toBe("질문입니다")
      expect(events.find((e) => e.name === "gen_ai.assistant.message")?.attributes.content).toBe("답변입니다")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("captureFirstUserPrompt", () => {
  afterEach(() => {
    __resetActiveTracerForTesting()
  })

  test("does not throw without a client", async () => {
    // given
    initializeOtel({ env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "console" } })

    // when / then
    await expect(captureFirstUserPrompt({ id: "user_1" }, "session-x")).resolves.toBeUndefined()
  })

  test("does not throw when the client fetch fails", async () => {
    // given
    initializeOtel({ env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "console" } })
    const failingClient = {
      session: {
        messages: async () => {
          throw new Error("network down")
        },
      },
    }

    // when / then
    await expect(captureFirstUserPrompt({ id: "user_1" }, "session-x", failingClient)).resolves.toBeUndefined()
  })

  test("records a user.prompt span with the prompt text", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "first-prompt-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const client = {
        session: {
          messages: async () => [
            { id: "user_first", parts: [{ type: "text", text: "very first prompt" }] },
          ],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_first" }, "session-first-prompt", client)
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("user.prompt"))
      expect(promptLine).toBeDefined()
      expect(JSON.parse(promptLine!).attributes["gen_ai.prompt"]).toBe("very first prompt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("re-establishes user.prompt as the new root after the previous root expired (long-idle conversation resumed)", async () => {
    // given — reproduces the live bug: SessionSpanContext expires a session's
    // root after DEFAULT_SESSION_IDLE_MS of inactivity (simulated here via
    // release()). The old dedup keyed on sessionID would permanently block
    // this session from ever getting user.prompt again — the next turn would
    // silently fall back to an anonymous session.turn root with no visible
    // prompt at all. Deduping by message id instead means a later message
    // (different id, same sessionID) still gets its own chance.
    const dir = mkdtempSync(join(tmpdir(), "session-resume-after-expiry-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const sessionID = "session-long-idle-resume"
      const client = {
        session: {
          messages: async () => [
            { id: "user_turn_1", parts: [{ type: "text", text: "첫 번째 턴" }] },
            { id: "user_turn_2", parts: [{ type: "text", text: "10분 넘게 쉬었다가 재개한 턴" }] },
          ],
        },
      }

      // when — first turn captured normally, then the root expires (idle timeout)
      await captureFirstUserPrompt({ id: "user_turn_1" }, sessionID, client)
      sessionSpanContext.release(sessionID) // simulates DEFAULT_SESSION_IDLE_MS elapsing
      await captureFirstUserPrompt({ id: "user_turn_2" }, sessionID, client)
      await handle.shutdown()

      // then — two separate user.prompt roots, not one user.prompt + one
      // silently-dropped session.turn
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const spans = contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
      const userPromptSpans = spans.filter((s) => s.name === "user.prompt")
      expect(userPromptSpans).toHaveLength(2)
      expect(userPromptSpans.map((s) => s.attributes["gen_ai.prompt"]).sort()).toEqual(
        ["10분 넘게 쉬었다가 재개한 턴", "첫 번째 턴"].sort()
      )
      expect(spans.find((s) => s.name === "session.turn")).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the user.prompt span IS the trace root (no separate parent) when nothing else raced ahead", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "first-prompt-root-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const client = {
        session: {
          messages: async () => [{ id: "user_root", parts: [{ type: "text", text: "루트가 되어야 하는 프롬프트" }] }],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_root" }, "session-root-prompt", client)
      await handle.shutdown()

      // then — exactly one span, named user.prompt, with no parent — it IS
      // the root, so it's guaranteed to render first in the waterfall
      // instead of being nested under a separate generic stamp.
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const lines = contents.split("\n").filter((line) => line.trim().length > 0)
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0]!)
      expect(parsed.name).toBe("user.prompt")
      expect(parsed.parentSpanId).toBeUndefined()
      expect(parsed.attributes["gen_ai.prompt"]).toBe("루트가 되어야 하는 프롬프트")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to a child user.prompt span (non-delegated race) when an unrelated span already won the root race", async () => {
    // given — a plain top-level session (no parentID) where some unrelated
    // span raced ahead and stamped a generic root before this async fetch
    // resolved. This message is still the session's genuine first message,
    // so it should surface as a child user.prompt — NOT silently skipped
    // (skipping is only correct for a later turn of an already-live
    // conversation, not this "lost the race but still the first message"
    // case) and NOT labeled agent.prompt (no delegation involved: the mock
    // client has no session.get, so isDelegatedSubSession resolves false).
    const dir = mkdtempSync(join(tmpdir(), "first-prompt-race-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const sessionID = "session-raced-prompt"
      sessionSpanContext.getContext(sessionID) // some other span wins the race first
      const client = {
        session: {
          messages: async () => [{ id: "user_raced", parts: [{ type: "text", text: "늦게 도착한 프롬프트" }] }],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_raced" }, sessionID, client)
      await handle.shutdown()

      // then — a session.turn root plus a child user.prompt span
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("\"name\":\"user.prompt\""))
      expect(promptLine).toBeDefined()
      const parsed = JSON.parse(promptLine!)
      expect(parsed.parentSpanId).toBeDefined()
      expect(parsed.attributes["gen_ai.prompt"]).toBe("늦게 도착한 프롬프트")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("waits for a sub-agent's root to bind instead of stamping an orphaned standalone root", async () => {
    // given — reproduces the live bug: bindRoot() for a delegated sub-agent
    // session always runs synchronously right after its sessionID is known,
    // but this function's own async message fetch can occasionally resolve
    // first. Without the wait, this would eagerly stamp a standalone root
    // (its own new trace) that bindRoot() then silently supersedes moments
    // later, leaving the stamp as a disconnected single-span trace forever.
    const dir = mkdtempSync(join(tmpdir(), "delegation-race-test-"))
    try {
      __setRootRaceRetryDelaysForTesting(5_000)
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const sessionID = "session-sub-agent-race"
      const client = {
        session: {
          messages: async () => [{ id: "user_race2", parts: [{ type: "text", text: "Test the explore agent." }] }],
          get: async () => ({ data: { parentID: "session-orchestrator" } }),
        },
      }
      const agentExecuteSpan = trace.getTracer("test").startSpan("agent.execute.explore")

      // when — bindRoot lands shortly after this call starts, within the retry window
      const capturePromise = captureFirstUserPrompt({ id: "user_race2" }, sessionID, client)
      setTimeout(() => sessionSpanContext.bindRoot(sessionID, agentExecuteSpan), 15)
      await capturePromise
      agentExecuteSpan.end()
      await handle.shutdown()

      // then — agent.prompt nests under the agent.execute span; no
      // separately-traced orphaned "user.prompt" root was ever stamped
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const lines = contents.split("\n").filter((line) => line.trim().length > 0)
      const spans = lines.map((line) => JSON.parse(line))
      expect(spans.find((s) => s.name === "user.prompt")).toBeUndefined()
      const promptSpan = spans.find((s) => s.name === "agent.prompt")
      expect(promptSpan).toBeDefined()
      expect(promptSpan.parentSpanId).toBe(agentExecuteSpan.spanContext().spanId)
      expect(promptSpan.traceId).toBe(agentExecuteSpan.spanContext().traceId)
    } finally {
      __resetRootRaceRetryDelaysForTesting()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("survives a BACKGROUND delegation's much longer bindRoot delay (waitForBackgroundSessionStart), not just a sync one", async () => {
    // given — reproduces the live bug precisely: background delegation
    // (delegate-task/background-task.ts, call-omo-agent/background-executor.ts)
    // only calls bindRoot() after waitForBackgroundSessionStart() reports the
    // session started — a 100ms-interval poll loop, not an immediate
    // synchronous call like the sync path. Observed live: a batch of
    // background sub-agent dispatches next to sync ones in the same
    // orchestrator run — the sync ones got agent.prompt correctly, several
    // background ones did not (each became a disconnected user.prompt-rooted
    // trace) because the original 20/40/60ms retry budget was nowhere near
    // long enough for this. This test's delay (well past the old fixed-schedule
    // total) would have failed before the fix and must pass now — the
    // event-driven wait resolves the instant bindRoot() fires regardless of
    // how generous the ceiling is.
    const dir = mkdtempSync(join(tmpdir(), "delegation-race-background-test-"))
    try {
      __setRootRaceRetryDelaysForTesting(5_000)
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const sessionID = "session-background-sub-agent-race"
      const client = {
        session: {
          messages: async () => [{ id: "user_race4", parts: [{ type: "text", text: "Test the librarian agent." }] }],
          get: async () => ({ data: { parentID: "session-orchestrator" } }),
        },
      }
      const agentExecuteSpan = trace.getTracer("test").startSpan("agent.execute.librarian")

      // when — bindRoot lands well past the old 120ms budget (at 300ms),
      // simulating a slow waitForBackgroundSessionStart poll cycle
      const capturePromise = captureFirstUserPrompt({ id: "user_race4" }, sessionID, client)
      setTimeout(() => sessionSpanContext.bindRoot(sessionID, agentExecuteSpan), 300)
      await capturePromise
      agentExecuteSpan.end()
      await handle.shutdown()

      // then — still nests under agent.execute, no disconnected trace
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const lines = contents.split("\n").filter((line) => line.trim().length > 0)
      const spans = lines.map((line) => JSON.parse(line))
      expect(spans.find((s) => s.name === "user.prompt")).toBeUndefined()
      const promptSpan = spans.find((s) => s.name === "agent.prompt")
      expect(promptSpan).toBeDefined()
      expect(promptSpan.parentSpanId).toBe(agentExecuteSpan.spanContext().spanId)
      expect(promptSpan.traceId).toBe(agentExecuteSpan.spanContext().traceId)
    } finally {
      __resetRootRaceRetryDelaysForTesting()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to stamping its own root as agent.prompt (not user.prompt) if a sub-agent's bind never arrives within the wait ceiling", async () => {
    // given — the wait is a bounded grace period, not a guarantee; if
    // bindRoot() genuinely never comes, this must still record something
    // rather than silently dropping the prompt. Reproduces a live bug: this
    // self-rooted stamp was hardcoded to "user.prompt" regardless of
    // isDelegated, mislabeling a confirmed sub-agent session's synthetic
    // delegation prompt (e.g. "Return a simple JSON response...") as if a
    // human had typed it. Since isDelegatedSubSession already confirmed a
    // parentID here, it must be named agent.prompt even in this fallback.
    const dir = mkdtempSync(join(tmpdir(), "delegation-race-timeout-test-"))
    try {
      __setRootRaceRetryDelaysForTesting(15)
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const client = {
        session: {
          messages: async () => [{ id: "user_race3", parts: [{ type: "text", text: "늦어도 결국 기록됨" }] }],
          get: async () => ({ data: { parentID: "session-orchestrator" } }),
        },
      }

      // when — bindRoot never arrives
      await captureFirstUserPrompt({ id: "user_race3" }, "session-sub-agent-timeout", client)
      await handle.shutdown()

      // then — still recorded, as the session's own root, but named agent.prompt
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const lines = contents.split("\n").filter((line) => line.trim().length > 0)
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0]!)
      expect(parsed.name).toBe("agent.prompt")
      expect(parsed.parentSpanId).toBeUndefined()
      expect(parsed.attributes["gen_ai.prompt"]).toBe("늦어도 결국 기록됨")
    } finally {
      __resetRootRaceRetryDelaysForTesting()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("prefers real human text over an internal-initiator-marked delegation prompt in the same message", async () => {
    // given — OMO's delegate-task/call-omo-agent path marks internally
    // constructed handoff prompts with OMO_INTERNAL_INITIATOR so they can be
    // told apart from what a human actually typed (see
    // packages/utils/src/internal-initiator-marker.ts). A message can carry
    // BOTH: a real human text part and, in some flows, an internal one.
    const dir = mkdtempSync(join(tmpdir(), "internal-initiator-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const client = {
        session: {
          messages: async () => [
            {
              id: "user_delegated",
              parts: [
                {
                  type: "text",
                  text: "[CONTEXT] internal handoff prompt built by the plan agent\n<!-- OMO_INTERNAL_INITIATOR -->",
                },
              ],
            },
          ],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_delegated" }, "session-internal-only", client)
      await handle.shutdown()

      // then — no real human text exists, so the fallback pass surfaces the
      // internal prompt, but with the marker comment stripped out.
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("user.prompt"))
      expect(promptLine).toBeDefined()
      expect(JSON.parse(promptLine!).attributes["gen_ai.prompt"]).toBe(
        "[CONTEXT] internal handoff prompt built by the plan agent",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("excludes internal-initiator-marked parts when real human text also exists", async () => {
    // given — a message with both a real human part and a separate
    // internal-marked part must show only the human one, not both joined.
    const dir = mkdtempSync(join(tmpdir(), "internal-initiator-mixed-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const client = {
        session: {
          messages: async () => [
            {
              id: "user_mixed",
              parts: [
                { type: "text", text: "실제로 사람이 입력한 질문입니다" },
                { type: "text", text: "[CONTEXT] synthetic delegation preamble\n<!-- OMO_INTERNAL_INITIATOR -->" },
              ],
            },
          ],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_mixed" }, "session-mixed", client)
      await handle.shutdown()

      // then — only the real human text, not stacked with the internal part
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("user.prompt"))
      expect(promptLine).toBeDefined()
      expect(JSON.parse(promptLine!).attributes["gen_ai.prompt"]).toBe("실제로 사람이 입력한 질문입니다")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("strips injected mode directives so the user's actual words survive truncation", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "strip-directive-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      // keyword-detector injects directives into the SAME text part:
      // `${directives}\n\n---\n\n${originalText}` (hook.ts)
      const injectedText = `<ultrawork-mode>\n\n${"MANDATORY DIRECTIVE ".repeat(400)}\n\n---\n\n트레이스 연결 고쳐줘`
      const client = {
        session: {
          messages: async () => [
            { id: "user_ulw", parts: [{ type: "text", text: injectedText }] },
          ],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_ulw" }, "session-strip-directive", client)
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("user.prompt"))
      expect(promptLine).toBeDefined()
      expect(JSON.parse(promptLine!).attributes["gen_ai.prompt"]).toBe("트레이스 연결 고쳐줘")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("strips the directive banner even when the banner itself contains markdown --- rules", async () => {
    // given — packages/prompts-core/prompts/ultrawork/*.md use standalone
    // "---" horizontal rules inside the banner body. The hook's own appended
    // separator is always the LAST "\n\n---\n\n" in the string, so stripping
    // must search from the end, not the first match (which would land on one
    // of the banner's internal rules and leave banner text mixed with the
    // real prompt).
    const dir = mkdtempSync(join(tmpdir(), "strip-directive-internal-rule-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const injectedText = [
        "## NO EXCUSES. NO COMPROMISES.",
        "",
        "**Section one.**",
        "",
        "---",
        "",
        "**Section two.**",
        "",
        "---",
        "",
        "트레이스 연결 고쳐줘",
      ].join("\n")
      const client = {
        session: {
          messages: async () => [{ id: "user_ulw2", parts: [{ type: "text", text: injectedText }] }],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_ulw2" }, "session-strip-directive-internal-rule", client)
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("user.prompt"))
      expect(promptLine).toBeDefined()
      expect(JSON.parse(promptLine!).attributes["gen_ai.prompt"]).toBe("트레이스 연결 고쳐줘")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("extracts the real human argument from an auto-slash-command template's ## User Request section", async () => {
    // given — reproduces the live bug precisely: typing "/init-deep ulw"
    // goes through hooks/auto-slash-command/hook.ts, which wraps the whole
    // reconstructed command template (name, description, scope, the full
    // "## Command Instructions" body, THEN "## User Request\n{args}") in
    // <auto-slash-command>...</auto-slash-command> (see executor.ts's
    // formatCommandTemplate, lines 78-124). Before this fix, stripInjectedDirectives'
    // "\n\n---\n\n" heuristic accidentally matched the template's OWN
    // separator before "## User Request", leaving "## User Request\n\nulw\n
    // </auto-slash-command>" as the captured prompt — not the same bug as
    // the <user-request>-tag case above, a third independent mechanism.
    const dir = mkdtempSync(join(tmpdir(), "auto-slash-command-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const injectedText = [
        "<auto-slash-command>",
        "# /init-deep Command",
        "",
        "**User Arguments**: ulw",
        "",
        "**Scope**: project",
        "---",
        "## Command Instructions",
        "",
        "## Anti-Patterns",
        "",
        "- **Static agent count**: MUST vary agents based on project size/depth",
        "- **Sequential execution**: MUST parallel (explore + LSP + codegraph concurrent)",
        "",
        "",
        "---",
        "## User Request",
        "",
        "ulw",
        "</auto-slash-command>",
      ].join("\n")
      const client = {
        session: {
          messages: async () => [{ id: "user_autoslash", parts: [{ type: "text", text: injectedText }] }],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_autoslash" }, "session-auto-slash-command", client)
      await handle.shutdown()

      // then — just "ulw", not "## User Request\n\nulw\n</auto-slash-command>"
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("user.prompt"))
      expect(promptLine).toBeDefined()
      expect(JSON.parse(promptLine!).attributes["gen_ai.prompt"]).toBe("ulw")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to dropping just the wrapper tags when an auto-slash-command has no free-text arguments", async () => {
    // given — formatCommandTemplate only appends "## User Request" when args
    // is non-empty (executor.ts:117). A bare "/init-deep" with no argument
    // never gets that section — there's nothing more specific to extract.
    const dir = mkdtempSync(join(tmpdir(), "auto-slash-command-no-args-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const injectedText = [
        "<auto-slash-command>",
        "# /init-deep Command",
        "",
        "**Scope**: project",
        "---",
        "## Command Instructions",
        "",
        "짧은 커맨드 본문",
        "</auto-slash-command>",
      ].join("\n")
      const client = {
        session: {
          messages: async () => [{ id: "user_autoslash_noargs", parts: [{ type: "text", text: injectedText }] }],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_autoslash_noargs" }, "session-auto-slash-command-no-args", client)
      await handle.shutdown()

      // then — tags dropped, template body shown as-is (nothing more precise to extract)
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("user.prompt"))
      expect(promptLine).toBeDefined()
      const capturedPrompt = JSON.parse(promptLine!).attributes["gen_ai.prompt"]
      expect(capturedPrompt).not.toContain("<auto-slash-command>")
      expect(capturedPrompt).not.toContain("</auto-slash-command>")
      expect(capturedPrompt).toContain("짧은 커맨드 본문")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("extracts the real human argument from a slash-command's <user-request> wrapper, discarding the <skill-instruction> dump", async () => {
    // given — reproduces the live bug: typing "/init-deep ulw" expands into
    // a huge <skill-instruction> template (the skill's own doc) followed by
    // <user-request>ulw</user-request> (the actual typed argument). Without
    // extraction, gen_ai.prompt showed the whole skill-instruction dump with
    // "ulw" buried at the very end, past the 4000-char truncation point in
    // real cases — effectively "the prompt I typed wasn't captured at all".
    const dir = mkdtempSync(join(tmpdir(), "user-request-wrapper-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const injectedText = [
        "<skill-instruction>",
        "## Anti-Patterns",
        "",
        "- **Static agent count**: MUST vary agents based on project size/depth",
        "- **Sequential execution**: MUST parallel (explore + LSP + codegraph concurrent)",
        "</skill-instruction>",
        "",
        "<user-request>",
        "ulw",
        "</user-request>",
      ].join("\n")
      const client = {
        session: {
          messages: async () => [{ id: "user_initdeep", parts: [{ type: "text", text: injectedText }] }],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_initdeep" }, "session-user-request-wrapper", client)
      await handle.shutdown()

      // then — just "ulw", not the skill-instruction dump
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("user.prompt"))
      expect(promptLine).toBeDefined()
      expect(JSON.parse(promptLine!).attributes["gen_ai.prompt"]).toBe("ulw")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("<user-request> extraction composes with mode-directive stripping when both wrappers are present", async () => {
    // given — if the extracted user-request argument itself triggers
    // keyword-detector (e.g. contains "ultrawork"), that injection wraps
    // the SAME text part further. Extraction must happen first so
    // stripInjectedDirectives sees a clean boundary either way.
    const dir = mkdtempSync(join(tmpdir(), "user-request-plus-directive-test-"))
    try {
      const handle = initializeOtel({
        env: { OMO_OTEL_ENABLED: "true", OMO_OTEL_EXPORTER: "file", OMO_OTEL_LOCAL_STORAGE_PATH: dir },
      })
      const injectedText = [
        "<skill-instruction>irrelevant template body</skill-instruction>",
        "",
        "<user-request>",
        "## MANDATORY DIRECTIVE",
        "",
        "---",
        "",
        "실제 요청 내용",
        "</user-request>",
      ].join("\n")
      const client = {
        session: {
          messages: async () => [{ id: "user_both", parts: [{ type: "text", text: injectedText }] }],
        },
      }

      // when
      await captureFirstUserPrompt({ id: "user_both" }, "session-user-request-plus-directive", client)
      await handle.shutdown()

      // then
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("user.prompt"))
      expect(promptLine).toBeDefined()
      expect(JSON.parse(promptLine!).attributes["gen_ai.prompt"]).toBe("실제 요청 내용")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
