# OMO 플러그인 폐쇄망 설치 패키지

`package-omo-plugin.ps1`로 빌드된 폐쇄망용 플러그인 패키지입니다.
폐쇄망 머신은 이 레포를 pull(또는 해당 버전 태그 checkout)한 뒤, 아래처럼 압축을 풀어 설치합니다.

## 설치

```powershell
# 태그 기준으로 받기 (-pkg 태그가 이 패키지를 포함한 커밋을 가리킴)
git fetch origin --tags
git checkout v4.15.1-otel.16-pkg

# 무결성 확인
cd deploy\plugin-airgap
Get-FileHash omo-plugin-airgap-20260717-4.15.1-otel.16.tar.gz -Algorithm SHA256
# 출력이 .sha256 파일 내용과 일치해야 함

# 압축 해제 후 설치
tar -xzf omo-plugin-airgap-20260717-4.15.1-otel.16.tar.gz -C C:\setup\
cd C:\setup\omo-plugin-airgap-20260717-4.15.1-otel.16
.\install.ps1

# 중요: opencode 플러그인 캐시 갱신 — 이걸 빼먹으면 구버전이 계속 로드됨
#        (otel.12 → otel.13 업데이트 때 실제로 겪은 문제)
pwsh .\update-cache.ps1
```

설치 후 omo를 **완전히 재시작**하고, 트레이스의 `service.version`이 `4.15.1-otel.16`인지 확인하세요:

```powershell
docker exec clickhouse-by-claude clickhouse-client -q "
SELECT DISTINCT ResourceAttributes['service.version'] AS ver
FROM openlit_db.otel_traces
WHERE Timestamp >= now() - INTERVAL 10 MINUTE
FORMAT PrettyCompact"
```

## 버전별 변경점

### otel.16
- **긴급 수정**: LLM 호출 성공/실패 판정 로직이 `error !== undefined`로 되어 있었는데,
  OpenCode가 정상 완료된 메시지에도 `error: null`을 명시적으로 내려주는 방식이라
  `null !== undefined`가 `true`가 되어 **모든 LLM 호출이 에러로 오판정**되던 버그를 수정.
  (실측: A/B 회귀 대시보드에서 실제 실패가 0건인데도 성공률이 항상 0%로 표시됨 —
  otel.15에서 추가한 LLM 에러 캡처 기능의 회귀 버그. `!= null`로 undefined/null을 모두
  "에러 없음"으로 처리하도록 수정)
- otel.15를 설치하신 분은 **반드시 otel.16으로 업데이트하세요** — otel.15 상태로는
  성공률/에러율 관련 모든 지표가 무효합니다.

### otel.15
- LLM 호출 자체의 실패(인증 오류, rate limit, 출력 길이 초과, abort 등)도 `gen_ai.completion.*`
  스팬에 `STATUS_CODE_ERROR` + exception 이벤트로 기록됨.
  (이전: OpenCode의 `AssistantMessage.error` 필드가 이미 들어오는데도 스팬 쪽에서 전혀 읽지 않아,
  LLM 자체 에러는 정상 완료처럼 보였음 — otel.13에서 고친 도구 실패와 동일한 패턴의 누락)
- `message.updated` 이벤트에서 `finish`가 비어 있어도(LLM 호출이 완료 전에 에러로 끝난 경우)
  `error` 필드가 있으면 스팬을 기록하도록 게이팅 조건 확장.
- 검증: 잘못된 모델명 지정 등으로 LLM 에러를 유발한 뒤, ClickHouse에서
  `SpanName LIKE '%gen_ai.completion%' AND StatusCode = 'STATUS_CODE_ERROR'` 조회 시 결과 확인.

### otel.14
- MCP 서버 이름 분류 정규화: 공백/하이픈/대문자가 든 서버 이름(예: `"sds confluence"`, `"DS Search"`)의
  도구 호출이 `hook.*`가 아닌 `mcp.*` 스팬으로 분류되고 `mcp.server_name` 태그가 붙음.
  (이전: OpenCode가 도구 이름을 `sds_confluence_getPageByID`로 정규화해 등록하는데
  분류기는 설정 원문 `"sds confluence"`로 prefix 매칭해서 항상 실패)

### otel.13
- 도구 실행 실패 시 스팬에 `STATUS_CODE_ERROR` + exception 이벤트가 기록됨
  (이전 버전은 실패해도 모든 스팬이 `STATUS_CODE_UNSET` — Jaeger에서 원인 스팬 특정 불가였음)
- 검증: 의도적으로 도구 실패를 유발한 뒤 ClickHouse에서
  `SELECT ... WHERE StatusCode = 'STATUS_CODE_ERROR'` 조회 시 결과가 나오고,
  Jaeger에서 해당 스팬이 빨간색으로 표시되어야 정상.

## 컨텍스트 한도(context limit)가 "No data"로 나올 때

`resolveActualContextLimit()`은 알려진 provider(anthropic/openai/google 등) 외에는
**opencode.json의 `provider.<이름>.models.<모델>.limit.context` 설정값을 그대로 읽는 구조**라,
사내 프록시(`codemate` 등) 모델은 이 설정을 넣지 않으면 항상 "No data"입니다.
플러그인 재배포 없이 opencode.json에 아래처럼 추가하고 omo만 재시작하면 됩니다 — 모델이 바뀌면 이 값만 고치면 됨:

```json
"provider": {
  "codemate": {
    "models": {
      "CodeLLMMax": { "limit": { "context": 202000 } },
      "CodeLLMPro": { "limit": { "context": 262000 } },
      "CodeLLMImage": { "limit": { "context": 128000 } }
    }
  }
}
```
