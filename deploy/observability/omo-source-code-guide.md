# 6. 소스코드 설명

심사위원이 제출 소스의 파일·디렉토리 역할을 빠르게 파악하도록 돕는 코드 탐색 가이드다.

**제출 범위에 대한 안내.** 본 과제의 소스는 DS 고객사 폐쇄망 내부에서 작성·검증되었으며, 고객사 보안 정책상 소스 전체를 외부로 반출할 수 없다. 따라서 본 문서와 부록 A는 **본인이 직접 작성·수정한 핵심 영역만을 발췌·정리**한 것이다. 발췌는 실제 제출 소스 기준이며, 오픈소스 원본(OMO/OpenCode 하니스)과 본인 작성 영역을 구분해 표기한다. (경로 기준: `packages/`)

## 본인 직접 작성/수정 (심사 대상 · 약 34파일 +4,950/−6)

### 계측 코어 패키지 — `packages/otel-core/src` (전체 신규 작성, 22파일 +2,135)

| 경로 | 역할 | 구분 |
|---|---|---|
| init.ts · config.ts | SDK 초기화·환경설정 병합 — 비활성 기본값, 실패 시 NOOP 폴백(무중단) | 신규 작성 |
| context.ts | 스팬 시작/안전 종료 헬퍼(`startSpan`·`endSpanSafely`) — 실패 시 `STATUS_CODE_ERROR`+exception 기록 | 신규 작성 |
| session-span-context.ts | 세션 루트 지연 생성·위임 루트 바인딩 race 해결(`bindRoot`/`waitForBind`) → 고아 트레이스 방지 | 신규 작성 |
| delegate-span-registry.ts | 위임 task↔Span 매핑 — 비동기 완료 지점에서 안전 종료 | 신규 작성 |
| gen-ai-usage-metrics.ts | 토큰·비용 Prometheus 카운터(모델·에이전트 라벨) | 신규 작성 |
| gen-ai-context-usage-metrics.ts | 컨텍스트 사용률 게이지(used_tokens는 한도 미해결 모델도 항상 기록) | 신규 작성 |
| otlp-http-span/metric-exporter.ts | OTLP/HTTP(JSON) 직접 인코딩 — gRPC/proto 의존 없이 Bun 런타임 호환 | 신규 작성 |
| file-span/metric-exporter.ts | 폐쇄망용 JSONL 로컬 저장(traces.jsonl/metrics.jsonl) | 신규 작성 |
| *.test.ts (7파일) | 초기화·설정·컨텍스트·레지스트리·메트릭 단위 테스트(bun:test) | 신규 작성 |

### 플러그인 계측 연동 — `packages/omo-opencode/src` (12파일 +2,815/−6)

| 경로 | 역할 | 구분 |
|---|---|---|
| plugin/gen-ai-completion-span.ts | **계측 핵심** — `{agent}.gen_ai.completion.{model}` 스팬 기록(모델·토큰·CoT·skill·컨텍스트 사용률·에러 상태), `user.prompt` 턴 루트 캡처·프롬프트 정제 | 신규 작성 |
| plugin/tool-span-tracker.ts | `{agent}.hook.{tool}` / `{agent}.mcp.{server}.{tool}` 스팬 생성·종료, 실패 시 에러 상태 기록, 인자는 키 이름만 수집(QA-05) | 신규 작성 |
| plugin/event.ts | `message.updated`(finish/error)·`message.part.updated`(도구 에러) 이벤트에서 계측 호출 — fire-and-forget | 수정 |
| plugin/tool-execute-before/after.ts | 도구 실행 전/후 훅에 스팬 추적 연동 | 수정 |
| shared/mcp-tool-classifier.ts | MCP 서버명 판별 — 서버명·도구명 정규화(소문자·특수문자 통일) 후 최장 접두 매칭 | 신규 작성 |
| shared/session-skill-usage-state.ts | 세션별 skill 사용 여부(A/B 비교용 저카디널리티 태깅) | 신규 작성 |
| shared/model-context-limits-cache.ts | 모델별 컨텍스트 한도 전역 미러 — usage_ratio 분모 해결 | 신규 작성 |
| *.test.ts (4파일) | 완료 스팬·도구 스팬·MCP 분류·에러 경로 단위 테스트 | 신규 작성 |
| config/schema/otel.ts | OTEL 설정 스키마(enabled·endpoint·exporter·sampling_rate) | 수정 |

