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
const zlib = require("zlib");

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

// ===== 오피스 첨부(docx 등)는 텍스트로 변환해 문서 목록에 들어가야 한다 =====
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let x = 0xFFFFFFFF; for (const v of b) x = CRC_T[(x ^ v) & 0xFF] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0; };
function makeZip(files) {
  const chunks = [], cd = []; let off = 0;
  for (const [name, content] of files) {
    const raw = Buffer.from(content, "utf8"), def = zlib.deflateRawSync(raw), crc = crc32(raw), nb = Buffer.from(name, "utf8");
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(def.length, 18); lfh.writeUInt32LE(raw.length, 22); lfh.writeUInt16LE(nb.length, 26);
    chunks.push(lfh, nb, def);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(def.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    cd.push(c, nb); off += 30 + nb.length + def.length;
  }
  const cdBuf = Buffer.concat(cd), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}
const DOCX_BUF = () => makeZip([["word/document.xml", "<w:document><w:body><w:p><w:r><w:t>요구사항 본문</w:t></w:r></w:p></w:body></w:document>"]]);

test("downloadCardAttachments: docx 는 .txt 로 변환돼 문서 목록에 들어간다", async () => {
  const orig = global.fetch;
  const sb = sandbox();
  try {
    const att = [{ id: 9, filename: "요구사항.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1 }];
    const buf = DOCX_BUF();
    global.fetch = async (url) => String(url).includes("/rest/api/3/issue/")
      ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ fields: { attachment: att } }) }
      : { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    const logs = [];
    const r = await downloadCardAttachments({ jiraSite: "x.atlassian.net", cloneBase: sb.cloneBase },
      { atlassianEmail: "a@b.c", atlassianToken: "t" }, "TEST-3", (m) => logs.push(m));
    assert.equal(r.docs.length, 1, "오피스 첨부가 문서로 잡혀야 한다");
    assert.match(r.docs[0], /\.docx\.txt$/, "Read 로 열 수 있게 .txt 로 저장돼야 한다");
    const body = fs.readFileSync(r.docs[0], "utf8");
    assert.match(body, /요구사항 본문/);
    assert.match(body, /요구사항\.docx 에서 추출한 텍스트/);
    assert.ok(logs.some((m) => m.includes("텍스트로 변환")), "변환 사실을 로그로 남겨야 한다");
    assert.ok(!logs.some((m) => m.includes("읽을 수 없어 제외")), "더 이상 제외 대상이 아니다");
  } finally { global.fetch = orig; sb.cleanup(); }
});

test("downloadCardAttachments: 변환 실패한 오피스는 조용히 빠진다", async () => {
  const orig = global.fetch;
  const sb = sandbox();
  try {
    const att = [{ id: 10, filename: "깨진.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1 }];
    const junk = Buffer.from("이건 zip 이 아님");
    global.fetch = async (url) => String(url).includes("/rest/api/3/issue/")
      ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ fields: { attachment: att } }) }
      : { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.byteLength) };
    const r = await downloadCardAttachments({ jiraSite: "x.atlassian.net", cloneBase: sb.cloneBase },
      { atlassianEmail: "a@b.c", atlassianToken: "t" }, "TEST-4");
    assert.deepEqual(r.docs, [], "변환 실패는 목록에서 빠지고 본 작업은 계속돼야 한다");
  } finally { global.fetch = orig; sb.cleanup(); }
});
