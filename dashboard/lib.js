// =============================================================================
// lib.js — server.js 의 순수 로직 + 프로젝트 스토어(파일 경로 주입형). 단위 테스트 대상.
// =============================================================================
const fs = require("fs");
const crypto = require("crypto");

// 카드 env 암호화(AES-256-GCM) — 첨부엔 암호문만, 빌드 시 로컬 키로만 복호화
const ENC_PREFIX = "ENCv1:";
function loadOrCreateEnvKey(keyPath) {
  try { const b = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64"); if (b.length === 32) return b; } catch {}
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
  return key;
}
function encryptEnv(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function decryptEnv(data, key) {
  const s = String(data);
  if (!s.startsWith(ENC_PREFIX)) return s; // 평문 첨부 호환
  const buf = Buffer.from(s.slice(ENC_PREFIX.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

const DEFAULT_CREDS = { anthropicApiKey: "", openaiApiKey: "", geminiApiKey: "", githubToken: "", atlassianEmail: "", atlassianToken: "", slackWebhookUrl: "" };

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return f; } };
const writeJson = (p, obj, mode) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: mode || 0o644 });

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "proj";
}

// 카드↔repo 매핑 라벨 접두사 (Jira 라벨 안전 문자만 사용: repo_<name>)
const REPO_LABEL_PREFIX = "repo_";
function repoNameFromUrl(url) {
  return slugify(String(url || "").replace(/\.git$/, "").split("/").filter(Boolean).pop() || "repo");
}
// 프로젝트의 repo 목록 정규화: repos 배열 우선, 없으면 레거시 repoUrl 1개로 변환
function normalizeRepos(p) {
  if (Array.isArray(p.repos) && p.repos.length) {
    return p.repos.filter((r) => r && r.url).map((r) => ({
      name: r.name || repoNameFromUrl(r.url),
      url: r.url,
      baseBranch: r.baseBranch || p.baseBranch || "main",
      envDest: r.envDest || "",
    }));
  }
  if (p.repoUrl) return [{ name: repoNameFromUrl(p.repoUrl), url: p.repoUrl, baseBranch: p.baseBranch || "main", envDest: p.envDest || "" }];
  return [];
}
// ===== LLM 엔진 선택 =====
// 지원 엔진과 전역 기본값. 프로젝트가 engine/model 을 비우면 이 기본값을 상속한다.
const ENGINES = ["claude", "codex", "gemini"];
const DEFAULT_ENGINE = "claude";
const DEFAULT_MODEL = "";   // 비우면 엔진 CLI 의 기본 모델 사용

// 프로젝트 설정에서 실제 사용할 엔진/모델을 해석한다(잘못된 값·빈 값은 전역 기본값으로 폴백).
// 반환: { engine, model } — run-cycle.js·server.js 가 ENGINE/MODEL env 로 주입.
function resolveEngine(cfg) {
  const raw = (cfg && typeof cfg.engine === "string" ? cfg.engine : "").trim().toLowerCase();
  const engine = ENGINES.includes(raw) ? raw : DEFAULT_ENGINE;
  const model = (cfg && typeof cfg.model === "string" ? cfg.model : "").trim();
  return { engine, model };
}

const REVIEW_LOOP_MAX_DEFAULT = 5;
const REVIEW_LOOP_MAX_LIMIT = 20;

// 리뷰 승인 루프 반복 상한: 요청값 → 프로젝트 설정 → 기본 5. 1~20 으로 clamp.
// (승인까지 루프 API 와 build 후 자동 연결 양쪽에서 같은 규칙을 쓴다)
function clampReviewLoopMax(requested, cfg) {
  const pick = [requested, cfg && cfg.reviewLoopMax, REVIEW_LOOP_MAX_DEFAULT]
    .map((v) => parseInt(v, 10))
    .find((v) => Number.isFinite(v) && v > 0);
  return Math.min(pick || REVIEW_LOOP_MAX_DEFAULT, REVIEW_LOOP_MAX_LIMIT);
}

