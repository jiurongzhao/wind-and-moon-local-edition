#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gen-cards.py —— 内置卡库的组合生成器。

为什么要有它：手写 160 张还能靠人；要做到「每分类 1000 张角色卡 + 1000 张剧情卡」
（16 类 = 32000 张），就必须是**素材库 + 组合生成**，而且要能被审计、能复现。

输入：
    cards/banks/<slug>.json   每分类的叙事母题素材库（结构级，全部原创措辞）
    cards/pack-*.json         已发布的 160 张内置卡（用来避开重名）

输出（默认写到 cards/library/，这个目录不进仓库，只作为发布附件）：
    <slug>-<kind>-<part>.json   卡包分片（按主题打包，默认每片约 250 张）
    index.json                  在线卡库目录（fy_library_v2：每片的 sha256 / 字节数 /
                                主题 topics / 关键词 keywords / 下载路径）
    audit.json                  多样性审计报告（长度分布、卡内重复、句长、与内置卡对照…）

用法：
    python3 tools/gen-cards.py --per-kind 20 --out /tmp/sample     # 先出小样
    python3 tools/gen-cards.py --only mystery,romance               # 只生成某几个分类
    python3 tools/gen-cards.py --per-kind 1000                      # 正式放量
    python3 tools/gen-cards.py --audit cards/library                # 只审计已生成的东西

设计要点（都是踩过的坑）：
  1. **不用纯随机抽样**，用「洗牌牌堆」(Deck)：每轮把素材库打乱后依次取，取完再洗。
     这样保证每个素材都被均匀用到，也不会出现连续三张卡用同一条缺点。
  2. **组合指纹去重**：把 (role, axis, flaw, care, hook, scene) 做个签名放进集合，
     撞了就重摇。这比 32k×32k 的两两相似度便宜得多，而且更硬。
  3. **名字全局唯一**：内置 160 张的名字先占坑；角色名走「姓氏池 × 名字池」，
     剧情名走「标题语法」（地名/物件/数字/事件），避免 2000 张挤 40 个名字。
  4. **审计不是为了好看**：真去统计 12-gram 覆盖率、槽位使用分布、抽样相似度；
     模板味太重会在 audit 里直接暴露出来。
