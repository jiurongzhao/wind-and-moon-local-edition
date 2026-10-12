#!/data/data/com.termux/files/usr/bin/bash
# fetch-sdk.sh —— 取 Android SDK 的 android.jar（javac / d8 / aapt2 需要它才能编译）
#
# 仓库里不放这 27MB 的第三方产物，但构建必须用它。来源是 Google 官方 SDK 仓库，
# 文件名可以从仓库里带的 repository2-1.xml 查到。
#
# 用法: ./tools/fetch-sdk.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/sdk/android-36"
PKG="platform-36-ext19_r01.zip"
EXPECT=66057671
URL="https://dl.google.com/android/repository/$PKG"

mkdir -p "$DEST"

if [ -f "$DEST/android.jar" ] && [ "$(stat -c%s "$DEST/android.jar")" -gt 1000000 ]; then
  echo "✅ 已存在 $DEST/android.jar（$(du -h "$DEST/android.jar" | cut -f1)），跳过"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "── 下载 Android SDK platform 36（约 66MB，Google 官方源）"
echo "   $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fL --retry 3 -o "$TMP/$PKG" "$URL"
else
  wget -O "$TMP/$PKG" "$URL"
fi

got="$(stat -c%s "$TMP/$PKG")"
if [ "$got" != "$EXPECT" ]; then
  echo "⚠️  包大小 $got 与清单里的 $EXPECT 不一致（可能 Google 更新了版本，继续尝试解包）" >&2
fi

echo "── 解包"
unzip -o -q "$TMP/$PKG" -d "$TMP/x"
JAR="$(find "$TMP/x" -name 'android.jar' | head -1)"
[ -n "$JAR" ] || { echo "❌ 解包后找不到 android.jar" >&2; exit 1; }
cp -f "$JAR" "$DEST/android.jar"

SRCJAR="$(find "$TMP/x" -name 'android-stubs-src.jar' | head -1)"
[ -n "$SRCJAR" ] && cp -f "$SRCJAR" "$DEST/android-stubs-src.jar"

echo "✅ 就绪：$DEST/android.jar（$(du -h "$DEST/android.jar" | cut -f1)）"
