package com.fy.local;

/**
 * 推理后端的统一契约（"留门"）。
 *
 * <p>现在 App 里真正在跑的本地推理有两类：
 * <ul>
 *   <li>{@link Engine}：fork llama-server 子进程 + localhost HTTP。它<b>不实现本接口</b> ——
 *       聊天走 HTTP，前端用 {@code native=false} 就能分辨；它只占 EngineRegistry 之外的
 *       "server 槽位"（见 {@code Bridge.engineStart} 的兜底分支）。</li>
 *   <li>{@link JniEngineBackend}：JNI 直连 libllama（进程内，前端走 {@code FY.chat()}）。</li>
 * </ul>
 *
 * <p>以后加 B（纯 Java 推理）、C（ONNX Runtime / MediaPipe）时，只要三步：
 * <ol>
 *   <li>写一个类实现本接口（状态取值保持 {@code stopped/loading/ready/error}）；</li>
 *   <li>在 {@code MainActivity.onCreate} 里 {@code registry.register(...)}；</li>
 *   <li>设置页「推理方式」多一个选项（前端按 {@code engineMode} 传回来，Bridge 用 id 找后端）。</li>
 * </ol>
 * 不需要改 {@code Bridge} 的调度，也不需要改前端的分叉逻辑。
 *
 * <p><b>约定</b>：同一时刻只有一个进程内后端在跑；{@link #start} 之前调用方负责停掉旧的。
 */
public interface EngineBackend {

    /** 稳定标识：{@code jni} / {@code onnx} / {@code java} / …，与前端 {@code engineMode} 同字。 */
    String id();

    /** 设置页显示的名字。 */
    String label();

    /**
     * 这个后端在本次安装 / 这台机器上能不能用。
     * .so 没打进 APK、ABI 不符、SDK 缺失，都要在这里如实返回 false，让上层能回退到 server。
     */
    boolean available();

    /** true = 跑在 App 进程内，聊天经 {@code FY.chat()}（token 走 gen 事件）；false = 走 HTTP 的那类。 */
    boolean inProcessChat();

    /* ---------- 状态快照（取值与 Engine.java 对齐） ---------- */

    /** stopped | loading | ready | error */
    String state();

    String message();

    String model();

    /** 加载耗时（ms）；还没加载过返回 -1。 */
    long loadMs();

    /** 是否已经就绪并可以在跑（loading / ready 之间）。 */
    boolean active();

    /** 有没有一轮生成正在进行（换模型前必须为 false）。 */
    boolean generating();

    /**
     * 异步装模型 / 起后端。状态通过实现类自己推事件（形状与 {@link Engine.Listener#onState} 一致）。
     *
     * @param absModelPath GGUF 绝对路径（或其他后端认识的模型路径）
     * @param onStartFailed 起不来时回调；调用方据此决定要不要回退到子进程引擎
     */
    void start(String absModelPath, int ctx, int threads, boolean mlock, Runnable onStartFailed);

    /**
     * 带调参的启动：tune 是 {@code "k=v;k=v"} 一行（可为 null/空），语义由各后端自己解释。
     *
     * <p>默认实现忽略调参、退回上面那个 5 参版本 —— 这样占位后端与测试里的假后端不用改，
     * 只有真正认得调参的后端（JNI 的 KV 量化 / LiteRT-LM 的思考与投机解码）才覆写它。
     */
    default void start(String absModelPath, int ctx, int threads, boolean mlock, String tune,
                       Runnable onStartFailed) {
        start(absModelPath, ctx, threads, mlock, onStartFailed);
    }

    /** 停止当前生成并把后端退回 stopped（之后可以再次 start）。 */
    void stop();

    /** 释放 native / 托管资源（进程退出前调）。 */
    void unload();

    /**
     * 开一轮生成。messages 已经拍平成 {@code [role, content, role, content, …]}。
     *
     * @return 本轮生成 id（前端用它丢弃迟到的旧事件）；后端正忙时返回 null
     */
    String chat(String[] flatMessages, ChatOptions opts);

    /** 中止当前这一轮生成。 */
    void stopChat();

    /** 一轮生成的采样参数（字段名与前端 opts 一致）。 */
    final class ChatOptions {
        public int pinMessages = 1;
        public int maxTokens = 512;
        public float temperature = 0.8f;
        public int topK = 40;
        public float topP = 0.95f;
        public int seed = 0;
        public String sampler = "";
        public String grammar = "";
        public String grammarTrigger = "";
        public boolean aux = false;
    }
}