### 관측 인프라 구성 (본인 구성/수정)

| 경로 | 역할 | 구분 |
|---|---|---|
| stack/docker-compose.yml | 관측 스택 6종(Collector·Jaeger·OpenLIT·ClickHouse·Prometheus·Grafana) 단일 기동, 에어갭 이미지 태그 고정 | 구성 |
| stack/otel-collector.yml | OTLP 수신 → **redaction(PII)·transform(사내 기밀) 마스킹** → batch → Jaeger/ClickHouse/Prometheus 분기, spanmetrics 차원 승격 | 구성 |
| stack/grafana/dashboards/*.json | omo-kpi(KPI 종합) · omo-cost(비용·토큰, 모델별 단가 변수) · omo-regression(A/B 회귀) · omo-overview · omo-traces 5종 | 구성/수정 |
| stack/openlit-seed-fix/seed.js | OpenLIT 기준정보(SQLite·Prisma) 부트스트랩 | 구성 |
| scripts/package-*.ps1 · deploy/plugin-airgap/ | 폐쇄망 오프라인 패키징·git 태그 기반 반입 체계 | 구성 |

## 오픈소스 원본 (참고 · 비심사)

| 경로 | 역할 | 구분 |
|---|---|---|
| packages/omo-opencode/src/* (계측 외 전체) | OMO 멀티에이전트 하니스(에이전트·도구·MCP·스킬 시스템) | 오픈소스 |
| OpenCode 본체 | CLI 하니스·플러그인 호스트·이벤트 버스 | 오픈소스 |

> 패키지 구조와 클래스 관계는 별첨 `omo-otel-diagrams.drawio`(패키지 다이어그램·클래스 다이어그램 2탭) 참조.

---

# 부록 A. 핵심 소스 (본인 작성/수정 영역)

※ 실제 제출 소스 기준 발췌이며(고객사망 반출 불가로 핵심 로직만 정리), 주석은 설명을 위해 요약하였다. 계측 핵심은 `plugin/gen-ai-completion-span.ts`이고 스팬 이름은 `{agent}.gen_ai.completion.{model}`이다. 비용은 하니스 제공값(`info.cost`)이 있을 때만 속성으로 기록하며, 비용을 보고하지 않는 사내 모델은 Grafana 단가 변수 × 실측 토큰으로 별도 산정한다(선택 3). 프롬프트/응답 본문은 최대 4,000자 저장하되 Collector의 redaction·transform에서 마스킹한다.

## A.1 계측 코어 (otel-core)

### A.1.1 SDK 초기화 · NOOP 폴백 · exporter 선택 (init.ts)

설정이 비활성(기본값)이거나 초기화가 실패하면 NOOP 트레이서를 반환해 에이전트 실행에 전혀 영향을 주지 않는다(무중단). exporter는 폐쇄망 대비 file을 포함해 4종을 지원한다.

```ts
// otel-core/init.ts (발췌) — SDK 초기화, 실패·비활성 시 NOOP 폴백 (무중단)
export function initializeOtel(input = {}) {
  try {
    const config = resolveOtelConfig(input)
    if (!config.enabled) {                       // 기본값 비활성 → SDK 미로드, 오버헤드 0
      return { enabled:false, tracer:NOOP_TRACER, meter:NOOP_METER, shutdown:async()=>{} }
    }
    const exporter = createExporter(config)      // otlp | jaeger | file | console
    const provider = new BasicTracerProvider({
      resource, sampler: new TraceIdRatioBasedSampler(config.samplingRate),
      spanProcessors: [ new BatchSpanProcessor(exporter) ],
    })
    trace.setGlobalTracerProvider(provider)
    activeTracer = trace.getTracer(config.serviceName, config.serviceVersion)
    ...
  } catch { /* 설정·exporter 오류 → NOOP 폴백 (에이전트 실행에 무영향) */ }
}
function createExporter(config) {
  switch (config.exporter) {
    case "file":    return new FileSpanExporter(config.localStoragePath)   // 폐쇄망
    case "console": return new ConsoleSpanExporter()
    default:        return new OtlpHttpSpanExporter(config.otlpEndpoint)   // otlp/jaeger 공용
  }
}
```

### A.1.2 설정 해석 — 비활성 기본값 (config.ts)

환경변수와 파일 설정을 병합하되 `OMO_OTEL_ENABLED` 기본값은 비활성이다. 엔드포인트·exporter·샘플링을 함께 해석한다.

```ts
// otel-core/config.ts (발췌) — 환경변수·파일 설정 병합, 기본값 비활성
export function resolveOtelConfig(input = {}) {
  const enabled  = parseBoolean(env.OMO_OTEL_ENABLED) ?? fileConfig?.enabled ?? DEFAULT_OTEL_ENABLED  // false
  const exporter = parseExporterKind(env.OMO_OTEL_EXPORTER) ?? ... ?? DEFAULT_OTEL_EXPORTER           // otlp
  const otlpEndpoint = normalize(env.OTEL_EXPORTER_OTLP_ENDPOINT) ?? ... ?? DEFAULT_OTLP_ENDPOINT     // :14318/v1/traces
  const samplingRate = parseSamplingRate(env.OMO_OTEL_SAMPLING_RATE) ?? clampSamplingRate(...)        // 0~1
  return { enabled, exporter, otlpEndpoint, serviceName, samplingRate, localStoragePath, ... }
}
```

### A.1.3 스팬 안전 종료 — 에러 상태 기록 (context.ts)

모든 스팬 종료가 이 헬퍼를 거친다. 실패 시 `recordException` + `STATUS_CODE_ERROR`를 기록해 Jaeger에서 원인 스팬이 빨간색으로 즉시 식별된다. 텔레메트리 예외는 격리되어 에이전트 실행에 영향을 주지 않는다.

```ts
// otel-core/context.ts (발췌) — 안전 종료 + 에러 상태 기록
export function endSpanSafely(span, attributes?, error?) {
  if (!span) return
  try {
    if (attributes) span.setAttributes(attributes)
    if (error !== undefined) {
      span.recordException(error instanceof Error ? error : String(error))
      span.setStatus({ code: SpanStatusCode.ERROR })      // ← Jaeger 빨간 스팬
    }
    span.end()
  } catch { /* 텔레메트리 실패는 에이전트 실행에 무영향 */ }
}
```

### A.1.4 세션 루트 · 트리 상관 · 위임 race 해결 (session-span-context.ts)

세션 첫 활동에서 루트를 지연 생성하고, 위임 서브에이전트의 루트 바인딩 경쟁(race)은 폴링이 아닌 이벤트 구동 대기(`waitForBind`)로 해결해 고아 트레이스를 방지한다.

```ts
// otel-core/session-span-context.ts (발췌) — 세션 루트 지연 생성 + 위임 race 해결
export const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000        // 세션 루트 유휴 만료
class SessionSpanContext {
  getContext(sessionID, idleMs, attributes?, startTimeMs?) { /* 루트 지연 생성 */ }
  bindRoot(sessionID, span, idleMs) { /* 위임 서브에이전트 루트를 부모 스팬에 바인딩 */ }
  waitForBind(sessionID, maxWaitMs) { /* bindRoot() 호출 순간 resolve — 폴링X, 이벤트 구동 */ }
  markPendingBind(sessionID) { /* 바인딩 대기중 표시 → 조기 stamp 방지(고아 트레이스 예방) */ }
}
export const sessionSpanContext = new SessionSpanContext()
// 스팬 이름: user.prompt · agent.execute.{name} · {agent}.hook.{tool} ·
//           {agent}.mcp.{server}.{tool} · {agent}.gen_ai.completion.{model}
```

### A.1.5 위임 스팬 레지스트리 (delegate-span-registry.ts)

위임 task id와 열린 Span을 매핑해, 비동기 완료 지점(백그라운드 after-hook)에서 자신이 만들지 않은 스팬을 안전하게 종료한다.

```ts
// otel-core/delegate-span-registry.ts — 위임 task→Span 매핑(비동기 완료 지점에서 종료)
export class DelegateSpanRegistry {
  private spans = new Map()
  set(taskId, span) { this.spans.set(taskId, span) }
  get(taskId) { return this.spans.get(taskId) }
  delete(taskId) { this.spans.delete(taskId) }
}
```

## A.2 gen_ai 사용량 계측 (핵심)

### A.2.1 gen_ai.completion 스팬 속성 조립 (gen-ai-completion-span.ts)

완료(또는 실패)된 assistant 응답에서 모델·provider·토큰·추론·skill·컨텍스트 사용률·에러 상태를 표준 gen_ai.* 속성으로 기록한다. 이 속성명이 OpenLIT 대시보드 쿼리와 그대로 일치한다.

```ts
// plugin/gen-ai-completion-span.ts (발췌) — LLM 응답 완료/실패 시 gen_ai.completion 기록
const MAX_TEXT_ATTRIBUTE_LENGTH = 4000            // 프롬프트/응답 본문 최대 4000자 저장
export async function recordGenAiCompletionSpan(info, sessionID, client?) {
  // != null: OpenCode는 성공 메시지에도 error:null을 명시적으로 내려줌 —
  // !== undefined로 판정하면 전 호출이 에러로 오판정됨(실측으로 발견·수정)
  const hasError = info.error != null
  if (!id || !modelID) return
  if (!hasError && (inputTokens === undefined || outputTokens === undefined)) return  // 실패 시 토큰 0 허용

  const attributes = {
    "gen_ai.operation.name": "chat",
    "gen_ai.system": providerID ?? "unknown",
    "gen_ai.request.model": modelID,
    "gen_ai.usage.input_tokens": safeInputTokens,
    "gen_ai.usage.output_tokens": safeOutputTokens,
    "gen_ai.usage.total_tokens": totalTokens,
    ...(cost !== undefined ? { "gen_ai.usage.cost": cost } : {}),        // 하니스 제공 시에만
    ...(reasoningTokens !== undefined ? { "gen_ai.usage.reasoning_tokens": reasoningTokens } : {}),
    "gen_ai.reasoning_present": reasoningTokens > 0 ? "true" : "false",  // CoT 캡처율 KPI 분자
    "gen_ai.skill_used": skillUsed ? "true" : "false",                   // skill A/B 비교
    "gen_ai.context.used_tokens": contextUsedTokens,                     // 한도 미해결 모델도 항상 기록
    ...(contextLimit ? { "gen_ai.context.limit": contextLimit,
                         "gen_ai.context.usage_ratio": contextUsageRatio } : {}),
    ...(prompt   ? { "gen_ai.prompt": prompt } : {}),        // 최대 4000자 · Collector에서 마스킹
    ...(response ? { "gen_ai.completion": response } : {}),
    "gen_ai.error": hasError,                                // 에러율 패널용 boolean
    ...(errorName ? { "gen_ai.error.type": errorName } : {}),
  }
  const name = agentName ? `${agentName}.gen_ai.completion.${modelID}` : `gen_ai.completion.${modelID}`
  const span = resolveTracer().startSpan(name, { attributes }, parentContext)
  if (hasError) {                                            // LLM 자체 실패도 빨간 스팬으로
    span.recordException(errorMessage || errorName || "LLM completion failed")
    span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage })
  }
  span.end(completedMs ?? Date.now())
}
```

### A.2.2 사용량 카운터 (gen-ai-usage-metrics.ts)

스팬과 별개로 동일 수치를 Prometheus 카운터로 집계(모델·에이전트 라벨). 대시보드·KPI가 ClickHouse 스캔 없이 총량/추이를 조회한다.

```ts
// otel-core/gen-ai-usage-metrics.ts (발췌) — Prometheus 카운터(대시보드용)
inputTokens:  meter.createCounter("gen_ai.usage.input_tokens",  ...)
outputTokens: meter.createCounter("gen_ai.usage.output_tokens", ...)
totalTokens:  meter.createCounter("gen_ai.usage.total_tokens",  ...)
cost:         meter.createCounter("gen_ai.usage.cost",
                 { description: "Estimated LLM cost, as reported by the harness", unit: "{USD}" })
