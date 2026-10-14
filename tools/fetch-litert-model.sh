#!/data/data/com.termux/files/usr/bin/bash
# fetch-litert-model.sh —— 下 C 路线 PoC 要用的 LiteRT `.task` 模型。
#
# 为什么走 ModelScope：HuggingFace 在国内这条线实测被限到 ~9KB/s，
# 同一个文件 ModelScope 有镜像、稳定 1.4~1.6MB/s（aria2 16 连接）。
#
# 用法:
#   ./tools/fetch-litert-model.sh              # 下到 ~/tmpwork/c-models
#   ./tools/fetch-litert-model.sh /sdcard/Download
set -euo pipefail

OUT_DIR="${1:-$HOME/tmpwork/c-models}"
NAME="Qwen2.5-0.5B-Instruct_multi-prefill-seq_q8_ekv1280.task"
EXPECT=546660344
SHA="e608953f169aeb1bd7b9155fec2559825e08453fc209b84eda3a781ed0452fd2"
URL="https://www.modelscope.cn/models/litert-community/Qwen2.5-0.5B-Instruct/resolve/master/$NAME"

mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

verify() {
  [ -s "$NAME" ] || return 1
  [ "$(stat -c%s "$NAME")" = "$EXPECT" ] || return 1
  [ "$(sha256sum "$NAME" | cut -d' ' -f1)" = "$SHA" ] || return 1
}
if verify; then echo "✅ 已存在且校验通过：$OUT_DIR/$NAME"; exit 0; fi

echo "下载 $NAME（约 521MiB）→ $OUT_DIR"
if command -v aria2c >/dev/null 2>&1; then
  aria2c -x16 -s16 -k1M -c --file-allocation=none --max-tries=0 --retry-wait=2 -o "$NAME" "$URL"
else
  echo "（没有 aria2c，用 curl 断点续传；aria2 会快很多）"
  for _ in $(seq 1 500); do
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
