# OMO 관측성(Observability) 정량 평가 보고서

## 0. 측정 환경

본 평가의 모든 실측은 **폐쇄망(air-gapped) 운영 환경**에서 수행하였다. 합성 트래픽이 아닌 실 사용 세션을 대상으로 하였으며, 인터넷 연결이 차단된 환경에서 사내 자체호스팅 모델만으로 재현하였다.

| 항목 | 내용 |
|---|---|
| 네트워크 | 폐쇄망 (외부 인터넷 차단), DS 고객사 배포 환경 |
| LLM | 사내 자체호스팅 CodeLLM 3종 (Max / Pro / Image, provider: codemate) |
| 관측 스택 | OTel Collector 0.103.0 · Jaeger 1.58 · ClickHouse 24.4 · Prometheus v2.53 · Grafana 11.1.0 · OpenLIT |
| 계측 플러그인 | oh-my-openagent (버전 4.15.1-otel.13 ~ otel.16, `service.version`으로 배포 버전 검증) |
| 배포 방식 | git 태그 기반 패키지 반입 — 소스 커밋과 설치 산출물의 1:1 추적 가능 |

---

## 1. 정량적 평가 요약

OMO KPI별 개선 전/후·정도·측정 방법·측정 조건이다. Phase 1의 결과는 부록으로 분리하였다.

| KPI | 개선 전 | 개선 후 | 측정 방법 / 조건 |
|---|---|---|---|
| Trace 수집률 | 0 (계측 없음) | 세션→에이전트 위임→도구/MCP 호출→LLM 호출 4계층이 단일 트레이스로 연결 | 실 세션 캡처: Sisyphus→explore 위임, Depth 3, 121 spans, 14m 38s, 단절(고아 스팬) 0건 |
| 원인 파악 시간 | 로그 수작업 분석(분 단위, 측정 기준 없음) | 트레이스에서 원인 스팬 직접 특정 — 외부시스템(MCP)·로컬(파일)·네트워크(HTTP) 3개 실패 계층 모두 커버 | 장애 시나리오 3건 실측(MCP 도구 실패, 파일 읽기 실패, webfetch 404): Jaeger 원인 스팬 클릭 + Logs 탭에서 exception 메시지·스택트레이스 즉시 확인 |
| 사고 과정(CoT) | Console 출력 (세션 종료 시 유실) | `gen_ai.completion` 스팬에 reasoning 속성 캡처 | KPI 게이지 실측 100% (목표 80% 이상), `gen_ai.reasoning_present` 태그 Jaeger 교차 확인 |
| 사용량 가시성 | 분산·집계 불가 | 모델·토큰 표준 속성 수집(`gen_ai.*`) + 비용·컨텍스트 한도 이원화 산정 체계 | 모델별 분리 집계(Max/Pro/Image), 동급 모델 공개 단가 기준 환산 비용, 모델별 컨텍스트 한도 반영 |
| 회귀 비교 | 비교 기준 없음 | A/B 시나리오(길이+간격) 자동 분리 비교 구조 확보, success/attempt 자동 집계 | 실측 A/B 테스트: 동일 스킬(AI DLC 요구사항 분석)을 한국어/영어로 비교, 모델 Pro 고정 |

---

## 2. Trace 수집률 — 실측 상세

Trace 수집률은 두 계층으로 나누어 측정하였다.

**(1) 파이프라인 수집률 (Grafana KPI 1 — 100%)**: OTEL Collector 자체 메트릭으로 계측한 스팬 수신 성공률이다. 측정식은 `accepted / (accepted + refused)`이며, 플러그인이 export한 스팬 중 Collector가 수신을 거부(refused)하거나 유실한 스팬의 비율을 나타낸다. 측정 구간(최근 1시간, 15초 간격) 동안 거부 스팬 0건으로 **수집률 100%**를 기록하였다. 즉 계측 지점에서 발생한 스팬은 전량 저장 계층(Jaeger·ClickHouse)까지 도달하였다.

