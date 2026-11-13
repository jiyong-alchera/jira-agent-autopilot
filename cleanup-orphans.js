#!/usr/bin/env node
// 카드 작업 폴더(repos/<repo>-<KEY>/)에서 러너 없이 남은 프로세스를 정리한다.
// 같은 카드의 러너가 살아 있으면 아무것도 하지 않는다.
//   node cleanup-orphans.js <KEY> [--exclude-pid <pid>]... [--dry-run]
const { execFileSync } = require("child_process");
const path = require("path");
const M = require(path.join(__dirname, "dashboard", "lib-monitor"));

const args = process.argv.slice(2);
const key = args[0];
if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key || "")) { console.error("usage: cleanup-orphans.js <KEY> [--exclude-pid N] [--dry-run]"); process.exit(2); }
const exclude = [process.pid, process.ppid];
let dry = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--exclude-pid") exclude.push(Number(args[++i]));
  else if (args[i] === "--dry-run") dry = true;
}

const ps = execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,etime=,command="], { encoding: "utf8", maxBuffer: 16 << 20 });
const { runnerAlive, targets } = M.orphanTargets(M.parsePs(ps), key, { excludePids: exclude });
if (runnerAlive) { console.log(`[${key}] 러너 실행 중 — 고아 정리 건너뜀`); process.exit(0); }
if (!targets.length) process.exit(0);
const desc = targets.map((t) => `${t.label}(${t.pid})`).join(", ");
if (dry) { console.log(`[${key}] 정리 대상: ${desc}`); process.exit(0); }
M.killTargets(targets, "SIGTERM");
console.log(`[${key}] 러너 없이 남은 프로세스 정리: ${desc}`);
setTimeout(() => {
  const left = M.killTargets(targets.filter((t) => M.pidAlive(t.pid)), "SIGKILL");
  if (left.length) console.log(`[${key}] SIGTERM 에 남은 프로세스 강제 종료: ${left.join(", ")}`);
}, 5000);
