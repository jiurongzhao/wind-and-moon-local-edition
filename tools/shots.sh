#!/data/data/com.termux/files/usr/bin/bash
# shots.sh —— 用无头 Chromium 给界面截图（README / 发版用，也能用来验收美化效果）。
#
# 为什么需要它：界面改动如果只靠肉眼猜，很容易"代码看着对、真机很难看"。
# 这个脚本把 UI 复制到临时目录，塞进一份假数据（tools/preview-seed.js），
# 用 http:// 源（IndexedDB/localStorage 才正常）打开，逐屏截图。
#
# 依赖： chromium（pkg install x11-repo && pkg install chromium）、python3
# 用法： ./tools/shots.sh [输出目录，默认 docs/shots]
# 环境变量： SHOT_WAIT=<ms> 覆盖等待预算（默认 9000；太短会截到"界面还没渲染完"的空页）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/docs/shots}"
UI="$ROOT/app/assets/ui"
PORT="${SHOT_PORT:-}"        # 不指定就随机挑一个空闲端口（避免上一轮残留占用）
W=412; H=915            # 近似 Pixel/小米 的逻辑分辨率

# Termux 里包名装出来的是 chromium-browser（chromium 只是习惯叫法）；
# 实测 headless_shell 在这个内核上不出图，chromium-browser --headless=new 才稳。
CHROME=""
for c in chromium chromium-browser headless_shell; do
  if command -v "$c" >/dev/null 2>&1; then CHROME="$c"; break; fi
done
[ -n "$CHROME" ] || {
  echo "❌ 没有 chromium。安装：pkg install x11-repo && pkg install chromium" >&2
  exit 1
}

# 卡包要先同步进 UI 目录（截图里要能显示卡包页）
python3 "$ROOT/tools/build-pack-index.py" >/dev/null 2>&1 || true

TMP="$(mktemp -d)"
cleanup() {
  if [ -n "${SRV_PID:-}" ]; then kill "$SRV_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

cp -r "$UI" "$TMP/ui"
cp "$ROOT/tools/preview-seed.js" "$TMP/ui/preview-seed.js"
# 在副本的 index.html 里注入预览脚本（原文件不动）
python3 - "$TMP/ui/index.html" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = s.replace('</body>', '  <script src="preview-seed.js"></script>\n</body>')
open(p, 'w', encoding='utf-8').write(s)
PY

mkdir -p "$OUT"

# 选端口 + 起服务：用 exec 让 $! 就是 python 自己的 PID（否则 kill 的是子 shell，
# python 变孤儿继续占着端口，下一轮就会截到 404 页面 —— 这个坑踩过一次）
if [ -z "$PORT" ]; then
  PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
fi
echo "── 启动临时 http 服务 :$PORT"
( cd "$TMP/ui" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
SRV_PID=$!

# 起完必须确认真能拿到页面，否则后面全是 404 截图（而且看不太出来）
ok=0
for i in $(seq 1 20); do
  if curl -sf -m 5 "http://127.0.0.1:$PORT/index.html" -o /dev/null 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
[ "$ok" = "1" ] || { echo "❌ 本地服务没起来（端口 $PORT），中止" >&2; exit 1; }

shot() {   # shot <文件名> <查询串>
  local name="$1" qs="$2"
  echo "   截图 $name …"
  "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run \
    --user-data-dir="$TMP/profile-$name" --hide-scrollbars \
    --force-prefers-reduced-motion \
    --force-device-scale-factor=2 \
    --window-size="$W,$H" \
    --virtual-time-budget="${SHOT_WAIT:-9000}" \
    --screenshot="$OUT/$name.png" \
    "http://127.0.0.1:$PORT/index.html?$qs" >/dev/null 2>&1 || echo "     ⚠️ $name 失败"
}

echo "── 逐屏截图（$W×$H @2x）"
shot 01-characters   "view=characters"
shot 02-chat         "view=chat"
shot 03-chat-light   "view=chat&theme=light"
shot 04-characters-light "view=characters&theme=light"
shot 05-packs        "view=packs"
shot 06-recommend    "view=rec"
shot 07-settings     "view=settings"
shot 08-onboard      "view=onboard"
shot 09-backend      "view=backend"
shot 10-slash        "view=slash"
shot 11-creator-category "view=creator"
shot 12-creator-skeleton "view=creator2"
shot 13-editor-lint  "view=editor"
shot 14-inspiration  "view=ref"
shot 15-library      "view=library"
shot 16-library-search "view=library-search"
shot 17-ask              "view=ask"
shot 18-empty            "view=empty"

echo
echo "✅ 完成：$OUT"
ls -la "$OUT" | awk 'NR>3 {printf "   %-26s %s\n", $9, $5}'
echo
echo "把这些图放进 README 即可（Markdown 相对路径引用）。"
