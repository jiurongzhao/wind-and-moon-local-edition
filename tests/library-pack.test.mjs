/**
 * library-pack.test.mjs —— 用 App **自己的解析器**吃一遍大卡库的分片。
 *
 * 为什么单开一个文件：`tools/check-cards.py` 校验的是 chara_card_v2 的字段完整性，
 * 它看不到「App 能不能把它正确映射成内部角色」。这个测试直接调
 * `app/assets/ui/cards.js` 的 `parsePack()`（前端导入卡包走的就是它），
 * 所以能抓到"JSON 合法但 App 认不出来"的那类问题。
 *
 * 跑法（不需要 jsdom，也不需要手机）：
 *     cd ~/2/fy/tests && node library-pack.test.mjs
 * 卡库还没生成时会跳过（exit 0），不阻塞 CI。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'cards', 'library');
const UI = path.join(ROOT, 'app', 'assets', 'ui');

if (!fs.existsSync(LIB)) {
  console.log('（跳过：cards/library/ 还没生成，先跑 python3 tools/gen-cards.py）');
  process.exit(0);
}

/* 在 vm 里加载 cards.js（它是浏览器 IIFE，挂在 window 上） */
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(UI, 'cards.js'), 'utf8'), sandbox);
const FYCards = sandbox.window.FYCards;
if (!FYCards) { console.error('❌ cards.js 没有导出 FYCards'); process.exit(1); }

/* 合法分类（与 creator/taxonomy.json 对齐） */
const TAX = JSON.parse(fs.readFileSync(path.join(UI, 'creator', 'taxonomy.json'), 'utf8'));
const CATS = new Set(TAX.categories.map((c) => c.tag));

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
};

const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.json')
  && !['index.json', 'audit.json', 'sample.json'].includes(f)).sort();
if (!files.length) {
  console.log('（跳过：cards/library/ 里没有分片）');
  process.exit(0);
}

const t0 = Date.now();
let total = 0, bad = 0;
const kindSeen = { character: 0, story: 0 };

/* v2 目录才有 topics / keywords：有目录就按目录的 spec 决定要不要卡这一层 */
const INDEX = path.join(LIB, 'index.json');
let SPEC = 'fy_library_v1';
if (fs.existsSync(INDEX)) {
  try { SPEC = JSON.parse(fs.readFileSync(INDEX, 'utf8')).spec || SPEC; } catch (e) { /* 交给下面报错 */ }
}
const V2 = SPEC === 'fy_library_v2';
let v2Packs = 0, v2BadField = 0, v2TopicMismatch = 0;
const allTopics = new Set();

for (const f of files) {
  const pack = JSON.parse(fs.readFileSync(path.join(LIB, f), 'utf8'));
  if (V2) {
    const topics = Array.isArray(pack.topics) ? pack.topics : [];
    const kws = Array.isArray(pack.keywords) ? pack.keywords : [];
    if (!topics.length || !kws.length) { v2BadField++; failures.push(`${f}: v2 分片缺 topics/keywords`); }
    else v2Packs++;
    topics.forEach((t) => allTopics.add(t));
    const tset0 = new Set(topics);
    for (const k of kws) {
      const s = String(k);
      if (tset0.has(s)) continue;              // 主题标签可以长，场景词要短
      if (s.length < 2 || s.length > 12) {
        v2BadField++; failures.push(`${f}: 场景关键词长度异常 ${JSON.stringify(k)}`); break;
      }
    }
    const tset = new Set(topics);
    for (const c of pack.cards) {
      const t = (((c.data || {}).extensions || {}).fy || {}).topic || '';
      if (t && !tset.has(t)) { v2TopicMismatch++; break; }
    }
  }
  let parsed;
  try {
    parsed = FYCards.parsePack(JSON.stringify(pack));
  } catch (e) {
    bad++; failures.push(f + ': parsePack 抛错 ' + e.message); continue;
  }
  if (parsed.cards.length !== pack.count) {
    bad++; failures.push(`${f}: parsePack 得到 ${parsed.cards.length} 张，声明 ${pack.count}`);
    continue;
  }
  for (const c of parsed.cards) {
    total++;
    const problems = [];
    if (!c.name) problems.push('缺 name');
    if (!c.persona || c.persona.length < 60) problems.push('人设太短');
    if (!c.greeting) problems.push('缺开场白');
    if (!c.tags || !c.tags.length || !CATS.has(c.tags[0])) problems.push('分类不在 16 类里：' + c.tags);
    if (c.kind !== 'character' && c.kind !== 'story') problems.push('kind 非法：' + c.kind);
    if (c.kind === 'story' && (!c.scenario || c.scenario.length < 30)) problems.push('剧情卡缺 scenario');
    if (!(c.temperature >= 0 && c.temperature <= 2)) problems.push('温度非法');
    if (!c.avatar) problems.push('缺头像');
    if (c.tagline && c.tagline.length > 60) problems.push('简介超 60 字');
    if (problems.length) {
      bad++;
      if (failures.length < 12) failures.push(`${f}/${c.name}: ${problems.join('、')}`);
    }
    kindSeen[c.kind]++;
  }
}

/* 往返：内部角色 → chara_card_v2 → 内部角色，字段不能丢 */
const sample = FYCards.parsePack(fs.readFileSync(path.join(LIB, files[0]), 'utf8')).cards[0];
const round = FYCards.fromCard(FYCards.toCardV2(sample));
check('往返转换保留人设/开场白/简介', round.persona === sample.persona
  && round.greeting === sample.greeting && round.tagline === sample.tagline);
check('往返转换保留剧情卡的 scenario', (() => {
  const storyPack = files.find((f) => f.includes('-story-')) || files[0];
  const s = FYCards.parsePack(fs.readFileSync(path.join(LIB, storyPack), 'utf8')).cards[0];
  return FYCards.fromCard(FYCards.toCardV2(s)).scenario === s.scenario;
})());

const ms = Date.now() - t0;
console.log(`\n卡库解析自检：${files.length} 个分片 / ${total} 张卡，App 解析耗时 ${ms} ms`);
console.log(`  角色卡 ${kindSeen.character} 张 / 剧情卡 ${kindSeen.story} 张`);
check('所有分片都能被 App 解析且字段完整', bad === 0, bad ? `${bad} 张有问题` : '');
check('角色卡与剧情卡数量都大于 0', kindSeen.character > 0 && kindSeen.story > 0);
check(`单张解析开销 < 0.5ms（实测 ${(ms / Math.max(1, total)).toFixed(3)}ms）`, ms / Math.max(1, total) < 0.5);
if (V2) {
  check(`v2 目录：每个分片都有 topics 与 keywords（${v2Packs}/${files.length}）`,
    v2BadField === 0 && v2Packs === files.length,
    `坏字段 ${v2BadField} 个`);
  check(`v2 目录：每张卡的主题都在它所在分片的 topics 里（不一致 ${v2TopicMismatch} 片）`,
    v2TopicMismatch === 0);
  check(`v2 目录：主题总数 > 100（实际 ${allTopics.size}）`, allTopics.size > 100,
    '主题太少说明分片没有按主题打包');
  console.log(`  v2：${v2Packs} 片 / ${allTopics.size} 个主题 / 片均 ${(total / Math.max(1, files.length)).toFixed(0)} 张`);
} else {
  console.log('  （v1 目录：跳过分片主题校验）');
}

console.log(`\n结果： ${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('失败项：'); failures.slice(0, 12).forEach((x) => console.log('  · ' + x)); }
process.exit(fail ? 1 : 0);
