# 在线卡库目录格式（fy_library）

在线卡库的目录是一份很小的 JSON（`cards/library-index.json`，随仓库走），
App 打开「卡库」面板时先拉它，再按需下载分片。分片本身是标准 `fy_pack_v1` 卡包。

- 生成器：`tools/gen-cards.py`（写 `cards/library/`）
- 发布：`tools/publish-cards.sh cards-v2`（建发行版 + 传附件 + 填 `baseUrl`/`url`）
- 校验：`tools/check-library.py`（目录 ↔ 分片逐字节对齐）
- 消费方：`app/assets/ui/app.js` 的「在线卡库」一节

## 为什么有 v2

v1 每个分类只有 **1 片 × 1000 张**：想只要「悬疑推理 · 角色卡」里的法医题材，
也得把 1000 张（约 2.7MB）整片下完。

v2 把每类按**主题**切成若干小片（默认每片约 250 张，片内主题一致），
并把每片的主题词、关键词写进目录。于是：

- 面板里输入关键词（如「解剖室」「画像师」「断桥」）→ 只列出命中的分片；
- 点一下就**只下载这一片**（约 1/4 个分类），而不是整类；
- 不输入关键词时行为和 v1 一样：按「分类 × 类型」整组下载（整组 = 它的全部分片）。

v2 是**纯增量**：字段只加不改，老版本 App（读 `packs` 数组）拿到 v2 目录照样能用，
只是不知道关键词、仍然整组下载。

## 目录

```jsonc
{
  "spec": "fy_library_v2",
  "note": "可下载卡库：…",
  "seed": 20261012,
  "per_kind": 1000,          // 每个「分类 × 类型」的卡数
  "chunk": 250,              // 每片目标张数（主题整块打包，允许略超）
  "total": 32000,            // 全库总张数
  "bytes": 101821058,        // 全部分片字节数合计
  "baseUrl": "https://…/releases/download/cards-v2/",
  "publishedAt": "2026-10-12",

  "categories": [
    {
      "slug": "mystery", "tag": "悬疑推理", "emoji": "🔍",
      "character": 1000, "story": 1000,
      "topics": ["法医鉴定", "现场勘查", "…"]     // 该分类可搜到的主题（可选，面板提示用）
    }
  ],

  "packs": [
    {
      "file": "mystery-character-1.json",
      "slug": "mystery", "tag": "悬疑推理", "emoji": "🔍",
      "kind": "character",                  // character | story
      "part": 1, "parts": 4,                // 该「分类 × 类型」内部的分片序号
      "count": 248,                         // 与文件里的 cards.length 必须相等
      "bytes": 671234, "sha256": "…",
      "url": "https://…/mystery-character-1.json",   // 绝对地址（优先用它）

      "topic": "法医鉴定 等 6 个主题",        // 人类可读的一句话标签
      "topics": ["法医鉴定", "现场勘查", "…"], // 片内覆盖的主题（主题整块，不跨片）
      "keywords": ["法医", "解剖室", "验尸报告", "…"]  // 搜索用关键词（主题 + 高频场景/物件/角色）
    }
  ]
}
```

### 约定

1. `count` 必须等于分片文件里 `cards` 的长度；`sha256`/`bytes` 必须与文件逐字节一致
   （`tools/check-library.py` 会验，App 下载后也会验 `count`）。
2. `topics` 里每个主题在同一「分类 × 类型」内**只出现在一片里**（主题整块打包）。
   App 的「只下某一片」正是靠这条：主题跨片就会漏卡，`check-library.py` 会直接拦发布。
3. `keywords` 非空。前面若干条是该片的主题标签（职业名/局面名，可以长一点），
   后面是最多 6 条**场景/物件词**（2~12 字）：它们按"在片内的集中度"挑出来
   （出现次数 ≥3 且占全类该词的 30% 以上），所以拿着它搜能定位到少数几片，而不是整类。
4. 老字段（`file/slug/tag/emoji/kind/part/parts/count/bytes/sha256/url`）语义不变；
   v1 目录（没有 `topics/keywords`）仍然合法。

