# TODO — 자동화 루프 보강 작업

자동화 루프를 더 안정적이고 운영 가능하게 만들기 위한 개선 항목입니다.
우선순위 순으로 정리되어 있으며, 각 항목은 완료 기준(AC)과 영향 파일을 포함합니다.

> ⚠️ **완료 정의 (Definition of Done) — 모든 항목 공통**
> 어떤 항목이든 구현이 끝나면 반드시:
> 1. `DOCUMENTATION.md`(및 필요 시 `README.md`, `LOOP-GUIDE.md`)를 **변경 내용에 맞게 동기화**한다.
> 2. 이 `TODO.md`의 해당 체크박스를 `[x]`로 갱신하고, 변경 요약/PR 링크를 항목 아래 한 줄로 남긴다.
> 3. 문서 동기화가 안 된 변경은 "완료"로 간주하지 않는다.
> (이 규칙은 `CLAUDE.md`에도 명시되어, 개발을 수행하는 Claude가 자동으로 따릅니다.)

---

## 높은 우선순위 — 안정성·정확성

- [x] **1. 멱등성 가드 (중복 PR/브랜치 방지)**
  - 내용: build 중간 실패(예: 상태 전환 실패) 후 재시도 시 동일 이슈에 중복 브랜치/PR이 생기지 않도록 가드.
  - AC: build 시작 시 해당 이슈 키로 열린 PR/원격 브랜치가 있으면 새로 만들지 않고 기존 것을 재사용하거나 스킵.
  - 영향: `run-jira-agent.sh` (build 프롬프트/사전 점검)
  → (완료 2026-06-23) build 단계 claude 실행 전 `git ls-remote feature/<KEY>-*` + `gh pr list --search <KEY>` 점검, 존재 시 `SKIP: 이미 처리됨` 출력 후 종료.

- [x] **2. 실패 처리·재시도 정책**
  - 내용: 실패한 카드가 매 주기 무한 재시도되지 않도록 처리.
  - AC: 실패 시 `claude-failed` 라벨 부여 + 실패 사유를 카드 코멘트로 기록 + N회 초과 시 탐지에서 제외(백오프).
  - 영향: `run-jira-agent.sh`, `detect-cards.sh`(JQL에 `claude-failed` 제외)
  → (완료 2026-06-23) 카드별 실패 카운터(`repos/.state/<KEY>.fail`) + `MAX_RETRIES`(기본 3) 초과 시 claude 로 `claude-failed` 라벨 + 담당자 멘션 실패 코멘트(오류 로그 요약). detect JQL 양쪽에 `claude-failed` 제외 추가. server.js 에 `failedLabel`/`maxRetries` 주입.

- [x] **3. clone 디렉토리 클린업**
  - 내용: 카드별 dir 재사용 시 이전 잔여 변경/브랜치로 checkout이 꼬이는 문제 방지.
  - AC: build 시작 시 `git reset --hard` + `git clean -fd` 후 base 브랜치로 정렬.
  - 영향: `run-jira-agent.sh`
  → (완료 2026-06-23) `fetch --prune` → `reset --hard` + `clean -fd` → base checkout → `reset --hard origin/<base>` 로 결정적 정렬(`git pull` 대체). plan/build 공통 적용.

- [x] **4. env 유출 방지 강화**
  - 내용: `work.env`가 대상 repo로 커밋되는 사고를 구조적으로 차단.
  - AC: env 복사 직후 clone의 `.git/info/exclude`에 env 파일명을 자동 추가(프롬프트 의존 제거).
  - 영향: `run-jira-agent.sh`
  → (완료 2026-06-23) env 복사 직후 `.git/info/exclude` 에 env 파일명·`.env` 를 멱등 등록(grep -qxF 중복 방지). repo `.gitignore` 와 무관한 로컬 전용 차단.

- [x] **5. 탐지 로직 REST 전환**
  - 내용: detect를 `claude` 호출 대신 백엔드 Jira REST로 전환(빠르고 결정적, 비용 절감).
  - AC: 대시보드/루프가 Jira REST로 plan/build 후보를 조회. claude 기반 detect는 폴백으로만.
  - 영향: `dashboard/server.js`(`/api/detect`), 루프가 백엔드/REST 사용
  → (완료 2026-06-23) server.js 에 `/api/detect/:mode`(detect-cards.sh 와 동일 JQL) 추가, scriptEnv 가 `DASHBOARD_URL` 주입. detect-cards.sh 가 `DASHBOARD_URL` 있으면 `curl /api/detect/<mode>` 우선, 실패 시 claude(+MCP) 폴백.

