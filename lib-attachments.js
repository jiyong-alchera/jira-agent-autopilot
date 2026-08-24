#!/usr/bin/env node
// lib-attachments.js — Jira 카드 첨부(이미지·문서)를 로컬로 내려받아 Claude 가 Read 로 인식하게 한다.
// --------------------------------------------------------------------------
// 모듈로도, CLI 로도 쓴다.
//   모듈: const { downloadCardAttachments } = require("./lib-attachments")   ← run-cycle.js(스케줄 루프)
//   CLI : node lib-attachments.js <ISSUE-KEY>                                ← run-jira-agent.sh / run-review.sh
//         env(JIRA_SITE·ATLASSIAN_EMAIL·ATLASSIAN_TOKEN·CLONE_BASE)로 동작하고
//         'IMG:<path>' / 'DOC:<path>' 줄을 stdout 에 출력(로그는 stderr).
// CLI 경로가 있어야 대시보드 '단건 즉시 실행'처럼 run-cycle 를 거치지 않는 실행에서도 첨부가 인식된다.
// --------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
// docx·xlsx·pptx 는 Read 로 열어도 의미가 없어 텍스트로 변환해 넘긴다.
const { extractOfficeText, isConvertibleOffice } = require(path.join(__dirname, "lib-office"));

const MAX_CARD_IMAGES = 10;
const MAX_CARD_DOCS = 10;
const MAX_DOC_BYTES = 25 * 1024 * 1024;   // 문서 1개 용량 상한(대용량 다운로드 방지)
const DOC_MIME = new Set([
  "application/pdf", "application/json", "application/xml", "application/xhtml+xml",
  "application/javascript", "application/x-javascript", "application/typescript",
  "application/x-yaml", "application/yaml", "application/x-sh", "application/x-python",
  "application/x-httpd-php", "application/sql", "application/x-sql", "text/markdown",
]);
const DOC_EXT = new Set([
  "pdf", "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm",
  "js", "jsx", "ts", "tsx", "py", "go", "java", "kt", "rb", "php", "c", "h", "cpp", "cc", "hpp",
  "cs", "rs", "swift", "sh", "bash", "zsh", "sql", "toml", "ini", "cfg", "conf", "env", "log",
  "gradle", "properties", "dockerfile", "makefile", "vue", "svelte", "scss", "css", "less",
]);

// Claude Read 로 의미 있게 열 수 있는 비이미지 문서인지 판정(mimeType 우선, 없으면 확장자 폴백)
function isReadableDoc(a) {
  const mt = String(a.mimeType || "").toLowerCase();
  if (mt.startsWith("image/")) return false;
  if (mt.startsWith("text/")) return true;
  if (DOC_MIME.has(mt)) return true;
  const ext = (String(a.filename || "").split(".").pop() || "").toLowerCase();
  return DOC_EXT.has(ext);
}
const isImage = (a) => String(a.mimeType || "").startsWith("image/");

async function fetchAttachmentTo(cfg, auth, a, dir) {
  const safe = String(a.filename || `att-${a.id}`).replace(/[^\w.\-]/g, "_");
  const p = path.join(dir, `${a.id}-${safe}`);
  const txtPath = `${p}.txt`;   // 오피스 변환 결과 경로
  // 첨부는 불변(같은 id = 같은 파일) — 이미 받아둔 게 있으면 재다운로드/재변환 생략.
  // 오피스는 변환 결과라 원본 크기와 비교할 수 없으므로 존재 여부로만 판단한다.
  if (isConvertibleOffice(a)) {
    try { if (fs.existsSync(txtPath) && fs.statSync(txtPath).size > 0) return txtPath; } catch { /* 재변환 */ }
  } else {
    try { if (fs.existsSync(p) && (!a.size || fs.statSync(p).size === Number(a.size))) return p; } catch { /* stat 실패 시 재다운로드 */ }
  }
  let up = await fetch(`https://${cfg.jiraSite}/rest/api/3/attachment/content/${a.id}`, { headers: { Authorization: `Basic ${auth}` }, redirect: "manual", signal: AbortSignal.timeout(30000) });
  const loc = up.headers.get("location");
  if (up.status >= 300 && up.status < 400 && loc) up = await fetch(loc, { signal: AbortSignal.timeout(30000) });
  if (!up.ok) return null;
  const body = Buffer.from(await up.arrayBuffer());
  if (isConvertibleOffice(a)) {
    // 원본 바이너리는 남기지 않는다 — Claude 가 읽는 건 변환된 .txt 뿐이다.
    const text = extractOfficeText(body, a.filename);
    if (!text) return null;
    fs.writeFileSync(txtPath, `[${a.filename} 에서 추출한 텍스트]\n\n${text}\n`);
    return txtPath;
  }
  fs.writeFileSync(p, body);
  return p;
}

