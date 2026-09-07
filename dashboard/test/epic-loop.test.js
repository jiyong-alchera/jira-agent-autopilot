// 에픽 연속 개발(run-epic-loop.js)의 순수 로직 회귀 테스트.
// - 하위 태스크 JQL(미완료 + 생성순, parent/Epic Link 두 형태)
// - 카드 라벨·상태로 '어느 단계부터 하면 되는지' 판정(중단 후 재개·중복 실행 방지의 핵심)
// - 다음 태스크 선정(생성순으로 처리할 게 남은 첫 카드)
// - plan 제안 답변 → 자동 채택 코멘트 본문
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../lib");

const CFG = {
  doneStatus: "DEV COMPLETED",
  triggerLabel: "claude-work",
  plannedLabel: "claude-planned",
  answeredLabel: "claude-answered",
  prOpenLabel: "claude-pr",
};

test("epicChildrenJql: 미완료 하위를 생성순으로 조회", () => {
  const jql = lib.epicChildrenJql("EKYB-800", CFG);
  assert.match(jql, /^parent = "EKYB-800"/);
  assert.match(jql, /statusCategory != Done/);
  assert.match(jql, /status NOT IN \("DEV COMPLETED"\)/);
  assert.match(jql, /ORDER BY created ASC$/);
});

test("epicChildrenJql: 구형 프로젝트는 'Epic Link' 절로 폴백", () => {
  assert.match(lib.epicChildrenJql("EKYB-800", CFG, "epic-link"), /^"Epic Link" = "EKYB-800"/);
});

test("epicTaskStep: 라벨 상태에 따라 시작 단계를 정한다", () => {
  const step = (labels, extra) => lib.epicTaskStep({ key: "K-1", labels, ...(extra || {}) }, CFG);
  assert.equal(step([]), "prepare");                                              // 트리거 라벨 없음
  assert.equal(step(["claude-work"]), "plan");                                    // plan 아직
  assert.equal(step(["claude-work", "claude-planned"]), "adopt");                 // 질문은 있고 답변 전
  assert.equal(step(["claude-work", "claude-planned", "claude-answered"]), "build");
  assert.equal(step(["claude-work", "claude-planned", "claude-answered", "claude-pr"]), "ci");   // PR 올림 → CI 확인부터
  assert.equal(step(["claude-work"], { done: true }), null);                      // 완료 카드는 건너뜀
});

test("epicTaskStep: repo_ 등 다른 라벨은 판정에 영향이 없다", () => {
  assert.equal(lib.epicTaskStep({ key: "K-1", labels: ["repo_kyb-api", "claude-work"] }, CFG), "plan");
});

test("nextEpicTask: 생성순으로 처리할 게 남은 첫 카드", () => {
  const tasks = [
    { key: "K-1", labels: ["claude-work"], done: true },
    { key: "K-2", labels: ["claude-work", "claude-planned"] },
    { key: "K-3", labels: [] },
  ];
  const next = lib.nextEpicTask(tasks, CFG);
  assert.equal(next.key, "K-2");
  assert.equal(next.step, "adopt");
});

test("nextEpicTask: 남은 태스크가 없으면 null (=에픽 완료)", () => {
  assert.equal(lib.nextEpicTask([{ key: "K-1", labels: [], done: true }], CFG), null);
  assert.equal(lib.nextEpicTask([], CFG), null);
});

test("nextEpicStep: 단계 순서대로 진행하고 마지막은 null", () => {
  assert.equal(lib.nextEpicStep("prepare"), "plan");
  assert.equal(lib.nextEpicStep("adopt"), "build");
  assert.equal(lib.nextEpicStep("build"), "ci");
  assert.equal(lib.nextEpicStep("ci"), "approve");
  assert.equal(lib.nextEpicStep("approve"), "await-merge");
  assert.equal(lib.nextEpicStep("await-merge"), null);
  assert.equal(lib.nextEpicStep("없는단계"), null);
});

test("buildAdoptedAnswerBody: 제안 답변을 질문과 함께 채택 코멘트로 만든다", () => {
  const suggested = lib.parseSuggestedAnswers([
    { id: "10", body: "1. 토글은 테넌트별로 두나요?\n   💡 제안: 테넌트별 설정으로 둡니다. (근거: tenant_config 테이블 존재)\n2. 기본값은?\n   💡 제안: 비활성" },
  ]);
  assert.equal(suggested.count, 2);
  const body = lib.buildAdoptedAnswerBody(suggested, "EKYB-800");
  assert.match(body, /EKYB-800/);
  assert.match(body, /1\. 토글은 테넌트별로 두나요\?\n→ 테넌트별 설정으로 둡니다\./);
  assert.match(body, /2\. 기본값은\?\n→ 비활성/);
  assert.doesNotMatch(body, /근거/);   // 근거는 답변 본문에서 제외(초안 규칙과 동일)
});