export function recordGenAiUsage(input) {
  const attributes = { "gen_ai.request.model": input.model,
                       ...(input.agentName ? { "gen_ai.agent.name": input.agentName } : {}) }
  counters.inputTokens.add(input.inputTokens, attributes)
  counters.outputTokens.add(input.outputTokens, attributes)
  counters.totalTokens.add(input.totalTokens, attributes)
  if (input.cost !== undefined) counters.cost.add(input.cost, attributes)
}
```

### A.2.3 컨텍스트 사용률 게이지 (gen-ai-context-usage-metrics.ts)

컨텍스트 창이 얼마나 찼는지를 게이지로 기록한다. 사내/커스텀 provider처럼 한도를 못 구해도 used_tokens는 항상 기록해, `provider.*.limit.context` 설정(또는 Grafana 변수)으로 사용률을 계산할 수 있게 했다.

```ts
// otel-core/gen-ai-context-usage-metrics.ts (발췌) — 컨텍스트 사용률 게이지
createGauge("gen_ai.context.used_tokens", ...)   // 최근 completion의 입력+출력 토큰
createGauge("gen_ai.context.usage_ratio", ...)   // used / (모델 컨텍스트 한도)
// usedTokens는 항상 기록 → 한도 미해결 모델도 설정/변수로 사용률 계산 가능
```

### A.2.4 컨텍스트 한도 캐시 (model-context-limits-cache.ts)

완료 스팬 기록기는 provider 설정과 다른 호출 경로에 있어, 모델별 컨텍스트 한도를 전역 미러로 노출해 사용률(usage_ratio)의 분모를 해결한다. 사내 모델은 `provider.codemate.models.*.limit.context` 설정값이 이 캐시에 채워진다.

```ts
// omo-opencode/shared/model-context-limits-cache.ts — 모델 컨텍스트 한도 전역 미러
let modelContextLimitsCache = new Map()
export function setModelContextLimitsCache(cache) { modelContextLimitsCache = cache }
export function getModelCacheState() { return { modelContextLimitsCache, anthropicContext1MEnabled } }
// gen-ai-completion-span.ts가 이 미러를 읽어 context.usage_ratio의 분모(모델 한도)를 해결
```

### A.2.5 프롬프트 정제 · 실제 사용자 텍스트 판별 (gen-ai-completion-span.ts)

슬래시커맨드·스킬 템플릿·모드 배너 등 합성 텍스트를 벗겨 사람이 실제 입력한 부분만 추출하고, 백그라운드 알림처럼 사람이 치지 않은 메시지는 실제 사용자 텍스트에서 제외한다.

```ts
// plugin/gen-ai-completion-span.ts (발췌) — 프롬프트 정제 · 실제 사용자 텍스트 판별
function cleanCapturedPromptText(text) {
  return stripInjectedDirectives(extractUserRequestWrapper(extractAutoSlashCommandUserRequest(text)))
}
function joinTextParts(parts, excludeSynthetic) {
  return parts.filter(p => p.type === "text")
    .filter(p => !excludeSynthetic || isRealUserTextPart(p))   // synthetic·내부 마커 제외
    .map(p => stripInternalInitiatorMarkers(p.text)).join("\n").trim()
}
```

### A.2.6 턴별 루트 · 위임 race 대기 (captureFirstUserPrompt)

매 실제 사용자 턴마다 새 `user.prompt` 루트를 만들고, 위임 서브에이전트 세션은 루트 바인딩(bindRoot)을 이벤트로 대기한 뒤 `agent.prompt` 자식으로 매달아 고아 트레이스를 방지한다.

```ts
// plugin/gen-ai-completion-span.ts (발췌) — user.prompt 루트 생성 · 위임 race 대기
export async function captureFirstUserPrompt(info, sessionID, client?) {
  if (!shouldCaptureFirstPrompt(id)) return                       // 메시지 id 기준 1회만
  const messages = await client.session.messages({ path:{ id: sessionID } })
  const hasRealUserText = joinTextParts(userMessage.parts, true).length > 0   // 백그라운드 알림 걸러냄
  if (isDelegated && !rootBound)                                  // 위임인데 루트 미바인딩이면
    await sessionSpanContext.waitForBind(sessionID, rootRaceMaxWaitMs())      // bindRoot 이벤트 대기(고아 방지)
  // 매 실제 사용자 턴마다 새 user.prompt 루트, 위임 세션은 agent.prompt 자식으로 매닮
}
```

## A.3 플러그인 계측 연동

### A.3.1 MCP 도구 분류 — mcp.server_name (mcp-tool-classifier.ts)

OpenCode 훅은 평면 도구명만 주므로, 구성된 MCP 서버명 집합에 대해 최장 접두 매칭으로 MCP 도구를 판별한다. OpenCode가 서버명을 정규화해 도구명을 등록하므로(예: `"sds confluence"` → `sds_confluence_<tool>`) **양쪽 모두 정규화(소문자·특수문자→_) 후 매칭**한다 — 실측에서 공백 포함 서버명이 분류 실패하던 문제를 수정한 부분이다.

```ts
// omo-opencode/shared/mcp-tool-classifier.ts (발췌) — mcp.server_name 판별 (정규화 매칭)
function sanitizeForMatch(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_") }
export function getMcpServerNameForTool(toolName) {
  const sanitizedTool = sanitizeForMatch(toolName)
  let best
  for (const name of knownMcpServerNames) {
    const sanitized = sanitizeForMatch(name)
    if (sanitizedTool.startsWith(`${sanitized}_`) && (!best || sanitized.length > best.length))
      best = sanitized                                  // 최장 접두 매칭(짧은 서버명 shadow 방지)
  }
  return best
}
```

### A.3.2 skill A/B 상태 (session-skill-usage-state.ts)

세션별 skill 사용 여부를 저카디널리티로 추적해 `gen_ai.skill_used`로 태깅, 스킬 사용 유무에 따른 컨텍스트·비용 증가를 A/B로 비교한다.

```ts
// omo-opencode/shared/session-skill-usage-state.ts — gen_ai.skill_used(A/B) 태깅용
const sessionsWithSkillUsage = new Set()
export function markSessionUsedSkill(sessionID) { sessionsWithSkillUsage.add(sessionID) }
export function hasSessionUsedSkill(sessionID)  { return sessionsWithSkillUsage.has(sessionID) }
```

### A.3.3 도구 스팬 추적 (tool-span-tracker.ts)

도구/MCP 스팬을 생성하며, 인자는 값이 아닌 키 이름만 요약(QA-05)하고, 위임 세션의 루트 바인딩을 대기한 뒤 스팬을 매단다. 실패 시 에러와 함께 종료된다.

```ts
// plugin/tool-span-tracker.ts (발췌) — 도구/MCP 스팬 · skill A/B · race-safe · 에러 상태
function summarizeArgs(args) {                 // QA-05: 인자 값이 아니라 키 이름만(구조 메타데이터)
  return args ? Object.keys(args).sort().join(",") : ""
}
export function createToolSpanTracker() {
  const registry = new DelegateSpanRegistry()
  return {
    async start(input) {                        // fire-and-forget → 도구 호출 지연에 영향 없음
      if (input.tool === SKILL_TOOL_NAME) markSessionUsedSkill(input.sessionID)   // skill A/B
      const parentContext = await sessionSpanContext.getContextAwaitingPendingBind(input.sessionID)
      const mcpServerName = getMcpServerNameForTool(input.tool)
      // 스팬명: "{agent}.hook.{tool}" 또는 "{agent}.mcp.{server}.{tool}" (dot-joined)
      ...
    },
    end(input, error?) {                        // 실패 시 error 전달 → STATUS_CODE_ERROR + exception
      endSpanSafely(registry.get(spanKey(input)),
        { "hook.error": error !== undefined, "hook.execution_ms": executionMs }, error)
    }
  }
}
```

## A.4 폐쇄망 무중단 익스포터

### A.4.1 OTLP/HTTP(JSON) 익스포터 (otlp-http-span-exporter.ts)

Bun 런타임 호환을 위해 gRPC/proto 의존 없이 OTLP를 HTTP(JSON)로 직접 인코딩·전송한다.

```ts
// otel-core/otlp-http-span-exporter.ts (발췌) — OTLP/HTTP(JSON) 직접 인코딩 (Bun 호환)
function encodeAttributeValue(value) {                 // OTLP AnyValue 인코딩
  if (typeof value === "string")  return { stringValue: value }
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "number")  return Number.isInteger(value) ? { intValue:String(value) } : { doubleValue:value }
  if (Array.isArray(value))       return { arrayValue: { values: value.map(v=>({value:encodeAttributeValue(v)})) } }
  return { stringValue: String(value) }
}
// → resourceSpans/scopeSpans JSON을 POST(/v1/traces) — gRPC/proto 의존 없이 Bun 런타임에서 동작
```

### A.4.2 파일 익스포터 (file-span-exporter.ts)

OTLP 콜렉터를 쓸 수 없을 때 스팬을 traces.jsonl로 append 저장해 오프라인 수집·사후 분석을 지원한다.

```ts
// otel-core/file-span-exporter.ts (발췌) — 폐쇄망 JSONL 저장
export class FileSpanExporter implements SpanExporter {
  constructor(directory) { this.filePath = join(directory, "traces.jsonl"); mkdirSync(directory,{recursive:true}) }
  export(spans, resultCallback) {
    try {
      const lines = spans.map(s => JSON.stringify(serializeSpan(s))).join("\n")
      appendFileSync(this.filePath, `${lines}\n`)     // append-only
      resultCallback({ code: SUCCESS })
    } catch (error) { resultCallback({ code: FAILED, error }) }
  }
}
```

## A.5 관측성 스택 설정

### A.5.1 OTel Collector — 마스킹 파이프라인 (otel-collector.yml)

redaction(PII)·transform(사내 기밀 LOT/EQPID 부분 마스킹)이 모든 exporter보다 먼저 실행되어 저장소에는 마스킹된 데이터만 남는다.

```yaml
# stack/otel-collector.yml (발췌) — 마스킹 포함 실제 파이프라인
receivers:
  otlp: { protocols: { grpc:{endpoint:0.0.0.0:4317}, http:{endpoint:0.0.0.0:4318} } }
