package com.fy.local;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 诊断报告导出。
 *
 * 为什么需要它：这台手机上无线调试（adb）随时会掉，掉了以后就没法用 logcat 看 App 内部情况。
 * 于是让 App 自己把「引擎自检结果 + 引擎日志 + 状态」写成一个 txt 丢到 Download 目录，
 * Termux 里直接 `cat ~/storage/downloads/fy-diagnostics.txt` 就能看到，全程不需要 adb、不需要用户转述。
 *
 * API 29+ 走 MediaStore.Downloads（不需要任何存储权限）；
 * 更低版本退到 App 自己的外部目录。
 */
public class Diag {

    private static final String TAG = "FY/Diag";
    public static final String FILE_NAME = "fy-diagnostics.txt";

    /** 生成一份完整报告文本。任何一步出错都要能容错，不能因为诊断把自己搞崩。 */
    public static String buildReport(Context ctx, Engine engine, ModelStore models, AssetServer server) {
        StringBuilder sb = new StringBuilder();
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA);
        sb.append("=== 风月·本地版 诊断报告 ===\n");
        sb.append("时间: ").append(fmt.format(new Date())).append('\n');
        sb.append("机型: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
          .append("  Android ").append(Build.VERSION.RELEASE)
          .append(" (SDK ").append(Build.VERSION.SDK_INT).append(")\n");
        sb.append("ABI: ").append(Build.SUPPORTED_ABIS[0]).append('\n');
        sb.append("包名: ").append(ctx.getPackageName()).append('\n');
        sb.append("nativeLibraryDir: ").append(ctx.getApplicationInfo().nativeLibraryDir).append('\n');
        sb.append("filesDir: ").append(ctx.getFilesDir().getAbsolutePath()).append('\n');
        sb.append("CPU 核数: ").append(Runtime.getRuntime().availableProcessors()).append('\n');
        try {
            android.app.ActivityManager am = (android.app.ActivityManager)
                    ctx.getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null) {
                android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
                am.getMemoryInfo(mi);
                sb.append("可用内存: ").append(mi.availMem / 1048576).append(" MB / 总 ")
                  .append(mi.totalMem / 1048576).append(" MB\n");
            }
        } catch (Throwable ignored) {
        }

        sb.append("\n--- 引擎状态 ---\n");
        if (engine != null) {
            sb.append("state=").append(engine.getState())
              .append("  port=").append(engine.getPort())
              .append("  model=").append(engine.getCurrentModel())
              .append("  launchStrategy=").append(engine.getLaunchStrategy())
              .append("  loadMode=").append(engine.getLoadMode().isEmpty() ? "auto(mmap)" : engine.getLoadMode())
              .append('\n');
            sb.append("message=").append(engine.getMessage()).append('\n');
            sb.append("lastError=").append(engine.getLastError()).append('\n');
            sb.append("\n--- 引擎自检（启动时跑 --version 的结果）---\n");
            sb.append(engine.getProbeResult()).append('\n');
            sb.append("\n--- 引擎日志（最近 80 行）---\n");
            java.util.List<String> lines = engine.tailLog(80);
            for (String l : lines) sb.append(l).append('\n');
            if (lines.isEmpty()) sb.append("(还没有日志)\n");
        } else {
            sb.append("(引擎对象为空)\n");
        }

        sb.append("\n--- 模型 ---\n");
        try {
            File dir = models != null ? models.dir() : null;
            sb.append("模型目录: ").append(dir == null ? "?" : dir.getAbsolutePath()).append('\n');
            File[] fs = dir == null ? null : dir.listFiles();
            if (fs == null || fs.length == 0) {
                sb.append("(没有模型文件)\n");
            } else {
                for (File f : fs) {
                    sb.append("  ").append(f.getName()).append("  ")
                      .append(f.length() / 1048576).append(" MB\n");
                }
            }
        } catch (Throwable t) {
            sb.append("列举模型失败: ").append(t).append('\n');
        }

        sb.append("\n--- 本地资源服务器 ---\n");
        sb.append("assetPort=").append(server == null ? "?" : server.getPort()).append('\n');
        return sb.toString();
    }

    /** 把报告写到 Download 目录，返回 {"ok":bool,"path":...} 的 JSON 字符串。 */
    public static String save(Context ctx, String text) {
        String path = null;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                path = saveViaMediaStore(ctx, text);
            }
        } catch (Throwable t) {
            Log.w(TAG, "MediaStore 写入失败，退回应用外部目录", t);
        }
        if (path == null) {
            path = saveViaFile(ctx, text);
        }
        boolean ok = path != null;
        Log.i(TAG, "诊断报告 " + (ok ? "已写入 " + path : "写入失败"));
        return "{\"ok\":" + ok + ",\"path\":" + org.json.JSONObject.quote(path == null ? "" : path) + "}";
    }

    private static String saveViaMediaStore(Context ctx, String text) throws Exception {
        ContentResolver cr = ctx.getContentResolver();
        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        // 先删掉旧报告，保证文件名固定、内容最新
        try (Cursor c = cr.query(collection, new String[]{MediaStore.MediaColumns._ID},
                MediaStore.MediaColumns.DISPLAY_NAME + "=?", new String[]{FILE_NAME}, null)) {
            if (c != null) {
                while (c.moveToNext()) {
                    long id = c.getLong(0);
                    cr.delete(android.content.ContentUris.withAppendedId(collection, id), null, null);
                }
            }
        } catch (Throwable ignored) {
        }

        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, FILE_NAME);
        v.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = cr.insert(collection, v);
        if (item == null) return null;
        try (OutputStream os = cr.openOutputStream(item)) {
            if (os == null) return null;
            os.write(text.getBytes(StandardCharsets.UTF_8));
            os.flush();
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(item, done, null, null);
        return "Download/" + FILE_NAME;
    }

    private static String saveViaFile(Context ctx, String text) {
        try {
            File dir = ctx.getExternalFilesDir(null);
            if (dir == null) dir = ctx.getFilesDir();
            File f = new File(dir, FILE_NAME);
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write(text.getBytes(StandardCharsets.UTF_8));
            }
            return f.getAbsolutePath();
        } catch (Throwable t) {
            Log.w(TAG, "写文件也失败了", t);
            return null;
        }
    }
}