[📷 스크린샷: Grafana KPI 종합 대시보드 — "KPI 1 — Trace 수집률" 게이지 100%]

**(2) 세션 단위 구조적 수집 완전성 (Jaeger 실측 캡처)**: 파이프라인이 스팬을 안 버리는 것과 별개로, "한 번의 에이전트 실행이 단계별로 빠짐없이 하나의 트레이스로 이어지는가"를 실제 세션으로 검증하였다. 2026-07-15 08:48 시작된 실 사용 세션(트레이스 ID `15f2c50…`)에서:

- **총 121개 스팬이 단일 트레이스**로 수집되었고, 고아(orphan) 스팬은 0건이었다.
- 루트는 `Sisyphus - ultraworker.user.prompt`(프롬프트 원문 포함)로 정확히 잡혔으며, 그 아래에 LLM 호출(`gen_ai.completion.CodeLLMMax`), 내장 도구(`hook.list_mcp_resources`, `hook.task`), MCP 호출(`mcp.codegraph.codegraph_search` 4건, 16.6~17.6s), 서브에이전트 위임(`agent.execute.explore` → `explore.agent.prompt`)까지 **제안 목표인 세션→에이전트→도구→LLM 4계층이 모두 계측**되었다.
- 트레이스 **Depth 3**은 위임 구조(메인 세션 → 위임 스팬 → 서브에이전트 하위 스팬)가 부모-자식 관계로 연결되었음을 보여주며, 전체 실행 시간 14m 38s 동안 단절 없이 유지되었다.

| 검증 항목 | 측정값 | 판정 기준 | 결과 |
|---|---|---|---|
| 총 스팬 수 | 121 | — | ✅ 전체 실행 단계 수집 |
| 루트 스팬 수 | 1 | = 1 | ✅ 파편화 없음 |
| 고아 스팬 수 | 0 | = 0 | ✅ 부모 유실 없음 |
| 루트 도달 가능 스팬 | 121/121 (100%) | = 총 스팬 수 | ✅ 트리 단절 0건 |
| 트레이스 깊이 | 3 | ≥ 3 | ✅ 메인→위임→서브에이전트 |
| 계층① 세션/프롬프트 | 1 | ≥ 1 | ✅ |
| 계층② 에이전트 위임 | 2 | ≥ 1 | ✅ |
| 계층③ 도구/MCP 호출 | 93 | ≥ 1 | ✅ |
| 계층④ LLM 호출 | 25 | ≥ 1 | ✅ |

제안 목표인 세션→에이전트→도구→LLM 4계층이 모두 단일 트레이스 안에서 부모-자식 관계로 연결됨을 재현 가능한 쿼리로 정량 확인하였다.

**측정 조건**: DS 고객사 폐쇄망 배포 환경, 사내 자체호스팅 모델(CodeLLM 계열), 실제 사용자 세션(합성 트래픽 아님).

**측정 방법**: (1)은 Prometheus 쿼리 `100 * rate(otelcol_receiver_accepted_spans[5m]) / (accepted + refused)`, (2)는 ClickHouse 직접 쿼리로 스팬 집계 및 재귀 CTE 기반 트리 도달성 검증.

<details>
<summary>부록 — 검증 쿼리 원문 (재현용)</summary>

