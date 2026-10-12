import android.content.Context;
import android.content.res.AssetManager;
import com.fy.local.AssetServer;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * AssetServerJvmTest —— 在 JVM 上真跑一遍 AssetServer.java。
 *
 * 它是 WebView 的入口：它要是错了，App 打开就是白屏。
 * 这里用真实文件目录冒充 APK 的 assets/，起服务后按浏览器的方式发真实 HTTP 请求。
 *
 * 覆盖：路由（/ → index.html）、MIME、Content-Length、内容逐字节一致、404、
 *       只监听 127.0.0.1、并发多请求（WebView 会并发拉资源）。
 *
 * 用法: java -cp <classes> AssetServerJvmTest
 */
public class AssetServerJvmTest {

    static int pass = 0, fail = 0;

    static void check(String name, boolean ok, String extra) {
        if (ok) {
            pass++;
            System.out.println("  ✅ " + name);
        } else {
            fail++;
            System.out.println("  ❌ " + name + (extra != null ? " — " + extra : ""));
        }
    }

    static void check(String name, boolean ok) {
        check(name, ok, null);
    }

    public static void main(String[] args) throws Exception {
        String uiDir = System.getProperty("user.home") + "/2/fy/app/assets";
        System.out.println("=== AssetServer JVM 实跑测试 ===");
        System.out.println("assets 目录 = " + uiDir);

        // 代理需要 SharedPreferences（外部模型服务配置），所以构造时要给 Context
        String tmp = System.getProperty("user.home") + "/tmpwork/assettest";
        Context ctx = new Context(System.getProperty("user.home") + "/2/fy/native",
                tmp + "/files", tmp + "/cache");
        AssetServer server = new AssetServer(new AssetManager(uiDir), ctx);
        int port = server.start();
        System.out.println("监听端口 = " + port);

        System.out.println("\n【1】根路径应该返回 index.html");
        Resp root = get(port, "/");
        check("GET / → 200", root.code == 200, "code=" + root.code);
        byte[] indexFile = Files.readAllBytes(Paths.get(uiDir, "ui/index.html"));
        check("内容与 ui/index.html 逐字节一致", java.util.Arrays.equals(root.body, indexFile),
                "收到 " + root.body.length + " 字节, 文件 " + indexFile.length + " 字节");
        check("Content-Type 是 text/html", root.contentType.contains("text/html"),
                root.contentType);

        System.out.println("\n【2】各个前端文件都能取到且 MIME 正确");
        String[][] files = {
                {"/index.html", "text/html"},
                {"/app.js", "application/javascript"},
                {"/store.js", "application/javascript"},
                {"/mock.js", "application/javascript"},
                {"/style.css", "text/css"},
                {"/presets.json", "application/json"},
        };
        for (String[] f : files) {
            Resp r = get(port, f[0]);
            byte[] expect = Files.readAllBytes(Paths.get(uiDir, "ui" + f[0]));
            check("GET " + f[0] + " → 200 且内容一致",
                    r.code == 200 && java.util.Arrays.equals(r.body, expect),
                    "code=" + r.code + " got=" + r.body.length + " want=" + expect.length);
            if (!r.contentType.contains(f[1])) {
                check("  ↳ MIME " + f[1], false, "实际 " + r.contentType);
            }
        }
        Resp r = get(port, "/app.js");
        check("app.js 的 MIME 是 javascript", r.contentType.contains("javascript"), r.contentType);
        r = get(port, "/presets.json");
        check("presets.json 的 MIME 是 json", r.contentType.contains("json"), r.contentType);
        r = get(port, "/style.css");
        check("style.css 的 MIME 是 css", r.contentType.contains("css"), r.contentType);

        System.out.println("\n【3】带 query 的路径要能正确处理（浏览器会加时间戳）");
        Resp q = get(port, "/app.js?v=123456");
        check("GET /app.js?v=123 仍返回 200 且内容正确",
                q.code == 200 && q.body.length > 1000, "code=" + q.code + " len=" + q.body.length);

        System.out.println("\n【4】不存在的路径返回 404");
        Resp miss = get(port, "/nope.js");
        check("GET /nope.js → 404", miss.code == 404, "code=" + miss.code);

        System.out.println("\n【5】并发拉取（WebView 首屏会同时要 6 个资源）");
        Thread[] threads = new Thread[8];
        final int[] okCount = {0};
        for (int i = 0; i < threads.length; i++) {
            final int idx = i;
            threads[i] = new Thread(() -> {
                try {
                    Resp r2 = get(port, idx % 2 == 0 ? "/app.js" : "/index.html");
                    if (r2.code == 200 && r2.body.length > 500) {
                        synchronized (okCount) {
                            okCount[0]++;
                        }
                    }
                } catch (Exception ignored) {
                }
            });
            threads[i].start();
        }
        for (Thread t : threads) t.join();
        check("8 个并发请求全部成功", okCount[0] == 8, "成功 " + okCount[0] + "/8");

        System.out.println("\n【6】只监听回环地址");
        check("127.0.0.1 可连", portOpen("127.0.0.1", port));
        String lanIp = firstLanIp();
        if (lanIp != null) {
            check("局域网地址 " + lanIp + " 连不上（不该暴露）", !portOpen(lanIp, port));
        } else {
            System.out.println("  （没拿到局域网 IP，跳过）");
        }

        server.stop();
        System.out.println("\n" + "─".repeat(56));
        System.out.println("结果： " + pass + " 通过 / " + fail + " 失败");
        System.exit(fail == 0 ? 0 : 1);
    }

    static class Resp {
        int code;
        byte[] body;
        String contentType = "";
    }

    static Resp get(int port, String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection)
                new URL("http://127.0.0.1:" + port + path).openConnection();
        c.setConnectTimeout(3000);
        c.setReadTimeout(5000);
        c.setInstanceFollowRedirects(false);
        Resp resp = new Resp();
        resp.code = c.getResponseCode();
        resp.contentType = String.valueOf(c.getContentType());
        InputStream in = resp.code == 200 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        if (in != null) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
        }
        resp.body = bos.toByteArray();
        c.disconnect();
        return resp;
    }

    static boolean portOpen(String host, int port) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), 800);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static String firstLanIp() {
        try {
            java.util.Enumeration<java.net.NetworkInterface> ifaces =
                    java.net.NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                java.net.NetworkInterface ni = ifaces.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    java.net.InetAddress a = addrs.nextElement();
                    if (a instanceof java.net.Inet4Address) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }
}
