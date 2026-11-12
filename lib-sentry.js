// =============================================================================
// lib-sentry.js — Sentry 에러 → Jira 카드 자동 처리의 순수 로직(설정 정규화·필터·카드 본문·라벨·지시문).
// I/O 는 run-sentry-loop.js 가 맡는다. 단위 테스트: dashboard/test/sentry.test.js
// =============================================================================
const fs = require("fs");
const path = require("path");

const SENTRY_LABEL = "sentry";
const SENTRY_ID_PREFIX = "sentry-";
const SENTRY_ENV_PREFIX = "sentry-env-";
const DEFAULT_EPIC_SUMMARY = "Sentry 작동 업무 처리";

const int = (v, d, lo, hi) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d;
};

// projects.json 의 project.sentry 를 기본값과 합쳐 정규화한다.
function sentryConfig(cfg) {
  const s = (cfg && cfg.sentry) || {};
  const projects = (Array.isArray(s.projects) ? s.projects : [])
    .map((p) => ({ slug: String((p && p.slug) || "").trim(), repo: String((p && p.repo) || "").trim() }))
    .filter((p) => p.slug && p.repo);
  const envs = (Array.isArray(s.environments) && s.environments.length ? s.environments : ["dev", "qa", "prod"])
    .map((e) => String(e).trim()).filter(Boolean);
  return {
    enabled: !!s.enabled,
    baseUrl: String(s.baseUrl || "https://sentry.io").replace(/\/+$/, ""),
    org: String(s.org || "").trim(),
    projects,
    environments: envs,
    minEvents: int(s.minEvents, 5, 1, 100000),
    windowHours: int(s.windowHours, 24, 1, 336),
    fatalImmediate: s.fatalImmediate === undefined ? true : !!s.fatalImmediate,
    intervalMinutes: int(s.intervalMinutes, 10, 1, 1440),
    maxCardsPerRun: int(s.maxCardsPerRun, 5, 1, 50),
    autoMergeAfterMin: int(s.autoMergeAfterMin, 5, 1, 1440),
    trackDays: int(s.trackDays, 14, 1, 90),   // 병합 뒤 배포·해결·재발을 지켜보는 기간
    epicSummary: String(s.epicSummary || DEFAULT_EPIC_SUMMARY).trim(),
    accessDir: String(s.accessDir || "").trim(),
    securityPatterns: (Array.isArray(s.securityPatterns) ? s.securityPatterns : []).map(String).filter(Boolean),
    ignorePatterns: (Array.isArray(s.ignorePatterns) ? s.ignorePatterns : []).map(String).filter(Boolean),   // 시험 이벤트 등 카드·알림 없이 건너뛸 것
  };
}

// 실행 가능 여부와 막힌 이유(대시보드·로그 표시용)
function sentryReady(conf, cred, opts) {
  if (!conf.enabled && !(opts && opts.ignoreEnabled)) return { ok: false, why: "sentry.enabled 꺼짐" };
  if (!cred || !cred.sentryToken) return { ok: false, why: "sentryToken 없음" };
  if (!conf.org) return { ok: false, why: "sentry.org 없음" };
  if (!conf.projects.length) return { ok: false, why: "sentry.projects(slug→repo) 없음" };
  return { ok: true, why: "" };
}

// 기간 내 발생 수 — stats 버킷 합이 있으면 그것, 없으면 count.
function eventCount(issue) {
  const st = issue && issue.stats;
  if (st && typeof st === "object") {
    const series = Object.values(st).find(Array.isArray);
    if (series) return series.reduce((a, b) => a + (Array.isArray(b) ? Number(b[1]) || 0 : 0), 0);
  }
  return Number(issue && issue.count) || 0;
}

