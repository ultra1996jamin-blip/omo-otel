import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetActiveTracerForTesting, initializeOtel, sessionSpanContext } from "@oh-my-opencode/otel-core"

import { captureFirstUserPrompt, captureOutgoingPrompt, recordGenAiCompletionSpan } from "./gen-ai-completion-span"

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

  test("falls back to a child agent.prompt span (not user.prompt) when another span already won the root race", async () => {
    // given — simulates a sub-agent session whose root was already bound to
    // the dispatching agent.execute span (delegate-task/call-omo-agent)
    // before this async fetch resolves — the fallback path, taken every time
    // for a delegated sub-agent. Named agent.prompt, not user.prompt, since
    // the text a sub-agent receives is the orchestrator's own delegation
    // prompt, not something a human typed.
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

      // then — a session.turn root plus a child agent.prompt span
      const contents = readFileSync(join(dir, "traces.jsonl"), "utf8")
      const promptLine = contents.split("\n").find((line) => line.includes("\"name\":\"agent.prompt\""))
      expect(promptLine).toBeDefined()
      const parsed = JSON.parse(promptLine!)
      expect(parsed.parentSpanId).toBeDefined()
      expect(parsed.attributes["gen_ai.prompt"]).toBe("늦게 도착한 프롬프트")
    } finally {
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
})
