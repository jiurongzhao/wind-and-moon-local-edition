#!/data/data/com.termux/files/usr/bin/bash
# bench2.sh —— 更贴近真实 App 的测试：测量【模型加载耗时】+【关掉思考模式后的生成速度】
# 用法: ./bench2.sh [线程数]
set -u
ROOT="$HOME/2/fy"
PORT=8091
T="${1:-6}"
M="$ROOT/models/Qwen3-4B-Q4_K_M.gguf"
LOG="$ROOT/bench2.log"

pkill -f 'llama[-]server' 2>/dev/null; sleep 1

echo "模型: $(basename "$M") ($(du -h "$M" | cut -f1))  线程: $T"
T0=$(date +%s)
env -i LD_LIBRARY_PATH="$ROOT/engine/striptest" \
  "$ROOT/engine/striptest/llama-server" -m "$M" \
  -c 4096 --host 127.0.0.1 --port "$PORT" -t "$T" > "$LOG" 2>&1 &
SRV=$!

for i in $(seq 1 240); do
  sleep 1
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q ok; then
    T1=$(date +%s); echo "⏱️  加载耗时: $((T1-T0))s"; break
  fi
  if ! kill -0 "$SRV" 2>/dev/null; then echo "❌ 启动失败"; tail -8 "$LOG"; exit 1; fi
done

BODY=$(python3 -c '
import json
print(json.dumps({
 "messages":[
   {"role":"system","content":"你是一个擅长写氛围感短文的助手。/no_think"},
   {"role":"user","content":"用三句话描写一个雨夜里的便利店。"}],
 "max_tokens":200,"temperature":0.7,
 "chat_template_kwargs":{"enable_thinking":False}},ensure_ascii=False))')

T2=$(date +%s%N)
curl -s --max-time 240 -H 'Content-Type: application/json' -d "$BODY" \
  "http://127.0.0.1:$PORT/v1/chat/completions" > "$ROOT/bench2-resp.json"
T3=$(date +%s%N)

python3 - "$ROOT/bench2-resp.json" "$(( (T3-T2)/1000000 ))" <<'PY'
import sys,json
d=json.load(open(sys.argv[1])); ms=sys.argv[2]
if 'choices' not in d:
    print("❌ 服务返回:", json.dumps(d,ensure_ascii=False)[:400]); raise SystemExit(1)
msg=d['choices'][0]['message']
print("── 生成内容 ──")
print((msg.get('content') or '(空)').strip())
rc=msg.get('reasoning_content')
if rc: print("── reasoning_content(%d 字) ──" % len(rc), rc[:120].replace("\n"," "))
t=d.get('timings',{})
print("── 速度 ──")
print("  预填充: %.1f tok/s (%d)" % (t.get('prompt_per_second',0), t.get('prompt_n',0)))
print("  生成:   %.1f tok/s (%d tokens)" % (t.get('predicted_per_second',0), t.get('predicted_n',0)))
print("  端到端: %sms" % ms)
PY

kill "$SRV" 2>/dev/null