// 보안 사건 의심 패턴(제목·culprit·메시지 정규식, 대소문자 무시). 맞으면 카드 대신 보안 알림 1회.
function patternMatch(issue, patterns) {
  const fields = [issue && issue.title, issue && issue.culprit, issue && issue.metadata && issue.metadata.value]
    .filter(Boolean).map(String);
  for (const p of patterns || []) {
    let re; try { re = new RegExp(p, "i"); } catch { continue; }
    if (fields.some((f) => re.test(f))) return p;   // 필드마다 따로 — ^…$ 패턴이 culprit 과 합쳐져 빗나가지 않게
  }
  return "";
}
const securityMatch = (issue, conf) => patternMatch(issue, conf.securityPatterns);
const ignoreMatch = (issue, conf) => patternMatch(issue, conf.ignorePatterns);

// 카드로 만들 이슈만: 미해결 + (fatal 이면 즉시 | 기간 내 minEvents 이상), 이미 처리한 id 제외.
function pickIssues(issues, conf, seen) {
  const known = seen || new Set();
  return (issues || []).filter((i) => {
    if (!i || !i.id || known.has(String(i.id))) return false;
    if (i.status && i.status !== "unresolved") return false;
    if (securityMatch(i, conf)) return false;
    if (ignoreMatch(i, conf)) return false;
    if (conf.fatalImmediate && String(i.level || "").toLowerCase() === "fatal") return true;
    return eventCount(i) >= conf.minEvents;
  });
}

const idLabel = (id) => `${SENTRY_ID_PREFIX}${id}`;
const envLabel = (env) => `${SENTRY_ENV_PREFIX}${String(env).replace(/[^A-Za-z0-9_-]/g, "_")}`;
function envOfLabels(labels) {
  const l = (labels || []).find((x) => String(x).indexOf(SENTRY_ENV_PREFIX) === 0);
  return l ? l.slice(SENTRY_ENV_PREFIX.length) : "";
}
const isSentryCard = (labels) => (labels || []).includes(SENTRY_LABEL);

function cardLabels(issueId, env, repo, triggerLabel) {
  return [triggerLabel || "claude-work", SENTRY_LABEL, idLabel(issueId), envLabel(env), `repo_${repo}`];
}

function cardSummary(issue, env) {
  const t = String((issue && (issue.title || issue.metadata && issue.metadata.title)) || "Sentry 이슈").replace(/\s+/g, " ").trim();
  const s = `[Sentry][${env}] ${t}`;
  return s.length > 240 ? `${s.slice(0, 237)}...` : s;
}

// 최신 이벤트에서 예외·스택(앱 프레임 우선)·breadcrumb·요청을 뽑는다.
function eventDigest(ev) {
  const out = { exceptions: [], breadcrumbs: [], request: null, tags: [] };
  if (!ev) return out;
  for (const e of ev.entries || []) {
    if (e.type === "exception") {
      for (const v of (e.data && e.data.values) || []) {
        const all = (v.stacktrace && v.stacktrace.frames) || [];
        const app = all.filter((f) => f.inApp);
        const frames = (app.length ? app : all).slice(-12).reverse().map((f) => ({
          file: f.filename || f.absPath || f.module || "?", line: f.lineNo, fn: f.function || "?",
          context: (f.context || []).filter((c) => c[0] === f.lineNo).map((c) => String(c[1]).trim())[0] || "",
        }));
        out.exceptions.push({ type: v.type || "", value: v.value || "", frames });
      }
    } else if (e.type === "breadcrumbs") {
      out.breadcrumbs = ((e.data && e.data.values) || []).slice(-15).map((b) => ({
        ts: b.timestamp || "", category: b.category || b.type || "", level: b.level || "",
        message: String(b.message || (b.data ? JSON.stringify(b.data) : "")).slice(0, 300),
      }));
    } else if (e.type === "request" && e.data) {
      out.request = { method: e.data.method || "", url: e.data.url || "" };
    }
  }
  out.tags = (ev.tags || []).map((t) => `${t.key}=${t.value}`).slice(0, 25);
  return out;
}

