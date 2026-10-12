/* =============================================================================
 * 风月·本地版 —— store.js
 * 持久化层：IndexedDB 薄封装（Promise 风格，不引任何库）+ 数据模型 + 降级方案
 *
 * 设计要点
 *  1. 上层（app.js）只看到一组 Promise 化的小接口，不直接接触 IDB。
 *  2. 首次打开 IndexedDB 失败时（Android WebView 用 file:// 加载、隐私模式等），
 *     自动降级到 localStorage 存储引擎，业务代码完全不用改。
 *  3. 所有数据都做内存缓存，写操作先改内存再异步落盘（保证 UI 永不卡顿）。
 *  4. 记录 ID 使用单调递增的时间戳前缀，保证按时间排序稳定。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ===========================================================================
   * 0. 常量与工具
   * ======================================================================== */

  var DB_NAME = 'fy_local';
  var DB_VERSION = 1;
  var STORES = ['characters', 'sessions', 'messages', 'memories', 'settings', 'logs'];
  var LS_PREFIX = 'fy.datastore.v1.';
  var LS_KEYS = '__keys__';

  /** 生成单调递增 ID（时间戳前缀 + 随机后缀），保证排序稳定且不会碰撞 */
  var _seq = 0;
  function newId(prefix) {
    _seq = (_seq + 1) % 100000;
    var t = Date.now().toString(36);
    var r = Math.random().toString(36).slice(2, 7);
    var s = _seq.toString(36);
    return (prefix ? prefix + '_' : '') + t + s + r;
  }

  function now() { return Date.now(); }

  /** 单调递增时间戳：同一毫秒内连续写入也不会相等（保证消息顺序稳定） */
  var _lastTs = 0;
  function nextTs() {
    var t = Date.now();
    if (t <= _lastTs) t = _lastTs + 1;
    _lastTs = t;
    return t;
  }

  function toStr(v, dflt) {
    if (v === null || v === undefined) return dflt === undefined ? '' : dflt;
    return typeof v === 'string' ? v : String(v);
  }

  function toNum(v, dflt) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : dflt;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * 深拷贝。以前是 JSON.parse(JSON.stringify(o)) —— 对"一个会话 2000 条消息"这种
   * 场景要序列化再反序列化两遍，实测 listMessages 一次 12ms（每次切会话都会走）。
   * 我们存的全是纯 JSON 形状的数据（对象/数组/字符串/数字/布尔/null），
   * 手写递归就够用且快得多，行为等价。
   */
  function copy(o) {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) {
      var arr = new Array(o.length);
      for (var i = 0; i < o.length; i++) arr[i] = copy(o[i]);
      return arr;
    }
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = copy(o[k]);
    return out;
  }

  /** 粗略 token 估算：中文 1 字≈1 token，英文约 4 字符≈1 token */
  /* ------------------------------------------------------------------
   * token 估算（带自校正）
   *
   * 这个估算只用来"裁剪历史"，但估不准的代价很实在：
   *   估多了 → 白截掉本该带上的上下文；
   *   估少了 → 请求超长，只能靠引擎的 --context-shift 硬截，剧情会断层。
   * 好消息是引擎每次都会回传 timings.prompt_n（真实 prompt token 数），
   * 那就拿它反过来校正换算系数（按模型分别记住），越用越准。
   * ------------------------------------------------------------------ */
  var TOKEN_FACTOR_KEY = 'fy.tokenFactor.';
  var tokenFactor = 1;
  var tokenFactorModel = '';

  function setTokenModel(name) {
    var m = toStr(name) || '(default)';
    if (m === tokenFactorModel) return tokenFactor;
    tokenFactorModel = m;
    var v = 1;
    try { v = Number(global.localStorage.getItem(TOKEN_FACTOR_KEY + m)); } catch (e) {}
    tokenFactor = (v && isFinite(v)) ? Math.max(0.4, Math.min(3, v)) : 1;
    return tokenFactor;
  }

  /** 用引擎回报的真实 token 数校正估算。返回新的系数。 */
  function calibrateTokens(actual, estimated) {
    if (!actual || !estimated || actual <= 0 || estimated <= 0) return tokenFactor;
    var ratio = Math.max(0.4, Math.min(3, actual / estimated));
    /* 指数平滑：单次异常（比如缓存命中导致 prompt_n 变小）不该把系数带跑 */
    tokenFactor = Math.max(0.4, Math.min(3, tokenFactor * 0.7 + ratio * 0.3));
    try { global.localStorage.setItem(TOKEN_FACTOR_KEY + tokenFactorModel, String(tokenFactor)); } catch (e) {}
    return tokenFactor;
  }

  function getTokenFactor() { return tokenFactor; }

  function estimateTokens(text) {
    var s = toStr(text);
    if (!s) return 0;
    var cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    var rest = s.length - cjk;
    return Math.ceil((cjk + rest / 3.2) * tokenFactor);
  }

  /* ===========================================================================
   * 1. 存储引擎 A：IndexedDB（Promise 薄封装）
   * ======================================================================== */

  var _dbPromise = null;

  function idbOpen() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      var req;
      try {
        if (!global.indexedDB) throw new Error('indexedDB 不存在');
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains('characters')) db.createObjectStore('characters', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sessions')) {
          var ss = db.createObjectStore('sessions', { keyPath: 'id' });
          ss.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('messages')) {
          var ms = db.createObjectStore('messages', { keyPath: 'id' });
          ms.createIndex('sessionId', 'sessionId');
        }
        if (!db.objectStoreNames.contains('memories')) {
          var me = db.createObjectStore('memories', { keyPath: 'id' });
          me.createIndex('sessionId', 'sessionId');
        }
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('logs')) {
          var lg = db.createObjectStore('logs', { keyPath: 'id' });
          lg.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = function (ev) {
        var db = ev.target.result;
        db.onversionchange = function () { try { db.close(); } catch (e) {} };
        resolve(db);
      };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
      req.onblocked = function () { reject(new Error('IndexedDB 被其它页面占用')); };
      /* 某些 WebView 在权限被拒时既不 success 也不 error，加个兜底超时 */
      setTimeout(function () { reject(new Error('IndexedDB 打开超时')); }, 4000);
    }).catch(function (e) {
      _dbPromise = null;   // 允许后续重试
      throw e;
    });
    return _dbPromise;
  }

  function idbRun(storeName, mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx, store, req;
        try {
          tx = db.transaction(storeName, mode);
          store = tx.objectStore(storeName);
          req = fn(store);
        } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(req && req.result); };
        tx.onerror = function () { reject(tx.error || new Error('事务失败')); };
        tx.onabort = function () { reject(tx.error || new Error('事务中止')); };
      });
    });
  }

  function idbGetAll(storeName) {
    return idbRun(storeName, 'readonly', function (s) { return s.getAll(); });
  }

  function idbPutAll(storeName, records, clearFirst) {
    return idbRun(storeName, 'readwrite', function (s) {
      if (clearFirst) s.clear();
      for (var i = 0; i < records.length; i++) s.put(records[i]);
      return null;
    });
  }

  /** 内存里的 settings 是 {key: value}，表里存的是 {key, value} 记录 */
  function settingsToRecords(obj) {
    var out = [];
    var s = obj || {};
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) out.push({ key: k, value: s[k] });
    return out;
  }

  function idbCacheAll(records) {
    /* 全量写回。现在是"增量落盘失败后的兜底"，正常路径不会再走到这里。
       注意 settings 的坑：内存里它是 {key:value} 对象，而表里是 {key,value} 记录。
       老代码把对象直接交给 idbPutAll，`records.length` 是 undefined → 循环一次都不执行，
       于是每次保存都把设置表清空，重启后所有设置悄悄回到默认值。 */
    var META = ['characters', 'sessions', 'memories'];
    return Promise.all(META.map(function (n) {
      return idbPutAll(n, records[n] || [], true);
    })).then(function () {
      return idbPutAll('settings', settingsToRecords(records.settings), true);
    }).then(function () {
      return idbPutAll('messages', records.messages || [], true);
    }).then(function () {
      return idbPutAll('logs', (records.logs || []).slice(-200), true);
    });
  }

  function idbLoadAll() {
    var out = {};
    /* 先用一次真实的 open 探活：失败就让 Promise 直接 reject，交给上层降级。
       注意不能把每个 store 的失败都吞掉，否则 IndexedDB 整体不可用时不会触发降级。 */
    return idbOpen().then(function () {
      return STORES.reduce(function (p, name) {
        return p.then(function () {
          return idbGetAll(name).then(function (rows) {
            if (name === 'settings') {
              var m = {};
              (rows || []).forEach(function (r) { m[r.key] = r.value; });
              out[name] = m;
            } else {
              out[name] = rows || [];
            }
          });
        });
      }, Promise.resolve()).then(function () { return out; });
    });
  }

  /* ===========================================================================
   * 2. 存储引擎 B：localStorage（降级用，接口与 A 完全一致）
   * ======================================================================== */

  function lsKey(name) { return LS_PREFIX + name; }
  function lsLoadRaw(name) {
    try {
      var s = global.localStorage.getItem(lsKey(name));
      if (!s) return null;
      return JSON.parse(s);
    } catch (e) { return null; }
  }
  function lsSaveRaw(name, value) {
    try {
      global.localStorage.setItem(lsKey(name), JSON.stringify(value));
      return true;
    } catch (e) {
      /* 配额爆掉时清掉消息历史再试一次（尽量保住角色卡与设置） */
      try {
        global.localStorage.removeItem(lsKey('messages'));
        global.localStorage.setItem(lsKey(name), JSON.stringify(value));
        return true;
      } catch (e2) { return false; }
    }
  }

  function lsCacheAll(records) {
    STORES.forEach(function (n) {
      lsSaveRaw(n, n === 'settings' ? (records.settings || {}) : (records[n] || []));
    });
    lsSaveRaw(LS_KEYS, STORES.slice());
    return Promise.resolve(true);
  }

  function lsLoadAll() {
    var out = {};
    STORES.forEach(function (n) {
      var v = lsLoadRaw(n);
      if (n === 'settings') out[n] = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      else out[n] = Array.isArray(v) ? v : [];
    });
    return Promise.resolve(out);
  }

  /* ===========================================================================
   * 3. 数据模型工厂
   * ======================================================================== */

  /* ===========================================================================
   * 1b. 存储后端：多后端可插拔
   *
   * 统一接口（三个方法）：
   *   loadAll()        → Promise<{characters:[],…,settings:{}}>
   *   apply(ops)       → Promise<void>
   *                      ops = { clears:[表名], puts:{表名:[记录]}, dels:{表名:[id]} }
   *   search(q, limit) → Promise<[消息]|null>   （null = 这个后端不支持检索）
   *
   * 四个后端：
   *   indexeddb    默认。WebView 自带，零依赖，实测 5000 条消息冷启动 74ms。
   *   sqlite       原生 SQLite（实验性，需在设置里手动切换）。事务 + 不受浏览器配额影响，
   *                且能上 LIKE/FTS 检索；走"文档表"（id + doc JSON），不做关系式拆分。
   *   localstorage 兜底（IndexedDB 坏掉时）。
   *   memory       纯内存（浏览器预览 / 测试用）。
   * ======================================================================== */

  var BACKEND_KEY = 'fy.backend';

  var IndexedDbBackend = {
    name: 'indexeddb',
    loadAll: function () { return idbLoadAll(); },
    apply: function (ops) {
      var names = {};
      var i;
      for (i = 0; i < (ops.clears || []).length; i++) names[ops.clears[i]] = 1;
      for (var a in (ops.puts || {})) names[a] = 1;
      for (var b in (ops.dels || {})) names[b] = 1;
      var clears = ops.clears || [];
      return Object.keys(names).reduce(function (p, name) {
        return p.then(function () {
          return idbRun(name, 'readwrite', function (s) {
            if (clears.indexOf(name) >= 0) s.clear();
            var rows = (ops.puts || {})[name] || [];
            for (var k = 0; k < rows.length; k++) s.put(rows[k]);
            var ids = (ops.dels || {})[name] || [];
            for (var j = 0; j < ids.length; j++) s.delete(ids[j]);
            return null;
          });
        });
      }, Promise.resolve(true));
    },
    search: null
  };

  var LocalStorageBackend = {
    name: 'localstorage',
    loadAll: function () { return lsLoadAll(); },
    apply: function (records) {
      /* localStorage 只能整块写，所以这里直接要"整份数据" */
      return lsCacheAll(records);
    },
    wholeData: true,
    search: null
  };

  var MemoryBackend = {
    name: 'memory',
    _data: null,
    loadAll: function () { return Promise.resolve(this._data || {}); },
    apply: function (ops) {
      var d = this._data || (this._data = {});
      var i;
      for (i = 0; i < (ops.clears || []).length; i++) d[ops.clears[i]] = (ops.clears[i] === 'settings') ? {} : [];
      for (var name in (ops.puts || {})) {
        var rows = ops.puts[name] || [];
        if (name === 'settings') {
          d.settings = d.settings || {};
          for (i = 0; i < rows.length; i++) d.settings[rows[i].key] = rows[i].value;
        } else {
          var list = d[name] || (d[name] = []);
          for (i = 0; i < rows.length; i++) {
            var at = -1;
            for (var k = 0; k < list.length; k++) if (list[k].id === rows[i].id) { at = k; break; }
            if (at >= 0) list[at] = rows[i]; else list.push(rows[i]);
          }
        }
      }
      for (var name2 in (ops.dels || {})) {
        var ids = ops.dels[name2] || [];
        if (name2 === 'settings') {
          for (i = 0; i < ids.length; i++) delete (d.settings || {})[ids[i]];
        } else {
          d[name2] = (d[name2] || []).filter(function (r) { return ids.indexOf(r.id) < 0; });
        }
      }
      return Promise.resolve(true);
    },
    search: null
  };

  var SqliteBackend = {
    name: 'sqlite',
    available: function () {
      return !!(global.FY && typeof global.FY.dbLoadAll === 'function'
        && typeof global.FY.dbApply === 'function');
    },
    loadAll: function () {
      var raw = global.FY.dbLoadAll();
      var o = raw ? JSON.parse(raw) : null;
      if (!o || o.ok === false) throw new Error((o && o.message) || 'SQLite 读取失败');
      return Promise.resolve(o);
    },
    apply: function (ops) {
      var raw = global.FY.dbApply(JSON.stringify(ops));
      var r = raw ? JSON.parse(raw) : null;
      if (!r || r.ok !== true) throw new Error((r && r.message) || 'SQLite 写入失败');
      return Promise.resolve(true);
    },
    search: function (q, limit) {
      try {
        if (!(global.FY && typeof global.FY.dbSearch === 'function')) return Promise.resolve(null);
        return Promise.resolve(JSON.parse(global.FY.dbSearch(q, limit) || '[]'));
      } catch (e) { return Promise.resolve(null); }
    }
  };

  var BACKENDS = {
    indexeddb: IndexedDbBackend,
    sqlite: SqliteBackend,
    localstorage: LocalStorageBackend,
    memory: MemoryBackend
  };

  function preferredBackend() {
    try { return global.localStorage.getItem(BACKEND_KEY) || ''; } catch (e) { return ''; }
  }
  function rememberBackend(name) {
    try { global.localStorage.setItem(BACKEND_KEY, name); } catch (e) {}
  }

  var DEFAULT_SYSTEM_PROMPT =
    '你要扮演一个鲜活的角色，与用户进行自然、沉浸式的对话。' +
    '始终保持人设，不要跳出角色，不要以 AI 的口吻解释自己。' +
    '用简洁口语化的中文回复，通常 1~3 句话，必要时可以描写动作与神态（用括号）。\n/no_think';

  function makeCharacter(patch) {
    var p = patch || {};
    var t = now();
    return {
      id: p.id || newId('ch'),
      name: toStr(p.name, '无名角色').slice(0, 24) || '无名角色',
      avatar: toStr(p.avatar, '🙂').slice(0, 8) || '🙂',
      tagline: toStr(p.tagline, '').slice(0, 60),
      persona: toStr(p.persona, ''),
      greeting: toStr(p.greeting, ''),
      examples: toStr(p.examples, ''),
      systemPrompt: toStr(p.systemPrompt, '') || DEFAULT_SYSTEM_PROMPT,
      temperature: clamp(toNum(p.temperature, 0.85), 0, 2),
      /* 分类与类型：
         tags  —— 分类标签（角色页用来筛选；chara_card_v2 的标准字段）
         kind  —— character=角色卡 / story=剧情卡（剧情卡自带世界观，开局就进剧情模式）
         plot  —— 打开这个角色的会话时是否默认开启剧情模式 */
      tags: Array.isArray(p.tags) ? p.tags.filter(function (x) { return typeof x === 'string' && x; }).slice(0, 6) : [],
      kind: (p.kind === 'story') ? 'story' : 'character',
      plot: !!p.plot,
      createdAt: toNum(p.createdAt, t),
      updatedAt: toNum(p.updatedAt, t),
      builtin: !!p.builtin
    };
  }

  function makeSession(patch) {
    var p = patch || {};
    var t = now();
    return {
      id: p.id || newId('se'),
      title: toStr(p.title, '新的对话').slice(0, 40) || '新的对话',
      characterIds: Array.isArray(p.characterIds) ? p.characterIds.slice() : [],
      mode: p.mode === 'group' ? 'group' : 'solo',   // solo 单聊 / group 群聊
      plot: !!p.plot,                                // 是否开启剧情选项模式
      speakerIndex: toNum(p.speakerIndex, 0),        // 群聊轮转指针
      lastSpeakerId: toStr(p.lastSpeakerId, ''),
      createdAt: toNum(p.createdAt, t),
      updatedAt: toNum(p.updatedAt, t),
      lastMessage: toStr(p.lastMessage, '').slice(0, 80)
    };
  }

  function makeMessage(patch) {
    var p = patch || {};
    return {
      id: p.id || newId('ms'),
      sessionId: toStr(p.sessionId, ''),
      role: p.role === 'assistant' ? 'assistant' : (p.role === 'system' ? 'system' : 'user'),
      content: toStr(p.content, ''),
      thinking: toStr(p.thinking, ''),
      characterId: toStr(p.characterId, ''),
      speakerName: toStr(p.speakerName, ''),
      speakerAvatar: toStr(p.speakerAvatar, ''),
      options: Array.isArray(p.options) ? p.options.map(function (o) { return toStr(o); }) : [],
      ts: toNum(p.ts, nextTs()),
      error: !!p.error,
      aborted: !!p.aborted
    };
  }

  function makeMemory(patch) {
    var p = patch || {};
    var t = now();
    return {
      id: p.id || newId('me'),
      sessionId: toStr(p.sessionId, ''),
      characterId: toStr(p.characterId, ''),
      text: toStr(p.text, ''),
      covered: toNum(p.covered, 0),   // 已压缩吸收的消息条数
      createdAt: toNum(p.createdAt, t),
      updatedAt: toNum(p.updatedAt, t)
    };
  }

  var DEFAULT_SETTINGS = {
    model: '',
    ctx: 4096,
    threads: 0,          // 0 = 自动（原生层按核数算，实测 8 核上 6 线程最快）
    gpuLayers: 0,
    temperature: 0.85,
    topP: 0.9,
    maxTokens: 512,
    historyLimit: 20,    // 送入模型的最大历史条数
    memoryThreshold: 20, // 超过多少条消息触发记忆压缩
    memoryEnabled: true,
    autoRead: false,     // 自动朗读 AI 回复
    plotDefault: false,  // 新会话默认开启剧情模式
    /* 默认【关掉】思考模式。Qwen3 默认先吐一大段思考，实测有两个糟糕后果：
       1) max_tokens 被思考段吃光，主气泡几乎没有正文，看起来像"没回复"；
       2) 生成慢好几倍（思考 token 也算生成时间）。
       想看思考过程的人可以在设置里打开「显示思考过程」折叠区。 */
    showThinking: false,
    /* mlock：把模型锁在内存里，避免推理时权重被换出。
       实测同一台机器跑 3B：默认 mmap 只有 3.6~4.7 tok/s，开了 mlock 是 8.4~9.2 tok/s（约 2 倍）。
       代价是内存占用变硬；内存特别小的机器可以关掉（加载失败时原生层会自动回退到 mmap）。 */
    mlock: true,
    /* 屏幕常亮策略：
       auto   = 生成期间不熄屏（默认；切到后台也靠 CPU 唤醒锁把这一轮跑完）
       always = 只要 App 在前台就一直不熄屏（慢慢看长回复、慢慢打字都不黑屏）
       off    = 什么都不保持，最省电 */
    keepScreen: 'auto',
    speakerMode: 'round',// round 顺序 / random 随机
    ttsRate: 1,
    theme: '#7c5cff',
    appearance: 'dark',      /* dark | light | auto（跟随系统） */
    bgPattern: true,         /* 背景图案（星野/点阵）开关 */
    lastModel: ''
  };

  function makeSettings(patch) {
    var out = {};
    for (var k in DEFAULT_SETTINGS) if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) out[k] = DEFAULT_SETTINGS[k];
    if (patch && typeof patch === 'object') {
      for (var k2 in patch) if (Object.prototype.hasOwnProperty.call(patch, k2)) out[k2] = patch[k2];
    }
    return out;
  }

  /* ===========================================================================
   * 4. Store：内存缓存 + 落盘 + 业务小接口
   * ======================================================================== */

  function createStore(engine, initial) {
    var data = {
      characters: initial.characters || [],
      sessions: initial.sessions || [],
      messages: initial.messages || [],
      memories: initial.memories || [],
      settings: makeSettings(initial.settings || {}),
      logs: initial.logs || []
    };
    var LS_ACTIVE = 'fy.activeSession';
    var saveTimer = null;
    var lastError = null;
    var writeCount = 0;
    var backend = engine;   // 落盘后端：indexeddb 或 localstorage（初始化时已确定，不再反复重试）

    /* ------------------------------------------------------------------
     * 内存索引 + 增量落盘
     *
     * 老实现有两个 O(N)（N = 消息总数）的坑，聊得越久越明显：
     *   1) persist() → idbCacheAll(data)：清空所有表再全量写回，
     *      于是"每加一条消息"都要把整张消息表重写一遍；
     *   2) listMessages / countMessages / lastMessage / updateMessage
     *      都遍历整张 messages 表 —— 而 updateMessage 每条回复结束都要跑一次。
     * 现在：按 sessionId 建索引、按 id 建哈希（查询降到 O(1)/O(会话长度)），
     *      落盘只写脏记录（降到 O(改动的记录数)）。
     * ------------------------------------------------------------------ */
    var msgIndex = {};      // sessionId -> [message]
    var msgById = {};       // id -> message
    var dirtyPut = {};      // storeName -> { id: true }
    var dirtyDel = {};      // storeName -> { id: true }
    var dirtyFull = {};     // storeName -> true（settings / logs 这种小表，整表重写更省事）

    function indexMessages() {
      msgIndex = {}; msgById = {};
      for (var i = 0; i < data.messages.length; i++) {
        var m = data.messages[i];
        msgById[m.id] = m;
        (msgIndex[m.sessionId] = msgIndex[m.sessionId] || []).push(m);
      }
      /* 索引里保持按时间有序：这样 listMessages 不用每次排序（消息是追加式的，
         排一次以后新消息基本都接在尾巴上）。 */
      for (var sid in msgIndex) {
        msgIndex[sid].sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      }
    }

    /** 把消息按 ts 插到有序索引里（绝大多数情况直接 push 到末尾） */
    function indexInsert(m) {
      var arr = msgIndex[m.sessionId] || (msgIndex[m.sessionId] = []);
      var n = arr.length;
      if (!n || (m.ts || 0) >= (arr[n - 1].ts || 0)) { arr.push(m); return; }
      var lo = 0, hi = n;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if ((arr[mid].ts || 0) <= (m.ts || 0)) lo = mid + 1; else hi = mid;
      }
      arr.splice(lo, 0, m);
    }
    function markPut(store, id) {
      (dirtyPut[store] = dirtyPut[store] || {})[id] = true;
      if (dirtyDel[store]) delete dirtyDel[store][id];
    }
    function markDel(store, id) {
      (dirtyDel[store] = dirtyDel[store] || {})[id] = true;
      if (dirtyPut[store]) delete dirtyPut[store][id];
    }

    indexMessages();   // 启动时建一次索引，之后增删改都同步维护

    function storeRecords(name) {
      if (name === 'settings') return settingsToRecords(data.settings);
      if (name === 'logs') return data.logs.slice(-200);
      return data[name] || [];
    }
    function recordById(name, id) {
      if (name === 'messages') return msgById[id] || null;
      var arr = data[name] || [];
      for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
      return null;
    }

    /** 把这一轮攒下的脏标记翻译成后端能懂的 ops（记录在 flush 时才取，取到的是最新值） */
    function takeOps() {
      var clears = [], puts = {}, dels = {}, k, id;
      for (k in dirtyFull) clears.push(k);
      for (k in dirtyPut) {
        puts[k] = puts[k] || [];
        for (id in dirtyPut[k]) {
          var rec = recordById(k, id);
          if (rec) puts[k].push(rec);
        }
      }
      for (k in dirtyDel) {
        dels[k] = dels[k] || [];
        for (id in dirtyDel[k]) dels[k].push(id);
      }
      /* 整表重写的表（settings/logs）要把"全部记录"一起带上 */
      for (var c = 0; c < clears.length; c++) puts[clears[c]] = storeRecords(clears[c]);
      dirtyPut = {}; dirtyDel = {}; dirtyFull = {};
      if (!clears.length && !Object.keys(puts).length && !Object.keys(dels).length) return null;
      return { clears: clears, puts: puts, dels: dels };
    }

    function persist() {
      var be = BACKENDS[backend] || IndexedDbBackend;
      if (be.wholeData) {   // localStorage：只能整份写
        writeCount++;
        be.apply(data).catch(function (e) { lastError = String(e && e.message || e); });
        return;
      }
      var ops = takeOps();
      if (!ops) return;
      writeCount++;
      be.apply(ops).catch(function (e) {
        /* 后端中途坏掉：退回 localStorage，保证数据不丢（整库落盘） */
        lastError = String(e && e.message || e);
        backend = 'localstorage';
        rememberBackend('localstorage');
        lsCacheAll(data).catch(function () {});
      });
    }

    function save() {
      if (saveTimer) return;
      saveTimer = setTimeout(function () {
        saveTimer = null;
        persist();
      }, 120);
    }

    function byId(list, id) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    }
    function indexOfId(list, id) {
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return i;
      return -1;
    }

    /* ---------------- 设置 ---------------- */
    function getSettings() { return data.settings; }
    function saveSettings(patch) {
      if (patch && typeof patch === 'object') {
        for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) data.settings[k] = patch[k];
      }
      dirtyFull.settings = true;   // 设置表很小，整表重写更省事
      save();
      return data.settings;
    }

    /* ---------------- 角色卡 ---------------- */
    function listCharacters() {
      return data.characters.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    }
    function getCharacter(id) {
      var c = byId(data.characters, id);
      return c ? copy(c) : null;
    }
    function saveCharacter(patch) {
      var c = makeCharacter(patch);
      var i = indexOfId(data.characters, c.id);
      if (i >= 0) {
        c.createdAt = data.characters[i].createdAt || c.createdAt;
        c.builtin = c.builtin || data.characters[i].builtin;
        c.updatedAt = now();
        data.characters[i] = c;
      } else {
        data.characters.push(c);
      }
      /* 角色改名后，同步已有消息上的显示名（只重写受影响的消息） */
      data.messages.forEach(function (m) {
        if (m.characterId === c.id) {
          m.speakerName = c.name;
          m.speakerAvatar = c.avatar;
          markPut('messages', m.id);
        }
      });
      markPut('characters', c.id);
      save();
      return copy(c);
    }
    function deleteCharacter(id) {
      var i = indexOfId(data.characters, id);
      if (i >= 0) data.characters.splice(i, 1);
      markDel('characters', id);
      /* 从会话里摘掉；会话空了就整体删除 */
      var dead = [];
      data.sessions.forEach(function (s) {
        var k = s.characterIds.indexOf(id);
        if (k >= 0) { s.characterIds.splice(k, 1); markPut('sessions', s.id); }
        if (s.characterIds.length === 0) dead.push(s.id);
      });
      dead.forEach(function (sid) { deleteSession(sid, true); });
      save();
      return true;
    }
    function characterCount() { return data.characters.length; }

    /* ---------------- 会话 ---------------- */
    function listSessions() {
      return data.sessions.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    }
    function getSession(id) {
      var s = byId(data.sessions, id);
      return s ? copy(s) : null;
    }
    function saveSession(patch) {
      var s = makeSession(patch);
      var i = indexOfId(data.sessions, s.id);
      if (i >= 0) {
        s.createdAt = data.sessions[i].createdAt || s.createdAt;
        s.updatedAt = now();
        data.sessions[i] = s;
      } else {
        data.sessions.push(s);
      }
      markPut('sessions', s.id);
      save();
      return copy(s);
    }
    function deleteSession(id, keepQuiet) {
      var i = indexOfId(data.sessions, id);
      if (i >= 0) data.sessions.splice(i, 1);
      markDel('sessions', id);
      /* 级联删掉这个会话的消息与记忆：按索引取，别全表扫 */
      var arr = msgIndex[id] || [];
      for (var k = 0; k < arr.length; k++) { delete msgById[arr[k].id]; markDel('messages', arr[k].id); }
      delete msgIndex[id];
      data.messages = data.messages.filter(function (m) { return m.sessionId !== id; });
      data.memories.filter(function (m) { return m.sessionId === id; }).forEach(function (m) { markDel('memories', m.id); });
      data.memories = data.memories.filter(function (m) { return m.sessionId !== id; });
      if (!keepQuiet && getActiveSessionId() === id) setActiveSessionId('');
      save();
      return true;
    }
    function getActiveSessionId() {
      try { return global.localStorage.getItem(LS_ACTIVE) || ''; } catch (e) { return ''; }
    }
    function setActiveSessionId(id) {
      try {
        if (id) global.localStorage.setItem(LS_ACTIVE, id);
        else global.localStorage.removeItem(LS_ACTIVE);
      } catch (e) {}
    }

    /* ---------------- 消息 ----------------
       全部走内存索引：msgIndex[sessionId] 只装这个会话的消息，
       msgById 让"按 id 改一条"从 O(N) 降到 O(1)。 */
    function listMessages(sessionId) {
      /* 索引本身就按时间有序（见 indexMessages / indexInsert），这里不需要再排序 */
      var arr = msgIndex[sessionId] || [];
      var out = new Array(arr.length);
      for (var i = 0; i < arr.length; i++) out[i] = copy(arr[i]);
      return out;
    }
    function countMessages(sessionId) {
      return (msgIndex[sessionId] || []).length;
    }
    function lastMessage(sessionId) {
      var arr = msgIndex[sessionId] || [];
      if (!arr.length) return null;
      var last = arr[0];
      for (var i = 1; i < arr.length; i++) if ((arr[i].ts || 0) >= (last.ts || 0)) last = arr[i];
      return copy(last);
    }
    function addMessage(patch) {
      var m = makeMessage(patch);
      data.messages.push(m);
      msgById[m.id] = m;
      indexInsert(m);
      var s = byId(data.sessions, m.sessionId);
      if (s) {
        s.updatedAt = now();
        s.lastMessage = m.content.slice(0, 80);
        if (m.characterId) s.lastSpeakerId = m.characterId;
        markPut('sessions', s.id);
      }
      markPut('messages', m.id);
      save();
      return copy(m);
    }
    function updateMessage(patch) {
      var cur = msgById[patch.id];
      if (!cur) return null;
      var merged = makeMessage({
        id: cur.id, sessionId: cur.sessionId, role: cur.role, ts: cur.ts,
        content: patch.content === undefined ? cur.content : patch.content,
        thinking: patch.thinking === undefined ? cur.thinking : patch.thinking,
        characterId: cur.characterId, speakerName: cur.speakerName, speakerAvatar: cur.speakerAvatar,
        options: patch.options === undefined ? cur.options : patch.options,
        error: patch.error === undefined ? cur.error : patch.error,
        aborted: patch.aborted === undefined ? cur.aborted : patch.aborted
      });
      var i = indexOfId(data.messages, merged.id);
      if (i >= 0) data.messages[i] = merged;
      msgById[merged.id] = merged;
      var arr = msgIndex[merged.sessionId] || (msgIndex[merged.sessionId] = []);
      var k = indexOfId(arr, merged.id);
      if (k >= 0) arr[k] = merged;
      var s = byId(data.sessions, merged.sessionId);
      if (s) { s.updatedAt = now(); s.lastMessage = merged.content.slice(0, 80); markPut('sessions', s.id); }
      markPut('messages', merged.id);
      save();
      return copy(merged);
    }
    function deleteMessage(id) {
      var cur = msgById[id];
      var i = indexOfId(data.messages, id);
      if (i >= 0) data.messages.splice(i, 1);
      if (cur) {
        delete msgById[id];
        var arr = msgIndex[cur.sessionId] || [];
        var k = indexOfId(arr, id);
        if (k >= 0) arr.splice(k, 1);
      }
      markDel('messages', id);
      save();
      return true;
    }
    function deleteMessagesFrom(sessionId, fromTs) {
      var arr = msgIndex[sessionId] || [];
      var gone = [];
      for (var i = 0; i < arr.length; i++) if ((arr[i].ts || 0) >= fromTs) gone.push(arr[i].id);
      for (var g = 0; g < gone.length; g++) {
        delete msgById[gone[g]];
        markDel('messages', gone[g]);
      }
      data.messages = data.messages.filter(function (m) { return gone.indexOf(m.id) < 0; });
      msgIndex[sessionId] = arr.filter(function (m) { return gone.indexOf(m.id) < 0; });
      save();
      return true;
    }

    /* ---------------- 记忆（长期记忆区，按会话/角色隔离） ---------------- */
    function listMemories(sessionId, characterId) {
      return data.memories.filter(function (m) {
        if (m.sessionId !== sessionId) return false;
        if (characterId && m.characterId && m.characterId !== characterId) return false;
        return true;
      }).sort(function (a, b) { return (a.updatedAt || 0) - (b.updatedAt || 0); }).map(copy);
    }
    function getMemory(sessionId, characterId) {
      var hit = data.memories.filter(function (m) {
        return m.sessionId === sessionId && (m.characterId || '') === (characterId || '');
      })[0];
      return hit ? copy(hit) : null;
    }
    function saveMemory(patch) {
      var m = makeMemory(patch);
      var idx = indexOfId(data.memories, m.id);
      if (idx >= 0) {
        data.memories[idx].text = m.text;
        data.memories[idx].covered = m.covered;
        data.memories[idx].updatedAt = now();
        markPut('memories', data.memories[idx].id);
      } else {
        /* 同一会话 + 同一角色只保留一条记忆，便于「压缩吸收」 */
        var exist = -1;
        for (var n = 0; n < data.memories.length; n++) {
          var x = data.memories[n];
          if (x.sessionId === m.sessionId && (x.characterId || '') === (m.characterId || '')) { exist = n; break; }
        }
        if (exist >= 0) {
          data.memories[exist].text = m.text;
          data.memories[exist].covered = m.covered;
          data.memories[exist].updatedAt = now();
          m = data.memories[exist];
        } else {
          data.memories.push(m);
        }
      }
      markPut('memories', m.id);
      save();
      return copy(m);
    }
    function clearMemory(sessionId, characterId) {
      var gone = data.memories.filter(function (m) {
        if (m.sessionId !== sessionId) return false;
        if (characterId === undefined || characterId === null || characterId === '') return true;
        return (m.characterId || '') === characterId;
      });
      for (var i = 0; i < gone.length; i++) markDel('memories', gone[i].id);
      data.memories = data.memories.filter(function (m) {
        if (m.sessionId !== sessionId) return true;
        if (characterId === undefined || characterId === null || characterId === '') return false;
        return (m.characterId || '') !== characterId;
      });
      save();
      return true;
    }

    /* ---------------- 日志（调试面板，最多 200 行） ---------------- */
    function addLog(line) {
      data.logs.push({ id: newId('lg'), ts: now(), line: toStr(line).slice(0, 2000) });
      if (data.logs.length > 200) data.logs = data.logs.slice(-200);
      dirtyFull.logs = true;
      save();
      return true;
    }
    function listLogs() { return data.logs.slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); }); }
    function clearLogs() { data.logs = []; dirtyFull.logs = true; save(); return true; }

    /* ---------------- 维护 ---------------- */
    function stats() {
      return {
        engine: engine,
        characters: data.characters.length,
        sessions: data.sessions.length,
        messages: data.messages.length,
        memories: data.memories.length,
        logs: data.logs.length,
        writes: writeCount,
        lastError: lastError
      };
    }
    /* ---------------- 整库备份 / 恢复 ----------------
       为什么需要：换签名重装、换机、或者只是想留个底 —— 全靠它。
       导出的是"内存里的原始记录"，恢复时整体替换并全量落盘（这是唯一需要全量写的场景）。 */
    function exportAll() {
      return {
        app: 'fengyue-local',
        schema: 1,
        exportedAt: new Date().toISOString(),
        engine: engine,
        characters: copy(data.characters),
        sessions: copy(data.sessions),
        messages: copy(data.messages),
        memories: copy(data.memories),
        settings: copy(data.settings)
      };
    }

    /** 整体替换（覆盖式恢复）。返回统计信息，失败抛错。 */
    function importAll(payload) {
      if (!payload || typeof payload !== 'object') throw new Error('备份内容不是对象');
      if (payload.app && payload.app !== 'fengyue-local') {
        throw new Error('这不是风月的备份文件（app=' + payload.app + '）');
      }
      var counts = {
        characters: Array.isArray(payload.characters) ? payload.characters.length : 0,
        sessions: Array.isArray(payload.sessions) ? payload.sessions.length : 0,
        messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
        memories: Array.isArray(payload.memories) ? payload.memories.length : 0
      };
      if (!counts.characters && !counts.sessions && !counts.messages) {
        throw new Error('备份里没有可恢复的数据');
      }
      data.characters = Array.isArray(payload.characters) ? payload.characters.slice() : [];
      data.sessions = Array.isArray(payload.sessions) ? payload.sessions.slice() : [];
      data.messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
      data.memories = Array.isArray(payload.memories) ? payload.memories.slice() : [];
      if (payload.settings && typeof payload.settings === 'object') {
        data.settings = makeSettings(payload.settings);
      }
      indexMessages();
      markFull();
      flushNow();
      return counts;
    }

    /** 整表重写（恢复备份这种"全变了"的场景用） */
    function markFull() {
      dirtyFull.characters = true;
      dirtyFull.sessions = true;
      dirtyFull.messages = true;
      dirtyFull.memories = true;
      dirtyFull.settings = true;
      dirtyFull.logs = true;
    }

    /** 当前后端名 */
    function getBackend() { return backend; }

    /** 列出可用后端（给设置页用） */
    function listBackends() {
      return Object.keys(BACKENDS).filter(function (n) {
        return n !== 'sqlite' || SqliteBackend.available();
      });
    }

    /** 把当前全部数据搬到另一个后端，成功后切过去。 */
    function migrateTo(name) {
      var target = BACKENDS[name];
      if (!target) return Promise.reject(new Error('未知存储后端：' + name));
      if (name === backend) return Promise.resolve({ ok: true, backend: backend, moved: 0 });
      var ops = { clears: STORES.slice(), puts: {}, dels: {} };
      for (var i = 0; i < STORES.length; i++) ops.puts[STORES[i]] = storeRecords(STORES[i]);
      var moved = data.messages.length;
      return Promise.resolve().then(function () {
        return target.wholeData ? target.apply(data) : target.apply(ops);
      }).then(function () {
        backend = name;
        rememberBackend(name);
        return { ok: true, backend: name, moved: moved };
      });
    }

    /** 把所有脏数据立刻写进当前后端（不确定时用）。 */
    function markAllDirty() {
      for (var i = 0; i < STORES.length; i++) dirtyFull[STORES[i]] = true;
    }

    /**
     * 消息检索。当前实现走内存（我们本来就全量持有），
     * 后端若提供 search（SQLite 的 LIKE）则优先用它 —— 数据量特别大时那条路更省内存。
     */
    function searchMessages(query, limit) {
      var q = toStr(query).trim();
      if (!q) return Promise.resolve([]);
      var cap = limit && limit > 0 ? limit : 200;
      var be = BACKENDS[backend];
      if (be && typeof be.search === 'function') {
        return Promise.resolve(be.search(q, cap)).then(function (rows) {
          if (rows && rows.length) return rows.map(copy);
          return searchInMemory(q, cap);
        }).catch(function () { return searchInMemory(q, cap); });
      }
      return Promise.resolve(searchInMemory(q, cap));
    }
    function searchInMemory(q, cap) {
      var needle = q.toLowerCase();
      var out = [];
      for (var i = data.messages.length - 1; i >= 0 && out.length < cap; i--) {
        var m = data.messages[i];
        if (String(m.content || '').toLowerCase().indexOf(needle) >= 0) out.push(copy(m));
      }
      return out;
    }

    /** 分页取消息（最新在前）。给"记录很多时只加载一屏"留的接口。 */
    function listMessagesPage(sessionId, offset, limit) {
      var arr = msgIndex[sessionId] || [];
      var off = Math.max(0, Number(offset) || 0);
      var lim = Math.max(1, Math.min(Number(limit) || 50, 500));
      var end = Math.max(0, arr.length - off);
      var start = Math.max(0, end - lim);
      var out = [];
      for (var i = start; i < end; i++) out.push(copy(arr[i]));
      return { items: out, total: arr.length, hasMore: start > 0 };
    }

    function flushNow() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      persist();
      return true;
    }

    return {
      raw: data,
      engine: engine,
      /* 设置 */
      getSettings: getSettings, saveSettings: saveSettings,
      /* 角色 */
      listCharacters: listCharacters, getCharacter: getCharacter, saveCharacter: saveCharacter,
      deleteCharacter: deleteCharacter, characterCount: characterCount,
      /* 会话 */
      listSessions: listSessions, getSession: getSession, saveSession: saveSession, deleteSession: deleteSession,
      getActiveSessionId: getActiveSessionId, setActiveSessionId: setActiveSessionId,
      /* 消息 */
      listMessages: listMessages, countMessages: countMessages, lastMessage: lastMessage,
      addMessage: addMessage, updateMessage: updateMessage, deleteMessage: deleteMessage,
      deleteMessagesFrom: deleteMessagesFrom,
      /* 记忆 */
      listMemories: listMemories, getMemory: getMemory, saveMemory: saveMemory, clearMemory: clearMemory,
      /* 日志 */
      addLog: addLog, listLogs: listLogs, clearLogs: clearLogs,
      /* 维护 */
      stats: stats, flushNow: flushNow, exportAll: exportAll, importAll: importAll,
      getBackend: getBackend, listBackends: listBackends, migrateTo: migrateTo,
      markAllDirty: markAllDirty, searchMessages: searchMessages, listMessagesPage: listMessagesPage
    };
  }

  /* ===========================================================================
   * 5. 对外入口
   * ======================================================================== */

  /**
   * 初始化存储。优先 IndexedDB，失败自动降级 localStorage。
   * @returns {Promise<{store, engine, error}>}
   */
  function init(preferred) {
    /* 后端尝试顺序：用户指定的 → indexeddb → sqlite（若桥在）→ localstorage → memory。
       任何一步失败都记下原因继续往下试，最后一定给用户一个能用的存储（memory 兜底不会丢数据到崩）。 */
    var want = preferred || preferredBackend();
    var order = [];
    if (want && BACKENDS[want]) order.push(want);
    ['indexeddb', 'sqlite', 'localstorage', 'memory'].forEach(function (n) {
      if (order.indexOf(n) < 0 && (n !== 'sqlite' || SqliteBackend.available())) order.push(n);
    });

    var errors = [];
    function tryAt(i) {
      if (i >= order.length) return Promise.reject(new Error('没有可用的存储后端：' + errors.join('; ')));
      var name = order[i];
      var be = BACKENDS[name];
      return Promise.resolve().then(function () {
        return be.loadAll();
      }).then(function (recs) {
        var store = createStore(name, recs || {});
        if (name !== want) rememberBackend(name);
        return { store: store, engine: name, error: errors.length ? errors.join('; ') : null, tried: order.slice(0, i + 1) };
      }).catch(function (e) {
        errors.push(name + ': ' + String(e && e.message || e));
        return tryAt(i + 1);
      });
    }
    return tryAt(0);
  }

  global.FYStore = {
    init: init,
    /* 模型工厂（app.js 建新角色/会话时用） */
    makeCharacter: makeCharacter,
    makeSession: makeSession,
    makeMessage: makeMessage,
    makeMemory: makeMemory,
    makeSettings: makeSettings,
    DEFAULTS: DEFAULT_SETTINGS,
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
    /* 工具 */
    newId: newId,
    estimateTokens: estimateTokens,
    calibrateTokens: calibrateTokens,
    setTokenModel: setTokenModel,
    getTokenFactor: getTokenFactor,
    clamp: clamp,
    copy: copy
  };
})(typeof window !== 'undefined' ? window : this);
