#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build-pack-index.py —— 把 cards/pack-*.json 汇总成卡包目录，并同步进 App 资源目录。

做两件事：
  1) 生成 cards/index.json —— 卡包目录（名字/张数/标签/许可/emoji/简介）
  2) 同步到 app/assets/ui/packs/ —— 这样卡包随 APK 内置，用户一键导入

用法:
    python3 tools/build-pack-index.py            # 构建 + 同步
    python3 tools/build-pack-index.py --check    # 只校验不同步
"""
import json
import os
import shutil
import sys
import glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, 'cards')
APP_PACKS = os.path.join(ROOT, 'app', 'assets', 'ui', 'packs')

# 分类 → emoji / 一句介绍（目录里展示用）
META = {
    'daily-healing': ('🌤', '日常、治愈、慢生活：适合睡前随便聊两句'),
    'romance': ('💗', '恋爱线：暧昧、告白、异地、久别重逢'),
    'mystery': ('🔍', '悬疑推理：案件、线索、审讯与反转'),
    'wuxia': ('⚔️', '古风仙侠：江湖恩怨、门派、修行与旧约'),
    'scifi': ('🛰', '科幻未来：飞船、AI、深空与伦理困境'),
    'fantasy': ('🐉', '奇幻冒险：剑与魔法、公会、遗迹与巨龙'),
    'campus': ('🎒', '校园：教室、社团、晚自习与青春期的心事'),
    'workplace': ('💼', '职场：项目、加班、甲方与办公室政治'),
    'history': ('📜', '历史：朝代里具体的人，细节都有出处'),
    'horror': ('🕯', '恐怖惊悚：密室、规则怪谈、步步紧逼'),
    'comedy': ('🤣', '喜剧沙雕：无厘头、整活、脱线日常'),
    'supernatural': ('👻', '灵异怪谈：都市传说、民俗禁忌、阴阳两界'),
    'apocalypse': ('☢️', '末世生存：废墟、物资、人心与活下去'),
    'cyberpunk': ('🌃', '赛博朋克：义体、财团、霓虹与底层'),
    'mythology': ('🐚', '神话志怪：山海经、妖怪、香火与因果'),
    'comfort': ('🫂', '情感树洞：倾诉、陪伴、被认真听见'),
}


def main():
    check_only = '--check' in sys.argv
    files = sorted(glob.glob(os.path.join(CARDS, 'pack-*.json')))
    if not files:
        print('cards/ 下没有卡包文件')
        return 1

    packs = []
    total = 0
    problems = []
    for f in files:
        base = os.path.basename(f)
        slug = base[len('pack-'):-len('.json')]
        try:
            with open(f, encoding='utf-8') as fh:
                pack = json.load(fh)
        except Exception as e:
            problems.append('%s: %s' % (base, e))
            continue
        cards = pack.get('cards') or []
        if not cards:
            problems.append('%s: 没有卡片' % base)
            continue
        tags = []
        kinds = {'character': 0, 'story': 0}
        for c in cards:
            d = c.get('data') or {}
            for t in (d.get('tags') or []):
                if t not in tags:
                    tags.append(t)
            k = ((d.get('extensions') or {}).get('fy') or {}).get('kind')
            if k in kinds:
                kinds[k] += 1
        emoji, desc = META.get(slug, ('📦', ''))
        n = len(cards)
        total += n
        story = kinds['story']
        packs.append({
            'file': base,
            'slug': slug,
            'name': pack.get('name') or slug,
            'emoji': emoji,
            'desc': desc,
            'count': n,
            'story': story,
            'tags': tags,
            'license': pack.get('license') or 'CC0-1.0',
        })

    packs.sort(key=lambda p: (-p['count'], p['slug']))
    index = {
        'spec': 'fy_pack_index_v1',
        'note': '内置卡包目录 · 全部由「风月·本地版」原创生成（AI 辅助创作），CC0-1.0 许可，可自由使用/修改/分发',
        'total': total,
        'packs': packs,
    }

    print('卡包 %d 个 / 卡片 %d 张（其中剧情卡 %d 张）'
          % (len(packs), total, sum(p['story'] for p in packs)))
    for p in packs:
        print('  %s %-8s %3d 张  剧情 %d  %s' % (p['emoji'], p['name'], p['count'], p['story'], '/'.join(p['tags'])))
    if problems:
        print('\n有问题：')
        for x in problems:
            print('  ❌ ' + x)
        return 1

    if check_only:
        print('\n（--check：未写入文件）')
        return 0

    with open(os.path.join(CARDS, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
    print('\n已写 cards/index.json')

    os.makedirs(APP_PACKS, exist_ok=True)
    for f in files:
        shutil.copy2(f, os.path.join(APP_PACKS, os.path.basename(f)))
    with open(os.path.join(APP_PACKS, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
    size = sum(os.path.getsize(os.path.join(APP_PACKS, x)) for x in os.listdir(APP_PACKS))
    print('已同步 %d 个文件到 app/assets/ui/packs/（%.0f KB，会打进 APK）'
          % (len(os.listdir(APP_PACKS)), size / 1024.0))
    return 0


if __name__ == '__main__':
    sys.exit(main())
