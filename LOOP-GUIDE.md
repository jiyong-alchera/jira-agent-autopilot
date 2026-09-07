# Jira → Claude 루프 자동화 가이드

`claude-work` 라벨(기본 label 모드)이 붙고 본인에게 할당된 Jira 카드를 **한 시간마다** 자동 탐지해,
plan(질문) → build(개발·PR·완료처리) 두 루프로 처리합니다. 대상 repo·Jira 프로젝트는
설정(환경변수 또는 대시보드)으로 지정하며, 특정 repo에 묶이지 않는 범용 도구입니다.

## 구성 파일

| 파일 | 역할 |
|------|------|
| `run-jira-agent.sh` | 카드 1개를 plan 또는 build 로 처리 (카드별 `repos/<repo이름>-<키>` 디렉토리, 병렬 가능) |
| `detect-cards.sh` | JQL 로 plan/build 대상 카드 키 목록을 탐지 (claude + Atlassian MCP) |
| `loop-plan.sh` | 1시간마다 plan 대상 탐지 → 카드별 병렬 plan 실행 |
| `loop-build.sh` | 1시간마다 build 대상 탐지 → 카드별 병렬 build 실행 |
| `run-epic-loop.js` | 상위 카드(에픽·워크스트림) 하나의 미완료 하위 태스크를 **생성순으로 하나씩** 끝까지 처리 (대시보드 '연속 개발' 패널) |

## 상태 머신 (카드가 흐르는 단계)

```
[신규 카드: claude-work 라벨 + 담당자=나 + 상태≠DEV COMPLETED, claude-planned 라벨 없음]
        │  loop-plan  →  질문 코멘트 작성(+답변 후 claude-answered 라벨 요청) + 'claude-planned' 라벨 추가
        ▼
[claude-planned + claude-answered 라벨 있음]
        │  loop-build →  (라벨/답변 없으면 SKIP, 다음 주기 재시도)
        │             →  답변 있으면 개발 → 브랜치/커밋/푸시 → base 브랜치로 PR
        │             →  완료 요약 기입(label 모드: 카드 설명 하단) → 상태를 DEV COMPLETED 로 전환
        ▼
[DEV COMPLETED] → 두 루프 모두 탐지에서 자동 제외
```

- **plan 중복 방지**: `claude-planned` 라벨이 붙으면 plan 루프가 다시 잡지 않음.
- **build 답변 대기**: 답변 전이면 build 가 `SKIP` 하고 종료 → 다음 주기 재시도.
- **완료 제외**: `DEV COMPLETED` 상태는 JQL `status != "DEV COMPLETED"` 로 두 루프에서 제외.

## 에픽·워크스트림 단위로 한 번에 (연속 개발)

카드를 하나씩 챙기는 대신, **상위 카드의 하위 태스크 전체**를 순서대로 맡길 수 있습니다.
대시보드 **'에픽 연속 개발'** 패널에서 프로젝트·상위 카드·대상 repo 를 고르고 시작하면:

```
하위 태스크(생성순) 한 건씩
  라벨 부여 → plan(질문) → plan 의 '💡 제안' 답변 자동 채택 → 개발·PR → 승인까지 리뷰 루프
  → CI 가 초록이 될 때까지 자동 수정 → 리뷰 승인 확인
  → (사람) 그 카드의 PR 을 모두 병합  →  자동으로 다음 태스크
미완료 하위가 없으면 완료
```

- 상위 카드 본문(설계안)이 모든 하위 태스크의 plan/build 프롬프트에 주입됩니다.
- **대상 repo 는 시작할 때 고정됩니다.** 실행 중이든 중단 상태든 체크박스는 잠기고, [이어서 진행]은 시작 시 고른 repo 로 재개합니다.
  다른 repo 로 돌리려면 **'다른 repo 로 새로 시작'** 으로 잠금을 풀고 [연속 개발 시작]을 누르세요 — 이전 실행의 재개 지점은 버려집니다.
- 상위 카드는 **에픽 계층이면 무엇이든** 됩니다. 그 계층을 부르는 이름은 프로젝트마다 다른데(EKYB·FSIF 는 '에픽',
  PHYS 는 '워크스트림'), 대시보드가 프로젝트에서 실제 쓰는 이름을 읽어 패널 제목·드롭다운·알림 문구에 그대로 씁니다.
- 사람의 필수 개입은 **PR 병합 하나**입니다. **'리뷰 승인 후 자동 병합'** 을 켜면 그것도 자동이 됩니다 —
  리뷰 승인이 끝난 PR 을 지정한 시간(기본 60분) 동안 아무도 병합하지 않으면 대신 병합합니다.
  미승인 PR 이 하나라도 있으면 시간이 지나도 병합하지 않고, 실행 중에 켜고 꺼도 바로 반영됩니다.
