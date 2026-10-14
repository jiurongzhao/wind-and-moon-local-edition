/**
 * bench-render.mjs —— 聊天区渲染：整屏重建 vs 增量渲染。
 *
 * 旧实现 renderMessages() 每次都 box.innerHTML='' 再把所有消息逐条建成 DOM 节点；
 * 长会话里每发一条消息都重建整屏。新实现只重建"渲染签名变了"的消息、新消息只 append。
 *
 * 用法: node bench-render.mjs [每条会话消息数]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(__dirname, '../app/assets/ui');
const N = Number(process.argv[2] || 1500);
const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const SCRIPTS = ['store.js', 'cards.js', 'creator.js', 'mock.js', 'avatar.js', 'app.js'];

const dom = new JSDOM(HTML, {
  url: 'http://127.0.0.1:5599/bench-render',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.indexedDB = globalThis.indexedDB;
    window.IDBKeyRange = globalThis.IDBKeyRange;
    window.IDBDatabase = globalThis.IDBDatabase;
    window.Request = globalThis.Request;
    window.Headers = globalThis.Headers;
    window.AbortController = globalThis.AbortController;
    window.structuredClone = globalThis.structuredClone;
    if (!window.crypto) window.crypto = {};
    if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'id-' + Math.random().toString(16).slice(2);
    window.fetch = async (input) => {
      const url = String(input && input.url ? input.url : input);
      const p = path.join(UI, url.replace(/^\.?\//, ''));
      return new globalThis.Response(fs.readFileSync(p), { status: 200 });
    };
  },
});
const { window } = dom;
const doc = window.document;
for (const f of SCRIPTS) window.eval(fs.readFileSync(path.join(UI, f), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(200);
const S = window.FYApp.state;
for (let i = 0; i < 200 && !(S.store && S.characters.length >= 1); i++) await sleep(50);

function mkSession(title) {
  const s = S.store.saveSession({ title, characterIds: [], mode: 'solo', plot: false });
  for (let i = 0; i < N; i++) {
    S.store.addMessage({
      sessionId: s.id, role: i % 2 ? 'assistant' : 'user',
      content: '第 ' + i + ' 条消息，模拟一段三四十字的中文对话内容，用来量真实节点开销。',
      ts: 1700000000000 + i,
    });
  }
  return s;
}
function useSession(s) { S.session = s; S.messages = S.store.listMessages(s.id); }

console.log('=== 聊天渲染基准：每会话 ' + N.toLocaleString() + ' 条消息 ===\n');
const A = mkSession('压测 A');
const B = mkSession('压测 B');
useSession(A);
window.FYApp.renderMessages();

const time = (label, iters, fn) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn(i);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  ' + label.padEnd(36) + (ms / iters).toFixed(2).padStart(9) + ' ms/次   （' + iters + ' 次共 ' + ms.toFixed(0) + ' ms）');
  return ms / iters;
};

const full = time('整屏重建（旧实现每次的成本）', 20, (i) => {
  useSession(i % 2 ? A : B);
  window.FYApp.renderMessages();
});
const noop = time('增量渲染 · 无变化重渲染', 50, () => window.FYApp.renderMessages());
const append = time('增量渲染 · 追加一条新消息', 20, (i) => {
  const nm = S.store.addMessage({ sessionId: S.session.id, role: 'user', content: '新增 ' + i, ts: Date.now() + 100000 + i });
  S.messages.push(nm);
  window.FYApp.renderMessages();
});

console.log('\n  提速：追加一条消息 ' + (full / append).toFixed(1) + '×，无变化重渲染 ' + (full / noop).toFixed(1) + '×');
console.log('  说明：旧实现每次 renderMessages() 都清空容器、逐条建节点；');
console.log('        新实现按签名只重建变了的、新消息只 append。');

/* jsdom + fake-indexeddb 会留下计时器，进程不主动退出的话脚本会一直挂着 */
process.exit(0);
