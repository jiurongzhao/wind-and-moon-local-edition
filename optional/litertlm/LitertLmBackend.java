package com.fy.local;

import android.util.Log;

import com.google.ai.edge.litertlm.ActivationDataType;
import com.google.ai.edge.litertlm.Backend;
import com.google.ai.edge.litertlm.BenchmarkInfo;
import com.google.ai.edge.litertlm.Content;
import com.google.ai.edge.litertlm.Contents;
import com.google.ai.edge.litertlm.Conversation;
import com.google.ai.edge.litertlm.ConversationConfig;
import com.google.ai.edge.litertlm.Engine;
import com.google.ai.edge.litertlm.EngineConfig;
import com.google.ai.edge.litertlm.Message;
import com.google.ai.edge.litertlm.MessageCallback;
import com.google.ai.edge.litertlm.ModelInfo;
import com.google.ai.edge.litertlm.Modality;
import com.google.ai.edge.litertlm.NativeLibraryLoader;
import com.google.ai.edge.litertlm.NoRepeatNgramConfig;
import com.google.ai.edge.litertlm.RepetitionPenaltyConfig;
import com.google.ai.edge.litertlm.SamplerConfig;
import com.google.ai.edge.litertlm.SuppressTokensConfig;
import com.google.ai.edge.litertlm.ThinkingConfig;

import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * 本地推理可选后端：LiteRT-LM（Google AI Edge）直跑 `.litertlm`。
 *
 * <p><b>它和 C（MediaPipe，.task）是两条不同的容器路线。</b>LiteRT-LM 只认 `.litertlm`：loader 按 magic
 * `LITERTLM` 解析，`.task` 是 PK zip，会直接报 "Invalid magic number. Expected 'LITERTLM'"。
 * 和 MediaPipe 那个 PoC 的本质区别：Conversation 自己带 KV，历史是增量喂进去的，
 * 所以长对话不用每轮重新 prefill；另外有 SamplerConfig / RepetitionPenaltyConfig 和
 * {@code cancelProcess()}，采样与"停止"都不再是黑盒。
 *
 * <p>源码放在 optional/litertlm/：只有 third_party/litertlm/（tools/fetch-litertlm.sh 产出）
 * 存在时，build.sh 才把它加进 javac/d8，并把 liblitertlm_jni.so 打进 APK；
 * MainActivity 用反射注册，默认构建没有这个类也不会炸。
 *
 * <p>与既有约定的关系（不允许退化）：
 * <ul>
 *   <li>事件形状不变：状态走 {@code pushEngineEvent}，token 走 {@code nativeToken} 合批通道；</li>
 *   <li>"去人机化"里能搬的采样项尽量搬：pen_rep/pen_freq/pen_pres/pen_n → RepetitionPenaltyConfig，
 *       topK/topP/temperature/seed → SamplerConfig；</li>
 *   <li>搬不动的（DRY / min-p / XTC / 动态温度 / GBNF）在 docs/engine-backends.md 里如实记着，
 *       靠 prompt 与可选惩罚补，别假装等价。</li>
 * </ul>
 */
public final class LitertLmBackend implements EngineBackend {

    private static final String TAG = "FyLitertLm";

    /** 只在第一次遇到 channel 时打一行 key，方便确认 thought/answer 分别叫什么。 */
    private static volatile boolean loggedChannels = false;

    /* ---------- 加载时探到的"这个模型天生会什么" ----------
     *
     * 全部来自 LiteRT-LM 自己的 ModelInfo（nativeSupportsThinking / nativeHasSpeculativeDecodingSupport），
     * 不靠模型名猜：Qwen3 支持 thinking，MTP 投机解码要求 bundle 里带 drafter（Gemma 系）。
     * 两个开关决定 ensureConversation 走 4 参还是 13 参构造 —— 不支持时行为与老版本一字不差。 */
    private volatile boolean capThinking = false;
    private volatile boolean capSpec = false;
    /** 本次加载用的是不是 GPU 委托（决定 auto 投机解码开不开）。 */
    private volatile boolean loadedGpu = false;
    /** 本次加载用的 tune 串（诊断 / appInfo 用）。 */
    private volatile String loadedTune = "";

    private final MainActivity host;

    private volatile Engine engine;
    private volatile Conversation convo;
    private volatile String state = "stopped";
    private volatile String message = "";
    private volatile String modelName = "";
    private volatile long loadMs = -1;

