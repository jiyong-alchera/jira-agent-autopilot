const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const lib = require("../lib");
const { handleInteractive, resultLine } = require("../slack-socket");

const act = (o) => ({ id: "merge", project: "ekyb", key: "EKYB-1", owner: "Org/repo", number: 7, ...o });

test("버튼이 없으면 blocks 에 actions 섹션을 만들지 않는다", () => {
  const m = lib.slackMessage("그냥 알림", []);
  assert.strictEqual(m.text, "그냥 알림");
  assert.strictEqual(m.blocks.length, 1);
  assert.strictEqual(m.blocks[0].type, "section");
});

test("버튼은 action_id 접두사와 value 를 갖는다", () => {
  const m = lib.slackMessage("승인됨", [act()]);
  const el = m.blocks[1].elements[0];
  assert.strictEqual(m.blocks[1].type, "actions");
  assert.strictEqual(el.action_id, "jaa:merge");
  assert.strictEqual(el.style, "primary");
  assert.deepStrictEqual(lib.decodeSlackAction(el.value), {
    id: "merge", project: "ekyb", key: "EKYB-1", owner: "Org/repo", number: "7", step: "",
  });
});

test("링크 버튼은 url 만 갖고 인터랙션 대상이 아니다", () => {
  const m = lib.slackMessage("PR", [{ url: "https://x/pull/1", label: "🔗 PR" }]);
  const el = m.blocks[1].elements[0];
  assert.strictEqual(el.url, "https://x/pull/1");
  assert.strictEqual(el.value, undefined);
});

test("Slack actions 블록 상한(5개)을 넘지 않는다", () => {
  const many = ["merge", "review-loop", "card-run", "epic-resume", "epic-skip", "epic-stop"].map((id) => act({ id }));
  assert.strictEqual(lib.slackMessage("t", many).blocks[1].elements.length, 5);
});

test("모르는 동작 id·깨진 JSON·잘못된 이슈 키는 디코드되지 않는다", () => {
  assert.strictEqual(lib.decodeSlackAction('{"a":"rm-rf","k":"EKYB-1"}'), null);
  assert.strictEqual(lib.decodeSlackAction("깨진값"), null);
  assert.strictEqual(lib.decodeSlackAction('{"a":"merge","k":"../etc"}'), null);
});

test("허용 사용자 미설정이면 아무도 실행할 수 없다", () => {
  assert.strictEqual(lib.slackActorAllowed({}, "U1"), false);
  assert.strictEqual(lib.slackActorAllowed({ slackAllowUsers: "" }, "U1"), false);
});

test("허용 목록은 쉼표·공백 구분이고 목록 밖 사용자는 거부한다", () => {
  const c = { slackAllowUsers: "U1, U2  U3" };
  assert.strictEqual(lib.slackActorAllowed(c, "U2"), true);
  assert.strictEqual(lib.slackActorAllowed(c, "U3"), true);
  assert.strictEqual(lib.slackActorAllowed(c, "U9"), false);
  assert.strictEqual(lib.slackActorAllowed(c, ""), false);
});

// ----- 인터랙션 처리 -----
function payload(value, userId) {
  return { type: "block_actions", user: { id: userId, username: "tester" }, response_url: "", actions: [{ action_id: "jaa:merge", value }] };
}

test("권한 없는 사용자의 클릭은 API 를 호출하지 않는다", async () => {
  let called = false;
  const deps = {
    getProjectCreds: () => ({ slackAllowUsers: "U1" }),
    baseUrl: "http://127.0.0.1:1",
    runAction: async () => { called = true; return { ok: true }; },
  };
  const r = await handleInteractive(payload(lib.encodeSlackAction(act()), "U9"), deps);
  assert.strictEqual(r.denied, true);
  assert.strictEqual(called, false);
});

test("block_actions 가 아닌 payload 는 무시한다", async () => {
  const r = await handleInteractive({ type: "view_submission" }, { getProjectCreds: () => ({}) });
  assert.strictEqual(r, null);
});

test("우리 버튼이 아닌 action_id 는 무시한다", async () => {
  const p = { type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "other:x", value: "{}" }] };
  assert.strictEqual(await handleInteractive(p, { getProjectCreds: () => ({}) }), null);
});

