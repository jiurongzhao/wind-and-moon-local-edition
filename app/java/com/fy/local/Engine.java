package com.fy.local;

import android.content.Context;
import android.os.PowerManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/**
 * 本地推理引擎管理：把随 APK 一起打包的 llama-server 拉起来，并盯着它的状态。
 *
 * 为什么能直接 exec nativeLibraryDir 里的文件？
 *   Android 10+ 禁止执行应用数据目录里的文件（SELinux + W^X），
 *   但 nativeLibraryDir（/data/app/xxx/lib/arm64）里的文件是可执行的，
 *   所以把 llama-server 改名成 libfy_llama_server.so 塞进 jniLibs，
 *   安装时会被解包成真实文件，就能 exec 了。
 */
public class Engine {

    private static final String TAG = "FY/Engine";
    public static final String EXEC_NAME = "libfy_llama_server.so";
    private static final int MAX_LOG_LINES = 200;

    public interface Listener {
        void onState(String state, String message);
        void onLog(String line);
    }

    private final Context ctx;
    private final Listener listener;
    private final ArrayDeque<String> logRing = new ArrayDeque<>();
    private final Object lock = new Object();

    private Process proc;
    private Thread pumpOut, pumpErr, watchdog;
    private volatile String state = "stopped";
    private volatile String message = "";
    private volatile String lastError = "";
    private volatile int port = 0;
    private volatile String currentModel = "";
    private PowerManager.WakeLock wakeLock;

    public Engine(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.listener = listener;
    }

    public String getState() {
        return state;
    }

    public String getMessage() {
        return message;
    }

    public String getLastError() {
        return lastError;
    }

    public int getPort() {
        return port;
    }

    public String getCurrentModel() {
        return currentModel;
    }

    public List<String> tailLog(int n) {
        synchronized (logRing) {
            List<String> all = new ArrayList<>(logRing);
            int from = Math.max(0, all.size() - n);
            return all.subList(from, all.size());
        }
    }

    public boolean isReady() {
        return "ready".equals(state);
    }

    private void setState(String s, String msg) {
        state = s;
        message = msg == null ? "" : msg;
        Log.i(TAG, "state=" + s + " " + message);
        if (listener != null) listener.onState(s, message);
    }

    private void addLog(String line) {
        synchronized (logRing) {
            logRing.addLast(line);
            while (logRing.size() > MAX_LOG_LINES) logRing.removeFirst();
        }
        if (listener != null) listener.onLog(line);
    }

    /** 模型加载方式："" = auto（默认 mmap）；"mlock" = 把模型锁进内存，避免换页。 */
    private volatile String loadMode = "";
    private boolean mlockRetried = false;
    /** 上一次 start() 的参数，mlock 失败回退时要用：{modelFile, ctx, threads, gpuLayers, modelDir} */
    private volatile String[] lastStart;

    public void setLoadMode(String mode) {
        this.loadMode = mode == null ? "" : mode;
    }

    public String getLoadMode() {
        return loadMode;
    }

    /** 启动引擎。会立刻返回，真正的进度通过 Listener 回调。 */
    public void start(final String modelFile, final int ctxSize, final int threads,
                      final int gpuLayers, final String modelDir) {
        synchronized (lock) {
            if ("starting".equals(state) || "loading".equals(state) || "ready".equals(state)) {
                Log.i(TAG, "引擎已在运行/启动中，忽略重复启动");
                return;
            }
            setState("starting", "正在准备引擎…");
            lastError = "";
            mlockRetried = false;
            lastStart = new String[]{modelFile, String.valueOf(ctxSize), String.valueOf(threads),
                    String.valueOf(gpuLayers), modelDir};
            new Thread(() -> doStart(modelFile, ctxSize, threads, gpuLayers, modelDir),
                    "fy-engine-start").start();
        }
    }

    // ================= 启动前自检 =================
    //
    // 跑一次 `--version`（不加载模型，立刻返回），把「可执行文件到底能不能被拉起」
    // 这件事在用户装完 App 的第一时间就写进日志。真出问题时，调试页的日志里
    // 直接能看到是哪个环节断的，不用连 adb 猜。

    private volatile String probeResult = "未自检";

    public String getProbeResult() {
        return probeResult;
    }