```sql
docker exec clickhouse clickhouse-client -q "
WITH '15f2c509d49a9ff043eceec289d13894' AS tid
SELECT
  count() AS total_spans,
  countIf(ParentSpanId = '') AS root_spans,
  countIf(ParentSpanId != '' AND ParentSpanId NOT IN (
    SELECT SpanId FROM openlit_db.otel_traces WHERE TraceId = tid
  )) AS orphan_spans,
  countIf(SpanName LIKE '%user.prompt%') AS layer1_session_prompt,
  countIf(SpanName LIKE '%agent.execute%' OR SpanName LIKE '%agent.prompt%') AS layer2_delegation,
  countIf(SpanName LIKE '%.hook.%' OR SpanName LIKE 'hook.execute.%' OR SpanName LIKE '%.mcp.%') AS layer3_tools,
  countIf(SpanName LIKE '%gen_ai.completion%') AS layer4_llm
FROM openlit_db.otel_traces
WHERE TraceId = tid
FORMAT Vertical"

-- 결과: total_spans=121, root_spans=1, orphan_spans=0,
--       layer1_session_prompt=1, layer2_delegation=2, layer3_tools=93, layer4_llm=25

docker exec clickhouse clickhouse-client --allow_experimental_analyzer=1 -q "
WITH RECURSIVE tree AS (
  SELECT SpanId, 1 AS depth
  FROM openlit_db.otel_traces
  WHERE TraceId = '15f2c509d49a9ff043eceec289d13894' AND ParentSpanId = ''
  UNION ALL
  SELECT t.SpanId, tree.depth + 1
  FROM openlit_db.otel_traces AS t
  INNER JOIN tree ON t.ParentSpanId = tree.SpanId
  WHERE t.TraceId = '15f2c509d49a9ff043eceec289d13894'
)
SELECT max(depth) AS trace_depth, count() AS reachable_spans
FROM tree
FORMAT Vertical"

-- 결과: trace_depth=3, reachable_spans=121
```

</details>

---

## 3. 원인 파악 시간 — 실측 상세

**목적**: OpenTelemetry 기반 Jaeger 트레이스에서 실패 계층(외부 시스템 MCP / 로컬 파일시스템 / 네트워크 HTTP)에 관계없이 "원인 스팬 한 번 클릭"으로 즉시 식별 가능함을 증빙.

### 계측 공백 발견 및 수정 이력

검증 과정에서 실패가 스팬에 전혀 기록되지 않는 구조적 계측 공백을 발견하고 순차적으로 수정하였다 — 이 자체가 "원인 파악 체계를 구축"한 핵심 작업이다.

| 버전 | 수정 내용 |
|---|---|
| otel.13 | 도구(hook) 실행 실패 시 스팬 상태가 기록되지 않던 문제 수정 — 이전엔 실패해도 전체 84만 스팬이 `STATUS_CODE_UNSET`이었음 |
| otel.14 | MCP 서버 이름 분류 정규화 — 공백/대문자 포함 서버명(`"sds confluence"`, `"DS Search"`) 호출이 `hook.*`로 잘못 분류되던 문제 수정, `mcp.*` + `mcp.server_name` 태그 정상 부착 |
| otel.15 | LLM 호출 자체의 실패(인증/타임아웃/중단)도 `gen_ai.completion.*` 스팬에 `STATUS_CODE_ERROR`로 기록되도록 확장 |
| otel.16 | **긴급 수정**: OpenCode가 성공 메시지에도 `error: null`을 명시적으로 내려주는데, `error !== undefined` 판정 로직이 이를 "에러 있음"으로 오판정 — 모든 LLM 호출이 에러로 잘못 표시되던 버그 수정 (`!= null`로 undefined/null 모두 "에러 없음"으로 처리) |

### 실측 시나리오

| # | 시나리오 | 원인 스팬 | 실측 증빙 |
|---|---|---|---|
| 1 | MCP 도구 실패 (외부 시스템) | `{agent}.mcp.ds_search.DS_Search_confluence_reader` (9.13s) | `otel.status_code=ERROR`, `error=true`, `mcp.server_name=ds_search`, Logs(1) exception |
| 2 | 파일 시스템 에러 (로컬) | `{agent}.hook.read` (64.5ms) | `exception.message: File not found: C:\setup\nonexistent-trace-test-xyz-98765.txt` + 스택트레이스 |
| 3 | 네트워크/HTTP 페치 실패 | `librarian.hook.webfetch` (567ms) | `otel.status_code=ERROR`, `error=true`, `hook.error=true`, Logs(1) exception |

