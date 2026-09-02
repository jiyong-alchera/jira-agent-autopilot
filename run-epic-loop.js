#!/usr/bin/env node
// run-epic-loop.js <EPIC-KEY>
// --------------------------------------------------------------------------
// 한 에픽의 하위 태스크를 '생성순으로 하나씩' 끝까지 개발한다.
//
// 태스크 한 건의 단계(lib.EPIC_STEPS):
//   prepare      claude-work + repo_<name> 라벨 부여(대상 repo 확정)
//   plan         run-jira-agent.sh <KEY> plan        (질문 코멘트 + claude-planned)
//   adopt        plan 이 남긴 '💡 제안:' 답변을 자동 채택 → 답변 코멘트 + claude-answered
//   build        REVIEW_LOOP_AFTER=1 run-jira-agent.sh <KEY> build
//                → PR 생성 후 run-review-loop.sh 가 '승인까지' 이어서 실행(기존 자산)
//   approve      열린 봇 PR 전부에 승인 마커(CLAUDE-REVIEW-APPROVED)가 있는지 확인
//   await-merge  사용자가 그 카드의 PR 을 모두 병합할 때까지 대기(카드가 완료되면 통과)
// 모든 태스크가 끝나면 에픽 완료.
//
// 어느 단계든 실패하면 상태를 'paused' 로 남기고 알림 후 종료한다. 대시보드의
// [이어서 진행]은 그 태스크의 그 단계부터, [건너뛰기]는 다음 단계부터 재개한다.
// 상태 파일 기반이라 대시보드/PC 를 재시작해도 멈춘 지점이 보존된다.
//
// 상태/제어 파일(<CLONE_BASE>/.state/):
//   <EPIC>.epic.lock(+.pid/.phase)  실행 중 락(에픽당 1개)
//   <EPIC>.epic.json                진행 상태(대시보드 폴링)
//   <EPIC>.epic.stop                중지 요청 플래그
//   <EPIC>.epic-design.md           에픽 설명(설계안) — 하위 태스크 프롬프트에 주입
//
// env: PROJECT_ID(필수), EPIC_REPOS(쉼표 구분 repo name), REVIEW_LOOP_MAX,
//      EPIC_MERGE_POLL(병합 대기 폴링 초, 기본 60), EPIC_RESUME_STEP·EPIC_RESUME_KEY(재개 지점),
//      DASHBOARD_URL(있으면 병합 동기화를 앞당김) — 그 외는 하위 스크립트가 쓰는 값 그대로
// --------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");

const { SELF, lib, reposToLines, resolveCardEnv, projectEnv, loadProjects, loadCreds } = require("./lib-project-env");
const { downloadCardAttachments } = require(path.join(SELF, "lib-attachments"));

const EPIC_KEY = process.argv[2];
if (!EPIC_KEY || !/^[A-Z][A-Z0-9]+-[0-9]+$/.test(EPIC_KEY)) {
  console.error("usage: run-epic-loop.js <EPIC-KEY>   (env: PROJECT_ID)");
  process.exit(2);
}
const PROJECT_ID = process.env.PROJECT_ID || "";
const MERGE_POLL_MS = Math.max(10, parseInt(process.env.EPIC_MERGE_POLL || "60", 10) || 60) * 1000;
const APPROVED_MARKER = lib.REVIEW_APPROVED_MARKER;

