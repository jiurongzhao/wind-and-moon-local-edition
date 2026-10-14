// litertlm-load.js —— 在 App 的 WebView 里（cdp.mjs --file）跑：把 LiteRT-LM 引擎拉起来，等就绪。
// 前置：模型已经躺在 App 的 models/ 里（tools/litertlm-device.sh 负责放进去）。
const S = window.FYApp.state;
const models = JSON.parse(window.FY.listModels());
const want = window.__LLM_MODEL;
const target = (want && models.find(function (m) { return m.name === want; }))
  || models.find(function (m) { return /\.litertlm$/i.test(m.name); })
  || models.find(function (m) { return /\.task$/i.test(m.name); });
if (!target) {
  return { error: 'models/ 里没有 .litertlm / .task', models: models.map(function (m) { return m.name; }) };
}
window.__llm = { model: target.name, events: [] };
const orig = window.fyEvent;
window.fyEvent = function (name, payload) {
  if (name === 'engine') {
    try { window.__llm.events.push({ state: payload.state, message: payload.message, t: Date.now() }); } catch (e) {}
  }
  return orig ? orig(name, payload) : undefined;
};
const t0 = Date.now();
const ack = JSON.parse(window.FY.engineStart(JSON.stringify({
  model: target.name,
  ctx: 4096,
  threads: window.__LLM_THREADS || 4,
  gpuLayers: 0,
  loadMode: 'mlock',
  engineMode: 'litertlm',
  tune: window.__LLM_TUNE || ''
})));
const deadline = Date.now() + 240000;
while (Date.now() < deadline) {
  if (S.engineState.state === 'ready' || S.engineState.state === 'error') break;
  await new Promise(function (r) { setTimeout(r, 500); });
}
return {
  model: target.name,
  ack: ack,
  elapsedMs: Date.now() - t0,
  finalState: S.engineState,
  events: window.__llm.events.slice(-12)
};
