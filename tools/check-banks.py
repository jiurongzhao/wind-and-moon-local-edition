#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check-banks.py —— 素材库校验器（生成器的输入闸门）。

为什么要有它：`gen-cards.py` 只会"尽力而为"——某个字段少了、条目写成名词短语、
`plot_models` 只有三拍，它照样能拼出卡来，只是拼出来的东西读着别扭。
这个脚本把素材库的形状钉死，缺什么直接报错。

用法：
    python3 tools/check-banks.py            # 校验 cards/banks/*.json
    python3 tools/check-banks.py --stats    # 顺便打每类的条数表
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BANKS = os.path.join(ROOT, 'cards', 'banks')

CATEGORIES = [
    ('daily-healing', '日常治愈'), ('romance', '恋爱'), ('mystery', '悬疑推理'),
    ('wuxia', '古风仙侠'), ('scifi', '科幻未来'), ('fantasy', '奇幻冒险'),
    ('campus', '校园'), ('workplace', '职场'), ('history', '历史'),
    ('horror', '恐怖惊悚'), ('comedy', '喜剧沙雕'), ('supernatural', '灵异怪谈'),
    ('apocalypse', '末世生存'), ('cyberpunk', '赛博朋克'), ('mythology', '神话志怪'),
    ('comfort', '情感树洞'),
]

# 字段 → 最少条数
# v2 把门槛整体抬高：卡库要"每张卡文本翻倍"，靠的就是素材库够厚
# （habits / reputation 是新增字段，专门喂人设的后半段）。
MIN = {
    'tropes': 20, 'plot_models': 14, 'roles': 30, 'axes': 24, 'flaws': 22,
    'cares': 22, 'hooks': 22, 'scenes': 26, 'voice': 18, 'voice_address': 10,
    'voice_tics': 14, 'details': 30, 'actions': 24, 'places': 22, 'things': 22,
    'openings': 22, 'system_musts': 10, 'system_avoids': 10, 'names': 40,
    'habits': 18, 'reputation': 18,
    'public_domain_sources': 10, 'trope_references': 7, 'do_not': 8,
}
# 这些字段必须"能独立成句"（否则拼进人设就是病句）
CLAUSE_FIELDS = ('flaws', 'cares', 'hooks', 'scenes', 'details', 'habits', 'reputation')
# 这些字段不能用句号结尾（会被当句子片段拼进去）
NO_PERIOD = ('voice', 'axes', 'actions', 'places', 'things')
# 喂给生成器的字段里不许出现"还在版权期作品"的专有名词/角色名 ——
# 登记表（public_domain_sources / trope_references / do_not）里点名是引用，另当别论。
COPYRIGHT_BAN = (
    '哈利', '霍格沃茨', '纳尼亚', '魔戒', '指环王', '霍比特', '甘道夫', '索伦',
    '米老鼠', '唐老鸭', '迪士尼', '冰雪奇缘', '艾莎', '蜘蛛侠', '蝙蝠侠', '超人',
    '星球大战', '尤达', '黑武士', '维尼熊', '小王子', '夏洛的网', '姆明',
)


