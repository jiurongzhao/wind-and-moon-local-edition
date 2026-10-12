#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check-library.py —— 在线卡库目录与分片的对齐校验（发布前的第二道闸门）。

`check-cards.py --strict` 管的是"每张卡本身合不合格"；这个脚本管的是
"目录里写的和文件里装的对不对得上"，也就是 App 下载时会踩到的那一类问题：

  1. 目录声明的 count / bytes / sha256 与分片文件逐字节一致（下到半截、传坏文件会在这里现形）；
  2. 每个「分类 × 类型」的分片号连续（1..parts），不重不漏；
  3. v2 的 topics / keywords 存在且有意义，且**同一主题不会跨两个分片**
     （跨片了"搜关键词只下一片"就会漏卡）；
  4. 每张卡的 extensions.fy.topic 都在它所在分片声明的 topics 里；
  5. 全库不重名（含与内置 160 张的重名）；
  6. categories 里每个分类的张数与 packs 实际相加一致。

用法：
    python3 tools/check-library.py                 # 校验 cards/library/
    python3 tools/check-library.py /path/to/lib    # 校验别的目录
"""
import glob
import hashlib
import json
import os
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_LIB = os.path.join(ROOT, 'cards', 'library')


def main():
    lib = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else DEFAULT_LIB
    idx_path = os.path.join(lib, 'index.json')
    if not os.path.exists(idx_path):
        print('❌ 没有目录文件：%s' % idx_path)
        return 1
    with open(idx_path, encoding='utf-8') as f:
        idx = json.load(f)
    errors = []
    warns = []

    spec = idx.get('spec')
    if spec not in ('fy_library_v1', 'fy_library_v2'):
        errors.append('spec 不合法：%r（应为 fy_library_v1 / fy_library_v2）' % spec)
    v2 = spec == 'fy_library_v2'

    packs = idx.get('packs') or []
    if not packs:
        errors.append('目录没有 packs')
        return _report(errors, warns, 0, 0)

    # ---- 1) 每个分片：文件存在、字节数 / sha256 / count 一致 ----
    files_on_disk = set(os.path.basename(p)
                        for p in glob.glob(os.path.join(lib, '*.json'))
                        if os.path.basename(p) not in ('index.json', 'audit.json', 'sample.json'))
    seen_files = set()
    total = 0
    kind_by_file = {}
    index_by_file = {}
    for p in packs:
        f = p.get('file') or ''
        if not f:
            errors.append('有一条 pack 没有 file')
            continue
        if f in seen_files:
            errors.append('目录里 %s 出现两次' % f)
        seen_files.add(f)
        fp = os.path.join(lib, f)
        if not os.path.exists(fp):
            errors.append('缺分片文件：%s' % f)
            continue
        blob = open(fp, 'rb').read()
        if p.get('bytes') != len(blob):
            errors.append('%s: bytes 声明 %s，实际 %d' % (f, p.get('bytes'), len(blob)))
        sha = hashlib.sha256(blob).hexdigest()
        if p.get('sha256') != sha:
            errors.append('%s: sha256 与文件不一致' % f)
        try:
            pack = json.loads(blob.decode('utf-8'))
        except Exception as e:
            errors.append('%s: JSON 解析失败：%s' % (f, e))
            continue
        cards = pack.get('cards') or []
        if pack.get('count') != len(cards):
            errors.append('%s: 文件内 count=%s 与实际 %d 不符' % (f, pack.get('count'), len(cards)))
        if p.get('count') != len(cards):
            errors.append('%s: 目录 count=%s 与实际 %d 不符' % (f, p.get('count'), len(cards)))
        if pack.get('slug') != p.get('slug') or pack.get('kind') != p.get('kind'):
            errors.append('%s: 文件里的 slug/kind 与目录不一致' % f)
        # v2：主题与关键词
        if v2:
            topics = pack.get('topics') or []
            kws = pack.get('keywords') or []
            if not topics:
                errors.append('%s: v2 分片缺 topics' % f)
            if not kws:
                errors.append('%s: v2 分片缺 keywords' % f)
            tset = set(topics)
            for k in kws:
                # 主题（职业/局面名）本身就是标签，可以长；场景/物件词要短，
                # 因为它们是"给人往搜索框里打的建议词"。
                if k in tset:
                    continue
                if not (2 <= len(str(k)) <= 12):
                    errors.append('%s: 场景关键词长度不合法：%r' % (f, k))
            tset = set(topics)
            for c in cards:
                t = str(((c.get('data') or {}).get('extensions') or {}).get('fy', {}).get('topic') or '')
                if t and t not in tset:
                    errors.append('%s: 卡「%s」的主题 %r 不在分片 topics 里'
                                  % (f, (c.get('data') or {}).get('name'), t))
        total += len(cards)
        kind_by_file[f] = p.get('kind')
        index_by_file[f] = p

    extra = files_on_disk - seen_files
    if extra:
        warns.append('目录没登记的分片文件（不会发布，但请清掉）：%s' % '、'.join(sorted(extra)[:6]))

    # ---- 2) 分片号连续 1..parts ----
    groups = defaultdict(list)
    for p in packs:
        groups[(p.get('slug'), p.get('kind'))].append(p)
    for (slug, kind), ps in sorted(groups.items()):
        parts = sorted(int(x.get('part') or 0) for x in ps)
        declared = {int(x.get('parts') or 0) for x in ps}
        if len(declared) != 1:
            errors.append('%s/%s: parts 声明不一致 %s' % (slug, kind, sorted(declared)))
        n = declared.pop() if declared else 0
        if parts != list(range(1, n + 1)):
            errors.append('%s/%s: 分片号不连续 %s（应为 1..%d）' % (slug, kind, parts, n))
        # 主题不跨片
        if v2:
            owner = {}
            for p in ps:
                for t in (p.get('topics') or []):
                    if t in owner and owner[t] != p.get('file'):
                        errors.append('主题「%s」同时出现在 %s 与 %s（跨片会让关键词下载漏卡）'
                                      % (t, owner[t], p.get('file')))
                    owner[t] = p.get('file')

    # ---- 3) 分类张数一致 ----
    by_tag = Counter()
    by_slug_kind = Counter()
    for p in packs:
        by_tag[p.get('tag')] += int(p.get('count') or 0)
        by_slug_kind[(p.get('slug'), p.get('kind'))] += int(p.get('count') or 0)
    for cat in (idx.get('categories') or []):
        slug, tag = cat.get('slug'), cat.get('tag')
        for kind in ('character', 'story'):
            want = int(cat.get(kind) or 0)
            got = by_slug_kind.get((slug, kind), 0)
            if want != got:
                errors.append('分类 %s 的 %s 声明 %d 张，分片实际 %d 张' % (tag, kind, want, got))
        if v2 and not (cat.get('topics') or []):
            errors.append('分类 %s 的 categories[].topics 为空' % tag)
    if idx.get('total') and idx['total'] != total:
        errors.append('目录 total=%s，分片张数合计 %d' % (idx['total'], total))

    # ---- 4) 全库不重名（含内置 160 张） ----
    names = {}
    collisions = 0
    for p in packs:
        f = p.get('file')
        if f not in index_by_file:
            continue
        fp = os.path.join(lib, f)
        try:
            pack = json.load(open(fp, encoding='utf-8'))
        except Exception:
            continue
        for c in pack.get('cards') or []:
            n = ((c.get('data') or {}).get('name') or '').strip()
            if not n:
                continue
            if n in names:
                collisions += 1
                if collisions <= 8:
                    errors.append('重名卡片：%s（%s 与 %s）' % (n, names[n], f))
            names[n] = f
    builtin = set()
    for bf in glob.glob(os.path.join(ROOT, 'cards', 'pack-*.json')):
        try:
            for c in json.load(open(bf, encoding='utf-8')).get('cards') or []:
                bn = ((c.get('data') or {}).get('name') or '').strip()
                if bn:
                    builtin.add(bn)
        except Exception:
            pass
    clash = sorted(set(names) & builtin)
    if clash:
        errors.append('与内置卡重名 %d 个：%s' % (len(clash), '、'.join(clash[:6])))
    if len(names) != total:
        warns.append('有效名字 %d 个，卡 %d 张（有卡缺 name？）' % (len(names), total))

    return _report(errors, warns, len(packs), total)


def _report(errors, warns, npacks, total):
    print('校验目录：%d 个分片 / %d 张卡' % (npacks, total))
    for w in warns:
        print('  ⚠️  ' + w)
    if errors:
        for e in errors[:40]:
            print('  ❌ ' + e)
        print('\n结论：%d 个问题 ❌' % len(errors))
        return 1
    print('结论：目录与分片逐字节对齐 ✅')
    return 0


if __name__ == '__main__':
    sys.exit(main())
