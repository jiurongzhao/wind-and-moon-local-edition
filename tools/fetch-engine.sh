#!/data/data/com.termux/files/usr/bin/bash
# fetch-engine.sh —— 从 llama.cpp 官方 release 取 Android arm64 预编译二进制，准备成 native/
#
# 为什么要这个脚本：仓库里不放 27MB 的第三方二进制（体积 + 溯源都不友好），
# 但这个 App 又必须靠它才能跑。所以：
#   * 想直接用现成包的人：用仓库里自带的 native/（就是本脚本产出的东西）
#   * 想自己核实/更新的人：跑这个脚本，从官方 GitHub release 重新拉一份
#
# 用法:
#   ./tools/fetch-engine.sh                # 产出到 ./native/
#   ./tools/fetch-engine.sh /tmp/out       # 产出到指定目录（用于比对）
#   LLAMA_BUILD=b12345 ./tools/fetch-engine.sh    # 换一个版本
#
# 产物（15 个文件）：
#   libfy_llama_server.so                  ← 官方 llama-server 改名而来
#   libllama.so libllama-common.so libllama-server-impl.so libmtmd.so
#   libggml.so libggml-base.so libggml-rpc.so
#   libggml-cpu-android_armv8.0_1.so / armv8.2_1 / armv8.2_2 / armv8.6_1 / armv9.0_1 / armv9.2_1 / armv9.2_2
#   （CPU 后端变体由 llama.cpp 运行时按 CPU 特性自动选，所以都要带上）
set -euo pipefail

VERSION="${LLAMA_BUILD:-b11552}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/native}"
TARBALL="llama-${VERSION}-bin-android-arm64.tar.gz"
URL="https://github.com/ggml-org/llama.cpp/releases/download/${VERSION}/${TARBALL}"

# 国内网络优先走镜像 / 本地包（见 CONTRIBUTING「依赖镜像」）：
#   GITEE_MIRROR=https://gitee.com/<user>/<repo>/releases/download/v1.0.0/native-b11552.tar.gz ./tools/fetch-engine.sh
#   ENGINE_TARBALL=/path/to/native-b11552.tar.gz ./tools/fetch-engine.sh
MIRROR="${GITEE_MIRROR:-}"
LOCAL_TAR="${ENGINE_TARBALL:-}"

LIBS=(
  libllama.so libllama-common.so libllama-server-impl.so libmtmd.so
  libggml.so libggml-base.so libggml-rpc.so
  libggml-cpu-android_armv8.0_1.so
  libggml-cpu-android_armv8.2_1.so
  libggml-cpu-android_armv8.2_2.so
  libggml-cpu-android_armv8.6_1.so
  libggml-cpu-android_armv9.0_1.so
  libggml-cpu-android_armv9.2_1.so
  libggml-cpu-android_armv9.2_2.so
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "$LOCAL_TAR" ]; then
  echo "── 使用本地引擎包：$LOCAL_TAR"
  cp -f "$LOCAL_TAR" "$TMP/pack.tar.gz"
elif [ -n "$MIRROR" ]; then
  echo "── 从镜像下载：$MIRROR"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$TMP/pack.tar.gz" "$MIRROR"
  else
    wget -O "$TMP/pack.tar.gz" "$MIRROR"
  fi
else
  echo "── 下载 llama.cpp ${VERSION}（Android arm64，官方源）"
  echo "   $URL"
  echo "   （国内如果超时：见 CONTRIBUTING「依赖镜像」，或设 GITEE_MIRROR / ENGINE_TARBALL）"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$TMP/pack.tar.gz" "$URL"
  else
    wget -O "$TMP/pack.tar.gz" "$URL"
  fi
fi
echo "   已获取 $(du -h "$TMP/pack.tar.gz" | cut -f1)"

echo "── 解包"
mkdir -p "$TMP/x"
tar xzf "$TMP/pack.tar.gz" -C "$TMP/x"
# 两种包结构都支持：官方 llama-bXXXX/ 目录，或我们自己打的 native/ 目录
if [ -d "$TMP/x/native" ]; then
  SRC="$TMP/x/native"
  PREBUILT=1
else
  SRC="$(find "$TMP/x" -maxdepth 2 -type d -name 'llama-*' | head -1)"
  PREBUILT=0
fi
[ -n "$SRC" ] && [ -d "$SRC" ] || { echo "❌ 解包后找不到可用目录" >&2; exit 1; }

if [ "$PREBUILT" = "1" ]; then
  echo "── 这是已打好的 native 包，直接拷贝"
  mkdir -p "$OUT"
  cp -f "$SRC"/* "$OUT"/
  chmod 755 "$OUT"/*.so
  echo; echo "✅ 引擎就绪：$OUT（$(du -sh "$OUT" | cut -f1)）"
  exit 0
fi

mkdir -p "$OUT"
echo "── 拷贝需要的库与可执行文件 → $OUT"
for f in "${LIBS[@]}"; do
  if [ -f "$SRC/$f" ]; then
    cp -f "$SRC/$f" "$OUT/$f"
  else
    echo "   ⚠️  官方包里没有 $f（版本变了？）" >&2
  fi
done

# llama-server → libfy_llama_server.so：Android 只允许执行 named lib*.so 的 native 库，
# 且必须放在 nativeLibraryDir 里（详见 docs/engine-exec.md）
[ -f "$SRC/llama-server" ] || { echo "❌ 官方包里没有 llama-server" >&2; exit 1; }
cp -f "$SRC/llama-server" "$OUT/libfy_llama_server.so"

echo "── strip（去掉调试符号，276MB → 约 27MB）"
STRIP="$(command -v llvm-strip || command -v strip || true)"
if [ -n "$STRIP" ]; then
  for f in "$OUT"/*.so; do
    "$STRIP" --strip-unneeded "$f" 2>/dev/null || "$STRIP" "$f" 2>/dev/null || true
  done
  echo "   使用 $STRIP"
else
  echo "   ⚠️  没有 strip，产物会偏大（不影响运行）"
fi
chmod 755 "$OUT"/*.so

# 许可证要跟着二进制一起走（MIT 要求保留版权声明）
if [ -f "$SRC/LICENSE" ]; then
  mkdir -p "$ROOT/third_party"
  cp -f "$SRC/LICENSE" "$ROOT/third_party/llama.cpp-LICENSE"
  echo "── 已保存第三方许可证 → third_party/llama.cpp-LICENSE"
fi

echo
echo "✅ 引擎就绪：$OUT"
ls -la "$OUT" | awk 'NR>3 {printf "   %-46s %s\n", $9, $5}'
echo
echo "总大小：$(du -sh "$OUT" | cut -f1)"
echo "下一步：./build.sh（会把它打进 APK）"
