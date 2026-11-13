const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../lib-monitor");

const W = "/Users/u/Work/loop-work";
const PS = [
  `  100     1   0.0  50000   32:09 node ${W}/run-epic-loop.js AML-75`,
  `  200   100   0.0   1000   29:54 bash ${W}/run-jira-agent.sh AML-110 build`,
  `  201   200  10.0 300000   29:52 /Users/u/.local/bin/claude --session-id x`,
  `  202   201 150.5 150000   06:48 ${W}/repos/aml-lite-AML-110/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron -r x`,
  `  203   202  20.0  80000   06:47 ${W}/repos/aml-lite-AML-110/electron/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/x`,
  `  210   200   0.0   2000   01:43 bash ${W}/run-review-loop.sh AML-110 AlcheraInc/aml-lite 60`,
  `  211   210   1.0  40000   01:41 node ${W}/ci-state.js AlcheraInc/aml-lite 60`,
  `  300     1   5.0  48000 02:29:03 /opt/jdk/bin/java -jar ${W}/repos/aml-lite-AML-104/target/app.jar`,
  `  400     1  30.0 900000 7-01:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  `  500     1   2.0  60000   10:00 node ${W}/run-sentry-loop.js`,
  `  600     1   1.0  70000   10:00 node server.js`,
].join("\n");

test("parsePs: 열·rss(KB→B)·etime 을 읽는다", () => {
  const p = M.parsePs(PS + "\ngarbage line\n");
  assert.equal(p.length, 11);
  assert.deepEqual({ pid: p[1].pid, ppid: p[1].ppid, cpu: p[1].cpu, rss: p[1].rss }, { pid: 200, ppid: 100, cpu: 0, rss: 1000 * 1024 });
  assert.equal(p[8].etime, "7-01:00:00");
});

test("etimeSec", () => {
  assert.equal(M.etimeSec("06:48"), 408);
  assert.equal(M.etimeSec("02:29:03"), 2 * 3600 + 29 * 60 + 3);
  assert.equal(M.etimeSec("7-01:00:00"), 7 * 86400 + 3600);
  assert.equal(M.etimeSec("?"), 0);
});

test("procLabel: 무거운 프로세스 이름을 알아본다", () => {
  assert.equal(M.procLabel("/Users/u/.local/bin/claude --session-id x"), "claude");
  assert.equal(M.procLabel("/x/Electron.app/Contents/MacOS/Electron"), "Electron");
  assert.equal(M.procLabel("/opt/jdk/bin/java -jar a.jar"), "Java");
  assert.equal(M.procLabel("java -Dfile.encoding=UTF-8 -jar a.jar"), "Java");
  assert.equal(M.procLabel("/Users/u/go/pkg/mod/golang.org/toolchain@v0.0.1/pkg/tool/darwin_arm64/compile -o /tmp/x"), "Go 빌드");
  assert.equal(M.procLabel("/usr/local/bin/postgres -D data"), "PostgreSQL");
  assert.equal(M.procLabel("node /a/b/ci-state.js x"), "node ci-state.js");
});

test("groupProcesses: 가장 가까운 러너로 묶고, 에픽 러너 밑 카드는 카드로 간다", () => {
  const { groups, other } = M.groupProcesses(M.parsePs(PS), { selfPids: [600] });
  const by = Object.fromEntries(groups.map((g) => [g.id, g]));
  const c = by["card:AML-110"];
  assert.ok(c);
  assert.equal(c.count, 6);                       // jira-agent, claude, Electron×2, review-loop, ci-state
  assert.equal(c.cpu, 181.5);
  assert.deepEqual(c.phases, ["build", "review"]);
  assert.equal(c.runnerAlive, true);
  assert.equal(c.elapsedSec, 29 * 60 + 54);
  assert.equal(c.top[0].label, "Electron");
  assert.equal(c.top[0].count, 2);
  assert.equal(c.top[0].cpu, 170.5);
  assert.equal(by["epic:AML-75"].count, 1);       // 에픽 러너 자신만
  assert.equal(by["loop:sentry"].count, 1);
  // 정렬: CPU 높은 순
  assert.equal(groups[0].id, "card:AML-110");
  // Chrome·대시보드 서버는 기타
  assert.equal(other.count, 2);
  assert.equal(other.cpu, 31);
});

test("groupProcesses: 러너 없이 남은 작업 폴더 프로세스는 고아로 카드에 붙인다", () => {
  const { groups } = M.groupProcesses(M.parsePs(PS));
  const g = groups.find((x) => x.id === "card:AML-104");
  assert.ok(g);
  assert.equal(g.orphanCount, 1);
  assert.equal(g.orphanOnly, true);
  assert.equal(g.runnerAlive, false);
  assert.equal(g.top[0].orphan, true);
});

test("groupProcesses: 러너가 살아 있는 카드의 경로 매칭 프로세스는 고아가 아니다", () => {
  const { groups } = M.groupProcesses(M.parsePs(PS));
  const g = groups.find((x) => x.id === "card:AML-110");
  assert.equal(g.orphanCount, 0);
  assert.equal(g.orphanOnly, false);
});

test("parseSwap / parseMemFree", () => {
  const s = M.parseSwap("total = 17408.00M  used = 16197.00M  free = 1211.00M  (encrypted)");
  assert.equal(s.total, 17408 * 1048576);
  assert.equal(s.used, 16197 * 1048576);
  assert.deepEqual(M.parseSwap(""), { total: null, used: null });
  assert.equal(M.parseMemFree("The system has ...\nSystem-wide memory free percentage: 36%"), 36);
  assert.equal(M.parseMemFree(""), null);
});

test("loadLevel: load 배수와 메모리 여유율로 판정", () => {
  assert.equal(M.loadLevel({ load1: 8, cores: 12, memFreePct: 50 }).level, "ok");
  assert.equal(M.loadLevel({ load1: 14, cores: 12, memFreePct: 50 }).level, "warn");
  assert.equal(M.loadLevel({ load1: 23, cores: 12, memFreePct: 50 }).level, "crit");
  assert.equal(M.loadLevel({ load1: 4, cores: 12, memFreePct: 25 }).level, "warn");
  const r = M.loadLevel({ load1: 14, cores: 12, memFreePct: 15 });
  assert.equal(r.level, "crit");
  assert.equal(r.reasons.length, 2);
  assert.equal(M.loadLevel({ load1: 4, cores: 12, memFreePct: null }).level, "ok");
});

test("pushHistory: 창 밖의 오래된 점을 밀어낸다", () => {
  const h = [];
  M.pushHistory(h, { t: 0 }, 100);
  M.pushHistory(h, { t: 50 }, 100);
  M.pushHistory(h, { t: 160 }, 100);
  assert.deepEqual(h.map((x) => x.t), [160]);
});
