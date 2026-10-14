package com.fy.local;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 极小的本地静态资源服务器。
 *
 * 为什么不直接用 file:///android_asset/ ？
 *   因为 file:// 页面在 WebView 里是「opaque origin」，IndexedDB 会被禁用、
 *   跨端口 fetch 也容易被拦。用一个真实的 http://127.0.0.1 源就没这些破事，
 *   前端可以放心用 IndexedDB + fetch 直连 llama-server。
 *
 * 只监听 127.0.0.1，仅本机可访问，不暴露到局域网。
 *
 * 另外承担两个反向代理：
 *
 * 1) /api/ —— 把外部的 OpenAI 兼容服务（Ollama / LM Studio / 云端 API）
 *    通过本机 127.0.0.1 转发出去。这样做有两个好处：
 *      - WebView 只跟同源地址打交道，没有跨域（CORS）问题 —— Ollama 默认只允许 localhost 源，
 *        直连必然失败；
 *      - API key 只存在原生侧，前端拿不到。
 *    转发是**流式**的：边读上游边 flush，SSE 增量照常到达前端。
 *
 * 2) GET /fetch?url=<urlencoded> —— 通用 https GET 代理，给「在线卡库」这类纯下载用。
 *    原因同上：Gitee 的 raw / release 附件不带 Access-Control-Allow-Origin，WebView 直连必被 CORS 拦。
 *    安全边界（见 fetchProxy）：
 *      - 只允许 https（http/file/ftp… 一律 400），避免被前端当成任意内网探测器；
 *      - 不转发前端的任何请求头（Cookie / Authorization / Referer 全部丢掉），无凭证泄漏；
 *      - 跟随重定向、连接 15s / 读取 60s 超时、响应体上限 64MB（超出 413），失败快速回 502。
 */
public class AssetServer {

    private static final String TAG = "FY/AssetServer";

    /** /fetch 单次响应体上限：64MB（三万张卡的单个分片约 1~2MB，留足余量）。 */
    public static final long DEFAULT_MAX_FETCH_BYTES = 64L * 1024 * 1024;
    private static final int FETCH_CONNECT_TIMEOUT_MS = 15000;
    private static final int FETCH_READ_TIMEOUT_MS = 60000;

    private final AssetManager assets;
    private final Context ctx;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    /** /fetch 响应体字节上限，超出回 413。 */
    private final long maxFetchBytes;
    /** 仅供 JVM 测试：允许 http://127.0.0.1 之类的回环明文地址。生产构造器永远是 false。 */
    private final boolean allowLoopbackHttp;
    private ServerSocket server;
    private Thread acceptThread;
    private volatile boolean running = false;
    private int port = 0;

    private static final Map<String, String> MIME = new HashMap<>();

    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("js", "application/javascript; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("webp", "image/webp");
        MIME.put("woff2", "font/woff2");
        MIME.put("txt", "text/plain; charset=utf-8");
    }

    public AssetServer(AssetManager assets, Context ctx) {
        this(assets, ctx, DEFAULT_MAX_FETCH_BYTES, false);
    }

    /**
     * @param maxFetchBytes        /fetch 响应体上限（字节）
     * @param allowLoopbackHttp    仅 JVM 测试用：放行 http://127.0.0.1 / localhost。
     *                             生产代码走两参构造器，永远是 false —— 前端无法影响它，
     *                             所以线上的安全边界没有被放宽。
     */
    public AssetServer(AssetManager assets, Context ctx, long maxFetchBytes, boolean allowLoopbackHttp) {
        this.assets = assets;
        this.ctx = ctx;
        this.maxFetchBytes = maxFetchBytes > 0 ? maxFetchBytes : DEFAULT_MAX_FETCH_BYTES;
        this.allowLoopbackHttp = allowLoopbackHttp;
    }

    public int getPort() {
        return port;
    }

    /** 启动服务器并返回监听端口；失败抛 IOException。 */
    public int start() throws IOException {
        server = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        port = server.getLocalPort();
        running = true;
        acceptThread = new Thread(this::acceptLoop, "fy-asset-server");
        acceptThread.setDaemon(true);
        acceptThread.start();
        Log.i(TAG, "资源服务器已启动 http://127.0.0.1:" + port + "/");
        return port;
    }