processors:
  memory_limiter: { check_interval: 5s, limit_mib: 512 }
  redaction:                          # PII 전체 마스킹 (본인 추가)
    allow_all_keys: true
    blocked_values:
      - "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"   # 이메일
      - "[0-9]{6}-[0-9]{7}"                                 # 주민등록번호
      - "01[0-9]-[0-9]{3,4}-[0-9]{4}"                       # 휴대폰
      - "sk-[A-Za-z0-9_-]{16,}"   # (외 카드·GitHub·AWS·Bearer 토큰)
  transform:                          # 사내 기밀 부분 마스킹 OTTL (본인 추가)
    trace_statements:
      - context: span
        statements:
          - replace_pattern(attributes["gen_ai.prompt"],
              "(?i)(RCP|RECIPE|LOT|STEP|EQPID)([:=_ ]+)([A-Za-z0-9]{3})[A-Za-z0-9]*", "$$1$$2$$3*")
  resource: { attributes: [ {key:deployment.environment, value:local, action:upsert} ] }
  batch:    { timeout: 1s, send_batch_size: 512 }
connectors:
  spanmetrics: { dimensions: [gen_ai.request.model, gen_ai.agent.name, gen_ai.system,
                              gen_ai.reasoning_present, status.code, ...] }
exporters:
  otlp/jaeger: { endpoint: jaeger:4317, tls:{insecure:true} }
  clickhouse:  { endpoint: "tcp://clickhouse:9000?...", database: openlit_db, ttl_days: 14 }
  prometheus:  { endpoint: 0.0.0.0:9464, namespace: omo }
