// =============================================================================
// lib-project-env.js — 프로젝트 설정(projects.json) → 스크립트 실행 env 구성.
// run-cycle.js(스케줄 루프)와 run-epic-loop.js(에픽 연속 개발)가 공유한다.
// (server.js 는 대시보드 전용 값(DASHBOARD_URL 등)을 더 얹으므로 자체 scriptEnv 를 유지)
// =============================================================================
const fs = require("fs");
const path = require("path");

const SELF = __dirname;
const DASH = path.join(SELF, "dashboard");
const lib = require(path.join(DASH, "lib"));

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return f; } };

const DEFAULTS = {
  workDir: SELF, baseBranch: "main", triggerMode: "label", triggerLabel: "claude-work", triggerText: "claude-work",
  doneStatus: "DEV COMPLETED", plannedLabel: "claude-planned", answeredLabel: "claude-answered", failedLabel: "claude-failed", prOpenLabel: "claude-pr",
  maxRetries: 3, maxParallel: 5, intervalSeconds: 3600, reviewIntervalSeconds: 3600, envMode: "content", envPath: "", envDest: "", cardEnvDir: "", cloneBase: path.join(SELF, "repos"),
  testCmd: "", buildCmd: "", repoUrl: "", jiraSite: "", projectKey: "", assigneeEmail: "", assigneeName: "",
  engine: "", model: "",   // 비우면 전역 기본값(claude) 상속
};

// repo 별 env 파일(repo 전용만; 없으면 미복사 — run-jira 가 -f 로 확인)
const repoEnvSrc = (cfg, repoName) => path.join(cfg.workDir || SELF, `work-${cfg.id}-${repoName}.env`);
// run-jira-agent.sh 에 넘길 줄 형식: name<US>url<US>baseBranch<US>envSrc<US>envDest (US=\x1f)
const reposToLines = (cfg, repos, envSrcOverride) => (repos || []).map((r) =>
  [r.name, r.url, r.baseBranch || "main", envSrcOverride || repoEnvSrc(cfg, r.name), r.envDest || cfg.envDest || ""].join("\x1f")
).join("\n");

// 카드 전용 env: 로컬 card-envs/<KEY>.env 만 읽는다(Jira 폴백 없음). 없으면 null → repo 전용 env 사용.
function cardEnvLocal(cfg, key) {
  return path.join(cfg.cardEnvDir || path.join(cfg.workDir || SELF, "card-envs"), `${key}.env`);
}
function resolveCardEnv(cfg, key) {
  const p = cardEnvLocal(cfg, key);
  return fs.existsSync(p) ? p : null;
}

function projectEnv(p, cred) {
  const cfg = { ...DEFAULTS, ...p };
  const repos = lib.normalizeRepos(cfg);
  const env = { ...process.env };
  env.PROJECT_ID = cfg.id || "";
  env.WORK_DIR = cfg.workDir;
  const eng = lib.resolveEngine(cfg);   // 프로젝트 override → 없으면 전역 기본값
  env.ENGINE = eng.engine;
  env.MODEL = eng.model;
  env.REPO_URL = (repos[0] && repos[0].url) || cfg.repoUrl || "";
  env.BASE_BRANCH = (repos[0] && repos[0].baseBranch) || cfg.baseBranch || "main";
  env.CARD_REPOS = reposToLines(cfg, repos);   // 기본=전체 repo(카드별로 좁혀짐)
  env.ASSIGNEE_EMAIL = cfg.assigneeEmail;
  env.ASSIGNEE_NAME = cfg.assigneeName;
  env.TRIGGER_MODE = cfg.triggerMode || "label";
  env.TRIGGER_LABEL = cfg.triggerLabel || "claude-work";
  env.TRIGGER_TEXT = cfg.triggerText;
  env.DONE_STATUS = lib.effectiveDoneStatuses(cfg).join(",");   // doneStatus ∪ 매핑 완료
  env.PLANNED_LABEL = cfg.plannedLabel;
  env.ANSWERED_LABEL = cfg.answeredLabel || "claude-answered";
  env.FAILED_LABEL = cfg.failedLabel || "claude-failed";
  env.PR_OPEN_LABEL = cfg.prOpenLabel || "claude-pr";
  env.MAX_RETRIES = String(cfg.maxRetries || 3);
  env.TEST_CMD = cfg.testCmd || "";
  env.BUILD_CMD = cfg.buildCmd || "";
  env.HISTORY_FILE = path.join(SELF, "history.jsonl");
  env.PROJECT_KEY = cfg.projectKey || "";
  env.ENV_SRC = cfg.envPath || path.join(cfg.workDir || SELF, `work-${cfg.id}.env`);
  env.ENV_DEST_REL = cfg.envDest || "";
  env.CLONE_BASE = cfg.cloneBase || path.join(cfg.workDir || SELF, "repos");
  if (cred && cred.anthropicApiKey) env.ANTHROPIC_API_KEY = cred.anthropicApiKey;
  if (cred && cred.openaiApiKey) env.OPENAI_API_KEY = cred.openaiApiKey;   // codex 엔진
  if (cred && cred.geminiApiKey) env.GEMINI_API_KEY = cred.geminiApiKey;   // gemini 엔진
  if (cred && cred.githubToken) { env.GH_TOKEN = cred.githubToken; env.GITHUB_TOKEN = cred.githubToken; }
  if (cred && cred.slackWebhookUrl) env.SLACK_WEBHOOK_URL = cred.slackWebhookUrl;
  // 완료 내역을 설명 ADF 에 직접 append(이미지 보존)하기 위한 Jira REST 자격증명
  env.JIRA_SITE = cfg.jiraSite || "";
  // Atlassian MCP 의 cloudId — 프롬프트에 미리 박아 getAccessibleAtlassianResources 왕복을 없앤다.
  env.JIRA_CLOUD_ID = cfg.jiraCloudId || cfg.jiraSite || "";
  if (cred && cred.atlassianEmail) env.ATLASSIAN_EMAIL = cred.atlassianEmail;
  if (cred && cred.atlassianToken) env.ATLASSIAN_TOKEN = cred.atlassianToken;
  return { cfg, env };
}

// projects.json / project-credentials.json 로드
function loadProjects() {
  return (readJson(path.join(DASH, "projects.json"), { projects: [] }).projects) || [];
}
function loadCreds() { return readJson(path.join(DASH, "project-credentials.json"), {}); }

module.exports = { SELF, DASH, lib, DEFAULTS, readJson, repoEnvSrc, reposToLines, cardEnvLocal, resolveCardEnv, projectEnv, loadProjects, loadCreds };