---

## 중간 우선순위 — 운영 편의

- [x] **6. 알림(Notification)**
  - 내용: PR 생성/완료/실패 시 Slack(또는 이메일) 알림.
  - AC: 설정한 웹훅으로 이벤트별 메시지 발송. 미설정 시 무시.
  - 영향: `run-jira-agent.sh` 또는 백엔드, 설정 추가
  → (완료 2026-06-23) Slack Incoming Webhook 지원. `run-jira-agent.sh` 가 `SLACK_WEBHOOK_URL` 있으면 처리 완료(success)/최대재시도 실패 시 Slack 메시지 발송, 미설정 시 스킵. credentials.json 에 `slackWebhookUrl`(마스킹) 저장 + server.js 주입 + 대시보드 자격증명에 입력 필드. 연결 테스트 200 OK 확인. (이메일은 추후)

- [x] **7. 답변 감지 명시적 신호**
  - 내용: "담당자 답변 여부"를 claude 판단에만 의존하지 않도록 명시적 신호 도입.
  - AC: 담당자가 다는 `claude-answered` 라벨 또는 "bot 질문 이후 담당자 코멘트 존재"를 build 진입 조건으로 사용.
  - 영향: `detect-cards.sh`(build JQL), `run-jira-agent.sh`
  → (완료 2026-06-23) 이중 게이트로 구현: 둘 다 있어야 build 진입. ① 탐지 게이트 — build JQL/`/api/detect` 에 `labels = "claude-answered"` 추가, ② 실행 게이트 — build 프롬프트가 `claude-answered` 라벨 + 담당자 실제 답변 코멘트를 모두 확인(하나라도 없으면 SKIP). plan 프롬프트가 담당자에게 라벨 추가를 안내. server.js `answeredLabel` 주입, 대시보드 카드 단계에 `awaiting-answer`(+`failed`) 배지 추가. `ANSWERED_LABEL` 환경변수 추가.

- [x] **8. 루프 영속성·상태 일관성**
  - 내용: 재부팅/크래시 후 자동 재시작, 대시보드 상태와 실제 프로세스 일치.
  - AC: launchd/pm2 등록 가이드 + pid를 디스크(pidfile)에 기록해 백엔드 재시작 후에도 상태 정확.
  - 영향: `dashboard/server.js`, 운영 문서
  → (완료 2026-06-23) 루프 시작 시 `loop-<type>.pid` 에 pid 기록. status/stop 이 pidfile 을 단일 진실로 사용 → 백엔드 재시작 후 복구(시작 로그 보고), stale pidfile 자동 정리, stop 은 프로세스 그룹째 종료. DOCUMENTATION 7.4 에 launchd/pm2 자동 재시작 가이드 추가. `loop-*.pid` gitignore 등록.

- [x] **9. 병렬 처리 상한**
  - 내용: 매칭 카드가 많을 때 claude 프로세스 과다 생성 방지.
  - AC: 동시에 처리하는 카드 수 상한(예: 3) 적용.
  - 영향: `loop-plan.sh`, `loop-build.sh`
  → (완료 2026-06-23) `MAX_PARALLEL`(기본 3) 도입. 두 루프가 카드 실행 전 `jobs -rp` 로 실행 중 작업 수를 확인해 상한 미만이 될 때까지 대기. server.js `maxParallel` 주입 + 대시보드 "동시 처리 상한" 입력 필드.

---

## 낮은 우선순위 — 품질 향상