service:
  pipelines:
    # 마스킹(redaction·transform)이 모든 exporter보다 먼저 실행
    traces:  { receivers:[otlp], processors:[memory_limiter, redaction, transform, resource, batch],
               exporters:[otlp/jaeger, clickhouse, spanmetrics] }
    metrics: { receivers:[otlp, spanmetrics], processors:[memory_limiter, batch],
               exporters:[prometheus, clickhouse] }
```

### A.5.2 컨테이너 스택 (docker-compose.yml)

관측 스택 6종을 단일 기동하며, 폐쇄망 재현을 위해 이미지 태그를 고정하고 host→container 포트를 매핑한다.

```yaml
# stack/docker-compose.yml (발췌) — 6종 컨테이너(에어갭 이미지 태그 고정, host→container 포트)
services:
  otel-collector: image: otel/opentelemetry-collector-contrib:0.103.0
                  ports: ["14317:4317","14318:4318","18888:8888","19464:9464"]
  jaeger:     image: jaegertracing/all-in-one:1.58        ports: ["26686:16686"]
  clickhouse: image: clickhouse/clickhouse-server:24.4-alpine   # :8123 http / :9000 native
  openlit:    image: ghcr.io/openlit/openlit:latest       ports: ["13000:3000"]
  prometheus: image: prom/prometheus:v2.53.0              ports: ["19090:9090"]
  grafana:    image: grafana/grafana:11.1.0               ports: ["13001:3000"]
