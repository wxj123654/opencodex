---
title: Pi
description: Pi에서 라우팅된 모델을 그대로 쓸 수 있습니다. `ocx export`가 Pi의 `models.json`에 맞는 커스텀 provider 블록을 내보내고, 실행 중인 프록시에 연결합니다.
---

Pi는 provider를 환경 변수 대신 하나의 전역 JSON 파일에서 읽기 때문에,
opencodex가 Pi를 직접 실행하지 않습니다. 대신 `ocx export`가 `opencodex` provider 블록,
즉 base URL, 모델 목록, 그리고 Pi가 치환하는 환경 변수 참조를 직렬화해서 사용자가
자신의 설정에 병합하도록 합니다.

## 빠른 시작

프록시를 먼저 띄우고 config를 출력합니다.

```bash
ocx start
ocx export --client pi
```

출력은 JSON으로 시작하고, 이어서 대상 경로, 병합 경고, 환경 변수 export 줄, 그리고
공식 context limit이 있는 모델 수를 보여줍니다.

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "$OPENCODEX_API_KEY",
      "compat": { "supportsDeveloperRole": false },
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

모델 id는 프록시의 정규 선택자이므로, 라우팅된 모델은 `provider/model`
(`anthropic/claude-opus-5`) 형태로 나타나고, 네이티브 OpenAI slug는 접두사 없이
(`gpt-5.6-sol`) 유지됩니다. `name` 접미사인 `(anthropic)`, `(native)`, `(routed)`는
Pi 선택기에서 같은 이름의 서로 다른 upstream 모델을 구분하게 해줍니다.

## 저장 위치

Pi의 전역 모델 config는 다음과 같습니다.

```text
~/.pi/agent/models.json
```

