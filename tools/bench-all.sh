#!/data/data/com.termux/files/usr/bin/bash
# bench-all.sh —— 一张表横向比本地推理线路。
#   JNI：在 Termux 里直接跑（同一份 libllama / 同一颗 CPU），不需要 adb
#   LiteRT-LM：需要 adb 无线调试（调 tools/litertlm-bench.sh）
#
# 用法:
#   ./tools/bench-all.sh              # JNI + LiteRT-LM
#   ./tools/bench-all.sh --jni-only   # 只跑 JNI（掉线时也能出 JNI 数字）
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JNI_ONLY=0
[ "${1:-}" = "--jni-only" ] && JNI_ONLY=1

echo "======== JNI（本进程 / 同一颗 CPU） ========"
MODEL="${JNI_MODEL:-$ROOT/models/qwen2.5-0.5b-instruct-q4_k_m.gguf}"
if [ -f "$MODEL" ] && [ -f "$ROOT/native/libfy_engine.so" ]; then
  mkdir -p "$ROOT/build/jvmtest"
  javac -nowarn -encoding UTF-8 -d "$ROOT/build/jvmtest" \
    "$ROOT/app/java/com/fy/local/NativeEngine.java" "$ROOT/tests/NativeEngineBench.java" 2>/dev/null
  LD_LIBRARY_PATH="$ROOT/native" GGML_BACKEND_PATH="$ROOT/native" \
    java -Djava.library.path="$ROOT/native" -cp "$ROOT/build/jvmtest" NativeEngineBench \
    "$MODEL" "${JNI_CTX:-2048}" "${JNI_THREADS:-4}" "${JNI_MAXTOK:-128}" "${JNI_TUNES:-}"
else
  echo "  跳过：缺 $MODEL 或 native/libfy_engine.so"
fi

[ "$JNI_ONLY" = "1" ] && exit 0

echo
echo "======== LiteRT-LM（真机，需 adb） ========"
"$ROOT/tools/litertlm-bench.sh" "${@:2}"
