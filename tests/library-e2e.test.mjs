/**
 * library-e2e.test.mjs —— 「在线卡库」真实端到端（不用手机，但用**真目录 + 真分片**）。
 *
 * 和 ui.test.mjs 的区别：那边用假目录/假卡包验证逻辑；这里把
 *   cards/library-index.json + cards/library/*.json（每片 2~3MB 真数据）
 * 通过一个本地 http 镜像喂进去，走完整链路：
 *   拉目录 → 聚合成行 → 下载分片 → 校验张数 → 批量入库 → 窗口化渲染 → 幂等
 *
 * 前置：本地镜像要起着（一条命令，镜像目录放在仓库外，build.sh 不会清掉它）：
 *   ./tools/dev-mirror.sh            # 默认 8765，停：./tools/dev-mirror.sh --stop
 * 想换端口： MIRROR=http://127.0.0.1:9000/ node library-e2e.test.mjs（脚本端口也要一起改）
 *
 * 跑法： cd ~/2/fy/tests && node library-e2e.test.mjs
 * 镜像没起 / cards/library 不存在 → 跳过（exit 0），不阻塞 CI。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import 'fake-indexeddb/auto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UI = path.join(ROOT, 'app', 'assets', 'ui');
const MIRROR = process.env.MIRROR || 'http://127.0.0.1:8765';

if (!fs.existsSync(path.join(ROOT, 'cards', 'library'))) {
  console.log('（跳过：cards/library/ 还没生成）');
  process.exit(0);
}
try {
  const r = await fetch(MIRROR + '/index.json', { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
} catch (e) {
  console.log(`（跳过：本地镜像 ${MIRROR} 没起来 —— ${e.message}）`);
  process.exit(0);
}

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 60000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch (e) { /* ignore */ }
    await sleep(step);
  }
  return false;
}

const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const SCRIPTS = ['store.js', 'cards.js', 'creator.js', 'mock.js', 'app.js'];
const consoleErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => consoleErrors.push(String(e && e.message || e)));
vc.on('error', (...a) => consoleErrors.push(a.join(' ')));