[📷 스크린샷: 시나리오 1 — Jaeger에서 `DS_Search_confluence_reader` 빨간 에러 스팬]

[📷 스크린샷: 시나리오 2 — Jaeger `hook.read` 스팬 Logs 탭, exception.message/stacktrace]

[📷 스크린샷: 시나리오 3 — Jaeger `librarian.hook.webfetch` 스팬, 404 exception]

세 시나리오는 각각 **외부 시스템(MCP) / 로컬 파일시스템 / 네트워크(HTTP)** 로 실패 계층이 서로 다르며, 모두 트레이스 목록에서 **빨간색 에러 아이콘으로 즉시 식별**되었고, 스팬 클릭 → Logs 탭 한 번으로 에러 메시지·대상·스택트레이스까지 도달하였다. 시나리오 3(webfetch)의 경우 `exception.message`에 `StatusCode: non 2xx status code (404 GET https://github.com/hrfairy/express-async-errors)`로 실패한 URL과 HTTP 상태 코드까지 원인 스팬 하나에서 정확히 확인되었다. 별도 로그 검색이 전혀 필요 없었다. 개선 전에는 로그를 수작업으로 분석해야 했고 소요 시간의 측정 기준 자체가 없었다.

> **비고**: 정확한 t0(발생)→t1(원인 확인) 소요시간은 스톱워치 단위로 기록하지 못하였다 — 체감상 트레이스 오픈 즉시(1~2분 이내) 확인 가능한 수준이었으나, 목표(30분 이내) 대비 정량 비교를 위해서는 재측정을 권장한다.

**측정 방법**: 폐쇄망에서 의도적으로 장애를 재현(존재하지 않는 파일 접근, 잘못된 MCP 인자)한 뒤 ClickHouse에서 `StatusCode = 'STATUS_CODE_ERROR'` 조회 → Jaeger에서 해당 TraceId 열어 원인 스팬 확인.

---

## 4. 사고 과정(CoT) 캡처율 — 실측 상세

**측정식**: `100 * (gen_ai_reasoning_present="true" 스팬 rate) / (전체 gen_ai.completion 스팬 rate)` — LLM 호출 스팬 중 사고 과정이 실제로 캡처된 스팬의 비율.

측정 구간(2026-07-15 21:52~21:56, 15초 간격) 동안 분자·분모가 함께 상승하며 **캡처율 100%**를 기록하였다(목표 80% 이상). 직전 구간(트래픽 없음)에는 0%였다가 omo 실행 직후 단일 스텝으로 100%까지 상승한 것으로, 계측 파이프라인이 트래픽 발생과 즉시 동기화됨을 확인하였다.

[📷 스크린샷: Grafana "KPI 4 — CoT 캡처율" 게이지 100%]

**Prometheus API 교차 검증**: UI 표시값뿐 아니라 원본 쿼리로도 동일 결과를 재확인하였다.

```powershell
$query = '100 * sum(rate(omo_calls_total{span_name=~".*gen_ai\.completion\..*",gen_ai_reasoning_present="true"}[10m])) / clamp_min(sum(rate(omo_calls_total{span_name=~".*gen_ai\.completion\..*"}[10m])), 0.0001)'
$encoded = [uri]::EscapeDataString($query)
(Invoke-RestMethod -Uri "http://localhost:19090/api/v1/query?query=$encoded").data.result

# metric value
# ------ -----
#        {1784187992.823, 100}
```

`value` 필드는 `[유닉스 타임스탬프, 값]` 쌍이며, 결과값 `100`이 Grafana 게이지와 정확히 일치함을 확인하였다.

**측정 방법**: 의도적으로 omo를 실행하여 실 트래픽을 발생시킨 뒤, Grafana UI 표시값과 Prometheus HTTP API 원본 쿼리 결과를 교차 대조.

---

## 5. 사용량 가시성 — 실측 상세