test("buildAdoptedAnswerBody: 제안이 없으면 빈 문자열", () => {
  assert.equal(lib.buildAdoptedAnswerBody(null, "E-1"), "");
  assert.equal(lib.buildAdoptedAnswerBody({ items: [] }, "E-1"), "");
});

test("prBelongsToCard: 브랜치·제목의 키로 이 카드 PR 을 가린다", () => {
  // gh pr list --search <KEY> 는 PR '본문'까지 전문 검색하므로, 본문이 다른 카드 키를 언급하면
  // 그 카드의 PR 로도 잡힌다. 자동화 규칙(브랜치 feat/<KEY>-…, 제목 …(<KEY>))으로 걸러낸다.
  const pr819 = { branch: "feat/EKYB-819-partner-api", title: "feat(partner): 인증 체계 도입 (EKYB-819)" };
  assert.equal(lib.prBelongsToCard(pr819, "EKYB-819"), true);
  assert.equal(lib.prBelongsToCard(pr819, "EKYB-820"), false);   // 본문에만 언급된 형제 카드
  assert.equal(lib.prBelongsToCard({ branch: "feat/ekyb-820-x", title: "" }, "EKYB-820"), true);  // 대소문자 무관
  assert.equal(lib.prBelongsToCard({ branch: "", title: "무관한 PR" }, "EKYB-820"), false);
  assert.equal(lib.prBelongsToCard(null, "EKYB-820"), false);
  assert.equal(lib.prBelongsToCard({ branch: "feat/EKYB-820-x" }, ""), false);
});

// ===== 자동 병합(리뷰 승인 후 N분) =====
test("clampAutoMergeMin: 기본 60분, 1~1440 범위", () => {
  assert.equal(lib.clampAutoMergeMin(undefined), 60);
  assert.equal(lib.clampAutoMergeMin(0), 60);
  assert.equal(lib.clampAutoMergeMin(-5), 60);
  assert.equal(lib.clampAutoMergeMin("30"), 30);
  assert.equal(lib.clampAutoMergeMin(99999), 1440);
});

test("shouldAutoMerge: 꺼져 있으면 시간이 지나도 병합하지 않는다", () => {
  const start = "2026-09-02T00:00:00Z";
  const at = (m) => Date.parse(start) + m * 60000;
  const r = lib.shouldAutoMerge({ autoMerge: false, autoMergeAfterMin: 60 }, start, [{ approved: true }], at(999));
  assert.equal(r.merge, false);
  assert.equal(r.reason, "off");
});

test("shouldAutoMerge: 미승인 PR 이 하나라도 있으면 병합하지 않는다 (승인 게이트 우회 금지)", () => {
  const start = "2026-09-02T00:00:00Z";
  const at = (m) => Date.parse(start) + m * 60000;
  const prs = [{ approved: true }, { approved: false }];
  const r = lib.shouldAutoMerge({ autoMerge: true, autoMergeAfterMin: 60 }, start, prs, at(600));
  assert.equal(r.merge, false);
  assert.equal(r.reason, "not-approved");
});

test("shouldAutoMerge: 대기 시간을 넘기고 전부 승인이면 병합", () => {
  const start = "2026-09-02T00:00:00Z";
  const at = (m) => Date.parse(start) + m * 60000;
  const prs = [{ approved: true }, { approved: true }];
  const opts = { autoMerge: true, autoMergeAfterMin: 60 };
  assert.equal(lib.shouldAutoMerge(opts, start, prs, at(59)).merge, false);   // 아직
  assert.equal(lib.shouldAutoMerge(opts, start, prs, at(59)).reason, "waiting");
  const due = lib.shouldAutoMerge(opts, start, prs, at(60));
  assert.equal(due.merge, true);
  assert.equal(due.dueMs, at(60));
});

test("shouldAutoMerge: 열린 PR 이 없거나 시작 시각이 없으면 병합하지 않는다", () => {
  const opts = { autoMerge: true, autoMergeAfterMin: 60 };
  assert.equal(lib.shouldAutoMerge(opts, "2026-09-02T00:00:00Z", [], Date.now()).reason, "no-open-pr");
  assert.equal(lib.shouldAutoMerge(opts, "", [{ approved: true }], Date.now()).reason, "no-start");
});

