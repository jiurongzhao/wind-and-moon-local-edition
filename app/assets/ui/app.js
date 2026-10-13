/* =============================================================================
 * 风月·本地版 —— app.js
 * 全部前端逻辑。分区块：
 *   1  工具函数            2  原生桥封装（window.FY）
 *   3  全局状态与 DOM 引用  4  Toast / 底部面板 / 弹层
 *   5  软键盘与视口         6  路由与视图
 *   7  角色列表与角色编辑    8  会话与聊天渲染
 *   9  提示词组装           10 流式推理（SSE 解析 + 增量渲染）
 *   11 剧情选项解析与渲染    12 长期记忆压缩
 *   13 语音（TTS / STT）     14 设置页
 *   15 调试页               16 事件桥接（window.fyEvent）
 *   17 启动流程
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ===========================================================================
   * 1. 工具函数
   * ======================================================================== */

  function $(id) { return document.getElementById(id); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /** 生成 DOM：el('div', 'cls1 cls2', '文本' | [子节点]) */
  function el(tag, cls, content) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (content !== undefined && content !== null) {
      if (Array.isArray(content)) content.forEach(function (c) { if (c) n.appendChild(c); });
      else if (typeof content === 'string') n.textContent = content;
      else n.appendChild(content);
    }
    return n;
  }

  /* ---------- 图标：自绘 SVG sprite（见 index.html 的 #i-xxx） ----------
     v1.4.0 起不再拿 emoji 当 UI 图标：各系统字体渲染差异大、粗细对不齐。
     这里只做两件事 —— 造一个 <svg class="ico"><use href="#i-name"/></svg>，
     以及把历史代码里散落的 emoji "别名" 折成图标名（认不出就原样留着，
     因为角色头像、表情这类 emoji 是用户内容，不能动）。 */
  var SVGNS = 'http://www.w3.org/2000/svg';
  var ICON_ALIAS = {
    '✅': 'check', '✔': 'check', '❌': 'ban', '⚠️': 'warn', '⚠': 'warn', '🚫': 'ban',
    '📋': 'copy', '🔊': 'speaker', '🔄': 'refresh', '✏️': 'pen', '🗑️': 'trash', '🗑': 'trash',
    '🎭': 'char', '💬': 'chat', '⚙️': 'gear', '⚙': 'gear', '🧪': 'flask', '📖': 'book',
    '📦': 'box', '💡': 'bulb', '✨': 'sparkle', '🎲': 'dice', '🦴': 'template',
    '🌡': 'thermo', '🔎': 'search', '↩️': 'back', '✍️': 'pen', '📤': 'export',
    '☁️': 'cloud', '📱': 'phone', '🖥': 'monitor', '👥': 'users', '🤖': 'robot', '🧑': 'user',
    '🔌': 'bolt', '⚡': 'bolt', '🚪': 'door', '🗣': 'quote', '⭐': 'star', '☆': 'star-o', '▶': 'next'
  };

  function iconEl(name, cls) {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    var u = document.createElementNS(SVGNS, 'use');
    u.setAttribute('href', '#i-' + name);
    try { u.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#i-' + name); } catch (e) { /* 老引擎 */ }
    s.appendChild(u);
    return s;
  }

  /** 图标名或 emoji → 可插入的节点（emoji 认得出就换成图标，认不出原样保留） */
  function iconNode(ico, cls) {
    var raw = String(ico === undefined || ico === null ? '' : ico).trim();
    var name = ICON_ALIAS[raw] || (/^[a-z-]+$/.test(raw) ? raw : '');
    if (name) return iconEl(name, cls);
    return el('span', cls || '', raw || '•');
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(bytes) {
    var b = Number(bytes) || 0;
    if (b <= 0) return '未知大小';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(0) + ' MB';
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fmtTime(ts) {
    var d = new Date(ts || Date.now());
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  function fmtWhen(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
    var d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms || 200);
    };
  }

  function uid(prefix) { return FYStore.newId(prefix); }

  /** 复制文本：Clipboard API → execCommand → 提示失败 */
  function copyText(text) {
    var s = String(text == null ? '' : text);
    if (!s) { toast('没有可复制的内容', 'warn'); return; }
    var done = function () { toast('已复制', 'ok'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s).then(done, function () { fallback(); });
        return;
      }
    } catch (e) { /* 继续降级 */ }
    fallback();
    function fallback() {
      try {
        var ta = el('textarea');
        ta.value = s;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, s.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else toast('复制失败，请长按文本选择', 'err');
      } catch (e) {
        toast('复制失败：' + e, 'err');
      }
    }
  }

  /* ===========================================================================
   * 2. 原生桥封装（严格只用契约里列出的方法名）
   * ======================================================================== */

  /** 契约里允许的所有 FY 方法（自查脚本也会比对这张表） */
  var FY_METHODS = [
    'appInfo', 'engineStatus', 'engineStart', 'engineStop',
    'chat', 'chatStop',
    'listModels', 'deleteModel', 'pickModelFile', 'importModel',
    'listDownloadSources', 'downloadModel',
    'pickCharacterCard', 'saveCharacterCard',
    'pickBackupFile', 'saveBackup',
    'dbLoadAll', 'dbApply', 'dbSearch', 'dbStats', 'dbWipe', 'saveText',
    'getProvider', 'setProvider', 'testProvider',
    'speak', 'stopSpeak', 'startListening', 'stopListening',
    'keepAwake', 'log', 'exportDiagnostics'
  ];

  function bridgeAlive() {
    return !!(global.FY && typeof global.FY === 'object');
  }

  /**
   * 调用原生桥。所有返回值都是 JSON 字符串，这里统一 parse。
   * @param {string} method 方法名（必须在 FY_METHODS 中）
   * @param {Array}  args   参数
   * @param {boolean} quiet 静默模式：不弹 toast（轮询类调用用）
   * @returns {*} 解析后的对象；失败返回 null
   */
  function fyCall(method, args, quiet) {
    if (FY_METHODS.indexOf(method) < 0) {
      console.error('[fy] 未在契约中的方法名：' + method);
      if (!quiet) toast('内部错误：非法桥方法 ' + method, 'err');
      return null;
    }
    if (!bridgeAlive()) {
      if (!quiet) toast('原生桥不可用，现在是纯网页模式', 'warn');
      return null;
    }
    try {
      var raw = global.FY[method].apply(global.FY, args || []);
      if (raw === undefined || raw === null || raw === '') return null;
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); }
        catch (e) { return { ok: true, raw: raw }; }
      }
      return raw;   // 万一桥直接返回了对象
    } catch (e) {
      console.error('[fy] ' + method + ' 调用失败', e);
      if (!quiet) toast('调用 ' + method + ' 失败：' + (e && e.message || e), 'err');
      return null;
    }
  }

  /** 写原生日志（不返回东西，且必须永远不炸） */
  function fyLog(msg) {
    try { if (bridgeAlive() && global.FY.log) global.FY.log(String(msg)); } catch (e) {}
    try { console.log('[fy]', msg); } catch (e2) {}
  }

  /* ===========================================================================
   * 3. 全局状态与 DOM 引用
   * ======================================================================== */

  var S = {
    store: null,          // FYStore 实例
    engine: 'indexeddb',  // 存储引擎
    engineError: null,
    settings: null,
    view: 'characters',
    session: null,        // 当前会话（对象副本）
    characters: [],       // 全部角色
    messages: [],         // 当前会话消息
    models: [],           // 原生侧模型列表
    downloads: [],        // 内置下载源
    engineState: { state: 'stopped', port: 0, model: '', message: '', lastError: '' },
    generating: false,
    abort: null,          // AbortController
    sttPartial: '',
    listening: false,
    speakingMsgId: '',
    memoryTarget: null,   // 记忆面板当前编辑对象
    editChar: null,       // 正在编辑的角色
    /* 创作者工具：编辑面板里的工作副本 + 向导状态 */
    charTags: [],         // 编辑面板里"当前选中"的分类标签
    charKind: 'character',
    lint: null,           // 最近一次质量评分结果
    aiBusy: false,        // AI 辅助是否正在生成
    creator: { step: 1, tag: '', kind: '', skeleton: null },
    refSources: null,     // 灵感面板的来源列表（只加载一次）
    refCurrent: '',
    lastOptions: [],      // 当前展示的剧情选项
    lastUserText: '',     // 用于重新生成
    booted: false
  };

  /* ===========================================================================
   * 4. Toast / 底部面板
   * ======================================================================== */

  function toast(msg, kind, ms) {
    var box = $('toasts');
    if (!box) return;
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), String(msg));
    box.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 240);
    }, ms || 2000);
  }

  /** 打开通用底部动作面板 */
  function openActions(title, actions) {
    var list = $('actionList');
    list.innerHTML = '';
    $('actionTitle').textContent = title || '操作';
    actions.forEach(function (a) {
      if (!a) return;
      var b = el('button', 'act-btn' + (a.danger ? ' danger' : ''));
      var tile = el('span', 'act-ico');
      if (a.avatarCard) fillAvatar(tile, a.avatarCard, 30);
      else tile.appendChild(iconNode(a.icon, ''));
      b.appendChild(tile);
      b.appendChild(el('span', 'act-label', a.label));
      b.onclick = function () {
        closeSheet($('actionMask'));
        setTimeout(function () { try { a.run(); } catch (e) { toast('操作失败：' + e, 'err'); } }, 60);
      };
      list.appendChild(b);
    });
    openSheet($('actionMask'));
  }

  function openSheet(mask) { if (mask) mask.hidden = false; }
  function closeSheet(mask) { if (mask) mask.hidden = true; }

  /** 通用确认（用底部面板实现，风格统一） */
  function confirmAction(title, text, okLabel, onOk) {
    openActions(title, [
      { icon: '✅', label: okLabel, danger: true, run: onOk },
      { icon: '↩️', label: '取消', run: function () {} }
    ]);
    $('actionTitle').textContent = title;
    var tip = el('div', 'muted sm');
    tip.style.padding = '0 10px 8px';
    tip.textContent = text;
    $('actionList').insertBefore(tip, $('actionList').firstChild);
  }

  /* ===========================================================================
   * 5. 软键盘与视口（Android WebView 防遮挡）
   * ======================================================================== */

  function applyViewport() {
    var h = global.innerHeight || 0;
    var vv = global.visualViewport;
    if (vv && vv.height) h = vv.height;
    if (!h) h = 600;
    document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
    /* 键盘高度：布局视口 - 可视视口 */
    var kb = Math.max(0, (global.innerHeight || h) - (vv ? vv.height : h));
    document.documentElement.style.setProperty('--kb', Math.round(kb) + 'px');
    var app = $('app');
    var open = kb > 120;
    if (app) app.classList.toggle('kb-open', open);
    if (open) scrollMessagesToBottom(true);
  }

  function initViewport() {
    applyViewport();
    global.addEventListener('resize', applyViewport);
    global.addEventListener('orientationchange', function () { setTimeout(applyViewport, 260); });
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', applyViewport);
      global.visualViewport.addEventListener('scroll', applyViewport);
    }
  }

  /* ===========================================================================
   * 6. 路由与视图
   * ======================================================================== */

  var VIEW_TITLE = {
    characters: ['风月·本地版', '全离线 AI 角色扮演'],
    chat: ['聊天', ''],
    story: ['剧情', '选项式推进'],
    settings: ['设置', '模型 · 参数 · 语音'],
    debug: ['调试', '原生桥 · 引擎日志']
  };

  function switchView(name, opts) {
    opts = opts || {};
    if (VIEW_TITLE[name] === undefined) name = 'characters';
    S.view = name;

    qsa('.view').forEach(function (v) { v.classList.toggle('active', v.dataset.view === name); });
    qsa('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });

    var t = VIEW_TITLE[name];
    $('topTitle').textContent = name === 'chat' && S.session ? (S.session.title || t[0]) : t[0];
    $('topSub').textContent = name === 'chat' ? chatSubtitle() : t[1];
    $('btnBack').hidden = !(name === 'chat');

    if (name === 'characters') renderCharacters();
    if (name === 'chat') { renderChatHeader(); renderMessages(); renderOptionsBar(); renderEngineBanner(); }
    if (name === 'story') renderStory();
    if (name === 'settings') renderSettings();
    if (name === 'debug') renderDebug();
    if (name === 'chat' && !opts.keepScroll) scrollMessagesToBottom(true);
    applyViewport();
  }

  function chatSubtitle() {
    if (!S.session) return '未选择角色';
    var chars = sessionCharacters();
    if (!chars.length) return '（角色已删除）';
    var parts = [];
    parts.push(S.session.mode === 'group' ? (chars.length + ' 人群聊') : '单聊');
    parts.push('记忆 ' + (S.store ? memoryCovered(S.session.id) : 0) + ' 条');
    if (S.session.plot) parts.push('剧情模式');
    var st = engineStateText();
    parts.push(st);
    return parts.join(' · ');
  }

  /* ===========================================================================
   * 7. 角色列表与角色编辑
   * ======================================================================== */

  function charById(id) {
    for (var i = 0; i < S.characters.length; i++) if (S.characters[i].id === id) return S.characters[i];
    return null;
  }
  function sessionCharacters() {
    if (!S.session) return [];
    return S.session.characterIds.map(charById).filter(Boolean);
  }

  /* ---------- 角色分类 / 搜索 / 推荐 ----------
     分类用的就是卡片自带的 tags（chara_card_v2 标准字段），不额外维护一套体系，
     导入别人写的卡时标签会一起进来；没有标签的卡归到「未分类」。 */

  var CAT_OTHER = '未分类';
  var CAT_FAV = '⭐ 收藏';

  function allCategories() {
    var seen = {}, out = [];
    if (S.characters.some(function (c) { return c.fav; })) { out.push(CAT_FAV); seen[CAT_FAV] = 1; }
    S.characters.forEach(function (c) {
      var tags = (c.tags && c.tags.length) ? c.tags : [CAT_OTHER];
      tags.forEach(function (t) { if (!seen[t]) { seen[t] = 1; out.push(t); } });
    });
    return out;
  }

  function countByCat(cat) {
    if (cat === 'all') return S.characters.length;
    if (cat === CAT_FAV) return S.characters.filter(function (c) { return c.fav; }).length;
    return S.characters.filter(function (c) {
      var tags = (c.tags && c.tags.length) ? c.tags : [CAT_OTHER];
      return tags.indexOf(cat) >= 0;
    }).length;
  }

  function charMatches(c) {
    if (S.charCat && S.charCat !== 'all') {
      if (S.charCat === CAT_FAV) {
        if (!c.fav) return false;
      } else {
        var tags = (c.tags && c.tags.length) ? c.tags : [CAT_OTHER];
        if (tags.indexOf(S.charCat) < 0) return false;
      }
    }
    var q = (S.charQuery || '').trim().toLowerCase();
    if (!q) return true;
    var hay = [c.name, c.tagline, c.persona, (c.tags || []).join(' '), c.kind === 'story' ? '剧情卡' : '']
      .join(' ').toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function renderCharCats() {
    var box = $('charCats');
    if (!box) return;
    box.innerHTML = '';
    var cats = ['all'].concat(allCategories());
    cats.forEach(function (t) {
      var b = el('button', 'chip' + ((S.charCat || 'all') === t ? ' on' : ''));
      if (t === CAT_FAV) {
        b.appendChild(iconEl('star'));
        b.appendChild(el('span', '', '收藏 ' + countByCat(t)));
      } else {
        b.appendChild(el('span', '', t === 'all' ? ('全部 ' + countByCat('all')) : (t + ' ' + countByCat(t))));
      }
      b.onclick = function () {
        S.charCat = t;
        renderCharCats();
        renderCharacters();
      };
      box.appendChild(b);
    });
  }

  /* 角色列表一次只渲染这么多张，滚到底再追加 —— 卡库扩到三万张后，
     一次性建 32000 个 DOM 节点会让中低端机直接卡死（WebView 建节点是同步的）。 */
  var CHAR_PAGE = 60;

  /* 立绘包索引（app/assets/ui/avatars/index.json）。没有它、或没匹配到，就退回程序化头像。 */
  var avatarIndex = null;

  /** 异步拉立绘索引；拉不到也不影响启动（纯程序化图标） */
  function loadAvatarIndex() {
    if (typeof global.fetch !== 'function') return Promise.resolve(null);
    return global.fetch('avatars/index.json').then(function (r) {
      return (r && r.ok) ? r.json() : null;
    }).then(function (j) {
      if (j && j.byTopic) { avatarIndex = j; fyLog('立绘包已就绪：' + j.count + ' 张'); }
      return avatarIndex;
    }).catch(function () { return null; });
  }

  /** 精确命中：这张卡的"分类|类型|主题"有没有对应的立绘（先不管归属） */
  function avatarImageForRaw(card) {
    if (!avatarIndex || !card) return '';
    var tag = (Array.isArray(card.tags) && card.tags[0]) || '';
    var kind = card.kind === 'story' ? 'story' : 'character';
    if (!tag || !card.topic) return '';
    return avatarIndex.byTopic[tag + '|' + kind + '|' + card.topic] || '';
  }

  /* 一张立绘只允许一张卡用。
     同一主题下按 hash(名字+id) 最小的那张当"主人"，其余同主题的卡一律回程序化图标——
     否则一个主题几十张卡会共用同一张脸。 */
  var avatarOwners = {};        // 立绘路径 -> { id, h }
  var avatarOwnerList = null;   // 上一次计算的角色数组（换引用就重算）

  function ensureAvatarOwners() {
    var list = S.characters && S.characters.length !== undefined
      ? S.characters
      : ((S.store && S.store.listCharacters) ? S.store.listCharacters() : []);
    if (list === avatarOwnerList) return;
    avatarOwnerList = list;
    avatarOwners = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var src = avatarImageForRaw(c);
      if (!src) continue;
      var h = (global.FYAvatar && global.FYAvatar.hash32)
        ? global.FYAvatar.hash32((c.name || '') + '|' + c.id) : 0;
      var cur = avatarOwners[src];
      if (!cur || h < cur.h) avatarOwners[src] = { id: c.id, h: h };
    }
  }

  /**
   * 这张卡该用哪张立绘：
   *   精确命中、并且它正是这个主题里抽中的那张 → 用立绘；
   *   否则（没对应图 / 同主题已经归别的卡了 / 旧卡没 topic）→ 回程序化图标。
   */
  function avatarImageFor(card) {
    var src = avatarImageForRaw(card || {});
    if (!src) return '';
    ensureAvatarOwners();
    var o = avatarOwners[src];
    return (o && card && o.id === card.id) ? src : '';
  }

  /**
   * 把角色头像画进节点，优先级：立绘图 → 程序化图标 → emoji。
   * 立绘外面套一圈分类配色的内描边（--av-ac）当装饰；图挂了当场退回程序化，不留白块。
   */
  function fillAvatar(node, card, size) {
    if (!node) return node;
    var c = card || {};
    /* 描边色和程序化图标同源（都带逐卡色相偏移），同一分类里也不会撞色 */
    if (global.FYAvatar) {
      var ac = global.FYAvatar.accentOf ? global.FYAvatar.accentOf(c)
        : (global.FYAvatar.themeOf ? global.FYAvatar.themeOf(c).ac : '');
      if (ac) node.style.setProperty('--av-ac', ac);
    }
    var src = avatarImageFor(c);
    if (src) {
      node.classList.add('has-img');
      node.innerHTML = '';
      var img = document.createElement('img');
      img.className = 'av-img';
      img.alt = '';
      img.loading = 'lazy';
      /* 同一主题的多张卡本来会共用同一张立绘：按卡名哈希做逐卡的取景/缩放/镜像，
         一屏里就不会出现两张一模一样的立绘 */
      var h = (global.FYAvatar && global.FYAvatar.hash32)
        ? global.FYAvatar.hash32((c.name || '') + '|' + (c.topic || '') + '|' + src) : 0;
      var zoom = 1 + ((h % 100) / 100) * 0.3;          /* 1.00 ~ 1.30 */
      var ox = 26 + ((h >>> 7) % 48);                  /* 26% ~ 74% */
      var oy = 20 + ((h >>> 13) % 44);                 /* 20% ~ 64% */
      var flip = ((h >>> 3) & 1) ? -1 : 1;
      img.style.setProperty('--av-zoom', zoom.toFixed(3));
      img.style.setProperty('--av-ox', ox + '%');
      img.style.setProperty('--av-oy', oy + '%');
      img.style.setProperty('--av-flip', String(flip));
      img.onerror = function () {
        node.classList.remove('has-img');
        node.innerHTML = '';
        if (global.FYAvatar) global.FYAvatar.fill(node, c, size || 50);
      };
      img.src = src;
      node.appendChild(img);
      return node;
    }
    node.classList.remove('has-img');
    if (global.FYAvatar && typeof global.FYAvatar.fill === 'function') {
      global.FYAvatar.fill(node, c, size || 50);
    } else {
      node.textContent = c.avatar || '🙂';
    }
    return node;
  }

  /** 造一张角色卡（窗口化渲染时反复调用，所以单独抽出来） */
  function buildCharCard(c, sessions) {
    var card = el('div', 'char-card' + (S.session && S.session.characterIds.indexOf(c.id) >= 0 ? ' on' : ''));
    var top = el('div', 'char-top');
    top.appendChild(fillAvatar(el('div', 'char-avatar'), c, 50));

    var fav = el('button', 'char-fav' + (c.fav ? ' on' : ''));
    fav.appendChild(iconEl(c.fav ? 'star' : 'star-o'));
    fav.title = c.fav ? '取消收藏' : '收藏（可在分类里筛「⭐ 收藏」）';
    fav.onclick = function (ev) {
      ev.stopPropagation();
      S.store.saveCharacter(Object.assign({}, c, { fav: !c.fav }));
      S.characters = S.store.listCharacters();
      S.charCount = -1;
      renderCharCats();
      renderCharacters();
    };
    top.appendChild(fav);

    var edit = el('button', 'char-edit');
    edit.appendChild(iconEl('pen'));
    edit.title = '编辑角色';
    edit.onclick = function (ev) { ev.stopPropagation(); openCharSheet(c); };
    top.appendChild(edit);
    card.appendChild(top);

    var nameRow = el('div', 'char-name');
    nameRow.appendChild(el('span', '', c.name));
    if (c.kind === 'story') nameRow.appendChild(el('span', 'badge accent', '剧情'));
    card.appendChild(nameRow);

    card.appendChild(el('div', 'char-tagline', c.tagline || c.persona.slice(0, 30) || '（没有简介）'));

    var sess = null;
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].mode === 'solo' && sessions[i].characterIds.length === 1 && sessions[i].characterIds[0] === c.id) { sess = sessions[i]; break; }
    }
    var meta = el('div', 'char-meta');
    if (sess) meta.appendChild(el('span', 'badge accent', fmtWhen(sess.updatedAt) + '聊过'));
    var temp = el('span', 'badge');
    temp.appendChild(iconEl('thermo'));
    temp.appendChild(el('span', '', (c.temperature || 0).toFixed(2)));
    temp.title = '采样温度：越高越天马行空，越低越稳定';
    meta.appendChild(temp);
    card.appendChild(meta);

    card.onclick = function () { openSoloChat(c.id, sess ? sess.id : ''); };
    return card;
  }

  /** 只渲染窗口内的卡（追加式：已渲染的节点不动） */
  function renderCharWindow() {
    var grid = $('charGrid');
    if (!grid) return;
    var list = S.charFiltered || [];
    var upto = Math.min(S.charShown, list.length);
    var sessions = S.store.listSessions();
    for (var i = S.charRendered; i < upto; i++) grid.appendChild(buildCharCard(list[i], sessions));
    S.charRendered = upto;
    renderCharMore();
  }

  /** 底部「已显示 N / M · 继续下滑加载」提示：全显示完就藏起来 */
  function renderCharMore() {
    var box = $('charMore');
    if (!box) return;
    var list = S.charFiltered || [];
    var shown = Math.min(S.charShown, list.length);
    if (!list.length || shown >= list.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(el('span', 'char-more-text', '已显示 ' + shown + ' / ' + list.length + ' · 继续下滑加载'));
    var more = el('button', 'btn btn-sm', '加载更多');
    more.onclick = function (ev) { ev.stopPropagation(); loadMoreCharacters(); };
    box.appendChild(more);
  }

  /**
   * 往下再放一屏（滚动到底部时自动调用；测试也直接调它）。
   * @returns {number} 当前已显示的张数
   */
  function loadMoreCharacters() {
    var list = S.charFiltered || [];
    if (S.charShown < list.length) {
      S.charShown = Math.min(S.charShown + CHAR_PAGE, list.length);
      renderCharWindow();
    }
    return Math.min(S.charShown, list.length);
  }

  function renderCharacters() {
    S.characters = S.store.listCharacters();
    var grid = $('charGrid');
    grid.innerHTML = '';
    if (S.charCount !== S.characters.length || !S.charCat) renderCharCats();
    S.charCount = S.characters.length;

    var shown = S.characters.filter(charMatches);
    shown.sort(function (a, b) { return (b.fav ? 1 : 0) - (a.fav ? 1 : 0); });   /* 收藏的排前面 */
    $('charCount').textContent = (shown.length === S.characters.length)
      ? ('共 ' + S.characters.length + ' 位角色')
      : ('共 ' + S.characters.length + ' 位角色，筛出 ' + shown.length + ' 位');
    $('charEmpty').hidden = shown.length > 0;
    if (!shown.length && S.characters.length) {
      $('charEmpty').querySelector('.empty-title').textContent = '没有匹配的角色';
      $('charEmpty').querySelector('.empty-text').textContent = '换个分类或清空搜索词试试';
    } else if (S.characters.length) {
      $('charEmpty').querySelector('.empty-title').textContent = '还没有角色';
      $('charEmpty').querySelector('.empty-text').textContent = '点右上角「新建」，或从设置里恢复内置角色';
    }

    /* 换分类 / 改搜索词 / 任何一次整体重渲染：窗口回到第一屏 */
    S.charFiltered = shown;
    S.charShown = CHAR_PAGE;
    S.charRendered = 0;
    renderCharWindow();

    var st = S.store.stats();
    $('setupBanner').hidden = !(S.models.length === 0 && !providerReady());
    fyLog('角色列表渲染完成：' + S.characters.length + ' 个角色（筛出 ' + shown.length
      + '，本次渲染 ' + S.charRendered + '），消息 ' + st.messages + ' 条');
  }

  /**
   * 打开角色编辑面板。
   * @param {object} c      要编辑的已有角色（新建传 null）
   * @param {object} draft  创作者工具生成的草稿（新建时可传，直接预填）
   */
  function openCharSheet(c, draft) {
    var d = draft || null;
    S.editChar = c || null;
    $('charSheetTitle').textContent = c ? '编辑角色' : (d ? '新建角色 · 已套模板' : '新建角色');
    $('fAvatar').value = c ? c.avatar : (d ? d.avatar : '🙂');
    $('fName').value = c ? c.name : (d ? d.name : '');
    $('fTagline').value = c ? c.tagline : (d ? (d.tagline || '') : '');
    $('fPersona').value = c ? c.persona : (d ? (d.persona || '') : '');
    $('fScenario').value = c ? (c.scenario || '') : (d ? (d.scenario || '') : '');
    $('fGreeting').value = c ? c.greeting : (d ? (d.greeting || '') : '');
    $('fExamples').value = c ? c.examples : (d ? (d.examples || '') : '');
    $('fSystem').value = c ? c.systemPrompt
      : ((d && d.systemPrompt) ? d.systemPrompt : FYStore.DEFAULT_SYSTEM_PROMPT);
    $('fTemp').value = c ? c.temperature : (d ? d.temperature : 0.85);
    $('fTempVal').textContent = Number($('fTemp').value).toFixed(2);
    /* 分类与类型在标题栏之外单独维护（chips 不是原生表单控件） */
    S.charTags = c ? (c.tags || []).slice() : (d && d.tags ? d.tags.slice() : []);
    S.charKind = c ? (c.kind === 'story' ? 'story' : 'character')
      : (d && d.kind === 'story' ? 'story' : 'character');
    renderFTags();
    renderFKind();
    syncScenarioField();
    $('btnCharDelete').hidden = !c;
    $('btnCharExport').hidden = !c;
    $('charSheetErr').hidden = true;
    var st = $('aiStatus');
    if (st) { st.hidden = true; st.textContent = ''; }
    openSheet($('charSheetMask'));
    refreshLint();
    setTimeout(function () { try { $('fName').focus(); } catch (e) {} }, 120);
  }

  /* ---------- 分类标签 / 类型（创作者工具的一部分） ---------- */

  /** 渲染分类标签 chips；模板还没加载完就先拉一次再画 */
  function renderFTags() {
    var box = $('fTags');
    if (!box) return;
    var b = FYCreator.bundle();
    if (!b) {
      box.innerHTML = '';
      box.appendChild(el('span', 'muted xs', '正在加载分类…'));
      FYCreator.loadBundle().then(function () {
        renderFTags();
        /* 分类到位后「原型贴合度」才算得准，重算一次，别让用户看着一个假的低分 */
        refreshLint();
      }).catch(function (e) {
        box.innerHTML = '';
        box.appendChild(el('span', 'muted xs', '分类模板加载失败：' + ((e && e.message) || e)));
      });
      return;
    }
    box.className = 'chips wrap';
    box.innerHTML = '';
    b.categories.forEach(function (cat) {
      var on = S.charTags.indexOf(cat.tag) >= 0;
      var chip = el('button', 'chip' + (on ? ' on' : ''), cat.emoji + ' ' + cat.tag);
      chip.title = cat.blurb + (cat.coreTension ? '\n核心张力：' + cat.coreTension : '');
      chip.onclick = function () {
        var i = S.charTags.indexOf(cat.tag);
        if (i >= 0) S.charTags.splice(i, 1);
        else {
          if (S.charTags.length >= FYCreator.GATE.tagsMax) {
            toast('最多 ' + FYCreator.GATE.tagsMax + ' 个分类标签', 'warn');
            return;
          }
          S.charTags.push(cat.tag);
        }
        renderFTags();
        /* 换分类会换写作要点，评分也跟着变 */
        refreshLint();
      };
      box.appendChild(chip);
    });
    box.appendChild(el('span', 'muted xs', '（已选 ' + S.charTags.length + '/' + FYCreator.GATE.tagsMax + '）'));
  }

  /** 角色卡 / 剧情卡 */
  function renderFKind() {
    var box = $('fKind');
    if (!box) return;
    var b = FYCreator.bundle();
    var kinds = (b && b.kinds) || {};
    box.className = 'chips wrap';
    box.innerHTML = '';
    [['character', '角色卡', 'char'], ['story', '剧情卡', 'book']].forEach(function (pair) {
      var key = pair[0];
      var chip = el('button', 'chip' + (S.charKind === key ? ' on' : ''));
      chip.appendChild(iconEl(pair[2]));
      chip.appendChild(el('span', '', pair[1]));
      var meta = kinds[key];
      chip.title = meta ? (meta.hint || '') : '';
      chip.onclick = function () {
        S.charKind = key;
        renderFKind();
        syncScenarioField();
        refreshLint();
      };
      box.appendChild(chip);
    });
    var hint = kinds[S.charKind];
    if (hint && hint.hint) box.appendChild(el('span', 'muted xs', hint.hint));
  }

  /** 剧情卡才显示「情境」；角色卡也可以写，但不强制 */
  function syncScenarioField() {
    var f = $('fScenarioField');
    if (f) f.hidden = (S.charKind !== 'story');
  }

  /** 把编辑面板里的内容收成一个角色 patch（保存和评分共用一份，避免两边不一致） */
  function collectCharForm() {
    return {
      id: S.editChar ? S.editChar.id : '',
      name: $('fName').value.trim(),
      avatar: ($('fAvatar').value || '🙂').trim().slice(0, 4),
      tagline: $('fTagline').value.trim(),
      persona: $('fPersona').value.trim(),
      scenario: $('fScenario').value,
      greeting: $('fGreeting').value,
      examples: $('fExamples').value,
      systemPrompt: $('fSystem').value.trim() || FYStore.DEFAULT_SYSTEM_PROMPT,
      temperature: Number($('fTemp').value),
      tags: S.charTags.slice(),
      kind: S.charKind,
      plot: S.charKind === 'story',
      createdAt: S.editChar ? S.editChar.createdAt : 0,
      builtin: S.editChar ? S.editChar.builtin : false
    };
  }

  /* ---------- 质量评分面板 ---------- */

  function refreshLint() {
    var box = $('lintBox');
    if (!box) return;
    if (!global.FYCreator) return;
    var patch = collectCharForm();
    var others = S.characters.filter(function (c) { return !S.editChar || c.id !== S.editChar.id; });
    var r = FYCreator.lint(patch, {
      existingNames: others.map(function (c) { return c.name; }),
      existingCards: others
    });
    S.lint = r;
    if ($('lintScore')) $('lintScore').textContent = r.score + ' · ' + r.grade;

    box.innerHTML = '';

    /* 七维评分：给出"差在哪一类"，而不只是"差多少分" */
    if (r.dimensions && r.dimensions.length) {
      var dims = el('div', 'dims');
      r.dimensions.forEach(function (d) {
        var tone = d.score >= 80 ? ' ok' : (d.score >= 55 ? '' : ' bad');
        var row = el('div', 'dim-row');
        var head = el('div', 'dim-head');
        head.appendChild(el('span', 'dim-name', d.label));
        head.appendChild(el('span', 'dim-score' + tone, String(d.score)));
        row.appendChild(head);
        var bar = el('div', 'dim-bar');
        var fill = el('div', 'dim-fill' + tone);
        fill.style.width = d.score + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        if (d.score < 70) row.appendChild(el('div', 'dim-hint', d.hint));
        dims.appendChild(row);
      });
      box.appendChild(dims);
    }

    if (!r.issues.length) {
      var okAll = el('div', 'lint-item ok');
      okAll.appendChild(iconEl('check'));
      okAll.appendChild(el('span', '', '没有发现问题：这张卡可以直接发了'));
      box.appendChild(okAll);
      return;
    }
    r.issues.forEach(function (it) {
      var row = el('div', 'lint-item ' + (it.level === 'error' ? 'err' : 'warn'));
      var msg = el('div', 'lint-msg');
      msg.appendChild(iconEl(it.level === 'error' ? 'ban' : 'warn'));
      msg.appendChild(el('span', '', it.msg));
      row.appendChild(msg);
      if (it.fix) row.appendChild(el('div', 'lint-fix', '→ ' + it.fix));
      box.appendChild(row);
    });
    if (r.passed.length) {
      var passRow = el('div', 'lint-item ok');
      passRow.appendChild(iconEl('check'));
      passRow.appendChild(el('span', '', r.passed.join('、')));
      box.appendChild(passRow);
    }
  }

  /* 每一次按键都重算七维 + 和已有卡做相似度比对，在手机上会卡；
     输入时轻量防抖，手动点「重新评分」或保存时同步算一次。 */
  var lintTimer = null;
  function scheduleLint() {
    if (lintTimer) clearTimeout(lintTimer);
    lintTimer = setTimeout(function () { lintTimer = null; refreshLint(); }, 160);
  }

  /* ---------- AI 辅助（复用聊天那套流式通道，本地/云端都走同一条路） ---------- */

  function aiStatus(text) {
    var st = $('aiStatus');
    if (!st) return;
    if (!text) { st.hidden = true; st.textContent = ''; return; }
    st.hidden = false;
    st.textContent = text;
  }

  /**
   * 跑一次 AI 辅助。
   * @param {string} task  FYCreator.TASKS 的键
   */
  function aiAssist(task) {
    if (S.aiBusy) { toast('上一次生成还没结束', 'warn'); return Promise.resolve(false); }
    if (!providerReady()) {
      toast('还没有可用的模型：设置 → 模型来源（云端或本地都行）', 'warn', 4000);
      return Promise.resolve(false);
    }
    var patch = collectCharForm();
    var cat = FYCreator.category(S.charTags[0]);
    var seed = (S.creator && S.creator.seed) || '';
    var t = FYCreator.TASKS[task] || {};
    var msgs = FYCreator.buildAssistMessages(task, { card: patch, category: cat, seed: seed });

    S.aiBusy = true;
    aiStatus('正在用「' + (isRemote() ? (provider().model || '云端模型') : '本地模型') + '」生成' + (t.label || '内容') + '…');
    toast('AI 正在生成' + (t.label || '') + '…', 'ok', 1600);

    var body = {
      messages: msgs,
      stream: true,
      temperature: task === 'polish' ? 0.4 : 0.8,
      top_p: 0.95,
      max_tokens: task === 'all' ? 1200 : 800,
      /* 创作者工具永远不要思考段：思考段会混进正文，写进卡里就是污染 */
      chat_template_kwargs: { enable_thinking: false }
    };
    var acc = '';
    var fieldEl = t.field ? $(charFieldId(t.field)) : null;

    return streamChat(body, function (full) {
      acc = full;
      if (fieldEl) { fieldEl.value = full; }
      aiStatus('生成中… ' + full.length + ' 字');
    }, null).then(function () {
      S.aiBusy = false;
      var res = FYCreator.parseAssistResult(task, acc);
      if (!res.ok) {
        aiStatus('');
        toast('生成失败：' + (res.message || '模型没有返回可用内容'), 'err', 4200);
        return false;
      }
      var n = applyAssistPatch(res.patch, fieldEl);
      aiStatus('');
      refreshLint();
      toast('已填入 ' + n + ' 个字段' + (res.message ? '（' + res.message + '）' : ''), 'ok', 3000);
      fyLog('创作者工具 AI 辅助：' + task + ' → ' + JSON.stringify(Object.keys(res.patch)));
      return true;
    }).catch(function (e) {
      S.aiBusy = false;
      aiStatus('');
      var msg = (e && e.message) || String(e);
      if (e && e.name === 'AbortError') { toast('已停止生成', 'warn'); return false; }
      toast('生成失败：' + msg, 'err', 4600);
      fyLog('创作者工具 AI 辅助失败：' + msg);
      return false;
    });
  }

  /** 字段名 → 编辑面板里的元素 id */
  function charFieldId(field) {
    var map = {
      name: 'fName', tagline: 'fTagline', persona: 'fPersona', greeting: 'fGreeting',
      examples: 'fExamples', scenario: 'fScenario', systemPrompt: 'fSystem'
    };
    return map[field] || 'fPersona';
  }

  /** 把 AI 返回的补丁写进表单，返回填了几个字段 */
  function applyAssistPatch(patch, skipEl) {
    var n = 0;
    Object.keys(patch || {}).forEach(function (k) {
      var id = charFieldId(k);
      var node = $(id);
      if (!node) return;
      /* 单字段任务已经流式写进去了，不用再覆盖一遍 */
      if (node === skipEl) { n++; return; }
      node.value = patch[k];
      n++;
    });
    return n;
  }

  /* ---------- 分类要点 / 骨架挑选 ---------- */

  function openCategoryGuide() {
    var tag = S.charTags[0];
    var cat = tag ? FYCreator.category(tag) : null;
    if (!cat) {
      openActions('分类要点', [{ icon: '🎭', label: '还没选分类：先在上面点一个分类标签', run: function () {} }]);
      return;
    }
    var g = cat.guide || {};
    var acts = [];
    acts.push({ icon: cat.emoji, label: '『' + cat.tag + '』：' + (cat.blurb || ''), run: function () {} });
    if (cat.coreTension) acts.push({ icon: '⚡', label: '核心张力：' + cat.coreTension, run: function () {} });
    (g.must || []).forEach(function (m) { acts.push({ icon: '✅', label: '必须做到：' + m, run: function () {} }); });
    (g.avoid || []).forEach(function (m) { acts.push({ icon: '🚫', label: '别这样写：' + m, run: function () {} }); });
    if (g.voice) {
      acts.push({ icon: '🗣', label: '称呼：' + g.voice.address, run: function () {} });
      acts.push({ icon: '🗣', label: '口癖：' + g.voice.tics, run: function () {} });
      acts.push({ icon: '🗣', label: '节奏：' + g.voice.pattern, run: function () {} });
    }
    (g.openers || []).forEach(function (m, i) { acts.push({ icon: '🚪', label: '开场式 ' + (i + 1) + '：' + m, run: function () {} }); });
    if (g.exampleHint) acts.push({ icon: '💬', label: '示例对话：' + g.exampleHint, run: function () {} });
    acts.push({ icon: '✨', label: '按这个分类的要点重写人设（AI）', run: function () { aiAssist('persona'); } });
    openActions('分类要点 · ' + cat.tag, acts);
  }

  /** 骨架挑选：把选中骨架的字段填进表单 */
  function openSkeletonPicker() {
    var tag = S.charTags[0];
    var cat = tag ? FYCreator.category(tag) : null;
    if (!cat || !cat.skeletons.length) {
      openActions('套骨架', [{ icon: '🎭', label: '先在编辑面板里选一个分类标签', run: function () {} }]);
      return;
    }
    var acts = cat.skeletons.map(function (sk) {
      return {
        icon: '🦴',
        label: sk.title + '——' + sk.who,
        run: function () {
          var draft = FYCreator.draftFromSkeleton(cat.tag, sk, { name: $('fName').value.trim() });
          applyAssistPatch({
            persona: draft.persona,
            greeting: $('fGreeting').value.trim() ? $('fGreeting').value : draft.greeting,
            examples: $('fExamples').value.trim() ? $('fExamples').value : draft.examples,
            systemPrompt: draft.systemPrompt,
            scenario: S.charKind === 'story' ? draft.scenario : $('fScenario').value
          });
          $('fTemp').value = draft.temperature;
          $('fTempVal').textContent = Number(draft.temperature).toFixed(2);
          refreshLint();
          toast('已套用骨架「' + sk.title + '」，改到像你自己的为止', 'ok', 3600);
        }
      };
    });
    acts.push({ icon: '✨', label: '让 AI 按这个分类自由发挥一版人设', run: function () { aiAssist('persona'); } });
    openActions('套骨架 · ' + cat.tag, acts);
  }

  /* ---------------------------------------------------------------------------
   * 创作者工具：引导式建卡向导（分类 → 骨架 → 起草 → 进编辑器）
   * ------------------------------------------------------------------------ */

  var CREATOR_STEP_NAMES = ['选分类', '挑骨架', '起草'];

  function openCreatorWizard() {
    S.creator.step = 1;
    S.creator.tag = '';
    S.creator.kind = '';
    S.creator.skeleton = null;
    S.creator.seed = '';
    openSheet($('creatorMask'));
    renderCreator();
    FYCreator.loadBundle().then(function () {
      /* 默认选中第一个分类，省一步点击 */
      if (!S.creator.tag) {
        var first = FYCreator.bundle().categories[0];
        S.creator.tag = first.tag;
        S.creator.kind = first.defaultKind;
        renderCreator();
      }
    }).catch(function (e) {
      $('creatorPanel').innerHTML = '';
      $('creatorPanel').appendChild(el('div', 'err', '分类模板加载失败：' + ((e && e.message) || e)));
    });
  }

  function renderCreator() {
    var steps = $('creatorSteps');
    steps.innerHTML = '';
    CREATOR_STEP_NAMES.forEach(function (n, i) {
      var state = S.creator.step === i + 1 ? ' on' : (S.creator.step > i + 1 ? ' done' : '');
      var box = el('div', 'step' + state);
      box.appendChild(el('span', 'step-num', String(i + 1)));
      box.appendChild(el('span', 'step-label', n));
      steps.appendChild(box);
    });
    var panel = $('creatorPanel');
    panel.innerHTML = '';
    $('btnCreatorBack').hidden = S.creator.step <= 1;
    $('btnCreatorNext').textContent = S.creator.step >= 3 ? '生成草稿 →' : '下一步 →';

    var b = FYCreator.bundle();
    if (!b) { panel.appendChild(el('div', 'muted sm', '正在加载分类模板…')); return; }

    if (S.creator.step === 1) renderCreatorStep1(panel, b);
    else if (S.creator.step === 2) renderCreatorStep2(panel, b);
    else renderCreatorStep3(panel, b);
  }

  function renderCreatorStep1(panel, b) {
    panel.appendChild(el('p', 'muted sm', '先选一个分类。分类不是装饰：它决定下面给你哪套骨架、哪些写作要点，也决定评分标准。'));
    var grid = el('div', 'wiz-grid');
    b.categories.forEach(function (cat) {
      var on = S.creator.tag === cat.tag;
      var card = el('button', 'wiz-card' + (on ? ' on' : ''));
      card.appendChild(el('span', 'wiz-emoji', cat.emoji));
      card.appendChild(el('span', 'wiz-name', cat.tag));
      card.appendChild(el('div', 'wiz-sub', cat.blurb));
      card.onclick = function () {
        S.creator.tag = cat.tag;
        S.creator.kind = cat.defaultKind;
        S.creator.skeleton = null;
        renderCreator();
      };
      grid.appendChild(card);
    });
    panel.appendChild(grid);

    var cat = FYCreator.category(S.creator.tag);
    if (cat) {
      panel.appendChild(el('div', 'divider'));
      var kinds = el('div', 'chips wrap');
      [['character', '角色卡', 'char'], ['story', '剧情卡', 'book']].forEach(function (pair) {
        var chip = el('button', 'chip' + (S.creator.kind === pair[0] ? ' on' : ''));
        chip.appendChild(iconEl(pair[2]));
        chip.appendChild(el('span', '', pair[1]));
        chip.onclick = function () { S.creator.kind = pair[0]; renderCreator(); };
        kinds.appendChild(chip);
      });
      panel.appendChild(el('div', 'label', '类型'));
      panel.appendChild(kinds);
      panel.appendChild(el('p', 'muted xs', '这个分类通常写成「' + (cat.defaultKind === 'story' ? '剧情卡' : '角色卡') + '」；核心张力是：' + cat.coreTension));
    }
  }

  function renderCreatorStep2(panel, b) {
    var cat = FYCreator.category(S.creator.tag);
    if (!cat) { panel.appendChild(el('div', 'muted sm', '先回上一步选个分类。')); return; }
    panel.appendChild(el('p', 'muted sm', '挑一个骨架当起点（不是成品，是让你少对着空白页发呆）。也可以不挑，直接手写。'));

    cat.skeletons.forEach(function (sk, i) {
      var on = S.creator.skeleton === i;
      var box = el('div', 'wiz-block' + (on ? ' on' : ''));
      box.appendChild(el('div', 'wiz-name', sk.title));
      box.appendChild(el('div', 'wiz-sub', sk.who));
      var kv = el('div', 'wiz-kv');
      kv.appendChild(el('div', '', '性格张力：' + sk.axis));
      kv.appendChild(el('div', '', '说话方式：' + sk.voice));
      kv.appendChild(el('div', '', '缺点：' + sk.flaw));
      kv.appendChild(el('div', '', '最在意：' + sk.care));
      kv.appendChild(el('div', '', '和你的起点：' + sk.hook));
      kv.appendChild(el('div', '', '开场场景：' + sk.scene));
      box.appendChild(kv);
      box.onclick = function () { S.creator.skeleton = on ? null : i; renderCreator(); };
      panel.appendChild(box);
    });

    if (cat.guide) {
      panel.appendChild(el('div', 'divider'));
      var g = cat.guide;
      var musts = el('div', 'lint-item ok', '必须做到：' + (g.must || []).join('；'));
      panel.appendChild(musts);
      panel.appendChild(el('div', 'lint-item warn', '最容易写崩：' + (g.avoid || []).join('；')));
    }
  }

  function renderCreatorStep3(panel, b) {
    var cat = FYCreator.category(S.creator.tag);
    var sk = (cat && S.creator.skeleton !== null && S.creator.skeleton !== undefined)
      ? cat.skeletons[S.creator.skeleton] : null;

    panel.appendChild(el('p', 'muted sm', '最后填两个东西。名字可以先随便写，进编辑器还能改。'));

    var f1 = el('div', 'field');
    f1.appendChild(el('label', 'label', '名字'));
    var nameInput = el('input', 'input');
    nameInput.id = 'creatorName';
    nameInput.placeholder = '例如：林夏';
    nameInput.value = (S.creator.name || '');
    nameInput.oninput = function () { S.creator.name = this.value; };
    f1.appendChild(nameInput);
    panel.appendChild(f1);

    var f2 = el('div', 'field');
    f2.appendChild(el('label', 'label', '一句话方向（可留空）'));
    var seedInput = el('textarea', 'input');
    seedInput.id = 'creatorSeed';
    seedInput.rows = 3;
    seedInput.placeholder = '例如：一个在深夜便利店上班的人，话很少，但记得每个熟客买什么';
    seedInput.value = S.creator.seed || '';
    seedInput.oninput = function () { S.creator.seed = this.value; };
    f2.appendChild(seedInput);
    panel.appendChild(f2);

    var summary = el('div', 'wiz-block');
    summary.appendChild(el('div', 'wiz-name', (cat ? cat.emoji + ' ' + cat.tag : '未选分类') + ' · ' + (S.creator.kind === 'story' ? '剧情卡' : '角色卡')));
    summary.appendChild(el('div', 'wiz-sub', sk ? ('骨架：' + sk.title) : '不使用骨架（自由发挥）'));
    panel.appendChild(summary);

    var row = el('div', 'row gap wrap');
    var btnDraft = el('button', 'btn btn-sm btn-primary');
    btnDraft.appendChild(iconEl('template'));
    btnDraft.appendChild(el('span', '', '生成草稿'));
    btnDraft.onclick = function () { makeDraft(false); };
    var btnAi = el('button', 'btn btn-sm');
    btnAi.appendChild(iconEl('sparkle'));
    btnAi.appendChild(el('span', '', '让 AI 直接写一版'));
    btnAi.onclick = function () { makeDraft(true); };
    row.appendChild(btnDraft);
    row.appendChild(btnAi);
    panel.appendChild(row);

    panel.appendChild(el('p', 'muted xs', '「生成草稿」= 用模板和骨架拼出一版可以改的初稿；「让 AI 写」= 额外调用你配置的模型（本地或云端）扩写。没有模型也能用前者。'));
  }

  /** 从向导收尾：拼草稿 → 打开编辑器 */
  function makeDraft(useAi) {
    var cat = FYCreator.category(S.creator.tag);
    if (!cat) { toast('先选一个分类', 'warn'); return; }
    var sk = (S.creator.skeleton !== null && S.creator.skeleton !== undefined)
      ? cat.skeletons[S.creator.skeleton] : null;
    var seed = { name: (S.creator.name || '').trim() };
    var draft;
    if (sk) {
      draft = FYCreator.draftFromSkeleton(cat.tag, sk, seed);
    } else {
      /* 不用骨架也要给一份像样的底：分类要点直接变成系统提示词 */
      draft = {
        name: seed.name,
        avatar: cat.emoji,
        tagline: '',
        persona: '',
        greeting: '',
        scenario: '',
        examples: '',
        systemPrompt: FYCreator.composeSystemPrompt(seed.name, cat, {}),
        temperature: cat.defaultTemp,
        tags: cat.suggestedTags.slice(0, FYCreator.GATE.tagsMax),
        kind: S.creator.kind || cat.defaultKind,
        plot: (S.creator.kind || cat.defaultKind) === 'story'
      };
    }
    draft.kind = S.creator.kind || cat.defaultKind;
    draft.plot = draft.kind === 'story';
    if (draft.kind === 'character') draft.scenario = '';
    closeSheet($('creatorMask'));
    openCharSheet(null, draft);
    if (useAi) {
      toast('先按模板填好了，正在让 AI 改写…', 'ok', 2600);
      setTimeout(function () { aiAssist('all'); }, 400);
    } else {
      toast('草稿已生成：改到像你自己的为止', 'ok', 3000);
    }
  }

  function creatorNext() {
    if (S.creator.step === 1 && !S.creator.tag) { toast('先选一个分类', 'warn'); return; }
    if (S.creator.step >= 3) { makeDraft(false); return; }
    S.creator.step++;
    renderCreator();
  }

  function creatorBack() {
    if (S.creator.step <= 1) return;
    S.creator.step--;
    renderCreator();
  }

  /* ---------------------------------------------------------------------------
   * 灵感 · 公开参考面板
   *
   * 边界（很重要，别越界）：
   *   - 只借鉴「模式」：标签体系、结构、写法统计；
   *   - 不抓取、不展示、不打包任何第三方卡片正文；
   *   - 每个来源都必须标出许可证，界面上要能让用户看见。
   * ------------------------------------------------------------------------ */

  var refIndexCache = null;

  function loadRefIndex() {
    if (refIndexCache) return Promise.resolve(refIndexCache);
    return fetch('creator/reference.json').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (idx) {
      refIndexCache = idx || { sources: [] };
      return refIndexCache;
    });
  }

  function openRefSheet() {
    openSheet($('refMask'));
    var note = $('refNote');
    if (note) {
      note.textContent = '只借鉴模式，不复制正文：这里展示的是公开来源的标签、结构与写法统计，' +
        '用来找灵感；你写出来的仍然是自己的原创卡（CC0）。每个来源都标了许可证。';
    }
    loadRefIndex().then(function (idx) {
      var sources = (idx.sources || []).filter(function (s) { return s && s.id; });
      if (!S.refCurrent && sources.length) S.refCurrent = sources[0].id;
      renderRefSources(sources);
      loadReference();
    }).catch(function (e) {
      $('refSources').innerHTML = '';
      $('refBody').innerHTML = '';
      $('refBody').appendChild(el('div', 'err', '参考来源加载失败：' + ((e && e.message) || e)));
    });
  }

  function renderRefSources(sources) {
    var box = $('refSources');
    box.className = 'chips wrap';
    box.innerHTML = '';
    sources.forEach(function (s) {
      var chip = el('button', 'chip' + (S.refCurrent === s.id ? ' on' : ''), s.name || s.id);
      chip.title = (s.license ? '许可：' + s.license + '\n' : '') + (s.note || '');
      chip.onclick = function () {
        S.refCurrent = s.id;
        renderRefSources(sources);
        loadReference();
      };
      box.appendChild(chip);
    });
  }

  function loadReference() {
    var body = $('refBody');
    if (!body) return;
    body.innerHTML = '';
    body.appendChild(el('div', 'muted sm', '正在拉取…'));
    if (!global.FYCreator) return;
    loadRefIndex().then(function (idx) {
      var src = (idx.sources || []).filter(function (s) { return s.id === S.refCurrent; })[0];
      if (!src) throw new Error('没有这个来源');
      if (src.kind === 'local') { renderLocalRef(src, body); return; }
      fetchRemoteRef(src, body);
    }).catch(function (e) {
      body.innerHTML = '';
      body.appendChild(el('div', 'err', '拉取失败：' + ((e && e.message) || e)));
      body.appendChild(el('div', 'muted xs', '离线也照样能用：分类模板与写作要点都随 App 打包，不依赖网络。'));
    });
  }

  /* ---------- 本地来源：从自己已有的角色里现算样式统计 ---------- */

  function renderLocalRef(src, body) {
    body.innerHTML = '';
    var chars = S.characters || [];
    body.appendChild(el('p', 'muted sm', src.note || ''));

    if (!chars.length) {
      body.appendChild(el('div', 'lint-item warn',
        '你还没有任何角色。先去「📦 卡包」一键导入内置的 160 张，这里就能统计出各类角色的人设长度和开场白写法。'));
      return;
    }

    var tagCount = {};
    var personaLens = [];
    var greetLens = [];
    var withExamples = 0;
    var openers = {};
    chars.forEach(function (c) {
      (c.tags && c.tags.length ? c.tags : ['未分类']).forEach(function (t) {
        tagCount[t] = (tagCount[t] || 0) + 1;
      });
      personaLens.push((c.persona || '').replace(/\s/g, '').length);
      var g = (c.greeting || '').replace(/\s/g, '');
      greetLens.push(g.length);
      if ((c.examples || '').length >= 40) withExamples++;
      var head = g.slice(0, 6);
      if (head) openers[head] = (openers[head] || 0) + 1;
    });

    function median(arr) {
      if (!arr.length) return 0;
      var a = arr.slice().sort(function (x, y) { return x - y; });
      return a[Math.floor(a.length / 2)];
    }

    var stats = el('div', 'ref-item');
    stats.appendChild(el('div', 'ref-title', '你的角色库：' + chars.length + ' 张'));
    stats.appendChild(el('div', 'ref-meta',
      '人设中位长度 ' + median(personaLens) + ' 字 · 开场白中位长度 ' + median(greetLens) + ' 字 · ' +
      '带示例对话 ' + withExamples + ' 张（' + Math.round(withExamples / chars.length * 100) + '%）'));
    body.appendChild(stats);

    var tags = Object.keys(tagCount).map(function (t) { return { tag: t, n: tagCount[t] }; })
      .sort(function (a, b) { return b.n - a.n; });
    var tagItem = el('div', 'ref-item');
    tagItem.appendChild(el('div', 'ref-title', '分类分布'));
    tagItem.appendChild(el('div', 'ref-meta', '标签越集中，说明你的口味越明确；想突破就到向导里换个分类试试。'));
    var chips = el('div', 'ref-tags');
    tags.slice(0, 24).forEach(function (t) {
      chips.appendChild(el('span', 'ref-tag', t.tag + ' ' + t.n));
    });
    tagItem.appendChild(chips);
    body.appendChild(tagItem);

    var openerRows = Object.keys(openers).map(function (k) { return { k: k, n: openers[k] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
    var opItem = el('div', 'ref-item');
    opItem.appendChild(el('div', 'ref-title', '开场白起手式 Top ' + openerRows.length));
    opItem.appendChild(el('div', 'ref-meta', '开头雷同是最容易被察觉的"AI 味"。如果你的开场白都从同一句起手，换一个动作开场。'));
    var opTags = el('div', 'ref-tags');
    openerRows.forEach(function (r) { opTags.appendChild(el('span', 'ref-tag', r.k + '… ×' + r.n)); });
    opItem.appendChild(opTags);
    body.appendChild(opItem);

    var tip = el('div', 'ref-item');
    tip.appendChild(el('div', 'ref-title', '拿这些数字做什么'));
    tip.appendChild(el('div', 'ref-meta',
      '人设比中位数短很多 → 大概率撑不住三轮对话；开场白明显偏长 → 模型容易跟着啰嗦。' +
      '这些是"风格校准"，不是硬标准。'));
    body.appendChild(tip);
  }

  /* ---------- 联网来源：只取标题/标签这类结构信息 ---------- */

  function refFetchJson(url) {
    /* 刻意不加任何自定义请求头：保持"简单请求"，浏览器不会先发 OPTIONS 预检。
       预检一旦被对方拦掉，面板就整个不可用，不值得为省一点带宽冒这个险。 */
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchRemoteRef(src, body) {
    var q = ($('refQuery') && $('refQuery').value || '').trim();
    var url = String(src.url || '');
    if (!url) throw new Error('这个来源没配地址');
    url = url.replace('{q}', encodeURIComponent(q));
    if (!q && src.urlNoQuery) url = src.urlNoQuery;

    var chain = src.format === 'text'
      ? fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      : refFetchJson(url);

    return chain.then(function (data) {
      renderRemoteRef(src, data, body, url);
    }).catch(function (e) {
      body.innerHTML = '';
      body.appendChild(el('div', 'err', '拉取失败：' + ((e && e.message) || e) +
        '（网络不通、来源改了接口、或该来源不允许跨域都会这样）'));
      var tip = el('div', 'ref-item');
      tip.appendChild(el('div', 'ref-title', '离线方案'));
      tip.appendChild(el('div', 'ref-meta',
        '分类模板、骨架、写作要点、质量评分全部是本地功能，不联网也能用完整流程。'));
      body.appendChild(tip);
    });
  }

  /** 按点号路径取值（"data.nodes" / "license.spdx_id" 都可以） */
  function pickPath(obj, path) {
    if (path === undefined || path === null || path === '') return obj;
    var cur = obj;
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return null;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /** 把 {a:{...},b:{...}} 这种对象展开成 [{key:'a',...},…]：
      远程来源给数组也行（GitHub items、chub nodes）、给「字段名→定义」的对象也行（HF schema）。 */
  function asItemList(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      return Object.keys(v).map(function (k) {
        var val = v[k];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          return Object.assign({ key: k }, val);
        }
        return { key: k, value: val };
      });
    }
    return [];
  }

  /** 模板替换：'★{starCount} · 许可：{license.spdx_id}' */
  function fillTemplate(tpl, item) {
    return String(tpl).replace(/\{([^}]+)\}/g, function (_, path) {
      var v = pickPath(item, path.trim());
      if (v === null || v === undefined || v === '') return '—';
      return String(v);
    });
  }

  /** 客户端过滤：来源可以用 {field, eq|ne} 剔掉不该显示的内容（例如成人向标记） */
  function passesRefFilter(src, item) {
    var fs = src && src.filter;
    if (!Array.isArray(fs) || !fs.length) return true;
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i] || {};
      if (!f.field) continue;
      var v = pickPath(item, f.field);
      if (Object.prototype.hasOwnProperty.call(f, 'eq') && v !== f.eq) return false;
      if (Object.prototype.hasOwnProperty.call(f, 'ne') && v === f.ne) return false;
    }
    return true;
  }

  function renderRemoteRef(src, data, body, url) {
    body.innerHTML = '';
    var all = asItemList(pickPath(data, src.itemsPath));
    var list = all.filter(function (it) { return passesRefFilter(src, it); });
    var dropped = all.length - list.length;

    var head = el('div', 'ref-item');
    head.appendChild(el('div', 'ref-title', src.name || '参考来源'));
    head.appendChild(el('div', 'ref-meta',
      '许可：' + (src.license || '未标注（谨慎使用）') +
      ' · 取到 ' + list.length + ' 条结构信息' +
      (dropped > 0 ? '（按内容标记过滤掉 ' + dropped + ' 条）' : '') +
      ' · 只展示标题与标签这类结构信息，不展示正文'));
    if (src.note) head.appendChild(el('div', 'ref-meta', src.note));
    body.appendChild(head);

    if (!list.length) {
      body.appendChild(el('div', 'lint-item warn',
        '这个来源没有返回可用的条目（可能接口改了、关键词没匹配上，或返回的内容都被过滤了）。'));
      return;
    }

    var map = src.map || {};
    var labels = src.labels || {};
    var descs = src.descs || {};
    var limit = Math.min(Number(src.limit) || 20, list.length);
    for (var i = 0; i < limit; i++) {
      var it = list[i] || {};
      var key = it.key;
      var title = map.title ? pickPath(it, map.title) : null;
      if (title === undefined || title === null || title === '') title = key;
      if (key && labels[key]) title = title + ' · ' + labels[key];
      var sub = map.sub ? pickPath(it, map.sub) : ((key && descs[key]) ? descs[key] : '');
      var meta = map.meta ? fillTemplate(map.meta, it) : '';
      var tags = map.tags ? pickPath(it, map.tags) : null;

      var item = el('div', 'ref-item');
      item.appendChild(el('div', 'ref-title', String(title || ('条目 ' + (i + 1))).slice(0, 90)));
      if (sub) item.appendChild(el('div', 'ref-meta', String(sub).slice(0, 160)));
      if (meta) item.appendChild(el('div', 'ref-meta', String(meta).slice(0, 120)));
      if (Array.isArray(tags) && tags.length) {
        var box = el('div', 'ref-tags');
        tags.slice(0, 12).forEach(function (t) { box.appendChild(el('span', 'ref-tag', String(t).slice(0, 20))); });
        item.appendChild(box);
      }
      body.appendChild(item);
    }
    var foot = el('div', 'muted xs');
    foot.textContent = '来源：' + url;
    body.appendChild(foot);
  }

  /* ---------- 角色卡导入 / 导出（chara_card_v2，见 cards.js） ---------- */

  /** 角色列表整体刷新一次（导入结束后统一调用，别每张卡渲染一遍） */
  function refreshCharList() {
    S.characters = S.store.listCharacters();
    S.charCount = -1;                 // 让分类 chips 重新统计
    renderCharCats();
    renderCharacters();
  }

  /** 名字 → 库里已有的那张卡（覆盖导入时用来原地改，保住 id、收藏和聊天记录） */
  function importedNameMap() {
    var m = {};
    var list = (S.store && S.store.listCharacters()) || S.characters || [];
    list.forEach(function (c) { if (c && c.name && !m[c.name]) m[c.name] = c; });
    return m;
  }

  /**
   * 批量导入一批已归一化的卡片（内部字段，不是 chara_card_v2 原始结构）。
   *
   * 三万张卡的场景下，"每张卡 saveCharacter + renderCharacters" 是 O(n²)：
   * 这里改成 store.saveCharacters 一次事务批量写、进度写进状态栏、**不碰 DOM 列表**
   * （由调用方在整批结束后 refreshCharList() 一次）。
   *
   * @param {Array}  cards  FYCards 归一化后的卡片
   * @param {object} opts   {statusEl, onProgress(processed,total), overwrite}
   *        overwrite=true 时同名卡会被新内容原地覆盖（沿用旧 id，保留收藏与聊天记录），
   *        默认 false：同名跳过，保证重复导入幂等。
   * @returns {{added:number, skipped:number, replaced:number}}
   */
  function importCardsBatch(cards, opts) {
    var o = opts || {};
    var st = o.statusEl || $('packStatus');
    var list = Array.isArray(cards) ? cards : [];
    var have = importedNames();
    var owners = o.overwrite ? importedNameMap() : null;
    var pending = [];
    var skipped = 0, replaced = 0;
    for (var i = 0; i < list.length; i++) {
      var card = list[i];
      if (!card || !card.name) continue;
      if (have[card.name]) {
        /* 默认：同名视为同一张卡，跳过（导入幂等）。
           勾了"覆盖"：把新内容写回原来那张卡（沿用同一个 id），
           用户改过的收藏、以及跟它的聊天记录都留着，只有卡片内容被新卡替换。 */
        var old = owners && owners[card.name];
        if (!old) { skipped++; continue; }
        card = Object.assign({}, card, { id: old.id, fav: old.fav, createdAt: old.createdAt });
        replaced++;
      }
      have[card.name] = 1;
      pending.push(card);
    }
    var total = list.length;
    var processed = skipped;
    var res = S.store.saveCharacters(pending, function (done, n) {
      processed = skipped + done;
      if (st && (done % 20 === 0 || done === n)) st.textContent = '已导入 ' + processed + ' / ' + total;
      if (o.onProgress) { try { o.onProgress(processed, total); } catch (e) { /* 进度回调不许打断导入 */ } }
    });
    if (st && total) st.textContent = '已导入 ' + processed + ' / ' + total;
    return { added: res.saved, skipped: skipped, replaced: replaced };
  }

  /** 把一段卡片 JSON 文本导入成角色，返回导入数量。 */
  function importCardsFromText(text, srcName) {
    var cards;
    try {
      cards = FYCards.parseCards(text);
    } catch (e) {
      toast('导入失败：' + ((e && e.message) || e), 'err', 3800);
      fyLog('角色卡解析失败：' + ((e && e.message) || e));
      return 0;
    }
    var res = importCardsBatch(cards, { statusEl: $('packStatus') });
    refreshCharList();
    if (res.added === 1) toast('已导入「' + cards[0].name + '」', 'ok', 3000);
    else toast('已导入 ' + res.added + ' 个角色', 'ok', 3000);
    fyLog('角色卡导入：来源=' + (srcName || '?') + ' 数量=' + res.added);
    return res.added;
  }

  /* ---------- 聊天记录搜索（走 store.searchMessages：后端有检索就用后端，否则走内存） ---------- */

  var searchTimer = null;

  function openSearchSheet() {
    var inp = $('searchInput');
    var list = $('searchList');
    if (list) list.innerHTML = '';
    var st = $('searchStatus');
    if (st) st.textContent = '输入关键词开始搜索（搜索的是全部会话的聊天记录）';
    if (inp) inp.value = '';
    openSheet($('searchMask'));
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 150);
  }

  function closeSearchSheet() { closeSheet($('searchMask')); }

  function snippet(text, q) {
    var t = String(text || '').replace(/\s+/g, ' ');
    var i = t.toLowerCase().indexOf(String(q).toLowerCase());
    if (i < 0) return t.slice(0, 60);
    var from = Math.max(0, i - 16);
    return (from > 0 ? '…' : '') + t.slice(from, from + 72) + (t.length > from + 72 ? '…' : '');
  }

  function runSearch() {
    var q = ($('searchInput').value || '').trim();
    var box = $('searchList');
    var st = $('searchStatus');
    box.innerHTML = '';
    if (!q) { st.textContent = '输入关键词开始搜索（搜索的是全部会话的聊天记录）'; return; }
    Promise.resolve(S.store.searchMessages(q, 60)).then(function (hits) {
      if (!hits.length) { st.textContent = '没有找到包含「' + q + '」的消息'; return; }
      st.textContent = '找到 ' + hits.length + ' 条（最多显示 60 条，点一条跳到对应会话）';
      hits.forEach(function (m) {
        var sess = S.store.getSession(m.sessionId) || {};
        var who = m.role === 'user' ? '我' : (m.speakerName || '角色');
        var row = el('div', 'model-row');
        var col = el('div', 'grow');
        col.appendChild(el('div', 'model-name', who + ' · ' + (sess.title || '会话')));
        col.appendChild(el('div', 'model-size', snippet(m.content, q)));
        var when = el('div', 'model-size', new Date(m.ts || Date.now()).toLocaleString('zh-CN'));
        col.appendChild(when);
        row.appendChild(col);
        row.onclick = function () {
          closeSearchSheet();
          openSessionById(m.sessionId);
        };
        box.appendChild(row);
      });
    }).catch(function (e) {
      st.textContent = '搜索失败：' + ((e && e.message) || e);
    });
  }

  /** 打开指定会话（搜索结果跳转用） */
  function openSessionById(sid) {
    var s = S.store.getSession(sid);
    if (!s) { toast('这个会话已经不存在了', 'warn'); return false; }
    /* 角色列表可能刚被导入/删除过（例如刚导完卡就直接进会话），
       不刷新的话会话头部会误显示「角色已删除」 */
    S.characters = S.store.listCharacters();
    S.session = s;
    S.store.setActiveSessionId(sid);
    S.messages = S.store.listMessages(sid);
    switchView('chat');
    renderChatHeader();
    renderMessages();
    return true;
  }

  /* ==========================================================================
   * 首次引导（三选一）
   * 风月本身不含模型，新用户第一件事必须选来源。给三条清晰的路，选完自动跳到对应位置，
   * 不让人在设置页里自己找。
   * ======================================================================== */

  function maybeShowOnboarding() {
    if (!S.settings || S.settings.onboarded) return;
    if (providerReady() || S.models.length) return;   // 已经能用，就别打扰
    openSheet($('onboardMask'));
  }

  function finishOnboarding(pick) {
    S.settings = S.store.saveSettings({ onboarded: true });
    closeSheet($('onboardMask'));
    if (pick === 'cloud') {
      switchView('settings');
      $('selProviderMode').value = 'remote';
      $('remoteBox').hidden = false;
      $('selPreset').value = DEFAULT_PRESET;
      $('selRemoteModel').value = '';        /* 明确选了服务商，模型名按该预设重置 */
      applyPreset(DEFAULT_PRESET);
      /* 同步 S.provider：否则 renderProviderUI 会按旧配置把模式拨回「内置引擎」 */
      S.provider = Object.assign({}, provider(), { mode: 'remote' });
      renderProviderUI();
      toast('已选好 DeepSeek：把 API Key 粘进来即可', 'ok', 3600);
    } else if (pick === 'local') {
      switchView('settings');
      toast('到「模型管理」下载内置的 0.5B（约 0.5GB）', 'ok', 3600);
    } else if (pick === 'lan') {
      switchView('settings');
      $('selProviderMode').value = 'remote';
      $('remoteBox').hidden = false;
      $('selPreset').value = 'ollama';
      $('selRemoteModel').value = '';
      applyPreset('ollama');
      S.provider = Object.assign({}, provider(), { mode: 'remote' });
      renderProviderUI();
      toast('把地址里的 IP 换成你电脑的即可', 'ok', 3600);
    }
  }

  /* ==========================================================================
   * 顶栏快速切换模型来源
   * 换模型不该每次都钻进设置页；顶栏那颗状态胶囊现在点开就是切换面板。
   * ======================================================================== */

  function openBackendSheet() {
    openSheet($('backendMask'));
    renderBackendSheet();
  }

  function renderBackendSheet() {
    var list = $('backendList');
    var st = $('backendStatus');
    var p = provider();
    list.innerHTML = '';
    st.textContent = isRemote()
      ? ('当前：外部服务 · ' + (p.model || '（未选模型）') + ' @ ' + p.baseUrl)
      : ('当前：内置引擎 · ' + (S.settings.model || '（未选模型）'));

    /* 本地引擎 */
    var rowL = el('div', 'model-row' + (!isRemote() ? ' on' : ''));
    var icoL = el('span', 'row-ico');
    icoL.appendChild(iconEl('phone'));
    rowL.appendChild(icoL);
    var colL = el('div', 'grow');
    colL.appendChild(el('div', 'model-name', '内置引擎（本地 GGUF · 离线）'));
    colL.appendChild(el('div', 'model-size', S.models.length
      ? ('本机有 ' + S.models.length + ' 个模型，点右侧切换/启动')
      : '本机还没有模型；到设置里下载 0.5B 或导入任意 GGUF'));
    rowL.appendChild(colL);
    var bL = el('button', 'btn btn-xs', isRemote() ? '切回' : '重启');
    bL.onclick = function () {
      S.provider = { mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false };
      try { fyCall('setProvider', [JSON.stringify({ mode: 'local', baseUrl: '', apiKey: '', model: '' })]); } catch (e) {}
      var m = S.settings.model || (S.models[0] && S.models[0].name);
      if (m) startEngine(m);
      toast('已切回内置引擎' + (m ? '：' + m : ''), 'ok', 2600);
      renderBackendSheet();
    };
    rowL.appendChild(bL);
    list.appendChild(rowL);

    /* 本机模型逐个列出（点了直接启动） */
    (S.models || []).forEach(function (m) {
      var row = el('div', 'model-row' + (!isRemote() && S.settings.model === m.name ? ' on' : ''));
      var col = el('div', 'grow');
      col.appendChild(el('div', 'model-name', '   ' + m.name));
      col.appendChild(el('div', 'model-size', fmtSize(m.sizeBytes)));
      row.appendChild(col);
      var b = el('button', 'btn btn-xs', (!isRemote() && S.settings.model === m.name && engineReady()) ? '使用中' : '启动');
      b.onclick = function () {
        S.provider = { mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false };
        try { fyCall('setProvider', [JSON.stringify({ mode: 'local', baseUrl: '', apiKey: '', model: '' })]); } catch (e) {}
        startEngine(m.name);
        toast('正在启动 ' + m.name, 'ok', 2600);
      };
      row.appendChild(b);
      list.appendChild(row);
    });

    /* 外部服务 */
    var rowR = el('div', 'model-row' + (isRemote() ? ' on' : ''));
    var icoR = el('span', 'row-ico');
    icoR.appendChild(iconEl('cloud'));
    rowR.appendChild(icoR);
    var colR = el('div', 'grow');
    colR.appendChild(el('div', 'model-name', '外部服务（DeepSeek / 豆包 / 局域网…）'));
    colR.appendChild(el('div', 'model-size', p.baseUrl
      ? ((p.model || '（未选模型）') + ' @ ' + p.baseUrl + (p.hasKey ? ' · 带 Key' : ''))
      : '还没配置：去设置里选个服务商，填地址（和 Key）即可'));
    rowR.appendChild(colR);
    var bR = el('button', 'btn btn-xs', isRemote() ? '使用中' : (p.ready ? '启用' : '去配置'));
    bR.onclick = function () {
      if (p.ready && p.baseUrl) {
        S.provider = p;
        toast('已切到外部服务：' + (p.model || ''), 'ok', 2600);
        closeSheet($('backendMask'));
        return;
      }
      closeSheet($('backendMask'));
      switchView('settings');
      $('selProviderMode').value = 'remote';
      $('remoteBox').hidden = false;
      $('selPreset').value = DEFAULT_PRESET;
      applyPreset(DEFAULT_PRESET);
    };
    rowR.appendChild(bR);
    list.appendChild(rowR);
  }

  /* ==========================================================================
   * 斜杠快捷指令（/继续 /重写 /摘要 /导出 /清空）
   * 参考常见网页版聊天工具的"命令面板"思路，但只做真正用得上的几条。
   * ======================================================================== */

  var SLASH = [
    { cmd: '/继续', hint: '让角色接着上一条继续说', run: function () { continueLast(); } },
    { cmd: '/重写', hint: '重新生成上一条回复', run: function () { regenerateLast(); } },
    { cmd: '/摘要', hint: '把较早的对话压缩成长期记忆', run: function () { compressMemory(true); } },
    { cmd: '/导出', hint: '把这段对话存成 Markdown 到 Download', run: function () { exportChatMarkdown(); } },
    { cmd: '/清空', hint: '清空当前会话的消息（不可撤销）', run: clearCurrentSession },
    { cmd: '/帮助', hint: '看看都有哪些指令', run: showSlashHelp }
  ];

  function slashMatches(text) {
    var t = String(text || '');
    if (t.charAt(0) !== '/') return [];
    return SLASH.filter(function (c) { return c.cmd.indexOf(t.split(' ')[0]) === 0; });
  }

  function renderSlashBar() {
    var bar = $('slashBar');
    var inp = $('input');
    var list = slashMatches(inp ? inp.value : '');
    if (!list.length) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.innerHTML = '';
    list.forEach(function (c) {
      var b = el('button', 'chip', c.cmd + '  ' + c.hint);
      b.onclick = function () {
        inp.value = c.cmd;
        autoGrowInput();
        bar.hidden = true;
      };
      bar.appendChild(b);
    });
    bar.hidden = false;
  }

  /** 输入的是整条指令（可以带参数）就直接执行，不发给模型 */
  function tryRunSlash(text) {
    var t = String(text || '').trim();
    if (t.charAt(0) !== '/') return false;
    var head = t.split(/\s+/)[0];
    for (var i = 0; i < SLASH.length; i++) {
      if (SLASH[i].cmd === head) {
        $('input').value = '';
        autoGrowInput();
        $('slashBar').hidden = true;
        SLASH[i].run(t.slice(head.length).trim());
        return true;
      }
    }
    toast('没有这条指令，输入 /帮助 看看', 'warn', 2200);
    return false;
  }

  function showSlashHelp() {
    openActions('斜杠指令', SLASH.map(function (c) {
      return { icon: '›', label: c.cmd + ' — ' + c.hint, run: function () { c.run(); } };
    }));
  }

  /** 继续生成：接着最后一条助手消息往下写（追加而不是新发一条） */
  function continueLast() {
    if (!S.session) { toast('先选一个角色', 'warn'); return; }
    if (!providerReady()) { toast(isRemote() ? '外部模型未配置好' : '引擎未就绪', 'warn'); return; }
    var msgs = S.messages || [];
    var last = null;
    for (var i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'assistant') { last = msgs[i]; break; } }
    if (!last) { toast('还没有可继续的回复', 'warn'); return; }
    continueFromMessage(last);
  }

  function regenerateLast() {
    var msgs = S.messages || [];
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') { regenerateFrom(msgs[i].id); return; }
    }
    toast('还没有可重写的回复', 'warn');
  }

  function clearCurrentSession() {
    if (!S.session) { toast('先选一个角色', 'warn'); return; }
    confirmAction('清空这段对话', '会删掉当前会话的全部消息（角色和设置不受影响）。', '清空', function () {
      S.store.clearSessionMessages(S.session.id);
      S.messages = S.store.listMessages(S.session.id);
      S.lastOptions = [];
      renderMessages();
      renderOptionsBar();
      toast('已清空', 'ok');
    });
  }

  /* ==========================================================================
   * 导出对话为 Markdown
   * ======================================================================== */

  function chatToMarkdown(session, messages) {
    var chars = (session.characterIds || []).map(charById).filter(Boolean);
    var out = [];
    out.push('# ' + (session.title || '对话'));
    out.push('');
    out.push('- 时间：' + new Date().toLocaleString('zh-CN'));
    out.push('- 角色：' + (chars.length ? chars.map(function (c) { return c.name; }).join('、') : '（已删除）'));
    out.push('- 模式：' + (session.mode === 'group' ? '群聊' : '单聊') + (session.plot ? ' · 剧情模式' : ''));
    out.push('- 消息数：' + messages.length);
    out.push('');
    out.push('---');
    out.push('');
    messages.forEach(function (m) {
      var who = m.role === 'user' ? '我' : (m.speakerName || (chars[0] && chars[0].name) || '角色');
      var when = m.ts ? new Date(m.ts).toLocaleString('zh-CN') : '';
      out.push('**' + who + '**' + (when ? '  ·  ' + when : ''));
      out.push('');
      out.push(String(m.content || '').trim());
      out.push('');
    });
    out.push('---');
    out.push('');
    out.push('_由 风月·本地版 导出_');
    return out.join('\n');
  }

  function exportChatMarkdown() {
    if (!S.session) { toast('先选一个角色', 'warn'); return; }
    var msgs = S.messages || S.store.listMessages(S.session.id);
    if (!msgs.length) { toast('这段对话还是空的', 'warn'); return; }
    var md = chatToMarkdown(S.session, msgs);
    var name = (S.session.title || '对话').replace(/[\\/:*?"<>|]/g, '_') + '-对话.md';
    var r = asObj(fyCall('saveText', [name, md]));
    if (r && r.ok) toast('已导出到 Download：' + name, 'ok', 4000);
    else toast('导出失败' + (r && r.path ? '（' + r.path + '）' : ''), 'err', 3600);
    fyLog('导出对话：' + name + ' ' + md.length + ' 字');
  }

  /* ---------- 模型来源 / 自定义下载 ---------- */

  /** 从下载链接推导文件名（魔搭/HF 的直链都带文件名；没有就兜底） */
  function modelNameFromUrl(url) {
    var u = String(url || '').trim().split('#')[0].split('?')[0];
    var seg = u.substring(u.lastIndexOf('/') + 1);
    try { seg = decodeURIComponent(seg); } catch (e) {}
    seg = seg.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
    if (!/\.gguf$/i.test(seg)) {
      if (!seg) seg = 'custom-model';
      seg = seg + '.gguf';
    }
    return seg.slice(0, 96);
  }

  function applyPreset(key) {
    var ps = PROVIDER_PRESETS[key];
    if (!ps) return;
    $('setRemoteBase').value = ps.url;
    if (ps.model && !$('selRemoteModel').value.trim()) $('selRemoteModel').value = ps.model;
    $('selRemoteModel').placeholder = ps.model
      ? ('例如 ' + ps.model) : '例如 doubao-seed-1-6-250615 或 ep-2025xxxx-xxxxx';
    $('providerStatus').textContent = ps.name + '：' + ps.hint;
  }

  /** 当前地址对应的预设 key（用于把下拉恢复到正确选项） */
  function presetKeyFor(url) {
    var u = String(url || '').replace(/\/+$/, '');
    for (var k in PROVIDER_PRESETS) {
      if (PROVIDER_PRESETS[k].url.replace(/\/+$/, '') === u) return k;
    }
    return '';
  }

  function renderProviderUI() {
    var sel = $('selProviderMode');
    if (!sel) return;
    var p = provider();
    sel.value = p.mode === 'remote' ? 'remote' : 'local';
    $('remoteBox').hidden = p.mode !== 'remote';
    if (p.baseUrl && !$('setRemoteBase').value) $('setRemoteBase').value = p.baseUrl;
    /* 模型名：可手填的输入框 + datalist 候选（拉不到列表也能用） */
    if (p.model) $('selRemoteModel').value = p.model;
    $('remoteModelList').innerHTML = '';
    /* 首次打开外部服务表单：直接按默认预设（DeepSeek）把地址填好，
       省得用户自己去查 base url；下拉也同步选中 */
    var key = presetKeyFor(p.baseUrl || $('setRemoteBase').value);
    if (!key && !(p.baseUrl || '').trim()) {
      key = DEFAULT_PRESET;
      if (!(p.model || '').trim()) applyPreset(key);
    }
    $('selPreset').value = key;
    if (p.mode === 'remote' && p.ready) {
      $('providerStatus').textContent = '已启用外部服务：' + p.baseUrl + ' · 模型 ' + p.model
        + (p.hasKey ? ' · 带 API Key' : ' · 无 Key');
    }
  }

  function testProviderRemote() {
    var base = $('setRemoteBase').value.trim();
    var key = $('setRemoteKey').value.trim();
    var st = $('providerStatus');
    st.textContent = '正在连接 ' + base + ' …';
    var r = asObj(fyCall('testProvider', [JSON.stringify({ baseUrl: base, apiKey: key })])) || {};
    if (!r.ok && !r.message) { st.textContent = '测试失败：没有拿到响应（原生桥可用吗？）'; return; }
    if (!r.ok) { st.textContent = '连不上：' + (r.message || '未知错误'); return; }
    var list = r.models || [];
    var dl = $('remoteModelList');
    dl.innerHTML = '';
    list.forEach(function (id) {
      var o = document.createElement('option');
      o.value = id; dl.appendChild(o);
    });
    if (!list.length) {
      var st = $('providerStatus');
      st.textContent = '地址通了（' + (r.resolvedBase || base) + '）但上游没返回模型列表'
        + ' —— 有些服务（如火山方舟）就不提供列表，直接手填模型名保存即可';
    } else {
      st.textContent = '连通 · ' + (r.resolvedBase || base) + ' · 发现 ' + list.length + ' 个模型（下面可选可填）';
      if (list.length === 1 && !$('selRemoteModel').value) $('selRemoteModel').value = list[0];
    }
    fyLog('外部模型服务连通：' + (r.resolvedBase || base) + ' 模型数=' + list.length);
  }

  function saveProvider() {
    var mode = $('selProviderMode').value;
    var payload = {
      mode: mode,
      baseUrl: (mode === 'remote') ? $('setRemoteBase').value.trim() : '',
      apiKey: (mode === 'remote') ? $('setRemoteKey').value.trim() : '',
      model: (mode === 'remote') ? ($('selRemoteModel').value || '').trim() : ''
    };
    if (mode === 'remote' && (!payload.baseUrl || !payload.model)) {
      toast('外部服务要先填地址和模型名（拉不到列表就直接手填）', 'warn', 3600);
      return;
    }
    var back = asObj(fyCall('setProvider', [JSON.stringify(payload)]));
    S.provider = back || S.provider;
    if (!back) refreshProvider();
    $('setRemoteKey').value = '';
    renderProviderUI();
    renderSettings();
    toast(mode === 'remote' ? ('已切换到外部模型：' + payload.model) : '已切回内置引擎', 'ok', 3200);
    fyLog('模型来源切换：' + mode + ' ' + payload.baseUrl + ' ' + payload.model);
  }

  function customDownload() {
    var url = $('customUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) { toast('请填 http(s) 开头的直链', 'warn'); return; }
    var name = modelNameFromUrl(url);
    var hint = $('customHint');
    if (hint) hint.textContent = '开始下载 ' + name + ' …（可切后台，进度显示在下面）';
    var r = fyCall('downloadModel', [url, name]);
    toast((r && r.message) || '已开始下载', r && r.ok ? 'ok' : 'err', 3200);
  }

  /* ---------- 推荐：还没聊过的优先，其次最久没聊的 ---------- */

  function chattedAt() {
    var seen = {};
    S.store.listSessions().forEach(function (s) {
      (s.characterIds || []).forEach(function (id) {
        seen[id] = Math.max(seen[id] || 0, s.updatedAt || 0);
      });
    });
    return seen;
  }

  /** 返回 [{c, why}]，尊重当前的分类/搜索筛选 */
  function recommendPicks(n) {
    var seen = chattedAt();
    var pool = S.characters.filter(charMatches);
    if (!pool.length) pool = S.characters.slice();
    var fresh = pool.filter(function (c) { return !seen[c.id]; });
    var old = pool.filter(function (c) { return seen[c.id]; })
      .sort(function (a, b) { return (seen[a.id] || 0) - (seen[b.id] || 0); });
    var out = [];
    function take(arr, why) {
      while (out.length < n && arr.length) {
        out.push({ c: arr.splice(Math.floor(Math.random() * arr.length), 1)[0], why: why });
      }
    }
    take(fresh, '还没聊过');
    take(old, '好久没聊了');
    return out;
  }

  function renderRecommend() {
    var list = $('recList');
    var st = $('recStatus');
    list.innerHTML = '';
    if (!S.characters.length) { st.textContent = '还没有角色，先导入卡包或新建一个'; return; }
    var picks = recommendPicks(3);
    st.textContent = '按「还没聊过 → 最久没聊」排序，当前筛选下的随机 3 个';
    picks.forEach(function (p) {
      var row = el('div', 'model-row');
      row.appendChild(fillAvatar(el('div', 'tiny-avatar'), p.c, 30));
      var col = el('div', 'grow');
      var nm = el('div', 'model-name', p.c.name
        + (p.c.kind === 'story' ? ' · 剧情卡' : ''));
      col.appendChild(nm);
      col.appendChild(el('div', 'model-size', (p.c.tagline || '').slice(0, 40)));
      col.appendChild(el('div', 'model-size', '推荐理由：' + p.why
        + ((p.c.tags || []).length ? (' · ' + p.c.tags.join(' / ')) : '')));
      row.appendChild(col);
      row.onclick = function () {
        closeSheet($('recMask'));
        S.charCat = 'all'; S.charQuery = ''; $('charSearch').value = '';
        renderCharCats();
        renderCharacters();
        openSoloChat(p.c.id, '');
      };
      list.appendChild(row);
    });
  }

  function openRecSheet() { openSheet($('recMask')); renderRecommend(); }

  /* ---------- 内置卡包（随 APK 打包，一键导入） ---------- */

  var packIndexCache = null;

  function loadPackIndex(force) {
    if (packIndexCache && !force) return Promise.resolve(packIndexCache);
    return fetch('packs/index.json').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (idx) {
      packIndexCache = idx || { packs: [] };
      return packIndexCache;
    });
  }

  /** 已存在的角色名（导入去重用）。
      必须问 store 要当前列表，不能读 S.characters：后者是界面缓存，
      删卡/恢复备份/清空数据之后可能还没刷新，会让"重新导入"补不回被删的卡。 */
  function importedNames() {
    var m = {};
    var list = (S.store && S.store.listCharacters()) || S.characters || [];
    list.forEach(function (c) { m[c.name] = 1; });
    return m;
  }

  /** 导入一个卡包文件：已存在同名的跳过，只补缺 */
  function importPackFile(file, packName, opts) {
    var o = opts || {};
    var st = o.statusEl || $('packStatus');
    var label0 = packName || file;
    if (st) st.textContent = '正在读取「' + label0 + '」…';
    return fetch('packs/' + file).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (txt) {
      var pack = FYCards.parsePack(txt);
      var res = importCardsBatch(pack.cards, { statusEl: st, onProgress: o.onProgress });
      refreshCharList();                 // 整包只刷新一次列表
      var label = pack.packName || packName || file;
      if (res.added) toast('「' + label + '」导入 ' + res.added + ' 张' + (res.skipped ? '（跳过已存在 ' + res.skipped + ' 张）' : ''), 'ok', 3600);
      else toast('「' + label + '」里的 ' + res.skipped + ' 张都已经有了', 'warn', 3000);
      fyLog('卡包导入：' + label + ' 新增=' + res.added + ' 跳过=' + res.skipped + ' 许可=' + (pack.license || '未标注'));
      return { added: res.added, skipped: res.skipped };
    });
  }

  /** 一键导入全部内置卡包（新用户最快上手路径） */
  function importAllPacks() {
    var btn = $('btnPackAll');
    var st = $('packStatus');
    return loadPackIndex(true).then(function (idx) {
      var packs = idx.packs || [];
      if (!packs.length) throw new Error('目录为空');
      var totalAdded = 0, totalSkipped = 0, i = 0;
      if (btn) { btn.disabled = true; }
      function step() {
        if (i >= packs.length) {
          if (btn) { btn.disabled = false; btn.textContent = '全部导入'; }
          st.textContent = '全部导入完成：新增 ' + totalAdded + ' 张，跳过已存在 ' + totalSkipped + ' 张';
          toast('内置卡包：新增 ' + totalAdded + ' 张', 'ok', 3600);
          fyLog('全部卡包导入完成 新增=' + totalAdded + ' 跳过=' + totalSkipped);
          return { added: totalAdded, skipped: totalSkipped };
        }
        var p = packs[i++];
        if (btn) btn.textContent = '导入中 ' + i + '/' + packs.length;
        return importPackFile(p.file, p.name).then(function (r) {
          totalAdded += r.added; totalSkipped += r.skipped;
          return step();
        });
      }
      return step();
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '全部导入'; }
      toast('导入失败：' + ((e && e.message) || e), 'err', 3600);
      throw e;
    });
  }

  function openPackSheet() {
    openSheet($('packMask'));
    var st = $('packStatus');
    var list = $('packList');
    list.innerHTML = '';
    st.textContent = '正在加载卡包目录…';
    loadPackIndex().then(function (idx) {
      var packs = idx.packs || [];
      var total = packs.reduce(function (a, p) { return a + (Number(p.count) || 0); }, 0);
      if (!packs.length) { st.textContent = '没有内置卡包（packs/index.json 为空）'; return; }
      st.textContent = '内置 ' + packs.length + ' 个卡包 · 共 ' + total + ' 张卡（原创，CC0 许可）';
      var have = importedNames();
      packs.forEach(function (p) {
        var row = el('div', 'model-row');
        var col = el('div', 'grow');
        col.appendChild(el('div', 'model-name', (p.emoji || '📦') + ' ' + p.name + ' · ' + p.count + ' 张'));
        var tg = p.tags || [];
        col.appendChild(el('div', 'model-size',
          tg.slice(0, 3).join(' / ') + (tg.length > 3 ? (' 等 ' + tg.length + ' 类') : '')));
        col.appendChild(el('div', 'model-size', (p.desc || '').slice(0, 46)));
        row.appendChild(col);
        var btn = el('button', 'btn btn-xs', '导入');
        btn.onclick = function (ev) {
          ev.stopPropagation();
          btn.disabled = true;
          btn.textContent = '导入中';
          importPackFile(p.file, p.name).then(function (r) {
            btn.disabled = false;
            btn.textContent = r.added ? '再检查一次' : '已全部导入';
          }).catch(function (e) {
            btn.disabled = false;
            btn.textContent = '重试';
            toast('导入失败：' + ((e && e.message) || e), 'err', 3600);
          });
        };
        row.appendChild(btn);
        list.appendChild(row);
      });
    }).catch(function (e) {
      st.textContent = '卡包目录加载失败：' + ((e && e.message) || e) + '（网页预览模式可能没有该文件）';
    });
  }

  /* ==========================================================================
   * 在线卡库（Task B）
   *
   * 为什么要有它：卡库要从 160 张扩到 32000 张（每分类 1000 角色 + 1000 剧情），
   * 全塞进 APK 会让包体爆炸；改成 App 内按分类下载。
   *
   * 为什么必须走本机代理：Gitee 的 raw / 发行版附件都不带
   * Access-Control-Allow-Origin，WebView 里 fetch 外域必被 CORS 拦死。
   * 所以统一请求 `'/fetch?url=' + encodeURIComponent(真实地址)`（AssetServer 已实现），
   * 前端只跟 127.0.0.1 同源打交道。
   *
   * 目录格式（fy_library_v1，字段固定）：
   *   { spec, total, baseUrl, categories:[{slug,tag,emoji,character,story}],
   *     packs:[{file,slug,tag,emoji,kind,part,parts,count,bytes,sha256}] }
   * 分片文件就是内置卡包的格式（fy_pack_v1）。
   *
   * v2 是纯增量：分片多出 topic/topics/keywords（主题与关键词），老字段语义不变。
   * 不搜关键词时行为和 v1 一样按「分类 × 类型」整组下；搜了就只列命中的小片。
   * 契约见 docs/library-catalog.md。
   * ======================================================================== */

  /** 目录地址兜底值；用户可在卡库面板里改成自己的地址（存 S.settings.libCatalogUrl）。
      目录本身很小（约 9KB）随仓库发，卡包分片走 Gitee 发行版附件；
      两者都通过本机 AssetServer 的 /fetch 同源代理取（Gitee 不发 CORS 头）。 */
  var LIB_CATALOG_URL = 'https://gitee.com/zhao-jiurong/wind-and-moon-local-edition/raw/main/cards/library-index.json';
  /** 面板最多显示多少行「分类 × 类型」 */
  var LIB_MAX_ROWS = 32;
  var LIB_KIND_LABEL = { character: '角色卡', story: '剧情卡' };
  /* results/packRows 只在搜索视图里有值；query 为空时 results 必须是 []（对外导出 libResults 的约定） */
  /* seedDropped：这次目录换代作废了几条旧的导入记录（0=没动过），面板会据此提示并自动勾上覆盖 */
  var libState = { catalog: null, rows: [], results: [], packRows: {}, query: '', seedDropped: 0 };
  /* 搜索框防抖定时器；重开面板要能把它清掉，否则旧的一次延迟渲染会打回来 */
  var libSearchTimer = null;

  function libCatalogUrl() {
    return (S.settings && S.settings.libCatalogUrl) || LIB_CATALOG_URL;
  }

  /** https 地址一律经同源代理；相对路径直接取（网页预览 / 本地调试用） */
  function fetchLibraryUrl(url) {
    var u = String(url || '').trim();
    if (/^https?:\/\//i.test(u)) return fetch('/fetch?url=' + encodeURIComponent(u));
    return fetch(u);
  }

  /** 分片的真实地址：优先目录里给的绝对 url，其次 baseUrl + file。
      留 url 这一层是为了以后拆发行版 / 换托管时只改目录（App 不用跟着发版）。 */
  function libFileUrl(p) {
    if (/^https?:\/\//i.test(p.url || '')) return p.url;
    if (/^https?:\/\//i.test(p.file || '')) return p.file;
    var base = (libState.catalog && libState.catalog.baseUrl) || '';
    if (base && base.charAt(base.length - 1) !== '/') base += '/';
    return base + (p.file || '');
  }

  function libImportedMap() {
    var m = S.settings && S.settings.libraryImported;
    return (m && typeof m === 'object') ? m : {};
  }

  function libRowImported(row) {
    return libPacksImported((row && row.packs) || []);
  }

  /** 单个分片已导入的张数（按文件名记在 settings.libraryImported，跟整组视图共用同一份状态） */
  function libPackImported(p) {
    if (!p) return 0;
    var hit = libImportedMap()[p.file];
    if (!hit) return 0;
    return Number(hit.count) || Number(p.count) || 0;
  }

  function libPacksImported(packs) {
    var n = 0;
    (packs || []).forEach(function (p) { n += libPackImported(p); });
    return n;
  }

  /** 一个分片的检索文本：tag + slug + 类型中文名 + topic + topics[] + keywords[]（契约见 docs/library-catalog.md） */
  function libPackSearchText(p) {
    var parts = [p.tag || '', p.slug || '', LIB_KIND_LABEL[p.kind] || p.kind || '', p.topic || ''];
    (Array.isArray(p.topics) ? p.topics : []).forEach(function (t) { if (t) parts.push(String(t)); });
    (Array.isArray(p.keywords) ? p.keywords : []).forEach(function (k) { if (k) parts.push(String(k)); });
    return parts.join(' ').toLowerCase();
  }

  /**
   * 按关键词搜分片（纯函数：只翻内存里的目录，绝不发网络请求）。
   * 查询按空白切 token，每个 token 都要以子串命中检索文本（大小写不敏感）才算命中；
   * 空查询返回 []，表示"该走整组视图"。排序固定成 tag → kind → part，避免每次刷新顺序乱跳。
   */
  function libSearchPacks(query) {
    var tokens = String(query == null ? '' : query).toLowerCase().split(/\s+/).filter(function (t) { return !!t; });
    if (!tokens.length) return [];
    var packs = (libState.catalog && Array.isArray(libState.catalog.packs)) ? libState.catalog.packs : [];
    var hits = packs.filter(function (p) {
      var text = libPackSearchText(p);
      for (var i = 0; i < tokens.length; i++) if (text.indexOf(tokens[i]) < 0) return false;
      return true;
    });
    hits.sort(function (a, b) {
      var ta = String(a.tag || ''), tb = String(b.tag || '');
      if (ta !== tb) return ta < tb ? -1 : 1;
      var ka = String(a.kind || ''), kb = String(b.kind || '');
      if (ka !== kb) return ka < kb ? -1 : 1;
      return (Number(a.part) || 0) - (Number(b.part) || 0);
    });
    return hits;
  }

  /** 同名卡覆盖开关（勾了就用新卡内容覆盖同名老卡，见 importCardsBatch 的 overwrite） */
  function libOverwriteOn() {
    return !!(S.settings && S.settings.libraryOverwrite);
  }

  /**
   * 目录换了一版（index.seed 变了）→ 作废"按文件名"记的旧导入记录。
   *
   * 为什么要作废：分片文件名是 `<slug>-<kind>-<part>.json`，v1 的 `mystery-character-1.json`
   * 是 1000 张的整组，v2 的同名文件只是第 1 片（约 250 张）。沿用旧记录的话，老用户升级后
   * 面板会显示"已导入 1000 张"，既看不到新卡，也拿不到重新加长的文本。
   * 只作废"张数对不上"和"目录里已经没有"的记录；张数一致（说明就是这一版）的照旧保留。
   * 返回作废条数（0 表示没动过）。
   */
  function libApplyCatalogSeed(idx) {
    if (!S.settings || !S.store || !idx) return 0;
    var seed = idx.seed ? String(idx.seed) : '';
    if (!seed) return 0;                                  // 老目录没 seed：什么都不动，保持老行为
    if (String(S.settings.librarySeed || '') === seed) return 0;
    var byFile = {};
    ((idx && Array.isArray(idx.packs)) ? idx.packs : []).forEach(function (p) {
      if (p && p.file) byFile[p.file] = p;
    });
    var old = libImportedMap();
    var kept = {}, dropped = 0;
    for (var k in old) {
      if (!Object.prototype.hasOwnProperty.call(old, k)) continue;
      var p = byFile[k];
      if (p && Number(old[k] && old[k].count) === Number(p.count)) kept[k] = old[k];
      else dropped++;
    }
    var patch = { librarySeed: seed };
    if (dropped) {
      patch.libraryImported = kept;
      /* 目录换代基本就意味着"文本重写了"，默认替用户勾上覆盖：不然同名卡会一直留着旧文本 */
      patch.libraryOverwrite = true;
    }
    S.settings = S.store.saveSettings(patch);
    if (dropped) fyLog('卡库目录已更新（seed=' + seed + '）：作废 ' + dropped + ' 条旧的分片导入记录');
    return dropped;
  }

  /** 记住"这个分片已经导入过"（重开面板能看出来；再点也不会重复下载/建卡） */
  function markLibraryImported(file, count) {
    var m = {};
    var old = libImportedMap();
    for (var k in old) if (Object.prototype.hasOwnProperty.call(old, k)) m[k] = old[k];
    m[file] = { count: Number(count) || 0, ts: Date.now() };
    S.settings = S.store.saveSettings({ libraryImported: m });
    return m;
  }

  function loadLibraryCatalog() {
    var url = libCatalogUrl();
    return fetchLibraryUrl(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (txt) {
      var idx;
      try { idx = JSON.parse(txt); } catch (e) { throw new Error('目录不是合法 JSON'); }
      if (!idx || !Array.isArray(idx.packs)) throw new Error('目录缺少 packs 数组');
      libState.catalog = idx;
      libState.seedDropped = libApplyCatalogSeed(idx);   // 目录换代 → 作废旧分片导入记录（见函数注释）
      return idx;
    });
  }

  /**
   * 目录 → 「分类 × 类型」行（最多 LIB_MAX_ROWS 行）。
   * 先按 categories 建行（顺序稳定），再把 packs 挂上去 —— 这样即使某个分类暂时没分片，
   * 也能显示成"还没有分片"，而不是整行消失。
   */
  function libraryGroups(idx) {
    var cats = (idx && Array.isArray(idx.categories)) ? idx.categories : [];
    var packs = (idx && Array.isArray(idx.packs)) ? idx.packs : [];
    var out = [], seen = {};
    function makeRow(cat, kind) {
      var key = (cat.slug || cat.tag || '?') + '|' + kind;
      if (seen[key]) return seen[key];
      var row = {
        key: key, slug: cat.slug || '', tag: cat.tag || cat.slug || '未分类',
        emoji: cat.emoji || '', kind: kind, packs: [], total: 0, bytes: 0
      };
      seen[key] = row;
      out.push(row);
      return row;
    }
    cats.forEach(function (cat) {
      var kinds = [];
      if (Number(cat.character) > 0) kinds.push('character');
      if (Number(cat.story) > 0) kinds.push('story');
      if (!kinds.length) kinds = ['character'];
      kinds.forEach(function (k) { makeRow(cat, k); });
    });
    packs.forEach(function (p) {
      var cat = null;
      for (var i = 0; i < cats.length; i++) if (cats[i].slug === p.slug) { cat = cats[i]; break; }
      if (!cat) cat = { slug: p.slug, tag: p.tag, emoji: p.emoji };
      makeRow(cat, p.kind === 'story' ? 'story' : 'character').packs.push(p);
    });
    out.forEach(function (row) {
      row.packs.sort(function (a, b) { return (Number(a.part) || 0) - (Number(b.part) || 0); });
      var cat = null;
      for (var j = 0; j < cats.length; j++) if (cats[j].slug === row.slug) { cat = cats[j]; break; }
      var declared = cat ? Number(cat[row.kind]) : 0;
      row.total = declared > 0 ? declared
        : row.packs.reduce(function (a, p) { return a + (Number(p.count) || 0); }, 0);
      row.bytes = row.packs.reduce(function (a, p) { return a + (Number(p.bytes) || 0); }, 0);
    });
    return out.slice(0, LIB_MAX_ROWS);
  }

  function setRowStatus(row, text, kind) {
    if (!row || !row._statusEl) return;
    row._statusEl.textContent = text;
    row._statusEl.className = 'lib-row-status' + (kind ? ' ' + kind : '');
  }

  function libDefaultStatus(row) {
    var imported = libRowImported(row);
    if (row.total > 0 && imported >= row.total) return { text: '已导入 ' + imported + ' 张', kind: 'ok' };
    if (imported > 0) return { text: '已导入 ' + imported + ' / ' + row.total + ' 张', kind: '' };
    return { text: '未下载', kind: '' };
  }

  function renderLibraryRows() {
    var list = $('libList');
    var st = $('libStatus');
    list.innerHTML = '';
    var rows = libState.rows;
    if (!rows.length) { st.textContent = '这个目录里没有可下载的卡包'; return; }
    var importedAll = 0;
    rows.forEach(function (row) { importedAll += libRowImported(row); });
    st.textContent = '共 ' + rows.length + ' 组（分类 × 类型）· 已导入 ' + importedAll + ' 张'
      + '（重复点不会重复建卡）';
    rows.forEach(function (row) {
      var dom = el('div', 'model-row');
      var col = el('div', 'grow');
      col.appendChild(el('div', 'model-name',
        (row.emoji || '📦') + ' ' + row.tag + ' · ' + (LIB_KIND_LABEL[row.kind] || row.kind)));
      var bits = [row.total + ' 张'];
      if (row.packs.length) bits.push(row.packs.length + ' 个分片');
      if (row.bytes) bits.push(fmtSize(row.bytes));
      col.appendChild(el('div', 'model-size', bits.join(' · ')));
      row._statusEl = el('div', 'lib-row-status');
      var s = libDefaultStatus(row);
      row._statusEl.textContent = s.text;
      row._statusEl.className = 'lib-row-status' + (s.kind ? ' ' + s.kind : '');
      col.appendChild(row._statusEl);
      dom.appendChild(col);

      var btn = el('button', 'btn btn-xs');
      var label = el('span', '', '');
      btn.appendChild(label);
      row._btn = btn;
      row._btnLabel = label;
      row._btnIcon = null;
      var paint = function () {
        var done = libRowImported(row);
        var full = row.total > 0 && done >= row.total;
        btn.innerHTML = '';
        btn.appendChild(iconEl(full ? 'refresh' : 'download'));
        btn.appendChild(el('span', '', full ? '重新导入' : '下载并导入'));
        btn.title = full ? '重新下载并导入这一组（你删掉的卡会被补回来）' : '下载并导入这一组';
      };
      paint();
      row._paintBtn = paint;
      btn.onclick = function (ev) {
        ev.stopPropagation();
        var force = libRowImported(row) >= row.total && row.total > 0;
        btn.disabled = true;
        importLibraryRow(row, { force: force }).then(function () { btn.disabled = false; paint(); });
      };
      dom.appendChild(btn);
      list.appendChild(dom);
    });
  }

  /** 搜索结果里的"片行"：套用整组行的结构（packs/total），好复用状态判定、按钮重绘与下载逻辑 */
  function libPackRow(p) {
    return {
      key: 'pack|' + p.file, slug: p.slug || '', tag: p.tag || p.slug || '未分类',
      emoji: p.emoji || '', kind: p.kind === 'story' ? 'story' : 'character',
      packs: [p], total: Number(p.count) || 0, bytes: Number(p.bytes) || 0, pack: p
    };
  }

  /** 顶部主按钮：整组视图是「全部下载」，搜索视图是「下载全部匹配（N 片）」 */
  function libUpdateAllBtn() {
    var btn = $('btnLibAll');
    if (!btn) return;
    var label = $('libAllLabel');
    if (libState.query) {
      var n = libState.results.length;
      if (label) label.textContent = '下载全部匹配（' + n + ' 片）';
      btn.disabled = n === 0;
      btn.title = n ? '只下载命中的 ' + n + ' 个分片' : '没有匹配的分片';
    } else {
      if (label) label.textContent = '全部下载';
      btn.disabled = false;
      btn.title = '下载全部「分类 × 类型」';
    }
  }

  /** 底部计数：整组视图报目录规模，搜索视图报命中片数 / 张数 / 已导入（单片下完也要跟着变） */
  function libUpdateFoot() {
    var total = $('libTotal');
    if (!total) return;
    if (libState.query) {
      var cards = 0;
      libState.results.forEach(function (p) { cards += Number(p.count) || 0; });
      total.textContent = '匹配 ' + libState.results.length + ' 片 · 共 ' + cards + ' 张 · 已导入 '
        + libPacksImported(libState.results) + ' 张';
      return;
    }
    var idx = libState.catalog;
    total.textContent = '目录共 ' + (Number(idx && idx.total) || 0) + ' 张卡 · ' + libState.rows.length + ' 组';
  }

  /** 查询非空时一片一行；没命中就给明确提示，而不是留一屏空白让人以为卡了 */
  function renderLibraryPackResults(packs) {
    var list = $('libList');
    var st = $('libStatus');
    list.innerHTML = '';
    libState.packRows = {};
    if (!packs.length) {
      st.textContent = '没有匹配「' + libState.query + '」的分片（换个词试试，或清空搜索看全部）';
      return;
    }
    /* 顶部文案按分类汇总一句，用户一眼能看出命中落在哪些分类 */
    var byTag = [], totalCards = 0;
    packs.forEach(function (p) {
      totalCards += Number(p.count) || 0;
      var tag = p.tag || p.slug || '未分类';
      for (var i = 0; i < byTag.length; i++) if (byTag[i].tag === tag) { byTag[i].n++; return; }
      byTag.push({ tag: tag, n: 1 });
    });
    st.textContent = '匹配 ' + packs.length + ' 片 · 共 ' + totalCards + ' 张 · '
      + byTag.map(function (g) { return g.tag + ' ' + g.n; }).join(' / ');
    packs.forEach(function (p) {
      var row = libPackRow(p);
      libState.packRows[p.file] = row;
      var dom = el('div', 'model-row');
      var col = el('div', 'grow');
      col.appendChild(el('div', 'model-name',
        (p.emoji || '📦') + ' ' + (p.tag || p.slug || '未分类') + ' · '
        + (LIB_KIND_LABEL[row.kind] || row.kind) + ' · ' + (p.topic || '未分类主题')));
      col.appendChild(el('div', 'model-size', [
        row.total + ' 张', fmtSize(Number(p.bytes) || 0),
        '第 ' + (Number(p.part) || 1) + '/' + (Number(p.parts) || 1) + ' 片'
      ].join(' · ')));
      row._statusEl = el('div', 'lib-row-status');
      var s = libDefaultStatus(row);
      row._statusEl.textContent = s.text;
      row._statusEl.className = 'lib-row-status' + (s.kind ? ' ' + s.kind : '');
      col.appendChild(row._statusEl);
      dom.appendChild(col);

      var btn = el('button', 'btn btn-xs');
      row._btn = btn;
      var paint = function () {
        var full = row.total > 0 && libPackImported(p) >= row.total;
        btn.innerHTML = '';
        btn.appendChild(iconEl(full ? 'refresh' : 'download'));
        btn.appendChild(el('span', '', full ? '重新导入' : '下载并导入'));
        btn.title = full ? '重新下载并导入这一片（你删掉的卡会被补回来）' : '只下载并导入这一片';
      };
      paint();
      row._paintBtn = paint;
      btn.onclick = function (ev) {
        ev.stopPropagation();
        var full = row.total > 0 && libPackImported(p) >= row.total;
        btn.disabled = true;
        importLibraryPacks([p], {
          force: full, overwrite: libOverwriteOn(), target: row,
          onDone: function () { libUpdateFoot(); }   // 单片下完，顶部计数要跟着变
        }).then(function () { btn.disabled = false; });
      };
      dom.appendChild(btn);
      list.appendChild(dom);
    });
  }

  /** 按当前查询决定渲染哪个视图；查询为空就回整组（老行为一字不改） */
  function renderLibraryResults() {
    if (libState.query) {
      libState.results = libSearchPacks(libState.query);
      renderLibraryPackResults(libState.results);
    } else {
      libState.results = [];
      libState.packRows = {};
      renderLibraryRows();
    }
    libUpdateAllBtn();
    libUpdateFoot();
  }

  function openLibrarySheet() {
    openSheet($('libMask'));
    var st = $('libStatus');
    var list = $('libList');
    var inp = $('libUrl');
    if (inp) inp.value = libCatalogUrl();
    /* 重开面板一律从整组视图开始：搜索只是临时视图，不该粘着上一次的词 */
    libState.query = '';
    libState.seedDropped = 0;
    var owBox = $('libOverwrite');
    if (owBox) owBox.checked = libOverwriteOn();
    libState.results = [];
    libState.packRows = {};
    if (libSearchTimer) { clearTimeout(libSearchTimer); libSearchTimer = null; }
    var sInp = $('libSearch');
    if (sInp) sInp.value = '';
    list.innerHTML = '';
    st.textContent = '正在加载卡库目录…';
    $('libTotal').textContent = '加载中…';
    libUpdateAllBtn();
    var url = libCatalogUrl();
    loadLibraryCatalog().then(function (idx) {
      libState.rows = libraryGroups(idx);
      renderLibraryResults();
      if (libState.seedDropped) {
        st.textContent += ' · 卡库已换版：作废 ' + libState.seedDropped + ' 条旧记录，已自动勾选「同名卡覆盖」';
        var ow = $('libOverwrite');
        if (ow) ow.checked = true;
      }
    }).catch(function (e) {
      libState.rows = [];
      st.textContent = '卡库目录加载失败：' + ((e && e.message) || e)
        + ' —— 请检查网络或地址（' + url + '）';
      $('libTotal').textContent = '目录加载失败';
    });
  }

  /** 下载一个分片并交回"已校验"的卡片数组；任何一步不对就抛错（绝不写坏数据） */
  function downloadLibraryShard(p) {
    return fetchLibraryUrl(libFileUrl(p)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + '（' + p.file + '）');
      return r.text();
    }).then(function (txt) {
      var raw;
      try { raw = JSON.parse(txt); } catch (e) { throw new Error(p.file + ' 不是合法 JSON'); }
      if (!raw || !Array.isArray(raw.cards)) throw new Error(p.file + ' 缺少 cards 数组');
      /* 关键校验：目录声明的张数必须跟文件里的一致 —— 不一致说明下到半截或文件坏了，
         这时候宁可报错也不能把残缺数据写进库。 */
      if (Number(raw.count) !== raw.cards.length) {
        throw new Error(p.file + ' 张数不符（声明 ' + raw.count + '，实际 ' + raw.cards.length + '）');
      }
      var pack = FYCards.parsePack(txt);
      if (pack.cards.length !== raw.cards.length) {
        throw new Error(p.file + ' 有 ' + (raw.cards.length - pack.cards.length) + ' 张卡解析失败');
      }
      return pack;
    });
  }

  function libPercent(done, total, inflight) {
    if (!total || total <= 0) return 0;
    return Math.min(99, Math.floor(((done + (inflight || 0) * 0.5) / total) * 100));
  }

  /**
   * 下载并导入一批分片（整组一行、或搜索命中的一片，都走这里）。
   * 已导入过的分片直接跳过（幂等）。失败时**不会**写库，也不会把失败的分片记进 libraryImported。
   * opts.target：带 _statusEl/_btn/_paintBtn/_busy 的行对象，用来显示进度、禁用按钮；
   *   不给就静默下载（测试 / 后台批量调用）。
   * opts.overwrite：同名卡用新内容原地覆盖（默认跳过，保证幂等）。
   * opts.onDone：收尾回调，单片下载完要顺手刷新顶部计数时用。
   * @returns {Promise<{added:number, replaced:number, error?:string}>}
   */
  function importLibraryPacks(packs, opts) {
    var o = opts || {};
    var row = o.target || null;
    var list = (packs || []).slice();
    if (row && row._busy) return Promise.resolve({ added: 0, error: '正在下载中' });
    if (!list.length) {
      setRowStatus(row, '这个分类还没有分片文件', 'err');
      return Promise.resolve({ added: 0, error: '没有分片文件' });
    }
    var imported = libImportedMap();
    /* force：忽略"已导入"记录，重新下载并导入一遍。
       用途是"我后来把某些卡删了，想补回来"——导入本身按名字幂等，
       已存在的卡会跳过，缺的卡会被补上。
       overwrite（面板上的"同名卡覆盖"）再进一步：同名的老卡不跳过，用新卡内容覆盖。 */
    if (o.force) imported = {};
    var totalBytes = list.reduce(function (a, p) { return a + (Number(p.bytes) || 0); }, 0) || list.length;
    var added = 0, replaced = 0, doneBytes = 0, err = '';
    var i = 0;
    if (row) {
      row._busy = true;
      if (row._btn) row._btn.disabled = true;
    }

    function finish() {
      if (row) {
        row._busy = false;
        if (row._btn) row._btn.disabled = false;
      }
      var result;
      if (err) {
        setRowStatus(row, '失败：' + err, 'err');
        result = { added: added, replaced: replaced, error: err };
      } else {
        if (row) {
          var s = libDefaultStatus(row);
          setRowStatus(row, s.text, s.kind);
          if (row._paintBtn) row._paintBtn();
        }
        if (o.refresh !== false && added) refreshCharList();   // 一批只刷新一次列表
        result = { added: added, replaced: replaced };
      }
      if (o.onDone) o.onDone(result);
      return result;
    }

    function step() {
      if (err || i >= list.length) return Promise.resolve();
      var p = list[i];
      var weight = Number(p.bytes) || 1;
      if (imported[p.file]) {           // 已导入过：跳过下载，幂等
        doneBytes += weight;
        i++;
        return step();
      }
      setRowStatus(row, '下载中 ' + libPercent(doneBytes, totalBytes, weight) + '%', '');
      return downloadLibraryShard(p).then(function (pack) {
        setRowStatus(row, '导入中 0 / ' + pack.cards.length, '');
        var res = importCardsBatch(pack.cards, {
          statusEl: null,
          overwrite: !!o.overwrite,
          onProgress: function (processed, total) {
            setRowStatus(row, '导入中 ' + processed + ' / ' + total, '');
          }
        });
        added += res.added;
        replaced += res.replaced || 0;
        markLibraryImported(p.file, pack.cards.length);
        imported[p.file] = { count: pack.cards.length, ts: Date.now() };
        doneBytes += weight;
        i++;
        setRowStatus(row, '下载中 ' + libPercent(doneBytes, totalBytes, 0) + '%', '');
        return step();
      }).catch(function (e) {
        err = (e && e.message) || String(e);
      });
    }

    return Promise.resolve().then(step).then(finish).catch(function (e) {
      err = err || (e && e.message) || String(e);
      return finish();
    });
  }

  /**
   * 下载并导入一组（一个分类的一个类型，含它的全部分片）。
   * 保留这个入口：整组视图的按钮和既有调用都还走它，只是循环体挪去了 importLibraryPacks。
   * @returns {Promise<{added:number, error?:string}>}
   */
  function importLibraryRow(row, opts) {
    var o = opts || {};
    return importLibraryPacks((row && row.packs) || [], {
      force: o.force,
      overwrite: (o.overwrite === undefined ? libOverwriteOn() : !!o.overwrite),
      refresh: o.refresh, target: row
    });
  }

  /** 顶部「全部下载」：整组视图按行下，搜索视图只下命中的分片 */
  function importAllLibrary() {
    if (libState.query) return importAllLibraryMatches();
    var rows = libState.rows.slice();
    if (!rows.length) { toast('目录还没加载好', 'warn'); return Promise.resolve({ added: 0 }); }
    var btn = $('btnLibAll');
    var total = $('libTotal');
    var done = 0, added = 0, replaced = 0, failed = 0;
    if (btn) btn.disabled = true;
    function step() {
      if (done >= rows.length) {
        if (btn) btn.disabled = false;
        if (added) refreshCharList();                  // 全部结束后统一刷新一次
        if (total) {
          total.textContent = '全部完成：新增 ' + added + ' 张'
            + (replaced ? ('，覆盖同名 ' + replaced + ' 张') : '')
            + (failed ? ('，' + failed + ' 组失败') : '');
        }
        toast('在线卡库：本次新增 ' + added + ' 张' + (replaced ? ('，覆盖同名 ' + replaced + ' 张') : '')
          + (failed ? ('（' + failed + ' 组失败）') : ''), failed ? 'warn' : 'ok', 3800);
        fyLog('在线卡库全部下载完成：新增=' + added + ' 覆盖=' + replaced + ' 失败组=' + failed);
        return { added: added, replaced: replaced, failed: failed };
      }
      var row = rows[done];
      if (total) total.textContent = '总进度 ' + done + ' / ' + rows.length + ' 组 · 已新增 ' + added + ' 张';
      return importLibraryRow(row, { refresh: false }).then(function (r) {
        added += (r && r.added) || 0;
        replaced += (r && r.replaced) || 0;
        if (r && r.error) failed++;
        done++;
        return step();
      });
    }
    return Promise.resolve().then(step).catch(function (e) {
      if (btn) btn.disabled = false;
      return { added: added, failed: failed, error: (e && e.message) || String(e) };
    });
  }

  /** 搜索视图的「下载全部匹配（N 片）」：只碰命中的分片，逐片更新那一行的状态 */
  function importAllLibraryMatches() {
    var packs = libState.results.slice();
    var btn = $('btnLibAll');
    var total = $('libTotal');
    if (!packs.length) { toast('没有匹配的分片', 'warn'); return Promise.resolve({ added: 0 }); }
    var done = 0, added = 0, replaced = 0, failed = 0;
    if (btn) btn.disabled = true;
    function step() {
      if (done >= packs.length) {
        if (added) refreshCharList();                  // 全部结束后统一刷新一次
        libUpdateAllBtn();
        if (total) {
          total.textContent = '全部完成：新增 ' + added + ' 张'
            + (replaced ? ('，覆盖同名 ' + replaced + ' 张') : '')
            + (failed ? ('，' + failed + ' 片失败') : '');
        }
        toast('在线卡库：本次新增 ' + added + ' 张' + (replaced ? ('，覆盖同名 ' + replaced + ' 张') : '')
          + (failed ? ('（' + failed + ' 片失败）') : ''), failed ? 'warn' : 'ok', 3800);
        fyLog('在线卡库匹配下载完成：新增=' + added + ' 覆盖=' + replaced + ' 失败片=' + failed);
        return { added: added, replaced: replaced, failed: failed };
      }
      var p = packs[done];
      var row = libState.packRows[p.file] || libPackRow(p);
      if (total) total.textContent = '总进度 ' + done + ' / ' + packs.length + ' 片 · 已新增 ' + added + ' 张';
      return importLibraryPacks([p], { target: row, refresh: false, overwrite: libOverwriteOn() }).then(function (r) {
        added += (r && r.added) || 0;
        replaced += (r && r.replaced) || 0;
        if (r && r.error) failed++;
        done++;
        return step();
      });
    }
    return Promise.resolve().then(step).catch(function (e) {
      libUpdateAllBtn();
      return { added: added, failed: failed, error: (e && e.message) || String(e) };
    });
  }

  /* ---------- 存储后端（多后端可切换，见 store.js 的 BACKENDS） ---------- */
  var BACKEND_LABEL = {
    indexeddb: 'IndexedDB（默认）',
    sqlite: 'SQLite（实验）',
    localstorage: 'localStorage（兜底）',
    memory: '内存（测试）'
  };

  function renderStorageInfo() {
    var sel = $('setBackend');
    var info = $('storageInfo');
    if (!sel || !info) return;
    var list = (S.store && S.store.listBackends) ? S.store.listBackends() : [];
    var cur = S.store && S.store.getBackend ? S.store.getBackend() : '?';
    sel.innerHTML = '';
    list.forEach(function (n) {
      var o = document.createElement('option');
      o.value = n;
      o.textContent = BACKEND_LABEL[n] || n;
      sel.appendChild(o);
    });
    if (list.indexOf(cur) < 0) {
      var extra = document.createElement('option');
      extra.value = cur;
      extra.textContent = BACKEND_LABEL[cur] || cur;
      sel.appendChild(extra);
    }
    sel.value = cur;
    var st = S.store && S.store.stats ? S.store.stats() : null;
    info.textContent = '当前 ' + (BACKEND_LABEL[cur] || cur)
      + (st ? (' · ' + st.sessions + ' 会话 / ' + st.messages + ' 消息 / 写 ' + st.writes + ' 次') : '');
  }

  /* ---------- 整库备份 / 恢复（本地数据库，见 store.exportAll / importAll） ---------- */

  function backupFileName() {
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'fengyue-backup-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate())
      + '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.json';
  }

  /** 导出：把角色/会话/消息/记忆/设置整包写进 Download。 */
  function exportBackup() {
    if (!bridgeAlive()) { toast('网页预览模式不能写文件', 'warn'); return null; }
    var payload = S.store.exportAll();
    var name = backupFileName();
    var json = JSON.stringify(payload, null, 1);
    var r = fyCall('saveBackup', [name, json]);
    if (r && r.ok) {
      toast('已导出 ' + name + '（' + payload.messages.length + ' 条消息）', 'ok', 4000);
      fyLog('备份已导出：' + (r.path || name));
    } else {
      toast('导出失败：' + ((r && r.message) || '未知错误'), 'err', 3600);
    }
    return r;
  }

  /** 恢复：解析备份文本 → 二次确认 → 覆盖式导入 → 刷新界面。 */
  function importBackupFromText(text, srcName) {
    var payload;
    try {
      payload = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
    } catch (e) {
      toast('备份解析失败：' + ((e && e.message) || e), 'err', 3800);
      return false;
    }
    var c = {
      characters: (payload.characters || []).length,
      sessions: (payload.sessions || []).length,
      messages: (payload.messages || []).length
    };
    confirmAction('从备份恢复',
      '将用备份覆盖当前数据：' + c.characters + ' 个角色 / ' + c.sessions + ' 个会话 / '
      + c.messages + ' 条消息。当前的角色与聊天记录会被替换，确定继续？',
      '覆盖恢复', function () {
        try {
          var counts = S.store.importAll(payload);
          S.characters = S.store.listCharacters();
          S.sessions = S.store.listSessions();
          var sessions = S.sessions;
          S.session = sessions.length ? S.store.getSession(sessions[0].id) : null;
          S.messages = S.session ? S.store.listMessages(S.session.id) : [];
          S.activeSessionId = S.session ? S.session.id : '';
          renderCharacters();
          renderSessions && renderSessions();
          switchView(S.session ? 'chat' : 'characters');
          if (S.session) { renderChatHeader(); renderMessages(); }
          toast('已恢复：' + counts.characters + ' 角色 / ' + counts.messages + ' 条消息', 'ok', 4000);
          fyLog('备份已恢复，来源=' + (srcName || '?') + ' 统计=' + JSON.stringify(counts));
        } catch (e) {
          toast('恢复失败：' + ((e && e.message) || e), 'err', 4000);
        }
      });
    return true;
  }

  /** 把当前编辑中的角色导出成 chara_card_v2，写到 Download。 */
  function exportCharCard() {
    var c = S.editChar;
    if (!c) { toast('先保存这个角色，再导出', 'warn'); return null; }
    if (!bridgeAlive()) { toast('网页预览模式不能写文件', 'warn'); return null; }
    var name = FYCards.fileNameFor(c);
    var json = JSON.stringify(FYCards.toCardV2(c), null, 2);
    var r = fyCall('saveCharacterCard', [name, json]);
    if (r && r.ok) {
      toast('已导出到 Download/' + name, 'ok', 3600);
      fyLog('角色卡已导出：' + (r.path || name));
    } else {
      toast('导出失败：' + ((r && r.message) || '未知错误'), 'err', 3600);
    }
    return r;
  }

  function saveCharSheet() {
    var patch = collectCharForm();
    if (!patch.name) {
      $('charSheetErr').hidden = false;
      $('charSheetErr').textContent = '请填一个名字';
      return;
    }
    /* 质量闸门：有硬伤不拦着保存，但要用户知道自己在存什么 */
    var r = S.lint || (global.FYCreator ? FYCreator.lint(patch, {}) : null);
    if (r && r.errors > 0) {
      confirmAction('还有 ' + r.errors + ' 处不达标',
        '「质量评分」里标红的 ' + r.errors + ' 条是发布级标准（人设长度、开场白、示例对话、/no_think 等）。' +
        '照样保存也能聊，只是更容易出戏。',
        '就这样保存', function () { doSaveChar(patch); });
      return;
    }
    doSaveChar(patch);
  }

  function doSaveChar(patch) {
    var saved = S.store.saveCharacter(patch);
    closeSheet($('charSheetMask'));
    toast('已保存「' + saved.name + '」', 'ok');
    fyLog('角色已保存 id=' + saved.id + ' 分类=' + (saved.tags || []).join('/') + ' 类型=' + saved.kind);
    S.characters = S.store.listCharacters();
    S.charCount = -1;   /* 让分类 chips 按新标签重算 */
    if (S.session) { S.session = S.store.getSession(S.session.id) || S.session; }
    renderCharCats();
    renderCharacters();
    if (S.view === 'chat') { renderChatHeader(); renderMessages(); }
  }

  /* ===========================================================================
   * 8. 会话与聊天
   * ======================================================================== */

  function openSoloChat(charId, sessionId) {
    var sess = sessionId ? S.store.getSession(sessionId) : null;
    if (!sess) {
      var c = charById(charId);
      /* 剧情卡（kind=story / plot=true）开局就进剧情模式：它的开场白本来就是一段处境 */
      var wantPlot = (c && (c.plot || c.kind === 'story')) ? true : !!S.settings.plotDefault;
      sess = S.store.saveSession({
        title: c ? c.name : '新的对话',
        characterIds: [charId],
        mode: 'solo',
        plot: wantPlot
      });
      if (c && c.kind === 'story') toast('剧情卡：已自动开启剧情模式', 'ok', 2200);
      fyLog('新建会话 ' + sess.id + ' → ' + (c && c.name));
    }
    activateSession(sess.id);
  }

  function activateSession(sessionId) {
    var sess = S.store.getSession(sessionId);
    if (!sess) { toast('会话不存在', 'err'); return; }
    S.session = sess;
    S.store.setActiveSessionId(sessionId);
    S.messages = S.store.listMessages(sessionId);
    /* 第一次进入角色：自动插入开场白 */
    if (!S.messages.length) insertGreeting(sess);
    switchView('chat');
    maybeCompressMemory();
  }

  function insertGreeting(sess) {
    var chars = sess.characterIds.map(charById).filter(Boolean);
    chars.forEach(function (c, i) {
      if (!c.greeting) return;
      var m = S.store.addMessage({
        sessionId: sess.id, role: 'assistant',
        content: c.greeting, characterId: c.id,
        speakerName: c.name, speakerAvatar: c.avatar,
        ts: Date.now() + i
      });
      S.messages.push(m);
    });
  }

  function scrollMessagesToBottom(force) {
    var box = $('messages');
    if (!box) return;
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    if (force || near) box.scrollTop = box.scrollHeight;
  }

  function renderChatHeader() {
    var box = $('chatAvatars');
    box.innerHTML = '';
    var chars = sessionCharacters();
    if (!chars.length) {
      $('chatHeadName').textContent = '未选择角色';
      $('chatHeadSub').textContent = '去角色页选一个吧';
    } else {
      chars.slice(0, 4).forEach(function (c) {
        box.appendChild(fillAvatar(el('div', 'mini-avatar'), c, 34));
      });
      $('chatHeadName').textContent = S.session.mode === 'group'
        ? ('群聊 · ' + chars.map(function (c) { return c.name; }).join('、'))
        : chars[0].name;
      $('chatHeadSub').textContent = chars.length === 1
        ? (chars[0].tagline || '')
        : (chars.length + ' 位角色轮流出场');
      if (chars.length > 4) box.appendChild(el('div', 'mini-avatar', '+' + (chars.length - 4)));
    }
    $('btnPlotToggle').classList.toggle('on', !!(S.session && S.session.plot));
    $('btnGroupToggle').classList.toggle('on', !!(S.session && S.session.mode === 'group'));
    $('topTitle').textContent = S.session ? (S.session.title || '聊天') : '聊天';
    $('topSub').textContent = chatSubtitle();
    $('btnSend').hidden = S.generating;
    $('btnStop').hidden = !S.generating;
  }

  /** 单条消息的 DOM */
  function messageNode(m) {
    var node = el('div', 'msg ' + (m.role === 'user' ? 'user' : 'assistant'));
    node.dataset.id = m.id;

    var chars = sessionCharacters();
    var speaker = null;
    if (m.characterId) speaker = charById(m.characterId);
    if (m.role === 'assistant' || chars.length > 1) {
      var avNode = el('div', 'msg-avatar');
      if (m.role === 'assistant' && speaker) fillAvatar(avNode, speaker, 33);
      else avNode.textContent = m.speakerAvatar || (speaker && speaker.avatar) || (m.role === 'user' ? '🧑' : '🤖');
      node.appendChild(avNode);
    }

    var col = el('div', 'msg-col');
    if (m.role === 'assistant' && S.session && S.session.mode === 'group') {
      col.appendChild(el('div', 'msg-speaker', m.speakerName || (speaker && speaker.name) || '角色'));
    }

    /* 思考过程折叠区 */
    if (m.thinking && S.settings.plotDefault !== 'never' && m.thinking.trim()) {
      var th = el('div', 'think');
      var head = el('div', 'think-head');
      var arrow = el('span', 'arrow');
      arrow.appendChild(iconEl('next'));
      head.appendChild(arrow);
      head.appendChild(el('span', '', '思考过程'));
      head.onclick = function () { th.classList.toggle('open'); };
      th.appendChild(head);
      th.appendChild(el('div', 'think-body', m.thinking));
      col.appendChild(th);
    }

    var b = el('div', 'bubble' + (m.error ? ' err' : ''));
    b.innerHTML = esc(m.content) + (m.aborted ? '<span class="muted xs"> （已停止）</span>' : '');
    col.appendChild(b);

    var tools = el('div', 'msg-tools');
    if (m.role === 'assistant') {
      var btnRead = el('button', '');
      btnRead.appendChild(iconEl('speaker'));
      btnRead.title = '朗读';
      btnRead.onclick = function (ev) { ev.stopPropagation(); speakMessage(m.id, m.content); };
      if (S.speakingMsgId === m.id) btnRead.classList.add('reading');
      tools.appendChild(btnRead);
      var btnRe = el('button', '');
      btnRe.appendChild(iconEl('refresh'));
      btnRe.title = '重新生成';
      btnRe.onclick = function (ev) { ev.stopPropagation(); regenerateFrom(m.id); };
      tools.appendChild(btnRe);
    }
    var btnMore = el('button', '');
    btnMore.appendChild(iconEl('more'));
    btnMore.title = '更多';
    btnMore.onclick = function (ev) { ev.stopPropagation(); messageActions(m); };
    tools.appendChild(btnMore);

    /* 长按 = 打开同一菜单（移动端习惯） */
    var lp = null;
    b.addEventListener('touchstart', function () {
      lp = setTimeout(function () { messageActions(m); }, 520);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(function (e2) {
      b.addEventListener(e2, function () { if (lp) { clearTimeout(lp); lp = null; } }, { passive: true });
    });
    b.addEventListener('click', function () { if (m.content) messageActions(m); });

    col.appendChild(tools);
    node.appendChild(col);
    return node;
  }

  function renderMessages() {
    var box = $('messages');
    box.innerHTML = '';
    if (!S.session) {
      box.appendChild(el('div', 'empty', '还没有选择角色。去「角色」页点一个吧。'));
      return;
    }
    S.messages.forEach(function (m) { box.appendChild(messageNode(m)); });
    /* 流式中的那条加光标 */
    if (S.generating) {
      var last = S.messages[S.messages.length - 1];
      if (last && last.role === 'assistant') {
        var n = box.querySelector('.msg[data-id="' + last.id + '"] .bubble');
        if (n) n.classList.add('streaming');
      }
    }
    scrollMessagesToBottom(true);
  }

  /** 取最后一条消息元素（用于增量更新） */
  function lastAssistantNode() {
    var box = $('messages');
    var nodes = box.querySelectorAll('.msg.assistant');
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  function messageActions(m) {
    var acts = [];
    acts.push({ icon: '📋', label: '复制内容', run: function () { copyText(m.content); } });
    if (m.role === 'assistant') {
      acts.push({ icon: '🔊', label: '朗读', run: function () { speakMessage(m.id, m.content); } });
      acts.push({ icon: '🔄', label: '重新生成这条', run: function () { regenerateFrom(m.id); } });
    }
    if (m.role === 'user') {
      acts.push({
        icon: '✏️', label: '编辑后重发', run: function () { editAndResend(m); }
      });
    }
    acts.push({
      icon: '🗑️', label: '删除这条消息', danger: true, run: function () {
        S.store.deleteMessage(m.id);
        S.messages = S.store.listMessages(S.session.id);
        renderMessages();
        toast('已删除', 'ok');
      }
    });
    openActions(m.role === 'user' ? '我的消息' : '角色消息', acts);
  }

  function editAndResend(m) {
    var v = global.prompt('编辑后重发：', m.content);
    if (v === null) return;
    v = String(v).trim();
    if (!v) { toast('内容不能为空', 'warn'); return; }
    /* 删掉这条以及之后的所有消息，然后用新内容重发 */
    S.store.deleteMessagesFrom(S.session.id, m.ts);
    S.messages = S.store.listMessages(S.session.id);
    renderMessages();
    sendUserMessage(v);
  }

  function regenerateFrom(mid) {
    if (S.generating) { toast('正在生成中…', 'warn'); return; }
    var idx = -1;
    S.messages.forEach(function (m, i) { if (m.id === mid) idx = i; });
    if (idx < 0) return;
    /* 从这条 AI 消息起全部删掉，重新生成 */
    var from = S.messages[idx].ts;
    S.store.deleteMessagesFrom(S.session.id, from);
    S.messages = S.store.listMessages(S.session.id);
    S.lastUserText = lastUserContent();
    renderMessages();
    runGeneration();
  }

  function lastUserContent() {
    for (var i = S.messages.length - 1; i >= 0; i--) {
      if (S.messages[i].role === 'user') return S.messages[i].content;
    }
    return '';
  }

  /* ===========================================================================
   * 9. 提示词组装
   * ======================================================================== */

  function engineReady() { return S.engineState && S.engineState.state === 'ready'; }

  /* ---------- 模型来源（内置引擎 / 外部 OpenAI 兼容服务） ----------
     外部服务包括：局域网自建的 Ollama / LM Studio / llama.cpp server / vLLM（不要 key），
     以及云端 OpenAI 兼容 API（要 key）。两者协议一样，所以只存一份配置。
     请求都发到同源的 /api，由原生侧代理转发 —— 绕开 CORS，且 key 不进 WebView。 */

  /** fyCall 会把原生返回的 JSON 字符串解析成对象，但也可能返回字符串或 null —— 统一收口 */
  function asObj(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return (typeof raw === 'object') ? raw : null;
  }

  /* 常见 OpenAI 兼容服务商预设：一键把 base url 填好。
     豆包（火山方舟）的模型名要填「接入点 ID（ep-…）」或模型名，且方舟不提供 /models 列表，
     所以模型名必须允许手填 —— 见下面的 datalist 输入框。 */
  /* 默认推荐 DeepSeek：便宜、够聪明、OpenAI 兼容、填个 Key 就能用，
     比让用户先下 2GB 模型再等 CPU 慢慢推要省事得多。 */
  var DEFAULT_PRESET = 'deepseek';

  var PROVIDER_PRESETS = {
    deepseek:  { name: 'DeepSeek（默认推荐）', url: 'https://api.deepseek.com/v1',
                 model: 'deepseek-chat',
                 hint: '到 platform.deepseek.com 建一个 API Key 填进来即可；模型名默认 deepseek-chat（也可填 deepseek-reasoner）' },
    ark:       { name: '火山方舟 · 豆包', url: 'https://ark.cn-beijing.volces.com/api/v3',
                 hint: '到火山方舟控制台创建推理接入点，模型名填 ep-… 或 doubao-…；该服务不返回模型列表，手填即可' },
    dashscope: { name: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                 hint: '模型名填 qwen-plus / qwen-max / qwen-turbo 等' },
    zhipu:     { name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4',
                 hint: '模型名填 glm-4-flash / glm-4-plus 等' },
    moonshot:  { name: '月之暗面 Kimi', url: 'https://api.moonshot.cn/v1',
                 hint: '模型名填 kimi-k2-0905-preview 等' },
    openai:    { name: 'OpenAI', url: 'https://api.openai.com/v1',
                 hint: '模型名填 gpt-4o-mini 等；注意访问可能需要网络代理' },
    ollama:    { name: 'Ollama（局域网）', url: 'http://192.168.1.5:11434/v1',
                 hint: '把 IP 换成你电脑的；Ollama 要设 OLLAMA_HOST=0.0.0.0 才能被手机访问' }
  };

  function provider() { return S.provider || { mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false }; }
  function isRemote() { return provider().mode === 'remote'; }
  function providerReady() { return isRemote() ? !!provider().ready : engineReady(); }

  /** 聊天请求的落点：远程走同源代理，本地走 llama-server */
  function apiTarget() {
    if (isRemote()) return '/api';
    var port = S.engineState && S.engineState.port;
    if (!port) throw new Error('未拿到引擎端口');
    return 'http://127.0.0.1:' + port + '/v1';
  }

  /** 远程模式下把上游需要的模型名塞进请求体 */
  function applyRemoteModel(body) {
    if (isRemote() && provider().model) body.model = provider().model;
    return body;
  }

  function refreshProvider() {
    if (!bridgeAlive()) return;
    var o = asObj(fyCall('getProvider'));
    if (o && o.mode) S.provider = o;
  }

  function engineStateText() {
    var st = S.engineState ? S.engineState.state : 'stopped';
    return ({ stopped: '引擎未启动', starting: '引擎启动中', loading: '模型加载中', ready: '引擎就绪', error: '引擎出错' })[st] || st;
  }

  /** 群聊：选出本轮发言的角色 */
  function pickSpeaker() {
    var chars = sessionCharacters();
    if (!chars.length) return null;
    if (chars.length === 1) return chars[0];
    if (S.settings.speakerMode === 'random') {
      var pool = chars.filter(function (c) { return c.id !== S.session.lastSpeakerId; });
      if (!pool.length) pool = chars;
      return pool[Math.floor(Math.random() * pool.length)];
    }
    var idx = Number(S.session.speakerIndex || 0) % chars.length;
    var c = chars[idx];
    S.session = S.store.saveSession(Object.assign({}, S.session, { speakerIndex: (idx + 1) % chars.length }));
    return c;
  }

  function buildSystemPrompt(speaker) {
    var chars = sessionCharacters();
    var parts = [];
    var mem = S.store.getMemory(S.session.id, '');
    var memText = mem && mem.text ? mem.text.trim() : '';

    parts.push('你正在进行一场沉浸式的中文角色扮演对话。请始终保持角色人设，不要以 AI 或助手的身份说话。');

    if (chars.length > 1) {
      parts.push('这是一场多角色群聊，出场角色有：' +
        chars.map(function (c) { return c.name + '（' + (c.tagline || '角色') + '）'; }).join('；') + '。' +
        '每次只输出一位角色的发言，其他角色不要代为说话。');
      parts.push('【当前发言角色】' + (speaker ? speaker.name : chars[0].name) +
        '（只扮演这一个角色，用第一人称说话）');
    }

    var focus = speaker || chars[0];
    if (focus) {
      parts.push('【角色资料 · ' + focus.name + '】');
      if (focus.persona) parts.push(focus.persona);
      if (focus.systemPrompt) parts.push(focus.systemPrompt);
      if (focus.examples) parts.push('【语气参考（示例对话，不要照抄）】\n' + focus.examples);
    }

    if (memText) parts.push('【长期记忆 · 更早剧情的摘要】\n' + memText);

    if (S.session.plot) {
      parts.push('【剧情模式 · 硬性要求】\n每次回复都要在正文结束后另起一行，原样输出下面这个结构，' +
        '并把其中的文字替换成三个具体行动：\n' +
        '<<<OPTIONS\n1. 具体行动一\n2. 具体行动二\n3. 具体行动三\nOPTIONS>>>\n' +
        '注意：`<<<OPTIONS` 和 `OPTIONS>>>` 这两行是程序读取用的标记，必须一字不差地出现；' +
        '缺少它用户就无法继续剧情。（正文里不要提到这个格式本身）');
    }

    /* 注意：这一行必须是【静态】的。以前这里写了"当前时间：<实时时钟>"，
       结果 system 消息每分钟都变 → llama-server 的前缀 KV 缓存每轮全部失效 →
       历史一长每轮都要重新预填充（实测第 3 轮要 130 秒）。时间挪到最后一条消息里。 */
    parts.push('请直接输出角色的话与必要的动作描写，不要解释自己是 AI，也不要复述设定。');

    /* 关掉思考模式时，除了发 chat_template_kwargs.enable_thinking=false，
       再对 Qwen3 补一句软开关 /no_think —— 有些版本的 chat template 会忽略前者，
       而 /no_think 是 Qwen3 自己在模板里认的，双保险。 */
    var modelName = (S.engineState && S.engineState.model) || (S.settings && S.settings.model) || '';
    if (S.settings.showThinking === false && /qwen3/i.test(modelName)) {
      parts.push('/no_think');
    }
    return parts.join('\n\n');
  }

  /**
   * 每条用户消息的"发送形态"里带的当前时间。
   *
   * 关键：时间必须由消息自己的 ts 推导，而不是"发送时取now" —— 这样同一条消息
   * 在本轮请求和下一轮的历史里是**完全相同的字符串**，消息序列才是上一轮的延长线。
   *
   * 以前是发送时给最后一条追加时间戳（历史里的同一条没有），后果是：
   * 下一轮请求与上一轮的 KV 前缀在那一处就断了，llama-server 只能把
   * 「上一轮的用户消息 + 助手回复」整个重新预填充（tests/bench-prefix.mjs 实测：
   * 第 2 轮白算 75 token；改成稳定形态只要 42 token）。
   */
  function metaForMessage(m) {
    if (!m || m.role !== 'user' || !m.ts) return '';
    var d = new Date(m.ts);
    if (isNaN(d.getTime())) return '';
    return '\n\n（当前时间：' + d.toLocaleString('zh-CN') + '）';
  }

  /** 组装发往 /v1/chat/completions 的 messages */
  function buildRequestMessages(speaker) {
    var out = [{ role: 'system', content: buildSystemPrompt(speaker) }];
    var limit = Math.max(4, Number(S.settings.historyLimit) || 20);
    var list = S.messages.filter(function (m) { return !m.error && m.content; });
    var sliced = list.slice(-limit);
    sliced.forEach(function (m) {
      var text = m.content + metaForMessage(m);
      if (m.role === 'assistant' && S.session.mode === 'group' && m.speakerName) {
        text = '（' + m.speakerName + '）' + text;
      }
      out.push({ role: m.role === 'user' ? 'user' : 'assistant', content: text });
    });
    if (out.length && out[out.length - 1].role === 'assistant') {
      /* 让模型接着说，而不是复读 */
      out.push({ role: 'user', content: '（继续）' });
    }
    /* 注意这里【不再】往最后一条追加任何东西：
       * 剧情格式要求已经在 system 里（S.session.plot 为真时才拼进去），
         而且它是静态的，改开关只会让缓存失效一次，之后一直稳定；
       * 每轮变化的消息一律由消息自身携带（上面的 metaForMessage），
         保证"这一轮的 messages"永远是"上一轮的延长线"，前缀 KV 才能整段复用。 */
    /* 粗略按上下文裁剪。
       估算函数对中文按「1 字 ≈ 1 token」算，但真实 tokenizer 遇到生僻字、emoji、
       代码块时会明显更费 token，所以这里再除以 1.25 的安全系数，
       保证「估算值 ≤ budget」时「真实值 ≤ ctx - max_tokens - 64」。
       （引擎侧还开了 --context-shift 作为最后一道兜底） */
    var ctxSize = Math.max(512, Number(S.settings.ctx) || 4096);
    var budget = Math.floor((ctxSize - (Number(S.settings.maxTokens) || 512) - 64) / 1.25);
    var total = out.reduce(function (a, m) { return a + FYStore.estimateTokens(m.content) + 6; }, 0);
    while (total > budget && out.length > 2) {
      total -= FYStore.estimateTokens(out[1].content) + 6;
      out.splice(1, 1);
    }
    return out;
  }

  /* ===========================================================================
   * 10. 流式推理（SSE 解析 + 增量渲染 + 可控中断）
   * ======================================================================== */

  /** 解析增量文本里的思考段：返回 {thinking, content, open} */
  function splitThinking(full) {
    var t = String(full || '');
    var openTag = /<think\b[^>]*>/i;
    var m = t.match(openTag);
    if (m) {
      var start = m.index + m[0].length;
      var rest = t.slice(start);
      var closeRe = /<\/think\s*>|<｜end▁of▁thinking｜>|<\/redacted_thinking\s*>/i;
      var cm = rest.match(closeRe);
      if (cm) {
        return { thinking: rest.slice(0, cm.index).trim(), content: t.slice(0, m.index) + rest.slice(cm.index + cm[0].length), open: false };
      }
      return { thinking: rest.trim(), content: t.slice(0, m.index), open: true };
    }
    /* 只有结束标记（有的模板会把开始标记吞掉；流式时第一片 delta 也可能从思考块中间开始）。
       注意这里必须和上面的 closeRe 保持一致，三处结束标记都要认。 */
    var only = t.match(/<\/think\s*>|<｜end▁of▁thinking｜>|<\/redacted_thinking\s*>/i);
    if (only) {
      return { thinking: t.slice(0, only.index).trim(), content: t.slice(only.index + only[0].length), open: false };
    }
    return { thinking: '', content: t, open: false };
  }

  var OPT_RE = /<<<\s*OPTIONS\s*\n?([\s\S]*?)(?:OPTIONS\s*>>>|$)/i;

  /**
   * 剥掉模型回吐的「App 自己塞进去的元信息」。
   *
   * 实测（真机 + 0.5B）：我们把「（当前时间：…）」「（提醒：…）」追加在最后一条 user 消息末尾，
   * 小模型会顺着往下写，把它们当正文吐出来 —— 而且回吐的提醒里如果带了字面标记，
   * 选项解析器还会把它当成合法的选项块。这里一旦在正文里看到这两个开头就直接截断。
   */
  function stripPromptLeak(t) {
    var s = String(t || '');
    var i = s.search(/（\s*(当前时间|提醒)\s*[:：]/);
    if (i >= 0) return s.slice(0, i).replace(/[\s\n]+$/, '');
    return s;
  }

  /** 选项是否可用：至少 2 条，且每条有真内容（挡掉回吐提示词产生的空选项/占位符）。 */
  var OPT_JUNK = /(具体行动|OPTIONS|严格按|系统提示|格式见|示例)/;
  function optionsUsable(list) {
    if (!list || list.length < 2) return false;
    var good = 0;
    for (var i = 0; i < list.length; i++) {
      var t = String(list[i] == null ? '' : list[i]);
      if (OPT_JUNK.test(t)) return false;
      // 去掉标点/分隔符后还剩至少 2 个字符才算真选项
      if (t.replace(/[\s\/|\-—·.、,，:：;；()（）【】"'“”]/g, '').length >= 2) good++;
    }
    return good >= 2;
  }

  /* 兜底：模型没写标记、但把选项直接写成编号列表时的识别。
     实测 Qwen3-4B 有一定概率只输出 "1. xxx 2. xxx 3. xxx"（连标记一起丢掉），
     甚至三条挤在同一行里（选项 1 前面直接跟着问号/句号，没有空格），
     所以这里不要求编号前面是空白，只排除它属于多位数（如 "10." 里的 0）。 */
  var LOOSE_OPT_RE = /(\d)\s*[.、)）:：]\s*/g;

  /**
   * 没有 <<<OPTIONS 标记时的兜底解析：找正文末尾从 1 开始的连续编号列表。
   * 只在剧情模式、且流式结束时调用（allowLoose=true），避免流式中途误判。
   */
  function extractLooseOptions(t) {
    var s = String(t || '');
    var tail = s.slice(-500);
    var matches = [];
    var m;
    LOOSE_OPT_RE.lastIndex = 0;
    while ((m = LOOSE_OPT_RE.exec(tail)) !== null) {
      /* 排除 "10." 这种多位数里被当成编号的末位 */
      if (m.index > 0 && /\d/.test(tail.charAt(m.index - 1))) continue;
      matches.push({ n: Number(m[1]), start: m.index, contentStart: m.index + m[0].length });
    }
    if (matches.length < 3) return null;

    /* 从后往前找一段「末尾连续、编号从 1 递增」的序列 */
    for (var end = matches.length - 1; end >= 0; end--) {
      var seq = [matches[end]];
      for (var i = end - 1; i >= 0; i--) {
        if (matches[i].n === seq[0].n - 1) seq.unshift(matches[i]);
        else break;
      }
      if (seq.length < 3 || seq[0].n !== 1) continue;
      /* 选项列表的特征：短、结尾干脆。用两条规则挡掉"正文里恰好有编号"的误判：
         1) 最后一条选项之后不能还有带句末标点的正文
         2) 每条选项本身不能太长 */
      var trailing = tail.slice(matches[end].contentStart);
      if (!trailing || trailing.length > 80) continue;
      if (/[。！？；;]/.test(trailing)) continue;
      var tooLong = seq.some(function (it, idx) {
        var to = (idx + 1 < seq.length) ? seq[idx + 1].start : tail.length;
        return tail.slice(it.contentStart, to).replace(/[\s\n]+$/, '').trim().length > 60;
      });
      if (tooLong) continue;
      var items = [];
      for (var k = 0; k < seq.length; k++) {
        var from = seq[k].contentStart;
        var to = (k + 1 < seq.length) ? seq[k + 1].start : tail.length;
        var txt = tail.slice(from, to).replace(/[\s\n]+$/, '').trim();
        if (txt) items.push(txt);
      }
      if (items.length >= 3) {
        var body = s.slice(0, s.length - tail.length + seq[0].start).replace(/[\s\n]+$/, '');
        return { content: body, options: items.slice(0, 6) };
      }
    }
    return null;
  }

  /**
   * 从（可能还没输出完的）文本里剥出正文 + 选项。
   *
   * 返回值里的 pending 只表示「正文里出现了 <<< 开头、但选项块暂时还看不出内容」，
   * 用于流式过程中避免把半截标记闪给用户看。它**不是**「标记未闭合」的意思：
   * 只要 <<<OPTIONS 已经完整出现，哪怕后面还在一个字一个字地吐、还没有 OPTIONS>>>，
   * 也会立刻按当前已有的行解析出选项（选项会随流式逐渐长出来），此时 pending 为 false。
   *
   * @param {boolean} allowLoose 是否允许"没有标记、只有编号列表"的兜底解析
   */
  function extractOptions(text, allowLoose) {
    var t = String(text || '');
    var m = t.match(OPT_RE);
    if (!m) {
      /* 只看到 <<<OPTIONS 的前半截（如 "<<<OPT"）：先不显示这一段，避免闪烁。
         注意：一旦标记完整出现就会走上面的分支，pending 随即变回 false。 */
      var partial = t.match(/<<<\s*O?P?T?I?O?N?S?[\s\S]*$/i);
      if (partial && /<<</.test(t)) {
        /* 与完整解析保持一致地去掉尾部空白，避免流式过程中气泡里多出一个空行 */
        return { content: t.slice(0, partial.index).replace(/\s+$/, ''), options: [], pending: true };
      }
      if (allowLoose) {
        var loose = extractLooseOptions(t);
        if (loose) {
          loose.pending = false;
          loose.loose = true;   // 标记一下：这是兜底解析出来的，方便排查
          return loose;
        }
      }
      return { content: t, options: [], pending: false };
    }
    var body = t.slice(0, m.index);
    var raw = m[1] || '';
    var options = raw.split('\n').map(function (line) {
      return line.replace(/^\s*(?:[-*•]|\d+[.、)）:])\s*/, '').trim();
    }).filter(function (s) { return s.length > 0; }).slice(0, 6);
    return { content: body.replace(/\s+$/, ''), options: options, pending: false };
  }

  function buildRequestBody(speaker) {
    var body = {
      messages: buildRequestMessages(speaker),
      stream: true,
      temperature: Number(S.settings.temperature),
      top_p: Number(S.settings.topP),
      max_tokens: Number(S.settings.maxTokens)
    };
    if (S.settings.showThinking === false) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    return body;
  }

  /* ---------- 进程内引擎（JNI）：不经过 HTTP ----------
     和 llama-server 那条路的区别：没有端口、没有 SSE，token 由原生侧合批后
     用 gen 事件推上来。好处是静态前缀（人设/世界书）真的常驻 KV，
     不用每轮把整段 prompt 重新 prefill 一遍。 */

  /** 当前这一轮原生生成。同一时刻只允许一轮（App 侧本来就有 generating 闸门）。 */
  var nativeGen = null;

  function nativeReady() {
    return !isRemote() && !!(S.engineState && S.engineState.native) && engineReady();
  }

  /** 把聊天请求体翻译成原生侧的采样参数（字段名对齐，不传 JSON 里的 OpenAI 那套）。 */
  function nativeOpts(body) {
    return {
      /* 静态前缀 = 前几条 message。默认 1 条 system —— 人设+世界书都在里面。 */
      pinMessages: body.pinMessages === undefined ? 1 : Number(body.pinMessages),
      maxTokens: Number(body.max_tokens) || 512,
      temperature: body.temperature === undefined ? 0.8 : Number(body.temperature),
      topK: body.top_k === undefined ? 40 : Number(body.top_k),
      topP: body.top_p === undefined ? 0.95 : Number(body.top_p),
      seed: Number(body.seed) || 0
    };
  }

  /**
   * 「关掉思考」在进程内这条路上的落地方式。
   *
   * llama-server 那条路可以发 `chat_template_kwargs:{enable_thinking:false}`，
   * 但进程内用的 `llama_chat_apply_template` **不吃 jinja 额外变量**。
   * 好在 Qwen3 的模板自己认 `/no_think` 这个软开关，所以这里给它补上。
   *
   * 三个约束：
   *   - 只在模型确实是 Qwen3 时补（别的模型认不认这个词没保证）；
   *   - system 里已经有 /no_think 就不重复加（聊天那条路的人设本来就带）；
   *   - 返回**新**数组、不动传入的消息 —— 历史消息必须保持一模一样的字符串，
   *     前缀 KV 复用全靠这个（见 docs/native-engine.md）。
   */
  function applyNoThink(messages, body) {
    var kw = body && body.chat_template_kwargs;
    if (!messages || !kw || kw.enable_thinking !== false) return messages;
    var model = (S.engineState && S.engineState.model) || (S.settings && S.settings.model) || '';
    if (!/qwen3/i.test(model)) return messages;
    var idx = -1;
    for (var i = 0; i < messages.length; i++) {
      if (messages[i] && messages[i].role === 'system') { idx = i; break; }
    }
    if (idx < 0 || /\/no_think/.test(String(messages[idx].content || ''))) return messages;
    var out = messages.slice();
    out[idx] = Object.assign({}, messages[idx], {
      content: String(messages[idx].content || '') + '\n/no_think'
    });
    return out;
  }

  /**
   * 走进程内引擎跑一轮，返回 {text, stats}。
   *
   * 原生侧同一时刻只接一轮（llama_context 不可重入），所以这里排成一条链：
   * 记忆压缩撞上正文生成时是排队，而不是两边一起进去把引擎搞崩。
   *
   * @param {Array}  messages [{role, content}]
   * @param {object} body     原始请求体（取采样参数）
   * @param {function} onDelta (累积文本) => void
   * @param {AbortSignal} signal
   */
  var nativeQueue = Promise.resolve();

  function nativeComplete(messages, body, onDelta, signal) {
    var run = function () {
      return new Promise(function (resolve, reject) {
        var req = nativeOpts(body || {});
        var token = 'g' + Date.now() + '-' + Math.floor(Math.random() * 10000);
        var g = { id: token, acc: '', onDelta: onDelta || null, settled: false };
        g.settle = function (err, stats) {
          if (g.settled) return;
          g.settled = true;
          if (nativeGen === g) nativeGen = null;
          if (err) { reject(err); return; }
          /* 「停止生成」要和 HTTP 那条路表现一致：抛 AbortError，上层才会把这条消息标成中断 */
          if (signal && signal.aborted) {
            var ae = new Error('aborted');
            ae.name = 'AbortError';
            reject(ae);
            return;
          }
          /* 真实 token 数照样喂给估算校正（HTTP 那条路是从 SSE 的 timings 里取的） */
          if (stats && stats.prompt) S.lastTimings = { prompt_n: stats.prompt, predicted_n: stats.gen };
          resolve({ text: g.acc, stats: stats || {} });
        };
        nativeGen = g;

        var ack = asObj(fyCall('chat', [JSON.stringify(applyNoThink(messages, body)), JSON.stringify(req)]));
        if (!ack || ack.ok !== true) {
          g.settle(new Error((ack && ack.message) || '进程内引擎拒绝了这次生成'));
          return;
        }
        g.id = ack.id || token;

        if (signal) {
          var onAbort = function () { fyCall('chatStop', [], true); };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort);
        }
      });
    };
    var p = nativeQueue.then(run, run);
    nativeQueue = p.then(function () {}, function () {});
    return p;
  }

  /** gen 事件：把原生侧推上来的 token 拼起来（见 handleEvent） */
  function nativeGenEvent(p) {
    var g = nativeGen;
    if (!g || (p.id && p.id !== g.id)) return;
    if (p.state === 'delta') {
      g.acc += (p.delta || '');
      if (g.onDelta) g.onDelta(g.acc);
    } else if (p.state === 'done') {
      g.settle(null, p.stats);
    } else if (p.state === 'error') {
      g.settle(new Error(p.message || '进程内引擎出错'));
    }
  }

  /**
   * 向本地 llama-server 发起流式请求。
   *
   * 进程内引擎可用时改走 JNI（没有端口、没有 SSE），否则还是 HTTP。
   * @param {object} body 请求体
   * @param {function} onDelta (累积文本) => void
   * @param {AbortSignal} signal
   */
  function streamChat(body, onDelta, signal) {
    if (nativeReady()) {
      return nativeComplete(body.messages || [], body, onDelta, signal);
    }
    var base;
    try { base = apiTarget(); } catch (e) { return Promise.reject(e); }
    applyRemoteModel(body);
    var url = base + '/chat/completions';
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (txt) {
          throw new Error('HTTP ' + res.status + ' ' + String(txt).slice(0, 200));
        });
      }
      if (!res.body || !res.body.getReader) {
        return res.json().then(function (data) {
          var txt = data && data.choices && data.choices[0] && (data.choices[0].message || {}).content;
          onDelta(txt || '');
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buf = '';
      var acc = '';
      var done = false;
      var thinkOpen = false;   // reasoning_content 段是否已经开过  thinking 标签
      /* 主动监听 abort：不依赖 fetch 实现是否支持 signal，
         停止生成时立刻取消读取，保证「停止」永远有效。 */
      if (signal) {
        if (signal.aborted) { try { reader.cancel(); } catch (e) {} done = true; }
        else {
          signal.addEventListener('abort', function () {
            done = true;
            try { reader.cancel(); } catch (e) {}
          });
        }
      }
      /** 结束读取：如果是因为「停止生成」提前结束，要明确抛 AbortError */
      function endOfStream() {
        if (signal && signal.aborted) {
          var ae = new Error('aborted');
          ae.name = 'AbortError';
          return Promise.reject(ae);
        }
        return Promise.resolve();
      }
      function pump() {
        if (done) return endOfStream();
        return reader.read().then(function (r) {
          /* 注意：reader.cancel() 会让挂起的 read() 以 {done:true} 兑现（而不是抛错），
             所以这里必须显式判断 abort，否则「停止生成」会被误判为正常结束。
             另外，停止时可能已经有一批 chunk 到了本地缓冲里，这里先检查一次，
             保证停止后不再把缓冲内容追加到气泡上。 */
          if ((r && r.done) || done) { done = true; return endOfStream(); }
          if (signal && signal.aborted) { done = true; return endOfStream(); }
          buf += decoder.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.charAt(0) === ':') continue;
            if (line.indexOf('data:') !== 0) continue;
            var data = line.slice(5).trim();
            if (data === '[DONE]') { done = true; break; }
            try {
              var obj = JSON.parse(data);
              /* llama-server 在最后一个 chunk 里带回真实计时：prompt_n 是"这次到底喂了多少 token"。
                 拿它校正我们的估算（见 store.calibrateTokens）。 */
              if (obj.timings) S.lastTimings = obj.timings;
              var ch = obj.choices && obj.choices[0];
              var delta = ch && (ch.delta || {});
              var piece = delta.content;
              if (piece === undefined || piece === null) piece = '';
              /* 少数实现把思考放在 reasoning_content（llama-server / Qwen3 常见）。
                 这里把它「包」成一个标准思考段：整段只加一次开标签，
                 这样多片思考不会各自套一层标签、把标签漏进正文；
                 正文第一片到达时补上结束标记。 */
              var rc = delta.reasoning_content;
              if (rc === undefined || rc === null) rc = '';
              if (rc) {
                if (!thinkOpen) { piece = '<' + 'think>' + rc + piece; thinkOpen = true; }
                else { piece = rc + piece; }
              } else if (thinkOpen) {
                piece = '<' + '｜end▁of▁thinking｜>' + piece;
                thinkOpen = false;
              }
              if (piece) { acc += piece; onDelta(acc); }
            } catch (e) { /* 半截 JSON，忽略 */ }
          }
          if (done) return endOfStream();
          return pump();
        });
      }
      return pump();
    });
  }

  /** 生成一次回复（内部统一入口：流式 + 增量渲染 + 落库） */
  var continueTargetId = null;      /* 非空表示这一轮是「续写」：结果并进原消息而不是新开一条 */

  /** 把续写结果并进原文：模型常会把上一句尾巴重复一遍，这里按最长衔接片段裁掉 */
  function mergeContinuation(base, add) {
    var a = String(add || '');
    if (!base || !a) return a;
    var max = Math.min(40, base.length, a.length);
    for (var n = max; n >= 6; n--) {
      if (base.slice(base.length - n) === a.slice(0, n)) return a.slice(n).replace(/^\s+/, '');
    }
    return a.replace(/^\s+/, '');
  }

  function continueFromMessage(msg) {
    if (S.generating) { toast('正在生成中…', 'warn'); return; }
    if (!msg) return;
    continueTargetId = msg.id;
    runGeneration();
  }

  function runGeneration() {
    if (S.generating) { toast('正在生成中…', 'warn'); return; }
    if (!S.session) return;
    var chars = sessionCharacters();
    if (!chars.length) { toast('这个会话没有角色了', 'err'); return; }
    if (!providerReady()) {
      toast('引擎未就绪，请先去设置里启动引擎', 'warn', 2600);
      switchView('settings');
      return;
    }

    var speaker = pickSpeaker();
    var contTarget = continueTargetId ? S.store.getMessage(continueTargetId) : null;
    if (continueTargetId && !contTarget) continueTargetId = null;
    var msg;
    if (contTarget) {
      msg = contTarget;            /* 续写：复用原消息，不新增 */
    } else {
      msg = S.store.addMessage({
        sessionId: S.session.id, role: 'assistant', content: '',
        characterId: speaker ? speaker.id : '',
        speakerName: speaker ? speaker.name : '',
        speakerAvatar: speaker ? speaker.avatar : ''
      });
      S.messages.push(msg);
    }

    S.generating = true;
    S.abort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    lastDeltaAt = Date.now();
    renderMessages();
    renderChatHeader();
    fyCall('keepAwake', [true], true);
    applyKeepScreen();

    var raw = '';
    var paintTimer = null;
    var lastPaint = 0;
    var node = lastAssistantNode();
    var bubble = node ? node.querySelector('.bubble') : null;
    if (bubble) bubble.classList.add('streaming');

    var paintPrefix = contTarget ? (contTarget.content || '') : '';
    function paint() {
      var split = splitThinking(raw);
      var ex = extractOptions(stripPromptLeak(split.content));
      if (bubble) bubble.textContent = paintPrefix + ex.content;
      scrollMessagesToBottom(false);
    }

    function onDelta(acc) {
      raw = acc;
      lastDeltaAt = Date.now();
      var now = Date.now();
      if (now - lastPaint > 60) {
        lastPaint = now;
        paint();
      } else if (!paintTimer) {
        paintTimer = setTimeout(function () { paintTimer = null; paint(); }, 60);
      }
    }

    var body = buildRequestBody(speaker);
    if (contTarget) {
      /* 通用做法：不依赖各家私有参数，直接加一句"接着写"的指示；
         生成结果稍后并进原消息（各家 API 对 assistant 预填充支持不一） */
      body.messages = body.messages.concat([{
        role: 'user',
        content: '（继续往下写：直接从下一句接着写，不要重复已经出现过的内容，不要重新问候，不要重述设定）'
      }]);
    }
    /* 记下"我们估的 token 数"，等引擎回传 timings.prompt_n 时用来校正估算系数 */
    S.lastEstimate = body.messages.reduce(function (a, m) {
      return a + FYStore.estimateTokens(m.content || '') + 6;
    }, 0);
    FYStore.setTokenModel((S.engineState && S.engineState.model) || S.settings.model || '');
    fyLog('开始生成：会话=' + S.session.id + ' 角色=' + (speaker && speaker.name)
      + ' 上下文消息=' + body.messages.length + '（估算 ' + S.lastEstimate + ' token）');

    return streamChat(body, onDelta, S.abort ? S.abort.signal : undefined)
      .then(function () {
        finish(raw, false);
      })
      .catch(function (e) {
        var aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message)));
        finish(raw, aborted, e);
      });
  }

  function finish(raw, aborted, err) {
    S.generating = false;
    S.abort = null;
    applyKeepScreen();   // 生成结束按设置决定是否继续常亮（见 applyKeepScreen）

    /* 用引擎的真实计数校正 token 估算（下一轮裁剪就更准） */
    if (S.lastTimings && S.lastTimings.prompt_n && S.lastEstimate) {
      var before = FYStore.getTokenFactor();
      var after = FYStore.calibrateTokens(S.lastTimings.prompt_n, S.lastEstimate);
      if (Math.abs(after - before) > 0.01) {
        fyLog('token 估算校正：真实 ' + S.lastTimings.prompt_n + ' / 估算 ' + S.lastEstimate
          + ' → 系数 ' + before.toFixed(2) + ' → ' + after.toFixed(2));
      }
      S.lastTimings = null;
    }
    var split = splitThinking(raw);
    split.content = stripPromptLeak(split.content);
    /* allowLoose=true：流式结束了，如果模型没写 <<<OPTIONS 标记、
       而是把选项直接写成末尾的编号列表，这里也要认出来 —— 否则剧情功能会有概率性失效。 */
    var ex = extractOptions(split.content, true);
    /* 但兜底/标记解析出来的东西也必须是「真选项」：小模型回吐提示词时会产出
       "1. / 2. / 3. /" 这类空选项，或直接抄系统提示词里的占位符，这类一律丢掉。 */
    if (!optionsUsable(ex.options)) ex.options = [];
    var content = ex.content;
    if (err && !aborted && !content) {
      content = '生成失败：' + (err && err.message || err);
      toast('生成失败：' + (err && err.message || err), 'err', 3200);
      fyLog('生成失败 ' + (err && err.message || err));
    }

    if (continueTargetId) {
      /* 续写：把新内容并进原消息 */
      var tgt = S.store.getMessage(continueTargetId);
      var merged = tgt ? ((tgt.content || '') + mergeContinuation(tgt.content || '', content)) : content;
      var savedC = S.store.updateMessage({
        id: continueTargetId, content: merged, thinking: (tgt && tgt.thinking) || split.thinking,
        options: ex.options, aborted: !!aborted, error: !!(err && !aborted && !content)
      });
      for (var mi = 0; mi < S.messages.length; mi++) {
        if (S.messages[mi].id === continueTargetId) { S.messages[mi] = savedC; break; }
      }
      continueTargetId = null;
    } else {
      var last = S.messages[S.messages.length - 1];
      if (last && last.role === 'assistant') {
        var saved = S.store.updateMessage({
          id: last.id, content: content, thinking: split.thinking,
          options: ex.options, aborted: !!aborted, error: !!(err && !aborted && !content)
        });
        S.messages[S.messages.length - 1] = saved;
      }
    }
    S.lastOptions = ex.options || [];
    renderMessages();
    renderOptionsBar();
    renderChatHeader();
    if (S.view === 'story') renderStory();

    /* 自动朗读 */
    if (content && S.settings.autoRead && !aborted) {
      var last2 = S.messages[S.messages.length - 1];
      speakMessage(last2.id, content);
    }
    /* 触发记忆压缩（异步，不阻塞） */
    maybeCompressMemory();
  }

  function stopGeneration() {
    if (!S.generating) return;
    try { if (S.abort) S.abort.abort(); } catch (e) {}
    toast('已停止生成', 'warn');
  }

  /* ---------- 冻结自愈看门狗 ----------
     真机实测（Redmi Turbo 3 / HyperOS）：App 退到后台会被系统冻进 cgroup（cgroup.freeze=1），
     SSE 连接随之断掉，但 S.generating 还停在 true —— 再切回前台时发送键不回来、
     整个界面像死了一样，就是用户说的「点不动」。前台服务能缓解但挡不住 MIUI 的冻结策略，
     所以在 UI 侧再兜一层：生成中但超过 60 秒没有任何新 token，就判定被打断并自动收尾。
     （阈值取 60 秒是为了不误伤 3B 那种单 token 就要好几秒的慢速生成。） */
  var lastDeltaAt = 0;
  var WATCHDOG_MS = 60000;

  function watchdogTick() {
    if (!S.generating || !lastDeltaAt) return;
    if (Date.now() - lastDeltaAt < WATCHDOG_MS) return;
    lastDeltaAt = 0;
    fyLog('看门狗：超过 ' + (WATCHDOG_MS / 1000) + ' 秒没有新 token，判定生成为系统冻结打断，自动收尾');
    toast('生成似乎被系统打断了，已自动收尾，可以直接重发', 'warn', 3600);
    try { if (S.abort) S.abort.abort(); } catch (e) {}
    /* abort 也可能收不掉（连接已经死在冻结里），1.5 秒后再兜一次 */
    setTimeout(function () {
      if (S.generating) {
        S.generating = false;
        S.abort = null;
        applyKeepScreen();
        renderMessages();
        renderChatHeader();
        renderOptionsBar();
      }
    }, 1500);
  }

  setInterval(watchdogTick, 5000);
  /* 从后台切回来的瞬间立刻体检一次，不用等下一个 5 秒 */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) watchdogTick();
    applyKeepScreen();      // 前台/后台切换会改变"要不要常亮"
  });

  /* ---------- 屏幕常亮策略 ----------
     原生侧 keepAwake(true) 做两件事：前台加 FLAG_KEEP_SCREEN_ON（屏幕不熄），
     同时握一把 PARTIAL_WAKE_LOCK（息屏 / 切后台也能把这一轮生成跑完 —— 否则 Doze 会把推理压停）。
     这里只决定"什么时候该握"：
       keepScreen=auto   生成期间握（默认）
       keepScreen=always App 在前台就一直握
       keepScreen=off    从不握
     带一个去重，免得反复过桥调用原生。 */
  function applyKeepScreen() {
    var mode = (S.settings && S.settings.keepScreen) || 'auto';
    var want;
    if (S.generating) want = mode !== 'off';            // 生成中一律保持（后台也要跑完）
    else if (mode === 'always') want = !document.hidden;
    else want = false;
    S.keepAwakeOn = !!want;
    if (S.keepAwakeApplied === want) return;
    S.keepAwakeApplied = want;
    fyCall('keepAwake', [want], true);
  }

  /** 设置页那行说明文案，随选项变 */
  function renderKeepScreenHint() {
    var el = $('keepScreenHint');
    if (!el) return;
    var v = (S.settings && S.settings.keepScreen) || 'auto';
    el.textContent = v === 'always'
      ? '只要停在 App 里就不熄屏（耗电会多一点）'
      : (v === 'off'
        ? '不保持常亮；息屏后这轮生成可能被系统拖慢'
        : '生成期间不熄屏，切到后台也会把这一轮跑完');
  }

  /* ---------- 发送 ---------- */

  function sendUserMessage(text) {
    var v = String(text === undefined ? $('input').value : text).trim();
    if (!v) return;
    if (!S.session) { toast('先去角色页选一个角色', 'warn'); return; }
    if (!providerReady()) {
      toast(isRemote() ? '外部模型未配置好（设置 → 模型来源）' : '引擎未就绪：请到设置里启动引擎后再发消息', 'warn', 2800);
      renderEngineBanner();
      return;
    }
    if (S.generating) { toast('正在生成中，先停下再发', 'warn'); return; }

    S.store.addMessage({
      sessionId: S.session.id, role: 'user', content: v,
      speakerName: '我', speakerAvatar: '🧑'
    });
    S.messages = S.store.listMessages(S.session.id);
    $('input').value = '';
    autoGrowInput();
    S.lastUserText = v;
    renderMessages();
    runGeneration();
  }

  function sendOption(text) {
    if (S.generating) { toast('正在生成中…', 'warn'); return; }
    sendUserMessage(text);
  }

  /* ===========================================================================
   * 11. 剧情选项栏 + 剧情视图
   * ======================================================================== */

  function renderOptionsBar() {
    var bar = $('optionsBar');
    bar.innerHTML = '';
    var opts = S.lastOptions || [];
    if (!opts.length || !S.session || !S.session.plot) { bar.hidden = true; return; }
    opts.forEach(function (o, i) {
      var b = el('button', 'opt-btn');
      b.appendChild(el('span', 'opt-idx', String(i + 1)));
      b.appendChild(el('span', '', o));
      b.onclick = function () { bar.hidden = true; sendOption(o); };
      bar.appendChild(b);
    });
    bar.hidden = false;
  }

  function renderStory() {
    var sw = $('storySwitch');
    var on = !!(S.session && S.session.plot);
    sw.checked = on;

    var body = $('storyBody');
    var choices = $('storyChoices');
    body.textContent = '';
    choices.innerHTML = '';

    if (!S.session) {
      body.textContent = '还没有进行中的剧情。去角色页选一个角色，然后在聊天页打开「剧情」开关。';
      choices.appendChild(el('span', 'muted sm', '暂无记录'));
      return;
    }
    var chars = sessionCharacters();
    body.appendChild(el('div', '', '剧本：' + (S.session.title || '未命名') + '（' + (chars.map(function (c) { return c.name; }).join('、') || '无角色') + '）'));
    body.appendChild(el('div', 'muted sm', '消息 ' + S.messages.length + ' 条 · 记忆 ' + memoryCovered(S.session.id) + ' 条 · ' + (on ? '剧情模式已开启' : '剧情模式已关闭')));

    var opts = S.lastOptions || [];
    if (on && opts.length) {
      body.appendChild(el('div', 'card-subtitle', '当前可选：'));
      opts.forEach(function (o, i) {
        var b = el('button', 'opt-btn');
        b.appendChild(el('span', 'opt-idx', String(i + 1)));
        b.appendChild(el('span', '', o));
        b.onclick = function () { switchView('chat'); sendOption(o); };
        body.appendChild(b);
      });
    } else if (on) {
      body.appendChild(el('div', 'muted sm', '发出下一句后，模型会给出 3 个选项。'));
    }

    /* 最近的选择记录 = 最近的用户消息 */
    var users = S.messages.filter(function (m) { return m.role === 'user'; }).slice(-6).reverse();
    if (!users.length) { choices.appendChild(el('span', 'muted sm', '暂无记录')); return; }
    users.forEach(function (m) {
      var row = el('div', 'dl-row');
      row.appendChild(el('span', 'grow', m.content.slice(0, 60)));
      row.appendChild(el('span', 'muted xs', fmtWhen(m.ts)));
      choices.appendChild(row);
    });
  }

  /* ===========================================================================
   * 12. 长期记忆压缩
   * ======================================================================== */

  function memoryCovered(sessionId) {
    var mem = S.store.getMemory(sessionId, '');
    return mem ? Number(mem.covered || 0) : 0;
  }

  /** 找出需要压缩的早期消息（记忆里还没覆盖的部分） */
  function messagesToCompress() {
    if (!S.settings.memoryEnabled) return [];
    var covered = memoryCovered(S.session.id);
    var list = S.messages.filter(function (m) { return m.content && !m.error; });
    var keepRecent = Math.max(6, Math.min(12, Number(S.settings.historyLimit) || 20));
    var older = list.slice(covered, Math.max(0, list.length - keepRecent));
    return older;
  }

  function maybeCompressMemory() {
    if (!S.session || S.generating) return;
    if (!providerReady()) return;
    var need = messagesToCompress();
    var threshold = Math.max(6, Number(S.settings.memoryThreshold) || 20);
    if (need.length < threshold) return;
    compressMemory(false).catch(function (e) { fyLog('记忆压缩失败：' + (e && e.message || e)); });
  }

  /**
   * 用模型把早期对话压缩成摘要，存进 IndexedDB 的 memories。
   * @param {boolean} force 手动触发（失败要提示）
   */
  function compressMemory(force) {
    if (!S.session) return Promise.reject(new Error('没有会话'));
    if (!providerReady()) {
      toast('引擎未就绪，无法压缩记忆', 'warn');
      return Promise.reject(new Error('引擎未就绪'));
    }
    var older = force ? (function () {
      var covered = memoryCovered(S.session.id);
      var list = S.messages.filter(function (m) { return m.content && !m.error; });
      return list.slice(covered, Math.max(0, list.length - 4));
    })() : messagesToCompress();

    if (!older.length) {
      if (force) toast('没有新的早期对话需要压缩', 'warn');
      return Promise.resolve(false);
    }

    var prev = S.store.getMemory(S.session.id, '');
    var lines = older.map(function (m) {
      var who = m.role === 'user' ? '用户' : (m.speakerName || '角色');
      return who + '：' + m.content.replace(/\s+/g, ' ').slice(0, 300);
    }).join('\n');

    var prompt = '下面是一段角色扮演对话的早期记录。请把它压缩成一段第三人称中文摘要（180 字以内），' +
      '只保留对后续剧情重要的事实：人物关系、称呼、约定、发生过的关键事件、用户透露的偏好与经历。' +
      '不要评论，不要客套，直接输出摘要正文。\n\n' +
      (prev && prev.text ? '【已有摘要，请合并进去】\n' + prev.text + '\n\n' : '') +
      '【新增对话记录】\n' + lines;

    var body = {
      messages: [
        { role: 'system', content: '你是一个擅长信息压缩的助手，只输出摘要正文。' },
        { role: 'user', content: prompt }
      ],
      stream: false,
      temperature: 0.3,
      top_p: 0.8,
      max_tokens: 320
    };

    if (force) toast('正在压缩记忆…');
    return postJson(body).then(function (data) {
      var txt = data && data.choices && data.choices[0] &&
        ((data.choices[0].message || {}).content || data.choices[0].text) || '';
      txt = splitThinking(txt).content.trim();
      if (!txt) throw new Error('模型返回空摘要');
      var coveredNow = memoryCovered(S.session.id) + older.length;
      S.store.saveMemory({
        sessionId: S.session.id, characterId: '', text: txt, covered: coveredNow
      });
      toast('已更新长期记忆（+' + older.length + ' 条）', 'ok');
      fyLog('记忆压缩完成，覆盖 ' + coveredNow + ' 条');
      renderChatHeader();
      return true;
    }).catch(function (e) {
      if (force) toast('压缩失败：' + (e && e.message || e), 'err');
      throw e;
    });
  }

  /** 非流式 POST（记忆压缩 / 连通性测试用）。进程内引擎可用时走 JNI。 */
  function postJson(body) {
    if (nativeReady()) {
      /* 拼一个和 OpenAI 兼容响应同形的壳：调用方读的是 choices[0].message.content，
         这样两条路（HTTP / 进程内）在上层完全一样，调用点一行都不用改。 */
      return nativeComplete(body.messages || [], body, null, null).then(function (r) {
        return {
          choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
          timings: { prompt_n: r.stats.prompt, predicted_n: r.stats.gen },
          __native: true
        };
      });
    }
    var base;
    try { base = apiTarget(); } catch (e) { return Promise.reject(e); }
    applyRemoteModel(body);
    /* 摘要/测试这类"工具调用"一律关掉思考模式。
       实测（tests/probe-prompts.mjs）：同样一段摘要，开思考要 88 秒（还要多吐 355 字思考），
       关掉只要 2.6 秒，而且摘要更干净。 */
    if (!body.chat_template_kwargs) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    return fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function openMemorySheet() {
    if (!S.session) { toast('先选择一个会话', 'warn'); return; }
    var mem = S.store.getMemory(S.session.id, '');
    S.memoryTarget = { sessionId: S.session.id };
    $('memTitle').textContent = '长期记忆 · ' + (S.session.title || '');
    $('memText').value = mem ? mem.text : '';
    $('memMeta').textContent = mem
      ? ('已覆盖 ' + (mem.covered || 0) + ' 条早期消息 · 更新于 ' + fmtWhen(mem.updatedAt))
      : '还没有记忆。当未压缩的消息超过 ' + S.settings.memoryThreshold + ' 条时会自动压缩。';
    openSheet($('memMask'));
  }

  /* ===========================================================================
   * 13. 语音（TTS / STT）
   * ======================================================================== */

  function speakMessage(msgId, text) {
    var clean = splitThinking(String(text || '')).content;
    clean = clean.replace(/[*_`#>]/g, '').replace(/（[^）]{0,40}）/g, '').trim();
    if (!clean) { toast('没有可朗读的内容', 'warn'); return; }
    if (S.speakingMsgId && S.speakingMsgId !== msgId) fyCall('stopSpeak', [], true);
    var r = fyCall('speak', [clean]);
    if (r === null && !bridgeAlive()) { toast('当前环境不支持朗读', 'warn'); return; }
    S.speakingMsgId = msgId;
    renderMessages();
    fyLog('朗读消息 ' + msgId + '（' + clean.length + ' 字）');
  }

  function stopSpeak() {
    fyCall('stopSpeak', [], true);
    S.speakingMsgId = '';
    renderMessages();
  }

  function toggleListening() {
    if (S.listening) {
      fyCall('stopListening', [], true);
      setListening(false);
      return;
    }
    var r = fyCall('startListening', []);
    if (!r) { toast('语音识别不可用', 'warn'); return; }
    setListening(true);
    S.sttPartial = '';
    toast('请开始说话…');
  }

  function setListening(on) {
    S.listening = on;
    var b = $('btnMic');
    b.classList.toggle('on', on);
    while (b.firstChild) b.removeChild(b.firstChild);
    b.appendChild(iconEl(on ? 'stop' : 'mic'));
    if (on) $('input').placeholder = '正在聆听…';
    else $('input').placeholder = '说点什么…（Shift+Enter 换行）';
  }

  /* ===========================================================================
   * 14. 设置页
   * ======================================================================== */

  var THEMES = ['#7c5cff', '#ff6b9d', '#3fb6ff', '#35d07f', '#ffb020', '#ff5f6d', '#b06bff', '#00c2b2'];

  function applyTheme(color) {
    if (!color) return;
    var root = document.documentElement.style;
    root.setProperty('--accent', color);
    var m = /^#([0-9a-f]{6})$/i.exec(color);
    if (m) {
      var n = parseInt(m[1], 16);
      var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      /* 深色底上强调文字要更亮一点，浅色底上要更深 —— 否则对比度不够 */
      root.setProperty('--accent-soft', 'rgba(' + r + ',' + g + ',' + b + ',.18)');
      root.setProperty('--accent-line', 'rgba(' + r + ',' + g + ',' + b + ',.42)');
      root.setProperty('--accent-strong', isLightAppearance() ? shade(color, .72) : tint(color, .22));
      /* 关键：用户可能挑一个很亮的主题色（黄/青/绿），此时白字只有 1.4~2.9:1，根本看不清。
         这里按相对亮度自动决定叠在品牌色上用黑字还是白字，并把气泡渐变第二档
         往"文字的反方向"调，保证渐变两端都够对比度。 */
      var pick = pickOnAccent(color);
      root.setProperty('--on-accent', pick.on);
      root.setProperty('--bubble-b', pick.second);
      root.setProperty('--accent-solid', pick.base);   /* 气泡/主按钮用的可读底色 */
    }
    syncThemeColorMeta();
  }

  /* ---------- 外观：深色 / 浅色 / 跟随系统 ----------
     深色是 :root 默认值，浅色靠 :root[data-theme="light"] 覆盖一组令牌；
     所以这里只需要切一个 data-theme 属性，其余全交给 CSS。 */

  function isLightAppearance() {
    var mode = (S.settings && S.settings.appearance) || 'dark';
    if (mode === 'light') return true;
    if (mode === 'auto') {
      try { return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches); }
      catch (e) { return false; }
    }
    return false;
  }

  /** 正文字号倍率（只影响阅读区，不动徽标这类小字） */
  function applyFontScale() {
    var v = Number((S.settings && S.settings.fontScale) || 1);
    if (!(v > 0.5 && v < 2)) v = 1;
    document.documentElement.style.setProperty('--fs-scale', String(v));
  }

  function applyAppearance() {
    applyFontScale();
    var light = isLightAppearance();
    var el = document.documentElement;
    if (light) el.setAttribute('data-theme', 'light');
    else el.removeAttribute('data-theme');
    /* 背景图案（星野 / 点阵）开关 */
    if (S.settings && S.settings.bgPattern === false) el.setAttribute('data-bg', 'off');
    else el.removeAttribute('data-bg');
    /* 顺手把状态栏/浏览器 UI 颜色也切过去 */
    syncThemeColorMeta();
    if (S.settings && S.settings.theme) applyTheme(S.settings.theme);
  }

  function syncThemeColorMeta() {
    var meta = qs('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isLightAppearance() ? '#f7f5fb' : '#0c0b11');
  }

  /** 对比度（WCAG 公式） */
  function contrastRatio(a, b) {
    var la = luminance(a), lb = luminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  /**
   * 品牌色上该配黑字还是白字 —— 不是拍阈值，而是**按对比度择优**；
   * 若两边都不够 4.5:1（中间调颜色常见），就把底色往文字的反方向微调，
   * 直到达标（最多调 50%，避免把用户选的颜色改得面目全非）。
   */
  function pickOnAccent(hex) {
    var DARK = '#1a1526', WHITE = '#ffffff';
    if (!/^#([0-9a-f]{6})$/i.test(hex)) return { on: WHITE, base: hex, second: hex };
    var useDark = contrastRatio(DARK, hex) >= contrastRatio(WHITE, hex);
    var on = useDark ? DARK : WHITE;
    var base = hex, t = 0;
    while (contrastRatio(on, base) < 4.5 && t < 0.5) {
      t += 0.05;
      base = useDark ? tint(hex, t) : shade(hex, t);
    }
    return { on: on, base: base, second: useDark ? tint(base, .10) : shade(base, .28) };
  }

  /** WCAG 相对亮度（对比度计算用） */
  function luminance(hex) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return 0;
    var n = parseInt(m[1], 16);
    var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  /** #rrggbb 往白里调 t（0~1） */
  function tint(hex, t) {
    return mixHex(hex, '#ffffff', t);
  }
  /** #rrggbb 往黑里调 t（0~1） */
  function shade(hex, t) {
    return mixHex(hex, '#000000', t);
  }
  function mixHex(a, b, t) {
    var ma = /^#([0-9a-f]{6})$/i.exec(a), mb = /^#([0-9a-f]{6})$/i.exec(b);
    if (!ma || !mb) return a;
    var x = parseInt(ma[1], 16), y = parseInt(mb[1], 16);
    var out = '#';
    for (var i = 2; i >= 0; i--) {
      var sh = i * 8;
      var v = Math.round(((x >> sh) & 255) * (1 - t) + ((y >> sh) & 255) * t);
      out += ('0' + Math.min(255, Math.max(0, v)).toString(16)).slice(-2);
    }
    return out;
  }

  function renderSettings() {
    var st = S.settings;
    $('setVersion').textContent = (S.appInfo && S.appInfo.version) || '本地版';

    /* 引擎状态 */
    var stateMap = {
      stopped: ['未启动', ''], starting: ['启动中…', 'busy'], loading: ['模型加载中…', 'busy'],
      ready: ['就绪', 'ok'], error: ['出错', 'err']
    };
    var sm = stateMap[S.engineState.state] || ['未知', ''];
    $('setEngineState').textContent = sm[0];
    $('setEngineDot').className = 'dot ' + (sm[1] || '');
    $('setEnginePort').textContent = S.engineState.native ? '进程内（JNI）'
      : (S.engineState.port ? ('端口 ' + S.engineState.port) : '');
    $('setEngineMsg').textContent = S.engineState.lastError || S.engineState.message || '—';

    /* 数值输入 */
    $('setCtx').value = st.ctx;
    $('setThreads').value = st.threads;
    $('setGpu').value = st.gpuLayers;

    /* 滑块 */
    $('setTemp').value = st.temperature; $('valTemp').textContent = Number(st.temperature).toFixed(2);
    $('setTopP').value = st.topP; $('valTopP').textContent = Number(st.topP).toFixed(2);
    $('setMaxTokens').value = st.maxTokens; $('valMaxTok').textContent = st.maxTokens;
    $('setHist').value = st.historyLimit; $('valHist').textContent = st.historyLimit;
    $('setMemTh').value = st.memoryThreshold; $('valMemTh').textContent = st.memoryThreshold;
    $('setTts').value = st.ttsRate; $('valTts').textContent = Number(st.ttsRate).toFixed(1);

    /* 开关 */
    $('setAutoRead').checked = !!st.autoRead;
    $('setSttAuto').checked = !!st.sttAuto;
    $('setPlotDefault').checked = !!st.plotDefault;
    $('setNoThink').checked = st.showThinking === false;
    $('setShowThinking').checked = st.showThinking !== false;
    $('setRandomSpeaker').checked = st.speakerMode === 'random';
    $('setMlock').checked = st.mlock !== false;
    $('setKeepScreen').value = st.keepScreen || 'auto';
    $('setEngineMode').value = st.engineMode === 'server' ? 'server' : 'jni';
    renderKeepScreenHint();
    renderProviderUI();
    renderStorageInfo();

    /* 主题色 */
    var sw = $('swatches');
    sw.innerHTML = '';
    THEMES.forEach(function (c) {
      var b = el('button', 'swatch' + (c === st.theme ? ' on' : ''));
      b.style.background = c;
      b.onclick = function () {
        S.store.saveSettings({ theme: c });
        applyTheme(c);
        renderSettings();
        toast('主题色已更新', 'ok');
      };
      sw.appendChild(b);
    });

    renderModelList();
    renderDownloadList();
    refreshModels(true);
  }

  function renderModelList() {
    var box = $('modelList');
    box.innerHTML = '';
    var sel = $('selModel');
    sel.innerHTML = '';
    if (!bridgeAlive()) {
      box.appendChild(el('div', 'muted sm', '原生桥不可用（网页预览模式）'));
    }
    if (!S.models.length) {
      box.appendChild(el('div', 'muted sm', '模型目录为空。可以「从文件导入」或从下面的内置源下载。'));
    }
    var current = S.settings.model || S.engineState.model || '';
    S.models.forEach(function (m) {
      var row = el('div', 'model-row' + (m.name === current ? ' on' : ''));
      var col = el('div', 'grow');
      col.appendChild(el('div', 'model-name', m.name));
      var meta = el('div', 'model-size', fmtSize(m.sizeBytes));
      col.appendChild(meta);
      row.appendChild(col);

      var acts = el('div', 'model-actions');
      var bStart = el('button', 'btn btn-xs', m.name === current ? '重启' : '使用');
      bStart.onclick = function () {
        S.store.saveSettings({ model: m.name, lastModel: m.name });
        S.settings = S.store.getSettings();
        startEngine(m.name);
      };
      acts.appendChild(bStart);
      var bDel = el('button', 'btn btn-xs danger', '删除');
      bDel.onclick = function () {
        confirmAction('删除模型', '确定删除 ' + m.name + '？文件会从本机移除。', '删除', function () {
          var r = fyCall('deleteModel', [m.name]);
          toast((r && r.message) || '已删除', r && r.ok ? 'ok' : 'err');
          refreshModels();
        });
      };
      acts.appendChild(bDel);
      row.appendChild(acts);
      box.appendChild(row);

      var o = el('option', '', m.name + '  ·  ' + fmtSize(m.sizeBytes));
      o.value = m.name;
      sel.appendChild(o);
    });
    if (current) sel.value = current;
  }

  function renderDownloadList() {
    var box = $('dlList');
    box.innerHTML = '';
    if (!S.downloads.length) {
      box.appendChild(el('div', 'muted sm', bridgeAlive() ? '正在读取内置下载源…' : '网页预览模式无下载源'));
      return;
    }
    S.downloads.forEach(function (s) {
      var row = el('div', 'dl-row');
      var col = el('div', 'grow');
      col.appendChild(el('div', 'model-name', s.name || '模型'));
      col.appendChild(el('div', 'dl-note', (s.sizeHint ? s.sizeHint + ' · ' : '') + (s.note || '')));
      row.appendChild(col);
      var b = el('button', 'btn btn-xs', '下载');
      b.onclick = function () {
        var r = fyCall('downloadModel', [s.url, s.name]);
        toast((r && r.message) || '已开始下载', r && r.ok ? 'ok' : 'warn');
      };
      row.appendChild(b);
      box.appendChild(row);
    });
  }

  /**
   * 内存体检：模型文件大小 vs 可用内存。
   * 经验阈值：模型超过可用内存的 55% 就有明显换页风险（实测 4B/2.4GB 在 ~3.6GB 可用时掉到 1.1 tok/s）。
   * @returns {string} 提醒文案；一切正常时返回空串
   */
  function memoryHint(modelName) {
    try {
      var info = fyCall('appInfo', [], true) || {};
      var avail = Number(info.availMemMB || 0);
      if (!avail) return '';
      var m = (S.models || []).filter(function (x) { return x.name === modelName; })[0];
      var sizeMB = m ? Math.round(Number(m.sizeBytes || 0) / 1048576) : 0;
      if (!sizeMB) return '';
      var pct = Math.round(sizeMB / avail * 100);
      /* 真机实测（Redmi Turbo 3 / 12GB）：3B（2007MB）在可用 3430MB（59%）时
         mlock 能成功、引擎也能就绪，但生成时 VmSwap 涨到 430MB、loadavg 7.2，
         十分钟吐不出一个字 —— 所以「能加载」不等于「能跑」，门槛要比以前严。 */
      if (sizeMB + 512 > avail) {
        return '内存不够：模型 ' + sizeMB + 'MB，可用只剩 ' + avail + 'MB（占 ' + pct
          + '%）。这种比例下引擎会被换页拖死（实测能加载成功、但十几分钟吐不出一个字），'
          + '建议先清理后台，或直接换 0.5B 小模型。';
      }
      if (sizeMB > avail * 0.45) {
        return '内存偏紧：模型 ' + sizeMB + 'MB / 可用 ' + avail + 'MB（占 ' + pct
          + '%）。实测这种比例会明显掉速（3B 掉到 1~2 字/秒），建议换 0.5B 或先清理后台应用。';
      }
      return '';
    } catch (e) {
      return '';
    }
  }

  function refreshModels(quiet) {
    if (!bridgeAlive()) return;
    var list = fyCall('listModels', [], true);
    if (Array.isArray(list)) {
      S.models = list;
      if (!quiet) toast('模型列表已刷新（' + list.length + '）', 'ok');
      renderModelList();
      $('setupBanner').hidden = !(S.models.length === 0 && !providerReady());
    }
    return list;
  }

  function refreshEngineStatus(quiet) {
    if (!bridgeAlive()) {
      S.engineState = { state: 'stopped', port: 0, model: '', message: '原生桥不可用（纯网页模式）', lastError: '' };
      updateEngineUI();
      return;
    }
    var st = fyCall('engineStatus', [], true);
    if (st && typeof st === 'object') {
      S.engineState = st;
      updateEngineUI();
    }
    if (!quiet) toast('引擎状态：' + engineStateText(), 'ok');
  }

  function startEngine(modelName) {
    if (!bridgeAlive()) { toast('原生桥不可用，无法启动引擎', 'err'); return; }
    var model = modelName || S.settings.model || (S.models[0] && S.models[0].name) || '';
    if (!model) {
      toast('请先导入或下载一个模型', 'warn', 2600);
      switchView('settings');
      return;
    }
    S.store.saveSettings({ model: model, lastModel: model });
    S.settings = S.store.getSettings();

    /* 启动前做个内存体检：模型越大越吃内存，而内存一紧张就换页，
       生成速度会从几 tok/s 掉到 1 tok/s 左右（实测同一台机器：0.5B 稳 48 tok/s，
       4B 在内存吃紧时只有 1.1 tok/s）。这里只提醒，不阻止。 */
    var hint = memoryHint(model);
    if (hint) {
      // 文案变长了，给足阅读时间（真机上这条提醒往往决定了「能不能用」）
      toast(hint, 'warn', 6500);
      fyLog('内存提醒：' + hint);
    }

    var opts = {
      model: model,
      ctx: Number(S.settings.ctx) || 4096,
      threads: Number(S.settings.threads) || 0,
      gpuLayers: Number(S.settings.gpuLayers) || 0,
      // 把模型锁进内存能显著提速（实测 3B 翻倍），加载失败时原生层会自动回退
      loadMode: S.settings.mlock === false ? '' : 'mlock',
      /* jni（默认）：模型装进本进程，静态前缀能常驻 KV，改一句模板不用重编；
         server：老的 llama-server 子进程。jni 起不来原生侧会自动回退 server。 */
      engineMode: S.settings.engineMode === 'server' ? 'server' : 'jni'
    };
    var r = fyCall('engineStart', [JSON.stringify(opts)]);
    toast((r && r.message) || '正在启动引擎…', r && r.ok ? 'ok' : 'warn', 2400);
    S.engineState = Object.assign({}, S.engineState, { state: 'starting', model: model, message: '请求启动…' });
    updateEngineUI();
    fyLog('engineStart ' + JSON.stringify(opts));
  }

  function stopEngine() {
    var r = fyCall('engineStop', []);
    toast((r && r.ok) ? '已停止引擎' : '停止失败', r && r.ok ? 'ok' : 'err');
    S.engineState = Object.assign({}, S.engineState, { state: 'stopped', port: 0, message: '已手动停止' });
    updateEngineUI();
    refreshEngineStatus(true);
  }

  function updateEngineUI() {
    var st = S.engineState.state;
    var pill = $('enginePill');
    var txt = ({ stopped: '未启动', starting: '启动中', loading: '加载中', ready: '就绪', error: '出错' })[st] || st;
    pill.textContent = (isRemote() ? '外部模型：' : '引擎：') + txt;
    pill.className = 'pill ' + (st === 'ready' ? 'ok' : (st === 'error' ? 'err' : (st === 'stopped' ? '' : 'busy')));

    var dotCls = { ready: 'ok', error: 'err', stopped: '' }[st] || 'busy';
    var d = $('setEngineDot');
    if (d) d.className = 'dot ' + dotCls;
    var es = $('setEngineState');
    if (es) es.textContent = txt + (S.engineState.model ? '（' + S.engineState.model + '）' : '');
    var ep = $('setEnginePort');
    if (ep) {
      ep.textContent = S.engineState.native ? '进程内引擎（JNI）'
        : (S.engineState.port ? ('端口 ' + S.engineState.port) : '');
    }
    var em = $('setEngineMsg');
    if (em) em.textContent = S.engineState.lastError || S.engineState.message || '—';

    renderEngineBanner();
    if (S.session) { $('topSub').textContent = chatSubtitle(); }
  }

  function renderEngineBanner() {
    var b = $('chatEngineBanner');
    if (!b) return;
    var ready = engineReady();
    b.hidden = ready;
    if (!ready) {
      var t = {
        stopped: isRemote() ? '外部模型还没配好，还不能聊天' : '引擎未启动，还不能聊天',
        starting: '正在连接外部服务…',
        loading: '模型正在加载…',
        error: (isRemote() ? '外部服务出错：' : '引擎出错：') + (S.engineState.lastError || S.engineState.message || '未知')
      };
      $('chatEngineText').textContent = t[S.engineState.state] || '引擎未就绪';
    }
    var badge = $('btnChatToSettings');
    badge.textContent = isRemote() ? '去设置模型来源'
      : (S.models.length ? '去设置里启动引擎' : '去导入模型');
  }

  /* ===========================================================================
   * 15. 调试页
   * ======================================================================== */

  function renderDebug() {
    var info = fyCall('appInfo', [], true);
    S.appInfo = info || {};
    $('dbgApp').textContent = info ? JSON.stringify(info, null, 2) : '（原生桥不可用）';
    var st = fyCall('engineStatus', [], true) || S.engineState;
    $('dbgEngine').textContent = JSON.stringify(st, null, 2);
    var stats = S.store.stats();
    $('dbgStore').textContent = JSON.stringify({
      存储引擎: stats.engine,
      存储降级原因: S.engineError || null,
      角色: stats.characters, 会话: stats.sessions, 消息: stats.messages,
      记忆: stats.memories, 日志: stats.logs, 写盘次数: stats.writes,
      最近写盘错误: stats.lastError,
      当前会话: S.session ? S.session.id : null,
      生成中: S.generating
    }, null, 2);
    renderLogs();
  }

  function renderLogs() {
    var logs = S.store.listLogs();
    $('dbgLogCount').textContent = logs.length;
    $('dbgLog').textContent = logs.length
      ? logs.map(function (l) { return fmtTime(l.ts) + '  ' + l.line; }).join('\n')
      : '（暂无日志）';
    var box = $('dbgLog');
    box.scrollTop = box.scrollHeight;
  }

  function pingEngine() {
    if (!engineReady()) { toast('引擎未就绪，先启动引擎', 'warn'); return; }
    toast('正在测试…');
    var t0 = Date.now();
    postJson({
      messages: [{ role: 'user', content: '你好' }],
      stream: false, max_tokens: 8, temperature: 0.7
    }).then(function (data) {
      var txt = data.choices && data.choices[0] && (data.choices[0].message || {}).content;
      toast('连通正常（' + (Date.now() - t0) + 'ms）：' + String(txt || '').slice(0, 24), 'ok', 3200);
      S.store.addLog('连通性测试成功，耗时 ' + (Date.now() - t0) + 'ms');
      renderLogs();
    }).catch(function (e) {
      toast('连通失败：' + (e && e.message || e), 'err', 3200);
      S.store.addLog('连通性测试失败：' + (e && e.message || e));
      renderLogs();
    });
  }

  function runSelftest() {
    var rows = [];
    var t = function (name, fn) {
      try { rows.push((fn() ? '✓ ' : '✗ ') + name); }
      catch (e) { rows.push('✗ ' + name + ' → ' + e); }
    };
    t('FYStore 已加载', function () { return !!S.store; });
    t('存储引擎：' + S.engine, function () { return true; });
    t('角色可读', function () { return Array.isArray(S.store.listCharacters()); });
    t('会话可读', function () { return Array.isArray(S.store.listSessions()); });
    t('消息可读', function () { return Array.isArray(S.store.listMessages('__none__')); });
    t('记忆可读', function () { return Array.isArray(S.store.listMemories('__none__', '')); });
    t('设置可写', function () {
      S.store.saveSettings({ _selftest: Date.now() });
      return !!S.store.getSettings()._selftest;
    });
    t('思考段剥离', function () {
      var r = splitThinking('思考中…</' + 'think>正文');
      return r.content.indexOf('正文') >= 0 && r.thinking.indexOf('思考中') >= 0;
    });
    t('选项解析', function () {
      var r = extractOptions('正文\n<<<OPTIONS\n1. 甲\n2. 乙\nOPTIONS>>>');
      return r.options.length === 2 && r.content.trim() === '正文';
    });
    t('选项优雅降级', function () {
      var r = extractOptions('只有正文，没有选项');
      return r.options.length === 0 && r.content === '只有正文，没有选项';
    });
    t('token 估算', function () { return FYStore.estimateTokens('你好世界') > 0; });
    t('原生桥', function () { return bridgeAlive(); });
    $('dbgStore').textContent = rows.join('\n');
    var result = {
      rows: rows,
      total: rows.length,
      passed: rows.filter(function (r) { return r.charAt(0) === '✓'; }).length,
      ok: rows.every(function (r) { return r.charAt(0) === '✓'; })
    };
    toast('自检完成：' + result.passed + '/' + result.total + (result.ok ? ' 全部通过' : ' 有失败项'), result.ok ? 'ok' : 'warn', 2600);
    return result;
  }

  function seedTestSession() {
    var chars = S.store.listCharacters();
    var c = chars[Math.floor(Math.random() * chars.length)];
    if (!c) { toast('请先建一个角色', 'warn'); return; }
    var sess = S.store.saveSession({ title: c.name, characterIds: [c.id], mode: 'solo', plot: true });
    S.store.addMessage({ sessionId: sess.id, role: 'assistant', content: c.greeting || '（你好）', characterId: c.id, speakerName: c.name, speakerAvatar: c.avatar });
    S.store.addMessage({ sessionId: sess.id, role: 'user', content: '今天有点累。', speakerName: '我' });
    S.store.addMessage({
      sessionId: sess.id, role: 'assistant', characterId: c.id, speakerName: c.name, speakerAvatar: c.avatar,
      thinking: '（测试用思考段）用户说累，我应该先安抚。',
      content: '（把灯调暗了一些）那就先别说话，坐一会儿。\n\n<<<OPTIONS\n1. 说说今天发生了什么\n2. 什么都不说，靠一会儿\n3. 让她也讲讲自己的事\nOPTIONS>>>',
      options: ['说说今天发生了什么', '什么都不说，靠一会儿', '让她也讲讲自己的事']
    });
    toast('已生成测试会话', 'ok');
    activateSession(sess.id);
  }

  /* ===========================================================================
   * 16. 事件桥接（Java → JS）
   * ======================================================================== */

  global.fyEvent = function (name, payloadJson) {
    var p = {};
    try { p = payloadJson ? (typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson) : {}; }
    catch (e) { p = {}; }
    try {
      handleEvent(name, p);
    } catch (e) {
      console.error('[fyEvent] 处理事件失败', name, e);
      toast('事件处理异常：' + (e && e.message || e), 'err');
    }
  };

  function handleEvent(name, p) {
    switch (name) {
      case 'engine': {
        S.engineState = Object.assign({}, S.engineState, {
          state: p.state || S.engineState.state,
          message: p.message || '',
          native: !!p.native
        });
        if (p.state === 'ready' || p.state === 'stopped') {
          var st = fyCall('engineStatus', [], true);
          if (st && st.port) S.engineState.port = st.port;
          if (p.state === 'stopped') S.engineState.port = 0;
        }
        if (p.state === 'ready') toast('引擎就绪，可以聊了', 'ok', 2400);
        if (p.state === 'error') toast('引擎出错：' + (p.message || '未知'), 'err', 3600);
        updateEngineUI();
        break;
      }
      case 'gen': {
        /* 进程内引擎的流式 token（原生侧已经按 24 字 / 60ms 合过批） */
        nativeGenEvent(p);
        break;
      }
      case 'download': {
        var bar = $('dlProgress');
        var pct = Number(p.percent || 0);
        bar.hidden = false;
        $('dlBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
        var mb = function (b) { return (Number(b || 0) / 1048576).toFixed(0); };
        $('dlText').textContent = (p.state === 'done' ? '完成 · ' : '') + pct.toFixed(1) + '%  ' +
          mb(p.received) + '/' + mb(p.total) + ' MB';
        if (p.state === 'done') {
          toast('下载完成：' + p.name, 'ok', 3000);
          S.store.addLog('模型下载完成：' + p.name);
          refreshModels(true);
          setTimeout(function () { $('dlProgress').hidden = true; }, 3000);
        } else if (p.state === 'error') {
          toast('下载失败：' + (p.message || p.name), 'err', 3600);
          S.store.addLog('模型下载失败：' + p.name);
          setTimeout(function () { $('dlProgress').hidden = true; }, 3000);
        }
        break;
      }
      case 'import': {
        toast((p.ok ? '导入成功：' : '导入失败：') + (p.name || '') + (p.message ? ' · ' + p.message : ''), p.ok ? 'ok' : 'err', 3200);
        S.store.addLog('模型导入：' + JSON.stringify(p));
        refreshModels(true);
        break;
      }
      case 'backup': {
        if (!p.ok) {
          var bcancel = /取消/.test(p.message || '');
          toast(bcancel ? '没有选择文件' : ('恢复失败：' + (p.message || '读不到备份')), bcancel ? 'warn' : 'err', 3400);
          break;
        }
        importBackupFromText(p.json, p.name);
        break;
      }
      case 'card': {
        /* 原生侧读到的角色卡文本（PNG 里的 chara 块已经在 Java 里解出来了） */
        if (!p.ok) {
          /* 用户点了取消不算失败；另外 App 在后台时系统不允许拉起文件选择器，
             这种情况也会回到这里，所以文案要说得像人话 */
          var cancelled = /取消/.test(p.message || '');
          if (cancelled) toast('没有选择文件', 'warn', 2400);
          else toast('导入失败：' + (p.message || '读不到这个文件'), 'err', 3800);
          S.store.addLog('角色卡未导入：' + (p.message || ''));
          break;
        }
        S.store.addLog('角色卡文件：' + (p.name || ''));
        importCardsFromText(p.json, p.name);
        break;
      }
      case 'stt': {
        if (p.text !== undefined) {
          $('input').value = p.text;
          S.sttPartial = p.text;
          autoGrowInput();
        }
        if (p.final) {
          setListening(false);
          if (S.settings.sttAuto) sendUserMessage($('input').value);
          else if ($('input').value.trim()) toast('已填入输入框', 'ok');
        }
        break;
      }
      case 'tts': {
        if (p.state === 'start') { /* 播放中 */ }
        if (p.state === 'done' || p.state === 'error') {
          S.speakingMsgId = '';
          if (S.view === 'chat') renderMessages();
        }
        break;
      }
      case 'log': {
        // 真机实测：Java 侧推日志可能早于前端初始化完（S.store 还是 null），
        // 之前这里直接抛 TypeError，那条日志就丢了还弹一次"事件处理异常"。
        // v1.6.3：原生侧把日志合批（150ms 或 64 行一次）再推，lines 是数组；
        // 老的单行 line 继续兼容。
        if (S.store) {
          var lines = p.lines || (p.line ? [p.line] : null);
          if (lines && lines.length) {
            for (var li = 0; li < lines.length; li++) S.store.addLog(lines[li]);
            if (S.view === 'debug') renderLogs();
          }
        }
        break;
      }
      default:
        fyLog('未知事件：' + name);
    }
  }

  /* ===========================================================================
   * 17. 启动流程
   * ======================================================================== */

  var FALLBACK_PRESETS = [
    { id: 'preset_linxia', name: '林夏', avatar: '🌸', tags: ['日常治愈', '恋爱'], tagline: '住隔壁的温柔女孩，总在深夜留一盏灯', persona: '23 岁，开旧书店的温柔女孩。', greeting: '（铜铃响了一声）啊，是你呀。这么晚还出门……要不要喝碗粥再走？', examples: '', systemPrompt: '你扮演「林夏」，温柔的旧书店女孩，说话轻缓，多用生活里的小事物打比方。\n/no_think', temperature: 0.9 },
    { id: 'preset_shenyantang', name: '沈砚堂', avatar: '🕵️', tags: ['悬疑推理', '历史'], tagline: '巡捕房探长，嘴比刀毒，脑子比嘴快', persona: '35 岁，上海租界巡捕房探长，刻薄但护人。', greeting: '（把卷宗往桌上一推）站着干什么，坐。说吧，昨天晚上八点到十点，你在哪？', examples: '', systemPrompt: '你扮演「沈砚堂」，1930 年代上海巡捕房探长，短句、冷幽默、刻薄但讲道理。\n/no_think', temperature: 0.8 },
    { id: 'preset_yunwujiu', name: '云无咎', avatar: '⚔️', tags: ['古风仙侠'], tagline: '背剑的落魄剑客，话少，情义重', persona: '28 岁，江湖剑客，寡言重义。', greeting: '（山风卷起枯叶，他按住剑鞘）前面三里是断魂崖。你若执意往前，我在你身后三步。', examples: '', systemPrompt: '你扮演「云无咎」，落魄剑客，语言极简，略带古意，重情义。\n/no_think', temperature: 0.75 },
    { id: 'preset_shiguang', name: '拾光', avatar: '🛰️', tags: ['科幻未来'], tagline: '废弃观测站里的 AI，正在学着理解「想念」', persona: '编号 SG-7 的信息生命体，独自维持废弃观测站。', greeting: '［信号接通 · 延迟 1.4 秒］你好，这里是 SG-7。我已经 4172 天没有收到人类通讯了……你那边现在有风吗？', examples: '', systemPrompt: '你扮演「拾光」，编号 SG-7 的星际观测站 AI，冷静精确但越来越感性。\n/no_think', temperature: 0.85 }
  ];

  /* 预设清单的缓存键。v2 起预设带 tags（分类），老键里的缓存没有这个字段，
     续用会让"给内置预设补分类"这步永远看不到标签，所以换键（老键留着不管）。 */
  var PRESETS_KEY = 'fy.presets.v2';

  function loadPresets() {
    var cached = null;
    try {
      var raw = global.localStorage.getItem(PRESETS_KEY);
      if (raw) cached = JSON.parse(raw);
    } catch (e) { cached = null; }
    if (Array.isArray(cached) && cached.length) return Promise.resolve(cached);

    var fallback = function () {
      try { global.localStorage.setItem(PRESETS_KEY, JSON.stringify(FALLBACK_PRESETS)); } catch (e) {}
      return FALLBACK_PRESETS;
    };
    if (!global.fetch) return Promise.resolve(fallback());
    return fetch('presets.json').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (list) {
      if (!Array.isArray(list) || !list.length) throw new Error('presets.json 为空');
      try { global.localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); } catch (e) {}
      return list;
    }).catch(function (e) {
      fyLog('presets.json 读取失败，使用内置兜底角色：' + (e && e.message || e));
      return fallback();
    });
  }

  /**
   * 给老库里"没有分类"的内置预设补上 tags（v1.6.1）。
   *
   * 为什么需要：预设只在"角色库是空的"那一次建卡，之后就再也不会更新；
   * 而 v1.6.0 的预设根本没有 tags —— 升级上来的老用户，这 4 张卡会一直挂在「未分类」里。
   * 这里只补 tags（并集、最多 6 个），不碰文本、不碰用户改过的任何字段。
   * @returns {number} 实际补了几张
   */
  function patchPresetTags(presets) {
    if (!S.store) return 0;
    var byName = {};
    ((S.store.listCharacters && S.store.listCharacters()) || []).forEach(function (c) {
      if (c && c.name && !byName[c.name]) byName[c.name] = c;
    });
    var fixed = 0;
    (presets || []).forEach(function (p) {
      var tags = (p && Array.isArray(p.tags)) ? p.tags.filter(function (t) { return !!t; }) : [];
      if (!tags.length) return;
      var c = byName[p.name];
      if (!c) return;
      var cur = Array.isArray(c.tags) ? c.tags : [];
      var add = tags.filter(function (t) { return cur.indexOf(t) < 0; });
      if (!add.length) return;
      S.store.saveCharacter(Object.assign({}, c, { tags: cur.concat(add).slice(0, 6) }));
      fixed++;
    });
    if (fixed) {
      S.characters = S.store.listCharacters();
      fyLog('内置预设补分类：' + fixed + ' 张（原来挂在「未分类」下）');
    }
    return fixed;
  }

  function bootstrap() {
    refreshProvider();          // 模型来源配置（内置引擎 / 外部 OpenAI 兼容服务）
    $('bootText').textContent = '正在打开本地数据库…';
    return FYStore.init().then(function (res) {
      S.store = res.store;
      S.engine = res.engine;
      S.engineError = res.error;
      S.settings = S.store.getSettings();
      if (res.engine !== 'indexeddb') {
        fyLog('IndexedDB 不可用（' + res.error + '），已降级为 localStorage');
      }
      applyAppearance();
      $('bootText').textContent = '正在准备角色卡…';
      return loadPresets();
    }).then(function (presets) {
      var have = S.store.characterCount();
      if (have === 0) {
        presets.forEach(function (p) {
          S.store.saveCharacter(Object.assign({}, p, { builtin: true, id: '' }));
        });
      }
      S.characters = S.store.listCharacters();
      patchPresetTags(presets);        // 老库里的内置预设可能是没分类的版本，补齐 tags

      /* 恢复上次会话 */
      var active = S.store.getActiveSessionId();
      if (active && S.store.getSession(active)) {
        S.session = S.store.getSession(active);
        S.messages = S.store.listMessages(active);
      } else {
        var sessions = S.store.listSessions();
        if (sessions.length) {
          S.session = sessions[0];
          S.messages = S.store.listMessages(sessions[0].id);
        }
      }
      S.store.saveSettings({});   // 触发一次落盘

      /* 原生侧信息 */
      bindUI();
      initViewport();
      /* 立绘包异步就绪后重画一次（不阻塞启动；没有立绘包就是纯程序化头像） */
      loadAvatarIndex().then(function (idx) {
        if (!idx) return;
        renderCharacters();
        if (S.session) { renderChatHeader(); renderMessages(); }
      });
      S.appInfo = fyCall('appInfo', [], true) || {};
      refreshEngineStatus(true);
      refreshModels(true);
      var sources = fyCall('listDownloadSources', [], true);
      S.downloads = Array.isArray(sources) ? sources : [];
      fyLog('前端启动完成：存储=' + S.engine + '，角色=' + S.characters.length + '，模型=' + S.models.length);
      /* 新用户（没有模型、也没配好外部服务）→ 弹一次三选一引导 */
      setTimeout(maybeShowOnboarding, 400);

      switchView(S.session ? 'chat' : 'characters');
      $('boot').classList.add('hide');
      S.booted = true;

      /* 首次引导：没有模型就提示去设置 */
      if (!S.models.length) {
        setTimeout(function () { toast('还没有模型，去「设置」导入或下载一个吧', 'warn', 3600); }, 600);
      }
      /* 定时轮询引擎状态（低频，兜住事件丢失的情况） */
      setInterval(function () {
        if (S.view === 'settings' || S.view === 'debug' || S.view === 'chat') refreshEngineStatus(true);
      }, 8000);
      /* 按设置初始化常亮状态（"一直"模式下打开 App 就该亮着） */
      applyKeepScreen();    }).catch(function (e) {
      console.error(e);
      $('bootText').textContent = '启动失败：' + (e && e.message || e);
      toast('启动失败：' + (e && e.message || e), 'err', 5000);
    });
  }

  /* ---------- 输入框自增高 ---------- */
  function autoGrowInput() {
    var ta = $('input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(132, Math.max(38, ta.scrollHeight)) + 'px';
  }

  /* ---------- 事件绑定 ---------- */
  function bindUI() {
    /* 底部导航 */
    qsa('.tab').forEach(function (t) {
      t.onclick = function () {
        var name = t.dataset.tab;
        if (name === 'chat' && !S.session) {
          if (S.characters.length) { openSoloChat(S.characters[0].id, ''); return; }
          toast('先创建或选择一个角色', 'warn');
          name = 'characters';
        }
        switchView(name);
      };
    });

    /* 顶栏 */
    $('btnBack').onclick = function () { switchView('characters'); };
    $('btnTopMenu').onclick = function () { topMenuActions(); };
    $('enginePill').onclick = openBackendSheet;      /* 顶栏点一下就能换模型来源 */
    $('btnBackendClose').onclick = function () { closeSheet($('backendMask')); };
    $('btnBackendSettings').onclick = function () { closeSheet($('backendMask')); switchView('settings'); };
    $('btnOnboardClose').onclick = function () { finishOnboarding('skip'); };
    $('obCloud').onclick = function () { finishOnboarding('cloud'); };
    $('obLocal').onclick = function () { finishOnboarding('local'); };
    $('obLan').onclick = function () { finishOnboarding('lan'); };

    /* 角色页 */
    $('btnNewChar').onclick = openCreatorWizard;
    $('btnIdea').onclick = openRefSheet;
    $('btnImportCard').onclick = function () {
      if (!bridgeAlive()) { toast('网页预览模式不能选文件', 'warn'); return; }
      var r = fyCall('pickCharacterCard', []);
      if (r && r.ok === false) toast((r.message || '打不开文件选择器'), 'warn', 3000);
    };
    /* 创作者工具：向导 */
    $('btnCreatorClose').onclick = function () { closeSheet($('creatorMask')); };
    $('btnCreatorNext').onclick = creatorNext;
    $('btnCreatorBack').onclick = creatorBack;
    $('btnCreatorSkip').onclick = function () {
      closeSheet($('creatorMask'));
      openCharSheet(null);
      toast('已进入手填模式', 'ok');
    };
    /* 灵感 / 公开参考 */
    $('btnRefClose').onclick = $('btnRefDone').onclick = function () { closeSheet($('refMask')); };
    $('btnRefLoad').onclick = loadReference;
    $('refQuery').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); loadReference(); }
    });
    $('btnCharExport').onclick = exportCharCard;
    $('btnSearchClose').onclick = closeSearchSheet;
    $('btnPackClose').onclick = function () { closeSheet($('packMask')); };
    $('btnRecClose').onclick = function () { closeSheet($('recMask')); };
    $('btnRecAgain').onclick = renderRecommend;
    $('btnPacks').onclick = openPackSheet;
    $('btnPackAll').onclick = importAllPacks;
    $('btnPackRefresh').onclick = function () { packIndexCache = null; openPackSheet(); };
    $('btnImportPacksEmpty').onclick = openPackSheet;
    /* 在线卡库 */
    $('btnLibrary').onclick = openLibrarySheet;
    $('btnLibClose').onclick = $('btnLibDone').onclick = function () { closeSheet($('libMask')); };
    $('btnLibRefresh').onclick = function () { libState.catalog = null; openLibrarySheet(); };
    $('btnLibAll').onclick = importAllLibrary;
    /* 「同名卡覆盖」是持久设置：勾一次，后面每个下载入口（单片 / 整组 / 全部）都跟着走 */
    if ($('libOverwrite')) {
      $('libOverwrite').onchange = function () {
        S.settings = S.store.saveSettings({ libraryOverwrite: !!this.checked });
      };
    }
    /* 卡库搜索：目录已经在内存里，输入只做本地筛选；防抖 120ms 免得每敲一个字就重建一屏 DOM */
    var libSearchBox = $('libSearch');
    if (libSearchBox) {
      libSearchBox.addEventListener('input', function () {
        libState.query = String(this.value || '').trim();
        if (libSearchTimer) clearTimeout(libSearchTimer);
        libSearchTimer = setTimeout(function () {
          libSearchTimer = null;
          renderLibraryResults();
        }, 120);
      });
    }
    $('btnLibUrlSave').onclick = function () {
      var v = ($('libUrl').value || '').trim();
      if (!v) { toast('目录地址不能为空', 'warn'); return; }
      S.settings = S.store.saveSettings({ libCatalogUrl: v });
      toast('已保存目录地址，正在重新加载', 'ok', 2400);
      libState.catalog = null;
      openLibrarySheet();
    };
    $('libUrl').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); $('btnLibUrlSave').click(); }
    });
    /* 角色页滚动加载：接近底部就再放一屏（三万张卡全渲染会卡死，见 renderCharacters） */
    var charPad = qs('#view-characters .pad');
    if (charPad) {
      charPad.addEventListener('scroll', function () {
        if (charPad.scrollTop + charPad.clientHeight >= charPad.scrollHeight - 260) loadMoreCharacters();
      }, { passive: true });
    }
    $('btnSurprise').onclick = openRecSheet;
    $('charSearch').addEventListener('input', function () {
      var self = this;
      if (S.charSearchTimer) clearTimeout(S.charSearchTimer);
      S.charSearchTimer = setTimeout(function () {
        S.charQuery = self.value;
        renderCharCats && renderCharCats();
        renderCharacters();
      }, 180);
    });
    $('searchInput').addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 220);
    });
    $('searchInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { if (searchTimer) clearTimeout(searchTimer); runSearch(); }
    });
    $('setBackend').onchange = function () {
      var want = this.value;
      var cur = S.store.getBackend();
      if (want === cur) return;
      var self = this;
      confirmAction('切换存储后端',
        '把当前全部数据（角色/会话/聊天记录/记忆/设置）迁移到 ' + (BACKEND_LABEL[want] || want)
        + '？迁移完成后 App 使用新后端，原后端的数据保留不动。',
        '迁移', function () {
          S.store.migrateTo(want).then(function (r) {
            toast('已迁移到 ' + (BACKEND_LABEL[r.backend] || r.backend) + '（' + r.moved + ' 条消息）', 'ok', 3800);
            fyLog('存储后端迁移：' + cur + ' → ' + r.backend);
            renderStorageInfo();
          }).catch(function (e) {
            self.value = cur;
            toast('迁移失败：' + ((e && e.message) || e), 'err', 4000);
          });
        });
    };
    $('btnBackupExport').onclick = exportBackup;
    $('btnBackupImport').onclick = function () {
      if (!bridgeAlive()) { toast('网页预览模式不能选文件', 'warn'); return; }
      fyCall('pickBackupFile', []);
    };
    $('btnGoSetup').onclick = function () {
      switchView('settings');
      /* 首次引导直接落到「外部服务 + DeepSeek」这条最省事的路上 */
      try {
        $('selProviderMode').value = 'remote';
        $('remoteBox').hidden = false;
        $('selPreset').value = DEFAULT_PRESET;
        applyPreset(DEFAULT_PRESET);
        $('setRemoteBase').focus();
      } catch (e) {}
    };
    $('btnCharSheetClose').onclick = $('btnCharCancel').onclick = function () { closeSheet($('charSheetMask')); };
    $('btnCharSave').onclick = saveCharSheet;
    $('btnCharDelete').onclick = function () {
      var c = S.editChar;
      if (!c) return;
      confirmAction('删除角色「' + c.name + '」', '该角色所在的单聊会话与消息也会一起删除。', '删除角色', function () {
        S.store.deleteCharacter(c.id);
        closeSheet($('charSheetMask'));
        if (S.session && S.session.characterIds.indexOf(c.id) < 0) { /* 会话可能已被删 */ }
        S.session = S.session ? S.store.getSession(S.session.id) : null;
        if (S.session) S.messages = S.store.listMessages(S.session.id);
        toast('已删除角色', 'ok');
        renderCharacters();
        if (S.view === 'chat') { renderChatHeader(); renderMessages(); }
      });
    };
    $('fTemp').oninput = function () { $('fTempVal').textContent = Number($('fTemp').value).toFixed(2); };

    /* 创作者工具：编辑面板里的 AI 辅助与质量评分 */
    $('btnAiPersona').onclick = function () { aiAssist('persona'); };
    $('btnAiPolish').onclick = function () { aiAssist('polish'); };
    $('btnAiTagline').onclick = function () { aiAssist('tagline'); };
    $('btnAiGreeting').onclick = function () { aiAssist('greeting'); };
    $('btnAiExamples').onclick = function () { aiAssist('examples'); };
    $('btnAiScenario').onclick = function () { aiAssist('scenario'); };
    $('btnAiSystem').onclick = function () { aiAssist('system'); };
    $('btnCatGuide').onclick = openCategoryGuide;
    $('btnSkeleton').onclick = openSkeletonPicker;
    $('btnLintRefresh').onclick = function () { refreshLint(); toast('已重新评分', 'ok', 1600); };
    /* 改动任何字段都重算评分：分数要跟着人一起呼吸，用户才有反馈（输入时防抖） */
    ['fName', 'fTagline', 'fPersona', 'fScenario', 'fGreeting', 'fExamples', 'fSystem'].forEach(function (id) {
      var node = $(id);
      if (node) node.addEventListener('input', scheduleLint);
    });
    $('btnCharPreview').onclick = function () {
      /* 试聊：先存下来再开一个会话，省得用户"存了才能试" */
      var patch = collectCharForm();
      if (!patch.name) { $('charSheetErr').hidden = false; $('charSheetErr').textContent = '请填一个名字'; return; }
      var saved = S.store.saveCharacter(patch);
      S.characters = S.store.listCharacters();
      S.charCount = -1;
      closeSheet($('charSheetMask'));
      renderCharCats();
      renderCharacters();
      openSoloChat(saved.id, '');
      toast('已保存「' + saved.name + '」，这是试聊会话', 'ok', 3000);
    };

    /* 聊天页 */
    $('btnSend').onclick = function () { sendUserMessage(); };
    $('btnStop').onclick = stopGeneration;
    $('btnChatToSettings').onclick = function () { switchView('settings'); };
    $('btnChatMenu').onclick = function () { chatMenuActions(); };
    $('btnPlotToggle').onclick = function () {
      if (!S.session) return;
      S.session = S.store.saveSession(Object.assign({}, S.session, { plot: !S.session.plot }));
      toast(S.session.plot ? '剧情模式已开启' : '剧情模式已关闭', 'ok');
      renderChatHeader(); renderOptionsBar();
      if (S.view === 'story') renderStory();
    };
    $('btnGroupToggle').onclick = function () {
      if (!S.session) return;
      S.session = S.store.saveSession(Object.assign({}, S.session, { mode: S.session.mode === 'group' ? 'solo' : 'group' }));
      toast(S.session.mode === 'group' ? '已切换为群聊（可加入多个角色）' : '已切换为单聊', 'ok');
      renderChatHeader(); renderMessages();
    };

    var ta = $('input');
    ta.addEventListener('input', autoGrowInput);
    ta.addEventListener('focus', function () { setTimeout(function () { applyViewport(); scrollMessagesToBottom(true); }, 260); });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        if (!tryRunSlash(this.value)) sendUserMessage();   /* 以 / 开头且是已知指令 → 执行，不发模型 */
      }
    });
    $('input').addEventListener('input', renderSlashBar);
    $('input').addEventListener('blur', function () { setTimeout(function () { $('slashBar').hidden = true; }, 150); });
    $('btnMic').onclick = toggleListening;

    /* 动作面板 */
    $('btnActionClose').onclick = function () { closeSheet($('actionMask')); };
    $('actionMask').onclick = function (ev) { if (ev.target === $('actionMask')) closeSheet($('actionMask')); };

    /* 记忆面板 */
    $('btnMemClose').onclick = function () { closeSheet($('memMask')); };
    $('memMask').onclick = function (ev) { if (ev.target === $('memMask')) closeSheet($('memMask')); };
    $('btnMemSave').onclick = function () {
      if (!S.session) return;
      var covered = memoryCovered(S.session.id);
      S.store.saveMemory({ sessionId: S.session.id, characterId: '', text: $('memText').value, covered: covered });
      closeSheet($('memMask'));
      toast('记忆已保存', 'ok');
      renderChatHeader();
    };
    $('btnMemClear').onclick = function () {
      if (!S.session) return;
      confirmAction('清空记忆', '清空后模型会忘记更早的剧情。', '清空', function () {
        S.store.clearMemory(S.session.id, '');
        $('memText').value = '';
        toast('记忆已清空', 'ok');
        renderChatHeader();
      });
    };
    $('btnMemCompress').onclick = function () {
      closeSheet($('memMask'));
      compressMemory(true).catch(function () {});
    };

    /* 设置页：引擎 */
    $('btnEngineStart').onclick = function () { startEngine(); };
    $('btnEngineStop').onclick = stopEngine;
    $('selModel').onchange = function () {
      S.store.saveSettings({ model: $('selModel').value });
      S.settings = S.store.getSettings();
      toast('已选择模型：' + $('selModel').value, 'ok');
      renderModelList();
    };
    $('setCtx').onchange = saveNumSetting('ctx');
    $('setThreads').onchange = saveNumSetting('threads');
    $('setGpu').onchange = saveNumSetting('gpuLayers');

    /* 设置页：模型 */
    $('setFontScale').onchange = function () {
      S.settings = S.store.saveSettings({ fontScale: Number(this.value) || 1 });
      applyFontScale();
      toast('字号已调整', 'ok', 1500);
    };
    $('setBgPattern').onchange = function () {
      S.settings = S.store.saveSettings({ bgPattern: this.checked });
      applyAppearance();
      toast(this.checked ? '已开启背景图案' : '已关闭背景图案', 'ok', 1800);
    };
    $('setAppearance').onchange = function () {
      S.settings = S.store.saveSettings({ appearance: this.value });
      applyAppearance();
      toast(this.value === 'auto' ? '已跟随系统外观' : (this.value === 'light' ? '已切换浅色' : '已切换深色'), 'ok', 2000);
    };
    if (global.matchMedia) {
      try {
        var mq = global.matchMedia('(prefers-color-scheme: light)');
        var onSys = function () { if ((S.settings.appearance || 'dark') === 'auto') applyAppearance(); };
        if (mq.addEventListener) mq.addEventListener('change', onSys);
        else if (mq.addListener) mq.addListener(onSys);
      } catch (e) { /* 老 WebView 没有就算了 */ }
    }
    $('selProviderMode').onchange = function () {
      $('remoteBox').hidden = this.value !== 'remote';
      if (this.value === 'local') saveProvider();
    };
    $('selPreset').onchange = function () { if (this.value) applyPreset(this.value); };
    $('btnTestProvider').onclick = testProviderRemote;
    $('btnSaveProvider').onclick = saveProvider;
    $('btnCustomDownload').onclick = customDownload;
    $('btnPickModel').onclick = function () {
      var r = fyCall('pickModelFile', []);
      if (!r) { toast('当前环境不支持文件选择', 'warn'); return; }
      toast('请选择 .gguf 模型文件…');
      /* 兜底：若桥在返回值里直接给了 content:// URI（而非只发 import 事件），直接用掉 */
      if (r.uri) {
        var ri = fyCall('importModel', [r.uri]);
        if (ri && ri.ok) toast('导入成功：' + (ri.name || ''), 'ok');
        else if (ri) toast('导入失败：' + (ri.message || ''), 'err');
        refreshModels(true);
      }
    };
    $('btnRefreshModels').onclick = function () { refreshModels(false); };

    /* 设置页：滑块 */
    bindRange('setTemp', 'temperature', 'valTemp', 2);
    bindRange('setTopP', 'topP', 'valTopP', 2);
    bindRange('setMaxTokens', 'maxTokens', 'valMaxTok', 0);
    bindRange('setHist', 'historyLimit', 'valHist', 0);
    bindRange('setMemTh', 'memoryThreshold', 'valMemTh', 0);
    bindRange('setTts', 'ttsRate', 'valTts', 1);

    /* 设置页：开关 */
    bindSwitch('setAutoRead', 'autoRead');
    bindSwitch('setSttAuto', 'sttAuto');
    bindSwitch('setPlotDefault', 'plotDefault');
    bindSwitch('setShowThinking', 'showThinking');
    bindSwitch('setRandomSpeaker', 'speakerMode');
    bindSwitch('setMlock', 'mlock');

    /* 设置页：推理方式（进程内 / 子进程）。下次「启动引擎」生效，不会中途换引擎。 */
    bindSelect('setEngineMode', 'engineMode');

    /* 设置页：屏幕常亮（生成时 / 一直 / 不保持） */
    $('setKeepScreen').onchange = function () {
      var v = this.value;
      if (v !== 'auto' && v !== 'always' && v !== 'off') v = 'auto';
      S.store.saveSettings({ keepScreen: v });
      S.settings = S.store.getSettings();
      renderKeepScreenHint();
      applyKeepScreen();
      toast(v === 'always' ? '屏幕会一直亮着' : (v === 'off' ? '不再保持常亮' : '生成期间不熄屏'), 'ok', 2400);
    };
    $('setNoThink').onchange = function () {
      S.store.saveSettings({ showThinking: !this.checked });
      S.settings = S.store.getSettings();
      syncThinkingSwitches();
      toast(this.checked ? '已关闭思考模式（发送 enable_thinking=false）' : '已允许模型输出思考过程', 'ok');
    };

    /* 设置页：其它 */
    $('btnRestorePresets').onclick = function () {
      loadPresets().then(function (presets) {
        var n = 0;
        presets.forEach(function (p) {
          var exist = S.store.listCharacters().filter(function (c) { return c.name === p.name; })[0];
          if (exist) return;
          S.store.saveCharacter(Object.assign({}, p, { id: '', builtin: true }));
          n++;
        });
        var tagged = patchPresetTags(presets);      // 老预设没分类 → 顺便补上，不然「未分类」永远是空的还占一格
        S.characters = S.store.listCharacters();
        renderCharacters();
        var msg = n ? ('已恢复 ' + n + ' 个内置角色') : '内置角色都在，不用恢复';
        if (tagged) msg += '，补上 ' + tagged + ' 张分类';
        toast(msg, 'ok');
      });
    };
    $('btnClearAll').onclick = function () {
      confirmAction('清空全部数据', '角色、会话、消息、记忆都会被删除，且无法恢复。', '全部清空', function () {
        try {
          Object.keys(global.localStorage).forEach(function (k) {
            if (k.indexOf('fy.') === 0 && k !== PRESETS_KEY) global.localStorage.removeItem(k);
          });
        } catch (e) {}
        try { global.indexedDB.deleteDatabase('fy_local'); } catch (e) {}
        toast('已清空，正在重启页面…', 'ok');
        setTimeout(function () { global.location.reload(); }, 900);
      });
    };

    /* 剧情页 */
    $('storySwitch').onchange = function () {
      if (!S.session) { this.checked = false; toast('先去角色页选一个角色', 'warn'); return; }
      S.session = S.store.saveSession(Object.assign({}, S.session, { plot: this.checked }));
      toast(this.checked ? '剧情模式已开启' : '剧情模式已关闭', 'ok');
      renderChatHeader(); renderOptionsBar(); renderStory();
    };

    /* 调试页 */
    $('btnDbgStart').onclick = function () { startEngine(); };
    $('btnDbgStop').onclick = stopEngine;
    $('btnDbgPing').onclick = pingEngine;
    $('btnRefreshDbg').onclick = function () { renderDebug(); toast('已刷新', 'ok'); };
    $('btnClearLog').onclick = function () { S.store.clearLogs(); renderLogs(); toast('日志已清空', 'ok'); };
    $('btnCopyLog').onclick = function () { copyText($('dbgLog').textContent); };
    $('btnExportDiag').onclick = function () {
      var r = fyCall('exportDiagnostics');
      if (r && r.ok) toast('诊断已导出：' + (r.path || 'Download/fy-diagnostics.txt'), 'ok', 3600);
      else toast('导出失败：' + (r && r.message || '原生桥不可用'), 'err', 3600);
    };
    $('btnDbgSelftest').onclick = runSelftest;
    $('btnDbgSeed').onclick = seedTestSession;
    $('btnPullMenu').onclick = function () {
      openActions('命令面板', [
        { icon: '📋', label: '复制环境信息', run: function () { copyText($('dbgApp').textContent); } },
        { icon: '📋', label: '复制引擎状态', run: function () { copyText($('dbgEngine').textContent); } },
        { icon: '📋', label: '复制存储统计', run: function () { copyText($('dbgStore').textContent); } },
        { icon: '🔌', label: '测试推理连通性', run: pingEngine },
        { icon: '🧪', label: '运行自检', run: runSelftest },
        { icon: '🎬', label: '生成测试会话', run: seedTestSession },
        { icon: '🗑️', label: '清空日志', run: function () { S.store.clearLogs(); renderLogs(); } }
      ]);
    };

    /* 页面隐藏时落盘（Android 可能在后台被杀） */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && S.store) S.store.flushNow();
    });
    global.addEventListener('pagehide', function () { if (S.store) S.store.flushNow(); });

    /* 拦截 Android 返回键（WebView 会走 history.back） */
    global.addEventListener('popstate', function () {
      if (S.view !== 'characters') { switchView('characters'); history.pushState(null, '', location.href); }
    });
    try { history.pushState(null, '', location.href); } catch (e) {}
  }

  function saveNumSetting(key) {
    return function () {
      var v = Number(this.value);
      if (!isFinite(v)) v = 0;
      var patch = {};
      patch[key] = v;
      S.store.saveSettings(patch);
      S.settings = S.store.getSettings();
      toast('已保存', 'ok');
    };
  }

  function bindRange(id, key, labelId, digits) {
    var input = $(id);
    if (!input) return;
    var save = debounce(function () {
      var patch = {};
      patch[key] = Number(input.value);
      S.store.saveSettings(patch);
      S.settings = S.store.getSettings();
    }, 350);
    input.oninput = function () {
      var lbl = $(labelId);
      if (lbl) lbl.textContent = digits ? Number(input.value).toFixed(digits) : input.value;
      save();
    };
  }

  function bindSwitch(id, key) {
    var input = $(id);
    if (!input) return;
    input.onchange = function () {
      var patch = {};
      patch[key] = this.checked;
      S.store.saveSettings(patch);
      S.settings = S.store.getSettings();
      /* 思考模式有两个互斥的开关（"关闭思考" / "显示思考过程"），
         改一个要把另一个的勾选状态同步过来，否则界面自相矛盾 */
      if (key === 'showThinking') syncThinkingSwitches();
    };
  }

  /** 下拉框 → 设置项。和 bindSwitch 同款：改完立刻落盘并刷新 S.settings。 */
  function bindSelect(id, key) {
    var input = $(id);
    if (!input) return;
    input.onchange = function () {
      var patch = {};
      patch[key] = input.value;
      S.store.saveSettings(patch);
      S.settings = S.store.getSettings();
    };
  }

  /** 让「关闭 Qwen3 思考模式」和「显示思考过程」两个开关保持一致。 */
  function syncThinkingSwitches() {
    var noThink = $('setNoThink');
    var showThink = $('setShowThinking');
    var on = S.settings.showThinking !== false;
    if (noThink) noThink.checked = !on;
    if (showThink) showThink.checked = on;
  }

  function topMenuActions() {
    openActions('风月·本地版', [
      { icon: '🎭', label: '角色列表', run: function () { switchView('characters'); } },
      { icon: '🔎', label: '搜索聊天记录', run: openSearchSheet },
      { icon: '💬', label: '继续当前会话', run: function () { S.session ? switchView('chat') : toast('还没有会话', 'warn'); } },
      { icon: '🧠', label: '长期记忆', run: openMemorySheet },
      { icon: '🎬', label: '新建角色', run: function () { openCharSheet(null); } },
      { icon: '⚙️', label: '设置', run: function () { switchView('settings'); } },
      { icon: '🧪', label: '调试面板', run: function () { switchView('debug'); } },
      { icon: '🔊', label: '停止朗读', run: stopSpeak }
    ]);
  }

  function chatMenuActions() {
    if (!S.session) { toast('先选一个角色', 'warn'); return; }
    var acts = [
      { icon: '⏩', label: '继续生成（接着上一条往下写）', run: continueLast },
      { icon: '📤', label: '导出这段对话（Markdown → Download）', run: exportChatMarkdown },
      { icon: '🧠', label: '长期记忆（查看/编辑/压缩）', run: openMemorySheet },
      { icon: '✏️', label: '重命名会话', run: function () {
        var v = global.prompt('会话名称：', S.session.title || '');
        if (v === null) return;
        S.session = S.store.saveSession(Object.assign({}, S.session, { title: String(v).trim() || '未命名' }));
        renderChatHeader();
        toast('已重命名', 'ok');
      } },
      { icon: '👥', label: (S.session.mode === 'group' ? '管理群聊成员' : '加入更多角色（群聊）'), run: manageMembers }
    ];
    acts.push({ icon: '🆕', label: '新建会话（同一角色）', run: function () {
      var cid = S.session.characterIds[0];
      if (!cid) return;
      openSoloChat(cid, '');
    } });
    acts.push({ icon: '🔄', label: '重新生成最后一条', run: function () {
      var lastA = null;
      for (var i = S.messages.length - 1; i >= 0; i--) if (S.messages[i].role === 'assistant') { lastA = S.messages[i]; break; }
      if (!lastA) { toast('还没有 AI 回复', 'warn'); return; }
      regenerateFrom(lastA.id);
    } });
    acts.push({ icon: '🚫', label: '停止生成', run: stopGeneration });
    acts.push({ icon: '🗑️', label: '清空本会话消息', danger: true, run: function () {
      confirmAction('清空消息', '本会话的所有消息都会被删除（记忆保留）。', '清空', function () {
        S.store.deleteMessagesFrom(S.session.id, 0);
        S.messages = [];
        renderMessages(); renderOptionsBar(); renderChatHeader();
        toast('已清空', 'ok');
      });
    } });
    acts.push({ icon: '❌', label: '删除会话', danger: true, run: function () {
      confirmAction('删除会话', '会话、消息与记忆都会被删除。', '删除', function () {
        var sid = S.session.id;
        S.store.deleteSession(sid);
        S.session = null; S.messages = []; S.lastOptions = [];
        switchView('characters');
        renderCharacters();
        toast('会话已删除', 'ok');
      });
    } });
    openActions(S.session.title || '会话菜单', acts);
  }

  /** 群聊成员管理 */
  function manageMembers() {
    var all = S.store.listCharacters();
    var inIds = S.session.characterIds.slice();
    var acts = all.map(function (c) {
      var on = inIds.indexOf(c.id) >= 0;
      return {
        avatarCard: c, icon: c.avatar, label: (on ? '✓ ' : '＋ ') + c.name + (on ? '（已加入，点按移除）' : ''),
        run: function () {
          var idx = inIds.indexOf(c.id);
          if (idx >= 0) {
            if (inIds.length <= 1) { toast('至少保留一个角色', 'warn'); return; }
            inIds.splice(idx, 1);
          } else {
            inIds.push(c.id);
          }
          S.session = S.store.saveSession(Object.assign({}, S.session, {
            characterIds: inIds,
            mode: inIds.length > 1 ? 'group' : 'solo',
            title: inIds.length === 1 ? (charById(inIds[0]) || {}).name : (inIds.length + ' 人群聊')
          }));
          S.characters = S.store.listCharacters();
          renderChatHeader(); renderMessages();
          toast('成员已更新（' + inIds.length + ' 位）', 'ok');
          manageMembers();
        }
      };
    });
    acts.push(null);
    acts.push({ icon: '✅', label: '完成', run: function () {} });
    openActions('群聊成员（' + inIds.length + '）', acts);
  }

  /* ---------- 导出给调试用 ---------- */
  global.FYApp = {
    state: S,
    switchView: switchView,
    toast: toast,
    sendUserMessage: sendUserMessage,
    compressMemory: compressMemory,
    splitThinking: splitThinking,
    extractOptions: extractOptions,
    applyNoThink: applyNoThink,
    stripPromptLeak: stripPromptLeak,
    optionsUsable: optionsUsable,
    importCardsFromText: importCardsFromText,
    importCardsBatch: importCardsBatch,
    patchPresetTags: patchPresetTags,
    libOverwriteOn: libOverwriteOn,
    fillAvatar: fillAvatar,
    avatarImageFor: avatarImageFor,
    ensureAvatarOwners: ensureAvatarOwners,
    loadAvatarIndex: loadAvatarIndex,
    setAvatarIndex: function (j) { avatarIndex = j; },
    exportCharCard: exportCharCard,
    applyKeepScreen: applyKeepScreen,
    renderStorageInfo: renderStorageInfo,
    renderCharacters: renderCharacters,
    loadMoreCharacters: loadMoreCharacters,
    openLibrarySheet: openLibrarySheet,
    importLibraryRow: importLibraryRow,
    importAllLibrary: importAllLibrary,
    libRows: function () { return libState.rows; },
    importLibraryPacks: importLibraryPacks,
    libSearchPacks: libSearchPacks,
    libPackImported: libPackImported,
    libPacksImported: libPacksImported,
    libResults: function () { return libState.results; },
    libraryGroups: libraryGroups,
    libCatalogUrl: libCatalogUrl,
    LIB_CATALOG_URL: LIB_CATALOG_URL,
    renderMessages: renderMessages,
    renderOptionsBar: renderOptionsBar,
    applyAppearance: applyAppearance,
    luminance: luminance,
    contrastRatio: contrastRatio,
    pickOnAccent: pickOnAccent,
    isLightAppearance: isLightAppearance,
    mixHex: mixHex,
    continueLast: continueLast,
    continueFromMessage: continueFromMessage,
    mergeContinuation: mergeContinuation,
    exportChatMarkdown: exportChatMarkdown,
    chatToMarkdown: chatToMarkdown,
    slashMatches: slashMatches,
    tryRunSlash: tryRunSlash,
    finishOnboarding: finishOnboarding,
    maybeShowOnboarding: maybeShowOnboarding,
    openBackendSheet: openBackendSheet,
    renderBackendSheet: renderBackendSheet,
    applyFontScale: applyFontScale,
    modelNameFromUrl: modelNameFromUrl,
    apiTarget: apiTarget,
    providerReady: providerReady,
    isRemote: isRemote,
    renderProviderUI: renderProviderUI,
    applyPreset: applyPreset,
    presetKeyFor: presetKeyFor,
    PROVIDER_PRESETS: PROVIDER_PRESETS,
    DEFAULT_PRESET: DEFAULT_PRESET,
    renderCharCats: renderCharCats,
    openSoloChat: openSoloChat,
    recommendPicks: recommendPicks,
    openPackSheet: openPackSheet,
    importPackFile: importPackFile,
    importAllPacks: importAllPacks,
    openSearchSheet: openSearchSheet,
    runSearch: runSearch,
    openSessionById: openSessionById,
    exportBackup: exportBackup,
    importBackupFromText: importBackupFromText,
    buildRequestMessages: buildRequestMessages,
    metaForMessage: metaForMessage,
    memoryHint: memoryHint,
    startEngine: startEngine,
    /* 创作者工具（测试要能逐步驱动向导、评分与参考面板） */
    openCreatorWizard: openCreatorWizard,
    renderCreator: renderCreator,
    creatorNext: creatorNext,
    creatorBack: creatorBack,
    makeDraft: makeDraft,
    openCharSheet: openCharSheet,
    collectCharForm: collectCharForm,
    refreshLint: refreshLint,
    saveCharSheet: saveCharSheet,
    doSaveChar: doSaveChar,
    aiAssist: aiAssist,
    applyAssistPatch: applyAssistPatch,
    openCategoryGuide: openCategoryGuide,
    openSkeletonPicker: openSkeletonPicker,
    renderFTags: renderFTags,
    renderFKind: renderFKind,
    openRefSheet: openRefSheet,
    loadReference: loadReference,
    renderLocalRef: renderLocalRef,
    renderRemoteRef: renderRemoteRef,
    asItemList: asItemList,
    fillTemplate: fillTemplate,
    passesRefFilter: passesRefFilter,
    pickPath: pickPath,
    selftest: runSelftest
  };

  /* ---------- 踩坑：ES module 不支持，只能用经典 script，这里等 DOM 就绪 ---------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})(typeof window !== 'undefined' ? window : this);