사용량 가시성은 (1) 표준 속성 수집, (2) 비용 산정 체계, (3) 컨텍스트 크기 가시성 세 부분으로 검증하였다.

### 5.1 개선 전/후

**개선 전 — 분산·집계 불가**: 기존에는 모델별 토큰·비용 데이터가 세션/프로세스 로그에 흩어져 있어, 모델별로 얼마나 쓰였는지 집계할 표준화된 방법이 없었다.

**개선 후 — `gen_ai.*` 표준 속성 수집 + 비용 산정 체계 보완**: OTel `gen_ai.*` 시맨틱 컨벤션에 따라 모델(`gen_ai_request_model`), 입력 토큰, 출력 토큰, 호출 수는 표준 속성으로 수집되도록 전환하였다. 다만 **비용(`gen_ai.usage.cost`)은 자체호스팅 모델 특성상 API 응답에 원천 데이터가 없어 표준 속성만으로는 채워지지 않는다** — 이를 보완하기 위해 Grafana에 모델별 단가 수동 입력 변수를 추가하고, 실측 토큰 사용량에 곱하는 방식으로 비용을 별도 산출하는 체계를 구축하였다.

### 5.2 비용 데이터 부재의 기술적 원인과 해결

OTel `gen_ai.*` 시맨틱 컨벤션에서 `gen_ai.usage.cost`는 LLM 프로바이더의 API 응답에 비용 필드가 포함된 경우에만 채워지는 값이다. OpenAI/Anthropic 같은 상용 API는 응답에 과금 정보를 실어 보내주지만, CodeLLM 계열은 **사내 자체호스팅 모델**이라 `codemate` 프록시의 API 응답 자체에 비용 필드가 없다 — 즉 계측 코드가 값을 못 읽어온 게 아니라, **모델 서버가 애초에 비용 데이터를 주지 않는 구조적 특성**이다. 이는 자체호스팅 LLM 배포 환경에서 공통적으로 나타나는 제약이며, "계측 실패"가 아니라 "원천 데이터 부재"로 명확히 구분할 필요가 있다.

[📷 스크린샷: "예상 비용 (USD)" 패널 — $0.0 (gen_ai.usage.cost 원천 데이터 없음)]

**해결**: 원천 데이터가 없는 문제를 계측 코드 수정으로는 해결할 수 없으므로, Grafana `OMO Cost & Token Dashboard`에 **모델별 단가 입력용 템플릿 변수 6개**를 신규 추가하였다(입력·출력 단가 × Max/Pro/Image 3개 모델). 이 값은 텍스트박스 변수라 실제 계약 단가가 확정되면 대시보드 UI에서 바로 교체 가능하며, 코드/설정 파일 수정이나 재배포 없이 즉시 전체 비용 패널에 반영된다.

[📷 스크린샷: Grafana 상단 6개 단가 입력 변수 (Max/Pro/Image × 입력/출력)]

### 5.3 모델 매핑 및 단가

CodeLLM-Max/Pro/Image는 자체호스팅 모델로 공개 과금 기준이 없어, 각 모델이 동급으로 언급된 공개 모델의 2026-07 기준 공식/표준 API 단가를 비용 산정 참고값으로 사용하였다.

| CodeLLM 모델 | 동급 모델 | 입력 단가 (USD/1M) | 출력 단가 (USD/1M) | 단가 출처 | 비고 |
|---|---|---:|---:|---|---|
| CodeLLM-Max | GLM-5.2 (Z.ai) | $1.40 | $4.40 | Z.ai 공식 (docs.z.ai) | GA 2026-06-16, 캐시 입력 $0.26/1M |
| CodeLLM-Pro | Qwen3.5-397B | $0.39 | $0.90 | Qwen 공식 | 프로바이더별 상이(DeepInfra $0.54/$3.40 등) |
| CodeLLM-Image | Gemma4-31B | $0.12 | $0.35 | 표준가(OpenRouter 등 대다수 프로바이더 동일) | Google AI Studio는 무료 티어 제공 |