```

### A.5.3 Grafana 비용 대시보드 쿼리 (omo-cost.json)

비용·토큰 패널은 본 과제가 계측한 `omo_gen_ai_usage_*` 메트릭을 PromQL로 집계한다. 사내 모델 비용은 대시보드 단가 변수(`$price_per_1m_input(_pro|_image)` 등 6개) × 실측 토큰으로 산정한다.

```
# stack/grafana/dashboards/omo-cost.json (발췌) — 비용/토큰 패널 쿼리(PromQL)
"총 토큰 사용량"     : sum(increase(omo_gen_ai_usage_tokens_total[$__range]))
"Model별 토큰(도넛)" : sum by (gen_ai_request_model) (increase(omo_gen_ai_usage_tokens_total[$__range]))
"LLM 호출 횟수"      : sum(increase(omo_calls_total{span_name=~".*gen_ai\.completion\..*"}[$__range]))
"모델별 예상 비용"   : (sum(increase(omo_gen_ai_usage_input_tokens_total{gen_ai_request_model="CodeLLMMax"}[$__range]))
                        * $price_per_1m_input / 1000000)
                     + (sum(increase(omo_gen_ai_usage_output_tokens_total{gen_ai_request_model="CodeLLMMax"}[$__range]))
                        * $price_per_1m_output / 1000000)   # Pro/Image 동일 패턴, 합계 패널 별도
