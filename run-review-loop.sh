#!/usr/bin/env bash
#
# run-review-loop.sh <JIRA-ISSUE-KEY> <OWNER/REPO> <PR-NUMBER>
# --------------------------------------------------------------------------
# 하나의 PR 에 대해 '리뷰 반영(rework) → 재리뷰' 를 승인될 때까지 반복한다.
# 대시보드 'PR 목록'의 [반영+재리뷰(승인까지 루프)] 버튼이 이 스크립트를 실행한다.
#
# 한 회차(iteration):
#   1) 승인 마커(CLAUDE-REVIEW-APPROVED) 확인 → 이미 있으면 즉시 성공 종료
#   2) REWORK=1 run-jira-agent.sh <KEY> build   (그 PR 하나만 반영·푸시)
#   3) FORCE_REVIEW=1 run-review.sh <KEY>       (그 PR 하나만 재리뷰)
#   4) 마커 재확인 → 있으면 성공 종료, 없으면 Slack 에 '회차 + 수정 필요' 알림 후 다음 회차
#
# REVIEW_FIRST=1 이면 1회차의 (2) 반영을 건너뛰고 리뷰부터 시작한다. 방금 개발해 올린 새 PR 은
# 아직 반영할 리뷰 의견이 없으므로, build 직후 이 루프로 이어지는 경우(REVIEW_LOOP_AFTER)에 쓴다.
#
# REVIEW_LOOP_MAX(기본 5) 회를 넘겨도 미승인이면 사람 확인을 요청하고 종료한다.
# 중지: <CLONE_BASE>/.state/<KEY>.reviewloop.stop 파일 생성(대시보드 '루프 중지' 버튼) 또는
#       프로세스 트리 종료(SIGTERM). 둘 다 진행 상태를 정리하고 Slack 에 중지 알림을 보낸다.
#
# 하위 스크립트의 Slack 알림은 끄고(SLACK_WEBHOOK_URL 비움) 이 스크립트가 회차를 명시해 보낸다.
#
# env: PROJECT_ID, CARD_REPOS, GH_TOKEN, CLONE_BASE, HISTORY_FILE, SLACK_WEBHOOK_URL,
#      REVIEW_LOOP_MAX(기본 5), REVIEW_FIRST(1이면 1회차 반영 생략)
#      — 그 외는 하위 스크립트가 쓰는 값 그대로 상속
# --------------------------------------------------------------------------
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-${SELF_DIR}}"
CLONE_BASE="${CLONE_BASE:-${WORK_DIR}/repos}"
HISTORY_FILE="${HISTORY_FILE:-${WORK_DIR}/history.jsonl}"
APPROVED_MARKER="CLAUDE-REVIEW-APPROVED"   # run-review.sh · lib.js 와 동일해야 함
NO_REWORK_MARK="NO_REWORK_NEEDED"          # run-jira-agent.sh 의 '반영할 새 피드백 없음' 마커와 동일해야 함
REVIEW_LOOP_MAX="${REVIEW_LOOP_MAX:-5}"
REVIEW_FIRST="${REVIEW_FIRST:-}"           # 1이면 1회차는 반영 없이 리뷰부터(방금 올린 새 PR)

ISSUE_KEY="${1:-}"
OR="${2:-}"
PR_NUM="${3:-}"
if [[ -z "${ISSUE_KEY}" || -z "${OR}" || -z "${PR_NUM}" ]]; then
  echo "Usage: $0 <JIRA-ISSUE-KEY> <OWNER/REPO> <PR-NUMBER>" >&2; exit 1
fi
PR_URL="https://github.com/${OR}/pull/${PR_NUM}"

command -v gh >/dev/null 2>&1 || { echo "ERROR: 'gh' (GitHub CLI) 가 필요합니다." >&2; exit 1; }

notify_slack() {
  [[ -z "${SLACK_WEBHOOK_URL:-}" ]] && return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS -X POST -H 'Content-type: application/json' \
    --data "{\"text\":\"$1\"}" "${SLACK_WEBHOOK_URL}" >/dev/null 2>&1 || true
}
record_history() {  # result
  local ts; ts="$(date -u +%FT%TZ)"
  mkdir -p "$(dirname "${HISTORY_FILE}")"
  printf '{"ts":"%s","project":"%s","key":"%s","phase":"review-loop","result":"%s","pr":"%s","branch":""}\n' \
    "${ts}" "${PROJECT_ID:-}" "${ISSUE_KEY}" "$1" "${PR_URL}" >> "${HISTORY_FILE}"
}

