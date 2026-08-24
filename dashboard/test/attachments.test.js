// dashboard/test/attachments.test.js — 카드 첨부(이미지·문서) 인식 회귀 테스트
//   실행: npm test
// 네트워크를 타지 않도록 global.fetch 를 스텁한다. 핵심 회귀:
//   run-cycle 를 거치지 않는 실행 경로(대시보드 단건 실행 등)도 첨부를 인식해야 한다.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const MODULE = path.join(ROOT, "lib-attachments.js");
const { downloadCardAttachments, isReadableDoc } = require(MODULE);

const ATT = [
  { id: 1, filename: "screen.png", mimeType: "image/png", size: 3 },
  { id: 2, filename: "spec.pdf", mimeType: "application/pdf", size: 3 },
  { id: 3, filename: "archive.zip", mimeType: "application/zip", size: 3 },   // 읽을 수 없음 → 제외
];

// fetch 스텁: 이슈 조회는 첨부 목록, 첨부 본문은 3바이트
function stubFetch(attachments) {
  global.fetch = async (url) => {
    if (String(url).includes("/rest/api/3/issue/")) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ fields: { attachment: attachments } }) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
  return { cloneBase: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("isReadableDoc: mimeType 우선 + 확장자 폴백, 이미지·바이너리 제외", () => {
  assert.equal(isReadableDoc({ mimeType: "image/png", filename: "a.png" }), false);
  assert.equal(isReadableDoc({ mimeType: "application/pdf", filename: "a.pdf" }), true);
  assert.equal(isReadableDoc({ mimeType: "text/plain", filename: "a.txt" }), true);
  assert.equal(isReadableDoc({ mimeType: "application/zip", filename: "a.zip" }), false);
  assert.equal(isReadableDoc({ mimeType: "", filename: "a.py" }), true);         // 확장자 폴백
  assert.equal(isReadableDoc({ mimeType: "", filename: "a.xlsx" }), false);
});

test("downloadCardAttachments: 이미지/문서를 분류해 내려받고 읽기 불가는 제외", async () => {
  const orig = global.fetch;
  const sb = sandbox();
  try {
    stubFetch(ATT);
    const logs = [];
    const r = await downloadCardAttachments(
      { jiraSite: "example.atlassian.net", cloneBase: sb.cloneBase },
      { atlassianEmail: "a@b.c", atlassianToken: "t" }, "TEST-1", (m) => logs.push(m));
    assert.equal(r.images.length, 1);
    assert.equal(r.docs.length, 1);
    assert.match(r.images[0], /TEST-1\.images\/1-screen\.png$/);
    assert.match(r.docs[0], /TEST-1\.docs\/2-spec\.pdf$/);
    assert.ok(fs.existsSync(r.images[0]) && fs.existsSync(r.docs[0]));
    assert.ok(logs.some((m) => m.includes("archive.zip")), "읽을 수 없는 첨부는 로그로 남겨야 한다");
  } finally { global.fetch = orig; sb.cleanup(); }
});

test("downloadCardAttachments: 자격증명·사이트가 없으면 조용히 빈 결과", async () => {
  const r = await downloadCardAttachments({ jiraSite: "" }, { atlassianEmail: "", atlassianToken: "" }, "TEST-1");
  assert.deepEqual(r, { images: [], docs: [] });
});

test("CLI: IMG:/DOC: 접두사로 경로를 출력한다(셸이 파싱하는 계약)", () => {
  const sb = sandbox();
  try {
    // 스텁 fetch 를 주입하기 위해 --require 로 감싸 실행
    const pre = path.join(sb.cloneBase, "stub.js");
    fs.writeFileSync(pre, `
      const ATT = ${JSON.stringify(ATT)};
      global.fetch = async (url) => String(url).includes("/rest/api/3/issue/")
        ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ fields: { attachment: ATT } }) }
        : { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([1,2,3]).buffer };
    `);
    const out = execFileSync(process.execPath, ["--require", pre, MODULE, "TEST-2"], {
      encoding: "utf8",
      env: { ...process.env, JIRA_SITE: "example.atlassian.net", ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_TOKEN: "t", CLONE_BASE: sb.cloneBase },
    });
    const imgs = out.split("\n").filter((l) => l.startsWith("IMG:")).map((l) => l.slice(4));
    const docs = out.split("\n").filter((l) => l.startsWith("DOC:")).map((l) => l.slice(4));
    assert.equal(imgs.length, 1);
    assert.equal(docs.length, 1);
    assert.ok(path.isAbsolute(imgs[0]), "셸이 그대로 프롬프트에 넣으므로 절대경로여야 한다");
  } finally { sb.cleanup(); }
});

test("run-jira-agent.sh / run-review.sh: 첨부가 비면 CLI 로 직접 받는 폴백이 있다", () => {
  for (const f of ["run-jira-agent.sh", "run-review.sh"]) {
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.match(s, /lib-attachments\.js/, `${f} 에 첨부 폴백이 있어야 한다`);
    assert.match(s, /sed -n 's\/\^IMG:\/\/p'/, `${f} 이 IMG: 접두사를 파싱해야 한다`);
  }
});
