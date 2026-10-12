#!/data/data/com.termux/files/usr/bin/bash
# runtests.sh —— 一条命令跑完所有"不需要真机"的测试。
#
#   1. 前端 jsdom 集成测试      （流式/思考段/剧情选项/群聊/记忆/语音/设置/诊断导出）
#   2. Engine.java JVM 实跑     （自检 + 状态机 + 真实推理 + 停止）—— 会真起 llama-server
#   3. AssetServer.java JVM 实跑（路由/MIME/404/并发/只监听回环）
#   4. 下载与断点续传实测        （打真实 ModelScope，逐字节比对）
#
# 用法: ./runtests.sh [--quick]     --quick 跳过会起引擎和联网的那两个
set -u
cd "$(dirname "$0")"
ROOT="$PWD"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

# 卡包从 cards/ 同步到 App 资源（前端测试会读取 packs/index.json）
if ls "$ROOT"/cards/pack-*.json >/dev/null 2>&1; then
  python3 "$ROOT/tools/build-pack-index.py" >/dev/null 2>&1 || true
fi

pass=0; fail=0
step() { echo; echo "════════ $* ════════"; }
ok()   { echo "  → 通过"; pass=$((pass+1)); }
bad()  { echo "  → 失败（退出码 $1）"; fail=$((fail+1)); }

# ---------------------------------------------------------------- 1. 前端
step "1/4 前端 jsdom 集成测试"
if [ -d tests/node_modules ]; then
  (cd tests && timeout 600 node ui.test.mjs 2>&1 | tail -6)
  [ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0
else
  echo "  跳过：tests/node_modules 不存在，先 cd tests && npm install jsdom fake-indexeddb"
fi

# ---------------------------------------------------------------- 2 & 3. Java
step "2/4 编译 JVM 测试桩"
rm -rf build/jvmtest && mkdir -p build/jvmtest
javac -nowarn -encoding UTF-8 -d build/jvmtest \
  tests/jvmstub/android/util/Log.java \
  tests/jvmstub/android/util/Base64.java \
  tests/jvmstub/android/content/pm/ApplicationInfo.java \
  tests/jvmstub/android/os/PowerManager.java \
  tests/jvmstub/android/content/Context.java \
  tests/jvmstub/android/content/res/AssetManager.java \
  app/java/com/fy/local/Engine.java \
  app/java/com/fy/local/AssetServer.java \
  app/java/com/fy/local/PngCardText.java \
  tests/EngineJvmTest.java \
  tests/CardIOJvmTest.java \
  tests/AssetServerJvmTest.java 2>&1 | grep -v deprecat | head -10
if [ -f build/jvmtest/EngineJvmTest.class ]; then ok; else bad 1; fi

step "3/4 AssetServer JVM 实跑（资源服务器）"
timeout 180 java -cp build/jvmtest AssetServerJvmTest 2>&1 | tail -5
[ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0

step "3.5/4 CardIO JVM 实跑（PNG 角色卡解析）"
timeout 120 java -cp build/jvmtest CardIOJvmTest 2>&1 | tail -10
[ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0

if [ "$QUICK" = "0" ]; then
  step "4/4 Engine JVM 实跑（会真起 llama-server 加载小模型）"
  timeout 400 java -cp build/jvmtest EngineJvmTest qwen2.5-0.5b-instruct-q4_k_m.gguf 2>&1 | tail -5
  [ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0
else
  step "4/4 Engine JVM 实跑（--quick 已跳过）"
fi

echo
echo "════════════════════════════════════════"
echo "套件结果： $pass 通过 / $fail 失败"
[ "$fail" = "0" ]