// 카드 라벨로 대상 repo 결정: repo_<name> 라벨과 매칭. 없으면 첫 repo(기본).
function cardRepos(p, labels) {
  const repos = normalizeRepos(p);
  const names = (labels || []).filter((l) => l.indexOf(REPO_LABEL_PREFIX) === 0).map((l) => l.slice(REPO_LABEL_PREFIX.length));
  const sel = repos.filter((r) => names.includes(r.name));
  return sel.length ? sel : (repos.length ? [repos[0]] : []);
}

function triggerClause(cfg) {
  return cfg.triggerMode === "text" ? `text ~ "${cfg.triggerText}"` : `labels = "${cfg.triggerLabel}"`;
}

// 완료 전환 대상(doneStatus): 쉼표 구분 복수 허용. 첫 번째가 병합 시 전환 대상(주 완료 상태). 배열/문자열 수용.
function doneStatusList(cfg) {
  const raw = cfg && cfg.doneStatus;
  const arr = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(",");
  return arr.map((s) => String(s).trim()).filter(Boolean);
}
// '완료로 인식'할 상태 집합 = doneStatus(전환 대상) ∪ 상태→단계 매핑에서 '완료(done)'로 지정한 상태들.
// 탐지 제외·'완료' 단계 판정에 쓰인다(중복 제거).
function effectiveDoneStatuses(cfg) {
  const mapped = Object.entries((cfg && cfg.statusStageMap) || {}).filter(([, v]) => v === "done").map(([k]) => k);
  return [...new Set([...doneStatusList(cfg), ...mapped])];
}

function detectJql(mode, cfg) {
  const proj = cfg.projectKey ? ` AND project = "${cfg.projectKey}"` : "";
  const failed = ` AND (labels != "${cfg.failedLabel}" OR labels IS EMPTY)`;
  // 완료 제외: 상태 카테고리 Done + '완료로 인식'하는 상태들(doneStatus ∪ 매핑 완료). (워크플로마다 완료가
  // 'Done 카테고리'일 수도, 'DEV COMPLETED'/'QA READY' 처럼 카테고리가 다른 커스텀 상태일 수도 있어 둘 다 제외)
  const dones = effectiveDoneStatuses(cfg);
  const doneName = dones.length === 1 ? ` AND status != "${dones[0]}"`
    : dones.length > 1 ? ` AND status NOT IN (${dones.map((s) => `"${s}"`).join(", ")})` : "";
  const prLabel = cfg.prOpenLabel || "claude-pr";
  const base = `assignee = currentUser() AND statusCategory != Done${doneName} AND ${triggerClause(cfg)}`;
  if (mode === "plan") return `${base} AND (labels != "${cfg.plannedLabel}" OR labels IS EMPTY)${failed}${proj}`;
  // review: PR 을 올린(claude-pr) 카드 = 병합 대기 PR. 이 PR 들을 자동 리뷰한다(build 와 상보적).
  if (mode === "review") return `${base} AND labels = "${prLabel}"${failed}${proj}`;
  // build: PR 을 이미 올린(claude-pr) 카드는 병합 대기 상태이므로 재빌드 대상에서 제외
  return `${base} AND labels = "${cfg.plannedLabel}" AND labels = "${cfg.answeredLabel}" AND (labels != "${prLabel}" OR labels IS EMPTY)${failed}${proj}`;
}

// PR 리뷰 승인 마커(자기 자신의 PR 은 formal approve 불가 → 이 고유 텍스트 코멘트로 승인 표시).
// 이 문자열이 PR 코멘트에 존재하면 review 루프는 해당 PR 을 승인 완료로 보고 이후 영구 스킵한다.
const REVIEW_APPROVED_MARKER = "CLAUDE-REVIEW-APPROVED";

