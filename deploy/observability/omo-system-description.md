# 4. 과제 시스템 설명

사용자는 AI Agent 개발, 운영, 최종 사용자다. 본 과제의 역할별 기능은 다음과 같다.

| 기능 | 작동 조건 | 입력 | 출력 / 제공 가치 |
|---|---|---|---|
| 실행 트레이스 수집 | OpenCode 세션 실행 + OMO otel 활성 | 세션·에이전트·도구·MCP·LLM 이벤트 | Jaeger 호출 트리(세션→위임→도구/MCP→LLM 4계층) → 병목·실패 지점 식별 |
| LLM 사용량 집계 | assistant 메시지 완료(`finish`) 또는 실패(`error`) | modelID·입출력/추론 토큰 | 모델별 토큰·호출 수·추론 비중 → 운영비 통제 근거 |
| 비용 산정 (이원화) | 대시보드 단가 변수 입력 | 실측 토큰 × 모델별 단가 | 비용을 보고하지 않는 자체호스팅 모델의 비용 가시화 |
| 실패 원인 진단 | 에러 상태 계측 (본 과제에서 신규 구축) | 도구/MCP/LLM 실패 이벤트 | 원인 스팬 즉시 식별 (`STATUS_CODE_ERROR` + exception 메시지·스택트레이스) |
| 컨텍스트 소진 관리 | `provider.*.limit.context` 설정 | used_tokens / limit | 모델별 컨텍스트 사용률 → 한도 초과·compaction 사전 예방 |
| 폐쇄망 수집 | OTLP 미가용 시 | 로컬 traces.jsonl / metrics.jsonl | 오프라인 수집·사후 분석 → 보안망 운영 가능 |

**모니터링 대상 — OMO 멀티에이전트 구성.** OMO는 역할이 다른 11개 에이전트가 협업하는 자율형 멀티에이전트 오케스트레이션이다. 메인 오케스트레이터가 작업을 계획해 서브에이전트에 병렬·연쇄로 위임한다. 본 과제 계측은 각 에이전트 실행을 `agent.execute.{name}` 스팬으로, 각 도구/MCP 호출을 `{agent}.hook.{tool}` / `{agent}.mcp.{server}.{tool}` 스팬으로, 각 LLM 호출을 `{agent}.gen_ai.completion.{model}` 스팬으로 분리 가시화한다 — 스팬 이름에 에이전트를 접두사로 포함시켜, Jaeger 트레이스 트리에서 "어느 에이전트가 무엇을 했는지"를 클릭 없이 한눈에 구분할 수 있게 하였다.

| 에이전트 | 역할 | 모드 |
|---|---|---|
| Sisyphus | 메인 오케스트레이터 — 계획 수립 후 서브에이전트에 위임 | primary |
| Prometheus | 전략 기획(요구 인터뷰·계획 수립) | primary |
| Atlas | 투두리스트 오케스트레이터 — 체크박스 단위 위임 | primary |
| Hephaestus | 자율 심층 작업자(목표 지향 구현) | primary |
| Sisyphus-Junior | 카테고리 라우팅으로 스폰되는 작업 실행기 | subagent |
| Metis | 사전 기획 컨설턴트 | subagent |
| Momus | 계획 리뷰어 | subagent |
| Oracle | 읽기 전용 자문(코드/설계 consult) | subagent |
| Librarian | 외부 문서·코드 검색 | subagent |
| Explore | 컨텍스트 grep(코드 탐색) | subagent |
| Multimodal-Looker | PDF·이미지 분석 | subagent |

이처럼 다수 에이전트가 동시에 도구·MCP·LLM을 호출하므로(현업 문제 정의의 비가시성 문제), 에이전트·모델별 분리 가시화가 운영의 핵심이다.

---

# 사용된 AI 기술 및 선택 이유

핵심 기술은 '후보 비교 → 평가 → 채택' 절차로 결정하였다.
평가 축은 계측 정확성, 고객사내 보안 정합성(사내 모델/폐쇄망), 유지보수성(표준·재사용), 비용이다.

## 선택 1. 모니터링 대상 에이전트·프레임워크 (LangGraph PoC → OMO 확장)

