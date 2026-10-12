import android.content.Context;
import com.fy.local.Engine;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * EngineJvmTest —— 在 JVM 上真跑一遍 Engine.java（用最小 Android 桩 + 真实 llama-server）。
 *
 * 这是目前唯一没被执行过的代码里最关键的一块，跑它等于把「App 启动引擎 → 模型加载 →
 * HTTP 就绪 → 前端发请求 → 停止」这条链路在真机之前先验证一遍。
 *
 * 覆盖：
 *   1. selfCheck()（App 启动时的 --version 自检）
 *   2. start() 的参数拼装 / LD_LIBRARY_PATH / 状态机（starting → loading → ready）
 *   3. 就绪后真的能跑一次 /v1/chat/completions 流式对话
 *   4. stop() 能干净收尾
 *
 * 用法: java -cp <classes> EngineJvmTest [模型文件名]
 */
public class EngineJvmTest {

    static final List<String> states = new ArrayList<>();
    static final List<String> logs = new ArrayList<>();
    static int pass = 0, fail = 0;

    static void check(String name, boolean ok) {
        check(name, ok, null);
    }

    static void check(String name, boolean ok, String extra) {
        if (ok) {
            pass++;
            System.out.println("  ✅ " + name);
        } else {
            fail++;
            System.out.println("  ❌ " + name + (extra != null ? " — " + extra : ""));
        }
    }

    public static void main(String[] args) throws Exception {
        String home = System.getProperty("user.home");
        String root = home + "/2/fy";
        String nativeDir = root + "/native";
        String work = root + "/build/jvmtest";
        String modelDir = root + "/models";
        String model = args.length > 0 ? args[0] : "qwen2.5-0.5b-instruct-q4_k_m.gguf";
        String loadMode = args.length > 1 ? args[1] : "";

        System.out.println("=== Engine.java JVM 实跑测试 ===");
        System.out.println("nativeLibraryDir = " + nativeDir);
        System.out.println("工作目录         = " + work);
        System.out.println("模型             = " + model);

        Context ctx = new Context(nativeDir, work + "/files", work + "/cache");
        Engine engine = new Engine(ctx, new Engine.Listener() {
            @Override
            public void onState(String state, String message) {
                states.add(state);
                System.out.println("  [state] " + state + " — " + message);
            }

            @Override
            public void onLog(String line) {
                if (logs.size() < 500) logs.add(line);
            }
        });

        System.out.println("\n【1】启动自检 selfCheck()");
        engine.selfCheck();
        long t0 = System.currentTimeMillis();
        while (System.currentTimeMillis() - t0 < 30000
                && "未自检".equals(engine.getProbeResult())) {
            Thread.sleep(300);
        }
        String probe = engine.getProbeResult();
        System.out.println("--- 自检结果 ---\n" + probe + "----------------");
        check("自检完成", !"未自检".equals(probe));
        check("自检里能看到 version:", probe.contains("version:"));
        check("自检认出这是 Android 构建", probe.contains("Android"));
        check("自检找到 CPU 后端变体", probe.matches("(?s).*CPU 后端变体=[1-9].*"));
        check("自检里没有「缺失」的依赖库", !probe.contains("缺失"),
                probe.replace('\n', '|'));

        System.out.println("\n【2】启动引擎 start()  loadMode=" + (loadMode.isEmpty() ? "auto(mmap)" : loadMode));
        states.clear();
        if (!loadMode.isEmpty()) engine.setLoadMode(loadMode);
        engine.start(model, 2048, 6, 0, modelDir);
        long t1 = System.currentTimeMillis();
        // 等够 10 分钟：和 App 里 Engine 的看门狗上限一致。
        // 实测冷启动（页缓存没热）加载 4B 要 2 分钟以上，不能按 17 秒的暖启动预期来卡。
        while (System.currentTimeMillis() - t1 < 600000 && !engine.isReady()
                && !"error".equals(engine.getState())) {
            Thread.sleep(500);
        }
        long loadMs = System.currentTimeMillis() - t1;
        System.out.println("  加载用时 " + (loadMs / 1000) + "s，"
                + "状态=" + engine.getState() + " 端口=" + engine.getPort()
                + " 启动方式=" + engine.getLaunchStrategy());
        check("状态机走过 starting", states.contains("starting"), states.toString());
        check("状态机走过 loading", states.contains("loading"), states.toString());
        check("最终到达 ready", engine.isReady(), "实际 " + engine.getState()
                + " / " + engine.getLastError());
        check("拿到了监听端口", engine.getPort() > 1024, "port=" + engine.getPort());
        check("记录了启动方式", engine.getLaunchStrategy().length() > 0,
                engine.getLaunchStrategy());

        System.out.println("\n【3】像前端那样发一次流式对话");
        String content = null;
        try {
            content = chat(engine.getPort(), "用一句话介绍你自己。", model);
        } catch (Exception e) {
            content = null;
            System.out.println("  请求失败: " + e);
        }
        System.out.println("  回复：" + content);
        check("HTTP 对话返回了非空内容", content != null && !content.trim().isEmpty());
        check("回复里没有残留思考段标记", content != null
                && !content.contains("think") && !content.contains("｜end"));

        System.out.println("\n【4】停止引擎 stop()");
        engine.stop();
        Thread.sleep(1500);
        check("停止后状态回到 stopped", "stopped".equals(engine.getState()),
                engine.getState());
        check("停止后端口不再可连", !portOpen(engine.getPort()));

        System.out.println("\n" + "─".repeat(56));
        System.out.println("结果： " + pass + " 通过 / " + fail + " 失败");
        if (fail > 0) {
            System.out.println("\n最后 15 行引擎日志：");
            int from = Math.max(0, logs.size() - 15);
            for (int i = from; i < logs.size(); i++) System.out.println("  " + logs.get(i));
        }
        System.exit(fail == 0 ? 0 : 1);
    }

