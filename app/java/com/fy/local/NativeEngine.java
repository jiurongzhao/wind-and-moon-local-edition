package com.fy.local;

/**
 * 风月·本地版专用推理引擎的 Java 侧门面（JNI 直连 libllama）。
 *
 * 跟老的 Engine.java（fork llama-server + localhost HTTP）相比，这里没有子进程、没有端口、
 * 没有 /health 轮询，KV 缓存归自己管 —— 所以"静态前缀常驻"是可以保证的，而不是求服务端命中。
 *
 * 分工（这条边界很重要）：
 *   Java 侧负责**内容**：系统提示、角色卡、示例对话、剧情提醒，按 messages 原样递进来；
 *   引擎负责**格式与状态**：套模型自带的对话模板（GGUF 里那份 jinja）、tokenize、
 *   前缀比对、KV 复用、context-shift、采样、流式回调。
 * 于是改一句中文模板不需要重编 .so，换一个模型也不用改 Java（模板跟着模型走）。
 */
public class NativeEngine {

    /** 流式回调。由 MainActivity 设置；为 null 时静默。 */
    public interface Listener {
        /** 每出一个 token 调一次（已经在引擎线程上，别做重活）。 */
        void onToken(String piece);
        /** 一轮结束，stats 是一小段 JSON（gen / reused / firstMs …）。 */
        void onDone(String statsJson);
        /** 预填充进度（done / total token）。默认空实现：只有需要「别被看门狗误杀」的界面才用。 */
        default void onProgress(int done, int total) {}
    }

    private static volatile Listener listener;

    public static void setListener(Listener l) {
        listener = l;
    }

    /** JNI 回调入口：C 侧每出一个 token 就调这里。 */
    public static void onToken(String piece) {
        Listener l = listener;
        if (l != null) l.onToken(piece);
    }

    /** JNI 回调入口：C 侧预填充每推进一块就调这里。 */
    public static void onProgress(int done, int total) {
        Listener l = listener;
        if (l != null) l.onProgress(done, total);
    }

    /** .so 是否成功加载 —— 表示"这条路存不存在"，与"某个模型有没有加载"是两回事。 */
    private static volatile boolean soLoaded = false;

    static {
        System.loadLibrary("fy_engine");
        soLoaded = true;
    }

    public static boolean soLoaded() {
        return soLoaded;
    }

    // ---------- 原生方法 ----------
    public static native String nativeSystemInfo();

    /** 返回加载耗时（ms），失败 -1。
     *  tune 是 "k=v;k=v" 一行（可为 null）：type_k/type_v（f16/f32/q8_0/q4_0/q5_0/q5_1）、
     *  flash_attn（-1 auto / 0 关 / 1 开）、ubatch（物理批大小）、kv_unified、swa_full。 */
    public static native long nativeLoad(String modelPath, int nCtx, int nThreads, int nBatch, boolean mlock, String tune);

    /** 把静态前缀解码进 KV 并常驻，返回前缀 token 数；失败 -1。 */
    public static native int nativeSetPrefix(String prefix);

    /** 一轮生成，返回统计 JSON；token 通过 onToken 流式推回。
     *  sampler："k=v;k=v" 采样参数（见 jni/fy_engine.c 顶部注释）；grammar：GBNF，空则不约束。 */
    public static native String nativeGenerate(String fullPrompt, int maxTokens, float temp,
                                               int topK, float topP, int seed, int prefixTokens,
                                               String sampler, String grammar, String grammarTrigger);

    /**
     * 一轮对话：messages 交给原生侧套**模型自带**的对话模板（GGUF 里那份），然后流式生成。
     *
     * @param messages    [role0, content0, role1, content1, …] 的扁平数组
     * @param pinMessages 前几条算静态前缀（一般是 1 条 system），这段永远不被 context-shift 丢掉
     */
    public static native String nativeChat(String[] messages, int pinMessages, int maxTokens,
                                           float temp, int topK, float topP, int seed,
                                           String sampler, String grammar, String grammarTrigger);

    /** 辅助生成（记忆压缩 / 工具调用）：跑完把聊天序列的 KV 恢复原样，不污染聊天缓存。 */
    public static native String nativeChatAux(String[] messages, int pinMessages, int maxTokens,
                                              float temp, int topK, float topP, int seed,
                                              String sampler, String grammar, String grammarTrigger);