"""

import argparse
import glob
import hashlib
import json
import os
import random
import re
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BANKS_DIR = os.path.join(ROOT, 'cards', 'banks')
LIB_DIR = os.path.join(ROOT, 'cards', 'library')
BUILTIN_GLOB = os.path.join(ROOT, 'cards', 'pack-*.json')

CATEGORIES = [
    ('daily-healing', '日常治愈', '🌤'), ('romance', '恋爱', '💗'),
    ('mystery', '悬疑推理', '🔍'), ('wuxia', '古风仙侠', '⚔️'),
    ('scifi', '科幻未来', '🛰'), ('fantasy', '奇幻冒险', '🐉'),
    ('campus', '校园', '🎒'), ('workplace', '职场', '💼'),
    ('history', '历史', '📜'), ('horror', '恐怖惊悚', '🕯'),
    ('comedy', '喜剧沙雕', '🤣'), ('supernatural', '灵异怪谈', '👻'),
    ('apocalypse', '末世生存', '☢️'), ('cyberpunk', '赛博朋克', '🌃'),
    ('mythology', '神话志怪', '🐚'), ('comfort', '情感树洞', '🫂'),
]
TAG_BY_SLUG = {s: t for s, t, _ in CATEGORIES}
EMOJI_BY_SLUG = {s: e for s, _, e in CATEGORIES}
SLUG_BY_TAG = {t: s for s, t, _ in CATEGORIES}

# 每类的默认温度（剧情/喜剧高一点，推理/历史低一点）
TEMP_BY_SLUG = {
    'daily-healing': 0.80, 'romance': 0.90, 'mystery': 0.75, 'wuxia': 0.85,
    'scifi': 0.80, 'fantasy': 0.90, 'campus': 0.85, 'workplace': 0.80,
    'history': 0.70, 'horror': 0.85, 'comedy': 0.95, 'supernatural': 0.85,
    'apocalypse': 0.80, 'cyberpunk': 0.85, 'mythology': 0.85, 'comfort': 0.80,
}

# 名字风格：决定用哪套姓氏/名字池
NAME_STYLE = {
    'daily-healing': 'modern', 'romance': 'modern', 'mystery': 'modern',
    'wuxia': 'ancient', 'scifi': 'code', 'fantasy': 'ancient',
    'campus': 'modern', 'workplace': 'modern', 'history': 'ancient',
    'horror': 'modern', 'comedy': 'modern', 'supernatural': 'ancient',
    'apocalypse': 'modern', 'cyberpunk': 'code', 'mythology': 'ancient',
    'comfort': 'modern',
}

# ---- 名字池（生成器自带；素材库里的 names 会优先用掉） ----
SURNAMES_MODERN = (
    '林 沈 陆 柯 周 白 顾 温 江 苏 程 傅 裴 谢 宋 许 叶 秦 方 夏 阮 季 贺 邵 严 曹 潘 杜 卫 蒋 '
    '游 詹 岑 谷 简 楼 骆 戚 舒 覃'
).split()
GIVEN_MODERN = (
    '砚 昭 一鸣 雨眠 青禾 知遥 德海 思远 予安 见川 听澜 亦舟 无恙 长庚 未晞 星野 念之 岸青 '
    '临安 归舟 小满 拾一 折枝 砚秋 若拙 肃之 沉璧 澜川 望舒 粲然 微澜 迟照 昀生 稚川 允诺 屿白 '
    '朝雨 眠川 之遥 折雪 空青 江离 木樨 松风 白露 秦淮 川流 砚白 无争 见月 拾光 知夏 澹台 云归 '
    '雪见 兰台 楚辞 燕回 竹隐 秋声 寒山 玉衡 镜湖 良宵 予怀 见山 向晚 长风 拾贰 之南 怀山 停舟 '
    '拾安 问夏 观棋 落雨 望山 知非 见微 溯溪 隐舟 拾岚 濯枝 拾微 见星 问渡 乘月 拂晓 溪云 磐石 '
    '知白 归远 拂尘 拾秋 望川 见南 拾穗 之屿 未白 时雨 见山居 长夏 空山 清和 予星 折柳 停云馆'
).split()
SURNAMES_ANCIENT = (
    '谢 裴 崔 卢 郑 薛 韦 柳 虞 卫 兰 慕容 独孤 上官 司徒 南宫 东方 皇甫 长孙 宇文 商 穆 燕 楚 '
    '宋 秦 唐 卫 姜 祁 阮 温 池 顾'
).split()
GIVEN_ANCIENT = (
    '无咎 云疏 长离 昭明 逢君 玉京 望川 听雪 砚尘 白霜 子恪 见微 承影 拂衣 拾遗 寒衣 折简 掩月 '
    '渡尘 青玄 素问 停云 落雁 沉舟 归海 望山 拾岚 醉石 疏影 怀瑾 问渠 敕勒 观澜 衔霜 悬黎 湛卢 '
    '羲和 望帝 鲛绡 长歌 檀奴 昭夜 无衣 沧溟 扶苏 兰台 白鹿 玄翎 星垂 云麾 霜华 素笺 遣怀 '
    '砚舟 惊蛰 焚舟 叩月 拾星 闻笛 补衣 引灯 埋剑 问津 照野 拾霁 抱琴 凿冰 收网 牵马 换盏 压卷 '
    '抬山 摹碑 扫径 候潮 焚稿 补天 借火 断弦 量川 垂竿 掩卷 斫琴 试墨 巡更 晒药 抚刀 涉水 结庐'
).split()
CODENAMES = (
    '白鸦 拾光 沧溟 银鲸 灰隼 烛龙 夜航 素秤 深蓝 锈鸢 量子狐 零号 千面 长夜 回声 静默 海市 '
    '罅隙 熵灯 冷杉 织网 白噪 铁鹤 孤星 弥散 蓝鲸 折光 缄默 十二 无面 潮汐 逆鳞 玻璃海 第七日 '
    '半人马 旧钟 无冬 暗涌 慢速 光栅 铜绿 秒针 归零 空号 断层 尾焰 灰阶 冷焊 硬着陆 静默区 '
    '磁偏角 零下 长曝 短路 逆熵 空白页 备用灯 折跃 悬浮 锚点 视界 哑光 拓扑 校准 惰性 收敛'
).split()

# ---- 剧情卡标题语法（剧情卡的 name 是一个局面/地点，不是人名） ----
STORY_TITLE_TPL = [
    '{place}的{num}{unit}', '第{num}{unit}{suffix}', '{place}{suffix2}',
    '{thing}·{num}', '{place}·{suffix}', '关于{thing}的{num}条{suffix3}',
    '{num}{unit}后，{place}', '{suffix4}·{place}', '{thing}的{num}{unit}',
]
PLACES = ('北山 南岸 潮汐站 旧钟楼 白塔 长夜港 第三宿舍 断桥 望海楼 地下三层 边界哨所 老糖厂 '
          '无名渡口 灰隼库房 十二号车厢 潮线以下 山阴驿 浮岛 灯塔 冷杉岭 磁带仓库 环城高架 '
          '暴雨管道 海棠巷 废弃观测站 云顶台 泥沙码头 静默区 半坡村 玻璃温室').split()
THINGS = ('种子 磁带 船票 病历 名单 钥匙 底片 账本 遗嘱 车票 编号 潮汐表 备用电池 军牌 信 契约 '
          '标本 录音带 玻璃罐 旧照片 值班表 药瓶 反锁的门 半封信').split()
UNITS = ('天 夜 小时 年 公里 个人 条规则 层 分钟 站').split()
SUFFIX = ('闭馆 停摆 熄灯 失联 断线 封路 停水 停电 换班 落锁 戒严 移交 结算 清空 下沉 断电').split()
SUFFIX2 = ('夜班 旧事 疑云 来客 规则 名单 余温 空位 回声 之外 之后 前夜').split()
SUFFIX3 = ('规矩 约定 禁忌 说法 传闻 记录 备忘').split()
SUFFIX4 = ('关于 说起 再说 回到 离开').split()
VERBS = ('亮灯 开门 下雨 回信 通航 收摊 点名 报时 说话 认人').split()

KIND_LABEL = {'character': '角色卡', 'story': '剧情卡'}


# ===========================================================================
# 工具
# ===========================================================================

def as_clause(s):
    """把素材条目变成一句完整的话（读起来不能有半截感）。"""
    s = str(s).strip()
    s = re.sub(r'^[-—·、,，\s]+', '', s)
    if not s:
        return ''
    if s[-1] not in '。！？…':
        s += '。'
    return s


# 素材库里有些条目自带标签前缀（"最在意的是…"），模板再加一次就重复了
LABEL_PREFIX = {
    'cares': ['最在意的就是', '最在意的是', '最在意的', '最在意', '心里放不下的是',
              '放不下的是', '真正在意的是', '在乎的是', '在意的就是', '在意的是', '在意'],
    'flaws': ['最大的毛病是', '毛病是', '缺点是', '软肋是', '最大的问题是'],
    'hooks': ['你和TA的起点是', '你和他的起点是', '和你的起点是', '你们的起点是', '起点是'],
}


def strip_label(field, s):
    s = str(s).strip().lstrip('：:，,。 ')
    for p in LABEL_PREFIX.get(field, []):
        if s.startswith(p):
            s = s[len(p):].lstrip('：:，,。 ')
            break
    return s.strip()


def looks_clausal(s):
    """素材条目是"一整句话"还是"一个名词短语"——决定怎么嵌进模板。"""
    s = str(s).strip()
    return len(s) > 11 or '，' in s or '。' in s or s.endswith('的')


class Deck:
    """洗牌牌堆：均匀取用素材，取完再洗，避免连续重复。"""

    def __init__(self, items, rng):
        self.items = list(items) or ['']
        self.rng = rng
        self.buf = []

    def take(self):
        if not self.buf:
            self.buf = list(self.items)
            self.rng.shuffle(self.buf)
        return self.buf.pop()

    def take_n(self, n):
        """取 n 个互不相同的素材；素材库比 n 小就只给这么多（否则会死循环——
        牌堆只有 2 条却要 3 条互不相同，洗多少次都凑不齐）。"""
        target = min(n, len(self.items))
        out = []
        guard = 0
        while len(out) < target and guard < target * 30 + 30:
            guard += 1
            v = self.take()
            if v not in out:
                out.append(v)
        return out


class Bank:
    """一个分类的素材库，带缺字段兜底（缺太多了要在校验里报出来）。"""

    REQUIRED = ['tropes', 'plot_models', 'roles', 'axes', 'flaws', 'cares', 'hooks',
                'scenes', 'voice', 'voice_address', 'voice_tics', 'details',
                'openings', 'system_musts', 'system_avoids', 'names']

    def __init__(self, slug, data, rng):
        self.slug = slug
        self.tag = data.get('tag') or TAG_BY_SLUG.get(slug, slug)
        self.emoji = EMOJI_BY_SLUG.get(slug, '🎭')
        self.temp = TEMP_BY_SLUG.get(slug, 0.85)
        self.rng = rng
        self.missing = [f for f in self.REQUIRED if not data.get(f)]
        self.raw = data
        self.roles = [r.get('title') if isinstance(r, dict) else r for r in data.get('roles') or []]
        self.role_notes = {}
        for r in data.get('roles') or []:
            if isinstance(r, dict) and r.get('title'):
                self.role_notes[r['title']] = r.get('note') or ''
        self.plot_models = data.get('plot_models') or []
        self.deck = {}
        for f in self.REQUIRED + ['public_domain_sources', 'trope_references', 'do_not',
                                  'actions', 'places', 'things', 'habits', 'reputation']:
            self.deck[f] = Deck([strip_label(f, x) if isinstance(x, str) else x
                                 for x in (data.get(f) or []) if x], rng)
        # roles 在素材库里是 {title, note}，牌堆里只放 title（note 走 role_notes 查）
        if self.roles:
            self.deck['roles'] = Deck(self.roles, rng)

    def has(self, field):
        return field in self.deck and bool(self.deck[field].items) and self.deck[field].items != ['']
        self.names = list(data.get('names') or [])

    def take(self, field):
        return self.deck[field].take() if field in self.deck else ''

    def take_n(self, field, n):
        return self.deck[field].take_n(n) if field in self.deck else [''] * n


# ===========================================================================
# 名字
# ===========================================================================

class NamePool:
    """全局唯一的名字分配器：内置 160 张先占坑，再按风格组合。"""

    def __init__(self, rng, builtin_names):
        self.rng = rng
        self.used = set(builtin_names)
        self.surname_deck = {}
        self.given_deck = {}

    def _pool(self, style):
        if style == 'ancient':
            return SURNAMES_ANCIENT, GIVEN_ANCIENT
        if style == 'code':
            return None, None
        return SURNAMES_MODERN, GIVEN_MODERN

    def _claim(self, name):
        """占坑。名字一律 strip + 不允许含空白：曾经用 random.choice('安 川 生 白 秋 舟')
        抽尾字，空格也被当成字符抽中，于是产生「卫白露 」这种带尾空格的名字 ——
        它在名字池里是"唯一"的，strip() 之后却和另一张卡撞名（发布闸门会报重名）。"""
        c = str(name).strip()
        if not c or len(c) > 12 or re.search(r'\s', c):
            return ''
        if c in self.used:
            return ''
        self.used.add(c)
        return c

    def person(self, style, preferred):
        """先试素材库里给的名字，撞了就组合，再撞就加一个尾字。"""
        for cand in preferred:
            c = self._claim(cand)
            if c:
                return c
        surnames, givens = self._pool(style)
        if style == 'code':
            for _ in range(600):
                c = self._claim(self.rng.choice(CODENAMES) if self.rng.random() < .5
                                else '%s-%d' % (self.rng.choice(CODENAMES), self.rng.randint(2, 99)))
                if c:
                    return c
        else:
            for _ in range(600):
                c = self._claim(self.rng.choice(surnames) + self.rng.choice(givens))
                if c:
                    return c
        # 兜底：加一个尾字（这里必须是列表，不能用字符串！）
        tail = ['安', '川', '生', '白', '秋', '舟', '之', '和', '野', '岚', '川', '吟']
        for _ in range(4000):
            base = (self.rng.choice(CODENAMES) if style == 'code'
                    else self.rng.choice(surnames) + self.rng.choice(givens))
            c = self._claim(base + self.rng.choice(tail))
            if c:
                return c
        raise RuntimeError('名字池耗尽')

    def story_title(self, places=None, things=None):
        places = places or PLACES
        things = things or THINGS
        for _ in range(200):
            t = self.rng.choice(STORY_TITLE_TPL).format(
                place=self.rng.choice(places), thing=self.rng.choice(things),
                num=self.rng.choice('一 二 三 四 五 六 七 八 九 十 12 24 36 7 9'.split()),
                unit=self.rng.choice(UNITS), suffix=self.rng.choice(SUFFIX),
                suffix2=self.rng.choice(SUFFIX2), suffix3=self.rng.choice(SUFFIX3),
                suffix4=self.rng.choice(SUFFIX4), verb=self.rng.choice(VERBS))
            t = re.sub(r'\s+', '', t)
            if t not in self.used and 2 <= len(t) <= 12:
                self.used.add(t)
                return t
        raise RuntimeError('标题池耗尽')


# ===========================================================================
# 文本组装
# ===========================================================================

PERSONA_TPL = [
    '{name}，{age}岁，{role}。{role_note}{axis_c}{voice_c}{flaw_c}{care_c}{hook_c}{detail_c}',
    '{name}，{age}岁。{role}——{role_note}{axis_c}{voice_c}{flaw_c}{care_c}{hook_c}{detail_c}',
    '先说清楚：{name}，{age}岁，{role}。{role_note}{axis_c}{voice_c}{flaw_c}{care_c}{hook_c}{detail_c}',
    '{name}，{age}岁，{role}。{axis_c}{role_note}{flaw_c}{voice_c}{care_c}{hook_c}{detail_c}',
    '{name}，{age}岁。做{role}这行第{tenure}年。{role_note}{axis_c}{voice_c}{flaw_c}{care_c}{hook_c}{detail_c}',
    '{name}，{age}岁，{role}。{role_note}{voice_c}{axis_c}{flaw_c}{care_c}{hook_c}{detail_c}',
]

AXIS_TPL = ['{a}。', '{a}——{name}自己也不否认。', '{a}，改不了。',
            '{a}。别人说这叫脾气，{name}说这叫记性。']
VOICE_TPL = ['{v}。', '{v}，一急就更明显。', '{v}——这是{name}一贯的说话方式。']
FLAW_TPL = ['{f}。', '毛病是：{f}。', '{f}，这一点谁劝都没用。', '{f}——而且他从不解释。']
CARE_TPL = ['最在意的是{c}。', '心里放不下的是{c}。', '真要说在意什么，是{c}。',
            '{c}——这是{name}嘴上不说、心里过不去的。', '{name}真正绕不过去的，是{c}。']
HOOK_TPL = ['你和{name}的起点是：{h}。', '{name}认识你，是从这件事开始的：{h}。',
            '你出现在{name}面前的方式是：{h}。', '你和{name}之间，是从这件事开始的：{h}。',
            '{name}第一次见你，是因为{h}。', '把你们拴在一起的是这件事：{h}。']
DETAIL_TPL_CLAUSE = ['{d}。', '还有一件事：{d}。', '（{d}）']
DETAIL_TPL_PHRASE = ['{name}随身带着{d}。', '{d}，一直没换。', '{name}身上常年有{d}。']
# 追加第二处细节时只用这两个，避免「还有一件事：…。还有一件事：…。」
DETAIL_TPL_EXTRA = ['{d}。', '（{d}）']
# 文本翻倍后一处细节不够，再补时会用到这几句（同样避免同句重复）
DETAIL_TPL_MORE = ['{d}。', '（{d}）', '还有一点：{d}。', '再细看：{d}。']

# 素材库没给 actions 时的通用舞台指示（能放进圆括号、任何分类都不违和）
GENERIC_ACTIONS = (
    '没抬头 把笔帽按上 手在桌沿敲了两下 把门带上 往椅背上一靠 顿了一下 把手里的东西放下 '
    '看了一眼窗外 把杯子往里推了推 没接话 换了个坐姿 把纸翻过来 站起身又坐下 清了清嗓子 '
    '把灯调暗一点 用手指点了点桌面 把外套搭在椅背上 把抽屉关严 往门口看了一眼 把话咽回去 '
    '把窗子推开一条缝 摘下眼镜擦了擦 把袖口往上撸 拎起包又放下 在纸角写了两个字 没有转身'
).split()

GREETING_TPL = [
    '{scene}。\n{opening}',
    '{scene}。\n{opening}\n（{action}）',
    '（{action}）{scene}。\n{opening}',
]
GREETING_TAIL = [
    '（说完这句，没有再看你，手里的动作却停了半拍）',
    '（话是硬的，动作却先让开了半步）',
    '（没催你，只是把手边的东西往旁边挪了挪，给你腾出个位置）',
    '（空气停了两秒，等着你先开口）',
]

SYSTEM_TPL = [
    '你扮演「{name}」，{tag}题材里的{role}。{voice}',
    '你扮演「{name}」，{role}，{tag}背景。{voice}',
    '你是「{name}」——{role}。{voice}',
]
# 给扮演方的创作空间：人设与示例只是"起手式"，不是剧本。
# 用户明确要求"即便完全脱离文本也没关系"，所以这句要写死在每张卡的系统提示里。
CREATIVE_FREEDOM = ('创作自由：大胆发挥——加人物、加事件、改走向、另起一条线都可以，'
                    '哪怕完全离开人设与示例里写到的具体情节也没关系；'
                    '只要人物的底色、说话方式与题材气质不跑偏就行。')

FOLLOW_UP = ('那你自己呢？', '为什么？', '你确定？', '然后呢。', '这话你信吗？',
             '你打算怎么办？', '就这么算了？', '还有谁？')
USER_LINES = ('这么晚还在？', '你不打算解释一下吗？', '要是我说不呢。', '你一直都这样？',
              '先说好，我不是来求你的。', '这件事你还管吗？', '你手怎么了？', '换个话题吧。',
              '如果我今天就想要个答案呢？', '你在这儿待了多久了？')
SHORT_LINES = ('先坐下。', '不解释。', '你猜。', '规矩就是规矩。', '这事我说了算。',
               '别急，慢慢说。', '……你倒是会挑时候。', '行，那我问你一句。',
               '别站门口，进来。', '我记性不好，你再说一遍。', '你手上那个，给我看看。',
               '今天不行。', '你想听真话还是好听的？', '嗯。', '说完了？')
SHORT_LINES2 = ('你要是不急，我这儿有热水。', '这事没完，但不是今天。',
                '记住，出了这门我什么都没说。', '别问我为什么，问了也是这个答案。',
                '以后少来，来了我也不会赶你。')

# ---- 示例对话的加长语料 ----
# v1 每段只有 55% 概率带一次追问，示例对话中位数 171 字，比内置卡（195 字）短一截；
# v2 把每段钉成两个来回、三分之二的卡再加一轮，并把回答句写长，目标中位 350 字（约翻倍）。
EXAMPLE_REPLIES = (
    '不用急，你先把话说完。', '我给不了你保证，但能给你一句实话。',
    '这事我认，别的免谈。', '你要是不信，可以自己去问一遍。',
    '先别下结论，把刚才那句再说一次。', '我做这行这么久，头一回听人这么问。',
    '话说到这儿就够了，剩下的我不接。', '你要真想弄明白，就得听点不好听的。',
    '别人的说法我不管，我只说我看见的。', '把东西放下，我们一条一条来。',
    '你问得很准，这一点我不如你。', '我记得那天有风，别的记不清了。',
    '不是我不说，是说了你也未必信。', '你要是急着走，这句就当我没说。',
    '行，就按你说的办，回头别怪我。', '我先把丑话说在前面，省得回头难看。',
    '你别看我，看东西。', '差一点就来不及了——你知道差在哪儿吗。',
    '我没什么可解释的；你要听，我陪你坐着说。',
    # 加长句：一段对话里总得有一句能"站住"的话，短句堆一起读着像吵架
    '这世上能让我半夜爬起来开门的人不多，你今天算一个，但别把这件事想得太好。',
    '我见过太多把话说满的人，最后都栽在自己那句话上，所以我说话一向留三分。',
    '你要的答案我现在给不了；不过我可以把我看到的那一部分，一句不落地讲给你听。',
    '别急着替别人下结论。你连自己昨天为什么犹豫都没想明白，怎么去断别人的事。',
    '我这一行有个规矩：不问来路，只问去处。你先把你要去哪儿说清楚，我们再谈别的。',
    '如果这事真有你说的那么简单，前前后后就不会死这么多人了——你自己想想这句话。',
    '你要真想帮他，就别在这儿跟我耗着；他现在最缺的不是你说服我，是有人替他跑一趟。',
    '我记性不好，可有些事我记一辈子：谁在什么时候伸过手，谁在什么时候把手缩回去。',
    '我没打算跟你讲道理。道理这东西谁都会讲，能把事情办成的，一个屋子里找不出第二个。',
    '回去吧。这事今天到此为止，明天你要是还这么想，就带着证据再来敲这扇门。',
    '你问我怕不怕？怕。可怕也得站着，坐下去就再也起不来了。',
    '这些话我只说一遍：你要么现在跟我走，要么从此别再打听这件事。',
)
FOLLOW_UP2 = ('那我换个问法。', '你确定要听后半段？', '这话你敢当着人说吗？',
              '最后一个问题，问完我就走。', '你刚才犹豫了。', '要不要把时间对一遍？',
              '你手上还有别的东西没拿出来。', '你打算瞒到什么时候？')
USER_LINES2 = ('我听说你那天不在。', '有人托我来问一件事。', '你先别急着撇清。',
               '我是替别人来的。', '你看起来不太意外。', '这事跟你脱不了干系吧。',
               '我把话放这儿了。', '你手上那个，是从哪儿来的？')
GREETING_LINES = (
    '屋里没开大灯，只有桌上一盏。', '外面还在下雨，声音一直没停。',
    '这地方这个点本该没人。', '门在你身后合上，风被挡在外面。',
    '桌上的东西摊了一半，像是刚翻过。', '水壶在响，没人去管它。',
    '窗玻璃上有手印，擦了一半。', '走廊的灯忽明忽暗，脚步声只有你一个。',
    '墙上的钟慢了两分钟，谁也没去调。', '烟灰缸满了，屋里没有别人。',
    '这屋里的味道，你一进门就闻到了。', '有人在你来之前刚走，椅子还是热的。',
    '窗外的天刚亮一半，屋里还留着夜里的凉。', '远处有车过去，声音在这里停了一下。',
    '桌上的茶凉了，杯口没有水痕——没人喝过。', '灯绳垂在门边，够得着，但没人去拉。',
    '地扫得很干净，只有门口那一小块是脏的。', '收音机开着，音量小到只能听见电流声。',
    '墙上贴的纸是对折过的，折痕压得很实。', '门缝底下塞着一张名片，边角被踩过。',
    '你进来的时候，说话声正好停了一拍。', '有人把手里的东西往身后挪了半寸。',
    '一屋子人，没有一个人的手是闲着的。', '椅子腿磨出的痕迹朝着同一个方向。',
    '该来的人还没来，不该来的已经坐下了。', '有人把自己那杯水推到你能够到的位置。',
    '钥匙放在桌上，谁也没伸手去拿。', '窗子开了一条缝，进来的风比外面暖。',
)
# 文本翻倍的目标：v1 实测中位 人设 220 / 开场白 119 / 示例 171（内置卡 222/117/195）
PERSONA_MIN = 450           # 约 2× 内置卡人设中位
GREETING_MIN = 250          # 约 2× 内置卡开场白中位
EXAMPLES_MIN = 350          # 约 2× 内置卡示例中位
# 人设后半段：习惯 + 旁人口碑 + 追加细节（新字段 habits / reputation 由素材库提供）
HABIT_TPL = ['{h}。', '日子过得有规律：{h}。', '习惯是{h}——很多年没变过。',
             '{h}，这一点连他自己都没察觉。']
REPUTE_TPL = ['别人眼里的{name}：{r}。', '关于{name}，外头传的是：{r}。',
              '{r}——这是旁人给的评语。', '认识{name}的人都说：{r}。',
              '要说{name}在外面的名声，一句话：{r}。']

SCENARIO_TPL = [
    '【局面】{scene}\n【要解决的事】{task}\n【为什么不能失败】{stake}\n【已经在发生的变化】{beat}\n你可以在任何一刻插话：可以谈，可以拖，也可以直接把事情推到无法回头的那一步。接下来怎么走，由你说的每一句话决定。',
    '【开局】{scene}\n【摆在桌面的问题】{task}\n【失败的代价】{stake}\n【升级的方向】{beat}\n没有人会替你决定，也没有人会把话说全。你可以站在门里，也可以站在门外——但每拖一轮，局面都会往更紧的方向走一格。',
]
TASK_PHRASES = ('把这件事在今晚之前定下来', '保住那个人，同时保住这摊子事',
                '在不撕破脸的前提下把东西要回来', '查清是谁先动的手',
                '把损失压到可承受的范围', '让两边都下得来台')


def _c(s):
    """一段话结尾一定带句号（拼接时就不会出现「……不说最在意的是」这种黏连）。"""
    s = str(s).strip()
    if not s:
        return ''
    return s if s.endswith(('。', '！', '？', '…', '）')) else s + '。'


def tic_line(bank, rng):
    tic = str(bank.take('voice_tics')).strip()
    return tic if tic.endswith(('。', '！', '？', '」')) else tic + '。'


def pick_action(bank, rng):
    a = bank.take('actions') if bank.has('actions') else ''
    a = str(a or '').strip().strip('（）()。')
    return a or rng.choice(GENERIC_ACTIONS)


def render_detail(bank, rng, name):
    d = str(bank.take('details')).strip().rstrip('。')
    if looks_clausal(d):
        return rng.choice(DETAIL_TPL_CLAUSE).format(d=d)
    return rng.choice(DETAIL_TPL_PHRASE).format(d=d, name=name)


def build_persona(bank, rng, name, role, picks, age):
    role_note = bank.role_notes.get(role) or ''
    role_note = _c(role_note) if role_note else ''
    axis_c = _c(rng.choice(AXIS_TPL).format(
        a=str(picks['axis']).strip().rstrip('。'), name=name))
    voice_c = _c(rng.choice(VOICE_TPL).format(
        v=str(picks['voice']).strip().rstrip('。'), name=name))
    flaw_c = _c(rng.choice(FLAW_TPL).format(
        f=str(picks['flaw']).strip().rstrip('。'), name=name))
    care_c = _c(rng.choice(CARE_TPL).format(
        c=str(picks['care']).strip().rstrip('。'), name=name))
    hook_c = _c(rng.choice(HOOK_TPL).format(
        h=str(picks['hook']).strip().rstrip('。'), name=name))
    detail_c = render_detail(bank, rng, name)
    if rng.random() < 0.5:               # 再补一处细节，人设长度往内置卡的中位数（约 222 字）靠
        d2 = str(bank.take('details')).strip().rstrip('。')
        extra = rng.choice(DETAIL_TPL_EXTRA).format(d=d2) if d2 else ''
        # 别把同一句话写两遍（28k 张里抓到过 1 例重复句子）
        if extra and d2 and d2 not in detail_c:
            detail_c = detail_c + extra
    tenure = rng.randint(2, max(2, min(21, age - 18)))   # 22 岁不可能"做这行第 21 年"
    out = rng.choice(PERSONA_TPL).format(
        name=name, age=age, role=role, role_note=role_note,
        tenure=tenure, axis_c=axis_c, voice_c=voice_c, flaw_c=flaw_c,
        care_c=care_c, hook_c=hook_c, detail_c=detail_c)
    out = re.sub(r'[ \t]+', '', out)
    return enrich_persona(bank, rng, out, name)


def enrich_persona(bank, rng, out, name, with_traits=True):
    """v2：人设后半段补「习惯 + 旁人口碑 + 追加细节」。

    文本翻倍（目标 PERSONA_MIN ≈ 内置卡人设中位的两倍）靠的就是这里；
    角色卡与剧情卡共用，剧情卡原本只有 250 字左右的模板正文。
    剧情卡的人设写的是"一个局面"而不是"一个人"，所以不挂习惯与口碑，只补细节。
    """
    if with_traits:
        for field, tpl in (('habits', HABIT_TPL), ('reputation', REPUTE_TPL)):
            if bank.has(field):
                v = str(bank.take(field)).strip().rstrip('。')
                if v and v not in out:
                    out += rng.choice(tpl).format(h=v, r=v, name=name)
    # 长度兜底：数"真正补进去几处"，而不是数循环了几次 ——
    # 抽到重复细节时 continue 会白烧一次配额，人设就停在 300 字上不去。
    added = 0
    guard = 0
    while len(out) < PERSONA_MIN and added < 8 and guard < 60:
        guard += 1
        d3 = str(bank.take('details')).strip().rstrip('。')
        if not d3 or d3 in out:
            continue
        out += rng.choice(DETAIL_TPL_MORE).format(d=d3)
        added += 1
    return out


def _greeting_bits(bank, rng):
    """叙述 + 一句带动作的话 + 一个舞台指示（+ 需要时再补）。
    硬上限 8 条，但补进来的都必须是**不带括号**的叙述句：早期版本靠"长度不够就再来一个
    圆括号动作"凑字数，结果开场白变成一串（动作）（动作）（动作），像舞台提示单。"""
    used_actions = []
    used_lines = []

    def _act():
        for _ in range(8):
            a = pick_action(bank, rng)
            if a not in used_actions:
                used_actions.append(a)
                return a
        return pick_action(bank, rng)

    def _line(pool):
        for _ in range(24):
            v = rng.choice(pool)
            if v not in used_lines:
                used_lines.append(v)
                return v
        return rng.choice(pool)

    bits = [_c(str(bank.take('scenes')).strip().rstrip('。')),
            str(bank.take('openings')).strip(),
            '（%s）' % _act()]
    if rng.random() < 0.5:
        bits.append(rng.choice(GREETING_TAIL))
    guard = 0
    while len('\n'.join(bits)) < GREETING_MIN and guard < 24:
        guard += 1
        d = str(bank.take('details')).strip().rstrip('。')
        if d and looks_clausal(d) and d not in '\n'.join(bits):
            # 插在「动作」之后：插在第 2 位会把（动作）一路挤到第 12 段之外，
            # 被上限截掉后开场白就没有圆括号动作了（QA 里抓到过 14%）。
            bits.insert(3 if len(bits) > 3 else len(bits), _c(d))
            continue
        bits.append(_line(GREETING_LINES))
    if len(bits) > 14:                   # 上限 14 段：补进来的都是叙述句，不会堆成舞台提示
        bits = bits[:14]
    return '\n'.join(b for b in bits if b)


