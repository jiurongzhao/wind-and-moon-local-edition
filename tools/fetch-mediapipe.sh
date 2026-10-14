#!/data/data/com.termux/files/usr/bin/bash
# fetch-mediapipe.sh —— 拉取 MediaPipe LLM Inference（C 路线 PoC）所需的 jar 与 arm64 .so。
#
# 为什么不把 30MB 二进制塞进 git：和 native/（llama.cpp）一个道理，
# 二进制走脚本按需下载，仓库里只留这个脚本 + 说明。
#
# 产出（third_party/mediapipe/，已被 .gitignore 忽略）：
#   classes.jar                       MediaPipe tasks-genai Java API（无自带依赖）
#   guava-android.jar / failureaccess.jar   ListenableFuture（generateResponseAsync 的返回类型）
#   protobuf-javalite.jar             jni/proto 生成的类需要
#   libllm_inference_engine_jni.so    arm64 运行时（26.6MB）
#
# 用法: ./tools/fetch-mediapipe.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/third_party/mediapipe"
AAR_VER="0.10.35"
# dl.google.com 在小网络下会 TLS 断流，优先走国内镜像
MIRRORS=(
  "https://maven.aliyun.com/repository/google"
  "https://mirrors.cloud.tencent.com/nexus/repository/maven-public"
  "https://dl.google.com/dl/android/maven2"
)
CENTRAL=(
  "https://maven.aliyun.com/repository/central"
  "https://repo1.maven.org/maven2"
)

mkdir -p "$DIR"
TMP="$DIR/.tmp"
rm -rf "$TMP"; mkdir -p "$TMP"

fetch_first() {   # fetch_first <输出> <相对路径...>
  local out="$1"; shift
  for base in "$@"; do
    if curl -sL --retry 5 --retry-all-errors --max-time 300 -o "$out" "$base"; then
      [ -s "$out" ] && return 0
    fi
  done
  echo "❌ 下载失败: $out" >&2
  return 1
}

echo "[1/3] MediaPipe tasks-genai AAR ($AAR_VER)"
fetch_first "$TMP/genai.aar" "${MIRRORS[@]/%//com/google/mediapipe/tasks-genai/$AAR_VER/tasks-genai-$AAR_VER.aar}"
unzip -o -q "$TMP/genai.aar" classes.jar "jni/arm64-v8a/libllm_inference_engine_jni.so" -d "$TMP"
cp "$TMP/classes.jar" "$DIR/classes.jar"
cp "$TMP/jni/arm64-v8a/libllm_inference_engine_jni.so" "$DIR/libllm_inference_engine_jni.so"

echo "[2/3] 依赖：guava-android / failureaccess / protobuf-javalite"
fetch_first "$DIR/guava-android.jar"        "${CENTRAL[@]/%//com/google/guava/guava/33.1.0-android/guava-33.1.0-android.jar}"
fetch_first "$DIR/failureaccess.jar"        "${CENTRAL[@]/%//com/google/guava/failureaccess/1.0.2/failureaccess-1.0.2.jar}"
fetch_first "$DIR/protobuf-javalite.jar"    "${CENTRAL[@]/%//com/google/protobuf/protobuf-javalite/3.25.3/protobuf-javalite-3.25.3.jar}"

rm -rf "$TMP"
echo "[3/3] 校验"
for f in classes.jar guava-android.jar failureaccess.jar protobuf-javalite.jar; do
  [ -s "$DIR/$f" ] || { echo "❌ 缺 $f" >&2; exit 1; }
done
[ -s "$DIR/libllm_inference_engine_jni.so" ] || { echo "❌ 缺 arm64 .so" >&2; exit 1; }
ls -la "$DIR"
echo "✅ MediaPipe 依赖就绪：$DIR"
