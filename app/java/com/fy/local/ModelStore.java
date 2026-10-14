package com.fy.local;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** 模型仓库：列出 / 导入 / 下载 / 删除 GGUF 模型。 */
public class ModelStore {

    private static final String TAG = "FY/Models";
    public static final String MODEL_DIR_NAME = "models";

    public interface Progress {
        void onProgress(String name, long received, long total, String state, String message);
    }

    private final Context ctx;

    public ModelStore(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    public File dir() {
        File d = new File(ctx.getFilesDir(), MODEL_DIR_NAME);
        if (!d.isDirectory() && !d.mkdirs()) Log.w(TAG, "无法创建模型目录 " + d);
        return d;
    }

    /** 认识的模型后缀：.gguf（llama.cpp）、.litertlm / .task（LiteRT-LM，见 docs/engine-backends.md）。 */
    private static boolean isModelFile(String lowerName) {
        return lowerName.endsWith(".gguf") || lowerName.endsWith(".gguf.part")
                || lowerName.endsWith(".task") || lowerName.endsWith(".task.part")
                || lowerName.endsWith(".litertlm") || lowerName.endsWith(".litertlm.part");
    }

    public JSONArray list() {
        JSONArray arr = new JSONArray();
        File[] files = dir().listFiles();
        if (files == null) return arr;
        for (File f : files) {
            if (!f.isFile()) continue;
            String n = f.getName().toLowerCase();
            if (!isModelFile(n)) continue;
            try {
                JSONObject o = new JSONObject();
                o.put("name", f.getName());
                o.put("sizeBytes", f.length());
                o.put("path", f.getAbsolutePath());
                arr.put(o);
            } catch (Exception ignored) {
            }
        }
        return arr;
    }

    public JSONObject delete(String name) {
        JSONObject r = new JSONObject();
        try {
            File f = new File(dir(), name);
            boolean ok = f.isFile() && f.delete();
            r.put("ok", ok);
            r.put("message", ok ? "已删除 " + name : "没找到这个文件，可能已经被删掉了");
        } catch (Exception e) {
            try {
                r.put("ok", false);
                r.put("message", "删除失败，请稍后重试");
            } catch (Exception ignored) {
            }
        }
        return r;
    }

    /** 从系统文件选择器返回的 content:// URI 导入模型。 */
    public JSONObject importFromUri(Uri uri, Progress cb) {
        JSONObject r = new JSONObject();
        String name = displayName(uri);
        if (name == null || !isModelFile(name.toLowerCase())) {
            name = "imported-" + System.currentTimeMillis() + ".gguf";
        }
        File dst = new File(dir(), name);
        try (InputStream in = ctx.getContentResolver().openInputStream(uri);
             OutputStream out = new FileOutputStream(dst)) {
            if (in == null) throw new IOException("这个文件读不了，换一个再试");
            long total = sizeOf(uri);
            byte[] buf = new byte[1 << 16];
            long got = 0;
            int n;
            long lastTick = 0;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                got += n;
                long now = System.currentTimeMillis();
                if (cb != null && now - lastTick > 400) {
                    cb.onProgress(name, got, total, "running", "导入中");
                    lastTick = now;
                }
            }
            if (cb != null) cb.onProgress(name, got, Math.max(total, got), "done", "导入完成");
            r.put("ok", true);
            r.put("name", name);
            r.put("message", "已导入 " + name);
        } catch (Exception e) {
            Log.w(TAG, "导入失败", e);
            try {
                //noinspection ResultOfMethodCallIgnored
                dst.delete();
                r.put("ok", false);
                r.put("name", name);
                r.put("message", "导入没成功，换一个文件再试");
            } catch (Exception ignored) {
            }
        }
        return r;
    }