**설계 근거.** 관측성 파이프라인(SDK→Collector→백엔드)을 먼저 통제된 조건에서 검증한 뒤 실제 현업 도구로 확장해 활용도를 확보해야 했다. 즉 "검증 용이성"과 "현업 정합성"을 단계로 분리했다.

- **후보 1) 자체 제작 예제(LangGraph) 단독 계측** — Mock LLM으로 완전 통제가 가능해 파이프라인 검증엔 최적이나, 현업에서 실제 쓰는 도구가 아니라 산출물 활용도가 낮다.
- **후보 2) 현업 표준 도구(OMO/OpenCode) 바로 계측** — 현업 정합성은 최고이나, 초기부터 실도구의 복잡한 이벤트·위임 구조를 계측·검증해야 해 리스크가 크다.
- **후보 3) 2단계: LangGraph(PoC) 검증 → OMO 확장 (채택)** — 프레임워크 중립성을 PoC로 입증한 뒤 사내 표준 도구로 확장.

| 품질속성 | 후보1 LangGraph 단독 | 후보2 OMO 바로 | 후보3 2단계 (채택) |
|---|---|---|---|
| 검증 용이성(통제·Mock) | ++ | − | ++ |
| 현업 정합성·활용도 | − (예제) | ++ | ++ (최종 OMO) |
| 표준·재사용(gen_ai.*) | + | + | ++ (양쪽 공통) |
| 초기 리스크 | ++ (낮음) | −− (높음) | + (단계적 완화) |

**채택.** LangGraph → OMO 2단계. LangGraph는 그래프(노드) 실행이 트레이스 트리에 잘 매핑되고 Python 계측 예제가 풍부해 Mock LLM으로 SDK→Collector→백엔드 전 구간을 통제된 조건에서 end-to-end 검증하고 프레임워크 중립성을 입증하기에 적합하다. 이후 사내 표준 자율형 코딩 에이전트 OMO/OpenCode(멀티에이전트 위임 구조로 트레이스 가치가 크고 사용량 급증 대상)로 확장해 현업 정합성·활용도를 확보했다. 두 스택 모두 OpenTelemetry 표준(gen_ai.*)이라 계측·대시보드를 그대로 재사용한다.

**위험 요인.** 두 스택 병행 유지 부담 → 공통 OTEL 표준으로 계측·대시보드를 공유하고, LangGraph는 PoC 범위로 한정.

## 선택 2. LLM 사용량 계측 방식

**설계 근거.** OMO 기본 계측은 실행 흐름(세션·에이전트·도구·MCP)만 남기고 모델·토큰·비용을 수집하지 않아, 제안 핵심 KPI(Model별 Token/비용)를 채울 계측 방식을 선택해야 했다.

- **후보 1) 자동 계측(auto-instrumentation)** — 코드 수정 최소. 그러나 사내 자체호스팅 모델은 식별·가격 정보가 없어 비용이 0으로 누락되고, OMO 내부 위임(`agent.execute`)과 상관되지 않는다.
- **후보 2) OTel SDK 커스텀 계측 — 플러그인 내 `gen_ai.completion` 스팬 직접 기록 (채택)** — `message.updated`(finish 또는 error)에서 모델·토큰을 표준 스팬으로 직접 기록하고 세션 루트 하위로 상관해 에이전트별 분리가 가능하다.
- **후보 3) APM 에이전트 / 로그 파싱** — 외부 상용 의존 또는 로그 후처리. 폐쇄망·표준 정합성·정확성에서 불리하다.

| 품질속성 | 후보1 자동계측 | 후보2 커스텀계측 (채택) | 후보3 APM·로그 |
|---|---|---|---|
| 계측 정확성 | + (사내모델 누락) | ++ (직접 기록) | + |
| 사내 모델 적합성 | −− (식별·가격 없음) | ++ (모델 식별 직접) | − |
| 유지보수성(표준) | + | ++ (gen_ai.* 표준) | − (벤더 종속) |
| 폐쇄망 적합성 | − | ++ (file exporter·무중단) | −− (SaaS 의존) |

