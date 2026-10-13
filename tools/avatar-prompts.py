# -*- coding: utf-8 -*-
"""avatar-prompts.py —— 为卡库的每个主题生成一张立绘的出图提示词。

产出 cards/avatars/prompts.json：
  { "style": {slug: 画风模板}, "items": [{slug, tag, kind, topic, prompt, seed}] }

设计：
  * 「分类」决定 画风 / 场景 / 色调（16 套，见 STYLE）
  * 「主题」决定 人物身份（职业/局面）
  * 统一后缀保证构图一致：半身、居中、深色背景、无文字水印
中文优先——智谱 CogView-3-Flash、硅基流动 FLUX/Kolors 都吃中文，效果比机翻英文好。
"""
import json, glob, os, hashlib, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, 'cards', 'library')
OUT = os.path.join(ROOT, 'cards', 'avatars', 'prompts.json')

# 每个分类：场景 + 色调 + 质感
STYLE = {
    'daily-healing': '自然暖光，清新柔和的配色，治愈系日常氛围，画面干净通透',
    'romance':       '柔和逆光与暖色光斑，浅景深，浪漫细腻的氛围',
    'mystery':       '冷灰与暖黄对比，雨夜湿润质感，黑色电影氛围，克制而压抑',
    'wuxia':         '薄雾与月色，水墨与工笔结合的笔触，东方仙侠气韵',
    'scifi':         '冷蓝与青色光，金属与全息质感，硬科幻氛围',
    'fantasy':       '壁炉暖光与烛火，厚涂奇幻笔触，古老神秘的氛围',
    'campus':        '明亮自然光，清新写实的配色，青春气息',
    'workplace':     '冷白日光灯，低饱和都市写实，克制冷静的氛围',
    'history':       '绢本质感，古画配色，克制的暖褐，中国古代气韵',
    'horror':        '昏暗冷光与深重阴影，低饱和，压抑不安的恐怖氛围',
    'comedy':        '高饱和明亮色彩，轻松夸张的喜剧氛围',
    'supernatural':  '潮湿雾气与昏黄路灯，低饱和绿灰，民俗灵异的阴冷氛围',
    'apocalypse':    '尘埃逆光与锈蚀质感，土黄与灰绿，写实粗粝的生存氛围',
    'cyberpunk':     '雨夜霓虹，紫红与青蓝强对比，义体与广告牌反光，赛博朋克氛围',
    'mythology':     '灯笼与云雾，朱砂与墨色，中式志怪与飘渺仙气',
    'comfort':       '一盏灯的暖光，低对比，温柔克制的情绪',
}

# 统一约束：单张像图标一样干净，构图一致；否定式写成"不要X"模型更容易吃
# 画风锚点：实测 CogView-3-Flash 对"二次元厚涂"响应最好，纯"精致厚涂"会发糊
SUFFIX = ('二次元厚涂插画，精细五官，赛璐璐与厚涂结合，国漫风格，强烈光影。'
          '头像肖像，胸口以上，脸部位于画面正中，深色简洁背景。'
          '画面中不要出现任何文字、招牌、字幕、水印、签名、边框，只有一个人物')

# 剧情卡：不是人，是局面/场景，用气氛海报的写法
STORY_SUFFIX = ('电影级构图与光影，厚涂插画，强烈的情绪氛围，画面中不出现清晰人脸。'
                '不要文字、水印、签名、边框')

def topic_seed(slug, topic):
    h = hashlib.sha256((slug + '|' + topic).encode('utf-8')).hexdigest()
    return int(h[:8], 16) % 2000000000

# ------------------------------------------------- 每卡一条（16,000 张角色卡各一张图标）
#
# 主题级 prompt 的问题是：一个主题平均 31.6 张卡共用一个身份，
# 出图必然撞脸。好在卡库里 16,000 个名字 100% 不重复，且每张卡都带
# personality（一句话人设）和几百字的 description（随身物件/习惯/口头禅）。
# 所以「名字 + 主题 + 一句话人设 + 从描述里按名字哈希挑一句细节」就足以
# 让每张卡的 prompt 各不相同，而且是对得上卡的内容的。

def card_seed(slug, name):
    h = hashlib.sha256(('card|%s|%s' % (slug, name)).encode('utf-8')).hexdigest()
    return int(h[:8], 16) % 2000000000

def clip(text, limit=42):
    """把挑出来的细节压到一句话的长度——图像模型对超长括号串不敏感，反而会糊。"""
    text = re.sub(r'[（）()]', '', text or '').strip()
    # 卡库里这些承上启下的口头标记对画面没意义，去掉更干净
    text = re.sub(r'^(再细看|还有一点|还有一件事|另外|补充说明|补充|同时|以及|对了)[：:，,]?', '', text)
    text = text.lstrip('。，,：:、;；').strip()
    if len(text) <= limit:
        return text
    cut = max(text.rfind('，', 0, limit), text.rfind('、', 0, limit))
    return text[:cut] if cut >= 12 else text[:limit]

def pick_sentences(text, name, k=1, minlen=8):
    """从 description 里按名字哈希挑 k 句，保证同一张卡每次都挑到同一句。"""
    parts = [p.strip() for p in re.split(r'[。！？；\n）)]', text or '') if len(p.strip()) >= minlen]
    if not parts:
        return []
    start = int(hashlib.sha256(name.encode('utf-8')).hexdigest()[:4], 16) % len(parts)
    return [parts[(start + i) % len(parts)] for i in range(k)]

