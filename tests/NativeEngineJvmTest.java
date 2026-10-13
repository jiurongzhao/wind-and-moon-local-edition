import com.fy.local.NativeEngine;

import java.util.ArrayList;
import java.util.List;

/**
 * NativeEngineJvmTest —— 在 Termux 里真跑 JNI 引擎（不碰 Android 设备）。
 *
 * 这是 v1.7.0「JNI 直连」这条路的验收测试，重点是**前缀复用**：
 *   第 1 轮把静态前缀（系统提示 + 角色卡）解码进 KV；
 *   第 2 轮带上历史，引擎应当只 decode 增量 —— reused 应该明显大于前缀长度。
 * 如果这条不成立，"专门为 App 写死的引擎"就没有意义（那还不如用 llama-server）。
 *
 * 用法:
 *   LD_LIBRARY_PATH=native GGML_BACKEND_PATH=native \
 *     java -Djava.library.path=native -cp build/jvmtest NativeEngineJvmTest [模型]
 */
public class NativeEngineJvmTest {

    static int pass = 0, fail = 0;
    static final List<String> streamed = new ArrayList<>();

    static void check(String name, boolean ok) {
        check(name, ok, null);
    }

    static void check(String name, boolean ok, String extra) {
        if (ok) {
            pass++;
            System.out.println("  ✅ " + name);
        } else {
            fail++;
            System.out.println("  ❌ " + name + (extra != null ? " — " + extra : ""));
        }
    }

    static int num(String json, String key) {
        int i = json.indexOf("\"" + key + "\":");
        if (i < 0) return -1;
        int j = i + key.length() + 3;
        int k = j;
        while (k < json.length() && (Character.isDigit(json.charAt(k)) || json.charAt(k) == '-')) k++;
        try {
            return Integer.parseInt(json.substring(j, k));
        } catch (Exception e) {
            return -1;
        }
    }

