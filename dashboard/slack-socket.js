// Slack Socket Mode 수신기 — 알림 메시지의 버튼 클릭을 받아 대시보드 API 를 실행한다.
//
// 왜 Socket Mode 인가: 버튼 클릭을 받으려면 Slack 이 우리 서버로 POST 를 보내야 하는데,
// 이 대시보드는 로컬 전용(포트 비공개)이다. Socket Mode 는 앱이 Slack 으로 아웃바운드
// WebSocket 을 열어 이벤트를 받으므로 공개 URL·터널링·포트 개방이 전혀 필요 없다.
//
// 필요한 것: Slack 앱의 App-Level Token(xapp-, scope connections:write) + Interactivity 활성화.
// 메시지 수정은 payload.response_url 로 하므로 봇 토큰은 필요 없다.

const lib = require("./lib");

// 버튼 → 대시보드 API 호출. 라우트를 그대로 재사용하므로 CI 게이트·카드 완료처리 등
// 대시보드에서 누를 때와 완전히 같은 로직을 탄다.
async function runAction(baseUrl, act) {
  const def = lib.SLACK_ACTIONS[act.id];
  if (!def) return { ok: false, message: "알 수 없는 동작입니다." };
  const url = baseUrl + def.api(act);
  const body = { project: act.project, ...def.body(act) };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),   // 병합·리뷰 루프 기동은 느릴 수 있다
    });
    const txt = await res.text();
    let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch {}
    if (!res.ok) return { ok: false, message: j.message || `HTTP ${res.status}` };
    return j;
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

// 실행 결과를 사람이 읽을 한 줄로. 라우트마다 응답 모양이 달라 여기서 흡수한다.
function resultLine(actId, r) {
  // 병합 라우트는 실패 사유를 message 가 아니라 errors 배열로 준다(CI 게이트 등) — 둘 다 본다.
  if (!r || r.ok === false) {
    const why = (r && r.message) || (r && (r.errors || []).join(" / ")) || "알 수 없는 오류";
    return `❌ 실패 — ${why}`;
  }
  switch (actId) {
    case "merge": {
      const errs = (r.errors || []).length ? ` · ⚠️ ${r.errors.join(" / ")}` : "";
      return `✅ 병합 완료 — PR ${r.merged || 0}건${r.doneStatus ? ` · 카드 ${r.doneStatus}` : ""}${errs}`;
    }
    case "review-loop": return `🔁 리뷰 승인 루프 시작${r.pid ? ` (pid ${r.pid})` : ""}`;
    case "card-run":    return `▶️ 카드 재실행 시작${r.pid ? ` (pid ${r.pid})` : ""}`;
    case "epic-resume": return `▶️ 이어서 진행${r.resumedAt ? ` — ${r.resumedAt} 부터` : ""}`;
    case "epic-skip":   return `⏭ 건너뛰고 진행${r.resumedAt ? ` — ${r.resumedAt} 부터` : ""}`;
    case "epic-stop":   return "⏹ 중지 요청됨";
    default:            return "✅ 완료";
  }
}

// 원본 메시지를 결과로 교체한다 — 버튼이 사라지므로 중복 클릭·이중 병합이 막힌다.
async function respond(responseUrl, text, replaceOriginal) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, replace_original: !!replaceOriginal, response_type: "in_channel" }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

// payload 1건 처리. 테스트 가능하도록 소켓과 분리했다.
async function handleInteractive(payload, deps) {
  if (!payload || payload.type !== "block_actions") return null;
  const raw = (payload.actions || []).find((a) => String(a.action_id || "").startsWith(lib.SLACK_ACTION_PREFIX));
  if (!raw || raw.url) return null;                       // 링크 버튼은 처리할 게 없다
  const act = lib.decodeSlackAction(raw.value || "");
  const responseUrl = payload.response_url || "";
  if (!act) { await respond(responseUrl, "❌ 알 수 없는 버튼입니다.", false); return null; }

  const cred = deps.getProjectCreds(act.project) || {};
  const userId = (payload.user && payload.user.id) || "";
  if (!lib.slackActorAllowed(cred, userId)) {
    const who = (payload.user && payload.user.username) || userId || "알 수 없는 사용자";
    await respond(responseUrl, `🚫 <@${userId}> 님은 실행 권한이 없습니다. 대시보드 → 자격증명 → 'Slack 실행 허용 사용자' 에 \`${userId}\` 를 추가하세요. (요청자: ${who})`, false);
    return { ok: false, denied: true };
  }

  const label = (lib.SLACK_ACTIONS[act.id] || {}).label || act.id;
  await respond(responseUrl, `⏳ [${act.key}] ${label} 실행 중… (요청: <@${userId}>)`, true);
  const r = await (deps.runAction || runAction)(deps.baseUrl, act);
  await respond(responseUrl, `[${act.key}] ${label} · <@${userId}>\n${resultLine(act.id, r)}`, true);
  return r;
}

// 프로젝트별 App-Level Token 으로 접속. 같은 토큰은 한 번만 연결한다.
function startSlackSocket(deps) {
  let SocketModeClient;
  try { ({ SocketModeClient } = require("@slack/socket-mode")); }
  catch { console.warn("  Slack Socket Mode: @slack/socket-mode 미설치 — 버튼 수신 비활성"); return { clients: [] }; }

  const seen = new Set(), clients = [];
  for (const p of deps.listProjects()) {
    const cred = deps.getProjectCreds(p.id) || {};
    const token = String(cred.slackAppToken || "").trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    const client = new SocketModeClient({ appToken: token, logLevel: "error" });
    client.on("interactive", async ({ body, ack }) => {
      try { await ack(); } catch {}
      try { await handleInteractive(body, deps); }
      catch (e) { console.warn("[slack] 버튼 처리 오류:", e.message); }
    });
    client.start()
      .then(() => console.log(`  Slack 버튼 수신(Socket Mode) 연결됨 — ${p.id}`))
      .catch((e) => console.warn(`  Slack Socket Mode 연결 실패(${p.id}): ${e.message}`));
    clients.push({ project: p.id, client });
  }
  if (!clients.length) console.log("  Slack 버튼 수신: App-Level Token 미설정 — 비활성");
  return { clients };
}

module.exports = { startSlackSocket, handleInteractive, runAction, resultLine };