- [x] **10. PR 품질** (테스트/빌드 검증 — 사용자 요청 범위로 한정 구현)
  - 내용: 테스트/린트 통과 후 PR, 리뷰어·라벨 지정, Jira↔PR 양방향 링크(remote link).
  - AC: 프로젝트별 test/lint 명령 설정 시 PR 전에 실행, 실패하면 PR 보류. PR에 Jira 링크 부착.
  - 영향: `run-jira-agent.sh`, 설정 추가
  → (완료 2026-06-23) build 프롬프트에 PR 전 검증 단계 추가: 테스트 수단(`TEST_CMD` 또는 자동 감지)이 있으면 통과할 때까지 수정 반복(불가 시 PR 없이 종료), 없으면 빌드/컴파일(`BUILD_CMD` 또는 자동 감지)만 시도(수단 없으면 건너뜀). server.js `testCmd`/`buildCmd` 주입 + 대시보드 입력 필드. 리뷰어·라벨·Jira↔PR 양방향 링크는 범위에서 제외(추후).

- [x] **11. 처리 이력(History)**
  - 내용: 처리한 카드/시각/결과/PR URL 기록.
  - AC: JSON 이력 파일 + 대시보드에 이력 표.
  - 영향: `dashboard/server.js`, `dashboard/public/index.html`
  → (완료 2026-06-23) `run-jira-agent.sh` 가 매 실행 결과(성공/스킵/스킵-중복방지/실패 + PR·브랜치)를 `history.jsonl`(JSONL)에 기록. server.js `/api/history`(최신순) + `HISTORY_FILE` 주입, 대시보드에 처리 이력 표(4초 갱신) 추가. `history.jsonl` gitignore 등록.

- [x] **12. 트리거 정밀도**
  - 내용: `text ~ "claude-work"`의 토큰화 오탐 가능성 제거.
  - AC: 텍스트 대신 전용 라벨(예: `claude-work`)을 트리거로 사용하는 옵션 제공.
  - 영향: `detect-cards.sh`, 문서
  → (완료 2026-06-23) `TRIGGER_MODE`(label|text, 기본 **label**) + `TRIGGER_LABEL`(기본 `claude-work`) 도입. detect-cards.sh/server.js JQL·/api/cards 가 모드별 트리거 절 사용, run-jira-agent.sh plan 조건/완료 요약(label 모드는 코멘트)도 모드 대응. 대시보드에 트리거 방식 선택 + 라벨 입력 추가. text 모드는 레거시로 유지.

---

## 확장 기능

- [x] **13. 에픽 연속 개발 (하위 태스크 순차 자동화)**
  - 내용: 에픽 하나를 지정하면 그 하위 태스크를 순서대로 개발 → PR → 리뷰 → (사람이 병합) → 다음 태스크로,
    에픽의 하위를 다 채울 때까지 이어서 진행. 에픽 본문(설계안)을 하위 태스크 작업의 베이스로 사용.
    실행 시 선택한 레포지토리를 기준으로 전 태스크를 진행.
  - AC: 대시보드에서 에픽+repo 를 선택해 시작/중지할 수 있고, 진행 상황(현재 태스크·단계)이 보인다.
    PR 이 모두 병합되면 다음 태스크로 자동 진행하며, 중단 시 알림 + 멈춘 지점부터 재개할 수 있다.
  - 영향: `run-epic-loop.js`(신규), `lib-project-env.js`(신규), `run-jira-agent.sh`(에픽 컨텍스트),
    `dashboard/lib.js`, `dashboard/server.js`, `dashboard/public/index.html`, `dashboard/test/epic-loop.test.js`
  → (완료 2026-09-02) `run-epic-loop.js` 추가 — 하위 태스크를 생성순으로 `prepare→plan→adopt→build(+승인까지 리뷰 루프)→approve→await-merge`
    단계 머신으로 처리. plan 의 `💡 제안:` 답변을 자동 채택해 사람 개입은 PR 병합 하나로 축소. 선택 repo 는 `repo_<name>` 라벨로 부여하고,
    트리거 라벨은 그 태스크 차례에만 붙여 스케줄 루프와의 순서 충돌을 방지. 실패 시 `paused` + Slack/대시보드 알림, [이어서 진행]/[건너뛰기] 로 재개
    (상태 파일 기반이라 재시작 후에도 복구). `/api/epics*` 5개 엔드포인트 + 대시보드 '에픽 연속 개발' 패널 + `loop-epic.log` 추가.
    `run-cycle.js` 의 env 구성 로직은 `lib-project-env.js` 로 분리해 공유.

