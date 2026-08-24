// dashboard/test/office.test.js — docx·xlsx·pptx 텍스트 변환 테스트
//   실행: npm test
// 외부 도구 없이 실제 zip 컨테이너를 만들어 넣는다(스텁이 아니라 진짜 OOXML 바이트).
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const path = require("path");
const { extractOfficeText, isConvertibleOffice } = require(path.join(__dirname, "..", "..", "lib-office"));

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (buf) => {
  let x = 0xFFFFFFFF;
  for (const b of buf) x = CRC_TABLE[(x ^ b) & 0xFF] ^ (x >>> 8);
  return (x ^ 0xFFFFFFFF) >>> 0;
};
// [name, content][] → zip 버퍼 (deflate 압축, EOCD/중앙디렉터리 포함)
function makeZip(files) {
  const chunks = [], cd = []; let off = 0;
  for (const [name, content] of files) {
    const raw = Buffer.from(content, "utf8");
    const def = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const nb = Buffer.from(name, "utf8");
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(def.length, 18); lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nb.length, 26);
    chunks.push(lfh, nb, def);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(def.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    cd.push(c, nb);
    off += 30 + nb.length + def.length;
  }
  const cdBuf = Buffer.concat(cd);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const DOCX = () => makeZip([["word/document.xml", `<?xml version="1.0"?><w:document><w:body>
  <w:p><w:r><w:t>비로그인 접수 요구사항</w:t></w:r></w:p>
  <w:p><w:r><w:t>1단계</w:t></w:r><w:tab/><w:r><w:t>사업자번호 입력</w:t></w:r></w:p>
  <w:p><w:r><w:t>임시저장 7일 &amp; 만료 행 유지</w:t></w:r></w:p>
</w:body></w:document>`]]);

const XLSX = () => makeZip([
  ["xl/workbook.xml", `<workbook><sheets><sheet name="API 목록" sheetId="1" r:id="rId1"/></sheets></workbook>`],
  ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
  ["xl/sharedStrings.xml", `<sst><si><t>엔드포인트</t></si><si><t>메서드</t></si><si><t>/v2/public/guest/drafts</t></si></sst>`],
  ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>
     <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
     <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t>PUT</t></is></c><c r="C2"><v>200</v></c></row>
   </sheetData></worksheet>`]]);

const PPTX = () => makeZip([["ppt/slides/slide1.xml", `<p:sld><p:spTree>
  <a:p><a:r><a:t>게스트 모드 개요</a:t></a:r></a:p>
  <a:p><a:r><a:t>토큰 7일</a:t></a:r><a:r><a:t> TTL</a:t></a:r></a:p>
</p:spTree></p:sld>`]]);

test("isConvertibleOffice: OOXML 만 변환 대상(구형 .doc/.xls 는 아님)", () => {
  assert.equal(isConvertibleOffice({ filename: "a.docx", mimeType: "" }), true);
  assert.equal(isConvertibleOffice({ filename: "a.xlsx", mimeType: "" }), true);
  assert.equal(isConvertibleOffice({ filename: "a.pptx", mimeType: "" }), true);
  assert.equal(isConvertibleOffice({ filename: "x", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), true);
  assert.equal(isConvertibleOffice({ filename: "a.doc", mimeType: "application/msword" }), false);   // 구형 바이너리
  assert.equal(isConvertibleOffice({ filename: "a.zip", mimeType: "application/zip" }), false);
});

test("docx: 문단·탭·엔티티를 살려 본문을 뽑는다", () => {
  const t = extractOfficeText(DOCX(), "req.docx");
  assert.match(t, /비로그인 접수 요구사항/);
  assert.match(t, /1단계\t사업자번호 입력/);        // <w:tab/> → 실제 탭
  assert.match(t, /임시저장 7일 & 만료 행 유지/);   // &amp; 디코딩
  assert.match(t, /요구사항\n/);                    // 문단 경계 보존
});

test("xlsx: 시트 이름 + 공유문자열·inlineStr·숫자 셀을 TSV 로", () => {
  const t = extractOfficeText(XLSX(), "api.xlsx");
  assert.match(t, /# 시트: API 목록/);              // workbook.xml + rels 로 표시 이름 해석
  assert.match(t, /엔드포인트\t메서드/);            // 공유 문자열 인덱스 해석
  assert.match(t, /\/v2\/public\/guest\/drafts\tPUT\t200/);
});

test("pptx: 슬라이드별로 텍스트 런을 합친다", () => {
  const t = extractOfficeText(PPTX(), "deck.pptx");
  assert.match(t, /# 슬라이드 1/);
  assert.match(t, /게스트 모드 개요/);
  assert.match(t, /토큰 7일 TTL/);                  // 쪼개진 런 병합
});

test("확장자가 어긋나도 내용으로 형식을 추정한다", () => {
  assert.match(extractOfficeText(DOCX(), "이름없음"), /비로그인 접수 요구사항/);
});

test("깨진/암호화 파일은 null (본 작업을 막지 않는다)", () => {
  assert.equal(extractOfficeText(Buffer.from("not a zip at all"), "a.docx"), null);
  assert.equal(extractOfficeText(makeZip([["random.xml", "<a/>"]]), "a.docx"), null);
});
