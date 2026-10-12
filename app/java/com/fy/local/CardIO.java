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

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 角色卡读写（SillyTavern chara_card_v2 是社区事实标准）。
 *
 * 这个类只管「文件 ↔ JSON 文本」：PNG 里取文本块的二进制活儿在 PngCardText，
 * 字段映射（角色 ↔ 卡片）在前端 cards.js —— 三层各管各的，都能单独测。
 *
 * 导入支持：纯 JSON 卡（v1 平铺 / v2、v3 带 data）、带 chara 块的 PNG 卡、以及数组打包。
 * 导出：把卡片 JSON 写进 Download（API 29+ 走 MediaStore，不需要存储权限）。
 */
public class CardIO {

    private static final String TAG = "FY/Cards";

    /** 选中的文件 → 卡片 JSON 文本。非 PNG 就当 UTF-8 文本读。 */
    public static String readCardJson(Context ctx, Uri uri) throws Exception {
        byte[] data;
        try (InputStream in = ctx.getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("打不开这个文件");
            data = readAll(in);
        }
        if (data.length == 0) throw new Exception("文件是空的");
        if (PngCardText.isPng(data)) {
            String text = PngCardText.extractPngText(data);
            if (text == null || text.trim().isEmpty()) {
                throw new Exception("这张 PNG 里没有角色卡数据（只有带 chara 块的卡才行）");
            }
            return text;
        }
        return new String(data, StandardCharsets.UTF_8);
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    // ================= 导出 =================

    /** 把卡片 JSON 写到 Download，返回 {"ok":bool,"path":...}。同名文件覆盖。 */
    public static String saveJson(Context ctx, String fileName, String json) {
        String name = sanitize(fileName);
        String path = null;
        try {
            if (Build.VERSION.SDK_INT >= 29) path = saveViaMediaStore(ctx, name, json);
        } catch (Throwable t) {
            Log.w(TAG, "MediaStore 写入失败，退回应用外部目录", t);
        }
        if (path == null) path = saveViaFile(ctx, name, json);
        boolean ok = path != null;
        Log.i(TAG, "角色卡 " + (ok ? "已导出 " + path : "导出失败"));
        return "{\"ok\":" + ok + ",\"path\":" + org.json.JSONObject.quote(path == null ? "" : path) + "}";
    }

    /** 把任意文本写到 Download（导出对话用）。ext 形如 .md / .txt */
    public static String saveText(Context ctx, String fileName, String text, String ext, String mime) {
        String name = sanitizeAs(fileName, ext);
        String path = null;
        try {
            if (Build.VERSION.SDK_INT >= 29) path = saveViaMediaStore(ctx, name, text, mime);
        } catch (Throwable t) {
            Log.w(TAG, "MediaStore 写入失败，退回应用外部目录", t);
        }
        if (path == null) path = saveViaFile(ctx, name, text);
        boolean ok = path != null;
        Log.i(TAG, "文本 " + (ok ? "已导出 " + path : "导出失败"));
        return "{\"ok\":" + ok + ",\"path\":" + org.json.JSONObject.quote(path == null ? "" : path) + "}";
    }

    private static String sanitize(String fileName) {
        return sanitizeAs(fileName, ".json");
    }

    private static String sanitizeAs(String fileName, String ext) {
        String n = fileName == null ? "" : fileName.trim();
        if (n.isEmpty()) n = "fy-export" + ext;
        n = n.replaceAll("[\\\\/:*?\"<>|\\s]+", "_");
        if (!n.toLowerCase().endsWith(ext)) n = n + ext;
        return n.length() > 80 ? n.substring(0, 80 - ext.length()) + ext : n;
    }

    private static String saveViaMediaStore(Context ctx, String name, String json) throws Exception {
        return saveViaMediaStore(ctx, name, json, "application/json");
    }

    private static String saveViaMediaStore(Context ctx, String name, String text, String mime) throws Exception {
        ContentResolver cr = ctx.getContentResolver();
        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        try (Cursor c = cr.query(collection, new String[]{MediaStore.MediaColumns._ID},
                MediaStore.MediaColumns.DISPLAY_NAME + "=?", new String[]{name}, null)) {
            if (c != null) {
                while (c.moveToNext()) {
                    cr.delete(android.content.ContentUris.withAppendedId(collection, c.getLong(0)), null, null);
                }
            }
        } catch (Throwable ignored) {
        }
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime == null ? "application/json" : mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        Uri item = cr.insert(collection, v);
        if (item == null) return null;
        try (OutputStream os = cr.openOutputStream(item)) {
            if (os == null) return null;
            os.write(text.getBytes(StandardCharsets.UTF_8));
            os.flush();
        }
        return Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                .getAbsolutePath() + "/" + name;
    }

    private static String saveViaFile(Context ctx, String name, String json) {
        try {
            File dir = ctx.getExternalFilesDir(null);
            if (dir == null) dir = ctx.getFilesDir();
            File f = new File(dir, name);
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write(json.getBytes(StandardCharsets.UTF_8));
            }
            return f.getAbsolutePath();
        } catch (Throwable t) {
            Log.w(TAG, "写文件失败", t);
            return null;
        }
    }
}
