#!/data/data/com.termux/files/usr/bin/bash
# build.sh —— 用 Termux 自带的 clang 把引擎桥编成 native/libfy_engine.so
#
# 不需要 Android NDK：Termux 的 clang 默认 target 就是 aarch64-linux-android24，
# 编出来的 .so 既能被 App 加载，也能被 Termux 里的 openjdk 直接 System.loadLibrary。
#
#   ./jni/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LLAMA_INC="${LLAMA_INC:-$ROOT/engine/snap/llama-b11552/include}"
NATIVE="$ROOT/native"
OUT="$NATIVE/libfy_engine.so"

[ -f "$LLAMA_INC/llama.h" ] || {
  echo "❌ 找不到 llama.h：$LLAMA_INC/llama.h" >&2
  echo "   先跑 ./tools/fetch-deps.sh 把引擎包解出来" >&2
  exit 1
}
[ -f "$NATIVE/libllama.so" ] || { echo "❌ 找不到 $NATIVE/libllama.so" >&2; exit 1; }

# rpath 用 $ORIGIN：App 里这些 .so 都躺在 nativeLibraryDir 同一个目录，
# Termux 里跑测试时另外用 LD_LIBRARY_PATH 顶上。
clang -shared -fPIC -O2 -Wall \
  -o "$OUT" "$ROOT/jni/fy_engine.c" \
  -I"$PREFIX/include" -I"$LLAMA_INC" \
  -L"$NATIVE" -lllama -lggml -lggml-base \
  -Wl,-rpath,'$ORIGIN'

echo "✅ 产出 $OUT（$(stat -c%s "$OUT") 字节）"
llvm-readelf -d "$OUT" 2>/dev/null | grep -E "NEEDED|RUNPATH|RPATH" | sed 's/^/   /'
exit 0
