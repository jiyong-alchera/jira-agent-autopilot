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
  assert.equal(step(["claude-work", "claude-planned", "claude-answered", "claude-pr"]), "await-merge"); // PR 올림
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
  assert.equal(lib.nextEpicStep("build"), "approve");
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
