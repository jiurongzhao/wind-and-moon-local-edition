#!/data/data/com.termux/files/usr/bin/bash
# build.sh —— 在 Termux 里把 app/ 打成可安装的 APK（无需 Android Studio / NDK / Gradle）
#
# 用法:
#   ./build.sh            正式构建（release 签名）-> fy.apk
#   ./build.sh --debug    调试构建（debug 签名 + debuggable）-> fy-debug.apk
#   ./build.sh --check    只检查工具链
#
# 两种构建的区别（发布前必看）：
#   * release：清单里没有 debuggable，WebView 调试端口关闭，诊断不自动落盘，
#              用 release.keystore 签名 —— 这是唯一能上架的形态。
#   * debug  ：debug 签名 + aapt2 --debug-mode（debuggable=true），
#              能接 WebView DevTools（Termux 里用 CDP 调试 App 就靠它）。
#
# ⚠️ release.keystore 一旦用于上架就【永远不能丢】：
#    以后更新必须用同一把钥匙签名，否则用户装不上（只能卸载重装）。
#    第一次运行会自动生成，并把口令写在 release-signing.properties，请立刻备份这两份文件。
#
# 依赖: javac(openjdk) d8 aapt2 apksigner keytool zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/app"
BUILD="$ROOT/build"
AJAR="$ROOT/sdk/android-36/android.jar"
NATIVE="$ROOT/native"

PKG="com.fy.local"
MIN_SDK=24
TARGET_SDK=35
# ⚠️ 注意：aapt2 的 --version-code/--version-name 只在 AndroidManifest.xml
# **没有**声明版本号时才生效（官方文档原话 "if none is present"）。
# 所以版本号以 app/AndroidManifest.xml 为准，这里的值只用于构建后比对自检。
VER_CODE=12
VER_NAME="1.6.1"

MODE="release"
[ "${1:-}" = "--debug" ] && MODE="debug"

RELEASE_KS="$ROOT/release.keystore"
RELEASE_PROPS="$ROOT/release-signing.properties"
DEBUG_KS="$ROOT/debug.keystore"

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少工具: $1" >&2; exit 1; }; }

if [ "${1:-}" = "--check" ]; then
  for t in javac d8 aapt2 apksigner keytool zip unzip; do
    printf '%-10s %s\n' "$t" "$(command -v "$t" || echo '<缺失>')"
  done
  [ -f "$AJAR" ] && echo "android.jar ok ($(du -h "$AJAR" | cut -f1))" || echo "android.jar <缺失>"
  [ -f "$RELEASE_KS" ] && echo "release.keystore ok" || echo "release.keystore <还没生成，首次构建会自动建>"
  exit 0
fi

for t in javac d8 aapt2 apksigner keytool zip; do need "$t"; done
[ -f "$AJAR" ] || { echo "缺少 android.jar: $AJAR" >&2; exit 1; }

# ---------- 签名配置 ----------
# 两种模式都用同一把 release 钥匙：这样 debug 包和 release 包可以互相覆盖安装，
# 换包不会丢数据（否则每换一次都要卸载重装，App 私有目录里的几 GB 模型全没）。
# 区别只在 debuggable（debug 模式注入）和输出文件名。
KS="$RELEASE_KS"; ALIAS="fengyue"
if [ ! -f "$KS" ]; then
  PASS="$(python3 -c 'import secrets;print(secrets.token_urlsafe(18))')"
  keytool -genkeypair -keystore "$KS" -alias "$ALIAS" -keyalg RSA -keysize 4096 \
    -validity 10950 -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=Fengyue Local, O=Fengyue, L=CN, C=CN" >/dev/null 2>&1
  printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=%s\nkeyPassword=%s\n' \
    "$(basename "$KS")" "$PASS" "$ALIAS" "$PASS" > "$RELEASE_PROPS"
  echo "  ⚠️  已生成正式签名 $KS"
  echo "  ⚠️  口令写在 $RELEASE_PROPS —— 请立刻把这两份文件备份到别处！"
  echo "  ⚠️  丢失 = 以后无法给已安装用户推送更新。"
fi
KSPASS="$(grep -m1 '^storePassword=' "$RELEASE_PROPS" | cut -d= -f2-)"
[ -n "$KSPASS" ] || { echo "读不到 $RELEASE_PROPS 里的口令" >&2; exit 1; }
if [ "$MODE" = "debug" ]; then
  OUT="$ROOT/fy-debug.apk"
else
  OUT="$ROOT/fy.apk"
fi

rm -rf "$BUILD"
mkdir -p "$BUILD"/{classes,dex,res,gen,apk}

# 卡包：cards/ 是唯一数据源，构建时同步进 App 资源（必须在 aapt2 之前！）
if ls "$ROOT"/cards/pack-*.json >/dev/null 2>&1; then
  python3 "$ROOT/tools/build-pack-index.py" | tail -1
fi

echo "[1/6] 编译资源 (aapt2 compile)"
aapt2 compile --dir "$APP/res" -o "$BUILD/res/res.zip"

echo "[2/6] 编译 Java (javac)"
find "$APP/java" -name '*.java' > "$BUILD/sources.txt"
javac -encoding UTF-8 -nowarn -source 11 -target 11 \
  -classpath "$AJAR" -d "$BUILD/classes" @"$BUILD/sources.txt"

echo "[3/6] 转 dex (d8)"
find "$BUILD/classes" -name '*.class' > "$BUILD/classes.txt"
xargs -a "$BUILD/classes.txt" d8 --min-api "$MIN_SDK" --lib "$AJAR" \
  --output "$BUILD/dex"

