#!/usr/bin/env bash
#
# lib-notify.sh — 리뷰 승인 알림의 CI 게이트(공용)
# --------------------------------------------------------------------------
# 왜 필요한가: 승인 마커만 보고 [병합] 버튼을 보내면, 승인 시점엔 CI 가 대개 아직 돌고 있어
# 그 버튼이 대시보드 병합 라우트의 CI 게이트에 막힌다 — 눌러도 병합되지 않고, CI 가 끝난 뒤
# 다른 알림이 또 와서 그때야 눌리는 '헛클릭 + 중복 알림' 이 된다.
# 그래서 승인 알림은 'CI 가 확정된 뒤' 한 번만 보낸다. 판정 기준은 대시보드·에픽 러너와
# 동일하다(ci-state.js → dashboard/lib.js 의 ciStateOf).
#
# 호출 스크립트가 제공해야 하는 것: SELF_DIR, ISSUE_KEY, notify_slack_btn()
#
# env:
#   REVIEW_APPROVE_CI_WAIT_MIN  CI 확정을 기다릴 최대 분(기본 40, 0=기다리지 않고 즉시 판정)
#   REVIEW_APPROVE_CI_POLL_SEC  폴링 간격 초(기본 30)
#   EPIC_KEY                    설정돼 있으면(연속 개발 중) 승인 알림을 보내지 않는다 —
#                               에픽 러너가 병합 대기에서 '승인 + CI 통과' 를 한 번만 알린다.
# --------------------------------------------------------------------------

# CI 상태 조회 → "상태\t실패체크이름". 어떤 실패에도 0 을 돌려준다(알림 때문에 본류를 멈추지 않는다).
ci_state() {  # <OWNER/REPO> <PR번호> [최대 대기 분]
  local or="$1" n="$2" wait_min="${3:-0}"
  command -v node >/dev/null 2>&1 || { printf 'unknown\t\n'; return 0; }
  node "${SELF_DIR}/ci-state.js" "${or}" "${n}" \
    --wait-min "${wait_min}" --poll-sec "${REVIEW_APPROVE_CI_POLL_SEC:-30}" 2>/dev/null \
    || printf 'unknown\t\n'
}

# 상태에 맞는 알림 1건. 초록(또는 CI 없는 repo)일 때만 [병합] 버튼을 붙인다.
_notify_by_ci_state() {  # <상태> <실패체크이름> <OWNER/REPO> <PR번호> <PR URL> <본문>
  local st="$1" names="$2" or="$3" n="$4" url="$5" msg="$6"
  case "${st}" in
    pass|none)
      notify_slack_btn "✅ ${msg} · CI 통과" "merge:${or}:${n}" "url:🔗 PR 열기:${url}" ;;
    fail)
      # 병합 버튼을 붙이지 않는다 — CI 게이트에 막히는 버튼은 없는 게 낫다.
      notify_slack_btn "🧪 ${msg} — 리뷰는 승인됐지만 CI 실패로 병합할 수 없습니다${names:+ (실패: ${names})}" "url:🔗 PR 열기:${url}" ;;
    closed)
      echo ">> [${ISSUE_KEY:-}] ${or}#${n} PR 이 이미 닫혀 승인 알림을 보내지 않습니다" ;;
    *)
      notify_slack_btn "⏳ ${msg} — CI 가 아직 확정되지 않았습니다(${REVIEW_APPROVE_CI_WAIT_MIN:-40}분 대기 초과). 초록이 된 뒤 병합하세요" "url:🔗 PR 열기:${url}" ;;
  esac
}

# 리뷰 승인 알림. <본문> 에는 아이콘 없이 내용만 넘긴다(아이콘은 CI 상태가 정한다).
notify_review_approved() {  # <OWNER/REPO> <PR번호> <PR URL> <본문>
  local or="$1" n="$2" url="$3" msg="$4"
  [[ -z "${SLACK_WEBHOOK_URL:-}" ]] && return 0
  if [[ -n "${EPIC_KEY:-}" ]]; then
    echo ">> [${ISSUE_KEY:-}] 연속 개발 중 — 승인 알림은 러너의 '병합만 남음'(승인+CI 통과) 알림으로 갈음합니다"
    return 0
  fi
  local wait_min="${REVIEW_APPROVE_CI_WAIT_MIN:-40}" out st names
  out="$(ci_state "${or}" "${n}" 0)"       # 먼저 1회만 본다 — 이미 확정이면 기다릴 이유가 없다
  st="${out%%$'\t'*}"; names="$(printf '%s' "${out#*$'\t'}" | tr -d '\n')"
  if [[ "${st}" == "pass" || "${st}" == "fail" || "${st}" == "closed" ]] || (( wait_min == 0 )); then
    _notify_by_ci_state "${st}" "${names}" "${or}" "${n}" "${url}" "${msg}"
    return 0
  fi
  # CI 가 아직 도는 중 — 본류를 붙잡지 않고 백그라운드에서 확정될 때까지 기다린 뒤 알린다.
  # 표준출력/에러는 끊어 둔다: 부모의 stdout 파이프를 물고 있으면 호출자(run-cycle·에픽 러너)가
  # '스크립트가 안 끝난다'고 읽는다(파이프가 닫히지 않아 close 이벤트가 늦는다).
  (
    out="$(ci_state "${or}" "${n}" "${wait_min}")"
    st="${out%%$'\t'*}"; names="$(printf '%s' "${out#*$'\t'}" | tr -d '\n')"
    _notify_by_ci_state "${st}" "${names}" "${or}" "${n}" "${url}" "${msg}"
  ) >/dev/null 2>&1 &
  echo ">> [${ISSUE_KEY:-}] ${or}#${n} CI 진행 중(${st}) — CI 확정 후 승인 알림을 보냅니다(최대 ${wait_min}분 대기)"
}