STATE_DIR="${CLONE_BASE}/.state"; mkdir -p "${STATE_DIR}"
LOCK_DIR="${STATE_DIR}/${ISSUE_KEY}.reviewloop.lock"
STOP_FILE="${STATE_DIR}/${ISSUE_KEY}.reviewloop.stop"
STATUS_FILE="${STATE_DIR}/${ISSUE_KEY}.reviewloop.json"
TERM_MARK="${STATE_DIR}/${ISSUE_KEY}.reviewloop.term"   # 중지 처리 1회 보장 마커(다음 실행 시작 때 정리)
STARTED_AT="$(date -u +%FT%TZ)"

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "SKIP: [${ISSUE_KEY}] 리뷰 승인 루프가 이미 실행 중입니다(lock)"; exit 0
fi
rm -f "${STOP_FILE}" 2>/dev/null || true
rm -rf "${TERM_MARK}" 2>/dev/null || true   # 이전 실행이 남긴 중지 마커 정리
printf 'review-loop' > "${LOCK_DIR}.phase" 2>/dev/null || true
printf '%s' "$$" > "${LOCK_DIR}.pid" 2>/dev/null || true

ITER=0
# 대시보드가 폴링하는 진행 상태(회차·단계) — 값은 토큰류라 JSON escape 불필요
write_status() {  # step
  printf '{"key":"%s","owner":"%s","number":"%s","url":"%s","iter":%s,"max":%s,"step":"%s","startedAt":"%s","updatedAt":"%s"}\n' \
    "${ISSUE_KEY}" "${OR}" "${PR_NUM}" "${PR_URL}" "${ITER}" "${REVIEW_LOOP_MAX}" "$1" "${STARTED_AT}" "$(date -u +%FT%TZ)" \
    > "${STATUS_FILE}" 2>/dev/null || true
}
cleanup() {
  rmdir "${LOCK_DIR}" 2>/dev/null || true
  rm -f "${LOCK_DIR}.phase" "${LOCK_DIR}.pid" "${STOP_FILE}" "${STATUS_FILE}" \
        "${STATE_DIR}/${ISSUE_KEY}.reviewloop.rework.out" 2>/dev/null || true
}
on_term() {
  # 중복 방지: 파이프라인 서브셸이 트랩을 함께 받아 두 번 도는 경우가 있어 원자적 mkdir 로 1회만 처리
  mkdir "${TERM_MARK}" 2>/dev/null || exit 130
  echo ">> [${ISSUE_KEY}] 리뷰 승인 루프 중지 신호 — ${ITER}회차에서 종료"
  notify_slack "⏹ [${ISSUE_KEY}] 리뷰 승인 루프 중지됨 (${ITER}/${REVIEW_LOOP_MAX}회차) · ${OR}#${PR_NUM} · ${PR_URL}"
  record_history "stopped"
  cleanup
  exit 130
}
trap cleanup EXIT
trap on_term TERM INT

# 승인 마커 존재 여부(0=승인됨)
is_approved() {
  gh api "repos/${OR}/issues/${PR_NUM}/comments?per_page=100" --jq '.[].body' 2>/dev/null | grep -q "${APPROVED_MARKER}"
}
stop_requested() { [[ -f "${STOP_FILE}" ]]; }

write_status "starting"
MODE_NOTE=""; [[ "${REVIEW_FIRST}" == "1" ]] && MODE_NOTE=" · 리뷰부터 시작"
echo ">> [${ISSUE_KEY}] 리뷰 승인 루프 시작 · ${OR}#${PR_NUM} (최대 ${REVIEW_LOOP_MAX}회${MODE_NOTE}) · ${PR_URL}"
notify_slack "🔁 [${ISSUE_KEY}] 리뷰 승인 루프 시작 (최대 ${REVIEW_LOOP_MAX}회${MODE_NOTE}) · ${OR}#${PR_NUM} · ${PR_URL}"

if is_approved; then
  echo ">> [${ISSUE_KEY}] ${OR}#${PR_NUM} 이미 승인 마커 존재 → 루프 불필요"
  notify_slack "✅ [${ISSUE_KEY}] 이미 리뷰 승인 상태 — 루프 종료 · ${OR}#${PR_NUM} · ${PR_URL}"
  record_history "approved"
  exit 0
fi

