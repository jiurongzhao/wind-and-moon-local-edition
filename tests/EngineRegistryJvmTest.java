import com.fy.local.EngineBackend;
import com.fy.local.EngineRegistry;
import com.fy.local.PlaceholderBackend;

/**
 * EngineRegistryJvmTest —— 验证"留门"那层抽象：后端注册、状态选择、聊天路由。
 *
 * 为什么值得测：前面两个后端（JNI 直连、子进程）本来是写死在 Bridge 里的分支，
 * 抽成注册表之后，选择逻辑（谁在跑、聊天该用谁、不可用的后端怎么跳过）
 * 一旦写错，表现是"引擎明明起来了却发不出消息"这种最难查的问题。
 * 这里不碰 Android、不碰 .so，纯逻辑，所以能在 Termux 里直接 JVM 真跑。
 *
 * 用法: java -cp <classes> EngineRegistryJvmTest
 */
public class EngineRegistryJvmTest {

    static int pass = 0, fail = 0;

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

    /** 只用来测选择逻辑的假后端。 */
    static class Fake implements EngineBackend {
        final String id;
        final boolean available;
        final boolean inProc;
        String state = "stopped";
        boolean active = false;

        Fake(String id, boolean available, boolean inProc) {
            this.id = id;
            this.available = available;
            this.inProc = inProc;
        }

        @Override public String id() { return id; }
        @Override public String label() { return "「" + id + "」"; }
        @Override public boolean available() { return available; }
        @Override public boolean inProcessChat() { return inProc; }
        @Override public String state() { return state; }
        @Override public String message() { return state; }
        @Override public String model() { return "m.gguf"; }
        @Override public long loadMs() { return -1; }
        @Override public boolean active() { return active; }
        @Override public boolean generating() { return false; }
        String started = null;
        String startedTune = null;
        @Override public void start(String p, int c, int t, boolean m, Runnable f) { started = p; }
        @Override public void stop() { active = false; state = "stopped"; }
        @Override public void unload() { }
        @Override public String chat(String[] f, ChatOptions o) { return null; }
        @Override public void stopChat() { }
    }

    /** 覆写了"带 tune"那个重载的假后端：验证 tune 真能传到后端。 */
    static final class TunedFake extends Fake {
        TunedFake() { super("tuned", true, true); }
        @Override public void start(String p, int c, int t, boolean m, String tune, Runnable f) {
            started = p;
            startedTune = tune;
        }
    }

    public static void main(String[] args) {
        System.out.println("=== 推理后端注册表 测试 ===");

        EngineRegistry reg = new EngineRegistry();
        Fake jni = new Fake("jni", true, true);
        Fake onnx = new Fake("onnx", false, true);   // 没装 ONNX Runtime：可用=false
        Fake javaB = new Fake("java", true, true);
        reg.register(jni);
        reg.register(onnx);
        reg.register(javaB);

        check("注册顺序 = all() 顺序",
                reg.all().size() == 3 && "jni".equals(reg.all().get(0).id())
                        && "onnx".equals(reg.all().get(1).id()) && "java".equals(reg.all().get(2).id()));
        check("按 id 取后端", reg.get("onnx") == onnx);
        check("没注册的 id 返回 null", reg.get("server") == null && reg.get(null) == null);
        reg.register(null);
        check("null 不注册", reg.all().size() == 3);

        check("没有后端在跑时 active() 为 null", reg.active() == null);
        check("forChat() 跳过不可用后端", reg.forChat() == jni,
                reg.forChat() == null ? "null" : reg.forChat().id());

        // loading 中的后端优先被 active() 报出来（engineStatus 用的就是它）
        javaB.state = "loading";
        check("正在 loading 的后端会被 active() 选中", reg.active() == javaB);
        check("loading + 可用 → forChat() 用它", reg.forChat() == javaB,
                reg.forChat() == null ? "null" : reg.forChat().id());

        javaB.state = "ready";
        javaB.active = true;
        check("ready + active 是 active()", reg.active() == javaB);
        check("active 且支持进程内 → forChat() 用 active 那个", reg.forChat() == javaB);

        // 非进程内后端（比如哪天把 server 也注册进来）不该抢聊天路由
        Fake srv = new Fake("server", true, false);
        srv.state = "ready";
        srv.active = true;
        javaB.active = false;
        javaB.state = "stopped";
        reg.register(srv);
        check("非进程内后端即使 active 也不抢聊天", reg.active() == srv && reg.forChat() == jni,
                "active=" + (reg.active() == null ? "null" : reg.active().id())
                        + " chat=" + (reg.forChat() == null ? "null" : reg.forChat().id()));

        check("summary() 把可用性写清楚",
                reg.summary().contains("jni:stopped")
                        && reg.summary().contains("onnx:unavailable")
                        && reg.summary().contains("java:stopped")
                        && reg.summary().contains("server:ready"),
                reg.summary());
        check("空注册表 summary() 是空串", new EngineRegistry().summary().isEmpty());
        check("空注册表 forChat()/active() 都是 null",
                new EngineRegistry().forChat() == null && new EngineRegistry().active() == null);

        // B/C 两条"留位不落地"的路：必须永远选不中、也起不来
        EngineRegistry ph = new EngineRegistry();
        ph.register(new Fake("jni", true, true));
        ph.register(new PlaceholderBackend("java", "纯 Java 引擎", "ART 没有 Vector API"));
        ph.register(new PlaceholderBackend("onnx", "ONNX Runtime", "要换模型格式"));
        check("占位后端 available() 恒为 false",
                !ph.get("java").available() && !ph.get("onnx").available());
        check("占位后端不会被 forChat() 选中", ph.forChat() != null && "jni".equals(ph.forChat().id()),
                ph.forChat() == null ? "null" : ph.forChat().id());
        check("占位后端 active() 为 null",
                ph.active() == null && "java".equals(ph.get("java").id()) && "onnx".equals(ph.get("onnx").id()));
        check("summary() 把未接入写清楚", ph.summary().contains("java:unavailable")
                && ph.summary().contains("onnx:unavailable"), ph.summary());

        // EngineBackend 的 6 参 start（带 tune）默认落回 5 参；覆写了它的后端才拿得到 tune
        Fake del = new Fake("del", true, true);
        del.start("m.gguf", 2048, 4, false, "type_k=q8_0", null);
        check("默认 6 参 start 落回 5 参（不认 tune 的老后端也不炸）",
                "m.gguf".equals(del.started) && del.startedTune == null,
                "started=" + del.started + " tune=" + del.startedTune);
        TunedFake tf = new TunedFake();
        tf.start("m.gguf", 2048, 4, false, "type_k=q8_0;flash_attn=1", null);
        check("覆写 6 参 start 的后端能收到 tune",
                "type_k=q8_0;flash_attn=1".equals(tf.startedTune), "tune=" + tf.startedTune);

        System.out.println();
        System.out.println("结果： " + pass + " 通过 / " + fail + " 失败");
        if (fail > 0) System.exit(1);
    }
}
