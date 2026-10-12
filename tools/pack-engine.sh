#!/data/data/com.termux/files/usr/bin/bash
# pack-engine.sh —— 把 native/ 打成一个可分发的包，用来传到 Gitee 发行版当附件。
#
# 用途：国内直接拉 llama.cpp 官方 GitHub release 经常超时。
# 维护者打一次包传到 Gitee 发行版，其他人就能用 GITEE_MIRROR 从国内快速取到
# （fetch-engine.sh 会自动优先用镜像）。
#
# 用法:
#   ./tools/pack-engine.sh              # 产出 dist/native-<版本>.tar.gz
#   LLAMA_BUILD=b12345 ./tools/pack-engine.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${LLAMA_BUILD:-b11552}"
SRC="$ROOT/native"
DIST="$ROOT/dist"
OUT="$DIST/native-${VERSION}.tar.gz"

[ -d "$SRC" ] || { echo "❌ 找不到 $SRC，先跑 ./tools/fetch-deps.sh" >&2; exit 1; }
mkdir -p "$DIST"

echo "── 打包 native/（$(du -sh "$SRC" | cut -f1)）"
tar czf "$OUT" -C "$ROOT" native

echo "── 校验（重新解包比对哈希）"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar xzf "$OUT" -C "$TMP"
ok=1
for f in "$SRC"/*; do
  b="$(basename "$f")"
  if [ -f "$TMP/native/$b" ]; then
    h1="$(sha256sum "$f" | cut -d' ' -f1)"; h2="$(sha256sum "$TMP/native/$b" | cut -d' ' -f1)"
    [ "$h1" = "$h2" ] || { echo "   ❌ $b 不一致"; ok=0; }
  else
    echo "   ❌ 包里缺少 $b"; ok=0
  fi
done
[ "$ok" = "1" ] && echo "   ✅ 15 个文件逐个哈希一致" || { echo "❌ 打包校验失败" >&2; exit 1; }

echo
echo "✅ 已生成：$OUT（$(du -h "$OUT" | cut -f1)）"
echo "   sha256: $(sha256sum "$OUT" | cut -d' ' -f1)"
echo
echo "下一步：把上面这个文件传到 Gitee 仓库的「发行版」附件，然后告诉使用者："
echo "  export GITEE_MIRROR=https://gitee.com/zhao-jiurong/wind-and-moon-local-edition/releases/download/v1.0.0/$(basename "$OUT")"
echo "  ./tools/fetch-engine.sh"
