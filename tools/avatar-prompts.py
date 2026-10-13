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
import json, glob, os, hashlib

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

if __name__ == '__main__':
    items = build()
    ch = [i for i in items if i['kind'] == 'character']
    st = [i for i in items if i['kind'] == 'story']
    print('写出 %s' % OUT)
    print('角色主题 %d 个 / 剧情主题 %d 个 / 合计 %d' % (len(ch), len(st), len(items)))
    for i in (ch[0], ch[100], ch[300], ch[500], st[0], st[100]):
        print('\n[%s] %s' % (i['slug'], i['topic']))
        print('  ' + i['prompt'])
