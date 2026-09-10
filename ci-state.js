#!/usr/bin/env node
// ci-state.js <OWNER/REPO> <PR번호> [--wait-min N] [--poll-sec S]
// --------------------------------------------------------------------------
// PR 의 CI 상태를 한 줄로 출력한다:  "<상태>\t<실패한 체크 이름들>"
//   상태: pass | fail | pending | none(체크 자체가 없음) | closed(PR 이 닫힘) | unknown(조회 실패)
//
// 왜 별도 스크립트인가: 셸 스크립트(run-review.sh · run-review-loop.sh)도 CI 를 봐야 하는데,
// 판정 기준이 대시보드 병합 게이트·에픽 러너와 어긋나면 '초록이라 보낸 버튼이 막히는' 일이 다시 생긴다.
// 그래서 판정은 dashboard/lib.js 의 ciStateOf/failedChecks 를 그대로 쓰고, 셸에는 이 CLI 로만 노출한다.
//
// --wait-min 을 주면 도는 체크가 없어질 때까지(또는 그 시간까지) 폴링한다.
// 어떤 실패에도 종료코드 0 을 준다 — 알림 판정에 쓰는 보조 도구라 호출부를 멈춰선 안 된다.
// --------------------------------------------------------------------------
const path = require("path");
const { execFile } = require("child_process");
const lib = require(path.join(__dirname, "dashboard", "lib"));

// '체크 없음' 을 '아직 안 올라옴' 으로 보는 유예 구간(3분). 방금 푸시하면 체크가 등록되기까지
// 시간이 걸려, 그 순간의 'none' 을 'CI 없는 repo' 로 읽으면 CI 를 기다리지 않고 지나친다.
// (run-epic-loop.js 의 CI_NONE_GRACE_MS 와 같은 근거·같은 값)
const NONE_GRACE_MS = 180000;
const UNKNOWN_GIVEUP = 3;   // gh 조회가 연속 이만큼 실패하면 기다리지 않고 unknown 으로 답한다

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateFromPr(pr) {
  if (!pr) return { state: "unknown", failed: [] };
  const prState = String(pr.state || "").toUpperCase();
  if (prState && prState !== "OPEN") return { state: "closed", failed: [] };
  return { state: lib.ciStateOf(pr.statusCheckRollup), failed: lib.failedChecks(pr.statusCheckRollup) };
}

// 더 기다릴 필요가 없는(확정된) 상태인지. 'none' 은 유예 구간 동안만 기다린다.
function isSettled(state, elapsedMs) {
  if (state === "pending" || state === "unknown") return false;
  if (state === "none" && elapsedMs < NONE_GRACE_MS) return false;
  return true;
}

function ghPr(or, num) {
  return new Promise((resolve) => {
    execFile("gh", ["pr", "view", String(num), "--repo", or, "--json", "state,statusCheckRollup"],
      { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout || "null")); } catch { resolve(null); }
      });
  });
}

function intArg(name, dflt) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const n = parseInt(process.argv[i + 1], 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

async function main() {
  const [or, num] = process.argv.slice(2);
  const out = (state, failed) => process.stdout.write(`${state}\t${(failed || []).map((f) => f.name).join(", ")}\n`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(or || "")) || !/^[0-9]+$/.test(String(num || ""))) return out("unknown", []);
  const waitMs = intArg("--wait-min", 0) * 60000;
  const pollMs = Math.max(5, intArg("--poll-sec", 30)) * 1000;
  const startedAt = Date.now();
  const until = startedAt + waitMs;
  let unknowns = 0;
  for (;;) {
    const { state, failed } = stateFromPr(await ghPr(or, num));
    unknowns = state === "unknown" ? unknowns + 1 : 0;
    if (isSettled(state, Date.now() - startedAt) || Date.now() >= until || unknowns >= UNKNOWN_GIVEUP) return out(state, failed);
    await sleep(pollMs);
  }
}

if (require.main === module) main().catch(() => process.stdout.write("unknown\t\n"));

module.exports = { stateFromPr, isSettled, NONE_GRACE_MS };