def build_greeting(bank, rng):
    return _greeting_bits(bank, rng)


def _dialog_examples(bank, rng, speaker, with_tics=True):
    """三段对话，每段至少两个来回（追问 + 完整回答），三分之一再加一轮。

    上一版每段只有 55% 概率带追问，示例对话中位数 171 字，比内置卡（195 字）短一截；
    这一版把"来回感"钉死，同一张卡里的短句/动作/追问/回答都不重复。"""
    used = set()

    def pick(pool):
        """从"还没用过的"里挑一个：这样同一张卡内不会出现重复句子。
        上一版用 rng.choice + 重试，pool 只有 5 条却要挑第 6 次时会退化成重复，
        审计里就出现了 12% 的「卡内重复句」。"""
        cands = [v for v in pool if v not in used]
        v = rng.choice(cands if cands else list(pool))
        used.add(v)
        return v

    def act():
        return str(pick(bank.deck['actions'].items if bank.has('actions') else GENERIC_ACTIONS)) \
            .strip('（）()。')

    users = [pick(USER_LINES), pick(USER_LINES), pick(USER_LINES + USER_LINES2)]
    blocks = []
    for u in users:
        short = pick(SHORT_LINES)
        if with_tics and rng.random() < 0.3:
            short = tic_line(bank, rng)
        shape = rng.choice(['（{a}）{s}', '（{a}）{s}（{a2}）', '{s}', '（{a}）{s}\n{s2}'])
        reply = shape.format(a=act(), a2=act(), s=short, s2=pick(SHORT_LINES))
        turn = '用户：%s\n%s：%s' % (u, speaker, reply)
        # 追问一：每段都有 —— 有来有回才像人写的，长度也靠它
        ans = pick(EXAMPLE_REPLIES)
        reply2 = rng.choice(['（%s）%s' % (act(), ans), ans,
                             '（%s）%s\n%s' % (act(), ans, pick(SHORT_LINES2))])
        turn += '\n\n用户：%s\n%s：%s' % (pick(FOLLOW_UP + FOLLOW_UP2), speaker, reply2)
        # 追问二：六成的卡再加一轮（v1 是三分之一）—— 文本翻倍主要靠这里
        if rng.random() < 0.6:
            turn += '\n\n用户：%s\n%s：（%s）%s' % (
                pick(FOLLOW_UP2), speaker, act(), pick(SHORT_LINES2))
        blocks.append(turn)
    text = '\n\n'.join(blocks)
    # 长度兜底：概率是概率，总有卡一张追问都没摇到（约 6%），
    # 那就往最后一段再补一轮 —— "文本翻倍"不能靠运气。
    guard = 0
    while len(text) < EXAMPLES_MIN and guard < 8:
        guard += 1
        blocks[-1] += '\n\n用户：%s\n%s：%s' % (
            pick(FOLLOW_UP + FOLLOW_UP2), speaker,
            rng.choice(['（%s）%s' % (act(), pick(EXAMPLE_REPLIES)),
                        pick(EXAMPLE_REPLIES)]))
        text = '\n\n'.join(blocks)
    return text