- [x] **13a. 워크스트림 등 '에픽이 아닌 상위 계층'도 연속 개발 대상으로**
  - 내용: 연속 개발 대상을 이슈 타입 이름(`Epic`)이 아니라 **계층(`hierarchyLevel` 1)** 으로 잡아,
    그 계층을 '워크스트림' 등 다른 이름으로 부르는 프로젝트(PHYS)에서도 하위 태스크를 연속 개발한다.
  - AC: 워크스트림 프로젝트에서 패널 드롭다운에 상위 카드가 뜨고, 하위 태스크 목록·단계가 조회되며,
    화면·알림 문구가 그 프로젝트의 용어를 쓴다. 기존 에픽 프로젝트는 그대로 동작한다.
  - 영향: `dashboard/lib.js`, `dashboard/server.js`, `dashboard/public/index.html`, `run-epic-loop.js`,
    `dashboard/test/epic-loop.test.js`
  → (완료 2026-09-07) Jira JQL 이 `issuetype` 을 **지역화된 표시 이름으로 매칭하지 못하는** 것이 원인
    (`issuetype = "워크스트림"`·`issuetype = "에픽"` 모두 0건). 프로젝트 메타에서 `hierarchyLevel === 1` 타입을 골라
    **타입 id 로** 조회하도록 전환(`lib.topLevelIssueTypes` / `epicSearchJql` / `epicTypeLabel`, 5분 캐시).
    표시 이름은 `/api/epics` 의 `label` · `/api/jira/meta` 의 `epicLabel` 로 내려 패널 제목·드롭다운·툴팁에 쓰고,
    러너에는 `EPIC_LABEL` 로 넘겨 로그·Slack·자동 채택 코멘트 문구에 반영. 러너 로직은 `parent` 기반이라 무변경.
    검증: PHYS 워크스트림 13건 조회, PHYS-123 하위 14건 단계 판정 정상 / EKYB·FSIF 기존 동작 유지.

- [x] **13b. 연속 개발 대상 repo 가 선택과 다르게 넓어지는 문제**
  - 내용: agentsystem 만 골랐는데 [이어서 진행] 시 workbench 까지 실행되던 문제. 원인 3가지를 함께 정리한다.
  - AC: 중단 상태에서 repo 체크박스가 잠기고, 바꾸려면 명시적으로 새 실행을 만들어야 한다.
    이전 실행이 남긴 `repo_*` 라벨이 정리되어 카드 단위 경로도 같은 repo 만 본다. 빈 repo 목록은 전체로 넓어지지 않는다.
  - 영향: `dashboard/lib.js`, `dashboard/server.js`, `dashboard/public/index.html`, `run-epic-loop.js`,
    `dashboard/test/epic-loop.test.js`
  → (완료 2026-09-07) ① UI: `repoLocked` 를 `run.running || (paused && !newRunMode)` 로 바꿔 **중단 상태에서도 잠금**,
    '다른 repo 로 새로 시작' 모드에서만 편집 가능하고 그때는 [이어서 진행]·[건너뛰기] 를 숨겨 새 실행임을 분명히 함.
    ② `prepare` 가 `lib.epicPrepareLabelDiff` 로 **이번 실행에 없는 `repo_*` 라벨을 제거**(추가 전용 → 동기화).
    카드 단위 경로(`run-cycle.js`·개별 실행)가 `lib.cardRepos` 로 라벨을 보기 때문에 이게 실제 유출 경로였음.
    ③ 빈 `EPIC_REPOS` 의 '전체' 폴백 제거 — 러너·`runEpicLoop`·resume 핸들러 3곳에서 거부.

