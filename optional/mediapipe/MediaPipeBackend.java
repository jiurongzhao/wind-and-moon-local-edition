package com.fy.local;

import android.util.Log;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mediapipe.tasks.genai.llminference.LlmInference;
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession;
import com.google.mediapipe.tasks.genai.llminference.ProgressListener;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * C 路线的真后端：MediaPipe LLM Inference（底层 LiteRT）跑 `.task` 模型。
 *
 * <p><b>两条路：</b>
 * <ul>
 *   <li>默认：{@code generateResponseAsync(prompt, ProgressListener)} 真流式 + 可取消 +
 *       用 {@code sizeInTokens} 报真实 token 数（老实现是同步 {@code generateResponse}，
 *       不出字、停不了、token 靠字符估）。</li>
 *   <li>{@code tune} 里 {@code mp_session=1}：再启用显式 {@code LlmInferenceSession}，
 *       跨轮保留 KV，只把新增的那条用户消息当新 query 喂进去（默认关：会话语义没在真机上
 *       验过，怕把能跑的 PoC 弄坏；任何异常都自动退回一次性 prompt）。</li>
 * </ul>
 * 采样参数由 MediaPipe 内部按 .task 走，前端那套重复惩罚/DRY/GBNF 在这里仍然用不上。
 */
public final class MediaPipeBackend implements EngineBackend {

    private static final String TAG = "FyMediaPipe";

    private final MainActivity host;
    private volatile LlmInference inf;
    private volatile String modelName = "";
    private volatile long loadMs = -1;
    private volatile String state = "stopped";
    private volatile String message = "";

    /* ---------- 流式 / 跨轮 KV ---------- */
    private volatile LlmInferenceSession session;
    private volatile boolean sessionEnabled = false;
    private final Object lock = new Object();
    private final List<String> fedKeys = new ArrayList<>();
    private String fedSystem = null;
    private volatile ListenableFuture<String> pending;
    private volatile LitertLmHistory.Streamer streamer = new LitertLmHistory.Streamer();
    private volatile long firstTokenAt = 0;
    private volatile boolean settled = false;

    public MediaPipeBackend(MainActivity host) {
        this.host = host;
    }

    @Override public String id() { return "mediapipe"; }

    @Override public String label() { return "本机引擎 · MediaPipe"; }

    /** 模型目录里能找到 .task 才可用；否则设置页显示"（不可用）"。 */
    @Override public boolean available() { return findTask() != null; }

    @Override public boolean inProcessChat() { return true; }

    @Override public String state() { return state; }
    @Override public String message() { return message; }
    @Override public String model() { return modelName; }
    @Override public long loadMs() { return loadMs; }
    @Override public boolean active() { return "ready".equals(state); }
    @Override public boolean generating() { return host.nativeGenerating(); }