// onMedia(attrs) 를 주면 media/mediaInline 노드를 그 반환값으로 치환(이미지 인라인 표시용). 없으면 무시(기존 동작).
function adfToText(node, onMedia) {
  if (!node) return "";
  if (Array.isArray(node)) return node.map((n) => adfToText(n, onMedia)).join("");
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return "@" + (node.attrs && node.attrs.text ? node.attrs.text.replace(/^@/, "") : "");
  if (node.type === "emoji") return (node.attrs && (node.attrs.shortName || node.attrs.text)) || "";
  if ((node.type === "media" || node.type === "mediaInline") && onMedia) return onMedia(node.attrs || {});
  const inner = node.content ? adfToText(node.content, onMedia) : "";
  if (node.type === "listItem") return "• " + inner.replace(/\n+$/, "") + "\n";
  if (node.type === "blockquote") { const t = inner.replace(/\n+$/, ""); return t.split("\n").map((l) => "> " + l).join("\n") + "\n"; }
  if (["paragraph", "heading", "codeBlock", "rule", "panel"].indexOf(node.type) !== -1) return inner + "\n";
  return inner;
}

// ADF media 노드 → 세그먼트. imgByName(첨부 filename→{id}) + images(순서 보존 첨부 목록)로 매칭.
// 반환: {type:"image", id|url, filename} | {type:"unavailable", reason, filename} | {type:"text", text}
const SEG_NUL = String.fromCharCode(0); // 일반 텍스트와 충돌하지 않는 구분자
function adfSegments(adf, imgByName, images) {
  imgByName = imgByName || {};
  images = images || [];
  const medias = [];
  const text = adfToText(adf, (a) => { medias.push(a || {}); return SEG_NUL + (medias.length - 1) + SEG_NUL; });
  const used = new Set();
  let cursor = 0; // 순서 기반 폴백용 다음 첨부 인덱스
  const resolve = (a) => {
    const alt = a.alt || "";
    if (alt && imgByName[alt]) { used.add(imgByName[alt].id); return { type: "image", id: imgByName[alt].id, filename: alt }; }
    // 외부 미디어: 공개 http(s) URL 은 직접 표시, blob: 등 서버가 못 가져오는 건 표시 불가 안내
    if (a.type === "external" && a.url) {
      if (/^https?:\/\//i.test(a.url)) return { type: "image", url: a.url, filename: alt };
      return { type: "unavailable", reason: "inline", filename: alt };
    }
    // 순서 기반 폴백: alt 가 없어 매칭 실패한 첨부 이미지를 노드 순서대로 연결
    while (cursor < images.length && used.has(images[cursor].id)) cursor++;
    if (cursor < images.length) { const att = images[cursor++]; used.add(att.id); return { type: "image", id: att.id, filename: att.filename || alt }; }
    return { type: "text", text: `[이미지: ${alt || "?"}]` };
  };
  const segs = [];
  const re = new RegExp(SEG_NUL + "(\\d+)" + SEG_NUL, "g");
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ type: "text", text: text.slice(last, m.index) });
    segs.push(resolve(medias[+m[1]]));
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ type: "text", text: text.slice(last) });
  return segs;
}

function toADF(text) {
  return { type: "doc", version: 1, content: String(text).split("\n").map((ln) => ({ type: "paragraph", content: ln ? [{ type: "text", text: ln }] : [] })) };
}

// 인라인 마크다운(**굵게**, `코드`, [텍스트](url)·맨 URL) → ADF inline 노드 배열
function mdInline(s) {
  const nodes = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s)]+)/g;
  let last = 0, m;
  const pushText = (t) => { if (t) nodes.push({ type: "text", text: t }); };
  while ((m = re.exec(s))) {
    pushText(s.slice(last, m.index));
    if (m[2] !== undefined) nodes.push({ type: "text", text: m[2], marks: [{ type: "strong" }] });
    else if (m[4] !== undefined) nodes.push({ type: "text", text: m[4], marks: [{ type: "code" }] });
    else if (m[5] !== undefined) nodes.push({ type: "text", text: m[6], marks: [{ type: "link", attrs: { href: m[7] } }] });
    else if (m[8] !== undefined) nodes.push({ type: "text", text: m[8], marks: [{ type: "link", attrs: { href: m[8] } }] });
    last = re.lastIndex;
  }
  pushText(s.slice(last));
  return nodes.length ? nodes : [{ type: "text", text: s }];
}