    /** 后台做一次自检（App 启动时调用）。 */
    public void selfCheck() {
        new Thread(this::doSelfCheck, "fy-engine-selfcheck").start();
    }

    private void doSelfCheck() {
        StringBuilder sb = new StringBuilder();
        try {
            File nativeDir = new File(ctx.getApplicationInfo().nativeLibraryDir);
            File exec = new File(nativeDir, EXEC_NAME);
            sb.append("nativeDir=").append(nativeDir.getAbsolutePath()).append('\n');
            sb.append("exec 存在=").append(exec.isFile())
              .append(" 大小=").append(exec.length())
              .append(" canExecute=").append(exec.canExecute())
              .append(" canRead=").append(exec.canRead()).append('\n');

            // 依赖库是否都在（缺一个都会 "no backends are loaded" 或 CANNOT LINK）
            for (String lib : new String[]{"libllama-server-impl.so", "libllama-common.so",
                    "libmtmd.so", "libllama.so", "libggml.so", "libggml-base.so"}) {
                File f = new File(nativeDir, lib);
                sb.append("  ").append(lib).append('=').append(f.isFile() ? f.length() : "缺失").append('\n');
            }
            int cpuBackends = 0;
            File[] all = nativeDir.listFiles();
            if (all != null) {
                for (File f : all) {
                    if (f.getName().startsWith("libggml-cpu-android")) cpuBackends++;
                }
            }
            sb.append("CPU 后端变体=").append(cpuBackends).append(" 个\n");

            if (!exec.isFile()) {
                probeResult = sb.append("❌ 引擎文件不存在").toString();
                addLog("[自检] " + probeResult.replace('\n', ' '));
                return;
            }

            sb.append("--- 方式1 direct: --version ---\n").append(runOnce(exec, "--version", false));
            if (!probeLooksOk(sb.toString())) {
                sb.append("--- 方式2 linker64: --version ---\n").append(runOnce(exec, "--version", true));
            }
            probeResult = sb.toString();
        } catch (Throwable t) {
            probeResult = sb.append("自检异常: ").append(t).toString();
        }
        addLog("[自检] " + probeResult.replace("\n", " | "));
    }

    private boolean probeLooksOk(String s) {
        return s.contains("version:") && s.contains("Android");
    }