    public void stop() {
        running = false;
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
        pool.shutdownNow();
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket sock = server.accept();
                pool.execute(() -> handle(sock));
            } catch (IOException e) {
                if (running) Log.w(TAG, "accept 失败: " + e);
            }
        }
    }

    private void handle(Socket sock) {
        try (Socket s = sock) {
            s.setSoTimeout(15000);
            String requestLine = readLine(s.getInputStream());
            if (requestLine == null) return;

            // "GET /path?query HTTP/1.1"
            String[] parts = requestLine.split(" ");
            String rawPath = parts.length > 1 ? parts[1] : "/";
            String rawQuery = "";
            int q = rawPath.indexOf('?');
            if (q >= 0) {
                rawQuery = rawPath.substring(q + 1);
                rawPath = rawPath.substring(0, q);
            }
            if (rawPath.equals("/")) rawPath = "/index.html";

            String method = parts.length > 0 ? parts[0] : "GET";

            // 读请求头（代理要用 Content-Length 和 Content-Type）
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(s.getInputStream())) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(),
                            line.substring(colon + 1).trim());
                }
            }

            // GET /fetch?url=… → 通用 https 下载代理（在线卡库等纯下载用）
            if (rawPath.equals("/fetch")) {
                fetchProxy(s, rawQuery, method);
                return;
            }

            // /api/... → 转发到外部 OpenAI 兼容服务（配置在 Providers 里）
            if (rawPath.startsWith("/api/")) {
                byte[] reqBody = null;
                String cl = headers.get("content-length");
                if (cl != null) {
                    try {
                        int n = Integer.parseInt(cl.trim());
                        if (n > 0 && n <= 32 * 1024 * 1024) reqBody = readN(s.getInputStream(), n);
                    } catch (NumberFormatException ignored) {
                    }
                }
                proxy(s, rawPath, method, reqBody, headers);
                return;
            }

            String assetPath = "ui" + rawPath;
            byte[] body;
            try {
                body = readAsset(assetPath);
            } catch (IOException e) {
                body = null;
            }

            OutputStream out = s.getOutputStream();
            if (body == null) {
                byte[] msg = ("404 Not Found: " + rawPath).getBytes("UTF-8");
                writeHeaders(out, "404 Not Found", "text/plain; charset=utf-8", msg.length);
                out.write(msg);
            } else {
                String ext = rawPath.substring(rawPath.lastIndexOf('.') + 1).toLowerCase();
                String mime = MIME.getOrDefault(ext, "application/octet-stream");
                writeHeaders(out, "200 OK", mime, body.length);
                out.write(body);
            }
            out.flush();
        } catch (Exception e) {
            Log.w(TAG, "处理请求失败: " + e);
        }
    }

    /**
     * 把 /api/xxx 转发成 {base}/xxx 并流式回传。
     * 不设 Content-Length，靠 Connection: close 结束 —— 这样 SSE 增量能立刻到达前端。
     */
    private void proxy(Socket sock, String path, String method, byte[] body, Map<String, String> headers) {
        OutputStream out = null;
        HttpURLConnection c = null;
        try {
            out = sock.getOutputStream();
            Providers.Config cfg = Providers.load(ctx);
            String base = Providers.normalizeBase(cfg.baseUrl);
            if (!Providers.MODE_REMOTE.equals(cfg.mode) || base.isEmpty()) {
                byte[] msg = "没有配置外部模型服务（设置 → 模型来源）".getBytes("UTF-8");
                writeHeaders(out, "503 Service Unavailable", "text/plain; charset=utf-8", msg.length);
                out.write(msg);
                out.flush();
                return;
            }
            String target = base + path.substring("/api".length());
            URL url = new URL(target);
            c = (HttpURLConnection) url.openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(15000);
            c.setReadTimeout(600000);          // 本地大模型首字可能要等很久
            c.setRequestProperty("Content-Type",
                    headers.getOrDefault("content-type", "application/json"));
            c.setRequestProperty("Accept", headers.getOrDefault("accept", "*/*"));
            if (cfg.apiKey != null && !cfg.apiKey.isEmpty()) {
                c.setRequestProperty("Authorization", "Bearer " + cfg.apiKey);
            }
            if (body != null && body.length > 0) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(body.length);
                OutputStream os = c.getOutputStream();
                os.write(body);
                os.flush();
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String ct = c.getContentType();
            if (ct == null || ct.isEmpty()) ct = "application/json; charset=utf-8";
            // 不写 Content-Length：一边读一边 flush，SSE 才能真的"流"起来
            String head = "HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "Upstream")
                    + "\r\nContent-Type: " + ct
                    + "\r\nCache-Control: no-store"
                    + "\r\nX-Fy-Proxy: 1"
                    + "\r\nConnection: close\r\n\r\n";
            out.write(head.getBytes("UTF-8"));
            out.flush();
            if (in != null) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    out.flush();
                }
                in.close();
            }
            Log.i(TAG, "代理 " + method + " " + path + " → " + url.getHost() + " " + code);
        } catch (Exception e) {
            Log.w(TAG, "代理失败: " + e);
            try {
                if (out != null) {
                    byte[] msg = "连不上这个服务，请检查地址和网络".getBytes("UTF-8");
                    writeHeaders(out, "502 Bad Gateway", "text/plain; charset=utf-8", msg.length);
                    out.write(msg);
                    out.flush();
                }
            } catch (IOException ignored) {
            }
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /**
     * GET /fetch?url=&lt;urlencoded&gt; —— 通用下载代理。
     *
     * 跟 /api/ 的区别：这里不碰 Providers、不带任何凭证、不流式（先收完整段再回，
     * 因为要能对超限的响应干净地回 413）。下载场景对"首字节延迟"不敏感，对"不要写坏数据"敏感。
     */
    private void fetchProxy(Socket sock, String rawQuery, String method) {
        OutputStream out = null;
        HttpURLConnection c = null;
        try {
            out = sock.getOutputStream();

            if (!"GET".equalsIgnoreCase(method)) {
                replyText(out, "405 Method Not Allowed", "请求方式不对");
                return;
            }

            String target = queryParam(rawQuery, "url");
            if (target == null || target.trim().isEmpty()) {
                replyText(out, "400 Bad Request", "缺少 url，没给出要下载的地址");
                return;
            }
            target = target.trim();

            URL url;
            try {
                url = new URL(target);
            } catch (Exception e) {
                replyText(out, "400 Bad Request", "这个地址打不开，检查一下链接是否完整");
                return;
            }

            /* 安全边界一：只允许 https。
               明文 http 只在"测试放行 + 回环地址"这个组合下才可能通过，
               生产构造器的 allowLoopbackHttp 恒为 false。 */
            String scheme = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase();
            boolean https = "https".equals(scheme);
            boolean loopbackTest = allowLoopbackHttp && "http".equals(scheme) && isLoopbackHost(url.getHost());
            if (!https && !loopbackTest) {
                replyText(out, "400 Bad Request",
                        "只允许 https 开头的地址，换一个链接再试");
                return;
            }

            c = (HttpURLConnection) url.openConnection();
            c.setInstanceFollowRedirects(true);   // 跟随重定向；跨协议（https→http）Java 不会跟，落到非 200 → 502
            c.setConnectTimeout(FETCH_CONNECT_TIMEOUT_MS);
            c.setReadTimeout(FETCH_READ_TIMEOUT_MS);
            c.setRequestMethod("GET");
            c.setUseCaches(false);
            /* 安全边界二：不转发前端的任何请求头。Cookie / Authorization / Referer /
               自定义头统一丢弃，只带上这两个无害的固定值。 */
            c.setRequestProperty("Accept", "*/*");
            c.setRequestProperty("User-Agent", "fy-local/1.0 AssetServer");

            int code = c.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                String msg = "这个服务返回了 " + code + "，请检查地址或稍后重试";
                Log.w(TAG, "/fetch 上游非 200：" + code + " " + url.getHost());
                replyText(out, "502 Bad Gateway", msg);
                return;
            }

            /* 安全边界三：体积上限。声明了 Content-Length 的先拦，边读边数兜住 chunked。 */
            long declared = -1;
            try { declared = c.getContentLengthLong(); } catch (Throwable ignored) { }
            if (declared > maxFetchBytes) {
                replyText(out, "413 Payload Too Large", "这个文件有 " + fmtBytes(declared) + "，超过单次 " + fmtBytes(maxFetchBytes) + " 的上限");
                return;
            }

            InputStream in = c.getInputStream();
            int initial = declared > 0 ? (int) Math.min(declared, 256 * 1024) : 16384;
            ByteArrayOutputStream bos = new ByteArrayOutputStream(initial);
            byte[] buf = new byte[16384];
            long total = 0;
            boolean tooBig = false;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > maxFetchBytes) { tooBig = true; break; }
                bos.write(buf, 0, n);
            }
            in.close();
            if (tooBig) {
                replyText(out, "413 Payload Too Large", "这个文件超过了单次 " + fmtBytes(maxFetchBytes) + " 的上限");
                return;
            }

            String ct = c.getContentType();
            if (ct == null || ct.isEmpty()) ct = "application/octet-stream";
            ct = ct.replace('\r', ' ').replace('\n', ' ');   // 不让上游往响应头里塞 CRLF
            byte[] body = bos.toByteArray();
            writeHeaders(out, "200 OK", ct, body.length);
            out.write(body);
            out.flush();
            Log.i(TAG, "/fetch " + url.getHost() + " → " + body.length + "B");
        } catch (Exception e) {
            Log.w(TAG, "/fetch 失败：" + e);
            try {
                if (out != null) replyText(out, "502 Bad Gateway", "下载失败，检查网络后重试");
            } catch (IOException ignored) {
            }
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 小段文本响应（错误提示用），自带 Content-Length。 */
    private void replyText(OutputStream out, String status, String text) throws IOException {
        byte[] msg = (text == null ? "" : text).getBytes("UTF-8");
        writeHeaders(out, status, "text/plain; charset=utf-8", msg.length);
        out.write(msg);
        out.flush();
    }

    /** 从 query string 里取一个参数并 URL 解码；取不到返回 null。 */
    private static String queryParam(String query, String name) {
        if (query == null || query.isEmpty()) return null;
        String[] parts = query.split("&");
        for (String p : parts) {
            int eq = p.indexOf('=');
            String k = eq >= 0 ? p.substring(0, eq) : p;
            if (!k.equals(name)) continue;
            String v = eq >= 0 ? p.substring(eq + 1) : "";
            try {
                return java.net.URLDecoder.decode(v, "UTF-8");
            } catch (Exception e) {
                return v;
            }
        }
        return null;
    }

    private static boolean isLoopbackHost(String host) {
        if (host == null) return false;
        String h = host.trim().toLowerCase();
        return h.equals("127.0.0.1") || h.equals("localhost") || h.equals("::1") || h.equals("[::1]");
    }

    private static String fmtBytes(long n) {
        if (n < 0) return "未知";
        if (n < 1024) return n + "B";
        if (n < 1024 * 1024) return (n / 1024) + "KB";
        return (n / 1024 / 1024) + "MB";
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) break;
            off += r;
        }
        return (off == n) ? buf : java.util.Arrays.copyOf(buf, off);
    }

    private void writeHeaders(OutputStream out, String status, String mime, int len) throws IOException {
        String head = "HTTP/1.1 " + status + "\r\n"
                + "Content-Type: " + mime + "\r\n"
                + "Content-Length: " + len + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        out.write(head.getBytes("UTF-8"));
    }

    private byte[] readAsset(String path) throws IOException {
        try (InputStream in = assets.open(path)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(1024, in.available()));
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder(128);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 8192) break;
        }
        return (c == -1 && sb.length() == 0) ? null : sb.toString();
    }
}