    /**
     * 当前 Conversation 吃过的"用户可见历史"签名：每一条非 assistant 消息（role + 内容）。
     * assistant 回复刻意不参与签名 —— 那是模型自己生成的，App 还会再加工（去 think 段、
     * 截断等），拿它做等值比较会永远对不上、每轮都重建。签名一致才续 KV。
     */
    private final List<String> sentUserKeys = new ArrayList<>();
    /** 建 Conversation 时用的 system 文本；换了人设就得重建。 */
    private String sentSystem = null;
    /** 本轮第一个 token 到达时刻（ms）。LiteRT-LM 的 BenchmarkInfo 在 sendMessageAsync 这条路上
        实测全是 0/-1，所以 TTFT 得自己量，decode tok/s 也自己算。 */
    private volatile long firstTokenAt = 0;
    /** 发这条消息之前，会话里已有的 token 数（prompt + 历史）。用来把 getTokenCount() 的
        "会话总量"拆成"本轮生成量"——实测 maxTokens=32 时总量 87、160 时 215，差正好是本轮生成。 */
    private volatile int tokensBefore = 0;
    /** 本轮是否已经收过尾（onDone/onError/看门狗三选一）。防止重复 finish 或停不下来。 */
    private volatile boolean settled = false;
    private final Object lock = new Object();

    /** 每轮重置：把"累计式"和"增量式"两种回调都压成增量（纯逻辑在 LitertLmHistory.Streamer）。 */
    private LitertLmHistory.Streamer streamer = new LitertLmHistory.Streamer();

    public LitertLmBackend(MainActivity host) {
        this.host = host;
    }

    @Override public String id() { return "litertlm"; }

    @Override public String label() { return "本机引擎 · LiteRT-LM"; }

    /** .so 没打进 APK / ABI 不符时，load() 会抛，统一吞成 false。结果缓存，别每次 available() 都 load 一遍。 */
    private static volatile Boolean runtimeOk;

    private static boolean runtimeLoads() {
        Boolean c = runtimeOk;
        if (c != null) return c;
        synchronized (LitertLmBackend.class) {
            if (runtimeOk == null) {
                boolean ok;
                try {
                    NativeLibraryLoader.INSTANCE.load();
                    ok = true;
                } catch (Throwable t) {
                    Log.w(TAG, "LiteRT-LM 运行时不可用", t);
                    ok = false;
                }
                runtimeOk = ok;
            }
            return runtimeOk;
        }
    }

    @Override public boolean available() { return runtimeLoads(); }

    @Override public boolean inProcessChat() { return true; }

    @Override public String state() { return state; }
    @Override public String message() { return message; }
    @Override public String model() { return modelName; }
    @Override public long loadMs() { return loadMs; }

    @Override public boolean active() { return engine != null && "ready".equals(state); }

    @Override public boolean generating() { return host.nativeGenerating(); }

    @Override
    public void start(final String absModelPath, final int ctx, final int threads,
                      final boolean mlock, final Runnable onStartFailed) {
        start(absModelPath, ctx, threads, mlock, null, onStartFailed);
    }

