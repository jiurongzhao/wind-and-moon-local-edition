package com.fy.local;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * 风月·本地版 —— 单机 AI 角色扮演 App。
 *
 * 结构：
 *   AssetServer（本地 http 静态服务器）→ 给 WebView 一个真实 origin
 *   Engine（llama-server 子进程）      → 本地推理
 *   Speech（系统 TTS / 语音识别）      → 朗读与语音输入
 *   Bridge（window.FY）                → 前端调用原生能力的唯一入口
 */
public class MainActivity extends Activity {

    private static final String TAG = "FY";
    private static final int REQ_FILE = 1001;
    private static final int REQ_MIC = 1002;
    private static final int REQ_NOTIF = 1003;
    private static final int REQ_CARD = 1004;
    private static final int REQ_BACKUP = 1005;

    private WebView web;
    private AssetServer server;
    private Engine engine;
    /**
     * 进程内推理后端注册表（jni / onnx / java…）。
     * 子进程 server 不进这张表：聊天走 HTTP，前端用 native=false 分辨，见 EngineRegistry 注释。
     */
    private EngineRegistry registry;
    private ModelStore models;
    private Speech speech;
    private volatile boolean uiReady = false;
    private boolean notifAsked = false;
    /**
     * 引擎日志合批：加载模型时 llama.cpp 会连打几十上百行，逐行走一次 evaluateJavascript
     * 会把 WebView 拖卡（而且日志窗口那边也只是往数组里 push）。
     * 现在按「150ms 或 64 行」合批，一次推一个 lines 数组；前端两种格式都认。
     */
    private final java.util.ArrayList<String> logQueue = new java.util.ArrayList<>();
    private boolean logFlushScheduled = false;
    private final android.os.Handler logHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());
    /** 推理期间的 CPU 唤醒锁（见 keepScreenOn） */
    private android.os.PowerManager.WakeLock inferWake;

    /* ---------- 进程内（JNI）引擎 ----------
     *
     * 和 Engine.java（fork llama-server + localhost HTTP）互为备份。
     * 进程内没有子进程、没有端口、没有 /health 轮询，KV 缓存归自己管，
     * 所以"静态前缀常驻"是可以保证的，而不是求服务端命中。
     * state 取值刻意和子进程那套一样，前端不用分叉。
     */
    private volatile String natState = "stopped";
    private volatile String natMessage = "";
    private volatile String natModel = "";
    private volatile long natLoadMs = -1;
    private volatile boolean natActive = false;

    /** 流式输出的合批缓冲（理由同引擎日志：逐 token 走一次 evaluateJavascript 会把 WebView 拖卡）。 */
    private final StringBuilder genBuf = new StringBuilder();
    private long genLastFlush = 0;
    private volatile String genId = "";
    /** 同一时刻只允许一轮原生生成：llama_context 不是可重入的，并发进去就是崩。 */
    private final java.util.concurrent.atomic.AtomicBoolean nativeBusy =
            new java.util.concurrent.atomic.AtomicBoolean(false);

    /* ---------- 调试用无头测试入口的状态（只 debug 构建注册） ---------- */
    private final Object devLock = new Object();
    private final StringBuilder devTokens = new StringBuilder();
    private volatile boolean devCapturing = false;
    private volatile String devStats = "";
    private volatile String devErr = "";
    private android.content.BroadcastReceiver devReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        engine = new Engine(this, new Engine.Listener() {
            @Override
            public void onState(String state, String message) {
                flushEngineLogs();   // 先推日志再推状态，否则日志窗口里顺序会乱
                JSONObject o = new JSONObject();
                try {
                    o.put("state", state);
                    o.put("message", message);
                    o.put("port", engine.getPort());
                    o.put("model", engine.getCurrentModel());
                } catch (Exception ignored) {
                }
                pushEvent("engine", o);
                // 引擎在跑就挂前台服务，别让系统把进程冻住（真机实测的坑，见 FyService 注释）
                syncEngineService(state, message);
                // 引擎到了关键状态就把诊断落盘（只在调试构建里自动做；发布版按需手动导出）
                if (isDevBuild() && ("ready".equals(state) || "error".equals(state))) {
                    writeDiagnostics();
                }
            }

            @Override
            public void onLog(String line) {
                boolean flushNow;
                synchronized (logQueue) {
                    logQueue.add(line);
                    flushNow = logQueue.size() >= 64;
                    if (!flushNow && !logFlushScheduled) {
                        logFlushScheduled = true;
                        logHandler.postDelayed(MainActivity.this::flushEngineLogs, 150);
                    }
                }
                if (flushNow) flushEngineLogs();
            }
        });

        models = new ModelStore(this);

        /* 进程内引擎注册进后端表。以后 B（纯 Java）/ C（ONNX）就是在这里多注册一行，
           Bridge 的调度与前端分叉都不用动。 */
        registry = new EngineRegistry();
        registry.register(new JniEngineBackend(this));
        /* 本地推理单栈：LiteRT-LM。源码在 optional/litertlm/，只有 third_party/litertlm/ 存在时
           才编得进来；反射注册，默认构建没有这个类也不会炸。 */
        try {
            Class<?> lm = Class.forName("com.fy.local.LitertLmBackend");
            registry.register((EngineBackend) lm.getDeclaredConstructor(MainActivity.class).newInstance(this));
        } catch (Throwable ignored) {
            // 默认构建没带 LiteRT-LM：正常路径
        }
        /* B / C 两条路：调研过、结论写进 docs/engine-backends.md，这一版只"留位"：
           available()=false → 设置页显示「不可用」并禁用，启动引擎时自动兜底子进程。 */
        registry.register(new PlaceholderBackend("java", "纯 Java 方式",
                "这版还不支持：实测在手机上太慢"));
        registry.register(new PlaceholderBackend("onnx", "另一套模型格式",
                "这版还不支持：要换一套模型文件，手机上也太慢"));
        /* C 路线的真后端：源码在 optional/mediapipe/，只有 third_party/mediapipe/ 存在时
           build.sh 才编进来。反射注册，默认构建没有这个类也不会炸。 */
        try {
            Class<?> mp = Class.forName("com.fy.local.MediaPipeBackend");
            registry.register((EngineBackend) mp.getDeclaredConstructor(MainActivity.class).newInstance(this));
        } catch (Throwable ignored) {
            // 默认构建没有 MediaPipe：正常路径
        }

        /* 调试构建额外注册一个无头测试广播：让真机测试不用抢用户屏幕（见 registerDevReceiver）。 */
        if (isDevBuild()) {
            try { registerDevReceiver(); } catch (Throwable t) { Log.w(TAG, "dev 入口注册失败", t); }
            /* 光有广播接收器不够：HyperOS 的 Greezer 会把 cached 进程冻住、直接拒发广播
               （dumpsys 里能看到 "Greezer Denial"）。所以调试构建一启动就把前台服务立起来，
               进程变成 foreground-service 级别，切到别的 App 也不会被冻，无头测试才收得到。
               startForegroundService 在 App 前台时是允许的；服务自己 onCreate 里马上 startForeground。 */
            startFyService();
        }

        // 启动就自检一次引擎（跑 --version，不加载模型），结果写进日志和 appInfo，
        // 万一真机上拉不起来，调试页能直接看到断在哪一步。
        engine.selfCheck();

        /* 进程内引擎的流式回调：token 由 C 侧直接回调到 Java（不经过 HTTP、不经过子进程），
           这里只做合批与转发。onDone 不发事件 —— 统计信息由发起生成的那次 Bridge 调用统一收口，
           否则完成信号会来两次。
           整段包在 try 里：万一 .so 没打进来，加载失败也不该让 App 起不来（engineStatus
           报 native:false，前端自动走子进程那条路）。 */
        try {
            NativeEngine.setListener(new NativeEngine.Listener() {
                @Override
                public void onToken(String piece) {
                    onNativeToken(piece);
                }

                @Override
                public void onDone(String stats) {
                }

                @Override
                public void onProgress(int done, int total) {
                    onNativeProgress(done, total);
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "进程内引擎不可用，将使用子进程引擎", t);
        }

        // 调试构建才自动把诊断报告写到 Download/（这样即使 adb 掉线也能读到内部情况）。
        // 发布版不自动落盘任何设备信息，用户要反馈时在调试页点「导出诊断」即可。
        if (isDevBuild()) {
            new android.os.Handler(android.os.Looper.getMainLooper())
                    .postDelayed(this::writeDiagnostics, 5000);
        }

        speech = new Speech(this, new Speech.Events() {
            @Override
            public void onStt(String text, boolean isFinal) {
                JSONObject o = new JSONObject();
                try {
                    o.put("text", text);
                    o.put("final", isFinal);
                } catch (Exception ignored) {
                }
                pushEvent("stt", o);
            }

            @Override
            public void onTts(String state) {
                JSONObject o = new JSONObject();
                try {
                    o.put("state", state);
                } catch (Exception ignored) {
                }
                pushEvent("tts", o);
            }
        });

        web = new WebView(this);
        /* 发布版必须关掉 WebView 调试端口：debuggable=true 时系统会自动打开它，
           Chrome DevTools 能直接连进来读页面、调原生桥。这里显式按构建类型决定，
           别依赖系统默认值。 */
        boolean devBuild = isDevBuild();
        try {
            WebView.setWebContentsDebuggingEnabled(devBuild);
        } catch (Throwable ignored) {
        }
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 允许页面(http://127.0.0.1)访问本机 http 推理端口，避免被当作混合内容拦掉
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(TAG, "[web] " + m.message() + " @" + m.lineNumber());
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(this), "FY");
        web.setBackgroundColor(0xFF0E0D12);

        setContentView(web);

        try {
            /* dev 构建额外放行 http://127.0.0.1 的 /fetch（本地镜像联调用）；
               发布版 devBuild=false，仍然只允许 https 外域。 */
            server = new AssetServer(getAssets(), getApplicationContext(),
                    AssetServer.DEFAULT_MAX_FETCH_BYTES, devBuild);
            int port = server.start();
            web.loadUrl("http://127.0.0.1:" + port + "/index.html");
            Log.i(TAG, "已加载前端 http://127.0.0.1:" + port + "/index.html");
        } catch (Exception e) {
            Log.e(TAG, "资源服务器启动失败", e);
            Toast.makeText(this, "界面资源没能加载，请重启应用后再试", Toast.LENGTH_LONG).show();
        }

        // 麦克风权限改成惰性申请：点语音输入时才要（发布审核不喜欢"一启动就索权"）。
        // 见 Bridge.startListening()。
    }

    /** 是否调试构建（debuggable）。发布版靠它关掉调试能力与自动落盘。 */
    public boolean isDevBuild() {
        try {
            return (getApplicationInfo().flags
                    & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        } catch (Throwable t) {
            return false;
        }
    }

    // ---------- 前端事件推送 ----------

    /** 从任意线程把事件推给前端。 */
    /** 把攒着的引擎日志一次性推给前端。线程安全（pushEvent 内部自己 runOnUiThread）。 */
    private void flushEngineLogs() {
        java.util.ArrayList<String> batch;
        synchronized (logQueue) {
            if (logQueue.isEmpty()) {
                logFlushScheduled = false;
                return;
            }
            batch = new java.util.ArrayList<>(logQueue);
            logQueue.clear();
            logFlushScheduled = false;
        }
        JSONObject o = new JSONObject();
        try {
            o.put("lines", new org.json.JSONArray(batch));
        } catch (Exception ignored) {
        }
        pushEvent("log", o);
    }

    public void pushEvent(final String name, final JSONObject payload) {
        final String js = "window.fyEvent && window.fyEvent(" + JSONObject.quote(name) + ","
                + (payload == null ? "{}" : payload.toString()) + ");";
        runOnUiThread(() -> {
            if (web != null) {
                try {
                    web.evaluateJavascript(js, null);
                } catch (Exception e) {
                    Log.w(TAG, "推送事件失败: " + e);
                }
            }
        });
    }

    // ---------- 给 Bridge 用的访问器 ----------

    public Engine engine() {
        return engine;
    }

    public ModelStore models() {
        return models;
    }

    public Speech speech() {
        return speech;
    }

    public AssetServer assetServer() {
        return server;
    }

    // ---------- 进程内（JNI）引擎：状态与流式转发 ----------

    public String natState() {
        return natState;
    }

    public String natMessage() {
        return natMessage;
    }

    public String natModel() {
        return natModel;
    }

    public long natLoadMs() {
        return natLoadMs;
    }

    public boolean natActive() {
        return natActive;
    }

    /** 有没有一轮原生生成正在跑（llama_context 不可重入，换模型前要问一句）。 */
    public boolean nativeGenerating() {
        return nativeBusy.get();
    }

    // ---------- 推理后端注册表（"留门"） ----------

    /** 全部进程内后端（按注册顺序）。 */
    public EngineRegistry backends() {
        return registry;
    }

    /** 按 id 取后端；没注册过返回 null（调用方据此回退到子进程 server）。 */
    public EngineBackend backend(String id) {
        return registry == null ? null : registry.get(id);
    }

    /** 当前在跑 / 正在起的进程内后端，engineStatus 报的就是它。 */
    public EngineBackend activeInProcessBackend() {
        return registry == null ? null : registry.active();
    }

    /** 聊天该用哪个进程内后端。 */
    public EngineBackend inProcessBackendForChat() {
        return registry == null ? null : registry.forChat();
    }

    /**
     * 放弃进程内引擎（回退子进程时用）。
     * 只清状态、不推事件：回退时推一条"已停止"会让前端先闪一下 stopped，
     * 子进程引擎紧接着又会推 starting —— 白闪一次。
     */
    public void nativeReset() {
        natState = "stopped";
        natMessage = "";
        natActive = false;
    }

    /**
     * 停止并释放进程内引擎。
     *
     * 不能 stop() 完立刻 unload()：如果还有一轮生成在跑，free 掉 context 而推理线程还在用它 = 崩。
     * stop() 之后那一轮最多再走一两个 token 就退出，所以等它退干净（最多 5 秒）再释放；
     * 释放放后台线程，别卡住调用方（可能是 onDestroy，也可能是点"停止引擎"）。
     */
    public void shutdownNativeEngine() {
        try {
            NativeEngine.stop();
        } catch (Throwable ignored) {
            // .so 没装进来时 stop() 就会抛；这时候也没什么可释放的
        }
        new Thread(() -> {
            for (int i = 0; i < 100 && nativeBusy.get(); i++) {
                try {
                    Thread.sleep(50);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            try {
                NativeEngine.unload();
            } catch (Throwable ignored) {
            }
        }, "fy-native-unload").start();
    }

    /**
     * 只往前端推一条引擎状态事件，**不动**原生状态机。
     *
     * 回退子进程时的提示必须走这条：如果用 nativePush("loading", …) 顺手把 natState 也设成
     * loading，engineStatus() 就会一直报原生状态，前端永远看不到子进程引擎的真实状态
     * （真机上踩过一次：引擎明明已经用子进程起来了，状态栏还停在进程内引擎的 loading）。
     */
    public void pushEngineEvent(String state, String message, String model, boolean isNative) {
        JSONObject o = new JSONObject();
        try {
            o.put("state", state);
            o.put("message", message == null ? "" : message);
            o.put("model", model == null ? "" : model);
            o.put("port", 0);
            o.put("native", isNative);
        } catch (Exception ignored) {
        }
        pushEvent("engine", o);
        syncEngineService(state, message);
    }

    /** 推一条原生引擎状态（会更新状态机）。事件形状和 Engine.Listener.onState 那套一致，前端不用分叉。 */
    public void nativePush(String state, String message, String model, long loadMs) {
        natState = state;
        natMessage = message == null ? "" : message;
        if (model != null && !model.isEmpty()) natModel = model;
        if (loadMs >= 0) natLoadMs = loadMs;
        if ("ready".equals(state)) natActive = true;
        if ("stopped".equals(state) || "error".equals(state)) natActive = false;
        pushEngineEvent(state, natMessage, natModel, true);
        if (isDevBuild() && ("ready".equals(state) || "error".equals(state))) writeDiagnostics();
    }

    /** 开一轮原生生成：抢到"生成中"这把锁才返回 id，否则返回 null（调用方应当拒绝这次请求）。 */
    public String beginNativeGen() {
        if (!nativeBusy.compareAndSet(false, true)) return null;
        synchronized (genBuf) {
            genBuf.setLength(0);
        }
        genLastFlush = 0;
        genId = "g" + System.currentTimeMillis();
        return genId;
    }

    /** 放开"生成中"锁。 */
    public void endNativeGen() {
        nativeBusy.set(false);
    }

    /** 原生侧预填充每推进一块调一次：给前端看门狗续命，别把长 prefill 当成卡死。 */
    private void onNativeProgress(int done, int total) {
        JSONObject o = new JSONObject();
        try {
            o.put("id", genId);
            o.put("state", "progress");
            o.put("done", done);
            o.put("total", total);
        } catch (Exception ignored) {
        }
        pushEvent("gen", o);
    }

    /** 给其它进程内后端（如 MediaPipe）推 token 用：和 JNI 那条共用同一套合批/事件。 */
    public void nativeToken(String piece) {
        onNativeToken(piece);
    }

    /** 原生侧每出一个 token 调一次（在推理线程上，所以只碰锁和 pushEvent）。 */
    private void onNativeToken(String piece) {
        synchronized (genBuf) {
            genBuf.append(piece);
        }
        if (devCapturing) {
            synchronized (devLock) { devTokens.append(piece); }
        }
        flushNativeGen(false);
    }

    /** 把攒着的 token 合批推给前端。force=true 用于一轮结束时把尾巴推干净。 */
    public void flushNativeGen(boolean force) {
        String out = null;
        synchronized (genBuf) {
            if (genBuf.length() > 0) {
                long now = android.os.SystemClock.uptimeMillis();
                if (force || genBuf.length() >= 24 || now - genLastFlush >= 60) {
                    out = genBuf.toString();
                    genBuf.setLength(0);
                    genLastFlush = now;
                }
            }
        }
        if (out == null) return;
        JSONObject o = new JSONObject();
        try {
            o.put("id", genId);
            o.put("state", "delta");
            o.put("delta", out);
        } catch (Exception ignored) {
        }
        pushEvent("gen", o);
    }

    /** 一轮生成正常结束：把尾巴推干净，再发 done（带统计）。 */
    public void finishNativeGen(String statsJson) {
        flushNativeGen(true);
        boolean err = statsJson != null && statsJson.contains("\"error\"");
        JSONObject o = new JSONObject();
        try {
            o.put("id", genId);
            o.put("state", err ? "error" : "done");
            if (err) o.put("message", nativeErrorMessage(statsJson));
            else o.put("stats", new JSONObject(statsJson == null || statsJson.isEmpty() ? "{}" : statsJson));
        } catch (Exception ignored) {
        }
        if (devCapturing) {
            synchronized (devLock) { devStats = statsJson == null ? "" : statsJson; }
        }
        pushEvent("gen", o);
        endNativeGen();
    }

    /** 原生侧的错误可能只有一句英文（如 engine not loaded），这里翻成人话再给前端。 */
    private static String nativeErrorMessage(String statsJson) {
        String detail = null;
        try {
            detail = new JSONObject(statsJson).optString("error", "");
        } catch (Exception ignored) {
        }
        if (detail != null && detail.contains("engine not loaded")) {
            return "模型还没加载好，请回设置页重新选一次模型";
        }
        return "这次回答没能生成，请重新发送";
    }

    /** 一轮生成以异常告终（nativeChat 抛出来，或者压根没起来）。 */
    public void failNativeGen(String message) {
        flushNativeGen(true);
        JSONObject o = new JSONObject();
        try {
            o.put("id", genId);
            o.put("state", "error");
            o.put("message", message == null ? "这次回答没能生成，请重新发送" : message);
        } catch (Exception ignored) {
        }
        if (devCapturing) {
            synchronized (devLock) { devErr = message == null ? "error" : message; }
        }
        pushEvent("gen", o);
        endNativeGen();
    }

    // ---------- 调试用无头测试入口（只 debug 构建注册） ----------
    /* WebView CDP 只在 Activity 前台时才有 target，测试会抢用户屏幕。这里注册一个导出广播：
       进程活着（测试期间用前台服务保活）时，就能在后台加载模型 / 跑一轮对话，把结果写到
       files/devtest/result.json，测试脚本用 run-as 读 —— 用户可以用别的 App，不受打扰。
       命令：
         am broadcast -a com.fy.local.DEVTEST --es cmd load  --es id litertlm --es model X \
            --ei ctx 4096 --ei threads 4 --es tune thinking=off
         am broadcast -a com.fy.local.DEVTEST --es cmd chat --es id litertlm --ei maxTokens 160 \
            --es messages '[{"role":"system","content":"..."},{"role":"user","content":"..."}]' */

    private void registerDevReceiver() {
        devReceiver = new android.content.BroadcastReceiver() {
            @Override public void onReceive(android.content.Context c, Intent it) { onDevIntent(it); }
        };
        android.content.IntentFilter f = new android.content.IntentFilter("com.fy.local.DEVTEST");
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(devReceiver, f, android.content.Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(devReceiver, f);
            }
            Log.i(TAG, "dev 无头测试广播已注册");
        } catch (Throwable t) {
            Log.w(TAG, "dev 广播注册失败", t);
        }
    }

    private void onDevIntent(Intent it) {
        final String cmd = it.getStringExtra("cmd");
        final String id = it.getStringExtra("id");
        final String model = it.getStringExtra("model");
        final int ctx = it.getIntExtra("ctx", 4096);
        final int threads = it.getIntExtra("threads", 4);
        final String tune = it.getStringExtra("tune");
        final int maxTokens = it.getIntExtra("maxTokens", 160);
        final String configsB64 = it.getStringExtra("configsB64");
        String mTmp = it.getStringExtra("messages");
        final String mb64 = it.getStringExtra("messagesB64");
        if (mb64 != null && !mb64.isEmpty()) {
            try { mTmp = new String(android.util.Base64.decode(mb64, android.util.Base64.NO_WRAP), "UTF-8"); }
            catch (Throwable ignored) { }
        }
        final String messages = mTmp;
        final String opts = it.getStringExtra("opts");
        new Thread(() -> {
            JSONObject r = new JSONObject();
            try {
                r.put("cmd", cmd);
                startFyService();
                if ("load".equals(cmd)) devLoad(id, model, ctx, threads, tune, r);
                else if ("chat".equals(cmd)) devChat(id, messages, opts, maxTokens, r);
                else if ("bench".equals(cmd)) devBench(configsB64, r);
                else if ("status".equals(cmd)) r.put("backends", backends() == null ? "" : backends().summary());
                else r.put("error", "unknown cmd " + cmd);
            } catch (Throwable t) {
                try { r.put("error", String.valueOf(t)); } catch (Exception ignored) { }
            }
            writeDevResult(r.toString());
        }, "fy-devtest").start();
    }

    private void startFyService() {
        try {
            Intent si = new Intent(this, FyService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(si);
            else startService(si);
        } catch (Throwable ignored) {
        }
    }

    private void devLoad(String id, String model, int ctx, int threads, String tune, JSONObject r) throws Exception {
        EngineBackend b = backend(id);
        if (b == null) { r.put("error", "unknown backend " + id); return; }
        if (!b.available()) { r.put("error", "backend unavailable"); return; }
        String abs = new java.io.File(models().dir(), model).getAbsolutePath();
        b.start(abs, ctx, threads, false, tune, () -> { });   // 不自动回退子进程
        long t0 = System.currentTimeMillis();
        while (System.currentTimeMillis() - t0 < 240000) {
            String st = b.state();
            if ("ready".equals(st) || "error".equals(st) || "stopped".equals(st)) break;
            Thread.sleep(300);
        }
        r.put("id", b.id());
        r.put("state", b.state());
        r.put("message", b.message() == null ? "" : b.message());
        r.put("loadMs", b.loadMs());
        r.put("model", b.model() == null ? "" : b.model());
    }

    private void devChat(String id, String messagesJson, String optsJson, int maxTokens, JSONObject r) throws Exception {
        EngineBackend b = id != null ? backend(id) : inProcessBackendForChat();
        if (b == null || !b.available()) { r.put("error", "backend unavailable"); return; }
        org.json.JSONArray arr = new org.json.JSONArray(messagesJson == null || messagesJson.isEmpty() ? "[]" : messagesJson);
        String[] flat = new String[arr.length() * 2];
        for (int i = 0; i < arr.length(); i++) {
            JSONObject m = arr.getJSONObject(i);
            flat[i * 2] = m.optString("role", "user");
            flat[i * 2 + 1] = m.optString("content", "");
        }
        EngineBackend.ChatOptions o = new EngineBackend.ChatOptions();
        o.maxTokens = maxTokens;
        JSONObject op = new JSONObject(optsJson == null || optsJson.isEmpty() ? "{}" : optsJson);
        o.temperature = (float) op.optDouble("temperature", 0.8);
        o.topK = op.optInt("topK", 40);
        o.topP = (float) op.optDouble("topP", 0.95);
        o.seed = op.optInt("seed", 0);
        o.pinMessages = op.optInt("pinMessages", 1);
        synchronized (devLock) {
            devTokens.setLength(0);
            devStats = "";
            devErr = "";
            devCapturing = true;
        }
        String gid = b.chat(flat, o);
        r.put("genId", gid == null ? "" : gid);
        if (gid == null) {
            synchronized (devLock) { devCapturing = false; }
            r.put("error", "busy");
            return;
        }
        long t0 = System.currentTimeMillis();
        while (nativeGenerating() && System.currentTimeMillis() - t0 < 300000) Thread.sleep(100);
        synchronized (devLock) {
            devCapturing = false;
            r.put("text", devTokens.toString());
            if (devStats != null && !devStats.isEmpty()) r.put("stats", new JSONObject(devStats));
            if (devErr != null && !devErr.isEmpty()) r.put("genError", devErr);
        }
    }


    /**
     * 一次性跑完整套基准（configsB64 = base64(JSON 数组)）。为什么要"一次广播跑完"：
     * HyperOS 会把 cached 进程冻住并拒发后续广播，逐条广播会卡死；这里只在收到一条广播时
     * 起一个线程把整串跑完，逐行 append 到 files/devtest/bench.jsonl，最后写 {"done":true}。
     */
    private void devBench(String configsB64, JSONObject r) throws Exception {
        if (configsB64 == null || configsB64.isEmpty()) { r.put("error", "no configs"); return; }
        java.io.File d = new java.io.File(getFilesDir(), "devtest");
        d.mkdirs();
        java.io.File out = new java.io.File(d, "bench.jsonl");
        org.json.JSONArray cfgs = new org.json.JSONArray(
                new String(android.util.Base64.decode(configsB64, android.util.Base64.NO_WRAP), "UTF-8"));
        java.io.FileWriter w = new java.io.FileWriter(out, false);
        w.write("{\"start\":" + cfgs.length() + "}\n");
        w.flush();
        for (int i = 0; i < cfgs.length(); i++) {
            JSONObject c = cfgs.getJSONObject(i);
            JSONObject line = new JSONObject();
            try {
                JSONObject lr = new JSONObject();
                devLoad(c.optString("id"), c.optString("model"), 4096, c.optInt("threads", 4),
                        c.optString("tune", ""), lr);
                line.put("load", lr);
                JSONObject cr = new JSONObject();
                devChat(c.optString("id"), c.optString("messages", "[]"), "{}",
                        c.optInt("maxTokens", 160), cr);
                line.put("chat", cr);
            } catch (Throwable t) {
                line.put("error", String.valueOf(t));
            }
            line.put("id", c.optString("id"));
            line.put("model", c.optString("model"));
            line.put("tune", c.optString("tune", ""));
            line.put("threads", c.optInt("threads", 4));
            w.write(line.toString() + "\n");
            w.flush();
        }
        w.write("{\"done\":true}\n");
        w.close();
        r.put("done", true);
    }

    private void writeDevResult(String json) {
        try {
            java.io.File d = new java.io.File(getFilesDir(), "devtest");
            d.mkdirs();
            java.io.FileWriter w = new java.io.FileWriter(new java.io.File(d, "result.json"), false);
            w.write(json);
            w.close();
        } catch (Throwable t) {
            Log.w(TAG, "写 dev 结果失败", t);
        }
    }

    /** 把「自检 + 引擎状态 + 日志 + 模型列表」写成 txt 落到 Download/（后台线程）。 */
    public void writeDiagnostics() {
        new Thread(() -> {
            try {
                Diag.save(this, Diag.buildReport(this, engine, models, server));
            } catch (Throwable t) {
                Log.w(TAG, "诊断导出失败", t);
            }
        }, "fy-diag").start();
    }

    public boolean hasMicPermission() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    public void requestMicPermission() {
        if (!hasMicPermission()) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
        }
    }

    /**
     * 推理期间的「别熄屏 / 别休眠」。
     *
     * 两件事一起做：
     *   1) FLAG_KEEP_SCREEN_ON —— App 在前台时屏幕不自动熄灭（用户能看着字一个个蹦出来）；
     *   2) PARTIAL_WAKE_LOCK   —— CPU 唤醒锁，屏幕关了 / App 切到后台也能把这一轮生成跑完，
     *      否则 Doze 会把推理线程压到几乎不动（实测后台生成会被拖慢甚至停住）。
     * 只在整个生成期间持有（几十秒量级），生成结束立刻放开，不做常驻耗电。
     */
    public void keepScreenOn(final boolean on) {
        runOnUiThread(() -> {
            if (on) {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
        try {
            if (on) {
                if (inferWake == null) {
                    android.os.PowerManager pm = (android.os.PowerManager)
                            getSystemService(POWER_SERVICE);
                    if (pm != null) {
                        inferWake = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "fy:infer");
                        inferWake.setReferenceCounted(false);
                    }
                }
                if (inferWake != null && !inferWake.isHeld()) {
                    inferWake.acquire(15 * 60 * 1000L);   // 兜底上限：15 分钟，防止异常路径漏放
                }
            } else if (inferWake != null && inferWake.isHeld()) {
                inferWake.release();
            }
        } catch (Throwable t) {
            Log.w(TAG, "唤醒锁操作失败: " + t);
        }
    }

    public void toast(final String msg) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
    }

    // ---------- 前台服务：防止引擎被后台冻结 ----------

    /**
     * 引擎跑着的时候挂一个前台服务。
     *
     * 真机实测（Redmi K70 Pro / Android 16 / HyperOS）：引擎在跑而 App 退到后台时，
     * 系统会立刻把进程塞进冻结 cgroup（cgroup.freeze=1），llama-server 是子进程跟着冻住，
     * WebView 也冻住 —— 再切回来界面「点不动」，严重时还会被直接杀掉。
     * 挂上前台服务后进程是 foreground-service 级别，不再是 cached，就不会被冻。
     */
    public void syncEngineService(String state, String message) {
        boolean running = "starting".equals(state) || "loading".equals(state) || "ready".equals(state);
        if (!running) {
            try {
                stopService(new Intent(this, FyService.class));
            } catch (Throwable t) {
                Log.w(TAG, "停止前台服务失败: " + t);
            }
            return;
        }
        String text;
        if ("starting".equals(state)) text = "正在启动本地模型…";
        else if ("loading".equals(state)) text = "正在加载模型…";
        else text = (message != null && !message.isEmpty()) ? message : "本地模型就绪，可以开始聊了";
        try {
            maybeRequestNotifPermission();
            Intent i = new Intent(this, FyService.class).putExtra(FyService.EXTRA_TEXT, text);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i);
            } else {
                startService(i);
            }
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(FyService.NOTIF_ID, FyService.build(this, text));
        } catch (Throwable t) {
            // 用户禁了通知之类的情况下前台服务可能起不来，绝不能因此把引擎搞挂
            Log.w(TAG, "前台服务启动失败: " + t);
        }
    }

    /** Android 13+ 通知要运行时授权；没授权前台服务照样能跑，只是通知不显示。 */
    private void maybeRequestNotifPermission() {
        if (notifAsked) return;
        notifAsked = true;
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    public void launchFilePicker() {
        runOnUiThread(() -> {
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                startActivityForResult(i, REQ_FILE);
            } catch (Exception e) {
                toast("打不开文件选择，请确认已授予存储权限后重试");
            }
        });
    }

    /** 选一张角色卡（.json 或带 chara 块的 .png），读完通过 card 事件回传前端。 */
    public void launchCardPicker() {
        pickDocument(REQ_CARD);
    }

    /** 选一个备份文件（.json），读完通过 backup 事件回传前端。 */
    public void launchBackupPicker() {
        pickDocument(REQ_BACKUP);
    }

    private void pickDocument(final int requestCode) {
        runOnUiThread(() -> {
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                startActivityForResult(i, requestCode);
            } catch (Exception e) {
                toast("打不开文件选择，请确认已授予存储权限后重试");
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        /* 角色卡：读完把 JSON 文本交给前端（字段映射在前端 cards.js 里做） */
        if (requestCode == REQ_CARD) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                pushEvent("card", payload(false, "", "已取消选择"));
                return;
            }
            final Uri uri = data.getData();
            final String display = String.valueOf(data.getData().getLastPathSegment());
            new Thread(() -> {
                JSONObject o = new JSONObject();
                try {
                    String json = CardIO.readCardJson(this, uri);
                    o.put("ok", true);
                    o.put("name", display);
                    o.put("json", json);
                    o.put("message", "");
                } catch (Throwable t) {
                    Log.w(TAG, "读角色卡失败", t);
                    try {
                        o.put("ok", false);
                        o.put("name", display);
                        o.put("message", "这个文件读不了，换一个再试");
                    } catch (Exception ignored) {
                    }
                }
                pushEvent("card", o);
            }, "fy-card-import").start();
            return;
        }

        /* 备份文件：和角色卡用同一套读取（纯 JSON 文本），只是事件名不同 */
        if (requestCode == REQ_BACKUP) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                pushEvent("backup", payload(false, "", "已取消选择"));
                return;
            }
            final Uri buri = data.getData();
            final String bname = String.valueOf(data.getData().getLastPathSegment());
            new Thread(() -> {
                JSONObject o = new JSONObject();
                try {
                    o.put("ok", true);
                    o.put("name", bname);
                    o.put("json", CardIO.readCardJson(this, buri));
                    o.put("message", "");
                } catch (Throwable t) {
                    Log.w(TAG, "读备份失败", t);
                    try {
                        o.put("ok", false);
                        o.put("name", bname);
                        o.put("message", "这个文件读不了，换一个再试");
                    } catch (Exception ignored) {
                    }
                }
                pushEvent("backup", o);
            }, "fy-backup-import").start();
            return;
        }

        if (requestCode != REQ_FILE) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            pushEvent("import", payload(false, "", "已取消选择"));
            return;
        }
        final Uri uri = data.getData();
        new Thread(() -> {
            JSONObject r = models.importFromUri(uri, (name, received, total, state, message) -> {
                JSONObject o = new JSONObject();
                try {
                    o.put("name", name);
                    o.put("received", received);
                    o.put("total", total);
                    o.put("percent", total > 0 ? Math.min(100, (int) (received * 100 / total)) : 0);
                    o.put("state", state);
                    o.put("message", message);
                } catch (Exception ignored) {
                }
                pushEvent("download", o);
            });
            pushEvent("import", r);
        }, "fy-import-picker").start();
    }

    private static JSONObject payload(boolean ok, String name, String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("ok", ok);
            o.put("name", name);
            o.put("message", message);
        } catch (Exception ignored) {
        }
        return o;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_MIC) {
            boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            toast(granted ? "麦克风已开，可以语音输入了" : "没有麦克风权限，语音就用不了。去系统设置里允许「麦克风」，回来再点一次");
        } else if (requestCode == REQ_NOTIF) {
            // 没授权也能跑前台服务，只是通知栏不显示，这里不打扰用户
            Log.i(TAG, "通知权限结果: " + (results.length > 0 ? results[0] : -1));
        }
    }

    // ---------- 生命周期 ----------

    @Override
    public void onBackPressed() {
        if (web != null) {
            // 交给前端处理：有历史/有弹层就退前端，否则退出
            web.evaluateJavascript(
                    "(function(){try{return window.fyOnBack&&window.fyOnBack()?'1':'0'}catch(e){return '0'}})()",
                    value -> {
                        boolean handled = value != null && value.contains("1");
                        if (!handled) {
                            if (web.canGoBack()) web.goBack();
                            else finish();
                        }
                    });
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        try {
            shutdownNativeEngine();
        } catch (Throwable ignored) {
        }
        try {
            if (engine != null) engine.stop();
        } catch (Exception ignored) {
        }
        try {
            stopService(new Intent(this, FyService.class));
        } catch (Exception ignored) {
        }
        try {
            if (inferWake != null && inferWake.isHeld()) inferWake.release();
        } catch (Exception ignored) {
        }
        try {
            if (speech != null) speech.shutdown();
        } catch (Exception ignored) {
        }
        try {
            if (server != null) server.stop();
        } catch (Exception ignored) {
        }
        try {
            if (web != null) {
                web.removeJavascriptInterface("FY");
                web.destroy();
            }
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }
}
