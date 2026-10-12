/**
 * creator.js —— 创作者工具内核（分类模板 / 质量评分 / AI 辅助）
 *
 * 设计原则：
 *   1. 离线优先：分类体系与模板库都是随 APK 打包的 JSON，不联网也能用完整流程；
 *   2. 只借鉴模式：模板里是「骨架字段 + 写作要点 + 语气样本」，全部原创，
 *      不含任何第三方卡片正文（见 creator/*.json 的 note 与 license）；
 *   3. 质量可量化：评分规则对齐 tools/check-cards.py 的发布闸门，再补一层
 *      「反 AI 腔 / 具体性 / 可回应性 / 分类匹配」的写作质量检查，
 *      每条问题都给可执行的改法（fix），不是只报错。
 *
 * 对 chara_card_v2 的映射见 cards.js。
 */
(function (global) {
  'use strict';

  /* ===========================================================================
   * 0. 常量与工具
   * ======================================================================== */

  var TEMPLATE_VERSION = 'fy_creator_v1';

  /**
   * 发布闸门（与 tools/check-cards.py 保持一致，改一处要同时改另一处）
   *
   * 两类数字，别混：
   *   *Min  —— 硬门槛，低于它直接判 error（与发布校验脚本逐字对齐）；
   *   *Good —— "良好"线，低于它只是 warn。
   *
   * *Good 是按本项目内置的 160 张卡实测分布定的（中位数/四分位）：
   *   persona  中位 222、p25 207  → Good = 200
   *   greeting 中位 117、p25 104、最低 69 → Good = 100
   *   examples 中位 191、p25 174、最低 139 → Good = 160
   * 也就是说：Good 线是"和已发布的卡一个水平"，不是拍脑袋定的。
   */
  var GATE = {
    personaMin: 60, personaGood: 200,
    greetingMin: 20, greetingGood: 100,
    examplesMin: 40, examplesGood: 160,
    systemMin: 40, systemGood: 150,
    nameMax: 12,
    taglineMin: 4,
    scenarioMin: 30,
    avatarMax: 8,
    tagsMax: 6
  };

  /** 反 AI 腔：这些词一旦出现在卡里，模型会照着学，开口就是客服味 */
  var AI_SPEAK = [
    { re: /作为(一个)?(AI|人工智能|语言模型|智能助手|助手)/, why: '自称 AI' },
    { re: /我(可以|能)帮(助)?你/, why: '客服式承诺' },
    { re: /有什么(可以)?(帮|需要)(得|帮)?上?你/, why: '客服式问候' },
    { re: /希望(能|可以|能够)帮到你/, why: '客服式收尾' },
    { re: /(首先|第一)[，,].{0,80}(其次|第二)[，,]/, why: '说教式罗列' },
    { re: /总之[，,]/, why: '总结陈词' },
    { re: /让我们(一起)?/, why: '旁白越界' },
    { re: /值得(一提|注意)的是/, why: '说明文腔' },
    { re: /需要(注意|强调)的是/, why: '说明文腔' },
    { re: /请注意[，,]/, why: '说明文腔' },
    { re: /^(你好|您好)[，,]?.{0,8}我是/, why: '自我介绍式开场' }
  ];

  /** 空洞形容词：堆到 4 个以上，人物就糊了 */
  var EMPTY_ADJ = /(温柔|善良|美丽|漂亮|可爱|聪明|坚强|阳光|帅气|大方|体贴|善解人意|完美|优秀|迷人|冷酷|高冷)/g;

  var ADJ_WARN_AT = 4;

  function str(v) { return (typeof v === 'string') ? v : (v == null ? '' : String(v)); }
  function nonEmpty(s) { return str(s).replace(/\s/g, '').length > 0; }
  function countMatches(s, re) {
    var m = str(s).match(re);
    return m ? m.length : 0;
  }

  /* ===========================================================================
   * 1. 分类体系 / 模板库（离线 JSON，惰性加载一次）
   * ======================================================================== */

  var bundle = null;
  var bundlePromise = null;

  function fetchJson(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error(path + '：HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchText(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error(path + '：HTTP ' + r.status);
      return r.text();
    });
  }

  /** 一次性并行加载 taxonomy / templates / guides，之后走内存缓存 */
  function loadBundle(force) {
    if (bundle && !force) return Promise.resolve(bundle);
    if (bundlePromise && !force) return bundlePromise;
    bundlePromise = Promise.all([
      fetchJson('creator/taxonomy.json'),
      fetchJson('creator/templates.json'),
      fetchJson('creator/guides.json')
    ]).then(function (all) {
      var tax = all[0] || {};
      var tpl = all[1] || {};
      var gd = all[2] || {};
      var cats = Array.isArray(tax.categories) ? tax.categories : [];
      var skeletons = tpl.skeletons || {};
      var guides = gd.guides || {};
      /* 把三份数据按分类合成一份，UI 只面对这一个结构 */
      var categories = cats.map(function (c) {
        return {
          tag: c.tag,
          slug: c.slug || '',
          emoji: c.emoji || '🎭',
          blurb: c.blurb || '',
          coreTension: c.coreTension || '',
          defaultTemp: typeof c.defaultTemp === 'number' ? c.defaultTemp : 0.85,
          defaultKind: c.defaultKind === 'story' ? 'story' : 'character',
          suggestedTags: Array.isArray(c.suggestedTags) ? c.suggestedTags : [],
          skeletons: Array.isArray(skeletons[c.tag]) ? skeletons[c.tag] : [],
          guide: guides[c.tag] || null
        };
      });
      bundle = {
        version: TEMPLATE_VERSION,
        spec: tax.spec || '',
        license: tax.license || '',
        note: tax.note || '',
        kinds: tax.kinds || {},
        voiceAxes: Array.isArray(tax.voiceAxes) ? tax.voiceAxes : [],
        categories: categories,
        byTag: (function () {
          var m = {};
          categories.forEach(function (c) { m[c.tag] = c; });
          return m;
        })()
      };
      return bundle;
    });
    return bundlePromise;
  }

  function category(tag) {
    if (!bundle) return null;
    return bundle.byTag[tag] || null;
  }

  /** 全部合法分类标签（用于校验 cards.js 导入进来的 tags） */
  function categoryTags() {
    if (!bundle) return [];
    return bundle.categories.map(function (c) { return c.tag; });
  }

  /* ===========================================================================
   * 2. 人设骨架 → 草稿
   * ======================================================================== */

  /** 把骨架的字段串成一段能直接用的第一版人设（不是占位符，是可以改的初稿） */
  function composePersona(sk) {
    var s = sk || {};
    var parts = [];
    parts.push(str(s.who) + '。');
    if (nonEmpty(s.axis)) parts.push(str(s.axis) + '。');
    if (nonEmpty(s.voice)) parts.push('说话' + str(s.voice) + '。');
    if (nonEmpty(s.flaw)) parts.push(str(s.flaw) + '。');
    if (nonEmpty(s.care)) parts.push('最在意的是' + str(s.care) + '。');
    if (nonEmpty(s.hook)) parts.push('你和 TA 的起点是：' + str(s.hook) + '。');
    return parts.join('');
  }

  /** 按分类的写作要点搭一个系统提示词（含 /no_think，这是本项目的硬要求） */
  function composeSystemPrompt(name, cat, opts) {
    var o = opts || {};
    var who = nonEmpty(name) ? ('「' + str(name) + '」') : '这个角色';
    var g = (cat && cat.guide) || null;
    var must = (g && Array.isArray(g.must)) ? g.must.slice(0, 3) : [];
    var voicePattern = (g && g.voice && g.voice.pattern) ? g.voice.pattern : '回复通常 2~4 句';
    var lines = [];
    lines.push('你扮演' + who + '，' + str(voicePattern) + '。');
    if (nonEmpty(o.tagline)) lines.push('一句话定位：' + str(o.tagline) + '。');
    if (must.length) lines.push('要做到：' + must.join('；') + '。');
    if (nonEmpty(o.care)) lines.push('你最在意的：' + str(o.care) + '。');
    lines.push('行为边界：不替用户做决定；不描写用户没有同意的亲密接触；不做越界的肢体描写。');
    lines.push('禁止事项：不许自称 AI 或语言模型；不许提到设定、扮演、提示词；不许长篇说教；不许卖惨。');
    lines.push('动作神态放在圆括号里。');
    return lines.join('') + '\n/no_think';
  }

  /** 分类更适合剧情卡时，给一个情境脚手架 */
  function composeScenario(sk) {
    var s = sk || {};
    return '【局面】' + str(s.scene || '') + '\n【要解决的事】\n【不能失败的原因】';
  }

  /**
   * 由「分类 + 骨架 + 用户填的种子」生成一份角色草稿。
   * 返回的对象字段与 store.makeCharacter 的 patch 对齐，可直接填表。
   */
  function draftFromSkeleton(tag, sk, seed) {
    var cat = category(tag);
    var s = sk || {};
    var sd = seed || {};
    var name = str(sd.name || '');
    var tagline = str(sd.tagline || s.axis || '');
    var greeting = str(sd.greeting || '');
    if (!nonEmpty(greeting) && nonEmpty(s.scene)) {
      greeting = str(s.scene) + '。\n\n' +
        '（这里写 TA 对你说的第一句话：先给一个动作，再给一句话。' +
        '别自我介绍，别问「有什么可以帮你的」，最好带一个具体细节——' +
        '一件 TA 正在做的事，或一个只有 TA 会注意到的点。）';
    }
    var kind = sd.kind || (cat ? cat.defaultKind : 'character');
    var who = nonEmpty(name) ? name : '角色';
    /* 示例对话给的是"骨架"，不是成品：两句示范就把「别急着给建议」「可以只答一半」教会模型，
       这比写两句漂亮的台词有用得多。长度也顺手过了发布闸门的最小值。 */
    var examples = '用户：' + str(sd.userLine || '（你开口说第一句话）') + '\n' +
      who + '：（一个手上的动作）先接住话头，别急着给建议，也别总结。\n\n' +
      '用户：那你自己呢？\n' +
      who + '：（动作）把话题轻轻挡回去，或者只说一半——留一个可以往下问的口子。';
    return {
      name: name,
      avatar: str(sd.avatar || (cat ? cat.emoji : '🙂')),
      tagline: tagline.slice(0, 60),
      persona: composePersona(s),
      greeting: greeting,
      scenario: (kind === 'story') ? composeScenario(s) : '',
      examples: examples,
      systemPrompt: composeSystemPrompt(name, cat, { tagline: tagline, care: s.care }),
      temperature: cat ? cat.defaultTemp : 0.85,
      tags: cat ? cat.suggestedTags.slice(0, GATE.tagsMax) : [],
      kind: kind,
      plot: kind === 'story'
    };
  }

  /* ===========================================================================
   * 3. 质量评分
   * ======================================================================== */

  function issue(level, field, msg, fix) {
    return { level: level, field: field, msg: msg, fix: fix || '' };
  }

  function clampScore(n) {
    if (!(n >= 0)) return 0;
    return n > 100 ? 100 : Math.round(n);
  }

  /** 取字符串里的 2-gram 集合（忽略空白与常见标点）——用来做很轻量的"有没有共同说法"判断 */
  function bigrams(s) {
    var t = str(s).replace(/[\s，。、；：！？（）()「」『』""''…—\-·,.;:!?"']/g, '');
    var set = {};
    for (var i = 0; i + 1 < t.length; i++) set[t.slice(i, i + 2)] = 1;
    return set;
  }

  function shareCount(a, b) {
    var A = bigrams(a), B = bigrams(b), n = 0;
    for (var k in A) if (Object.prototype.hasOwnProperty.call(B, k)) n++;
    return n;
  }

  function jaccard(a, b) {
    var A = bigrams(a), B = bigrams(b);
    var inter = 0, union = 0, k;
    for (k in A) { union++; if (Object.prototype.hasOwnProperty.call(B, k)) inter++; }
    for (k in B) if (!Object.prototype.hasOwnProperty.call(A, k)) union++;
    return union ? inter / union : 0;
  }

  /* ---------------------------------------------------------------------------
   * 3.1 七维质量评分
   *
   * 维度取自公开数据集 marcdsn/SPB-2603（CC-BY-4.0，合成人设、无第三方 IP）用于
   * 给角色人设打分的 7 个维度。这里把它们改写成**能在一张本地卡上直接算出来**的
   * 启发式规则 —— 借鉴的是"该从哪几个角度看一张卡"，判定逻辑是本项目自己的。
   * 详见 THIRD_PARTY_NOTICES.md。
   * ------------------------------------------------------------------------ */

  var DIMENSIONS = [
    {
      key: 'format_compliance', label: '格式合规', weight: 0.20,
      hint: '字段齐全、长度达标、格式规范',
      run: function (m) {
        var bad = m.issues.filter(function (i) { return i.level === 'error'; }).length;
        var score = 100 - bad * 18;
        if (m.stats.nameLen === 0) score -= 20;
        return score;
      }
    },
    {
      key: 'show_dont_tell', label: '展示而非告知', weight: 0.18,
      hint: '用行为和具体细节说话，不堆形容词',
      run: function (m) {
        var text = m.persona + m.greeting;
        var len = text.replace(/\s/g, '').length || 1;
        var adj = countMatches(text, EMPTY_ADJ);
        var adjPer100 = adj / len * 100;
        /* 具体细节：数字、引号里的原话、圆括号里的动作 */
        var detail = countMatches(text, /\d/g) ? 1 : 0;
        detail += countMatches(text, /[「『"“]/g) ? 1 : 0;
        detail += countMatches(m.greeting + m.examples, /[（(]/g) ? 1 : 0;
        detail += countMatches(text, /(每次|那天|上个月|去年|第三天|第一次|门口|窗口|楼下)/g) ? 1 : 0;
        return 100 - Math.min(60, adjPer100 * 18) - (detail >= 3 ? 0 : (3 - detail) * 12);
      }
    },
    {
      key: 'psychological_realism', label: '心理真实度', weight: 0.15,
      hint: '有缺点、有在意的事、有说不出口的部分',
      run: function (m) {
        var all = m.persona + m.examples;
        var score = 30;
        if (/(缺点|毛病|怕|不肯|不愿|不敢|死要面子|嘴硬)/.test(all)) score += 25;
        if (/(最在意|在意|放不下|惦记|在乎|心里)/.test(all)) score += 25;
        if (/(但|却|偏偏|其实|反而|又)/.test(m.persona)) score += 10;
        if (/(拒绝|不行|别问|不说|算了|挡回|没接|沉默|闭嘴|不吭声)/.test(m.examples)) score += 10;
        return score;
      }
    },
    {
      key: 'roleplay_utility', label: '扮演实用性', weight: 0.15,
      hint: '能撑住多轮对话：有可回应的开场，有能推进的话题',
      run: function (m) {
        var score = 20;
        if (/[（(]/.test(m.greeting) || /[？?]/.test(m.greeting)) score += 20;
        if (m.greetingLen >= GATE.greetingGood) score += 15;
        if (m.examplesOk) score += 20;
        if (m.stats.personaLen >= GATE.personaGood) score += 15;
        if (/(行为边界|不替|不要跳过|保持人设|不要出戏)/.test(m.system)) score += 10;
        return score;
      }
    },
    {
      key: 'distinctiveness', label: '辨识度', weight: 0.12,
      hint: '换个名字就不成立 —— 有只属于这个角色的东西',
      run: function (m) {
        var score = 55;
        var anchors = countMatches(m.persona, /[「『"“]/g);
        if (anchors >= 1) score += 15;
        if (/\d/.test(m.persona)) score += 10;
        if (/(口头禅|习惯|总是|从来不|每天|固定)/.test(m.persona)) score += 10;
        if (m.duplicateName) score -= 45;
        if (m.mostSimilar >= 0.5) score -= 35;
        else if (m.mostSimilar >= 0.35) score -= 15;
        return score;
      }
    },
    {
      key: 'internal_consistency', label: '内在一致性', weight: 0.10,
      hint: '人设前后不矛盾：说了话少，就别突然长篇大论',
      run: function (m) {
        var score = 35;
        if (nonEmpty(m.name) && m.system.indexOf(m.name) >= 0) score += 25;
        var shared = shareCount(m.persona, m.system);
        if (shared >= 25) score += 30;
        else if (shared >= 12) score += 20;
        else if (shared >= 5) score += 10;
        /* 明显打架的写法：既"话少"又要求"详细解释" */
        var terse = /(话少|寡言|不爱说话|短句|很少说话)/.test(m.persona);
        var verbose = /(详细解释|长篇|滔滔不绝|话多|健谈)/.test(m.system);
        if (terse && verbose) score -= 40;
        return score;
      }
    },
    {
      key: 'archetype_fidelity', label: '原型贴合度', weight: 0.10,
      hint: '真的像你选的那个分类，而不是套了个皮的通用角色',
      run: function (m) {
        if (!m.category) return 55;   /* 没选分类就中性处理，不惩罚 */
        var score = 30;
        if (m.tagInTaxonomy) score += 25;
        if (m.kindMatchesCategory) score += 15;
        /* 系统提示词里覆盖到了这个分类「必须做到」的几条 */
        var musts = (m.category.guide && m.category.guide.must) || [];
        var covered = musts.filter(function (mu) { return shareCount(mu, m.system + m.persona) >= 3; }).length;
        if (musts.length) score += Math.round(covered / musts.length * 30);
        return score;
      }
    }
  ];

  /** 算出七维得分与加权总分 */
  function scoreDimensions(m) {
    var dims = DIMENSIONS.map(function (d) {
      return {
        key: d.key,
        label: d.label,
        weight: d.weight,
        hint: d.hint,
        score: clampScore(d.run(m))
      };
    });
    var total = 0, used = 0;
    dims.forEach(function (d) { total += d.score * d.weight; used += d.weight; });
    var overall = used ? Math.round(total / used) : 0;
    /* 硬伤必须压分：不能让七个维度的平均把"根本没写完"的卡算成及格 */
    var errors = m.issues.filter(function (i) { return i.level === 'error'; }).length;
    if (errors) overall = Math.min(overall, 100 - errors * 14);
    if (overall < 0) overall = 0;
    return { dimensions: dims, overall: overall };
  }

  /**
   * 给一张角色卡打分。
   * @param {object} card  角色对象（store.makeCharacter 的形状）
   * @param {object} opts  { existingNames: [] 用于查重 }
   * @returns {{score:number, grade:string, issues:Array, passed:Array, stats:object}}
   */
  function lint(card, opts) {
    var c = card || {};
    var o = opts || {};
    var issues = [];
    var passed = [];

    var name = str(c.name).trim();
    var persona = str(c.persona);
    var greeting = str(c.greeting);
    var examples = str(c.examples);
    var system = str(c.systemPrompt);
    var scenario = str(c.scenario);
    var tagline = str(c.tagline).trim();
    var tags = Array.isArray(c.tags) ? c.tags : [];
    var kind = c.kind === 'story' ? 'story' : 'character';
    var temp = Number(c.temperature);
    var avatar = str(c.avatar);

    var stats = {
      personaLen: persona.replace(/\s/g, '').length,
      greetingLen: greeting.replace(/\s/g, '').length,
      examplesLen: examples.replace(/\s/g, '').length,
      systemLen: system.replace(/\s/g, '').length,
      scenarioLen: scenario.replace(/\s/g, '').length,
      nameLen: name.length,
      tagCount: tags.length
    };

    /* ---- 硬闸门：与发布校验脚本同一套标准 ---- */

    if (!name) {
      issues.push(issue('error', 'name', '还没有名字', '起一个 2~4 字的称呼，避免用「小美」「某某」这种泛称'));
    } else if (name.length > GATE.nameMax) {
      issues.push(issue('warn', 'name', '名字 ' + name.length + ' 个字，超过内置标准的 ' + GATE.nameMax + ' 字',
        '长名字在角色卡上会被截断，建议压到 ' + GATE.nameMax + ' 字内'));
    } else {
      passed.push('名字规范');
    }

    if (stats.personaLen < GATE.personaMin) {
      issues.push(issue('error', 'persona', '人设只有 ' + stats.personaLen + ' 字（至少 ' + GATE.personaMin + '）',
        '补上「身份 + 说话方式 + 一个缺点 + 在意的事 + 你和 TA 的起点」'));
    } else if (stats.personaLen < GATE.personaGood) {
      issues.push(issue('warn', 'persona', '人设 ' + stats.personaLen + ' 字，偏薄（建议 ' + GATE.personaGood + ' 字以上）',
        '再加一处具体细节：一件随身物件、一句口头禅、一个只有 TA 会做的小动作'));
    } else {
      passed.push('人设丰满（' + stats.personaLen + ' 字）');
    }

    if (stats.greetingLen < GATE.greetingMin) {
      issues.push(issue('error', 'greeting', '开场白太短（至少 ' + GATE.greetingMin + ' 字）',
        '写一个动作 + 一句对你说的话，把场景交代清楚'));
    } else if (stats.greetingLen < GATE.greetingGood) {
      issues.push(issue('warn', 'greeting', '开场白 ' + stats.greetingLen + ' 字，可以再给点信息',
        '加一点环境或身体动作，让用户知道自己在哪、和你是谁'));
    } else {
      passed.push('开场白到位');
    }

    if (stats.examplesLen < GATE.examplesMin) {
      issues.push(issue('error', 'examples', '示例对话太短（至少 ' + GATE.examplesMin + ' 字）',
        '写两轮「用户：…／角色：…」，这是模型学语气最有效的部分'));
    } else if (stats.examplesLen < GATE.examplesGood) {
      issues.push(issue('warn', 'examples', '示例对话 ' + stats.examplesLen + ' 字，偏少',
        '补一轮「角色拒绝或转移话题」的对话，能明显压住模型一味讨好的倾向'));
    } else {
      passed.push('示例对话够用');
    }

    if (stats.systemLen < GATE.systemMin) {
      issues.push(issue('error', 'systemPrompt', '系统提示词太短（至少 ' + GATE.systemMin + ' 字）',
        '点「AI 起草」或「按分类生成」一键补齐'));
    } else if (stats.systemLen < GATE.systemGood) {
      issues.push(issue('warn', 'systemPrompt', '系统提示词 ' + stats.systemLen + ' 字，比内置卡薄（内置卡中位数约 210 字）',
        '补上「要做到」与「禁止事项」两条：前者定语气，后者挡 AI 腔'));
    }
    if (system.indexOf('/no_think') < 0) {
      issues.push(issue('error', 'systemPrompt', '系统提示词缺 /no_think',
        '本项目的 Qwen3 系模型不加 /no_think 会先吐一大段思考，必须加上'));
    } else if (stats.systemLen >= GATE.systemMin) {
      passed.push('系统提示词合规（含 /no_think）');
    }

    if (!tags.length) {
      issues.push(issue('error', 'tags', '没有分类标签', '选一个分类：没标签的卡会落进「未分类」，筛选时找不到'));
    } else if (bundle) {
      var unknown = tags.filter(function (t) { return categoryTags().indexOf(t) < 0; });
      if (unknown.length) {
        issues.push(issue('warn', 'tags', '标签不在内置分类里：' + unknown.join('、'),
          '内置分类才能进分类筛选；自定义标签仍会保留，但会归到「未分类」旁边'));
      } else {
        passed.push('分类标签合法');
      }
    }

    if (kind === 'story' && stats.scenarioLen < GATE.scenarioMin) {
      issues.push(issue('error', 'scenario', '剧情卡必须有「情境」（至少 ' + GATE.scenarioMin + ' 字）',
        '写清楚：现在是什么局面、要解决什么事、为什么不能失败'));
    } else if (kind === 'story') {
      passed.push('剧情卡有情境');
    }

    if (!nonEmpty(tagline)) {
      issues.push(issue('warn', 'tagline', '缺一句话简介', '写出「最容易被记住的那个点」，会显示在角色卡上'));
    } else {
      passed.push('有一句话简介');
    }

    if (avatar.length > GATE.avatarMax) {
      issues.push(issue('error', 'avatar', '头像 emoji 太长', '填 1 个 emoji 就好'));
    }

    if (!(temp >= 0 && temp <= 2)) {
      issues.push(issue('error', 'temperature', '温度必须在 0~2 之间', '剧情/喜剧可以高一点，推理/历史低一点'));
    }

    /* ---- 写作质量：这些才是「像不像活人」的分水岭 ---- */

    var cat = bundle ? category(tags[0]) : null;
    if (cat && cat.defaultKind === 'story' && kind !== 'story') {
      issues.push(issue('warn', 'kind', '「' + cat.tag + '」通常写成剧情卡效果更好',
        '这个分类需要「一个可推进的局面」；切成剧情卡并补上情境，模型才有事可做'));
    }
    if (cat && cat.defaultKind === 'character' && kind === 'story' && stats.scenarioLen < GATE.scenarioMin) {
      issues.push(issue('warn', 'kind', '「' + cat.tag + '」写剧情卡的话，情境就是命',
        '这个分类原本靠人物关系驱动，改成剧情卡后必须把局面写足'));
    }

    /* 反 AI 腔 */
    var speakHits = [];
    AI_SPEAK.forEach(function (r) {
      var scope = r.re;
      if (scope.test(persona) || scope.test(greeting) || scope.test(examples) || scope.test(system)) {
        speakHits.push(r.why);
      }
    });
    if (speakHits.length) {
      issues.push(issue('warn', 'persona', '有 AI 腔/说教腔：' + speakHits.join('、'),
        '删掉这些句子。模型会照抄卡里的语气，卡里一旦有客服味，聊天就出戏'));
    } else {
      passed.push('没有 AI 腔');
    }

    /* 空洞形容词堆砌 */
    var adj = countMatches(persona, EMPTY_ADJ);
    if (adj >= ADJ_WARN_AT) {
      issues.push(issue('warn', 'persona', '形容词堆了 ' + adj + ' 个（温柔、善良、坚强…）',
        '每个形容词换成一个能看见的行为：「温柔」→「会先把水晾到不烫再递给你」'));
    }

    /* 具体性：有没有数字或引号里的具体东西 */
    if (stats.personaLen >= GATE.personaMin && !/\d/.test(persona) && !/[「『"“]/.test(persona)) {
      issues.push(issue('warn', 'persona', '人设里没有一处具体细节',
        '加一个数字（年龄、工龄、几年）或一句原话（口头禅），人物立刻立体'));
    }

    /* 开场白可回应性 */
    if (stats.greetingLen >= GATE.greetingMin) {
      var hasAction = /[（(]/.test(greeting);
      var hasHook = /[？?]/.test(greeting);
      if (!hasAction && !hasHook) {
        issues.push(issue('warn', 'greeting', '开场白只有陈述，没有可以接的话头',
          '加个动作（圆括号）或一个问句，用户才知道怎么开口'));
      } else {
        passed.push('开场白有可接的话头');
      }
    }

    /* 示例对话格式 */
    if (stats.examplesLen >= GATE.examplesMin) {
      var hasUserLine = /用户[:：]/.test(examples);
      var hasCharLine = /角色[:：]/.test(examples) || (nonEmpty(name) && examples.indexOf(name + '：') >= 0);
      if (!hasUserLine || !hasCharLine) {
        issues.push(issue('warn', 'examples', '示例对话的格式不标准',
          '用「用户：…」和「角色名：…」两个前缀，模型才能分清谁在说话'));
      } else {
        passed.push('示例对话格式标准');
      }
    }

    /* 重名 / 与已有卡过于相似 */
    var existing = Array.isArray(o.existingNames) ? o.existingNames : [];
    var duplicateName = nonEmpty(name) && existing.indexOf(name) >= 0;
    if (duplicateName) {
      issues.push(issue('warn', 'name', '已经有一个叫「' + name + '」的角色了',
        '同名会让角色列表和备份恢复都变得难认，换个名字或加个姓氏'));
    }
    var mostSimilar = 0;
    var others = Array.isArray(o.existingCards) ? o.existingCards : [];
    if (nonEmpty(persona)) {
      for (var k = 0; k < others.length && k < 300; k++) {
        var oc = others[k] || {};
        if (str(oc.id) && str(oc.id) === str(c.id)) continue;
        var sim = jaccard(persona, oc.persona);
        if (sim > mostSimilar) mostSimilar = sim;
      }
      if (mostSimilar >= 0.5) {
        issues.push(issue('warn', 'persona', '和已有的某个角色相似度 ' + Math.round(mostSimilar * 100) + '%',
          '两张卡太像，模型会串味。给这张卡换一个只属于 TA 的具体细节或口癖'));
      }
    }

    /* ---- 计分：七维加权（维度见 DIMENSIONS） ---- */
    var metrics = {
      name: name, persona: persona, greeting: greeting, examples: examples,
      system: system, scenario: scenario, tagline: tagline,
      stats: stats, issues: issues,
      category: cat,
      tagInTaxonomy: !!(cat && tags.length),
      kindMatchesCategory: !!(cat && kind === cat.defaultKind),
      examplesOk: /用户[:：]/.test(examples) &&
        (/角色[:：]/.test(examples) || (nonEmpty(name) && examples.indexOf(name + '：') >= 0)),
      greetingLen: stats.greetingLen,
      duplicateName: duplicateName,
      mostSimilar: mostSimilar
    };
    var scored = scoreDimensions(metrics);
    var score = scored.overall;
    var grade = score >= 90 ? '可以直接发' : (score >= 75 ? '不错，再补两处' : (score >= 55 ? '能用，但会露馅' : '还得改'));

    return {
      score: score,
      grade: grade,
      dimensions: scored.dimensions,
      issues: issues,
      passed: passed,
      stats: stats,
      errors: issues.filter(function (i) { return i.level === 'error'; }).length,
      warns: issues.filter(function (i) { return i.level === 'warn'; }).length
    };
  }

  /* ===========================================================================
   * 4. AI 辅助（用已配置的模型：本地引擎或云端 OpenAI 兼容服务）
   * ======================================================================== */

  /** 每种任务的说明：给模型看的要求 + 期望的输出形态 */
  var TASKS = {
    all: {
      label: '整卡起草',
      field: '',
      json: true,
      ask: '请输出一个 JSON 对象，字段为 name / tagline / persona / greeting / examples / scenario / systemPrompt。' +
        'persona 要 150~300 字，包含身份、说话方式、一个缺点、最在意的事、和用户的起点。' +
        'greeting 要 60~150 字，写一个动作加一句话，不要自我介绍。' +
        'examples 写两轮对话，用「用户：」和「角色名：」开头。' +
        '只输出 JSON，不要解释，不要代码块标记。'
    },
    persona: { label: '扩写人设', field: 'persona', ask: '只输出人设正文（150~300 字），不要标题、不要解释。' },
    tagline: { label: '写一句话简介', field: 'tagline', ask: '只输出一句话（不超过 30 字），不要引号、不要解释。' },
    greeting: { label: '写开场白', field: 'greeting', ask: '只输出开场白正文（60~150 字），包含一个动作和一句对用户说的话，不要自我介绍。' },
    examples: { label: '写示例对话', field: 'examples', ask: '只输出两轮对话，每轮以「用户：」和「角色名：」开头，不要解释。' },
    scenario: { label: '写剧情情境', field: 'scenario', ask: '只输出情境正文（80~200 字），写清局面、要解决的事、失败代价，不要解释。' },
    system: { label: '生成系统提示词', field: 'systemPrompt', json: false, ask: '只输出系统提示词正文，必须包含行为边界与禁止事项，结尾单独一行写 /no_think。' },
    polish: { label: '润色现有文本', field: '', ask: '保持原意与信息量，去掉 AI 腔和形容词堆砌，让句子更像真人在说话；只输出改写后的正文。' }
  };

  function guideBlock(cat) {
    if (!cat || !cat.guide) return '';
    var g = cat.guide;
    var out = [];
    out.push('【分类】' + cat.tag + '：' + cat.blurb);
    if (cat.coreTension) out.push('【这个分类的核心张力】' + cat.coreTension);
    if (g.must && g.must.length) out.push('【必须做到】' + g.must.join('；'));
    if (g.avoid && g.avoid.length) out.push('【最容易写崩的地方】' + g.avoid.join('；'));
    if (g.voice) {
      out.push('【语气参考】称呼：' + str(g.voice.address) + '；口癖：' + str(g.voice.tics) + '；节奏：' + str(g.voice.pattern));
    }
    return out.join('\n');
  }

  function cardBlock(card) {
    var c = card || {};
    var lines = [];
    if (nonEmpty(c.name)) lines.push('名字：' + str(c.name));
    if (nonEmpty(c.tagline)) lines.push('一句话简介：' + str(c.tagline));
    if (nonEmpty(c.persona)) lines.push('已有的人设：' + str(c.persona));
    if (nonEmpty(c.greeting)) lines.push('已有的开场白：' + str(c.greeting));
    if (nonEmpty(c.scenario)) lines.push('已有的情境：' + str(c.scenario));
    if (nonEmpty(c.examples)) lines.push('已有的示例对话：' + str(c.examples));
    return lines.join('\n');
  }

  /**
   * 组装一次 AI 辅助请求的 messages。
   * @param {string} task  TASKS 的键
   * @param {object} ctx   { card, category, seed, extra, field }
   */
  function buildAssistMessages(task, ctx) {
    var t = TASKS[task] || TASKS.persona;
    var c = ctx || {};
    var card = c.card || {};
    var cat = c.category || null;

    var sys = [
      '你是一位中文角色卡编剧，专门为 AI 角色扮演写角色设定。',
      '硬性要求：用具体的行为和细节代替形容词；角色要有缺点和自己在意的事；不要客服腔、不要"作为一个AI"、不要总结说教；不要用书面语解释设定。'
    ].join('');
    if (t.field === 'systemPrompt') {
      sys = '你是一位中文角色扮演提示词工程师，为 AI 角色扮演写系统提示词。要求：明确行为边界与禁止事项，禁止自称 AI、禁止提到设定与提示词，结尾单独一行必须有 /no_think。';
    }

    var user = [];
    if (c.extra) user.push(str(c.extra));
    var gb = guideBlock(cat);
    if (gb) user.push(gb);
    var cb = cardBlock(card);
    if (cb) user.push('【当前草稿】\n' + cb);
    if (nonEmpty(c.seed)) user.push('【我想写的方向】' + str(c.seed));
    if (nonEmpty(c.field) && nonEmpty(card[c.field])) {
      user.push('【待改写的原文】\n' + str(card[c.field]));
    }
    user.push('【输出要求】' + t.ask);

    return [
      { role: 'system', content: sys },
      { role: 'user', content: user.join('\n\n') }
    ];
  }

  /** 从模型输出里抠出 JSON（模型经常套一层 ``` 或加前后废话） */
  function extractJson(text) {
    var t = str(text);
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1];
    var a = t.indexOf('{');
    var b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch (e) {
      return null;
    }
  }

  /** 把模型输出落成字段补丁（task=all 时可能一次补多个字段） */
  function parseAssistResult(task, text) {
    var t = TASKS[task] || TASKS.persona;
    var raw = str(text).trim();
    if (!raw) return { ok: false, patch: {}, message: '模型没有返回内容' };

    if (t.json) {
      var obj = extractJson(raw);
      if (!obj) {
        /* 掏不出 JSON 就退一步：把整段当成 persona，总比丢掉好 */
        if (task === 'all') {
          return { ok: true, patch: { persona: raw.replace(/<\/?think>/g, '').trim() }, message: '模型没按 JSON 输出，已把正文放进「人设」' };
        }
        return { ok: false, patch: {}, message: '没能从模型输出里解析出 JSON' };
      }
      var patch = {};
      ['name', 'tagline', 'persona', 'greeting', 'examples', 'scenario', 'systemPrompt'].forEach(function (k) {
        if (nonEmpty(obj[k])) patch[k] = str(obj[k]).trim();
      });
      return { ok: Object.keys(patch).length > 0, patch: patch, message: '' };
    }

    var clean = raw.replace(/<\/?think>/g, '').replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    if (t.field === 'systemPrompt' && clean.indexOf('/no_think') < 0) clean += '\n/no_think';
    var p = {};
    p[t.field || 'persona'] = clean;
    return { ok: nonEmpty(clean), patch: p, message: nonEmpty(clean) ? '' : '模型返回了空内容' };
  }

  /* ===========================================================================
   * 5. 导出为 chara_card_v2（与项目标准一致，便于社区互通）
   * ======================================================================== */

  function toCardV2(card, meta) {
    var c = card || {};
    var m = meta || {};
    return {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: str(c.name),
        description: str(c.persona),
        personality: str(c.tagline),
        scenario: str(c.scenario),
        first_mes: str(c.greeting),
        mes_example: str(c.examples),
        creator_notes: str(m.notes || '由「风月·本地版」创作者工具导出'),
        system_prompt: str(c.systemPrompt),
        post_history_instructions: '',
        alternate_greetings: [],
        character_book: null,
        tags: Array.isArray(c.tags) ? c.tags.slice(0, GATE.tagsMax) : [],
        creator: str(m.creator || '风月·本地版'),
        character_version: '1.0',
        extensions: {
          fy: {
            avatar: str(c.avatar, '🙂'),
            tagline: str(c.tagline),
            temperature: typeof c.temperature === 'number' ? c.temperature : 0.85,
            kind: c.kind === 'story' ? 'story' : 'character',
            plot: !!c.plot,
            creatorTool: TEMPLATE_VERSION
          }
        }
      }
    };
  }

  var api = {
    VERSION: TEMPLATE_VERSION,
    GATE: GATE,
    TASKS: TASKS,
    loadBundle: loadBundle,
    bundle: function () { return bundle; },
    category: category,
    categoryTags: categoryTags,
    draftFromSkeleton: draftFromSkeleton,
    composePersona: composePersona,
    composeSystemPrompt: composeSystemPrompt,
    composeScenario: composeScenario,
    lint: lint,
    buildAssistMessages: buildAssistMessages,
    parseAssistResult: parseAssistResult,
    extractJson: extractJson,
    toCardV2: toCardV2
  };

  global.FYCreator = api;
})(typeof window !== 'undefined' ? window : this);