// 요약 마크다운 → ADF 문서(제목/불릿/표/구분선/문단). FE prefill 친화적 서식 보존용.
function mdToADF(md) {
  const lines = String(md == null ? "" : md).replace(/\r\n/g, "\n").split("\n");
  const content = [];
  const isBullet = (l) => /^\s*[*\-]\s+/.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i], t = line.trim();
    if (t === "") { i++; continue; }                                   // 빈 줄 = 문단 경계
    if (/^(-{3,}|\*{3,})$/.test(t)) { content.push({ type: "rule" }); i++; continue; }
    const hx = t.match(/^(#{1,6})\s+(.*)$/);
    if (hx) { content.push({ type: "heading", attrs: { level: hx[1].length }, content: mdInline(hx[2]) }); i++; continue; }
    if (isBullet(line)) {
      const items = [];
      while (i < lines.length && isBullet(lines[i])) {
        items.push({ type: "listItem", content: [{ type: "paragraph", content: mdInline(lines[i].replace(/^\s*[*\-]\s+/, "")) }] });
        i++;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {                                 // 표: 헤더/구분선 행 스킵, 나머지는 '·' 로 연결한 문단(우아한 강등)
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) { i++; continue; }
      const cells = t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean);
      content.push({ type: "paragraph", content: mdInline(cells.join(" · ")) });
      i++; continue;
    }
    content.push({ type: "paragraph", content: mdInline(t) });
    i++;
  }
  return { type: "doc", version: 1, content };
}

function buildReplyADF(body, replyTo) {
  const content = [];
  if (replyTo && replyTo.snippet) {
    const q = String(replyTo.snippet).split("\n").map((ln) => ({ type: "paragraph", content: ln ? [{ type: "text", text: ln }] : [] }));
    content.push({ type: "blockquote", content: q.length ? q : [{ type: "paragraph", content: [] }] });
  }
  String(body).split("\n").forEach((ln, idx) => {
    const para = { type: "paragraph", content: [] };
    if (idx === 0 && replyTo && replyTo.accountId) {
      para.content.push({ type: "mention", attrs: { id: replyTo.accountId, text: "@" + (replyTo.author || "user") } });
      para.content.push({ type: "text", text: " " });
    }
    if (ln) para.content.push({ type: "text", text: ln });
    content.push(para);
  });
  if (content.length === 0) content.push({ type: "paragraph", content: [] });
  return { type: "doc", version: 1, content };
}

function maskCreds(c) {
  return {
    anthropicApiKey: !!c.anthropicApiKey, openaiApiKey: !!c.openaiApiKey, geminiApiKey: !!c.geminiApiKey, githubToken: !!c.githubToken,
    atlassianEmail: c.atlassianEmail || "", atlassianToken: !!c.atlassianToken, slackWebhookUrl: !!c.slackWebhookUrl,
  };
}

function applyCreds(cur, b) {
  const apply = (k) => (b[k] === undefined ? cur[k] : b[k] === "__CLEAR__" ? "" : b[k] === "" ? cur[k] : b[k]);
  return {
    anthropicApiKey: apply("anthropicApiKey"),
    openaiApiKey: apply("openaiApiKey"),
    geminiApiKey: apply("geminiApiKey"),
    githubToken: apply("githubToken"),
    atlassianEmail: b.atlassianEmail !== undefined ? b.atlassianEmail : cur.atlassianEmail,
    atlassianToken: apply("atlassianToken"),
    slackWebhookUrl: apply("slackWebhookUrl"),
  };
}

