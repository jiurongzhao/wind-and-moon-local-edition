import android.content.Context;
import android.content.res.AssetManager;
import com.fy.local.AssetServer;
import com.fy.local.Providers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * ProxyJvmTest —— 在 JVM 上真跑一遍 AssetServer 的 /api/ 反向代理。
 *
 * 为什么必须真跑：这是「用外部 OpenAI 兼容服务（局域网自建 Ollama / LM Studio / 云端 API）」
 * 的整条命脉 —— 前端 -> 本机 AssetServer -> 上游服务。它要是错了：
 *   * 用户配好了地址也聊不了；
 *   * 或者更糟：**流式没透传**，回复要等整段生成完才出现（看起来像卡死）；
 *   * 或者 API key 没带上 / 带错了。
 *
 * 所以这里起一个**假的 OpenAI 兼容上游**（JDK 自带的 HttpServer），
 * 然后按前端的方式往 AssetServer 打请求，验证：
 *   1. /api/models 与 /api/chat/completions 的路由拼接（base 到 /v1 为止，不重复拼 /v1）
 *   2. POST body 逐字节转发
 *   3. Authorization: Bearer <key> 被带上（key 只存在原生侧）
 *   4. **SSE 分块实时透传**：上游每写一块，客户端能立刻收到（而不是等结束）
 *   5. 没配置外部服务时返回 503，而不是挂死
 *   6. GET /fetch?url=…（在线卡库的通用下载代理）：成功透传、只放行 https、
 *      不转发前端 Cookie/Authorization、上游 404/连不上 → 502、超上限 → 413
 *
 * 用法: java -cp <classes> ProxyJvmTest
 */
public class ProxyJvmTest {

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

    /** 假的 OpenAI 兼容上游 */
    static HttpServer startUpstream(AtomicReference<String> seenAuth, AtomicReference<String> seenBody,
                                    AtomicReference<String> seenPath, AtomicLong firstChunkAt,
                                    AtomicLong lastChunkAt, AtomicReference<String> seenCookie,
                                    AtomicReference<String> seenFetchAuth) throws Exception {
        HttpServer srv = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);