    @Override
    public void start(final String absModelPath, final int ctx, final int threads,
                      final boolean mlock, final String tune, final Runnable onStartFailed) {
        final String display = new File(absModelPath).getName();
        final String tn = tune == null ? "" : tune;
        if (display.toLowerCase().endsWith(".task")) {
            /* .task 是 MediaPipe 的容器（PK zip），LiteRT-LM 的 loader 按 LITERTLM magic 解析会直接判非法。
               早点给出可读的错误，别让用户只看到 "Invalid magic number. Expected 'LITERTLM'"。 */
            state = "error";
            message = "这个模型文件的格式不匹配，请换一个模型，或到设置里重新选运行方式";
            host.pushEngineEvent("error", message, display, true);
            return;
        }
        /* 委托方式：默认 CPU。GPU 在高通 Adreno 上被厂商 OpenCL 编译器崩过（/vendor/lib64/libllvm-qgl.so），
           所以只有调用方显式 backend=gpu / gpu=1 才开；NPU 需要先把厂商 .so 放进 nativeLibraryDir。 */
        final boolean wantGpu = "gpu".equals(LitertLmHistory.param(tn, "backend", "cpu").toLowerCase())
                || LitertLmHistory.paramBool(tn, "gpu", false);
        final boolean wantNpu = "npu".equals(LitertLmHistory.param(tn, "backend", "cpu").toLowerCase());
        final String act = LitertLmHistory.param(tn, "act", "").toLowerCase();
        state = "loading";
        message = "正在加载模型…";
        host.pushEngineEvent("loading", "正在把模型装进本机引擎…", display, true);
        new Thread(() -> {
            long t0 = System.currentTimeMillis();
            try {
                // 先收掉别的引擎：两份模型同时驻留会把内存挤爆（llama-server 尤其明显）
                host.engine().stop();
                /* 万一调用方绕过 Bridge 的"生成中不许换模型"检查，直接 start：
                   关掉正在被推理线程用的 Conversation，回调就永远不回来、nativeBusy 卡死。
                   这里先取消并等它收尾（看门狗 5 秒兜底），最多等 4 秒。 */
                if (generating()) {
                    stopChat();
                    for (int i = 0; i < 40 && generating(); i++) {
                        try {
                            Thread.sleep(100);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            break;
                        }
                    }
                }
                closeQuietly();
                /* 后端：只用 CPU。
                   GPU 路试过了，结论是**不能开**：官方带 GPU 图优化的 dynamic-int4 变体
                   在 Redmi Turbo 3（Snapdragon 8s Gen 3 / Adreno）上直接让进程 SIGSEGV——
                   栈在厂商 OpenCL 编译器里：/vendor/lib64/libllvm-qgl.so。
                   Java 层 try/catch 拦不住 native crash，App 会当场死掉，这比慢更要命。
                   所以 GPU 不做默认；等 Google/高通修了编译器，或者只在确认可用的机型上开。 */
                /* 先探模型能力（thinking / 投机解码 / 支持哪些委托）。ModelInfo 是原生读 bundle，
                   .task 或格式不对时可能抛，一律吞掉、退回"什么都不知道"的安全默认。 */
                boolean supThink = false, supSpec = false;
                String miLog = "";
                try {
                    ModelInfo mi = ModelInfo.Companion.from(absModelPath);
                    if (mi instanceof ModelInfo.Llm) {
                        ModelInfo.Llm llm = (ModelInfo.Llm) mi;
                        supThink = llm.supportsThinking();
                        supSpec = llm.hasSpeculativeDecodingSupport();
                    }
                    try {
                        miLog = "maxCtx=" + mi.maxContextTokens()
                                + " backends=" + mi.supportedBackends(Modality.TEXT)
                                + " soc=" + mi.socName(Modality.TEXT)
                                + " npu=" + mi.npuBrand(Modality.TEXT);
                    } catch (Throwable ignored) {
                    }
                } catch (Throwable mt) {
                    Log.w(TAG, "ModelInfo 探测失败（按 CPU/无思考/无投机 的安全默认跑）", mt);
                }
                capThinking = supThink;
                capSpec = supSpec;
                loadedGpu = wantGpu;
                loadedTune = tn;
                Log.i(TAG, "模型能力 thinking=" + supThink + " spec=" + supSpec + " " + miLog);

                Backend main;
                if (wantGpu) {
                    Log.w(TAG, "按 tune 显式启用 GPU 委托：部分 Adreno 驱动会在 OpenCL 编译器里崩，风险自担");
                    main = new Backend.GPU();
                } else if (wantNpu) {
                    main = new Backend.NPU(host.getApplicationInfo().nativeLibraryDir);
                } else {
                    main = new Backend.CPU(Math.max(1, threads), null);
                }
                Engine e = new Engine(engineConfig(absModelPath, main, ctx, act));
                e.initialize();
                synchronized (lock) {
                    engine = e;
                    sentUserKeys.clear();
                    sentSystem = null;
                }
                modelName = display;
                loadMs = System.currentTimeMillis() - t0;
                state = "ready";
                /* 标签按"这次实际会不会用"来写，而不是按模型能力 —— 否则 spec=off 也会显示"已开"。 */
                LitertLmHistory.ConvPlan readyPlan = LitertLmHistory.conversationPlan(
                        display, supThink, supSpec, wantGpu, tn);
                StringBuilder tags = new StringBuilder();
                if (readyPlan.extraEnableThinking) tags.append("，已关思考");
                if (Boolean.TRUE.equals(readyPlan.speculative)) tags.append("，已启用加速");
                if (wantGpu) tags.append("，GPU 加速");
                else if (wantNpu) tags.append("，NPU 加速");
                message = "本机引擎就绪（加载 " + (loadMs / 1000.0) + " 秒" + tags + "）";
                host.pushEngineEvent("ready", message, modelName, true);
            } catch (Throwable t) {
                Log.w(TAG, "LiteRT-LM 加载失败", t);
                loadMs = -1;
                state = "stopped";
                closeQuietly();
                host.pushEngineEvent("error", "本机引擎没能加载，请回设置页重新选一次模型", display, true);
                if (onStartFailed != null) onStartFailed.run();
            }
        }, "fy-litertlm-load").start();
    }

