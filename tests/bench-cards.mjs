/**
 * bench-cards.mjs —— 角色卡库在"三万张"规模下的数据结构开销。
 *
 * 针对的是"打开角色页要等多久 / 搜一次要多久"背后的两件事：
 *   1) listCharacters()：老实现每次都 slice + sort 三万条；
 *   2) getCharacter()/saveCharacter()：老实现用 indexOfId 全表 linear scan。
 * 改完这两处都是 O(1)/O(log n) 级别，这个脚本就是拿数字证明。
 *
 * 可以传两份 store.js 做前后对照（旧版从 git 里取）：
 *   node bench-cards.mjs ../app/assets/ui/store.js 32000
 *   node bench-cards.mjs /data/.../store-head.js 32000
 *
 * 用法: node bench-cards.mjs [store.js 路径] [卡数]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.argv[2] || path.resolve(__dirname, '../app/assets/ui/store.js');
const N = Number(process.argv[3] || 32000);

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:5599/bench-cards',
  runScripts: 'dangerously',
  beforeParse(window) {
    window.indexedDB = globalThis.indexedDB;
    window.IDBKeyRange = globalThis.IDBKeyRange;
    window.IDBDatabase = globalThis.IDBDatabase;
    window.structuredClone = globalThis.structuredClone;
    if (!window.crypto) window.crypto = {};
    if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'id-' + Math.random().toString(16).slice(2);
    window.localStorage.clear();
  },
});
const { window } = dom;
window.eval(fs.readFileSync(STORE, 'utf8'));

const t = (label, fn) => {
  const t0 = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  ' + label.padEnd(34) + ms.toFixed(1).padStart(9) + ' ms');
  return r;
};

console.log('=== 角色卡库基准：' + N.toLocaleString() + ' 张 ===');
console.log('  store: ' + STORE + '\n');

const { store } = await window.FYStore.init();

const seeds = [];
for (let i = 0; i < N; i++) {
  seeds.push({
    name: '角色' + i,
    tagline: '第 ' + i + ' 号角色的简介',
    persona: '这是一段大约一百字的人设文本，用来模拟真实卡库里的内容。'.repeat(4) + i,
    tags: ['日常治愈', '恋爱'],
    greeting: '（抬头）你来了。',
    examples: '',
    systemPrompt: '你扮演一个角色。/no_think',
    createdAt: 1700000000000 + i,
    updatedAt: 1700000000000 + i,
  });
}

t('saveCharacters 首次导入 ' + N.toLocaleString() + ' 张', () => store.saveCharacters(seeds));
const saved = store.listCharacters();
const ids = saved.map((c) => c.id);

t('listCharacters ×100（首屏/切分类）', () => { for (let i = 0; i < 100; i++) store.listCharacters(); });
t('getCharacter ×10000（开会话/查角色）', () => {
  for (let i = 0; i < 10000; i++) store.getCharacter(ids[i % N]);
});
t('saveCharacter ×2000（改已有卡）', () => {
  for (let i = 0; i < 2000; i++) {
    const c = saved[i];
    store.saveCharacter({ id: c.id, name: c.name, avatar: c.avatar, tagline: '改一下 ' + i, persona: c.persona, tags: c.tags });
  }
});
t('saveCharacters 更新全部（改简介）', () => {
  store.saveCharacters(saved.map((c) => ({
    id: c.id, name: c.name, avatar: c.avatar, tagline: '批量改',
    persona: c.persona, tags: c.tags,
  })));
});

console.log('\n  说明：老实现对 listCharacters 每次 slice+sort、对 get/save 全表 linear scan；');
console.log('        新实现 listCharacters 走排序缓存、get/save 走 id→对象哈希。');
