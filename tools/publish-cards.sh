#!/data/data/com.termux/files/usr/bin/bash
# publish-cards.sh —— 把 cards/library/ 里的大卡库作为发行版附件发出去，并生成 App 用的目录。
#
# 为什么不在 APK 里：每分类 1000 角色卡 + 1000 剧情卡 = 32000 张，约 100MB 原始 JSON，
# 塞进 APK 会让安装包从 13MB 涨到 30MB 以上，而且大多数人只玩几个分类。
#
# 令牌：GITEE_TOKEN 环境变量，或 ~/.gitee_token（**不会**打印令牌）。
#
# 用法:
#   ./tools/publish-cards.sh cards-v1          # 建发行版 + 传全部分片 + 生成目录
#   ./tools/publish-cards.sh cards-v1 --dry    # 只清点要传什么，不联网
#   SKIP_UPLOAD=1 ./tools/publish-cards.sh cards-v1   # 只生成目录（用于本地联调）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/cards/library"
REPO="${GITEE_REPO:-zhao-jiurong/wind-and-moon-local-edition}"
API="https://gitee.com/api/v5/repos/$REPO"
TAG="${1:-cards-v1}"
DRY=0
[ "${2:-}" = "--dry" ] && DRY=1

[ -d "$LIB" ] || { echo "❌ 没有 $LIB —— 先跑 python3 tools/gen-cards.py" >&2; exit 1; }

# 要传的分片（目录/审计报告不传）
mapfile -t FILES < <(cd "$LIB" && ls *.json 2>/dev/null | grep -v -E '^(index|audit|sample)\.json$' | sort || true)
COUNT="${#FILES[@]}"
BYTES="$(du -sb "$LIB" | cut -f1)"
echo "── 卡库清点：$COUNT 个分片，目录合计 $((BYTES/1048576)) MB"
[ "$COUNT" -gt 0 ] || { echo "❌ $LIB 里没有分片" >&2; exit 1; }

BASE="https://gitee.com/$REPO/releases/download/$TAG/"
echo "── 附件下载前缀：$BASE"

if [ "$DRY" = "1" ]; then
  printf '   %s\n' "${FILES[@]}" | head -8
  [ "$COUNT" -gt 8 ] && echo "   …（其余 $((COUNT-8)) 个）"
  echo "（--dry：没有联网，也没有改目录）"
  exit 0
fi

# ---- 1) 建发行版（已存在就复用） ----
RID=""
if [ "${SKIP_UPLOAD:-0}" != "1" ]; then
  TOKEN="${GITEE_TOKEN:-}"
  if [ -z "$TOKEN" ] && [ -f "$HOME/.gitee_token" ]; then
    TOKEN="$(tr -d ' \t\r\n' < "$HOME/.gitee_token")"
  fi
  [ -n "$TOKEN" ] || { echo "❌ 没有令牌（GITEE_TOKEN 或 ~/.gitee_token）" >&2; exit 1; }

  echo "── 1/3 创建发行版 $TAG"
  NOTES="$ROOT/dist/卡库说明-$TAG.md"
  if [ ! -f "$NOTES" ]; then
    NOTES="$(mktemp)"
    cat > "$NOTES" <<EOF
# 风月·本地版 · 可下载卡库 $TAG

每分类 **1000 张角色卡 + 1000 张剧情卡**（16 类，共 32000 张），全部由本项目的
叙事母题素材库组合生成，**CC0-1.0**，可自由使用与修改。

- 只借鉴**结构与母题**，不包含任何第三方作品正文、角色名或台词；
- 每张卡都过了发布闸门（字段齐全、长度达标、含 \`/no_think\`），并做过查重与多样性审计；
- 在 App 里「角色页 → 卡库」一键下载导入，不需要手动解压。

各分片是标准 \`fy_pack_v1\` 卡包（\`chara_card_v2\` 数组），也可以用「导入卡」手动导入。
EOF
  else
    echo "   正文用 $NOTES"
    TMP_NOTES=0
  fi
  RESP="$(curl -sS -X POST "$API/releases" \
    --data-urlencode "access_token=$TOKEN" \
    --data-urlencode "tag_name=$TAG" \
    --data-urlencode "name=风月·本地版 卡库 $TAG" \
    --data-urlencode "body@$NOTES" \
    --data-urlencode "prerelease=false" \
    --data-urlencode "target_commitish=main")"
  # 只删临时文件；仓库里的发行说明（dist/卡库说明-*.md）绝不能被删掉
  [ "${TMP_NOTES:-1}" = "1" ] && rm -f "$NOTES"
  RID="$(printf '%s' "$RESP" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
print(d.get("id","") if isinstance(d,dict) else "")')"
  if [ -z "$RID" ]; then
    echo "   同名发行版可能已存在，改为复用：$TAG"
    RID="$(curl -sS "$API/releases/tags/$TAG" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
print(d.get("id","") if isinstance(d,dict) else "")')"
  fi
  [ -n "$RID" ] || { echo "❌ 建发行版失败（令牌权限？）" >&2; exit 1; }
  echo "   ✅ 发行版 id=$RID"

  echo "── 2/3 上传 $COUNT 个分片（每个约 $(( $(du -sb "$LIB"|cut -f1) / COUNT / 1024 )) KB）"
  ok=0; bad=0
  for f in "${FILES[@]}"; do
    OUT="$(curl -sS -X POST "$API/releases/$RID/attach_files" \
      -F "access_token=$TOKEN" -F "file=@$LIB/$f" 2>&1 | head -c 200)"
    case "$OUT" in
      *'"id"'*|*'"browser_download_url"'*) ok=$((ok+1)); printf '   ✅ %s\n' "$f" ;;
      *) bad=$((bad+1)); printf '   ⚠️  %s → %s\n' "$f" "$(printf '%s' "$OUT" | head -c 120)" ;;
    esac
  done
  echo "   上传完成：成功 $ok / 失败 $bad"
  [ "$bad" = "0" ] || echo "   （有失败分片：先看是不是附件数量上限，必要时改小 --chunk 再重新分片）"
else
  echo "── 1-2/3 跳过上传（SKIP_UPLOAD=1）"
fi

echo "── 3/3 写目录（App 用）"
python3 - "$LIB/index.json" "$ROOT/cards/library-index.json" "$BASE" <<'PY'
import json, sys, os, hashlib
src, dst, base = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(src, encoding='utf-8'))
d['baseUrl'] = base
d['publishedAt'] = __import__('datetime').datetime.now().strftime('%Y-%m-%d')
# 分片字节数与 sha256 以本地文件为准（目录可能是分片之前生成的）
lib = os.path.dirname(src)
for p in d.get('packs', []):
    fp = os.path.join(lib, p['file'])
    if os.path.exists(fp):
        blob = open(fp, 'rb').read()
        p['bytes'] = len(blob)
        p['sha256'] = hashlib.sha256(blob).hexdigest()
    # 绝对地址也写一份：万一以后附件数量超限、要拆成两个发行版或换托管，
    # 直接改每条的 url 就行，App 不用动、也不用重新生成卡
    p['url'] = base + p['file']
json.dump(d, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('   目录：%s（%d 个分片 / %d 张卡 / baseUrl=%s）'
      % (dst, len(d.get('packs', [])), d.get('total', 0), base))
PY
echo
echo "✅ 完成。发行版页面：https://gitee.com/$REPO/releases/tag/$TAG"
echo "   把 apps 里的 LIB_CATALOG_URL 指到（已提交的）目录文件即可："
echo "   https://gitee.com/$REPO/raw/main/cards/library-index.json"
