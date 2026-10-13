# -*- coding: utf-8 -*-
"""gpu-sdserver.py —— 把一台带 NVIDIA 显卡的机器变成一个出图 HTTP 服务，专给 gen-avatars.py 用。

在一台 Ubuntu + NVIDIA 显卡（云 GPU、租的卡、自建工作站都行）上跑：

  bash tools/gpu-setup.sh "Tongyi-MAI/Z-Image-Turbo"      # 一键装好并启动（推荐）
  # 或者手动：
  python3 -m venv /opt/sdvenv && . /opt/sdvenv/bin/activate
  pip install -U pip torch diffusers transformers accelerate safetensors sentencepiece protobuf
  python3 tools/gpu-sdserver.py --model Qwen/Qwen-Image --port 8080 --token <随机串>

本地手机上：

  python3 tools/gen-avatars.py --provider selfhost \
      --endpoint http://<公网IP>:8080 --token <随机串> --size 768x768 --workers 2

接口（都实现，方便换用其它前端）：
  GET  /health            -> {"ok":true,"model":...,"device":...,"done":n}
  POST /sdapi/v1/txt2img  -> {"images":["<base64 png>"]}   兼容 A1111 / Forge / sd-webui
  POST /generate          -> image/png 原始字节
请求体：{"prompt","negative_prompt","width","height","steps","cfg_scale","seed"}

只用标准库 + torch/diffusers；单卡串行排队出图，不落盘。
"""
import argparse, base64, io, json, os, sys, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {
    'pipe': None, 'model': '', 'device': 'cuda', 'dtype': 'bf16',
    'lock': threading.Lock(), 'token': '', 'done': 0, 'started': time.time(),
    'defaults': {'steps': 8, 'cfg': 1.0, 'negative': ''},
}


def load_pipe(model, dtype_name, device):
    import torch
    from diffusers import AutoPipelineForText2Image

    dtype = {'bf16': torch.bfloat16, 'fp16': torch.float16, 'fp32': torch.float32}[dtype_name]
    pipe = AutoPipelineForText2Image.from_pretrained(model, torch_dtype=dtype)
    pipe = pipe.to(device)
    try:
        pipe.set_progress_bar_config(disable=True)
    except Exception:
        pass
    for fn in ('enable_vae_slicing', 'enable_attention_slicing', 'enable_vae_tiling'):
        try:
            getattr(pipe, fn)()
        except Exception:
            pass
    if device == 'cuda':
        torch.backends.cuda.matmul.allow_tf32 = True
    return pipe


def generate(req):
    """按请求出图，返回 PIL.Image。只把管道真正认识的参数传进去。

    FLUX 系列不吃 negative_prompt，Z-Image/Qwen 系列走 guidance_scale，
    不同管道签名不一样，所以这里用 inspect 过滤，避免参数错误把整条请求打挂。
    """
    import inspect
    import torch

    pipe = STATE['pipe']
    prompt = str(req.get('prompt') or '').strip()
    if not prompt:
        raise ValueError('prompt 为空')
    width = max(256, min(int(req.get('width') or 768), 2048))
    height = max(256, min(int(req.get('height') or 768), 2048))
    steps = max(1, min(int(req.get('steps') or STATE['defaults']['steps']), 100))
    cfg = float(req.get('cfg_scale', req.get('guidance_scale', STATE['defaults']['cfg'])))
    negative = req.get('negative_prompt')
    if negative is None:
        negative = STATE['defaults']['negative']
    seed = int(req.get('seed') or 0)

    kw = {'prompt': prompt, 'width': width, 'height': height,
          'num_inference_steps': steps, 'guidance_scale': cfg}
    params = set(inspect.signature(pipe.__call__).parameters)
    if negative and 'negative_prompt' in params:
        kw['negative_prompt'] = negative
    if 'max_sequence_length' in params and 'flux' in STATE['model'].lower():
        kw['max_sequence_length'] = 256
    if seed > 0:
        try:
            kw['generator'] = torch.Generator(device=STATE['device']).manual_seed(seed % 2147483647)
        except Exception:
            kw['generator'] = torch.Generator().manual_seed(seed % 2147483647)
    with STATE['lock']:
        return pipe(**kw).images[0]


