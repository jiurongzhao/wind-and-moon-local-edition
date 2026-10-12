package com.fy.local;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * 外部模型服务（OpenAI 兼容接口）配置与连通性测试。
 *
 * 为什么要有它：App 默认跑内置的 llama.cpp 引擎（本地 GGUF），但很多人还会：
 *   * 在电脑/路由器/另一台手机上用 Ollama、LM Studio、llama.cpp server、vLLM 起服务（局域网，不需要 key）；
 *   * 或者直接用云端 OpenAI 兼容服务（需要 key）。
 * 这两种在协议上是同一个东西，所以这里只存一份「base url + key + 模型名」。
 *
 * 设计要点：
 *   1. **key 只存在原生侧**，不下发给 WebView（前端只知道"有没有配 key"）；
 *   2. 所有请求都经过 AssetServer 的 /api/ 代理转发 —— 绕开 WebView 的跨域限制；
 *   3. base url 允许填到 /v1 为止（大多数服务的习惯写法），代理拼接时不再重复加 /v1；
 *   4. **不依赖 org.json** —— 这样这个类能在 JVM 里真跑测试（Android 的 org.json 在桌面上没有），
 *      JSON 包装交给 Bridge 那一层做。
 */
public class Providers {

    private static final String TAG = "FY/Providers";
    private static final String PREF = "fy_provider";

    public static final String MODE_LOCAL = "local";     // 内置 llama.cpp 引擎（本地 GGUF）
    public static final String MODE_REMOTE = "remote";   // 外部 OpenAI 兼容接口

    public static class Config {
        public String mode = MODE_LOCAL;
        public String baseUrl = "";
        public String apiKey = "";
        public String model = "";
    }

    /** /v1/models 的结果 */
    public static class ModelsResult {
        public boolean ok = false;
        public String message = "";
        public String resolvedBase = "";
        public List<String> models = new ArrayList<>();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    public static Config load(Context ctx) {
        Config c = new Config();
        SharedPreferences p = prefs(ctx);
        c.mode = p.getString("mode", MODE_LOCAL);
        c.baseUrl = p.getString("baseUrl", "");
        c.apiKey = p.getString("apiKey", "");
        c.model = p.getString("model", "");
        return c;
    }

    public static void save(Context ctx, String mode, String baseUrl, String apiKey, String model) {
        prefs(ctx).edit()
                .putString("mode", MODE_REMOTE.equals(mode) ? MODE_REMOTE : MODE_LOCAL)
                .putString("baseUrl", baseUrl == null ? "" : baseUrl.trim())
                .putString("apiKey", apiKey == null ? "" : apiKey.trim())
                .putString("model", model == null ? "" : model.trim())
                .apply();
        Log.i(TAG, "已保存模型来源：mode=" + mode + " base=" + baseUrl + " model=" + model);
    }

    public static boolean isHttpUrl(String u) {
        return u != null && (u.startsWith("http://") || u.startsWith("https://"));
    }

    /** 远程配置是否可用（选了远程 + 地址合法 + 选了模型） */
    public static boolean isReady(Config c) {
        return c != null && MODE_REMOTE.equals(c.mode) && isHttpUrl(c.baseUrl)
                && c.model != null && !c.model.isEmpty();
    }

    /** 规范化 base url：去尾部斜杠；用户只填到 host:port 时补 /v1（Ollama 等最常见写法） */
    public static String normalizeBase(String base) {
        String b = base == null ? "" : base.trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        if (b.isEmpty()) return "";
        try {
            URL u = new URL(b);
            String p = u.getPath();
            if (p == null || p.isEmpty() || "/".equals(p)) b = b + "/v1";
        } catch (Exception ignored) {
        }
        return b;
    }

    /** 拉取上游模型列表（GET {base}/models），用于「测试连接」与可选模型下拉。 */
    public static ModelsResult listModels(String baseUrl, String apiKey) {
        ModelsResult out = new ModelsResult();
        out.resolvedBase = normalizeBase(baseUrl);
        HttpURLConnection c = null;
        try {
            if (!isHttpUrl(out.resolvedBase)) {
                out.message = "地址要以 http:// 或 https:// 开头";
                return out;
            }
            URL url = new URL(out.resolvedBase + "/models");
            c = (HttpURLConnection) url.openConnection();
            c.setRequestMethod("GET");
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            if (apiKey != null && !apiKey.trim().isEmpty()) {
                c.setRequestProperty("Authorization", "Bearer " + apiKey.trim());
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = readAll(in);
            if (code >= 400) {
                out.message = "HTTP " + code + " " + squeeze(text);
                return out;
            }
            out.models = parseModelIds(text);
            out.ok = true;
            out.message = "连通，发现 " + out.models.size() + " 个模型";
        } catch (Exception e) {
            out.message = shortError(e);
        } finally {
            if (c != null) c.disconnect();
        }
        return out;
    }

    /**
     * 从 /v1/models 的响应里抠出模型名。
     * 不用 JSON 库：形状就两种 —— OpenAI 风格 {"data":[{"id":"..."}]}，
     * 少数服务是 {"models":[{"name":"..."}]}。按 key 扫即可，够稳且零依赖。
     */
    public static List<String> parseModelIds(String json) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        if (json == null) return new ArrayList<>();
        int at = json.indexOf("\"data\"");
        String key = "id";
        if (at < 0) {
            at = json.indexOf("\"models\"");
            key = "name";
        }
        String body = at >= 0 ? json.substring(at) : json;
        String needle = "\"" + key + "\"";
        int i = 0;
        while (true) {
            int k = body.indexOf(needle, i);
            if (k < 0) break;
            int colon = body.indexOf(':', k + needle.length());
            if (colon < 0) break;
            int q1 = body.indexOf('"', colon + 1);
            if (q1 < 0) break;
            int q2 = body.indexOf('"', q1 + 1);
            if (q2 < 0) break;
            String v = body.substring(q1 + 1, q2).trim();
            if (!v.isEmpty() && v.length() <= 128) out.add(v);
            i = q2 + 1;
            if (out.size() > 500) break;
        }
        return new ArrayList<>(out);
    }

    private static String shortError(Exception e) {
        String m = e.getMessage();
        if (e instanceof java.net.SocketTimeoutException) return "连接超时（地址/端口对不对？服务在跑吗？）";
        if (e instanceof java.net.UnknownHostException) return "域名解析不了：" + m;
        if (e instanceof java.net.ConnectException) return "连不上：" + m + "（同一局域网吗？防火墙？）";
        return e.getClass().getSimpleName() + (m == null ? "" : (": " + m));
    }

    private static String squeeze(String s) {
        if (s == null) return "";
        s = s.replaceAll("\\s+", " ").trim();
        return s.length() > 160 ? s.substring(0, 160) + "…" : s;
    }

    public static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toString("UTF-8");
    }
}