        srv.createContext("/v1/models", (HttpExchange ex) -> {
            seenPath.set(ex.getRequestURI().getPath());
            byte[] body = "{\"object\":\"list\",\"data\":[{\"id\":\"fake-model-a\"},{\"id\":\"fake-model-b\"}]}"
                    .getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(200, body.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        });

        srv.createContext("/v1/chat/completions", (HttpExchange ex) -> {
            seenAuth.set(ex.getRequestHeaders().getFirst("Authorization"));
            seenPath.set(ex.getRequestURI().getPath());
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = ex.getRequestBody().read(buf)) > 0) bos.write(buf, 0, n);
            seenBody.set(bos.toString("UTF-8"));

            ex.getResponseHeaders().add("Content-Type", "text/event-stream");
            ex.sendResponseHeaders(200, 0);      // 0 = chunked，模拟真实 SSE
            OutputStream os = ex.getResponseBody();
            String[] chunks = {
                    "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n",
                    "data: [DONE]\n\n"
            };
            for (int i = 0; i < chunks.length; i++) {
                os.write(chunks[i].getBytes(StandardCharsets.UTF_8));
                os.flush();
                if (i == 0) firstChunkAt.set(System.currentTimeMillis());
                if (i < chunks.length - 1) {
                    try { Thread.sleep(400); } catch (InterruptedException ignored) { }
                }
            }
            lastChunkAt.set(System.currentTimeMillis());
            os.close();
        });

        /* ---- /fetch 用的假下载源 ------------------------------------------
           全部在回环明文上，只有「JVM 测试放行回环 http」时 AssetServer 才会去连。 */
        srv.createContext("/lib/pack.json", (HttpExchange ex) -> {
            /* 记录 AssetServer 转发过来的头：用来证明 /fetch 不转发前端的凭证 */
            seenCookie.set(ex.getRequestHeaders().getFirst("Cookie"));
            seenFetchAuth.set(ex.getRequestHeaders().getFirst("Authorization"));
            byte[] body = "{\"spec\":\"fy_pack_v1\",\"count\":1,\"cards\":[]}".getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(200, body.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        });

        srv.createContext("/lib/notfound", (HttpExchange ex) -> {
            byte[] body = "nope".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(404, body.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        });

        /* 声明了 Content-Length 的超限响应：应被"先拦"（不读 body） */
        srv.createContext("/lib/big", (HttpExchange ex) -> {
            byte[] body = new byte[4096];
            java.util.Arrays.fill(body, (byte) 'x');
            ex.getResponseHeaders().add("Content-Type", "text/plain");
            ex.sendResponseHeaders(200, body.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        });

        /* chunked（不发 Content-Length）的超限响应：应被"边读边数"兜住 */
        srv.createContext("/lib/bigchunk", (HttpExchange ex) -> {
            byte[] body = new byte[4096];
            java.util.Arrays.fill(body, (byte) 'y');
            ex.getResponseHeaders().add("Content-Type", "text/plain");
            ex.sendResponseHeaders(200, 0);      // 0 = chunked
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        });

        srv.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(4));
        srv.start();
        return srv;
    }

    public static void main(String[] args) throws Exception {
        System.out.println("=== /api 反向代理 JVM 实跑测试 ===");
        String home = System.getProperty("user.home");
        String assetsDir = home + "/2/fy/app/assets";
        String tmp = home + "/tmpwork/proxytest";
        new java.io.File(tmp).mkdirs();

        AtomicReference<String> auth = new AtomicReference<>();
        AtomicReference<String> body = new AtomicReference<>();
        AtomicReference<String> path = new AtomicReference<>();
        AtomicLong firstChunk = new AtomicLong(0);
        AtomicLong lastChunk = new AtomicLong(0);
        AtomicReference<String> fetchCookie = new AtomicReference<>();
        AtomicReference<String> fetchAuth = new AtomicReference<>();

        HttpServer upstream = startUpstream(auth, body, path, firstChunk, lastChunk, fetchCookie, fetchAuth);
        int upPort = upstream.getAddress().getPort();
        System.out.println("假上游: http://127.0.0.1:" + upPort + "/v1");

        Context ctx = new Context(home + "/2/fy/native", tmp + "/files", tmp + "/cache");
        /* JVM 测试专用构造器：放行回环明文 http（生产永远 false），并把 /fetch 上限压到 1KB
           好让"超限 → 413"这条能用一个几百字节的假响应覆盖。 */
        AssetServer server = new AssetServer(new AssetManager(assetsDir), ctx, 1024, true);
        int port = server.start();
        System.out.println("AssetServer: http://127.0.0.1:" + port + "\n");

        // ---------- 1. 没配置外部服务时应当 503，而不是挂死 ----------
        String r503 = raw("GET", "http://127.0.0.1:" + port + "/api/models", null, null);
        check("未配置外部服务时返回 503 并给出提示",
                r503.startsWith("HTTP/1.1 503") && r503.contains("没有配置外部模型服务"),
                r503.split("\r\n")[0] + " / " + r503.substring(Math.max(0, r503.length() - 40)).replace("\n", " "));

        // ---------- 2. 配置成「用户只填到 host:port」的写法，验证自动补 /v1 ----------
        Providers.save(ctx, Providers.MODE_REMOTE, "http://127.0.0.1:" + upPort, "sk-test-key-123", "fake-model-a");
        check("base 只填到端口时自动补 /v1（normalizeBase）",
                ("http://127.0.0.1:" + upPort + "/v1").equals(Providers.normalizeBase("http://127.0.0.1:" + upPort)),
                Providers.normalizeBase("http://127.0.0.1:" + upPort));
        check("base 已含 /v1 时不重复拼",
                ("http://127.0.0.1:" + upPort + "/v1").equals(Providers.normalizeBase("http://127.0.0.1:" + upPort + "/v1/")),
                Providers.normalizeBase("http://127.0.0.1:" + upPort + "/v1/"));

        // ---------- 2b. 模型列表解析（不用 JSON 库，手写扫描） ----------
        java.util.List<String> ids = Providers.parseModelIds(
                "{\"object\":\"list\",\"data\":[{\"id\":\"a\",\"object\":\"model\"},{\"id\":\"b\"}]}");
        check("能从 /v1/models 响应里解析出模型 id（含去重）",
                ids.size() == 2 && ids.contains("a") && ids.contains("b"), ids.toString());
        java.util.List<String> named = Providers.parseModelIds(
                "{\"models\":[{\"name\":\"llama3:8b\"},{\"name\":\"qwen2.5:7b\"}]}");
        check("兼容 \"models\" 里取 name 的形状",
                named.size() == 2 && named.contains("llama3:8b"), named.toString());

        // ---------- 3. GET /api/models 透传 ----------
        String models = raw("GET", "http://127.0.0.1:" + port + "/api/models", null, null);
        check("GET /api/models 透传成功且路径拼接正确",
                models.startsWith("HTTP/1.1 200") && models.contains("fake-model-a") && models.contains("fake-model-b"),
                models.split("\r\n")[0]);
        check("上游收到的路径是 /v1/models", "/v1/models".equals(path.get()), String.valueOf(path.get()));

        // ---------- 4. POST /api/chat/completions：body / key / 流式 ----------
        String reqBody = "{\"model\":\"fake-model-a\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}],\"stream\":true}";
        long t0 = System.currentTimeMillis();
        StringBuilder firstSeen = new StringBuilder();
        long[] firstSeenAt = new long[]{0};
        String resp = rawStreaming("POST", "http://127.0.0.1:" + port + "/api/chat/completions", reqBody,
                "sk-test-key-123", firstSeen, firstSeenAt);
        long tEnd = System.currentTimeMillis();

        check("POST 转发返回 200 且内容完整",
                resp.startsWith("HTTP/1.1 200") && resp.contains("data: [DONE]"),
                resp.split("\r\n")[0]);
        check("请求体被逐字节转发到上游（含 model 与 messages）",
                reqBody.equals(body.get()), String.valueOf(body.get()).substring(0, Math.min(80, String.valueOf(body.get()).length())));
        check("Authorization: Bearer <key> 由原生侧补上（前端拿不到 key）",
                "Bearer sk-test-key-123".equals(auth.get()), String.valueOf(auth.get()));
        check("上游路径是 /v1/chat/completions（没有 /v1/v1）",
                "/v1/chat/completions".equals(path.get()), String.valueOf(path.get()));

        // 关键：首块到达时间要明显早于"上游写完最后一块之后"
        long endDelay = tEnd - lastChunk.get();
        check("SSE 实时透传：首块在上游还没写完时就已到达客户端",
                firstSeenAt[0] > 0 && firstSeenAt[0] < lastChunk.get(),
                "首块@" + (firstSeenAt[0] - t0) + "ms，上游末块@" + (lastChunk.get() - t0)
                        + "ms，客户端结束@" + (tEnd - t0) + "ms");
        check("首块延迟远小于整段耗时（说明不是攒完再发）",
                (firstSeenAt[0] - t0) < (lastChunk.get() - t0) && (firstSeenAt[0] - t0) < 800,
                "首块 " + (firstSeenAt[0] - t0) + "ms / 全程 " + (lastChunk.get() - t0) + "ms");

        // ---------- 5. 上游不可达时给 502 而不是挂死 ----------
        Providers.save(ctx, Providers.MODE_REMOTE, "http://127.0.0.1:9/v1", "", "x");
        long t1 = System.currentTimeMillis();
        String bad = raw("GET", "http://127.0.0.1:" + port + "/api/models", null, null);
        long cost = System.currentTimeMillis() - t1;
        check("上游连不上时返回 502 并快速失败（不挂死）",
                bad.startsWith("HTTP/1.1 502") && cost < 12000,
                bad.split("\r\n")[0] + " 耗时 " + cost + "ms");

        // ---------- 6. 静态资源不受代理影响 ----------
        String index = raw("GET", "http://127.0.0.1:" + port + "/", null, null);
        check("代理不影响静态资源（仍能取到 index.html）",
                index.startsWith("HTTP/1.1 200") && index.contains("<html"),
                index.split("\r\n")[0]);

        // ---------- 7. /fetch 通用下载代理（在线卡库：Gitee 无 CORS，必须同源代理） ----------
        System.out.println("\n【/fetch 通用下载代理】");
        String okUrl = "http://127.0.0.1:" + upPort + "/lib/pack.json";
        long tFetch = System.currentTimeMillis();
        String okResp = rawHeaders("http://127.0.0.1:" + port + "/fetch?url=" + enc(okUrl),
                new String[][]{{"Cookie", "fy-should-not-leak=1"}, {"Authorization", "Bearer should-not-leak"}});
        check("/fetch 成功透传上游内容（200 + 原文）",
                statusOf(okResp) == 200 && okResp.contains("fy_pack_v1"),
                "HTTP " + statusOf(okResp));
        check("/fetch 不转发前端 Cookie（无凭证泄漏）",
                fetchCookie.get() == null, String.valueOf(fetchCookie.get()));
        check("/fetch 不转发前端 Authorization（无凭证泄漏）",
                fetchAuth.get() == null, String.valueOf(fetchAuth.get()));
        check("/fetch 失败也快速返回（不挂死）", System.currentTimeMillis() - tFetch < 10000,
                (System.currentTimeMillis() - tFetch) + "ms");

        String httpResp = raw("GET",
                "http://127.0.0.1:" + port + "/fetch?url=" + enc("http://example.com/pack.json"), null, null);
        check("非 https 地址被拒（400，不回显内容）",
                httpResp.startsWith("HTTP/1.1 400") && httpResp.contains("只允许 https"),
                httpResp.split("\r\n")[0]);

        String fileResp = raw("GET",
                "http://127.0.0.1:" + port + "/fetch?url=" + enc("file:///etc/passwd"), null, null);
        check("file:// 之类的 scheme 被拒（400）",
                fileResp.startsWith("HTTP/1.1 400"), fileResp.split("\r\n")[0]);

        String noUrl = raw("GET", "http://127.0.0.1:" + port + "/fetch", null, null);
        check("缺少 url 参数时 400 并给出提示",
                noUrl.startsWith("HTTP/1.1 400") && noUrl.contains("url"), noUrl.split("\r\n")[0]);

        long t404 = System.currentTimeMillis();
        String notFound = raw("GET",
                "http://127.0.0.1:" + port + "/fetch?url=" + enc("http://127.0.0.1:" + upPort + "/lib/notfound"),
                null, null);
        long cost404 = System.currentTimeMillis() - t404;
        check("上游 404 → 502 且带上游状态码、快速返回",
                notFound.startsWith("HTTP/1.1 502") && notFound.contains("404") && cost404 < 10000,
                notFound.split("\r\n")[0] + " 耗时 " + cost404 + "ms");

        long tDead = System.currentTimeMillis();
        String dead = raw("GET",
                "http://127.0.0.1:" + port + "/fetch?url=" + enc("http://127.0.0.1:9/pack.json"), null, null);
        long costDead = System.currentTimeMillis() - tDead;
        check("上游连不上 → 502 且快速失败（不挂死）",
                dead.startsWith("HTTP/1.1 502") && costDead < 15000,
                dead.split("\r\n")[0] + " 耗时 " + costDead + "ms");

        String big = raw("GET",
                "http://127.0.0.1:" + port + "/fetch?url=" + enc("http://127.0.0.1:" + upPort + "/lib/big"),
                null, null);
        check("声明 Content-Length 超上限 → 413（先拦，不读 body）",
                big.startsWith("HTTP/1.1 413"), big.split("\r\n")[0]);

        String bigChunk = raw("GET",
                "http://127.0.0.1:" + port + "/fetch?url=" + enc("http://127.0.0.1:" + upPort + "/lib/bigchunk"),
                null, null);
        check("chunked 响应边读边数、超上限 → 413",
                bigChunk.startsWith("HTTP/1.1 413"), bigChunk.split("\r\n")[0]);

        upstream.stop(0);
        server.stop();

        System.out.println("\n结果： " + pass + " 通过 / " + fail + " 失败");
        /* 显式退出：HttpServer 的线程池不是 daemon，不退出会让测试挂到超时 */
        System.exit(fail > 0 ? 1 : 0);
    }

    /** 普通请求（读完整个响应） */
    static String raw(String method, String url, String body, String auth) throws Exception {
        StringBuilder sb = new StringBuilder();
        long[] t = new long[1];
        return rawStreaming(method, url, body, auth, sb, t);
    }

    /** 带自定义请求头的 GET；返回 "HTTP/1.1 <code>\r\n...\r\n\r\n<body>"（够断言用） */
    static String rawHeaders(String url, String[][] headers) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("GET");
        c.setConnectTimeout(5000);
        c.setReadTimeout(30000);
        for (String[] h : headers) c.setRequestProperty(h[0], h[1]);
        int code = c.getResponseCode();
        InputStream in;
        try {
            in = c.getInputStream();
        } catch (Exception e) {
            in = c.getErrorStream();
        }
        StringBuilder out = new StringBuilder("HTTP/1.1 ").append(code).append("\r\n\r\n");
        if (in != null) {
            byte[] buf = new byte[512];
            int n;
            while ((n = in.read(buf)) > 0) out.append(new String(buf, 0, n, StandardCharsets.UTF_8));
            in.close();
        }
        c.disconnect();
        return out.toString();
    }

    /** 从 raw/rawHeaders 的返回里抠出状态码（抠不到算 -1） */
    static int statusOf(String resp) {
        int i = String.valueOf(resp).indexOf("HTTP/1.1 ");
        if (i < 0) return -1;
        String rest = resp.substring(i + 9).trim();
        int sp = rest.indexOf(' ');
        if (sp < 0) sp = rest.indexOf('\r');
        try {
            return Integer.parseInt(rest.substring(0, sp < 0 ? rest.length() : sp).trim());
        } catch (Exception e) {
            return -1;
        }
    }

    static String enc(String s) throws Exception {
        return java.net.URLEncoder.encode(s, "UTF-8");
    }

    /** 发请求并按块读响应；首块到达时间写进 firstAt[0]，首块内容写进 firstSeen */
    static String rawStreaming(String method, String url, String body, String auth,
                               StringBuilder firstSeen, long[] firstAt) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(5000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Content-Type", "application/json");
        if (body != null) {
            c.setDoOutput(true);
            try (OutputStream os = c.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = c.getResponseCode();
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(code).append(" ")
                .append(code == 200 ? "OK" : (code >= 400 && code < 500 ? "ClientError" : "ServerError"))
                .append("\r\n");
        for (String k : new String[]{"Content-Type", "X-Fy-Proxy"}) {
            String v = c.getHeaderField(k);
            if (v != null) head.append(k).append(": ").append(v).append("\r\n");
        }
        head.append("\r\n");

        InputStream in;
        try {
            in = c.getInputStream();
        } catch (Exception e) {
            in = c.getErrorStream();
        }
        StringBuilder out = new StringBuilder(head);
        if (in != null) {
            byte[] buf = new byte[512];
            int n;
            boolean first = true;
            while ((n = in.read(buf)) > 0) {
                String chunk = new String(buf, 0, n, StandardCharsets.UTF_8);
                if (first) {
                    firstSeen.append(chunk);
                    firstAt[0] = System.currentTimeMillis();
                    first = false;
                }
                out.append(chunk);
            }
            in.close();
        }
        c.disconnect();
        return out.toString();
    }
}
