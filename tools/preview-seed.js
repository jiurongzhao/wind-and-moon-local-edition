/**
 * preview-seed.js —— 只给「截图/预览」用的假数据注入脚本。
 *
 * 它**不进 APK**：tools/shots.sh 会把 UI 复制到临时目录，再在副本的 index.html 里
 * 额外引入这个文件，用 ?view=xxx 指定要摆出哪个界面，然后交给无头 Chromium 截图。
 *
 * 支持的参数：
 *   ?view=characters|chat|chatlight|settings|packs|sheet|rec|search|onboard|backend|slash
 *        |creator|creator2|editor|ref
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

  /* 编辑面板截图用的一张「接近成品」的卡：人设/开场白/示例/系统提示词都够长，
     这样七维评分条不是一排 0，截出来能看出评分面板真正长什么样。 */
  var DRAFT = {
    name: '沈砚', avatar: '📜',
    tagline: '图书馆闭馆前，那本书还回来时夹着一张今天的照片',
    persona: '沈砚，34 岁，市图书馆古籍部的管理员。她说话慢，习惯先把手里的东西放稳再开口。'
      + '别人以为她冷淡，其实她记得每个常客借过什么书。缺点是不肯欠人情：别人帮了她一次，她要想办法还两次。'
      + '最在意的是 1998 年那批没编完号的旧书——她父亲当年就是管这批书的。'
      + '你和她的起点是：闭馆前十分钟，她把一本三十年前借出的书推到你面前。',
    greeting: '（把那本书推到桌面中间，指腹压着书脊）闭馆前十分钟，我一般不说话。'
      + '今天例外——这本书是三十年前借出去的，今天还回来了。'
      + '（她翻开扉页，里面夹着一张照片）你看这个人，是不是有点像你？',
    examples: '用户：这么晚还在图书馆？\n沈砚：（把台灯往你那边推了推）灯给你，我习惯暗一点。\n\n'
      + '用户：你为什么一直留着这本书？\n沈砚：（停了两秒）……有些编号是要还的，人也是。',
    systemPrompt: '你扮演「沈砚」，市图书馆古籍部管理员，34 岁，说话慢、句子短，动作神态放在圆括号里。\n'
      + '要做到：先有动作再开口；记得每个常客的细节；拒绝时直接拒绝。\n'
      + '你最在意的：1998 年那批没编完号的旧书。\n'
      + '行为边界：不替用户做决定；不长篇说教；不自称 AI。\n/no_think',
    temperature: 0.8, tags: ['悬疑推理'], kind: 'story', plot: true,
  };

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
    /* 启动遮罩必须立刻拿掉：无头 Chromium 的 virtual-time 会把 380ms 的淡出动画
       冻在中途，截出来的整页像蒙了一层灰（设置页尤其明显）。 */
    try {
      var boot = document.getElementById('boot');
      if (boot) { boot.classList.add('hide'); boot.style.display = 'none'; }
    } catch (e) {}
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
    } else if (view === 'onboard') {
      App.switchView('characters');
      try {
        App.state.settings = App.store.saveSettings({ onboarded: false });
        /* 截图要看到引导：把"已经有模型/已配好服务"这两个条件按新用户状态摆好 */
        App.state.models = [];
        App.state.provider = { mode: 'local', baseUrl: '', model: '', hasKey: false, ready: false };
        App.state.engineState = Object.assign({}, App.state.engineState, { state: 'stopped', port: 0 });
      } catch (e) {}
      App.maybeShowOnboarding ? App.maybeShowOnboarding() : null;
      /* 预览里 bootstrap 会把模型列表再填回来，所以直接强制显示这次引导，专门给它截图 */
      document.getElementById('onboardMask').hidden = false;
    } else if (view === 'backend') {
      App.switchView('chat');
      App.openBackendSheet ? App.openBackendSheet() : null;
    } else if (view === 'slash') {
      App.switchView('chat');
      var inp = document.getElementById('input');
      inp.value = '/';
      inp.dispatchEvent(new Event('input'));
    } else if (view === 'creator' || view === 'creator2') {
      App.switchView('characters');
      App.openCreatorWizard();
      if (view === 'creator2') {
        /* 模板库是异步加载的；等它到位再跳到第二步，否则截出来是"正在加载" */
        var t2t = 0;
        var t2 = setInterval(function () {
          t2t++;
          if (window.FYCreator && window.FYCreator.bundle()) {
            clearInterval(t2);
            try {
              App.state.creator.tag = '悬疑推理';
              App.state.creator.kind = 'story';
              App.creatorNext();
            } catch (e) {}
          } else if (t2t > 60) { clearInterval(t2); }
        }, 100);
      }
    } else if (view === 'editor') {
      App.switchView('characters');
      App.openCharSheet(null, DRAFT);
      try { App.refreshLint(); } catch (e) {}
    } else if (view === 'ref') {
      App.switchView('characters');
      App.openRefSheet();
    } else if (view === 'library' || view === 'library-search') {
      /* 在线卡库面板（v2）：把目录流（/fetch?url=…）用假目录截住。
         每「分类 × 类型」切成 4 片主题片，带 topics / keywords，
         并假装其中两片已经导入过 —— 截图里能同时看到「已导入 / 未下载 / 全部下载」。
         view=library-search 会顺手在搜索框里打一个词，截"只下某一片"那张。 */
      App.switchView('characters');
      var cats = [
        ['daily-healing', '日常治愈', '🌤'], ['romance', '恋爱', '💗'],
        ['mystery', '悬疑推理', '🔍'], ['wuxia', '古风仙侠', '⚔️'],
        ['scifi', '科幻未来', '🛰'], ['fantasy', '奇幻冒险', '🐉'],
        ['campus', '校园', '🎒'], ['workplace', '职场', '💼'],
        ['history', '历史', '📜'], ['horror', '恐怖惊悚', '🕯'],
        ['comedy', '喜剧沙雕', '🤣'], ['supernatural', '灵异怪谈', '👻'],
        ['apocalypse', '末世生存', '☢️'], ['cyberpunk', '赛博朋克', '🌃'],
        ['mythology', '神话志怪', '🐚'], ['comfort', '情感树洞', '🫂'],
      ];
      var topics = {
        'mystery': [['画像师', '私下接活的调查员', '法医', '殡葬用品店店主'], ['不在场证明的时间表', '一笔一笔合法的清算', '遗言的两层意思']],
        'wuxia': [['摆渡的瞎子', '贩马客', '山门伙夫', '狱卒'], ['三件信物', '旧约到期', '同一个人，两个门派的名分']],
        'romance': [['旧照片修复师', '医院陪护', '花店店主', '殡仪馆化妆师'], ['先婚后爱', '童年之约过期', '异地恋']],
      };
      var packs = [];
      cats.forEach(function (c) {
        ['character', 'story'].forEach(function (k) {
          var sample = (topics[c[0]] || [[], []])[k === 'character' ? 0 : 1];
          for (var i = 1; i <= 4; i++) {
            var t0 = sample[(i - 1) % Math.max(1, sample.length)] || c[1];
            var t1 = sample[i % Math.max(1, sample.length)] || t0;
            var kw = [t0];
            if (t1 !== t0) kw.push(t1);
            ['解剖室', '旧档案', '值班表', '断桥', '备用钥匙', '一封没寄出的信']
              .slice(i - 1, i + 2).forEach(function (w) { if (kw.indexOf(w) < 0) kw.push(w); });
            packs.push({
              file: c[0] + '-' + k + '-' + i + '.json', slug: c[0], tag: c[1], emoji: c[2],
              kind: k, part: i, parts: 4, count: 248, bytes: 1230000, sha256: '',
              topic: t0 + (i < 4 ? ' 等 6 个主题' : ''),
              topics: [t0, t1], keywords: kw,
            });
          }
        });
      });
      var catalog = {
        spec: 'fy_library_v2', chunk: 250, total: 32000, baseUrl: 'https://example.invalid/library/',
        categories: cats.map(function (c) {
          var sample = (topics[c[0]] || [[''], ['']]);
          return {
            slug: c[0], tag: c[1], emoji: c[2], character: 1000, story: 1000,
            topics: sample[0].slice(0, 3).concat(sample[1].slice(0, 2)),
          };
        }),
        packs: packs,
      };
      var realFetch = window.fetch;
      window.fetch = function (u) {
        if (/\/fetch\?url=/.test(String(u)) || /fy-library|library\/index/.test(String(u))) {
          return Promise.resolve(new Response(JSON.stringify(catalog), {
            status: 200, headers: { 'content-type': 'application/json' },
          }));
        }
        return realFetch.apply(window, arguments);
      };
      var imported = {};
      imported['mystery-character-1.json'] = { count: 248, ts: Date.now() };
      imported['romance-story-2.json'] = { count: 250, ts: Date.now() };
      App.state.settings = App.state.store.saveSettings({
        libCatalogUrl: 'https://example.invalid/library/index.json',
        libraryImported: imported,
      });
      App.openLibrarySheet();
      if (view === 'library-search') {
        var tries = 0;
        var t = setInterval(function () {
          var box = document.getElementById('libSearch');
          if (box && App.libSearchPacks) {
            box.value = '画像师';
            box.dispatchEvent(new Event('input', { bubbles: true }));
            clearInterval(t);
          } else if (++tries > 40) { clearInterval(t); }
        }, 50);
      }
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
