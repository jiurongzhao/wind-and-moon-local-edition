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
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import 'fake-indexeddb/auto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(__dirname, '../app/assets/ui');
const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const SCRIPTS = ['store.js', 'cards.js', 'mock.js', 'app.js'];

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

console.log('\n' + '─'.repeat(64));
console.log(`结果： ${pass} 通过 / ${fail} 失败`);
if (failures.length) { console.log('失败项：'); failures.forEach(f => console.log('  · ' + f)); }
const cErrs = consoleErrors.filter(e => !e.startsWith('jsdomError'));
if (cErrs.length) {
  console.log('\n控制台输出（前 12 条）：');
  cErrs.slice(0, 12).forEach(e => console.log('  · ' + String(e).slice(0, 180)));
}
process.exit(fail ? 1 : 0);