**채택.** 사내 모델 식별까지 정확히 수집하면서 표준·폐쇄망 적합성이 높은 OTel 커스텀 계측을 채택. 수집 속성: `gen_ai.request.model` · `gen_ai.system`(프로바이더) · `gen_ai.usage.input/output/reasoning/total_tokens` · `gen_ai.usage.cost`(제공 시) · `gen_ai.reasoning_present` · `gen_ai.skill_used` · `gen_ai.context.used_tokens/limit/usage_ratio` · `gen_ai.agent.name` · `session.id`. 아울러 본 과제에서 **실패 상태 계측을 신규 구축**하였다 — 도구 실패(hook), MCP 실패, LLM 호출 자체 실패(인증/타임아웃/중단)를 모두 `STATUS_CODE_ERROR` + exception 이벤트로 기록해, 실패 유형과 무관하게 Jaeger에서 원인 스팬이 즉시 식별된다.

**위험 요인.** 플러그인 이벤트 스키마 변경/해석 오류 시 계측 왜곡 가능 → 단위 테스트와 NOOP 폴백·예외 격리로 완화(텔레메트리 실패가 에이전트 실행을 막지 않음). **실증 사례**: OpenCode가 성공 메시지에도 `error: null`을 명시적으로 내려주는 스키마 특성을 놓쳐 전 호출이 에러로 오판정되는 결함이 실측 중 발견되었고, 회귀 테스트 추가와 함께 즉시 수정하였다 — 이 발견·수정 과정 자체가 "지표를 실측으로 교차 검증해야 하는 이유"를 보여준다.

## 선택 3. 사내 모델 비용 산정 방식

**설계 근거.** OpenCode는 공개 모델 비용은 제공하나 사내 자체호스팅 모델(codemate 프록시의 CodeLLM Max/Pro/Image) 비용은 제공하지 않는다 — 모델 서버의 API 응답 자체에 비용 필드가 없는 원천 데이터 부재이며, 계측 코드로는 해결할 수 없다. 또한 사내 단가는 미확정 상태로 추후 변동 가능성이 크다.

- **후보 1) reportedCost만 사용** — 사내 모델 비용이 항상 0 → KPI 미충족.
- **후보 2) 계측 코드에 단가 내장** — 플러그인 코드에 모델별 단가를 하드코딩. 단가 변경 시마다 재빌드→폐쇄망 반입→재설치가 필요해 폐쇄망 운영 비용이 크다.
- **후보 3) Grafana 대시보드 변수 기반 모델별 단가 (채택)** — 실측 토큰(`gen_ai.usage.input/output_tokens`)에 대시보드 템플릿 변수로 입력한 모델별 단가를 곱해 산정. 단가 변경이 UI 입력만으로 즉시 전체 패널에 반영된다.

| 품질속성 | 후보1 reportedCost | 후보2 코드 내장 단가 | 후보3 대시보드 변수 단가 (채택) |
|---|---|---|---|
| 산정 정확성 | −− (사내모델 0) | ++ | ++ (실측 토큰 × 단가) |
| 단가 변경 대응 | − | −− (재배포 필요) | ++ (UI 입력 즉시 반영) |
| 폐쇄망 운영성 | + | −− (반입 절차 반복) | ++ (재배포 불요) |
| 유지보수성 | + (단 무의미) | − | + (변수 6개 관리) |

**채택.** 모델별 단가 입력용 템플릿 변수 6개(입력·출력 단가 × Max/Pro/Image)를 Grafana `OMO Cost & Token Dashboard`에 신규 추가하고, PromQL로 `(모델별 입력 토큰 증가량 × 입력단가 + 출력 토큰 증가량 × 출력단가) ÷ 1,000,000`을 계산하는 모델별 비용 패널을 구축했다. 단가 참고값은 각 모델이 동급으로 언급된 공개 모델의 2026-07 기준 공식/표준 API 단가를 사용했다(Max≈GLM-5.2 $1.40/$4.40, Pro≈Qwen3.5-397B $0.39/$0.90, Image≈Gemma4-31B $0.12/$0.35 — 1M tokens 기준). 같은 원리로 **컨텍스트 윈도우 한도** 역시 자동 조회가 불가능한 사내 모델에 대해 `provider.codemate.models.*.limit.context` 설정(Max 202K/Pro 262K/Image 128K)으로 보완해, 코드 변경 없이 모델별 컨텍스트 사용률까지 표출된다.