**CodeLLM 모델 기술 사양 (동급 모델 선정 근거)**

| 항목 | CodeLLM-Max | CodeLLM-Pro | CodeLLM-Image |
|---|---|---|---|
| 모델 타입 | Text/Code/Chat/Agent | Text/Code/Chat/Agent | Text/Image/Code/Chat/Agent |
| 아키텍처 | MoE | MoE | MoE (활성 파라미터 ~4B) |
| Context Window | 202K Tokens | 262K Tokens | 128K Tokens |
| Max Output | 32K Tokens | 32K Tokens | 32K Tokens |
| 출시일 | 2026-06 | 2026-06 | 2026-03 |
| 주요 벤치마크 | Terminal-Bench 2.1 81.0 · SWE-bench Pro 62.1 · NL2Repo 48.9 | Terminal-Bench 2.1 64.2 · SWE-bench Verified 75.6 · SWE-bench Pro 50.4 · NL2Repo 34.6 | (멀티모달 특화, 코딩 벤치마크 미기재) |

### 5.4 실측 검증 (폐쇄망, 2026-07-16, Last 2 days)

**(1) 표준 속성 수집 (OpenLIT/Grafana 핵심 5지표 — 정상 표출)**: `gen_ai.*` 5개 표준 속성이 모두 수집되어 "OMO Cost & Token Dashboard"의 "Model별 분석" 섹션에 모델별로 분리 표출됨을 확인하였다.

| 핵심 지표 | 확인된 패널 | 실측값 (CodeLLM-Max / Pro / Image) |
|---|---|---|
| 모델 | Model별 토큰 사용량 (도넛) | 3개 모델 분리 표출 (84% / 16% / 1%) |
| 입력·출력 토큰 | Model별 토큰 사용량 (표) | 273 Mil / 51.4 Mil / 2.06 Mil |
| 호출 수 | Model별 호출 횟수 추이 | 1.74 / 0.562 / 0.719 req/s |
| 비용 | 모델별 예상 비용 | $384.5 / $20.3 / $0.3 |
| 합계 비용 | 모델별 예상 비용 (합계) | **$405.0** |

참고로 오늘(24h) 222Mil 토큰, 최근 7일 1.40Bil 토큰이 사용되었다.

[📷 스크린샷: "Model별 토큰 사용량" 도넛 + "모델별 예상 비용" 패널]

**계산 방식**: 각 모델의 실제 입력·출력 토큰 사용량(`gen_ai.usage.input_tokens`/`output_tokens`, 실측 표준 속성)에 위 단가를 곱하는 PromQL을 신규 패널로 추가하였다.

```
(모델별 입력 토큰 증가량 × 입력단가 ÷ 1,000,000) + (모델별 출력 토큰 증가량 × 출력단가 ÷ 1,000,000)
```

**(2) 모델별 분리 집계의 필요성**: 이 모델별 합산치($405.0)는 모델 구분 없이 전체 트래픽에 Max 단가를 일괄 적용한 기존 "수동 단가 기준" 패널의 **$67.3K**와 크게 어긋난다($67.3K ÷ $405.0 ≈ **166배**). 이는 CodeLLM 계열이 아닌 다른 모델(비교/외부 호출용) 트래픽까지 Max 프리미엄 단가로 잘못 환산되기 때문이다. 즉 모델별로 분리 집계하지 않으면 비용이 두 자릿수~세 자릿수 배로 과대 추정될 수 있으며, 이는 "분산·집계 불가" 상태에서 `gen_ai.*` 표준 속성 기반 모델별 집계 체계로 전환해야 하는 근거를 정량적으로 보여준다.

→ **5개 지표 모두 OpenLIT/Grafana에서 모델별로 정상 표출됨을 확인** — "분산·집계 불가"였던 상태에서 "모델별 표준 속성 기반 집계"로 전환 완료.

