#!/data/data/com.termux/files/usr/bin/bash
# publish-cards.sh —— 把 cards/library/ 里的大卡库作为发行版附件发出去，并生成 App 用的目录。
#
# 为什么不在 APK 里：每分类 1000 角色卡 + 1000 剧情卡 = 32000 张，约 158MB 原始 JSON，
# 塞进 APK 会让安装包从 13MB 涨到几十 MB，而且大多数人只玩几个分类。
#
# 令牌：GITEE_TOKEN 环境变量，或 ~/.gitee_token（**不会**打印令牌）。
#
# 用法:
#   ./tools/publish-cards.sh cards-v2          # 建发行版 + 传全部分片 + 生成目录
#   ./tools/publish-cards.sh cards-v2 --dry    # 只清点要传什么，不联网
#   SKIP_UPLOAD=1 ./tools/publish-cards.sh cards-v2   # 只生成目录（用于本地联调）
#
#   # 附件数撞上 Gitee 上限时：按 64 个一组拆成 cards-v2 / cards-v2-2 / cards-v2-3…
#   # 每片的绝对 url 会写到它实际所在的发行版（App 优先读 url，不用改代码）
#   ATTACH_PER_RELEASE=64 ./tools/publish-cards.sh cards-v2
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/cards/library"
REPO="${GITEE_REPO:-zhao-jiurong/wind-and-moon-local-edition}"
API="https://gitee.com/api/v5/repos/$REPO"
TAG="${1:-cards-v1}"
DRY=0
[ "${2:-}" = "--dry" ] && DRY=1

[ -d "$LIB" ] || { echo "❌ 没有 $LIB —— 先跑 python3 tools/gen-cards.py" >&2; exit 1; }

