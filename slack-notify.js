#!/usr/bin/env node
// 셸 스크립트용 Slack 알림 전송기 — 텍스트에 실행 버튼(Block Kit)을 붙여 보낸다.
// 버튼 클릭은 대시보드의 Socket Mode 수신기가 받아 처리한다(dashboard/slack-socket.js).
//
// 사용: node slack-notify.js "<텍스트>" [액션 ...]
//   액션 형식
//     merge:<OWNER/REPO>:<PR번호>     PR 병합
//     review-loop:<OWNER/REPO>:<PR번호>  리뷰 승인 루프 시작
//     card-run:<phase>                카드 재실행 (plan|build|review)
//     epic-resume | epic-skip | epic-stop
//     url:<라벨>:<주소>               링크 버튼(인터랙션 없음)
//   env: SLACK_WEBHOOK_URL(필수), PROJECT_ID, ISSUE_KEY
//
// 버튼이 없거나 전송에 실패해도 절대 실패로 끝내지 않는다 — 알림은 부수 효과일 뿐이다.

const path = require("path");
const lib = require(path.join(__dirname, "dashboard", "lib"));

function parseAction(spec, ctx) {
  const parts = String(spec || "").split(":");
  const id = parts[0];
  if (id === "url") return { url: parts.slice(2).join(":"), label: parts[1] || "열기" };
  if (!Object.prototype.hasOwnProperty.call(lib.SLACK_ACTIONS, id)) return null;
  const a = { id, project: ctx.project, key: ctx.key };
  if (id === "merge" || id === "review-loop") { a.owner = parts[1] || ""; a.number = parts[2] || ""; }
  if (id === "card-run") a.step = parts[1] || "build";
  return a;
}

async function main() {
  const url = process.env.SLACK_WEBHOOK_URL || "";
  const [text, ...specs] = process.argv.slice(2);
  if (!url || !text) return;
  const ctx = { project: process.env.PROJECT_ID || "", key: process.env.ISSUE_KEY || "" };
  const actions = specs.map((s) => parseAction(s, ctx)).filter(Boolean);
  // 이슈 키가 없으면 실행 버튼은 무의미하므로 링크만 남긴다.
  const usable = ctx.key ? actions : actions.filter((a) => a.url);
  const payload = lib.slackMessage(text, usable);
  try {
    await fetch(url, {
      method: "POST", headers: { "Content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

// 직접 실행할 때만 보낸다(require 는 파서 재사용 목적).
if (require.main === module) main().catch(() => {});

module.exports = { parseAction, main };
