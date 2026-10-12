#!/data/data/com.termux/files/usr/bin/bash
# adbgo.sh — 连接本机「无线调试」(adb over Wi-Fi)
#
# 用法:
#   ./adbgo.sh              自动找端口并连接 127.0.0.1
#   ./adbgo.sh 33411        指定连接端口
#   ./adbgo.sh --scan       强制扫描端口范围（默认 30000-49999）
#   ./adbgo.sh --list       只列出当前设备
#
# 说明: 本机 adb 不支持 `adb mdns`（会报 "mdns is not supported"），
#       所以这里用「候选端口 + 端口扫描」代替 mDNS 自动发现。
#       成功连接的端口会记到 ~/.adb-wireless-port，下次优先尝试。
set -u

HOST="${ADB_HOST:-127.0.0.1}"
PORTFILE="${ADB_PORTFILE:-$HOME/.adb-wireless-port}"
SCAN_FROM="${SCAN_FROM:-30000}"
SCAN_TO="${SCAN_TO:-49999}"
FALLBACK_PORTS="${FALLBACK_PORTS:-33411 5555 37000}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-5}"

die() { echo "错误: $*" >&2; exit 1; }
usage() {
  cat <<'EOF'
用法:
  ./adbgo.sh              自动找端口并连接 127.0.0.1
  ./adbgo.sh 33411        指定连接端口
  ./adbgo.sh --scan       强制扫描端口范围（默认 30000-49999）
  ./adbgo.sh --list       只列出当前设备

环境变量: ADB_HOST 目标主机(默认 127.0.0.1)、SCAN_FROM/SCAN_TO 扫描范围、
          FALLBACK_PORTS 候选端口、ADB_PORTFILE 端口记录文件
EOF
}
list_devices() { adb devices -l | sed -n '2,$p' | sed '/^[[:space:]]*$/d' | sed 's/^/  /'; }
save_port() { printf '%s\n' "$1" > "$PORTFILE"; }

any_device_online() { adb devices | awk 'NR>1 && $2=="device"' | grep -q .; }

is_device() { adb devices | awk -v t="$1" '$1==t && $2=="device"' | grep -q .; }

connect_port() {  # $1 = 端口；成功返回 0
  timeout "$CONNECT_TIMEOUT" adb connect "$HOST:$1" >/dev/null 2>&1
  is_device "$HOST:$1"
}

scan_ports() {  # 快速扫本机开放端口并逐行打印（分块，避免 fd 耗尽）
  python3 - "$HOST" "$SCAN_FROM" "$SCAN_TO" <<'PY'
import select, socket, sys, time

host, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
CHUNK = 256
found = []

for i in range(lo, hi + 1, CHUNK):
    pending = {}
    for port in range(i, min(i + CHUNK, hi + 1)):
        s = socket.socket()
        s.setblocking(False)
        try:
            s.connect_ex((host, port))
        except OSError:
            s.close()
            continue
        pending[s.fileno()] = (s, port)
    deadline = time.time() + 2.0
    while pending and time.time() < deadline:
        socks = [v[0] for v in pending.values()]
        try:
            _, w, x = select.select([], socks, socks, 0.2)
        except (OSError, ValueError):
            break
        for s in set(w) | set(x):
            port = pending.pop(s.fileno(), (None, None))[1]
            if port is not None and s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0:
                found.append(port)
            s.close()
    for s, _ in pending.values():
        s.close()

for port in sorted(set(found)):
    print(port)
PY
}

main() {
  command -v adb >/dev/null 2>&1 || die "未找到 adb，请先 pkg install android-tools"
  adb start-server >/dev/null 2>&1

  case "${1:-}" in
    -h|--help) usage; exit 0 ;;
    --list|-l) list_devices; exit 0 ;;
  esac

  if [ "$#" -ge 1 ] && [ "$1" != "--scan" ] && [ "$1" != "-s" ]; then
    connect_port "$1" || die "端口 $1 连接失败（确认已开启「无线调试」）"
    save_port "$1"; echo "已连接 $HOST:$1"; echo; list_devices; exit 0
  fi

  if [ "${1:-}" != "--scan" ] && [ "${1:-}" != "-s" ]; then
    if any_device_online; then
      echo "设备已在线："; list_devices; exit 0
    fi
    candidates=""
    [ -f "$PORTFILE" ] && candidates="$(head -1 "$PORTFILE" 2>/dev/null)"
    candidates="$candidates $FALLBACK_PORTS"
    for p in $candidates; do
      [ -n "$p" ] || continue
      if connect_port "$p"; then
        save_port "$p"; echo "已连接 $HOST:$p（候选端口）"; echo; list_devices; exit 0
      fi
    done
  fi

  echo "候选端口不通，扫描 $SCAN_FROM-$SCAN_TO ..."
  for p in $(scan_ports); do
    if connect_port "$p"; then
      save_port "$p"; echo "已连接 $HOST:$p（扫描发现）"; echo; list_devices; exit 0
    fi
  done
  die "没找到可连接的无线调试端口。请在手机上开启「无线调试」，或用 ./adbpair.sh 重新配对"
}

main "$@"