const ts = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const log = (m) => console.log(`[${ts()}] [epic ${EPIC_KEY}] ${m}`);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----- 프로젝트 해석 -----
const project = loadProjects().find((p) => p.id === PROJECT_ID) || loadProjects()[0];
if (!project) { console.error("프로젝트가 없습니다. 대시보드에서 먼저 등록하세요."); process.exit(2); }
const cred = loadCreds()[project.id] || {};
const { cfg, env: BASE_ENV } = projectEnv(project, cred);
if (!cfg.jiraSite || !cred.atlassianEmail || !cred.atlassianToken) {
  console.error("Jira 사이트/Atlassian 자격증명이 없습니다."); process.exit(2);
}
const HISTORY_FILE = BASE_ENV.HISTORY_FILE;
const STATE_DIR = path.join(cfg.cloneBase || path.join(cfg.workDir || SELF, "repos"), ".state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const LOCK_DIR = path.join(STATE_DIR, `${EPIC_KEY}.epic.lock`);
const STOP_FILE = path.join(STATE_DIR, `${EPIC_KEY}.epic.stop`);
const STATUS_FILE = path.join(STATE_DIR, `${EPIC_KEY}.epic.json`);
const DESIGN_FILE = path.join(STATE_DIR, `${EPIC_KEY}.epic-design.md`);

// 대상 repo — 시작 시 사용자가 고른 것. 비면 프로젝트 전체.
const allRepos = lib.normalizeRepos(cfg);
const pickedNames = String(process.env.EPIC_REPOS || "").split(",").map((s) => s.trim()).filter(Boolean);
const epicRepos = pickedNames.length ? allRepos.filter((r) => pickedNames.includes(r.name)) : allRepos;
if (!epicRepos.length) { console.error("대상 repo 가 없습니다."); process.exit(2); }

// ----- Jira REST -----
const jiraAuth = Buffer.from(`${cred.atlassianEmail}:${cred.atlassianToken}`).toString("base64");
async function jira(method, urlPath, body) {
  const r = await fetch(`https://${cfg.jiraSite}${urlPath}`, {
    method,
    headers: { Authorization: `Basic ${jiraAuth}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Jira ${method} ${urlPath} → ${r.status}: ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : {};
}
const jiraSearch = (jql) => jira("POST", "/rest/api/3/search/jql", { jql, maxResults: 100, fields: ["summary", "labels", "status", "created"] });
const addLabels = (key, labels) => jira("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: labels.map((l) => ({ add: l })) } });

// 하위 태스크 목록(미완료, 생성순). 태스크 경계마다 다시 조회해 중간에 추가된 카드도 반영한다.
// parent 절이 안 먹는 구형 프로젝트는 'Epic Link' 로 한 번 더 시도한다.
let CHILD_LINK = "parent";
async function fetchChildren() {
  let data;
  try { data = await jiraSearch(lib.epicChildrenJql(EPIC_KEY, cfg, CHILD_LINK)); }
  catch (e) {
    if (CHILD_LINK !== "parent") throw e;
    CHILD_LINK = "epic-link";
    data = await jiraSearch(lib.epicChildrenJql(EPIC_KEY, cfg, CHILD_LINK));
  }
  return (data.issues || []).map((i) => ({
    key: i.key,
    summary: (i.fields && i.fields.summary) || "",
    labels: (i.fields && i.fields.labels) || [],
    status: (i.fields && i.fields.status && i.fields.status.name) || "",
    done: false,
  }));
}
// 카드 1건의 현재 라벨·상태(단계 재판정용)
async function fetchTask(key) {
  const i = await jira("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,labels,status`);
  const status = (i.fields && i.fields.status) || {};
  const done = (status.statusCategory && status.statusCategory.key === "done")
    || lib.effectiveDoneStatuses(cfg).includes(status.name);
  return { key, summary: (i.fields && i.fields.summary) || "", labels: (i.fields && i.fields.labels) || [], status: status.name || "", done };
}

// ----- 알림 / 이력 -----
async function slack(text) {
  const url = cred.slackWebhookUrl;
  if (!url) return;
  try { await fetch(url, { method: "POST", headers: { "Content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) }); } catch {}
}
function history(key, result, extra) {
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({
      ts: nowIso(), project: project.id, key: key || EPIC_KEY, phase: "epic", result, pr: (extra && extra.pr) || "", branch: "",
    }) + "\n");
  } catch {}
}

// ----- 상태 파일 -----
let STATE = {
  epic: EPIC_KEY, project: project.id, repos: epicRepos.map((r) => r.name),
  startedAt: nowIso(), updatedAt: nowIso(), pid: process.pid,
  status: "running", reason: "", step: "", index: 0, total: 0,
  current: null, tasks: [],
};
function writeStatus(patch) {
  STATE = { ...STATE, ...(patch || {}), updatedAt: nowIso() };
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(STATE, null, 2)); } catch {}
}
// build 처럼 수십 분 걸리는 단계에서도 상태 파일이 갱신되도록 주기적으로 updatedAt 을 찍는다.
// (이게 없으면 대시보드가 '마지막 갱신 11분 전' 로 보여 멈춘 것처럼 읽힌다)
const HEARTBEAT_MS = 15000;
const heartbeat = setInterval(() => writeStatus({}), HEARTBEAT_MS);
heartbeat.unref?.();
const stopRequested = () => fs.existsSync(STOP_FILE);

// ----- 락 -----
try { fs.mkdirSync(LOCK_DIR); }
catch { console.log(`SKIP: [${EPIC_KEY}] 에픽 연속 개발이 이미 실행 중입니다(lock)`); process.exit(0); }
try { fs.unlinkSync(STOP_FILE); } catch {}
try { fs.writeFileSync(`${LOCK_DIR}.phase`, "epic"); fs.writeFileSync(`${LOCK_DIR}.pid`, String(process.pid)); } catch {}

let cleaned = false;
function cleanup(keepStatus) {
  if (cleaned) return; cleaned = true;
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
  for (const f of [`${LOCK_DIR}.phase`, `${LOCK_DIR}.pid`, STOP_FILE]) { try { fs.unlinkSync(f); } catch {} }
  if (!keepStatus) { try { fs.unlinkSync(STATUS_FILE); } catch {} }
}
// paused/done/stopped 는 상태 파일을 남긴다 — 대시보드가 사유를 보여주고 재개 버튼을 띄운다.
function finish(status, reason, code) {
  clearInterval(heartbeat);
  writeStatus({ status, reason: reason || "", pid: null });
  cleanup(true);
  process.exit(code || 0);
}
process.on("exit", () => cleanup(true));
let terminating = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (terminating) return; terminating = true;
    log(`중지 신호 — ${STATE.current ? `${STATE.current.key} ${STATE.step}` : "대기"} 에서 종료`);
    await slack(`⏹ [${EPIC_KEY}] 에픽 연속 개발 중지됨${STATE.current ? ` (${STATE.current.key} · ${STATE.step})` : ""}`);
    history(STATE.current && STATE.current.key, "stopped");
    finish("stopped", "사용자 중지", 130);
  });
}

