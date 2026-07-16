# OMO Observability Grafana Dashboards

Grafana 대시보드 JSON — `omo-observability` 스택(`grafana/dashboards/`)에 파일 기반으로 프로비저닝됩니다.
폐쇄망 배포 환경은 이 레포를 pull해서 해당 경로에 덮어쓰는 방식으로 최신 대시보드를 반영합니다.

## 폐쇄망 적용 방법

```powershell
git pull
$dst = "C:\omo-observability\grafana\dashboards"
$bak = "$dst\_backup_$(Get-Date -Format yyyyMMdd_HHmmss)"
New-Item -ItemType Directory -Force -Path $bak | Out-Null
Copy-Item "$dst\*.json" $bak
Copy-Item "deploy\observability\grafana\dashboards\*.json" $dst -Force
docker restart grafana-by-claude
```

Grafana는 `updateIntervalSeconds: 30` 파일 프로비저닝이라 컨테이너 재시작 없이도 30초 내 자동 반영되지만,
즉시 확인하려면 재시작을 권장합니다.

## 변경 이력 요약

- `span_name` 라벨이 에이전트 이름으로 접두사가 붙는 명명 규칙 변경(`{agent}.gen_ai.completion.*`,
  `{agent}.hook.*`, `{agent}.mcp.*`)에 맞춰, 앵커링된 정규식(`span_name=~"gen_ai\.completion\..*"`)에
  `.*` 접두사를 추가 — Prometheus 라벨 매처는 전체 앵커링(`^...$`)되므로 접두사가 없으면 매치되지 않음.
  `agent.execute.*` 계열은 애초에 접두사가 붙지 않으므로 그대로 유지.
- `omo-cost.json`: 모델별(CodeLLM-Max/Pro/Image) 단가 변수 및 "모델별 예상 비용" 패널 추가.
  CodeLLM 계열은 공개 과금 기준이 없는 자체호스팅 모델이라, 동급 모델의 2026-07 기준 공개 API 단가를 참고값으로 사용:
  - Max ≈ GLM-5.2 (Z.ai): $1.40 / $4.40 (1M input/output)
  - Pro ≈ Qwen3.5-397B: $0.39 / $0.90
  - Image ≈ Gemma4-31B: $0.12 / $0.35

  실제 CodeLLM 계약 단가가 확정되면 대시보드 상단 변수(`price_per_1m_input(_pro|_image)` 등)만 교체.