- **CI 가 깨지면 스스로 고칩니다.** PR 을 올린 뒤 CI 를 확인해, 실패하면 실패한 잡의 로그를 읽고
  원인을 판단합니다 — 패키지 미러 다운 같은 **일시적 실패면 그 잡만 재실행**하고, **코드 문제면 고쳐서 푸시**합니다.
  테스트를 지우거나 검사를 꺼서 통과시키는 것은 금지돼 있습니다. 고친 코드는 아무도 안 본 코드이므로
  **기존 리뷰 승인을 무효화하고 재리뷰**를 받습니다. 기본 5회까지 반복하고, 그래도 빨간색이면 멈추고 알립니다.
- **CI 가 빨간 PR 은 자동 병합되지 않습니다.** 승인과 대기 시간을 채웠더라도 막습니다.
  대시보드에서 사람이 직접 병합할 때는 확인창에 CI 상태를 알려주고, 그래도 진행을 고르면 넘어갑니다.
- **'중단 시 자동 재시도'** 를 켜면, 토큰(사용량 한도) 소진처럼 시간이 지나면 풀리는 이유로 멈췄을 때
  대시보드가 대신 재개합니다. 사용량 한도는 엔진이 알려주는 해제 시각(예: `resets 1:40pm`)을 읽어 그 직후에 재시도하고,
  시각을 모르면 10분 → 30분 → 1시간 → 2시간 → 4시간으로 늘려갑니다.
  사람이 봐야 하는 중단(제안 답변 없음·리뷰 미승인·자동 병합 실패·CI 수정 반복 소진)은 재시도하지 않습니다.
- 어느 단계든 실패하면 멈추고 알림을 보냅니다. 조치 후 **[이어서 진행]**(그 단계부터) 또는
  **[이 단계 건너뛰기]**(다음 단계부터) 로 재개합니다. 대시보드·PC 를 재시작해도 멈춘 지점이 보존됩니다.
- 아직 차례가 아닌 하위 카드에는 트리거 라벨을 붙이지 않으므로 plan/build 루프가 순서를 앞지르지 않습니다.
  다만 **이미 `claude-work` 가 붙어 있던 카드**는 루프도 볼 수 있으니, 연속 개발 실행 중에는 두 루프를 멈춰두길 권합니다.

## 실행

두 루프를 각각 백그라운드로 띄웁니다(서로 독립 프로세스).
대시보드로 띄우는 게 편하지만, 수동으로 띄울 땐 대상 repo 등을 환경변수로 지정합니다:

```bash
cd <작업폴더>   # 스크립트가 있는 폴더
chmod +x run-jira-agent.sh detect-cards.sh loop-plan.sh loop-build.sh

export REPO_URL="https://github.com/Org/repo.git"
export BASE_BRANCH="main"
export PROJECT_KEY="PROJ"
# (선택) 엔진/모델 — 비우면 claude, 엔진 기본 모델 사용
export ENGINE="claude"   # claude | codex | gemini
export MODEL=""          # 예: opus / gpt-5-codex / gemini-2.5-pro
# (필요시) ASSIGNEE_EMAIL, ASSIGNEE_NAME, ENV_SRC, CLONE_BASE 등도 export

nohup ./loop-plan.sh  > /dev/null 2>&1 &
nohup ./loop-build.sh > /dev/null 2>&1 &
```

진행 상황 확인:

```bash
tail -f loop-plan.log      # plan 루프 로그
tail -f loop-build.log     # build 루프 로그
jobs -l                    # 실행 중인 루프 확인
```

주기 변경(예: 30분):

```bash
LOOP_INTERVAL=1800 nohup ./loop-plan.sh > /dev/null 2>&1 &
```

종료:

```bash
pkill -f loop-plan.sh
pkill -f loop-build.sh
```

## 병렬 동작

- 한 주기에 여러 카드가 탐지되면, 카드마다 `repos/<repo이름>-<카드키>` 디렉토리에서 **동시에** 실행됩니다.
  (예: `repos/myrepo-PROJ-765`, `repos/myrepo-PROJ-770` …)
- 각 카드가 독립 디렉토리라 git 작업이 서로 충돌하지 않습니다.

## 사전 준비 (필수)

- `claude` (Claude Code CLI) 설치 + 로그인
- `claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp` + `/mcp` 인증
- `gh auth login` (PR 생성용)

## 주의사항

- **DEV COMPLETED**: Jira 워크플로우에 이 상태로 가는 transition 이 실제로 있어야 전환됩니다.
  없으면 build 단계에서 사유를 출력하니 로그를 확인하세요.
- **탐지 비용**: 매 주기 detect-cards 가 `claude` 를 1회 호출합니다(plan/build 각각). 1시간 주기라 부담은 작습니다.
- **env 파일(`work.env`)**: 대상 repo로 복사되는 시크릿 파일입니다. 절대 커밋되지 않도록 `.gitignore` 가 `*.env` 를 제외합니다.
- **트리거 방식**: 기본은 `claude-work` **라벨**(`TRIGGER_MODE=label`)입니다. 텍스트 검색(`text ~`)은 토큰화 오탐이 있어 레거시(`TRIGGER_MODE=text`)로만 남겨두었습니다. 어느 모드든 각 카드 처리 시 claude 가 트리거 충족 여부를 다시 확인합니다.