FINAL="exhausted"
NOOP_STREAK=0   # 연속 무변경 반영 횟수(2회면 진전 없음으로 판단)
while (( ITER < REVIEW_LOOP_MAX )); do
  ITER=$(( ITER + 1 ))
  stop_requested && on_term

  PR_STATE="$(gh pr view "${PR_NUM}" --repo "${OR}" --json state --jq '.state' 2>/dev/null || echo "")"
  if [[ -n "${PR_STATE}" && "${PR_STATE}" != "OPEN" ]]; then
    echo ">> [${ISSUE_KEY}] ${OR}#${PR_NUM} PR 이 열려 있지 않음(${PR_STATE}) → 루프 종료"
    notify_slack "⏹ [${ISSUE_KEY}] PR 이 ${PR_STATE} 상태여서 리뷰 승인 루프 종료 (${ITER}회차) · ${OR}#${PR_NUM} · ${PR_URL}"
    FINAL="closed"; break
  fi

  # 1) 리뷰 반영(rework) — 그 PR 하나만. 하위 Slack 알림은 끄고 회차 알림으로 대체.
  # REVIEW_FIRST 1회차는 건너뛴다: 방금 올린 PR 이라 반영할 리뷰 의견이 아직 없다.
  if [[ "${REVIEW_FIRST}" == "1" && ${ITER} -eq 1 ]]; then
    echo ">> [${ISSUE_KEY}] === 루프 1/${REVIEW_LOOP_MAX} 회차: 새 PR → 반영 생략, 리뷰부터 ==="
  else
    echo ">> [${ISSUE_KEY}] === 루프 ${ITER}/${REVIEW_LOOP_MAX} 회차: 리뷰 반영(rework) ==="
    write_status "rework"
    REWORK_OUT="${STATE_DIR}/${ISSUE_KEY}.reviewloop.rework.out"
    # 파이프(| tee) 대신 파일로 받는다 — 파이프라인 서브셸이 중지 시그널을 함께 받아 중지 처리가 꼬이는 것을 막는다.
    # (엔진 진행 상황은 agent-logs/<KEY>-build.log 에서 실시간으로 볼 수 있다)
    # 연쇄 플래그(REVIEW_LOOP_AFTER/REVIEW_AFTER/REVIEW_FIRST)는 반드시 끊는다 — 대시보드가 최상위 build 에
    # 넣은 값을 하위가 그대로 물려받으면 rework 가 끝나고 이 루프를 '또' 띄워, 그 중첩 실행이 락에 막혀 남긴
    # SKIP 줄 때문에 정작 성공한 반영이 '카드 처리 중'으로 오인돼 루프가 죽는다.
    SLACK_WEBHOOK_URL="" REVIEW_LOOP_AFTER="" REVIEW_AFTER="" REVIEW_FIRST="" IN_REVIEW_LOOP=1 \
      REWORK=1 REWORK_ONLY_OWNER="${OR}" REWORK_ONLY_NUM="${PR_NUM}" \
      bash "${SELF_DIR}/run-jira-agent.sh" "${ISSUE_KEY}" build > "${REWORK_OUT}" 2>&1
    RC=$?
    cat "${REWORK_OUT}" 2>/dev/null || true
    stop_requested && on_term   # 중지 요청으로 하위가 죽은 경우 — 실패 알림 대신 중지 처리
    if (( RC != 0 )); then
      echo ">> [${ISSUE_KEY}] ${ITER}회차 리뷰 반영 실패(exit ${RC}) → 루프 중단" >&2
      notify_slack "❌ [${ISSUE_KEY}] 리뷰 승인 루프 ${ITER}/${REVIEW_LOOP_MAX}회차 — 리뷰 반영 실패로 중단 · ${OR}#${PR_NUM} · ${PR_URL}"
      FINAL="failed"; break
    fi
    # 스킵 판정은 '이 카드의 락에 막혔다'는 그 한 줄로만 한다. 하위가 찍는 다른 SKIP(중첩 루프·질문 대기)까지
    # 싸잡으면 반영이 성공했는데도 루프가 중단된다.
    if grep -qF "SKIP: [${ISSUE_KEY}] 이미 처리 중(lock)" "${REWORK_OUT}" 2>/dev/null; then
      echo ">> [${ISSUE_KEY}] ${ITER}회차 리뷰 반영이 스킵됨(다른 작업이 이 카드를 처리 중) → 루프 중단" >&2
      notify_slack "⏸ [${ISSUE_KEY}] 리뷰 승인 루프 ${ITER}/${REVIEW_LOOP_MAX}회차 — 카드가 이미 처리 중이라 중단 · ${OR}#${PR_NUM} · ${PR_URL}"
      FINAL="skipped"; break
    fi
    if grep -qF "SKIP: awaiting answers" "${REWORK_OUT}" 2>/dev/null; then
      echo ">> [${ISSUE_KEY}] ${ITER}회차 리뷰 반영이 질문 답변을 기다림 → 루프 중단" >&2
      notify_slack "⏸ [${ISSUE_KEY}] 리뷰 승인 루프 ${ITER}/${REVIEW_LOOP_MAX}회차 — 카드 질문 답변 대기로 중단 · ${OR}#${PR_NUM} · ${PR_URL}"
      FINAL="skipped"; break
    fi
    # 반영할 새 피드백이 없어 아무것도 안 고친 회차(정상). 직전 리뷰가 이미 반영된 상태일 수 있으므로
    # 재리뷰로 넘겨 판정한다. 다만 두 회차 연속 무변경이면 더 진전될 게 없으므로 사람 확인으로 넘긴다.
    if grep -qF "${NO_REWORK_MARK}" "${REWORK_OUT}" 2>/dev/null; then
      NOOP_STREAK=$(( NOOP_STREAK + 1 ))
      if (( NOOP_STREAK >= 2 )); then
        echo ">> [${ISSUE_KEY}] ${ITER}회차도 반영할 새 피드백 없음(연속 ${NOOP_STREAK}회) → 진전 없음, 루프 중단" >&2
        notify_slack "⏸ [${ISSUE_KEY}] 리뷰 승인 루프 ${ITER}/${REVIEW_LOOP_MAX}회차 — 반영할 새 피드백이 없어 진전 없음, 사람 확인 필요 · ${OR}#${PR_NUM} · ${PR_URL}"
        FINAL="noop"; break
      fi
      echo ">> [${ISSUE_KEY}] ${ITER}회차 반영할 새 피드백 없음 → 재리뷰로 판정"
    else
      NOOP_STREAK=0
    fi
    stop_requested && on_term
  fi

  # 2) 재리뷰 — 승인 마커가 있어도 강제(FORCE_REVIEW), 그 PR 하나만(REVIEW_ONLY_*)
  echo ">> [${ISSUE_KEY}] === 루프 ${ITER}/${REVIEW_LOOP_MAX} 회차: 재리뷰 ==="
  write_status "review"
  SLACK_WEBHOOK_URL="" REVIEW_LOOP_AFTER="" REVIEW_AFTER="" IN_REVIEW_LOOP=1 \
    FORCE_REVIEW=1 REVIEW_ONLY_OWNER="${OR}" REVIEW_ONLY_NUM="${PR_NUM}" \
    bash "${SELF_DIR}/run-review.sh" "${ISSUE_KEY}" \
    || echo ">> [${ISSUE_KEY}] ${ITER}회차 재리뷰 실행 오류 — 승인 여부로 계속 판정" >&2
  stop_requested && on_term

  # 3) 판정 — 승인 마커는 GitHub 에서 재확인(신뢰 가능한 판정)
  if is_approved; then
    echo ">> [${ISSUE_KEY}] ${OR}#${PR_NUM} ${ITER}회차에서 리뷰 승인 → 루프 종료"
    notify_slack "✅ [${ISSUE_KEY}] 리뷰 승인 완료 (루프 ${ITER}/${REVIEW_LOOP_MAX}회차) · ${OR}#${PR_NUM} · ${PR_URL}"
    record_history "approved"
    FINAL="approved"; break
  fi
  echo ">> [${ISSUE_KEY}] ${OR}#${PR_NUM} ${ITER}회차 미승인(수정 필요) → 다음 회차 반영"
  notify_slack "📝 [${ISSUE_KEY}] 리뷰 루프 ${ITER}/${REVIEW_LOOP_MAX}회차 — 수정 필요(미승인) · ${OR}#${PR_NUM} · ${PR_URL}"
  record_history "reviewed"
done

if [[ "${FINAL}" == "exhausted" ]]; then
  echo ">> [${ISSUE_KEY}] ${OR}#${PR_NUM} ${REVIEW_LOOP_MAX}회 반복 후에도 미승인 → 사람 확인 필요"
  notify_slack "⏸ [${ISSUE_KEY}] 리뷰 승인 루프 ${REVIEW_LOOP_MAX}회 반복 후에도 미승인 — 사람 확인 필요 · ${OR}#${PR_NUM} · ${PR_URL}"
  record_history "failed"
fi
[[ "${FINAL}" == "approved" ]] && exit 0
exit 0
