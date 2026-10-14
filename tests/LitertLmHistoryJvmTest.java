import com.fy.local.LitertLmHistory;

import java.util.ArrayList;
import java.util.List;

/**
 * LitertLmHistoryJvmTest —— LiteRT-LM 后端那层纯逻辑的 JVM 真跑。
 *
 * 为什么单拎出来测：这三段都"错了很难从真机表现看出来"——
 *   签名算错 → 每轮偷偷重建 Conversation，KV 白丢，只是慢；
 *   采样解析错 → 惩罚参数静默失效，只是回复变人机；
 *   流式 diff 错 → 回复少字/多字，肉眼看半天。
 * 它们不碰 Android、不碰 .so，所以能在 Termux 里直接跑。
 *
 * 用法: java -cp <classes> LitertLmHistoryJvmTest
 */
public class LitertLmHistoryJvmTest {

    static int pass = 0, fail = 0;

    static void check(String name, boolean ok) {
        if (ok) { pass++; System.out.println("  ✅ " + name); }
        else { fail++; System.out.println("  ❌ " + name); }
    }

    static void eq(String name, Object want, Object got) {
        boolean ok = want == null ? got == null : want.equals(got);
        check(name + (ok ? "" : "（want=" + want + " got=" + got + "）"), ok);
    }

