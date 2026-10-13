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
            return fail(String.valueOf(e));
        }
    }

    @JavascriptInterface
    public void log(String msg) {
        Log.i(TAG, "[js] " + msg);
    }

    // ---------- 引擎 ----------

    @JavascriptInterface
    public String engineStatus() {
        Engine e = host.engine();
        try {
            JSONObject o = new JSONObject();
            o.put("state", e.getState());
            o.put("port", e.getPort());
            o.put("model", e.getCurrentModel());
            o.put("message", e.getMessage());
            o.put("lastError", e.getLastError());
            o.put("launchStrategy", e.getLaunchStrategy());
            return o.toString();
        } catch (Exception ex) {
            return fail(String.valueOf(ex));
        }
    }

    @JavascriptInterface
    public String engineStart(String optsJson) {
        try {
            JSONObject o = new JSONObject(optsJson == null || optsJson.isEmpty() ? "{}" : optsJson);
            String model = o.optString("model", "");
            if (model.isEmpty()) return fail("没有指定模型");
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
            host.engine().start(model, ctx, threads, gpuLayers,
                    host.models().dir().getAbsolutePath());
            return ok("已开始启动");
        } catch (Exception e) {
            return fail("engineStart 参数错误: " + e);
        }
    }

    @JavascriptInterface
    public String engineStop() {
        host.engine().stop();
        return ok("已停止");
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
            return "{\"ok\":false,\"message\":" + JSONObject.quote(String.valueOf(e)) + "}";
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
                out.put("message", String.valueOf(e));
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
        return ok("已打开文件选择器");
    }

    /** 选一个备份文件；结果通过 backup 事件回传 {ok,name,json,message}。 */
    @JavascriptInterface
    public String pickBackupFile() {
        host.launchBackupPicker();
        return ok("已打开文件选择器");
    }

    /** 把任意 JSON 文本（如整库备份）写到 Download，返回 {ok,path}。 */
    @JavascriptInterface
    public String saveBackup(String fileName, String json) {
        if (json == null || json.trim().isEmpty()) return fail("备份内容是空的");
        try {
            return CardIO.saveJson(host, fileName, json);
        } catch (Throwable t) {
            return fail("导出失败: " + t);
        }
    }

    /** 把卡片的 JSON 文本写到 Download，返回 {ok,path}。 */
    @JavascriptInterface
    public String saveCharacterCard(String fileName, String json) {
        if (json == null || json.trim().isEmpty()) return fail("卡片内容是空的");
        try {
            return CardIO.saveJson(host, fileName, json);
        } catch (Throwable t) {
            return fail("导出失败: " + t);
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
        return ok("已打开文件选择器");
    }

    @JavascriptInterface
    public String importModel(String uri) {
        if (uri == null || uri.isEmpty()) return fail("URI 为空");
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
            return fail("参数不完整");
        }
        final String u = url, n = name;
        new Thread(() -> {
            host.models().download(u, n, (nm, received, total, state, message) ->
                    host.pushEvent("download", progressPayload(nm, received, total, state, message)));
            host.pushEvent("download", progressPayload(n, 0, 0, "finish", "任务结束"));
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
            return fail("导出诊断失败: " + t);
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