const dom = new JSDOM(HTML, {
  url: 'http://127.0.0.1:5599/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.indexedDB = globalThis.indexedDB;
    window.IDBKeyRange = globalThis.IDBKeyRange;
    window.IDBDatabase = globalThis.IDBDatabase;
    window.TextEncoder = globalThis.TextEncoder;
    window.TextDecoder = globalThis.TextDecoder;
    window.ReadableStream = globalThis.ReadableStream;
    window.Response = globalThis.Response;
    window.Headers = globalThis.Headers;
    window.Request = globalThis.Request;
    window.AbortController = globalThis.AbortController;
    window.structuredClone = globalThis.structuredClone;
    if (!window.crypto) window.crypto = {};
    if (!window.crypto.randomUUID) window.crypto.randomUUID = () => 'id-' + Math.random().toString(16).slice(2);
    window.fetch = async (input, opts) => {
      const url = String(input && input.url ? input.url : input);
      /* 同源 /fetch?url=… 代理 → 直接去打本地镜像（真网络，真 3MB JSON） */
      const m = /^\/fetch\?url=(.+)$/.exec(url);
      if (m) {
        const real = decodeURIComponent(m[1]);
        const r = await fetch(real, opts);
        const buf = Buffer.from(await r.arrayBuffer());
        return new globalThis.Response(buf, {
          status: r.status,
          headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' },
        });
      }
      if (/^https?:/.test(url)) throw new Error('测试环境不联网: ' + url);
      const p = path.join(UI, url.replace(/^\.?\//, ''));
      return new globalThis.Response(fs.readFileSync(p), {
        status: 200,
        headers: { 'content-type': url.endsWith('.json') ? 'application/json' : 'text/plain' },
      });
    };
  },
});

const { window } = dom;
const doc = window.document;
for (const f of SCRIPTS) window.eval(fs.readFileSync(path.join(UI, f), 'utf8'));
const $ = (id) => doc.getElementById(id);
await sleep(400);

const S = window.FYApp.state;
const App = window.FYApp;

console.log('\n【真卡库端到端：目录 → 下载 → 校验 → 入库 → 窗口化 → 幂等】');
check('应用启动（存储就绪）', !!S.store && S.engine === 'indexeddb', String(S.engine));

/* 目录：指向本地镜像 */
S.settings = S.store.saveSettings({ libCatalogUrl: MIRROR + '/index.json', libraryImported: {} });
const before = S.characters.length;
App.switchView('characters');
await sleep(200);

/* 打开面板，等目录渲染成行 */
const opened = await until(() => {
  if ($('libMask').hidden) App.openLibrarySheet();
  return doc.querySelectorAll('#libList .model-row, #libMask .model-row').length >= 30;
}, 30000);
const rows = doc.querySelectorAll('#libMask .model-row').length;
check('目录拉取成功并渲染出 32 组（分类 × 类型）', opened && rows === 32, '行数 ' + rows);
check('面板显示的目录总数与目录一致（32000）', /32000/.test($('libStatus') ? $('libStatus').textContent : '') ||
  /32000/.test($('libMask').textContent), ($('libStatus') || {}).textContent);

/* ---- v2：按主题关键词只下载"某一个分类的一部分" ---- */
const partRow = App.libRows().find((r) => (r.packs || []).length >= 2
  && !(r.slug === 'mystery' && r.kind === 'character'));
check('v2 目录：一个「分类 × 类型」被切成多个主题片',
  !!partRow && partRow.packs.length >= 2,
  partRow ? `${partRow.tag}/${partRow.kind} ${partRow.packs.length} 片` : 'none');
const topicWord = (partRow.packs[0].topics || [])[0] || (partRow.packs[0].keywords || [])[0] || '';
const hits = App.libSearchPacks(topicWord);
check(`v2 目录：搜主题「${topicWord}」只命中部分片（${hits.length}/${partRow.packs.length}）`,
  hits.length > 0 && hits.length < partRow.packs.length,
  hits.map((p) => p.file).join(', '));
const beforePart = S.characters.length;
const wantPart = hits.reduce((a, p) => a + (Number(p.count) || 0), 0);
let partRes = { added: 0 };
for (let guard = 0; guard < 3; guard++) {
  try { partRes = await App.importLibraryPacks(hits); break; } catch (e) { await sleep(300); }
}
check(`v2 目录：只下载命中的分片（+${partRes.added} 张，整组是 ${partRow.total} 张）`,
  partRes.added === wantPart && partRes.added > 0 && partRes.added < partRow.total,
  `新增 ${partRes.added} / 期望 ${wantPart} / 整组 ${partRow.total}`);
check('v2 目录：只有命中的分片进了 libraryImported',
  hits.every((p) => S.settings.libraryImported[p.file])
  && partRow.packs.filter((p) => hits.indexOf(p) < 0)
    .every((p) => !S.settings.libraryImported[p.file]),
  Object.keys(S.settings.libraryImported || {}).length + ' 片已记录');
const partSample = S.characters.find((c) => (c.tags || []).indexOf(partRow.tag) >= 0);
check('v2 目录：部分下载的卡字段完整', !!(partSample && partSample.persona && partSample.greeting),
  partSample ? `${partSample.name} / ${partSample.persona.length}字` : 'none');

/* 真的下载并导入一行（悬疑推理 · 角色卡，1000 张 / 2.8MB） */
const t0 = Date.now();
const row = App.libRows().find((r) => r.slug === 'mystery' && r.kind === 'character');
check('能定位到「悬疑推理 · 角色卡」这一行', !!row, row ? row.tag + '/' + row.kind : 'none');
const importedDone = await until(() => {
  App.importLibraryRow(row).catch(() => {});
  return (S.characters.length - before) >= 1000;
}, 120000, 300);
const cost = Date.now() - t0;
check('1000 张真分片下载 + 入库完成', importedDone, `新增 ${S.characters.length - before} 张，耗时 ${cost}ms`);
check('导入记录写进设置（libraryImported）',
  !!(S.settings.libraryImported && S.settings.libraryImported['mystery-character-1.json']),
  JSON.stringify(Object.keys(S.settings.libraryImported || {})).slice(0, 80));

const sample = S.characters.find((c) => c.tags && c.tags.indexOf('悬疑推理') >= 0);
check('入库的卡字段完整（人设/开场白/分类/温度）',
  !!(sample && sample.persona && sample.persona.length > 60 && sample.greeting && sample.temperature >= 0),
  sample ? `${sample.name} / ${sample.persona.length}字` : 'none');

/* 窗口化渲染：1000+ 张时只建 60 个 DOM 节点，加载更多后才变多 */
App.switchView('characters');
await sleep(400);
const rendered1 = doc.querySelectorAll('#charGrid .char-card').length;
const moreText = $('charMore') ? $('charMore').textContent : '';
check('窗口化渲染：首屏只建 60 张卡（不是 1000 张）', rendered1 === 60, '实际 ' + rendered1);
check('底部提示显示「已显示 60 / N」', /已显示\s*60\s*\//.test(moreText), moreText.trim().slice(0, 40));
App.loadMoreCharacters();
await sleep(300);
const rendered2 = doc.querySelectorAll('#charGrid .char-card').length;
check('加载更多后追加到 120 张', rendered2 === 120, '实际 ' + rendered2);

/* 幂等：同一片再导一次，不该翻倍 */
const mid = S.characters.length;
const again = await until(async () => {
  try { await App.importLibraryRow(row); } catch (e) { /* 已导入时可能直接返回 */ }
  return true;
}, 30000);
await sleep(800);
check('重复导入同一分片不会重复建卡（按名字幂等）', S.characters.length === mid,
  `之前 ${mid} → 现在 ${S.characters.length}`);

const cErrs = consoleErrors.filter((e) => !/Not implemented|Could not parse CSS/.test(e));
check('过程中没有 JS 异常', cErrs.length === 0, cErrs.slice(0, 2).join(' | '));

/* FULL=1：把 32 片全部导入（32000 张），量一下总耗时与内存 —— 手机内存够不够的参考 */
if (process.env.FULL === '1') {
  console.log('\n【全量：32 片 / 32000 张】');
  const tAll = Date.now();
  const allRows = App.libRows();
  for (const r of allRows) {
    if (r.slug === 'mystery' && r.kind === 'character') continue;   // 上面已导过
    let guard = 0;
    while (guard < 3) {
      guard++;
      try { await App.importLibraryRow(r); break; } catch (e) { await sleep(300); }
    }
  }
  const okAll = await until(() => S.characters.length >= 32000, 300000, 500);
  const costAll = Date.now() - tAll;
  const heap = Math.round((process.memoryUsage().heapUsed / 1048576));
  check('32000 张全部下载并入库', okAll, `实际 ${S.characters.length} 张，耗时 ${(costAll / 1000).toFixed(1)}s`);
  check('全部导入后列表仍是窗口化（DOM 只有 60 张卡）', doc.querySelectorAll('#charGrid .char-card').length === 60,
    String(doc.querySelectorAll('#charGrid .char-card').length));
  console.log(`   Node 堆占用约 ${heap} MB（jsdom + fake-indexeddb + 32000 张卡对象）`);
}

console.log('\n' + '─'.repeat(60));
console.log(`结果： ${pass} 通过 / ${fail} 失败   （真实分片 1 片 / 新增 ${S.characters.length - before} 张 / ${cost}ms）`);
if (failures.length) { console.log('失败项：'); failures.forEach((f) => console.log('  · ' + f)); }
process.exit(fail ? 1 : 0);