class Handler(BaseHTTPRequestHandler):
    server_version = 'fy-sdserver/1.0'
    protocol_version = 'HTTP/1.1'

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        tok = STATE['token']
        if not tok:
            return True
        if self.headers.get('Authorization', '') == 'Bearer ' + tok:
            return True
        q = self.path.split('?', 1)[1] if '?' in self.path else ''
        for part in q.split('&'):
            if part.startswith('token=') and part[6:] == tok:
                return True
        return False

    def log_message(self, fmt, *a):
        sys.stderr.write('[%s] %s\n' % (time.strftime('%H:%M:%S'), fmt % a))

    def do_GET(self):
        if self.path.split('?')[0] in ('/health', '/'):
            self._json(200, {'ok': True, 'model': STATE['model'], 'device': STATE['device'],
                             'dtype': STATE['dtype'], 'done': STATE['done'],
                             'uptime': round(time.time() - STATE['started'], 1),
                             'defaults': STATE['defaults']})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if not self._authed():
            self._json(401, {'error': 'unauthorized'})
            return
        path = self.path.split('?')[0]
        if path not in ('/sdapi/v1/txt2img', '/generate'):
            self._json(404, {'error': 'not found'})
            return
        n = int(self.headers.get('Content-Length') or 0)
        if n > (1 << 20):
            self._json(413, {'error': 'body too large'})
            return
        try:
            req = json.loads(self.rfile.read(n) or b'{}')
        except Exception as e:
            self._json(400, {'error': 'bad json: %s' % e})
            return
        t0 = time.time()
        try:
            img = generate(req)
        except Exception as e:
            traceback.print_exc()
            self._json(500, {'error': str(e)[:300]})
            return
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        raw = buf.getvalue()
        STATE['done'] += 1
        sys.stderr.write('  -> #%d %.1fs %dx%d steps=%s\n'
                         % (STATE['done'], time.time() - t0, img.width, img.height,
                            req.get('steps') or STATE['defaults']['steps']))
        if path == '/generate':
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        else:
            self._json(200, {'images': [base64.b64encode(raw).decode('ascii')]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='Tongyi-MAI/Z-Image-Turbo', help='HuggingFace 仓库名')
    ap.add_argument('--host', default='0.0.0.0')
    ap.add_argument('--port', type=int, default=8080)
    ap.add_argument('--token', default=os.environ.get('SD_TOKEN', ''), help='公网部署必须设置')
    ap.add_argument('--dtype', default='bf16', choices=['bf16', 'fp16', 'fp32'])
    ap.add_argument('--device', default='cuda')
    ap.add_argument('--steps', type=int, default=8)
    ap.add_argument('--cfg', type=float, default=1.0)
    ap.add_argument('--negative', default='')
    ap.add_argument('--warmup', action='store_true', help='先出 1 张 512 的预热')
    a = ap.parse_args()

    STATE.update(model=a.model, device=a.device, dtype=a.dtype, token=a.token)
    STATE['defaults'] = {'steps': a.steps, 'cfg': a.cfg, 'negative': a.negative}
    if not a.token:
        sys.stderr.write('!! 没设置 --token：能访问到这个端口的人都能白用你的显卡\n')
    sys.stderr.write('加载模型 %s（首次会下载，可能要几分钟）…\n' % a.model)
    STATE['pipe'] = load_pipe(a.model, a.dtype, a.device)
    sys.stderr.write('模型就绪\n')
    if a.warmup:
        generate({'prompt': 'warmup', 'width': 512, 'height': 512, 'steps': 2})
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    sys.stderr.write('listening on %s:%d  model=%s\n' % (a.host, a.port, a.model))
    srv.serve_forever()


if __name__ == '__main__':
    main()