    @Override
    public void stop() {
        boolean was = active() || "loading".equals(state);
        closeQuietly();
        state = "stopped";
        message = "";
        if (was) host.pushEngineEvent("stopped", "已手动停止", modelName, true);
    }

    @Override public void unload() { stop(); }

    @Override
    public String chat(String[] flat, ChatOptions o) {
        final Engine e = engine;
        if (e == null) return null;
        final String id = host.beginNativeGen();
        if (id == null) return null;

        StringBuilder sys = new StringBuilder();
        List<String[]> body = new ArrayList<>();
        for (int i = 0; i + 1 < flat.length; i += 2) {
            String role = flat[i] == null ? "user" : flat[i];
            String text = flat[i + 1] == null ? "" : flat[i + 1];
            if (text.isEmpty()) continue;
            if ("system".equals(role)) {
                if (sys.length() > 0) sys.append('\n');
                sys.append(text);
            } else {
                body.add(new String[]{role, text});
            }
        }
        if (body.isEmpty()) {
            host.failNativeGen("没有可发送的消息");
            return id;
        }

        final String sysText = sys.toString();
        final String[] last = body.get(body.size() - 1);
        final List<String[]> init = new ArrayList<>(body.subList(0, body.size() - 1));
        /* 惩罚项：能映射的都映射，映射不了的在 docs/engine-backends.md 记着。
           两个配置都给实例、不给 null —— Kotlin 那边的参数是不是可空没法在 Termux 里验，
           给"空配置"最坏也只是不额外惩罚，不会 NPE。 */
        final LitertLmHistory.Penalties pen = LitertLmHistory.parsePenalties(o.sampler);
        final RepetitionPenaltyConfig rep = pen.any()
                ? new RepetitionPenaltyConfig(pen.repetition, pen.presence, pen.frequency, pen.window)
                : new RepetitionPenaltyConfig();
        final int ngramSize = LitertLmHistory.noRepeatNgram(o.sampler);

        synchronized (lock) {
            streamer = new LitertLmHistory.Streamer();
            firstTokenAt = 0;
            settled = false;
        }
        new Thread(() -> {
            long t0 = System.currentTimeMillis();
            try {
                Conversation c = ensureConversation(sysText, init, o);
                // 发之前的会话大小 = 这条消息的 prefill 量；发完减去它就是本轮生成量
                tokensBefore = c.getTokenCount();
                synchronized (lock) {
                    // 记下这条（assistant 不记）：下一轮历史没变就继续用同一个 Conversation 的 KV
                    if (!"assistant".equals(last[0])) sentUserKeys.add(LitertLmHistory.key(last[0], last[1]));
                }
                MessageCallback cb = new MessageCallback() {
                    @Override public void onMessage(Message m) {
                        String delta;
                        synchronized (lock) {
                            if (firstTokenAt == 0) firstTokenAt = System.currentTimeMillis();
                            delta = streamer.feed(textOf(m));
                        }
                        if (delta != null) host.nativeToken(delta);
                    }

                    @Override public void onDone() {
                        settled = true;
                        host.finishNativeGen(statsOf(t0));
                    }

                    @Override public void onError(Throwable t) {
                        settled = true;
                        host.failNativeGen("这次回答没能生成，请重新发送");
                    }
                };
                /* 可选配置一律给实例、不给 null：能构造"空配置"就不赌 Kotlin 的可空性。
                   - ngram：DRY 开了才带 dryAllowedLength，否则空配置（=不启用）；
                   - suppress：空列表（=不额外压 token）；
                   - maxOutputToken：把前端 maxTokens 真正接上 —— 之前接的是短重载，
                     真机实测设了 160 却生成了 300 个 token。 */
                NoRepeatNgramConfig ngram = ngramSize > 0
                        ? new NoRepeatNgramConfig(ngramSize)
                        : new NoRepeatNgramConfig();
                c.sendMessageAsync(last[1], cb, Collections.emptyMap(), rep, ngram,
                        new SuppressTokensConfig(Collections.emptyList()),
                        o.maxTokens > 0 ? o.maxTokens : null);
            } catch (Throwable t) {
                Log.w(TAG, "LiteRT-LM 生成失败", t);
                host.failNativeGen(String.valueOf(t));
            }
        }, "fy-litertlm-chat").start();
        return id;
    }

