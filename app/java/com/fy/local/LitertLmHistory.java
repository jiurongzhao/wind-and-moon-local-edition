package com.fy.local;

import java.util.ArrayList;
import java.util.List;

/**
 * LiteRT-LM 后端的纯逻辑层：历史签名、采样串解析、流式增量提取。
 *
 * <p>刻意不 import 任何 Android / LiteRT-LM 的类 —— 这样它能在 Termux 的 JVM 里直接跑
 * （tests/LitertLmHistoryJvmTest.java），而真正的 Engine/Conversation 得等真机。
 * 这三段逻辑恰好都是"错了很难从真机表现看出来"的那类：
 * 签名算错 = 每轮偷偷重建、KV 白丢；采样解析错 = 参数静默失效；
 * 流式 diff 错 = 回复缺字或多字。
 */
public final class LitertLmHistory {

    private LitertLmHistory() { }

    /** 签名分隔符：不可见控制符，正常正文不会出现。public 是给 JVM 测试断言用的。 */
    public static final String SEP = String.valueOf((char) 1);

    /**
     * 用户可见历史的签名：跳过 assistant。
     *
     * <p>assistant 回复是模型生成的，App 还会二次加工（去 think 段、截断、加动作标记），
     * 拿它做等值比较会永远对不上，于是每轮都重建 Conversation、KV 全丢。
     * 只认 system + user：历史一变（改设定 / 删改消息 / 换角色）签名就变，重建；否则续 KV。
     */
    public static List<String> userKeys(List<String[]> msgs) {
        List<String> out = new ArrayList<>(msgs == null ? 0 : msgs.size());
        if (msgs == null) return out;
        for (String[] m : msgs) {
            if (m == null || m.length < 2) continue;
            if ("assistant".equals(m[0])) continue;
            out.add(key(m[0], m[1]));
        }
        return out;
    }

    /** 单条消息的签名。 */
    public static String key(String role, String text) {
        return (role == null ? "user" : role) + SEP + (text == null ? "" : text);
    }

    /**
     * 把流式回调压成增量。
     *
     * <p>LiteRT-LM 不同后端/版本的回调语义不一致：有的 {@code onMessage} 给"到目前为止的整段"，
     * 有的只给"这次新出的几个字"。两种都见过，所以这里做前缀判断：是累计就取差集，
     * 不是就当增量往后接。
     */
    public static final class Streamer {
        private String emitted = "";

        public String feed(String piece) {
            if (piece == null || piece.isEmpty()) return null;
            String delta;
            if (piece.startsWith(emitted)) {
                delta = piece.substring(emitted.length());   // 累计式
                emitted = piece;
            } else {
                delta = piece;                                // 增量式
                emitted = emitted + piece;
            }
            return delta.isEmpty() ? null : delta;
        }

        /** 已经吐出去的全量（测试 / 诊断用）。 */
        public String emitted() {
            return emitted;
        }
    }

    /** 从 "k=v;k=v" 采样串里抠出来的重复惩罚项（null = 没设）。 */
    public static final class Penalties {
        public Float repetition;
        public Float presence;
        public Float frequency;
        public Integer window;

        public boolean any() {
            return repetition != null || presence != null || frequency != null;
        }
    }

    public static Penalties parsePenalties(String sampler) {
        Penalties p = new Penalties();
        for (String kv : split(sampler)) {
            int eq = kv.indexOf('=');
            if (eq <= 0) continue;
            String k = kv.substring(0, eq).trim();
            String v = kv.substring(eq + 1).trim();
            Float f = parseFloat(v);
            if (f == null) continue;
            if ("pen_rep".equals(k)) p.repetition = f;
            else if ("pen_pres".equals(k)) p.presence = f;
            else if ("pen_freq".equals(k)) p.frequency = f;
            else if ("pen_n".equals(k)) p.window = (int) (float) f;
        }
        return p;
    }

    /**
     * DRY 在 LiteRT-LM 里没有对应项，用 no-repeat-ngram 近似压逐字复读：
     * 拿 dryAllowedLength 当 ngram 大小。DRY 没开就不动（返回 0）；
     * 开了但值越界就取 4。
     */
    public static int noRepeatNgram(String sampler) {
        boolean seen = false;
        Integer size = null;
        for (String kv : split(sampler)) {
            int eq = kv.indexOf('=');
            if (eq <= 0) continue;
            if (!"dry_allowed".equals(kv.substring(0, eq).trim())) continue;
            seen = true;
            Float f = parseFloat(kv.substring(eq + 1).trim());
            if (f != null) size = (int) (float) f;
        }
        if (!seen) return 0;
        if (size == null || size < 2 || size > 12) return 4;
        return size;
    }

