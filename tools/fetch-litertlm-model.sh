#!/data/data/com.termux/files/usr/bin/bash
# fetch-litertlm-model.sh —— 下 LiteRT-LM 单栈要用的 .litertlm 模型（走 ModelScope 镜像）。
#
# 默认 Qwen3-0.6B（最短路径验证链路），--4b 换成 Qwen3-4B 的 int4（真机性能实测用）。
#
# 用法:
#   ./tools/fetch-litertlm-model.sh              # 0.6B → ~/tmpwork/c-models
#   ./tools/fetch-litertlm-model.sh --4b         # 4B mixed int4
#   ./tools/fetch-litertlm-model.sh /sdcard/Download
set -euo pipefail

OUT_DIR=""
WHICH="0.6b"
for a in "$@"; do
  case "$a" in
    --4b) WHICH="4b" ;;
    --int4) WHICH="int4" ;;
    --dyn4) WHICH="dyn4" ;;
    *) OUT_DIR="$a" ;;
  esac
done
OUT_DIR="${OUT_DIR:-$HOME/tmpwork/c-models}"

if [ "$WHICH" = "4b" ]; then
  REPO="litert-community/Qwen3-4B"
  NAME="qwen3_4b_mixed_int4.litertlm"
  EXPECT=2659053760
  SHA="569fe029f51e55b6377f98ebd7f6d26431bc73e1d632034f5389f2fd720da701"
elif [ "$WHICH" = "int4" ]; then
  # 0.6B 的 4 比特权重：CPU 上应该比 int8 快，拿来回答"切 LiteRT-LM 会不会更慢"
  REPO="litert-community/Qwen3-0.6B"
  NAME="qwen3_0_6b_mixed_int4.litertlm"
  EXPECT=497516544
  SHA="7900eb4e7362d88c58782c6f9999bb7a129e03544aa98b8f338ea0cc5d8c22c1"
elif [ "$WHICH" = "dyn4" ]; then
  # 更小(344MB)的动态 int4 变体，兼容性未知，当备选
  REPO="litert-community/Qwen3-0.6B"
  NAME="Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm"
  EXPECT=344671744
  SHA="03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856"
else
  REPO="litert-community/Qwen3-0.6B"
  NAME="Qwen3-0.6B.litertlm"
  EXPECT=614236160
  SHA="555579ff2f4fd13379abe69c1c3ab5200f7338bc92471557f1d6614a6e5ab0b4"
fi
URL="https://www.modelscope.cn/models/$REPO/resolve/master/$NAME"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

verify() {
  [ -s "$NAME" ] || return 1
  [ "$(stat -c%s "$NAME")" = "$EXPECT" ] || return 1
  [ "$(sha256sum "$NAME" | cut -d' ' -f1)" = "$SHA" ] || return 1
}
if verify; then echo "✅ 已存在且校验通过：$OUT_DIR/$NAME"; exit 0; fi

echo "下载 $NAME（约 $((EXPECT/1048576))MiB）→ $OUT_DIR"
if command -v aria2c >/dev/null 2>&1; then
  aria2c -x16 -s16 -k1M -c --file-allocation=none --max-tries=0 --retry-wait=2 -o "$NAME" "$URL"
else
  echo "（没有 aria2c，用 curl 断点续传）"
  for _ in $(seq 1 2000); do
    have=$(stat -c%s "$NAME" 2>/dev/null || echo 0)
    [ "$have" -ge "$EXPECT" ] && break
    curl -sL --retry 0 --max-time 1800 -r "$have-" -o - "$URL" >> "$NAME" || true
    sleep 2
  done
fi

if verify; then
  echo "✅ 校验通过（size=$EXPECT, sha256=$SHA）"
else
  echo "❌ 校验失败：$(stat -c%s "$NAME" 2>/dev/null || echo 0) 字节" >&2
  exit 1
fi
