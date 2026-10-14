#!/data/data/com.termux/files/usr/bin/bash
# devtest.sh —— 通过调试广播无头驱动 App 的三条推理线路（不抢屏幕、不打断用户）。
#
# 前置：debug 包已装；App 进程活着（打开过一次「风月·本地版」即可，测试期间靠它的前台服务保活）。
# 结果：App 写在 files/devtest/result.json，本脚本用 run-as 读出来。
#
# 用法:
#   ./tools/devtest.sh status
#   ./tools/devtest.sh load <id> <model> [tune] [threads] [ctx]
#   ./tools/devtest.sh chat <id> [maxTokens] < messages.json
set -u
PKG=com.fy.local
DEV="${DEV:-$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')}"
[ -n "$DEV" ] || { echo "没有设备（先开无线调试）" >&2; exit 1; }
ADB="adb -s $DEV"

clear_result() { $ADB shell "run-as $PKG sh -c 'rm -f files/devtest/result.json'" >/dev/null 2>&1; }
read_result()  { $ADB shell "run-as $PKG cat files/devtest/result.json 2>/dev/null" | tr -d '\r'; }

cmd_json() {   # cmd_json <等待秒> <am broadcast 参数...>
  local wait="$1"; shift
  clear_result
  $ADB shell am broadcast -a com.fy.local.DEVTEST "$@" >/dev/null 2>&1
  local i
  for i in $(seq 1 $(( wait * 2 ))); do
    OUT="$(read_result)"
    [ -n "$OUT" ] && { printf '%s\n' "$OUT"; return 0; }
    sleep 0.5
  done
  echo '{"error":"等待 App 结果超时（App 进程可能没起来：先手动打开一次风月 App）"}'
  return 1
}

case "${1:-}" in
  status) cmd_json 10 --es cmd status ;;
  load)
    [ $# -ge 3 ] || { echo "load 需要 <id> <model>" >&2; exit 1; }
    cmd_json 300 --es cmd load --es id "$2" --es model "$3" \
      --es tune "${4:-}" --ei threads "${5:-4}" --ei ctx "${6:-4096}" ;;
  chat)
    [ $# -ge 2 ] || { echo "chat 需要 <id> [maxTokens]，messages 从 stdin 读" >&2; exit 1; }
    MSGS="$(cat | base64 -w0)"
    cmd_json 300 --es cmd chat --es id "$2" --ei maxTokens "${3:-160}" --es messagesB64 "$MSGS" ;;
  *)
    sed -n '3,10p' "$0"; exit 1 ;;
esac