    private File findTask() {
        try {
            File[] fs = host.models().dir().listFiles();
            if (fs == null) return null;
            for (File f : fs) {
                if (f.isFile() && f.getName().toLowerCase().endsWith(".task")) return f;
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    @Override
    public void start(String absModelPath, int ctx, int threads, boolean mlock, Runnable onStartFailed) {
        start(absModelPath, ctx, threads, mlock, null, onStartFailed);
    }

    @Override
    public void start(String absModelPath, int ctx, int threads, boolean mlock, String tune,
                      Runnable onStartFailed) {
        sessionEnabled = LitertLmHistory.paramBool(tune, "mp_session", false);
        final File task = findTask();
        if (task == null) {
            host.nativeReset();
            if (onStartFailed != null) onStartFailed.run();
            return;
        }
        state = "loading";
        message = "正在加载模型…";
        /* 注意：这里不能用 nativePush —— 那套会顺手把 natActive 置真，
           于是 EngineRegistry 会误判"jni 正在跑"、把聊天路由给一个没加载的 JNI 后端。 */
        host.pushEngineEvent("loading", "正在把模型装进本机引擎…", task.getName(), true);
        new Thread(() -> {
            long t0 = System.currentTimeMillis();
            try {
                host.engine().stop();
                LlmInference old = inf;
                inf = null;
                if (old != null) {
                    try { old.close(); } catch (Throwable ignored) { }
                }
                closeSession();
                LlmInference.LlmInferenceOptions opts = LlmInference.LlmInferenceOptions.builder()
                        .setModelPath(task.getAbsolutePath())
                        .setMaxTokens(1024)
                        // 前端 topK 可能到 64；不抬这个上限，session sampler 会被截断
                        .setMaxTopK(64)
                        .build();
                inf = LlmInference.createFromOptions(host, opts);
                modelName = task.getName();
                loadMs = System.currentTimeMillis() - t0;
                state = "ready";
                message = "本机引擎就绪（加载 " + (loadMs / 1000.0) + " 秒"
                        + (sessionEnabled ? "，会话加速已开" : "") + "）";
                host.pushEngineEvent("ready", message, modelName, true);
            } catch (Throwable t) {
                Log.w(TAG, "MediaPipe 加载失败", t);
                loadMs = -1;
                state = "stopped";
                host.pushEngineEvent("error", "本机引擎没能加载，请回设置页重新选一次模型", task.getName(), true);
                if (onStartFailed != null) onStartFailed.run();
            }
        }, "fy-mediapipe-load").start();
    }

    @Override
    public void stop() {
        boolean was = active() || "loading".equals(state);
        try {
            LlmInference cur = inf;
            if (cur != null) cur.close();
        } catch (Throwable ignored) {
        }
        inf = null;
        closeSession();
        state = "stopped";
        if (was) host.pushEngineEvent("stopped", "已手动停止", null, true);
    }

    @Override public void unload() { stop(); }

    @Override
    public String chat(String[] flatMessages, ChatOptions o) {
        final LlmInference cur = inf;
        if (cur == null) return null;
        final String id = host.beginNativeGen();
        if (id == null) return null;

        StringBuilder sys = new StringBuilder();
        final List<String[]> body = new ArrayList<>();
        for (int i = 0; i + 1 < flatMessages.length; i += 2) {
            String role = flatMessages[i] == null ? "user" : flatMessages[i];
            String text = flatMessages[i + 1] == null ? "" : flatMessages[i + 1];
            if (text.isEmpty()) continue;
            if ("system".equals(role)) {
                if (sys.length() > 0) sys.append('\n');
                sys.append(text);
            } else {
                body.add(new String[]{role, text});
            }
        }
        if (body.isEmpty()) {
            host.failNativeGen("这条消息是空的，写点内容再发");
            return id;
        }
        final String sysText = sys.toString();
        final String fullPrompt = buildPrompt(flatMessages);
        final String[] last = body.get(body.size() - 1);
        final boolean incremental = sessionEnabled && "user".equals(last[0]);
        synchronized (lock) {
            streamer = new LitertLmHistory.Streamer();
            firstTokenAt = 0;
            settled = false;
        }
        new Thread(() -> {
            long t0 = System.currentTimeMillis();
            try {
                ProgressListener<String> pl = (partial, done) -> {
                    String delta;
                    synchronized (lock) {
                        if (firstTokenAt == 0) firstTokenAt = System.currentTimeMillis();
                        delta = streamer.feed(partial);
                    }
                    if (delta != null) host.nativeToken(delta);
                };
                String sent = fullPrompt;
                ListenableFuture<String> fut;
                LlmInferenceSession s = incremental ? ensureSession(cur, sysText, body, o) : null;
                if (s != null) {
                    sent = last[1];
                    s.addQueryChunk(sent);
                    fut = s.generateResponseAsync(pl);
                } else {
                    fut = cur.generateResponseAsync(fullPrompt, pl);
                }
                synchronized (lock) { pending = fut; }
                String full = fut.get();
                long ms = System.currentTimeMillis() - t0;
                synchronized (lock) {
                    if (settled) return;   // 看门狗已经收过尾，别再发一次 done
                    settled = true;
                }
                int gen = 0, prompt = 0;
                try {
                    if (full != null && !full.isEmpty()) gen = Math.max(1, cur.sizeInTokens(full));
                    prompt = cur.sizeInTokens(sent);
                } catch (Throwable ignored) {
                }
                long ft = firstTokenAt;
                long firstMs = ft > 0 ? (ft - t0) : -1;
                double decodeTps = -1;
                if (gen > 0 && firstMs >= 0 && ms > firstMs) {
                    decodeTps = gen / ((ms - firstMs) / 1000.0);
                }
                if (sessionEnabled && s != null) {
                    synchronized (lock) {
                        fedSystem = sysText;
                        fedKeys.clear();
                        fedKeys.addAll(LitertLmHistory.userKeys(body));
                    }
                }
                String stats = "{\"gen\":" + gen + ",\"prompt\":" + prompt + ",\"totalMs\":" + ms
                        + ",\"prefillMs\":-1,\"firstMs\":" + firstMs
                        + ",\"decodeTps\":" + decodeTps + ",\"backend\":\"mediapipe\"}";
                host.finishNativeGen(stats);
            } catch (Throwable t) {
                synchronized (lock) { settled = true; }
                Log.w(TAG, "MediaPipe 生成失败", t);
                host.failNativeGen(String.valueOf(t));
            }
        }, "fy-mediapipe-chat").start();
        return id;
    }

    @Override
    public void stopChat() {
        LlmInferenceSession s = session;
        ListenableFuture<String> f = pending;
        try { if (s != null) s.cancelGenerateResponseAsync(); } catch (Throwable ignored) { }
        try { if (f != null) f.cancel(true); } catch (Throwable ignored) { }
        /* cancel 不保证回调一定回来：5 秒还没收尾就强制放锁，否则 nativeBusy 会永久卡住。 */
        new Thread(() -> {
            for (int i = 0; i < 50 && !settled; i++) {
                try { Thread.sleep(100); } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            synchronized (lock) {
                if (settled) return;
                settled = true;
            }
            host.failNativeGen("停下了，已收好尾");
        }, "fy-mediapipe-stop-watchdog").start();
    }

    /**
     * 跨轮 KV：前缀（system + 除最后一条用户消息外的历史）没变就复用同一个 session，
     * 只把最后一条用户消息当新 query 喂进去。任何不一致/异常都返回 null → 退回一次性 prompt。
     */
    private LlmInferenceSession ensureSession(LlmInference inf, String sysText, List<String[]> body, ChatOptions o) {
        try {
            List<String> wantPrefix = LitertLmHistory.userKeys(body.subList(0, body.size() - 1));
            synchronized (lock) {
                if (session != null && sysText.equals(fedSystem) && wantPrefix.equals(fedKeys)) {
                    return session;
                }
            }
            LlmInferenceSession.LlmInferenceSessionOptions so =
                    LlmInferenceSession.LlmInferenceSessionOptions.builder()
                            .setTopK(Math.max(1, o.topK))
                            .setTopP(o.topP)
                            .setTemperature(o.temperature)
                            .setRandomSeed(o.seed)
                            .build();
            LlmInferenceSession s = LlmInferenceSession.createFromOptions(inf, so);
            // 用"除最后一条用户消息以外"的整段 prompt 给新会话打底，随后调用方只补最后一条
            List<String[]> head = body.subList(0, body.size() - 1);
            StringBuilder seed = new StringBuilder();
            if (sysText.length() > 0) seed.append(sysText).append("\n\n");
            for (String[] m : head) {
                if ("assistant".equals(m[0])) seed.append("角色：").append(m[1]).append('\n');
                else seed.append("用户：").append(m[1]).append('\n');
            }
            if (seed.length() > 0) s.addQueryChunk(seed.toString());
            synchronized (lock) {
                closeSessionLocked();
                session = s;
                fedSystem = sysText;
                fedKeys.clear();
                fedKeys.addAll(wantPrefix);
            }
            return s;
        } catch (Throwable t) {
            Log.w(TAG, "LlmInferenceSession 建会话失败，退回一次性 prompt", t);
            return null;
        }
    }

    private void closeSession() {
        synchronized (lock) { closeSessionLocked(); }
    }

    private void closeSessionLocked() {
        LlmInferenceSession s = session;
        session = null;
        fedSystem = null;
        fedKeys.clear();
        if (s != null) {
            try { s.close(); } catch (Throwable ignored) { }
        }
    }

    /** 把 [role, content, …] 拼成一段纯文本喂给 .task（MediaPipe 只收单串 prompt）。 */
    private static String buildPrompt(String[] flat) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i + 1 < flat.length; i += 2) {
            String role = flat[i] == null ? "user" : flat[i];
            String text = flat[i + 1] == null ? "" : flat[i + 1];
            if (text.isEmpty()) continue;
            if ("system".equals(role)) sb.append(text).append("\n\n");
            else if ("assistant".equals(role)) sb.append("角色：").append(text).append('\n');
            else sb.append("用户：").append(text).append('\n');
        }
        sb.append("角色：");
        return sb.toString();
    }
}
