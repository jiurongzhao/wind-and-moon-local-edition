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
    private ModelStore models;
    private Speech speech;
    private volatile boolean uiReady = false;
    private boolean notifAsked = false;
    /** 推理期间的 CPU 唤醒锁（见 keepScreenOn） */
    private android.os.PowerManager.WakeLock inferWake;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        engine = new Engine(this, new Engine.Listener() {
            @Override
            public void onState(String state, String message) {
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
                JSONObject o = new JSONObject();
                try {
                    o.put("line", line);
                } catch (Exception ignored) {
                }
                pushEvent("log", o);
            }
        });

        models = new ModelStore(this);

        // 启动就自检一次引擎（跑 --version，不加载模型），结果写进日志和 appInfo，
        // 万一真机上拉不起来，调试页能直接看到断在哪一步。
        engine.selfCheck();

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
            Toast.makeText(this, "资源服务器启动失败: " + e, Toast.LENGTH_LONG).show();
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
     * 真机实测（Redmi Turbo 3 / Android 16 / HyperOS）：引擎在跑而 App 退到后台时，
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
        if ("starting".equals(state)) text = "正在启动引擎…";
        else if ("loading".equals(state)) text = "正在加载模型…";
        else text = (message != null && !message.isEmpty()) ? message : "引擎就绪，可以开始聊了";
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
                toast("无法打开文件选择器: " + e);
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
                toast("无法打开文件选择器: " + e);
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
                        o.put("message", String.valueOf(t.getMessage() == null ? t : t.getMessage()));
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
                        o.put("message", String.valueOf(t.getMessage() == null ? t : t.getMessage()));
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
            toast(granted ? "麦克风权限已允许" : "没有麦克风权限，语音输入不可用");
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