    public static void main(String[] args) throws Exception {
        String root = System.getProperty("user.home") + "/2/fy";
        String model = args.length > 0 ? args[0] : root + "/models/qwen2.5-0.5b-instruct-q4_k_m.gguf";
        int ctx = args.length > 1 ? Integer.parseInt(args[1]) : 2048;

        System.out.println("=== NativeEngine（JNI 直连 libllama）JVM 实跑 ===");
        System.out.println("model : " + model);

        NativeEngine.setListener(new NativeEngine.Listener() {
            @Override
            public void onToken(String piece) {
                streamed.add(piece);
            }

            @Override
            public void onDone(String statsJson) {
            }
        });

        System.out.println("\n【1】加载");
        long ms = NativeEngine.load(model, ctx, 4, false);
        System.out.println("  加载耗时 " + ms + " ms");
        check("模型加载成功", ms >= 0, "ms=" + ms);
        if (ms < 0) {
            summary();
            return;
        }
        check("加载在 10 秒内（JNI 直连的卖点之一）", ms < 10000, ms + "ms");

        System.out.println("\n【2】静态前缀写进 KV");
        String prefix = "<|im_start|>system\n你叫林夏，是深夜书店的店员。说话短，",
        // 折成两段拼接避免行太长
        prefix2 = "喜欢用具体的东西打比方。<|im_end|>\n";
        prefix = prefix + prefix2;
        int pt = NativeEngine.setPrefix(prefix);
        System.out.println("  前缀 " + pt + " token");
        check("前缀写入成功", pt > 0);
        check("KV 里就是前缀那么长", NativeEngine.nativeCacheTokens() == pt,
                "cache=" + NativeEngine.nativeCacheTokens() + " prefix=" + pt);

        System.out.println("\n【3】第 1 轮：只该 decode 用户那几 token");
        String sys = prefix;
        String u1 = "<|im_start|>user\n你好<|im_end|>\n<|im_start|>assistant\n";
        streamed.clear();
        String s1 = NativeEngine.generate(sys + u1, 24, 0.0f, 0, 1.0f, 1);
        String t1 = String.join("", streamed);
        System.out.println("  stats: " + s1);
        System.out.println("  文本 : " + t1.replace("\n", "⏎"));
        check("有 token 流式回调到 Java", streamed.size() > 0, "size=" + streamed.size());
        check("第 1 轮复用了整个前缀", num(s1, "reused") >= pt, "reused=" + num(s1, "reused") + " prefix=" + pt);
        check("第 1 轮确实生成了 token", num(s1, "gen") > 0, "gen=" + num(s1, "gen"));

        System.out.println("\n【4】第 2 轮：复用应当包含第 1 轮的全部内容（前缀 + 历史）");
        String p2 = sys + u1 + t1 + "<|im_end|>\n<|im_start|>user\n再说一句<|im_end|>\n<|im_start|>assistant\n";
        streamed.clear();
        String s2 = NativeEngine.generate(p2, 24, 0.0f, 0, 1.0f, 1);
        String t2 = String.join("", streamed);
        int r1 = num(s1, "reused"), r2 = num(s2, "reused");
        System.out.println("  stats: " + s2);
        System.out.println("  文本 : " + t2.replace("\n", "⏎"));
        // 真正的判据不是"prefill 更快"（那是按新增 token 数算的，两轮本来就不一样），
        // 而是"上一轮一个 token 都没白算" —— 第 2 轮的 reused 应当正好等于第 1 轮结束时的 cache 长度。
        check("第 2 轮复用了第 1 轮的全部（前缀 + 用户 + 已生成）",
                r2 == num(s1, "cache"), "r2=" + r2 + " 第1轮cache=" + num(s1, "cache"));

        System.out.println("\n【4.5】messages 走模型自带模板（nativeChat）");
        // 换一个跟前两节都不一样的角色：既能验证模板，又能验证"换人设 = 旧缓存失效"
        String sys2 = "你叫沈砚堂，是古董店的掌柜。";
        String[] msgs = { "system", sys2, "user", "你好" };
        String pfxRendered = NativeEngine.applyTemplate(msgs, false);
        System.out.println("  模板渲染: " + pfxRendered.replace("\n", "⏎"));
        check("用的是模型自带的对话模板（ChatML 角色标记）",
                pfxRendered.contains("<|im_start|>system") && pfxRendered.contains("<|im_end|>"),
                pfxRendered);
        check("addAssistant=true 会补上 assistant 起手标记",
                NativeEngine.applyTemplate(msgs, true).contains("<|im_start|>assistant"));
        int pin = NativeEngine.countTokens(pfxRendered);
        System.out.println("  静态前缀 " + pin + " token");
        check("静态前缀的 token 数算得出来", pin > 0, "pin=" + pin);

        streamed.clear();
        String c1 = NativeEngine.chat(msgs, 1, 24, 0.0f, 0, 1.0f, 1);
        String ct1 = String.join("", streamed);
        System.out.println("  stats: " + c1);
        System.out.println("  文本 : " + ct1.replace("\n", "⏎"));
        check("chat 有 token 流式回调到 Java", streamed.size() > 0, "size=" + streamed.size());
        check("换人设后旧前缀不该被算成可复用", num(c1, "reused") < pin,
                "reused=" + num(c1, "reused") + " pin=" + pin);
        check("chat 确实生成了 token", num(c1, "gen") > 0, "gen=" + num(c1, "gen"));

        System.out.println("\n【4.6】chat 第 2 轮：人设 + 历史整体复用");
        String[] msgs2 = { "system", sys2, "user", "你好", "assistant", ct1, "user", "再说一句" };
        streamed.clear();
        String c2 = NativeEngine.chat(msgs2, 1, 24, 0.0f, 0, 1.0f, 1);
        int rc2 = num(c2, "reused");
        System.out.println("  stats: " + c2);
        check("第 2 轮复用了第 1 轮的全部（人设 + 历史）", rc2 == num(c1, "cache"),
                "r2=" + rc2 + " 第1轮cache=" + num(c1, "cache"));
        check("复用的长度至少盖住静态前缀（人设常驻）", rc2 >= pin, "reused=" + rc2 + " pin=" + pin);

        System.out.println("\n【5】换角色 = 换前缀：缓存应当被清掉重来");
        int pt2 = NativeEngine.setPrefix("<|im_start|>system\n你叫沈砚堂，是古董店的掌柜。<|im_end|>\n");
        check("换前缀成功", pt2 > 0);
        check("换前缀后 KV 长度等于新前缀", NativeEngine.nativeCacheTokens() == pt2,
                "cache=" + NativeEngine.nativeCacheTokens() + " new=" + pt2);
        String s3 = NativeEngine.generate("<|im_start|>system\n你叫沈砚堂，是古董店的掌柜。<|im_end|>\n"
                + "<|im_start|>user\n在吗<|im_end|>\n<|im_start|>assistant\n", 16, 0.0f, 0, 1.0f, 1);
        check("新角色第 1 轮仍然复用满前缀", num(s3, "reused") >= pt2 - 4,
                "reused=" + num(s3, "reused") + " prefix=" + pt2);

        System.out.println("\n【6】小上下文压力测试：必然溢出，看 context-shift 会不会崩");
        NativeEngine.unload();
        long tiny = NativeEngine.load(model, 192, 4, false);   // 故意给一个很小的 ctx
        check("用小 ctx 重新加载成功", tiny >= 0, "ms=" + tiny);
        if (tiny >= 0) {
            String pfx = "<|im_start|>system\n你是深夜书店的店员。\n";
            int pn = NativeEngine.setPrefix(pfx);
            check("小 ctx 下前缀写入成功", pn > 0, "prefix=" + pn);
            String longTurn = pfx;
            int rounds = 0;
            boolean crashed = false;
            // 连推 6 轮，每轮带上一轮的输出 —— 192 的 ctx 肯定装不下，必然走到丢弃分支
            for (int i = 0; i < 6; i++) {
                String st = NativeEngine.generate(longTurn + "<|im_start|>user\n继续" + i
                        + "<|im_end|>\n<|im_start|>assistant\n", 40, 0.0f, 0, 1.0f, 1);
                if (st.contains("error")) { crashed = true; System.out.println("  第 " + i + " 轮: " + st); break; }
                rounds++;
                longTurn = longTurn + "第" + i + "轮回答。<|im_end|>\n";
            }
            check("溢出后没有报错、连续跑完 6 轮", !crashed && rounds == 6, "rounds=" + rounds);
            check("KV 长度始终没超过 ctx", NativeEngine.nativeCacheTokens() <= 192,
                    "cache=" + NativeEngine.nativeCacheTokens());
        }

        System.out.println("\n【6.5】停止：生成中途能真的停下来");
        // 【6】把小 ctx 的引擎留在那儿了，先换回正常 ctx
        NativeEngine.unload();
        long rl = NativeEngine.load(model, 512, 4, false);
        check("重新加载（正常 ctx）", rl >= 0, "ms=" + rl);
        if (rl >= 0) {
            String[] countMsgs = { "system", "你叫林夏。", "user",
                    "请从 1 数到 300，每个数字单独一行，不要省略。" };
            streamed.clear();
            long t0 = System.currentTimeMillis();
            Thread stopper = new Thread(() -> {
                try {
                    Thread.sleep(200);
                } catch (InterruptedException ignored) {
                }
                NativeEngine.stop();   // 模拟用户在界面点「停止生成」
            }, "stopper");
            stopper.start();
            String st = NativeEngine.chat(countMsgs, 1, 256, 0.0f, 0, 1.0f, 1);
            long stopMs = System.currentTimeMillis() - t0;
            stopper.join();
            int gen = num(st, "gen");
            System.out.println("  stats: " + st + "（" + stopMs + "ms 后返回）");
            check("点停止后本轮很快返回（不是跑满 256 个 token）", stopMs < 8000, stopMs + "ms");
            check("停止确实截短了生成长度", gen >= 0 && gen < 256, "gen=" + gen);
        }

        System.out.println("\n【7】停止与卸载");
        NativeEngine.stop();
        NativeEngine.unload();
        check("卸载后 isLoaded() 为 false", !NativeEngine.isLoaded());

        summary();
    }

    static void summary() {
        System.out.println("\n" + "─".repeat(56));
        System.out.println("结果： " + pass + " 通过 / " + fail + " 失败");
        System.exit(fail == 0 ? 0 : 1);
    }
}
