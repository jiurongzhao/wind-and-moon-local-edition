#!/data/data/com.termux/files/usr/bin/bash
# dev-mirror.sh —— 把 cards/library/ 用 http 暴露出来，用于**本机联调**「在线卡库」。
#
# 为什么需要它：卡库正式发布是作为 Gitee 发行版附件，但真机联调时没法把 97MB
# 传上去再试。这个脚本在手机本机的 127.0.0.1 上开一个只读 http 镜像，
# 并把目录里的 baseUrl/url 改写成这个本机地址；App 的 /fetch 代理在 **dev 构建**
# 下放行回环 http（发布版仍然只允许 https），于是真机上能完整跑完
# 「拉目录 → 下载分片 → 校验 → 入库」。
#
# ⚠️ 镜像目录放在仓库外（$HOME/tmpwork/fydevlib）：build.sh 会整目录重建 build/，
#    放里面会被清掉，之前踩过。
#
# 用法:
#   ./tools/dev-mirror.sh            # 生成目录 + 起服务（默认 8765）
#   ./tools/dev-mirror.sh 9000       # 换端口
#   ./tools/dev-mirror.sh --stop     # 停掉
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8765}"
DIR="${DEV_MIRROR_DIR:-$HOME/tmpwork/fydevlib}"
PIDFILE="$DIR/.pid"

if [ "$PORT" = "--stop" ]; then
  if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi
  pkill -f "http.server .*--bind 127.0.0.1" 2>/dev/null || true
  echo "已停止本地卡库镜像"
  exit 0
fi

LIB="$ROOT/cards/library"
[ -d "$LIB" ] || { echo "❌ 没有 $LIB —— 先跑 python3 tools/gen-cards.py" >&2; exit 1; }

rm -rf "$DIR"; mkdir -p "$DIR"
python3 - "$ROOT/cards/library-index.json" "$DIR/index.json" "http://127.0.0.1:$PORT/" <<'PY'
import json, sys
src, dst, base = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src, encoding='utf-8'))
d['baseUrl'] = base
for p in d['packs']:
    p['url'] = base + p['file']
json.dump(d, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('   目录：%d 片 / %d 张（base=%s）' % (len(d['packs']), d.get('total', 0), base))
PY
for f in "$LIB"/*.json; do
  b="$(basename "$f")"
  case "$b" in index.json|audit.json) continue;; esac
  ln -sf "$f" "$DIR/$b"
done

( cd "$DIR" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
echo $! > "$PIDFILE"
sleep 1.5
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/index.json" || echo 000)"
size="$(curl -s -o /dev/null -w '%{size_download}' "http://127.0.0.1:$PORT/mystery-character-1.json" || echo 0)"
[ "$code" = "200" ] || { echo "❌ 镜像没起来（HTTP $code）" >&2; exit 1; }
echo "✅ 本地卡库镜像：http://127.0.0.1:$PORT/index.json （目录 HTTP $code，单片 ${size} B）"
echo "   分片软链自 $LIB；停止：./tools/dev-mirror.sh --stop"
echo
echo "   真机联调：装 dev 包（./build.sh --debug），卡片面板把目录地址改成"
echo "   http://127.0.0.1:$PORT/index.json —— dev 构建才放行回环 http。"
