// public/index.html 의 카드 목록 필터·점프 페이지 계산.
// 활성 패널에서 카드로 점프할 때 예전엔 검색창에 카드 키를 써넣어, 점프 이후 목록이
// 그 카드 1건만 남은 채로 계속 유지됐다. 지금은 검색을 건드리지 않고 페이지만 옮긴다.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const start = html.indexOf("const CARD_PAGE_SIZE =");
const end = html.indexOf("const stageBadge = {");
assert.ok(start > 0 && end > start, "index.html 에서 카드 목록 헬퍼 블록을 찾지 못했습니다");
const ctx = {};
vm.createContext(ctx);
vm.runInContext(html.slice(start, end) + "\nglobalThis.__h = { CARD_PAGE_SIZE, cardMatches, cardJumpPage };", ctx);
const { CARD_PAGE_SIZE, cardMatches, cardJumpPage } = ctx.__h;

const cards = Array.from({ length: 32 }, (_, i) => ({
  key: `EKYB-${815 - i}`, summary: `카드 ${i}`, status: i < 2 ? "진행 중" : "DEV COMPLETED",
}));

test("검색어가 비면 전체가 남는다", () => {
  assert.strictEqual(cards.filter((c) => cardMatches(c, "")).length, 32);
});

test("검색어는 키·이름·상태 어디든 걸린다", () => {
  assert.ok(cardMatches(cards[0], "ekyb-815"));
  assert.ok(cardMatches(cards[0], "카드 0"));
  assert.ok(cardMatches(cards[5], "dev completed"));
  assert.ok(!cardMatches(cards[0], "없는값"));
});

test("점프 대상의 페이지를 페이지 크기로 계산한다", () => {
  assert.strictEqual(cardJumpPage(cards, "EKYB-815", ""), 0);   // 0번째
  assert.strictEqual(cardJumpPage(cards, "EKYB-806", ""), 0);   // 9번째 → 여전히 0페이지
  assert.strictEqual(cardJumpPage(cards, "EKYB-805", ""), 1);   // 10번째 → 1페이지
  assert.strictEqual(cardJumpPage(cards, "EKYB-784", ""), 3);   // 31번째 → 3페이지
  assert.strictEqual(CARD_PAGE_SIZE, 10);
});

test("목록에 없는 카드는 -1 (검색을 해제해야 하는지 판단용)", () => {
  assert.strictEqual(cardJumpPage(cards, "EKYB-999", ""), -1);
  assert.strictEqual(cardJumpPage(cards, "EKYB-805", "진행 중"), -1);   // 검색에 안 걸림
});

test("검색이 걸린 상태에서도 그 결과 안에서의 페이지를 센다", () => {
  assert.strictEqual(cardJumpPage(cards, "EKYB-814", "진행 중"), 0);
});
