// dashboard/test/review-approve-ci-gate.test.js
// 리뷰 승인 알림의 CI 게이트(lib-notify.sh) 회귀 테스트.
// 핵심 회귀: 승인 시점에 CI 가 아직 돌고 있으면 [병합] 버튼을 보내지 않는다 —
// 그 버튼은 대시보드 병합 라우트의 CI 게이트에 막혀 눌러도 병합되지 않는다.
// 네트워크·gh 를 타지 않도록 ci-state.js 를 스텁으로 갈아끼운다.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");

// SELF_DIR 을 임시 디렉토리로 두고 그 안의 ci-state.js 가 FAKE_CI 를 그대로 돌려준다.
function run(fakeCi, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gate-"));
  fs.writeFileSync(path.join(dir, "ci-state.js"),
    'process.stdout.write(`${process.env.FAKE_CI}\\t${process.env.FAKE_FAILED || ""}\\n`);');
  const script = `
    set -uo pipefail
    SELF_DIR="${dir}"
    ISSUE_KEY="EKYB-1"
    notify_slack_btn() { printf 'BTN|%s\\n' "$*"; }
    source "${ROOT}/lib-notify.sh"
    notify_review_approved "Org/repo" 7 "https://x/pull/7" "[EKYB-1] 리뷰 승인 완료 (루프 2/5회차) · Org/repo#7"
  `;
  const out = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, FAKE_CI: fakeCi, SLACK_WEBHOOK_URL: "https://example.invalid/hook", ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test("CI 초록이면 승인 알림에 병합 버튼을 붙여 보낸다", () => {
  const out = run("pass");
  assert.match(out, /BTN\|✅ \[EKYB-1\] 리뷰 승인 완료 .* · CI 통과 merge:Org\/repo:7 url:/);
});

// '체크 0건' 은 'CI 없는 repo' 와 '방금 푸시해 아직 등록 전' 이 구분되지 않는다. 후자에서 버튼을
// 보내면 몇 초 뒤 체크가 pending 으로 올라와 같은 버그가 재현되므로, 유예 구간을 기다린 뒤 판정한다.
test("체크가 아직 0건이면 즉시 보내지 않고 유예 구간 뒤에 판정한다", () => {
  const out = run("none");
  assert.ok(!out.includes("BTN|"), `유예 없이 버튼이 나갔다: ${out}`);
  assert.match(out, /CI 확정 후 승인 알림을 보냅니다/);
});

test("대기를 끈 상태에서 체크가 없는 repo 는 종전대로 병합 버튼을 보낸다", () => {
  assert.match(run("none", { REVIEW_APPROVE_CI_WAIT_MIN: "0" }), /BTN\|✅ .*merge:Org\/repo:7/);
});

test("CI 가 진행 중이면 알림을 보내지 않고 CI 확정까지 기다린다(헛클릭 방지)", () => {
  const out = run("pending");
  assert.ok(!out.includes("BTN|"), `버튼 알림이 나갔다: ${out}`);
  assert.match(out, /CI 확정 후 승인 알림을 보냅니다/);
});

test("CI 실패면 병합 버튼 없이 실패를 알린다", () => {
  const out = run("fail", { FAKE_FAILED: "unit-test, lint" });
  assert.match(out, /BTN\|🧪 .*CI 실패로 병합할 수 없습니다 \(실패: unit-test, lint\)/);
  assert.ok(!out.includes("merge:Org/repo:7"), `실패인데 병합 버튼이 붙었다: ${out}`);
});

test("대기를 끄면(0분) 미확정 상태를 병합 버튼 없이 그대로 알린다", () => {
  const out = run("pending", { REVIEW_APPROVE_CI_WAIT_MIN: "0" });
  assert.match(out, /BTN\|⏳ .*CI 가 아직 확정되지 않았습니다/);
  assert.ok(!out.includes("merge:Org/repo:7"), `미확정인데 병합 버튼이 붙었다: ${out}`);
});

test("PR 이 이미 닫혔으면 알림을 보내지 않는다", () => {
  const out = run("closed");
  assert.ok(!out.includes("BTN|"), out);
  assert.match(out, /PR 이 이미 닫혀 승인 알림을 보내지 않습니다/);
});

test("연속 개발 중이면 승인 알림을 러너의 '병합만 남음' 알림에 맡긴다(중복 방지)", () => {
  const out = run("pass", { EPIC_KEY: "PHYS-139" });
  assert.ok(!out.includes("BTN|"), `에픽 실행 중인데 중복 알림이 나갔다: ${out}`);
  assert.match(out, /병합만 남음/);
});

test("Slack 웹훅이 없으면 아무것도 하지 않는다", () => {
  const out = run("pass", { SLACK_WEBHOOK_URL: "" });
  assert.strictEqual(out.trim(), "");
});

// ci-state.js 의 확정 판정 — '체크 없음' 은 방금 푸시한 직후일 수 있어 유예 구간 동안 기다린다.
const ciState = require(path.join(ROOT, "ci-state.js"));

test("isSettled: pending·unknown 은 기다리고, none 은 유예 구간 안에서만 기다린다", () => {
  assert.strictEqual(ciState.isSettled("pending", 10 * 60000), false);
  assert.strictEqual(ciState.isSettled("unknown", 10 * 60000), false);
  assert.strictEqual(ciState.isSettled("none", 1000), false);
  assert.strictEqual(ciState.isSettled("none", ciState.NONE_GRACE_MS + 1), true);
  assert.strictEqual(ciState.isSettled("pass", 0), true);
  assert.strictEqual(ciState.isSettled("fail", 0), true);
});

test("stateFromPr: 닫힌 PR 은 closed, 조회 실패는 unknown, 그 외는 CI 판정을 따른다", () => {
  assert.strictEqual(ciState.stateFromPr(null).state, "unknown");
  assert.strictEqual(ciState.stateFromPr({ state: "MERGED" }).state, "closed");
  assert.strictEqual(ciState.stateFromPr({ state: "OPEN", statusCheckRollup: [] }).state, "none");
  const failing = { state: "OPEN", statusCheckRollup: [{ name: "unit", status: "COMPLETED", conclusion: "FAILURE" }] };
  assert.strictEqual(ciState.stateFromPr(failing).state, "fail");
  assert.deepStrictEqual(ciState.stateFromPr(failing).failed.map((f) => f.name), ["unit"]);
});