    static List<String[]> msgs(String... pairs) {
        List<String[]> out = new ArrayList<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) out.add(new String[]{pairs[i], pairs[i + 1]});
        return out;
    }

    public static void main(String[] args) {
        System.out.println("=== LiteRT-LM 纯逻辑（历史签名 / 采样解析 / 流式增量）测试 ===");

        /* ---------- 历史签名 ---------- */
        System.out.println("-- 历史签名 --");
        List<String[]> m = msgs(
                "system", "人设 A",
                "user", "你好",
                "assistant", "嗯。",
                "user", "在吗");
        List<String> sig = LitertLmHistory.userKeys(m);
        eq("跳过 assistant：4 条消息 → 3 个签名", 3, sig.size());
        check("system 在签名里", sig.get(0).startsWith("system" + LitertLmHistory.SEP));
        check("两条 user 都在", sig.get(1).contains("你好") && sig.get(2).contains("在吗"));

        List<String[]> m2 = msgs(
                "system", "人设 A",
                "user", "你好",
                "assistant", "嗯。完全换了一句（App 可能去 think 段/截断）。",
                "user", "在吗");
        eq("assistant 被改写 → 签名不变（这是能续 KV 的关键）", sig, LitertLmHistory.userKeys(m2));

        List<String[]> m3 = msgs(
                "system", "人设 A",
                "user", "你好",
                "assistant", "嗯。",
                "user", "在吗？");
        check("改用户消息 → 签名变", !sig.equals(LitertLmHistory.userKeys(m3)));

        List<String[]> m4 = msgs(
                "system", "人设 B",
                "user", "你好",
                "assistant", "嗯。",
                "user", "在吗");
        check("换 system → 签名变", !sig.equals(LitertLmHistory.userKeys(m4)));

        eq("空历史 → 空签名", 0, LitertLmHistory.userKeys(null).size());
        eq("role 为 null 当 user（不炸）", 0, LitertLmHistory.userKeys(msgs("x", "")).size() - 1);

        /* ---------- 采样解析 ---------- */
        System.out.println("-- 采样解析 --");
        LitertLmHistory.Penalties p = LitertLmHistory.parsePenalties(
                "pen_rep=1.1;pen_freq=0.2;pen_pres=0.3;pen_n=64;dry_allowed=3");
        eq("pen_rep", 1.1f, p.repetition);
        eq("pen_freq", 0.2f, p.frequency);
        eq("pen_pres", 0.3f, p.presence);
        eq("pen_n 取整", 64, p.window);
        check("有惩罚项 → any()", p.any());

        LitertLmHistory.Penalties empty = LitertLmHistory.parsePenalties("");
        check("空串 → 没有惩罚项", !empty.any());
        check("null → 没有惩罚项", !LitertLmHistory.parsePenalties(null).any());
        LitertLmHistory.Penalties junk = LitertLmHistory.parsePenalties("pen_rep=abc;=1;pen_n");
        check("垃圾输入被忽略、不抛", !junk.any());

        eq("DRY 没开 → 不动 no-repeat-ngram", 0, LitertLmHistory.noRepeatNgram("pen_rep=1.1"));
        eq("DRY 开了 → 用 dryAllowedLength", 3, LitertLmHistory.noRepeatNgram("dry_allowed=3"));
        eq("DRY 值越界 → 兜 4", 4, LitertLmHistory.noRepeatNgram("dry_allowed=1"));
        eq("DRY 值缺失 → 兜 4", 4, LitertLmHistory.noRepeatNgram("dry_allowed="));

        /* ---------- 后端 tune 串解析 ---------- */
        System.out.println("-- tune 串解析 --");
        String tune = "thinking=off;spec=1;backend=gpu;act=int8;ubatch=256";
        eq("字符串参数", "gpu", LitertLmHistory.param(tune, "backend", "cpu"));
        eq("字符串缺省", "cpu", LitertLmHistory.param(tune, "missing", "cpu"));
        eq("整型参数", 256, LitertLmHistory.paramInt(tune, "ubatch", 0));
        eq("整型缺省", 7, LitertLmHistory.paramInt(tune, "missing", 7));
        eq("整型垃圾值兜底", 7, LitertLmHistory.paramInt("ubatch=abc", "ubatch", 7));
        check("布尔 off", !LitertLmHistory.paramBool(tune, "thinking", true));
        check("布尔 1", LitertLmHistory.paramBool(tune, "spec", false));
        check("布尔 true 文本", LitertLmHistory.paramBool("a=true", "a", false));
        check("布尔缺省", LitertLmHistory.paramBool(tune, "nope", true));
        eq("值两边空格被 trim", "q8_0", LitertLmHistory.param("type_k = q8_0 ;x", "type_k", null));

        /* ---------- 模型能力 + tune → 配置决策 ---------- */
        System.out.println("-- 配置决策（thinking / spec）--");
        LitertLmHistory.ConvPlan q3 = LitertLmHistory.conversationPlan("Qwen3-0.6B.litertlm", false, false, false, null);
        check("Qwen3 名 → 即使 bundle 没声明 channel 也要塞 enable_thinking", q3.extraEnableThinking);
        check("没声明 channel → 不发 ThinkingConfig", !q3.useThinkingConfig);
        check("没 drafter → 不指定 spec（null）", !Boolean.TRUE.equals(q3.speculative));
        check("要走 13 参构造", q3.extended);

        LitertLmHistory.ConvPlan ct = LitertLmHistory.conversationPlan("Qwen3-0.6B.litertlm", true, false, false, null);
        check("声明了 channel → 发 ThinkingConfig(false)", ct.useThinkingConfig);

        LitertLmHistory.ConvPlan off = LitertLmHistory.conversationPlan("Qwen3-0.6B.litertlm", false, false, false, "thinking=off");
        check("thinking=off 显式关（即使非 Qwen3 名也一样）", off.extraEnableThinking);
        LitertLmHistory.ConvPlan on = LitertLmHistory.conversationPlan("Qwen3-0.6B.litertlm", false, false, false, "thinking=on");
        check("thinking=on 不塞 enable_thinking", !on.extraEnableThinking && !on.useThinkingConfig);

        LitertLmHistory.ConvPlan sp = LitertLmHistory.conversationPlan("gemma-4-E2B.litertlm", false, true, false, "spec=1");
        check("带 drafter + spec=1 → 显式开投机解码", Boolean.TRUE.equals(sp.speculative));
        LitertLmHistory.ConvPlan noSp = LitertLmHistory.conversationPlan("Qwen3-0.6B.litertlm", false, false, false, "spec=1");
        check("没 drafter → spec=1 也不强开（会抛）", !Boolean.TRUE.equals(noSp.speculative));
        LitertLmHistory.ConvPlan spOff = LitertLmHistory.conversationPlan("gemma-4-E2B.litertlm", false, true, false, "spec=off");
        check("spec=off 显式关", Boolean.FALSE.equals(spOff.speculative));
        LitertLmHistory.ConvPlan cpuAuto = LitertLmHistory.conversationPlan("gemma-4-E2B.litertlm", false, true, false, null);
        check("CPU 上 auto 必须显式 FALSE（否则继承成开）", Boolean.FALSE.equals(cpuAuto.speculative));
        LitertLmHistory.ConvPlan gpuAuto = LitertLmHistory.conversationPlan("gemma-4-E2B.litertlm", false, true, true, null);
        check("GPU 上 auto 才自动开投机", Boolean.TRUE.equals(gpuAuto.speculative));

        LitertLmHistory.ConvPlan plain = LitertLmHistory.conversationPlan("qwen2.5-0.5b.task", false, false, false, null);
        check("普通模型 + 无 tune → 沿用 4 参构造（行为不变）", !plain.extended);

        /* ---------- 流式增量 ---------- */
        System.out.println("-- 流式增量 --");
        LitertLmHistory.Streamer cum = new LitertLmHistory.Streamer();
        eq("累计式·首段", "你好", cum.feed("你好"));
        eq("累计式·接着涨", "，世界", cum.feed("你好，世界"));
        eq("累计式·原样重发不重复吐", null, cum.feed("你好，世界"));

        LitertLmHistory.Streamer inc = new LitertLmHistory.Streamer();
        eq("增量式·首段", "旧", inc.feed("旧"));
        eq("增量式·第二段", "书店", inc.feed("书店"));
        eq("增量式·空片段丢弃", null, inc.feed(""));
        eq("增量式·null 丢弃", null, inc.feed(null));
        eq("两种语义拼出来的全量一致", "旧书店", inc.emitted());

        LitertLmHistory.Streamer one = new LitertLmHistory.Streamer();
        one.feed("甲");
        eq("换成不以前文开头的整段（重开一轮）→ 整段当增量", "乙", one.feed("乙"));

        System.out.println();
        System.out.println("结果： " + pass + " 通过 / " + fail + " 失败");
        if (fail > 0) System.exit(1);
    }
}
