/**
 * probe-speed.mjs —— 量化多轮对话到底慢在哪。
 *
 * 用非流式请求，直接读 llama-server 返回的 timings（prompt_ms / predicted_ms），
 * 分别看「预填充」和「生成」各占多少，以及第二次相同前缀能不能命中缓存。
 *
 * 用法: node probe-speed.mjs [模型文件名]
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = path.join(ROOT, 'native');
const MODEL = process.argv[2] || 'Qwen3-4B-Q4_K_M.gguf';
const PORT = 8126;
const EXTRA = (process.argv[3] || '').split(' ').filter(Boolean);
console.log('额外参数: ' + (EXTRA.join(' ') || '(无)'));

const engine = spawn(path.join(PAYLOAD, 'libfy_llama_server.so'),
  ['-m', path.join(ROOT, 'models', MODEL), '-c', '4096', '-t', '6',
   '--host', '127.0.0.1', '--port', String(PORT), '--no-webui',
   '--context-shift', '--cache-reuse', '256', ...EXTRA],
  { env: { LD_LIBRARY_PATH: PAYLOAD, PATH: '/system/bin:/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
engine.stdout.on('data', () => {});
engine.stderr.on('data', () => {});
process.on('exit', () => { try { engine.kill('SIGKILL'); } catch (e) {} });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 240; i++) {
  await sleep(1000);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (r.ok && (await r.text()).includes('ok')) break;
  } catch (e) {}
}
console.log(`引擎就绪：${MODEL}\n`);

async function ask(messages, maxTokens, label) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages, stream: false, max_tokens: maxTokens, temperature: 0.85, top_p: 0.9,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const d = await r.json();
  const t = d.timings || {};
  const total = Date.now() - t0;
  console.log(`--- ${label} ---`);
  console.log(`  墙钟总耗时 ${(total / 1000).toFixed(1)}s`);
  console.log(`  预填充 ${t.prompt_n || 0} token / ${((t.prompt_ms || 0) / 1000).toFixed(1)}s`
    + ` = ${(t.prompt_per_second || 0).toFixed(1)} tok/s`);
  console.log(`  生成   ${t.predicted_n || 0} token / ${((t.predicted_ms || 0) / 1000).toFixed(1)}s`
    + ` = ${(t.predicted_per_second || 0).toFixed(1)} tok/s`);
  const msg = (d.choices && d.choices[0] && d.choices[0].message) || {};
  console.log(`  finish=${d.choices && d.choices[0] && d.choices[0].finish_reason}`
    + `  正文 ${(msg.content || '').length} 字`);
  return { total, t, content: msg.content || '' };
}

// 模拟 App 真实的 system prompt（角色设定 + 群聊 + 剧情 + 记忆 + 结尾要求）
const sys = '你正在进行一场沉浸式的中文角色扮演对话。请始终保持角色人设，不要以 AI 或助手的身份说话。\n\n'
  + '【角色】林夏\n住隔壁的温柔女孩，总在深夜留一盏灯。说话轻声细语，喜欢煮粥，怕黑。\n\n'
  + '【长期记忆 · 更早剧情的摘要】\n林夏与用户在雨夜相遇，用户湿透归来，林夏提供毛巾和热粥，两人关系逐渐亲近。\n\n'
  + '【剧情模式 · 硬性要求】\n每次回复都要在正文结束后另起一行，原样输出下面这个结构，'
  + '并把其中的文字替换成三个具体行动：\n<<<OPTIONS\n1. 具体行动一\n2. 具体行动二\n3. 具体行动三\nOPTIONS>>>\n'
  + '注意：`<<<OPTIONS` 和 `OPTIONS>>>` 这两行是程序读取用的标记，必须一字不差地出现；'
  + '缺少它用户就无法继续剧情。（正文里不要提到这个格式本身）\n\n'
  + '请直接输出角色的话与必要的动作描写，不要解释自己是 AI，也不要复述设定。';
const history = [
  { role: 'user', content: '今天下了一整天的雨，我刚从外面回来，鞋全湿了。\n\n（当前时间：2026/10/11 11:30:00）' },
  { role: 'assistant', content: '（轻轻擦擦眼镜，把围裙系得更紧些）你看，雨滴在窗台上的声音，像谁在轻轻哼歌。我给你煮了红豆粥，等你坐下来，我给你换双干的鞋。' },
  { role: 'user', content: '我擦着头发，看着窗外的雨，想找点事做。\n\n（当前时间：2026/10/11 11:31:00）\n（提醒：请在回复末尾另起一行，严格按 <<<OPTIONS / 1. / 2. / 3. / OPTIONS>>> 的格式给出 3 个可选行动）' },
  { role: 'assistant', content: '（把一盆温水放在窗边）你要是想做点什么，可以试试把旧书页翻出来，我这儿有本《雨的形状》，你要是感兴趣，我给你讲讲。' },
];
const userTurn = { role: 'user', content: '好啊，你讲讲吧。\n\n（当前时间：2026/10/11 11:32:00）\n（提醒：请在回复末尾另起一行，严格按 <<<OPTIONS / 1. / 2. / 3. / OPTIONS>>> 的格式给出 3 个可选行动）' };

console.log('【A】第一轮：system + 4 条历史 + 1 条新消息（max_tokens=512，和 App 默认一致）');
const a = await ask([{ role: 'system', content: sys }, ...history, userTurn], 512, 'A 首次');

console.log('\n【B】立刻再发一次完全相同的请求（应该命中前缀缓存）');
const b = await ask([{ role: 'system', content: sys }, ...history, userTurn], 512, 'B 同前缀');

console.log('\n【C】只多一条历史（模拟下一轮，前缀应基本复用）');
const c = await ask([
  { role: 'system', content: sys }, ...history, userTurn,
  { role: 'assistant', content: a.content || '（点头）好。' },
  { role: 'user', content: '嗯，然后呢？\n\n（当前时间：2026/10/11 11:33:00）' },
], 512, 'C 追加一轮');

console.log('\n【D】限制 max_tokens=160（看生成时间占比）');
const d = await ask([{ role: 'system', content: sys }, ...history, userTurn], 160, 'D 短输出');

console.log('\n════ 小结 ════');
console.log(`A 首次：${(a.total / 1000).toFixed(1)}s（预填充 ${((a.t.prompt_ms || 0) / 1000).toFixed(1)}s + 生成 ${((a.t.predicted_ms || 0) / 1000).toFixed(1)}s）`);
console.log(`B 同前缀：${(b.total / 1000).toFixed(1)}s（预填充 ${((b.t.prompt_ms || 0) / 1000).toFixed(1)}s）`);
console.log(`C 追加：${(c.total / 1000).toFixed(1)}s（预填充 ${((c.t.prompt_ms || 0) / 1000).toFixed(1)}s）`);
console.log(`D 短输出：${(d.total / 1000).toFixed(1)}s（生成 ${((d.t.predicted_ms || 0) / 1000).toFixed(1)}s, ${(d.t.predicted_per_second || 0).toFixed(1)} tok/s）`);

try { engine.kill('SIGKILL'); } catch (e) {}
process.exit(0);
