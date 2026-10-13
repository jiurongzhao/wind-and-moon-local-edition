# -*- coding: utf-8 -*-
"""gen-avatars.py —— 按 cards/avatars/prompts.json 批量出立绘，裁方压成 WebP。

用法:
  python3 tools/gen-avatars.py --dry-run                 # 只看会生成什么
  python3 tools/gen-avatars.py --provider zhipu          # 需要 ZHIPU_API_KEY（CogView-3-Flash 免费）
  python3 tools/gen-avatars.py --provider siliconflow    # 需要 SILICONFLOW_API_KEY（FLUX.1-schnell 免费）
  python3 tools/gen-avatars.py --provider pollinations   # 免费但限流
  python3 tools/gen-avatars.py --provider hfspace        # HuggingFace FLUX 空间，匿名额度有限

令牌读取顺序：环境变量 → ~/.image_token（一行）；不会打印。
特性：断点续传（已有 webp 就跳过）、并发、退避重试、生成清单 manifest.json。
"""
import argparse, concurrent.futures, hashlib, json, os, subprocess, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPTS = os.path.join(ROOT, 'cards', 'avatars', 'prompts.json')
OUTDIR = os.path.join(ROOT, 'cards', 'avatars')
RAW = os.path.join(OUTDIR, '.raw')
MANIFEST = os.path.join(OUTDIR, 'manifest.json')
UA = {'User-Agent': 'Mozilla/5.0'}

def token(name):
    """按 provider 取令牌：环境变量 → ~/.<provider>_token → ~/.image_token 兜底。

    SILICONFLOW_API_KEY → ~/.siliconflow_token，ZHIPU_API_KEY → ~/.zhipu_token。
    绝不打印令牌。
    """
    v = os.environ.get(name, '').strip()
    if v:
        return v
    cands = [os.path.expanduser('~/.%s' % name.lower().replace('_api_key', '_token')),
             os.path.expanduser('~/.image_token')]
    for p in cands:
        if os.path.exists(p):
            t = open(p, encoding='utf-8').read().strip()
            if t:
                return t
    return ''

def http_json(url, payload, headers=None, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers=dict({'Content-Type': 'application/json'}, **(headers or {})))
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())

def http_get(url, timeout=180):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()

# ----------------------------------------------------------------- 各出图通道

def gen_zhipu(prompt, seed, size, model='cogview-3-flash'):
    key = token('ZHIPU_API_KEY')
    if not key:
        raise RuntimeError('缺少 ZHIPU_API_KEY')
    # 注意：不要把 seed 拼进 prompt —— 图像模型可能把 "seed=123" 当文字画进画面
    d = http_json('https://open.bigmodel.cn/api/paas/v4/images/generations',
                  {'model': model, 'prompt': prompt, 'size': size},
                  {'Authorization': 'Bearer ' + key})
    return http_get(d['data'][0]['url'])

def gen_siliconflow(prompt, seed, size, model='Tongyi-MAI/Z-Image-Turbo'):
    """硅基流动。注意：FLUX.1-schnell 已下架（Model disabled），
    现在可用的文生图模型：Qwen/Qwen-Image、Tongyi-MAI/Z-Image-Turbo、Kwai-Kolors/Kolors 等。"""
    key = token('SILICONFLOW_API_KEY')
    if not key:
        raise RuntimeError('缺少 SILICONFLOW_API_KEY')
    # 响应是 images[].url（不是 data[].url），URL 只有 1 小时有效
    d = http_json('https://api.siliconflow.cn/v1/images/generations',
                  {'model': model, 'prompt': prompt,
                   'image_size': size, 'batch_size': 1, 'seed': seed % 999999999},
                  {'Authorization': 'Bearer ' + key})
    arr = d.get('images') or d.get('data') or []
    if not arr:
        raise RuntimeError('返回里没有图片：' + str(d)[:120])
    return http_get(arr[0]['url'])

def gen_pollinations(prompt, seed, size, model='turbo'):
    px = size.split('x')[0]
    url = ('https://image.pollinations.ai/prompt/' + urllib.parse.quote(prompt) +
           '?width=%s&height=%s&model=turbo&nologo=true&seed=%d' % (px, px, seed % 99999))
    return http_get(url)

def gen_hfspace(prompt, seed, size, model='', steps=4):
    host = 'https://black-forest-labs-flux-1-schnell.hf.space'
    px = int(size.split('x')[0])
    r = http_json(host + '/gradio_api/call/infer',
                  {'data': [prompt, seed % 2147483647, False, px, px, steps]})
    txt = http_get(host + '/gradio_api/call/infer/' + r['event_id']).decode('utf-8', 'replace')
    if 'event: error' in txt:
        raise RuntimeError('空间返回 error（匿名额度用尽）')
    url = None
    for line in txt.splitlines():
        if line.startswith('data:') and 'url' in line:
            arr = json.loads(line[5:].strip())
            def find(o):
                if isinstance(o, dict):
                    if o.get('url'):
                        return o['url']
                    for v in o.values():
                        u = find(v)
                        if u:
                            return u
                if isinstance(o, list):
                    for v in o:
                        u = find(v)
                        if u:
                            return u
                return None
            url = find(arr)
    if not url:
        raise RuntimeError('空间没有返回图片地址')
    return http_get(url)

PROVIDERS = {'zhipu': gen_zhipu, 'siliconflow': gen_siliconflow,
             'pollinations': gen_pollinations, 'hfspace': gen_hfspace}

# ----------------------------------------------------------------- 后处理

