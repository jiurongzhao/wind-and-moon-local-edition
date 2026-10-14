// litertlm-chat.js —— 起一轮生成，token 攒到 window.__llmGen，用 litertlm-poll.js 收。
window.__llmGen = { acc: '', done: null, errors: [], t0: Date.now() };
const orig = window.fyEvent;
window.fyEvent = function (name, payload) {
  if (name === 'gen') {
    if (payload.state === 'delta') window.__llmGen.acc += (payload.delta || '');
    else if (payload.state === 'done') { window.__llmGen.done = payload; window.__llmGen.tEnd = Date.now(); }
    else if (payload.state === 'error') window.__llmGen.errors.push(payload);
  }
  return orig ? orig(name, payload) : undefined;
};
const messages = [
  { role: 'system', content: window.__LLM_SYS || '你扮演「林夏」，老城区旧书店的店主，说话轻、慢，句子短，不要总结和讲道理。' },
  { role: 'user', content: window.__LLM_USER || '给我推荐一本书吧，再讲讲你为什么会想起它。' }
];
const ack = JSON.parse(window.FY.chat(JSON.stringify(messages), JSON.stringify({
  pinMessages: 1, maxTokens: window.__LLM_MAX || 160, temperature: 0.8, topK: 40, topP: 0.9, seed: 0,
  penaltyRepeat: 1.1, penaltyLastN: 64, penaltyFreq: 0.0, penaltyPresent: 0.0
})));
return { ack: ack, t0: window.__llmGen.t0 };
