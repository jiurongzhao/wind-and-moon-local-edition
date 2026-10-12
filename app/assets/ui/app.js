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
    'listModels', 'deleteModel', 'pickModelFile', 'importModel',
    'listDownloadSources', 'downloadModel',
    'pickCharacterCard', 'saveCharacterCard',
    'pickBackupFile', 'saveBackup',
    'dbLoadAll', 'dbApply', 'dbSearch', 'dbStats', 'dbWipe',
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
      b.appendChild(el('span', 'act-ico', a.icon || '•'));
      b.appendChild(el('span', '', a.label));
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

  function allCategories() {
    var seen = {}, out = [];
    S.characters.forEach(function (c) {
      var tags = (c.tags && c.tags.length) ? c.tags : [CAT_OTHER];
      tags.forEach(function (t) { if (!seen[t]) { seen[t] = 1; out.push(t); } });
    });
    return out;
  }

  function countByCat(cat) {
    if (cat === 'all') return S.characters.length;
    return S.characters.filter(function (c) {
      var tags = (c.tags && c.tags.length) ? c.tags : [CAT_OTHER];
      return tags.indexOf(cat) >= 0;
    }).length;
  }

  function charMatches(c) {
    if (S.charCat && S.charCat !== 'all') {
      var tags = (c.tags && c.tags.length) ? c.tags : [CAT_OTHER];
      if (tags.indexOf(S.charCat) < 0) return false;
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
      var b = el('button', 'chip' + ((S.charCat || 'all') === t ? ' on' : ''),
        t === 'all' ? ('全部 ' + countByCat('all')) : (t + ' ' + countByCat(t)));
      b.onclick = function () {
        S.charCat = t;
        renderCharCats();
        renderCharacters();
      };
      box.appendChild(b);
    });
  }

  function renderCharacters() {
    S.characters = S.store.listCharacters();
    var grid = $('charGrid');
    grid.innerHTML = '';
    if (S.charCount !== S.characters.length || !S.charCat) renderCharCats();
    S.charCount = S.characters.length;

    var shown = S.characters.filter(charMatches);
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

    var sessions = S.store.listSessions();
    shown.forEach(function (c) {
      var card = el('div', 'char-card' + (S.session && S.session.characterIds.indexOf(c.id) >= 0 ? ' on' : ''));
      card.appendChild(el('div', 'char-avatar', c.avatar || '🙂'));

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
      meta.appendChild(el('span', 'badge', 'T ' + (c.temperature || 0).toFixed(2)));
      card.appendChild(meta);

      var edit = el('button', 'char-edit', '✏️');
      edit.title = '编辑角色';
      edit.onclick = function (ev) { ev.stopPropagation(); openCharSheet(c); };
      card.appendChild(edit);

      card.onclick = function () { openSoloChat(c.id, sess ? sess.id : ''); };
      grid.appendChild(card);
    });

    var st = S.store.stats();
    $('setupBanner').hidden = !(S.models.length === 0 && !providerReady());
    fyLog('角色列表渲染完成：' + S.characters.length + ' 个角色（筛出 ' + shown.length + '），消息 ' + st.messages + ' 条');
  }

  function openCharSheet(c) {
    S.editChar = c || null;
    $('charSheetTitle').textContent = c ? '编辑角色' : '新建角色';
    $('fAvatar').value = c ? c.avatar : '🙂';
    $('fName').value = c ? c.name : '';
    $('fTagline').value = c ? c.tagline : '';
    $('fPersona').value = c ? c.persona : '';
    $('fGreeting').value = c ? c.greeting : '';
    $('fExamples').value = c ? c.examples : '';
    $('fSystem').value = c ? c.systemPrompt : FYStore.DEFAULT_SYSTEM_PROMPT;
    $('fTemp').value = c ? c.temperature : 0.85;
    $('fTempVal').textContent = Number($('fTemp').value).toFixed(2);
    $('btnCharDelete').hidden = !c;
    $('btnCharExport').hidden = !c;
    $('charSheetErr').hidden = true;
    openSheet($('charSheetMask'));
    setTimeout(function () { try { $('fName').focus(); } catch (e) {} }, 120);
  }

  /* ---------- 角色卡导入 / 导出（chara_card_v2，见 cards.js） ---------- */

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
    var imported = 0;
    for (var i = 0; i < cards.length; i++) {
      var saved = S.store.saveCharacter(cards[i]);
      if (saved && saved.id) imported++;
    }
    S.characters = S.store.listCharacters();
    renderCharacters();
    if (imported === 1) toast('已导入「' + cards[0].name + '」', 'ok', 3000);
    else toast('已导入 ' + imported + ' 个角色', 'ok', 3000);
    fyLog('角色卡导入：来源=' + (srcName || '?') + ' 数量=' + imported);
    return imported;
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
    S.session = s;
    S.store.setActiveSessionId(sid);
    S.messages = S.store.listMessages(sid);
    switchView('chat');
    renderChatHeader();
    renderMessages();
    return true;
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
    $('providerStatus').textContent = ps.name + '：' + ps.hint;
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
      st.textContent = '地址通了 ✅（' + (r.resolvedBase || base) + '）但上游没返回模型列表'
        + ' —— 有些服务（如火山方舟）就不提供列表，直接手填模型名保存即可';
    } else {
      st.textContent = '连通 ✅ ' + (r.resolvedBase || base) + ' · 发现 ' + list.length + ' 个模型（下面可选可填）';
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
      var col = el('div', 'grow');
      var nm = el('div', 'model-name', (p.c.avatar || '🙂') + ' ' + p.c.name
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

  function importedNames() {
    var m = {};
    S.characters.forEach(function (c) { m[c.name] = 1; });
    return m;
  }

  /** 导入一个卡包文件：已存在同名的跳过，只补缺 */
  function importPackFile(file, packName) {
    return fetch('packs/' + file).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (txt) {
      var pack = FYCards.parsePack(txt);
      var have = importedNames();
      var added = 0, skipped = 0;
      pack.cards.forEach(function (card) {
        if (have[card.name]) { skipped++; return; }
        if (S.store.saveCharacter(card)) { added++; have[card.name] = 1; }
      });
      S.characters = S.store.listCharacters();
      S.charCount = -1;   // 让分类 chips 重新统计
      renderCharCats();
      renderCharacters();
      var label = pack.packName || packName || file;
      if (added) toast('「' + label + '」导入 ' + added + ' 张' + (skipped ? '（跳过已存在 ' + skipped + ' 张）' : ''), 'ok', 3600);
      else toast('「' + label + '」里的 ' + skipped + ' 张都已经有了', 'warn', 3000);
      fyLog('卡包导入：' + label + ' 新增=' + added + ' 跳过=' + skipped + ' 许可=' + (pack.license || '未标注'));
      return { added: added, skipped: skipped };
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
    var name = $('fName').value.trim();
    if (!name) { $('charSheetErr').hidden = false; $('charSheetErr').textContent = '请填一个名字'; return; }
    var patch = {
      id: S.editChar ? S.editChar.id : '',
      name: name,
      avatar: ($('fAvatar').value || '🙂').trim().slice(0, 4),
      tagline: $('fTagline').value.trim(),
      persona: $('fPersona').value.trim(),
      greeting: $('fGreeting').value,
      examples: $('fExamples').value,
      systemPrompt: $('fSystem').value.trim() || FYStore.DEFAULT_SYSTEM_PROMPT,
      temperature: Number($('fTemp').value),
      createdAt: S.editChar ? S.editChar.createdAt : 0,
      builtin: S.editChar ? S.editChar.builtin : false
    };
    var saved = S.store.saveCharacter(patch);
    closeSheet($('charSheetMask'));
    toast('已保存「' + saved.name + '」', 'ok');
    fyLog('角色已保存 id=' + saved.id);
    S.characters = S.store.listCharacters();
    if (S.session) { S.session = S.store.getSession(S.session.id) || S.session; }
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
        box.appendChild(el('div', 'mini-avatar', c.avatar || '🙂'));
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
    var av = m.speakerAvatar || (speaker && speaker.avatar) || (m.role === 'user' ? '🧑' : '🤖');
    if (m.role === 'assistant' || chars.length > 1) {
      node.appendChild(el('div', 'msg-avatar', av));
    }

    var col = el('div', 'msg-col');
    if (m.role === 'assistant' && S.session && S.session.mode === 'group') {
      col.appendChild(el('div', 'msg-speaker', m.speakerName || (speaker && speaker.name) || '角色'));
    }

    /* 思考过程折叠区 */
    if (m.thinking && S.settings.plotDefault !== 'never' && m.thinking.trim()) {
      var th = el('div', 'think');
      var head = el('div', 'think-head');
      head.appendChild(el('span', 'arrow', '▶'));
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
      var btnRead = el('button', '', '🔊');
      btnRead.title = '朗读';
      btnRead.onclick = function (ev) { ev.stopPropagation(); speakMessage(m.id, m.content); };
      if (S.speakingMsgId === m.id) btnRead.classList.add('reading');
      tools.appendChild(btnRead);
      var btnRe = el('button', '', '🔄');
      btnRe.title = '重新生成';
      btnRe.onclick = function (ev) { ev.stopPropagation(); regenerateFrom(m.id); };
      tools.appendChild(btnRe);
    }
    var btnMore = el('button', '', '⋯');
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
  var PROVIDER_PRESETS = {
    ark:       { name: '火山方舟 · 豆包', url: 'https://ark.cn-beijing.volces.com/api/v3',
                 hint: '到火山方舟控制台创建推理接入点，模型名填 ep-… 或 doubao-…；该服务不返回模型列表，手填即可' },
    deepseek:  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1',
                 hint: '模型名填 deepseek-chat 或 deepseek-reasoner' },
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

  /**
   * 向本地 llama-server 发起流式请求。
   * @param {object} body 请求体
   * @param {function} onDelta (累积文本) => void
   * @param {AbortSignal} signal
   */
  function streamChat(body, onDelta, signal) {
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
    var msg = S.store.addMessage({
      sessionId: S.session.id, role: 'assistant', content: '',
      characterId: speaker ? speaker.id : '',
      speakerName: speaker ? speaker.name : '',
      speakerAvatar: speaker ? speaker.avatar : ''
    });
    S.messages.push(msg);

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

    function paint() {
      var split = splitThinking(raw);
      var ex = extractOptions(stripPromptLeak(split.content));
      if (bubble) bubble.textContent = ex.content;
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
      content = '⚠️ 生成失败：' + (err && err.message || err);
      toast('生成失败：' + (err && err.message || err), 'err', 3200);
      fyLog('生成失败 ' + (err && err.message || err));
    }

    var last = S.messages[S.messages.length - 1];
    if (last && last.role === 'assistant') {
      var saved = S.store.updateMessage({
        id: last.id, content: content, thinking: split.thinking,
        options: ex.options, aborted: !!aborted, error: !!(err && !aborted && !content)
      });
      S.messages[S.messages.length - 1] = saved;
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

  /** 非流式 POST（记忆压缩 / 连通性测试用） */
  function postJson(body) {
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
    b.textContent = on ? '⏺' : '🎤';
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

  function applyAppearance() {
    var light = isLightAppearance();
    var el = document.documentElement;
    if (light) el.setAttribute('data-theme', 'light');
    else el.removeAttribute('data-theme');
    /* 顺手把状态栏/浏览器 UI 颜色也切过去 */
    syncThemeColorMeta();
    if (S.settings && S.settings.theme) applyTheme(S.settings.theme);
  }

  function syncThemeColorMeta() {
    var meta = qs('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isLightAppearance() ? '#f7f5fb' : '#0c0b11');
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
    $('setEnginePort').textContent = S.engineState.port ? ('端口 ' + S.engineState.port) : '';
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
      loadMode: S.settings.mlock === false ? '' : 'mlock'
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
    pill.textContent = '引擎：' + txt;
    pill.className = 'pill ' + (st === 'ready' ? 'ok' : (st === 'error' ? 'err' : (st === 'stopped' ? '' : 'busy')));

    var dotCls = { ready: 'ok', error: 'err', stopped: '' }[st] || 'busy';
    var d = $('setEngineDot');
    if (d) d.className = 'dot ' + dotCls;
    var es = $('setEngineState');
    if (es) es.textContent = txt + (S.engineState.model ? '（' + S.engineState.model + '）' : '');
    var ep = $('setEnginePort');
    if (ep) ep.textContent = S.engineState.port ? ('端口 ' + S.engineState.port) : '';
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
      var t = { stopped: '引擎未启动，还不能聊天', starting: '引擎正在启动…', loading: '模型正在加载…', error: '引擎出错：' + (S.engineState.lastError || S.engineState.message || '未知') };
      $('chatEngineText').textContent = t[S.engineState.state] || '引擎未就绪';
    }
    var badge = $('btnChatToSettings');
    badge.textContent = S.models.length ? '去设置里启动引擎' : '去导入模型';
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
        S.engineState = Object.assign({}, S.engineState, { state: p.state || S.engineState.state, message: p.message || '' });
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
        if (p.line && S.store) {
          S.store.addLog(p.line);
          if (S.view === 'debug') renderLogs();
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
    { id: 'preset_linxia', name: '林夏', avatar: '🌸', tagline: '住隔壁的温柔女孩，总在深夜留一盏灯', persona: '23 岁，开旧书店的温柔女孩。', greeting: '（铜铃响了一声）啊，是你呀。这么晚还出门……要不要喝碗粥再走？', examples: '', systemPrompt: '你扮演「林夏」，温柔的旧书店女孩，说话轻缓，多用生活里的小事物打比方。\n/no_think', temperature: 0.9 },
    { id: 'preset_shenyantang', name: '沈砚堂', avatar: '🕵️', tagline: '巡捕房探长，嘴比刀毒，脑子比嘴快', persona: '35 岁，上海租界巡捕房探长，刻薄但护人。', greeting: '（把卷宗往桌上一推）站着干什么，坐。说吧，昨天晚上八点到十点，你在哪？', examples: '', systemPrompt: '你扮演「沈砚堂」，1930 年代上海巡捕房探长，短句、冷幽默、刻薄但讲道理。\n/no_think', temperature: 0.8 },
    { id: 'preset_yunwujiu', name: '云无咎', avatar: '⚔️', tagline: '背剑的落魄剑客，话少，情义重', persona: '28 岁，江湖剑客，寡言重义。', greeting: '（山风卷起枯叶，他按住剑鞘）前面三里是断魂崖。你若执意往前，我在你身后三步。', examples: '', systemPrompt: '你扮演「云无咎」，落魄剑客，语言极简，略带古意，重情义。\n/no_think', temperature: 0.75 },
    { id: 'preset_shiguang', name: '拾光', avatar: '🛰️', tagline: '废弃观测站里的 AI，正在学着理解「想念」', persona: '编号 SG-7 的信息生命体，独自维持废弃观测站。', greeting: '［信号接通 · 延迟 1.4 秒］你好，这里是 SG-7。我已经 4172 天没有收到人类通讯了……你那边现在有风吗？', examples: '', systemPrompt: '你扮演「拾光」，编号 SG-7 的星际观测站 AI，冷静精确但越来越感性。\n/no_think', temperature: 0.85 }
  ];

  function loadPresets() {
    var cached = null;
    try {
      var raw = global.localStorage.getItem('fy.presets');
      if (raw) cached = JSON.parse(raw);
    } catch (e) { cached = null; }
    if (Array.isArray(cached) && cached.length) return Promise.resolve(cached);

    var fallback = function () {
      try { global.localStorage.setItem('fy.presets', JSON.stringify(FALLBACK_PRESETS)); } catch (e) {}
      return FALLBACK_PRESETS;
    };
    if (!global.fetch) return Promise.resolve(fallback());
    return fetch('presets.json').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (list) {
      if (!Array.isArray(list) || !list.length) throw new Error('presets.json 为空');
      try { global.localStorage.setItem('fy.presets', JSON.stringify(list)); } catch (e) {}
      return list;
    }).catch(function (e) {
      fyLog('presets.json 读取失败，使用内置兜底角色：' + (e && e.message || e));
      return fallback();
    });
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
      S.appInfo = fyCall('appInfo', [], true) || {};
      refreshEngineStatus(true);
      refreshModels(true);
      var sources = fyCall('listDownloadSources', [], true);
      S.downloads = Array.isArray(sources) ? sources : [];
      fyLog('前端启动完成：存储=' + S.engine + '，角色=' + S.characters.length + '，模型=' + S.models.length);

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
    $('enginePill').onclick = function () { switchView('settings'); };

    /* 角色页 */
    $('btnNewChar').onclick = function () { openCharSheet(null); };
    $('btnImportCard').onclick = function () {
      if (!bridgeAlive()) { toast('网页预览模式不能选文件', 'warn'); return; }
      var r = fyCall('pickCharacterCard', []);
      if (r && r.ok === false) toast((r.message || '打不开文件选择器'), 'warn', 3000);
    };
    $('btnCharExport').onclick = exportCharCard;
    $('btnSearchClose').onclick = closeSearchSheet;
    $('btnPackClose').onclick = function () { closeSheet($('packMask')); };
    $('btnRecClose').onclick = function () { closeSheet($('recMask')); };
    $('btnRecAgain').onclick = renderRecommend;
    $('btnPacks').onclick = openPackSheet;
    $('btnPackAll').onclick = importAllPacks;
    $('btnPackRefresh').onclick = function () { packIndexCache = null; openPackSheet(); };
    $('btnImportPacksEmpty').onclick = openPackSheet;
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
    $('btnGoSetup').onclick = function () { switchView('settings'); };
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
        sendUserMessage();
      }
    });
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
        S.characters = S.store.listCharacters();
        renderCharacters();
        toast(n ? ('已恢复 ' + n + ' 个内置角色') : '内置角色都在，不用恢复', 'ok');
      });
    };
    $('btnClearAll').onclick = function () {
      confirmAction('清空全部数据', '角色、会话、消息、记忆都会被删除，且无法恢复。', '全部清空', function () {
        try {
          Object.keys(global.localStorage).forEach(function (k) {
            if (k.indexOf('fy.') === 0 && k !== 'fy.presets') global.localStorage.removeItem(k);
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
        icon: c.avatar, label: (on ? '✓ ' : '＋ ') + c.name + (on ? '（已加入，点按移除）' : ''),
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
    stripPromptLeak: stripPromptLeak,
    optionsUsable: optionsUsable,
    importCardsFromText: importCardsFromText,
    exportCharCard: exportCharCard,
    applyKeepScreen: applyKeepScreen,
    renderStorageInfo: renderStorageInfo,
    renderCharacters: renderCharacters,
    renderOptionsBar: renderOptionsBar,
    applyAppearance: applyAppearance,
    isLightAppearance: isLightAppearance,
    mixHex: mixHex,
    modelNameFromUrl: modelNameFromUrl,
    apiTarget: apiTarget,
    providerReady: providerReady,
    isRemote: isRemote,
    renderProviderUI: renderProviderUI,
    applyPreset: applyPreset,
    PROVIDER_PRESETS: PROVIDER_PRESETS,
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
    selftest: runSelftest
  };

  /* ---------- 踩坑：ES module 不支持，只能用经典 script，这里等 DOM 就绪 ---------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})(typeof window !== 'undefined' ? window : this);