    /** 内置推荐模型源（ModelScope 直链，国内可直连）。
        默认走云端（DeepSeek 等）；这里是"完全离线"时用的两个最小模型。 */
    public JSONArray downloadSources() {
        JSONArray arr = new JSONArray();
        /* 新默认引擎（litertlm）吃的是 .litertlm，别下成 GGUF 之后在设置里对着一个
           起不来的后端发呆。两个都列出来，各自标注清楚给哪个引擎用。 */
        addSource(arr, "Qwen3-0.6B（LiteRT-LM · 0.57GB）",
                "https://www.modelscope.cn/models/litert-community/Qwen3-0.6B/resolve/master/Qwen3-0.6B.litertlm",
                "0.57 GB", "内置推荐：0.6B，中文够用，打开后 1 秒内就能开始聊");
        addSource(arr, "Qwen2.5-0.5B-Instruct（llama.cpp · 0.49GB）",
                "https://www.modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/master/qwen2.5-0.5b-instruct-q4_k_m.gguf",
                "0.49 GB", "旧格式模型文件：只在兼容模式下能用");
        return arr;
    }

    private void addSource(JSONArray arr, String name, String url, String size, String note) {
        try {
            JSONObject o = new JSONObject();
            o.put("name", name);
            o.put("url", url);
            o.put("sizeHint", size);
            o.put("note", note);
            // 前端「下载」按钮按 file 存档：以前直接拿显示名，中文括号 + 没后缀，存下来是个怪文件
            o.put("file", fileNameOf(url));
            arr.put(o);
        } catch (Exception ignored) {
        }
    }

    /** 从下载直链里取文件名，去 query。 */
    static String fileNameOf(String url) {
        if (url == null) return "model.bin";
        String s = url;
        int q = s.indexOf('?');
        if (q >= 0) s = s.substring(0, q);
        int slash = s.lastIndexOf('/');
        String n = slash >= 0 ? s.substring(slash + 1) : s;
        return n.isEmpty() ? "model.bin" : n;
    }

    /** 下载模型（支持断点续传）。在后台线程调用。 */
    public JSONObject download(String url, String name, Progress cb) {
        JSONObject r = new JSONObject();
        File part = new File(dir(), name + ".part");
        File dst = new File(dir(), name);
        long existing = part.isFile() ? part.length() : 0;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(true);
            if (existing > 0) c.setRequestProperty("Range", "bytes=" + existing + "-");
            int code = c.getResponseCode();
            if (code != 200 && code != 206) throw new IOException("HTTP " + code);
            long total = c.getContentLength() + (code == 206 ? existing : 0);
            if (code == 200) existing = 0; // 服务端不支持续传，从头来

            try (InputStream in = c.getInputStream();
                 OutputStream out = new FileOutputStream(part, code == 206)) {
                byte[] buf = new byte[1 << 16];
                long got = existing;
                int n;
                long lastTick = 0;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    got += n;
                    long now = System.currentTimeMillis();
                    if (cb != null && now - lastTick > 300) {
                        cb.onProgress(name, got, total, "running", "下载中");
                        lastTick = now;
                    }
                }
                if (cb != null) cb.onProgress(name, got, Math.max(total, got), "done", "下载完成");
            }

            if (dst.exists() && !dst.delete()) Log.w(TAG, "覆盖旧模型失败");
            if (!part.renameTo(dst)) throw new IOException("下载的文件没能保存，请重试");

            r.put("ok", true);
            r.put("name", name);
            r.put("message", "下载完成 " + name);
        } catch (Exception e) {
            Log.w(TAG, "下载失败", e);
            try {
                r.put("ok", false);
                r.put("message", "下载没成功（已经保留进度，可以接着下）");
            } catch (Exception ignored) {
            }
            if (cb != null) cb.onProgress(name, part.length(), 0, "error", "下载没成功（已经保留进度，可以接着下）");
        } finally {
            if (c != null) c.disconnect();
        }
        return r;
    }

    private String displayName(Uri uri) {
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(uri, null, null, null, null);
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) return c.getString(i);
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        String p = uri.getLastPathSegment();
        return p == null ? null : p.substring(p.lastIndexOf('/') + 1);
    }

    private long sizeOf(Uri uri) {
        Cursor c = null;
        try {
            c = ctx.getContentResolver().query(uri, null, null, null, null);
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.SIZE);
                if (i >= 0 && !c.isNull(i)) return c.getLong(i);
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return 0;
    }
}