def to_webp(raw_bytes, out_path, px=256, zoom=0.90, ybias=0.30):
    """裁成正方形并压成 WebP。

    zoom/ybias 不是随手设的：智谱会在右下角强制打「AI生成」水印，
    裁掉 10% 边 + 视野上移，正好把水印切出画面，同时让脸更大。
    """
    os.makedirs(RAW, exist_ok=True)
    tmp = os.path.join(RAW, hashlib.sha1(raw_bytes).hexdigest()[:16] + '.img')
    open(tmp, 'wb').write(raw_bytes)
    side = 'min(iw,ih)*%.3f' % zoom
    vf = ("crop=w='%s':h='%s':x='(iw-%s)/2':y='(ih-%s)*%.2f',scale=%d:%d:flags=lanczos"
          % (side, side, side, side, ybias, px, px))
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', tmp, '-vf', vf,
           '-c:v', 'libwebp', '-quality', '82', out_path]
    subprocess.run(cmd, check=True)
    os.remove(tmp)

def rel(path):
    return os.path.relpath(path, ROOT).replace(os.sep, '/')

# ----------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--provider', default='zhipu', choices=list(PROVIDERS))
    ap.add_argument('--size', default='1024x1024')
    ap.add_argument('--px', type=int, default=256, help='输出 WebP 边长')
    ap.add_argument('--zoom', type=float, default=0.90, help='裁剪保留比例（越小脸越大、越能切掉水印）')
    ap.add_argument('--ybias', type=float, default=0.30, help='裁剪窗口垂直位置 0=顶部 1=底部')
    ap.add_argument('--workers', type=int, default=2)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--per-category', type=int, default=0, help='每类只取前 N 个主题（做样张用）')
    ap.add_argument('--lang', default='zh', choices=['zh', 'en'], help='en=用 prompt_en（FLUX 等英文模型）')
    ap.add_argument('--model', default='', help='覆盖默认模型名，如 Qwen/Qwen-Image')
    ap.add_argument('--slug', default='')
    ap.add_argument('--kind', default='')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    data = json.load(open(PROMPTS, encoding='utf-8'))
    items = data['items']
    if args.slug:
        items = [i for i in items if i['slug'] == args.slug]
    if args.kind:
        items = [i for i in items if i['kind'] == args.kind]
    if args.per_category:
        picked, seen = [], {}
        for it in items:
            k = it['slug'] + '|' + it['kind']
            if seen.get(k, 0) < args.per_category:
                picked.append(it)
                seen[k] = seen.get(k, 0) + 1
        items = picked
    if args.limit:
        items = items[:args.limit]

    manifest = {}
    if os.path.exists(MANIFEST):
        manifest = json.load(open(MANIFEST, encoding='utf-8'))

    todo = []
    for idx, it in enumerate(items):
        key = '%s|%s|%s' % (it['slug'], it['kind'], it['topic'])
        out = os.path.join(OUTDIR, it['slug'], '%s-%03d.webp' % (it['kind'], idx))
        if args.lang == 'en' and it.get('prompt_en'):
            it = dict(it, prompt=it['prompt_en'])
        if key in manifest and os.path.exists(os.path.join(ROOT, manifest[key]['file'])):
            continue
        todo.append((idx, it, key, out))

    print('计划生成 %d 张（已存在 %d 张），通道=%s，输出 %dpx WebP'
          % (len(todo), len(items) - len(todo), args.provider, args.px))
    if args.dry_run or not todo:
        for idx, it, key, out in todo[:8]:
            print('  [%s] %s\n    %s' % (it['slug'], it['topic'], it['prompt'][:110] + '…'))
        return

    gen = PROVIDERS[args.provider]
    model = args.model or {
        'zhipu': 'cogview-3-flash',
        'siliconflow': 'Tongyi-MAI/Z-Image-Turbo',
    }.get(args.provider, '')
    if model:
        print('模型：%s' % model)
    lock_state = {'done': 0}

    def work(job):
        idx, it, key, out = job
        os.makedirs(os.path.dirname(out), exist_ok=True)
        last = ''
        for attempt in range(6):
            try:
                raw = gen(it['prompt'], it['seed'], args.size, model)
                if len(raw) < 1500:
                    raise RuntimeError('图太小（%d 字节）' % len(raw))
                to_webp(raw, out, args.px, args.zoom, args.ybias)
                return (key, {'file': rel(out), 'bytes': os.path.getsize(out),
                              'sha256': hashlib.sha256(open(out, 'rb').read()).hexdigest()[:16],
                              'topic': it['topic'], 'slug': it['slug'], 'kind': it['kind']}, None)
            except Exception as e:
                last = str(e)[:120]
                # 智谱免费模型限流很紧：429 要等久一点，别把配额撞没
                wait = (12 + attempt * 8) if '429' in last else (2 + attempt * 3)
                time.sleep(wait)
        return (key, None, last)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        for key, meta, err in ex.map(work, todo):
            lock_state['done'] += 1
            if meta:
                manifest[key] = meta
                open(MANIFEST, 'w', encoding='utf-8').write(
                    json.dumps(manifest, ensure_ascii=False, indent=1))
                print('[%d/%d] ✅ %s' % (lock_state['done'], len(todo), meta['topic']))
            else:
                print('[%d/%d] ❌ %s — %s' % (lock_state['done'], len(todo), key, err))
    print('完成：清单 %s（共 %d 张）' % (rel(MANIFEST), len(manifest)))

if __name__ == '__main__':
    main()
