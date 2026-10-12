#!/data/data/com.termux/files/usr/bin/bash
# bench.sh —— 在本机（Termux 里）实测 llama-server 的生成速度
# 用法: ./bench.sh cpu|gpu [模型路径] [prompt]
set -u
ROOT="$HOME/2/fy"
MODE="${1:-cpu}"
MODEL="${2:-$ROOT/models/qwen2.5-0.5b-instruct-q4_k_m.gguf}"
PROMPT="${3:-用两句话描述一个雨夜里的便利店。}"
PORT=8089
LOG="$ROOT/bench-$MODE.log"

case "$MODE" in
  cpu) BIN="$ROOT/engine/striptest/llama-server"; LIB="$ROOT/engine/striptest"; EXTRA="-t 6";;
  gpu) BIN="$ROOT/engine/snapstrip/bin/llama-server"; LIB="$ROOT/engine/snapstrip/lib"; EXTRA="--device GPUOpenCL -ngl 99 -t 6";;
  *) echo "用法: $0 cpu|gpu [模型] [prompt]"; exit 1;;
esac

echo "模式=$MODE  模型=$(basename "$MODEL")  大小=$(du -h "$MODEL" | cut -f1)"
pkill -f "llama-server.*--port $PORT" 2>/dev/null
sleep 1

env -i LD_LIBRARY_PATH="$LIB:/vendor/lib64" "$BIN" \
  -m "$MODEL" -c 2048 --host 127.0.0.1 --port "$PORT" $EXTRA \
  > "$LOG" 2>&1 &
SRV=$!

for i in $(seq 1 60); do
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then break; fi
  if ! kill -0 "$SRV" 2>/dev/null; then echo "❌ 服务启动失败，日志尾部："; tail -15 "$LOG"; exit 1; fi
  sleep 1
done

echo "--- 服务已就绪，发送请求 ---"
BODY=$(python3 -c "
import json,sys
print(json.dumps({'messages':[{'role':'user','content':sys.argv[1]}],'max_tokens':80,'temperature':0.8},ensure_ascii=False))" "$PROMPT")

RESP=$(curl -s --max-time 180 -H 'Content-Type: application/json' -d "$BODY" \
  "http://127.0.0.1:$PORT/v1/chat/completions")

python3 - "$RESP" <<'PY'
import sys,json
raw=sys.argv[1]
try: d=json.loads(raw)
except Exception:
    print("❌ 响应解析失败：", raw[:500]); raise SystemExit(1)
if 'choices' not in d:
    print("❌ 服务返回错误：", json.dumps(d,ensure_ascii=False)[:500]); raise SystemExit(1)
print("── 生成内容 ──")
print(d['choices'][0]['message']['content'].strip())
t=d.get('timings',{})
print("── 速度 ──")
print("  预填充: %.1f tok/s (%d tokens)" % (t.get('prompt_per_second',0), t.get('prompt_n',0)))
print("  生成:   %.1f tok/s (%d tokens)" % (t.get('predicted_per_second',0), t.get('predicted_n',0)))
PY

kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null
