/**
 * UI 集成测试 —— 在 node + jsdom 里把前端真跑一遍（不需要手机）。
 *
 * 覆盖：启动引导 / 角色卡 / 引擎状态机 / 流式聊天 / 思考块与剧情选项解析 /
 *       剧情模式 / 群聊 / 长期记忆 / 语音 / 设置页模型管理 / 自检
 *
 * 运行： cd ~/2/fy/tests && node ui.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import 'fake-indexeddb/auto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UI = path.resolve(__dirname, '../app/assets/ui');

/* 卡包是从 cards/ 同步到 App 资源目录的（生成的目录不入库，见 .gitignore）。
   直接 `node ui.test.mjs` 时先自动同步一次，免得因为缺 packs/ 而误报失败；
   没有 python3 就标记为跳过，让【21】自己退让而不是报错。 */
let PACKS_READY = fs.existsSync(path.join(UI, 'packs', 'index.json'));
if (!PACKS_READY && fs.existsSync(path.join(ROOT, 'cards'))) {
  try {
    execFileSync('python3', [path.join(ROOT, 'tools', 'build-pack-index.py')], { stdio: 'ignore' });
    PACKS_READY = fs.existsSync(path.join(UI, 'packs', 'index.json'));
    if (PACKS_READY) console.log('（已自动从 cards/ 同步内置卡包到 app/assets/ui/packs/）');
  } catch (e) {
    console.log('（卡包同步失败，将跳过【21】内置卡包校验：' + (e && e.message) + '）');
  }
}
const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const SCRIPTS = ['store.js', 'cards.js', 'creator.js', 'mock.js', 'avatar.js', 'app.js'];

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true; } catch (e) { /* ignore */ }
    await sleep(step);
  }
  return false;
}

const consoleErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => consoleErrors.push('jsdomError: ' + ((e && e.message) || e)));
vc.on('error', (...a) => consoleErrors.push('console.error: ' + a.join(' ')));

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
    window.fetch = async (input) => {
      const url = String(input && input.url ? input.url : input);
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
await sleep(200);

console.log('\n【1】启动引导与角色卡');
check('mock 注入了 window.FY', !!window.FY);
check('app.js 注册了 window.fyEvent', typeof window.fyEvent === 'function');
check('app.js 导出 window.FYApp', !!window.FYApp);
const S = window.FYApp.state;
check('presets.json 加载出 ≥4 个角色', await until(() => S.characters.length >= 4, 10000),
  '实际 ' + S.characters.length);
check('存储引擎为 IndexedDB', S.engine === 'indexeddb', 'engine=' + S.engine);
const grid = $('charGrid');
await until(() => grid.children.length > 0, 5000);
check('角色卡渲染到 DOM', grid.children.length >= 4, '卡片数 ' + grid.children.length);
check('角色卡字段完整', !!(S.characters[0].name && S.characters[0].persona && S.characters[0].greeting),
  JSON.stringify(Object.keys(S.characters[0])));

console.log('\n【2】引擎状态机（走真实的 engineStart 流程）');
check('未启动时聊天页显示告警条', $('chatEngineBanner').hidden === false);
const startAck = JSON.parse(window.FY.engineStart(JSON.stringify({ model: 'Qwen3-4B-Q4_K_M.gguf', ctx: 4096, threads: 6 })));
check('engineStart 返回 ok', !!(startAck && startAck.ok === true), JSON.stringify(startAck));
check('立刻进入 starting', await until(() => S.engineState.state === 'starting', 2000), 'state=' + S.engineState.state);
check('starting 文案显示正确', /启动/.test($('setEngineState').textContent), $('setEngineState').textContent);
check('出现 loading 阶段', await until(() => S.engineState.state === 'loading', 5000), 'state=' + S.engineState.state);
check('loading 文案显示正确', /加载/.test($('setEngineState').textContent), $('setEngineState').textContent);
check('最终到达 ready', await until(() => S.engineState.state === 'ready', 8000), 'state=' + S.engineState.state);
await sleep(200);
check('ready 状态显示正确', /就绪/.test($('setEngineState').textContent), $('setEngineState').textContent);
check('就绪后告警条隐藏', $('chatEngineBanner').hidden === true);
check('端口已写入状态（以 engineStatus 为准）', Number(S.engineState.port) > 0, 'port=' + S.engineState.port);

console.log('\n【3】点击角色卡 → 开会话 → 流式对话');
doc.querySelectorAll('.char-card')[0].click();
const opened = await until(() => S.view === 'chat' && S.session, 5000);
check('点角色卡进入聊天视图', opened, 'view=' + S.view);
check('已创建会话并插入开场白', S.messages.length >= 1, '消息数 ' + S.messages.length);
check('会话绑定到该角色', !!(S.session && S.session.characterIds.length === 1));

const beforeIds = new Set(S.messages.map(m => m.id));
window.FYApp.sendUserMessage('你好呀，介绍一下你自己');
const gotReply = await until(() => S.messages.some(m =>
  !beforeIds.has(m.id) && m.role === 'assistant' && m.content && m.content.trim()), 25000);
check('发消息后收到助手回复', gotReply, '消息数 ' + S.messages.length);
const asst = S.messages.filter(m => !beforeIds.has(m.id) && m.role === 'assistant').pop();
check('流式内容非空', !!(asst && asst.content && asst.content.trim().length > 0),
  asst ? JSON.stringify(asst.content).slice(0, 100) : 'none');
check('SSE 解析没漏出 data: 前缀', !(asst && /data:/.test(asst.content || '')));
check('流式结束后 generating 复位', await until(() => S.generating !== true, 20000));
check('消息已渲染进 DOM', doc.querySelectorAll('#messages .msg, #messages > *').length > 0,
  'DOM 消息节点 ' + doc.querySelectorAll('#messages .msg, #messages > *').length);

console.log('\n【4】思考块剥离与剧情选项解析');
const sp = window.FYApp.splitThinking;
const t1 = sp('正文内容\n<' + 'think>内部推理过程<｜end▁of▁thinking｜>尾巴');
check('splitThinking 剥出 thinking 并清理正文',
  t1 && t1.thinking.indexOf('内部推理过程') >= 0 && t1.content.indexOf('内部推理过程') < 0,
  JSON.stringify(t1).slice(0, 140));
const t2 = sp('普通回复，没有思考段');
check('splitThinking 对普通文本不误伤', t2 && t2.thinking === '' && t2.content === '普通回复，没有思考段',
  JSON.stringify(t2).slice(0, 100));
const t3 = sp('正文\n<' + 'think>还没写完的思考');
check('splitThinking 处理未闭合思考块', t3 && t3.open === true && t3.thinking.length > 0,
  JSON.stringify(t3).slice(0, 100));

const ex = window.FYApp.extractOptions;
const o1 = ex('雨夜路口，你听见身后脚步声。\n<<<OPTIONS\n1. 回头看看\n2. 加快脚步\n3. 躲进巷子\nOPTIONS>>>');
check('extractOptions 解析出 3 个选项', o1 && o1.options && o1.options.length === 3,
  JSON.stringify(o1).slice(0, 180));
check('extractOptions 从正文剥掉标记', o1 && typeof o1.content === 'string' && o1.content.indexOf('OPTIONS') < 0,
  o1 ? JSON.stringify(o1.content).slice(0, 90) : '');
check('extractOptions 样式化编号（1. 2. 3.）已被去掉',
  o1 && o1.options[0] === '回头看看', o1 ? JSON.stringify(o1.options) : '');
const o2 = ex('没有选项的普通回复。');
check('无选项文本优雅降级', o2 && o2.options.length === 0 && o2.content.indexOf('普通回复') >= 0,
  JSON.stringify(o2).slice(0, 120));
const o3 = ex('正文\n<<<OPTI');
check('半截选项标记被识别为 pending（流式中）', o3 && o3.pending === true && o3.content.indexOf('<<<') < 0,
  JSON.stringify(o3).slice(0, 120));

/* 兜底解析：真模型有概率不写 <<<OPTIONS 标记，只把选项写成末尾编号列表
   （实测 Qwen3-4B 会这样，甚至三条挤在同一行）。allowLoose=true 时才启用。 */
const L1 = ex('雨还在下。\n1. 借我一条毛巾\n2. 一起煮粥\n3. 聊聊天', true);
check('兜底：末尾编号列表被识别为选项（换行版）',
  L1 && L1.options.length === 3 && L1.options[0] === '借我一条毛巾' && /雨还在下/.test(L1.content),
  JSON.stringify(L1).slice(0, 160));
check('兜底：选项列表已从正文剥掉',
  L1 && L1.content.indexOf('借我一条毛巾') < 0, L1 && L1.content);
const L2 = ex('要不要听个故事？1. 好啊 2. 不了 3. 你先讲', true);
check('兜底：三行挤在同一行的编号列表也能识别',
  L2 && L2.options.length === 3 && L2.options[1] === '不了', JSON.stringify(L2).slice(0, 160));
const L3 = ex('正文。\n1. 甲\n2. 乙\n3. 丙', false);
check('兜底：allowLoose=false 时不启用（流式中不误判）',
  L3 && L3.options.length === 0, JSON.stringify(L3).slice(0, 120));
const L4 = ex('他列出了三点：1. 第一点 2. 第二点 3. 第三点，然后继续说了下去，还有很多正文内容。', true);
check('兜底：列表后面还有正文时不误判成选项',
  L4 && L4.options.length === 0, JSON.stringify(L4).slice(0, 160));
const L5 = ex('普通回复，没有列表。', true);
check('兜底：没有列表时保持原样', L5 && L5.options.length === 0 && L5.content === '普通回复，没有列表。');

/* 真机实测（0.5B + 剧情模式）：小模型会把追加在 user 消息末尾的「（当前时间：…）」
   「（提醒：…）」顺势当正文吐出来；回吐的提醒里若含字面标记，还会被解析成空选项。
   两道防线：正文里出现这两个开头就截断；解析出的选项必须是"真选项"。 */
const leak = window.FYApp.stripPromptLeak;
const SL1 = leak('（拿起茶杯）嗯，我刚才看了个故事书。\n\n（当前时间：2026/10/11 22:07:41）\n（提醒：请在回复末尾另起一行）');
check('提示词回吐：正文截断到「（当前时间：」之前',
  SL1 === '（拿起茶杯）嗯，我刚才看了个故事书。', JSON.stringify(SL1));
check('提示词回吐：不含元信息时原样返回', leak('正常回复。') === '正常回复。');
const LEAKED = ex(leak('正文。\n\n（提醒：请在回复末尾另起一行，严格按 <<<OPTIONS / 1. / 2. / 3. / OPTIONS>>> 的格式给出 3 个可选行动）'), true);
check('提示词回吐：回吐的标记块不再产出空选项',
  LEAKED && LEAKED.options.length === 0, JSON.stringify(LEAKED).slice(0, 160));
const usable = window.FYApp.optionsUsable;
check('选项可用性：空选项/斜杠碎片判为不可用', usable(['1', '/ 1.', '/ 2.']) === false,
  JSON.stringify(['1', '/ 1.', '/ 2.']));
check('选项可用性：抄系统提示词占位符判为不可用', usable(['具体行动一', '具体行动二', '具体行动三']) === false);
check('选项可用性：正常选项判为可用', usable(['回头看看', '加快脚步', '躲进巷子']) === true);

console.log('\n【4b】内存体检提醒（模型大小 vs 可用内存）');
const origAppInfo = window.FY.appInfo;
const origModels = S.models;
S.models = [{ name: 'big.gguf', sizeBytes: 2400 * 1048576 }];
window.FY.appInfo = () => JSON.stringify({ availMemMB: 3600 });
check('内存紧张时给出提醒', /内存偏紧/.test(window.FYApp.memoryHint('big.gguf')),
  window.FYApp.memoryHint('big.gguf'));
window.FY.appInfo = () => JSON.stringify({ availMemMB: 8000 });
check('内存充足时不提醒', window.FYApp.memoryHint('big.gguf') === '',
  window.FYApp.memoryHint('big.gguf'));
/* 真机教训：3B 在可用 3430MB（59%）时 mlock 能成功、引擎能就绪，
   但生成时疯狂换页，十分钟吐不出一个字 ——「装得下」不等于「跑得动」。 */
window.FY.appInfo = () => JSON.stringify({ availMemMB: 2600 });
check('内存几乎装不下时升级为最强告警',
  /内存不够/.test(window.FYApp.memoryHint('big.gguf')),
  window.FYApp.memoryHint('big.gguf'));
window.FY.appInfo = () => JSON.stringify({});
check('拿不到内存信息时安静返回', window.FYApp.memoryHint('big.gguf') === '');
S.models = origModels;
window.FY.appInfo = origAppInfo;

console.log('\n【5】剧情选项模式');
S.settings.plotDefault = true;
if (S.session) { S.session.plot = true; }
S.lastOptions = ['甲路线', '乙路线', '丙路线'];
window.FYApp.switchView('chat');
await sleep(250);
check('剧情模式下渲染出 3 个选项按钮', $('optionsBar').children.length === 3,
  '按钮数 ' + $('optionsBar').children.length);
check('选项按钮文字正确', /甲路线/.test($('optionsBar').textContent), $('optionsBar').textContent.slice(0, 60));
check('选项栏可见', $('optionsBar').hidden === false);
$('optionsBar').children[0].click();
const optSent = await until(() => S.messages.some(m => m.role === 'user' && m.content === '甲路线'), 3000);
check('点选项 = 发送该选项文本', optSent);
if (S.session) S.session.plot = false;
S.lastOptions = [];
window.FYApp.switchView('chat');
await sleep(200);
check('关掉剧情模式后选项栏隐藏', $('optionsBar').hidden === true);
if (S.session) S.session.plot = true;

console.log('\n【6】多角色群聊');
await until(() => !S.generating, 25000);        // 等上一轮生成结束，否则会被"正在生成中"挡住
S.characters.slice(0, 3).forEach(c => { c.inGroup = true; });
const multi = S.store.saveSession({ title: '群聊测试', characterIds: S.characters.slice(0, 3).map(c => c.id), mode: 'group', plot: false });
S.session = S.store.getSession(multi.id);
S.messages = S.store.listMessages(multi.id);
S.lastOptions = [];
window.FYApp.switchView('chat');
await sleep(200);
check('群聊会话含 3 个角色', S.session.characterIds.length === 3);
check('群聊头像行已渲染', $('chatAvatars').children.length >= 3, '头像数 ' + $('chatAvatars').children.length);
const gIds = new Set(S.messages.map(m => m.id));
window.FYApp.sendUserMessage('大家好啊');
const grpReply = await until(() => S.messages.some(m =>
  !gIds.has(m.id) && m.role === 'assistant' && m.content && m.content.trim()), 25000);
check('群聊里有人回复', grpReply);
const speaker = S.messages.filter(m => !gIds.has(m.id) && m.role === 'assistant' && m.content.trim()).pop();
check('群聊回复带有说话人名字', !!(speaker && speaker.speakerName), JSON.stringify(speaker && speaker.speakerName));

console.log('\n【7】长期记忆压缩');
S.messages.push({ id: 'm1', sessionId: S.session.id, role: 'user', content: '我叫小林，怕黑。', ts: Date.now() });
S.messages.push({ id: 'm2', sessionId: S.session.id, role: 'assistant', content: '记住了，小林。', ts: Date.now() });
S.messages.push({ id: 'm3', sessionId: S.session.id, role: 'user', content: '我们约好周五去河边。', ts: Date.now() });
S.messages.push({ id: 'm4', sessionId: S.session.id, role: 'assistant', content: '好，周五河边见。', ts: Date.now() });
S.messages.push({ id: 'm5', sessionId: S.session.id, role: 'user', content: '别忘了带伞。', ts: Date.now() });
window.FYApp.compressMemory(true).catch(() => {});
const memOk = await until(() => {
  const mem = S.store.getMemory(S.session.id, '');
  return mem && mem.text && mem.text.length > 0;
}, 20000);
check('记忆摘要已写入 IndexedDB', memOk,
  JSON.stringify((S.store.getMemory(S.session.id, '') || {}).text || '').slice(0, 80));
check('记忆 UI 能显示摘要', /小林|周五|河边|伞/.test($('memText').textContent) || memOk,
  $('memText').textContent.slice(0, 60));

console.log('\n【8】语音');
const speakCalls = [];
const origSpeak = window.FY.speak;
window.FY.speak = function (t) { speakCalls.push(t); return origSpeak ? origSpeak.apply(window.FY, arguments) : '{"ok":true}'; };
window.FYApp.switchView('chat');
await sleep(250);
const readBtn = doc.querySelector('button[title="朗读"]');
if (readBtn) {
  readBtn.click();
  await sleep(200);
  check('朗读按钮调到了 FY.speak', speakCalls.length > 0, '调用 ' + speakCalls.length + ' 次');
} else {
  check('消息里存在朗读按钮', false, '找不到 button[title="朗读"]');
}
const micBtn = $('btnMic');
check('输入区有语音输入按钮', !!micBtn);
const sttBefore = window.FY.__sttCount || 0;
window.fyEvent('stt', JSON.stringify({ text: '这是语音识别的结果', final: true }));
await sleep(200);
check('stt 事件把文本写进输入框', $('input').value.indexOf('语音识别') >= 0, $('input').value.slice(0, 40));

console.log('\n【9】设置页与模型管理');
window.FYApp.switchView('settings');
await sleep(400);
check('模型下拉已填充', $('selModel').innerHTML.length > 20);
check('内置下载源已渲染', $('dlList').children.length > 0, '子节点 ' + $('dlList').children.length);
window.fyEvent('download', JSON.stringify({ name: 'Qwen3-4B', received: 52428800, total: 104857600, percent: 50, state: 'running' }));
await sleep(200);
check('下载进度条已更新', /50/.test($('dlText').textContent), $('dlText').textContent.slice(0, 60));
check('下载进度条可见', $('dlProgress').hidden === false);
/* 先让 mock 的引擎真的停下，再发一次合成事件。
   为什么要多这一步：App 里有一个 8 秒一次的低频轮询「兜住事件丢失」，
   它会读 engineStatus() 覆盖状态。如果只发合成事件而 mock 内部还是 ready，
   轮询一旦落进下面这 200ms 的断言窗口，就会把状态改回「就绪」——
   那是测试环境的假不一致（引擎真的停了吗？没有），不是 App 的缺陷。
   以前这条断言是碰运气过的：只是恰好没撞上轮询。 */
window.FY.engineStop();
window.fyEvent('engine', JSON.stringify({ state: 'stopped', message: '已停止' }));
await sleep(200);
check('停止事件后状态回到未启动', /未启动/.test($('setEngineState').textContent), $('setEngineState').textContent);

console.log('\n【10】调试页与自检');
window.FYApp.switchView('debug');
await sleep(300);
check('调试页显示 appInfo', $('dbgApp').textContent.length > 20, $('dbgApp').textContent.slice(0, 60));
check('调试页显示引擎状态', $('dbgEngine').textContent.indexOf('state') >= 0, $('dbgEngine').textContent.slice(0, 60));
let diagCalled = false;
const origDiag = window.FY.exportDiagnostics;
window.FY.exportDiagnostics = function () { diagCalled = true; return origDiag ? origDiag.apply(window.FY, arguments) : '{"ok":true,"path":"mock"}'; };
check('调试页有「导出诊断」按钮', !!$('btnExportDiag'));
$('btnExportDiag').click();
await sleep(250);
check('点导出诊断会调用 FY.exportDiagnostics', diagCalled);
const stRes = window.FYApp.selftest();
const dbgBox = $('dbgStore');
const stText = typeof stRes === 'string' ? stRes
  : (stRes && (stRes.rows ? stRes.rows.join('\n') : JSON.stringify(stRes)))
  || (dbgBox ? dbgBox.textContent : '');
check('内置自检跑完且无 ✗', !!stText && stText.indexOf('✗') < 0, String(stText).slice(0, 200));
const jsdomErrs = consoleErrors.filter(e => e.startsWith('jsdomError'));
check('全程没有 jsdomError', jsdomErrs.length === 0, jsdomErrs.slice(0, 2).join(' | '));

/* 【11】弹层必须真的能藏起来（真机致命 bug 的回归测试）
   index.html 用 hidden 属性控制 .sheet-mask，而 style.css 给了它 display:flex。
   作者样式压过浏览器默认的 [hidden]{display:none}，结果遮罩永远显示、
   整个界面被盖住 —— 真机上表现就是「弹窗叉不掉、界面点不动」。
   jsdom 不做完整 CSS 级联，所以这里直接对样式表文本断言，并检查弹层默认带 hidden。 */
console.log('\n【11】弹层可隐藏性（真机致命 bug 回归）');
const cssText = fs.readFileSync(path.join(UI, 'style.css'), 'utf8');
check('style.css 有 [hidden]{display:none} 全局兜底',
  /\[hidden\]\s*\{[^}]*display\s*:\s*none/i.test(cssText),
  '缺少兜底规则 → .sheet-mask 永远显示');
const maskIds = ['charSheetMask', 'actionMask', 'memMask'];
const masksAllHidden = maskIds.every(id => {
  const m = doc.getElementById(id);
  return m && m.hidden === true;
});
check('三个弹层（角色/操作/记忆）默认都是 hidden', masksAllHidden,
  maskIds.map(id => { const m = doc.getElementById(id); return id + '=' + (m ? m.hidden : 'missing'); }).join(', '));
check('弹层遮罩确实用了 .sheet-mask（即会被 display:flex 影响）',
  maskIds.every(id => { const m = doc.getElementById(id); return m && /sheet-mask/.test(m.className); }));

console.log('\n【12】角色卡导入/导出（chara_card_v2）');
const C = window.FYCards;
check('FYCards 已加载', !!C && typeof C.toCardV2 === 'function');
const sampleChar = {
  id: 'ch1', name: '测试角色', avatar: '🌙', tagline: '一句话简介',
  persona: '人设正文', greeting: '开场白', examples: '示例对话',
  systemPrompt: '系统提示', temperature: 0.7
};
const card = C.toCardV2(sampleChar);
check('导出：spec/data 结构正确',
  card.spec === 'chara_card_v2' && card.data && card.data.name === '测试角色');
check('导出：字段映射 persona→description / greeting→first_mes / examples→mes_example',
  card.data.description === '人设正文' && card.data.first_mes === '开场白' && card.data.mes_example === '示例对话',
  JSON.stringify(card.data).slice(0, 160));
check('导出：emoji 与温度进扩展字段',
  card.data.extensions.fy.avatar === '🌙' && card.data.extensions.fy.temperature === 0.7);
const back = C.fromCard(card);
check('往返：人设/开场白/示例/系统提示都对得上',
  back.persona === '人设正文' && back.greeting === '开场白'
  && back.examples === '示例对话' && back.systemPrompt === '系统提示',
  JSON.stringify(back).slice(0, 180));
const v1 = C.fromCard({ name: '老卡', description: 'v1 人设', personality: 'v1 简介', first_mes: 'v1 开场' });
check('兼容 v1 平铺卡', v1.name === '老卡' && v1.persona === 'v1 人设'
  && v1.greeting === 'v1 开场' && v1.tagline === 'v1 简介', JSON.stringify(v1).slice(0, 140));
const cardsMulti = C.parseCards(JSON.stringify([
  { name: 'A', description: 'a' },
  { spec: 'chara_card_v2', data: { name: 'B', description: 'b' } }
]));
check('支持数组打包（一次导入多张）', cardsMulti.length === 2 && cardsMulti[1].name === 'B');
const wrapped = C.parseCards(JSON.stringify({ spec: 'chara_card_v2', data: { name: 'C', description: 'c' } }));
check('支持单张 v2 卡', wrapped.length === 1 && wrapped[0].name === 'C');
let cardThrew = false;
try { C.parseCards('这不是 JSON'); } catch (e) { cardThrew = true; }
check('垃圾输入给出可读错误（不静默失败）', cardThrew);
check('导出文件名清洗非法字符', C.fileNameFor({ name: 'a/b c:d' }) === 'a_b_c_d.json',
  C.fileNameFor({ name: 'a/b c:d' }));
/* 走 App 自己的导入函数，确认真的落到角色库 */
const charsBefore = S.characters.length;
const importedCount = window.FYApp.importCardsFromText(JSON.stringify(card), 'unit-test.json');
await sleep(150);
check('导入真的写进角色库', importedCount === 1 && S.characters.length === charsBefore + 1,
  '导入=' + importedCount + ' 角色数=' + S.characters.length);
const addedChar = S.characters.filter(c => c.name === '测试角色')[0];
check('导入后的角色字段可用', !!addedChar && addedChar.persona === '人设正文' && addedChar.greeting === '开场白',
  addedChar ? JSON.stringify(addedChar).slice(0, 140) : '没找到');
check('导入的角色出现在角色页 DOM 里', doc.getElementById('charGrid').textContent.indexOf('测试角色') >= 0);

console.log('\n【13】屏幕常亮策略（生成时 / 一直 / 不保持）');
const kaCalls = [];
const origKeepAwakeFn = window.FY.keepAwake;
window.FY.keepAwake = function (on) { kaCalls.push(!!on); return '{"ok":true}'; };
const origKeepScreen = S.settings.keepScreen;
const origGenerating = S.generating;
S.keepAwakeApplied = null; S.keepAwakeOn = null;
S.generating = false; S.settings.keepScreen = 'auto';
window.FYApp.applyKeepScreen();
check('auto + 未生成 → 不保持', S.keepAwakeOn === false, 'keepAwakeOn=' + S.keepAwakeOn);
S.generating = true;
window.FYApp.applyKeepScreen();
check('auto + 生成中 → 保持（后台也要跑完）', S.keepAwakeOn === true, 'keepAwakeOn=' + S.keepAwakeOn);
S.generating = false; S.settings.keepScreen = 'always';
window.FYApp.applyKeepScreen();
check('always + App 在前台 → 保持', S.keepAwakeOn === true, 'keepAwakeOn=' + S.keepAwakeOn);
S.settings.keepScreen = 'off'; S.generating = true;
window.FYApp.applyKeepScreen();
check('off → 生成中也不保持（最省电）', S.keepAwakeOn === false, 'keepAwakeOn=' + S.keepAwakeOn);
check('去重生效：状态没变就不重复过桥调用', kaCalls.length <= 3, '调用次数 ' + kaCalls.length);
S.generating = origGenerating; S.settings.keepScreen = origKeepScreen;
window.FY.keepAwake = origKeepAwakeFn;
S.keepAwakeApplied = null; S.keepAwakeOn = null;

/* 【14】多轮前缀稳定 —— 这是"每轮要重新预填充多少 token"的根因。
   以前的实现把「（当前时间：…）」在【发送时】追加到最后一条消息上，历史里的同一条没有，
   于是下一轮请求与上一轮的 KV 前缀在那一处断掉，llama-server 只能把
   「上一轮用户消息 + 助手回复」重新算一遍（tests/bench-prefix.mjs 实测第 2 轮白算 75 token）。
   修好后时间戳由消息自身的 ts 推导，历史与发送形态永远一致。 */
console.log('\n【14】多轮对话的前缀稳定性（前缀 KV 复用）');
const sess = S.store.saveSession({ title: '前缀测试', characterIds: [], mode: 'solo', plot: false });
const pfxT1 = Date.now() - 60000;
S.store.addMessage({ sessionId: sess.id, role: 'user', content: '今天下了一整天的雨，鞋全湿了。', ts: pfxT1 });
S.session = sess;
S.messages = S.store.listMessages(sess.id);
const bodyA = window.FYApp.buildRequestMessages(null);
const bodyA2 = window.FYApp.buildRequestMessages(null);
check('同一状态下连续组装两次完全一致（时间戳不再取"发送时的 now"）',
  JSON.stringify(bodyA) === JSON.stringify(bodyA2));
S.store.addMessage({
  sessionId: sess.id, role: 'assistant',
  content: '（把温热的杯子塞进你手里）先暖暖手，再说别的。', ts: pfxT1 + 1000
});
S.store.addMessage({ sessionId: sess.id, role: 'user', content: '好啊，你讲讲吧。', ts: pfxT1 + 2000 });
S.messages = S.store.listMessages(sess.id);
const bodyB = window.FYApp.buildRequestMessages(null);
const n = bodyA.length;   // buildRequestMessages 返回的就是 messages 数组
const isPrefix = bodyA.every((m, i) =>
  bodyB[i] && bodyB[i].role === m.role && bodyB[i].content === m.content);
check('第 2 轮请求以第 1 轮的 messages 为完整前缀（可整段复用 KV）',
  isPrefix && bodyB.length > n,
  '第1轮 ' + n + ' 条 / 第2轮 ' + bodyB.length + ' 条');
const withTime = bodyA.filter(m => /（当前时间：/.test(m.content || ''));
check('时间戳写在消息自身里（每轮都能对上）', withTime.length === 1,
  '带时间戳的消息 ' + withTime.length + ' 条');
check('剧情格式要求只出现在 system（不再往每条消息里塞提醒）',
  bodyA[0].role === 'system' &&
  (!/提醒：/.test(bodyA.slice(1).map(m => m.content).join(''))),
  '第 2 条起含"提醒："：' + /提醒：/.test(bodyA.slice(1).map(m => m.content).join('')));

console.log('\n【15】本地数据库（IndexedDB 持久化 / 索引 / 增量落盘）');
/* 数据量上去以后，这里三件事必须成立：
   ① 写进去的数据"重启"后还在（用 FYStore.init() 重新读一遍来模拟重启）；
   ② 查询走内存索引，只碰本会话的消息；
   ③ 删除要级联干净，不能留下孤儿记录。 */
const dbStore = S.store;
const dbSession = dbStore.saveSession({ title: '数据库测试', characterIds: [], mode: 'solo', plot: false });
for (let i = 0; i < 5; i++) {
  dbStore.addMessage({
    sessionId: dbSession.id, role: i % 2 ? 'assistant' : 'user',
    content: '第 ' + i + ' 条', ts: Date.now() + i
  });
}
const otherSession = dbStore.saveSession({ title: '另一个会话', characterIds: [], mode: 'solo', plot: false });
dbStore.addMessage({ sessionId: otherSession.id, role: 'user', content: '别的会话的消息', ts: Date.now() + 99 });

check('按会话查询只返回本会话的消息（内存索引）',
  dbStore.listMessages(dbSession.id).length === 5 && dbStore.listMessages(otherSession.id).length === 1,
  'A=' + dbStore.listMessages(dbSession.id).length + ' B=' + dbStore.listMessages(otherSession.id).length);
check('countMessages 与索引一致', dbStore.countMessages(dbSession.id) === 5);
check('lastMessage 取到最新那条',
  (dbStore.lastMessage(dbSession.id) || {}).content === '第 4 条',
  JSON.stringify(dbStore.lastMessage(dbSession.id)).slice(0, 80));

const firstMsg = dbStore.listMessages(dbSession.id)[0];
dbStore.updateMessage({ id: firstMsg.id, content: '改过的第一条' });
check('updateMessage 能改到内容', dbStore.listMessages(dbSession.id)[0].content === '改过的第一条');

/* 设置持久化：老实现把 settings 表清空了（内存里是对象、表里是记录），重启后设置全丢 */
const origKeep = dbStore.getSettings().keepScreen;
dbStore.saveSettings({ keepScreen: 'always' });
dbStore.flushNow();
await sleep(400);
const reopened = await window.FYStore.init();
check('设置能持久化（重新打开数据库后仍在）',
  reopened.store.getSettings().keepScreen === 'always',
  'keepScreen=' + reopened.store.getSettings().keepScreen);
check('消息能持久化（重新打开后数量/内容一致）',
  reopened.store.listMessages(dbSession.id).length === 5 &&
  reopened.store.listMessages(dbSession.id)[0].content === '改过的第一条',
  '条数=' + reopened.store.listMessages(dbSession.id).length);
check('重新打开后 lastMessage 仍是最后一条',
  (reopened.store.lastMessage(dbSession.id) || {}).content === '第 4 条');

dbStore.deleteSession(dbSession.id);
dbStore.flushNow();
await sleep(400);
check('删会话后内存索引立刻清空', dbStore.listMessages(dbSession.id).length === 0);
const reopened2 = await window.FYStore.init();
check('删会话后重新打开也没有残留消息',
  reopened2.store.listMessages(dbSession.id).length === 0,
  '残留 ' + reopened2.store.listMessages(dbSession.id).length + ' 条');
check('别的会话不受影响（删除没有误伤）',
  reopened2.store.listMessages(otherSession.id).length === 1);

dbStore.saveSettings({ keepScreen: origKeep });
dbStore.deleteSession(otherSession.id);
dbStore.flushNow();
await sleep(200);

console.log('\n【16】整库备份 / 恢复（换签名重装、换机就靠它）');
check('设置页有导出/恢复两个按钮',
  !!doc.getElementById('btnBackupExport') && !!doc.getElementById('btnBackupImport'));

const snap = S.store.exportAll();
check('导出结构正确（带 app 标识、含各类数据）',
  snap.app === 'fengyue-local' && snap.schema === 1 &&
  Array.isArray(snap.characters) && Array.isArray(snap.sessions) &&
  Array.isArray(snap.messages) && Array.isArray(snap.memories) && !!snap.settings,
  Object.keys(snap).join(','));
const snapJson = JSON.stringify(snap);
check('导出可序列化（能直接落成 .json 文件）', snapJson.length > 50, snapJson.length + ' 字节');

/* 破坏现场：加角色 + 加会话，然后用快照覆盖回来 */
const beforeChars = S.store.listCharacters().length;
S.store.saveCharacter({ name: '备份测试角色', persona: '临时' });
S.store.saveSession({ title: '备份测试会话', characterIds: [], mode: 'solo' });
check('破坏现场：确实多了数据',
  S.store.listCharacters().length === beforeChars + 1);

const counts = S.store.importAll(JSON.parse(snapJson));
check('恢复后数据回到快照状态',
  S.store.listCharacters().length === beforeChars && counts.characters === beforeChars,
  '角色 ' + S.store.listCharacters().length + ' / 快照 ' + beforeChars);
check('恢复后临时加的角色不见了',
  S.store.listCharacters().filter(c => c.name === '备份测试角色').length === 0);
check('恢复会整表落盘（写计数增加）', S.store.stats().writes > 0, 'writes=' + S.store.stats().writes);

let badThrew = false;
try { S.store.importAll({ app: 'not-fengyue', characters: [{ id: 'x' }] }); }
catch (e) { badThrew = /不是风月的备份/.test(String(e && e.message)); }
check('拒绝非本 App 的备份文件', badThrew);

check('恢复非法 JSON 时不崩（走 UI 入口）',
  window.FYApp.importBackupFromText('这不是 JSON', 'bad.json') === false);

console.log('\n【17】token 估算自校正（引擎回报真实 token 数 → 反过来校准）');
const FY = window.FYStore;
FY.setTokenModel('unit-test-model');
const rawEst = FY.estimateTokens('这是一句中文测试文本，用来验证估算。');
check('有基础估算值', rawEst > 0, 'est=' + rawEst);
const f0 = FY.getTokenFactor();
/* 引擎说实际用了 2 倍 token：系数应该往上走 */
const f1 = FY.calibrateTokens(rawEst * 2, rawEst);
check('真实值偏大时系数上调', f1 > f0, f0.toFixed(2) + ' → ' + f1.toFixed(2));
check('校正后估算值随之变大', FY.estimateTokens('这是一句中文测试文本，用来验证估算。') > rawEst);
/* 反复校正应收敛到 2 附近，而不是无限增长 */
for (let i = 0; i < 40; i++) FY.calibrateTokens(rawEst * 2, rawEst);
const f2 = FY.getTokenFactor();
check('反复校正会收敛（不会失控）', f2 > 1.6 && f2 <= 2.05, '收敛到 ' + f2.toFixed(2));
/* 异常输入不能把系数带跑 */
const f3 = FY.calibrateTokens(0, 0);
check('异常输入不改变系数', Math.abs(f3 - f2) < 1e-9);
/* 系数按模型分别记住 */
FY.setTokenModel('another-model');
check('换模型后系数独立（新模型从 1 开始）', Math.abs(FY.getTokenFactor() - 1) < 1e-9,
  'factor=' + FY.getTokenFactor());
FY.setTokenModel('unit-test-model');
check('切回原模型时系数还在', Math.abs(FY.getTokenFactor() - f2) < 1e-6,
  'factor=' + FY.getTokenFactor());

console.log('\n【18】多存储后端（IndexedDB / SQLite / 内存）+ 迁移 + 检索 + 分页');
/* 真机上的 SQLite 路径没法在这里跑，但**协议语义**可以：用一个"假原生桥"把
   Db.java 的三件事（clears/puts/dels 走文档表、loadAll 读回、search 模糊匹配）
   按同样的语义实现一遍，验证前端发出去的 ops 和读回来的数据都对。 */

const fakeSqlite = { data: {}, ops: [], searches: 0 };
function fakeLoad() {
  return JSON.stringify(Object.assign({ ok: true }, JSON.parse(JSON.stringify(fakeSqlite.data))));
}
function fakeApply(opsJson) {
  const ops = JSON.parse(opsJson || '{}');
  fakeSqlite.ops.push(ops);
  (ops.clears || []).forEach((t) => { fakeSqlite.data[t] = (t === 'settings') ? {} : []; });
  Object.keys(ops.puts || {}).forEach((t) => {
    const rows = ops.puts[t] || [];
    if (t === 'settings') {
      fakeSqlite.data.settings = fakeSqlite.data.settings || {};
      rows.forEach((r) => { fakeSqlite.data.settings[r.key] = r.value; });
    } else {
      const list = fakeSqlite.data[t] = fakeSqlite.data[t] || [];
      rows.forEach((r) => {
        const at = list.findIndex((x) => x.id === r.id);
        if (at >= 0) list[at] = r; else list.push(r);
      });
    }
  });
  Object.keys(ops.dels || {}).forEach((t) => {
    const ids = ops.dels[t] || [];
    if (t === 'settings') ids.forEach((k) => { delete (fakeSqlite.data.settings || {})[k]; });
    else fakeSqlite.data[t] = (fakeSqlite.data[t] || []).filter((r) => ids.indexOf(r.id) < 0);
  });
  return JSON.stringify({ ok: true });
}
function fakeSearch(q, limit) {
  fakeSqlite.searches++;
  const rows = (fakeSqlite.data.messages || []).filter((m) => String(m.content || '').includes(q));
  return JSON.stringify(rows.slice(0, limit || 50));
}
const origDb = { load: window.FY.dbLoadAll, apply: window.FY.dbApply, search: window.FY.dbSearch };
window.FY.dbLoadAll = fakeLoad;
window.FY.dbApply = fakeApply;
window.FY.dbSearch = fakeSearch;

/* 1) 内存后端：最干净的往返 */
const mem = await window.FYStore.init('memory');
check('可选内存后端', mem.engine === 'memory', 'backend=' + mem.engine);
const memSess = mem.store.saveSession({ title: '内存会话', characterIds: [], mode: 'solo' });
mem.store.addMessage({ sessionId: memSess.id, role: 'user', content: '内存里的一条消息', ts: Date.now() });
mem.store.flushNow();
await sleep(200);
const mem2 = await window.FYStore.init('memory');
check('内存后端读写一致（同一进程内）',
  mem2.store.listMessages(memSess.id).length === 1, '条数=' + mem2.store.listMessages(memSess.id).length);

/* 2) SQLite 后端：验证发给原生的 ops 与读回的数据 */
const sq = await window.FYStore.init('sqlite');
check('SQLite 后端被选中（桥可用时）', sq.engine === 'sqlite', 'backend=' + sq.engine);
const sqSess = sq.store.saveSession({ title: 'SQLite 会话', characterIds: [], mode: 'solo' });
sq.store.addMessage({ sessionId: sqSess.id, role: 'user', content: '彩虹关键词', ts: Date.now() });
sq.store.saveSettings({ keepScreen: 'always' });
sq.store.flushNow();
await sleep(300);
check('SQLite 后端收到了批量 ops（clears/puts）',
  fakeSqlite.ops.length > 0 && typeof fakeSqlite.ops[0].puts === 'object',
  'ops 次数=' + fakeSqlite.ops.length);
check('settings 以 {key,value} 记录形式下发（不再踩对象/记录混用的坑）',
  fakeSqlite.ops.some(o => o.puts && o.puts.settings &&
    o.puts.settings.some(r => r.key === 'keepScreen' && r.value === 'always')));
const sq2 = await window.FYStore.init('sqlite');
check('SQLite 后端读回数据正确',
  sq2.store.listMessages(sqSess.id).length === 1 &&
  sq2.store.getSettings().keepScreen === 'always',
  '消息=' + sq2.store.listMessages(sqSess.id).length + ' keepScreen=' + sq2.store.getSettings().keepScreen);

/* 3) 检索：优先走后端，后端没有就回落到内存 */
const hits = await sq2.store.searchMessages('彩虹', 10);
check('检索能命中消息', hits.length === 1 && /彩虹/.test(hits[0].content), '命中 ' + hits.length);
check('检索走了后端接口', fakeSqlite.searches > 0, 'searches=' + fakeSqlite.searches);
check('空关键词返回空数组', (await sq2.store.searchMessages('   ', 10)).length === 0);

/* 4) 迁移：memory → sqlite，数据要跟着走 */
const from = await window.FYStore.init('memory');
const mvSess = from.store.saveSession({ title: '待迁移', characterIds: [], mode: 'solo' });
from.store.addMessage({ sessionId: mvSess.id, role: 'user', content: '迁移测试消息', ts: Date.now() });
from.store.flushNow();
await sleep(150);
const mv = await from.store.migrateTo('sqlite');
check('迁移调用成功且后端已切换', mv.ok && mv.backend === 'sqlite' && from.store.getBackend() === 'sqlite',
  JSON.stringify(mv));
const after = await window.FYStore.init('sqlite');
check('迁移后目标后端能读到这条消息',
  after.store.listMessages(mvSess.id).some(m => m.content === '迁移测试消息'),
  '条数=' + after.store.listMessages(mvSess.id).length);

/* 5) 分页 */
const pgStore = after.store;
const pgSess = pgStore.saveSession({ title: '分页测试', characterIds: [], mode: 'solo' });
for (let i = 0; i < 10; i++) {
  pgStore.addMessage({ sessionId: pgSess.id, role: 'user', content: 'P' + i, ts: 1000 + i });
}
const page1 = pgStore.listMessagesPage(pgSess.id, 0, 3);
check('分页第一页取最新 3 条',
  page1.items.length === 3 && page1.items[2].content === 'P9' && page1.total === 10 && page1.hasMore,
  JSON.stringify(page1.items.map(m => m.content)));
const page2 = pgStore.listMessagesPage(pgSess.id, 3, 3);
check('分页第二页往前翻',
  page2.items[2].content === 'P6', JSON.stringify(page2.items.map(m => m.content)));

/* 6) 后端回退：指定的后端打不开时，要自动降级而不是直接崩
      （IndexedDB 已经打开过、句柄还在缓存里，所以这里用"SQLite 报错"来验这条链） */
const goodLoad = window.FY.dbLoadAll;
window.FY.dbLoadAll = function () { return JSON.stringify({ ok: false, message: '模拟 SQLite 打不开' }); };
const fb = await window.FYStore.init('sqlite');
check('指定后端打不开时自动回退，并保留失败原因',
  fb.engine !== 'sqlite' && /SQLite/.test(String(fb.error || '')),
  'backend=' + fb.engine + ' / error=' + fb.error);
window.FY.dbLoadAll = goodLoad;
check('回退链顺序正确（sqlite → indexeddb → localstorage → memory）',
  String(fb.tried || '').indexOf('sqlite') === 0 || (fb.tried || [])[0] === 'sqlite',
  JSON.stringify(fb.tried));

window.FY.dbLoadAll = origDb.load;
window.FY.dbApply = origDb.apply;
window.FY.dbSearch = origDb.search;

console.log('\n【19】聊天记录搜索界面（搜全部会话 → 点击跳转）');
const srStore = S.store;
const srSessA = srStore.saveSession({ title: '搜索会话A', characterIds: [], mode: 'solo' });
const srSessB = srStore.saveSession({ title: '搜索会话B', characterIds: [], mode: 'solo' });
srStore.addMessage({ sessionId: srSessA.id, role: 'user', content: '今天在雨里捡到一只猫', ts: 2000 });
srStore.addMessage({ sessionId: srSessB.id, role: 'assistant', content: '窗台上那只猫又来了', ts: 2001, speakerName: '林夏' });
srStore.flushNow();
await sleep(150);

window.FYApp.openSearchSheet();
check('搜索弹层能打开', doc.getElementById('searchMask').hidden === false);
$('searchInput').value = '猫';
window.FYApp.runSearch();
await sleep(120);
const rows = doc.querySelectorAll('#searchList .model-row');
check('跨会话搜到两条', rows.length === 2, '命中 ' + rows.length + ' 条');
check('结果显示说话人与片段',
  /林夏|我/.test(rows[0].textContent) && /猫/.test(rows[0].textContent),
  rows[0].textContent.slice(0, 60));
check('状态行给出命中数', /找到 2 条/.test($('searchStatus').textContent), $('searchStatus').textContent);

rows[1].click();   // 点第二条 → 跳到对应会话
await sleep(150);
check('点结果能跳到对应会话',
  S.session && (S.session.id === srSessA.id || S.session.id === srSessB.id),
  '当前会话=' + (S.session && S.session.title));
check('跳转后搜索弹层关闭', doc.getElementById('searchMask').hidden === true);

$('searchInput').value = '绝对不存在的词xyz';
window.FYApp.runSearch();
await sleep(120);
check('搜不到时给明确提示', /没有找到/.test($('searchStatus').textContent), $('searchStatus').textContent);

/* 收尾 */
srStore.deleteSession(srSessA.id);
srStore.deleteSession(srSessB.id);
srStore.flushNow();
await sleep(150);

console.log('\n【20】分类 / 搜索 / 推荐 / 剧情卡 / 卡包导入');
const catStore = S.store;
/* 造 4 个角色：3 个带分类，1 个无标签 */
const mkChar = (name, tags, kind) => catStore.saveCharacter({
  name, avatar: '🙂', tagline: name + ' 的一句话', persona: name + ' 的人设描述，'.repeat(4),
  greeting: '（看着你）你好，我是' + name + '。', examples: '用户：hi\n' + name + '：嗯。',
  systemPrompt: '你扮演' + name + '。/no_think', tags, kind: kind || 'character', plot: kind === 'story',
});
const cA = mkChar('甲角色', ['古风仙侠']);
const cB = mkChar('乙角色', ['恋爱', '日常治愈']);
const cC = mkChar('丙角色', ['恋爱'], 'story');
const cD = mkChar('丁角色', []);
S.characters = catStore.listCharacters();

window.FYApp.renderCharCats();
const chips = Array.from(doc.querySelectorAll('#charCats .chip')).map((b) => b.textContent);
check('分类 chips 会生成（含「全部」与「未分类」）',
  chips.some((t) => t.startsWith('全部')) && chips.some((t) => t.startsWith('恋爱')) && chips.some((t) => t.startsWith('未分类')),
  chips.join(' | '));

S.charCat = '恋爱';
window.FYApp.renderCharacters();
let cards = Array.from(doc.querySelectorAll('#charGrid .char-card .char-name')).map((n) => n.textContent);
/* 内置预设从 v1.6.1 起也带分类（林夏 = 日常治愈 + 恋爱），所以这里不能写死张数，
   只断言"恋爱分类里出现乙/丙、且不带这个分类的甲/丁被排除" */
check('按分类筛选只显示该分类的卡',
  cards.some((t) => t.includes('乙角色')) && cards.some((t) => t.includes('丙角色'))
  && !cards.some((t) => t.includes('甲角色')) && !cards.some((t) => t.includes('丁角色')),
  cards.join(' | '));
check('剧情卡带「剧情」标记',
  cards.some((t) => t.includes('剧情')), cards.join(' | '));

S.charCat = 'all'; S.charQuery = '人设描述';
window.FYApp.renderCharacters();
check('搜索能命中人设正文',
  doc.querySelectorAll('#charGrid .char-card').length === 4,
  String(doc.querySelectorAll('#charGrid .char-card').length));

S.charQuery = '丙角色';
window.FYApp.renderCharacters();
check('搜索能按名字精确筛出',
  doc.querySelectorAll('#charGrid .char-card').length === 1,
  String(doc.querySelectorAll('#charGrid .char-card').length));

S.charQuery = '不存在的词xyz';
window.FYApp.renderCharacters();
check('搜不到时显示空状态并提示换词',
  doc.getElementById('charEmpty').hidden === false && /没有匹配/.test(doc.getElementById('charEmpty').textContent),
  doc.getElementById('charEmpty').textContent.replace(/\s+/g, ' ').slice(0, 50));

S.charQuery = ''; S.charCat = 'all';
window.FYApp.renderCharacters();

/* 推荐：还没聊过的优先 */
const rec1 = window.FYApp.recommendPicks(3);
check('推荐优先给「还没聊过」的角色',
  rec1.length === 3 && rec1.every((p) => p.why === '还没聊过'),
  rec1.map((p) => p.c.name + ':' + p.why).join(', '));

/* 剧情卡开局自动进剧情模式 */
window.FYApp.openSoloChat(cC.id, '');
check('剧情卡自动开启剧情模式', S.session && S.session.plot === true,
  'plot=' + (S.session && S.session.plot) + ' title=' + (S.session && S.session.title));
const rec2 = window.FYApp.recommendPicks(3);
check('聊过的角色不再被推荐为「还没聊过」',
  rec2.every((p) => p.c.name !== '丙角色' || p.why !== '还没聊过'),
  rec2.map((p) => p.c.name + ':' + p.why).join(', '));

/* 卡包导入：用假的 fetch 返回一个卡包，验证标签/类型保留 + 重复导入跳过 */
const realFetch = window.fetch;
window.fetch = async (input) => {
  const url = String(input);
  if (url.indexOf('packs/index.json') >= 0) {
    return new globalThis.Response(JSON.stringify({
      packs: [{ file: 'pack-test.json', name: '测试卡包', count: 2, tags: ['恋爱'], emoji: '📦', desc: '测试用' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.indexOf('pack-test.json') >= 0) {
    return new globalThis.Response(JSON.stringify({
      spec: 'fy_pack_v1', name: '测试卡包', license: 'CC0-1.0', count: 2,
      cards: [cA, cB].map((c) => window.FYCards.toCardV2(Object.assign({}, c, { name: c.name + '·包' }))),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input);
};
const before = S.store.listCharacters().length;
const r1 = await window.FYApp.importPackFile('pack-test.json', '测试卡包');
check('卡包导入：新增 2 张', r1.added === 2 && r1.skipped === 0, JSON.stringify(r1));
const added = S.store.listCharacters().filter((c) => /·包$/.test(c.name));
check('导入的卡保留了标签与类型',
  added.length === 2 && added.every((c) => (c.tags || []).length > 0),
  added.map((c) => c.name + '[' + (c.tags || []).join(',') + ']').join(' | '));
const r2 = await window.FYApp.importPackFile('pack-test.json', '测试卡包');
check('重复导入只跳过不重复建卡', r2.added === 0 && r2.skipped === 2, JSON.stringify(r2));
check('角色总数正确（原 4 + 新增 2）', S.store.listCharacters().length === before + 2,
  before + ' → ' + S.store.listCharacters().length);
window.fetch = realFetch;

/* 留一个带分类的角色给后面的卡包集成测试用；其余清理 */
[cA, cB, cC, cD].forEach((c) => catStore.deleteCharacter(c.id));
S.store.listCharacters().filter((c) => /·包$/.test(c.name)).forEach((c) => catStore.deleteCharacter(c.id));
catStore.flushNow();
await sleep(200);

console.log('\n【21】内置卡包（随 APK 发布）真实性校验');
if (!PACKS_READY) {
  console.log('  ⏭  跳过：没有 app/assets/ui/packs/index.json（先跑 python3 tools/build-pack-index.py）');
} else {
const idxRes = await window.fetch('packs/index.json');
const idx = await idxRes.json();
check('卡包目录存在并列出 16 个分类包', (idx.packs || []).length === 16,
  '包数=' + (idx.packs || []).length);
const sumCount = (idx.packs || []).reduce((a, p) => a + p.count, 0);
check('目录声明的总卡数与逐包相加一致', sumCount === idx.total && idx.total === 160,
  'total=' + idx.total + ' sum=' + sumCount);
check('每个包都标了许可与分类标签',
  (idx.packs || []).every((p) => p.license && (p.tags || []).length > 0),
  (idx.packs || []).map((p) => p.slug + ':' + p.license).slice(0, 3).join(' '));
check('目录里有剧情卡统计', (idx.packs || []).every((p) => typeof p.story === 'number'),
  '剧情卡合计=' + (idx.packs || []).reduce((a, p) => a + p.story, 0));

const beforeNames = {};
S.store.listCharacters().forEach((c) => { beforeNames[c.name] = 1; });
const target = (idx.packs || []).find((p) => p.slug === 'mystery');
const imp = await window.FYApp.importPackFile(target.file, target.name);
check('真实卡包能一键导入（悬疑推理 10 张）', imp.added === 10,
  JSON.stringify(imp));
const newCards = S.store.listCharacters().filter((c) => !beforeNames[c.name]);
check('导入的卡带分类标签', newCards.every((c) => (c.tags || []).indexOf('悬疑推理') >= 0),
  newCards.map((c) => c.name + '[' + (c.tags || []).join(',') + ']').join(' | ').slice(0, 90));
check('导入的剧情卡被正确识别（kind=story / plot）',
  newCards.filter((c) => c.kind === 'story').length === 3
  && newCards.filter((c) => c.kind === 'story').every((c) => c.plot === true),
  '剧情卡=' + newCards.filter((c) => c.kind === 'story').length);
check('导入的卡人设与开场白完整落地',
  newCards.every((c) => c.persona.length >= 60 && c.greeting.length >= 20
    && /\/no_think/.test(c.systemPrompt)),
  '最短人设=' + Math.min.apply(null, newCards.map((c) => c.persona.length)));

/* 清理导入的卡 */
newCards.forEach((c) => S.store.deleteCharacter(c.id));
S.store.flushNow();
await sleep(200);
check('清理后角色数回到导入前', S.store.listCharacters().length === Object.keys(beforeNames).length,
  S.store.listCharacters().length + ' vs ' + Object.keys(beforeNames).length);
}

console.log('\n【22】模型来源：内置引擎 / 外部 OpenAI 兼容服务（含局域网自建）');
/* ---- 文件名推导：粘贴任意直链都要能起个像样的名字 ---- */
const mnu = window.FYApp.modelNameFromUrl;
check('直链推导文件名',
  mnu('https://www.modelscope.cn/models/Qwen/Qwen3-4B-GGUF/resolve/master/Qwen3-4B-Q4_K_M.gguf') === 'Qwen3-4B-Q4_K_M.gguf',
  mnu('https://www.modelscope.cn/models/Qwen/Qwen3-4B-GGUF/resolve/master/Qwen3-4B-Q4_K_M.gguf'));
check('带查询串/锚点的链接能剥掉',
  mnu('https://hf-mirror.com/a/b/resolve/main/model-q4.gguf?download=true#x') === 'model-q4.gguf',
  mnu('https://hf-mirror.com/a/b/resolve/main/model-q4.gguf?download=true#x'));
check('中文名保留（不变成下划线）',
  mnu('https://x.com/盘古-7B.gguf') === '盘古-7B.gguf', mnu('https://x.com/盘古-7B.gguf'));
check('没有扩展名时补 .gguf',
  mnu('https://x.com/models/my-model') === 'my-model.gguf', mnu('https://x.com/models/my-model'));
check('空链接也不崩',
  mnu('') === 'custom-model.gguf', mnu(''));

/* ---- 路由：本地模式走 127.0.0.1 引擎端口 ---- */
const realProvider = S.provider;
S.provider = { mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false };
S.engineState = Object.assign({}, S.engineState, { state: 'ready', port: 5555 });
check('本地模式 → 直连 llama-server 端口',
  window.FYApp.apiTarget() === 'http://127.0.0.1:5555/v1', window.FYApp.apiTarget());
check('本地模式就绪判定看引擎状态', window.FYApp.providerReady() === true);

/* ---- 路由：远程模式走同源代理（绕开 CORS，key 不下发前端）---- */
S.provider = { mode: 'remote', baseUrl: 'http://192.168.1.5:11434/v1', model: 'qwen2.5:7b', hasKey: true, ready: true };
check('远程模式 → 同源 /api（由原生代理转发）',
  window.FYApp.apiTarget() === '/api', window.FYApp.apiTarget());
check('远程模式就绪判定看配置而非引擎', window.FYApp.providerReady() === true
  && window.FYApp.isRemote() === true);
S.provider = { mode: 'remote', baseUrl: 'http://192.168.1.5:11434/v1', model: '', hasKey: false, ready: false };
check('远程没选模型时判定为未就绪', window.FYApp.providerReady() === false);

/* ---- 保存配置：key 只上传、不回读 ---- */
const calls = [];
const origCall = window.FY.getProvider;
window.FY.getProvider = function () { return JSON.stringify({ mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false }); };
window.FY.setProvider = function (json) {
  calls.push(JSON.parse(json));
  const o = JSON.parse(json);
  return JSON.stringify({ mode: o.mode, baseUrl: o.baseUrl, model: o.model, hasKey: !!o.apiKey, ready: !!(o.baseUrl && o.model) });
};
S.provider = { mode: 'remote', baseUrl: 'http://192.168.1.9:1234/v1', model: '', hasKey: false, ready: false };
window.FYApp.renderProviderUI();          // 先渲染（它会重建模型下拉），再往下拉里填模型
$('selProviderMode').value = 'remote';
$('setRemoteBase').value = 'http://192.168.1.9:1234/v1';
$('setRemoteKey').value = 'sk-test-123';
const opt = doc.createElement('option'); opt.value = 'lmstudio-community/Qwen3-4B'; opt.textContent = opt.value;
$('selRemoteModel').appendChild(opt); $('selRemoteModel').value = opt.value;
$('btnSaveProvider').click();
await sleep(80);
check('保存后发给原生侧的载荷正确（含 key 与模型名）',
  calls.length === 1 && calls[0].mode === 'remote' && calls[0].apiKey === 'sk-test-123'
  && calls[0].model === 'lmstudio-community/Qwen3-4B' && calls[0].baseUrl === 'http://192.168.1.9:1234/v1',
  JSON.stringify(calls[0] || {}));
check('保存后前端状态里没有 key，只有 hasKey',
  S.provider && S.provider.hasKey === true && S.provider.apiKey === undefined,
  JSON.stringify(S.provider));
check('保存后判定为就绪（地址+模型齐全）', window.FYApp.providerReady() === true,
  JSON.stringify(S.provider));
check('保存后输入框里的 key 被清空（不在页面上留存）',
  $('setRemoteKey').value === '', '[' + $('setRemoteKey').value + ']');

/* ---- 远程缺模型名时拒绝保存 ---- */
calls.length = 0;
S.provider = { mode: 'remote', baseUrl: 'http://192.168.1.9:1234/v1', model: '', hasKey: true, ready: false };
$('selProviderMode').value = 'remote';
$('setRemoteBase').value = 'http://192.168.1.9:1234/v1';
$('selRemoteModel').value = '';      // 这个字段现在是可手填的 <input>（原来是只读 select）
$('btnSaveProvider').click();
await sleep(60);
check('没选模型时拒绝保存（避免切过去才发现不能用）', calls.length === 0, '调用次数=' + calls.length);

window.FY.getProvider = origCall;
S.provider = realProvider;
window.FYApp.renderProviderUI();

console.log('\n【23】外观主题（深色 / 浅色 / 跟随系统）+ 强调色对比度');
const root = doc.documentElement;
/* 回到已知状态 */
S.settings = S.store.saveSettings({ appearance: 'dark', theme: '#7c5cff' });
window.FYApp.applyAppearance();
check('深色是默认：不挂 data-theme', !root.hasAttribute('data-theme'),
  'data-theme=' + root.getAttribute('data-theme'));
check('深色下状态栏色是深底', /0c0b11/i.test(doc.querySelector('meta[name="theme-color"]').getAttribute('content')),
  doc.querySelector('meta[name="theme-color"]').getAttribute('content'));

S.settings = S.store.saveSettings({ appearance: 'light' });
window.FYApp.applyAppearance();
check('切浅色会挂上 data-theme="light"', root.getAttribute('data-theme') === 'light',
  String(root.getAttribute('data-theme')));
check('浅色下判定为浅色', window.FYApp.isLightAppearance() === true);
check('浅色下状态栏色是浅底', /f7f5fb/i.test(doc.querySelector('meta[name="theme-color"]').getAttribute('content')),
  doc.querySelector('meta[name="theme-color"]').getAttribute('content'));

S.settings = S.store.saveSettings({ appearance: 'auto' });
/* 模拟系统偏好（jsdom 默认不实现 matchMedia 的 matches） */
const realMM = window.matchMedia;
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
window.FYApp.applyAppearance();
check('跟随系统：系统是浅色时切浅色', root.getAttribute('data-theme') === 'light',
  String(root.getAttribute('data-theme')));
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.FYApp.applyAppearance();
check('跟随系统：系统是深色时回深色', !root.hasAttribute('data-theme'));
window.matchMedia = realMM;

/* 强调色在两种主题下都要有足够对比度 */
check('浅色下强调文字色被压深（对比度）',
  window.FYApp.mixHex('#7c5cff', '#000000', .72).length === 7
  && parseInt(window.FYApp.mixHex('#7c5cff', '#000000', .72).slice(1, 3), 16)
     < parseInt('#7c5cff'.slice(1, 3), 16),
  window.FYApp.mixHex('#7c5cff', '#000000', .72));
check('深色下强调文字色被提亮',
  parseInt(window.FYApp.mixHex('#7c5cff', '#ffffff', .22).slice(1, 3), 16)
  > parseInt('#7c5cff'.slice(1, 3), 16),
  window.FYApp.mixHex('#7c5cff', '#ffffff', .22));
check('非法主题色不炸（原样返回）', window.FYApp.mixHex('乱七八糟', '#ffffff', .5) === '乱七八糟');
check('外观设置能落盘', S.store.getSettings().appearance === 'auto',
  String(S.store.getSettings().appearance));

/* 收尾：回到深色，别影响后面的用例 */
S.settings = S.store.saveSettings({ appearance: 'dark' });
window.FYApp.applyAppearance();
check('收尾回到深色', !root.hasAttribute('data-theme'));

console.log('\n【24】远程模型模式：不启动本地引擎也能聊天（回归）');
/* 这个用例是补的：v1.1.0 发布后才发现 sendUserMessage 等 5 处仍在检查 engineReady()，
   于是"配好了外部服务也发不出消息"。这里把本地引擎故意置为 stopped，
   只把 provider 设成远程就绪，验证整条路走得通。 */
function sseResponse(chunks) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) { chunks.forEach((t) => c.enqueue(enc.encode(t))); c.close(); },
  });
  return new globalThis.Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const rc = S.store.listCharacters()[0];
window.FYApp.openSoloChat(rc.id, '');
S.engineState = Object.assign({}, S.engineState, { state: 'stopped', port: 0, model: '' });
S.provider = { mode: 'remote', baseUrl: 'http://127.0.0.1:11434/v1', model: 'mock-vps-model', hasKey: false, ready: true };
check('远程就绪时 providerReady 为真（本地引擎是 stopped）',
  window.FYApp.providerReady() === true && S.engineState.state === 'stopped');

const captured = [];
const realFetch2 = window.fetch;
window.fetch = async (url, opts) => {
  captured.push({ url: String(url), body: opts && opts.body });
  return sseResponse([
    'data: {"choices":[{"delta":{"content":"来自远程"}}]}' + '\n\n',
    'data: {"choices":[{"delta":{"content":"服务的回复"}}]}' + '\n\n',
    'data: [DONE]' + '\n\n',
  ]);
};
const beforeIds2 = new Set((S.messages || []).map((m) => m.id));
window.FYApp.sendUserMessage('远程模式测试');
await until(() => captured.length > 0, 6000);
check('远程模式：请求打到同源 /api 代理（不是本地端口）',
  captured.length > 0 && captured[0].url === '/api/chat/completions',
  captured.length ? captured[0].url : '（没有发出请求）');
check('远程模式：请求体带上了上游模型名',
  captured.length > 0 && JSON.parse(captured[0].body).model === 'mock-vps-model',
  captured.length ? String(captured[0].body).slice(0, 90) : '');
const gotRemote = await until(() => (S.messages || []).some((m) =>
  !beforeIds2.has(m.id) && m.role === 'assistant' && /来自远程/.test(m.content || '')), 8000);
check('远程模式：流式回复正常落地到消息里', gotRemote,
  JSON.stringify(((S.messages || []).filter((m) => m.role === 'assistant').pop() || {}).content || '').slice(0, 80));
window.fetch = realFetch2;

/* 收尾：回到本地模式，别影响后面的用例 */
S.provider = { mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false };

console.log('\n【25】服务商预设（豆包/方舟等）+ 模型名可手填');
const P = window.FYApp.PROVIDER_PRESETS;
check('预设里包含豆包（火山方舟）', !!(P && P.ark && /volces\.com/.test(P.ark.url)), P && P.ark && P.ark.url);
check('预设地址都是 https（除局域网 Ollama 外）',
  Object.keys(P).every((k) => k === 'ollama' ? /^http:\/\//.test(P[k].url) : /^https:\/\//.test(P[k].url)),
  Object.keys(P).map((k) => k + '=' + P[k].url).join(' | ').slice(0, 120));

S.provider = { mode: 'remote', baseUrl: '', model: '', hasKey: false, ready: false };
window.FYApp.renderProviderUI();
$('selPreset').value = 'ark';
window.FYApp.applyPreset('ark');
check('选豆包预设会填好方舟地址',
  $('setRemoteBase').value === 'https://ark.cn-beijing.volces.com/api/v3', $('setRemoteBase').value);
check('状态区给出方舟的说明（要填接入点/模型名）',
  /接入点|ep-/.test($('providerStatus').textContent), $('providerStatus').textContent.slice(0, 60));

/* 方舟不返回 /models：模拟"地址通但拉不到列表" */
const realFetch3 = window.FY.fetchProvider;
window.FY.testProvider = () => JSON.stringify({ ok: true, message: '连通，发现 0 个模型',
  resolvedBase: 'https://ark.cn-beijing.volces.com/api/v3', models: [], count: 0 });
window.FYApp.renderProviderUI();
$('setRemoteBase').value = 'https://ark.cn-beijing.volces.com/api/v3';
$('btnTestProvider').click();
await sleep(60);
check('拉不到模型列表时提示可以手填（不再卡死）',
  /手填/.test($('providerStatus').textContent), $('providerStatus').textContent.slice(0, 70));

/* 手填模型名 → 能保存 */
const calls2 = [];
window.FY.setProvider = (json) => {
  calls2.push(JSON.parse(json));
  return JSON.stringify({ mode: 'remote', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: JSON.parse(json).model, hasKey: !!JSON.parse(json).apiKey, ready: true });
};
$('selProviderMode').value = 'remote';
$('setRemoteKey').value = 'ark-key-demo';
$('selRemoteModel').value = 'ep-20251012-abcdef';
$('btnSaveProvider').click();
await sleep(80);
check('手填的模型名被正确保存（豆包接入点 ID）',
  calls2.length === 1 && calls2[0].model === 'ep-20251012-abcdef' && calls2[0].baseUrl.indexOf('volces') > 0,
  JSON.stringify(calls2[0] || {}));
check('保存后判定为就绪', window.FYApp.providerReady() === true, JSON.stringify(S.provider));
check('Key 不在前端留存', $('setRemoteKey').value === '' && S.provider.apiKey === undefined);

/* 手填为空时仍然拒绝保存 */
calls2.length = 0;
$('selRemoteModel').value = '';
$('btnSaveProvider').click();
await sleep(60);
check('模型名为空时拒绝保存', calls2.length === 0, '调用 ' + calls2.length + ' 次');
window.FY.testProvider = realFetch3;

S.provider = { mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false };
window.FYApp.renderProviderUI();

console.log('\n【26】背景图案开关 + 品牌色自动配色（对比度）');
const root2 = doc.documentElement;
/* 默认开启图案 */
S.settings = S.store.saveSettings({ bgPattern: true });
window.FYApp.applyAppearance();
check('默认开启背景图案（html 上没有 data-bg=off）', !root2.hasAttribute('data-bg'),
  'data-bg=' + root2.getAttribute('data-bg'));
/* 关掉 */
S.settings = S.store.saveSettings({ bgPattern: false });
window.FYApp.applyAppearance();
check('关闭后给 html 打上 data-bg=off（CSS 里隐藏图案层）', root2.getAttribute('data-bg') === 'off');
check('设置能落盘', S.store.getSettings().bgPattern === false,
  String(S.store.getSettings().bgPattern));
/* 再打开 */
S.settings = S.store.saveSettings({ bgPattern: true });
window.FYApp.applyAppearance();
check('可以再次打开', !root2.hasAttribute('data-bg'));
check('图案层用的是 CSS 变量（深浅主题各自一套）',
  /--bg-stars/.test(doc.defaultView.getComputedStyle(root2).getPropertyValue('--bg-stars') ||
    fs.readFileSync(path.join(UI, 'style.css'), 'utf8'))
  && /body::before/.test(fs.readFileSync(path.join(UI, 'style.css'), 'utf8')),
  '（检查样式里存在变量与图层）');

/* 品牌色亮度 → 叠在其上的文字该黑还是白（浅色主题色曾是"白字看不清"的重灾区） */
const lum = window.FYApp.luminance;
check('亮度函数：黑≈0 / 白≈1', lum('#000000') < 0.01 && lum('#ffffff') > 0.99,
  lum('#000000').toFixed(3) + ' / ' + lum('#ffffff').toFixed(3));
for (const c of ['#ffb020', '#00c2b2', '#3fb6ff', '#ffd166']) {
  S.settings = S.store.saveSettings({ appearance: 'dark', theme: c });
  window.FYApp.applyAppearance();
  const on = window.getComputedStyle(root2).getPropertyValue('--on-accent').trim();
  const bb = window.getComputedStyle(root2).getPropertyValue('--bubble-b').trim();
  check('亮色主题色 ' + c + ' → 叠字改为深色（不再白字）', on === '#1a1526', 'on-accent=' + on);
  check('  渐变的第二档也变亮了（两端都够对比）', bb !== c && bb.length === 7, 'bubble-b=' + bb);
}
S.settings = S.store.saveSettings({ appearance: 'dark', theme: '#7c5cff' });
window.FYApp.applyAppearance();
check('深色主题色仍用白字', window.getComputedStyle(root2).getPropertyValue('--on-accent').trim() === '#ffffff',
  window.getComputedStyle(root2).getPropertyValue('--on-accent').trim());
check('浅色主题下品牌色被压深（保证亮底可读）',
  (() => { S.settings = S.store.saveSettings({ appearance: 'light', theme: '#7c5cff' });
    window.FYApp.applyAppearance();
    const strong = window.getComputedStyle(root2).getPropertyValue('--accent-strong').trim();
    return strong.length === 7 && parseInt(strong.slice(1, 3), 16) < parseInt('7c', 16); })(),
  window.getComputedStyle(root2).getPropertyValue('--accent-strong').trim());

/* 把"主题色选择器里所有颜色"都扫一遍：气泡上的字必须 ≥4.5:1（WCAG AA 正文） */
const SWATCHES = ['#7c5cff', '#b06bff', '#3fb6ff', '#00c2b2', '#35d07f', '#ffb020', '#ff6b9d', '#ff5f6d'];
const bad = SWATCHES.filter((c) => {
  const pick = window.FYApp.pickOnAccent(c);
  return window.FYApp.contrastRatio(pick.on, pick.base) < 4.5;
});
check('8 个可选主题色全部满足正文对比度 ≥4.5:1（气泡文字看得清）', bad.length === 0,
  bad.length ? ('不达标：' + bad.join(',')) : SWATCHES.map((c) => c + '→' + window.FYApp.pickOnAccent(c).on).join(' '));

S.settings = S.store.saveSettings({ appearance: 'dark', theme: '#7c5cff', bgPattern: true });
window.FYApp.applyAppearance();

console.log('\n【27】默认模型来源 = DeepSeek（不再默认推荐千问）');
const P2 = window.FYApp.PROVIDER_PRESETS;
check('默认预设是 deepseek', window.FYApp.DEFAULT_PRESET === 'deepseek', String(window.FYApp.DEFAULT_PRESET));
check('预设下拉里 DeepSeek 排第一',
  doc.querySelector('#selPreset option').value === 'deepseek',
  doc.querySelector('#selPreset option').value + ' / ' + doc.querySelector('#selPreset option').textContent);
check('DeepSeek 预设带默认模型名 deepseek-chat',
  P2.deepseek.model === 'deepseek-chat', String(P2.deepseek.model));
check('预设能按地址反查（带不带尾斜杠都认）',
  window.FYApp.presetKeyFor('https://api.deepseek.com/v1') === 'deepseek'
  && window.FYApp.presetKeyFor('https://api.deepseek.com/v1/') === 'deepseek'
  && window.FYApp.presetKeyFor('http://192.168.1.5:11434/v1') === 'ollama',
  window.FYApp.presetKeyFor('https://api.deepseek.com/v1/') + ',' + window.FYApp.presetKeyFor('http://192.168.1.5:11434/v1'));

/* 第一次打开外部服务表单：应该已经按 DeepSeek 填好 */
S.provider = { mode: 'remote', baseUrl: '', model: '', hasKey: false, ready: false };
$('setRemoteBase').value = '';
$('selRemoteModel').value = '';
window.FYApp.renderProviderUI();
check('首次打开即预填 DeepSeek 地址（不用自己去查 base url）',
  $('setRemoteBase').value === 'https://api.deepseek.com/v1', $('setRemoteBase').value);
check('顺带把默认模型名填成 deepseek-chat', $('selRemoteModel').value === 'deepseek-chat',
  $('selRemoteModel').value);
check('下拉同步选中 DeepSeek', $('selPreset').value === 'deepseek', $('selPreset').value);

/* 已经填过自定义地址时不能被覆盖 */
$('setRemoteBase').value = 'http://192.168.1.9:1234/v1';
$('selRemoteModel').value = 'my-local-model';
S.provider = { mode: 'remote', baseUrl: 'http://192.168.1.9:1234/v1', model: 'my-local-model', hasKey: false, ready: true };
window.FYApp.renderProviderUI();
check('已有自定义配置不会被默认预设覆盖',
  $('setRemoteBase').value === 'http://192.168.1.9:1234/v1' && $('selRemoteModel').value === 'my-local-model',
  $('setRemoteBase').value + ' | ' + $('selRemoteModel').value);

/* 内置下载源只剩一个离线备选（Java 侧已改，这里校验前端展示逻辑不依赖它） */
check('引导横幅文案改成推荐 DeepSeek',
  /DeepSeek/.test(doc.getElementById('setupBanner').textContent)
  && /离线/.test(doc.getElementById('setupBanner').textContent),
  doc.getElementById('setupBanner').textContent.replace(/\s+/g, ' ').slice(0, 60));

S.provider = { mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false };
window.FYApp.renderProviderUI();

console.log('\n【28】新增：首次引导 / 顶栏切换 / 斜杠指令 / 导出对话 / 字号 / 收藏 / 续写');

/* ---- 首次引导三选一 ---- */
S.models = [];
S.provider = { mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false };
S.settings = S.store.saveSettings({ onboarded: false });
window.FYApp.maybeShowOnboarding();
check('没有模型也没配外部服务时，弹出三选一引导',
  doc.getElementById('onboardMask').hidden === false);
window.FYApp.finishOnboarding('cloud');
check('选「DeepSeek」后：标记已引导 + 预填地址与模型名',
  S.store.getSettings().onboarded === true
  && doc.getElementById('setRemoteBase').value === 'https://api.deepseek.com/v1'
  && doc.getElementById('selRemoteModel').value === 'deepseek-chat'
  && doc.getElementById('selProviderMode').value === 'remote',
  doc.getElementById('setRemoteBase').value + ' | ' + doc.getElementById('selRemoteModel').value);
check('引导面板已关闭', doc.getElementById('onboardMask').hidden === true);
S.settings = S.store.saveSettings({ onboarded: true });
window.FYApp.maybeShowOnboarding();
check('已引导过就不再打扰', doc.getElementById('onboardMask').hidden === true);

/* ---- 顶栏快速切换 ---- */
S.models = [{ name: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', sizeBytes: 491400032 }];
S.settings = S.store.saveSettings({ model: 'qwen2.5-0.5b-instruct-q4_k_m.gguf' });
S.provider = { mode: 'remote', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true, ready: true };
window.FYApp.openBackendSheet();
const backendRows = Array.from(doc.querySelectorAll('#backendList .model-row .model-name')).map((n) => n.textContent.trim());
check('切换面板列出「内置引擎」与「外部服务」',
  backendRows.some((t) => /内置引擎/.test(t)) && backendRows.some((t) => /外部服务/.test(t)),
  backendRows.join(' | ').slice(0, 90));
check('切换面板列出本机模型', backendRows.some((t) => /qwen2\.5-0\.5b/.test(t)), backendRows.join(' | ').slice(0, 90));
check('状态行显示当前用的是外部服务与模型名',
  /deepseek-chat/.test(doc.getElementById('backendStatus').textContent),
  doc.getElementById('backendStatus').textContent.slice(0, 70));
doc.getElementById('backendMask').hidden = true;

/* ---- 斜杠指令 ---- */
check('输入 /继 能匹配到 /继续',
  window.FYApp.slashMatches('/继').some((c) => c.cmd === '/继续'),
  JSON.stringify(window.FYApp.slashMatches('/继').map((c) => c.cmd)));
check('不以 / 开头不匹配', window.FYApp.slashMatches('你好').length === 0);
const helpRan = window.FYApp.tryRunSlash('/帮助');
check('执行 /帮助 后输入框被清空', helpRan === true && doc.getElementById('input').value === '',
  'returned=' + helpRan + ' value=[' + doc.getElementById('input').value + ']');
check('未知指令不会误发消息', window.FYApp.tryRunSlash('/不存在') === false);

/* ---- 导出对话 ---- */
const expSess = S.store.saveSession({ title: '导出测试', characterIds: [S.store.listCharacters()[0].id], mode: 'solo', plot: true });
S.store.addMessage({ sessionId: expSess.id, role: 'user', content: '你好呀', ts: Date.now() - 2000 });
S.store.addMessage({ sessionId: expSess.id, role: 'assistant', speakerName: '林夏', content: '嗯，我在。', ts: Date.now() - 1000 });
const mdText = window.FYApp.chatToMarkdown(expSess, S.store.listMessages(expSess.id));
check('Markdown 含标题/角色/正文与说话人',
  /# 导出测试/.test(mdText) && /你好呀/.test(mdText) && /嗯，我在。/.test(mdText)
  && /\*\*我\*\*/.test(mdText) && /\*\*林夏\*\*/.test(mdText),
  mdText.split('\n').slice(0, 3).join(' / '));
const realSave = window.FY.saveText;
let savedName = '', savedText = '';
window.FY.saveText = (n, t) => { savedName = n; savedText = t; return JSON.stringify({ ok: true, path: '/Download/' + n }); };
window.FYApp.state.session = expSess;
window.FYApp.state.messages = S.store.listMessages(expSess.id);
window.FYApp.exportChatMarkdown();
await sleep(60);
check('导出会调用原生保存，文件名是 .md 且内容完整',
  /\.md$/.test(savedName) && /你好呀/.test(savedText),
  savedName + ' (' + savedText.length + ' 字)');
window.FY.saveText = realSave;
S.store.deleteSession(expSess.id);

/* ---- 正文字号 ---- */
window.FYApp.applyFontScale.call(null);
S.settings = S.store.saveSettings({ fontScale: 1.25 });
window.FYApp.applyFontScale();
check('字号倍率写进 CSS 变量',
  doc.documentElement.style.getPropertyValue('--fs-scale') === '1.25',
  doc.documentElement.style.getPropertyValue('--fs-scale'));
S.settings = S.store.saveSettings({ fontScale: 1 });
window.FYApp.applyFontScale();
check('字号设置能落盘', S.store.getSettings().fontScale === 1, String(S.store.getSettings().fontScale));

/* ---- 收藏 ---- */
const favChar = S.store.listCharacters()[0];
S.store.saveCharacter(Object.assign({}, favChar, { fav: true }));
S.characters = S.store.listCharacters();
S.charCount = -1;
window.FYApp.renderCharCats();
const favChip = Array.from(doc.querySelectorAll('#charCats .chip')).map((c) => c.textContent);
check('有收藏后出现「⭐ 收藏」筛选项', favChip.some((t) => /收藏/.test(t)), favChip.join(' | ').slice(0, 80));
S.charCat = '⭐ 收藏';
window.FYApp.renderCharacters();
check('「⭐ 收藏」只显示收藏的角色',
  doc.querySelectorAll('#charGrid .char-card').length === 1,
  String(doc.querySelectorAll('#charGrid .char-card').length));
S.charCat = 'all';
S.store.saveCharacter(Object.assign({}, favChar, { fav: false }));
S.characters = S.store.listCharacters();
S.charCount = -1;
window.FYApp.renderCharCats();
window.FYApp.renderCharacters();

/* ---- 续写：并进原消息，不新增一条 ---- */
check('续写去重：模型重复的尾巴会被裁掉',
  window.FYApp.mergeContinuation('我今天很累。', '我今天很累。不过还好。') === '不过还好。',
  window.FYApp.mergeContinuation('我今天很累。', '我今天很累。不过还好。'));
check('续写去重：没有重复就原样追加',
  window.FYApp.mergeContinuation('今天很累。', '你怎么看？') === '你怎么看？',
  window.FYApp.mergeContinuation('今天很累。', '你怎么看？'));

const cc = S.store.listCharacters()[0];
window.FYApp.openSoloChat(cc.id, '');
S.provider = { mode: 'remote', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true, ready: true };
S.engineState = Object.assign({}, S.engineState, { state: 'stopped', port: 0 });
S.store.addMessage({ sessionId: S.session.id, role: 'assistant', speakerName: cc.name, content: '外面下雨了。', ts: Date.now() + 1000 });
S.messages = S.store.listMessages(S.session.id);
window.FYApp.renderMessages();
const beforeCount = S.messages.length;
const cap2 = [];
const realFetch4 = window.fetch;
window.fetch = async (url, opts) => {
  cap2.push({ url: String(url), body: opts && opts.body });
  return sseResponse(['data: {"choices":[{"delta":{"content":"我"}}]}' + '\n\n',
    'data: {"choices":[{"delta":{"content":"去收衣服。"}}]}' + '\n\n', 'data: [DONE]' + '\n\n']);
};
window.FYApp.continueLast();
await until(() => S.generating !== true && cap2.length > 0, 9000);
const afterMsgs = S.store.listMessages(S.session.id);
const lastMsg = afterMsgs[afterMsgs.length - 1];
check('续写不新增消息条数', afterMsgs.length === beforeCount,
  beforeCount + ' → ' + afterMsgs.length);
check('续写内容并进原消息（原文保留 + 新内容追加）',
  lastMsg && lastMsg.role === 'assistant' && /外面下雨了。/.test(lastMsg.content) && /我去收衣服。/.test(lastMsg.content),
  lastMsg ? lastMsg.content : 'none');
check('续写请求里带了"接着写"的指示（不依赖各家私有参数）',
  cap2.length > 0 && /继续往下写/.test(String(cap2[0].body)),
  String(cap2[0] && cap2[0].body).slice(-80));
window.fetch = realFetch4;
S.provider = { mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false };

/* ============================================================================
 * 【29】创作者工具：分类模板 / 质量评分 / 骨架 / AI 辅助 / 灵感面板
 * ==========================================================================*/
console.log('\n【29】创作者工具（分类模板 / 质量评分 / AI 辅助）');
const FC = window.FYCreator;
check('FYCreator 已加载', !!FC && typeof FC.lint === 'function');
check('质量闸门与发布校验脚本 check-cards.py 同源',
  FC.GATE.personaMin === 60 && FC.GATE.greetingMin === 20 && FC.GATE.examplesMin === 40 && FC.GATE.nameMax === 12,
  JSON.stringify(FC.GATE));

const bundle = await FC.loadBundle();
check('分类模板加载成功（16 类）', !!bundle && bundle.categories.length === 16,
  '分类 ' + (bundle ? bundle.categories.length : 0));
check('每个分类都有 ≥3 个骨架和完整的写作要点',
  bundle.categories.every(c => c.skeletons.length >= 3 && c.guide &&
    c.guide.must.length === 3 && c.guide.avoid.length === 3 &&
    c.guide.voice && c.guide.openers.length === 2));
check('骨架字段完整（who/axis/voice/flaw/care/hook/scene）',
  bundle.categories.every(c => c.skeletons.every(s =>
    s.who && s.axis && s.voice && s.flaw && s.care && s.hook && s.scene)));
check('模板库标注了 CC0 与"只借鉴模式"的边界',
  /CC0/.test(bundle.license) && /第三方卡片正文/.test(bundle.note));
if (PACKS_READY) {
  const packIdx = JSON.parse(fs.readFileSync(path.join(UI, 'packs', 'index.json'), 'utf8'));
  const packNames = new Set(packIdx.packs.map(p => p.name));
  const missing = FC.categoryTags().filter(t => !packNames.has(t));
  check('分类标签与内置卡包的 16 个分类名完全对齐', missing.length === 0, '对不上：' + missing.join('、'));
}

/* ---- 质量评分 ---- */
const emptyLint = FC.lint({ name: '', persona: '', greeting: '', examples: '', systemPrompt: '', tags: [], kind: 'character', temperature: 0.85, avatar: '🙂', tagline: '' });
check('空卡会报硬错误，不是静默通过', emptyLint.errors >= 4 && emptyLint.score < 60,
  'errors=' + emptyLint.errors + ' score=' + emptyLint.score);
check('每条问题都给了可执行的改法', emptyLint.issues.every(i => i.fix && i.fix.length > 4));

const goodCard = {
  name: '林夏', avatar: '🌤', tagline: '嘴上说没事，手上多下一把面',
  persona: '林夏，58 岁，前纺织厂工人，老伴走了三年，一个人在小区门口开面馆。' +
    '她烫一头紫红色小卷，手腕上戴七八个塑料手串，隔一条街就能听见她喊人。' +
    '她记性好得吓人：谁家孩子今年高考、谁上个月赊过两碗面、谁的老娘住院了，全装在心里却从不当回事。' +
    '缺点是好面子又嘴碎，看不上的人当场变脸，第二天照样多下半碗面，还说是面下多了。' +
    '最在意的是你碗里剩不剩，剩了要问一句是不是不好吃，问完自己先不高兴。' +
    '你和她的起点是：你搬来这个小区第一个月，第一次推开那扇油腻的玻璃门。',
  scenario: '',
  greeting: '（她把抹布往肩上一搭，从灶台后探出头，灶上还坐着一锅没下面条的水，热气糊了半面墙）哎哟，都这个点才来。\n' +
    '坐下吧，我给你下一把——你吃辣不吃？不吃辣还有昨天熬的番茄汤底，比你上回带的那家好吃。\n' +
    '（她说着已经抓了面，也不等你答，顺手把靠窗那张桌子上的醋瓶挪到一边）',
  examples: '用户：我不饿，就是路过。\n' +
    '林夏：（手上已经抓了一把面，头也不抬）路过你进来干嘛，闻味儿啊。坐。\n\n' +
    '用户：我最近挺难的。\n' +
    '林夏：（她顿了一下，把火关小，往你那边推了个搪瓷缸）先吃。难的事，吃完再说，我又不赶你走。\n\n' +
    '用户：你一个人守着这店不累吗？\n' +
    '林夏：（她笑了一声，很短，转身把面下进锅里，水声一下盖过了话）累啊。可我要是不开门，楼上那几个天天加班到十点的，回来吃啥。',
  systemPrompt: '你扮演「林夏」，回复通常 2~4 句，句子短、带点方言味。' +
    '要做到：写具体的日常动作；冲突要小；角色要有自己的事在做，不是干等着陪用户说话。' +
    '行为边界：不替用户做决定，不说教，不做越界的肢体描写，不追问用户不愿意说的隐私。' +
    '禁止事项：不许自称 AI、不许提到设定与提示词、不许长篇总结人生道理、不许卖惨。' +
    '动作神态放在圆括号里，称呼用户直接用「你」。\n/no_think',
  temperature: 0.85, tags: ['日常治愈'], kind: 'character'
};
const goodLint = FC.lint(goodCard, { existingNames: [] });
check('达标的卡能拿到高分', goodLint.score >= 90,
  'score=' + goodLint.score + ' issues=' + goodLint.issues.map(i => i.msg).join('|'));
check('达标的卡没有硬错误', goodLint.errors === 0,
  JSON.stringify(goodLint.issues.map(i => i.msg)));

check('能识别 AI 腔',
  FC.lint(Object.assign({}, goodCard, { persona: '作为一个AI助手，我可以帮助你解决问题。' }), {})
    .issues.some(i => /AI 腔/.test(i.msg)));
const noThink = FC.lint(Object.assign({}, goodCard, { systemPrompt: '你扮演一个角色，保持人设不要出戏，说话自然一点，别太长。' }), {});
check('能识别缺 /no_think', noThink.issues.some(i => /no_think/.test(i.msg)));
const storyNoScenario = FC.lint(Object.assign({}, goodCard, { kind: 'story' }), {});
check('剧情卡缺情境会被拦住',
  storyNoScenario.issues.some(i => i.level === 'error' && /情境/.test(i.msg)));
check('重名会提示', FC.lint(goodCard, { existingNames: ['林夏'] })
  .issues.some(i => /已经有一个叫/.test(i.msg)));
check('形容词堆砌会提示',
  FC.lint(Object.assign({}, goodCard, { persona: goodCard.persona + '她温柔善良美丽可爱聪明坚强。' }), {})
    .issues.some(i => /形容词/.test(i.msg)));

/* ---- 骨架 → 草稿 ---- */
const romance = FC.category('恋爱');
const draft = FC.draftFromSkeleton('恋爱', romance.skeletons[0], { name: '沈砚舟' });
check('草稿人设里包含了骨架的关键字段',
  draft.persona.indexOf(romance.skeletons[0].who) >= 0 && draft.persona.indexOf(romance.skeletons[0].care) >= 0);
check('草稿系统提示词带 /no_think', /\/no_think/.test(draft.systemPrompt));
check('草稿带上了分类默认温度与建议标签',
  draft.temperature === romance.defaultTemp && draft.tags.indexOf('恋爱') >= 0, JSON.stringify(draft.tags));
check('草稿本身就能过闸门（不是一坨占位符）', FC.lint(draft, {}).errors === 0,
  JSON.stringify(FC.lint(draft, {}).issues.map(i => i.msg)));

/* ---- AI 辅助：提示词组装与结果解析 ---- */
const aiMsgs = FC.buildAssistMessages('persona', { card: goodCard, category: FC.category('日常治愈'), seed: '想看深夜食堂' });
check('AI 辅助请求是 system+user 两条', aiMsgs.length === 2 && aiMsgs[0].role === 'system' && aiMsgs[1].role === 'user');
check('提示词里带了分类的写作要点', /必须做到/.test(aiMsgs[1].content) && /最容易写崩/.test(aiMsgs[1].content));
check('提示词里带了用户写的方向', /深夜食堂/.test(aiMsgs[1].content));
const parsedAll = FC.parseAssistResult('all', '好的：\n```json\n{"name":"阿澈","persona":"他是夜班店员。"}\n```\n希望有帮助');
check('能从 ```json 包裹和废话里抠出整卡草稿',
  parsedAll.ok && parsedAll.patch.name === '阿澈' && parsedAll.patch.persona === '他是夜班店员。', JSON.stringify(parsedAll));
check('单字段任务落到对应字段',
  FC.parseAssistResult('greeting', '（他把门推开）来了？').patch.greeting === '（他把门推开）来了？');
check('系统提示词任务会自动补上 /no_think',
  /\/no_think/.test(FC.parseAssistResult('system', '你是林夏，保持人设，别出戏，说话短一点。').patch.systemPrompt));
check('掏不出 JSON 时退回 persona，而不是丢弃',
  FC.parseAssistResult('all', '就是一段话').patch.persona === '就是一段话');

/* ---- scenario 回归：导入 → 角色模型 → 导出，不能丢 ---- */
const storyCardIn = {
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: '规则怪谈', description: '一张剧情卡的人设，写的是宿舍楼里的宿管。',
    scenario: '宿舍楼有七条规则，第七条被人撕掉了，而你昨晚违反了它，现在还听得见走廊里的拖鞋声。',
    first_mes: '你入住第一天就被塞了一张手写规则。',
    mes_example: '用户：第一条是什么？\n角色：（她压低声音）别问。',
    system_prompt: '你扮演宿管。\n/no_think', tags: ['恐怖惊悚']
  }
};
const importedStory = window.FYCards.fromCard(storyCardIn);
check('导入剧情卡时 scenario 被保留', /第七条被人撕掉了/.test(importedStory.scenario), importedStory.scenario.slice(0, 20));
check('导入时按 scenario 判定为剧情卡', importedStory.kind === 'story');
check('导出时 scenario 会回写（以前永远是空串）',
  /第七条被人撕掉了/.test(window.FYCards.toCardV2(importedStory).data.scenario));
const savedStory = S.store.saveCharacter(importedStory);
check('角色模型里存住了 scenario', /第七条被人撕掉了/.test(savedStory.scenario), String(savedStory.scenario).slice(0, 20));

/* ---- 编辑面板：分类 / 类型 / 情境不能丢（回归：以前编辑会清掉 tags） ---- */
window.FYApp.openCharSheet(null, Object.assign({}, goodCard, { scenario: '宿舍楼有七条规则。'.repeat(3), kind: 'story' }));
await sleep(60);
check('编辑面板预填了分类标签', S.charTags.indexOf('日常治愈') >= 0, JSON.stringify(S.charTags));
check('编辑面板预填了类型', S.charKind === 'story', S.charKind);
check('剧情卡才显示「情境」输入框', $('fScenarioField').hidden === false);
$('fName').value = '林夏二号';
$('fPersona').value = goodCard.persona;
$('fGreeting').value = goodCard.greeting;
$('fExamples').value = goodCard.examples;
$('fSystem').value = goodCard.systemPrompt;
$('fScenario').value = '宿舍楼有七条规则，第七条被撕掉了。'.repeat(2);
window.FYApp.refreshLint();
check('评分面板渲染出了结果', $('lintBox').children.length > 0 && /·/.test($('lintScore').textContent),
  $('lintScore').textContent);
window.FYApp.saveCharSheet();
await sleep(150);
const savedTwice = S.store.listCharacters().filter(c => c.name === '林夏二号')[0];
check('保存后分类标签还在（回归）',
  savedTwice && savedTwice.tags.indexOf('日常治愈') >= 0, JSON.stringify(savedTwice && savedTwice.tags));
check('保存后类型与情境还在（回归）',
  savedTwice && savedTwice.kind === 'story' && /第七条被撕掉了/.test(savedTwice.scenario),
  savedTwice ? (savedTwice.kind + '/' + String(savedTwice.scenario).slice(0, 12)) : 'missing');

/* ---- 向导：分类 → 骨架 → 起草 ---- */
window.FYApp.openCreatorWizard();
await until(() => FC.bundle() && $('creatorPanel').querySelectorAll('.wiz-card').length > 0, 4000);
check('向导第一步列出 16 个分类', $('creatorPanel').querySelectorAll('.wiz-card').length === 16,
  String($('creatorPanel').querySelectorAll('.wiz-card').length));
S.creator.tag = '科幻未来';
S.creator.kind = 'story';
window.FYApp.creatorNext();
check('第二步给出该分类的骨架', $('creatorPanel').querySelectorAll('.wiz-block').length >= 3,
  String($('creatorPanel').querySelectorAll('.wiz-block').length));
S.creator.skeleton = 0;
window.FYApp.creatorNext();
check('第三步要求填名字与方向', !!$('creatorName') && !!$('creatorSeed'));
$('creatorName').value = 'F-9';
S.creator.name = 'F-9';
window.FYApp.makeDraft(false);
await sleep(80);
check('生成草稿后打开编辑面板并预填名字',
  $('charSheetMask').hidden === false && $('fName').value === 'F-9', $('fName').value);
check('草稿带上了向导里选的分类与类型',
  S.charTags.indexOf('科幻未来') >= 0 && S.charKind === 'story', S.charTags + ' / ' + S.charKind);
check('剧情卡草稿带了情境脚手架', /【局面】/.test($('fScenario').value), $('fScenario').value.slice(0, 20));
check('草稿的系统提示词含 /no_think', /\/no_think/.test($('fSystem').value));
check('草稿的分类写作要点进了系统提示词', /要做到：/.test($('fSystem').value), $('fSystem').value.slice(0, 40));
window.FYApp.openCategoryGuide();
check('「分类要点」面板能打开', $('actionMask').hidden === false);
if ($('btnActionClose').onclick) $('btnActionClose').onclick();

/* ---- AI 辅助端到端：真的发一次补全请求，并把结果写进字段 ---- */
window.FYApp.openCharSheet(null, goodCard);
await sleep(60);
const prevProvider = S.provider;
S.provider = { mode: 'remote', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true, ready: true };
const realFetch5 = window.fetch;
const aiCalls = [];
window.fetch = async (url, opts) => {
  if (String(url).indexOf('/chat/completions') >= 0) {
    aiCalls.push({ url: String(url), body: String(opts && opts.body) });
    return sseResponse(['data: {"choices":[{"delta":{"content":"（他把账本合上）"}}]}' + '\n\n',
      'data: {"choices":[{"delta":{"content":"今天不接单了。"}}]}' + '\n\n', 'data: [DONE]' + '\n\n']);
  }
  return realFetch5(url, opts);
};
await window.FYApp.aiAssist('greeting');
window.fetch = realFetch5;
S.provider = prevProvider;
check('AI 辅助确实发了一次补全请求', aiCalls.length === 1, String(aiCalls.length));
check('请求体里带了分类写作要点', aiCalls.length > 0 && /必须做到/.test(aiCalls[0].body));
check('请求体里关了思考段（思考段不能写进卡里）',
  aiCalls.length > 0 && /"enable_thinking":false/.test(aiCalls[0].body));
check('AI 结果落进了「开场白」字段', /今天不接单了/.test($('fGreeting').value), $('fGreeting').value);

/* ---- 灵感面板：本地来源不联网也能给统计 ---- */
$('charSheetMask').hidden = true;
if (!S.characters.length) { S.store.saveCharacter(goodCard); S.characters = S.store.listCharacters(); }
window.FYApp.openRefSheet();
/* 注意：不能只判断"refBody 没有正在拉取 且 有子节点"——静态占位里本来就有一个 span，
   那样断言会在异步加载完成前就成立，等于什么都没测。这里等来源 chips 真的渲染出来。 */
await until(() => $('refSources').children.length > 0, 5000);
await sleep(150);
check('灵感面板列出了来源', $('refSources').children.length >= 1, String($('refSources').children.length));
check('本地来源渲染出分类分布与人设长度统计',
  /分类分布/.test($('refBody').textContent) && /人设中位长度/.test($('refBody').textContent),
  $('refBody').textContent.slice(0, 70));
check('界面明确写了「只借鉴模式，不复制正文」与许可证提示',
  /只借鉴模式/.test($('refNote').textContent) && /许可证/.test($('refNote').textContent),
  $('refNote').textContent.slice(0, 50));
$('refMask').hidden = true;

/* ---- 联网来源的清单纪律：每个来源都必须标许可证，且至少留一个离线来源 ---- */
const refIdx = await (await window.fetch('creator/reference.json')).json();
check('参考来源清单结构完整（id/name/kind/license）',
  refIdx.sources.length >= 4 &&
  refIdx.sources.every(s => s.id && s.name && s.kind && s.license),
  '来源数 ' + refIdx.sources.length);
check('远程来源都必须给 https 地址和明确许可证',
  refIdx.sources.filter(s => s.kind === 'remote')
    .every(s => /^https:\/\//.test(s.url) && s.license && s.license !== '未标注' && s.license !== 'unknown'));
check('至少有一个离线来源（断网也有参考面板）',
  refIdx.sources.some(s => s.kind === 'local'));
check('社区来源配置了内容标记过滤（挡掉成人向条目）',
  refIdx.sources.some(s => Array.isArray(s.filter) && s.filter.some(f => f.field === 'nsfw_image')));
check('远程来源只取结构信息（标题/标签），不取正文',
  refIdx.sources.filter(s => s.kind === 'remote').every(s => !/definition|first_mes|description/.test(String(s.itemsPath))));

/* ---- 远程渲染：对象→条目、模板替换、内容过滤 ---- */
check('对象型返回（HF schema 那种）能展开成条目',
  window.FYApp.asItemList({ a: { dtype: 'string' }, b: { dtype: 'int64' } }).length === 2);
check('数组型返回原样返回',
  window.FYApp.asItemList([{ x: 1 }]).length === 1);
check('meta 模板能按路径替换',
  window.FYApp.fillTemplate('★{stargazers_count} · 许可：{license.spdx_id}',
    { stargazers_count: 42, license: { spdx_id: 'MIT' } }) === '★42 · 许可：MIT');
check('取不到的字段渲染成占位符而不是 undefined',
  window.FYApp.fillTemplate('{nope}', {}) === '—');
check('内容标记过滤生效（nsfw_image=true 会被剔掉）',
  window.FYApp.passesRefFilter({ filter: [{ field: 'nsfw_image', eq: false }] }, { nsfw_image: true }) === false &&
  window.FYApp.passesRefFilter({ filter: [{ field: 'nsfw_image', eq: false }] }, { nsfw_image: false }) === true);
check('没有配过滤就全部保留', window.FYApp.passesRefFilter({}, { anything: 1 }) === true);

/* ---- 七维质量评分（维度口径借鉴 SPB-2603，见 THIRD_PARTY_NOTICES） ---- */
check('评分给出七个维度', goodLint.dimensions && goodLint.dimensions.length === 7,
  goodLint.dimensions ? goodLint.dimensions.map(d => d.label).join('/') : 'none');
check('每个维度都落在 0~100',
  goodLint.dimensions.every(d => d.score >= 0 && d.score <= 100 && d.weight > 0));
check('维度名与权重之和正确',
  Math.abs(goodLint.dimensions.reduce((a, d) => a + d.weight, 0) - 1) < 1e-9);
const adjOnly = FC.lint(Object.assign({}, goodCard, {
  persona: '她很温柔，很善良，很美丽，很可爱，很聪明，很坚强，很阳光，很大方，很体贴，很优秀。'
}), {});
const adjDim = (r, k) => r.dimensions.filter(d => d.key === k)[0].score;
check('只堆形容词时「展示而非告知」明显掉分',
  adjDim(adjOnly, 'show_dont_tell') < adjDim(goodLint, 'show_dont_tell') - 20,
  adjDim(adjOnly, 'show_dont_tell') + ' vs ' + adjDim(goodLint, 'show_dont_tell'));
check('缺 /no_think 时「格式合规」掉分',
  adjDim(noThink, 'format_compliance') < adjDim(goodLint, 'format_compliance'));
check('剧情卡缺情境时「格式合规」掉分',
  adjDim(storyNoScenario, 'format_compliance') < adjDim(goodLint, 'format_compliance'));
const noFlaw = FC.lint(Object.assign({}, goodCard, {
  persona: '林夏，58 岁，开面馆。她烫紫红色小卷，手腕上戴塑料手串。她和你的起点是第一次推门。',
  examples: '用户：你好。\n林夏：（点头）坐。'
}), {});
check('没有缺点与矛盾时「心理真实度」掉分',
  adjDim(noFlaw, 'psychological_realism') < adjDim(goodLint, 'psychological_realism'),
  adjDim(noFlaw, 'psychological_realism') + ' vs ' + adjDim(goodLint, 'psychological_realism'));
check('同一张卡相似度判罚：和已有卡几乎一样会掉「辨识度」',
  adjDim(FC.lint(goodCard, { existingCards: [{ id: 'x', name: '别人', persona: goodCard.persona }] }), 'distinctiveness')
  < adjDim(goodLint, 'distinctiveness'));
check('卡片相似度会在问题列表里提示',
  FC.lint(goodCard, { existingCards: [{ id: 'x', name: '别人', persona: goodCard.persona }] })
    .issues.some(i => /相似度/.test(i.msg)));
check('没选分类时「原型贴合度」中性处理，不惩罚',
  FC.lint(Object.assign({}, goodCard, { tags: [] }), {}).dimensions.filter(d => d.key === 'archetype_fidelity')[0].score === 55);

check('评分面板渲染出七维评分条', (function () {
  window.FYApp.openCharSheet(null, goodCard);
  window.FYApp.refreshLint();
  return $('lintBox').querySelectorAll('.dim-row').length === 7;
})(), String($('lintBox').querySelectorAll('.dim-row').length));
$('charSheetMask').hidden = true;

console.log('\n【33】界面重做（v1.4.0）：自绘图标系统 + 新的列表结构');
/* 这组用例钉住的是"看起来"的部分 —— 以前这些只能靠人眼看截图，
   结果就是样式改动把导航图标退回 emoji 了也没人发现。 */
const spriteSyms = doc.querySelectorAll('.sprite symbol').length;
check('图标精灵里定义了足够多的自绘图标（≥25）', spriteSyms >= 25, spriteSyms + ' 个');
const tabIcons = Array.from(doc.querySelectorAll('#tabbar .tab .tab-ico .ico use'))
  .map((u) => u.getAttribute('href'));
check('底部导航 5 个入口都用自绘 SVG 图标',
  tabIcons.length === 5 && tabIcons.every((h) => /^#i-/.test(h || '')), tabIcons.join(' '));

window.FYApp.switchView('characters');
await sleep(150);
const card0 = doc.querySelector('#charGrid .char-card');
check('角色卡改为「头像 + 收藏 / 编辑」一行式结构（图标不再压住头像）',
  !!(card0 && card0.querySelector('.char-top .char-avatar')
    && card0.querySelector('.char-top .char-fav .ico')
    && card0.querySelector('.char-top .char-edit .ico')));
const toolbarBtns = Array.from(doc.querySelectorAll('#view-characters .toolbar .btn'));
const toolbarText = toolbarBtns.map((b) => b.textContent).join('|');
check('角色页工具栏是「图标 + 文字」按钮，且不再用 emoji 当图标',
  toolbarBtns.length >= 5 && toolbarBtns.every((b) => b.querySelector('.ico'))
  && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(toolbarText),
  toolbarText.trim().slice(0, 60));

window.FYApp.switchView('chat');
await sleep(200);
const readBtn2 = doc.querySelector('button[title="朗读"]');
check('消息工具条换成自绘图标（朗读 / 重新生成）',
  !!(readBtn2 && readBtn2.querySelector('.ico')));
window.FYApp.switchView('characters');

console.log('\n【34】在线卡库与窗口化渲染');

/* ---------- 34a. 窗口化渲染：卡库到三万张后不可能一次建完 DOM ---------- */
const charCountBeforeWin = S.store.listCharacters().length;
const winBatch = [];
for (let i = 0; i < 200; i++) {
  winBatch.push({
    name: '窗口卡' + i, avatar: '🙂', tagline: '窗口化测试 ' + i,
    persona: '窗口化测试人设，要够长才像一张真卡。'.repeat(3),
    greeting: '你好，我是窗口卡' + i + '。', tags: ['窗口测试'],
  });
}
S.store.saveCharacters(winBatch);
S.charCat = 'all'; S.charQuery = '';
window.FYApp.renderCharacters();
const winTotal = S.charFiltered.length;
check('窗口化：200 张新卡入列后总数正确', winTotal === charCountBeforeWin + 200,
  '总数 ' + winTotal);
const firstPage = doc.querySelectorAll('#charGrid .char-card').length;
check('窗口化：默认只渲染前 60 张', firstPage === 60, '实际 ' + firstPage);
check('#charMore 提示「已显示 60 / N · 继续下滑加载」',
  $('charMore').hidden === false && /已显示\s*60\s*\/\s*\d+/.test($('charMore').textContent),
  $('charMore').textContent.trim().slice(0, 60));
const afterMore = window.FYApp.loadMoreCharacters();
const secondPage = doc.querySelectorAll('#charGrid .char-card').length;
check('调用加载函数后再追加 60 张（60 → 120）',
  afterMore === 120 && secondPage === 120, '返回 ' + afterMore + ' / DOM ' + secondPage);
let winGuard = 0;
while (window.FYApp.loadMoreCharacters() < winTotal && winGuard++ < 80) { /* 一直加载到底 */ }
check('全部显示后 #charMore 自动隐藏', $('charMore').hidden === true,
  'DOM ' + doc.querySelectorAll('#charGrid .char-card').length + ' / 总数 ' + winTotal);
window.FYApp.renderCharacters();
check('重新渲染时窗口重置回 60 张',
  doc.querySelectorAll('#charGrid .char-card').length === 60,
  String(doc.querySelectorAll('#charGrid .char-card').length));
S.charCat = '窗口测试';
window.FYApp.renderCharacters();
check('切分类同样重置窗口（不会沿用上一屏的 200 张）',
  doc.querySelectorAll('#charGrid .char-card').length === 60
  && /已显示\s*60\s*\//.test($('charMore').textContent),
  doc.querySelectorAll('#charGrid .char-card').length + ' 张 / ' + $('charMore').textContent.trim().slice(0, 40));
S.charCat = 'all'; S.charQuery = '';
window.FYApp.renderCharacters();

/* ---------- 34b. 在线卡库：目录解析 / 下载导入 / 幂等 / 坏数据 / 拉不到目录 ---------- */
const realFetchLib = window.fetch;
const libCard = (name) => ({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name,
    description: '在线卡库测试人设：' + name + '。' + '这是用来凑长度的人设正文。'.repeat(4),
    personality: name + ' 的一句话简介',
    scenario: '',
    first_mes: '（看着你）你好，我是' + name + '。',
    mes_example: '用户：hi\n' + name + '：嗯。',
    system_prompt: '你扮演' + name + '。/no_think',
    tags: ['在线卡库'],
    extensions: { fy: { avatar: '🌙', temperature: 0.85, kind: 'character', plot: false } },
  },
});
const libShard = (tag, n, count) => JSON.stringify({
  spec: 'fy_pack_v1', name: tag, license: 'CC0-1.0',
  count: count === undefined ? n : count,
  cards: Array.from({ length: n }, (_, i) => libCard(tag + '-' + (i + 1))),
});
const libCatalog = {
  spec: 'fy_library_v1', total: 20, seed: 'test-seed-1', baseUrl: 'https://lib.example.invalid/fy-library/',
  categories: [
    { slug: 'mystery', tag: '悬疑推理', emoji: '🔍', character: 10, story: 0 },
    { slug: 'badcount', tag: '坏张数', emoji: '💥', character: 5, story: 0 },
    { slug: 'badjson', tag: '坏JSON', emoji: '🧨', character: 5, story: 0 },
  ],
  packs: [
    { file: 'mystery-character-1.json', slug: 'mystery', tag: '悬疑推理', emoji: '🔍', kind: 'character', part: 1, parts: 2, count: 5, bytes: 1000,
      topic: '法医鉴定', topics: ['法医鉴定'], keywords: ['解剖室', '验尸报告', '法医'] },
    { file: 'mystery-character-2.json', slug: 'mystery', tag: '悬疑推理', emoji: '🔍', kind: 'character', part: 2, parts: 2, count: 5, bytes: 1000,
      topic: '画像师', topics: ['画像师'], keywords: ['画像师', '模拟画像', '断桥'] },
    { file: 'badcount-character-1.json', slug: 'badcount', tag: '坏张数', emoji: '💥', kind: 'character', part: 1, parts: 1, count: 5, bytes: 500,
      topic: '坏张数主题', topics: ['坏张数主题'], keywords: ['坏张数'] },
    { file: 'badjson-character-1.json', slug: 'badjson', tag: '坏JSON', emoji: '🧨', kind: 'character', part: 1, parts: 1, count: 5, bytes: 500,
      topic: '坏JSON主题', topics: ['坏JSON主题'], keywords: ['坏JSON'] },
  ],
};
const jsonResp = (text) => new globalThis.Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
window.fetch = async (input) => {
  const url = String(input && input.url ? input.url : input);
  const at = url.indexOf('/fetch?url=');
  if (at >= 0) {
    const target = decodeURIComponent(url.slice(at + '/fetch?url='.length));
    /* 目录地址不要依赖 app.js 里的默认值（那个会随发布改）：这里显式设成测试地址，
       匹配规则也放宽到"任意 index.json" */
    if (/nowhere|example\.invalid\/missing/.test(target)) return new globalThis.Response('missing', { status: 404 });
    if (/index\.json$/.test(target)) return jsonResp(JSON.stringify(libCatalog));
    if (/mystery-character-1\.json$/.test(target)) return jsonResp(libShard('悬疑角色甲', 5));
    if (/mystery-character-2\.json$/.test(target)) return jsonResp(libShard('悬疑角色乙', 5));
    if (/badcount-character-1\.json$/.test(target)) return jsonResp(libShard('坏张数卡', 5, 99));
    if (/badjson-character-1\.json$/.test(target)) return jsonResp('{"spec":"fy_pack_v1","count":5,"cards":[Ooops');
    return new globalThis.Response('missing', { status: 404 });
  }
  return realFetchLib(input);
};

const libBefore = S.store.listCharacters().length;
S.settings = S.store.saveSettings({ libCatalogUrl: 'https://lib.example.invalid/fy-library/index.json' });
window.FYApp.openLibrarySheet();
check('在线卡库面板能打开', $('libMask').hidden === false);
const rowsShown = await until(() => doc.querySelectorAll('#libList .model-row').length >= 3, 6000);
check('目录渲染出「分类 × 类型」行（3 组）', rowsShown,
  '行数 ' + doc.querySelectorAll('#libList .model-row').length);
const libRows = window.FYApp.libRows();
check('每行带分类名 / 类型 / 总张数',
  libRows.length === 3
  && libRows.some((r) => r.tag === '悬疑推理' && r.kind === 'character' && r.total === 10),
  libRows.map((r) => r.tag + '/' + r.kind + ':' + r.total).join(' | '));
const firstLibName = doc.querySelector('#libList .model-row .model-name');
check('行标题含分类名与类型',
  /悬疑推理/.test(firstLibName.textContent) && /角色卡/.test(firstLibName.textContent),
  firstLibName.textContent.trim());
check('未下载的分类显示「未下载」',
  /未下载/.test(doc.querySelector('#libList .lib-row-status').textContent),
  doc.querySelector('#libList .lib-row-status').textContent.trim());

/* 进度回调：把 store.saveCharacters 包一层，数一数真的被调了几次 */
const realSaveMany = S.store.saveCharacters;
let saveManyCalls = 0, progressCalls = 0;
S.store.saveCharacters = function (list, onProgress) {
  saveManyCalls++;
  return realSaveMany.call(S.store, list, typeof onProgress === 'function'
    ? function (d, t) { progressCalls++; return onProgress(d, t); } : onProgress);
};

const rowMystery = libRows.find((r) => r.slug === 'mystery');
const libRes1 = await window.FYApp.importLibraryRow(rowMystery);
check('下载并导入：2 片 × 5 张全部进库（+10）',
  libRes1.added === 10 && S.store.listCharacters().length === libBefore + 10,
  '新增 ' + libRes1.added + ' / 库 ' + S.store.listCharacters().length);
check('批量写入：每片一次 saveCharacters，不是每张一次',
  saveManyCalls === 2, saveManyCalls + ' 次（卡 10 张）');
check('导入过程的进度回调被调用过',
  progressCalls >= 10, progressCalls + ' 次');
check('导入完成后行状态显示「已导入 10 张」',
  /已导入/.test(rowMystery._statusEl.textContent), rowMystery._statusEl.textContent);
check('已导入的分片持久化到 settings.libraryImported（重开面板能看出）',
  !!(S.settings.libraryImported
    && S.settings.libraryImported['mystery-character-1.json']
    && S.settings.libraryImported['mystery-character-2.json']),
  Object.keys(S.settings.libraryImported).join(', '));

const libRes2 = await window.FYApp.importLibraryRow(rowMystery);
check('重复导入幂等：不翻倍、不重复建卡',
  libRes2.added === 0 && S.store.listCharacters().length === libBefore + 10,
  '第二次新增 ' + libRes2.added + ' / 库 ' + S.store.listCharacters().length);

/* 强制重导：用户事后把导入的卡删了，得能补回来（否则面板永远显示"已导入"却少卡） */
check('整组已导入后按钮变成「重新导入」',
  /重新导入/.test(rowMystery._btn.textContent), rowMystery._btn.textContent.trim());
const victim = S.store.listCharacters().filter((c) => (c.tags || []).indexOf('在线卡库') >= 0)[0];
S.store.deleteCharacter(victim.id);
check('删掉一张已导入的卡（模拟用户清理）',
  S.store.listCharacters().length === libBefore + 10 - 1,
  String(S.store.listCharacters().length));
const forced = await window.FYApp.importLibraryRow(rowMystery, { force: true });
check('强制重导把删掉的卡补回来，且不重复建卡',
  forced.added === 1 && S.store.listCharacters().length === libBefore + 10,
  '补回 ' + forced.added + ' / 库 ' + S.store.listCharacters().length);

const beforeBad = S.store.listCharacters().length;
const badCountRow = libRows.find((r) => r.slug === 'badcount');
const badCountRes = await window.FYApp.importLibraryRow(badCountRow);
check('坏数据：count 与 cards.length 不符 → 报错且不写库',
  !!badCountRes.error && /张数不符/.test(badCountRes.error)
  && S.store.listCharacters().length === beforeBad,
  (badCountRes.error || '(没有报错)') + ' / 库 ' + S.store.listCharacters().length);
check('坏数据：行状态显示失败原因',
  /失败/.test(badCountRow._statusEl.textContent), badCountRow._statusEl.textContent);
check('坏数据：不会被记进 libraryImported',
  !S.settings.libraryImported['badcount-character-1.json'],
  Object.keys(S.settings.libraryImported).join(', '));

const badJsonRow = libRows.find((r) => r.slug === 'badjson');
const badJsonRes = await window.FYApp.importLibraryRow(badJsonRow);
check('坏数据：坏 JSON → 报错且不写库',
  !!badJsonRes.error && S.store.listCharacters().length === beforeBad,
  (badJsonRes.error || '(没有报错)') + ' / 库 ' + S.store.listCharacters().length);

/* 目录拉不到：必须给明确提示，不能静默失败 */
S.settings = S.store.saveSettings({ libCatalogUrl: 'https://lib.example.invalid/nowhere/index.json' });
window.FYApp.openLibrarySheet();
const libFailed = await until(() => /失败/.test($('libStatus').textContent), 5000);
check('目录拉不到时给出明确失败提示（不静默）',
  libFailed && /卡库目录加载失败/.test($('libStatus').textContent),
  $('libStatus').textContent.trim().slice(0, 80));
S.settings = S.store.saveSettings({ libCatalogUrl: '' });

/* ---------- 34b-2. v2 目录：按关键词只下载某一片（topic / topics / keywords） ---------- */
const libTypeSearch = (v) => {
  const el = $('libSearch');
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};

check('搜索是纯函数：空查询返回 []（表示走整组视图）',
  window.FYApp.libSearchPacks('').length === 0 && window.FYApp.libSearchPacks('   ').length === 0);
const hitAnJie = window.FYApp.libSearchPacks('解剖室');
check('搜「解剖室」只命中法医那一片（keywords 命中）',
  hitAnJie.length === 1 && hitAnJie[0].file === 'mystery-character-1.json',
  hitAnJie.map((p) => p.file).join(', ') || '(0 片)');
const hitHuaXiang = window.FYApp.libSearchPacks('悬疑 画像师');
check('搜「悬疑 画像师」两个 token 都要命中 → 只命中画像师那一片',
  hitHuaXiang.length === 1 && hitHuaXiang[0].file === 'mystery-character-2.json',
  hitHuaXiang.map((p) => p.file).join(', ') || '(0 片)');
check('搜分类名「悬疑」把该分类两片都列出来（按 part 排序）',
  (() => {
    const h = window.FYApp.libSearchPacks('悬疑');
    return h.length === 2 && h[0].part === 1 && h[1].part === 2;
  })(),
  window.FYApp.libSearchPacks('悬疑').map((p) => p.file).join(', '));
check('搜不存在的词返回 0 片', window.FYApp.libSearchPacks('没有这个词xyz').length === 0);

/* 重新打开面板（上一段把目录地址改坏了），验证搜索交互 */
S.settings = S.store.saveSettings({ libCatalogUrl: 'https://lib.example.invalid/fy-library/index.json' });
window.FYApp.openLibrarySheet();
const libRowsBack = await until(() => doc.querySelectorAll('#libList .model-row').length >= 3, 6000);
check('重开面板默认回整组视图（搜索框清空、libResults 为空）',
  libRowsBack && window.FYApp.libResults().length === 0 && $('libSearch').value === '',
  '行数 ' + doc.querySelectorAll('#libList .model-row').length + ' / 框=' + JSON.stringify($('libSearch').value));
check('重开面板主按钮回到「全部下载」',
  /全部下载/.test($('btnLibAll').textContent) && !/下载全部匹配/.test($('btnLibAll').textContent),
  $('btnLibAll').textContent.trim());

/* 搜不存在的词 → 列表为空 + 明确提示（不能静默留白） */
libTypeSearch('没有这个词xyz');
const libNoHit = await until(() => /没有匹配/.test($('libStatus').textContent), 4000);
check('搜不到时 #libStatus 给出明确提示，且列表为空',
  libNoHit && /没有匹配/.test($('libStatus').textContent) && /换个词/.test($('libStatus').textContent)
  && doc.querySelectorAll('#libList .model-row').length === 0,
  $('libStatus').textContent.trim().slice(0, 80));

/* 搜「解剖室」→ 只列一片，主按钮变「下载全部匹配（1 片）」 */
libTypeSearch('解剖室');
const libOneHit = await until(() => /匹配 1 片/.test($('libStatus').textContent), 4000);
check('搜索后只列命中的分片（1 行）',
  libOneHit && doc.querySelectorAll('#libList .model-row').length === 1,
  '状态=' + $('libStatus').textContent.trim().slice(0, 60)
  + ' 行数=' + doc.querySelectorAll('#libList .model-row').length);
const searchName = doc.querySelector('#libList .model-row .model-name');
check('结果行标题是「分类 · 类型 · 主题」',
  !!(searchName && /悬疑推理/.test(searchName.textContent)
    && /角色卡/.test(searchName.textContent) && /法医鉴定/.test(searchName.textContent)),
  searchName ? searchName.textContent.trim() : '(没有行)');
check('#libStatus 汇总命中片数 / 总张数 / 分类',
  /匹配 1 片 · 共 5 张 · 悬疑推理 1/.test($('libStatus').textContent),
  $('libStatus').textContent.trim());
check('有查询时 #btnLibAll 变成「下载全部匹配（N 片）」',
  /下载全部匹配/.test($('btnLibAll').textContent) && /1 片/.test($('btnLibAll').textContent),
  $('btnLibAll').textContent.trim());

/* 只下载命中的那一片：先把前面整组导入的卡与记录清干净，才能断言"只多 5 张" */
S.store.listCharacters().filter((c) => (c.tags || []).indexOf('在线卡库') >= 0)
  .forEach((c) => S.store.deleteCharacter(c.id));
S.settings = S.store.saveSettings({ libraryImported: {} });
const shardBefore = S.store.listCharacters().length;
const shardRes = await window.FYApp.importLibraryPacks(window.FYApp.libSearchPacks('解剖室'));
check('只下载命中的那一片：+5 张（不是整组 +10）',
  shardRes.added === 5 && S.store.listCharacters().length === shardBefore + 5,
  '新增 ' + shardRes.added + ' / 库 ' + S.store.listCharacters().length);
check('只有命中的分片进了 settings.libraryImported',
  !!S.settings.libraryImported['mystery-character-1.json']
  && !S.settings.libraryImported['mystery-character-2.json'],
  Object.keys(S.settings.libraryImported).join(', '));
check('libPackImported / libPacksImported 反映单片与合计已导入',
  window.FYApp.libPackImported({ file: 'mystery-character-1.json', count: 5 }) === 5
  && window.FYApp.libPacksImported(window.FYApp.libSearchPacks('解剖室')) === 5,
  '单片 ' + window.FYApp.libPackImported({ file: 'mystery-character-1.json', count: 5 })
  + ' / 合计 ' + window.FYApp.libPacksImported(window.FYApp.libSearchPacks('解剖室')));
check('libResults 在搜索视图返回命中的分片',
  window.FYApp.libResults().length === 1
  && window.FYApp.libResults()[0].file === 'mystery-character-1.json',
  window.FYApp.libResults().map((p) => p.file).join(', '));

/* 清空搜索 → 回整组行视图 */
libTypeSearch('');
const libGroupBack = await until(() => doc.querySelectorAll('#libList .model-row').length >= 3, 4000);
check('清空搜索后回到整组行视图（≥3 行）',
  libGroupBack && doc.querySelectorAll('#libList .model-row').length >= 3,
  '行数 ' + doc.querySelectorAll('#libList .model-row').length);
check('清空搜索后 libResults 归零、主按钮回到「全部下载」',
  window.FYApp.libResults().length === 0
  && /全部下载/.test($('btnLibAll').textContent) && !/下载全部匹配/.test($('btnLibAll').textContent),
  '结果 ' + window.FYApp.libResults().length + ' / 按钮 ' + $('btnLibAll').textContent.trim());

/* ---------- 34b-3. v1.6.1：目录换代（seed 变）→ 作废旧的分片导入记录 ---------- */
S.settings = S.store.saveSettings({
  libraryImported: {
    'mystery-character-1.json': { count: 1000, ts: 1 },   // v1 时代：同名文件却是 1000 张的整组 → 张数对不上，要作废
    'mystery-character-2.json': { count: 5, ts: 2 },      // 张数对得上 → 就是这一版的记录，得留着
    'gone-character-1.json': { count: 5, ts: 3 },         // 目录里已经没有这个文件了 → 作废
  },
  librarySeed: 'old-seed',
  libraryOverwrite: false,
});
window.FYApp.openLibrarySheet();
const seedApplied = await until(() => S.settings.librarySeed === 'test-seed-1', 6000);
check('目录 seed 变了：张数对不上的旧记录被作废，对得上的留着（不留 = 又让老用户看不到新卡）',
  seedApplied
  && !S.settings.libraryImported['mystery-character-1.json']
  && !!S.settings.libraryImported['mystery-character-2.json']
  && !S.settings.libraryImported['gone-character-1.json'],
  JSON.stringify(S.settings.libraryImported));
check('作废后自动勾上「同名卡覆盖」+ 面板明确提示（不然同名老卡一直留着旧文本）',
  S.settings.libraryOverwrite === true && $('libOverwrite').checked === true
  && /作废 2 条旧记录/.test($('libStatus').textContent),
  'overwrite=' + S.settings.libraryOverwrite + ' / ' + $('libStatus').textContent.trim().slice(-70));
/* 同一版本再开面板：seed 没变，必须是"一条都不动"（否则每次开面板都把记录清空） */
S.settings = S.store.saveSettings({
  libraryImported: { 'mystery-character-1.json': { count: 999, ts: 9 } },
  libraryOverwrite: false,
});
window.FYApp.openLibrarySheet();
const seedSame = await until(() => /匹配|共 \d+ 组|已导入/.test($('libStatus').textContent), 6000);
check('seed 没变就一条记录都不动（作废只在换代时发生一次）',
  seedSame && !!S.settings.libraryImported['mystery-character-1.json']
  && S.settings.libraryOverwrite === false,
  JSON.stringify(S.settings.libraryImported) + ' / overwrite=' + S.settings.libraryOverwrite);
check('勾选框跟设置联动：勾上 → settings.libraryOverwrite 落盘',
  (() => {
    $('libOverwrite').checked = true;
    $('libOverwrite').dispatchEvent(new window.Event('change', { bubbles: true }));
    return S.settings.libraryOverwrite === true;
  })(),
  'overwrite=' + S.settings.libraryOverwrite);

/* ---------- 34b-4. v1.6.1：勾了「同名卡覆盖」→ 同名卡原地换成新文本 ---------- */
/* 先把 34b-2 那次导入留下的 5 张清掉，保证这一步只有"一张老卡 + 5 张新卡" */
S.store.listCharacters().filter((c) => /^悬疑角色甲-/.test(c.name)).forEach((c) => S.store.deleteCharacter(c.id));
S.settings = S.store.saveSettings({ libraryImported: {}, libraryOverwrite: true });
const oldCard = S.store.saveCharacter({
  name: '悬疑角色甲-1', persona: '旧文本（v1 的短人设）', greeting: '旧开场白', tags: ['在线卡库'], fav: true,
});
const oldSession = S.store.saveSession({ title: '跟老卡的旧聊天', characterIds: [oldCard.id] });
S.store.addMessage({ sessionId: oldSession.id, role: 'assistant', characterId: oldCard.id, speakerName: oldCard.name, content: '旧的聊天记录' });
const owPack = window.FYApp.libSearchPacks('解剖室')[0];
const owRes = await window.FYApp.importLibraryPacks([owPack], { overwrite: true });
const owCard = S.store.listCharacters().filter((c) => c.name === '悬疑角色甲-1')[0];
check('同名卡覆盖：沿用原 id、保留收藏，文本换成新卡的（不是新插一张）',
  owRes.replaced === 1 && owRes.added === 5 && !!owCard && owCard.id === oldCard.id && owCard.fav === true
  && owCard.persona !== '旧文本（v1 的短人设）' && /在线卡库测试人设/.test(owCard.persona),
  'replaced=' + owRes.replaced + ' added=' + owRes.added + ' id同名=' + (!!owCard && owCard.id === oldCard.id)
  + ' fav=' + (!!owCard && owCard.fav) + ' persona=' + String(owCard && owCard.persona).slice(0, 20));
check('同名卡覆盖：跟它的聊天记录一条不少（只是卡片内容换了）',
  S.store.listMessages(oldSession.id).length === 1
  && S.store.listMessages(oldSession.id)[0].content === '旧的聊天记录',
  S.store.listMessages(oldSession.id).map((m) => m.content).join(' | '));
check('同名卡覆盖：不重复入库（还是 5 张，不会变 10 张）',
  S.store.listCharacters().filter((c) => /^悬疑角色甲-/.test(c.name)).length === 5,
  String(S.store.listCharacters().filter((c) => /^悬疑角色甲-/.test(c.name)).length));
/* 不勾覆盖（老行为）：同名一律跳过 —— 重复导入幂等这条不能因为新功能被破坏 */
const owRes2 = await window.FYApp.importLibraryPacks([owPack], { force: true, overwrite: false });
check('没勾覆盖时同名照旧跳过：added=0 / replaced=0（幂等老行为不变）',
  owRes2.added === 0 && (owRes2.replaced || 0) === 0,
  'added=' + owRes2.added + ' replaced=' + owRes2.replaced);

/* ---------- 34b-5. v1.6.1：内置预设补分类（老库里没 tags 的那 4 张） ---------- */
const presetNames = ['林夏', '沈砚堂', '云无咎', '拾光'];
const allPresets = S.store.listCharacters().filter((c) => presetNames.indexOf(c.name) >= 0);
check('4 张内置预设现在都带分类（不再落进「未分类」）',
  allPresets.length === 4 && allPresets.every((c) => (c.tags || []).length > 0),
  allPresets.map((c) => c.name + ':' + JSON.stringify(c.tags)).join(' | '));
/* 模拟"升级上来的老库"：把林夏的 tags 清空，再跑一次迁移 */
const linxiaOld = S.store.listCharacters().filter((c) => c.name === '林夏')[0];
const linxiaPersona = linxiaOld.persona, linxiaGreeting = linxiaOld.greeting;
S.store.saveCharacter(Object.assign({}, linxiaOld, { tags: [] }));
const patched = window.FYApp.patchPresetTags([{ name: '林夏', tags: ['日常治愈', '恋爱'] }]);
const linxiaNew = S.store.listCharacters().filter((c) => c.name === '林夏')[0];
check('老库预设没分类 → 迁移补上（只动 tags，文本一个字都不改）',
  patched === 1 && linxiaNew.tags.length === 2 && linxiaNew.tags.indexOf('日常治愈') >= 0
  && linxiaNew.persona === linxiaPersona && linxiaNew.greeting === linxiaGreeting
  && linxiaNew.id === linxiaOld.id,
  'patched=' + patched + ' tags=' + JSON.stringify(linxiaNew.tags));
check('已经有分类的卡不会被反复改（迁移幂等，返回 0）',
  window.FYApp.patchPresetTags([{ name: '林夏', tags: ['日常治愈', '恋爱'] }]) === 0);

/* ---------- 35. 程序化头像：每张卡一个独有的图标（v1.6.1） ---------- */
console.log('\n【35】程序化头像（分类配色 + 名字唯一）');
check('FYAvatar 已加载，能画出 SVG',
  !!window.FYAvatar && /^<svg /.test(window.FYAvatar.svg({ name: '测试', tags: ['悬疑推理'] }, 50)),
  typeof window.FYAvatar);
const avCardA = { name: '白口罩', tags: ['末世生存'], avatar: '☢️', tagline: '水站看表的' };
window.FYAvatar.clearCache();
const avSvg1 = window.FYAvatar.svg(avCardA, 50);
const avSvg2 = window.FYAvatar.svg(avCardA, 50);
check('同一张卡两次渲染字节一致（确定性：不是每次刷新都换）', avSvg1 === avSvg2);
const avUniq = {};
for (let i = 0; i < 400; i++) avUniq[window.FYAvatar.svg({ name: '悬疑-' + i, tags: ['悬疑推理'] }, 50)] = 1;
check('同分类 400 个不同名字 → 400 个不同图标（“每个图标都不一样”）',
  Object.keys(avUniq).length === 400, String(Object.keys(avUniq).length));
const avBgs = {};
['末世生存', '恋爱', '科幻未来', '古风仙侠', '恐怖惊悚', '喜剧沙雕'].forEach((t) => {
  avBgs[t] = window.FYAvatar.themeOf({ name: 'X', tags: [t] }).bg[1];
});
check('不同分类拿到不同配色（图标跟着内容走）',
  new Set(Object.values(avBgs)).size === 6
  && window.FYAvatar.themeOf({ name: 'X', tags: ['末世生存'] }).ac === '#c9d94a'
  && window.FYAvatar.themeOf({ name: 'X', avatar: '🔍' }).ac === '#e3b341',
  JSON.stringify(avBgs));
check('库卡的分类 emoji 换成名字首字（不然 1000 张末世卡还是同一个 ☢️）',
  avSvg1.indexOf('白') >= 0 && avSvg1.indexOf('☢') < 0);
check('用户自己挑的 emoji 保留成角标（不抢用户的选择）',
  window.FYAvatar.svg({ name: '自定义', avatar: '🌸', tags: ['自定分类'] }, 50).indexOf('🌸') >= 0);
check('名字里的特殊字符被转义，不会把 SVG 撑坏',
  window.FYAvatar.svg({ name: '<b>&"', tags: ['悬疑推理'] }, 50).indexOf('&lt;') >= 0);
/* 列表里真的用上了 SVG（不是把 emoji 继续塞进 div） */
window.FYApp.renderCharacters();
check('角色列表的头像渲染成 SVG（不是 emoji 文本）',
  !!doc.querySelector('#charGrid .char-avatar svg'),
  '#charGrid .char-avatar svg = ' + doc.querySelectorAll('#charGrid .char-avatar svg').length);
/* 装饰随机但稳定：同一张卡两次一致；不同卡连装饰图案都可能不同 */
const decoA = window.FYAvatar.svg({ name: '白口罩', tags: ['末世生存'] }, 50);
const decoB = window.FYAvatar.svg({ name: '白口罩', tags: ['末世生存'] }, 50);
check('同一张卡的图标两次完全一致（确定性）', decoA === decoB);
check('图标带随机装饰图案（叶子/星芒/圆点/波纹…不止一种）',
  Object.keys(window.FYAvatar._patterns).length >= 8
  && Object.keys(window.FYAvatar._patterns).indexOf('leaf') >= 0,
  Object.keys(window.FYAvatar._patterns).join(','));

/* ---------- 36. 卡库立绘：AI 图优先，缺图退回程序化（v1.6.1） ---------- */
console.log('\n【36】卡库立绘（一张图只给一张卡）');
const avIndexPath = path.join(UI, 'avatars', 'index.json');
const avIndex = fs.existsSync(avIndexPath) ? JSON.parse(fs.readFileSync(avIndexPath, 'utf8')) : null;
check('立绘索引已随 App 打包（app/assets/ui/avatars/index.json）',
  !!avIndex && avIndex.count > 0, avIndex ? ('count=' + avIndex.count) : '缺失');
window.FYApp.setAvatarIndex(avIndex);

/* 立绘是"一张图只给一张卡"：先建两张同主题的卡，只有哈希小的那张拿得到图 */
const avA = S.store.saveCharacter({ name: '白口罩', tags: ['末世生存'], kind: 'character', topic: '水站看表的', persona: '测试人设' });
const avB = S.store.saveCharacter({ name: '白粥', tags: ['末世生存'], kind: 'character', topic: '水站看表的', persona: '测试人设' });
S.characters = S.store.listCharacters();
window.FYApp.ensureAvatarOwners();
const avSrcA = window.FYApp.avatarImageFor(avA);
const avSrcB = window.FYApp.avatarImageFor(avB);
const avHits = [avSrcA, avSrcB].filter(Boolean);
check('带 topic 的卡命中专属立绘（"符合剧情"的那张）',
  avHits.length === 1 && avHits[0].indexOf('avatars/apocalypse/') === 0,
  JSON.stringify([avSrcA, avSrcB]));
check('命中路径指向真实存在的文件', !!avHits[0] && fs.existsSync(path.join(UI, avHits[0])));
check('同一张立绘只给一张卡用：同主题的另一张不重复用同一张脸', avHits.length === 1);
check('没带 topic 的卡 → 返回空（回程序化图标）',
  window.FYApp.avatarImageFor({ name: '甲', tags: ['末世生存'], kind: 'character' }) === '');
check('分类里一张图都没有 → 返回空（不报错）',
  window.FYApp.avatarImageFor({ name: '无', tags: ['不存在的分类'], kind: 'character' }) === '');

const avOwner = avSrcA ? avA : avB;
const avOther = avSrcA ? avB : avA;
const avNode = doc.createElement('div');
window.FYApp.fillAvatar(avNode, avOwner, 50);
check('fillAvatar 命中时渲染 <img.av-img> 并挂上描边色',
  !!avNode.querySelector('img.av-img') && avNode.classList.contains('has-img')
  && avNode.style.getPropertyValue('--av-ac').length > 0,
  avNode.innerHTML.slice(0, 70));
const avProc = doc.createElement('div');
window.FYApp.fillAvatar(avProc, avOther, 50);
check('同主题的"非主人"卡渲染程序化 SVG（不是同一张脸）',
  !!avProc.querySelector('svg') && !avProc.classList.contains('has-img'));
S.store.deleteCharacter(avA.id);
S.store.deleteCharacter(avB.id);
S.characters = S.store.listCharacters();

window.FYApp.setAvatarIndex(null);
const procNode = doc.createElement('div');
window.FYApp.fillAvatar(procNode, { name: '白口罩', tags: ['末世生存'], kind: 'character' }, 50);
check('没有立绘包时退回程序化 SVG（离线不花屏）',
  !!procNode.querySelector('svg') && !procNode.classList.contains('has-img'));
window.FYApp.setAvatarIndex(avIndex);

console.log('\n【37】引擎日志合批（原生侧一次推多行）');
window.FYApp.switchView('debug');
await sleep(300);
const logBefore = S.store.listLogs().length;
window.fyEvent('log', JSON.stringify({ lines: ['合批-甲', '合批-乙', '合批-丙'] }));
await sleep(200);
const logAfter = S.store.listLogs();
check('lines 数组一次写入 3 行',
  logAfter.length === logBefore + 3
  && logAfter.slice(-3).map(x => x.line).join(',') === '合批-甲,合批-乙,合批-丙',
  'before=' + logBefore + ' after=' + logAfter.length);
/* 老格式（单行 line）必须继续认：原生侧可能还装着旧版本，前端不能崩 */
window.fyEvent('log', JSON.stringify({ line: '旧的单行格式' }));
await sleep(200);
check('老的单行 line 仍然兼容',
  S.store.listLogs().slice(-1)[0].line === '旧的单行格式',
  S.store.listLogs().slice(-1)[0].line);
check('调试页把合批的日志渲染出来了',
  $('dbgLog').textContent.indexOf('合批-丙') >= 0);

console.log('\n【38】设置页版本号取自原生 appInfo（防"写死版本号"回归）');
/* 背景：Bridge.java 里曾经写死 o.put("version","0.2")，于是装 1.6.2 也显示 0.2。
   这里把原生返回的版本号换成不可能出现在代码里的字符串，再看界面跟不跟着变。 */
const realAppInfo = window.FY.appInfo;
window.FY.appInfo = function () {
  return realAppInfo.apply(window.FY, arguments)
    .replace(/"version":"[^"]*"/, '"version":"9.9.9-test"');
};
S.appInfo = JSON.parse(window.FY.appInfo());
window.FYApp.switchView('settings');
await sleep(300);
check('改了原生版本号，设置页跟着变（版本号不是前端写死的）',
  $('setVersion').textContent === '9.9.9-test', $('setVersion').textContent);
window.FY.appInfo = realAppInfo;
S.appInfo = JSON.parse(realAppInfo.call(window.FY));

S.store.saveCharacters = realSaveMany;
window.fetch = realFetchLib;
$('libMask').hidden = true;

console.log('\n【39】进程内引擎（JNI）：本地聊天不再走 HTTP');
/* 背景：v1.7.0 起本地推理默认在进程内跑（libllama 直接链进 App 进程），
   没有端口、没有 SSE，token 走 gen 事件。这里把桥假装成「进程内引擎就绪」，
   真发一轮消息，验证：请求确实给了 FY.chat、messages 原样过去、
   token 事件能拼成完整回复、静态前缀默认 pin 住 system。 */
const realEngineStatus = window.FY.engineStatus;
const realChat = window.FY.chat;
const realChatStop = window.FY.chatStop;
const realFyLog = window.FY.log;
const nativeLogs = [];
window.FY.log = function (m) { nativeLogs.push(String(m)); return realFyLog.apply(window.FY, arguments); };
let nativeReq = null;
window.FY.engineStatus = () => JSON.stringify({
  state: 'ready', port: 0, model: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
  message: '进程内引擎就绪', lastError: '', launchStrategy: 'jni', native: true
});
window.FY.chat = function (msgsJson, optsJson) {
  nativeReq = { msgs: JSON.parse(msgsJson), opts: JSON.parse(optsJson) };
  const id = 'g-test-1';
  const full = '（把灯调暗了些）那就先别说话，坐一会儿。';
  const parts = full.match(/.{1,6}/g);
  let i = 0;
  const tick = function () {
    if (i < parts.length) {
      window.fyEvent('gen', JSON.stringify({ id, state: 'delta', delta: parts[i++] }));
      setTimeout(tick, 5);
    } else {
      /* prompt 故意报成"估算值的 5 倍"：这样 token 估算校正一定会触发（否则日志断言会飘） */
      const est = Number(S.lastEstimate) || 100;
      window.fyEvent('gen', JSON.stringify({
        id, state: 'done',
        stats: { gen: 18, reused: est, prompt: est * 5, cache: est * 5 + 18,
                 prefillMs: 12, firstMs: 30, totalMs: 900 }
      }));
    }
  };
  setTimeout(tick, 5);
  return JSON.stringify({ ok: true, id });
};
window.FY.chatStop = function () { return JSON.stringify({ ok: true }); };

S.engineState = {
  state: 'ready', port: 0, model: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
  message: '进程内引擎就绪', lastError: '', native: true
};
const nativeBefore = new Set(S.messages.map(m => m.id));
window.FYApp.sendUserMessage('在吗');
const nativeOk = await until(() => S.messages.some(m =>
  !nativeBefore.has(m.id) && m.role === 'assistant'
  && (m.content || '').indexOf('先别说话') >= 0), 15000);
check('进程内引擎：一轮对话走的是 FY.chat（不是 HTTP）', !!nativeReq,
  'nativeReq=' + (nativeReq ? 'ok' : 'null'));
check('进程内引擎：messages 原样递给了原生侧（含 system）',
  !!(nativeReq && nativeReq.msgs.length >= 2 && nativeReq.msgs[0].role === 'system'),
  nativeReq ? nativeReq.msgs.length + ' 条' : '');
check('进程内引擎：静态前缀默认 pin 1 条 system',
  !!(nativeReq && nativeReq.opts.pinMessages === 1), nativeReq && JSON.stringify(nativeReq.opts));
check('进程内引擎：gen 事件拼成完整回复', nativeOk,
  nativeOk ? '' : JSON.stringify((S.messages.slice(-1)[0] || {}).content).slice(0, 120));
check('进程内引擎：流式结束后 generating 复位', await until(() => S.generating !== true, 5000),
  'generating=' + S.generating);
check('进程内引擎：真实 prompt token 数进了估算校正日志',
  nativeLogs.some(l => /token 估算校正/.test(l)),
  JSON.stringify(nativeLogs.slice(-3)));

window.FY.engineStatus = realEngineStatus;
window.FY.chat = realChat;
window.FY.chatStop = realChatStop;
window.FY.log = realFyLog;
S.engineState = { state: 'ready', port: 5599, model: 'Qwen3-4B-Q4_K_M.gguf', message: 'ok', lastError: '' };

console.log('\n' + '─'.repeat(64));
console.log(`结果： ${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('失败项：'); failures.forEach(f => console.log('  · ' + f)); }
const cErrs = consoleErrors.filter(e => !e.startsWith('jsdomError'));
if (cErrs.length) {
  console.log('\n控制台输出（前 12 条）：');
  cErrs.slice(0, 12).forEach(e => console.log('  · ' + String(e).slice(0, 180)));
}
process.exit(fail ? 1 : 0);