// 프로젝트 스토어(파일 경로 주입형) — 단위 테스트는 임시 경로로 생성해 검증한다.
function createStore({ projectsPath, credsPath, configPath, credPath, defaultConfig }) {
  function migrateIfNeeded() {
    if (readJson(projectsPath, null)) return false;
    const legacy = configPath && readJson(configPath, null);
    if (legacy) {
      const id = slugify(legacy.projectKey || "default");
      const name = legacy.projectKey || "기본 프로젝트";
      writeJson(projectsPath, { projects: [{ id, name, ...legacy }] });
      const lc = credPath && readJson(credPath, null);
      if (lc) writeJson(credsPath, { [id]: { ...DEFAULT_CREDS, ...lc } }, 0o600);
      return id;
    }
    writeJson(projectsPath, { projects: [] });
    return false;
  }
  function listProjects() {
    const raw = readJson(projectsPath, { projects: [] });
    return (raw.projects || []).map((p) => { const m = { ...defaultConfig, ...p }; return { ...m, repos: normalizeRepos(m) }; });
  }
  function getProject(id) { return listProjects().find((p) => p.id === id) || null; }
  function defaultProjectId() { const l = listProjects(); return l.length ? l[0].id : null; }
  function saveProject(p) {
    const list = listProjects();
    let id = p.id || slugify(p.name || p.projectKey || "proj");
    if (!p.id) { const base = id; let n = 2; while (list.some((x) => x.id === id)) id = `${base}-${n++}`; }
    const idx = list.findIndex((x) => x.id === id);
    const merged = idx >= 0 ? { ...list[idx], ...p, id } : { ...defaultConfig, ...p, id };
    if (idx >= 0) list[idx] = merged; else list.push(merged);
    writeJson(projectsPath, { projects: list });
    return merged;
  }
  function removeProject(id) {
    writeJson(projectsPath, { projects: listProjects().filter((p) => p.id !== id) });
    const all = readJson(credsPath, {});
    if (all[id]) { delete all[id]; writeJson(credsPath, all, 0o600); }
  }
  function getProjectCreds(id) { const all = readJson(credsPath, {}); return { ...DEFAULT_CREDS, ...(all[id] || {}) }; }
  function setProjectCreds(id, next) { const all = readJson(credsPath, {}); all[id] = { ...DEFAULT_CREDS, ...(all[id] || {}), ...next }; writeJson(credsPath, all, 0o600); }
  return { migrateIfNeeded, listProjects, getProject, defaultProjectId, saveProject, removeProject, getProjectCreds, setProjectCreds };
}

// plan 질문 코멘트의 "제안:" 줄을 뽑아 답변 초안을 만든다.
// 권장 형식(run-jira-agent.sh plan 프롬프트가 지시):
//   1. <질문>
//      💡 제안: <제안 답변> (근거: <한 줄 근거>)
// 엔진이 번호 대신 불릿(•/-/*)을 쓰거나 💡·근거를 빼는 경우도 흔해서 둘 다 받는다.
// 여러 plan 회차가 쌓일 수 있으므로 제안이 담긴 '마지막' 코멘트만 본다.
const SUGGEST_MARK = "💡 제안:";
const SUGGEST_RE = /^[\s>]*(?:[•·\-*]\s*)?(?:💡\s*)?제안\s*[:：]\s*(.+?)\s*$/;
const QUESTION_RE = /^[\s>]*(?:(\d+)\s*[.)]|[•·\-*])\s*(.+?)\s*$/;
function parseSuggestedAnswers(comments) {
  const hasSuggestion = (c) => String((c && c.body) || "").split(/\r?\n/).some((l) => SUGGEST_RE.test(l));
  const src = (Array.isArray(comments) ? comments : []).filter(hasSuggestion).pop();
  if (!src) return null;
  const items = [];
  let num = 0, question = "";
  for (const raw of String(src.body).split(/\r?\n/)) {
    const sug = raw.match(SUGGEST_RE);
    if (!sug) {
      const q = raw.match(QUESTION_RE);
      if (q) { num = q[1] ? parseInt(q[1], 10) : 0; question = q[2]; }
      continue;
    }
    // 근거는 답변 초안에서 빼고 따로 보관 — 초안은 그대로 Jira 코멘트로 나가기 때문.
    let text = sug[1], rationale = "";
    const m = text.match(/^(.*?)\s*[(（]\s*근거\s*[:：]\s*(.+?)\s*[)）][.。]?\s*$/);
    if (m) { text = m[1].trim(); rationale = m[2].trim(); }
    if (!text) continue;
    items.push({ n: num || items.length + 1, question, suggestion: text, rationale });
    num = 0; question = "";
  }
  if (!items.length) return null;
  return {
    commentId: src.id, count: items.length, items,
    draft: items.map((it, i) => `${it.n || i + 1}. ${it.suggestion}`).join("\n"),
  };
}