// ----- 하위 스크립트 실행 -----
async function taskEnv(key) {
  const e = { ...BASE_ENV };
  e.CARD_REPOS = reposToLines(cfg, epicRepos, resolveCardEnv(cfg, key));   // 에픽에서 고른 repo 로 고정
  e.EPIC_KEY = EPIC_KEY;
  e.EPIC_SUMMARY = STATE.epicSummary || "";
  if (fs.existsSync(DESIGN_FILE)) e.EPIC_DESIGN_FILE = DESIGN_FILE;
  e.SUMMARY_FILE = path.join(STATE_DIR, `${key}.summary.md`);
  try {
    const att = await downloadCardAttachments(cfg, cred, key, log);
    if (att.images.length) e.CARD_IMAGES = att.images.join("\n");
    if (att.docs.length) e.CARD_DOCS = att.docs.join("\n");
  } catch { /* 첨부 없이 진행 */ }
  return e;
}
function runScript(script, args, env) {
  return new Promise((resolve) => {
    const c = spawn("bash", [path.join(SELF, script), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const pipe = (s) => s.on("data", (d) => { out += d; process.stdout.write(d); });
    pipe(c.stdout); pipe(c.stderr);
    c.on("close", (code) => resolve({ code: code == null ? 1 : code, out }));
    c.on("error", (e) => resolve({ code: 1, out: `${out}\n${e.message}` }));
  });
}
function ghJson(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { env: BASE_ENV, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout || "null")); } catch { resolve(null); }
    });
  });
}
const ownerRepo = (url) => String(url || "").replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "").split("/").slice(0, 2).join("/");