def main():
    stats = '--stats' in sys.argv
    only = set()
    if '--only' in sys.argv:
        i = sys.argv.index('--only')
        if i + 1 < len(sys.argv):
            only = {x.strip() for x in sys.argv[i + 1].split(',') if x.strip()}
    errors = []
    warns = []
    rows = []
    for slug, tag in CATEGORIES:
        if only and slug not in only:
            continue
        p = os.path.join(BANKS, slug + '.json')
        if not os.path.exists(p):
            errors.append('缺素材库：%s（%s）' % (slug + '.json', tag))
            continue
        try:
            with open(p, encoding='utf-8') as f:
                d = json.load(f)
        except Exception as e:
            errors.append('%s: JSON 解析失败：%s' % (slug, e))
            continue
        if d.get('tag') != tag:
            errors.append('%s: tag 应为 %s，实际 %r' % (slug, tag, d.get('tag')))
        counts = {}
        for f, want in MIN.items():
            v = d.get(f)
            if not isinstance(v, list) or not v:
                errors.append('%s: 缺字段 %s' % (slug, f))
                continue
            counts[f] = len(v)
            if len(v) < want:
                errors.append('%s.%s 只有 %d 条（至少 %d）' % (slug, f, len(v), want))
        # 细节形状
        for f in CLAUSE_FIELDS:
            for item in (d.get(f) or []):
                t = item if isinstance(item, str) else (item.get('title') if isinstance(item, dict) else '')
                if t and len(t) < 6:
                    errors.append('%s.%s 条目太短（不会是完整句子）：%r' % (slug, f, t))
        for f in NO_PERIOD:
            for item in (d.get(f) or []):
                # 结尾带句号无所谓（生成器会 rstrip）；真正要拦的是"把模板标签也写进条目"
                if isinstance(item, str) and re.match(r'^(说话方式|性格|缺点|最在意)[:：]', item.strip()):
                    errors.append('%s.%s 条目带了模板标签：%r' % (slug, f, item[:24]))
        # 剧情结构必须是 4~5 拍
        for m in (d.get('plot_models') or []):
            beats = (m or {}).get('beats') or []
            if len(beats) < 4:
                errors.append('%s.plot_models「%s」只有 %d 拍（至少要 4 拍：局面/升级/反转/代价）'
                              % (slug, (m or {}).get('name', '?'), len(beats)))
            if not (m or {}).get('name'):
                errors.append('%s.plot_models 有一条没有 name' % slug)
        # 开场白必须是「（动作）+ 一句话」
        for o in (d.get('openings') or []):
            if isinstance(o, str) and not re.match(r'^[（(]', o.strip()):
                errors.append('%s.openings 应以「（动作）」开头：%r' % (slug, o[:24]))
        # 喂给生成器的文本里不许有"还在版权期作品"的专有名词（登记表除外）
        for f in MIN:
            if f in ('public_domain_sources', 'trope_references', 'do_not'):
                continue
            for item in (d.get(f) or []):
                t = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
                for w in COPYRIGHT_BAN:
                    if w in t:
                        errors.append('%s.%s 出现版权作品专有名词 %r：%r' % (slug, f, w, t[:32]))
                        break
        # 名字与内置 160 张不能撞
        builtin = set()
        for f in glob.glob(os.path.join(ROOT, 'cards', 'pack-*.json')):
            with open(f, encoding='utf-8') as fh:
                for c in json.load(fh).get('cards', []):
                    n = (c.get('data') or {}).get('name')
                    if n:
                        builtin.add(n)
        dup = [n for n in (d.get('names') or []) if n in builtin]
        if dup:
            # 不算错误：生成器的 NamePool 会把内置卡用过的名字跳过，只是这些名字白写了
            warns.append('%s.names 有 %d 个与内置卡重名（生成时会被跳过）：%s'
                         % (slug, len(dup), '、'.join(dup[:5])))
        rows.append((slug, tag, counts, len(d.get('names') or [])))

    print('校验 %d 个素材库' % len(rows))
    if stats:
        fields = list(MIN.keys())
        print('  %-14s %s' % ('slug', ' '.join(f[:6] for f in fields[:10])))
        for slug, tag, c, nn in rows:
            print('  %-14s %s' % (slug, ' '.join(str(c.get(f, 0)) for f in fields[:10])))
    for w in warns:
        print('  ⚠️  ' + w)
    if errors:
        for e in errors[:60]:
            print('  ❌ ' + e)
        print('\n结论：%d 个问题 ❌' % len(errors))
        return 1
    print('结论：全部通过 ✅（%d 类）' % len(rows))
    return 0


if __name__ == '__main__':
    sys.exit(main())
