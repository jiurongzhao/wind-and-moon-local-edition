#!/data/data/com.termux/files/usr/bin/bash
# deploy.sh —— 一键部署到手机（走本机无线调试）
#
#   ./deploy.sh              全部：连 adb → 装 APK → 推模型 → 启动 → 跟日志
#   ./deploy.sh install      只装 APK
#   ./deploy.sh model [路径]  只推模型（默认推 Qwen3-4B）
#   ./deploy.sh model-small  推 0.5B 小模型（测试用，快）
#   ./deploy.sh run          只启动 App
#   ./deploy.sh logs         跟日志（Ctrl-C 退出）
#   ./deploy.sh reinstall    卸载重装（清数据）
set -u

ROOT="$HOME/2/fy"
PKG="com.fy.local"
APK="$ROOT/fy.apk"
BIG="$ROOT/models/Qwen3-4B-Q4_K_M.gguf"
SMALL="$ROOT/models/qwen2.5-0.5b-instruct-q4_k_m.gguf"
LOGTAGS="FY:V FY/Engine:V FY/AssetServer:V FY/Models:V FY/Speech:V FY/Bridge:V"

adbdev() { adb devices | awk 'NR>1 && $2=="device"{print $1; exit}'; }

connect() {
  local d; d="$(adbdev)"
  if [ -z "$d" ]; then
    echo "── 重新连接无线调试 …"
    # 优先用仓库自带的工具；老布局（脚本放在 ~/2/）也能兼容
    if [ -x "$ROOT/tools/adbgo.sh" ]; then
      "$ROOT/tools/adbgo.sh" || return 1
    else
      (cd "$HOME/2" && ./adbgo.sh) || return 1
    fi
    d="$(adbdev)"
  fi
  [ -n "$d" ] || { echo "❌ 没有可用设备，请先在手机上打开「无线调试」"; return 1; }
  echo "✅ 设备: $d"
}

do_install() {
  local d; d="$(adbdev)" || return 1
  echo "── 安装 $APK"
  adb -s "$d" install -r -d "$APK"
}

do_reinstall() {
  local d; d="$(adbdev)" || return 1
  read -r -p "会清空 App 数据（角色卡/会话全丢），确认？[y/N] " a
  [ "$a" = y ] || { echo "已取消"; return 0; }
  adb -s "$d" uninstall "$PKG" >/dev/null 2>&1
  adb -s "$d" install "$APK"
}

do_model() {
  local d; d="$(adbdev)"; local m="${1:-$BIG}"
  [ -f "$m" ] || { echo "❌ 模型不存在: $m"; return 1; }
  local base; base="$(basename "$m")"
  echo "── 推模型 $base ($(du -h "$m" | cut -f1)) → App 私有目录"
  echo "   （走 adb 本地回环，不经过 WiFi 网卡，速度取决于存储）"
  adb -s "$d" shell "run-as $PKG mkdir -p files/models" || {
    echo "❌ run-as 失败：APK 可能不是 debuggable 构建"; return 1; }
  # 直接流式写入，避免在设备上多占一份 2.5G 临时文件
  adb -s "$d" shell "run-as $PKG sh -c 'cat > files/models/$base.part'" < "$m" \
    && adb -s "$d" shell "run-as $PKG sh -c 'mv files/models/$base.part files/models/$base'" \
    && echo "✅ 已推送 $base"
  adb -s "$d" shell "run-as $PKG ls -la files/models/"
}

do_run() {
  local d; d="$(adbdev)" || return 1
  adb -s "$d" shell am start -n "$PKG/.MainActivity"
}

do_logs() {
  local d; d="$(adbdev)" || return 1
  echo "── 日志（$LOGTAGS）Ctrl-C 退出"
  adb -s "$d" logcat -v time -s $LOGTAGS
}

do_all() {
  connect || exit 1
  do_install || exit 1
  do_model "$SMALL" || echo "（小模型推送失败，可稍后手动 ./deploy.sh model）"
  do_run
  sleep 3
  do_logs
}

cmd="${1:-all}"
case "$cmd" in
  install)   connect && do_install ;;
  reinstall) connect && do_reinstall ;;
  model)     connect && do_model "${2:-$BIG}" ;;
  model-small) connect && do_model "$SMALL" ;;
  run)       connect && do_run ;;
  logs)      connect && do_logs ;;
  all)       do_all ;;
  *) sed -n '2,14p' "$0"; exit 1 ;;
esac
