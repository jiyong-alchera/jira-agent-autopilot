// dashboard/test/review-loop.test.js — run-review-loop.sh 회귀 테스트
//   실행: npm test
// 실제 스크립트를 임시 디렉터리에 복사하고 하위 스크립트(run-jira-agent.sh / run-review.sh)와 gh 를
// 스텁으로 갈아끼워, 네트워크·엔진 없이 루프의 제어 흐름만 검증한다.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPTS_DIR = path.join(__dirname, "..", "..");
const KEY = "TEST-1";
const OR = "acme/repo";
const PR = "7";

// 스텁 일체를 깐 임시 작업공간을 만든다. reworkStdout = rework 스텁이 뱉을 stdout.
function makeSandbox(reworkStdout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewloop-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, "repos", ".state"), { recursive: true });
  fs.copyFileSync(path.join(SCRIPTS_DIR, "run-review-loop.sh"), path.join(root, "run-review-loop.sh"));

  // gh: PR 은 항상 OPEN, 승인 마커는 없음(루프가 최대 회차까지 돌도록)
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash\n[[ "\${1:-}" == "pr" ]] && echo OPEN\nexit 0\n`, { mode: 0o755 });

  // 하위 스텁: 호출 순서·핵심 env 를 calls.log 에 기록
  const trace = (name) => `#!/usr/bin/env bash
printf '%s|REVIEW_LOOP_AFTER=%s|REVIEW_AFTER=%s|IN_REVIEW_LOOP=%s\\n' \\
  "${name}" "\${REVIEW_LOOP_AFTER:-}" "\${REVIEW_AFTER:-}" "\${IN_REVIEW_LOOP:-}" >> "${path.join(root, "calls.log")}"
`;
  fs.writeFileSync(path.join(root, "run-jira-agent.sh"), trace("rework") + reworkStdout + "\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "run-review.sh"), trace("review") + "exit 0\n", { mode: 0o755 });
  return { root, bin };
}

function runLoop(reworkStdout) {
  const { root, bin } = makeSandbox(reworkStdout);
  const r = spawnSync("bash", [path.join(root, "run-review-loop.sh"), KEY, OR, PR], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      WORK_DIR: root,
      CLONE_BASE: path.join(root, "repos"),
      HISTORY_FILE: path.join(root, "history.jsonl"),
      SLACK_WEBHOOK_URL: "",
      REVIEW_LOOP_MAX: "2",
      REVIEW_FIRST: "1",          // 1회차는 반영 생략(개발 직후 새 PR)
      REVIEW_LOOP_AFTER: "1",     // 대시보드가 최상위 build 에 넣는 값 — 하위로 새면 안 된다
      REVIEW_AFTER: "1",
    },
  });
  const calls = fs.existsSync(path.join(root, "calls.log"))
    ? fs.readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n").filter(Boolean)
    : [];
  fs.rmSync(root, { recursive: true, force: true });
  // 중단 사유는 stderr 로도 나가므로 합쳐서 본다
  return { stdout: (r.stdout || "") + (r.stderr || ""), status: r.status, calls };
}

test("review-loop: rework 하위에 연쇄 플래그를 넘기지 않는다(중첩 루프 방지)", () => {
  const { calls } = runLoop("echo done");
  const rework = calls.find((l) => l.startsWith("rework|"));
  assert.ok(rework, "rework 가 호출되어야 한다");
  assert.match(rework, /REVIEW_LOOP_AFTER=\|/);   // 빈 값
  assert.match(rework, /REVIEW_AFTER=\|/);        // 빈 값
  assert.match(rework, /IN_REVIEW_LOOP=1/);
  const review = calls.find((l) => l.startsWith("review|"));
  assert.match(review, /REVIEW_LOOP_AFTER=\|/);
  assert.match(review, /IN_REVIEW_LOOP=1/);
});

test("review-loop: 중첩 루프의 SKIP 줄에 루프가 죽지 않는다", () => {
  // 연쇄 플래그가 어떤 경로로든 새어 하위가 이 줄을 찍어도, 반영 자체는 성공이므로 계속 가야 한다
  const nested = `echo "SKIP: [${KEY}] 리뷰 승인 루프가 이미 실행 중입니다(lock)"`;
  const { stdout, calls } = runLoop(nested);
  assert.doesNotMatch(stdout, /루프 중단/);
  assert.match(stdout, /2\/2 회차: 재리뷰/);                       // 반영 뒤 재리뷰까지 진행
  assert.equal(calls.filter((l) => l.startsWith("review|")).length, 2);
});

test("review-loop: 실제 카드 락 SKIP 이면 중단한다", () => {
  const { stdout, calls } = runLoop(`echo "SKIP: [${KEY}] 이미 처리 중(lock) — 동시 실행 방지로 종료"`);
  assert.match(stdout, /다른 작업이 이 카드를 처리 중.*루프 중단/);
  assert.equal(calls.filter((l) => l.startsWith("review|")).length, 1);   // 2회차 재리뷰는 없음
});

test("review-loop: 질문 답변 대기(SKIP: awaiting answers)면 그 사유로 중단한다", () => {
  const { stdout } = runLoop(`echo "SKIP: awaiting answers"`);
  assert.match(stdout, /질문 답변을 기다림/);
  assert.doesNotMatch(stdout, /다른 작업이 이 카드를 처리 중/);
});
