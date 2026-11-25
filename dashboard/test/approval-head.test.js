// 승인 마커가 지금 PR head 에 대한 것인지 — 승인 뒤 커밋이 올라오면 그 승인으로 병합하지 않는다.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../lib");

const M = lib.REVIEW_APPROVED_MARKER;
const approval = (id, sha, createdAt) => ({ id, createdAt, body: `✅ ${M}\n\n근거\n${sha ? `<!-- ${M}:${sha} -->` : ""}` });

test("approvalOf: 마커의 SHA 가 head 와 같으면 승인, 다르면 무효 후보", () => {
  const head = { sha: "7b1c29a4e0000000000000000000000000000000" };
  assert.deepStrictEqual(lib.approvalOf([approval(1, "7b1c29a4e0000000000000000000000000000000")], head), { approved: true, staleIds: [] });
  // 2026-11-25 PHYS-602: f253026 을 승인한 뒤 CI 수정 커밋 7b1c29a 가 올라왔다
  assert.deepStrictEqual(lib.approvalOf([approval(1, "f25302688421adc3645c0b3a17b3e073000f472c")], head), { approved: false, staleIds: [1] });
  // 짧은 SHA 도 앞자리로 맞춘다
  assert.strictEqual(lib.approvalOf([approval(1, "7b1c29a")], head).approved, true);
});

test("approvalOf: 옛 승인이 무효여도 head 에 대한 새 승인이 있으면 승인", () => {
  const r = lib.approvalOf([approval(1, "aaaaaaa1"), approval(2, "bbbbbbb2")], { sha: "bbbbbbb2" });
  assert.deepStrictEqual(r, { approved: true, staleIds: [] });
});

test("approvalOf: SHA 없는 옛 마커는 head 커밋 시각과 코멘트 시각으로 판정", () => {
  const c = [approval(5, "", "2026-11-25T16:15:40Z")];
  assert.strictEqual(lib.approvalOf(c, { sha: "abc1234", committedAt: "2026-11-25T15:00:00Z" }).approved, true);
  assert.deepStrictEqual(lib.approvalOf(c, { sha: "abc1234", committedAt: "2026-11-25T17:24:37Z" }), { approved: false, staleIds: [5] });
  // 커밋 시각을 모르면 예전처럼 승인으로 둔다
  assert.strictEqual(lib.approvalOf(c, { sha: "abc1234" }).approved, true);
});

test("approvalOf: 무효화된 마커·마커 없는 코멘트는 승인이 아니고 무효 후보도 아니다", () => {
  const superseded = { id: 9, body: lib.supersededBody(approval(9, "aaaaaaa1").body, lib.REVIEW_SUPERSEDED_STALE, "승인 뒤 새 커밋이 올라와", "t") };
  assert.deepStrictEqual(lib.approvalOf([superseded, { id: 3, body: "## 자동 리뷰 — 수정 필요" }], { sha: "bbbbbbb2" }), { approved: false, staleIds: [] });
  assert.deepStrictEqual(lib.approvalOf([], { sha: "x" }), { approved: false, staleIds: [] });
});

test("approvalNeedsCommitTime: SHA 없는 승인 마커가 있을 때만", () => {
  assert.strictEqual(lib.approvalNeedsCommitTime([approval(1, "abcdef1")]), false);
  assert.strictEqual(lib.approvalNeedsCommitTime([approval(1, "")]), true);
  assert.strictEqual(lib.approvalNeedsCommitTime([{ body: "그냥 코멘트" }]), false);
});

test("isTransientGhError: GitHub 일시 장애만 다시 보낸다", () => {
  for (const m of ["gh api -X 실패: unexpected end of JSON input", "GraphQL: Something went wrong while executing your query", "HTTP 502: Bad Gateway", "HTTP 503", "read: connection reset by peer", "net/http: TLS handshake timeout"]) {
    assert.strictEqual(lib.isTransientGhError(m), true, m);
  }
  for (const m of ["HTTP 404: Not Found", "HTTP 403: Resource not accessible by integration", "HTTP 422: Validation Failed", ""]) {
    assert.strictEqual(lib.isTransientGhError(m), false, m);
  }
});