:::caution[병합하고, 대체하지 마세요]
`ocx export`는 그 파일을 절대 쓰지 않습니다. `providers.opencodex` 블록을 그 안에
병합하세요. 파일을 통째로 바꾸면 이미 설정해 둔 다른 provider가 모두 사라집니다.
`--out`은 임시 경로용이며, `--force` 없이 이미 존재하는 파일을 덮어쓰지 못합니다.

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # or redirect the byte-exact JSON
```
:::

내보낸 블록은 실시간 뷰가 아니라 고정 스냅샷입니다. provider를 추가하거나 모델
가시성을 바꾼 뒤에는 `ocx export`를 다시 실행하고, 새 블록을 옛 블록 위에 병합하세요.

## 또는 opencodex에게 블록 관리를 맡기기

수동 병합이 유일한 방법은 아닙니다. opencodex는 이 파일의 `providers.opencodex` 블록을
소유할 수 있습니다. 블록을 대신 기록해 주며 — 추론 레벨도 `reasoning: true`와 각 모델의 실제
사다리에 Pi의 레벨 선택을 제한하는 `thinkingLevelMap`으로 포함됩니다 — 파일의 다른
provider는 건드리지 않습니다.

```bash
ocx integration client enable --client pi                          # 블록을 가져와 기록
ocx integration client enable --client pi --overwrite-conflict     # 밀린 블록을 강제 교체
ocx integration client status --client pi                          # current / stale / not installed
ocx integration client history --client pi                         # op id가 달린 기록 목록
ocx integration client restore --op <opId>                         # 기록 하나 되돌리기
ocx integration client disable --client pi                         # 소유 해제 (블록은 유지)
```

기존 블록이 손으로 편집되어 opencodex가 쓰려는 내용과 어긋난 경우 `enable`은 거절합니다.
`--overwrite-conflict`가 그것을 현재 카탈로그 내용으로 교체하는 탈출구입니다. 참고로 관리
받는 Pi 블록은 `ocx sync`로 자동 새로 고쳐지지 않습니다(오늘날 자동 갱신은 MiniMax Code
뿐입니다). 모델·사다리·가시성을 바꾼 뒤에는 `enable --overwrite-conflict`를 다시 실행하거나
대시보드 Integrations 페이지의 Refresh / Replace를 사용해 블록을 최신화하세요. `status`가
`stale`을 보고하면 그 신호입니다. 전체 의미론, 스냅샷, 롤백 규칙은
[통합 가이드](/guides/integrations/)를 참고하세요.

## 인증 키

여기서는 서로 헷갈리기 쉬운 키가 두 개 있고, 이 파일에 등장하는 것은 첫 번째뿐입니다.

| 키 | 무엇인지 | 어디에 있는지 |
| --- | --- | --- |
| Proxy admission key | opencodex의 자체 인증 정보이며, 대시보드의 **API** 탭에서 생성됩니다 | `apiKey`로 `$OPENCODEX_API_KEY`를 참조하며, 값은 환경 변수에 둡니다 |
| Provider key | Anthropic / OpenAI / OpenRouter 키입니다 | opencodex의 자체 config에 있으며, [Providers](/guides/providers/)마다 따로 둡니다 |

내보낸 config에는 비밀값이 아니라 참조만 들어갑니다. Pi는 `$NAME` 형태를 그대로
치환하므로 변수는 다음과 같습니다.

```bash
export OPENCODEX_API_KEY=<your key>
```

이 이름은 Pi 전용입니다. opencode는 다른 변수를 씁니다
(`OPENCODEX_OPENCODE_API_KEY`, `{env:…}` 형식) - 자세한 내용은 [opencode 가이드](/guides/opencode/)를 보세요.

**루프백 프록시는 키가 전혀 필요 없습니다.** opencodex는 기본적으로 `127.0.0.1`에
바인드하고 그곳에서는 아무 것도 인증하지 않으므로, `$OPENCODEX_API_KEY` 참조는
실제로는 비어 있어도 됩니다. 이 값은 `hostname`이 루프백 바깥으로 설정될 때만
의미가 있으며, 그 경우에는 프록시가 토큰 없이 시작하지 않습니다. 자세한 내용은
[Remote access](/reference/configuration/#remote-access)를 보세요.

## 모델 메타데이터

`contextWindow`와 `maxTokens`는 카탈로그가 확정된 context window를 보고할 때만
출력됩니다. 그렇지 않으면 두 필드 모두 해당 모델에서 생략되고, Pi는 자체 기본값을
적용합니다. `ocx export`는 그 경우가 몇 줄이었는지도 함께 출력합니다.

`maxTokens`는 스키마를 만족시키기 위한 `32000` 예산이며, context window보다 더 크게
잡히지 않도록 아래로 잘립니다. 즉, 작은 context 모델에 그보다 많은 출력을 주겠다는
의미가 아닙니다.

모든 행에는 명시적인 0 `cost`가 들어갑니다. opencodex에는 라우팅된 모델의 가격 데이터가
없지만, 필드를 아예 빼는 것이 0을 넣는 것보다 나쁜 결과를 낳습니다. pi는 models.json에서
직접 읽어 들인 모델에만 기본 `cost`를 채워 넣고, provider를 다시 등록하는 확장(파일 안의
모든 provider를 다시 등록하는 pi-setup-custom-providers 등)은 기본값 없이 행을 pi의
확장 경로에 통과시킵니다. 그 상태에서 첫 번째 스트림이 성공하면 사용량 비용 계산에서
`Cannot read properties of undefined (reading 'tiers')`로 깨집니다. 로컬 프록시에게 0은
실제로도 올바른 값입니다. 과금을 계산하는 쪽은 pi가 아니라 프록시이기 때문입니다. 내보낸
블록을 수동으로 병합한다면 `cost` 필드를 삭제하지 말고 그대로 두십시오.

`reasoning`도 역사가 있는 필드입니다. 예전에는 빠져 있었습니다. Pi는 boolean을 저장하지만
카탈로그는 effort 단계 체계를 들고 있으므로, 둘을 1:1로 맞추는 것은 추측이었기 때문입니다.

## 스키마 상태

:::note[실제 설치에서 검증함]
이 형태는 pi 0.84.3의 실제 `~/.pi/agent/models.json`(2026-08)으로 검증되었습니다. 검증
과정에서 위의 0 `cost`가 생긴 경위도 확인되었습니다. pi-setup-custom-providers가 파일 안의
모든 provider를 다시 등록하고, pi는 그 경로에서 기본 cost를 채워 넣지 않기 때문에 `cost`
없는 행은 첫 번째 성공한 스트림에서 pi의 사용량 계산을 깨뜨렸습니다. `reasoning`,
`thinkingLevelMap`, 레벨을 숨기는 `null` 항목 모두 그 설치에서 문서대로 동작했습니다. 더
새로운 pi나 확장이 이를 바꾼다면, pi가 보고한 내용과 함께
[issue를 열어주세요](https://github.com/lidge-jun/opencodex/issues).
:::

## 요구 사항

실행 중인 opencodex 프록시(`ocx start`)와 설치된 Pi가 필요합니다. `ocx export`는
프록시의 management API를 통해 live catalog를 읽으므로, 빈 모델 목록으로는 config를
내보낼 수 없습니다.