**단가 산정 기준**: 실제 CodeLLM 계약 단가가 확정되면 대시보드 상단 변수만 교체해 즉시 갱신 가능하다.

### 5.5 컨텍스트 크기 가시성

`provider.codemate.models.*.limit.context` 설정(Max 202K / Pro 262K / Image 128K)을 통해, 모델별 실제 한도 기준 컨텍스트 사용률이 Grafana에 정상 표출됨을 확인하였다.

```json
// C:\Users\jinguss.park\.config\opencode\opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "codemate": {
      "models": {
        "CodeLLMMax":   { "limit": { "context": 202000, "output": 32000 } },
        "CodeLLMPro":   { "limit": { "context": 262000, "output": 32000 } },
        "CodeLLMImage": { "limit": { "context": 128000, "output": 32000 } }
      }
    }
  }
}
```

| 모델 | 실제 한도 | 선택 기간 내 최대 사용률 |
|---|---|---|
| CodeLLM-Image | 128K | 71.2% |
| CodeLLM-Max | 202K | 61.2% |
| CodeLLM-Pro | 262K | 54.7% |

[📷 스크린샷: "선택 기간 내 모델별 최대 컨텍스트 사용률" 패널]

이는 `provider.*.limit.context` 설정만으로(코드 변경 없이) 모델별 실제 한도가 반영됨을 보여주며, 모델별 속성 없이는 컨텍스트 소진 임박 여부조차 정확히 판단할 수 없었던 상태에서 벗어났음을 뜻한다.

---

## 6. 회귀 비교 — 실측 상세

**목적**: "동일 시나리오를 반복 실행했을 때 결과를 자동으로 비교할 수 있는가"를 검증. A/B 회귀 대시보드에 시나리오 길이(A/B 각각)와 A→B 간격을 변수화하여, 수동으로 실행한 두 테스트를 시간 구간으로 분리·비교하는 구조를 구축하였다.

### 6.1 실험 설계 — AI DLC 스킬 언어 비교

동일한 요구사항 분석 스킬(`anl-functional-req-definition`, AI DLC 1단계)을 **한국어 원본**과 **영어 번역본**으로 각각 실행하여, 언어 차이가 토큰 효율·응답 시간에 미치는 영향을 비교하였다. 모델은 **CodeLLM-Pro로 고정**(`oh-my-openagent.json`의 모든 에이전트/카테고리 라우팅을 Pro로 일괄 설정)하여 모델 차이가 결과에 섞이지 않도록 통제하였다.

[📷 스크린샷: AI DLC 분석 1단계 스킬 실행 화면]

### 6.2 실측 결과

**컨텍스트 토큰 (OpenCode 세션 스냅샷 기준)**

| | 컨텍스트 토큰 |
|---|---:|
| A (한국어) | 113,542 |
| B (영어) | 100,985 |
| **차이** | **-12,557 (약 -11.1%)** |

한국어가 영어보다 약 11% 더 많은 토큰을 소비하였다 — 한국어 텍스트가 BPE 계열 토크나이저에서 서브워드 토큰을 더 많이 사용하는 특성과 일치하는 방향이다.

**레이턴시 (p50/p95/p99, ms)**

| | A (한국어) | B (영어) |
|---|---|---|
| p50 (Mean/Max/Min) | 10.4s / 20s / 3.50s | 34.3s / 1min / 3.96s |
| p95 (Mean/Max/Min) | 32.1s / 1min / 9.49s | 48.8s / 1min / 8.94s |
| p99 (Mean/Max/Min) | 33.3s / 1min / 9.90s | 51.6s / 1min / 9.79s |

[📷 스크린샷: A vs B 레이턴시 비교 패널]

**Grafana 누적 토큰 사용량**: A(한국어) 1.30M, B(영어) 3.73M — B가 더 큰 이유는 OpenCode의 "컨텍스트 스냅샷"(마지막 턴 기준 1회성 값)과 달리, Grafana 값은 **세션 내 전체 LLM 호출의 입력+출력 토큰 누적 합산**이기 때문이다. B 테스트가 실행 시간이 더 길고 호출 횟수가 많았던 것이 누적치에 반영되었다.

