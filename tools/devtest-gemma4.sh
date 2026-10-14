#!/data/data/com.termux/files/usr/bin/bash
set -u
PKG=com.fy.local
DEV="${DEV:-$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')}"
ADB="adb -s $DEV"
CFG=$(python3 - <<'PY'
import json, base64
SYS={"role":"system","content":"你扮演林夏，老城区旧书店的店主，说话轻、慢，句子短。"}
USR={"role":"user","content":"给我推荐一本书吧，再讲讲你为什么会想起它。"}
msgs=json.dumps([SYS,USR],ensure_ascii=False)
cfgs=[{"id":"litertlm","model":"gemma-4-E2B-it.litertlm","tune":tune,"threads":4,"maxTokens":48,"messages":msgs}
      for tune in ("", "spec=off")]
print(base64.b64encode(json.dumps(cfgs,ensure_ascii=False).encode()).decode())
PY
)
$ADB shell 'run-as $PKG rm -f files/devtest/bench.jsonl' >/dev/null 2>&1
$ADB shell am broadcast -a com.fy.local.DEVTEST --es cmd bench --es configsB64 "$CFG" >/dev/null 2>&1
for i in $(seq 1 600); do
  OUT="$($ADB shell "run-as $PKG cat files/devtest/bench.jsonl 2>/dev/null" | tr -d '\r')"
  echo "$OUT" | grep -q '"done":true' && break
  sleep 2
done
echo '--- bench.jsonl ---'
$ADB shell "run-as $PKG cat files/devtest/bench.jsonl 2>/dev/null"
echo '--- capability ---'
$ADB logcat -d -t 1200 2>/dev/null | grep -E '模型能力' | tail -2