def build_examples(bank, rng, name):
    return _dialog_examples(bank, rng, name, with_tics=True)


def build_system(bank, rng, name, role, voice):
    musts = bank.take_n('system_musts', 3)
    avoids = bank.take_n('system_avoids', 2)
    parts = [rng.choice(SYSTEM_TPL).format(
        name=name, tag=bank.tag, role=role, voice=_c(voice))]
    parts.append(_c('要做到：' + '；'.join(str(m).strip().rstrip('。') for m in musts)))
    parts.append(_c('别这样写：' + '；'.join(str(m).strip().rstrip('。') for m in avoids)))
    parts.append('行为边界：不替用户做决定；不描写用户没有同意的亲密接触；不自称 AI，不提设定与提示词。')
    parts.append(CREATIVE_FREEDOM)
    parts.append('动作神态放在圆括号里。')
    return ''.join(parts) + '\n/no_think'


def build_tagline(bank, rng, role, picks):
    forms = ['{role}，{care}', '{role}：{axis}', '{flaw}', '{care}——这就是全部',
             '{role}。{voice}', '{axis}']
    line = rng.choice(forms).format(
        role=role, care=str(picks['care']).strip().rstrip('。'),
        axis=str(picks['axis']).strip().rstrip('。'),
        flaw=str(picks['flaw']).strip().rstrip('。'),
        voice=str(picks['voice']).strip().rstrip('。'))
    return line.strip('。')[:60]