// ===== 에픽 연속 개발(run-epic-loop.js) 순수 로직 =====
// 한 에픽의 하위 태스크를 생성순으로 하나씩: prepare→plan→adopt→build(+리뷰 승인 루프)→await-merge.
// 러너는 상태를 <CLONE_BASE>/.state/<EPIC>.epic.json 에 쓰고 대시보드가 폴링한다.
const EPIC_STEPS = ["prepare", "plan", "adopt", "build", "approve", "await-merge"];
// 하위 태스크 조회 JQL — 미완료(완료 상태·Done 카테고리 제외) 전부, 생성순.
// link: "parent"(기본) 또는 "epic-link" — 구형 company-managed 프로젝트는 'Epic Link' 만 먹는다.
function epicChildrenJql(epicKey, cfg, link) {
  const done = effectiveDoneStatuses(cfg || {});
  const excl = done.length ? ` AND status NOT IN (${done.map((s) => `"${s}"`).join(", ")})` : "";
  const clause = link === "epic-link" ? `"Epic Link" = "${epicKey}"` : `parent = "${epicKey}"`;
  return `${clause} AND statusCategory != Done${excl} ORDER BY created ASC`;
}
// 태스크의 남은 단계 판정 — 라벨/상태로 '어디부터 하면 되는지'를 정한다(중단 후 재개·중복 실행 방지).
function epicTaskStep(task, cfg) {
  const c = cfg || {};
  const labels = (task && task.labels) || [];
  if (task && task.done) return null;                                   // 이미 완료된 카드는 건너뜀
  if (labels.includes(c.prOpenLabel || "claude-pr")) return "await-merge"; // PR 올림 → 병합 대기
  if (!labels.includes(c.triggerLabel || "claude-work")) return "prepare";
  if (!labels.includes(c.plannedLabel || "claude-planned")) return "plan";
  if (!labels.includes(c.answeredLabel || "claude-answered")) return "adopt";
  return "build";
}
// 다음에 처리할 태스크(생성순으로 처리할 게 남은 첫 카드). 없으면 null → 에픽 완료.
function nextEpicTask(tasks, cfg) {
  for (const t of tasks || []) { const step = epicTaskStep(t, cfg); if (step) return { ...t, step }; }
  return null;
}
// 이번 단계 다음 단계(마지막이면 null)
function nextEpicStep(step) {
  const i = EPIC_STEPS.indexOf(step);
  return (i < 0 || i >= EPIC_STEPS.length - 1) ? null : EPIC_STEPS[i + 1];
}
// 제안 답변 → Jira 답변 코멘트 본문. 자동 채택임을 명시해 사람이 나중에 구분할 수 있게 한다.
function buildAdoptedAnswerBody(suggested, epicKey) {
  if (!suggested || !suggested.items || !suggested.items.length) return "";
  const head = `[에픽 연속 개발${epicKey ? ` · ${epicKey}` : ""}] plan 이 제시한 제안 답변을 그대로 채택합니다.`;
  const lines = suggested.items.map((it, i) => {
    const n = it.n || i + 1;
    return it.question ? `${n}. ${it.question}\n→ ${it.suggestion}` : `${n}. ${it.suggestion}`;
  });
  return `${head}\n\n${lines.join("\n\n")}`;
}

// PR 이 정말 이 카드의 것인지 판정.
// `gh pr list --search <KEY>` 는 PR 본문까지 전문 검색하므로, 본문에 다른 카드 키를 언급한 PR
// (예: "후속: EKYB-820")이 그 카드의 PR 로도 잡힌다. 자동화는 브랜치를 `feat/<KEY>-…`,
// 제목을 `… (<KEY>)` 로 만들므로 둘 중 하나에 키가 있으면 그 카드의 PR 로 본다.
function prBelongsToCard(pr, key) {
  if (!pr || !key) return false;
  const k = String(key).toUpperCase();
  const has = (v) => String(v || "").toUpperCase().includes(k);
  return has(pr.branch) || has(pr.title);
}

