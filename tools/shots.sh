#!/data/data/com.termux/files/usr/bin/bash
# shots.sh —— 用无头 Chromium 给界面截图（README / 发版用，也能用来验收美化效果）。
#
# 为什么需要它：界面改动如果只靠肉眼猜，很容易"代码看着对、真机很难看"。
# 这个脚本把 UI 复制到临时目录，塞进一份假数据（tools/preview-seed.js），
# 用 http:// 源（IndexedDB/localStorage 才正常）打开，逐屏截图。
#
# 依赖： chromium（pkg install x11-repo && pkg install chromium）、python3
# 用法： ./tools/shots.sh [输出目录，默认 docs/shots]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/docs/shots}"
UI="$ROOT/app/assets/ui"
PORT="${SHOT_PORT:-8899}"
W=412; H=915            # 近似 Pixel/小米 的逻辑分辨率

command -v chromium >/dev/null 2>&1 || {
  echo "❌ 没有 chromium。安装：pkg install x11-repo && pkg install chromium" >&2
  exit 1
}

# 卡包要先同步进 UI 目录（截图里要能显示卡包页）
python3 "$ROOT/tools/build-pack-index.py" >/dev/null 2>&1 || true

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null || true' EXIT

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
echo "── 启动临时 http 服务 :$PORT"
( cd "$TMP/ui" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
SRV_PID=$!
sleep 2

shot() {   # shot <文件名> <查询串>
  local name="$1" qs="$2"
  echo "   截图 $name …"
  chromium --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 \
    --window-size="$W,$H" \
    --virtual-time-budget="${SHOT_WAIT:-6000}" \
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

echo
echo "✅ 完成：$OUT"
ls -la "$OUT" | awk 'NR>3 {printf "   %-26s %s\n", $9, $5}'
echo
echo "把这些图放进 README 即可（Markdown 相对路径引用）。"
