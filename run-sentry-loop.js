#!/usr/bin/env node
// run-sentry-loop.js — Sentry 에러 → Jira 카드 → 에픽 연속 개발 (1회 실행; 대시보드가 주기적으로 띄운다)
// --------------------------------------------------------------------------
// 1) 「Sentry 작동 업무 처리」 에픽을 찾는다(같은 제목의 미완료 에픽). 없으면 만든다.
// 2) 매핑된 Sentry 프로젝트 × 환경마다 미해결 이슈를 가져와 기준(fatal 즉시 | 기간 내 N회 이상)에 맞는
//    새 이슈를 에픽 하위 카드로 만든다(라벨 claude-work · sentry · sentry-<id> · sentry-env-<env> · repo_<repo>).
// 3) 새 카드는 '처리 시작' 을 두 웹훅(slackWebhookUrl + sentrySlackWebhookUrl)에 알리고 Sentry 이슈에 코멘트.
// 4) 추적 중인 카드가 완료(병합)되면 '병합 완료(배포 전)', 에픽에서 멈추면 '실패' 를 두 웹훅에 한 번씩 알린다.
// 5) 남은 카드가 있는데 에픽 연속 개발이 안 돌면(idle/done) 자동 병합을 켜서 시작한다.
//    사용자가 멈춘(stopped) 실행이나 실패로 멈춘(paused) 실행은 건드리지 않는다.
//
// env: PROJECT_ID(필수), DASHBOARD_URL(에픽 시작·상태 조회), SENTRY_DRY_RUN=1(카드·알림 없이 조회만)
// 상태: <CLONE_BASE>/.state/sentry-<projectId>.json · 락 sentry-<projectId>.lock
// --------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const { SELF, lib, projectEnv, loadProjects, loadCreds } = require("./lib-project-env");
const S = require("./lib-sentry");

const PROJECT_ID = process.env.PROJECT_ID || "";
const DRY = process.env.SENTRY_DRY_RUN === "1";
const DASH = process.env.DASHBOARD_URL || "http://127.0.0.1:4317";
const ts = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const log = (m) => console.log(`[${ts()}] [sentry ${PROJECT_ID}] ${m}`);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const project = loadProjects().find((p) => p.id === PROJECT_ID);
if (!project) { console.error(`프로젝트 ${PROJECT_ID} 가 없습니다.`); process.exit(2); }
const cred = loadCreds()[project.id] || {};
const { cfg } = projectEnv(project, cred);
const conf = S.sentryConfig(cfg);
const ready = S.sentryReady(conf, cred);
if (!ready.ok) { log(`건너뜀: ${ready.why}`); process.exit(0); }
if (!cfg.jiraSite || !cred.atlassianEmail || !cred.atlassianToken || !cfg.projectKey) {
  console.error("Jira 사이트·프로젝트 키·Atlassian 자격증명이 없습니다."); process.exit(2);
}

const STATE_DIR = path.join(cfg.cloneBase || path.join(cfg.workDir || SELF, "repos"), ".state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, `sentry-${project.id}.json`);
const LOCK = path.join(STATE_DIR, `sentry-${project.id}.lock`);
const HISTORY_FILE = path.join(SELF, "history.jsonl");

let STATE = lib.readJson(STATE_FILE, {});
STATE.issues = STATE.issues || {};
const save = (patch) => {
  STATE = { ...STATE, ...(patch || {}), updatedAt: nowIso() };
  fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(STATE, null, 2));
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
};

// ----- 락: 주기 실행이 겹치지 않게(오래된 락은 30분 뒤 무시) -----
function takeLock() {
  try { fs.mkdirSync(LOCK); return true; } catch {}
  try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 30 * 60000) { fs.rmdirSync(LOCK); fs.mkdirSync(LOCK); return true; } } catch {}
  return false;
}
const releaseLock = () => { try { fs.rmdirSync(LOCK); } catch {} };