**위험 요인.** 참고 단가는 실제 계약 단가가 아닌 추정치 → 실제 단가 확정 시 대시보드 변수만 교체하면 즉시 반영. 모델 구분 없이 단일 단가를 일괄 적용할 경우 비용이 두 자릿수 배 이상 과대 추정될 수 있음을 실측으로 확인하였으며(비교/외부 모델 트래픽까지 프리미엄 단가로 환산되는 문제), 모델별 분리 집계가 필수임을 정량 근거로 확보했다.

## 선택 4. 관측 백엔드

**설계 근거.** 트레이스(호출 트리)와 LLM 특화 지표(모델·토큰·비용)를 동시에, 그리고 폐쇄망에서 운영해야 한다.

- **후보 1) Jaeger 단독** — 호출 트리 추적은 우수하나 모델·토큰·비용 집계 화면이 없다.
- **후보 2) Jaeger + OpenLIT(+Prometheus/Grafana) (채택)** — Jaeger로 호출 트리, OpenLIT(ClickHouse)로 gen_ai.* 기반 모델·토큰·비용 대시보드, Prometheus/Grafana로 시계열. 우리가 주입한 gen_ai.* 속성과 OpenLIT 쿼리 컨벤션이 일치한다.
- **후보 3) 외부 SaaS 관측(APM/Langfuse 등)** — 기능은 풍부하나 폐쇄망·비용·표준 측면에서 부적합.

| 품질속성 | 후보1 Jaeger 단독 | 후보2 Jaeger+OpenLIT (채택) | 후보3 외부 SaaS |
|---|---|---|---|
| LLM 특화 가시성 | − (집계 화면 부재) | ++ (모델·토큰·비용) | ++ |
| 폐쇄망 적합성 | ++ | ++ (전부 self-host) | −− (외부 의존) |
| 비용 | ++ | + (오픈소스) | −− (라이선스) |
| 표준 정합성 | + | ++ (gen_ai.*) | + |

**채택.** Jaeger + OpenLIT 병행(+Prometheus/Grafana). 단일 도구로는 호출 트리와 LLM 지표를 동시에 얻기 어렵다.

**위험 요인.** 백엔드 다수 운영 부담 → docker-compose 단일 기동 + 에어갭 이미지 패키징으로 완화. 실운영에서 확인된 추가 제약: Jaeger all-in-one의 기본 in-memory 저장소는 시간 범위 기반 검색이 불안정해(Grafana traces 패널의 시간창 질의가 빈 결과 반환), 트레이스 탐색은 Jaeger/OpenLIT 자체 UI를 직접 사용하는 것으로 역할을 정리하였다 — Grafana는 집계·시계열 전담.

### 컴포넌트별 채택 이유

전체 스택은 "Jaeger + OpenLIT(+Prometheus/Grafana)"를 채택했으며(모두 self-host·폐쇄망 적합·오픈소스), 구성 요소별 채택 이유는 다음과 같다.

| 컴포넌트 | 역할 | 채택 이유 |
|---|---|---|
| OTel Collector (contrib) | 수집·가공 허브 | OTLP 표준 수신 + 마스킹(redaction/transform)·batch·라우팅을 앱 밖에서 중앙화(앱 재배포 없이 정책 변경). ClickHouse exporter·OTTL·spanmetrics가 contrib 배포판에만 있어 core 대신 채택. |
| Jaeger (all-in-one) | 트레이스(호출 트리) | 세션→에이전트→도구→LLM 워터폴·지연·병목·실패 스팬 특정에 특화된 분산추적 표준. 경량 단일 컨테이너로 폐쇄망 부담 최소. |
| ClickHouse | 트레이스 저장소 | OpenLIT 백엔드 저장 계층. 컬럼형 OLAP로 대량 스팬·속성(gen_ai.usage.*)을 고속 집계. 본 과제의 구조적 검증 쿼리(고아 스팬·재귀 CTE 트리 도달성)도 직접 조회. |
| OpenLIT | LLM 특화 대시보드 | gen_ai.* 기반 모델별 Requests/Tokens/Cost. 우리가 주입한 표준 속성과 OpenLIT 쿼리 컨벤션이 1:1 일치. |
| Prometheus | 시계열 메트릭 | omo_* 카운터·spanmetrics(호출률·지연·토큰·비용 추이) 저장. 사실상 표준 TSDB. |
| Grafana | 통합 대시보드 | Prometheus 데이터소스 기반 KPI 종합·비용(omo-cost)·회귀 A/B(omo-regression)·트레이스 통계(omo-traces) 대시보드. 파일 프로비저닝(30초 자동 리로드)으로 폐쇄망에서도 git pull → 파일 복사만으로 대시보드 갱신. |