function cardDescription(issue, ev, env, conf) {
  const d = eventDigest(ev);
  const L = [];
  L.push("Sentry 가 잡은 에러를 오토파일럿이 자동으로 등록한 카드입니다.");
  L.push("");
  L.push("## Sentry 이슈");
  L.push(`- 링크: ${issue.permalink || ""}`);
  L.push(`- 환경: ${env}`);
  L.push(`- 프로젝트: ${(issue.project && issue.project.slug) || ""}`);
  L.push(`- 레벨: ${issue.level || ""}`);
  L.push(`- 발생: 최근 ${conf.windowHours}시간 ${eventCount(issue)}회 · 영향 사용자 ${issue.userCount || 0}명`);
  L.push(`- 처음/마지막 발생: ${issue.firstSeen || ""} / ${issue.lastSeen || ""}`);
  if (issue.culprit) L.push(`- 위치(culprit): ${issue.culprit}`);
  if (d.request) L.push(`- 요청: ${d.request.method} ${d.request.url}`);
  for (const ex of d.exceptions) {
    L.push("");
    L.push(`## 예외: ${ex.type}${ex.value ? ` — ${ex.value}` : ""}`);
    L.push("```");
    for (const f of ex.frames) L.push(`${f.file}:${f.line || "?"} in ${f.fn}${f.context ? `\n    ${f.context}` : ""}`);
    L.push("```");
  }
  if (d.breadcrumbs.length) {
    L.push("");
    L.push("## Breadcrumbs (최근)");
    L.push("```");
    for (const b of d.breadcrumbs) L.push(`${b.ts} [${b.category}${b.level ? `/${b.level}` : ""}] ${b.message}`);
    L.push("```");
  }
  if (d.tags.length) {
    L.push("");
    L.push("## 태그");
    L.push(d.tags.join(", "));
  }
  L.push("");
  L.push("## 처리 기준");
  L.push("- 위 에러의 원인을 찾아 코드로 고친다. 재발 방지 테스트를 함께 넣는다.");
  L.push("- 병합은 리뷰 승인 + CI 통과 뒤 자동으로 한다. 배포는 사람이 따로 한다.");
  return L.join("\n");
}

// 환경 접근 정보 파일: <accessDir>/<projectId>-<env>.md (없으면 null)
function accessDirOf(conf, workDir) {
  return conf.accessDir || path.join(workDir, "env-access");
}
function accessFileOf(conf, workDir, projectId, env) {
  if (!env) return null;
  const p = path.join(accessDirOf(conf, workDir), `${projectId}-${env}.md`);
  try { return fs.statSync(p).isFile() && fs.statSync(p).size > 0 ? p : null; } catch { return null; }
}

// plan/build 프롬프트에 붙는 지시. 접근 정보가 있으면 조회·재현만 허용, 없으면 Sentry 정보만.
function agentInstr(env, accessFile) {
  const head = `

[Sentry 자동 처리] 이 카드는 Sentry 가 ${env || "?"} 환경에서 잡은 에러입니다. 카드 본문의 스택트레이스·breadcrumb·태그를 근거로 원인을 찾아 고치고, 같은 에러가 다시 나지 않음을 보이는 테스트를 넣으세요.`;
  if (!accessFile) {
    return `${head}
이 환경의 접근 정보는 등록돼 있지 않습니다. 실제 환경에 접속하려 하지 말고 Sentry 정보와 코드만으로 판단하세요.`;
  }
  return `${head}
'${env}' 환경 접근 정보가 '${accessFile}' 에 있습니다. 원인 조사·재현이 필요하면 'Read' 로 읽고 사용하세요. 규칙:
- 조회·재현만 한다. 데이터 쓰기·삭제, 배포, 재시작, 설정 변경, 대량 요청은 하지 않는다.
- 접근 정보(비밀번호·토큰·접속 문자열)를 코드·커밋·PR·Jira·로그에 남기지 않는다.
- 접속이 안 되면 Sentry 정보만으로 진행한다.`;
}

// 에픽 안에서 Sentry 카드는 자기 repo_ 라벨의 repo 만 다룬다(에픽 대상 repo 와의 교집합). 일반 카드는 전부.
function taskRepoNames(labels, epicNames) {
  if (!isSentryCard(labels)) return epicNames.slice();
  const own = (labels || []).filter((l) => l.indexOf("repo_") === 0).map((l) => l.slice(5));
  const hit = epicNames.filter((n) => own.includes(n));
  return hit.length ? hit : epicNames.slice();
}