def build_per_card(slug_filter='', kind_filter=''):
    items = []
    for kind in ('character', 'story'):
        if kind_filter and kind != kind_filter:
            continue
        for f in sorted(glob.glob(os.path.join(LIB, '*-%s-*.json' % kind))):
            slug = os.path.basename(f).split('-' + kind + '-')[0]
            if slug_filter and slug != slug_filter:
                continue
            d = json.load(open(f, encoding='utf-8'))
            style = STYLE.get(slug, '')
            tag = d.get('name', '').split(' · ')[0]
            for c in d.get('cards', []):
                cd = c.get('data', {}) or {}
                name = (cd.get('name') or '').strip()
                if not name:
                    continue
                ext = (cd.get('extensions', {}) or {}).get('fy', {}) or {}
                topic = (ext.get('topic') or '').strip()
                persona = (cd.get('personality') or '').strip().rstrip('。')
                # personality 常常就是把主题复述一遍（"水站看表的。……"），这种就别塞进 prompt 占位
                if persona and topic and persona.startswith(topic[:4]):
                    persona = persona[len(topic):].lstrip('。，,：: ')
                detail = clip('；'.join(pick_sentences(cd.get('description'), name, 1)))
                head = ('性格：%s。' % persona) if persona else ''
                tail = ('细节：%s。' % detail) if detail else ''
                if kind == 'character':
                    prompt = '人物立绘：%s，%s。%s%s%s。%s' % (
                        name, topic or '无名者', head, tail, style, SUFFIX)
                else:
                    prompt = '场景气氛图：%s（%s）。%s%s。%s' % (
                        name, topic or '某个时刻', tail, style, STORY_SUFFIX)
                items.append({'slug': slug, 'tag': tag, 'kind': kind, 'topic': topic,
                              'name': name, 'prompt': prompt,
                              'seed': card_seed(slug, name)})
    return items

def build():
    items = []
    for kind in ('character', 'story'):
        for f in sorted(glob.glob(os.path.join(LIB, '*-%s-*.json' % kind))):
            slug = os.path.basename(f).split('-' + kind + '-')[0]
            d = json.load(open(f, encoding='utf-8'))
            style = STYLE.get(slug, '')
            for t in d.get('topics', []):
                if kind == 'character':
                    # 结构：主体 → 职业特征 → 画风 → 构图约束（图像模型比一整句长句更好吃）
                    prompt = '人物立绘：%s。其典型形象、神态与随身物件；%s。%s' % (t, style, SUFFIX)
                else:
                    prompt = '场景气氛图：%s。%s。%s' % (t, style, STORY_SUFFIX)
                items.append({
                    'slug': slug, 'tag': d.get('name', '').split(' · ')[0],
                    'kind': kind, 'topic': t, 'prompt': prompt,
                    'seed': topic_seed(slug, t),
                })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fp:
        json.dump({'style': STYLE, 'suffix': SUFFIX, 'items': items}, fp, ensure_ascii=False, indent=1)
    return items

PER_CARD_OUT = os.path.join(ROOT, 'cards', 'avatars', 'prompts-percard.json')

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--per-card', action='store_true', help='每张卡一条 prompt（默认每个主题一条）')
    ap.add_argument('--slug', default='', help='只处理某个分类')
    ap.add_argument('--kind', default='', choices=['', 'character', 'story'])
    ap.add_argument('--dry-run', action='store_true', help='只打印，不写文件')
    a = ap.parse_args()

    if a.per_card:
        items = build_per_card(a.slug, a.kind)
        ch = [i for i in items if i['kind'] == 'character']
        st = [i for i in items if i['kind'] == 'story']
        if not a.dry_run:
            with open(PER_CARD_OUT, 'w', encoding='utf-8') as fp:
                json.dump({'style': STYLE, 'suffix': SUFFIX, 'items': items},
                          fp, ensure_ascii=False, indent=1)
            print('写出 %s' % PER_CARD_OUT)
        print('角色卡 %d 张 / 剧情卡 %d 张 / 合计 %d' % (len(ch), len(st), len(items)))
        if ch:
            t0 = ch[0]['topic']
            same = [i for i in ch if i['topic'] == t0][:3]
            print('\n== 同一个主题「%s」下三张不同的卡，prompt 各不相同 ==' % t0)
            for i in same:
                print('\n[%s] %s' % (i['slug'], i['name']))
                print('  ' + i['prompt'])
        if st:
            print('\n== 剧情卡示例 ==')
            print('[%s] %s' % (st[0]['slug'], st[0]['name']))
            print('  ' + st[0]['prompt'])
        raise SystemExit(0)

    items = build()
    ch = [i for i in items if i['kind'] == 'character']
    st = [i for i in items if i['kind'] == 'story']
    print('写出 %s' % OUT)
    print('角色主题 %d 个 / 剧情主题 %d 个 / 合计 %d' % (len(ch), len(st), len(items)))
    for i in (ch[0], ch[100], ch[300], ch[500], st[0], st[100]):
        print('\n[%s] %s' % (i['slug'], i['topic']))
        print('  ' + i['prompt'])
