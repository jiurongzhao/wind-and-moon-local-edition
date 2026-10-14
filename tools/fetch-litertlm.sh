#!/data/data/com.termux/files/usr/bin/bash
# fetch-litertlm.sh —— 拉取 LiteRT-LM（本地推理单栈）所需的 AAR/jar 与 arm64 .so。
#
# 为什么不把 20MB 二进制塞进 git：和 native/、third_party/mediapipe/ 一个道理，
# 二进制走脚本按需下载，仓库里只留这个脚本 + 说明。
#
# 产出（third_party/litertlm/，已被 .gitignore 忽略）：
#   classes.jar                      LiteRT-LM Android API（Kotlin 编译产物，Java 可直调）
#   libs/gson-*.jar                  Engine/Conversation 的 JSON 序列化
#   libs/kotlin-stdlib-*.jar         Kotlin 运行时（classes.jar 的硬依赖）
#   libs/kotlin-reflect-*.jar        Kotlin 反射
#   libs/kotlinx-coroutines-*.jar    Conversation.sendMessageAsync / Flow 的依赖
#   libs/error_prone_annotations-*.jar  gson 的编译期注解
#   liblitertlm_jni.so               arm64 运行时（22.2MB）
#
# 用法: ./tools/fetch-litertlm.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/third_party/litertlm"
LIBS="$DIR/libs"
VER="0.18.0"
KOTLIN="2.4.0"
COROUTINES="1.11.0"
GSON="2.14.0"
ERRORPRONE="2.48.0"

MIRRORS=(
  "https://maven.aliyun.com/repository/google"
  "https://mirrors.cloud.tencent.com/nexus/repository/maven-public"
  "https://dl.google.com/dl/android/maven2"
)
CENTRAL=(
  "https://maven.aliyun.com/repository/central"
  "https://repo1.maven.org/maven2"
)

mkdir -p "$DIR" "$LIBS"
TMP="$DIR/.tmp"
rm -rf "$TMP"; mkdir -p "$TMP"

fetch_first() {   # fetch_first <输出> <base...> -- <相对路径>
  local out="$1"; shift
  local rel="$1"; shift
  local base
  for base in "$@"; do
    if curl -sL --retry 5 --retry-all-errors --max-time 600 -o "$out" "$base/$rel"; then
      [ -s "$out" ] && return 0
    fi
  done
  echo "❌ 下载失败: $rel -> $out" >&2
  return 1
}

echo "[1/2] LiteRT-LM $VER AAR"
fetch_first "$TMP/litertlm.aar" "com/google/ai/edge/litertlm/litertlm-android/$VER/litertlm-android-$VER.aar" "${MIRRORS[@]}"
unzip -o -q "$TMP/litertlm.aar" classes.jar "jni/arm64-v8a/liblitertlm_jni.so" -d "$TMP"
cp "$TMP/classes.jar" "$DIR/classes.jar"
cp "$TMP/jni/arm64-v8a/liblitertlm_jni.so" "$DIR/liblitertlm_jni.so"

echo "[2/2] 依赖 jar"
fetch_first "$LIBS/gson.jar"                  "com/google/code/gson/gson/$GSON/gson-$GSON.jar" "${CENTRAL[@]}"
fetch_first "$LIBS/error_prone_annotations.jar" "com/google/errorprone/error_prone_annotations/$ERRORPRONE/error_prone_annotations-$ERRORPRONE.jar" "${CENTRAL[@]}"
fetch_first "$LIBS/kotlin-stdlib.jar"         "org/jetbrains/kotlin/kotlin-stdlib/$KOTLIN/kotlin-stdlib-$KOTLIN.jar" "${CENTRAL[@]}"
fetch_first "$LIBS/kotlin-reflect.jar"        "org/jetbrains/kotlin/kotlin-reflect/$KOTLIN/kotlin-reflect-$KOTLIN.jar" "${CENTRAL[@]}"
fetch_first "$LIBS/kotlinx-coroutines-android.jar" "org/jetbrains/kotlinx/kotlinx-coroutines-android/$COROUTINES/kotlinx-coroutines-android-$COROUTINES.jar" "${CENTRAL[@]}"
fetch_first "$LIBS/kotlinx-coroutines-core-jvm.jar" "org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/$COROUTINES/kotlinx-coroutines-core-jvm-$COROUTINES.jar" "${CENTRAL[@]}"

rm -rf "$TMP"
echo "[校验]"
for f in classes.jar liblitertlm_jni.so libs/gson.jar libs/error_prone_annotations.jar libs/kotlin-stdlib.jar libs/kotlin-reflect.jar libs/kotlinx-coroutines-android.jar libs/kotlinx-coroutines-core-jvm.jar; do
  [ -s "$DIR/$f" ] || { echo "❌ 缺 $f" >&2; exit 1; }
done
ls -la "$DIR" "$LIBS"
echo "✅ LiteRT-LM 依赖就绪：$DIR"
