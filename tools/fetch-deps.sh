#!/data/data/com.termux/files/usr/bin/bash
# fetch-deps.sh —— 一次把构建所需的两个第三方大件准备好：
#   1) native/           llama.cpp 官方 Android arm64 预编译二进制（约 27MB，MIT）
#   2) sdk/android-36/   android.jar（约 28MB，Google 官方 SDK）
#
# 仓库里刻意不放这两个（体积 + 溯源），所以 clone 之后要先跑一次这个脚本。
#
# 用法: ./tools/fetch-deps.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "════ 1/2 引擎二进制（llama.cpp） ════"
"$ROOT/tools/fetch-engine.sh"

echo
echo "════ 2/2 android.jar（Android SDK） ════"
"$ROOT/tools/fetch-sdk.sh"

echo
echo "════ 检查工具链 ════"
"$ROOT/build.sh" --check
