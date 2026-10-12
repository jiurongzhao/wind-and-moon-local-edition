/**
 * bench-flags.mjs —— 引擎参数 A/B 基准（真机 CPU 上跑真引擎，不依赖 adb）
 *
 * 为什么需要它：这个 App 的性能几乎完全由 llama.cpp 的启动参数决定，
 * 而"哪个参数更快"只能实测 —— 网上抄的经验在手机 SoC 上经常反过来。
 * 这里固定同一段提示词、同一个模型，只切换参数，读服务端返回的 timings，
 * 把「加载耗时 / 预填充 tok/s / 生成 tok/s / 前缀复用 / 常驻内存」一次打出来。
 *
 * 用法:
 *   node bench-flags.mjs                       # 跑默认矩阵（0.5B）
 *   MODEL=Qwen3-4B-Q4_K_M.gguf node bench-flags.mjs
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = path.join(ROOT, 'native');
const MODEL = process.env.MODEL || 'qwen2.5-0.5b-instruct-q4_k_m.gguf';
const PORT = Number(process.env.PORT || 8131);
const MAXTOK = Number(process.env.MAXTOK || 160);
const ONLY = process.env.ONLY || '';

/* App 现在真实用的那套参数（基线必须和它一致，否则对比没意义） */
const BASE = ['-c', '4096', '-t', '6', '--host', '127.0.0.1', '--port', String(PORT),
  '--no-webui', '--context-shift', '--cache-reuse', '256', '--load-mode', 'mlock'];

const SETS = [
  ['基线（App 现状）', []],
  ['+ flash-attn', ['-fa', 'on']],
  ['+ KV q8_0', ['-ctk', 'q8_0', '-ctv', 'q8_0']],
  ['+ fa + KV q8_0', ['-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0']],
  ['+ ubatch 128', ['-ub', '128', '-b', '512']],
  ['+ 4 线程', ['-t', '4']],
  ['+ 4线程+fa+KVq8', ['-t', '4', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0']],
  ['+ 8 线程', ['-t', '8']],
  /* 投机解码：0.5B 当草稿、目标模型自己猜，猜中的 token 一次验证通过。
     草稿小模型很快，命中率高时整体能提速 —— 命中率低时反而更慢，必须实测。 */
  ['+ 草稿加速 0.5B', ['-md', path.join(ROOT, 'models', 'qwen2.5-0.5b-instruct-q4_k_m.gguf'),
    '--spec-draft-n-max', '8', '--spec-draft-threads', '4']],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sys = '你正在进行一场沉浸式的中文角色扮演对话。请始终保持角色人设，不要以 AI 或助手的身份说话。\n\n'
  + '【角色】林夏\n住隔壁的温柔女孩，总在深夜留一盏灯。说话轻声细语，喜欢煮粥，怕黑。\n\n'
  + '【长期记忆 · 更早剧情的摘要】\n林夏与用户在雨夜相遇，用户湿透归来，林夏提供毛巾和热粥，两人关系逐渐亲近。\n\n'
  + '请直接输出角色的话与必要的动作描写，不要解释自己是 AI，也不要复述设定。';

const history = [
  { role: 'user', content: '今天下了一整天的雨，我刚从外面回来，鞋全湿了。\n\n（当前时间：2026/10/11 11:30:00）' },
  { role: 'assistant', content: '（轻轻擦擦眼镜，把围裙系得更紧些）你看，雨滴在窗台上的声音，像谁在轻轻哼歌。我给你煮了红豆粥，等你坐下来，我给你换双干的鞋。' },
  { role: 'user', content: '我擦着头发，看着窗外的雨，想找点事做。\n\n（当前时间：2026/10/11 11:31:00）' },
  { role: 'assistant', content: '（把一盆温水放在窗边）你要是想做点什么，可以试试把旧书页翻出来，我这儿有本《雨的形状》，你要是感兴趣，我给你讲讲。' },
];
const turn = { role: 'user', content: '好啊，你讲讲吧。\n\n（当前时间：2026/10/11 11:32:00）' };

async function ask(messages) {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages, stream: false, max_tokens: MAXTOK, temperature: 0.85, top_p: 0.9,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const d = await r.json();
  return d.timings || {};
}

function rssOf(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = s.match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : 0;
  } catch (e) { return 0; }
}

async function runSet(label, extra) {
  const args = ['-m', path.join(ROOT, 'models', MODEL), ...BASE, ...extra];
  const t0 = Date.now();
  const p = spawn(path.join(PAYLOAD, 'libfy_llama_server.so'), args, {
    env: { LD_LIBRARY_PATH: PAYLOAD, PATH: '/system/bin:/usr/bin:/bin' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let ready = false;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok && (await r.text()).includes('ok')) { ready = true; break; }
    } catch (e) {}
    if (p.exitCode !== null) break;
  }
  const loadMs = Date.now() - t0;
  if (!ready) {
    try { p.kill('SIGKILL'); } catch (e) {}
    console.log(`${label.padEnd(18)} | 启动失败（参数不被支持或内存不够）`);
    return;
  }
  const rss = rssOf(p.pid);

  const cold = await ask([{ role: 'system', content: sys }, ...history, turn]);      // 冷启动预填充
  const warm = await ask([{ role: 'system', content: sys }, ...history, turn]);      // 同前缀 → 命中缓存
  const next = await ask([{ role: 'system', content: sys }, ...history, turn,        // 多一轮 → 看复用程度
    { role: 'assistant', content: cold.__dummy || '（放下书）好，我从头讲。' }, turn]);

  const f = (t, k) => (t[k] || 0);
  console.log([
    label.padEnd(18),
    ('加载 ' + (loadMs / 1000).toFixed(0) + 's').padEnd(9),
    ('预填充 ' + f(cold, 'prompt_per_second').toFixed(0) + ' t/s').padEnd(15),
    ('生成 ' + f(cold, 'predicted_per_second').toFixed(1) + ' t/s').padEnd(13),
    ('复用后预填充 ' + f(warm, 'prompt_n') + ' token').padEnd(22),
    ('RSS ' + rss + 'MB'),
  ].join(' | '));
  try { p.kill('SIGKILL'); } catch (e) {}
  await sleep(2000);
}

console.log(`=== 引擎参数基准：${MODEL}（max_tokens=${MAXTOK}）===`);
console.log('参数组             | 加载      | 预填充          | 生成          | 前缀复用               | 内存');
for (const [label, extra] of SETS) {
  if (ONLY && !label.includes(ONLY)) continue;
  await runSet(label, extra);
}
console.log('\n注：预填充 = prompt_per_second；"复用后预填充" 是第二次相同请求实际要算的 token 数（越小越好）。');
