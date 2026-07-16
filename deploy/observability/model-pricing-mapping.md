# CodeLLM 모델별 동급 모델 매핑 및 단가 기준 (2026-07)

CodeLLM-Max/Pro/Image는 자체호스팅 모델로 공개 과금 기준이 없어, 각 모델이 동급으로 언급된
공개 모델의 2026-07 기준 공식/표준 API 단가를 비용 산정 참고값으로 사용하였다.

## 모델 매핑 및 단가

| CodeLLM 모델 | 동급 모델 | 입력 단가 (USD/1M) | 출력 단가 (USD/1M) | 단가 출처 | 비고 |
|---|---|---:|---:|---|---|
| CodeLLM-Max | GLM-5.2 (Z.ai) | $1.40 | $4.40 | Z.ai 공식 (docs.z.ai) | GA 2026-06-16, 캐시 입력 $0.26/1M |
| CodeLLM-Pro | Qwen3.5-397B | $0.39 | $0.90 | Qwen 공식 | 프로바이더별 상이(DeepInfra $0.54/$3.40 등) |
| CodeLLM-Image | Gemma4-31B | $0.12 | $0.35 | 표준가(OpenRouter 등 대다수 프로바이더 동일) | Google AI Studio는 무료 티어 제공 |

## CodeLLM 모델 기술 사양 (동급 모델 선정 근거)

| 항목 | CodeLLM-Max | CodeLLM-Pro | CodeLLM-Image |
|---|---|---|---|
| 모델 타입 | Text/Code/Chat/Agent | Text/Code/Chat/Agent | Text/Image/Code/Chat/Agent |
| 아키텍처 | MoE | MoE | MoE (활성 파라미터 ~4B) |
| Context Window | 202K Tokens | 262K Tokens | 128K Tokens |
| Max Output | 32K Tokens | 32K Tokens | 32K Tokens |
| 출시일 | 2026-06 | 2026-06 | 2026-03 |
| 주요 벤치마크 | Terminal-Bench 2.1 81.0 · SWE-bench Pro 62.1 · NL2Repo 48.9 | Terminal-Bench 2.1 64.2 · SWE-bench Verified 75.6 · SWE-bench Pro 50.4 · NL2Repo 34.6 | (멀티모달 특화, 코딩 벤치마크 미기재) |

## 대시보드 반영 위치

Grafana `OMO Cost & Token Dashboard` (`omo-cost.json`) 상단 템플릿 변수:

- `price_per_1m_input` / `price_per_1m_output` — CodeLLM-Max 단가
- `price_per_1m_input_pro` / `price_per_1m_output_pro` — CodeLLM-Pro 단가
- `price_per_1m_input_image` / `price_per_1m_output_image` — CodeLLM-Image 단가

"🧪 모델별 비용 (동급 모델 공개 단가 기준)" 패널에서 모델별·합계 비용이 실시간으로 계산되어 표출된다.
실제 CodeLLM 계약 단가가 확정되면 위 변수 값만 교체하면 전체 패널에 일괄 반영된다.

## 유의사항

- 위 단가는 **실제 CodeLLM 계약 단가가 아니라, 동급 모델의 공개 단가를 참고값으로 대입한 추정치**이다.
- CodeLLM은 자체호스팅이므로 실제 운영 비용은 토큰당 과금이 아니라 GPU 인프라 상각비 기준이며, 위 추정치는
  "상용 API로 동등 성능을 구매했다면"이라는 비교 시나리오에 한해 의미를 가진다.
- 동급 모델 매핑(Max≈GLM-5.2, Pro≈Qwen3.5-397B, Image≈Gemma4-31B)은 사용자 확인을 거쳐 확정되었다
  (최초 Max≈Claude Opus 4.7로 제시되었다가 GLM-5.2로 정정됨).
