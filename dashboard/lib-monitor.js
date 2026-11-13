// 오토파일럿 부하 모니터 — ps 출력을 러너(카드) 단위로 묶는다. 순수 함수만 두고 수집·보관은 server.js 에서.

// 러너 판정: 가장 가까운 러너 조상이 그 프로세스의 소속을 정한다.
const RUNNERS = [
  { re: /run-jira-agent\.sh\s+(\S+)\s+(\S+)/, kind: "card", key: (m) => m[1], phase: (m) => m[2] },
  { re: /run-review-loop\.sh\s+(\S+)/, kind: "card", key: (m) => m[1], phase: () => "review" },
  { re: /run-review\.sh\s+(\S+)/, kind: "card", key: (m) => m[1], phase: () => "review" },
  { re: /run-epic-loop\.js\s+(\S+)/, kind: "epic", key: (m) => m[1], phase: () => "epic" },
  { re: /run-sentry-loop\.js/, kind: "loop", key: () => "sentry", phase: () => "sentry" },
  { re: /run-cycle\.js/, kind: "loop", key: () => "cycle", phase: () => "cycle" },
  { re: /loop-(plan|build|review)\.sh/, kind: "loop", key: (m) => `loop-${m[1]}`, phase: (m) => m[1] },
];
// 러너가 죽고 남은 테스트 서버 등은 작업 폴더 경로로 카드를 찾는다.
const WORKTREE_RE = /\/repos\/[^/\s]+?-([A-Z][A-Z0-9]*-\d+)(?:\/|\s|$)/;

function parsePs(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: +m[1], ppid: +m[2], cpu: +m[3], rss: +m[4] * 1024, etime: m[5], cmd: m[6] });
  }
  return out;
}

function matchRunner(cmd) {
  for (const r of RUNNERS) {
    const m = cmd.match(r.re);
    if (m) return { kind: r.kind, key: r.key(m), phase: r.phase(m) };
  }
  return null;
}

// ps etime: [[dd-]hh:]mm:ss
function etimeSec(s) {
  const m = String(s || "").match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3]) * 60 + (+m[4]);
}

function procLabel(cmd) {
  const c = String(cmd || "");
  if (/\/claude(\s|$)/.test(c) || /^claude(\s|$)/.test(c)) return "claude";
  if (/Electron/.test(c)) return "Electron";
  if (/postgres/i.test(c)) return "PostgreSQL";
  if (/(^|\/)java(\s|$)/.test(c)) return "Java";
  if (/golang\.org\/toolchain|\/go-build|\/compile\s+-o|\/link\s+-o/.test(c)) return "Go 빌드";
  if (/(^|\/)go\s+(test|build|run|vet)\b/.test(c)) return "Go";
  if (/gradle/i.test(c)) return "Gradle";
  if (/playwright/.test(c)) return "Playwright";
  if (/vite/.test(c)) return "vite";
  if (/docker/.test(c)) return "docker";
  const node = c.match(/(?:^|\/)node\s+(\S+)/);
  if (node) return `node ${node[1].split("/").pop()}`;
  const exe = c.split(/\s+/)[0] || "";
  return exe.split("/").pop() || exe;
}

// 프로세스를 그룹으로 묶는다. selfPid(대시보드 서버·수집 ps)는 기타로 둔다.
function groupProcesses(procs, { selfPids = [] } = {}) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const memo = new Map();
  const skip = new Set(selfPids);
  const ownerOf = (pid) => {
    if (memo.has(pid)) return memo.get(pid);
    const chain = [];
    let cur = byPid.get(pid), found = null;
    const seen = new Set();
    while (cur && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      if (memo.has(cur.pid)) { found = memo.get(cur.pid); break; }
      chain.push(cur.pid);
      const r = matchRunner(cur.cmd);
      if (r) { found = r; break; }
      if (cur.ppid <= 1) break;
      cur = byPid.get(cur.ppid);
    }
    for (const id of chain) memo.set(id, found);
    return found;
  };

  const groups = new Map();
  const other = { cpu: 0, rss: 0, count: 0 };
  const get = (id, base) => {
    if (!groups.has(id)) groups.set(id, { id, kind: base.kind, key: base.key, phases: [], cpu: 0, rss: 0, count: 0, elapsedSec: 0, orphanCount: 0, orphanRss: 0, runnerAlive: false, procs: [] });
    return groups.get(id);
  };

  for (const p of procs) {
    if (skip.has(p.pid)) { other.cpu += p.cpu; other.rss += p.rss; other.count++; continue; }
    let owner = ownerOf(p.pid);
    let orphan = false;
    if (!owner) {
      const w = p.cmd.match(WORKTREE_RE);
      if (w) { owner = { kind: "card", key: w[1], phase: null }; orphan = true; }
    }
    if (!owner) { other.cpu += p.cpu; other.rss += p.rss; other.count++; continue; }
    // 에픽 러너 밑의 카드 러너는 카드로, 에픽 러너 자신만 에픽 그룹으로 간다.
    const g = get(`${owner.kind}:${owner.key}`, owner);
    g.cpu += p.cpu; g.rss += p.rss; g.count++;
    if (orphan) { g.orphanCount++; g.orphanRss += p.rss; }
    const self = matchRunner(p.cmd);
    if (self && `${self.kind}:${self.key}` === g.id) {
      g.runnerAlive = true;
      if (self.phase && !g.phases.includes(self.phase)) g.phases.push(self.phase);
      g.elapsedSec = Math.max(g.elapsedSec, etimeSec(p.etime));
    }
    g.procs.push({ pid: p.pid, label: procLabel(p.cmd), cpu: p.cpu, rss: p.rss, orphan });
  }

  const list = [...groups.values()].map((g) => {
    // 같은 이름 프로세스는 합쳐서 상위 3개만 남긴다.
    const agg = new Map();
    for (const q of g.procs) {
      const a = agg.get(q.label) || { label: q.label, cpu: 0, rss: 0, count: 0, orphan: false };
      a.cpu += q.cpu; a.rss += q.rss; a.count++; a.orphan = a.orphan || q.orphan;
      agg.set(q.label, a);
    }
    const top = [...agg.values()].sort((a, b) => (b.cpu - a.cpu) || (b.rss - a.rss)).slice(0, 3)
      .map((a) => ({ ...a, cpu: round1(a.cpu) }));
    const { procs: _p, ...rest } = g;
    const orphans = g.procs.filter((q) => q.orphan).slice(0, 10).map((q) => ({ pid: q.pid, label: q.label, rss: q.rss }));
    return { ...rest, cpu: round1(g.cpu), orphanOnly: !g.runnerAlive && g.orphanCount > 0, top, orphans };
  }).sort((a, b) => (b.cpu - a.cpu) || (b.rss - a.rss));

  return { groups: list, other: { ...other, cpu: round1(other.cpu) } };
}

