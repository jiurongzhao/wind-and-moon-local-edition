/**
 * avatar.js —— 程序化生成的角色图标（没有专属立绘时的兜底，张张不同）。
 *
 * 一张图标由这些层叠出来，参数全部由「卡名 + 分类」的哈希决定：
 *   1. 背景   分类配色的渐变，角度 + 明暗做逐卡抖动
 *   2. 纹样   10 种装饰图案随机取一种（叶子 / 星芒 / 圆点 / 波纹 / 圆环 / 十字 / 花 / 气泡 / 短划 / 三角）
 *   3. 叶饰   2~4 处角落小装饰
 *   4. 主体   5x5 左右镜像的独有图案（方/圆/菱，主副两色）
 *   5. 边框   无 / 细圈 / 虚线圈 / 四角括号，随机
 *   6. 角标   名字首字（用户自选 emoji 则原样保留）
 *
 * 同一张卡任何时候都画成同一张；不联网、不落文件、不写库。
 * 对外：FYAvatar.svg(card, size) / fill(node, card, size) / specOf / themeOf / hash32 / clearCache
 */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------- 哈希 / 随机 */

  function hash32(str) {
    var h = 0x811c9dc5 >>> 0, i, n = str.length;
    for (i = 0; i < n; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function rngFrom(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var f = function (v) {
      v = amt >= 0 ? v + (255 - v) * amt : v * (1 + amt);
      return Math.max(0, Math.min(255, Math.round(v)));
    };
    return '#' + ((1 << 24) + (f(r) << 16) + (f(g) << 8) + f(b)).toString(16).slice(1);
  }

  /* 色相旋转：让同一分类的卡也能有不同颜色，同时保持整块配色和谐（底色和点缀一起转） */
  function hexToHsl(hex) {
    var n = parseInt(hex.slice(1), 16);
    var r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, s = 0, l = (mx + mn) / 2;
    if (mx !== mn) {
      var d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [h, s, l];
  }
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    var f = function (v) { return Math.round((v + m) * 255).toString(16).padStart(2, '0'); };
    return '#' + f(r) + f(g) + f(b);
  }
  function rotateHue(hex, deg) {
    if (!deg) return hex;
    var hsl = hexToHsl(hex);
    return hslToHex(hsl[0] + deg, hsl[1], hsl[2]);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fx(v) { return (Math.round(v * 10) / 10).toString(); }

  /* ---------------------------------------------------------------- 题材表 */

  var THEMES = {
    '日常治愈': { bg: ['#1f3a2e', '#3d6b52'], ac: '#a8e6a3' },
    '恋爱':     { bg: ['#3a1b2c', '#6e2b4c'], ac: '#ff9ec4' },
    '悬疑推理': { bg: ['#151d28', '#2c3d4f'], ac: '#e3b341' },
    '古风仙侠': { bg: ['#16262e', '#33505c'], ac: '#9fe8d8' },
    '科幻未来': { bg: ['#0d2236', '#14527a'], ac: '#5fd8ff' },
    '奇幻冒险': { bg: ['#251c44', '#473173'], ac: '#c9a6ff' },
    '校园':     { bg: ['#22301c', '#42622f'], ac: '#f0d878' },
    '职场':     { bg: ['#1b2434', '#35496b'], ac: '#84b6ff' },
    '历史':     { bg: ['#2e2418', '#57422b'], ac: '#e6c88a' },
    '恐怖惊悚': { bg: ['#150f14', '#2f1c26'], ac: '#e36a6a' },
    '喜剧沙雕': { bg: ['#33280f', '#634d1c'], ac: '#ffe066' },
    '灵异怪谈': { bg: ['#141d2a', '#263a52'], ac: '#9fe6e6' },
    '末世生存': { bg: ['#2a2113', '#4a3a1c'], ac: '#c9d94a' },
    '赛博朋克': { bg: ['#1a0f33', '#3c1a63'], ac: '#ff5fd4' },
    '神话志怪': { bg: ['#152a24', '#2f5344'], ac: '#ffd9a0' },
    '情感树洞': { bg: ['#241c33', '#453460'], ac: '#ffb3c9' }
  };

  var THEME_BY_EMOJI = {
    '🌤': '日常治愈', '💗': '恋爱', '🔍': '悬疑推理', '⚔': '古风仙侠',
    '🛰': '科幻未来', '🐉': '奇幻冒险', '🎒': '校园', '💼': '职场',
    '📜': '历史', '🕯': '恐怖惊悚', '🤣': '喜剧沙雕', '👻': '灵异怪谈',
    '☢': '末世生存', '🌃': '赛博朋克', '🐚': '神话志怪', '🫂': '情感树洞'
  };

  var HUES = [
    ['#1d2a3a', '#2f4a63'], ['#2a1d33', '#4a3160'], ['#1d3329', '#33604a'],
    ['#33291d', '#604a31'], ['#33201d', '#603331'], ['#1d2533', '#314a60']
  ];

  function normEmoji(s) { return String(s || '').replace(/[\uFE0E\uFE0F]/g, '').trim(); }

  function themeOf(card) {
    var c = card || {};
    var tags = Array.isArray(c.tags) ? c.tags : [];
    var i, t, key;
    for (i = 0; i < tags.length; i++) {
      t = String(tags[i] || '').trim();
      if (THEMES[t]) return THEMES[t];
      key = THEME_BY_EMOJI[normEmoji(t)];
      if (key) return THEMES[key];
    }
    key = THEME_BY_EMOJI[normEmoji(c.avatar)];
    if (key) return THEMES[key];
    var h = hash32(c.name || '') % HUES.length;
    return { bg: HUES[h], ac: '#cfd6e6' };
  }

  /* ---------------------------------------------------------------- 装饰图案 */

  /* 每种图案都在 0~100 的画布里撒随机小元素；调用方统一给透明度。 */
  var PATTERNS = {
    /* 叶子 */
    leaf: function (ac, r) {
      var s = '', i, x, y, sc, rot;
      for (i = 0; i < 8; i++) {
        x = r() * 100; y = r() * 100; sc = 4.5 + r() * 6; rot = r() * 360;
        s += '<g transform="translate(' + fx(x) + ' ' + fx(y) + ') rotate(' + Math.round(rot) + ')" opacity="' + (0.45 + r() * 0.55).toFixed(2) + '">' +
             '<ellipse rx="' + fx(sc) + '" ry="' + fx(sc * 0.42) + '" fill="' + ac + '"/>' +
             '<line x1="' + fx(-sc) + '" y1="0" x2="' + fx(sc) + '" y2="0" stroke="#000" stroke-opacity=".2" stroke-width="1"/></g>';
      }
      return s;
    },
    /* 四角星芒 */
    star: function (ac, r) {
      var s = '', i, x, y, sc, rot;
      for (i = 0; i < 7; i++) {
        x = r() * 100; y = r() * 100; sc = 3.5 + r() * 6; rot = r() * 90;
        s += '<path d="M0 ' + fx(-sc) + ' L' + fx(sc * 0.22) + ' ' + fx(-sc * 0.22) + ' L' + fx(sc) + ' 0 L' + fx(sc * 0.22) + ' ' + fx(sc * 0.22) +
             ' L0 ' + fx(sc) + ' L' + fx(-sc * 0.22) + ' ' + fx(sc * 0.22) + ' L' + fx(-sc) + ' 0 L' + fx(-sc * 0.22) + ' ' + fx(-sc * 0.22) +
             ' Z" fill="' + ac + '" opacity="' + (0.45 + r() * 0.5).toFixed(2) + '" transform="translate(' + fx(x) + ' ' + fx(y) + ') rotate(' + Math.round(rot) + ')"/>';
      }
      return s;
    },
    /* 圆点 */
    dot: function (ac, r) {
      var s = '', i, x, y, sc;
      for (i = 0; i < 14; i++) {
        x = r() * 100; y = r() * 100; sc = 1.6 + r() * 5;
        s += '<circle cx="' + fx(x) + '" cy="' + fx(y) + '" r="' + fx(sc) + '" fill="' + ac + '" opacity="' + (0.3 + r() * 0.6).toFixed(2) + '"/>';
      }
      return s;
    },
    /* 波纹 */
    wave: function (ac, r) {
      var s = '', i, y, amp = 4 + r() * 5, w = 0.9 + r() * 1.2;
      for (i = 0; i < 4; i++) {
        y = 16 + i * 22;
        s += '<path d="M -4 ' + fx(y) + ' Q 21 ' + fx(y - amp) + ' 46 ' + fx(y) + ' T 104 ' + fx(y) +
             '" fill="none" stroke="' + ac + '" stroke-width="' + fx(w) + '" opacity="' + (0.35 + r() * 0.4).toFixed(2) + '"/>';
      }
      return s;
    },
    /* 圆环 */
    ring: function (ac, r) {
      var s = '', i, x, y, sc;
      for (i = 0; i < 6; i++) {
        x = r() * 100; y = r() * 100; sc = 6 + r() * 14;
        s += '<circle cx="' + fx(x) + '" cy="' + fx(y) + '" r="' + fx(sc) + '" fill="none" stroke="' + ac +
             '" stroke-width="' + fx(1 + r() * 2) + '" opacity="' + (0.3 + r() * 0.45).toFixed(2) + '"/>';
      }
      return s;
    },
    /* 十字 / 加号 */
    cross: function (ac, r) {
      var s = '', i, x, y, sc, rot;
      for (i = 0; i < 9; i++) {
        x = r() * 100; y = r() * 100; sc = 2.5 + r() * 4; rot = r() * 45;
        s += '<g transform="translate(' + fx(x) + ' ' + fx(y) + ') rotate(' + Math.round(rot) + ')" opacity="' + (0.35 + r() * 0.5).toFixed(2) + '">' +
             '<rect x="' + fx(-sc * 0.28) + '" y="' + fx(-sc) + '" width="' + fx(sc * 0.56) + '" height="' + fx(sc * 2) + '" rx="1" fill="' + ac + '"/>' +
             '<rect x="' + fx(-sc) + '" y="' + fx(-sc * 0.28) + '" width="' + fx(sc * 2) + '" height="' + fx(sc * 0.56) + '" rx="1" fill="' + ac + '"/></g>';
      }
      return s;
    },
    /* 五瓣小花 */
    petal: function (ac, r) {
      var s = '', i, j, x, y, sc, rot;
      for (i = 0; i < 5; i++) {
        x = r() * 100; y = r() * 100; sc = 3.5 + r() * 4; rot = r() * 72;
        s += '<g transform="translate(' + fx(x) + ' ' + fx(y) + ') rotate(' + Math.round(rot) + ')" opacity="' + (0.4 + r() * 0.5).toFixed(2) + '">';
        for (j = 0; j < 5; j++) {
          s += '<ellipse cx="0" cy="' + fx(-sc) + '" rx="' + fx(sc * 0.5) + '" ry="' + fx(sc * 0.95) + '" fill="' + ac + '" transform="rotate(' + (j * 72) + ')"/>';
        }
        s += '<circle r="' + fx(sc * 0.42) + '" fill="#000" fill-opacity=".25"/></g>';
      }
      return s;
    },
    /* 气泡 */
    bubble: function (ac, r) {
      var s = '', i, x, y, sc;
      for (i = 0; i < 9; i++) {
        x = r() * 100; y = r() * 100; sc = 3 + r() * 8;
        s += '<circle cx="' + fx(x) + '" cy="' + fx(y) + '" r="' + fx(sc) + '" fill="' + ac + '" fill-opacity=".22" stroke="' + ac +
             '" stroke-opacity=".6" stroke-width="1"/>' +
             '<circle cx="' + fx(x - sc * 0.3) + '" cy="' + fx(y - sc * 0.3) + '" r="' + fx(sc * 0.18) + '" fill="#fff" fill-opacity=".5"/>';
      }
      return s;
    },
    /* 短划 / 撒糖 */
    dash: function (ac, r) {
      var s = '', i, x, y, len, rot;
      for (i = 0; i < 12; i++) {
        x = r() * 100; y = r() * 100; len = 4 + r() * 9; rot = r() * 180;
        s += '<line x1="' + fx(x) + '" y1="' + fx(y) + '" x2="' + fx(x + len) + '" y2="' + fx(y) + '" stroke="' + ac +
             '" stroke-width="' + fx(1.5 + r() * 2) + '" stroke-linecap="round" opacity="' + (0.35 + r() * 0.5).toFixed(2) +
             '" transform="rotate(' + Math.round(rot) + ' ' + fx(x) + ' ' + fx(y) + ')"/>';
      }
      return s;
    },
    /* 小三角 */
    tri: function (ac, r) {
      var s = '', i, x, y, sc, rot;
      for (i = 0; i < 9; i++) {
        x = r() * 100; y = r() * 100; sc = 3 + r() * 6; rot = r() * 360;
        s += '<path d="M0 ' + fx(-sc) + ' L' + fx(sc) + ' ' + fx(sc) + ' L' + fx(-sc) + ' ' + fx(sc) + ' Z" fill="' + ac +
             '" opacity="' + (0.3 + r() * 0.5).toFixed(2) + '" transform="translate(' + fx(x) + ' ' + fx(y) + ') rotate(' + Math.round(rot) + ')"/>';
      }
      return s;
    }
  };
  var PATTERN_KEYS = Object.keys(PATTERNS);

  /* ---------------------------------------------------------------- 图案描述 */

  function specOf(card) {
    var c = card || {};
    var theme = themeOf(c);
    var name = String(c.name || '');
    var seed = hash32(name + '|' + (Array.isArray(c.tags) ? c.tags.join(',') : '') + '|' + (c.tagline || ''));
    var r = rngFrom(seed);

    var av = normEmoji(c.avatar);
    var isCategoryEmoji = !av || av === '🙂' || Object.prototype.hasOwnProperty.call(THEME_BY_EMOJI, av);
    var badge = isCategoryEmoji ? (name.trim().charAt(0) || '?') : av;

    var cells = [], tints = [];
    for (var i = 0; i < 15; i++) {
      cells.push(r() < 0.42 ? 0 : Math.round(r() * 3));   // 0=空，1~3=形状/密度
      tints.push(r() < 0.5);
    }
    return {
      theme: theme,
      seed: seed,
      monogram: badge,
      angle: Math.round(r() * 360),
      cells: cells,
      tints: tints,
      bgJit: r() * 0.24 - 0.12,
      bgJit2: r() * 0.24 - 0.12,
      /* 逐卡色相偏移：同一分类的图标也五颜六色（-90°~+90°） */
      hueShift: Math.round(r() * 180 - 90),
      pattern: PATTERN_KEYS[Math.floor(r() * PATTERN_KEYS.length)],
      patternOpacity: 0.16 + r() * 0.14,
      patternScale: 0.9 + r() * 0.4,
      patternRot: Math.round(r() * 360),
      frame: Math.floor(r() * 4),
      accent2: shade(theme.ac, r() * 0.5 - 0.25)
    };
  }

  /* ---------------------------------------------------------------- 组装 */

  var seq = 0;
  var cache = {};
  var CACHE_MAX = 3000;

  function svgOf(card, px) {
    var sp = specOf(card);
    var th = sp.theme;
    var hs = sp.hueShift;
    var ac = rotateHue(th.ac, hs);
    var ac2 = rotateHue(sp.accent2, hs);
    var id = 'fyav' + (seq++).toString(36);
    var bg1 = rotateHue(shade(th.bg[0], sp.bgJit), hs), bg2 = rotateHue(shade(th.bg[1], sp.bgJit2), hs);

    /* 装饰纹样：低透明度铺底，逐卡不同 */
    var pattern = '<g opacity="' + sp.patternOpacity.toFixed(3) + '" transform="rotate(' + sp.patternRot + ' 50 50) ' +
                  'translate(50 50) scale(' + sp.patternScale.toFixed(3) + ') translate(-50 -50)">' +
                  (PATTERNS[sp.pattern] || PATTERNS.dot)(ac, rngFrom(sp.seed ^ 0x9e3779b9)) + '</g>';

    /* 主体：5x5 左右镜像，形状（方/圆/菱）随格子值变化 */
    var grid = '', cs = 14, ox = 50 - 2.5 * cs, oy = 50 - 2.5 * cs, row, col, k, v, cols, x, y, w, rr, cx, cy, fill, op;
    for (row = 0; row < 5; row++) {
      for (col = 0; col < 3; col++) {
        v = sp.cells[row * 3 + col];
        if (!v) continue;
        cols = col === 2 ? [2] : [col, 4 - col];
        for (k = 0; k < cols.length; k++) {
          x = ox + cols[k] * cs; y = oy + row * cs;
          w = cs - 3; rr = w / 2; cx = x + rr; cy = y + rr;
          fill = sp.tints[row * 3 + col] ? ac2 : ac;
          op = (0.6 + v * 0.12).toFixed(3);
          if (v === 2) {
            grid += '<circle cx="' + fx(cx) + '" cy="' + fx(cy) + '" r="' + fx(rr) + '" fill="' + fill + '" opacity="' + op + '"/>';
          } else if (v === 3) {
            grid += '<rect x="' + fx(x) + '" y="' + fx(y) + '" width="' + fx(w) + '" height="' + fx(w) +
                    '" rx="2" fill="' + fill + '" opacity="' + op + '" transform="rotate(45 ' + fx(cx) + ' ' + fx(cy) + ')"/>';
          } else {
            grid += '<rect x="' + fx(x) + '" y="' + fx(y) + '" width="' + fx(w) + '" height="' + fx(w) +
                    '" rx="3" fill="' + fill + '" opacity="' + op + '"/>';
          }
        }
      }
    }

    /* 边框四选一 */
    var frame = '';
    if (sp.frame === 1) {
      frame = '<rect x="3.5" y="3.5" width="93" height="93" rx="20" fill="none" stroke="' + ac2 + '" stroke-opacity=".4" stroke-width="2"/>';
    } else if (sp.frame === 2) {
      frame = '<rect x="4" y="4" width="92" height="92" rx="20" fill="none" stroke="' + ac2 + '" stroke-opacity=".45" stroke-width="2" stroke-dasharray="5 5"/>';
    } else if (sp.frame === 3) {
      var L = 16;
      frame = '<g stroke="' + ac2 + '" stroke-opacity=".5" stroke-width="2.5" fill="none" stroke-linecap="round">' +
              '<path d="M6 ' + (6 + L) + ' L6 6 L' + (6 + L) + ' 6"/>' +
              '<path d="M' + (94 - L) + ' 6 L94 6 L94 ' + (6 + L) + '"/>' +
              '<path d="M94 ' + (94 - L) + ' L94 94 L' + (94 - L) + ' 94"/>' +
              '<path d="M' + (6 + L) + ' 94 L6 94 L6 ' + (94 - L) + '"/></g>';
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px +
      '" viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(' + sp.angle + ' .5 .5)">' +
        '<stop offset="0" stop-color="' + bg1 + '"/><stop offset="1" stop-color="' + bg2 + '"/>' +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#' + id + ')"/>' +
      pattern +
      grid +
      /* 内描边给方块一点厚度 */
      '<rect x="1" y="1" width="98" height="98" rx="22" fill="none" stroke="#000" stroke-opacity=".22" stroke-width="2"/>' +
      frame +
      /* 右下角小字：列表里能一眼对上是谁 */
      '<circle cx="79" cy="79" r="14.5" fill="#0b0d14" fill-opacity=".82"/>' +
      '<text x="79" y="79.5" text-anchor="middle" dominant-baseline="central" ' +
        'font-size="17" font-weight="800" fill="#ffffff" fill-opacity=".95" ' +
        'font-family="system-ui,-apple-system,\'Noto Sans CJK SC\',\'PingFang SC\',sans-serif">' +
        esc(sp.monogram) + '</text>' +
      '</svg>';
  }

  function svg(card, size) {
    var px = Math.max(16, Number(size) || 50);
    var c = card || {};
    var key = (c.name || '') + '\u0001' + (Array.isArray(c.tags) ? c.tags.join(',') : '') +
              '\u0001' + (c.avatar || '') + '\u0001' + px;
    if (cache[key]) return cache[key];
    var out = svgOf(c, px);
    var keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) { for (var i = 0; i < 500; i++) delete cache[keys[i]]; }
    cache[key] = out;
    return out;
  }

  function fill(node, card, size) {
    if (!node) return node;
    node.innerHTML = svg(card, size);
    return node;
  }

  root.FYAvatar = {
    svg: svg,
    fill: fill,
    specOf: specOf,
    themeOf: themeOf,
    hash32: hash32,
    clearCache: function () { cache = {}; },
    /** 这张卡的点缀色（已含逐卡色相偏移）：立绘描边用它，和程序化图标同源 */
    accentOf: function (card) { var sp = specOf(card); return rotateHue(sp.theme.ac, sp.hueShift); },
    _patterns: PATTERNS
  };
})(typeof window !== 'undefined' ? window : globalThis);