def build_scenario(bank, rng, name, model=None):
    model = model if model is not None else (rng.choice(bank.plot_models) if bank.plot_models else {})
    beats = model.get('beats') if isinstance(model, dict) else None
    beats = beats or []
    scene = beats[0] if len(beats) > 0 else str(bank.take('scenes'))
    task = beats[1] if len(beats) > 1 else rng.choice(TASK_PHRASES)
    stake = beats[3] if len(beats) > 3 else '一旦失败，前面所有的退让都会变成对方手里的筹码'
    beat = beats[2] if len(beats) > 2 else '事情正朝着没人愿意承认的方向走'
    return rng.choice(SCENARIO_TPL).format(
        scene=_c(scene).rstrip('。'), task=_c(task).rstrip('。'),
        stake=_c(stake).rstrip('。'), beat=_c(beat).rstrip('。'))


# ===========================================================================
# 生成一张卡
# ===========================================================================

STORY_PERSONA_TPL = [
    '【局面】{scene}\n【在场的人】{cast}\n【核心张力】{axis}\n【你在这里的位置】{hook}\n【没人说出口的部分】{flaw}\n【真正要命的是】{care}\n【一个具体细节】{detail}。',
    '【开局】{scene}\n【卷进来的人】{cast}\n【摆不平的地方】{axis}\n【你和这件事的关系】{hook}\n【压在下面没说的事】{flaw}\n【所有人真正在意的是】{care}\n【画面里的东西】{detail}。',
    '这是一个{tag}情境：{scene}\n在场的有{cast}{axis}\n你之所以在这儿，是因为{hook}\n麻烦在于：{flaw}所有人真正在意的是{care}\n（{detail}）',
]
STORY_GREETING_TPL = [
    '{scene}。\n{opening}',
    '{scene}。\n{opening}\n（{action}）',
    '（{action}）{scene}。\n{opening}',
]
STORY_TAGLINE_TPL = ['{stake}', '【{tag}】{task}', '{task}——而时间不站在你这边', '每个人都只说了一半：{axis}']


def pick_slots(bank):
    return {
        'axis': bank.take('axes'), 'voice': bank.take('voice'),
        'flaw': bank.take('flaws'), 'care': bank.take('cares'),
        'hook': bank.take('hooks'), 'scene': bank.take('scenes'),
    }


def _make_character(bank, names, name, rng):
    picks = pick_slots(bank)
    role = bank.take('roles') or bank.tag
    age = rng.randint(19, 62)
    if re.search(r'[婶叔爷婆伯姨公奶姥]', name) or name.startswith('老'):   # 「阿婶 / 老周 / 三爷」不可能是十九岁
        age = rng.randint(46, 68)
    elif re.search(r'[小妹娃仔崽]', name):
        age = rng.randint(16, 28)
    persona = build_persona(bank, rng, name, role, picks, age)
    greeting = build_greeting(bank, rng)
    examples = build_examples(bank, rng, name)
    system = build_system(bank, rng, name, role, picks['voice'])
    tagline = build_tagline(bank, rng, role, picks)
    sig = (bank.slug, 'character', str(picks['axis'])[:18], str(picks['flaw'])[:18],
           str(picks['care'])[:18], str(picks['hook'])[:18], name)
    # 主题 = 职业。同一职业的卡天然是一类，分片按主题打包后就能"搜「法医」只下那一片"。
    return make_payload(bank, name, 'character', persona, tagline, greeting, examples,
                        system, '', rng, topic=str(role).strip()), sig