**역할 분담.** 실행 흐름 = Jaeger, 모델별 비용·토큰 = OpenLIT(ClickHouse), 시계열 추이·KPI·A/B 회귀 = Prometheus/Grafana. 단일 도구로는 호출 트리와 LLM 지표를 동시에 얻기 어렵고, 표준 OTLP로 분기하므로 어느 백엔드도 벤더 종속 없이 교체·제거가 가능하다.

계측 표준은 OpenTelemetry GenAI semantic convention을 채택해 벤더 종속을 제거했고, Collector는 memory_limiter·resource(deployment.environment)·batch로 수집 정책을 중앙화했다. 계측은 NOOP 폴백·전 구간 예외 격리·OTEL 비활성 기본값으로 무중단·최소수집(프롬프트 본문 4,000자 제한, 도구 인자는 값이 아닌 키 이름만 수집)을 보장한다.

**활성화.** `OMO_OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT`(예: http://localhost:14318/v1/traces), 또는 설정 파일의 otel 필드(enabled · endpoint · service_name · exporter · sampling_rate). 비활성(기본값)이면 SDK 미로드로 오버헤드 0.

**수집·저장 스택(6종).** OTel Collector · Jaeger(:26686) · ClickHouse · OpenLIT(:13000) · Prometheus(:19090) · Grafana(:13001).

**배포 추적성.** 플러그인 패키지는 git 태그(`v4.15.1-otel.N-pkg`)에 빌드 산출물(tar.gz + sha256)을 포함해 커밋하며, 폐쇄망은 git pull → 해시 검증 → 설치의 단일 경로로 반입한다. 트레이스의 `service.version` 속성으로 실제 배포 버전을 원격 검증할 수 있어, "설치했는데 구버전이 돌고 있는" 문제(플러그인 캐시 미갱신)를 실측으로 탐지·해결하였다.

## 선택 5. 중요정보(PII·사내 기밀) 필터링·마스킹 레이어 (정규표현식 기반, 채택)

**설계 근거.** 본 계측은 실행 추적 정확도를 위해 프롬프트·응답 본문을 스팬에 저장한다(gen_ai.prompt/completion, 최대 4,000자). 따라서 개인정보·사내 기밀(LOT·EQPID 등)이 스팬을 통해 저장소(ClickHouse·Jaeger)로 유출되지 않도록, exporter 이전 단계(OTel Collector)에서 중요정보를 식별·마스킹하는 전용 필터링 레이어를 둔다. 보안성과 처리 성능을 동시에 만족해야 한다.

- **후보 1) 정규표현식(Regex) 기반 필터링 (채택)** — 주민번호·전화번호·이메일·카드·API 키 등 형식이 명확한 항목을 패턴 매칭으로 마스킹. 빠르고 규칙을 운영자가 완전히 통제하나, 형식이 불명확한 자연어 내 정보는 놓칠 수 있다.
- **후보 2) NER(개체명 인식) 기반 필터링** — 문맥으로 개체(이름·위치 등)를 추출해 탐지. 직접 표현되지 않은 정보도 감지 가능하나, 별도 AI 모델 구동으로 리소스·지연이 크고 도메인 특화 기밀(내부 시스템명·LOT/EQPID)은 사전학습 범위 밖.
- **후보 3) 키워드 딕셔너리 기반 필터링** — 사전 등록 키워드 매칭. 빠르고 도메인 용어 추가가 쉬우나 변형·유사어 탐지 한계.

| 구분 | 정규표현식 (채택) | NER 기반 | 키워드 딕셔너리 |
|---|---|---|---|
| 성능(속도) | 빠름 (++) | 느림·모델 구동 (−−) | 빠름 (+) |
| 보안성 | 형식 명확 항목 고정밀, 자연어 내 정보엔 한계 (+) | 문맥 인식 가능 (+) | 정확 매칭만, 변형에 약함 (+) |
| 폐쇄망·리소스 | ++ (경량) | −− (모델·GPU) | + |
| 운영 통제성 | ++ (규칙 직접 관리) | − (재학습) | + (사전 관리) |

