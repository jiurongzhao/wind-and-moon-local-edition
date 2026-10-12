/**
 * preview-seed.js —— 只给「截图/预览」用的假数据注入脚本。
 *
 * 它**不进 APK**：tools/shots.sh 会把 UI 复制到临时目录，再在副本的 index.html 里
 * 额外引入这个文件，用 ?view=xxx 指定要摆出哪个界面，然后交给无头 Chromium 截图。
 *
 * 支持的参数：
 *   ?view=characters|chat|chatlight|settings|packs|sheet|rec|search
 *   &theme=light|dark
 *   &n=8            角色数量（默认 12）
 */
(function () {
  var q = new URLSearchParams(location.search);
  var view = q.get('view') || 'characters';
  var theme = q.get('theme') || '';
  var n = parseInt(q.get('n') || '12', 10);

  var CARDS = [
    ['沈砚', '📜', '悬疑推理', '图书馆闭馆前，那本书还回来时夹着一张今天的照片', 'story'],
    ['林昭', '🌤', '日常治愈', '楼下面包店的常客，总在打烊前十分钟来', 'character'],
    ['阿箬', '⚔️', '古风仙侠', '剑冢守碑人，记得每一把断剑的名字', 'story'],
    ['白鸦', '🌃', '赛博朋克', '义体医生，只收现金，不问来路', 'character'],
    ['陆知遥', '💗', '恋爱', '高中同学会重逢，她带了别人的戒指', 'character'],
    ['柯砚', '🔍', '悬疑推理', '法医，习惯先说完结论再解释', 'character'],
    ['桑野', '🐉', '奇幻冒险', '公会登记员，偷偷把新人塞进最好的队伍', 'character'],
    ['周雨眠', '🫂', '情感树洞', '深夜电台主播，声音比人先睡', 'character'],
    ['老陈', '☢️', '末世生存', '守着一台还能发电的收音机', 'story'],
    ['青禾', '🎒', '校园', '生物社唯一坚持来的人，养了一缸虾', 'character'],
    ['赵一鸣', '💼', '职场', '甲方改需求时先笑，然后逐条反驳', 'character'],
    ['蜃', '🐚', '神话志怪', '海边集市上卖梦的摊主，找零找记忆', 'character'],
  ];

  function seed() {
    var App = window.FYApp, store = App && App.state && App.state.store;
    if (!store) return false;
    /* 内置预设会先占位（DB 为空时 bootstrap 会种 4 个预设），这里清掉换成有标签的样本，
       否则截出来的角色页看不到分类 chips。 */
    store.listCharacters().forEach(function (c) {
      if (c.builtin || /^(林夏|沈砚堂|云无咎|拾光)$/.test(c.name)) store.deleteCharacter(c.id);
    });
    if (store.listCharacters().length === 0) {
      CARDS.slice(0, n).forEach(function (c) {
        store.saveCharacter({
          name: c[0], avatar: c[1], tags: [c[2]], tagline: c[3],
          persona: c[3] + '。说话有自己的节奏，会把在意的事藏在细节里。'.repeat(2),
          greeting: '（抬眼看你）……你来了。' + c[3] + '。',
          examples: '用户：你好\n' + c[0] + '：嗯。\n\n用户：然后呢？\n' + c[0] + '：（顿了顿）然后就没下文了。',
          systemPrompt: '你扮演' + c[0] + '。语气自然，动作神态放在圆括号里。\n/no_think',
          kind: c[4], plot: c[4] === 'story', temperature: 0.85,
        });
      });
    }
    /* 一个已经有内容的会话，用来截聊天页。
       注意：这里必须用**自己造的角色**（按名字捞），不能取 listCharacters()[0] ——
       App 启动时也会种入 4 个内置预设，抢起来会话就会绑到稍后被清掉的角色上，
       截出来就是"（角色已删除）"。 */
    if (store.listSessions().length === 0) {
      var ch = null;
      store.listCharacters().forEach(function (c) { if (c.name === '沈砚' && !ch) ch = c; });
      if (!ch) ch = store.listCharacters()[0];
      var s = store.saveSession({ title: ch.name, characterIds: [ch.id], mode: 'solo', plot: ch.kind === 'story' });
      store.addMessage({ sessionId: s.id, role: 'user', content: '这么晚还在图书馆？' , ts: Date.now() - 60000 });
      store.addMessage({
        sessionId: s.id, role: 'assistant', speakerName: ch.name,
        characterId: ch.id, speakerAvatar: ch.avatar,
        content: '（把那本书推到桌面中间，指腹压着书脊）闭馆前十分钟，我一般不说话。\n今天例外——这本书是三十年前借出去的，今天还回来了。\n（她翻开扉页，里面夹着一张照片）你看这个人，是不是有点像你？',
        ts: Date.now() - 50000,
      });
      store.setActiveSessionId(s.id);
    }
    store.flushNow();
    return true;
  }

  function go() {
    var App = window.FYApp;
    if (!App) return;
    try { App.state.characters = App.state.store.listCharacters(); } catch (e) {}
    App.state.settings = App.state.store.saveSettings({ appearance: theme === 'light' ? 'light' : 'dark' });
    App.applyAppearance();
    if (view === 'chat' || view === 'chatlight') {
      var st = App.state.store;
      var s = st.listSessions()[0];
      var ch0 = st.listCharacters()[0];
      /* 截图要好看：如果会话绑的角色已经不存在（种子与 App 预设种入抢过），
         就地把它重新指到一个有效角色，避免截出「（角色已删除）」 */
      if (s && ch0 && (!(s.characterIds || []).length || !st.getCharacter(s.characterIds[0]))) {
        s = st.saveSession(Object.assign({}, s, { characterIds: [ch0.id], title: ch0.name }));
      }
      if (s) App.openSessionById(s.id);
      App.switchView('chat');
      /* 剧情选项栏是从 S.lastOptions 渲染的（真实流程里由流式解析写入），这里手动摆出来 */
      if (App.state.session) {
        App.state.session = App.state.store.saveSession(
          Object.assign({}, App.state.session, { plot: true }));
        App.state.lastOptions = ['照片上的人我认识，是我母亲。', '先问她这本书是谁还回来的。', '假装没看见，把书合上。'];
        try { App.renderOptionsBar ? App.renderOptionsBar() : null; } catch (e) {}
      }
    } else if (view === 'settings') {
      App.switchView('settings');
    } else if (view === 'packs') {
      App.switchView('characters');
      App.openPackSheet();
    } else if (view === 'rec') {
      App.switchView('characters');
      document.getElementById('btnSurprise').click();
    } else if (view === 'search') {
      App.switchView('characters');
      App.openSearchSheet();
      document.getElementById('searchInput').value = '书';
      App.runSearch();
    } else if (view === 'sheet') {
      App.switchView('characters');
      var first = App.state.store.listCharacters()[0];
      document.querySelector('#charGrid .char-card').click();
      if (!App.state.session) App.openSoloChat(first.id, '');
    } else {
      App.switchView('characters');
    }
  }

  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var ok = false;
    try { ok = seed(); } catch (e) { ok = false; }
    if (ok || tries > 40) {
      clearInterval(timer);
      setTimeout(go, 120);
      /* bootstrap 还在跑：它会在自己的 then 链里用早期读到的 settings 再应用一次外观，
         所以这里等它落定后再压一次，保证截图里的主题就是我们要的 */
      setTimeout(function () { try { go(); } catch (e) {} }, 1500);
    }
  }, 100);
})();