```

## A.6 계측 연동 지점 (event.ts)

OpenCode 이벤트 버스에서 세 지점을 계측에 연결한다 — 모두 fire-and-forget으로 호출해 텔레메트리 실패가 실행 경로를 막지 않도록 한다.

```ts
// plugin/event.ts (발췌) — 이벤트 → 계측 연동 (fire-and-forget)
if (event.type === "message.part.updated") {
  // 도구 실패는 tool.execute.after가 아예 호출되지 않음 — 도구 파트의
  // state.status==="error" 전이가 유일한 실패 신호이므로 여기서 스팬을 에러로 종료
  const part = props?.part
  if (part?.type === "tool" && part.state?.status === "error")
    toolSpanTracker?.end({ tool: part.tool, sessionID: part.sessionID, callID: part.callID },
                         new Error(part.state.error ?? "tool execution failed"))
}

if (event.type === "message.updated") {
  const messageFinished = typeof state.info?.finish === "string"
                            ? state.info.finish.length > 0 : state.info?.finish === true
  const messageErrored = state.info?.error != null       // LLM 자체 실패도 스팬 기록 대상
  if (state.sessionID && state.role === "assistant" && (messageFinished || messageErrored))
    void recordGenAiCompletionSpan(state.info ?? {}, state.sessionID, pluginContext.client)
  if (state.sessionID && state.role === "user")
    void captureFirstUserPrompt(state.info ?? {}, state.sessionID, pluginContext.client)
}
```
