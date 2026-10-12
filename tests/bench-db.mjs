/**
 * bench-db.mjs —— 本地数据库在"真实规模"下的表现（jsdom + fake-indexeddb，不需要真机）。
 *
 * 回答一个具体问题：**聊天记录攒到几千条时，存储层会不会成为瓶颈、要不要换 SQLite？**
 * 量四件事：
 *   1) 冷启动：从 IndexedDB 读全库 + 建索引要多久（用户点开 App 的等待时间）
 *   2) 单会话查询：listMessages / lastMessage（每次渲染都会调）
 *   3) 写入：addMessage + 落盘（每轮对话至少 2 次）
 *   4) 长期记忆压缩时的全量扫描（按会话）
 *
 * 用法: node bench-db.mjs [每条会话消息数] [会话数]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(__dirname, '../app/assets/ui');
const PER_SESSION = Number(process.argv[2] || 2000);
const SESSIONS = Number(process.argv[3] || 3);

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:5599/index.html',
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
window.eval(fs.readFileSync(path.join(UI, 'store.js'), 'utf8'));

const t = (label, fn) => {
  const t0 = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms`);
  return { ms, r };
};
const tAsync = async (label, fn) => {
  const t0 = process.hrtime.bigint();
  const r = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms`);
  return { ms, r };
};

console.log(`=== 本地数据库基准：${SESSIONS} 个会话 × ${PER_SESSION} 条消息`
  + `（共 ${(SESSIONS * PER_SESSION).toLocaleString()} 条）===\n`);

const { store } = await window.FYStore.init();

console.log('【写入】逐条 addMessage（含 120ms 防抖合并落盘）');
const sessionIds = [];
const tWrite = t(`灌 ${SESSIONS * PER_SESSION} 条`, () => {
  for (let s = 0; s < SESSIONS; s++) {
    const sess = store.saveSession({ title: '压测会话 ' + s, characterIds: [], mode: 'solo' });
    sessionIds.push(sess.id);
    for (let i = 0; i < PER_SESSION; i++) {
      store.addMessage({
        sessionId: sess.id, role: i % 2 ? 'assistant' : 'user',
        content: '第 ' + i + ' 条消息，模拟一段正常长度的中文对话内容，大约三四十个字。',
        ts: 1700000000000 + s * 10000000 + i,
      });
    }
  }
});
await tAsync('flushNow()（整批落盘）', () => store.flushNow());
await new Promise((r) => setTimeout(r, 800));

console.log('\n【冷启动】重新打开数据库（模拟用户点开 App）');
const tBoot = await tAsync('FYStore.init()（读全库 + 建索引）', () => window.FYStore.init());
const store2 = tBoot.r.store;

console.log('\n【读】单会话查询（每次渲染/发消息都会调）');
const sid = sessionIds[Math.floor(SESSIONS / 2)];
t('listMessages(单会话)', () => store2.listMessages(sid));
t('lastMessage(单会话)', () => store2.lastMessage(sid));
t('countMessages(单会话)', () => store2.countMessages(sid));
t('100 次 lastMessage', () => { for (let i = 0; i < 100; i++) store2.lastMessage(sid); });
t('100 次 listMessages', () => { for (let i = 0; i < 100; i++) store2.listMessages(sid); });

console.log('\n【写】单条追加 + 落盘');
const tAdd = t('addMessage + flushNow', () => {
  store2.addMessage({ sessionId: sid, role: 'user', content: '压测追加一条', ts: Date.now() });
  store2.flushNow();
});
await new Promise((r) => setTimeout(r, 300));

console.log('\n【其它】');
t('listSessions()', () => store2.listSessions());
t('listCharacters()', () => store2.listCharacters());
const st = store2.stats();
console.log(`  统计: 角色 ${st.characters} / 会话 ${st.sessions} / 消息 ${st.messages}`
  + ` / 写次数 ${st.writes} / 后端 ${st.engine}`);

console.log('\n结论提示：冷启动和单会话查询是不是"秒开"级别，直接决定要不要上 SQLite 分页。');