test("결과 문구는 라우트별 응답 모양을 흡수한다", () => {
  assert.match(resultLine("merge", { ok: true, merged: 2, doneStatus: "DEV COMPLETED" }), /병합 완료 — PR 2건 · 카드 DEV COMPLETED/);
  assert.match(resultLine("merge", { ok: false, message: "CI 실패" }), /실패 — CI 실패/);
  // 병합 라우트는 message 없이 errors 만 주기도 한다(CI 게이트) — 사유가 그대로 보여야 한다
  assert.match(resultLine("merge", { ok: false, merged: 0, errors: ["repo #51: CI 가 아직 진행 중이라 병합하지 않았습니다"] }),
    /실패 — repo #51: CI 가 아직 진행 중이라 병합하지 않았습니다/);
  assert.match(resultLine("merge", { ok: false, errors: [] }), /실패 — 알 수 없는 오류/);
  assert.match(resultLine("epic-skip", { ok: true, resumedAt: "review" }), /건너뛰고 진행 — review 부터/);
});

test("SLACK_ACTIONS 의 모든 동작이 대시보드 API 경로로 매핑된다", () => {
  for (const [id, def] of Object.entries(lib.SLACK_ACTIONS)) {
    const url = def.api({ key: "EKYB-1" });
    assert.match(url, /^\/api\/(cards|epics)\/EKYB-1\//, `${id} 경로 오류: ${url}`);
    assert.strictEqual(typeof def.body({ owner: "o", number: "1" }), "object");
  }
});

test("셸용 알림 전송기가 액션 문자열을 버튼으로 변환한다", () => {
  const { parseAction } = require(path.join(__dirname, "..", "..", "slack-notify.js"));
  const ctx = { project: "ekyb", key: "EKYB-1" };
  assert.deepStrictEqual(parseAction("merge:Org/repo:7", ctx), { id: "merge", project: "ekyb", key: "EKYB-1", owner: "Org/repo", number: "7" });
  assert.deepStrictEqual(parseAction("url:🔗 PR:https://x/pull/1", ctx), { url: "https://x/pull/1", label: "🔗 PR" });
  assert.strictEqual(parseAction("epic-resume", ctx).id, "epic-resume");
  assert.strictEqual(parseAction("nope", ctx), null);
});

// 실패해도 버튼이 남아야 한다 — 사라지면 Slack 에서 재시도할 방법이 없다.
test("실패하면 원본 버튼을 남기고 사유만 덧붙인다", async () => {
  const sent = [];
  const orig = lib.slackMessage("승인됨", [act()]).blocks;
  const p = { ...payload(lib.encodeSlackAction(act()), "U1"), response_url: "https://slack/r", message: { blocks: orig } };
  const deps = {
    getProjectCreds: () => ({ slackAllowUsers: "U1" }),
    runAction: async () => ({ ok: false, errors: ["repo #51: CI 가 아직 진행 중이라 병합하지 않았습니다"] }),
    fetch: null,
  };
  global.fetch = async (url, opt) => { sent.push(JSON.parse(opt.body)); return { ok: true, text: async () => "ok" }; };
  await handleInteractive(p, deps);
  const last = sent[sent.length - 1];
  const btns = (last.blocks || []).find((b) => b.type === "actions");
  assert.ok(btns, "실패 응답에 버튼 블록이 남아야 한다");
  assert.strictEqual(btns.elements[0].action_id, "jaa:merge");
  assert.match(JSON.stringify(last.blocks), /CI 가 아직 진행 중/);
});

test("성공하면 버튼을 없애 이중 실행을 막는다", async () => {
  const sent = [];
  const orig = lib.slackMessage("승인됨", [act()]).blocks;
  const p = { ...payload(lib.encodeSlackAction(act()), "U1"), response_url: "https://slack/r", message: { blocks: orig } };
  global.fetch = async (url, opt) => { sent.push(JSON.parse(opt.body)); return { ok: true, text: async () => "ok" }; };
  await handleInteractive(p, {
    getProjectCreds: () => ({ slackAllowUsers: "U1" }),
    runAction: async () => ({ ok: true, merged: 1 }),
  });
  const last = sent[sent.length - 1];
  assert.strictEqual(last.blocks, undefined, "성공 응답에는 버튼이 남지 않아야 한다");
  assert.match(last.text, /병합 완료/);
});

test("재시도해도 결과 줄이 쌓이지 않는다", async () => {
  const sent = [];
  const withNote = [...lib.slackMessage("승인됨", [act()]).blocks,
    { type: "context", block_id: "jaa-note", elements: [{ type: "mrkdwn", text: "이전 실패" }] }];
  const p = { ...payload(lib.encodeSlackAction(act()), "U1"), response_url: "https://slack/r", message: { blocks: withNote } };
  global.fetch = async (url, opt) => { sent.push(JSON.parse(opt.body)); return { ok: true, text: async () => "ok" }; };
  await handleInteractive(p, {
    getProjectCreds: () => ({ slackAllowUsers: "U1" }),
    runAction: async () => ({ ok: false, message: "또 실패" }),
  });
  const notes = (sent[sent.length - 1].blocks || []).filter((b) => b.block_id === "jaa-note");
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0].elements[0].text, /또 실패/);
});
