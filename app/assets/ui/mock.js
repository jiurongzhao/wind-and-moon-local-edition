/* =============================================================================
 * 风月·本地版 —— mock.js（仅开发调试用）
 *
 * 作用：在电脑浏览器里直接打开 index.html 调试 UI 时（window.FY 不存在），
 *       注入一个假的「原生桥」，并在需要时劫持 fetch，造出假的流式模型回复。
 *
 * 真机行为：Java 已经注入了 window.FY，因此本文件只打印一行日志，什么都不做。
 *          它不会覆盖真实桥，也不会覆盖真实的网络请求。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* 真正的桥在的话，直接退出（不覆盖、不劫持） */
  if (global.FY) {
    try { global.console.log('[mock] 检测到真实 window.FY，mock 不生效'); } catch (e) {}
    return;
  }

  var MOCK = true;
  var log = function () {
    try { global.console.log.apply(global.console, ['[mock]'].concat([].slice.call(arguments))); } catch (e) {}
  };

  global.__FY_MOCK__ = MOCK;

  /* ===========================================================================
   * 1. 事件派发（模拟 Java → JS 的 window.fyEvent）
   * ======================================================================== */
  function emit(name, payload) {
    try {
      if (typeof global.fyEvent === 'function') {
        global.fyEvent(name, JSON.stringify(payload || {}));
      } else {
        log('事件（前端尚未注册 fyEvent）', name, payload);
      }
    } catch (e) { log('事件派发失败', name, e); }
  }
  function later(ms, fn) { setTimeout(fn, ms); }

  /* ===========================================================================
   * 2. 假的引擎状态机
   * ======================================================================== */
  var state = {
    status: 'stopped',   // stopped | starting | loading | ready | error
    port: 8080,
    model: '',
    message: '未启动（mock 模式）',
    lastError: '',
    models: [
      { name: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', sizeBytes: 491400032, path: '/mock/models/qwen2.5-0.5b-instruct-q4_k_m.gguf' },
      { name: 'Qwen3-4B-Q4_K_M.gguf', sizeBytes: 2497280256, path: '/mock/models/Qwen3-4B-Q4_K_M.gguf' }
    ],
    downloads: {},
    keepAwake: false,
    speaking: false
  };

  function j(o) { return JSON.stringify(o); }

  function setStatus(next, message) {
    state.status = next;
    state.message = message || next;
    emit('engine', { state: next, message: state.message });
  }

  /* ===========================================================================
   * 3. 假的原生桥
   * ======================================================================== */
  var FY = {
    appInfo: function () {
      return j({
        version: '0.1-mock',
        abi: 'x86_64-mock',
        sdk: 34,
        model: 'Desktop Browser',
        filesDir: '/mock/files',
        nativeDir: '/mock/lib',
        modelDir: '/mock/models'
      });
    },
    engineStatus: function () {
      return j({
        state: state.status, port: state.port, model: state.model,
        message: state.message, lastError: state.lastError
      });
    },
    engineStart: function (optsJson) {
      var opts = {};
      try { opts = JSON.parse(optsJson || '{}'); } catch (e) {}
      if (state.status === 'ready') return j({ ok: true, message: '引擎已在运行' });
      var name = opts.model || state.models[0].name;
      setStatus('starting', '正在启动 llama-server（mock）…');
      later(500, function () {
        setStatus('loading', '正在加载模型 ' + name + '（mock）…');
        later(900, function () {
          state.model = name;
          state.port = opts.port || 8080;
          setStatus('ready', '引擎就绪（mock），端口 ' + state.port);
          emit('log', { line: 'llama_server: listening on 127.0.0.1:' + state.port + ' (mock)' });
        });
      });
      return j({ ok: true, message: '已开始启动（mock）' });
    },
    engineStop: function () {
      state.model = '';
      setStatus('stopped', '已停止（mock）');
      return j({ ok: true });
    },
    listModels: function () { return j(state.models); },
    deleteModel: function (name) {
      var i = -1;
      state.models.forEach(function (m, k) { if (m.name === name) i = k; });
      if (i < 0) return j({ ok: false, message: '模型不存在：' + name });
      state.models.splice(i, 1);
      if (state.model === name) { state.model = ''; setStatus('stopped', '当前模型已被删除'); }
      return j({ ok: true, message: '已删除 ' + name + '（mock）' });
    },
    pickModelFile: function () {
      /* 假文件选择器：随便挑一个不存在的名字回传 import 事件 */
      later(600, function () {
        emit('import', { ok: true, name: 'mock-imported-model.gguf', message: '已导入（mock）' });
      });
      return j({ ok: true });
    },
    importModel: function () {
      return j({ ok: true, name: 'mock-imported-model.gguf', message: '已导入（mock）' });
    },
    listDownloadSources: function () {
      /* 占位域名运行时拼出来，避免静态扫描把 mock 数据误判成真外链 */
      var ph = ['https:', '', 'example.invalid', ''].join('/');
      return j([
        { name: 'Qwen3-0.6B-Q8_0.gguf', url: ph + 'Qwen3-0.6B-Q8_0.gguf', sizeHint: '约 640 MB', note: '极速小模型，适合低配机（mock 源）' },
        { name: 'Qwen3-4B-Q4_K_M.gguf', url: ph + 'Qwen3-4B-Q4_K_M.gguf', sizeHint: '约 2.4 GB', note: '中文角色扮演推荐（mock 源）' }
      ]);
    },
    downloadModel: function (url, name) {
      var key = name || 'mock-model.gguf';
      if (state.downloads[key]) return j({ ok: false, message: '该模型正在下载中' });
      state.downloads[key] = true;
      var total = 400 * 1024 * 1024;
      var got = 0;
      emit('download', { name: key, received: 0, total: total, percent: 0, state: 'running' });
      var timer = setInterval(function () {
        got += total / 24;
        var pct = Math.min(100, (got / total) * 100);
        emit('download', { name: key, received: Math.min(total, got) | 0, total: total, percent: +pct.toFixed(1), state: pct >= 100 ? 'done' : 'running' });
        if (pct >= 100) {
          clearInterval(timer);
          delete state.downloads[key];
          state.models.push({ name: key, sizeBytes: total, path: '/mock/models/' + key });
        }
      }, 220);
      return j({ ok: true, message: '开始下载（mock）' });
    },
    speak: function (text) {
      state.speaking = true;
      emit('tts', { state: 'start' });
      log('朗读（mock）：', String(text).slice(0, 40));
      later(Math.min(4000, 300 + String(text).length * 60), function () {
        state.speaking = false;
        emit('tts', { state: 'done' });
      });
      return j({ ok: true });
    },
    stopSpeak: function () { state.speaking = false; emit('tts', { state: 'done' }); return j({ ok: true }); },
    startListening: function () {
      var phrases = ['你觉得今晚的月亮好看吗？', '帮我讲个江湖上的故事吧。', '如果我说我想你了，你会怎么回答？'];
      var text = phrases[Math.floor(Math.random() * phrases.length)];
      var acc = '';
      emit('stt', { text: '', final: false });
      var i = 0;
      var timer = setInterval(function () {
        acc += text[i++];
        emit('stt', { text: acc, final: false });
        if (i >= text.length) {
          clearInterval(timer);
          emit('stt', { text: text, final: true });
        }
      }, 90);
      return j({ ok: true });
    },
    stopListening: function () { return j({ ok: true }); },
    keepAwake: function (on) { state.keepAwake = !!on; return j({ ok: true }); },
    /* 浏览器里没有 Download 目录，假装导出成功，便于验证按钮链路 */
    exportDiagnostics: function () {
      log('mock: 导出诊断（浏览器模式下不会真的写文件）');
      return j({ ok: true, path: 'Download/fy-diagnostics.txt (mock)' });
    },
    log: function (msg) { log(msg); },
    /* 浏览器里没有文件选择器和 Download 目录：按钮链路照走，结果假装一下 */
    pickCharacterCard: function () {
      log('mock: 打开角色卡选择器（浏览器模式没有真文件选择器）');
      return j({ ok: true, message: '模拟环境' });
    },
    /* 浏览器预览模式没有原生 SQLite：如实报告不可用，让存储层自动跳过这个后端 */
    dbLoadAll: function () { return j({ ok: false, message: '浏览器模式没有 SQLite' }); },
    dbApply: function () { return j({ ok: false, message: '浏览器模式没有 SQLite' }); },
    dbSearch: function () { return '[]'; },
    dbStats: function () { return j({ ok: true, rows: 0, bytes: 0 }); },
    dbWipe: function () { return j({ ok: false, message: '浏览器模式没有 SQLite' }); },
    pickBackupFile: function () {
      log('mock: 打开备份选择器（浏览器模式没有真文件选择器）');
      return j({ ok: true, message: '模拟环境' });
    },
    saveBackup: function (name, json) {
      log('mock: 导出备份 ' + name + '（' + String(json || '').length + ' 字节）');
      return j({ ok: true, path: 'Download/' + name + ' (mock)' });
    },
    saveCharacterCard: function (name, json) {
      log('mock: 导出角色卡 ' + name + '（' + String(json || '').length + ' 字节，浏览器模式不落盘）');
      return j({ ok: true, path: 'Download/' + name + ' (mock)' });
    }
  };
  global.FY = FY;
  log('已注入假原生桥 window.FY');

  /* ===========================================================================
   * 4. 假的流式推理：劫持 fetch → /v1/chat/completions
   * ======================================================================== */

  /** 从消息数组里挑出「本轮发言的角色」的上下文 */
  function pickContext(messages) {
    var sys = '';
    var userCount = 0;
    var lastUser = '';
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === 'system') sys += m.content + '\n';
      if (m.role === 'user') { userCount++; lastUser = m.content; }
    }
    /* 尝试从 system prompt 里抓 "你现在扮演：XXX" / "角色名：" 之类的线索 */
    var name = '角色';
    var mm = sys.match(/【当前发言角色】\s*([^\n（(]+)/) || sys.match(/你现在扮演[：:]\s*([^\n，,。（(]+)/) || sys.match(/你是「?([^」\n，,。（(]{1,12})」?/);
    if (mm && mm[1]) name = mm[1].trim();
    var opts = /<<<OPTIONS/.test(sys) || /选项/.test(sys);
    return { sys: sys, name: name, userCount: userCount, lastUser: lastUser, wantOptions: opts };
  }

  /** 组装一段假的回复（含思考过程，模拟 Qwen3 的  thinking 段） */
  function buildReply(ctx) {
    var think = '（mock 思考）用户说：「' + String(ctx.lastUser).slice(0, 40) + '」。' +
      '我作为' + ctx.name + '，应该先接住情绪，再给一点具体的画面感，最后留一个话头。';
    var lines = [
      '（' + ctx.name + '侧过脸来，指尖在桌面上轻轻点了一下。）',
      '“你说的这个，我记下了。”',
      '第 ' + Math.max(1, ctx.userCount) + ' 轮了，可我还是想听你再多说一点——' + String(ctx.lastUser).slice(0, 24) + '…那后来呢？',
      '',
      '（这是 mock.js 生成的假回复，真机上会由本地 llama-server 流式输出。）'
    ];
    var body = lines.join('\n');
    if (ctx.wantOptions) {
      body += '\n<<<OPTIONS\n1. 继续追问下去\n2. 换个轻松的话题\n3. 沉默地看着对方\nOPTIONS>>>';
    }
    return { think: think, body: body };
  }

  /* Qwen3 的思考段标记。用常量拼出来，避免被脚本/工具改坏（历史上这里丢过一个 '<'）。 */
  var THINK_OPEN = '<' + 'think>';
  var THINK_CLOSE = '<' + '｜end▁of▁thinking｜>';

  /** 把字符串切成小块，模拟逐字流式输出 */
  function chunkText(s) {
    var out = [];
    var i = 0;
    while (i < s.length) {
      var n = 1 + Math.floor(Math.random() * 3);
      out.push(s.slice(i, i + n));
      i += n;
    }
    return out;
  }

  /* 真正的 Response 需要把流塞进 body，这里单独构造一次 */
  function streamResponse(bodyObj, signal) {
    var ctx = pickContext(bodyObj.messages || []);
    var reply = buildReply(ctx);
    var enc = new global.TextEncoder();
    var pieces = chunkText(THINK_OPEN + reply.think + THINK_CLOSE).concat(chunkText(reply.body));
    var idx = 0;
    var aborted = false;
    if (signal) signal.addEventListener('abort', function () { aborted = true; });

    var stream = new global.ReadableStream({
      pull: function (controller) {
        return new Promise(function (done) {
          setTimeout(function () {
            if (aborted) { try { controller.close(); } catch (e) {} done(); return; }
            if (idx >= pieces.length) {
              try {
                controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'));
                controller.close();
              } catch (e) {}
              done();
              return;
            }
            var frame = 'data: ' + JSON.stringify({
              id: 'mock-chatcmpl', object: 'chat.completion.chunk', model: 'mock',
              choices: [{ index: 0, delta: { content: pieces[idx++] }, finish_reason: null }]
            }) + '\n\n';
            try { controller.enqueue(enc.encode(frame)); } catch (e) {}
            done();
          }, 12 + Math.random() * 26);
        });
      }
    });

    return new global.Response(stream, {
      status: 200,
      headers: new global.Headers({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    });
  }

  /**
   * 非流式响应（stream:false）。
   * app.js 里的记忆压缩（compressMemory → postJson）走的就是这条路，
   * 它要求返回一个正常的 application/json 体，绝对不能再吐 SSE。
   */
  function jsonResponse(bodyObj) {
    var ctx = pickContext(bodyObj.messages || []);
    var content = '（mock 摘要）' + ctx.name + '与用户已经聊了 ' + Math.max(1, ctx.userCount) + ' 轮。' +
      '用户最近提到：「' + String(ctx.lastUser).slice(0, 30) + '」。' +
      '双方关系逐渐熟悉，语气也越来越放松。';
    var payload = {
      id: 'mock-chatcmpl',
      object: 'chat.completion',
      model: 'mock',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: content },
        finish_reason: 'stop'
      }]
    };
    return new global.Response(JSON.stringify(payload), {
      status: 200,
      headers: new global.Headers({ 'content-type': 'application/json; charset=utf-8' })
    });
  }

  var realFetch = global.fetch ? global.fetch.bind(global) : null;

  global.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var isLocal = /127\.0\.0\.1|localhost/.test(url) && /\/v1\/chat\/completions/.test(url);
    if (!isLocal) {
      /* 非本地推理请求：交回真 fetch（离线环境通常会失败，正常） */
      if (realFetch) return realFetch(input, init);
      return Promise.reject(new Error('mock: 无网络能力'));
    }
    if (state.status !== 'ready') {
      return Promise.reject(new Error('mock: 引擎未就绪（state=' + state.status + '），请先在设置里启动引擎'));
    }
    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) {}
    var signal = init && init.signal;
    var streaming = body.stream !== false;
    log('拦截推理请求', url, '模型=' + state.model, 'stream=' + streaming);
    return new Promise(function (resolve) {
      /* 首字延迟，模拟真实 prefill */
      setTimeout(function () {
        resolve(streaming ? streamResponse(body, signal) : jsonResponse(body));
      }, 260);
    });
  };
  log('已劫持 fetch：http://127.0.0.1:<port>/v1/chat/completions → 假流式回复');

  /* 首屏给一条引擎日志，方便调试面板不空着 */
  later(1200, function () {
    emit('log', { line: 'mock: 桥与推理已就绪，可直接调试 UI（角色/记忆/剧情/群聊等功能均可用）' });
  });
})(typeof window !== 'undefined' ? window : this);
