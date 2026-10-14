package com.fy.local;

import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 暴露给前端的原生桥（window.FY）。
 *
 * 注意：这些方法会在 WebView 的 JavaBridge 线程被调用，不是主线程，
 * 所以耗时的活儿（下载、导入、启动引擎）都甩到后台线程，方法本身立刻返回。
 */
public class Bridge {

    private static final String TAG = "FY/Bridge";
    private final MainActivity host;

    public Bridge(MainActivity host) {
        this.host = host;
    }

    private static String ok() {
        return ok(null);
    }

    private static String ok(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", true);
            if (msg != null) o.put("message", msg);
            return o.toString();
        } catch (Exception e) {
            return "{\"ok\":true}";
        }
    }

    private static String fail(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("message", msg);
            return o.toString();
        } catch (Exception e) {
            return "{\"ok\":false}";
        }
    }

    // ---------- 基础信息 ----------

    /**
     * 从清单读真实版本号。
     *
     * 以前这里写死 "0.2"，于是设置页底部的版本号永远显示 0.2 —— 装的是 1.6.2 也一样，
     * 而且测试里没有任何断言盯着它，所以这个 bug 活了很久。改完顺带补了一条前端回归测试。
     */
    private String appVersion() {
        try {
            return host.getPackageManager()
                    .getPackageInfo(host.getPackageName(), 0).versionName;
        } catch (Throwable t) {
            return "本地版";
        }
    }

    @JavascriptInterface
    public String appInfo() {
        try {
            JSONObject o = new JSONObject();
            o.put("version", appVersion());
            o.put("abi", android.os.Build.SUPPORTED_ABIS[0]);
            o.put("sdk", android.os.Build.VERSION.SDK_INT);
            o.put("model", android.os.Build.MODEL);
            o.put("filesDir", host.getFilesDir().getAbsolutePath());
            o.put("nativeDir", host.getApplicationInfo().nativeLibraryDir);
            o.put("modelDir", host.models().dir().getAbsolutePath());
            o.put("engineProbe", host.engine().getProbeResult());
            // 进程内（JNI）引擎：装没装、起没起、加载多久、后端是什么。
            // 这些都是"真机上出问题时要第一眼看的东西"，所以放进 appInfo 而不是埋在日志里。
            try {
                EngineBackend jni = host.backend("jni");
                o.put("nativeLoaded", jni != null && jni.available());
                o.put("nativeState", jni != null ? jni.state() : "stopped");
                o.put("nativeLoadMs", jni != null ? jni.loadMs() : -1);
                o.put("backends", host.backends() == null ? "" : host.backends().summary());
                // 设置页「推理方式」下拉框直接吃这个数组：新增后端不用改前端
                o.put("engineBackends", backendsJson());
                o.put("nativeSystem", NativeEngine.nativeSystemInfo().trim().replace('\n', ' '));
            } catch (Throwable t) {
                o.put("nativeError", String.valueOf(t));
            }
            // 内存信息：模型大小和可用内存的关系直接决定速度。
            // 实测同一台机器：0.5B（0.5GB）稳 48 tok/s；4B（2.4GB）在内存吃紧时掉到 1.1 tok/s。
            try {
                android.app.ActivityManager am = (android.app.ActivityManager)
                        host.getSystemService(android.content.Context.ACTIVITY_SERVICE);
                if (am != null) {
                    android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
                    am.getMemoryInfo(mi);
                    o.put("availMemMB", mi.availMem / 1048576);
                    o.put("totalMemMB", mi.totalMem / 1048576);
                    o.put("lowMemory", mi.lowMemory);
                }
            } catch (Throwable ignored) {
            }
            return o.toString();
        } catch (Exception e) {
            return fail("应用信息读不出来，请重启应用后再试");
        }
    }

    @JavascriptInterface
    public void log(String msg) {
        Log.i(TAG, "[js] " + msg);
    }

    // ---------- 引擎 ----------

    @JavascriptInterface
    public String engineStatus() {
        try {
            JSONObject o = new JSONObject();
            // 有进程内后端在跑（或正在起）就报它；否则报子进程那套 —— 两边的 state 取值一样
            EngineBackend inProc = host.activeInProcessBackend();
            if (inProc != null) {
                o.put("state", inProc.state());
                o.put("port", 0);
                o.put("model", inProc.model());
                o.put("message", inProc.message());
                o.put("lastError", "error".equals(inProc.state()) ? inProc.message() : "");
                o.put("launchStrategy", inProc.id());
                o.put("native", inProc.inProcessChat());
                o.put("loadMs", inProc.loadMs());
                return o.toString();
            }
            Engine e = host.engine();
            o.put("state", e.getState());
            o.put("port", e.getPort());
            o.put("model", e.getCurrentModel());
            o.put("message", e.getMessage());
            o.put("lastError", e.getLastError());
            o.put("launchStrategy", e.getLaunchStrategy());
            o.put("native", false);
            return o.toString();
        } catch (Exception ex) {
            return fail("引擎状态读不出来，请重启应用后再试");
        }
    }

    /** 进程内后端清单 → 设置页「推理方式」下拉框的数据源。 */
    private JSONArray backendsJson() {
        JSONArray arr = new JSONArray();
        EngineRegistry reg = host.backends();
        if (reg == null) return arr;
        for (EngineBackend b : reg.all()) {
            JSONObject o = new JSONObject();
            try {
                o.put("id", b.id());
                o.put("label", b.label());
                o.put("available", b.available());
                o.put("inProcess", b.inProcessChat());
            } catch (Exception ignored) {
            }
            arr.put(o);
        }
        return arr;
    }

    @JavascriptInterface
    public String engineStart(String optsJson) {
        try {
            JSONObject o = new JSONObject(optsJson == null || optsJson.isEmpty() ? "{}" : optsJson);
            String model = o.optString("model", "");
            if (model.isEmpty()) return fail("还没选模型。回设置里的「模型管理」点一下要用的那个，再启动");
            int ctx = o.optInt("ctx", 4096);
            /* 线程数默认值：实测（Redmi Turbo 3 / 8 核 big.LITTLE：2 小核 + 5 中核 + 1 大核）
               0.5B：4 线程稳定 48~52 tok/s；6 线程 24~57 抖动极大；8 线程 11~35 更差
               3B  ：4 线程 11.5 tok/s 且加载 8s；6 线程 11.3 tok/s 但加载 17s
               原因是慢核会把每次同步点拖成短板（llama.cpp 是同步并行的）。
               所以取"快核数量 ≈ 4"，并给界面留一个核 —— 而不是以前那个 0.75×核数。 */
            int defThreads = Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors() - 1));
            int threads = o.optInt("threads", 0);
            if (threads <= 0) threads = defThreads;
            int gpuLayers = o.optInt("gpuLayers", 0);
            // mlock：把模型锁进内存避免换页，实测能让 3B 的生成速度翻倍（3.6→9 tok/s）。
            // 前端按机型内存决定默认值，这里只负责透传。
            String loadMode = o.optString("loadMode", "");
            host.engine().setLoadMode(loadMode);

            /* engineMode=jni（默认）走进程内后端；没注册 / 不可用 / =server，都落到
               llama-server 子进程。进程内起不来也会自动回退，所以默认值可以放心激进。 */
            EngineBackend backend = host.backend(o.optString("engineMode", "jni"));
            if (backend != null && backend.inProcessChat() && backend.available()) {
                // 换模型期间绝不能有生成在跑：C 侧 free 掉 context 而推理线程还在用它 = 崩
                if (backend.generating()) return fail("还在生成中，点停止后再换模型");
                final String m = model;
                final String abs = new java.io.File(host.models().dir(), model).getAbsolutePath();
                final int c = ctx, th = threads, gl = gpuLayers;
                final boolean mlock = "mlock".equals(loadMode);
                /* 加载调参：前端可传 tune（"k=v;k=v"）。JNI 认 type_k/type_v/flash_attn/ubatch 等；
                   LiteRT-LM 认 thinking/spec/...。不传就是各后端的老默认，行为不变。 */
                final String tune = o.optString("tune", "");
                backend.start(abs, c, th, mlock, tune, () -> {
                    /* 回退：提示走"只推事件"那条，别把后端状态又设回 loading，
                       否则前端看不到子进程引擎的真实状态。 */
                    host.pushEngineEvent("loading", backend.label() + "没启动成功，改用兼容模式重试…", m, false);
                    host.engine().start(m, c, th, gl, host.models().dir().getAbsolutePath());
                });
                return ok("已开始启动（" + backend.label() + "）");
            }

            host.engine().start(model, ctx, threads, gpuLayers,
                    host.models().dir().getAbsolutePath());
            return ok("已开始启动");
        } catch (Exception e) {
            return fail("启动信息不完整，请回设置页重新选一次模型");
        }
    }

    @JavascriptInterface
    public String engineStop() {
        EngineBackend inProc = host.activeInProcessBackend();
        if (inProc != null) inProc.stop();
        else host.shutdownNativeEngine();   // 没在跑也释放一次，免得 .so 里留着 context
        host.engine().stop();
        return ok("已停止");
    }

    // ---------- 进程内引擎的对话（不走 HTTP） ----------

    /**
     * 一轮对话：messages 交给进程内引擎，原生侧套模型自带模板并流式回调。
     *
     * 立即返回 {ok, id}；token 通过 gen 事件推回来：
     *   {id, state:"delta", delta:"…"} / {id, state:"done", stats:{…}} / {id, state:"error", message:"…"}
     * 事件带 id 是为了让前端能丢掉"上一轮迟到的尾巴"（停止/重开时会发生）。
     */
    @JavascriptInterface
    public String chat(String messagesJson, String optsJson) {
        EngineBackend backend = host.inProcessBackendForChat();
        if (backend == null || !backend.inProcessChat() || !backend.available()) {
            // 没注册进程内后端 / .so 没打进去 / ABI 不符，都走这条，别把异常甩给 WebView
            return fail("内置模型现在用不了，请到设置页换一种推理方式");
        }
        try {
            JSONArray arr = new JSONArray(messagesJson == null ? "[]" : messagesJson);
            int n = arr.length();
            if (n <= 0) return fail("没有可发送的消息");
            String[] flat = new String[n * 2];
            for (int i = 0; i < n; i++) {
                JSONObject m = arr.optJSONObject(i);
                flat[i * 2] = m == null ? "user" : m.optString("role", "user");
                flat[i * 2 + 1] = m == null ? "" : m.optString("content", "");
            }
            JSONObject o = new JSONObject(optsJson == null || optsJson.isEmpty() ? "{}" : optsJson);
            EngineBackend.ChatOptions co = new EngineBackend.ChatOptions();
            co.pinMessages = Math.max(0, o.optInt("pinMessages", 1));
            co.maxTokens = Math.max(1, o.optInt("maxTokens", 512));
            co.temperature = (float) o.optDouble("temperature", 0.8);
            co.topK = o.optInt("topK", 40);
            co.topP = (float) o.optDouble("topP", 0.95);
            co.seed = o.optInt("seed", 0);
            co.sampler = buildSamplerCfg(o);
            co.grammar = o.optString("grammar", "");
            co.grammarTrigger = o.optString("grammarTrigger", "");
            /* aux=true：辅助生成（记忆压缩 / 工具调用），跑完把聊天 KV 恢复原样 */
            co.aux = o.optBoolean("aux", false);

            String id = backend.chat(flat, co);
            if (id == null) return fail("上一轮还在生成，稍等一下");
            JSONObject r = new JSONObject();
            r.put("ok", true);
            r.put("id", id);
            return r.toString();
        } catch (Exception e) {
            return fail("这条消息没能发出去，请重开一次对话");
        }
    }

    /**
     * 把前端的采样设置压成引擎认的 "k=v;k=v" 一行。没设的键不出现，引擎取默认值（=关）。
     * 字段名用前端那套（penaltyRepeat / dryMultiplier / minP …），引擎键名见 fy_engine.c。
     */
    private static String buildSamplerCfg(JSONObject o) {
        StringBuilder sb = new StringBuilder();
        num(sb, "pen_n", o, "penaltyLastN");
        num(sb, "pen_rep", o, "penaltyRepeat");
        num(sb, "pen_freq", o, "penaltyFreq");
        num(sb, "pen_pres", o, "penaltyPresent");
        num(sb, "dry_mult", o, "dryMultiplier");
        num(sb, "dry_base", o, "dryBase");
        num(sb, "dry_allowed", o, "dryAllowedLength");
        num(sb, "min_p", o, "minP");
        num(sb, "top_ns", o, "topNSigma");
        num(sb, "xtc_p", o, "xtcProbability");
        num(sb, "xtc_t", o, "xtcThreshold");
        num(sb, "temp_delta", o, "dynTempDelta");
        num(sb, "temp_exp", o, "dynTempExponent");
        return sb.toString();
    }

    private static void num(StringBuilder sb, String key, JSONObject o, String field) {
        if (!o.has(field)) return;
        double v = o.optDouble(field, 0);
        if (Double.isNaN(v)) return;
        if (sb.length() > 0) sb.append(';');
        sb.append(key).append('=').append(v);
    }

    /** 停止当前这一轮原生生成（点了"停止"时调）。 */
    @JavascriptInterface
    public String chatStop() {
        EngineBackend backend = host.inProcessBackendForChat();
        if (backend != null) backend.stopChat();
        return ok("正在停止…");
    }

    @JavascriptInterface
    public String engineLog() {
        return new JSONArray(host.engine().tailLog(200)).toString();
    }

    /** 保存一段文本到 Download（对话导出用）：name 建议带扩展名，如 林夏-对话.md */
    @JavascriptInterface
    public String saveText(String name, String text) {
        String n = (name == null || name.trim().isEmpty()) ? "fy-对话.md" : name.trim();
        return CardIO.saveText(host, n, text == null ? "" : text, ".md", "text/markdown; charset=utf-8");
    }

    // ---------- 模型来源（内置引擎 / 外部 OpenAI 兼容服务） ----------

    /** 当前配置（**不含 key**，只告诉前端有没有配） */
    @JavascriptInterface
    public String getProvider() {
        Providers.Config c = Providers.load(host);
        JSONObject o = new JSONObject();
        try {
            o.put("mode", c.mode);
            o.put("baseUrl", c.baseUrl);
            o.put("model", c.model);
            o.put("hasKey", c.apiKey != null && !c.apiKey.isEmpty());
            o.put("ready", Providers.isReady(c));
        } catch (Exception ignored) {
        }
        return o.toString();
    }

    /** 保存配置：{mode, baseUrl, apiKey, model}。key 只留在原生侧。 */
    @JavascriptInterface
    public String setProvider(String json) {
        try {
            JSONObject o = new JSONObject(json == null ? "{}" : json);
            Providers.save(host, o.optString("mode", Providers.MODE_LOCAL),
                    o.optString("baseUrl", ""), o.optString("apiKey", ""), o.optString("model", ""));
            return getProvider();
        } catch (Exception e) {
            return "{\"ok\":false,\"message\":" + JSONObject.quote("设置没保存成功，请重试") + "}";
        }
    }

    /** 测试连通性并列出上游模型（GET {base}/models） */
    @JavascriptInterface
    public String testProvider(String json) {
        JSONObject out = new JSONObject();
        try {
            JSONObject o = new JSONObject(json == null ? "{}" : json);
            Providers.ModelsResult r = Providers.listModels(o.optString("baseUrl", ""), o.optString("apiKey", ""));
            out.put("ok", r.ok);
            out.put("message", r.message);
            out.put("resolvedBase", r.resolvedBase);
            JSONArray arr = new JSONArray();
            for (String m : r.models) arr.put(m);
            out.put("models", arr);
            out.put("count", r.models.size());
        } catch (Exception e) {
            try {
                out.put("ok", false);
                out.put("message", "连接失败，检查一下地址和网络");
            } catch (Exception ignored) {
            }
        }
        return out.toString();
    }

    // ---------- 存储后端（SQLite，实验性） ----------

    /** 一次性读出 SQLite 全库，返回 {ok, characters:[...], settings:{...}, ...} */
    @JavascriptInterface
    public String dbLoadAll() {
        return Db.loadAll(host);
    }

    /** 一个事务里批量应用变更：{clears:[], puts:{}, dels:{}} */
    @JavascriptInterface
    public String dbApply(String opsJson) {
        return Db.apply(host, opsJson);
    }

    /** 消息模糊检索 */
    @JavascriptInterface
    public String dbSearch(String query, int limit) {
        return Db.search(host, query, limit);
    }

    /** 行数 / 库文件体积（设置页显示用） */
    @JavascriptInterface
    public String dbStats() {
        return Db.stats(host);
    }

    /** 清空 SQLite 库（切换后端时用） */
    @JavascriptInterface
    public String dbWipe() {
        return Db.wipe(host);
    }

    // ---------- 角色卡（SillyTavern chara_card_v2） ----------

    /** 打开文件选择器挑一张角色卡；结果通过 card 事件回传 {ok,name,json,message}。 */
    @JavascriptInterface
    public String pickCharacterCard() {
        host.launchCardPicker();
        return ok("请选择文件");
    }

    /** 选一个备份文件；结果通过 backup 事件回传 {ok,name,json,message}。 */
    @JavascriptInterface
    public String pickBackupFile() {
        host.launchBackupPicker();
        return ok("请选择文件");
    }

    /** 把任意 JSON 文本（如整库备份）写到 Download，返回 {ok,path}。 */
    @JavascriptInterface
    public String saveBackup(String fileName, String json) {
        if (json == null || json.trim().isEmpty()) return fail("这个备份文件是空的，读不到内容，换一个完整的备份再恢复");
        try {
            return CardIO.saveJson(host, fileName, json);
        } catch (Throwable t) {
            return fail("导出没成功，请检查存储空间后重试");
        }
    }

    /** 把卡片的 JSON 文本写到 Download，返回 {ok,path}。 */
    @JavascriptInterface
    public String saveCharacterCard(String fileName, String json) {
        if (json == null || json.trim().isEmpty()) return fail("卡片内容是空的");
        try {
            return CardIO.saveJson(host, fileName, json);
        } catch (Throwable t) {
            return fail("导出没成功，请检查存储空间后重试");
        }
    }

    // ---------- 模型 ----------

    @JavascriptInterface
    public String listModels() {
        return host.models().list().toString();
    }

    @JavascriptInterface
    public String deleteModel(String name) {
        return host.models().delete(name).toString();
    }

    @JavascriptInterface
    public String listDownloadSources() {
        return host.models().downloadSources().toString();
    }

    @JavascriptInterface
    public String pickModelFile() {
        host.launchFilePicker();
        return ok("请选择文件");
    }

    @JavascriptInterface
    public String importModel(String uri) {
        if (uri == null || uri.isEmpty()) return fail("没有拿到文件，请重新选一次");
        final String u = uri;
        new Thread(() -> {
            JSONObject r = host.models().importFromUri(android.net.Uri.parse(u),
                    (name, received, total, state, message) -> host.pushEvent("download",
                            progressPayload(name, received, total, state, message)));
            try {
                JSONObject o = new JSONObject(r.toString());
                host.pushEvent("import", o);
            } catch (Exception ignored) {
            }
        }, "fy-import").start();
        return ok("开始导入");
    }

    @JavascriptInterface
    public String downloadModel(String url, String name) {
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            return fail("下载信息不完整，请重新填写");
        }
        final String u = url, n = name;
        new Thread(() -> {
            host.models().download(u, n, (nm, received, total, state, message) ->
                    host.pushEvent("download", progressPayload(nm, received, total, state, message)));
            host.pushEvent("download", progressPayload(n, 0, 0, "finish", "已完成"));
        }, "fy-download").start();
        return ok("开始下载");
    }

    private static JSONObject progressPayload(String name, long received, long total,
                                             String state, String message) {
        JSONObject o = new JSONObject();
        try {
            o.put("name", name);
            o.put("received", received);
            o.put("total", total);
            o.put("percent", total > 0 ? Math.min(100, (int) (received * 100 / total)) : 0);
            o.put("state", state);
            o.put("message", message == null ? "" : message);
        } catch (Exception ignored) {
        }
        return o;
    }

    // ---------- 语音 ----------

    @JavascriptInterface
    public String speak(final String text) {
        host.speech().speak(text);
        return ok();
    }

    @JavascriptInterface
    public String stopSpeak() {
        host.speech().stopSpeak();
        return ok();
    }

    @JavascriptInterface
    public String startListening() {
        if (!host.hasMicPermission()) {
            host.requestMicPermission();
            return fail("需要麦克风权限，请在弹窗里允许后重试");
        }
        host.speech().startListening();
        return ok();
    }

    @JavascriptInterface
    public String stopListening() {
        host.speech().stopListening();
        return ok();
    }

    @JavascriptInterface
    public String setSpeechRate(float rate) {
        host.speech().setRate(rate);
        return ok();
    }

    // ---------- 杂项 ----------

    @JavascriptInterface
    public String keepAwake(boolean on) {
        host.keepScreenOn(on);
        return ok();
    }

    /** 把诊断报告写到 Download/fy-diagnostics.txt，返回 {ok, path}。 */
    @JavascriptInterface
    public String exportDiagnostics() {
        try {
            String report = Diag.buildReport(host, host.engine(), host.models(), host.assetServer());
            return Diag.save(host, report);
        } catch (Throwable t) {
            return fail("诊断导出没成功，请稍后重试");
        }
    }

    @JavascriptInterface
    public String toast(String msg) {
        host.toast(msg);
        return ok();
    }

    @JavascriptInterface
    public String exitApp() {
        host.finish();
        return ok();
    }
}
