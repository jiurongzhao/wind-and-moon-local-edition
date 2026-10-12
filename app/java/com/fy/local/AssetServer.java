package com.fy.local;

import android.content.res.AssetManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
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
 */
public class AssetServer {

    private static final String TAG = "FY/AssetServer";
    private final AssetManager assets;
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

    public AssetServer(AssetManager assets) {
        this.assets = assets;
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

            // 吃掉请求头
            String line;
            while ((line = readLine(s.getInputStream())) != null && !line.isEmpty()) {
                // 忽略
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