function round1(n) { return Math.round(n * 10) / 10; }

// "total = 17408.00M  used = 16197.00M  free = 1211.00M"
function parseSwap(text) {
  const n = (k) => { const m = String(text || "").match(new RegExp(`${k}\\s*=\\s*([\\d.]+)M`)); return m ? Math.round(+m[1] * 1048576) : null; };
  return { total: n("total"), used: n("used") };
}

function parseMemFree(text) {
  const m = String(text || "").match(/free percentage:\s*(\d+)%/);
  return m ? +m[1] : null;
}

const DEFAULT_THRESHOLDS = { loadWarn: 1.0, loadCrit: 1.5, memWarn: 30, memCrit: 20 };

// load 는 코어 수 대비 배수, 메모리는 여유율(%)로 판정한다.
function loadLevel({ load1, cores, memFreePct }, t = DEFAULT_THRESHOLDS) {
  const ratio = cores > 0 ? load1 / cores : 0;
  const reasons = [];
  let level = "ok";
  const bump = (l) => { if (l === "crit" || (l === "warn" && level === "ok")) level = l; };
  if (ratio > t.loadCrit) { bump("crit"); reasons.push(`load ${round1(ratio)}×코어`); }
  else if (ratio > t.loadWarn) { bump("warn"); reasons.push(`load ${round1(ratio)}×코어`); }
  if (memFreePct != null) {
    if (memFreePct < t.memCrit) { bump("crit"); reasons.push(`메모리 여유 ${memFreePct}%`); }
    else if (memFreePct < t.memWarn) { bump("warn"); reasons.push(`메모리 여유 ${memFreePct}%`); }
  }
  return { level, ratio: Math.round(ratio * 100) / 100, reasons };
}

// 이력 링버퍼: 오래된 점은 windowMs 밖으로 밀어낸다.
function pushHistory(hist, point, windowMs) {
  hist.push(point);
  const cut = point.t - windowMs;
  while (hist.length && hist[0].t < cut) hist.shift();
  return hist;
}

// 카드의 고아 프로세스(러너 조상 없이 작업 폴더 경로로만 잡힌 것)와 그 자손.
// 같은 카드의 러너가 살아 있으면 비운다 — 진행 중인 테스트가 띄운 데몬일 수 있다.
// excludePids: 러너로 치지 않을 pid(종료 직전인 자기 자신 등).
function orphanTargets(procs, key, { excludePids = [] } = {}) {
  const ex = new Set(excludePids.map(Number));
  const view = procs.map((p) => (ex.has(p.pid) ? { ...p, cmd: "" } : p));
  const { groups } = groupProcesses(view);
  const g = groups.find((x) => x.id === `card:${key}`);
  if (!g) return { runnerAlive: false, targets: [] };
  if (g.runnerAlive) return { runnerAlive: true, targets: [] };
  const roots = view.filter((p) => {
    const w = p.cmd.match(WORKTREE_RE);
    return w && w[1] === key;
  });
  const kids = new Map();
  for (const p of view) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const seen = new Set(), out = [];
  const walk = (p) => {
    if (seen.has(p.pid) || ex.has(p.pid)) return;
    seen.add(p.pid);
    out.push({ pid: p.pid, label: procLabel(p.cmd), rss: p.rss });
    for (const c of kids.get(p.pid) || []) walk(c);
  };
  roots.forEach(walk);
  return { runnerAlive: false, targets: out };
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
// 신호를 보낸 pid 목록을 돌려준다(이미 없는 pid 는 조용히 넘긴다).
function killTargets(targets, signal) {
  const done = [];
  for (const t of targets) { try { process.kill(t.pid, signal); done.push(t.pid); } catch {} }
  return done;
}

module.exports = { orphanTargets, pidAlive, killTargets, parsePs, matchRunner, etimeSec, procLabel, groupProcesses, parseSwap, parseMemFree, loadLevel, pushHistory, DEFAULT_THRESHOLDS };
