# -*- coding: utf-8 -*-
"""vultr-gpu-watch.py —— 盯 Vultr 的 GPU 库存。

用的是公开的 /v2/regions/<id>/availability 接口，不需要 API key。
Vultr 现在把 Cloud GPU（L40S）列出来但 locations 是空的 = 全区售罄；
一有货这个脚本就会打印出来。

  python3 tools/vultr-gpu-watch.py --once        # 扫一次
  python3 tools/vultr-gpu-watch.py --rounds 36   # 每 5 分钟一次，最多 3 小时
"""
import argparse, concurrent.futures, json, sys, time, urllib.request

BASE = 'https://api.vultr.com'


def get(path):
    req = urllib.request.Request(BASE + path, headers={'User-Agent': 'fy-gpu-watch'})
    return json.loads(urllib.request.urlopen(req, timeout=25).read())


def gpu_in_region(r):
    """只认 /v2/plans 里真在售的 GPU 机型。

    Vultr 的 availability 接口里残留了两条已下架的老 A16（blr），
    直接按 vcg 前缀过滤会误报，所以这里拿目录里的 id 做交集。
    """
    try:
        plans = get('/v2/regions/%s/availability' % r).get('available_plans', [])
    except Exception:
        return None
    gpu = [p for p in plans if p in CATALOG_GPU]
    return [r, gpu] if gpu else None


CATALOG_GPU = set()


def scan():
    global CATALOG_GPU
    regs = [r['id'] for r in get('/v2/regions')['regions']]
    CATALOG_GPU = {p['id'] for p in get('/v2/plans?per_page=500').get('plans', []) if p.get('gpu_type')}
    hits = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        for res in ex.map(gpu_in_region, regs):
            if res:
                hits.append(res)
    cat = []
    for p in get('/v2/plans?per_page=500').get('plans', []):
        if p.get('gpu_type'):
            cat.append([p['id'], p.get('gpu_type'), p.get('gpu_vram_gb'), p.get('hourly_cost'), p.get('locations')])
    return regs, hits, cat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--once', action='store_true')
    ap.add_argument('--rounds', type=int, default=36)
    ap.add_argument('--interval', type=int, default=300)
    a = ap.parse_args()

    rounds = 1 if a.once else a.rounds
    for i in range(rounds):
        regs, hits, cat = scan()
        stamp = time.strftime('%Y-%m-%d %H:%M:%S')
        print('[%s] 扫描 %d 个区域 | GPU 目录 %d 个机型 | 有货区域: %s'
              % (stamp, len(regs), len(cat), json.dumps(hits, ensure_ascii=False) if hits else '无'), flush=True)
        for c in cat:
            print('    %s %s %sGB $%s/h 可用区域=%s' % tuple(c), flush=True)
        if hits:
            print('!!! Vultr 有 GPU 库存了：%s' % json.dumps(hits, ensure_ascii=False), flush=True)
            return 0
        if i + 1 < rounds:
            time.sleep(a.interval)
    print('监控结束：%d 次扫描都没有 GPU 库存' % rounds, flush=True)
    return 1


if __name__ == '__main__':
    sys.exit(main())
