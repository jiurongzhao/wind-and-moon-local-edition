#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dedupe-cards.py —— 处理批量生成带来的卡片重名。

多个分类的生成端互相看不到对方，很容易撞名字（实测「苏晚棠」同时出现在悬疑和恋爱包里）。
重名会让角色页出现两张一样的名字，用户分不清，所以必须消歧。

策略（尽量自然，不产生「苏晚棠2」这种机器味）：
  1. 保留第一次出现的名字不动；
  2. 后续重名者尝试缩短：三字名去掉中间字（苏晚棠→苏棠）、去掉末字（苏晚棠→苏晚）；
  3. 还冲突就加一个**该分类相关的单字**做后缀（悬疑→影、恋爱→心…）；
  4. 最后兜底加序号；
  5. 改名后**同步替换卡片正文里的自称**（人设/开场白/示例/系统提示），避免卡里名字对不上。

用法:
    python3 tools/dedupe-cards.py --dry-run    # 只看会改什么
    python3 tools/dedupe-cards.py              # 真的改（写回 cards/）
"""
import json
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, 'cards')

# 分类后缀字：撞名时用得上，读起来像个正常名字
SUFFIX = {
    'daily-healing': '禾', 'romance': '心', 'mystery': '影', 'wuxia': '尘',
    'scifi': '星', 'fantasy': '岚', 'campus': '夏', 'workplace': '川',
    'history': '史', 'horror': '夜', 'comedy': '乐', 'supernatural': '玄',
    'apocalypse': '野', 'cyberpunk': '霓', 'mythology': '泽', 'comfort': '暖',
}

FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes',
          'mes_example', 'system_prompt', 'creator_notes']


def rename_in_card(card, old, new):
    d = card.get('data') or {}
    for f in FIELDS:
        v = d.get(f)
        if isinstance(v, str) and old in v:
            d[f] = v.replace(old, new)
    ext = (d.get('extensions') or {}).get('fy') or {}
    for f in ('tagline',):
        v = ext.get(f)
        if isinstance(v, str) and old in v:
            ext[f] = v.replace(old, new)


def candidates(name, slug):
    out = []
    if len(name) >= 3:
        out.append(name[0] + name[2:])      # 去中间字
        out.append(name[:-1])               # 去末字
    if len(name) >= 2:
        out.append(name[0] + name[-1])
    s = SUFFIX.get(slug, '之')
    out.append(name + s)
    out.append(s + name)
    for i in range(2, 10):
        out.append(name + str(i))
    return [c for c in out if c and len(c) <= 12]


def main():
    dry = '--dry-run' in sys.argv
    files = sorted(glob.glob(os.path.join(CARDS, 'pack-*.json')))
    if not files:
        print('没有卡包文件')
        return 1

    packs = {}
    for f in files:
        with open(f, encoding='utf-8') as fh:
            packs[f] = json.load(fh)

    used = {}        # 名字 → 已占用的包
    renames = []
    for f in files:
        slug = os.path.basename(f)[len('pack-'):-len('.json')]
        for card in packs[f].get('cards') or []:
            d = card.get('data') or {}
            name = (d.get('name') or '').strip()
            if not name:
                continue
            if name not in used:
                used[name] = os.path.basename(f)
                continue
            pick = None
            for cand in candidates(name, slug):
                if cand not in used:
                    pick = cand
                    break
            if not pick:
                continue
            renames.append((os.path.basename(f), name, pick))
            rename_in_card(card, name, pick)
            d['name'] = pick
            used[pick] = os.path.basename(f)

    if not renames:
        print('没有重名，无需处理 ✅')
        return 0
    print('处理 %d 处重名：' % len(renames))
    for f, old, new in renames:
        print('  %-26s %s → %s' % (f, old, new))
    if dry:
        print('\n（--dry-run：未写回）')
        return 0
    for f in files:
        with open(f, 'w', encoding='utf-8') as fh:
            json.dump(packs[f], fh, ensure_ascii=False, indent=1)
    print('\n已写回 %d 个卡包' % len(files))
    return 0


if __name__ == '__main__':
    sys.exit(main())
