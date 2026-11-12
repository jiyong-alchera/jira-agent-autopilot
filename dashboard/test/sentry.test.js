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
  const off = S.sentryConfig({ sentry: { enabled: false, org: "o", projects: [{ slug: "a", repo: "r" }] } });
  assert.equal(S.sentryReady(off, { sentryToken: "t" }, { ignoreEnabled: true }).ok, true);   // 미리보기
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
  const hit = { id: "9", level: "fatal", title: "Error: x", culprit: "app/page", count: "100" };   // culprit 이 있어도 제목만으로 걸린다
  assert.equal(S.securityMatch(hit, conf), "^Error: x$");
  assert.equal(S.securityMatch({ title: "Error: xyz" }, conf), "");
  assert.deepEqual(S.pickIssues([hit, { id: "8", level: "fatal", title: "TypeError" }], conf).map((i) => i.id), ["8"]);
});

test("overviewRows: 병합 > 에픽 워커 > 태스크 목록 > 대기 순으로 단계를 정하고, 문제 있는 것부터 정렬", () => {
  const state = {
    issues: {
      "1": { key: "K-1", env: "dev", title: "a", createdAt: "2026-11-12T00:00:01Z", notified: { start: true, merged: "2026-11-12T01:00:00Z" } },
      "2": { key: "K-2", env: "qa", title: "b", createdAt: "2026-11-12T00:00:02Z", notified: { start: true } },
      "3": { key: "K-3", env: "prod", title: "c", createdAt: "2026-11-12T00:00:03Z", notified: { start: true } },
      "4": { key: "K-4", env: "dev", title: "d", createdAt: "2026-11-12T00:00:04Z" },
      "5": { key: "K-5", env: "dev", title: "e", createdAt: "2026-11-12T00:00:05Z" },
    },
    security: { "9": { env: "dev", title: "Error: x", at: "2026-11-12T00:00:00Z" } },
  };
  const epic = {
    workers: [{ key: "K-2", status: "running", step: "build" }, { key: "K-3", status: "failed", step: "ci", reason: "CI 실패" }],
    tasks: [{ key: "K-4", state: "blocked" }, { key: "K-5", state: "pending" }],
  };
  const { rows, security } = S.overviewRows(state, epic);
  assert.deepEqual(rows.map((r) => [r.key, r.stage]), [["K-3", "failed"], ["K-2", "running"], ["K-4", "blocked"], ["K-5", "queued"], ["K-1", "merged"]]);
  assert.equal(rows[0].reason, "CI 실패");
  assert.equal(rows[1].step, "build");
  assert.equal(security.length, 1);
  assert.deepEqual(S.overviewRows({}, {}), { rows: [], security: [] });
});

test("overviewRows: 병합 뒤 추적 단계 — 재발은 맨 위, 해결은 맨 아래", () => {
  const m = { start: true, merged: "2026-11-12T01:00:00Z" };
  const state = { issues: {
    "1": { key: "K-1", notified: m, track: { resolvedAt: "x", deployedAt: "x", deployedRelease: "abc" } },
    "2": { key: "K-2", notified: m, track: { regressedAt: "x", regressedRelease: "abc", regressedEnv: "qa" } },
    "3": { key: "K-3", notified: m, track: { tag: "v1.5.68", tagAt: "x" } },
    "4": { key: "K-4", notified: { start: true } },
  } };
  const { rows } = S.overviewRows(state, { workers: [{ key: "K-4", status: "running", step: "plan" }] });
  assert.deepEqual(rows.map((r) => [r.key, r.stage]), [["K-2", "regressed"], ["K-4", "running"], ["K-3", "tagged"], ["K-1", "resolved"]]);
  assert.equal(rows[0].track.regressedEnv, "qa");
});

test("combineContains / sortTagsDesc", () => {
  assert.equal(S.combineContains([true, true]), true);
  assert.equal(S.combineContains([true, false]), false);
  assert.equal(S.combineContains([true, null]), null);
  assert.equal(S.combineContains([null, false]), false);
  assert.equal(S.combineContains([]), null);
  assert.deepEqual(S.sortTagsDesc([{ name: "v1.5.9" }, { name: "v1.5.68" }, { name: "v1.5.10" }]).map((t) => t.name), ["v1.5.68", "v1.5.10", "v1.5.9"]);
});

