/**
 * bench-prefix.mjs —— 量「多轮对话里每轮到底要重新预填充多少 token」。
 *
 * 背景：llama-server 会缓存上一次请求的 KV 前缀。只要这一轮的 messages 序列
 * 是上一轮序列的"延长"，前缀就能全命中，新的一轮几乎不用预填充。
 * 但如果历史消息的"发送形态"和"存储形态"不一致（App 现在就是这样：时间戳/剧情提醒
 * 只在发送时追加到最后一条，历史里没有），前缀就会在上一轮的位置断掉 ——
 * 每轮都要把上一轮的用户消息 + 助手回复重新算一遍。
 *
 * 这个脚本用两种形态各跑一遍，直接读服务端返回的 prompt_n（真实需要预填充的 token 数）。
 *
 * 用法:
 *   SHAPE=broken node bench-prefix.mjs   # 现状：元信息只在最后一条
 *   SHAPE=stable node bench-prefix.mjs   # 修复后：元信息随消息一起存
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = path.join(ROOT, 'native');
const MODEL = process.env.MODEL || 'qwen2.5-0.5b-instruct-q4_k_m.gguf';
const PORT = Number(process.env.PORT || 8133);
const SHAPE = process.env.SHAPE || 'broken';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = ['-c', '4096', '-t', '4', '--host', '127.0.0.1', '--port', String(PORT),
  '--no-webui', '--context-shift', '--cache-reuse', '256', '--load-mode', 'mlock'];

const engine = spawn(path.join(PAYLOAD, 'libfy_llama_server.so'),
  ['-m', path.join(ROOT, 'models', MODEL), ...BASE],
  { env: { LD_LIBRARY_PATH: PAYLOAD, PATH: '/system/bin:/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore'] });
process.on('exit', () => { try { engine.kill('SIGKILL'); } catch (e) {} });

for (let i = 0; i < 300; i++) {
  await sleep(1000);
  try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok && (await r.text()).includes('ok')) break; } catch (e) {}
}

const sys = '你扮演林夏，一个开旧书店的温柔女孩，说话轻缓、口语化，动作放在圆括号里。';

/* 同一个"实际内容"，两种发送/存储形态 */
const U1_CONTENT = '今天下了一整天的雨，我刚从外面回来，鞋全湿了。';
const U2_CONTENT = '好啊，你讲讲吧。';
const META1 = '\n\n（当前时间：2026/10/11 11:30:00）';
const META2 = '\n\n（当前时间：2026/10/11 11:32:00）';

async function ask(messages, label) {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, stream: false, max_tokens: 48, temperature: 0.8,
      chat_template_kwargs: { enable_thinking: false } }),
  });
  const d = await r.json();
  const t = d.timings || {};
  const content = (d.choices && d.choices[0] && d.choices[0].message.content) || '';
  console.log(`  ${label.padEnd(26)} 预填充 ${String(t.prompt_n || 0).padStart(4)} token`
    + ` / ${((t.prompt_ms || 0) / 1000).toFixed(2)}s   （生成 ${t.predicted_n || 0} token）`);
  return content;
}

console.log(`=== 前缀复用对比（形态=${SHAPE}，模型=${MODEL}）===\n`);

/* 第一轮：两种形态完全一样（元信息本来就在最后一条上） */
const hist1 = [{ role: 'user', content: U1_CONTENT + META1 }];
const a1 = await ask([{ role: 'system', content: sys }, ...hist1], '第 1 轮（冷启动）');

/* 第二轮：区别就在这里 */
let turn2;
if (SHAPE === 'stable') {
  /* 修复后：历史里保留当初发送的形态 → 整个上一轮都是前缀 */
  turn2 = [
    { role: 'system', content: sys },
    { role: 'user', content: U1_CONTENT + META1 },
    { role: 'assistant', content: a1 },
    { role: 'user', content: U2_CONTENT + META2 },
  ];
} else {
  /* 现状：历史是"干净"的存储形态，元信息只在发送时追加到最新一条 → 前缀在 U1 处断掉 */
  turn2 = [
    { role: 'system', content: sys },
    { role: 'user', content: U1_CONTENT },
    { role: 'assistant', content: a1 },
    { role: 'user', content: U2_CONTENT + META2 },
  ];
}
await ask(turn2, SHAPE === 'stable' ? '第 2 轮（形态稳定）' : '第 2 轮（现状形态）');

console.log('\n（"预填充 token" 越接近新消息本身越理想；现状形态会把上一轮的用户消息+回复重算一遍）');
try { engine.kill('SIGKILL'); } catch (e) {}