- [x] **14. CI 실패 자동 수정 + 병합 CI 게이트**
  - 내용: 자동 병합이 CI 를 전혀 보지 않아 빨간 PR 이 그대로 병합되던 문제(실측: PHYS-126 #45, PHYS-127 #46)와,
    PR 조회 실패가 조용히 "PR 없음"으로 둔갑해 자동 병합이 사유 없이 죽던 문제(로그에 `HTTP 200` 만 남음)를 함께 정리한다.
  - AC: CI 가 깨지면 러너가 원인을 파악해 스스로 고치고 초록이 된 뒤에만 다음 단계로 간다.
    CI 수정으로 코드가 바뀌면 기존 리뷰 승인은 무효가 되고 재리뷰를 받는다.
    CI 가 빨갛거나 진행 중이면 자동 병합이 시간·승인과 무관하게 막힌다. 조회 실패는 사유가 로그에 남는다.
  - 영향: `run-jira-agent.sh`, `run-epic-loop.js`, `dashboard/lib.js`, `dashboard/server.js`,
    `dashboard/public/index.html`, `dashboard/test/epic-loop.test.js`
  → (완료 2026-09-08) ① `lib.ciStateOf`/`failedChecks` 로 CI 판정을 한 곳에 모으고, 에픽 단계에
    `ci` 를 신설(build → **ci** → approve → await-merge). `claude-pr` 재개 지점도 `ci` 로 변경.
    ② `run-jira-agent.sh` 에 `CI_FIX` 모드 추가 — 실패 잡 로그를 반드시 읽고 (a) 인프라·플레이크는
    `gh run rerun --failed`(`CI_RERUN_ONLY`) (b) 코드 문제는 수정·로컬검증·푸시(`CI_FIX_PUSHED`) 로 분기.
    테스트 삭제·skip·무시 주석·`continue-on-error` 로 통과시키는 것은 프롬프트에서 금지.
    ③ CI 수정 커밋이 생기면 승인 마커를 `CLAUDE-REVIEW-SUPERSEDED-BY-CI-FIX` 로 치환해 무효화하고
    `run-review-loop.sh` 재실행 → 다음 회차에서 CI 재판정. 상한 `EPIC_CI_LOOP_MAX`(기본 5).
    ④ `shouldAutoMerge` 에 CI 게이트(`ci-failed`/`ci-pending`/`ci-unknown`) 추가.
    `/api/cards/:key/merge` 도 동일 게이트(사람이 확인창에서 넘길 때만 `force`).
    ⑤ `listCardPRs` 가 `list.ok` 를 검사하고, 병합 대상이 없으면 `message` 를 실어 응답.
    러너의 승인·CI 조회는 `ghJsonStrict` 로 실패를 던짐. `await-merge` 는 조회 실패 회차를 판정하지 않음(`pr-lookup-failed`).
    검증: `npm test` 107건 통과(CI 판정·게이트·단계 순서 신규 12건 포함).

- [x] **15. Slack 알림 버튼으로 원격 조작 (병합·재개·재실행)**
  - 내용: 알림을 받기만 하던 Slack 을 양방향으로 — 메시지의 버튼으로 PR 병합, 에픽 이어서 진행/건너뛰기/중지,
    카드 재실행, 리뷰 승인 루프 재시작을 Slack 에서 바로 수행한다.
  - AC: 리뷰 승인·에픽 중단·병합 대기·처리 실패 알림에 버튼이 붙고, 허용된 사용자가 누르면
    대시보드에서 누른 것과 동일하게 실행된다(CI 게이트 유지). 대시보드 포트를 외부에 열지 않는다.
  - 영향: `dashboard/lib.js`, `dashboard/slack-socket.js`(신규), `slack-notify.js`(신규),
    `dashboard/server.js`, `dashboard/public/index.html`, `run-review-loop.sh`, `run-review.sh`,
    `run-jira-agent.sh`, `run-epic-loop.js`, `dashboard/test/slack-actions.test.js`(신규)
  → (완료 2026-09-08) Slack **Socket Mode**(아웃바운드 WebSocket)로 버튼 클릭을 수신 — 공개 URL·터널링·포트 개방이 필요 없다.
    메시지 갱신은 payload 의 `response_url` 로 하므로 봇 토큰도 불필요. 버튼은 기존 대시보드 라우트를 그대로 호출해
    CI 게이트·카드 완료처리 로직을 공유한다. 안전장치: `slackAllowUsers` 화이트리스트(**미설정 시 전원 거부**),
    동작 id·이슈 키 형식 화이트리스트 검증, 클릭 즉시 원본 메시지를 결과로 교체해 중복 클릭 차단.
    자격증명에 `slackAppToken`(마스킹) · `slackAllowUsers` 추가. 검증: `npm test` 120건 통과(신규 13건).


---

*완료된 항목은 위 "완료 정의"에 따라 체크 표시 + 문서 동기화 후 마감합니다.*
