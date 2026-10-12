#!/data/data/com.termux/files/usr/bin/bash
# checkup.sh —— 不依赖 adb 的装机/运行体检。
#
# 前提是 App 自己把诊断报告写到了 Download/fy-diagnostics.txt（App 启动 5 秒后自动写，
# 引擎进入 ready/error 时也会刷新；调试页还有「导出诊断」按钮可手动触发）。
#
# 用法: ./checkup.sh
set -u
PKG="com.fy.local"
F="$HOME/storage/downloads/fy-diagnostics.txt"

echo "=== 1) App 是否已安装 ==="
p="$(cmd package path "$PKG" 2>/dev/null)"
if echo "$p" | grep -q "package:"; then
  echo "  ✅ 已安装：${p#package:}"
else
  echo "  ❌ 未安装（系统返回：${p:-空}）"
  echo "     提示：APK 在 Download/fy.apk，点一下安装即可"
fi

echo
echo "=== 2) 诊断报告 ==="
if [ -f "$F" ]; then
  echo "  ✅ $F"
  echo "     写入时间：$(stat -c%y "$F" 2>/dev/null | cut -d. -f1)"
  echo
  echo "  --- 环境 ---"
  grep -E '机型:|ABI:|nativeLibraryDir:|可用内存:' "$F" | sed 's/^/    /'
  echo "  --- 引擎状态 ---"
  grep -E '^(state=|message=|lastError=)' "$F" | sed 's/^/    /'
  echo "  --- 引擎自检 ---"
  sed -n '/引擎自检/,/引擎日志/p' "$F" | head -18 | sed 's/^/    /'
  echo "  --- 模型 ---"
  sed -n '/--- 模型 ---/,/--- 本地资源服务器 ---/p' "$F" | sed 's/^/    /'
else
  echo "  ⏳ 还没有诊断报告"
  echo "     让 App 启动一次（打开后等 5 秒），或在调试页点「导出诊断」"
fi

echo
echo "=== 3) 本地还准备好的东西 ==="
for f in "$HOME/2/fy/fy.apk" "$HOME/2/fy/models/Qwen3-4B-Q4_K_M.gguf" "$HOME/2/fy/models/qwen2.5-0.5b-instruct-q4_k_m.gguf"; do
  [ -f "$f" ] && printf '  %-52s %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)" || printf '  %-52s %s\n' "$(basename "$f")" "缺失"
done
