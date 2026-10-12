/** 调试：一次完整对话后，S.messages 里到底存了什么 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import 'fake-indexeddb/auto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(__dirname, '../app/assets/ui');
const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const vc = new VirtualConsole();
vc.on('jsdomError', e => console.log('[jsdomError]', e.message));
vc.on('log', (...a) => console.log('[page]', ...a));
vc.on('warn', (...a) => console.log('[page:warn]', ...a));
vc.on('error', (...a) => console.log('[page:err]', ...a));

const dom = new JSDOM(HTML, {
  url: 'http://127.0.0.1:5599/index.html', runScripts: 'dangerously', pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(w) {
    Object.assign(w, {
      indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange,
      TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
      ReadableStream: globalThis.ReadableStream, Response: globalThis.Response,
      Headers: globalThis.Headers, Request: globalThis.Request,
      AbortController: globalThis.AbortController, structuredClone: globalThis.structuredClone,
    });
    if (!w.crypto) w.crypto = {};
    if (!w.crypto.randomUUID) w.crypto.randomUUID = () => 'id-' + Math.random().toString(16).slice(2);
    w.fetch = async (input) => {
      const url = String(input && input.url ? input.url : input);
      if (/^https?:/.test(url)) throw new Error('no net: ' + url);
      return new globalThis.Response(fs.readFileSync(path.join(UI, url.replace(/^\.?\//, ''))), { status: 200 });
    };
  },
});
const { window } = dom;
for (const f of ['store.js', 'mock.js', 'app.js']) window.eval(fs.readFileSync(path.join(UI, f), 'utf8'));
await sleep(400);

const S = window.FYApp.state;
window.FY.engineStart(JSON.stringify({ model: 'Qwen3-4B-Q4_K_M.gguf', ctx: 4096, threads: 6 }));
for (let i = 0; i < 20 && S.engineState.state !== 'ready'; i++) await sleep(300);
console.log('引擎状态:', S.engineState.state, 'port=', S.engineState.port);
window.document.querySelectorAll('.char-card')[0].click();
await sleep(400);
console.log('--- 开会话后 ---');
console.log('messages:', JSON.stringify(S.messages.map(m => ({ r: m.role, c: String(m.content).slice(0, 20), t: String(m.thinking || '').slice(0, 20) })), null, 1));

S.messages.length = 0;
window.FYApp.sendUserMessage('你好呀');
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (!S.generating && S.messages.some(m => m.role === 'assistant')) break;
}
console.log('--- 生成结束后 ---');
console.log('generating =', S.generating);
console.log('lastOptions =', JSON.stringify(S.lastOptions));
S.messages.forEach((m, i) => {
  console.log(`[${i}] role=${m.role} contentLen=${(m.content || '').length} thinkingLen=${(m.thinking || '').length}`);
  console.log('     content =', JSON.stringify(String(m.content).slice(0, 120)));
  console.log('     thinking=', JSON.stringify(String(m.thinking || '').slice(0, 60)));
});
process.exit(0);
