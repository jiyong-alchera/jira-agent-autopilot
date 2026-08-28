// plan 질문 코멘트의 "💡 제안:" 줄 → 답변 초안 파싱.
// 형식은 run-jira-agent.sh 의 plan 프롬프트가 생성하므로, 둘이 어긋나면 여기서 깨진다.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const lib = require("../lib.js");

const planComment = `@Matthew Jeong 구현 전 확인이 필요합니다.

1. 지원 언어는 영어 단일인가요, 다국어인가요?
   💡 제안: 임시 지원이므로 영어 단일로 시작 (근거: 코드베이스에 i18n 설정이 없어 확장 비용이 큼)

2. 번역 리소스는 어떻게 관리하나요?
   💡 제안: react-i18next + locales/{en,ko}.json

답변을 마치신 뒤 이 이슈에 "claude-answered" 라벨을 추가해 주세요.`;

test("제안 답변을 번호·근거와 함께 파싱한다", () => {
  const r = lib.parseSuggestedAnswers([{ id: "10", body: planComment }]);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.items[0].n, 1);
  assert.strictEqual(r.items[0].question, "지원 언어는 영어 단일인가요, 다국어인가요?");
  assert.strictEqual(r.items[0].suggestion, "임시 지원이므로 영어 단일로 시작");
  assert.match(r.items[0].rationale, /i18n 설정이 없어/);
  assert.strictEqual(r.items[1].rationale, "");
});

test("답변 초안에는 근거를 빼고 번호 + 제안만 넣는다", () => {
  const r = lib.parseSuggestedAnswers([{ id: "10", body: planComment }]);
  assert.strictEqual(r.draft, "1. 임시 지원이므로 영어 단일로 시작\n2. react-i18next + locales/{en,ko}.json");
});

test("plan 이 여러 번 돌아 제안 코멘트가 쌓이면 마지막 것만 쓴다", () => {
  const r = lib.parseSuggestedAnswers([
    { id: "1", body: "1. 옛 질문\n   💡 제안: 옛 제안" },
    { id: "2", body: "잡담 코멘트" },
    { id: "3", body: "1. 새 질문\n   💡 제안: 새 제안" },
  ]);
  assert.strictEqual(r.commentId, "3");
  assert.strictEqual(r.draft, "1. 새 제안");
});

test("제안이 없는 카드는 null 을 돌려준다", () => {
  assert.strictEqual(lib.parseSuggestedAnswers([{ id: "1", body: "1. 질문만 있음" }]), null);
  assert.strictEqual(lib.parseSuggestedAnswers([]), null);
  assert.strictEqual(lib.parseSuggestedAnswers(undefined), null);
});

test("'1)' 형식 번호와 전각 괄호 근거도 인식한다", () => {
  const r = lib.parseSuggestedAnswers([{ id: "1", body: "1) 질문\n  💡 제안: 답 （근거: 이유）" }]);
  assert.strictEqual(r.items[0].suggestion, "답");
  assert.strictEqual(r.items[0].rationale, "이유");
});

test("plan 프롬프트가 파서와 같은 마커·형식을 지시한다", () => {
  const sh = fs.readFileSync(path.join(__dirname, "..", "..", "run-jira-agent.sh"), "utf8");
  assert.ok(sh.includes(lib.SUGGEST_MARK + " <제안하는 답변> (근거: <한 줄 근거>)"),
    "run-jira-agent.sh 의 plan 프롬프트와 parseSuggestedAnswers 의 형식이 어긋났습니다");
});

// 실제 plan 출력은 번호 대신 불릿을 쓰고 💡·근거를 생략하는 경우가 많다(EKYB-815 실측).
test("불릿 질문 + 💡 없는 '제안:' 형식도 인식한다", () => {
  const r = lib.parseSuggestedAnswers([{ id: "5", body: `확인이 필요한 사항
• 지원 언어의 범위 — 영어 단일인가요?
시안 섹션명이 「영문버전 Full Flow」라 영어 단일로 이해했습니다. 맞나요?
제안: 저장 값은 언어 코드("ko"|"en")로 두고 토글은 on=en 으로 매핑합니다.
• 토글 조작 주체
제안: root 콘솔 전용. 심사자 화면에는 노출하지 않습니다.` }]);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.items[0].question, "지원 언어의 범위 — 영어 단일인가요?");
  assert.strictEqual(r.items[1].n, 2);
  assert.strictEqual(r.items[1].suggestion, "root 콘솔 전용. 심사자 화면에는 노출하지 않습니다.");
});

test("질문 본문에 '제안' 이 들어가도 줄 시작이 아니면 제안으로 오인하지 않는다", () => {
  const r = lib.parseSuggestedAnswers([{ id: "6", body: `1. 이 제안을 반영할까요?
   💡 제안: 반영합니다` }]);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.items[0].question, "이 제안을 반영할까요?");
  assert.strictEqual(r.items[0].suggestion, "반영합니다");
});