// ===== 에픽 자동 병합 옵션 =====
// 리뷰 승인까지 끝난 PR 을 사람이 오래 병합하지 않으면 대기 시간 뒤에 자동 병합한다.
// 기본 60분, 1분~24시간(1440분) 범위.
const EPIC_AUTO_MERGE_MIN_DEFAULT = 60;
const EPIC_AUTO_MERGE_MIN_LIMIT = 1440;
function clampAutoMergeMin(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return EPIC_AUTO_MERGE_MIN_DEFAULT;
  return Math.min(n, EPIC_AUTO_MERGE_MIN_LIMIT);
}
// 자동 병합 판정 — 켜져 있고, 대기 시간을 넘겼고, 열린 PR 이 '모두 리뷰 승인' 됐을 때만.
// 미승인 PR 이 하나라도 있으면 시간이 지나도 병합하지 않는다(승인 게이트를 우회하지 않기 위해).
function shouldAutoMerge(opts, waitStartedAt, openPRs, now) {
  if (!opts || !opts.autoMerge) return { merge: false, reason: "off" };
  const prs = openPRs || [];
  if (!prs.length) return { merge: false, reason: "no-open-pr" };
  if (!prs.every((p) => p.approved)) return { merge: false, reason: "not-approved" };
  const start = Date.parse(waitStartedAt || "");
  if (!Number.isFinite(start)) return { merge: false, reason: "no-start" };
  const dueMs = start + clampAutoMergeMin(opts.autoMergeAfterMin) * 60000;
  const t = (now instanceof Date ? now.getTime() : Number(now)) || Date.now();
  return t >= dueMs ? { merge: true, reason: "due", dueMs } : { merge: false, reason: "waiting", dueMs };
}

// ===== 에픽 자동 재시도 =====
// 중단(paused) 사유가 '시간이 지나면 풀리는' 종류면 대시보드가 일정 시간 뒤 자동으로 재개한다.
// 가장 흔한 원인은 사용량 한도(토큰 소진)이고, 엔진이 해제 시각을 함께 알려준다:
//   "You've hit your session limit · resets 1:40pm (Asia/Seoul)"
// 실측상 해제까지 9시간 넘게 걸리는 경우도 있어, 고정 백오프로는 닿지 않는다 → 시각을 파싱해 그때 재시도한다.
const EPIC_RETRY_MAX_DEFAULT = 5;
const EPIC_RETRY_MAX_LIMIT = 20;
// 해제 시각을 못 얻었을 때 쓰는 점증 백오프(분). 마지막 값을 넘어서면 마지막 값을 계속 쓴다.
const EPIC_RETRY_BACKOFF_MIN = [10, 30, 60, 120, 240];
const EPIC_RETRY_BUFFER_MIN = 2;    // 해제 시각 직후는 아직 안 풀릴 수 있어 여유를 둔다

function clampRetryMax(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return EPIC_RETRY_MAX_DEFAULT;
  return Math.min(n, EPIC_RETRY_MAX_LIMIT);
}

// 지정 타임존에서 '지금'이 몇 분(0~1439)인지. TZ 변환 없이 '지금부터 몇 분 뒤'만 계산하기 위한 것.
function minutesOfDayInTZ(date, tz) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" })
      .formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
    const h = parseInt(p.hour, 10) % 24, m = parseInt(p.minute, 10);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  } catch { return null; }
}

// "resets 1:40pm (Asia/Seoul)" / "resets 3pm" / "resets 10am" → 재시도할 시각(Date). 못 읽으면 null.
// 해당 타임존 기준으로 '다음 번 그 시각'까지 남은 분을 구해 now 에 더한다(절대 TZ 변환을 피해 DST 영향을 줄임).
function parseUsageLimitReset(text, now) {
  const s = String(text || "");
  const m = s.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = (m[3] || "").toLowerCase();
  if (h > 23 || min > 59) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  const tz = (m[4] || "").trim();
  const base = now instanceof Date ? now : new Date(now || Date.now());
  const nowMin = tz ? minutesOfDayInTZ(base, tz) : (base.getHours() * 60 + base.getMinutes());
  if (nowMin == null) return null;
  let delta = (h * 60 + min) - nowMin;
  if (delta <= 0) delta += 1440;                      // 이미 지난 시각이면 '내일 그 시각'
  return new Date(base.getTime() + (delta + EPIC_RETRY_BUFFER_MIN) * 60000);
}

