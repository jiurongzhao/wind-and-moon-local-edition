#!/usr/bin/env bash
# gpu-setup.sh —— 把一台 Ubuntu + NVIDIA 显卡的机器一键变成出图服务器。
#
#   bash tools/gpu-setup.sh "Tongyi-MAI/Z-Image-Turbo"
#   TOKEN=xxx PORT=8080 bash tools/gpu-setup.sh "Qwen/Qwen-Image"
#
# 全程约 10~25 分钟（主要慢在下数 GB 的模型）。跑完会打印 endpoint / token，
# 然后在本机： python3 tools/gen-avatars.py --provider selfhost --endpoint ... --token ...
set -euo pipefail

MODEL="${1:-Tongyi-MAI/Z-Image-Turbo}"
PORT="${PORT:-8080}"
VENV="${VENV:-/opt/sdvenv}"
FYDIR="${FYDIR:-/opt/fy-gpu}"
SRC="$(cd "$(dirname "$0")" && pwd)/gpu-sdserver.py"

command -v nvidia-smi >/dev/null 2>&1 || {
  echo "✗ 找不到 nvidia-smi：这台机器没有 NVIDIA 驱动。请选带 GPU 的镜像/实例。" >&2; exit 1; }
echo "== 显卡 =="
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader

echo "== 装依赖 =="
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip ffmpeg curl >/dev/null

if [ ! -x "$VENV/bin/python" ]; then python3 -m venv "$VENV"; fi
# shellcheck disable=SC1091
. "$VENV/bin/activate"
pip install -q -U pip
pip install -q torch diffusers transformers accelerate safetensors sentencepiece protobuf

mkdir -p "$FYDIR"
cp -f "$SRC" "$FYDIR/gpu-sdserver.py"

if [ -z "${TOKEN:-}" ]; then
  TOKEN="$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28)"
fi
printf '%s' "$TOKEN" > "$FYDIR/token"
chmod 600 "$FYDIR/token"

echo "== 启动服务（模型 $MODEL）=="
pkill -f gpu-sdserver.py 2>/dev/null || true
sleep 1
cd "$FYDIR"
nohup "$VENV/bin/python" gpu-sdserver.py --model "$MODEL" --port "$PORT" \
      --token "$TOKEN" --host 0.0.0.0 > "$FYDIR/server.log" 2>&1 &
echo $! > "$FYDIR/server.pid"
sleep 5

PUBIP="$(curl -s --max-time 6 https://api.ipify.org || true)"
[ -n "$PUBIP" ] || PUBIP="<公网IP>"

cat <<EOF

=== 出图服务已启动 ===
endpoint : http://$PUBIP:$PORT
token    : $TOKEN
日志     : $FYDIR/server.log      （模型下载/加载要等它跑完）
健康检查 : curl -s http://$PUBIP:$PORT/health
停止     : pkill -f gpu-sdserver.py

本机抓图：
  python3 tools/gen-avatars.py --provider selfhost \
      --endpoint http://$PUBIP:$PORT --token $TOKEN \
      --size 768x768 --steps 8 --workers 2

用完记得把实例关掉/销毁，按小时计费。
EOF