**채택.** 명확한 보안과 실행 성능 비저하를 가장 균형 있게 만족하는 정규표현식 기반 필터링을 채택했다. 실제 구현은 Collector 단 이중 가드레일로 동작한다 — redaction 프로세서가 이메일·주민등록번호·휴대폰·신용카드·API 키/토큰을 매칭 부분만 마스킹하고, transform(OTTL) 프로세서가 반도체 팹 특화 키(RCP·RECIPE·LOT·STEP·EQPID) 값을 앞 3자만 남기고 부분 마스킹한다(예: `LOT:ABC*`). 두 프로세서는 모든 exporter보다 먼저 실행되어 저장소엔 마스킹된 데이터만 남는다.

**위험 요인.** 정규표현식은 형식이 명확한 정보에만 유효하므로 문장 속에 자연스럽게 녹아든 정보는 노출될 수 있다 → 도메인 전문가 피드백으로 패턴 커버리지를 주기적으로 확대하고, 필요 시 NER 계층을 후속 보강한다.

---

# 성능 개선 포인트 (기본 구성 대비 추가 최적화)

과제 도입 전/후가 아니라, 기본 설정/구조로 수행했을 때 대비 추가로 적용한 최적화와 그 효과다.

| 최적화 | 방법 / 이유 | 개선 전→후 · 측정 방법/조건 |
|---|---|---|
| 저장량 절감 | 프롬프트/응답 본문 4,000자 제한 + 도구 인자는 값 대신 키 이름만 수집(민감정보 미수집 겸용) | 기본(전량) 대비 수집 바이트 감소, 동일 세션 표본 대조 |
| 실패 가시성 확보 | 도구/MCP/LLM 실패의 스팬 상태 미기록 공백을 발견·수정 (에러 상태 + exception 이벤트 계측 신규 구축) | 수정 전: 84만 스팬 전량 `STATUS_CODE_UNSET`(원인 파악 불가) → 수정 후: 3개 실패 계층(MCP/파일/네트워크) 모두 원인 스팬 즉시 식별 실측 |
| 비용 가시화 | 모델별 단가 변수 × 실측 토큰 기반 비용 패널 신규 구축 | 단일 단가 일괄 적용 대비 과대 추정 배율 실측 — 모델별 분리 집계 필요성의 정량 근거 확보 |
| 컨텍스트 한도 반영 | `provider.*.limit.context` 설정 기반 모델별 사용률 산출 (코드 변경 없음) | 설정 전: 사내 모델 사용률 표출 불가(No data) → 설정 후: 모델별 실제 한도(202K/262K/128K) 기준 사용률 표출 |
| 수집 정책 분리 | Collector batch/sampling/마스킹 중앙화로 앱 재배포 없이 정책 변경 | 정책 변경 반영 시간(앱 재배포 대비) |
| A/B 회귀 비교 구조 | 시나리오 길이+간격 변수로 두 실행 구간을 자동 분리 비교 (배포 전후·모델 비교·언어 비교 범용) | 실측: 동일 스킬 한국어/영어 비교 — 컨텍스트 토큰 약 11% 차이 검출 |
| 재사용성 | 지표명·속성 표준화(gen_ai.*) — LangGraph PoC와 OMO가 동일 대시보드 공유 | 신규 담당자 재현/이해 시간 |
| 배포 추적성 | git 태그에 빌드 산출물 포함, `service.version`으로 실배포 버전 원격 검증 | 버전 불일치(캐시 미갱신) 실측 탐지 사례 확보 |

---

# 구조 설명

전체 구조는 ① 대상·외부 연계, ② 수집 파이프라인, ③ 저장·가시화 백엔드의 3계층으로 구성된다.

## 전체 아키텍처 구조도 구성요소

아키텍처 구성도에서 표현한 Layer와 Module들의 역할에 대해서 아래 표에 정리하였다.

