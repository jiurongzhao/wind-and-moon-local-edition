#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check-creator.py —— 创作者工具模板库校验器。

为什么需要它：分类体系（taxonomy）、骨架（templates）、写作要点（guides）是三份
分开维护的 JSON，靠"分类 tag"这个字符串对齐。一旦哪边多一个、少一个、改个错别字，
App 不会报错，只会安静地少给一套骨架或一段要点 —— 这种坏法最难发现。
所以这里把三份数据的对齐关系和字段完整性钉死。

用法:
    python3 tools/check-creator.py            # 校验
    python3 tools/check-creator.py --stats    # 顺便打每个分类的骨架/要点统计
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'app', 'assets', 'ui', 'creator')
CARDS_INDEX = os.path.join(ROOT, 'cards', 'index.json')

SKELETON_FIELDS = ['title', 'who', 'axis', 'voice', 'flaw', 'care', 'hook', 'scene']
GUIDE_FIELDS = ['must', 'avoid', 'voice', 'openers', 'exampleHint']
VOICE_FIELDS = ['address', 'tics', 'pattern']
MIN_SKELETONS = 3
MIN_MUST, MIN_AVOID, MIN_OPENERS = 3, 3, 2


def load(name, errors):
    p = os.path.join(DIR, name)
    if not os.path.exists(p):
        errors.append('缺文件：%s' % p)
        return None
    try:
        with open(p, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception as e:
        errors.append('%s: JSON 解析失败：%s' % (name, e))
        return None


def check_taxonomy(tax, errors):
    if tax is None:
        return []
    if tax.get('spec') != 'fy_creator_taxonomy_v1':
        errors.append('taxonomy: spec 必须是 fy_creator_taxonomy_v1')
    if not str(tax.get('license') or '').startswith('CC0'):
        errors.append('taxonomy: license 应为 CC0-1.0（产出必须可自由分发）')
    if '第三方卡片正文' not in str(tax.get('note') or ''):
        errors.append('taxonomy: note 必须写明"不包含任何第三方卡片正文"的边界')
    cats = tax.get('categories')
    if not isinstance(cats, list) or len(cats) != 16:
        errors.append('taxonomy: categories 必须是 16 个（实际 %s）' % (len(cats) if isinstance(cats, list) else 'N/A'))
        return []
    tags = []
    for i, c in enumerate(cats):
        where = 'taxonomy[%d]' % i
        tag = c.get('tag')
        if not tag:
            errors.append('%s: 缺 tag' % where)
            continue
        tags.append(tag)
        for k in ('slug', 'emoji', 'blurb', 'coreTension'):
            if not str(c.get(k) or '').strip():
                errors.append('%s[%s]: 缺 %s' % (where, tag, k))
        if c.get('defaultKind') not in ('character', 'story'):
            errors.append('%s[%s]: defaultKind 必须是 character/story' % (where, tag))
        t = c.get('defaultTemp')
        if not isinstance(t, (int, float)) or not (0 <= t <= 2):
            errors.append('%s[%s]: defaultTemp 非法：%r' % (where, tag, t))
        st = c.get('suggestedTags')
        if not isinstance(st, list) or not st:
            errors.append('%s[%s]: 缺 suggestedTags' % (where, tag))
        elif tag not in st:
            errors.append('%s[%s]: suggestedTags 里应当包含自己' % (where, tag))
    if len(set(tags)) != len(tags):
        dup = [t for t in set(tags) if tags.count(t) > 1]
        errors.append('taxonomy: 分类 tag 重复：%s' % '、'.join(dup))
    return tags


def check_templates(tpl, tags, errors):
    if tpl is None:
        return {}
    if tpl.get('spec') != 'fy_creator_templates_v1':
        errors.append('templates: spec 必须是 fy_creator_templates_v1')
    if not str(tpl.get('license') or '').startswith('CC0'):
        errors.append('templates: license 应为 CC0-1.0')
    sk = tpl.get('skeletons')
    if not isinstance(sk, dict):
        errors.append('templates: 缺 skeletons 对象')
        return {}
    for tag in tags:
        arr = sk.get(tag)
        if not isinstance(arr, list):
            errors.append('templates: 分类「%s」没有骨架' % tag)
            continue
        if len(arr) < MIN_SKELETONS:
            errors.append('templates: 分类「%s」只有 %d 个骨架（至少 %d）' % (tag, len(arr), MIN_SKELETONS))
        seen_titles = set()
        for j, s in enumerate(arr):
            where = 'templates[%s][%d]' % (tag, j)
            if not isinstance(s, dict):
                errors.append('%s: 不是对象' % where)
                continue
            for f in SKELETON_FIELDS:
                if not str(s.get(f) or '').strip():
                    errors.append('%s: 缺 %s' % (where, f))
            title = str(s.get('title') or '')
            if title in seen_titles:
                errors.append('%s: 骨架标题重复：%s' % (where, title))
            seen_titles.add(title)
            if len(str(s.get('who') or '')) < 8:
                errors.append('%s: who 太短（骨架要足够具体才有用）' % where)
    extra = [k for k in sk if k not in tags]
    if extra:
        errors.append('templates: 有多余分类（taxonomy 里没有）：%s' % '、'.join(extra))
    return sk


def check_guides(gd, tags, errors):
    if gd is None:
        return {}
    if gd.get('spec') != 'fy_creator_guides_v1':
        errors.append('guides: spec 必须是 fy_creator_guides_v1')
    if not str(gd.get('license') or '').startswith('CC0'):
        errors.append('guides: license 应为 CC0-1.0')
    g = gd.get('guides')
    if not isinstance(g, dict):
        errors.append('guides: 缺 guides 对象')
        return {}
    for tag in tags:
        one = g.get(tag)
        if not isinstance(one, dict):
            errors.append('guides: 分类「%s」没有写作要点' % tag)
            continue
        for f in GUIDE_FIELDS:
            if f not in one:
                errors.append('guides[%s]: 缺 %s' % (tag, f))
        for f, need in (('must', MIN_MUST), ('avoid', MIN_AVOID), ('openers', MIN_OPENERS)):
            arr = one.get(f)
            if not isinstance(arr, list) or len(arr) < need:
                errors.append('guides[%s]: %s 至少 %d 条' % (tag, f, need))
            elif any(not str(x).strip() for x in arr):
                errors.append('guides[%s]: %s 有空条目' % (tag, f))
        v = one.get('voice')
        if not isinstance(v, dict):
            errors.append('guides[%s]: voice 必须是对象' % tag)
        else:
            for f in VOICE_FIELDS:
                if not str(v.get(f) or '').strip():
                    errors.append('guides[%s]: voice 缺 %s' % (tag, f))
    extra = [k for k in g if k not in tags]
    if extra:
        errors.append('guides: 有多余分类：%s' % '、'.join(extra))
    return g


def check_reference(ref, errors):
    if ref is None:
        return []
    if ref.get('spec') != 'fy_creator_reference_v1':
        errors.append('reference: spec 必须是 fy_creator_reference_v1')
    srcs = ref.get('sources')
    if not isinstance(srcs, list) or not srcs:
        errors.append('reference: sources 必须是非空数组')
        return []
    ids = []
    for i, s in enumerate(srcs):
        where = 'reference[%d]' % i
        for k in ('id', 'name', 'kind', 'license'):
            if not str(s.get(k) or '').strip():
                errors.append('%s: 缺 %s' % (where, k))
        if s.get('kind') not in ('local', 'remote'):
            errors.append('%s: kind 必须是 local/remote' % where)
        if s.get('kind') == 'remote' and not str(s.get('url') or '').startswith('https://'):
            errors.append('%s: remote 来源必须给 https 地址' % where)
        if s.get('license') in (None, '', 'unknown', '未标注'):
            errors.append('%s: 必须标出许可证，不能留空/写未标注' % where)
        ids.append(s.get('id'))
    if len(set(ids)) != len(ids):
        errors.append('reference: id 重复')
    if not any(s.get('kind') == 'local' for s in srcs):
        errors.append('reference: 至少要有一个离线（local）来源，否则断网就没有参考面板')
    return srcs


def main():
    stats = '--stats' in sys.argv
    errors = []

    tax = load('taxonomy.json', errors)
    tpl = load('templates.json', errors)
    gd = load('guides.json', errors)
    ref = load('reference.json', errors)

    tags = check_taxonomy(tax, errors)
    sk = check_templates(tpl, tags, errors)
    gg = check_guides(gd, tags, errors)
    srcs = check_reference(ref, errors)

    # 与内置卡包对齐：分类必须就是卡包的那 16 个分类名
    if os.path.exists(CARDS_INDEX):
        try:
            with open(CARDS_INDEX, encoding='utf-8') as fh:
                idx = json.load(fh)
            pack_names = [p.get('name') for p in idx.get('packs', [])]
            if pack_names and tags:
                missing = [t for t in pack_names if t not in tags]
                extra = [t for t in tags if t not in pack_names]
                if missing:
                    errors.append('与内置卡包对不上：卡包有但分类体系没有：%s' % '、'.join(missing))
                if extra:
                    errors.append('与内置卡包对不上：分类体系有但卡包没有：%s' % '、'.join(extra))
        except Exception as e:
            errors.append('读 cards/index.json 失败：%s' % e)

    print('校验创作者工具模板库（%d 个分类）' % len(tags))
    if errors:
        for e in errors[:40]:
            print('  ❌ ' + e)
        print('\n结论：%d 个问题 ❌' % len(errors))
        return 1
    print('结论：全部通过 ✅')
    if stats:
        print('\n分类：骨架 / 必须 / 别这样 / 开场式')
        for tag in tags:
            print('  %-8s %d / %d / %d / %d' % (
                tag, len(sk.get(tag, [])), len(gg.get(tag, {}).get('must', [])),
                len(gg.get(tag, {}).get('avoid', [])), len(gg.get(tag, {}).get('openers', []))))
        print('\n参考来源：%d 个（离线 %d，联网 %d）' % (
            len(srcs), sum(1 for s in srcs if s.get('kind') == 'local'),
            sum(1 for s in srcs if s.get('kind') == 'remote')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