# ---- 0) 发布闸门：卡本身 + 目录与分片的对齐，任何一道不过就不发 ----
echo "── 0/3 发布闸门（严格字段 / 文本翻倍线 / 目录逐字节对齐）"
if ! python3 "$ROOT/tools/check-cards.py" --strict "$LIB"/*.json 2>&1 | tail -3; then
  echo "❌ 严格字段闸门没过，先修生成器再发" >&2; exit 1
fi
python3 "$ROOT/tools/check-cards.py" --strict "$LIB"/*.json >/dev/null 2>&1 \
  || { echo "❌ 严格字段闸门没过（重跑上面那条看详情）" >&2; exit 1; }
python3 "$ROOT/tools/check-library.py" "$LIB" 2>&1 | tail -4
python3 "$ROOT/tools/check-library.py" "$LIB" >/dev/null 2>&1 \
  || { echo "❌ 目录与分片没对齐，先修生成器再发" >&2; exit 1; }

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

# ---- 1) 建发行版（已存在就复用；需要时可以拆成多个） ----
RID=""
TMPMAP=""
if [ "${SKIP_UPLOAD:-0}" != "1" ]; then
  TOKEN="${GITEE_TOKEN:-}"
  if [ -z "$TOKEN" ] && [ -f "$HOME/.gitee_token" ]; then
    TOKEN="$(tr -d ' \t\r\n' < "$HOME/.gitee_token")"
  fi
  [ -n "$TOKEN" ] || { echo "❌ 没有令牌（GITEE_TOKEN 或 ~/.gitee_token）" >&2; exit 1; }

  mkrelease() {   # mkrelease <tag> → 回显 release id（同名就复用）
    # 注意：`local t="$1" notes="…$t…"` 在 set -u 下会报 t: unbound variable
    # （同一个 local 里后面的展开看不到前面的赋值），所以拆成两行。
    local t="$1" resp rid tmp=0
    local notes="$ROOT/dist/卡库说明-$t.md"
    # 直接给 id：Gitee 被限流时连读接口都 403，这时只能靠外部把 id 传进来续传
    if [ -n "${CARDS_RELEASE_ID:-}" ] && [ "$t" = "$TAG" ]; then
      printf '%s' "$CARDS_RELEASE_ID"; return 0
    fi
    if [ ! -f "$notes" ]; then
      notes="$(mktemp)"; tmp=1
      cat > "$notes" <<EOF
# 风月·本地版 · 可下载卡库 $t

每分类 **1000 张角色卡 + 1000 张剧情卡**（16 类，共 32000 张），按主题切成约 250 张一片
（共 128 片 / 768 个主题），全部由本项目的叙事母题素材库组合生成，**CC0-1.0**。

- 只借鉴**结构与母题**，不包含任何第三方作品正文、角色名或台词；
- 目录里每一片都带主题与关键词，App 里**搜关键词就能只下某一片**，不用整类下完；
- 各分片是标准 \`fy_pack_v1\` 卡包（\`chara_card_v2\` 数组），也可以用「导入卡」手动导入。
EOF
    fi
    resp="$(curl -sS -X POST "$API/releases" \
      --data-urlencode "access_token=$TOKEN" \
      --data-urlencode "tag_name=$t" \
      --data-urlencode "name=风月·本地版 卡库 $t" \
      --data-urlencode "body@$notes" \
      --data-urlencode "prerelease=false" \
      --data-urlencode "target_commitish=main")"
    # 只删临时文件；仓库里的发行说明（dist/卡库说明-*.md）绝不能被删掉
    [ "$tmp" = "1" ] && rm -f "$notes"
    rid="$(printf '%s' "$resp" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
print(d.get("id","") if isinstance(d,dict) else "")')"
    if [ -z "$rid" ]; then
      echo "   同名发行版已存在（或建发行版被限流），尝试读回：$t" >&2
      # 限流时读接口也会 403，退避重试几次
      for _try in 1 2 3 4; do
        rid="$(curl -sS "$API/releases/tags/$t" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
print(d.get("id","") if isinstance(d,dict) else "")')"
        [ -n "$rid" ] && break
        sleep $((_try * 15))
      done
    fi
    [ -n "$rid" ] || return 1
    printf '%s' "$rid"
  }

  PER="${ATTACH_PER_RELEASE:-0}"
  TMPMAP="$(mktemp)"
  echo "── 1/3 准备发行版（分组大小：$([ "$PER" -gt 0 ] 2>/dev/null && echo "$PER" || echo 全部)）"
  gidx=0; gi=0; cur_tag=""; cur_rid=""
  for f in "${FILES[@]}"; do
    if [ -z "$cur_rid" ] || { [ "$PER" -gt 0 ] 2>/dev/null && [ "$gi" -ge "$PER" ]; }; then
      gidx=$((gidx+1)); gi=0
      if [ "$gidx" = "1" ]; then cur_tag="$TAG"; else cur_tag="$TAG-$gidx"; fi
      cur_rid="$(mkrelease "$cur_tag")" || { echo "❌ 建发行版失败（令牌权限？）" >&2; exit 1; }
      echo "   ✅ $cur_tag（id=$cur_rid）"
      [ "$gidx" = "1" ] && RID="$cur_rid"
    fi
    printf '%s\t%s\n' "$f" "$cur_tag" >> "$TMPMAP"
    gi=$((gi+1))
  done

  echo "── 2/3 上传 $COUNT 个分片（每个约 $(( $(du -sb "$LIB"|cut -f1) / COUNT / 1024 )) KB）"
  # 可续传：先读一遍各发行版已有的附件名，已经传上去的直接跳过。
  # （128 个附件传到一半断了是常事，重跑一遍不能变成"再传一份重复的"。）
  release_id() {
    # 限流时连读接口都 403，此时允许外部把 id 直接传进来
    if [ -n "${CARDS_RELEASE_ID:-}" ] && [ "$1" = "$TAG" ]; then
      printf '%s' "$CARDS_RELEASE_ID"; return 0
    fi
    curl -sS --max-time 30 "$API/releases/tags/$1" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
print(d.get("id","") if isinstance(d,dict) else "")'
  }
  # 回显附件名；读不到（限流/网络）返回非 0 —— 绝不把"读不到"当成"一个都没传"，
  # 否则会整批重传一遍，发行版里就会出现重名附件。
  fetch_names() {
    local code out
    out="$(mktemp)"
    code="$(curl -sS --max-time 60 -o "$out" -w '%{http_code}' "$API/releases/$(release_id "$1")")"
    if [ "$code" != "200" ]; then rm -f "$out"; return 1; fi
    python3 - "$out" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    raise SystemExit(1)
for a in (d.get("assets") or []):
    n = a.get("name") or ""
    if n:
        print(n)
PY
    local rc=$?
    rm -f "$out"
    return $rc
  }
  ok=0; bad=0; skip=0
  declare -A NAMES_CACHE=()
  declare -A RID_CACHE=()
  # Gitee 的 attach_files 有明显限流：连着传几十个就返回 405，再传一阵子整个 API 会
  # 403 Rate Limit Exceeded。所以默认每个之间隔 4 秒，撞上 405/429 指数退避重试；
  # 读接口都读不到时直接停下来（本轮失败），交给外层循环过一阵子续传。
  DELAY="${UPLOAD_DELAY:-4}"
  while IFS=$'\t' read -r f gtag; do
    if [ -z "${RID_CACHE[$gtag]+x}" ]; then RID_CACHE[$gtag]="$(release_id "$gtag")"; fi
    grid="${RID_CACHE[$gtag]}"
    if [ -z "${NAMES_CACHE[$gtag]+x}" ]; then
      names="$(fetch_names "$gtag")" || {
        echo "   ⚠️ 读不到 $gtag 的附件列表（多半是限流），本轮先停，稍后续传"
        bad=$((bad+1)); break
      }
      NAMES_CACHE[$gtag]="$names"
    fi
    if printf '%s\n' "${NAMES_CACHE[$gtag]}" | grep -qxF "$f"; then
      skip=$((skip+1)); printf '   ⏭  %s（已在上，跳过）\n' "$f"; continue
    fi
    attempt=0
    while :; do
      attempt=$((attempt+1))
      OUT="$(curl -sS --max-time 600 -X POST "$API/releases/$grid/attach_files" \
        -F "access_token=$TOKEN" -F "file=@$LIB/$f" 2>&1 | head -c 300)"
      case "$OUT" in
        *'"id"'*|*'"browser_download_url"'*)
          ok=$((ok+1)); printf '   ✅ %s → %s\n' "$f" "$gtag"
          NAMES_CACHE[$gtag]="${NAMES_CACHE[$gtag]}"$'\n'"$f"
          break ;;
        *)
          if printf '%s' "$OUT" | grep -qE '405|429|Too Many|rate'; then
            wait_s=$((attempt * 30))
            if [ "$attempt" -ge 5 ]; then
              bad=$((bad+1)); printf '   ⚠️ %s → 限流重试 %d 次仍失败\n' "$f" "$attempt"; break
            fi
            printf '   …限流（%s），等 %ds 重试 %s\n' "$(printf '%s' "$OUT" | head -c 40)" "$wait_s" "$f"
            sleep "$wait_s"
            continue
          fi
          bad=$((bad+1)); printf '   ⚠️ %s → %s\n' "$f" "$(printf '%s' "$OUT" | head -c 160)"
          break ;;
      esac
    done
    sleep "$DELAY"
  done < "$TMPMAP"
  echo "   上传完成：新传 $ok / 跳过 $skip / 失败 $bad"
  UPLOAD_BAD=$bad
  if [ "$bad" != "0" ]; then
    echo "   ⚠️ 有失败分片：直接重跑同一条命令即可续传（已传的会自动跳过，限流会自己退避）；"
    echo "      若报的是单发行版附件数量上限，用 ATTACH_PER_RELEASE=64 重跑，会拆成多个发行版。"
  fi
else
  echo "── 1-2/3 跳过上传（SKIP_UPLOAD=1）"
fi

echo "── 3/3 写目录（App 用）"
python3 - "$LIB/index.json" "$ROOT/cards/library-index.json" "$BASE" "$REPO" "${TMPMAP:-}" <<'PY'
import json, sys, os, hashlib
src, dst, base, repo, mapfile = sys.argv[1:6]
d = json.load(open(src, encoding='utf-8'))
# 分片 → 它实际所在的发行版（拆分上传时每片 url 指到自己那个发行版）
tag_of = {}
if mapfile and os.path.exists(mapfile):
    for line in open(mapfile, encoding='utf-8'):
        if '\t' in line:
            f, t = line.rstrip('\n').split('\t', 1)
            tag_of[f] = t
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
    # 绝对地址也写一份：拆成多个发行版或换托管时只改每条 url，
    # App 不用动、也不用重新生成卡（libFileUrl 优先用 url）
    t = tag_of.get(p['file'], base.rstrip('/').rsplit('/', 1)[-1])
    p['url'] = 'https://gitee.com/%s/releases/download/%s/%s' % (repo, t, p['file'])
json.dump(d, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('   目录：%s（%d 个分片 / %d 张卡 / baseUrl=%s）'
      % (dst, len(d.get('packs', [])), d.get('total', 0), base))
PY
[ -n "${TMPMAP:-}" ] && rm -f "$TMPMAP"
echo
echo "✅ 完成。发行版页面：https://gitee.com/$REPO/releases/tag/$TAG"
echo "   把 apps 里的 LIB_CATALOG_URL 指到（已提交的）目录文件即可："
echo "   https://gitee.com/$REPO/raw/main/cards/library-index.json"
# 有分片没传上就以非 0 退出，外层重试循环据此决定要不要再跑一轮
[ "${UPLOAD_BAD:-0}" = "0" ] || exit 1
