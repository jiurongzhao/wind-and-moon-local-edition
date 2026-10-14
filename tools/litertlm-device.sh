#!/data/data/com.termux/files/usr/bin/bash
# litertlm-device.sh —— 一条链跑完 LiteRT-LM 真机冒烟：连 adb → 装包 → 放模型 → 起 App → 接 CDP → 加载 + 对话。
#
# 前置：手机已开「无线调试」（tools/adbgo.sh 能连上）。
# 用法:
#   ./tools/litertlm-device.sh                 # 默认放 Qwen3-0.6B.litertlm
#   MODEL=/path/to/Qwen3-4B.litertlm ./tools/litertlm-device.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="$ROOT/fy-debug.apk"
MODEL="${MODEL:-$HOME/tmpwork/c-models/Qwen3-0.6B.litertlm}"
PKG="com.fy.local"
CDP="${CDP_MJS:-$HOME/tmpwork/cdp.mjs}"

[ -f "$APK" ] || { echo "缺 $APK（先 ./build.sh --debug）" >&2; exit 1; }
[ -f "$MODEL" ] || { echo "缺模型 $MODEL（先 ./tools/fetch-litertlm-model.sh）" >&2; exit 1; }
[ -f "$CDP" ] || { echo "缺 CDP 吊具 $CDP" >&2; exit 1; }

echo "== 1/6 连 adb =="
# 优先复用已经连上的设备（可能连的是 wlan IP 或 127.0.0.1）；都没有再扫。
DEV="$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
if [ -z "$DEV" ]; then
  "$ROOT/tools/adbgo.sh" 2>&1 | tail -2
  # 接口名不一定是 wlan0（实测在 wlan0 / wlan1 之间变过），认所有 wlan*
  WLAN="$(ifconfig 2>/dev/null | awk '/^wlan/{f=1} f && /inet /{print $2; exit}')"
  if [ -n "$WLAN" ]; then
    echo "  127.0.0.1 没找到，改扫 wlan（$WLAN）…"
    ADB_HOST="$WLAN" "$ROOT/tools/adbgo.sh" 2>&1 | tail -2
  fi
  DEV="$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
fi
[ -n "$DEV" ] || { echo "没有设备：手机上打开「无线调试」再试" >&2; exit 1; }
ADB="adb -s $DEV"
echo "device=$ADB"

echo "== 2/6 装 debug 包 =="
$ADB install -r -d "$APK" 2>&1 | tail -2
$ADB shell settings put system screen_off_timeout 1800000 >/dev/null 2>&1
$ADB shell svc power stayon true >/dev/null 2>&1
$ADB shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1

echo "== 3/6 把模型放进 App 私有 models/（shell 读 → run-as 写，绕开 scoped storage）=="
NAME="$(basename "$MODEL")"
SIZE="$(stat -c%s "$MODEL")"
HAVE="$($ADB shell "run-as $PKG sh -c 'stat -c%s files/models/$NAME 2>/dev/null || echo 0'" 2>/dev/null | tr -d '\r')"
if [ "$HAVE" != "$SIZE" ]; then
  $ADB shell "run-as $PKG mkdir -p files/models" >/dev/null 2>&1
  $ADB push "$MODEL" /sdcard/Download/"$NAME" 2>&1 | tail -1
  echo "  导入中（$((SIZE/1048576))MiB，走管道可能要几分钟）…"
  $ADB shell "cat /sdcard/Download/$NAME | run-as $PKG sh -c 'cat > files/models/$NAME'"
  $ADB shell "rm -f /sdcard/Download/$NAME" >/dev/null 2>&1
else
  echo "  已存在且大小一致：$NAME"
fi
$ADB shell "run-as $PKG ls -la files/models" 2>/dev/null | tail -5

echo "== 4/6 启动 App =="
$ADB shell am force-stop $PKG >/dev/null 2>&1
$ADB shell am start -n $PKG/.MainActivity >/dev/null 2>&1
# WebView devtools socket 比 Activity 建得慢，进程还可能重启 → 重新取 PID + 校验 + 重试。
# （真机实测：只在启动后 sleep 6 再 forward，经常拿到空 target，后面 node cdp.mjs 直接挂死。）
CDP_OK=0
for attempt in 1 2 3 4 5 6; do
  sleep 4
  PID=$($ADB shell pidof $PKG 2>/dev/null | tr -d '\r' | awk '{print $1}')
  [ -n "$PID" ] || continue
  $ADB forward --remove-all >/dev/null 2>&1
  $ADB forward tcp:9222 localabstract:"webview_devtools_remote_$PID" >/dev/null 2>&1
  if curl -s --max-time 4 http://127.0.0.1:9222/json/list | grep -q '"type"'; then
    echo "CDP 就绪（第 $attempt 次，pid=$PID）"
    CDP_OK=1
    break
  fi
done
[ "$CDP_OK" = "1" ] || { echo "CDP forward 失败：WebView devtools target 一直没出现" >&2; exit 1; }

mkdir -p "$ROOT/build"
LOADJS="$ROOT/build/ll-load.js"
{ echo "window.__LLM_MODEL='$NAME'; window.__LLM_THREADS=${THREADS:-4}; window.__LLM_TUNE='${TUNE:-}';"; cat "$ROOT/tools/litertlm-load.js"; } > "$LOADJS"
echo "== 5/6 加载 LiteRT-LM（$NAME）=="
node "$CDP" --file "$LOADJS"
echo
CHATJS="$ROOT/build/ll-chat.js"
{ echo "window.__LLM_MAX=${MAXTOK:-160};"; cat "$ROOT/tools/litertlm-chat.js"; } > "$CHATJS"
echo "== 6/6 一轮对话（maxTokens=${MAXTOK:-160}）=="
node "$CDP" --file "$CHATJS"
for i in $(seq 1 60); do
  sleep 2
  OUT=$(node "$CDP" --file "$ROOT/tools/litertlm-poll.js")
  echo "$OUT" | grep -q '"done": true' && { echo "$OUT"; break; }
  [ "$i" = "60" ] && echo "$OUT"
done
echo "== 完成 =="
