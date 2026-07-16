# OMO 플러그인 폐쇄망 설치 패키지

`package-omo-plugin.ps1`로 빌드된 폐쇄망용 플러그인 패키지입니다.
폐쇄망 머신은 이 레포를 pull(또는 해당 버전 태그 checkout)한 뒤, 아래처럼 압축을 풀어 설치합니다.

## 설치

```powershell
# 태그 기준으로 받기 (-pkg 태그가 이 패키지를 포함한 커밋을 가리킴;
# v4.15.1-otel.13 태그는 소스 스냅샷용으로 패키지 파일이 없음)
git fetch origin --tags
git checkout v4.15.1-otel.13-pkg

# 무결성 확인
cd deploy\plugin-airgap
Get-FileHash omo-plugin-airgap-20260716-4.15.1-otel.13.tar.gz -Algorithm SHA256
# 출력이 .sha256 파일 내용과 일치해야 함

# 압축 해제 후 설치 (기존 방식과 동일)
tar -xzf omo-plugin-airgap-20260716-4.15.1-otel.13.tar.gz -C C:\setup\
cd C:\setup\omo-plugin-airgap-20260716-4.15.1-otel.13
.\install.ps1
```

설치 후 omo를 재시작하고, 트레이스의 `service.version`이 `4.15.1-otel.13`인지 확인하세요.

## 이 버전(otel.13)의 변경점

- 도구 실행 실패 시 스팬에 `STATUS_CODE_ERROR` + exception 이벤트가 기록됨
  (이전 버전은 실패해도 모든 스팬이 `STATUS_CODE_UNSET` — Jaeger에서 원인 스팬 특정 불가였음)
- 검증: 의도적으로 도구 실패를 유발한 뒤 ClickHouse에서
  `SELECT ... WHERE StatusCode = 'STATUS_CODE_ERROR'` 조회 시 결과가 나오고,
  Jaeger에서 해당 스팬이 빨간색으로 표시되어야 정상.