    /**
     * 按前端的调用方式发一次流式请求，返回拼起来的正文。
     * 关键：默认关掉思考模式（enable_thinking=false + Qwen3 的 /no_think 软开关），
     * 这正是 App 现在的默认行为 —— 否则 Qwen3 会把 token 全花在思考段上，正文是空的。
     */
    static String chat(int port, String prompt, String modelName) throws Exception {
        HttpURLConnection c = (HttpURLConnection)
                new URL("http://127.0.0.1:" + port + "/v1/chat/completions").openConnection();
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "application/json");
        c.setConnectTimeout(5000);
        c.setReadTimeout(120000);
        c.setDoOutput(true);
        String sys = "你是角色扮演助手。" + (modelName != null && modelName.toLowerCase().contains("qwen3")
                ? "\n\n/no_think" : "");
        String body = "{\"messages\":[{\"role\":\"system\",\"content\":" + orgJsonQuote(sys)
                + "},{\"role\":\"user\",\"content\":" + orgJsonQuote(prompt)
                + "}],\"stream\":true,\"max_tokens\":60,\"temperature\":0.7,"
                + "\"chat_template_kwargs\":{\"enable_thinking\":false}}";
        try (OutputStream os = c.getOutputStream()) {
            os.write(body.getBytes("UTF-8"));
        }
        if (c.getResponseCode() != 200) {
            throw new RuntimeException("HTTP " + c.getResponseCode());
        }
        StringBuilder acc = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (!line.startsWith("data:")) continue;
                String data = line.substring(5).trim();
                if ("[DONE]".equals(data)) break;
                int i = data.indexOf("\"content\":\"");
                if (i < 0) continue;
                int j = i + 11;
                StringBuilder piece = new StringBuilder();
                for (; j < data.length(); j++) {
                    char ch = data.charAt(j);
                    if (ch == '\\') {
                        char n = data.charAt(++j);
                        if (n == 'n') piece.append('\n');
                        else if (n == 't') piece.append('\t');
                        else if (n == 'u') {
                            piece.append((char) Integer.parseInt(data.substring(j + 1, j + 5), 16));
                            j += 4;
                        } else piece.append(n);
                    } else if (ch == '"') break;
                    else piece.append(ch);
                }
                acc.append(piece);
            }
        } finally {
            c.disconnect();
        }
        return acc.toString();
    }

    static String orgJsonQuote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c == '\n') sb.append("\\n");
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

    static boolean portOpen(int port) {
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress("127.0.0.1", port), 800);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