// ===== 중단 시 자동 재시도 =====
// 실측 사례: 04:06 에 "resets 1:40pm" → 9시간 34분 뒤. 고정 백오프(최대 4시간)로는 닿지 않아
// 해제 시각 파싱이 필수다.
test("parseUsageLimitReset: 실제 메시지에서 해제 시각을 읽는다", () => {
  const now = new Date("2026-09-02T04:06:11+09:00");
  const at = lib.parseUsageLimitReset("You've hit your session limit · resets 1:40pm (Asia/Seoul)", now);
  assert.equal(Math.round((at - now) / 60000), 576);   // 9시간 34분 + 버퍼 2분
});

test("parseUsageLimitReset: 분 없는 형식·자정 넘김도 처리", () => {
  const now = new Date("2026-09-02T04:06:11+09:00");
  assert.equal(Math.round((lib.parseUsageLimitReset("resets 3pm (Asia/Seoul)", now) - now) / 60000), 656);
  assert.equal(Math.round((lib.parseUsageLimitReset("resets 10am (Asia/Seoul)", now) - now) / 60000), 356);
  // 01:20am 은 이미 지난 시각 → 다음 날 그 시각
  assert.equal(Math.round((lib.parseUsageLimitReset("resets 1:20am (Asia/Seoul)", now) - now) / 60000), 1276);
});

test("parseUsageLimitReset: 못 읽는 문자열은 null", () => {
  assert.equal(lib.parseUsageLimitReset("그냥 실패했습니다", new Date()), null);
  assert.equal(lib.parseUsageLimitReset("", new Date()), null);
  assert.equal(lib.parseUsageLimitReset("resets 99:99pm", new Date()), null);
});

test("classifyPause: 사용량 한도는 재시도 대상", () => {
  const c = lib.classifyPause("build 실행 실패 (exit 1)", "You've hit your session limit · resets 1:40pm (Asia/Seoul)");
  assert.equal(c.retryable, true);
  assert.equal(c.kind, "usage-limit");
});

test("classifyPause: 사람이 봐야 하는 중단은 재시도하지 않는다", () => {
  for (const r of ["EKYB-1 · approve: 리뷰 승인이 남았습니다: o/r#1",
                   "EKYB-1 · adopt: plan 질문에 '💡 제안:' 답변이 없어 자동 채택할 수 없습니다.",
                   "자동 병합 실패 — base 충돌"]) {
    assert.equal(lib.classifyPause(r, "").retryable, false, r);
  }
  assert.equal(lib.classifyPause("build 가 답변 대기로 스킵됐습니다", "").kind, "awaiting-answer");
});

test("classifyPause: 일반 실행 실패는 일시적으로 보고 재시도", () => {
  const c = lib.classifyPause("plan 실행 실패 (exit 1)", "some engine crash");
  assert.equal(c.retryable, true);
  assert.equal(c.kind, "transient");
});

test("planRetry: 사용량 한도면 해제 시각에, 아니면 점증 백오프", () => {
  const now = new Date("2026-09-02T04:06:11+09:00");
  const cfg = { autoRetry: true, autoRetryMax: 5 };
  const limit = { reason: "build 실행 실패 (exit 1)", lastError: "You've hit your session limit · resets 1:40pm (Asia/Seoul)" };
  const p1 = lib.planRetry(limit, 0, cfg, now);
  assert.equal(p1.retry, true);
  assert.equal(p1.source, "reset-time");
  assert.equal(Math.round((p1.at - now) / 60000), 576);

  const plain = { reason: "build 실행 실패 (exit 1)", lastError: "network hiccup" };
  assert.equal(Math.round((lib.planRetry(plain, 0, cfg, now).at - now) / 60000), 10);
  assert.equal(Math.round((lib.planRetry(plain, 2, cfg, now).at - now) / 60000), 60);
  const wide = { autoRetry: true, autoRetryMax: 20 };
  assert.equal(Math.round((lib.planRetry(plain, 4, wide, now).at - now) / 60000), 240);
  assert.equal(Math.round((lib.planRetry(plain, 9, wide, now).at - now) / 60000), 240);  // 배열 끝을 넘으면 마지막 값 유지
  assert.equal(lib.planRetry(plain, 0, cfg, now).source, "backoff");
});

