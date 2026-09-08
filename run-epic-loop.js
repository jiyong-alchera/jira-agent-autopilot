#!/usr/bin/env node
// run-epic-loop.js <EPIC-KEY>
// --------------------------------------------------------------------------
// 한 상위 카드(에픽 계층 — 프로젝트에 따라 '에픽' · '워크스트림' 등으로 불린다)의 하위 태스크를
// '생성순으로 하나씩' 끝까지 개발한다. 하위는 parent 로만 찾으므로 타입 이름과 무관하게 동작한다.
//
// 태스크 한 건의 단계(lib.EPIC_STEPS):
//   prepare      claude-work + repo_<name> 라벨 부여(대상 repo 확정)
//   plan         run-jira-agent.sh <KEY> plan        (질문 코멘트 + claude-planned)
//   adopt        plan 이 남긴 '💡 제안:' 답변을 자동 채택 → 답변 코멘트 + claude-answered
//   build        REVIEW_LOOP_AFTER=1 run-jira-agent.sh <KEY> build
//                → PR 생성 후 run-review-loop.sh 가 '승인까지' 이어서 실행(기존 자산)
//   ci           PR 의 CI 를 확인해 깨졌으면 '원인 파악 → 수정/재실행 → 재검증' 을 초록까지 반복
//                (CI 수정 커밋이 생기면 기존 승인을 무효화하고 리뷰 루프를 다시 태운다)
//   approve      열린 봇 PR 전부에 승인 마커(CLAUDE-REVIEW-APPROVED)가 있는지 확인
//   await-merge  사용자가 그 카드의 PR 을 모두 병합할 때까지 대기(카드가 완료되면 통과)
//                자동 병합은 승인 + CI 초록일 때만 — 대기 중 base 가 움직여 깨진 회귀를 여기서 다시 막는다
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
//      EPIC_CI_LOOP_MAX(CI 수정 반복 한도, 기본 5), EPIC_CI_POLL(CI 폴링 초, 기본 30),
//      EPIC_CI_WAIT_MAX_MIN(CI 완료 대기 한도 분, 기본 40),
//      EPIC_MERGE_POLL(병합 대기 폴링 초, 기본 60), EPIC_RESUME_STEP·EPIC_RESUME_KEY(재개 지점),
//      EPIC_AUTO_MERGE(1=승인 후 자동 병합)·EPIC_AUTO_MERGE_AFTER_MIN(대기 분, 기본 60),
//      EPIC_LABEL(상위 카드 표시 이름, 기본 "에픽" — 로그·Slack·Jira 코멘트 문구에만 쓰임),
//      DASHBOARD_URL(병합 동기화 가속 + 자동 병합 경로) — 그 외는 하위 스크립트가 쓰는 값 그대로
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
// 상위 카드를 프로젝트가 부르는 이름(에픽 · 워크스트림 …). 대시보드가 이슈 타입 메타에서 뽑아 넘긴다.
const EPIC_LABEL = process.env.EPIC_LABEL || lib.EPIC_LABEL_FALLBACK;
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
// 실행 중에도 대시보드가 바꿀 수 있는 옵션(자동 병합 on/off·대기 시간). 러너는 폴링할 때마다 다시 읽는다.
const OPTS_FILE = path.join(STATE_DIR, `${EPIC_KEY}.epic.opts.json`);
const DEFAULT_OPTS = {
  autoMerge: process.env.EPIC_AUTO_MERGE === "1",
  autoMergeAfterMin: lib.clampAutoMergeMin(process.env.EPIC_AUTO_MERGE_AFTER_MIN),
};
function readOpts() {
  try {
    const o = JSON.parse(fs.readFileSync(OPTS_FILE, "utf8"));
    return { autoMerge: !!o.autoMerge, autoMergeAfterMin: lib.clampAutoMergeMin(o.autoMergeAfterMin) };
  } catch { return DEFAULT_OPTS; }
}

