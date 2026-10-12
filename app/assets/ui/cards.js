/**
 * cards.js —— 角色卡导入/导出（SillyTavern chara_card_v2 事实标准）
 *
 * 为什么用它：这是社区通用格式，导出后能在 SillyTavern / 各类前端里直接用；
 * 反过来也能从公开授权的卡源导入，不用手抄人设。
 *
 * 兼容范围：
 *   v2  { spec:'chara_card_v2', spec_version:'2.0', data:{...} }
 *   v3  { spec:'chara_card_v3', data:{...} }        （字段与 v2 基本一致）
 *   v1  { name, description, personality, scenario, first_mes, mes_example, ... }  平铺
 *   打包 [ {...}, {...} ] 或 { characters:[...] }
 *
 * 字段对应关系（风月 → chara_card_v2）：
 *   persona      → data.description      （人设是本 App 的主字段）
 *   tagline      → data.personality      （一句话简介，社区习惯放在这里）
 *   greeting     → data.first_mes        （开场白）
 *   examples     → data.mes_example      （示例对话）
 *   systemPrompt → data.system_prompt
 *   头像 emoji / 温度 → data.extensions.fy（标准里没有这两个概念，塞进扩展字段）
 */
(function (global) {
  'use strict';

  function str(v, d) {
    if (typeof v === 'string') return v;
    if (v == null) return d || '';
    return String(v);
  }

  /* ---------- 角色 → chara_card_v2 ---------- */

  function toCardV2(c) {
    var p = c || {};
    return {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: str(p.name, '无名角色'),
        description: str(p.persona),
        personality: str(p.tagline),
        scenario: '',
        first_mes: str(p.greeting),
        mes_example: str(p.examples),
        creator_notes: '由「风月·本地版」导出',
        system_prompt: str(p.systemPrompt),
        post_history_instructions: '',
        alternate_greetings: [],
        character_book: null,
        tags: [],
        creator: '风月·本地版',
        character_version: '1.0',
        extensions: {
          fy: {
            avatar: str(p.avatar, '🙂'),
            tagline: str(p.tagline),
            temperature: typeof p.temperature === 'number' ? p.temperature : 0.85
          }
        }
      }
    };
  }

  /* ---------- 卡片（v1/v2/v3）→ 角色补丁 ---------- */

  function fromCard(obj) {
    var card = (obj && typeof obj === 'object') ? obj : {};
    var d = (card.data && typeof card.data === 'object') ? card.data : card;   // 有 data 走 v2/v3，否则当 v1
    var ext = (d.extensions && d.extensions.fy) || (card.extensions && card.extensions.fy) || {};

    var name = str(d.name || d.char_name).trim().slice(0, 24) || '导入角色';
    var persona = str(d.description || d.char_persona);
    var personality = str(d.personality || d.char_personality);
    /* 有些 v1 卡只有一个字段：人设和简介揉在一起，那就都给人设 */
    if (!persona && personality) persona = personality;

    var greeting = str(d.first_mes || d.char_greeting);
    if (!greeting && Array.isArray(d.alternate_greetings) && d.alternate_greetings.length) {
      greeting = str(d.alternate_greetings[0]);
    }

    return {
      name: name,
      avatar: str(ext.avatar || d.avatar || '', '🙂').slice(0, 8) || '🙂',
      tagline: str(ext.tagline || personality).slice(0, 60),
      persona: persona,
      greeting: greeting,
      examples: str(d.mes_example || d.example_dialogue),
      /* 空的 systemPrompt 交给 store.makeCharacter 填默认值 */
      systemPrompt: str(d.system_prompt),
      temperature: typeof ext.temperature === 'number' ? ext.temperature : 0.85,
      builtin: false
    };
  }

  /* ---------- 文本 → 角色补丁数组（容错解析） ---------- */

  function parseCards(text) {
    var t = str(text).replace(/^\uFEFF/, '').trim();
    if (!t) throw new Error('文件是空的（没读到内容）');
    var obj;
    try {
      obj = JSON.parse(t);
    } catch (e) {
      throw new Error('不是合法的 JSON：' + (e && e.message ? e.message : e));
    }
    var list;
    if (Array.isArray(obj)) list = obj;
    else if (Array.isArray(obj.characters)) list = obj.characters;
    else if (obj.card && typeof obj.card === 'object') list = [obj.card];
    else list = [obj];

    var out = [];
    for (var i = 0; i < list.length; i++) {
      var c = fromCard(list[i]);
      if (c && c.name && (c.persona || c.greeting || c.examples || c.name)) out.push(c);
    }
    if (!out.length) throw new Error('这张卡里没有可用的角色字段');
    return out;
  }

  /** 文件名：角色名 + .json，去掉文件名里不安全的字符 */
  function fileNameFor(c) {
    var n = str(c && c.name, 'character').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    return (n || 'character') + '.json';
  }

  global.FYCards = {
    toCardV2: toCardV2,
    fromCard: fromCard,
    parseCards: parseCards,
    fileNameFor: fileNameFor
  };
})(typeof window !== 'undefined' ? window : this);
