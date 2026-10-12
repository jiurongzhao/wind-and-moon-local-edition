#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check-cards.py —— 卡包校验器。

为什么需要它：卡包是批量生成的，没有校验就一定会混进空人设、重复名字、
标签写错、开场白缺失这类"灌水卡"。这个脚本把标准钉死，生成端每次自检。

用法:
    python3 tools/check-cards.py cards/pack-*.json      # 校验若干卡包
    python3 tools/check-cards.py --all                  # 校验 cards/ 下全部
    python3 tools/check-cards.py --stats                # 顺便打分类统计
"""
import json
import os
import re
import sys
import glob
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS_DIR = os.path.join(ROOT, 'cards')

CATEGORIES = [
    '日常治愈', '恋爱', '悬疑推理', '古风仙侠', '科幻未来', '奇幻冒险',
    '校园', '职场', '历史', '恐怖惊悚', '喜剧沙雕', '灵异怪谈',
    '末世生存', '赛博朋克', '神话志怪', '情感树洞',
]

KINDS = ['character', 'story']
MIN_PERSONA, MIN_GREETING, MIN_EXAMPLES = 60, 20, 40
MAX_NAME = 12


def fail(msg, errors):
    errors.append(msg)


def check_card(c, where, errors):
    if not isinstance(c, dict):
        return fail('%s: 不是对象' % where, errors)
    if c.get('spec') != 'chara_card_v2':
        fail('%s: spec 必须是 chara_card_v2' % where, errors)
    d = c.get('data')
    if not isinstance(d, dict):
        return fail('%s: 缺 data' % where, errors)

    name = (d.get('name') or '').strip()
    if not name:
        fail('%s: 缺 name' % where, errors)
    elif len(name) > MAX_NAME:
        fail('%s: name 太长（%d > %d）：%s' % (where, len(name), MAX_NAME, name), errors)

    persona = (d.get('description') or '').strip()
    if len(persona) < MIN_PERSONA:
        fail('%s[%s]: 人设太短（%d < %d）' % (where, name, len(persona), MIN_PERSONA), errors)

    greeting = (d.get('first_mes') or '').strip()
    if len(greeting) < MIN_GREETING:
        fail('%s[%s]: 开场白太短' % (where, name), errors)

    examples = (d.get('mes_example') or '').strip()
    if len(examples) < MIN_EXAMPLES:
        fail('%s[%s]: 示例对话太短' % (where, name), errors)

    sp = (d.get('system_prompt') or '').strip()
    if len(sp) < 40:
        fail('%s[%s]: system_prompt 太短' % (where, name), errors)
    if '/no_think' not in sp:
        fail('%s[%s]: system_prompt 缺 /no_think（否则 Qwen3 会先吐思考段）' % (where, name), errors)

    tags = d.get('tags') or []
    if not tags:
        fail('%s[%s]: 缺 tags' % (where, name), errors)
    for t in tags:
        if t not in CATEGORIES:
            fail('%s[%s]: 标签不在允许列表：%s' % (where, name, t), errors)

    ext = (d.get('extensions') or {}).get('fy') or {}
    if ext.get('kind') not in KINDS:
        fail('%s[%s]: extensions.fy.kind 必须是 %s' % (where, name, KINDS), errors)
    av = (ext.get('avatar') or '').strip()
    if not av or len(av) > 8:
        fail('%s[%s]: 头像 emoji 不合法' % (where, name), errors)
    temp = ext.get('temperature')
    if not isinstance(temp, (int, float)) or not (0 <= temp <= 2):
        fail('%s[%s]: temperature 非法：%r' % (where, name, temp), errors)
    if not (ext.get('tagline') or '').strip():
        fail('%s[%s]: 缺一句话简介' % (where, name), errors)
    # 剧情卡必须有 scenario
    if ext.get('kind') == 'story' and len((d.get('scenario') or '').strip()) < 30:
        fail('%s[%s]: 剧情卡必须有 scenario' % (where, name), errors)


def main():
    args = sys.argv[1:]
    stats_only = '--stats' in args
    if '--all' in args or not args:
        files = sorted(glob.glob(os.path.join(CARDS_DIR, 'pack-*.json')))
    else:
        files = [a for a in args if not a.startswith('--')]
    if not files:
        print('没有找到卡包文件（%s）' % CARDS_DIR)
        return 1

    errors = []
    names = {}
    tag_counter = Counter()
    kind_counter = Counter()
    total = 0

    for f in files:
        base = os.path.basename(f)
        try:
            with open(f, encoding='utf-8') as fh:
                pack = json.load(fh)
        except Exception as e:
            fail('%s: JSON 解析失败：%s' % (base, e), errors)
            continue
        if pack.get('spec') != 'fy_pack_v1':
            fail('%s: spec 必须是 fy_pack_v1' % base, errors)
        cards = pack.get('cards')
        if not isinstance(cards, list) or not cards:
            fail('%s: cards 必须是非空数组' % base, errors)
            continue
        declared = pack.get('count')
        if isinstance(declared, int) and declared != len(cards):
            fail('%s: count 声明 %s 与实际 %d 不符' % (base, declared, len(cards)), errors)
        for i, c in enumerate(cards):
            where = '%s#%d' % (base, i)
            check_card(c, where, errors)
            d = c.get('data') or {}
            n = (d.get('name') or '').strip()
            if n:
                if n in names:
                    fail('重名卡片：%s（%s 与 %s）' % (n, names[n], base), errors)
                names[n] = base
            for t in (d.get('tags') or []):
                tag_counter[t] += 1
            ext = (d.get('extensions') or {}).get('fy') or {}
            if ext.get('kind'):
                kind_counter[ext['kind']] += 1
            total += 1

    print('校验 %d 个卡包 / %d 张卡' % (len(files), total))
    if args and not stats_only and errors:
        for e in errors[:40]:
            print('  ❌ ' + e)
    if errors:
        print('\n结论：%d 个问题 ❌' % len(errors))
        return 1
    print('结论：全部通过 ✅')
    if stats_only or '--all' in args:
        print('\n分类分布：')
        for t in CATEGORIES:
            n = tag_counter.get(t, 0)
            bar = '█' * min(40, n // 3)
            print('  %-8s %4d  %s' % (t, n, bar))
        print('\n类型：' + ' / '.join('%s=%d' % (k, v) for k, v in kind_counter.items()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
