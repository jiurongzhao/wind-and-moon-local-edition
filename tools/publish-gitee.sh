#!/data/data/com.termux/files/usr/bin/bash
# publish-gitee.sh —— 用 Gitee OpenAPI 建发行版并上传附件（一个命令发版）。
#
# 需要一个访问令牌（Gitee → 设置 → 私人令牌，勾 projects 权限）。**不会**把令牌打印出来：
#   * 优先读环境变量 GITEE_TOKEN
#   * 否则读文件 ~/.gitee_token（建议 chmod 600，用完即删/吊销）
#
# 用法:
#   ./tools/publish-gitee.sh v1.1.0                        # 说明取 dist/发行说明-v1.1.0.md
#   ./tools/publish-gitee.sh v1.1.0 /path/to/notes.md      # 指定说明文件
#   SKIP_ASSETS=1 ./tools/publish-gitee.sh v1.1.0          # 只建发行版不传附件
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${GITEE_REPO:-zhao-jiurong/wind-and-moon-local-edition}"
API="https://gitee.com/api/v5/repos/$REPO"
TAG="${1:-}"
NOTES="${2:-$ROOT/dist/发行说明-${TAG}.md}"

[ -n "$TAG" ] || { echo "用法: $0 <tag> [说明文件]" >&2; exit 1; }

TOKEN="${GITEE_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$HOME/.gitee_token" ]; then
  TOKEN="$(tr -d ' \t\r\n' < "$HOME/.gitee_token")"
fi
[ -n "$TOKEN" ] || {
  echo "❌ 没有令牌。请先把令牌写进 ~/.gitee_token（chmod 600），或导出 GITEE_TOKEN" >&2
  exit 1
}

[ -f "$NOTES" ] || { echo "❌ 找不到说明文件：$NOTES" >&2; exit 1; }

echo "── 1/3 创建发行版 $TAG（仓库 $REPO）"
RESP="$(curl -sS -X POST "$API/releases" \
  --data-urlencode "access_token=$TOKEN" \
  --data-urlencode "tag_name=$TAG" \
  --data-urlencode "name=风月·本地版 $TAG" \
  --data-urlencode "body@$NOTES" \
  --data-urlencode "prerelease=false" \
  --data-urlencode "target_commitish=main")"

RID="$(printf '%s' "$RESP" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
if isinstance(d,dict) and d.get("id"):
    print(d["id"])
else:
    sys.stderr.write("接口返回：" + str(d)[:300] + "\n")
    print("")')"

if [ -z "$RID" ]; then
  echo "❌ 创建失败（令牌权限不够？标签不存在？同名发行版已存在？）" >&2
  exit 1
fi
echo "   ✅ 发行版 id=$RID"

if [ "${SKIP_ASSETS:-0}" = "1" ]; then
  echo "── 2/3 跳过附件（SKIP_ASSETS=1）"
else
  echo "── 2/3 上传附件"
  ATTACH="$API/releases/$RID/attach_files"
  for f in "$ROOT/fy.apk" "$ROOT/dist/native-b11552.tar.gz"; do
    [ -f "$f" ] || { echo "   ⚠️  跳过不存在的 $f"; continue; }
    echo "   ↑ $(basename "$f")（$(du -h "$f" | cut -f1)）"
    OUT="$(curl -sS -X POST "$ATTACH" -F "access_token=$TOKEN" -F "file=@$f" 2>&1 | head -c 200)"
    case "$OUT" in
      *'"id"'*|*'"browser_download_url"'*) echo "     ✅ 已上传" ;;
      *) echo "     ⚠️  返回：$OUT" ;;
    esac
  done
fi

echo "── 3/3 校验"
curl -sS "$API/releases/tags/$TAG?access_token=$TOKEN" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("   标题:", d.get("name"), "| 标签:", d.get("tag_name"))
assets = d.get("assets") or []
print("   附件:", len(assets), "个")
for a in assets:
    print("     -", a.get("name") or a.get("browser_download_url"))
'
echo
echo "✅ 完成。发行版页面：https://gitee.com/$REPO/releases/tag/$TAG"