test("planRetry: 꺼져 있거나 상한 초과면 재시도하지 않는다", () => {
  const now = new Date();
  const run = { reason: "build 실행 실패 (exit 1)", lastError: "session limit" };
  assert.equal(lib.planRetry(run, 0, { autoRetry: false }, now).why, "off");
  assert.equal(lib.planRetry(run, 5, { autoRetry: true, autoRetryMax: 5 }, now).why, "max-attempts");
});

test("clampRetryMax: 기본 5, 1~20", () => {
  assert.equal(lib.clampRetryMax(undefined), 5);
  assert.equal(lib.clampRetryMax(0), 5);
  assert.equal(lib.clampRetryMax(3), 3);
  assert.equal(lib.clampRetryMax(999), 20);
});

// ===== 에픽 계층 타입(에픽 · 워크스트림 …) 해석 =====
// Jira JQL 은 issuetype 을 지역화된 표시 이름으로 매칭하지 못한다(`issuetype = "워크스트림"`,
// `issuetype = "에픽"` 모두 에러 없이 0건). 반드시 타입 id 로 조회해야 한다.
const PHYS_TYPES = [
  { id: "12219", name: "워크스트림", subtask: false, hierarchyLevel: 1 },
  { id: "12220", name: "작업", subtask: false, hierarchyLevel: 0 },
  { id: "12221", name: "하위 작업", subtask: true, hierarchyLevel: -1 },
  { id: "12228", name: "버그", subtask: false, hierarchyLevel: 0 },
];
const EKYB_TYPES = [
  { id: "10872", name: "작업", subtask: false, hierarchyLevel: 0 },
  { id: "10873", name: "에픽", subtask: false, hierarchyLevel: 1 },
  { id: "10874", name: "하위 작업", subtask: true, hierarchyLevel: -1 },
];

test("topLevelIssueTypes: 이름과 무관하게 hierarchyLevel 1 만 고른다", () => {
  assert.deepEqual(lib.topLevelIssueTypes(PHYS_TYPES).map((t) => t.id), ["12219"]);
  assert.deepEqual(lib.topLevelIssueTypes(EKYB_TYPES).map((t) => t.id), ["10873"]);
  assert.deepEqual(lib.topLevelIssueTypes([]), []);
  assert.deepEqual(lib.topLevelIssueTypes(null), []);
  // 하위작업은 hierarchyLevel 이 -1 이지만 방어적으로 subtask 도 배제한다
  assert.deepEqual(lib.topLevelIssueTypes([{ id: "1", name: "x", subtask: true, hierarchyLevel: 1 }]), []);
});

test("epicSearchJql: 표시 이름이 아니라 타입 id 로 조회한다", () => {
  const phys = lib.epicSearchJql("PHYS", PHYS_TYPES);
  assert.match(phys, /^project = "PHYS" AND issuetype IN \(12219\) ORDER BY created DESC$/);
  assert.doesNotMatch(phys, /워크스트림/);   // 이름 매칭은 0건이라 절대 쓰면 안 된다

  const ekyb = lib.epicSearchJql("EKYB", EKYB_TYPES);
  assert.match(ekyb, /issuetype IN \(10873\)/);
});

test("epicSearchJql: 계층 타입이 여러 개면 모두 포함, 메타가 없으면 Epic 으로 떨어진다", () => {
  const multi = lib.epicSearchJql("X", [
    { id: "1", name: "에픽", subtask: false, hierarchyLevel: 1 },
    { id: "2", name: "워크스트림", subtask: false, hierarchyLevel: 1 },
  ]);
  assert.match(multi, /issuetype IN \(1, 2\)/);
  assert.match(lib.epicSearchJql("X", []), /issuetype = Epic/);
  assert.match(lib.epicSearchJql("X", null), /issuetype = Epic/);
});

test("epicTypeLabel: 화면·알림 문구는 프로젝트가 쓰는 이름을 따른다", () => {
  assert.equal(lib.epicTypeLabel(PHYS_TYPES), "워크스트림");
  assert.equal(lib.epicTypeLabel(EKYB_TYPES), "에픽");
  assert.equal(lib.epicTypeLabel([]), "에픽");
});

test("buildAdoptedAnswerBody: 채택 코멘트도 프로젝트 용어를 쓴다", () => {
  const suggested = lib.parseSuggestedAnswers([{ id: "1", body: "1. 기본값은?\n   💡 제안: 비활성" }]);
  assert.match(lib.buildAdoptedAnswerBody(suggested, "PHYS-123", "워크스트림"), /^\[워크스트림 연속 개발 · PHYS-123\]/);
  assert.match(lib.buildAdoptedAnswerBody(suggested, "EKYB-800"), /^\[에픽 연속 개발 · EKYB-800\]/);
});

