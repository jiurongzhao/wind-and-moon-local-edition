package com.fy.local;

import android.util.Log;

/**
 * JNI 直连 libllama 的后端 —— v1.7.0 那个"进程内引擎"。
 *
 * <p>这是一个<b>薄适配器</b>：真正的状态机、token 合批、60 秒看门狗都还在
 * {@link MainActivity} 里没动。原因很实际 —— Bridge / MainActivity 是 Android 专属胶水，
 * 没有 JVM 测试覆盖，能不搬就不搬；而 B/C 两个后端只要能插进
 * {@link EngineRegistry} 就行，状态放哪不影响扩展。
 *
 * <p>它存在的意义只有一个：把"进程内引擎"从写死在 Bridge 里的分支，
 * 变成注册表里的一格。
 */
public final class JniEngineBackend implements EngineBackend {

    private static final String TAG = "FyJniBackend";

    private final MainActivity host;

    public JniEngineBackend(MainActivity host) {
        this.host = host;
    }

    @Override public String id() { return "jni"; }

    @Override public String label() { return "内置（推荐）"; }

    @Override public boolean available() {
        /* 这里问的必须是".so 这条路在不在"，而不是"模型有没有加载"（isLoaded 是后者）。
           以前用了 isLoaded()：进程刚起来时恒为 false，于是 engineStart 悄悄回退子进程、
           进程内引擎永远起不来。.so 没打进 APK / ABI 不符时类初始化会抛，统一吞成 false。 */
        try { return NativeEngine.soLoaded(); } catch (Throwable t) { return false; }
    }

    @Override public boolean inProcessChat() { return true; }

    @Override public String state() { return host.natState(); }

    @Override public String message() { return host.natMessage(); }

    @Override public String model() { return host.natModel(); }

    @Override public long loadMs() { return host.natLoadMs(); }

    /* available() 是防御性的：如果哪天别的后端误碰了 natActive，也不会把聊天路由骗到没加载的 JNI 上。 */
    @Override public boolean active() { return available() && host.natActive(); }

    @Override public boolean generating() { return host.nativeGenerating(); }

    @Override
    public void start(final String absModelPath, final int ctx, final int threads,
                      final boolean mlock, final Runnable onStartFailed) {
        start(absModelPath, ctx, threads, mlock, null, onStartFailed);
    }

    @Override
    public void start(final String absModelPath, final int ctx, final int threads,
                      final boolean mlock, final String tune, final Runnable onStartFailed) {
        final String displayName = new java.io.File(absModelPath).getName();
        host.nativePush("loading", "正在加载模型…", displayName, -1);
        new Thread(() -> {
            long ms = -1;
            try {
                // 先收掉可能还在跑的旧引擎：一个占着 3.5GB 的残留会让新模型加载慢一个数量级
                host.engine().stop();
                NativeEngine.unload();
                ms = NativeEngine.load(absModelPath, ctx, threads, mlock, tune);
            } catch (Throwable t) {
                // .so 加载失败（缺库 / ABI 不符）会在这里抛，别让线程就这么死掉
                Log.w(TAG, "进程内引擎加载异常", t);
                ms = -1;
            }
            if (ms >= 0) {
                host.nativePush("ready", "模型就绪（加载 " + ms + " 毫秒）", displayName, ms);
            } else {
                /* 回退：先把原生状态清干净（否则 engineStatus 会一直报 loading，
                   前端就看不到子进程引擎的真实状态了），再让调用方去起 llama-server。 */
                host.nativeReset();
                if (onStartFailed != null) onStartFailed.run();
            }
        }, "fy-native-load").start();
    }

    @Override
    public void stop() {
        boolean wasNative = host.natActive() || "loading".equals(host.natState());
        host.shutdownNativeEngine();
        if (wasNative) host.nativePush("stopped", "已手动停止", null, -1);
    }

    @Override
    public void unload() {
        try { NativeEngine.unload(); } catch (Throwable ignored) { }
    }

    @Override
    public String chat(String[] flatMessages, ChatOptions o) {
        final String id = host.beginNativeGen();
        if (id == null) return null;
        new Thread(() -> {
            try {
                String stats = o.aux
                        ? NativeEngine.chatAux(flatMessages, o.pinMessages, o.maxTokens, o.temperature,
                                o.topK, o.topP, o.seed, o.sampler, o.grammar, o.grammarTrigger)
                        : NativeEngine.chat(flatMessages, o.pinMessages, o.maxTokens, o.temperature,
                                o.topK, o.topP, o.seed, o.sampler, o.grammar, o.grammarTrigger);
                host.finishNativeGen(stats);
            } catch (Throwable t) {
                Log.w(TAG, "原生生成失败", t);
                host.failNativeGen("这次回答没能生成，请重新发送");
            }
        }, "fy-native-chat").start();
        return id;
    }

    @Override
    public void stopChat() {
        try { NativeEngine.stop(); } catch (Throwable ignored) { }
    }
}