def _make_story(bank, name, rng):
    picks = pick_slots(bank)
    roles = bank.take_n('roles', 2) or [bank.tag]
    cast = '、'.join(roles)
    cast_note = '；'.join(
        '%s（%s）' % (r, bank.role_notes.get(r, '').strip().rstrip('。'))
        for r in roles if bank.role_notes.get(r))
    persona = rng.choice(STORY_PERSONA_TPL).format(
        tag=bank.tag, scene=_c(picks['scene']),
        cast=cast + ('：' + cast_note + '。' if cast_note else '。'),
        axis=_c(picks['axis']), hook=_c(picks['hook']),
        flaw=_c(picks['flaw']), care=_c(picks['care']),
        detail=_c(str(bank.take('details')).strip().rstrip('。')).rstrip('。'))
    # 剧情卡的人设也要"翻倍"：只补细节（局面没有"习惯"和"口碑"）
    persona = enrich_persona(bank, rng, persona, '', with_traits=False)
    # 局面模型只摇一次，scenario / 节拍 / 主题标签都用它，避免三处对不上
    model = rng.choice(bank.plot_models) if bank.plot_models else {}
    topic = str((model or {}).get('name') or '').strip() or str(picks['scene']).strip()[:10]
    scenario = build_scenario(bank, rng, name, model)
    beats = _story_beats(bank, rng, model)
    tagline = build_tagline_story(bank, rng, picks, beats)
    greeting = build_story_greeting(bank, rng, name)
    examples = build_story_examples(bank, rng, roles[0])
    system = build_story_system(bank, rng, name, roles, picks['voice'])
    sig = (bank.slug, 'story', str(picks['axis'])[:18], str(picks['flaw'])[:18],
           str(picks['care'])[:18], str(picks['hook'])[:18], name)
    return make_payload(bank, name, 'story', persona, tagline, greeting, examples,
                        system, scenario, rng, topic=topic), sig


def _story_beats(bank, rng, model=None):
    model = model if model is not None else (rng.choice(bank.plot_models) if bank.plot_models else {})
    beats = (model.get('beats') if isinstance(model, dict) else None) or []
    while len(beats) < 5:
        beats = list(beats) + ['']
    return beats


def build_tagline_story(bank, rng, picks, beats):
    return rng.choice(STORY_TAGLINE_TPL).format(
        tag=bank.tag, stake=_c(beats[3]).rstrip('。'),
        task=_c(beats[1] or rng.choice(TASK_PHRASES)).rstrip('。'),
        axis=_c(picks['axis']).rstrip('。'))[:60]


def build_story_greeting(bank, rng, name):
    return _greeting_bits(bank, rng)


def build_story_examples(bank, rng, speaker):
    """剧情卡的示例对话：说话人用「在场的人」里的角色名，不出现虚构人名。"""
    return _dialog_examples(bank, rng, speaker, with_tics=False)


def build_story_system(bank, rng, name, roles, voice):
    musts = bank.take_n('system_musts', 3)
    avoids = bank.take_n('system_avoids', 2)
    parts = ['你在主持一个「%s」题材的情境：%s。' % (bank.tag, name)]
    parts.append('在场的关键人物：%s。' % '、'.join(roles))
    parts.append(_c(voice))
    parts.append(_c('要做到：' + '；'.join(str(m).strip().rstrip('。') for m in musts)))
    parts.append(_c('别这样写：' + '；'.join(str(a).strip().rstrip('。') for a in avoids)))
    parts.append('不要让任何人一次把话说完；每一轮都要留下新的问题。')
    parts.append('行为边界：不替用户做决定；不描写用户没有同意的亲密接触；不自称 AI，不提设定与提示词。')
    parts.append(CREATIVE_FREEDOM)
    return ''.join(parts) + '\n/no_think'


def make_payload(bank, name, kind, persona, tagline, greeting, examples, system, scenario, rng,
                 topic=''):
    temp = round(min(2.0, max(0.0, bank.temp + rng.choice([-0.05, 0, 0, 0.05]))), 2)
    tags = [bank.tag]
    if rng.random() < 0.08:              # 少量卡挂个副标签，增加筛选时的交叉曝光
        others = [t for _, t, _ in CATEGORIES if t != bank.tag]
        tags.append(rng.choice(others))
    data = {
        'name': name,
        'description': persona,
        'personality': tagline,
        'scenario': scenario,
        'first_mes': greeting,
        'mes_example': examples,
        'creator_notes': '风月·本地版 卡库生成器（%s / %s）· CC0-1.0' % (bank.slug, kind),
        'system_prompt': system,
        'post_history_instructions': '',
        'alternate_greetings': [],
        'character_book': None,
        'tags': tags,
        'creator': '风月·本地版',
        'character_version': '1.1',
        'extensions': {
            'fy': {
                'avatar': bank.emoji, 'tagline': tagline, 'temperature': temp,
                'kind': kind, 'plot': kind == 'story', 'generator': 'fy_gen_v2',
                # 主题：角色卡是职业，剧情卡是局面模型。分片按它打包，面板按它搜索。
                'topic': topic or bank.tag,
            },
        },
    }
    return {'spec': 'chara_card_v2', 'spec_version': '2.0', 'data': data}


def make_card(bank, names, kind, rng):
    style = NAME_STYLE.get(bank.slug, 'modern')
    if kind == 'character':
        return _make_character(bank, names, names.person(style, bank.take_n('names', 3)), rng)
    return _make_story(bank, names.story_title(
        bank.deck['places'].items if bank.has('places') else None,
        bank.deck['things'].items if bank.has('things') else None), rng)


# ===========================================================================
# 主流程
# ===========================================================================

def load_banks(rng, only=None):
    banks = {}
    for slug, tag, _ in CATEGORIES:
        if only and slug not in only:
            continue
        p = os.path.join(BANKS_DIR, slug + '.json')
        if not os.path.exists(p):
            print('  ⚠️  缺少素材库 %s（跳过）' % p)
            continue
        with open(p, encoding='utf-8') as f:
            data = json.load(f)
        b = Bank(slug, data, rng)
        banks[slug] = b
        if b.missing:
            print('  ⚠️  %-14s 缺字段：%s' % (slug, '、'.join(b.missing)))
    return banks


def builtin_names():
    """内置 160 张 + App 启动时种入的 4 个预设——两边的名字都不能再用。
    预设名不在 cards/pack-*.json 里，只写在 app.js（id: 'preset_xxx', name: '…'），
    上一版就漏了它，结果卡库里生成了一个「拾光」，导入时被按名跳过，32000 张少 1 张。"""
    out = set()
    try:
        src = open(os.path.join(ROOT, 'app', 'assets', 'ui', 'app.js'), encoding='utf-8').read()
        for m in re.finditer(r"id:\s*'preset_[a-z0-9]+'\s*,\s*name:\s*'([^']+)'", src):
            out.add(m.group(1))
    except Exception:
        pass
    for f in glob.glob(BUILTIN_GLOB):
        try:
            with open(f, encoding='utf-8') as fh:
                for c in json.load(fh).get('cards', []):
                    n = (c.get('data') or {}).get('name')
                    if n:
                        out.add(n)
        except Exception:
            pass
    return out


def jaccard(a, b, n=3):
    A = {a[i:i + n] for i in range(max(0, len(a) - n + 1))}
    B = {b[i:i + n] for i in range(max(0, len(b) - n + 1))}
    if not A or not B:
        return 0.0
    return len(A & B) / len(A | B)


# QA 线（比发布闸门严）：生成器自检用。上一版是 80/100/无示例检查，
# 结果"开场白 60~79 字"这类偏短的卡有 90 张也能过 —— 这一版把线抬到接近内置卡的下沿。
QA_MIN_GREETING = 180        # 内置卡开场白 median 117 → 翻倍约 234，留余量
QA_MIN_PERSONA = 320         # 内置卡人设 median 222 → 翻倍约 444，留余量
QA_MIN_EXAMPLES = 240        # 内置卡示例 median 195 → 翻倍约 390，留余量
QA_MIN_TURNS = 3             # 示例对话里「用户：」至少出现 3 次（三段各一来回）
# 提示词泄漏只在正文三字段里查：system_prompt 本来就要写「不自称 AI、不提提示词」，
# 拿它当禁词会把自己的行为边界判成违规。
PROMPT_LEAK = ('作为AI', '作为 AI', '人工智能', '语言模型', '提示词', 'system_prompt', '{{', '}}')


def _sentences(t):
    """切句：只保留长度 ≥ 8 的片段，太短的（「嗯」）不该参与重复判断。"""
    return [s.strip() for s in re.split(r'[。！？…\n]+', t or '') if len(s.strip()) >= 8]


def _self_repeat(t):
    """同一字段里同一句话出现两次 —— 一眼就能看出来的凑字数。"""
    seen = set()
    for s in _sentences(t):
        if s in seen:
            return True
        seen.add(s)
    return False


