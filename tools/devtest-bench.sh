#!/data/data/com.termux/files/usr/bin/bash
# devtest-bench.sh —— 用无头广播入口（tools/devtest.sh）跑三条线路的横向基准，不抢屏幕。
#
# 前置:
#   1) debug 包已装；
#   2) 手机「无线调试」开着、adb 已连（./tools/adbgo.sh）；
#   3) 手动打开过一次「风月·本地版」（让进程与广播接收器活着，之后可以用别的 App）。
#
# 用法: ./tools/devtest-bench.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DT="$ROOT/tools/devtest.sh"
# 注意：无头通道绕过前端 applyNoThink，Qwen3 的 /no_think 得自己带上，否则会白吐一段思考。
SYSH='{"role":"system","content":"你扮演林夏，深夜书店的店员，说话短，不要总结。\n/no_think"}'
USRH='{"role":"user","content":"给我推荐一本书，再讲讲你为什么会想起它。"}'
MSGS="[$SYSH,$USRH]"

fld() { printf '%s' "$1" | python3 -c "import sys,json
try:
  d=json.load(sys.stdin); print(d.get('$2',''))
except Exception: print('')" 2>/dev/null; }

printf '%-9s %-44s %-20s %5s %8s %10s %9s\n' route model tune gen firstMs decodeTps loadMs
run() {  # run <route> <model> <tune> <threads>
  local route="$1" model="$2" tune="$3" th="$4"
  local L C gen first dec load state
  L="$("$DT" load "$route" "$model" "$tune" "$th" 2>/dev/null)"
  state="$(fld "$L" state)"; load="$(fld "$L" loadMs)"
  if [ "$state" != "ready" ]; then
    printf '%-9s %-44s %-20s %5s %8s %10s %9s\n' "$route" "$model" "${tune:-（默认）}" - - "失败:$state" "$load"
    return
  fi
  C="$("$DT" chat "$route" 160 2>/dev/null)"
  gen="$(fld "$C" gen)"; dec="$(printf '%s' "$C" | python3 -c "import sys,json
try:
  s=json.load(sys.stdin).get('stats') or {}
  print(round(float(s.get('decodeTps',-1)),2))
except Exception: print('')" 2>/dev/null)"
  first="$(printf '%s' "$C" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('stats',{}).get('firstMs',''))
except Exception: print('')" 2>/dev/null)"
  printf '%-9s %-44s %-20s %5s %8s %10s %9s\n' "$route" "$model" "${tune:-（默认）}" "${gen:--}" "${first:--}" "${dec:--}" "${load:--}"
}

echo "== LiteRT-LM（.litertlm）=="
for m in Qwen3-0.6B.litertlm qwen3_0_6b_mixed_int4.litertlm Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm; do
  for th in 4 6; do run litertlm "$m" "thinking=off" "$th"; done
done
echo
echo "== MediaPipe（.task，跨轮 KV 开关对比）=="
run mediapipe Qwen2.5-0.5B-Instruct_q8_ekv1280.task "" 4
run mediapipe Qwen2.5-0.5B-Instruct_q8_ekv1280.task "mp_session=1" 4
echo
echo "== JNI（GGUF，自投机开关对比）=="
run jni qwen2.5-0.5b-instruct-q4_k_m.gguf "" 4
run jni qwen2.5-0.5b-instruct-q4_k_m.gguf "lookup=3" 4
