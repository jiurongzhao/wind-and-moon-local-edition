#!/data/data/com.termux/files/usr/bin/bash
# devtest-bench2.sh —— 一次广播跑完整套基准（绕开 HyperOS 逐条广播被 Greezer 拒发的问题）。
# 前置：debug 包已装、App 进程活着（打开过一次）、无线调试已连。
set -u
PKG=com.fy.local
DEV="${DEV:-$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')}"
[ -n "$DEV" ] || { echo "没有设备" >&2; exit 1; }
ADB="adb -s $DEV"

CFG=$(python3 - <<'PY'
import json, base64
SYS = {"role":"system","content":"你扮演林夏，深夜书店的店员，说话短，不要总结。\n/no_think"}
USR = {"role":"user","content":"给我推荐一本书，再讲讲你为什么会想起它。"}
msgs = json.dumps([SYS, USR], ensure_ascii=False)
cfgs = []
for m in ["Qwen3-0.6B.litertlm", "qwen3_0_6b_mixed_int4.litertlm", "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm"]:
    for th in (4, 6):
        cfgs.append({"id":"litertlm","model":m,"tune":"thinking=off","threads":th,"maxTokens":160,"messages":msgs})
for tune in ("", "mp_session=1"):
    cfgs.append({"id":"mediapipe","model":"Qwen2.5-0.5B-Instruct_q8_ekv1280.task","tune":tune,"threads":4,"maxTokens":160,"messages":msgs})
for tune in ("", "lookup=3"):
    cfgs.append({"id":"jni","model":"qwen2.5-0.5b-instruct-q4_k_m.gguf","tune":tune,"threads":4,"maxTokens":160,"messages":msgs})
print(base64.b64encode(json.dumps(cfgs, ensure_ascii=False).encode()).decode())
PY
)

$ADB shell 'run-as $PKG rm -f files/devtest/bench.jsonl' >/dev/null 2>&1
echo "发送一次 bench 广播（$(echo -n "$CFG" | wc -c) 字节配置）…"
$ADB shell am broadcast -a com.fy.local.DEVTEST --es cmd bench --es configsB64 "$CFG" 2>&1 | tail -1

echo "等待结果（最多 20 分钟）…"
DONE=0
for i in $(seq 1 600); do
  OUT="$($ADB shell "run-as $PKG cat files/devtest/bench.jsonl 2>/dev/null" | tr -d '\r')"
  echo "$OUT" | grep -q '"done":true' && { DONE=1; break; }
  sleep 2
done
[ "$DONE" = "1" ] || echo "（超时：只拿到部分结果）"

RAW="$($ADB shell "run-as $PKG cat files/devtest/bench.jsonl 2>/dev/null" | tr -d '\r')"
printf '%s' "$RAW" | python3 -c '
import sys, json
print("%-9s %-40s %-16s %5s %8s %11s %8s" % ("route","model","tune","gen","firstMs","decodeTps","loadMs"))
for ln in sys.stdin:
    ln=ln.strip()
    if not ln.startswith("{"): continue
    try: d=json.loads(ln)
    except Exception: continue
    if d.get("done"): print("（全部完成）"); continue
    if d.get("error"): print("  %-40s ERROR %s" % (d.get("model","?"), d["error"][:60])); continue
    lr = d.get("load") or {}; cr = d.get("chat") or {}; st = cr.get("stats") or {}
    dec = st.get("decodeTps"); dec = round(float(dec),2) if isinstance(dec,(int,float)) else "-"
    print("%-9s %-40s %-16s %5s %8s %11s %8s" % (
        d.get("id",""), (d.get("model","") or "")[:40], (d.get("tune","") or "（默认）")[:16],
        cr.get("stats",{}).get("gen","-") if cr else "-",
        st.get("firstMs","-"), dec, lr.get("loadMs","-") if lr else "-"))
'