// 두 웹훅(기존 + Sentry 채널)을 중복 없이
function notifyUrls(cred) {
  return [...new Set([cred && cred.slackWebhookUrl, cred && cred.sentrySlackWebhookUrl].filter(Boolean))];
}

// 이 카드의 PR URL 들 — history.jsonl 에서 build 성공 기록을 모은다.
function prsFromHistory(lines, key) {
  const urls = new Set();
  for (const ln of lines || []) {
    let r; try { r = JSON.parse(ln); } catch { continue; }
    if (r && r.key === key && r.pr) String(r.pr).split(/[\s,]+/).filter((u) => /^https?:\/\//.test(u)).forEach((u) => urls.add(u));
  }
  return [...urls];
}

// ----- 병합 뒤 추적: 태그 → 배포 → 해결/재발 -----
// 배포는 Sentry release 로 판정한다. release 값은 배포된 커밋(SHA 나 태그)이라, 그 환경에서 수정 커밋을
// 포함한 release 의 이벤트가 보이면 그 환경이 새 버전으로 돈다는 뜻이다. 배포 경로(워크플로·스크립트·수동)와 무관.

// 여러 수정 커밋의 포함 여부 → 하나라도 빠졌으면 false, 모두 포함이면 true, 그 외(조회 실패)는 null
function combineContains(list) {
  if (!list.length) return null;
  if (list.some((c) => c === false)) return false;
  return list.every((c) => c === true) ? true : null;
}

// 재발했거나 추적 기한이 지났으면 더 묻지 않는다. 해결은 재발을 계속 지켜보느라 끝이 아니다.
const trackDone = (t) => !!(t && (t.regressedAt || t.gaveUpAt));

// merged 이후 단계. 재발 > 해결 > 배포 확인 > 재발 없음(배포 미확인) > 태그 포함 > 병합
function trackStage(v) {
  const n = (v && v.notified) || {}, t = (v && v.track) || {};
  if (!n.merged) return "";
  if (t.regressedAt) return "regressed";
  if (t.resolvedAt) return "resolved";
  if (t.deployedAt) return "deployed";
  if (t.quietAt) return "quiet";
  if (t.tag) return "tagged";
  return "merged";
}

// inp: { now(ms), mergedAt, windowMs, giveUpMs, tag:{name,at}|null, lastSeen,
//        envReleases:[{version,dateCreated}] (카드 환경), events:[{release,env,at}] (병합 뒤, 모든 환경),
//        contains:{version: true|false|null} }
// 반환: { track, changes:["deployed"|"resolved"|"regressed"] } — changes 는 이번에 새로 일어난 일
function advanceTrack(t0, inp) {
  const t = { ...(t0 || {}) }, changes = [];
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const has = (ver) => !!ver && (inp.contains || {})[ver] === true;
  const mergedMs = Date.parse(inp.mergedAt) || 0;
  if (!t.tag && inp.tag && inp.tag.name) { t.tag = inp.tag.name; t.tagAt = inp.tag.at || ""; }
  if (!t.deployedAt) {
    const hit = (inp.envReleases || []).filter((r) => has(r.version))
      .sort((a, b) => String(a.dateCreated).localeCompare(String(b.dateCreated)))[0];
    if (hit) {
      t.deployedRelease = hit.version;
      t.deployedAt = iso(Math.max(Date.parse(hit.dateCreated) || 0, mergedMs));
      changes.push("deployed");
    }
  }
  if (!t.regressedAt) {
    const ev = (inp.events || []).filter((e) => has(e.release) && Date.parse(e.at) > mergedMs)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
    if (ev) { t.regressedAt = ev.at; t.regressedRelease = ev.release; t.regressedEnv = ev.env || ""; changes.push("regressed"); }
  }
  if (!t.regressedAt && !t.resolvedAt && t.deployedAt && inp.now - Date.parse(t.deployedAt) >= inp.windowMs) {
    t.resolvedAt = iso(inp.now);
    changes.push("resolved");
  }
  // release 가 안 잡히는 경우(새 버전에서 에러가 없으면 그 release 이벤트도 없다)를 위한 보조 표시. 태그 뒤로
  // 기간 내내 어느 환경에서도 안 났으면 '재발 없음'. 다시 나면 지운다 — 옛 버전이 아직 돈다는 뜻이다.
  const quiet = !t.deployedAt && !!t.tagAt && inp.now - Date.parse(t.tagAt) >= inp.windowMs
    && !(Date.parse(inp.lastSeen) > Date.parse(t.tagAt));
  if (quiet) t.quietAt = t.quietAt || iso(inp.now); else delete t.quietAt;
  if (!trackDone(t) && inp.giveUpMs && inp.now - mergedMs > inp.giveUpMs) t.gaveUpAt = iso(inp.now);
  return { track: t, changes };
}

// 태그를 최신 순으로 — v1.5.9 < v1.5.68 이 되도록 숫자 비교
function sortTagsDesc(tags) {
  return (tags || []).slice().sort((a, b) => String(b.name).localeCompare(String(a.name), undefined, { numeric: true }));
}

// 대시보드 표시용 — 추적 중인 Sentry 이슈마다 진행 단계. 우선순위: 병합 뒤 추적 > 에픽 워커(돌거나 멈춘 카드) > 에픽 태스크 목록 > 대기.
// epic: .state/<EPIC>.epic.json (없으면 {}).
// stage: regressed | failed | running | stopped | blocked | queued | merged | tagged | quiet | deployed | resolved
function overviewRows(state, epic) {
  const workers = Object.fromEntries(((epic && epic.workers) || []).map((w) => [w.key, w]));
  const tasks = Object.fromEntries(((epic && epic.tasks) || []).map((t) => [t.key, t]));
  const rows = Object.entries((state && state.issues) || {}).map(([id, v]) => {
    const n = v.notified || {};
    const w = workers[v.key], t = tasks[v.key];
    let stage = "queued", step = "", reason = "";
    if (n.merged) stage = trackStage(v);
    else if (w && w.status === "failed") { stage = "failed"; step = w.step || ""; reason = w.reason || ""; }
    else if (w && w.status === "stopped") { stage = "stopped"; step = w.step || ""; }
    else if (w) { stage = "running"; step = w.step || ""; }
    else if (t && t.state === "blocked") stage = "blocked";
    return {
      issueId: id, shortId: v.shortId || "", title: v.title || "", env: v.env || "", permalink: v.permalink || "",
      key: v.key || "", repo: v.repo || "", level: v.level || "", count: v.count || 0,
      stage, step, reason, createdAt: v.createdAt || "", mergedAt: n.merged || "", recovered: !!v.recovered,
      track: v.track ? {
        tag: v.track.tag || "", tagAt: v.track.tagAt || "", deployedRelease: v.track.deployedRelease || "", deployedAt: v.track.deployedAt || "",
        resolvedAt: v.track.resolvedAt || "", quietAt: v.track.quietAt || "", regressedAt: v.track.regressedAt || "",
        regressedRelease: v.track.regressedRelease || "", regressedEnv: v.track.regressedEnv || "", note: v.track.note || "",
      } : null,
    };
  });
  const order = { regressed: 0, failed: 0, running: 1, stopped: 2, blocked: 3, queued: 4, merged: 5, tagged: 5, quiet: 5, deployed: 5, resolved: 6 };
  rows.sort((a, b) => (order[a.stage] - order[b.stage]) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const security = Object.entries((state && state.security) || {}).map(([id, s]) => ({ issueId: id, ...s }))
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  return { rows, security };
}

module.exports = {
  overviewRows, combineContains, trackDone, trackStage, advanceTrack, sortTagsDesc,
  SENTRY_LABEL, DEFAULT_EPIC_SUMMARY, sentryConfig, sentryReady, eventCount, pickIssues, securityMatch, ignoreMatch,
  idLabel, envLabel, envOfLabels, isSentryCard, cardLabels, cardSummary, eventDigest, cardDescription,
  accessDirOf, accessFileOf, agentInstr, taskRepoNames, notifyUrls, prsFromHistory,
};