    /** 只套模板不生成：给测试和「查看实际 prompt」用。 */
    public static native String nativeApplyTemplate(String[] messages, boolean addAssistant);

    /** 一段文本在模型词表下是多少 token（未加载返回 -1）。上下文预算要用。 */
    public static native int nativeCountTokens(String text);

    public static native void nativeStop();

    /** 当前 KV 里有多少 token（测试与诊断用）。 */
    public static native int nativeCacheTokens();

    public static native void nativeRelease();

    // ---------- 便捷门面 ----------
    private static volatile boolean loaded = false;
    private static volatile int prefixTokens = 0;

    public static boolean isLoaded() {
        return loaded;
    }

    public static int prefixTokens() {
        return prefixTokens;
    }

    public static long load(String modelPath, int nCtx, int nThreads, boolean mlock) {
        return load(modelPath, nCtx, nThreads, mlock, null);
    }

    /** 带加载调参的重载（tune 见 nativeLoad 注释）。null/空串 = 完全保持老行为。 */
    public static long load(String modelPath, int nCtx, int nThreads, boolean mlock, String tune) {
        int batch = Math.max(512, nThreads * 128);
        long ms = nativeLoad(modelPath, nCtx, nThreads, batch, mlock,
                tune == null || tune.isEmpty() ? null : tune);
        loaded = ms >= 0;
        return ms;
    }

    public static int setPrefix(String prefix) {
        prefixTokens = nativeSetPrefix(prefix == null ? "" : prefix);
        return prefixTokens;
    }

    public static String generate(String prompt, int maxTokens, float temp, int topK, float topP, int seed) {
        return generate(prompt, maxTokens, temp, topK, topP, seed, null, null, null);
    }

    public static String generate(String prompt, int maxTokens, float temp, int topK, float topP, int seed,
                                  String sampler, String grammar, String grammarTrigger) {
        String stats = nativeGenerate(prompt, maxTokens, temp, topK, topP, seed, prefixTokens,
                sampler, grammar, grammarTrigger);
        Listener l = listener;
        if (l != null) l.onDone(stats);
        return stats;
    }

    /**
     * 一轮对话。模板由原生侧按模型自己那份套（换模型自动换模板），Java 只递 messages。
     * 静态前缀（前 pinMessages 条）会常驻 KV，历史变长时只丢前缀之后的部分。
     */
    public static String chat(String[] messages, int pinMessages, int maxTokens,
                              float temp, int topK, float topP, int seed) {
        return chat(messages, pinMessages, maxTokens, temp, topK, topP, seed, null, null, null);
    }

    public static String chat(String[] messages, int pinMessages, int maxTokens,
                              float temp, int topK, float topP, int seed,
                              String sampler, String grammar, String grammarTrigger) {
        String stats = nativeChat(messages, pinMessages, maxTokens, temp, topK, topP, seed,
                sampler, grammar, grammarTrigger);
        Listener l = listener;
        if (l != null) l.onDone(stats);
        return stats;
    }

    /** 辅助生成：同参，但跑完会把聊天序列的 KV 恢复原样。 */
    public static String chatAux(String[] messages, int pinMessages, int maxTokens,
                                 float temp, int topK, float topP, int seed) {
        return chatAux(messages, pinMessages, maxTokens, temp, topK, topP, seed, null, null, null);
    }

    public static String chatAux(String[] messages, int pinMessages, int maxTokens,
                                 float temp, int topK, float topP, int seed,
                                 String sampler, String grammar, String grammarTrigger) {
        String stats = nativeChatAux(messages, pinMessages, maxTokens, temp, topK, topP, seed,
                sampler, grammar, grammarTrigger);
        Listener l = listener;
        if (l != null) l.onDone(stats);
        return stats;
    }

    /** 只套模板不生成（测试 / 前端「查看实际 prompt」）。 */
    public static String applyTemplate(String[] messages, boolean addAssistant) {
        return nativeApplyTemplate(messages, addAssistant);
    }

    /** 一段文本的 token 数（未加载返回 -1）。 */
    public static int countTokens(String text) {
        return nativeCountTokens(text == null ? "" : text);
    }

    public static void stop() {
        nativeStop();
    }

    public static void unload() {
        nativeRelease();
        loaded = false;
        prefixTokens = 0;
    }
}