// 중단 사유 분류. retryable=false 면 시간이 지나도 그대로라 사람이 봐야 한다.
function classifyPause(reason, lastError) {
  const t = `${reason || ""}\n${lastError || ""}`;
  if (/session limit|usage limit|rate limit|quota|too many requests|\b429\b|overloaded/i.test(t)) {
    return { retryable: true, kind: "usage-limit", label: "사용량 한도(토큰) 소진" };
  }
  // 사람 판단이 필요한 것들 — 재시도해도 결과가 같다
  if (/제안 답변이 없|리뷰 승인이 남았|자동 병합 실패/.test(t)) {
    return { retryable: false, kind: "needs-human", label: "사람 확인 필요" };
  }
  if (/답변 대기|awaiting answers/i.test(t)) {
    return { retryable: false, kind: "awaiting-answer", label: "카드 질문 답변 대기" };
  }
  if (/실행 실패|exit \d+|오류|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up/i.test(t)) {
    return { retryable: true, kind: "transient", label: "일시적 실행 실패" };
  }
  return { retryable: false, kind: "unknown", label: "분류되지 않은 중단" };
}

// 다음 재시도 계획. attempt 는 '지금까지 시도한 횟수'(0부터).
function planRetry(run, attempt, cfg, now) {
  const opts = cfg || {};
  if (!opts.autoRetry) return { retry: false, why: "off" };
  const max = clampRetryMax(opts.autoRetryMax);
  const c = classifyPause(run && run.reason, run && run.lastError);
  if (!c.retryable) return { retry: false, why: c.kind, kind: c.kind, label: c.label };
  if (attempt >= max) return { retry: false, why: "max-attempts", kind: c.kind, label: c.label, max };
  const base = now instanceof Date ? now : new Date(now || Date.now());
  const reset = c.kind === "usage-limit" ? parseUsageLimitReset(run && run.lastError, base) : null;
  const at = reset || new Date(base.getTime() + EPIC_RETRY_BACKOFF_MIN[Math.min(attempt, EPIC_RETRY_BACKOFF_MIN.length - 1)] * 60000);
  return { retry: true, at, kind: c.kind, label: c.label, max, source: reset ? "reset-time" : "backoff" };
}

module.exports = {
  DEFAULT_CREDS, readJson, writeJson, slugify, triggerClause, detectJql,
  adfToText, adfSegments, toADF, mdInline, mdToADF, buildReplyADF, maskCreds, applyCreds, createStore, doneStatusList, effectiveDoneStatuses,
  REPO_LABEL_PREFIX, repoNameFromUrl, normalizeRepos, cardRepos, REVIEW_APPROVED_MARKER,
  loadOrCreateEnvKey, encryptEnv, decryptEnv,
  ENGINES, DEFAULT_ENGINE, DEFAULT_MODEL, resolveEngine,
  REVIEW_LOOP_MAX_DEFAULT, REVIEW_LOOP_MAX_LIMIT, clampReviewLoopMax,
  SUGGEST_MARK, parseSuggestedAnswers,
  EPIC_STEPS, epicChildrenJql, epicTaskStep, nextEpicTask, nextEpicStep, buildAdoptedAnswerBody, prBelongsToCard,
  EPIC_AUTO_MERGE_MIN_DEFAULT, EPIC_AUTO_MERGE_MIN_LIMIT, clampAutoMergeMin, shouldAutoMerge,
  EPIC_RETRY_MAX_DEFAULT, EPIC_RETRY_MAX_LIMIT, EPIC_RETRY_BACKOFF_MIN, clampRetryMax,
  parseUsageLimitReset, classifyPause, planRetry,
};