// cfg: { jiraSite, cloneBase, workDir }  cred: { atlassianEmail, atlassianToken }
// 오피스(docx·xlsx·pptx)는 텍스트로 변환해 넘기고, 그래도 읽을 수 없는 것(압축·영상 등)은 받지 않고 로그로만 남긴다.
async function downloadCardAttachments(cfg, cred, key, log = () => {}) {
  const empty = { images: [], docs: [] };
  if (!cred || !cred.atlassianEmail || !cred.atlassianToken || !cfg.jiraSite) return empty;
  const auth = Buffer.from(`${cred.atlassianEmail}:${cred.atlassianToken}`).toString("base64");
  try {
    const r = await fetch(`https://${cfg.jiraSite}/rest/api/3/issue/${encodeURIComponent(key)}?fields=attachment`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return empty;
    const d = await r.json();
    const all = (d.fields && d.fields.attachment) || [];
    let imgs = all.filter(isImage);
    // 오피스(docx·xlsx·pptx)는 그대로는 못 읽지만 텍스트로 변환해 넘기므로 문서에 포함한다.
    let docs = all.filter((a) => isReadableDoc(a) || isConvertibleOffice(a));
    const nOffice = docs.filter(isConvertibleOffice).length;
    if (nOffice) log(`[${key}] 오피스 첨부 ${nOffice}개는 텍스트로 변환해 인식`);
    const skipped = all.filter((a) => !isImage(a) && !isReadableDoc(a) && !isConvertibleOffice(a));
    if (skipped.length) log(`[${key}] 첨부 ${skipped.length}개는 Claude 가 읽을 수 없어 제외: ${skipped.map((a) => a.filename).join(", ")}`);
    if (imgs.length > MAX_CARD_IMAGES) { log(`[${key}] 이미지 ${imgs.length}장 중 ${MAX_CARD_IMAGES}장만 인식(상한)`); imgs = imgs.slice(0, MAX_CARD_IMAGES); }
    const tooBig = docs.filter((a) => Number(a.size || 0) > MAX_DOC_BYTES);
    if (tooBig.length) log(`[${key}] 문서 ${tooBig.length}개는 용량 초과(>${Math.round(MAX_DOC_BYTES / 1048576)}MB)로 제외: ${tooBig.map((a) => a.filename).join(", ")}`);
    docs = docs.filter((a) => Number(a.size || 0) <= MAX_DOC_BYTES);
    if (docs.length > MAX_CARD_DOCS) { log(`[${key}] 문서 ${docs.length}개 중 ${MAX_CARD_DOCS}개만 인식(상한)`); docs = docs.slice(0, MAX_CARD_DOCS); }
    const base = cfg.cloneBase || path.join(cfg.workDir || __dirname, "repos");
    const imgDir = path.join(base, ".state", `${key}.images`);
    const docDir = path.join(base, ".state", `${key}.docs`);
    if (imgs.length) fs.mkdirSync(imgDir, { recursive: true });
    if (docs.length) fs.mkdirSync(docDir, { recursive: true });
    const outImg = [], outDoc = [];
    for (const a of imgs) { try { const p = await fetchAttachmentTo(cfg, auth, a, imgDir); if (p) outImg.push(p); } catch { /* 개별 실패 건너뜀 */ } }
    for (const a of docs) { try { const p = await fetchAttachmentTo(cfg, auth, a, docDir); if (p) outDoc.push(p); } catch { /* 개별 실패 건너뜀 */ } }
    return { images: outImg, docs: outDoc };
  } catch { return empty; }
}

module.exports = { downloadCardAttachments, isReadableDoc, isConvertibleOffice, MAX_CARD_IMAGES, MAX_CARD_DOCS, MAX_DOC_BYTES };

// ===== CLI: node lib-attachments.js <ISSUE-KEY> =====
if (require.main === module) {
  const key = process.argv[2] || "";
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(key)) { console.error("usage: lib-attachments.js <ISSUE-KEY>"); process.exit(2); }
  const cfg = {
    jiraSite: process.env.JIRA_SITE || "",
    cloneBase: process.env.CLONE_BASE || "",
    workDir: process.env.WORK_DIR || __dirname,
  };
  const cred = { atlassianEmail: process.env.ATLASSIAN_EMAIL || "", atlassianToken: process.env.ATLASSIAN_TOKEN || "" };
  downloadCardAttachments(cfg, cred, key, (m) => console.error(m))
    .then(({ images, docs }) => {
      for (const p of images) console.log(`IMG:${p}`);
      for (const p of docs) console.log(`DOC:${p}`);
    })
    .catch(() => process.exit(0));   // 첨부 실패로 본 작업을 막지 않는다
}