    /** 用指定方式跑一次引擎命令，返回「退出码 + 合并输出」，最多等 25 秒。 */
    private String runOnce(File exec, String arg, boolean viaLinker) {
        List<String> args = new ArrayList<>();
        args.add(arg);
        Process p = null;
        try {
            p = launch(exec, args, viaLinker);
            StringBuilder out = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                String line;
                long deadline = System.currentTimeMillis() + 25000;
                while (System.currentTimeMillis() < deadline && (line = r.readLine()) != null) {
                    out.append(line).append('\n');
                    if (out.length() > 4000) break;
                }
            }
            p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS);
            int code = -1;
            try {
                code = p.exitValue();
            } catch (IllegalThreadStateException ignored) {
            }
            return "exit=" + code + "\n" + out;
        } catch (Throwable t) {
            return "启动失败: " + t + "\n";
        } finally {
            if (p != null) p.destroy();
        }
    }

    private void doStart(String modelFile, int ctxSize, int threads, int gpuLayers, String modelDir) {
        // threads <= 0 视为"自动"。不要用"核数×系数"：实测 8 核(2小+5中+1大)上
        // 4 线程稳定 42~52 tok/s，6 线程在 24~57 之间抖动，8 线程更差（慢核拖同步点）。
        // 与 Bridge.engineStart 里的默认值保持一致。
        if (threads <= 0) {
            threads = Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors() - 1));
        }
        if (ctxSize <= 0) ctxSize = 4096;

        File model = new File(modelDir, modelFile);
        if (!model.isFile()) {
            lastError = "模型文件不存在: " + model.getAbsolutePath();
            setState("error", lastError);
            return;
        }

        File nativeDir = new File(ctx.getApplicationInfo().nativeLibraryDir);
        File exec = new File(nativeDir, EXEC_NAME);
        if (!exec.isFile()) {
            lastError = "引擎可执行文件缺失: " + exec.getAbsolutePath();
            setState("error", lastError);
            return;
        }
        if (!exec.canExecute()) {
            // 有些机型解包后没给执行位，自己补一下
            //noinspection ResultOfMethodCallIgnored
            exec.setExecutable(true, false);
        }

        try {
            port = findFreePort();
        } catch (IOException e) {
            lastError = "找不到可用端口: " + e.getMessage();
            setState("error", lastError);
            return;
        }

        List<String> args = new ArrayList<>();
        args.add("-m"); args.add(model.getAbsolutePath());
        args.add("-c"); args.add(String.valueOf(ctxSize));
        args.add("-t"); args.add(String.valueOf(threads));
        args.add("--host"); args.add("127.0.0.1");
        args.add("--port"); args.add(String.valueOf(port));
        args.add("--no-webui");
        // 上下文兜底：默认是 disabled，一旦前端估算的 token 数偏小、请求超出 n_ctx，
        // 服务端会直接报错让对话中断。开了以后超长时会自动丢弃最早的历史继续生成。
        args.add("--context-shift");
        // 让服务端在"前缀不完全相同"时也能通过 KV shifting 复用缓存。
        // 多轮对话里这直接决定速度：不开的话历史一长，每轮都要把整个历史重新预填充。
        args.add("--cache-reuse");
        args.add("256");
        // mlock：把模型锁在内存里，避免换页。
        // 实测同一台机器 3B 模型：mmap 只有 3.6~4.7 tok/s，mlock 能到 8.4~9.2 tok/s（约 2 倍）。
        // 代价是内存占用变"硬"，所以做成可关的选项，并且加载失败会自动回退一次。
        if ("mlock".equals(loadMode)) {
            args.add("--load-mode");
            args.add("mlock");
        }
        if (gpuLayers > 0) {
            args.add("-ngl"); args.add(String.valueOf(gpuLayers));
        }

        addLog("$ " + exec.getAbsolutePath() + " " + String.join(" ", args));

        // 策略 1：直接 exec nativeLibraryDir 里的可执行文件
        // 策略 2：用 /system/bin/linker64 手动加载（万一 ROM 的 SELinux 不允许直接 exec）
        try {
            proc = launch(exec, args, false);
            launchStrategy = "direct";
        } catch (IOException e) {
            addLog("直接执行失败（" + e.getMessage() + "），改用 linker64 加载…");
            try {
                proc = launch(exec, args, true);
                launchStrategy = "linker64";
            } catch (IOException e2) {
                lastError = "引擎无法启动：直接执行失败（" + e.getMessage()
                        + "），linker64 回退也失败（" + e2.getMessage() + "）";
                setState("error", lastError);
                return;
            }
        }

        addLog("启动方式：" + launchStrategy);

        // 有些 ROM 会「先成功 fork、再因权限被拒立刻退出」——这种情况也要能回退
        try {
            if (proc.waitFor(1500, java.util.concurrent.TimeUnit.MILLISECONDS)
                    && !"linker64".equals(launchStrategy) && looksLikeExecDenied()) {
                addLog("进程因执行权限被拒退出，改用 linker64 重试…");
                try {
                    proc = launch(exec, args, true);
                    launchStrategy = "linker64";
                    addLog("启动方式：" + launchStrategy);
                } catch (IOException e) {
                    lastError = "linker64 回退失败：" + e.getMessage();
                    setState("error", lastError);
                    return;
                }
            }
        } catch (InterruptedException ignored) {
        }

        setState("loading", "正在加载模型 " + modelFile + " …");
        acquireWakeLock();

        final Process p = proc;
        pumpOut = new Thread(() -> pump(p), "fy-engine-log");
        pumpOut.setDaemon(true);
        pumpOut.start();

        watchdog = new Thread(() -> waitReady(p), "fy-engine-watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
    }

    private volatile String launchStrategy = "";

    public String getLaunchStrategy() {
        return launchStrategy;
    }

    /** 按指定策略启动引擎进程。viaLinker=true 时用 /system/bin/linker64 加载可执行文件。 */
    private Process launch(File exec, List<String> args, boolean viaLinker) throws IOException {
        List<String> cmd = new ArrayList<>();
        if (viaLinker) {
            cmd.add("/system/bin/linker64");
        }
        cmd.add(exec.getAbsolutePath());
        cmd.addAll(args);

        File nativeDir = new File(ctx.getApplicationInfo().nativeLibraryDir);
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.directory(ctx.getFilesDir());
        pb.redirectErrorStream(true);
        // 关键：让动态链接器能在 nativeLibraryDir 里找到 libllama.so / libggml*.so
        pb.environment().put("LD_LIBRARY_PATH", nativeDir.getAbsolutePath());
        pb.environment().put("GGML_BACKEND_PATH", nativeDir.getAbsolutePath());
        pb.environment().put("HOME", ctx.getFilesDir().getAbsolutePath());
        pb.environment().put("TMPDIR", ctx.getCacheDir().getAbsolutePath());
        pb.environment().remove("CLASSPATH");
        return pb.start();
    }

    /** 日志里是否出现「不允许执行」的特征。 */
    private boolean looksLikeExecDenied() {
        List<String> tail = tailLog(12);
        for (String l : tail) {
            String s = l.toLowerCase();
            if (s.contains("permission denied") || s.contains("not executable")
                    || s.contains("cannot execute") || s.contains("exec format error")
                    || s.contains("access denied") || s.contains("avc: denied")) {
                return true;
            }
        }
        return false;
    }

    private void pump(Process p) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
            String line;
            while ((line = r.readLine()) != null) {
                addLog(line);
                // 从日志里提升状态，让用户看到"加载中"的进度感
                if (state.equals("loading") && line.contains("llama_model_load")
                        && line.contains("loaded")) {
                    setState("loading", "模型已加载，正在初始化上下文…");
                }
            }
        } catch (IOException ignored) {
        }
    }

    private void waitReady(Process p) {
        long deadline = System.currentTimeMillis() + 10 * 60 * 1000L; // 大模型冷启动上限 10 分钟
        while (System.currentTimeMillis() < deadline) {
            if (!p.isAlive()) {
                int code = -1;
                try {
                    code = p.exitValue();
                } catch (IllegalThreadStateException ignored) {
                }
                if (!"stopped".equals(state)) {
                    lastError = "引擎进程异常退出（code=" + code + "）。最后日志："
                            + lastLines(3);
                    setState("error", lastError);
                }
                releaseWakeLock();
                // mlock 加载失败（内存不够 / 内核不允许）时，自动退回默认 mmap 再试一次，
                // 免得用户看到"引擎出错"就卡死在那儿。
                if ("mlock".equals(loadMode) && !mlockRetried && lastStart != null) {
                    mlockRetried = true;
                    loadMode = "";
                    addLog("[回退] mlock 加载失败，改用默认 mmap 重新加载…");
                    setState("starting", "内存锁定失败，改用普通方式重新加载…");
                    final String[] p0 = lastStart;
                    new Thread(() -> doStart(p0[0], Integer.parseInt(p0[1]),
                            Integer.parseInt(p0[2]), Integer.parseInt(p0[3]), p0[4]),
                            "fy-engine-mlock-fallback").start();
                }
                return;
            }
            if (probeHealth()) {
                setState("ready", "引擎就绪（端口 " + port + "）");
                return;
            }
            try {
                Thread.sleep(700);
            } catch (InterruptedException e) {
                return;
            }
        }
        lastError = "等待引擎就绪超时（10 分钟）";
        setState("error", lastError);
        stop();
    }

    private boolean probeHealth() {
        HttpURLConnection c = null;
        try {
            URL u = new URL("http://127.0.0.1:" + port + "/health");
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1500);
            int code = c.getResponseCode();
            if (code != 200) return false;
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()))) {
                String line = r.readLine();
                return line != null && line.contains("ok");
            }
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    public void stop() {
        synchronized (lock) {
            Process p = proc;
            proc = null;
            if (p != null) {
                p.destroy();
                try {
                    if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly();
                } catch (InterruptedException ignored) {
                }
            }
            releaseWakeLock();
            setState("stopped", "引擎已停止");
        }
    }

    private String lastLines(int n) {
        List<String> l = tailLog(n);
        StringBuilder sb = new StringBuilder();
        for (String s : l) sb.append(s).append(" | ");
        return sb.toString();
    }

    private static int findFreePort() throws IOException {
        try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return s.getLocalPort();
        }
    }

    @SuppressWarnings("deprecation")
    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fy:engine");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(30 * 60 * 1000L);
        } catch (Exception ignored) {
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
        }
        wakeLock = null;
    }
}
