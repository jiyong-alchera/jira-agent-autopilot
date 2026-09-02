#!/usr/bin/env node
// run-cycle.js <plan|build>
// --------------------------------------------------------------------------
// 한 번의 사이클: 등록된 모든 프로젝트를 순회하며 detect → run-jira-agent.sh 실행.
// 루프(loop-plan.sh/loop-build.sh)가 매 주기 이 스크립트를 호출한다.
// - projects.json / project-credentials.json 을 직접 읽어 프로젝트별 env 를 구성
// - 탐지: DASHBOARD_URL 있으면 /api/detect/<mode>?project=<id> 우선, 실패 시 detect-cards.sh 폴백
// - 카드별 run-jira-agent.sh 를 프로젝트 MAX_PARALLEL 만큼 동시 실행
// 출력은 stdout(상위 루프가 loop-<phase>.log 로 리다이렉트)
// --------------------------------------------------------------------------
const path = require("path");
const { spawn } = require("child_process");

// 프로젝트 설정 → 실행 env 구성은 run-epic-loop.js 와 공유(lib-project-env.js)
const { SELF, lib, reposToLines, resolveCardEnv, projectEnv, loadProjects, loadCreds } = require("./lib-project-env");
// 카드 첨부(이미지·문서) 다운로드는 공유 모듈 — 대시보드 단건 실행 경로도 같은 코드를 CLI 로 쓴다.
const { downloadCardAttachments } = require(path.join(SELF, "lib-attachments"));
const phase = process.argv[2];
if (!["plan", "build", "review"].includes(phase)) { console.error("usage: run-cycle.js <plan|build|review>"); process.exit(2); }

const ts = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const log = (m) => console.log(`[${ts()}] ${m}`);
// 카드 라벨 조회(프로젝트 자격증명) → 대상 repo 결정용
async function fetchLabels(cfg, cred, key) {
  if (!cred || !cred.atlassianEmail || !cred.atlassianToken || !cfg.jiraSite) return [];
  const auth = Buffer.from(`${cred.atlassianEmail}:${cred.atlassianToken}`).toString("base64");
  const r = await fetch(`https://${cfg.jiraSite}/rest/api/3/issue/${encodeURIComponent(key)}?fields=labels`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.fields && d.fields.labels) || [];
}

// 탐지: REST(대시보드) 우선, 실패 시 detect-cards.sh 폴백
async function detect(p, env) {
  const base = process.env.DASHBOARD_URL;
  if (base) {
    try {
      const r = await fetch(`${base}/api/detect/${phase}?project=${encodeURIComponent(p.id)}`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) { const j = await r.json(); if (j && j.ok) return j.keys || []; }
    } catch { /* 폴백 */ }
  }
  return await new Promise((resolve) => {
    let out = "";
    const c = spawn("bash", [path.join(SELF, "detect-cards.sh"), phase], { env });
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => resolve((out.match(/[A-Z][A-Z0-9]+-[0-9]+/g) || []).filter((v, i, a) => a.indexOf(v) === i)));
    c.on("error", () => resolve([]));
  });
}

async function runCard(key, env, cfg, cred) {
  const e = { ...env };
  try {
    const cardEnv = resolveCardEnv(cfg, key);   // 카드 전용 env(로컬) 우선
    e.CARD_REPOS = reposToLines(cfg, lib.cardRepos(cfg, await fetchLabels(cfg, cred, key)), cardEnv);
  } catch { /* 기본(전체) 사용 */ }
  // 카드 첨부(이미지+문서)를 내려받아 Claude Read 인식용 env 로 전달 — plan/build/review 모두 동일하게 적용.
  try {
    const att = await downloadCardAttachments(cfg, cred, key, log);
    if (att.images.length) { e.CARD_IMAGES = att.images.join("\n"); log(`[${key}] 카드 이미지 ${att.images.length}장 첨부(추론 인식)`); }
    if (att.docs.length) { e.CARD_DOCS = att.docs.join("\n"); log(`[${key}] 카드 문서 ${att.docs.length}개 첨부(추론 인식)`); }
  } catch { /* 첨부 없이 진행 */ }
  // review: PR 리뷰만 수행(run-review.sh). 요약 세팅 불필요.
  if (phase === "review") {
    return new Promise((resolve) => {
      const c = spawn("bash", [path.join(SELF, "run-review.sh"), key], { env: e, stdio: "inherit" });
      c.on("close", () => resolve());
      c.on("error", () => resolve());
    });
  }
  // 완료 내역 요약 저장 경로(claude 가 여기에 markdown 작성 → 스크립트가 설명 ADF 에 안전 append)
  const stateBase = cfg.cloneBase || path.join(cfg.workDir || SELF, "repos");
  e.SUMMARY_FILE = path.join(stateBase, ".state", `${key}.summary.md`);
  return new Promise((resolve) => {
    const c = spawn("bash", [path.join(SELF, "run-jira-agent.sh"), key, phase], { env: e, stdio: "inherit" });
    c.on("close", () => resolve());
    c.on("error", () => resolve());
  });
}

// 동시 실행 상한 적용
async function runWithCap(keys, env, cap, cfg, cred) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, cap) }, async () => {
    while (i < keys.length) { const k = keys[i++]; await runCard(k, env, cfg, cred); }
  });
  await Promise.all(workers);
}

(async () => {
  const projects = loadProjects();
  const creds = loadCreds();
  if (!projects.length) { log(`프로젝트가 없습니다 — 건너뜀`); return; }
  for (const p of projects) {
    const cred = creds[p.id];
    const { cfg, env } = projectEnv(p, cred);
    try {
      const keys = await detect(p, env);
      if (!keys.length) { log(`[${p.id}] ${phase} 대상 없음`); continue; }
      log(`[${p.id}] ${phase} 대상 ${keys.length}건: ${keys.join(", ")} (동시 ${cfg.maxParallel})`);
      await runWithCap(keys, env, cfg.maxParallel || 5, cfg, cred);
      log(`[${p.id}] ${phase} 사이클 완료`);
    } catch (e) {
      log(`[${p.id}] ${phase} 오류: ${String((e && e.message) || e)}`);
    }
  }
})();