// ===== prepare 라벨 동기화 =====
// 라벨을 '추가만' 하면 이전 실행이 남긴 repo_<name> 이 카드에 그대로 붙어 있고,
// 카드 단위 경로(run-cycle.js 예약 루프 · 대시보드 개별 실행)는 CARD_REPOS 가 아니라 이 라벨로
// 대상 repo 를 정하므로 이번 실행에서 뺀 repo 가 계속 딸려온다.
test("epicPrepareLabelDiff: 이번 실행에 없는 repo_ 라벨은 제거 대상", () => {
  const labels = ["claude-work", "repo_physical-ai-agentsystem", "repo_physical-ai-workbench"];
  const d = lib.epicPrepareLabelDiff(labels, ["physical-ai-agentsystem"], CFG);
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, ["repo_physical-ai-workbench"]);
});

test("epicPrepareLabelDiff: 트리거·repo 라벨을 함께 채운다", () => {
  const d = lib.epicPrepareLabelDiff([], ["be", "fe"], CFG);
  assert.deepEqual(d.add, ["claude-work", "repo_be", "repo_fe"]);
  assert.deepEqual(d.remove, []);
});

test("epicPrepareLabelDiff: repo_ 가 아닌 라벨은 절대 건드리지 않는다", () => {
  const labels = ["claude-work", "claude-planned", "claude-answered", "hotfix", "repo_be"];
  const d = lib.epicPrepareLabelDiff(labels, ["be"], CFG);
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove, []);   // 사람이 붙인 hotfix, 진행 라벨 모두 보존
});

test("epicPrepareLabelDiff: 이미 맞으면 변경 없음(불필요한 PUT 방지)", () => {
  const d = lib.epicPrepareLabelDiff(["claude-work", "repo_be"], ["be"], CFG);
  assert.equal(d.add.length + d.remove.length, 0);
});

// ===== CI(체크) 상태 판정과 병합 게이트 =====
// 실측 사례: PR #47 이 collect-agent·dataset-service 실패(코드 오류) + eval-service 실패(도커 미러 다운)인데
// develop 에 브랜치 보호가 없어 GitHub 가 막지 않았다. 자동 병합의 유일한 방어선이 이 판정이다.
const CHECK = (name, conclusion, status) => ({ __typename: "CheckRun", name, status: status || "COMPLETED", conclusion });

test("ciStateOf: 하나라도 실패면 fail, 도는 게 있으면 pending, 없으면 none", () => {
  assert.equal(lib.ciStateOf([]), "none");
  assert.equal(lib.ciStateOf(null), "none");
  assert.equal(lib.ciStateOf([CHECK("a", "SUCCESS"), CHECK("b", "SKIPPED")]), "pass");
  assert.equal(lib.ciStateOf([CHECK("a", "SUCCESS"), CHECK("b", "FAILURE")]), "fail");
  // 실패가 있으면 도는 게 있어도 fail — 기다릴 이유가 없다
  assert.equal(lib.ciStateOf([CHECK("a", null, "IN_PROGRESS"), CHECK("b", "FAILURE")]), "fail");
  assert.equal(lib.ciStateOf([CHECK("a", "SUCCESS"), CHECK("b", null, "QUEUED")]), "pending");
});

test("ciStateOf: SKIPPED·NEUTRAL 은 통과, CANCELLED·TIMED_OUT 은 실패로 본다", () => {
  assert.equal(lib.ciStateOf([CHECK("a", "NEUTRAL"), CHECK("b", "SKIPPED")]), "pass");
  assert.equal(lib.ciStateOf([CHECK("a", "CANCELLED")]), "fail");
  assert.equal(lib.ciStateOf([CHECK("a", "TIMED_OUT")]), "fail");
  assert.equal(lib.ciStateOf([CHECK("a", "ACTION_REQUIRED")]), "fail");
});

test("ciStateOf: StatusContext(구형 상태 API) 도 같은 기준으로 읽는다", () => {
  const ctx = (context, state) => ({ __typename: "StatusContext", context, state });
  assert.equal(lib.ciStateOf([ctx("ci/x", "SUCCESS")]), "pass");
  assert.equal(lib.ciStateOf([ctx("ci/x", "ERROR")]), "fail");
  assert.equal(lib.ciStateOf([ctx("ci/x", "FAILURE")]), "fail");
  assert.equal(lib.ciStateOf([ctx("ci/x", "PENDING")]), "pending");
});

