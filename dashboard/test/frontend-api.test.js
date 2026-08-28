// public/index.html 의 api 헬퍼 회귀 테스트.
// 이 헬퍼가 reject 하면 호출부의 await 가 throw 되어 setLoading(false) 를 건너뛰고
// 버튼이 "…중" 상태로 영구 고착된다. 그래서 "절대 reject 하지 않는다" 가 계약이다.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const start = html.indexOf("async function request(");
const end = html.indexOf("};", html.indexOf("const api = {", start));
assert.ok(start > 0 && end > start, "index.html 에서 api 헬퍼 블록을 찾지 못했습니다");
const source = html.slice(start, end + 2);

function loadApi(fetchStub) {
  const ctx = { fetch: fetchStub };
  vm.createContext(ctx);
  vm.runInContext(source + "\nglobalThis.__api = api;", ctx);
  return ctx.__api;
}

const jsonRes = (obj, status = 200) => ({
  status, statusText: "OK", text: async () => JSON.stringify(obj),
});

test("api: 정상 JSON 응답은 그대로 통과시킨다", async () => {
  const api = loadApi(async () => jsonRes({ ok: true, description: "hi" }));
  const r = await api.post("/x", {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.description, "hi");
});

test("api: 서버가 죽어 fetch 가 실패해도 reject 하지 않고 ok:false 를 돌려준다", async () => {
  const api = loadApi(async () => { throw new TypeError("Failed to fetch"); });
  const r = await api.post("/api/ai/refine-description", { text: "x" });
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /서버에 연결할 수 없습니다/);
});

test("api: 비 JSON 응답(프록시 HTML 등)도 ok:false 로 정규화한다", async () => {
  const api = loadApi(async () => ({ status: 502, statusText: "Bad Gateway", text: async () => "<html>nope</html>" }));
  const r = await api.get("/api/cards");
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /HTTP 502/);
});

test("api: 서버가 낸 에러 JSON 은 message 를 보존한다", async () => {
  const api = loadApi(async () => jsonRes({ ok: false, message: "claude 응답 시간 초과" }, 500));
  const r = await api.post("/x", {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.message, "claude 응답 시간 초과");
});
