/**
 * probe-plot.mjs —— 用真模型连跑 N 轮剧情模式，统计「选项功能」的实际成功率。
 *
 * 走的是完整真实链路：真实 app.js 组装 prompt → 真 llama-server 生成 →
 * 真实流式解析 → extractOptions（含兜底）→ 选项按钮。
 *
 * 用法: node probe-plot.mjs [模型文件名] [轮数]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import 'fake-indexeddb/auto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UI = path.join(ROOT, 'app/assets/ui');
const PAYLOAD = path.join(ROOT, 'native');
const MODEL = process.argv[2] || 'Qwen3-4B-Q4_K_M.gguf';
const ROUNDS = Number(process.argv[3] || 5);
const PORT = 8125;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch (e) {}
    await sleep(step);
  }
  return false;
}

const engine = spawn(path.join(PAYLOAD, 'libfy_llama_server.so'),
  ['-m', path.join(ROOT, 'models', MODEL), '-c', '4096', '-t', '6',
   '--host', '127.0.0.1', '--port', String(PORT), '--no-webui', '--context-shift', '--cache-reuse', '256'],
  { env: { LD_LIBRARY_PATH: PAYLOAD, PATH: '/system/bin:/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
engine.stdout.on('data', () => {});
engine.stderr.on('data', () => {});
process.on('exit', () => { try { engine.kill('SIGKILL'); } catch (e) {} });

for (let i = 0; i < 240; i++) {
  await sleep(1000);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (r.ok && (await r.text()).includes('ok')) break;
  } catch (e) {}
}
console.log(`引擎就绪：${MODEL}，连跑 ${ROUNDS} 轮剧情\n`);

const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const vc = new VirtualConsole();
vc.on('jsdomError', e => console.log('[jsdomError]', e.message));

const dom = new JSDOM(HTML, {
  url: 'http://127.0.0.1:5599/index.html', runScripts: 'dangerously', pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    Object.assign(window, {
      indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange,
      TextEncoder: globalThis.TextEncoder, TextDecoder: globalThis.TextDecoder,
      ReadableStream: globalThis.ReadableStream, Response: globalThis.Response,
      Headers: globalThis.Headers, Request: globalThis.Request,
      AbortController: globalThis.AbortController, structuredClone: globalThis.structuredClone,
    });
    if (!window.crypto) window.crypto = {};
    if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'id-' + Math.random().toString(16).slice(2);
    const nf = globalThis.fetch;
    window.fetch = (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (/^https?:/.test(url)) return nf(url, init);
      return Promise.resolve(new globalThis.Response(
        fs.readFileSync(path.join(UI, url.replace(/^\.?\//, ''))), { status: 200 }));
    };
    const j = (o) => JSON.stringify(o);
    window.FY = {
      appInfo: () => j({ version: 'probe', abi: 'aarch64', sdk: 34, model: 'termux',
        filesDir: '/tmp', nativeDir: PAYLOAD, modelDir: path.join(ROOT, 'models'), engineProbe: '' }),
      engineStatus: () => j({ state: 'ready', port: PORT, model: MODEL, message: 'ok',
        lastError: '', launchStrategy: 'direct' }),
      engineStart: () => j({ ok: true }), engineStop: () => j({ ok: true }),
      listModels: () => j([]), deleteModel: () => j({ ok: true }),
      pickModelFile: () => j({ ok: true }), importModel: () => j({ ok: true }),
      listDownloadSources: () => j([]), downloadModel: () => j({ ok: true }),
      speak: () => j({ ok: true }), stopSpeak: () => j({ ok: true }),
      startListening: () => j({ ok: true }), stopListening: () => j({ ok: true }),
      keepAwake: () => j({ ok: true }), exportDiagnostics: () => j({ ok: true, path: '' }),
      log: () => {},
    };
  },
});

const { window } = dom;
const doc = window.document;
for (const f of ['store.js', 'app.js']) window.eval(fs.readFileSync(path.join(UI, f), 'utf8'));
await sleep(400);

const S = window.FYApp.state;
await until(() => S.characters.length >= 4, 8000);
doc.querySelectorAll('.char-card')[0].click();
await until(() => S.view === 'chat' && S.session, 5000);
S.session.plot = true;
S.settings.plotDefault = true;
S.store.saveSettings({ showThinking: false, plotDefault: true });
S.settings = S.store.getSettings();

const prompts = [
  '我擦着头发，看着窗外的雨，想找点事做。',
  '雨好像小了，我走到窗边看了看外面。',
  '我有点困了，但又不想睡。',
  '你手里那本书讲的是什么？',
  '我想帮你做点什么。',
];

let withMarker = 0, withLoose = 0, withOptions = 0, noOptions = 0;
const rows = [];

for (let i = 0; i < ROUNDS; i++) {
  const before = new Set(S.messages.map(m => m.id));
  S.lastOptions = [];
  const t0 = Date.now();
  window.FYApp.sendUserMessage(prompts[i % prompts.length]);
  await until(() => {
    if (S.lastOptions && S.lastOptions.length) return true;
    if (!S.generating) {
      return S.messages.some(m => !before.has(m.id) && m.role === 'assistant' && m.content && m.content.trim());
    }
    return false;
  }, 180000);
  await sleep(300);
  const reply = S.messages.filter(m => !before.has(m.id) && m.role === 'assistant').pop();
  const text = (reply && reply.content) || '';
  const hasMarker = /<<<OPTIONS/.test(text);
  const opts = S.lastOptions || [];
  if (hasMarker) withMarker++;
  if (opts.length && !hasMarker) withLoose++;
  if (opts.length) withOptions++; else noOptions++;
  rows.push({ i: i + 1, ms: Date.now() - t0, hasMarker, n: opts.length, opts, tail: text.slice(-90) });
  console.log(`第 ${i + 1} 轮：用时 ${((Date.now() - t0) / 1000).toFixed(1)}s  标记=${hasMarker ? '有' : '无'}  选项=${opts.length}`);
  console.log('   尾部: ' + JSON.stringify(text.slice(-90)));
  opts.forEach((o, k) => console.log(`   ${k + 1}. ${o}`));
}

console.log('\n════ 统计 ════');
console.log(`轮数 ${ROUNDS}：吐了标记 ${withMarker} 次，靠兜底解析出选项 ${withLoose} 次`);
console.log(`剧情选项可用（标记或兜底）: ${withOptions}/${ROUNDS}`);
console.log(`完全没解析出选项: ${noOptions}/${ROUNDS}`);
console.log('成功率: ' + Math.round(withOptions / ROUNDS * 100) + '%');

try { engine.kill('SIGKILL'); } catch (e) {}
process.exit(0);
