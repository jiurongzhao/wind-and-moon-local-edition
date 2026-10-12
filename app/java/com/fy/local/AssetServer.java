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
 * 另外承担 /api/ 反向代理：把外部的 OpenAI 兼容服务（Ollama / LM Studio / 云端 API）
 * 通过本机 127.0.0.1 转发出去。这样做有两个好处：
 *   1. WebView 只跟同源地址打交道，没有跨域（CORS）问题 —— Ollama 默认只允许 localhost 源，
 *      直连必然失败；
 *   2. API key 只存在原生侧，前端拿不到。
 * 转发是**流式**的：边读上游边 flush，SSE 增量照常到达前端。
 */
public class AssetServer {

    private static final String TAG = "FY/AssetServer";
    private final AssetManager assets;
    private final Context ctx;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
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
        this.assets = assets;
        this.ctx = ctx;
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

            // "GET /path HTTP/1.1"
            String[] parts = requestLine.split(" ");
            String rawPath = parts.length > 1 ? parts[1] : "/";
            int q = rawPath.indexOf('?');
            if (q >= 0) rawPath = rawPath.substring(0, q);
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
                    byte[] msg = ("代理失败: " + e).getBytes("UTF-8");
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
