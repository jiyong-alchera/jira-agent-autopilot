const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("../../lib-sentry");

test("sentryConfig: 기본값과 clamp, slug·repo 없는 매핑은 버린다", () => {
  const c = S.sentryConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.baseUrl, "https://sentry.io");
  assert.deepEqual(c.environments, ["dev", "qa", "prod"]);
  assert.equal(c.minEvents, 5);
  assert.equal(c.windowHours, 24);
  assert.equal(c.fatalImmediate, true);
  assert.equal(c.epicSummary, "Sentry 작동 업무 처리");
  const d = S.sentryConfig({ sentry: { enabled: true, baseUrl: "https://s.local/", projects: [{ slug: "api", repo: "kyb-api" }, { slug: "x" }], minEvents: 0, intervalMinutes: 99999 } });
  assert.equal(d.baseUrl, "https://s.local");
  assert.deepEqual(d.projects, [{ slug: "api", repo: "kyb-api" }]);
  assert.equal(d.minEvents, 1);
  assert.equal(d.intervalMinutes, 1440);
});

test("sentryReady: 빠진 항목을 이유로 알려 준다", () => {
  const conf = S.sentryConfig({ sentry: { enabled: true, org: "o", projects: [{ slug: "a", repo: "r" }] } });
  assert.equal(S.sentryReady(conf, {}).why, "sentryToken 없음");
  assert.equal(S.sentryReady(conf, { sentryToken: "t" }).ok, true);
  assert.equal(S.sentryReady(S.sentryConfig({}), { sentryToken: "t" }).ok, false);
});

test("pickIssues: fatal 은 즉시, 그 외는 기간 내 발생 수 기준, 처리한 id·해결된 이슈 제외", () => {
  const conf = S.sentryConfig({ sentry: { minEvents: 5 } });
  const issues = [
    { id: "1", level: "error", count: "3" },
    { id: "2", level: "error", count: "100", stats: { "24h": [[0, 2], [1, 4]] } },   // stats 합 6 ≥ 5
    { id: "3", level: "fatal", count: "1" },
    { id: "4", level: "error", count: "50" },
    { id: "5", level: "error", count: "50", status: "resolved" },
    { id: "6", level: "error", count: "100", stats: { "24h": [[0, 1]] } },           // 기간 내 1 < 5
  ];
  assert.deepEqual(S.pickIssues(issues, conf, new Set(["4"])).map((i) => i.id), ["2", "3"]);
  const noFatal = S.sentryConfig({ sentry: { fatalImmediate: false } });
  assert.deepEqual(S.pickIssues([{ id: "3", level: "fatal", count: "1" }], noFatal).length, 0);
});

test("라벨: 카드 라벨 구성과 환경 역추출", () => {
  const l = S.cardLabels("123", "prod", "kyb-api", "claude-work");
  assert.deepEqual(l, ["claude-work", "sentry", "sentry-123", "sentry-env-prod", "repo_kyb-api"]);
  assert.equal(S.envOfLabels(l), "prod");
  assert.equal(S.isSentryCard(l), true);
  assert.equal(S.isSentryCard(["claude-work"]), false);
  assert.equal(S.envLabel("q a"), "sentry-env-q_a");
});

test("cardSummary: 환경 접두와 길이 제한", () => {
  assert.equal(S.cardSummary({ title: "TypeError: x is undefined" }, "dev"), "[Sentry][dev] TypeError: x is undefined");
  assert.ok(S.cardSummary({ title: "a".repeat(400) }, "qa").length <= 240);
});