### 6.3 성공률/에러율 자동 집계 — 발견 및 수정

A/B 비교를 실제로 검증하는 과정에서, **성공률 패널이 A/B 모두 0%로 표시되는 이상 현상**을 발견하였다. 원인 분석 결과, otel.15에서 추가한 LLM 에러 판정 로직(`error !== undefined`)이 OpenCode가 성공 메시지에도 명시적으로 내려주는 `error: null`을 "에러 있음"으로 오판정하여, **모든 LLM 호출이 실제로는 성공했음에도 에러로 잘못 기록**되고 있었다. 실제 호출/토큰 데이터는 정상 존재했으나 에러율만 100%로 계산되는 상태였다.

`!= null`(undefined와 null을 모두 "에러 없음"으로 처리)로 즉시 수정(otel.16)하고 회귀 테스트를 추가하였다 — **이 발견·수정 자체가 "success/attempt 자동 기록 구조"의 신뢰성을 검증하고 강화한 과정**이다.

> **상태**: otel.16 적용 후 성공률 재검증이 진행 중이다. 본 문서의 A/B 레이턴시·토큰 수치는 이 버그와 무관하게 유효하나, 최종 성공률/에러율 수치는 otel.16 기준으로 재확인 후 추가할 예정이다.

### 6.4 대시보드 구조 개선

A/B 시나리오를 시간 구간으로 자동 분리하기 위해 다음 구조를 신규 구축하였다:

- **A 시나리오 길이 / A→B 간격 / B 시나리오 길이** 3개 변수로 분리 — B는 항상 "지금 기준 최근 N분", A는 "B 시작 시점 이전 N분"으로 자동 분리되어 두 구간이 겹치지 않음
- 짧은 수동 테스트(5~30분 단위)에 맞는 프리셋 추가
- 배포 전/후 전용이던 기존 설계를 모델 비교·언어 비교 등 범용 시나리오 비교로 확장

[📷 스크린샷: A/B 회귀 대시보드 변수 패널 (A 시나리오 길이 / A→B 간격 / B 시나리오 길이)]

---

## 부록 A. 발견 및 수정된 계측 버그 전체 목록

| 버전 | 버그 | 영향 | 수정 |
|---|---|---|---|
| otel.13 | 도구 실패 시 스팬 상태 미기록 | 84만 스팬 전부 `STATUS_CODE_UNSET` — 원인 파악 불가 | 실패 시 `STATUS_CODE_ERROR` + exception 기록 |
| otel.14 | MCP 서버명(공백/대문자 포함) 분류 실패 | MCP 호출이 `hook.*`로 잘못 분류, `mcp.server_name` 누락 | 서버명·도구명 정규화 매칭 |
| otel.15 | LLM 호출 자체 실패 미기록 | LLM 에러(인증/타임아웃 등)가 정상 완료처럼 보임 | `AssistantMessage.error` 필드 반영 |
| otel.16 | `error !== undefined`가 `null`을 에러로 오판정 | 모든 LLM 호출이 에러로 표시(성공률 0%) | `!= null`로 undefined/null 통합 처리 |
| (대시보드) | `span_filter` 변수에 "All" 옵션 부재 | 리터럴 문자열 "All" 입력 시 매칭 0건 | "전체"→"All"로 개명 + 기본값 지정 |
| (대시보드) | A/B 시나리오 시간창이 항상 "~지금"으로 끝남 | A 구간에 B 구간이 포함되어 비교 오염 | 길이+간격(timeShift) 구조로 재설계 |
| (대시보드) | 패널 JSON 중복 키(`timeShift` 두 번 선언) | A 시나리오 레이턴시 패널만 시간 분리 무효화 | 중복 키 제거 |