test("failedChecks: 실패한 체크만 이름·사유·URL 로 추린다", () => {
  const rollup = [
    CHECK("collect-agent", "FAILURE"),
    CHECK("ops-web", "SUCCESS"),
    { __typename: "CheckRun", name: "eval-service", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/123/job/9" },
  ];
  const f = lib.failedChecks(rollup);
  assert.deepEqual(f.map((x) => x.name), ["collect-agent", "eval-service"]);
  assert.equal(f[1].url, "https://github.com/o/r/actions/runs/123/job/9");
  assert.equal(lib.runIdFromCheckUrl(f[1].url), "123");
  assert.equal(lib.runIdFromCheckUrl("https://example.com/nope"), "");
});

test("shouldAutoMerge: CI 가 빨갛거나 아직 도는 중이면 승인·시간과 무관하게 병합하지 않는다", () => {
  const start = "2026-09-02T00:00:00Z";
  const at = (m) => Date.parse(start) + m * 60000;
  const opts = { autoMerge: true, autoMergeAfterMin: 60 };
  assert.equal(lib.shouldAutoMerge(opts, start, [{ approved: true, ci: "fail" }], at(600)).reason, "ci-failed");
  assert.equal(lib.shouldAutoMerge(opts, start, [{ approved: true, ci: "pending" }], at(600)).reason, "ci-pending");
  // 판정 불능(조회 실패)도 막는다 — 모르면 병합하지 않는다
  assert.equal(lib.shouldAutoMerge(opts, start, [{ approved: true, ci: "unknown" }], at(600)).reason, "ci-unknown");
  // 여러 PR 중 하나만 빨개도 전체를 막는다
  assert.equal(lib.shouldAutoMerge(opts, start, [{ approved: true, ci: "pass" }, { approved: true, ci: "fail" }], at(600)).reason, "ci-failed");
});

test("shouldAutoMerge: CI 초록이거나 체크가 없는 repo 는 종전대로 병합", () => {
  const start = "2026-09-02T00:00:00Z";
  const at = (m) => Date.parse(start) + m * 60000;
  const opts = { autoMerge: true, autoMergeAfterMin: 60 };
  assert.equal(lib.shouldAutoMerge(opts, start, [{ approved: true, ci: "pass" }], at(60)).merge, true);
  assert.equal(lib.shouldAutoMerge(opts, start, [{ approved: true, ci: "none" }], at(60)).merge, true);
  // ci 필드를 안 채우는 옛 호출부는 그대로 동작(하위 호환)
  assert.equal(lib.shouldAutoMerge(opts, start, [{ approved: true }], at(60)).merge, true);
});

test("clampCiLoopMax: 기본 5, 상한 20, 잘못된 값은 기본값", () => {
  assert.equal(lib.clampCiLoopMax(null, {}), 5);
  assert.equal(lib.clampCiLoopMax("", {}), 5);
  assert.equal(lib.clampCiLoopMax(3, {}), 3);
  assert.equal(lib.clampCiLoopMax(999, {}), 20);
  assert.equal(lib.clampCiLoopMax("abc", {}), 5);
  assert.equal(lib.clampCiLoopMax(null, { ciLoopMax: 7 }), 7);
});

test("ci 단계: build 와 approve 사이에 있고, PR 이 올라간 카드는 ci 부터 재개한다", () => {
  assert.equal(lib.nextEpicStep("build"), "ci");
  assert.equal(lib.nextEpicStep("ci"), "approve");
  assert.equal(lib.epicTaskStep({ key: "K-1", labels: ["claude-work", "claude-planned", "claude-answered", "claude-pr"] }, CFG), "ci");
});

test("classifyPause: CI 수정 반복 소진은 사람 확인 대상(재시도 무의미)", () => {
  const c = lib.classifyPause("PHYS-128 · ci: o/r#47 CI 수정 반복 5회 후에도 정리되지 않았습니다", "");
  assert.equal(c.retryable, false);
  assert.equal(c.kind, "needs-human");
  // 다만 한도 소진으로 죽은 것이라면 그건 시간이 풀어준다 — 그쪽이 우선
  const u = lib.classifyPause("PHYS-128 · ci: CI 수정 실행 실패 (exit 1)", "You've hit your session limit · resets 6:10pm (Asia/Seoul)");
  assert.equal(u.retryable, true);
  assert.equal(u.kind, "usage-limit");
});