echo "[4/6] 链接资源/清单/前端资源 (aapt2 link, $MODE)"
AAPT_DEBUG=()
[ "$MODE" = "debug" ] && AAPT_DEBUG=(--debug-mode)   # 只在调试构建里注入 debuggable
aapt2 link -o "$BUILD/apk/base.apk" \
  -I "$AJAR" \
  --manifest "$APP/AndroidManifest.xml" \
  "$BUILD/res/res.zip" \
  -A "$APP/assets" \
  --java "$BUILD/gen" \
  "${AAPT_DEBUG[@]}" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VER_CODE" \
  --version-name "$VER_NAME"

echo "[5/6] 打包 dex + 原生库（自己做 zipalign 对齐）"
PKG_ARGS=()
i=0
for d in "$BUILD"/dex/*.dex; do
  [ -e "$d" ] || continue
  if [ "$i" -eq 0 ]; then arc="classes.dex"; else arc="classes$((i + 1)).dex"; fi
  PKG_ARGS+=("$arc=$d")
  i=$((i + 1))
done
if [ -d "$NATIVE" ] && compgen -G "$NATIVE/*" > /dev/null; then
  echo "      + 内置原生库/引擎: $(ls "$NATIVE" | tr '\n' ' ')"
  for n in "$NATIVE"/*; do
    [ -e "$n" ] || continue
    PKG_ARGS+=("lib/arm64-v8a/$(basename "$n")=$n")
  done
fi
python3 "$ROOT/tools/packapk.py" "$BUILD/apk/base.apk" "$BUILD/apk/aligned.apk" "${PKG_ARGS[@]}"

echo "[5.5/6] 校验对齐"
python3 "$ROOT/tools/checkapk.py" "$BUILD/apk/aligned.apk" || exit 1

echo "[6/6] 签名 (apksigner, $MODE)"
if [ "$MODE" = "debug" ] && [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias fy -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass android -keypass android \
    -dname "CN=FY Local, O=FY, C=CN" >/dev/null 2>&1
  echo "      已生成调试签名 $KS"
fi

# 两种模式都签 v1+v2+v3（换包兼容 + 老设备也能装）
SIGN_ARGS=(--ks "$KS" --ks-pass "pass:$KSPASS" --key-pass "pass:$KSPASS"
  --ks-key-alias "$ALIAS" --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true)
apksigner sign "${SIGN_ARGS[@]}" --out "$OUT" "$BUILD/apk/aligned.apk" >/dev/null

echo "[6.5/6] 签名后再次校验（apksigner 会重写中央目录）"
python3 "$ROOT/tools/checkapk.py" "$OUT" || exit 1

# 版本一致性自检：防"tag 是 v1.1.0、APK 却自称 1.0.0"这种装上去才发现的事故。
# 注意 aapt2 的 --version-code/--version-name 只在 manifest 未声明版本号时生效，
# 所以真相来源是 app/AndroidManifest.xml。
if command -v aapt2 >/dev/null 2>&1; then
  BADGE="$(aapt2 dump badging "$OUT" 2>/dev/null | head -1)"
  GOT_NAME="$(echo "$BADGE" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
  GOT_CODE="$(echo "$BADGE" | sed -n "s/.*versionCode='\([^']*\)'.*/\1/p")"
  if [ "$GOT_NAME" != "$VER_NAME" ] || [ "$GOT_CODE" != "$VER_CODE" ]; then
    echo "❌ 版本号不一致：APK 里是 $GOT_NAME(code $GOT_CODE)，脚本期望 $VER_NAME(code $VER_CODE)"
    echo "   请改 app/AndroidManifest.xml 的 android:versionCode / android:versionName"
    exit 1
  fi
  echo "  ✅ 版本号一致：$GOT_NAME (code $GOT_CODE)"
fi


# 版本一致性自检：防"tag 是 v1.1.0、APK 却自称 1.0.0"这种只有装上去才发现的事故
if command -v aapt2 >/dev/null 2>&1; then
  BADGE="$(aapt2 dump badging "$OUT" 2>/dev/null | head -1)"
  GOT_NAME="$(echo "$BADGE" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
  GOT_CODE="$(echo "$BADGE" | sed -n "s/.*versionCode='\([^']*\)'.*/\1/p")"
  if [ "$GOT_NAME" != "$VER_NAME" ] || [ "$GOT_CODE" != "$VER_CODE" ]; then
    echo "❌ 版本号不一致：manifest 里是 $GOT_NAME($GOT_CODE)，脚本期望 $VER_NAME($VER_CODE)"
    echo "   修 app/AndroidManifest.xml 的 android:versionCode / android:versionName"
    exit 1
  fi
  echo "  ✅ 版本号一致：$GOT_NAME (code $GOT_CODE)"
fi

echo "── 签名信息 ──"
apksigner verify --print-certs "$OUT" 2>/dev/null | head -4
if [ "$MODE" = "release" ]; then
  if python3 - "$OUT" <<'PY'
import sys, zipfile
# 发布包自检：清单里绝不能出现 debuggable
z = zipfile.ZipFile(sys.argv[1])
raw = z.read('AndroidManifest.xml')
sys.exit(0 if b'debuggable' not in raw else 1)
PY
  then echo "  ✅ 清单中没有 debuggable（发布形态）"
  else echo "  ❌ 发布包里出现了 debuggable，检查 aapt2 参数！" >&2; exit 1; fi
fi
ls -la "$OUT"
echo "✅ 构建完成（$MODE）: $OUT"
