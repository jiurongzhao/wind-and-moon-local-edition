# -*- coding: utf-8 -*-
"""build-avatar-index.py —— 把 cards/avatars/ 的立绘同步进 App 资源并生成索引。

产出：
  app/assets/ui/avatars/<slug>/<file>.webp     给 WebView 直接按相对路径加载
  app/assets/ui/avatars/index.json             { byTopic, byCategory }

匹配规则（App 侧）：
  1. 卡片带 topic  → 按 "<分类>|<kind>|<topic>" 精确命中专属立绘；
  2. 没带 topic    → 从同分类的图里按名字哈希挑一张（同分类内也不重样）；
  3. 该分类一张都没有 → App 退回程序化头像。
"""
import json, os, shutil, glob, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'cards', 'avatars')
MANIFEST = os.path.join(SRC, 'manifest.json')
DST = os.path.join(ROOT, 'app', 'assets', 'ui', 'avatars')
INDEX = os.path.join(DST, 'index.json')

def slug_to_tag():
    """从卡库目录拿 slug → 中文分类名（App 里存的是中文 tags）。"""
    m = {}
    cat = os.path.join(ROOT, 'cards', 'library-index.json')
    if os.path.exists(cat):
        for c in json.load(open(cat, encoding='utf-8')).get('categories', []):
            if c.get('slug'):
                m[c['slug']] = c.get('tag') or c['slug']
    return m

def main():
    man = json.load(open(MANIFEST, encoding='utf-8')) if os.path.exists(MANIFEST) else {}
    tags = slug_to_tag()
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    os.makedirs(DST, exist_ok=True)

    by_topic, by_cat = {}, {}
    n = 0
    for key, meta in man.items():
        src = os.path.join(ROOT, meta['file'])
        if not os.path.exists(src):
            continue
        slug, kind = meta['slug'], meta['kind']
        tag = tags.get(slug, slug)
        rel = 'avatars/%s/%s' % (slug, os.path.basename(src))
        out = os.path.join(ROOT, 'app', 'assets', 'ui', rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        shutil.copy2(src, out)
        by_topic['%s|%s|%s' % (tag, kind, meta['topic'])] = rel
        by_cat.setdefault('%s|%s' % (tag, kind), []).append(rel)
        n += 1

    for k in by_cat:
        by_cat[k].sort()
    idx = {
        'count': n,
        'note': '立绘包：byTopic 精确匹配，byCategory 兜底（按名字哈希挑一张）',
        'byTopic': by_topic,
        'byCategory': by_cat,
    }
    json.dump(idx, open(INDEX, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('同步 %d 张 → app/assets/ui/avatars/' % n)
    print('  byTopic %d 条 / byCategory %d 组' % (len(by_topic), len(by_cat)))
    total = sum(os.path.getsize(os.path.join(DST, p.split('avatars/', 1)[1])) for p in by_topic.values())
    print('  大小 %.1f MB' % (total / 1048576))

if __name__ == '__main__':
    main()