    /* ---------- 模型能力 + tune → ConversationConfig 决策 ----------
     *
     * 这段纯逻辑从 LitertLmBackend 里抽出来，就是为了能在 JVM 里测：
     * 决策错了不会报错，只会"思考关不掉"或"投机解码没开"，很难从真机表现看出来。 */

    /** {@link #conversationPlan} 的结果。 */
    public static final class ConvPlan {
        /** 传 ThinkingConfig(false)：只在 bundle 声明了 thought channel（capThinking）时才有意义。 */
        public boolean useThinkingConfig;
        /** 往 extraContext 塞 enable_thinking=false：bundle 没声明 channel 时这条才管用。 */
        public boolean extraEnableThinking;
        /** enableSpeculativeDecoding 的三态：null=不指定（继承引擎默认，Gemma 上默认是开！）；
            TRUE/FALSE=显式开/关。auto 在 CPU 上必须显式 FALSE，否则会继承成"开"。 */
        public Boolean speculative;
        /** 是否要走 13 参构造（三条里任何一条命中）。false = 沿用老的 4 参构造，行为不变。 */
        public boolean extended;
    }

    /**
     * 综合"模型自己会什么"（capThinking/capSpec，来自 ModelInfo）+ 用户 tune + 模型名，
     * 决定 ConversationConfig 怎么建。
     *
     * <p>thinking=auto（默认）：能关就关（Qwen3 不关会白烧大量思考 token）；
     * thinking=on/off 可显式覆盖。spec=auto：模型带 drafter 才开；spec=1 在不支持时也**不会**
     * 强开（LiteRT-LM 会直接抛异常，不能拿它赌）。
     */
    public static ConvPlan conversationPlan(String modelName, boolean capThinking, boolean capSpec,
                                            boolean gpu, String tune) {
        ConvPlan p = new ConvPlan();
        if ("".equals(tune)) tune = null;
        boolean qwen3 = modelName != null && modelName.toLowerCase().contains("qwen3");
        String thinkWant = param(tune, "thinking", "auto").toLowerCase();
        boolean noThink;
        if (isOff(thinkWant)) noThink = true;
        else if (isOn(thinkWant)) noThink = false;
        else noThink = capThinking || qwen3;
        p.extraEnableThinking = noThink;
        p.useThinkingConfig = noThink && capThinking;

        /* MTP 在这台 CPU 上是净亏（Gemma 4 E2B 实测：开 24.5 / 关 39.8 tok/s），
           所以 auto 只在 GPU 上自动开；CPU 上要开得用户显式 spec=1。官方"3×"也是 GPU 数字。 */
        String specWant = param(tune, "spec", "auto").toLowerCase();
        if (isOn(specWant)) p.speculative = capSpec ? Boolean.TRUE : null;
        else if (isOff(specWant)) p.speculative = Boolean.FALSE;
        else p.speculative = capSpec ? (gpu ? Boolean.TRUE : Boolean.FALSE) : null;

        p.extended = p.useThinkingConfig || p.extraEnableThinking || p.speculative != null;
        return p;
    }

    private static boolean isOn(String v) {
        return "1".equals(v) || "true".equals(v) || "on".equals(v) || "yes".equals(v);
    }

    private static boolean isOff(String v) {
        return "0".equals(v) || "false".equals(v) || "off".equals(v) || "no".equals(v);
    }

    /* ---------- 通用 "k=v;k=v" 参数（后端 tune 串） ---------- */

    /** 取一个字符串参数（值 trim 过）；没有该键返回 def。 */
    public static String param(String cfg, String key, String def) {
        for (String kv : split(cfg)) {
            int eq = kv.indexOf('=');
            if (eq <= 0) continue;
            if (key.equals(kv.substring(0, eq).trim())) return kv.substring(eq + 1).trim();
        }
        return def;
    }

    /** 取一个整型参数；没有 / 解析不了返回 def。 */
    public static int paramInt(String cfg, String key, int def) {
        String v = param(cfg, key, null);
        if (v == null) return def;
        try { return Integer.parseInt(v); } catch (NumberFormatException e) { return def; }
    }

    /** 三态布尔：1/true/on/yes、0/false/off/no；没有该键返回 def。 */
    public static boolean paramBool(String cfg, String key, boolean def) {
        String v = param(cfg, key, null);
        if (v == null) return def;
        v = v.toLowerCase();
        if ("1".equals(v) || "true".equals(v) || "on".equals(v) || "yes".equals(v)) return true;
        if ("0".equals(v) || "false".equals(v) || "off".equals(v) || "no".equals(v)) return false;
        return def;
    }

    static String[] split(String s) {
        return (s == null || s.isEmpty()) ? new String[0] : s.split(";");
    }

    static Float parseFloat(String v) {
        try {
            return Float.parseFloat(v);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