    @Override
    public void stopChat() {
        Conversation c = convo;
        if (c != null) {
            try {
                c.cancelProcess();
            } catch (Throwable ignored) {
            }
        }
        /* 看门狗：cancelProcess 只是"请求取消"，不保证回调一定回来（真机实测踩过：
           引擎在生成中途被换掉，onDone/onError 永远不来，nativeBusy 卡死，之后所有
           聊天都报"上一轮还在生成"，只能重启 App）。5 秒还没收尾就强制放锁。 */
        new Thread(() -> {
            for (int i = 0; i < 50 && !settled; i++) {
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            if (!settled) {
                settled = true;
                host.failNativeGen("停下了，已收好尾");
            }
        }, "fy-litertlm-stop-watchdog").start();
    }

    // ---------- 内部 ----------

    /**
     * 造 EngineConfig。vision / audio 必须传 null：纯文本模型里没有 audio/vision 编码器，
     * 塞一个 CPU 后端进去会在 createConversation 时炸 "tf_lite_audio_encoder_hw not found"。
     * 带 maxNumTokens 的构造一旦抛（Kotlin 参数可空性没法静态确认），退回最简构造。
     */
    private static EngineConfig engineConfig(String path, Backend backend, int ctx, String act) {
        ActivationDataType adt = null;
        if ("f16".equals(act) || "float16".equals(act)) adt = ActivationDataType.FLOAT16;
        else if ("int8".equals(act)) adt = ActivationDataType.INT8;
        else if ("int16".equals(act)) adt = ActivationDataType.INT16;
        else if ("f32".equals(act) || "float32".equals(act)) adt = ActivationDataType.FLOAT32;
        try {
            if (adt != null) {
                return new EngineConfig(path, backend, null, null,
                        ctx > 0 ? ctx : 4096, null, null, adt);
            }
            return new EngineConfig(path, backend, null, null, ctx > 0 ? ctx : 4096);
        } catch (Throwable t) {
            Log.w(TAG, "带 maxNumTokens/激活类型的 EngineConfig 构造失败，退回默认", t);
            return new EngineConfig(path, backend);
        }
    }

    /**
     * 拿到一个"历史已经准备好"的 Conversation。
     *
     * <p>复用条件（两个都满足才复用，KV 才敢接着用）：
     * <ul>
     *   <li>system 文本没变；</li>
     *   <li>非 assistant 历史签名完全一致 —— 用户没改设定、没删/改历史、没换角色。</li>
     * </ul>
     * 只要有一条不满足就重建，并把"除最后一条以外"的全部历史作为 initialMessages 预填充，
     * 保证语义正确优先于省一次 prefill。
     */
    private Conversation ensureConversation(String sysText, List<String[]> init, ChatOptions o) {
        synchronized (lock) {
            List<String> want = LitertLmHistory.userKeys(init);
            if (convo != null && sysText.equals(sentSystem) && sentUserKeys.equals(want)) {
                return convo;
            }
            closeConversationQuietly();
            List<Message> msgs = new ArrayList<>();
            for (String[] mm : init) msgs.add(toMessage(mm));
            Contents system = Contents.Companion.of(sysText == null ? "" : sysText);
            SamplerConfig sc = new SamplerConfig(Math.max(1, o.topK), o.topP, o.temperature, o.seed);
            /* 决策全在 LitertLmHistory.conversationPlan（纯逻辑、JVM 可测）：
               thinking 走 ThinkingConfig + extraContext 两条路，spec 只有带 drafter 才敢开。 */
            LitertLmHistory.ConvPlan plan =
                    LitertLmHistory.conversationPlan(modelName, capThinking, capSpec, loadedGpu, loadedTune);
            Map<String, Object> extra = new java.util.HashMap<>();
            if (plan.extraEnableThinking) extra.put("enable_thinking", Boolean.FALSE);
            ThinkingConfig think = plan.useThinkingConfig ? new ThinkingConfig(false) : null;
            Boolean spec = plan.speculative;
            Conversation c;
            if (plan.extended) {
                /* tools/channels 必须传 null = 用 bundle 自带默认配置。
                   绝不能传空列表：文档明确 "If empty, channels will be disabled"，
                   那会把 thought/正文的 channel 分割一起关掉。 */
                /* tools 必须给非空列表（Kotlin 参数非空，传 null 直接 NPE）；channels 传 null 才是"用默认"，
                   传空列表会禁用 channel。extraContext 也必须非空。 */
                ConversationConfig cfg = new ConversationConfig(system, msgs, Collections.emptyList(), sc,
                        false, null, extra, null, false, null, think, false, spec);
                c = engine.createConversation(cfg);
            } else {
                ConversationConfig cfg = new ConversationConfig(system, msgs, Collections.emptyList(), sc);
                c = engine.createConversation(cfg);
            }
            convo = c;
            sentSystem = sysText;
            sentUserKeys.clear();
            sentUserKeys.addAll(want);
            return c;
        }
    }

    private static Message toMessage(String[] m) {
        if ("assistant".equals(m[0])) return Message.Companion.model(m[1]);
        return Message.Companion.user(m[1]);
    }

    private static String textOf(Message m) {
        if (m == null) return "";
        StringBuilder sb = new StringBuilder();
        if (m.getContents() != null) {
            for (Content c : m.getContents().getContents()) {
                if (c instanceof Content.Text) sb.append(((Content.Text) c).getText());
            }
        }
        /* 有些导出（实测 Qwen3-0.6B dynamic-int4）把内容放进命名 channel，contents 是空的：
           只读 contents 会一个字都收不到、但 done 照常触发，很难查。这里兜底把 channel 值接上。 */
        if (sb.length() == 0) {
            try {
                java.util.Map<String, String> ch = m.getChannels();
                if (ch != null && !ch.isEmpty()) {
                    if (!loggedChannels) {
                        loggedChannels = true;
                        Log.i(TAG, "message 走 channel：" + ch.keySet());
                    }
                    for (String v : ch.values()) {
                        if (v != null) sb.append(v);
                    }
                }
            } catch (Throwable ignored) {
            }
        }
        return sb.toString();
    }

    private String statsOf(long t0) {
        long totalMs = System.currentTimeMillis() - t0;
        int gen = 0, prompt = 0;
        double decodeTps = -1, prefillTps = -1, firstMs = -1;
        try {
            Conversation c = convo;
            if (c != null) {
                /* getTokenCount() 是"会话总量"。有发前快照就减一下，得到真实的本轮生成数；
                   新会话（before=0）没有参照，只能报总量（偏高）。 */
                int total = c.getTokenCount();
                int before = tokensBefore;
                if (before > 0) {
                    gen = Math.max(0, total - before);
                    prompt = before;
                } else {
                    gen = total;
                }
                BenchmarkInfo b = c.getBenchmarkInfo();
                if (b != null) {
                    int bp = b.getLastPrefillTokenCount();
                    double bd = b.getLastDecodeTokensPerSecond();
                    double bpf = b.getLastPrefillTokensPerSecond();
                    double bf = b.getTimeToFirstTokenInSecond() * 1000.0;
                    if (bp > 0) prompt = bp;
                    if (bd > 0) decodeTps = bd;
                    if (bpf > 0) prefillTps = bpf;
                    if (bf > 0) firstMs = bf;
                }
            }
        } catch (Throwable ignored) {
        }
        /* 兜底：BenchmarkInfo 在 sendMessageAsync 路径上实测给不出值（全 0/-1），
           用自己量的第一个 token 时刻算 TTFT 和 decode tok/s。decode 用"首 token 之后"的
           时间窗口 —— 把 prefill 剔出去，不然长 prompt 会把 decode 速率压得很难看。 */
        long ft = firstTokenAt;
        if (firstMs < 0 && ft > 0) firstMs = ft - t0;
        if (decodeTps <= 0 && gen > 0 && firstMs >= 0 && totalMs > firstMs) {
            decodeTps = gen / ((totalMs - firstMs) / 1000.0);
        }
        JSONObject o = new JSONObject();
        try {
            o.put("gen", gen);
            o.put("prompt", prompt);
            o.put("totalMs", totalMs);
            o.put("prefillMs", -1);
            o.put("firstMs", firstMs < 0 ? -1 : Math.round(firstMs));
            o.put("prefillTps", prefillTps);
            o.put("decodeTps", decodeTps);
            o.put("backend", "litertlm");
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    private void closeConversationQuietly() {
        Conversation c = convo;
        convo = null;
        sentUserKeys.clear();
        sentSystem = null;
        if (c != null) {
            try {
                c.close();
            } catch (Throwable ignored) {
            }
        }
    }

    private void closeQuietly() {
        synchronized (lock) {
            closeConversationQuietly();
            Engine e = engine;
            engine = null;
            if (e != null) {
                try {
                    e.close();
                } catch (Throwable ignored) {
                }
            }
        }
    }
}