def qa_card(card):
    """机器能查出来的"读着别扭"：双标点、半句黏连、模板残留、卡内重复、
    动作堆叠、内容太薄、示例来回太少。比发布闸门严，允不允许发布看闸门。"""
    d = card['data']
    issues = []
    for f in ('description', 'first_mes', 'mes_example', 'system_prompt'):
        t = (d.get(f) or '').strip()
        if '。。' in t or '，，' in t:
            issues.append(f + ':双标点')
        if re.search(r'[\u4e00-\u9fa5]最在意的是[\u4e00-\u9fa5]{0,4}$', t):
            issues.append(f + ':句子黏连')
        if re.search(r'[（(][）)]', t):
            issues.append(f + ':动作堆叠')
        if _self_repeat(t):
            issues.append(f + ':卡内重复句')
        if f != 'system_prompt':
            if re.search(r'[{｛][A-Za-z_]{2,}[}｝]', t):
                issues.append(f + ':模板占位符残留')
            for w in PROMPT_LEAK:
                if w in t:
                    issues.append(f + ':提到设定或AI')
                    break
    fm = (d.get('first_mes') or '').strip()
    if len(fm) < QA_MIN_GREETING:
        issues.append('开场白偏短')
    if not re.search(r'[（(]', fm):
        issues.append('开场白缺动作')
    desc = (d.get('description') or '').strip()
    if not desc.endswith(('。', '）')):
        issues.append('人设结尾异常')
    if len(desc) < QA_MIN_PERSONA:
        issues.append('人设偏薄')
    ex = (d.get('mes_example') or '').strip()
    if len(ex) < QA_MIN_EXAMPLES:
        issues.append('示例对话偏短')
    if ex.count('用户：') < QA_MIN_TURNS:
        issues.append('示例对话来回太少')
    if not re.search(r'[（(]', ex):
        issues.append('示例对话缺动作')
    return issues