// ----- HTTP -----
const jiraAuth = Buffer.from(`${cred.atlassianEmail}:${cred.atlassianToken}`).toString("base64");
async function jira(method, urlPath, body) {
  const r = await fetch(`https://${cfg.jiraSite}${urlPath}`, {
    method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Basic ${jiraAuth}`, Accept: "application/json", "Content-Type": "application/json" },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Jira ${method} ${urlPath} → ${r.status}: ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : {};
}
const jiraSearch = (jql, fields) => jira("POST", "/rest/api/3/search/jql", { jql, maxResults: 100, fields: fields || ["summary", "labels", "status"] });

async function sentry(method, urlPath, body) {
  const r = await fetch(`${conf.baseUrl}${urlPath}`, {
    method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${cred.sentryToken}`, Accept: "application/json", "Content-Type": "application/json" },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Sentry ${method} ${urlPath} → ${r.status}: ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : {};
}

async function dash(method, urlPath, body) {
  const sep = urlPath.includes("?") ? "&" : "?";
  const r = await fetch(`${DASH}${urlPath}${sep}project=${encodeURIComponent(project.id)}`, {
    method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json" },
  });
  return r.json();
}

// 처리 시작·병합 완료·실패 — 기존 웹훅과 Sentry 채널 웹훅에 동시에. 한쪽이 실패해도 계속.
async function notifyBoth(text) {
  if (DRY) { log(`(dry) 알림: ${text}`); return; }
  await Promise.all(S.notifyUrls(cred).map((url) => fetch(url, {
    method: "POST", headers: { "Content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000),
  }).catch((e) => log(`Slack 전송 실패: ${e.message}`))));
}
async function sentryComment(issueId, text) {
  if (DRY) return;
  try { await sentry("POST", `/api/0/issues/${encodeURIComponent(issueId)}/comments/`, { text }); }
  catch (e) { log(`Sentry 코멘트 실패(${issueId}): ${e.message}`); }
}
const browse = (key) => `https://${cfg.jiraSite}/browse/${key}`;

// ----- Jira 메타 -----
let META = null;
async function meta() {
  if (META) return META;
  const p = await jira("GET", `/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}`);
  const types = p.issueTypes || [];
  const epicType = lib.topLevelIssueTypes(types)[0];
  const lv0 = types.filter((t) => !t.subtask && Number(t.hierarchyLevel) === 0);
  const pick = (re) => lv0.find((t) => re.test(t.name));
  const childType = pick(/^(bug|버그)$/i) || pick(/^(task|작업)$/i) || lv0[0];
  const me = await jira("GET", "/rest/api/3/myself");
  META = { types, epicType, childType, accountId: me.accountId };
  return META;
}

// ----- 1) 에픽 확보 -----
async function ensureEpic() {
  const m = await meta();
  if (!m.epicType) throw new Error("프로젝트에 에픽 계층(hierarchyLevel 1) 이슈 타입이 없습니다.");
  const isOpen = (i) => !(i.fields.status && i.fields.status.statusCategory && i.fields.status.statusCategory.key === "done");
  if (STATE.epicKey) {
    try {
      const i = await jira("GET", `/rest/api/3/issue/${encodeURIComponent(STATE.epicKey)}?fields=summary,status`);
      if (isOpen(i)) return STATE.epicKey;
      log(`기록된 에픽 ${STATE.epicKey} 가 완료돼 다시 찾습니다.`);
    } catch (e) { log(`기록된 에픽 ${STATE.epicKey} 조회 실패: ${e.message}`); }
  }
  const jql = `${lib.epicSearchJql(cfg.projectKey, m.types).replace(/ ORDER BY.*$/, "")} AND summary ~ "\\"${conf.epicSummary.replace(/"/g, "")}\\"" ORDER BY created DESC`;
  const r = await jiraSearch(jql, ["summary", "status"]);
  const hit = (r.issues || []).find((i) => String(i.fields.summary || "").trim() === conf.epicSummary && isOpen(i));
  if (hit) { log(`기존 에픽 사용: ${hit.key}`); save({ epicKey: hit.key }); return hit.key; }
  if (DRY) { log("(dry) 에픽이 없어 새로 만들 예정"); return ""; }
  const desc = [
    "Sentry 가 잡은 에러를 오토파일럿이 자동으로 처리하는 에픽입니다.",
    "",
    "- 하위 카드는 run-sentry-loop.js 가 만든다(라벨 sentry · sentry-env-<환경>).",
    "- 카드마다 원인 수정 → 리뷰 승인 + CI 통과 → 프로젝트 병합 대상 브랜치로 자동 병합.",
    "- 배포는 사람이 병합 결과를 확인한 뒤 따로 한다.",
  ].join("\n");
  const c = await jira("POST", "/rest/api/3/issue", { fields: {
    project: { key: cfg.projectKey }, issuetype: { id: m.epicType.id }, summary: conf.epicSummary,
    description: lib.mdToADF(desc), assignee: { accountId: m.accountId },
  } });
  log(`에픽 생성: ${c.key}`);
  save({ epicKey: c.key });
  return c.key;
}

// ----- 2) 이슈 수집 → 카드 -----
async function alreadyCarded(issueId) {
  if (STATE.issues[issueId]) return true;
  const r = await jiraSearch(`project = "${cfg.projectKey}" AND labels = "${S.idLabel(issueId)}"`, ["summary"]);
  const hit = (r.issues || [])[0];
  if (hit) STATE.issues[issueId] = { key: hit.key, recovered: true, createdAt: nowIso(), notified: { start: true } };
  return !!hit;
}

async function fetchIssues(slug, env) {
  const q = new URLSearchParams({ query: "is:unresolved", environment: env, statsPeriod: `${conf.windowHours}h`, limit: "50" });
  // statsPeriod 는 24h·14d 만 받는 버전이 있어, 그 외 값이면 24h 로 한 번 더 시도한다.
  try { return await sentry("GET", `/api/0/projects/${encodeURIComponent(conf.org)}/${encodeURIComponent(slug)}/issues/?${q}`); }
  catch (e) {
    if (!/→ 400/.test(e.message) || conf.windowHours === 24) throw e;
    q.set("statsPeriod", "24h");
    return sentry("GET", `/api/0/projects/${encodeURIComponent(conf.org)}/${encodeURIComponent(slug)}/issues/?${q}`);
  }
}

async function createCard(epicKey, issue, env, repo) {
  const m = await meta();
  let ev = null;
  try { ev = await sentry("GET", `/api/0/issues/${encodeURIComponent(issue.id)}/events/latest/`); }
  catch (e) { log(`최신 이벤트 조회 실패(${issue.id}): ${e.message}`); }
  const summary = S.cardSummary(issue, env);
  if (DRY) { log(`(dry) 카드 생성 예정: ${summary} → repo ${repo}`); return null; }
  const c = await jira("POST", "/rest/api/3/issue", { fields: {
    project: { key: cfg.projectKey }, issuetype: { id: m.childType.id }, summary,
    parent: { key: epicKey }, labels: S.cardLabels(issue.id, env, repo, cfg.triggerLabel),
    description: lib.mdToADF(S.cardDescription(issue, ev, env, conf)), assignee: { accountId: m.accountId },
  } });
  return c.key;
}

async function collect(epicKey) {
  let made = 0;
  for (const p of conf.projects) {
    if (!lib.normalizeRepos(cfg).some((r) => r.name === p.repo)) { log(`매핑 repo ${p.repo} 가 프로젝트에 없어 ${p.slug} 를 건너뜁니다.`); continue; }
    for (const env of conf.environments) {
      if (made >= conf.maxCardsPerRun) return made;
      let issues;
      try { issues = await fetchIssues(p.slug, env); }
      catch (e) { log(`이슈 조회 실패(${p.slug}/${env}): ${e.message}`); STATE.lastError = e.message; continue; }
      STATE.security = STATE.security || {};
      for (const issue of issues || []) {
        const pat = S.securityMatch(issue, conf);
        if (!pat || STATE.security[String(issue.id)]) continue;
        if (!DRY) { STATE.security[String(issue.id)] = { env, slug: p.slug, title: issue.title || "", pattern: pat, at: nowIso() }; save(); }
        log(`보안 의심 — 카드 만들지 않음: ${p.slug}/${env} #${issue.shortId || issue.id} (${pat})`);
        await notifyBoth(`🚨 [Sentry][${env}] 보안 사건 의심 에러 — 자동 수정 대상에서 제외했습니다. 사람이 확인해 주세요 · ${issue.title || ""} · <${issue.permalink || ""}|Sentry>`);
      }
      const picked = S.pickIssues(issues, conf, new Set(Object.keys(STATE.issues)));
      for (const issue of picked) {
        if (made >= conf.maxCardsPerRun) break;
        if (await alreadyCarded(String(issue.id))) continue;
        const key = await createCard(epicKey, issue, env, p.repo);
        if (!key) { made++; continue; }   // dry-run: 예정 건수도 상한에 센다
        made++;
        STATE.issues[String(issue.id)] = {
          key, env, repo: p.repo, slug: p.slug, title: issue.title || "", permalink: issue.permalink || "",
          createdAt: nowIso(), notified: { start: true },
        };
        save();
        log(`카드 생성: ${key} ← ${p.slug}/${env} #${issue.shortId || issue.id}`);
        const access = S.accessFileOf(conf, cfg.workDir || SELF, project.id, env) ? "환경 접근 조사 포함" : "Sentry 정보만";
        await notifyBoth(`🛠 [Sentry][${env}] ${issue.title || ""} — 자동 처리를 시작합니다 (${access}) · <${browse(key)}|${key}> · <${issue.permalink || ""}|Sentry>`);
        await sentryComment(issue.id, `오토파일럿이 자동 처리를 시작했습니다: ${key} ${browse(key)}`);
      }
    }
  }
  return made;
}

// ----- 3) 추적 카드 후속 알림 -----
async function followUp(epicKey) {
  const open = Object.entries(STATE.issues).filter(([, v]) => v.key && !(v.notified && v.notified.merged));
  if (!open.length) return;
  const keys = open.map(([, v]) => v.key);
  const statusOf = {};
  for (let i = 0; i < keys.length; i += 50) {
    const r = await jiraSearch(`key IN (${keys.slice(i, i + 50).join(",")})`, ["status"]);
    for (const it of r.issues || []) {
      const st = it.fields.status || {};
      statusOf[it.key] = (st.statusCategory && st.statusCategory.key === "done") || lib.effectiveDoneStatuses(cfg).includes(st.name);
    }
  }
  let epic = {};
  try { epic = lib.readJson(path.join(STATE_DIR, `${epicKey}.epic.json`), {}); } catch {}
  const failedOf = Object.fromEntries((epic.workers || []).filter((w) => w.status === "failed").map((w) => [w.key, w]));
  let lines = [];
  try { lines = fs.readFileSync(HISTORY_FILE, "utf8").split("\n"); } catch {}
  for (const [id, v] of open) {
    v.notified = v.notified || {};
    if (statusOf[v.key]) {
      const prs = S.prsFromHistory(lines, v.key);
      const prTxt = prs.length ? prs.map((u) => `<${u}|PR>`).join(" ") : "PR 기록 없음";
      await notifyBoth(`✅ [Sentry][${v.env}] ${v.title} — 병합 완료(배포 전) · <${browse(v.key)}|${v.key}> · ${prTxt}`);
      await sentryComment(id, `수정이 병합됐습니다(배포 전): ${v.key} ${prs.join(" ")}`);
      v.notified.merged = nowIso();
      continue;
    }
    const f = failedOf[v.key];
    const sig = f ? `${f.step}:${f.reason}` : "";
    if (f && v.notified.failed !== sig) {
      await notifyBoth(`⚠️ [Sentry][${v.env}] ${v.title} — 자동 처리 중단, 사람 확인 필요 (${f.step}: ${f.reason}) · <${browse(v.key)}|${v.key}>`);
      v.notified.failed = sig;
    }
  }
  save();
}

// ----- 4) 에픽 연속 개발 유지 -----
async function ensureRun(epicKey) {
  const r = await jiraSearch(lib.epicChildrenJql(epicKey, cfg, "parent", "created"), ["summary"]).catch(() => null);
  const pending = r ? (r.issues || []).length : 0;
  if (!pending) return "남은 카드 없음";
  const st = await dash("GET", `/api/epics/${epicKey}/run`).catch((e) => ({ ok: false, message: e.message }));
  if (!st.ok) return `대시보드 응답 없음(${st.message || ""}) — 에픽 시작 보류`;
  const run = st.run || {};
  if (run.running) return `실행 중(${pending}건 남음)`;
  if (run.status === "paused" || run.status === "stopped") return `에픽이 ${run.status} 상태라 건드리지 않음(${pending}건 대기)`;
  if (DRY) return `(dry) 에픽 시작 예정(${pending}건)`;
  const repos = [...new Set(conf.projects.map((p) => p.repo))];
  const res = await dash("POST", `/api/epics/${epicKey}/run`, {
    repos, autoMerge: true, autoMergeAfterMin: conf.autoMergeAfterMin, autoRetry: true,
  });
  return res.ok === false ? `에픽 시작 실패: ${res.message}` : `에픽 연속 개발 시작(${pending}건, 자동 병합)`;
}

(async () => {
  if (!takeLock()) { log("이전 실행이 아직 돌고 있어 건너뜁니다."); return; }
  try {
    save({ lastRunAt: nowIso(), lastError: "" });
    const epicKey = await ensureEpic();
    if (!epicKey && !DRY) return;
    // dry-run 은 에픽이 아직 없어도 어떤 이슈가 카드가 될지까지 보여 준다
    const made = await collect(epicKey);
    if (epicKey) await followUp(epicKey);
    const run = epicKey ? await ensureRun(epicKey) : "(dry) 에픽 생성 후 시작 예정";
    save({ lastCreated: made, lastRun: run });
    log(`완료 — 새 카드 ${made}건 · ${run}`);
  } catch (e) {
    log(`오류: ${e.message}`);
    save({ lastError: e.message });
    process.exitCode = 1;
  } finally { releaseLock(); }
})();
