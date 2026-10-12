/**
 * probe-prompts.mjs —— 拿真模型做对照实验，找出「剧情选项不吐标记」「记忆摘要为空」的原因。
 *
 * 用法: node probe-prompts.mjs [模型文件名]
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = path.join(ROOT, 'native');
const MODEL = process.argv[2] || 'Qwen3-4B-Q4_K_M.gguf';
const PORT = 8124;

const engine = spawn(path.join(PAYLOAD, 'libfy_llama_server.so'),
  ['-m', path.join(ROOT, 'models', MODEL), '-c', '4096', '-t', '6',
   '--host', '127.0.0.1', '--port', String(PORT), '--no-webui', '--context-shift', '--cache-reuse', '256'],
  { env: { LD_LIBRARY_PATH: PAYLOAD, PATH: '/system/bin:/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
engine.stdout.on('data', () => {});
engine.stderr.on('data', () => {});
process.on('exit', () => { try { engine.kill('SIGKILL'); } catch (e) {} });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok && (await r.text()).includes('ok')) return true;
    } catch (e) {}
    if (engine.exitCode !== null) return false;
  }
  return false;
}

/** 非流式请求，返回 {content, reasoning, finish, ms} */
async function ask(messages, opts = {}) {
  const body = {
    messages,
    stream: false,
    temperature: opts.temperature !== undefined ? opts.temperature : 0.8,
    top_p: 0.9,
    max_tokens: opts.max_tokens || 200,
  };
  if (opts.noThink) body.chat_template_kwargs = { enable_thinking: false };
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  const m = (d.choices && d.choices[0] && d.choices[0].message) || {};
  return {
    content: m.content || '',
    reasoning: m.reasoning_content || '',
    finish: d.choices && d.choices[0] && d.choices[0].finish_reason,
    ms: Date.now() - t0,
  };
}

const OK = (b) => (b ? '有' : '没有');

if (!(await waitReady())) { console.log('引擎起不来'); process.exit(1); }
console.log(`引擎就绪：${MODEL}\n`);

// ============================================================ 实验一：剧情选项
console.log('════ 实验一：怎样才能让模型吐出 <<<OPTIONS 标记 ════');

const persona = '【角色】林夏\n住隔壁的温柔女孩，总在深夜留一盏灯。说话轻声细语，喜欢煮粥。';
const chatHistory = [
  { role: 'user', content: '今天下了一整天的雨，我刚从外面回来，鞋全湿了。' },
  { role: 'assistant', content: '（轻轻擦擦眼镜）我给你煮了红豆粥，先换双干的鞋吧。' },
];
const userTurn = '我擦着头发，看着窗外的雨，想找点事做。';

const promptA = persona + '\n\n【剧情模式】正文结束后，必须另起一行输出三个可选行动，格式严格如下（不要加任何多余文字）：\n<<<OPTIONS\n1. 选项一\n2. 选项二\n3. 选项三\nOPTIONS>>>\n\n/no_think';
const promptB = persona + '\n\n【剧情模式 · 硬性要求】\n你每次回复都必须在正文结束后，另起一行原样输出下面这段结构，把其中的文字替换成三个具体行动：\n'
  + '<<<OPTIONS\n1. 具体行动一\n2. 具体行动二\n3. 具体行动三\nOPTIONS>>>\n'
  + '注意：`<<<OPTIONS`、`OPTIONS>>>` 这两行是程序标记，必须一字不差地出现；缺少它用户将无法继续剧情。\n\n/no_think';
const reminder = '（记得在末尾按 <<<OPTIONS ... OPTIONS>>> 格式给出 3 个可选行动）';

for (const [name, msgs] of [
  ['A 现状：仅在 system 里说明格式', [{ role: 'system', content: promptA }, ...chatHistory, { role: 'user', content: userTurn }]],
  ['B 强化 system（强调必须+后果）', [{ role: 'system', content: promptB }, ...chatHistory, { role: 'user', content: userTurn }]],
  ['C system 强化 + user 末尾再提醒', [{ role: 'system', content: promptB }, ...chatHistory, { role: 'user', content: userTurn + '\n' + reminder }]],
  ['D 只在 user 末尾提醒（system 保持现状）', [{ role: 'system', content: promptA }, ...chatHistory, { role: 'user', content: userTurn + '\n' + reminder }]],
]) {
  const r = await ask(msgs, { max_tokens: 260, noThink: true });
  const hasOpen = r.content.includes('<<<OPTIONS');
  const hasClose = r.content.includes('OPTIONS>>>');
  console.log(`\n--- ${name} ---`);
  console.log(`  开标记:${OK(hasOpen)}  闭标记:${OK(hasClose)}  finish=${r.finish}  用时=${(r.ms / 1000).toFixed(1)}s`);
  console.log('  尾部 120 字: ' + JSON.stringify(r.content.slice(-120)));
}

// ============================================================ 实验二：记忆摘要
console.log('\n\n════ 实验二：记忆压缩（stream:false）为什么返回空 ════');
const memPrompt = '下面是一段角色扮演对话的早期记录。请把它压缩成一段第三人称中文摘要（180 字以内），'
  + '只保留对后续剧情重要的事实：人物关系、称呼、约定、发生过的关键事件、用户透露的偏好与经历。'
  + '不要评论，不要客套，直接输出摘要正文。\n\n【新增对话记录】\n用户：我叫小林，怕黑。\n角色：记住了，小林。\n用户：我们约好周五去河边。\n角色：好，周五河边见。\n用户：别忘了带伞。';
const memMsgs = [
  { role: 'system', content: '你是一个擅长信息压缩的助手，只输出摘要正文。' },
  { role: 'user', content: memPrompt },
];

const r1 = await ask(memMsgs, { temperature: 0.3, max_tokens: 320, noThink: false });
console.log('\n--- 现状：不带 enable_thinking=false，max_tokens=320 ---');
console.log(`  content ${r1.content.length} 字, reasoning_content ${r1.reasoning.length} 字, finish=${r1.finish}, 用时=${(r1.ms / 1000).toFixed(1)}s`);
console.log('  content: ' + JSON.stringify(r1.content.slice(0, 160)));
console.log('  reasoning 前 100: ' + JSON.stringify(r1.reasoning.slice(0, 100)));

const r2 = await ask(memMsgs, { temperature: 0.3, max_tokens: 320, noThink: true });
console.log('\n--- 修法：带 enable_thinking=false ---');
console.log(`  content ${r2.content.length} 字, reasoning ${r2.reasoning.length} 字, finish=${r2.finish}, 用时=${(r2.ms / 1000).toFixed(1)}s`);
console.log('  content: ' + JSON.stringify(r2.content.slice(0, 200)));

const r3 = await ask(memMsgs, { temperature: 0.3, max_tokens: 800, noThink: false });
console.log('\n--- 另一种修法：不关思考但把 max_tokens 提到 800 ---');
console.log(`  content ${r3.content.length} 字, reasoning ${r3.reasoning.length} 字, finish=${r3.finish}, 用时=${(r3.ms / 1000).toFixed(1)}s`);
console.log('  content: ' + JSON.stringify(r3.content.slice(0, 200)));

try { engine.kill('SIGKILL'); } catch (e) {}
process.exit(0);