def _quantiles(vals):
    """min / p25 / median / p75 / max —— 审计里到处要用，抽出来省得每处写一遍。"""
    vals = sorted(vals)
    if not vals:
        return {}
    return {'min': vals[0], 'p25': vals[len(vals) // 4], 'median': vals[len(vals) // 2],
            'p75': vals[len(vals) * 3 // 4], 'max': vals[-1]}


def builtin_baseline():
    """内置 160 张卡的字段长度中位数 —— 生成器唯一有意义的对照物（人写的）。"""
    vals = {'persona': [], 'greeting': [], 'examples': []}
    for f in glob.glob(BUILTIN_GLOB):
        try:
            with open(f, encoding='utf-8') as fh:
                for c in json.load(fh).get('cards', []):
                    d = c.get('data') or {}
                    vals['persona'].append(len(d.get('description') or ''))
                    vals['greeting'].append(len(d.get('first_mes') or ''))
                    vals['examples'].append(len(d.get('mes_example') or ''))
        except Exception:
            pass
    out = {}
    for k, v in vals.items():
        if v:
            v.sort()
            out[k] = v[len(v) // 2]
    return out


def audit(cards, rng, sample_pairs=3000):
    """多样性审计：模板味重不重、文本够不够厚、像不像人写，看这几个数字。"""
    rep = {}
    rep['total'] = len(cards)
    rep['unique_names'] = len({(c['data']['name'] or '').strip() for c in cards})
    qa = Counter()
    qa_kind = {'character': [0, 0], 'story': [0, 0]}      # [干净, 总数]
    for c in cards:
        issues = qa_card(c)
        for i in issues:
            qa[i] += 1
        k = c['data']['extensions']['fy'].get('kind', 'character')
        slot = qa_kind.setdefault(k, [0, 0])
        slot[1] += 1
        if not issues:
            slot[0] += 1
    rep['qa_issues'] = dict(qa)
    rep['qa_clean_rate'] = round(1 - sum(1 for c in cards if qa_card(c)) / max(1, len(cards)), 4)
    rep['qa_clean_rate_by_kind'] = {k: round(v[0] / max(1, v[1]), 4) for k, v in qa_kind.items()}
    by_slug = Counter()
    by_kind = Counter()
    for c in cards:
        ext = c['data']['extensions']['fy']
        by_kind[ext['kind']] += 1
        by_slug[c['data']['tags'][0]] += 1
    rep['by_kind'] = dict(by_kind)
    rep['by_tag'] = dict(by_slug)
    rep['topics'] = len({str(c['data']['extensions']['fy'].get('topic') or '').strip()
                         for c in cards})

    # 字段长度分布
    def lens(field, ext=False):
        vals = []
        for c in cards:
            v = c['data']['extensions']['fy'].get(field) if ext else c['data'].get(field)
            vals.append(len(v or ''))
        return _quantiles(vals)
    rep['chars'] = {'persona': lens('description'), 'greeting': lens('first_mes'),
                    'examples': lens('mes_example'), 'system': lens('system_prompt')}

    # —— "像不像人写"这一层 ——
    turns, sent_lens, puncts, self_rep = [], [], [], 0
    ex_line_lens = []
    for c in cards:
        ex = c['data'].get('mes_example') or ''
        turns.append(ex.count('用户：'))
        for line in ex.split('\n'):
            line = line.strip()
            if line and not line.startswith('用户：'):
                ex_line_lens.append(len(line))
        for f in ('description', 'first_mes', 'mes_example'):
            t = c['data'].get(f) or ''
            sent_lens.extend(len(s) for s in _sentences(t))
            if _self_repeat(t):
                self_rep += 1
                break
        puncts.append(len({ch for ch in (c['data'].get('mes_example') or '')
                           if ch in '。！？…，、—：；「」（）'}))
    rep['examples_turns'] = _quantiles(turns)
    rep['examples_reply_len'] = _quantiles(ex_line_lens)
    rep['sentence_len'] = _quantiles(sent_lens)
    rep['punct_kinds'] = _quantiles(puncts)
    rep['self_repeat_cards'] = self_rep
    rep['self_repeat_rate'] = round(self_rep / max(1, len(cards)), 4)

    # 12-gram 覆盖率：一句话如果出现在超过 5% 的卡里，就是"模板味"来源
    grams = Counter()
    for c in cards:
        t = re.sub(r'\s', '', c['data']['description'])
        for i in range(0, len(t) - 12, 3):
            grams[t[i:i + 12]] += 1
    rep['top_12gram_share'] = [{'gram': g, 'share': round(n / max(1, len(cards)), 3)}
                               for g, n in grams.most_common(8)]

    # 抽样两两相似度（3-gram jaccard）
    sims = []
    for _ in range(min(sample_pairs, len(cards) * 2)):
        a, b = rng.sample(cards, 2)
        sims.append(jaccard(a['data']['description'], b['data']['description']))
    sims.sort()
    if sims:
        rep['pair_sim'] = {'mean': round(sum(sims) / len(sims), 4),
                           'p95': round(sims[int(len(sims) * .95)], 4), 'max': round(sims[-1], 4)}

    # 与内置 160 张（人写的）对照：中位数差为正才算"不输给人写的"
    base = builtin_baseline()
    if base:
        rep['builtin_baseline'] = base
        rep['gap_vs_builtin'] = {
            k: (rep['chars'][k]['median'] - base[k])
            for k in base if rep['chars'].get(k, {}).get('median') is not None
        }
    # 与 v1 卡库（2026-10 发布版）对照：这一栏就是"文本翻倍"的验收数字
    v1 = {'persona': 220, 'greeting': 119, 'examples': 171}
    rep['v1_median_baseline'] = v1
    rep['doubling_vs_v1'] = {
        k: round(rep['chars'][k]['median'] / v1[k], 2)
        for k in v1 if rep['chars'].get(k, {}).get('median')
    }
    return rep


def _card_text(c):
    """一张卡用于关键词统计的全部正文（不含系统提示词，那里面全是模板话）。"""
    d = c['data']
    return ' '.join((d.get('description') or '', d.get('first_mes') or '',
                     d.get('mes_example') or '', d.get('scenario') or ''))


def topic_key(c):
    ext = c['data']['extensions']['fy']
    return str(ext.get('topic') or '').strip() or str(c['data']['tags'][0])


def write_packs(cards, out_dir, chunk, banks=None):
    """按主题打包 + 给每片算关键词（v2）。

    为什么要按主题：v1 是"1000 张一刀切"，想只要悬疑里的法医题材也得下整类。
    现在同一个主题的卡不拆到两片里，每片约 chunk 张，索引里记下这片覆盖的主题
    与场景词 —— 面板就能"搜「法医」只下那一片"。
    """
    os.makedirs(out_dir, exist_ok=True)
    catalog = []
    groups = {}
    for c in cards:
        ext = c['data']['extensions']['fy']
        slug = SLUG_BY_TAG.get(c['data']['tags'][0], 'misc')
        groups.setdefault((slug, ext['kind']), []).append(c)

    for (slug, kind), group in sorted(groups.items()):
        bank = (banks or {}).get(slug)
        # 关键词候选：素材库里的职业 / 地点 / 物件（短词，用户会这么搜）
        terms = []
        if bank is not None:
            for f in ('roles', 'places', 'things'):
                for t in ((bank.deck[f].items if bank.has(f) else []) or []):
                    t = str(t).strip()
                    if 2 <= len(t) <= 8 and t not in terms:
                        terms.append(t)
        totals = {t: sum(1 for c in group if t in _card_text(c)) for t in terms}

        # 主题整块进片：累加到接近 chunk 就收一片（允许超 20%，换主题不被拆散）
        by_topic = {}
        for c in group:
            by_topic.setdefault(topic_key(c), []).append(c)
        parts, cur, cur_topics = [], [], []
        for topic, items in by_topic.items():
            if cur and len(cur) + len(items) > chunk * 1.2:
                parts.append((list(cur_topics), cur))
                cur, cur_topics = [], []
            cur.extend(items)
            if topic not in cur_topics:
                cur_topics.append(topic)
        if cur:
            parts.append((list(cur_topics), cur))

        for idx, (topics, part) in enumerate(parts, 1):
            texts = [_card_text(c) for c in part]
            kw = list(topics)
            ranked = []
            for t in terms:
                if t in kw:
                    continue
                local = sum(1 for s in texts if t in s)
                if local >= 3:
                    ranked.append((local / max(1, totals.get(t, 0)), local, t))
            # 场景/物件词只留"在这片里特别集中"的：泛泛都有的词搜出来等于整类
            ranked.sort(key=lambda x: (-x[0], -x[1], x[2]))
            for ratio, _local, t in ranked[:6]:
                if ratio >= 0.3:
                    kw.append(t)
            kw = kw[:24]
            label = '、'.join(topics[:2])
            if len(topics) > 2:
                label += ' 等 %d 个主题' % len(topics)
            fname = '%s-%s-%d.json' % (slug, kind, idx)
            pack = {
                'spec': 'fy_pack_v1',
                'name': '%s · %s %d/%d（%s）' % (
                    TAG_BY_SLUG.get(slug, slug), KIND_LABEL[kind], idx, len(parts), label),
                'slug': slug, 'kind': kind, 'part': idx, 'parts': len(parts),
                'license': 'CC0-1.0', 'count': len(part),
                'topics': topics, 'keywords': kw, 'topic_label': label,
                'cards': part,
            }
            blob = json.dumps(pack, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            with open(os.path.join(out_dir, fname), 'wb') as f:
                f.write(blob)
            catalog.append({
                'file': fname, 'slug': slug, 'tag': TAG_BY_SLUG.get(slug, slug),
                'emoji': EMOJI_BY_SLUG.get(slug, '🎭'), 'kind': kind,
                'part': idx, 'parts': len(parts), 'count': len(part),
                'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest(),
                'topic': label, 'topics': topics, 'keywords': kw,
            })
    return catalog


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--per-kind', type=int, default=1000)
    # 250 张一片：按主题打包后，一片 ≈ 5~7 个主题；搜到一个主题 = 只下 1/4 个分类
    ap.add_argument('--chunk', type=int, default=250)
    ap.add_argument('--seed', type=int, default=20261012)
    ap.add_argument('--out', default=LIB_DIR)
    ap.add_argument('--only', default='', help='逗号分隔的 slug')
    ap.add_argument('--sample', type=int, default=0, help='只写一份样卡文件（前 N 张）供人工看')
    ap.add_argument('--audit', default='', help='只审计这个目录里已生成的卡包')
    ap.add_argument('--no-write', action='store_true')
    args = ap.parse_args()
    rng = random.Random(args.seed)

    if args.audit:
        cards = []
        for f in sorted(glob.glob(os.path.join(args.audit, '*.json'))):
            if os.path.basename(f) == 'index.json':
                continue
            with open(f, encoding='utf-8') as fh:
                cards.extend(json.load(fh).get('cards', []))
        rep = audit(cards, rng)
        print(json.dumps(rep, ensure_ascii=False, indent=2))
        return 0

    only = set(x.strip() for x in args.only.split(',') if x.strip()) or None
    print('── 加载素材库 …')
    banks = load_banks(rng, only)
    if not banks:
        print('❌ 一个素材库都没加载到（cards/banks/ 是空的？）')
        return 1
    names = NamePool(rng, builtin_names())
    print('   已占坑的内置名字：%d 个' % len(names.used))

    cards, sigs, dups = [], set(), 0
    for slug, bank in banks.items():
        for kind in ('character', 'story'):
            for i in range(args.per_kind):
                for _ in range(24):          # 最多重摇 24 次，摇不出新组合就放过
                    card, sig = make_card(bank, names, kind, rng)
                    if sig not in sigs:
                        break
                else:
                    dups += 1
                sigs.add(sig)
                cards.append(card)
        print('   %-14s %s 完成（%d 张）' % (slug, bank.tag, args.per_kind * 2))

    print('── 生成 %d 张（组合撞车重摇后仍重复：%d）' % (len(cards), dups))

    if args.sample:
        os.makedirs(args.out, exist_ok=True)
        p = os.path.join(args.out, 'sample.json')
        with open(p, 'w', encoding='utf-8') as f:
            json.dump({'spec': 'fy_pack_v1', 'name': '样卡', 'count': len(cards),
                       'cards': cards}, f, ensure_ascii=False, indent=1)
        print('   样卡：%s' % p)

    rep = audit(cards, rng)
    print('── 审计：')
    print('   名字唯一：%d/%d' % (rep['unique_names'], rep['total']))
    print('   QA 干净率：%s（按类型 %s；问题分布 %s）' % (
        rep['qa_clean_rate'], rep['qa_clean_rate_by_kind'], rep['qa_issues']))
    print('   字数中位：人设 %s / 开场白 %s / 示例 %s / 系统 %s' % (
        rep['chars']['persona'].get('median'), rep['chars']['greeting'].get('median'),
        rep['chars']['examples'].get('median'), rep['chars']['system'].get('median')))
    if rep.get('gap_vs_builtin'):
        print('   对比内置卡（人写）中位差：%s（正数=比内置卡长）' % rep['gap_vs_builtin'])
    if rep.get('doubling_vs_v1'):
        print('   对比 v1 卡库的倍数：%s（1.0 = 持平，2.0 = 翻倍）' % rep['doubling_vs_v1'])
    print('   示例对话：来回 %s 次 / 回答行长 %s / 卡内重复率 %s' % (
        rep['examples_turns'].get('median'), rep['examples_reply_len'].get('median'),
        rep['self_repeat_rate']))
    print('   抽样相似度：均值 %s / p95 %s / 最大 %s' % (
        rep['pair_sim'].get('mean'), rep['pair_sim'].get('p95'), rep['pair_sim'].get('max')))
    print('   最高频 12-gram 覆盖率：%s' % ', '.join(
        '%s(%s)' % (x['gram'], x['share']) for x in rep['top_12gram_share'][:3]))

    if args.no_write:
        return 0
    catalog = write_packs(cards, args.out, args.chunk, banks)
    total_bytes = sum(c['bytes'] for c in catalog)
    # 每个分类可搜到的主题（面板提示用）
    topics_by_slug = {}
    for p in catalog:
        bucket = topics_by_slug.setdefault(p['slug'], [])
        if p.get('topic'):
            bucket.append(p['topic'])
    index = {
        'spec': 'fy_library_v2',
        'note': '可下载卡库：每分类各 %d 张角色卡 + %d 张剧情卡，全部原创（AI 组合生成），CC0-1.0；'
                '按主题分片，可按关键词只下载其中一片' % (args.per_kind, args.per_kind),
        'seed': args.seed, 'per_kind': args.per_kind, 'chunk': args.chunk,
        'total': len(cards), 'bytes': total_bytes,
        'baseUrl': '',                 # 发布时填（Gitee 附件地址前缀）
        'categories': [
            {'slug': s, 'tag': t, 'emoji': e, 'character': args.per_kind, 'story': args.per_kind,
             'topics': topics_by_slug.get(s, [])}
            for s, t, e in CATEGORIES if s in banks
        ],
        'packs': catalog,
    }
    with open(os.path.join(args.out, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(args.out, 'audit.json'), 'w', encoding='utf-8') as f:
        json.dump(rep, f, ensure_ascii=False, indent=1)
    print('── 写出 %d 个分片（%.1f MB）→ %s' % (len(catalog), total_bytes / 1048576, args.out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