// 대상 repo — 시작 시 사용자가 고른 것. **비어 있으면 전체로 넓히지 않고 실패한다**:
// 예전엔 빈 값을 '프로젝트 전체'로 해석했는데, 상태 파일이 낡거나 깨져 repos 가 비면 재개가
// 조용히 전 repo 로 번졌다(고른 적 없는 repo 에 PR 이 열린다). 넓히는 실수는 되돌리기 비싸므로 멈춘다.
const allRepos = lib.normalizeRepos(cfg);
const pickedNames = String(process.env.EPIC_REPOS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!pickedNames.length) {
  console.error("대상 repo 가 지정되지 않았습니다(EPIC_REPOS). 전체로 넓히지 않고 종료합니다 — 대시보드에서 repo 를 골라 새로 시작하세요.");
  process.exit(2);
}
const unknown = pickedNames.filter((n) => !allRepos.some((r) => r.name === n));
const epicRepos = allRepos.filter((r) => pickedNames.includes(r.name));
if (!epicRepos.length) { console.error(`대상 repo 가 프로젝트에 없습니다: ${pickedNames.join(", ")}`); process.exit(2); }
if (unknown.length) console.log(`[warn] 프로젝트에 없는 repo 는 무시합니다: ${unknown.join(", ")}`);

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
// 한 번의 PUT 으로 추가·제거를 함께 적용(중간 상태가 남지 않게).
const editLabels = (key, add, remove) => jira("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, {
  update: { labels: [...add.map((l) => ({ add: l })), ...remove.map((l) => ({ remove: l }))] },
});

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
async function slack(text, actions) {
  const url = cred.slackWebhookUrl;
  if (!url) return;
  // actions 가 있으면 Block Kit 버튼을 붙인다 — Slack 에서 바로 병합·재개할 수 있다.
  const payload = actions && actions.length ? lib.slackMessage(text, actions) : { text };
  try { await fetch(url, { method: "POST", headers: { "Content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) }); } catch {}
}
// 이 에픽 실행에 대한 버튼 묶음(프로젝트·에픽 키는 항상 같다)
const epicBtn = (...ids) => ids.map((id) => ({ id, project: project.id, key: EPIC_KEY }));
function history(key, result, extra) {
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({
      ts: nowIso(), project: project.id, key: key || EPIC_KEY, phase: "epic", result, pr: (extra && extra.pr) || "", branch: "",
    }) + "\n");
  } catch {}
}

// ----- 상태 파일 -----
let STATE = {
  epic: EPIC_KEY, label: EPIC_LABEL, project: project.id, repos: epicRepos.map((r) => r.name),
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
catch { console.log(`SKIP: [${EPIC_KEY}] ${EPIC_LABEL} 연속 개발이 이미 실행 중입니다(lock)`); process.exit(0); }
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
function finish(status, reason, code, extra) {
  clearInterval(heartbeat);
  writeStatus({ status, reason: reason || "", pid: null, ...(extra || {}) });
  cleanup(true);
  process.exit(code || 0);
}
process.on("exit", () => cleanup(true));
let terminating = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    if (terminating) return; terminating = true;
    log(`중지 신호 — ${STATE.current ? `${STATE.current.key} ${STATE.step}` : "대기"} 에서 종료`);
    await slack(`⏹ [${EPIC_KEY}] ${EPIC_LABEL} 연속 개발 중지됨${STATE.current ? ` (${STATE.current.key} · ${STATE.step})` : ""}`);
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
// 실패 사유 분류용으로 엔진 출력의 끝부분만 남긴다(사용량 한도 메시지·해제 시각이 여기 찍힌다).
const tailOf = (out, n = 2000) => String(out || "").slice(-n);
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
// 실패를 '결과 없음'으로 삼키지 않는 판. 승인·CI 판정처럼 '못 물어본 것'과 '없는 것'을 구분해야
// 하는 자리에 쓴다 — 조용히 빈 배열을 주면 미승인 PR 이 승인된 것처럼, CI 실패가 없는 것처럼 보인다.
function ghJsonStrict(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { env: BASE_ENV, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gh ${args.slice(0, 2).join(" ")} 실패: ${String(stderr || err.message).trim().slice(0, 200)}`));
      try { resolve(JSON.parse(stdout || "null")); } catch (e) { reject(new Error(`gh 출력 파싱 실패: ${e.message}`)); }
    });
  });
}
const ownerRepo = (url) => String(url || "").replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "").split("/").slice(0, 2).join("/");

// 카드의 열린 봇 PR 들 — 승인 마커와 CI 상태를 함께 판정한다.
// [{owner,number,url,sha,approved,ci,ciFailed}] 반환. gh 조회가 실패하면 throw 한다(빈 배열로 삼키지 않음).
async function cardOpenPRs(key) {
  const prs = [];
  for (const r of epicRepos) {
    const or = ownerRepo(r.url);
    const list = await ghJsonStrict(["pr", "list", "--repo", or, "--search", key, "--state", "open",
      "--json", "number,url,title,headRefName,headRefOid,isDraft,statusCheckRollup"]);
    for (const p of (list || [])) {
      if (p.isDraft) continue;
      // --search 는 PR 본문까지 훑어 형제 카드의 PR 까지 잡는다 → 브랜치/제목으로 이 카드 것만 남긴다.
      if (!lib.prBelongsToCard({ branch: p.headRefName, title: p.title }, key)) continue;
      const comments = await ghJsonStrict(["api", `repos/${or}/issues/${p.number}/comments?per_page=100`, "--jq", "[.[].body]"]);
      const approved = (comments || []).some((b) => String(b).includes(APPROVED_MARKER));
      prs.push({
        owner: or, number: p.number, url: p.url, sha: p.headRefOid || "", approved,
        ci: lib.ciStateOf(p.statusCheckRollup), ciFailed: lib.failedChecks(p.statusCheckRollup),
      });
    }
  }
  return prs;
}

// 대시보드를 통해 이 카드의 자동화 PR 을 병합한다.
// gh 로 직접 머지하지 않는 이유: 대시보드 병합 경로가 '병합 + 카드 완료 전환 + 완료 내역 최종 갱신 +
// clone 정리' 를 함께 처리하기 때문. 카드가 완료돼야 await-merge 가 통과하므로 이 경로를 써야 한다.
async function mergeViaDashboard() {
  const dash = process.env.DASHBOARD_URL;
  if (!dash) return { ok: false, message: "DASHBOARD_URL 이 없어 자동 병합을 할 수 없습니다(대시보드 필요)." };
  try {
    const r = await fetch(`${dash}/api/cards/${encodeURIComponent(STATE.current.key)}/merge?project=${encodeURIComponent(project.id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(300000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j || !j.ok) return { ok: false, message: (j && (j.message || (j.errors || [])[0])) || `HTTP ${r.status}` };
    return { ok: true, merged: j.merged || 0, doneStatus: j.doneStatus || "", errors: j.errors || [] };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
}

// ----- 단계 구현 -----
// 카드의 라벨을 이번 실행의 repo 선택에 맞춘다 — 부족한 건 붙이고, 이번 실행에 없는 repo_ 는 지운다.
// 안 지우면 카드 단위 경로(run-cycle.js 예약 루프 · 대시보드 개별 실행)가 그 라벨을 보고 뺀 repo 까지
// 개발한다(러너 자신은 CARD_REPOS 를 쓰므로 영향 없음).
// **prepare 단계가 아니라 태스크 진입마다** 부른다 — 이미 claude-work 가 붙은 카드는 시작 단계가
// plan/build 라 prepare 를 건너뛰는데, 스테일 라벨이 남는 건 바로 그 카드들이기 때문.
async function syncTaskLabels(task) {
  const { add, remove } = lib.epicPrepareLabelDiff(task.labels, epicRepos.map((r) => r.name), cfg);
  if (!add.length && !remove.length) return { changed: false, note: "라벨 이미 설정됨" };
  await editLabels(task.key, add, remove);
  const note = [add.length ? `부여: ${add.join(", ")}` : "", remove.length ? `제거: ${remove.join(", ")}` : ""].filter(Boolean).join(" · ");
  return { changed: true, note: `라벨 ${note}` };
}
async function stepPrepare(task) {
  const r = await syncTaskLabels(task);
  return { ok: true, note: r.note };
}
async function stepPlan(task) {
  const { code, out } = await runScript("run-jira-agent.sh", [task.key, "plan"], await taskEnv(task.key));
  if (code !== 0) return { ok: false, reason: `plan 실행 실패 (exit ${code})`, lastError: tailOf(out) };
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
  const body = lib.buildAdoptedAnswerBody(suggested, EPIC_KEY, EPIC_LABEL);
  await jira("POST", `/rest/api/3/issue/${encodeURIComponent(task.key)}/comment`, { body: lib.buildReplyADF(body, suggested.commentId) });
  await addLabels(task.key, [cfg.answeredLabel || "claude-answered"]);
  return { ok: true, note: `제안 답변 ${suggested.count}건 자동 채택` };
}
async function stepBuild(task) {
  const e = await taskEnv(task.key);
  e.REVIEW_LOOP_AFTER = "1";                                        // PR 생성 후 '승인까지 리뷰 루프'로 이어짐
  e.REVIEW_LOOP_MAX = String(lib.clampReviewLoopMax(process.env.REVIEW_LOOP_MAX, cfg));
  const { code, out } = await runScript("run-jira-agent.sh", [task.key, "build"], e);
  if (code !== 0) return { ok: false, reason: `build 실행 실패 (exit ${code})`, lastError: tailOf(out) };
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
// ----- ci 단계: CI 가 깨졌으면 원인을 파악해 고치고 초록으로 만든다 -----
// 회차마다 '한 가지 일'만 한다 — CI 실패면 수정, 수정 커밋이 쌓였으면 재리뷰. 그리고 다시 판정한다.
// 재리뷰가 필요한 이유: CI 를 고치면 코드가 바뀌는데, 그 커밋은 아무도 리뷰하지 않은 채로 병합된다.
const CI_POLL_MS = Math.max(10, parseInt(process.env.EPIC_CI_POLL || "30", 10) || 30) * 1000;
const CI_WAIT_MAX_MS = Math.max(1, parseInt(process.env.EPIC_CI_WAIT_MAX_MIN || "40", 10) || 40) * 60000;
const CI_SETTLE_MS = 20000;        // 푸시·재실행 직후 새 체크가 등록될 때까지의 여유
const CI_NONE_GRACE_MS = 180000;   // '체크 없음'을 '아직 안 올라옴'으로 보는 구간(3분)
const CI_PUSHED_MARK = "CI_FIX_PUSHED";   // run-jira-agent.sh 의 CI_PUSHED_MARK 와 같아야 함
const SUPERSEDED_MARKER = "CLAUDE-REVIEW-SUPERSEDED-BY-CI-FIX";

async function prCiState(or, number) {
  const p = await ghJsonStrict(["pr", "view", String(number), "--repo", or, "--json", "state,headRefOid,statusCheckRollup"]);
  return {
    prState: (p && p.state) || "", sha: (p && p.headRefOid) || "",
    state: lib.ciStateOf(p && p.statusCheckRollup), failed: lib.failedChecks(p && p.statusCheckRollup),
  };
}
// CI 가 확정될 때까지(도는 체크가 없어질 때까지) 기다린다.
async function waitCi(or, number) {
  const until = Date.now() + CI_WAIT_MAX_MS;
  const graceUntil = Date.now() + CI_NONE_GRACE_MS;
  for (;;) {
    if (stopRequested()) return { stop: true };
    const c = await prCiState(or, number);
    if (c.prState && c.prState !== "OPEN") return { ...c, closed: true };
    // 체크가 아직 하나도 없으면 '없는 repo'인지 '방금 푸시해 아직 안 올라온 것'인지 알 수 없다 → 잠깐 기다려 본다.
    if (c.state !== "pending" && !(c.state === "none" && Date.now() < graceUntil)) return c;
    if (Date.now() >= until) return { ...c, timeout: true };
    await sleep(CI_POLL_MS);
  }
}
// CI 수정 커밋이 올라오면 기존 리뷰 승인은 무효다. 승인 마커를 남의 코멘트를 지우지 않고 무력화한다
// (봇이 쓴 자기 코멘트만 편집 — 마커 문자열을 바꾸고 무효 사유를 덧붙인다).
async function supersedeApproval(or, number) {
  const comments = await ghJsonStrict(["api", `repos/${or}/issues/${number}/comments?per_page=100`, "--jq", "[.[] | {id, body}]"]);
  const file = path.join(STATE_DIR, `${EPIC_KEY}.ci-supersede.md`);
  let n = 0;
  for (const c of (comments || [])) {
    const body = String((c && c.body) || "");
    if (!body.includes(APPROVED_MARKER)) continue;
    fs.writeFileSync(file, `${body.split(APPROVED_MARKER).join(SUPERSEDED_MARKER)}\n\n> ⚠️ CI 수정 커밋이 올라와 이 승인은 무효화됐습니다(${nowIso()}). 재리뷰가 진행됩니다.\n`);
    await ghJsonStrict(["api", "-X", "PATCH", `repos/${or}/issues/comments/${c.id}`, "-F", `body=@${file}`]);
    n += 1;
  }
  try { fs.unlinkSync(file); } catch {}
  return n;
}

async function ciFixLoop(task, pr, max) {
  const tag = `${pr.owner}#${pr.number}`;
  let pendingReview = false;   // CI 수정 커밋이 쌓여 재리뷰가 필요한 상태
  let last = null;
  for (let i = 1; i <= max; i++) {
    if (stopRequested()) return { ok: false, stop: true };
    const c = await waitCi(pr.owner, pr.number);
    if (c.stop) return { ok: false, stop: true };
    if (c.closed) return { ok: true, note: `${tag} PR 이 ${c.prState} → 건너뜀` };
    if (c.timeout) return { ok: false, reason: `${tag} CI 가 ${CI_WAIT_MAX_MS / 60000}분 안에 끝나지 않았습니다(아직 진행 중). 확인 후 [이어서 진행] 하세요.` };
    last = c;

    if (c.state === "fail") {
      const names = c.failed.map((f) => f.name).join(", ");
      log(`${task.key} ${tag} CI 실패(${names}) → 수정 ${i}/${max} 회차`);
      await slack(`🧪 [${EPIC_KEY}] ${task.key} — CI 실패 수정 ${i}/${max} 회차 · ${tag} · 실패: ${names}`);
      const e = await taskEnv(task.key);
      e.CI_FIX = "1";
      e.REWORK_ONLY_OWNER = pr.owner;
      e.REWORK_ONLY_NUM = String(pr.number);
      e.CI_FAILED_CHECKS = c.failed.map((f) => `- ${f.name} (${f.conclusion}) ${f.url}`).join("\n");
      // 연쇄 실행 플래그는 끊는다 — CI 수정이 리뷰 루프를 또 띄우면 중첩 실행이 락에 막힌다.
      e.REVIEW_LOOP_AFTER = ""; e.REVIEW_AFTER = ""; e.REVIEW_FIRST = ""; e.IN_REVIEW_LOOP = "1";
      const { code, out } = await runScript("run-jira-agent.sh", [task.key, "build"], e);
      if (stopRequested()) return { ok: false, stop: true };
      if (code !== 0) return { ok: false, reason: `${tag} CI 수정 실행 실패 (exit ${code})`, lastError: tailOf(out) };
      if (out.includes(CI_PUSHED_MARK)) pendingReview = true;
      await sleep(CI_SETTLE_MS);
      continue;
    }

    // 여기부터는 CI 초록(또는 체크 없음).
    if (!pendingReview) return { ok: true, note: `${tag} CI ${c.state === "none" ? "체크 없음" : "통과"}${i > 1 ? ` (${i - 1}회 수정)` : ""}` };

    // CI 수정 커밋은 아무도 안 본 코드다 → 기존 승인을 무효화하고 리뷰 루프를 다시 태운다.
    log(`${task.key} ${tag} CI 초록 · CI 수정 커밋 재리뷰 (${i}/${max} 회차)`);
    await slack(`🔁 [${EPIC_KEY}] ${task.key} — CI 수정 커밋에 대해 재리뷰합니다 · ${tag}`);
    try {
      const n = await supersedeApproval(pr.owner, pr.number);
      if (n) log(`${task.key} ${tag} 기존 리뷰 승인 ${n}건 무효화`);
    } catch (e) { return { ok: false, reason: `${tag} 기존 승인 무효화 실패: ${e.message}` }; }
    const re = await taskEnv(task.key);
    re.REVIEW_FIRST = "1";   // 방금 고친 코드라 반영할 리뷰 의견이 아직 없다 → 리뷰부터
    re.REVIEW_LOOP_MAX = String(lib.clampReviewLoopMax(process.env.REVIEW_LOOP_MAX, cfg));
    const { code } = await runScript("run-review-loop.sh", [task.key, pr.owner, String(pr.number)], re);
    if (stopRequested()) return { ok: false, stop: true };
    if (code !== 0) return { ok: false, reason: `${tag} CI 수정분 재리뷰 실패 (exit ${code})` };
    pendingReview = false;
    await sleep(CI_SETTLE_MS);   // 재리뷰가 반영 커밋을 더했을 수 있으니 CI 를 다시 본다
  }
  const names = last && last.failed ? last.failed.map((f) => f.name).join(", ") : "";
  return { ok: false, reason: `${tag} CI 수정 반복 ${max}회 후에도 정리되지 않았습니다${names ? ` (실패: ${names})` : ""}. 로그를 확인한 뒤 [이어서 진행] 하세요.` };
}

async function stepCi(task) {
  const prs = await cardOpenPRs(task.key);
  if (!prs.length) return { ok: true, note: "열린 PR 없음(이미 병합됨)" };
  const max = lib.clampCiLoopMax(process.env.EPIC_CI_LOOP_MAX, cfg);
  const notes = [];
  for (const pr of prs) {
    const r = await ciFixLoop(task, pr, max);
    if (!r.ok) return r;
    notes.push(r.note);
  }
  return { ok: true, note: notes.join(" · ") };
}

// 사용자가 PR 을 모두 병합할 때까지 대기. 대시보드가 있으면 병합 동기화를 앞당겨 호출한다.
// 자동 병합이 켜져 있으면, 대기 시간이 지나고 열린 PR 이 '모두 리뷰 승인' 된 경우 대신 병합한다.
async function stepAwaitMerge(task) {
  const waitStartedAt = STATE.stepStartedAt || nowIso();
  const o0 = readOpts();
  await slack(`⏳ [${EPIC_KEY}] ${task.key} PR 병합 대기 중 — 병합하면 다음 태스크로 넘어갑니다.`
    + (o0.autoMerge ? ` (승인 상태로 ${o0.autoMergeAfterMin}분 경과 시 자동 병합)` : ""),
    [{ id: "merge", project: project.id, key: task.key }, ...epicBtn("epic-stop")]);
  let autoMergeTried = false;
  for (;;) {
    if (stopRequested()) return { ok: false, stop: true };
    const dash = process.env.DASHBOARD_URL;
    if (dash) {   // 외부 병합 감지를 3분 주기보다 앞당김(실패해도 무방 — 아래 상태 확인으로 판정)
      try { await fetch(`${dash}/api/cards/sync-merged?project=${encodeURIComponent(project.id)}`, { method: "POST", signal: AbortSignal.timeout(60000) }); } catch {}
    }
    let cur;
    try { cur = await fetchTask(task.key); } catch (e) { log(`상태 조회 실패(재시도): ${e.message}`); await sleep(MERGE_POLL_MS); continue; }
    if (cur.done) return { ok: true, note: `병합 완료 → ${cur.status}` };

    // 자동 병합 판정 — 옵션은 매 회 다시 읽어 실행 중 on/off 가 바로 반영되게 한다.
    const opts = readOpts();
    let openPRs = [], prsErr = "";
    if (opts.autoMerge) { try { openPRs = await cardOpenPRs(task.key); } catch (e) { prsErr = e.message; } }
    // 조회 자체가 실패한 회차는 판정하지 않는다 — '못 물어봤다'를 '열린 PR 이 없다'로 읽으면
    // 승인·CI 게이트를 통째로 건너뛰게 된다. 다음 폴링에서 다시 본다.
    const d = prsErr ? { merge: false, reason: "pr-lookup-failed" }
      : lib.shouldAutoMerge(opts, waitStartedAt, openPRs, Date.now());
    if (prsErr) log(`PR 상태 조회 실패(다음 폴링에서 재시도): ${prsErr}`);
    writeStatus({
      waitStartedAt, autoMerge: opts.autoMerge, autoMergeAfterMin: opts.autoMergeAfterMin,
      autoMergeAt: d.dueMs ? new Date(d.dueMs).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
      autoMergeState: d.reason,
      current: { ...STATE.current, waitingSince: waitStartedAt },
    });
    if (d.merge && !autoMergeTried) {
      autoMergeTried = true;   // 한 번만 시도 — 실패하면 사람이 봐야 한다(무한 재시도로 PR 을 계속 두드리지 않는다)
      log(`${task.key} 승인 상태로 ${opts.autoMergeAfterMin}분 경과 → 자동 병합 시도 (PR ${openPRs.length}건)`);
      await slack(`🤖 [${EPIC_KEY}] ${task.key} — 리뷰 승인 후 ${opts.autoMergeAfterMin}분간 병합되지 않아 자동 병합합니다 (PR ${openPRs.length}건).`);
      const r = await mergeViaDashboard();
      if (r.ok) {
        log(`${task.key} 자동 병합 완료 (${r.merged}건${r.doneStatus ? ` · 카드 ${r.doneStatus}` : ""})`);
        await slack(`✅ [${EPIC_KEY}] ${task.key} 자동 병합 완료 — PR ${r.merged}건${r.doneStatus ? ` · 카드 ${r.doneStatus}` : ""}`);
        continue;   // 다음 폴링에서 카드 완료를 확인하고 다음 태스크로
      }
      log(`${task.key} 자동 병합 실패: ${r.message}`);
      return { ok: false, reason: `자동 병합 실패 — ${r.message}. PR 상태(충돌·권한)를 확인한 뒤 직접 병합하거나 [이어서 진행] 하세요.` };
    }
    await sleep(MERGE_POLL_MS);
  }
}
const STEP_FN = { prepare: stepPrepare, plan: stepPlan, adopt: stepAdopt, build: stepBuild, ci: stepCi, approve: stepApprove, "await-merge": stepAwaitMerge };

// ----- 메인 -----
(async () => {
  // 에픽 설명(설계안)을 파일로 저장 → 하위 태스크 프롬프트에 주입
  let epicSummary = "";
  try {
    const ep = await jira("GET", `/rest/api/3/issue/${encodeURIComponent(EPIC_KEY)}?fields=summary,description`);
    epicSummary = (ep.fields && ep.fields.summary) || "";
    const design = lib.adfToText(ep.fields && ep.fields.description) || "";
    fs.writeFileSync(DESIGN_FILE, `# ${EPIC_KEY} ${epicSummary}\n\n${design}\n`);
  } catch (e) { log(`${EPIC_LABEL} 설명 조회 실패(설계안 없이 진행): ${e.message}`); }
  writeStatus({ epicSummary });

  log(`시작 · repo: ${epicRepos.map((r) => r.name).join(", ")}`);
  await slack(`🧭 [${EPIC_KEY}] ${EPIC_LABEL} 연속 개발 시작 — ${epicSummary || ""} · repo ${epicRepos.map((r) => r.name).join(", ")}`);
  history(EPIC_KEY, "started");

  // 재개 시 시작할 단계(대시보드 [이어서 진행]/[건너뛰기] 가 지정).
  // 멈췄던 그 카드에만 적용한다 — 그 사이 사람이 카드를 끝냈으면 다음 카드는 처음부터 판정한다.
  let resumeStep = process.env.EPIC_RESUME_STEP || "";
  const resumeKey = process.env.EPIC_RESUME_KEY || "";
  let doneCount = 0;

  for (;;) {
    if (stopRequested()) { await slack(`⏹ [${EPIC_KEY}] ${EPIC_LABEL} 연속 개발 중지됨`); history(EPIC_KEY, "stopped"); finish("stopped", "사용자 중지"); }

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
    // 어느 단계에서 시작하든 라벨부터 이번 실행 기준으로 맞춘다(prepare 를 건너뛰는 카드 포함).
    try {
      const sync = await syncTaskLabels(task);
      if (sync.changed) log(`${task.key} · ${sync.note}`);
    } catch (e) { log(`${task.key} · 라벨 동기화 실패(계속 진행): ${e.message}`); }

    while (step) {
      if (stopRequested()) { await slack(`⏹ [${EPIC_KEY}] ${EPIC_LABEL} 연속 개발 중지됨 (${task.key} · ${step})`); history(task.key, "stopped"); finish("stopped", "사용자 중지"); }
      writeStatus({ step, stepStartedAt: nowIso(), current: { key: task.key, summary: task.summary, step } });
      log(`${task.key} · ${step} …`);
      let r;
      try { r = await STEP_FN[step](task); }
      catch (e) { r = { ok: false, reason: `${step} 오류: ${String((e && e.message) || e)}` }; }
      if (r && r.stop) { await slack(`⏹ [${EPIC_KEY}] ${EPIC_LABEL} 연속 개발 중지됨 (${task.key} · ${step})`); history(task.key, "stopped"); finish("stopped", "사용자 중지"); }
      if (!r || !r.ok) {
        const reason = (r && r.reason) || `${step} 실패`;
        log(`중단: ${reason}`);
        await slack(`⏸ [${EPIC_KEY}] ${task.key} · ${step} 에서 중단 — ${reason}`, epicBtn("epic-resume", "epic-skip", "epic-stop"));
        history(task.key, "paused");
        finish("paused", `${task.key} · ${step}: ${reason}`, 1, { lastError: r.lastError || "", pausedAt: nowIso() });
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

  log(`${EPIC_LABEL} 완료 — 하위 태스크 ${doneCount}건 처리`);
  await slack(`🎉 [${EPIC_KEY}] ${EPIC_LABEL} 연속 개발 완료 — 하위 태스크 ${doneCount}건 처리`);
  history(EPIC_KEY, "done");
  finish("done", `하위 태스크 ${doneCount}건 완료`);
})().catch(async (e) => {
  log(`오류: ${String((e && e.stack) || e)}`);
  await slack(`❌ [${EPIC_KEY}] ${EPIC_LABEL} 연속 개발 오류 — ${String((e && e.message) || e)}`);
  history(EPIC_KEY, "failed");
  finish("paused", String((e && e.message) || e), 1);
});