test("cardDescription: 앱 프레임·breadcrumb·요청·링크를 담는다", () => {
  const ev = {
    entries: [
      { type: "exception", data: { values: [{ type: "TypeError", value: "boom", stacktrace: { frames: [
        { filename: "node_modules/lib.js", lineNo: 1, function: "lib", inApp: false },
        { filename: "src/svc.js", lineNo: 42, function: "handle", inApp: true, context: [[42, "  return a.b;"]] },
      ] } }] } },
      { type: "breadcrumbs", data: { values: [{ timestamp: "t1", category: "http", message: "GET /api" }] } },
      { type: "request", data: { method: "POST", url: "https://x/api/v1" } },
    ],
    tags: [{ key: "release", value: "1.2.3" }],
  };
  const md = S.cardDescription({ permalink: "https://sentry/i/1", level: "error", count: "7", project: { slug: "api" } }, ev, "prod", S.sentryConfig({}));
  assert.match(md, /https:\/\/sentry\/i\/1/);
  assert.match(md, /환경: prod/);
  assert.match(md, /src\/svc\.js:42 in handle/);
  assert.doesNotMatch(md, /node_modules\/lib\.js/);   // 앱 프레임이 있으면 라이브러리 프레임은 뺀다
  assert.match(md, /\[http\] GET \/api/);
  assert.match(md, /POST https:\/\/x\/api\/v1/);
  assert.match(md, /release=1\.2\.3/);
});

test("accessFileOf + agentInstr: 접근 정보가 있으면 조회만 허용, 없으면 Sentry 정보만", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sentry-acc-"));
  const conf = S.sentryConfig({ sentry: { accessDir: dir } });
  assert.equal(S.accessFileOf(conf, "/x", "p1", "dev"), null);
  fs.writeFileSync(path.join(dir, "p1-dev.md"), "API=https://dev\n");
  fs.writeFileSync(path.join(dir, "p1-qa.md"), "");   // 빈 파일은 없는 것으로 본다
  const f = S.accessFileOf(conf, "/x", "p1", "dev");
  assert.equal(f, path.join(dir, "p1-dev.md"));
  assert.equal(S.accessFileOf(conf, "/x", "p1", "qa"), null);
  assert.match(S.agentInstr("dev", f), /조회·재현만/);
  assert.match(S.agentInstr("dev", f), new RegExp(f.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  assert.match(S.agentInstr("prod", null), /Sentry 정보와 코드만으로/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("taskRepoNames: Sentry 카드는 자기 repo 만, 일반 카드·교집합 없음은 에픽 대상 전부", () => {
  const epic = ["kyb-api", "kyb-client"];
  assert.deepEqual(S.taskRepoNames(["sentry", "repo_kyb-api"], epic), ["kyb-api"]);
  assert.deepEqual(S.taskRepoNames(["repo_kyb-api"], epic), epic);
  assert.deepEqual(S.taskRepoNames(["sentry", "repo_other"], epic), epic);
});

test("notifyUrls: 두 웹훅을 중복 없이, 빈 값은 뺀다", () => {
  assert.deepEqual(S.notifyUrls({ slackWebhookUrl: "a", sentrySlackWebhookUrl: "b" }), ["a", "b"]);
  assert.deepEqual(S.notifyUrls({ slackWebhookUrl: "a", sentrySlackWebhookUrl: "a" }), ["a"]);
  assert.deepEqual(S.notifyUrls({ slackWebhookUrl: "a" }), ["a"]);
  assert.deepEqual(S.notifyUrls({}), []);
});

test("prsFromHistory: 카드의 PR URL 을 모은다", () => {
  const lines = [
    JSON.stringify({ key: "K-1", pr: "https://github.com/o/r/pull/1" }),
    JSON.stringify({ key: "K-2", pr: "https://github.com/o/r/pull/2" }),
    JSON.stringify({ key: "K-1", pr: "https://github.com/o/r/pull/1, https://github.com/o/s/pull/3" }),
    "not json",
  ];
  assert.deepEqual(S.prsFromHistory(lines, "K-1"), ["https://github.com/o/r/pull/1", "https://github.com/o/s/pull/3"]);
});

test("securityMatch: 보안 의심 패턴은 카드 대상에서 빠진다", () => {
  const conf = S.sentryConfig({ sentry: { securityPatterns: ["^Error: x$", "(bad"] } });   // 잘못된 정규식은 무시
  const hit = { id: "9", level: "fatal", title: "Error: x", count: "100" };
  assert.equal(S.securityMatch(hit, conf), "^Error: x$");
  assert.equal(S.securityMatch({ title: "Error: xyz" }, conf), "");
  assert.deepEqual(S.pickIssues([hit, { id: "8", level: "fatal", title: "TypeError" }], conf).map((i) => i.id), ["8"]);
});
