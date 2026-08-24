#!/usr/bin/env node
// lib-office.js — docx·xlsx·pptx 를 외부 의존성 없이 텍스트로 변환한다.
// --------------------------------------------------------------------------
// OOXML 은 'zip 안의 XML' 이라, 최소 zip 리더(중앙 디렉터리 파싱 + zlib inflateRaw)와
// 태그 스트리핑만으로 본문을 뽑을 수 있다. Claude 는 Read 로 .docx 바이너리를 열어봐야
// 의미 있는 내용을 못 보므로, 첨부 파이프라인이 이 결과를 .txt 로 저장해 넘긴다.
//
// 지원: .docx(문단) · .xlsx(시트별 TSV) · .pptx(슬라이드별 텍스트)
// 한계: 이미지·차트·도형 좌표·서식은 버린다(본문 텍스트만). 암호화 파일은 실패 → null.
// --------------------------------------------------------------------------
const zlib = require("zlib");

const MAX_TEXT_BYTES = 1024 * 1024;   // 변환 결과 상한(프롬프트 폭주 방지)

// ===== 최소 zip 리더 =====
// 중앙 디렉터리(EOCD → CD 엔트리)를 읽어 이름→로컬헤더 오프셋을 만들고, 필요한 것만 푼다.
function readZip(buf) {
  const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LFH_SIG = 0x04034b50;
  let eocd = -1;
  const from = Math.max(0, buf.length - 66 * 1024);   // 주석 최대 64KB + EOCD
  for (let i = buf.length - 22; i >= from; i--) { if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; } }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) return null;   // ZIP64 는 다루지 않는다(오피스 첨부에서 사실상 없음)
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CD_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lfh = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, lfh });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    // 로컬 헤더의 name/extra 길이는 중앙 디렉터리와 다를 수 있어 반드시 여기서 다시 읽는다.
    if (e.lfh + 30 > buf.length || buf.readUInt32LE(e.lfh) !== LFH_SIG) return null;
    const nameLen = buf.readUInt16LE(e.lfh + 26);
    const extraLen = buf.readUInt16LE(e.lfh + 28);
    const start = e.lfh + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.compSize);
    try {
      if (e.method === 0) return data.toString("utf8");
      if (e.method === 8) return zlib.inflateRawSync(data).toString("utf8");
    } catch { return null; }
    return null;
  };
  return { names: [...entries.keys()], read };
}

// ===== XML → 텍스트 =====
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === "#") {
      const cp = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENT[g] !== undefined ? ENT[g] : m;
  });
}
const stripTags = (xml) => decodeEntities(xml.replace(/<[^>]*>/g, ""));
// 특정 태그의 안쪽 텍스트만 순서대로 뽑는다(<a:t>, <t> 등)
function textOf(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<${tag}(?:\\s[^>]*)?/>`, "g");
  let m;
  while ((m = re.exec(xml))) out.push(m[1] ? decodeEntities(m[1]) : "");
  return out;
}
const clean = (s) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// ===== docx =====
function fromDocx(zip) {
  let xml = zip.read("word/document.xml");
  if (!xml) return null;
  // 문단·줄바꿈·탭을 먼저 실제 문자로 바꾼 뒤 태그를 제거해야 문서 구조가 남는다.
  xml = xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t");
  return clean(stripTags(xml));
}

// ===== xlsx =====
function sharedStrings(zip) {
  const xml = zip.read("xl/sharedStrings.xml");
  if (!xml) return [];
  // <si> 하나가 여러 <t> 런으로 쪼개질 수 있어 si 단위로 합친다.
  return (xml.match(/<si>[\s\S]*?<\/si>/g) || []).map((si) => textOf(si, "t").join(""));
}
// 시트 파일 ↔ 표시 이름 매핑(workbook.xml + rels). 실패하면 파일명 순서로 폴백.
function sheetTargets(zip) {
  const wb = zip.read("xl/workbook.xml");
  const rels = zip.read("xl/_rels/workbook.xml.rels");
  const files = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10)));
  if (!wb || !rels) return files.map((f, i) => ({ file: f, name: `시트${i + 1}` }));
  const idToTarget = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    idToTarget.set(m[1], m[2].replace(/^\/?xl\//, "").replace(/^\.\//, ""));
  }
  const out = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)) {
    const t = idToTarget.get(m[2]);
    if (t) out.push({ file: `xl/${t}`, name: decodeEntities(m[1]) });
  }
  return out.length ? out : files.map((f, i) => ({ file: f, name: `시트${i + 1}` }));
}
function fromXlsx(zip) {
  const shared = sharedStrings(zip);
  const sheets = sheetTargets(zip);
  if (!sheets.length) return null;
  const parts = [];
  for (const { file, name } of sheets) {
    const xml = zip.read(file);
    if (!xml) continue;
    const rows = [];
    for (const rowXml of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const cm of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cm[1], body = cm[2];
        const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "n";
        if (t === "s") {                       // 공유 문자열 인덱스
          const i = parseInt(textOf(body, "v")[0] || "", 10);
          cells.push(Number.isFinite(i) ? (shared[i] || "") : "");
        } else if (t === "inlineStr") {
          cells.push(textOf(body, "t").join(""));
        } else {
          cells.push((textOf(body, "v")[0] || "").trim());
        }
      }
      if (cells.some((c) => c !== "")) rows.push(cells.join("\t"));
    }
    if (rows.length) parts.push(`# 시트: ${name}\n${rows.join("\n")}`);
  }
  return parts.length ? clean(parts.join("\n\n")) : null;
}

// ===== pptx =====
function fromPptx(zip) {
  const slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10)));
  if (!slides.length) return null;
  const parts = [];
  slides.forEach((f, i) => {
    const xml = zip.read(f);
    if (!xml) return;
    // <a:p> 가 문단, <a:t> 가 텍스트 런
    const lines = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || [])
      .map((p) => textOf(p, "a:t").join("").trim()).filter(Boolean);
    if (lines.length) parts.push(`# 슬라이드 ${i + 1}\n${lines.join("\n")}`);
  });
  return parts.length ? clean(parts.join("\n\n")) : null;
}

const OFFICE_EXT = new Set(["docx", "xlsx", "pptx"]);
const OFFICE_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
// 텍스트로 변환 가능한 오피스 첨부인지(구형 .doc/.xls/.ppt 는 OOXML 이 아니라 제외)
function isConvertibleOffice(a) {
  const mt = String(a.mimeType || "").toLowerCase();
  if (OFFICE_MIME.has(mt)) return true;
  const ext = (String(a.filename || "").split(".").pop() || "").toLowerCase();
  return OFFICE_EXT.has(ext);
}

// 버퍼 → 텍스트. 변환 불가/빈 내용이면 null.
function extractOfficeText(buf, filename) {
  const ext = (String(filename || "").split(".").pop() || "").toLowerCase();
  const zip = readZip(buf);
  if (!zip) return null;
  let text = null;
  try {
    if (ext === "docx") text = fromDocx(zip);
    else if (ext === "xlsx") text = fromXlsx(zip);
    else if (ext === "pptx") text = fromPptx(zip);
    else text = fromDocx(zip) || fromXlsx(zip) || fromPptx(zip);   // 확장자가 이상하면 내용으로 추정
  } catch { return null; }
  if (!text) return null;
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
    text = text.slice(0, MAX_TEXT_BYTES) + "\n\n[... 변환 결과가 1MB 를 넘어 잘렸습니다]";
  }
  return text;
}

module.exports = { extractOfficeText, isConvertibleOffice, readZip, MAX_TEXT_BYTES };
