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
step "1/5 前端 jsdom 集成测试"
if [ -d tests/node_modules ]; then
  (cd tests && timeout 600 node ui.test.mjs 2>&1 | tail -6)
  [ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0
else
  echo "  跳过：tests/node_modules 不存在，先 cd tests && npm install jsdom fake-indexeddb"
fi

# ---------------------------------------------------------------- 1.5 模板库
step "1.5/5 创作者工具模板库校验（三份 JSON 的对齐关系）"
python3 "$ROOT/tools/check-creator.py" 2>&1 | tail -12
[ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0

# ---------------------------------------------------------------- 1.6 卡库素材库
step "1.6/5 卡库素材库校验（16 类的字段形状与条数）"
python3 "$ROOT/tools/check-banks.py" 2>&1 | tail -6
[ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0

# ---------------------------------------------------------------- 1.7 大卡库
# cards/library/ 是发布附件、不入库；没生成就跳过，不阻塞
step "1.7/5 大卡库发布闸门（严格：字段 + 文本翻倍线 + topic）"
if ls "$ROOT"/cards/library/*.json >/dev/null 2>&1; then
  python3 "$ROOT/tools/check-cards.py" --strict "$ROOT"/cards/library/*.json 2>&1 | tail -5
  [ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0
  step "1.75/5 卡库目录 ↔ 分片逐字节对齐（count/bytes/sha256/主题不跨片）"
  python3 "$ROOT/tools/check-library.py" 2>&1 | tail -8
  [ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0
else
  echo "  跳过：cards/library/ 还没生成（先跑 python3 tools/gen-cards.py）"
fi

step "1.8/5 大卡库分片用 App 解析器自检（没有 cards/library/ 就跳过）"
(cd "$ROOT/tests" && timeout 600 node library-pack.test.mjs 2>&1 | tail -5)
[ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0

# ---------------------------------------------------------------- 1.8 卡库端到端
# 需要本地 http 镜像（见 tests/library-e2e.test.mjs 头部注释）；镜像没起就自跳过。
# 想连 32000 张一起量： FULL=1 node tests/library-e2e.test.mjs
step "1.8/5 在线卡库端到端（真目录 + 真分片；没起本地镜像就跳过）"
(cd "$ROOT/tests" && timeout 900 node library-e2e.test.mjs 2>&1 | tail -5)
[ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0

# ---------------------------------------------------------------- 2 & 3. Java
step "2/5 编译 JVM 测试桩"
rm -rf build/jvmtest && mkdir -p build/jvmtest
# 源文件自动发现：以前这里是 14 行手写清单，加一个测试桩就得回来改脚本（漏改就是"莫名编译失败"）。
# 路径里没有空格，所以靠 shell 分词展开是有意的。
STUB_SRC=$(find tests/jvmstub -name '*.java' | sort | tr '\n' ' ')
APP_SRC="app/java/com/fy/local/Engine.java app/java/com/fy/local/AssetServer.java app/java/com/fy/local/PngCardText.java app/java/com/fy/local/Providers.java"
TEST_SRC=$(find tests -maxdepth 1 -name '*JvmTest.java' | sort | tr '\n' ' ')
# shellcheck disable=SC2086
javac -nowarn -encoding UTF-8 -d build/jvmtest $STUB_SRC $APP_SRC $TEST_SRC > build/javac.log 2>&1
javac_rc=$?
grep -v deprecat build/javac.log | head -12
# 以前用 "| head -10" 直接把 javac 的退出码冲掉了，只能靠"类文件在不在"猜
if [ "$javac_rc" = "0" ] && [ -f build/jvmtest/EngineJvmTest.class ]; then ok; else bad $javac_rc; fi

step "3/5 AssetServer JVM 实跑（资源服务器）"
timeout 180 java -cp build/jvmtest AssetServerJvmTest 2>&1 | tail -5
[ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0

step "3.5/5 CardIO JVM 实跑（PNG 角色卡解析）"
timeout 120 java -cp build/jvmtest CardIOJvmTest 2>&1 | tail -10
# 先把退出码存下来：原来直接在 bad 的参数里用 PIPESTATUS[0]，
# 但那时的 PIPESTATUS 已经被 if 里的 [ 命令覆盖，报出来的码是错的。
cardio_rc=${PIPESTATUS[0]}
if [ "$cardio_rc" = "0" ]; then ok; else bad "$cardio_rc"; fi

step "3.6/5 Engine 孤儿进程清理 JVM 实跑（真起进程、真杀进程）"
timeout 120 java -cp build/jvmtest EngineReapJvmTest 2>&1 | tail -14
reap_rc=${PIPESTATUS[0]}
if [ "$reap_rc" = "0" ]; then ok; else bad "$reap_rc"; fi

step "4/5 外部模型代理 JVM 实跑（假上游 + SSE 透传）"
timeout 180 java -cp build/jvmtest ProxyJvmTest > build/proxy-test.log 2>&1
rc=$?
tail -16 build/proxy-test.log
# 这里以前还多一行 [ "PIPESTATUS[0]" = "0" ] && ok || bad 0，导致代理测试被计两次；
# 而且失败时那行的 PIPESTATUS 已变成上面 if 的退出码，会出现"失败 +1、通过 +1"。
if [ "$rc" = "0" ]; then ok; else bad "$rc"; fi

if [ "$QUICK" = "0" ]; then
  step "5/5 Engine JVM 实跑（会真起 llama-server 加载小模型）"
  timeout 400 java -cp build/jvmtest EngineJvmTest qwen2.5-0.5b-instruct-q4_k_m.gguf 2>&1 | tail -5
  [ "${PIPESTATUS[0]:-0}" = "0" ] && ok || bad 0
else
  step "5/5 Engine JVM 实跑（--quick 已跳过）"
fi

echo
echo "════════════════════════════════════════"
echo "套件结果： $pass 通过 / $fail 失败"
[ "$fail" = "0" ]
