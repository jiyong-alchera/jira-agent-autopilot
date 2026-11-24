// 오래된 작업 정리(보관 기간) — 무엇을 지우고 무엇을 남기는지.
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../lib");

const DAY = 86400000;
const NOW = Date.parse("2026-11-24T00:00:00Z");
const ago = (d) => NOW - d * DAY;
const iso = (d) => new Date(ago(d)).toISOString();

test("clampRetentionDays: 빈 값은 기본값, 0 이하는 끔, 소수는 버림", () => {
  assert.strictEqual(lib.clampRetentionDays("", 30), 30);
  assert.strictEqual(lib.clampRetentionDays(undefined, 7), 7);
  assert.strictEqual(lib.clampRetentionDays("abc", 30), 30);
  assert.strictEqual(lib.clampRetentionDays(0, 30), 0);
  assert.strictEqual(lib.clampRetentionDays(-3, 30), 0);
  assert.strictEqual(lib.clampRetentionDays("14.7", 30), 14);
  assert.strictEqual(lib.clampRetentionDays(99999, 30), 3650);
});

test("stateFileKey / cloneDirKey: 파일·폴더 이름에서 카드 키", () => {
  assert.strictEqual(lib.stateFileKey("AML-257.build.out"), "AML-257");
  assert.strictEqual(lib.stateFileKey("AML-257-rebase-mvn.log"), "AML-257");
  assert.strictEqual(lib.stateFileKey("EKYB-799.images"), "EKYB-799");
  assert.strictEqual(lib.stateFileKey("sentry-ekyb.json"), null);
  assert.strictEqual(lib.cloneDirKey("physical-ai-agentsystem-PHYS-513"), "PHYS-513");
  assert.strictEqual(lib.cloneDirKey("shotsA"), null);
});

test("retentionPlan: 30일 지난 카드는 summary 만 남기고 산출물을 지운다", () => {
  const r = lib.retentionPlan({
    now: NOW, retentionDays: 30, cloneDays: 7,
    stateEntries: [
      { name: "EKYB-1.plan.out", mtimeMs: ago(40) },
      { name: "EKYB-1.build.out", mtimeMs: ago(35) },
      { name: "EKYB-1.summary.md", mtimeMs: ago(35) },
      { name: "EKYB-1.images", mtimeMs: ago(40) },
      { name: "EKYB-1-rebase-mvn.log", mtimeMs: ago(36) },
      { name: "AML-9.build.out", mtimeMs: ago(3) },
      { name: "sentry-ekyb.json", mtimeMs: ago(90) },
    ],
    clones: [], history: [], active: [],
  });
  assert.deepStrictEqual(r.stateRemove.sort(), ["EKYB-1-rebase-mvn.log", "EKYB-1.build.out", "EKYB-1.images", "EKYB-1.plan.out"]);
});

test("retentionPlan: 마지막 활동은 파일·clone·이력 중 가장 최근 — 최근 이력이 있으면 남긴다", () => {
  const r = lib.retentionPlan({
    now: NOW, retentionDays: 30, cloneDays: 7,
    stateEntries: [{ name: "PHYS-5.build.out", mtimeMs: ago(60) }],
    clones: [], history: [{ key: "PHYS-5", ts: iso(10), phase: "review", result: "reviewed" }], active: [],
  });
  assert.deepStrictEqual(r.stateRemove, []);
});

test("retentionPlan: clone 은 완료 7일 뒤, 완료 기록이 없으면 30일 뒤", () => {
  const r = lib.retentionPlan({
    now: NOW, retentionDays: 30, cloneDays: 7,
    stateEntries: [],
    clones: [
      { name: "aml-lite-AML-1", mtimeMs: ago(8) },     // 완료 8일 → 삭제
      { name: "aml-lite-AML-2", mtimeMs: ago(3) },     // 완료 3일 → 유지
      { name: "aml-lite-AML-3", mtimeMs: ago(10) },    // 미완료 10일 → 유지
      { name: "aml-lite-AML-4", mtimeMs: ago(31) },    // 미완료 31일 → 삭제
    ],
    history: [
      { key: "AML-1", ts: iso(8), phase: "merge", result: "merged" },
      { key: "AML-2", ts: iso(3), phase: "epic", result: "task-done" },
    ],
    active: [],
  });
  assert.deepStrictEqual(r.clonesRemove, [
    { name: "aml-lite-AML-1", key: "AML-1", reason: "done" },
    { name: "aml-lite-AML-4", key: "AML-4", reason: "old" },
  ]);
});

test("retentionPlan: 작업 중인 카드와 끝나지 않은 에픽은 날짜와 상관없이 건너뛴다", () => {
  const r = lib.retentionPlan({
    now: NOW, retentionDays: 30, cloneDays: 7,
    stateEntries: [
      { name: "AML-7.build.out", mtimeMs: ago(50) },
      { name: "AML-250.epic-design.md", mtimeMs: ago(50) },
      { name: "AML-164.epic-design.md", mtimeMs: ago(50) },
      { name: "AML-164.epic.json", mtimeMs: ago(50) },
    ],
    clones: [{ name: "aml-lite-AML-7", mtimeMs: ago(50) }],
    history: [{ key: "AML-7", ts: iso(50), phase: "merge", result: "merged" }],
    active: ["AML-7"],
    epicStatus: { "AML-250": "paused", "AML-164": "done" },
  });
  assert.deepStrictEqual(r.stateRemove, ["AML-164.epic-design.md"]);
  assert.deepStrictEqual(r.clonesRemove, []);
});

test("retentionPlan: 0 이면 그 정리는 끈다", () => {
  const input = {
    now: NOW,
    stateEntries: [{ name: "AB-1.build.out", mtimeMs: ago(100) }],
    clones: [{ name: "r-AB-1", mtimeMs: ago(100) }],
    history: [{ key: "AB-1", ts: iso(100), phase: "merge", result: "merged" }], active: [],
  };
  const off = lib.retentionPlan({ ...input, retentionDays: 0, cloneDays: 0 });
  assert.deepStrictEqual(off, { stateRemove: [], clonesRemove: [] });
  const cloneOnly = lib.retentionPlan({ ...input, retentionDays: 0, cloneDays: 7 });
  assert.deepStrictEqual(cloneOnly.stateRemove, []);
  assert.strictEqual(cloneOnly.clonesRemove.length, 1);
});

test("logTrimOffset: cutoff 이전 시각 줄과 거기 딸린 줄을 잘라낸다", () => {
  const log = [
    "[2026-10-01 01:00:00] old",
    ">> [AML-1] 딸린 줄",
    "[2026-11-20 01:00:00] new",
    ">> [AML-2] 새 줄",
    "",
  ].join("\n");
  const cut = Date.parse("2026-10-25T00:00:00Z");
  const off = lib.logTrimOffset(log, cut);
  assert.strictEqual(log.slice(off), "[2026-11-20 01:00:00] new\n>> [AML-2] 새 줄\n");
  assert.strictEqual(lib.logTrimOffset(log, Date.parse("2026-09-01T00:00:00Z")), 0);
  assert.strictEqual(lib.logTrimOffset(log, Date.parse("2026-12-01T00:00:00Z")), log.length);
  assert.strictEqual(lib.logTrimOffset("시각 없는 로그\n", cut), 0);
});