| Layer | Module | 설명 |
|---|---|---|
| 계측 대상 (OpenCode · OMO) | OpenCode | 사용자는 OpenCode에 질문·명령을 입력한다. |
| | OMO Plugin «otel-core» (자율형 코딩 에이전트) | OpenCode에 로드되는 사내 플러그인 하니스. DS 고객사내 표준 CLI형 자율 코딩 에이전트로, 세션·에이전트·도구·LLM 호출을 실제 실행하는 계측 대상이다. 커스텀 OTEL 계측(tool-span-tracker·gen-ai-completion-span·exporter-factory·config)을 추가해 실행 흐름과 gen_ai.* 지표를 표준 스팬으로 생성한다. |
| | OTel SDK / Exporter | OpenTelemetry JS SDK(sdk-trace/metrics). 생성 스팬을 OTLP(호스트 :14318)·file·console로 내보낸다. 비활성(기본값) 시 SDK 미로드로 오버헤드 0(무중단). |
| | 계측 스팬 (Trace Tree) | `user.prompt` · `agent.execute.{name}` · `{agent}.hook.{tool}` / `{agent}.mcp.{server}.{tool}`(도구·MCP) · `{agent}.gen_ai.completion.{model}`을 하나의 실행 트리로 상관. 실패 시 `STATUS_CODE_ERROR` + exception 이벤트가 함께 기록되어, 로그 수작업 추적을 대체하고 원인 파악 시간을 단축한다. |
| 외부 시스템 (External) | DS전자 고객사 LLM (CodeLLM) | 고객사 폐쇄망에 서빙되는 자율형 코딩용 LLM. Max/Pro/Image 3종(codemate 프로바이더) 체계이며, 응답에 토큰 usage(입력·출력·추론)를 제공해 사용량 집계의 원천이 된다. **비용·컨텍스트 한도는 응답에 포함되지 않아**, 각각 대시보드 단가 변수와 `provider.*.limit.context` 설정으로 보완한다(선택 3 참조). |
| 수집·가공 (OTel Collector · contrib) | OTLP Receiver | gRPC :4317 / HTTP :4318(호스트 :14317/:14318)로 애플리케이션 텔레메트리를 표준 프로토콜로 수신하는 진입점이다. |
| | 마스킹 가드레일 | exporter 이전 단계에서 PII(이메일·주민번호·휴대폰·카드·API키)와 사내 기밀(RCP·RECIPE·LOT·STEP·EQPID)을 정규표현식으로 마스킹한다. 저장소에는 마스킹된 데이터만 남겨 보안을 확보한다. |
| | spanmetrics Connector | 스팬을 호출수·지연 메트릭(omo_calls_total·omo_duration_milliseconds)으로 변환하여 시계열 지표를 생성한다. 스팬 속성(모델·에이전트·에러 상태·reasoning 여부)이 메트릭 차원으로 승격되어 Grafana KPI·A/B 회귀 비교의 기반이 된다. |
| | Processors (memory_limiter·resource·batch) | 수집 정책을 앱 밖에서 중앙화하여 앱 재배포 없이 정책을 변경한다. deployment.environment 등 리소스 태그를 부여한다. |
| 저장 (Storage) | Jaeger | 분산 트레이스(호출 트리)를 저장하는 백엔드이다. |
| | ClickHouse (openlit_db.otel_traces) | 컬럼형 OLAP DB. gen_ai.usage.* 등 대량 스팬 속성을 고속 집계하며 OpenLIT의 백엔드 저장소 역할을 한다. 본 과제의 구조적 검증 쿼리(고아 스팬 카운트·재귀 CTE 트리 도달성·에러 스팬 조회)도 직접 실행한다. |
| | Prometheus | omo_* 카운터·spanmetrics를 저장하는 시계열 데이터베이스(TSDB)이다. |
| | OpenLIT App DB (SQLite) | OpenLIT 컨테이너 내부에 임베드된 파일 DB(Prisma). user/org/project·datasource config 등 기준정보를 저장한다(별도 서비스인 ClickHouse와 다른 레벨). 사용자 정보, 대시보드의 정보 등을 관리한다. |
| 관측·시각화 (Observability UI) | Jaeger UI (호스트 :26686) | 세션→에이전트→도구→LLM 호출 트리·워터폴을 시각화하여 병목·실패 구간을 특정한다. 실패 스팬은 빨간색 에러 아이콘으로 즉시 식별되며, Logs 탭에서 exception 메시지·스택트레이스까지 확인된다. |
| | OpenLIT (호스트 :13000) | gen_ai.* 기반 모델별 Requests/Tokens/Cost 대시보드. ClickHouse를 직접 조회해 사용량을 집계한다. |
| | Grafana (호스트 :13001) | Prometheus를 데이터소스로 omo-kpi(KPI 종합)·omo-cost(비용·토큰)·omo-regression(A/B 회귀 비교)·omo-traces(스팬 지연 통계) 대시보드를 제공한다. 파일 프로비저닝(30초 자동 리로드)이라 폐쇄망에서도 git pull → 파일 복사만으로 갱신된다. 트레이스 개별 탐색은 Jaeger·OpenLIT 자체 UI가 전담한다(역할 분담). |
| 폐쇄망·무중단 (Resilience) | File Exporter (traces.jsonl/metrics.jsonl) | OTLP 콜렉터가 미가용인 환경에서 스팬·메트릭을 로컬(~/.cache/oh-my-openagent)에 JSONL로 저장했다가 사후 분석·재적재할 수 있다. |
| | 예외 격리 / NOOP | 전 계측 구간 try/catch + OTEL 비활성 기본값. 관측 스택이 멈춰도 에이전트·LLM 실행은 정상 동작한다(무중단). |