// 카드의 열린 봇 PR 들이 모두 승인 마커를 받았는지 확인. [{owner,number,url,approved}] 반환.
async function cardOpenPRs(key) {
  const prs = [];
  for (const r of epicRepos) {
    const or = ownerRepo(r.url);
    const list = await ghJson(["pr", "list", "--repo", or, "--search", key, "--state", "open", "--json", "number,url,title,headRefName,isDraft"]);
    for (const p of (list || [])) {
      if (p.isDraft) continue;
      const comments = await ghJson(["api", `repos/${or}/issues/${p.number}/comments?per_page=100`, "--jq", "[.[].body]"]);
      const approved = (comments || []).some((b) => String(b).includes(APPROVED_MARKER));
      prs.push({ owner: or, number: p.number, url: p.url, approved });
    }
  }
  return prs;
}

// ----- 단계 구현 -----
async function stepPrepare(task) {
  const want = [cfg.triggerLabel || "claude-work", ...epicRepos.map((r) => lib.REPO_LABEL_PREFIX + r.name)];
  const missing = want.filter((l) => !task.labels.includes(l));
  if (!missing.length) return { ok: true, note: "라벨 이미 설정됨" };
  await addLabels(task.key, missing);
  return { ok: true, note: `라벨 부여: ${missing.join(", ")}` };
}
async function stepPlan(task) {
  const { code } = await runScript("run-jira-agent.sh", [task.key, "plan"], await taskEnv(task.key));
  if (code !== 0) return { ok: false, reason: `plan 실행 실패 (exit ${code})` };
  const after = await fetchTask(task.key);
  if (!after.labels.includes(cfg.plannedLabel || "claude-planned")) {
    return { ok: false, reason: "plan 이 끝났지만 claude-planned 라벨이 없습니다(질문 코멘트 확인 필요)" };
  }
  return { ok: true };
}
async function stepAdopt(task) {
  const cs = await jira("GET", `/rest/api/3/issue/${encodeURIComponent(task.key)}/comment?maxResults=50`);
  const comments = (cs.comments || []).map((c) => ({ id: c.id, body: lib.adfToText(c.body) }));
  const suggested = lib.parseSuggestedAnswers(comments);
  if (!suggested) {
    return { ok: false, reason: "plan 질문에 '💡 제안:' 답변이 없어 자동 채택할 수 없습니다. 카드에 직접 답변한 뒤 이어서 진행하세요." };
  }
  const body = lib.buildAdoptedAnswerBody(suggested, EPIC_KEY);
  await jira("POST", `/rest/api/3/issue/${encodeURIComponent(task.key)}/comment`, { body: lib.buildReplyADF(body, suggested.commentId) });
  await addLabels(task.key, [cfg.answeredLabel || "claude-answered"]);
  return { ok: true, note: `제안 답변 ${suggested.count}건 자동 채택` };
}
async function stepBuild(task) {
  const e = await taskEnv(task.key);
  e.REVIEW_LOOP_AFTER = "1";                                        // PR 생성 후 '승인까지 리뷰 루프'로 이어짐
  e.REVIEW_LOOP_MAX = String(lib.clampReviewLoopMax(process.env.REVIEW_LOOP_MAX, cfg));
  const { code, out } = await runScript("run-jira-agent.sh", [task.key, "build"], e);
  if (code !== 0) return { ok: false, reason: `build 실행 실패 (exit ${code})` };
  if (/SKIP: awaiting answers/.test(out)) return { ok: false, reason: "build 가 답변 대기로 스킵됐습니다(카드 질문 확인 필요)" };
  const after = await fetchTask(task.key);
  if (!after.labels.includes(cfg.prOpenLabel || "claude-pr") && !after.done) {
    return { ok: false, reason: `build 가 끝났지만 PR 표시(${cfg.prOpenLabel || "claude-pr"} 라벨)가 없습니다` };
  }
  return { ok: true };
}
async function stepApprove(task) {
  const prs = await cardOpenPRs(task.key);
  if (!prs.length) return { ok: true, note: "열린 PR 없음(이미 병합됨)" };
  const pending = prs.filter((p) => !p.approved);
  if (pending.length) {
    return { ok: false, reason: `리뷰 승인이 남았습니다: ${pending.map((p) => `${p.owner}#${p.number}`).join(", ")}` };
  }
  return { ok: true, note: `PR ${prs.length}건 리뷰 승인 완료` };
}
// 사용자가 PR 을 모두 병합할 때까지 대기. 대시보드가 있으면 병합 동기화를 앞당겨 호출한다.
async function stepAwaitMerge(task) {
  await slack(`⏳ [${EPIC_KEY}] ${task.key} PR 병합 대기 중 — 병합하면 다음 태스크로 넘어갑니다.`);
  for (;;) {
    if (stopRequested()) return { ok: false, stop: true };
    const dash = process.env.DASHBOARD_URL;
    if (dash) {   // 외부 병합 감지를 3분 주기보다 앞당김(실패해도 무방 — 아래 상태 확인으로 판정)
      try { await fetch(`${dash}/api/cards/sync-merged?project=${encodeURIComponent(project.id)}`, { method: "POST", signal: AbortSignal.timeout(60000) }); } catch {}
    }
    let cur;
    try { cur = await fetchTask(task.key); } catch (e) { log(`상태 조회 실패(재시도): ${e.message}`); await sleep(MERGE_POLL_MS); continue; }
    if (cur.done) return { ok: true, note: `병합 완료 → ${cur.status}` };
    writeStatus({ current: { ...STATE.current, waitingSince: STATE.current && STATE.current.waitingSince ? STATE.current.waitingSince : nowIso() } });
    await sleep(MERGE_POLL_MS);
  }
}
const STEP_FN = { prepare: stepPrepare, plan: stepPlan, adopt: stepAdopt, build: stepBuild, approve: stepApprove, "await-merge": stepAwaitMerge };

// ----- 메인 -----
(async () => {
  // 에픽 설명(설계안)을 파일로 저장 → 하위 태스크 프롬프트에 주입
  let epicSummary = "";
  try {
    const ep = await jira("GET", `/rest/api/3/issue/${encodeURIComponent(EPIC_KEY)}?fields=summary,description`);
    epicSummary = (ep.fields && ep.fields.summary) || "";
    const design = lib.adfToText(ep.fields && ep.fields.description) || "";
    fs.writeFileSync(DESIGN_FILE, `# ${EPIC_KEY} ${epicSummary}\n\n${design}\n`);
  } catch (e) { log(`에픽 설명 조회 실패(설계안 없이 진행): ${e.message}`); }
  writeStatus({ epicSummary });

  log(`시작 · repo: ${epicRepos.map((r) => r.name).join(", ")}`);
  await slack(`🧭 [${EPIC_KEY}] 에픽 연속 개발 시작 — ${epicSummary || ""} · repo ${epicRepos.map((r) => r.name).join(", ")}`);
  history(EPIC_KEY, "started");

  // 재개 시 시작할 단계(대시보드 [이어서 진행]/[건너뛰기] 가 지정).
  // 멈췄던 그 카드에만 적용한다 — 그 사이 사람이 카드를 끝냈으면 다음 카드는 처음부터 판정한다.
  let resumeStep = process.env.EPIC_RESUME_STEP || "";
  const resumeKey = process.env.EPIC_RESUME_KEY || "";
  let doneCount = 0;

  for (;;) {
    if (stopRequested()) { await slack(`⏹ [${EPIC_KEY}] 에픽 연속 개발 중지됨`); history(EPIC_KEY, "stopped"); finish("stopped", "사용자 중지"); }

    let children;
    try { children = await fetchChildren(); }
    catch (e) { await slack(`❌ [${EPIC_KEY}] 하위 태스크 조회 실패 — ${e.message}`); finish("paused", `하위 태스크 조회 실패: ${e.message}`, 1); }

    const next = lib.nextEpicTask(children, cfg);
    writeStatus({
      total: doneCount + children.length,
      index: doneCount,
      tasks: children.map((t) => ({ key: t.key, summary: t.summary, status: t.status, state: next && t.key === next.key ? "current" : "pending" })),
    });
    if (!next) break;   // 남은 하위 태스크 없음 → 에픽 완료

    const useResume = resumeStep && (!resumeKey || resumeKey === next.key);
    let step = useResume ? resumeStep : next.step;
    resumeStep = "";
    log(`태스크 ${next.key} — ${next.summary} (시작 단계: ${step})`);
    await slack(`▶️ [${EPIC_KEY}] ${next.key} 처리 시작 (${doneCount + 1}/${doneCount + children.length}) · ${next.summary}`);

    let task = next;
    while (step) {
      if (stopRequested()) { await slack(`⏹ [${EPIC_KEY}] 에픽 연속 개발 중지됨 (${task.key} · ${step})`); history(task.key, "stopped"); finish("stopped", "사용자 중지"); }
      writeStatus({ step, stepStartedAt: nowIso(), current: { key: task.key, summary: task.summary, step } });
      log(`${task.key} · ${step} …`);
      let r;
      try { r = await STEP_FN[step](task); }
      catch (e) { r = { ok: false, reason: `${step} 오류: ${String((e && e.message) || e)}` }; }
      if (r && r.stop) { await slack(`⏹ [${EPIC_KEY}] 에픽 연속 개발 중지됨 (${task.key} · ${step})`); history(task.key, "stopped"); finish("stopped", "사용자 중지"); }
      if (!r || !r.ok) {
        const reason = (r && r.reason) || `${step} 실패`;
        log(`중단: ${reason}`);
        await slack(`⏸ [${EPIC_KEY}] ${task.key} · ${step} 에서 중단 — ${reason}\n대시보드에서 조치 후 [이어서 진행] 하세요.`);
        history(task.key, "paused");
        finish("paused", `${task.key} · ${step}: ${reason}`, 1);
      }
      if (r.note) log(`${task.key} · ${step} ✓ ${r.note}`);
      step = lib.nextEpicStep(step);
      if (step) { try { task = { ...task, ...(await fetchTask(task.key)) }; } catch {} }
    }

    doneCount += 1;
    log(`태스크 ${task.key} 완료 (${doneCount})`);
    await slack(`✅ [${EPIC_KEY}] ${task.key} 완료 — 다음 태스크로 진행합니다.`);
    history(task.key, "task-done");
  }

  log(`에픽 완료 — 하위 태스크 ${doneCount}건 처리`);
  await slack(`🎉 [${EPIC_KEY}] 에픽 연속 개발 완료 — 하위 태스크 ${doneCount}건 처리`);
  history(EPIC_KEY, "done");
  finish("done", `하위 태스크 ${doneCount}건 완료`);
})().catch(async (e) => {
  log(`오류: ${String((e && e.stack) || e)}`);
  await slack(`❌ [${EPIC_KEY}] 에픽 연속 개발 오류 — ${String((e && e.message) || e)}`);
  history(EPIC_KEY, "failed");
  finish("paused", String((e && e.message) || e), 1);
});
