// litertlm-poll.js —— 收 litertlm-chat.js 的战果。
const g = window.__llmGen || {};
return {
  done: !!g.done,
  chars: (g.acc || '').length,
  elapsedMs: g.tEnd ? (g.tEnd - g.t0) : (Date.now() - (g.t0 || Date.now())),
  stats: g.done ? g.done.stats : null,
  text: (g.acc || '').slice(0, 600),
  errors: g.errors || []
};
