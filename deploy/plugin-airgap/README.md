# OMO 플러그인 폐쇄망 설치 패키지

`package-omo-plugin.ps1`로 빌드된 폐쇄망용 플러그인 패키지입니다.
폐쇄망 머신은 이 레포를 pull(또는 해당 버전 태그 checkout)한 뒤, 아래처럼 압축을 풀어 설치합니다.

## 설치

```powershell
# 태그 기준으로 받기 (-pkg 태그가 이 패키지를 포함한 커밋을 가리킴)
git fetch origin --tags
git checkout v4.15.1-otel.14-pkg

# 무결성 확인
cd deploy\plugin-airgap
Get-FileHash omo-plugin-airgap-20260716-4.15.1-otel.14.tar.gz -Algorithm SHA256
# 출력이 .sha256 파일 내용과 일치해야 함

# 압축 해제 후 설치
tar -xzf omo-plugin-airgap-20260716-4.15.1-otel.14.tar.gz -C C:\setup\
cd C:\setup\omo-plugin-airgap-20260716-4.15.1-otel.14
.\install.ps1

# 중요: opencode 플러그인 캐시 갱신 — 이걸 빼먹으면 구버전이 계속 로드됨
#        (otel.12 → otel.13 업데이트 때 실제로 겪은 문제)
pwsh .\update-cache.ps1
```

설치 후 omo를 **완전히 재시작**하고, 트레이스의 `service.version`이 `4.15.1-otel.14`인지 확인하세요:

```powershell
docker exec clickhouse-by-claude clickhouse-client -q "
SELECT DISTINCT ResourceAttributes['service.version'] AS ver
FROM openlit_db.otel_traces
WHERE Timestamp >= now() - INTERVAL 10 MINUTE
FORMAT PrettyCompact"
```

## 버전별 변경점

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
