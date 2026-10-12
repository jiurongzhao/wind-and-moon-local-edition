/**
 * e2e-real.mjs —— 端到端：真实前端(app.js) + 真实 llama-server + 真实 4B 模型。
 *
 * 和 ui.test.mjs 的区别：那边用 mock.js 造假流式回复，只验证 UI 逻辑；
 * 这边把 mock 换成真的本地推理，于是可以验证「我们写的 system prompt 能不能让
 * 真模型按格式输出剧情选项」「回复是不是真的在角色里」这类只有真模型才能回答的问题。
 *
 * 覆盖：角色卡 → 开会话 → 真实流式对话 → 剧情模式 <<<OPTIONS 解析 → 记忆压缩
 *
 * 用法: node e2e-real.mjs [模型文件名]      （默认用 4B，会真起引擎，约 1~2 分钟）
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
const PORT = 8123;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch (e) { /* ignore */ }
    await sleep(step);
  }
  return false;
}

// ---------------------------------------------------------------- 起真实引擎

const engine = spawn(path.join(PAYLOAD, 'libfy_llama_server.so'),
  ['-m', path.join(ROOT, 'models', MODEL), '-c', '4096', '-t', '6',
   '--host', '127.0.0.1', '--port', String(PORT), '--no-webui', '--context-shift', '--cache-reuse', '256'],
  { env: { LD_LIBRARY_PATH: PAYLOAD, PATH: '/system/bin:/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });

let engineLog = '';
engine.stdout.on('data', d => { engineLog += d.toString(); });
engine.stderr.on('data', d => { engineLog += d.toString(); });

function killEngine() {
  try { engine.kill('SIGKILL'); } catch (e) {}
}
process.on('exit', killEngine);
process.on('SIGINT', () => { killEngine(); process.exit(130); });

console.log(`=== 端到端真跑：${MODEL} + 真实前端 ===`);
console.log('等待引擎就绪（4B 冷启动可能几十秒）…');
const tReady = Date.now();
let ready = false;
for (let i = 0; i < 240; i++) {
  await sleep(1000);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (r.ok && (await r.text()).includes('ok')) { ready = true; break; }
  } catch (e) {}
  if (engine.exitCode !== null) break;
}
console.log(`引擎就绪=${ready}，用时 ${((Date.now() - tReady) / 1000).toFixed(0)}s`);
if (!ready) {
  console.log('引擎日志尾部：\n' + engineLog.split('\n').slice(-20).join('\n'));
  process.exit(1);
}

// ---------------------------------------------------------------- 起前端（真桥桩）

const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const consoleErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => consoleErrors.push('jsdomError: ' + (e && e.message || e)));
vc.on('error', (...a) => consoleErrors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(HTML, {
  url: 'http://127.0.0.1:5599/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    Object.assign(window, {
      indexedDB: globalThis.indexedDB,
      IDBKeyRange: globalThis.IDBKeyRange,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      ReadableStream: globalThis.ReadableStream,
      Response: globalThis.Response,
      Headers: globalThis.Headers,
      Request: globalThis.Request,
      AbortController: globalThis.AbortController,
      structuredClone: globalThis.structuredClone,
    });
    if (!window.crypto) window.crypto = {};
    if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'id-' + Math.random().toString(16).slice(2);

    // 相对资源（presets.json）读文件；到本地推理端口的请求交给 node 的真 fetch
    const nodeFetch = globalThis.fetch;
    window.fetch = (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (/^https?:/.test(url)) return nodeFetch(url, init);
      const p = path.join(UI, url.replace(/^\.?\//, ''));
      return Promise.resolve(new globalThis.Response(fs.readFileSync(p), {
        status: 200,
        headers: { 'content-type': url.endsWith('.json') ? 'application/json' : 'text/plain' },
      }));
    };

    // 真桥桩：直接告诉前端「引擎已就绪，端口是 PORT」
    const j = (o) => JSON.stringify(o);
    window.FY = {
      appInfo: () => j({ version: 'e2e', abi: 'aarch64', sdk: 34, model: 'Termux-JVM',
        filesDir: '/tmp', nativeDir: PAYLOAD, modelDir: path.join(ROOT, 'models'),
        engineProbe: 'e2e' }),
      engineStatus: () => j({ state: 'ready', port: PORT, model: MODEL,
        message: 'e2e 就绪', lastError: '', launchStrategy: 'direct' }),
      engineStart: () => j({ ok: true }),
      engineStop: () => j({ ok: true }),
      listModels: () => j([{ name: MODEL, sizeBytes: 0, path: path.join(ROOT, 'models', MODEL) }]),
      deleteModel: () => j({ ok: true }),
      pickModelFile: () => j({ ok: true }),
      importModel: () => j({ ok: true }),
      listDownloadSources: () => j([]),
      downloadModel: () => j({ ok: true }),
      speak: () => j({ ok: true }),
      stopSpeak: () => j({ ok: true }),
      startListening: () => j({ ok: true }),
      stopListening: () => j({ ok: true }),
      keepAwake: () => j({ ok: true }),
      exportDiagnostics: () => j({ ok: true, path: 'Download/fy-diagnostics.txt' }),
      log: () => {},
    };
  },
});

const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
// 只加载 store.js + app.js —— 不加载 mock.js，因为我们要的是真推理
for (const f of ['store.js', 'app.js']) {
  window.eval(fs.readFileSync(path.join(UI, f), 'utf8'));
}
await sleep(400);

const S = window.FYApp.state;
console.log('\n【1】首屏与引擎状态');
check('角色卡加载', await until(() => S.characters.length >= 4, 8000), '角色数 ' + S.characters.length);
check('引擎状态被识别为就绪', S.engineState.state === 'ready', S.engineState.state);
check('未提示引擎未就绪', $('chatEngineBanner').hidden === true);

console.log('\n【2】真实对话（4B 本地推理）');
const char = S.characters[0];
console.log(`  角色：${char.name}（${char.tagline || ''}）`);
doc.querySelectorAll('.char-card')[0].click();
await until(() => S.view === 'chat' && S.session, 5000);
S.settings.plotDefault = false;
S.session.plot = false;
S.store.saveSettings({ showThinking: false });   // 关思考，和默认一致
S.settings = S.store.getSettings();

const ids0 = new Set(S.messages.map(m => m.id));
window.FYApp.sendUserMessage('今天下了一整天的雨，我刚从外面回来，鞋全湿了。');
const t0 = Date.now();
const got = await until(() => S.messages.some(m => !ids0.has(m.id) && m.role === 'assistant'
  && m.content && m.content.trim().length > 0), 180000);
const reply = S.messages.filter(m => !ids0.has(m.id) && m.role === 'assistant').pop();
console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('  ── 模型回复 ──');
console.log(String(reply && reply.content).split('\n').map(l => '  ' + l).join('\n'));
console.log('  ─────────────');
check('真模型给出了非空回复', got);
check('回复里没有残留思考段', !(reply && /think|｜end/.test(reply.content || '')));
check('回复里没有 OPTIONS 标记泄漏', !(reply && /OPTIONS/.test(reply.content || '')));
check('回复是中文（角色扮演语言一致）', !!(reply && /[\u4e00-\u9fff]/.test(reply.content || '')));
check('没有出现"作为AI/语言模型"这类出戏（Qwen 模型常见失败）',
  !(reply && /(作为(一个)?(AI|人工智能|语言模型)|我是(一个)?(AI|人工智能|语言模型))/.test(reply.content || '')),
  '实际回复见上');

console.log('\n【3】剧情模式：真模型必须按格式吐 <<<OPTIONS');
S.session.plot = true;
S.store.saveSettings({ plotDefault: true });
const ids1 = new Set(S.messages.map(m => m.id));
window.FYApp.sendUserMessage('我擦着头发，看着窗外的雨，想找点事做。');
const gotPlot = await until(() => S.lastOptions && S.lastOptions.length > 0, 180000);
const plotReply = S.messages.filter(m => !ids1.has(m.id) && m.role === 'assistant').pop();
console.log('  ── 剧情回复 ──');
console.log(String(plotReply && plotReply.content).split('\n').map(l => '  ' + l).join('\n'));
console.log('  ── 解析出的选项 ──');
(S.lastOptions || []).forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
check('真模型按格式输出了剧情选项', gotPlot, '选项数 ' + ((S.lastOptions || []).length));
check('选项条渲染成按钮', $('optionsBar').children.length >= 2,
  '按钮数 ' + $('optionsBar').children.length);
check('正文里没有把 OPTIONS 标记显示出来',
  !(plotReply && /<<<OPTIONS|OPTIONS>>>/.test(plotReply.content || '')));

console.log('\n【4】长期记忆压缩（真模型生成摘要）');
const ids2 = new Set(S.messages.map(m => m.id));
for (const t of ['我叫小林，怕黑。', '我们约好周五去河边。', '别忘了带伞。']) {
  S.messages.push({ id: 'x' + Math.random(), sessionId: S.session.id, role: 'user', content: t, ts: Date.now() });
}
window.FYApp.compressMemory(true)
  .then(r => console.log('  compressMemory 返回:', r, '（S.messages 共 ' + S.messages.length + ' 条）'))
  .catch(e => console.log('  压缩失败:', e && e.message));
const memOk = await until(() => {
  const m = S.store.getMemory(S.session.id, '');
  return m && m.text && m.text.length > 0;
}, 180000);
const mem = S.store.getMemory(S.session.id, '');
console.log('  ── 记忆摘要 ──');
console.log('  ' + ((mem && mem.text) || '(无)').split('\n').join('\n  '));
check('真模型生成了记忆摘要', memOk);
/* 注意：compressMemory(true) 压缩的是【最早的】对话（末尾 4 条会保留给上下文），
   所以断言要看早期剧情的关键词（角色名/雨/粥/毛巾），而不是刚 push 到末尾的那三条。 */
check('摘要内容确实来自早期对话（提到角色或早期事件）',
  !!(mem && /林夏|雨|粥|毛巾|湿/.test(mem.text)) && mem.text.length > 20,
  mem && mem.text);

check('全程没有 jsdomError', consoleErrors.filter(e => e.startsWith('jsdomError')).length === 0,
  consoleErrors.slice(0, 2).join(' | '));

killEngine();
console.log('\n' + '─'.repeat(58));
console.log(`结果： ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