### 当前这一版的实际数字（cards-v2）

- 32000 张 = 16 类 ×（1000 角色卡 + 1000 剧情卡），`chunk = 250`；
- **128 个分片**，每片 220~300 张（主题整块，允许超 20%），片均 250 张；
- **768 个主题**（角色卡的主题是职业，剧情卡的主题是局面模型）；
- 单个分片约 1.0~1.5MB，全库约 158MB（文本比 cards-v1 翻倍：人设 220→442、
  开场白 119→259、示例对话 171→380 字，中位数）。

## App 侧搜索语义（v1.6.0 起）

- 面板顶部有搜索框 `#libSearch`。
- 查询串按空白切成若干 token；一个分片命中当且仅当**每个** token 都以子串形式
  （大小写不敏感）出现在它的「检索文本」里：
  `tag + slug + kind 中文名 + topic + topics[] + keywords[]`。
- 查询为空 → 显示原来的「分类 × 类型」行（整组下载）。
- 查询非空 → 显示命中的分片列表：`分类 · 类型 · 主题`、`count 张 · bytes · 第 part/parts 片`、
  状态（未下载 / 已导入 n 张）、单片刻的「下载并导入 / 重新导入」按钮。
- 顶部主按钮：查询为空时是「全部下载」（所有分类），查询非空且有命中时变成
  「下载全部匹配（N 片）」，只下载命中的分片。
- 导入记录仍按文件名记在 `settings.libraryImported`（`{[file]: {count, ts}}`），
  所以「某片已导入」在搜索列表和整组列表里是同一份状态。

## 换版语义：seed、作废旧记录、同名卡覆盖（v1.6.1 起）

分片文件名是 `<slug>-<kind>-<part>.json`，**跨版本会重名**：
v1 的 `mystery-character-1.json` 是整组 1000 张，v2 的同名文件只是第 1 片（约 250 张）。
"导入过没有"又是按文件名记的，所以换版后光看记录会得出错误结论。规则如下：

1. 目录顶层的 `seed` 是**版本指纹**。App 把它记在 `settings.librarySeed`；
2. 每次拉到目录，若 `index.seed` 与已记录的不同，就逐条核对旧记录：
   **张数跟新目录对不上（`record.count !== pack.count`）、或新目录里已经没有这个文件 → 作废**；
   张数一致的保留（说明本来就是这一版）。作废条数写进日志，面板上也会提示；
3. 有作废时**自动置 `settings.libraryOverwrite = true`**（面板上「同名卡用新内容覆盖」勾上），
   因为换版基本意味着"文本重写了"，不覆盖的话同名卡会一直留着旧文本；
4. 覆盖导入（`importCardsBatch(cards, {overwrite:true})`）遇到同名卡不跳过，
   而是**沿用库里那张卡的 `id` 覆盖内容**（`fav`、`createdAt` 一起保留），
   所以收藏、位置和已有聊天记录都不受影响；不勾覆盖时行为与以前完全一致（同名跳过，幂等）；
5. 没有 `seed` 字段的老目录：上述逻辑整段跳过，行为与 v1.6.0 一致。

导出给测试/其它前端用的入口：`FYApp.libSearchPacks` / `libPackImported` / `libPacksImported`
/ `importLibraryPacks` / `libResults` / `libOverwriteOn` / `importCardsBatch`。

## 内置预设的分类迁移（v1.6.1 起）

`app/assets/ui/presets.json` 里 4 张预设（林夏 / 沈砚堂 / 云无咎 / 拾光）现在带 `tags`
（日常治愈+恋爱 / 悬疑推理+历史 / 古风仙侠 / 科幻未来）。
预设只在角色库为空时建卡，老库里的这几张要靠迁移补：启动与设置页「恢复内置角色」时
`patchPresetTags()` 按名字找到它们，**只对 `tags` 取并集（最多 6 个）**，不动任何文本字段。
预设清单的缓存键同时升到 `fy.presets.v2`（老键里的缓存没有 `tags`，续用会让迁移看不到标签）。
