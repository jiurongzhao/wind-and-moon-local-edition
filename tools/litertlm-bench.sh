#!/data/data/com.termux/files/usr/bin/bash
# litertlm-bench.sh —— 同一段 prompt 跑多个 模型×线程×tune 组合，把关键数字打出来，方便横向比。
#
# 用法:
#   ./tools/litertlm-bench.sh                       # 默认：Qwen3-0.6B int8 + Qwen2.5-0.5B .task
#   ./tools/litertlm-bench.sh a.litertlm b.task     # 指定模型
#   THREADS_LIST="4 8" TUNE_LIST="|thinking=off|spec=1"
#
# 环境变量:
#   THREADS_LIST  线程列表，默认 "4"（真机实测线程越多越慢）
#   TUNE_LIST     tune 串列表，用 '|' 分隔，空元素代表默认。默认 "|thinking=off"
# 前置：无线调试在线（tools/adbgo.sh 能连上）。掉线时这一轮跳过并打印原因，不假装成功。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS=("$@")
if [ ${#MODELS[@]} -eq 0 ]; then
  MODELS=("$HOME/tmpwork/c-models/Qwen3-0.6B.litertlm"
          "$HOME/tmpwork/c-models/Qwen2.5-0.5B-Instruct_q8_ekv1280.task")
fi
THREADS_LIST="${THREADS_LIST:-4}"
TUNE_LIST="${TUNE_LIST:-|thinking=off}"

printf '%-38s %-7s %-30s %6s %8s %11s\n' "model" "threads" "tune" "gen" "firstMs" "decodeTps"
for m in "${MODELS[@]}"; do
  [ -f "$m" ] || { echo "跳过（文件不存在）：$m"; continue; }
  for th in $THREADS_LIST; do
    IFS='|' read -r -a TUNES <<< "$TUNE_LIST"
    for tn in "${TUNES[@]}"; do
      OUT=$(MODEL="$m" THREADS="$th" TUNE="$tn" MAXTOK=160 "$ROOT/tools/litertlm-device.sh" 2>&1)
      if ! printf '%s' "$OUT" | grep -q '"decodeTps"'; then
        printf '%-38s %-7s %-30s %6s %8s %11s\n' "$(basename "$m")" "$th" "${tn:-（默认）}" "-" "-" "失败"
        printf '%s\n' "$OUT" | grep -E "没有设备|错误|失败|Exception|NOT_FOUND|SIGSEGV" | head -3 | sed 's/^/      /'
        continue
      fi
      GEN=$(printf '%s\n' "$OUT" | grep -o '"gen":[0-9]*' | tail -1 | cut -d: -f2)
      FIRST=$(printf '%s\n' "$OUT" | grep -o '"firstMs":[-0-9]*' | tail -1 | cut -d: -f2)
      DEC=$(printf '%s\n' "$OUT" | grep -o '"decodeTps":[0-9.]*' | tail -1 | cut -d: -f2)
      printf '%-38s %-7s %-30s %6s %8s %11s\n' "$(basename "$m")" "$th" "${tn:-（默认）}" "${GEN:--}" "${FIRST:--}" "${DEC:--}"
    done
  done
done