test("advanceTrack: 태그 → 배포 확인 → 기간 뒤 해결, 수정 release 에서 다시 나면 재발", () => {
  const H = 3600000;
  const merged = Date.parse("2026-11-12T01:00:00Z");
  const base = { mergedAt: "2026-11-12T01:00:00Z", windowMs: 24 * H, giveUpMs: 14 * 24 * H, lastSeen: "2026-11-12T00:30:00Z" };
  // 태그만 — 배포 release 아직 없음
  let r = S.advanceTrack({}, { ...base, now: merged + H, tag: { name: "v1.5.68", at: "2026-11-12T01:01:00Z" },
    envReleases: [{ version: "old", dateCreated: "2026-11-11T00:00:00Z" }], events: [], contains: { old: false } });
  assert.equal(r.track.tag, "v1.5.68");
  assert.deepEqual(r.changes, []);
  assert.equal(S.trackStage({ notified: { merged: "x" }, track: r.track }), "tagged");
  // 카드 환경에 수정 포함 release 가 보임 → 배포 확인. 배포 시각은 병합보다 앞설 수 없다
  r = S.advanceTrack(r.track, { ...base, now: merged + 2 * H, tag: null,
    envReleases: [{ version: "new", dateCreated: "2026-11-12T00:00:00Z" }], events: [], contains: { new: true } });
  assert.deepEqual(r.changes, ["deployed"]);
  assert.equal(r.track.deployedAt, "2026-11-12T01:00:00Z");
  // 기간이 지나도 재발 없음 → 해결
  r = S.advanceTrack(r.track, { ...base, now: merged + 25 * H, envReleases: [], events: [], contains: {} });
  assert.deepEqual(r.changes, ["resolved"]);
  assert.equal(S.trackDone(r.track), false);   // 해결 뒤에도 재발은 계속 본다
  // 병합 뒤 옛 release 이벤트는 재발이 아니고, 수정 release 이벤트는 재발
  r = S.advanceTrack(r.track, { ...base, now: merged + 26 * H, envReleases: [],
    events: [{ release: "old", env: "dev", at: "2026-11-12T03:00:00Z" }, { release: "new", env: "qa", at: "2026-11-13T02:00:00Z" }],
    contains: { old: false, new: true } });
  assert.deepEqual(r.changes, ["regressed"]);
  assert.equal(r.track.regressedEnv, "qa");
  assert.equal(S.trackDone(r.track), true);
  assert.equal(S.trackStage({ notified: { merged: "x" }, track: r.track }), "regressed");
});

test("advanceTrack: release 가 안 잡히면 태그 뒤 기간 내 재발 없음을 보조로 표시하고, 다시 나면 지운다 · 기한이 지나면 종료", () => {
  const H = 3600000;
  const merged = Date.parse("2026-11-12T01:00:00Z");
  const base = { mergedAt: "2026-11-12T01:00:00Z", windowMs: 24 * H, giveUpMs: 14 * 24 * H, envReleases: [], events: [], contains: {} };
  const t0 = { tag: "v1", tagAt: "2026-11-12T01:00:00Z" };
  let r = S.advanceTrack(t0, { ...base, now: merged + 25 * H, lastSeen: "2026-11-12T00:00:00Z" });
  assert.ok(r.track.quietAt);
  assert.equal(S.trackStage({ notified: { merged: "x" }, track: r.track }), "quiet");
  r = S.advanceTrack(r.track, { ...base, now: merged + 26 * H, lastSeen: "2026-11-13T01:30:00Z" });
  assert.equal(r.track.quietAt, undefined);
  r = S.advanceTrack(r.track, { ...base, now: merged + 15 * 24 * H, lastSeen: "" });
  assert.ok(r.track.gaveUpAt);
  assert.equal(S.trackDone(r.track), true);
});

test("ignorePatterns: 시험 이벤트는 카드 대상에서 빠지고 보안 의심으로도 보지 않는다", () => {
  const conf = S.sentryConfig({ sentry: { minEvents: 1, ignorePatterns: ["중계기 시험 오류"] } });
  const test1 = { id: "1", level: "error", title: "EKYB-1172 중계기 시험 오류 (무시해도 됩니다)", count: "3" };
  assert.ok(S.ignoreMatch(test1, conf));
  assert.equal(S.securityMatch(test1, conf), "");
  assert.deepEqual(S.pickIssues([test1, { id: "2", level: "error", title: "boom", count: "1" }], conf).map((i) => i.id), ["2"]);
});