[그림 1] AI Agent 운영 가시화 시스템 블록 다이어그램

## 데이터 흐름

1. 개발자가 OpenCode(OMO CLI)에 프롬프트(질문·명령)를 입력한다.
2. OMO 플러그인이 DS전자 고객사 LLM에 요청(프롬프트 및 도구 결과)을 전달한다.
3. LLM이 응답과 함께 사용량(input·output·reasoning 토큰)을 반환한다. (비용은 반환하지 않으며, 대시보드 단가 산정으로 보완 — 선택 3)
4. 플러그인이 `user.prompt` · `agent.execute.{name}` · `{agent}.hook.{tool}` / `{agent}.mcp.{server}.{tool}`(도구·MCP) 스팬을 생성해 세션 루트 아래 하나의 실행 트리로 연결한다. 도구/MCP 호출이 실패하면 해당 스팬에 `STATUS_CODE_ERROR`와 exception 이벤트를 기록한다.
5. 응답이 완료(또는 실패)되면 본 과제가 추가한 `{agent}.gen_ai.completion.{model}` 스팬(모델·토큰·CoT(reasoning)·skill 사용 여부·컨텍스트 사용률, 실패 시 에러 상태 포함)을 기록한다.
6. 생성된 스팬을 OTel SDK/Exporter로 전달한다.
7. OTel SDK가 OTLP(호스트 :14318)로 스팬과 메트릭을 OTel Collector에 전송한다.
8. Collector가 본 과제가 추가한 마스킹(전체보안 마스킹 모듈로 PII, 도메인보안 마스킹 모듈로 LOT·EQPID 등 사내 기밀)을 모든 exporter 이전에 수행한다.
9. 마스킹된 트레이스·메트릭을 관측성 백엔드(Jaeger·ClickHouse·Prometheus)에 적재한다.
10. 관측성 스택 내부에서 OpenLIT은 ClickHouse를 직접 조회해 본 과제가 주입한 gen_ai.usage.* 속성 기반 모델별 토큰 대시보드를 구성하고, Grafana는 PromQL로 지표를 가져와 KPI·비용(단가 변수 × 실측 토큰)·A/B 회귀 비교를 계산한다.
11. 개발자가 대시보드(Jaeger 호출 트리·OpenLIT 토큰·Grafana KPI/비용/회귀)를 조회해 병목·원인과 사용량을 진단한다.

## 외부 시스템 연계

외부 연계는 사내 서빙 CodeLLM(Max/Pro/Image 3종)뿐이다(외부 공개 LLM 미사용). OpenCode가 추론 요청을 사내 LLM에 보내고, 응답의 모델·토큰이 계측되어 파이프라인으로 흐른다. 비용은 LLM 응답에 포함되지 않으므로, 실측 토큰에 대시보드 단가 변수를 곱해 산정한다.
