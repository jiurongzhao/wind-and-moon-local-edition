package com.fy.local;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;

/**
 * SQLite 存储后端（可选）。
 *
 * 设计取舍：**文档表**，不做关系式建模。
 *   每张表就两列 —— id TEXT PRIMARY KEY, doc TEXT（整条记录的 JSON）。
 *   理由：前端本来就把记录当整体读写（内存里也是整对象），关系式拆分只会带来
 *   join 成本和迁移风险，却换不到任何本机规模下的收益。
 *   这样换来的是：事务、完整性、不受 WebView 存储配额影响、以及能上 LIKE/FTS 检索。
 *
 * 表：
 *   characters / sessions / messages / memories / logs → (id, doc)
 *   settings → (k, doc)          （前端里 settings 是 {key:value} 对象）
 *
 * 对外只暴露三个操作，全部走 JSON，方便桥接：
 *   loadAll()            → {"characters":[...], "settings":{...}, ...}
 *   apply(opsJson)       → 一个事务里做 clears / puts / dels
 *   search(q, limit)     → 在 messages 里按内容模糊匹配
 *
 * ⚠️ 这个后端是【实验性】的：代码路径与 IndexedDB 并行，默认不启用，
 *    要在设置里手动切换（并会先做一次数据迁移）。真机验证通过后再考虑设为默认。
 */
public class Db {

    private static final String TAG = "FY/Db";
    public static final String FILE_NAME = "fy_store.db";
    private static final String[] TABLE_STORES = {"characters", "sessions", "messages", "memories", "logs"};

    private static SQLiteDatabase db;

    private static synchronized SQLiteDatabase open(Context ctx) {
        if (db != null && db.isOpen()) return db;
        File f = new File(ctx.getFilesDir(), FILE_NAME);
        db = SQLiteDatabase.openOrCreateDatabase(f, null);
        db.enableWriteAheadLogging();
        for (String t : TABLE_STORES) {
            db.execSQL("CREATE TABLE IF NOT EXISTS " + t + " (id TEXT PRIMARY KEY, doc TEXT NOT NULL)");
        }
        db.execSQL("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, doc TEXT NOT NULL)");
        // 消息按会话检索用；doc 里是 JSON，这里只建一个"会话"辅助列不划算，先用 id 主键
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id)");
        return db;
    }

    public static synchronized void close() {
        try {
            if (db != null && db.isOpen()) db.close();
        } catch (Throwable ignored) {
        }
        db = null;
    }

    // ================= 读 =================

    public static String loadAll(Context ctx) {
        JSONObject out = new JSONObject();
        try {
            SQLiteDatabase d = open(ctx);
            for (String t : TABLE_STORES) {
                JSONArray arr = new JSONArray();
                try (Cursor c = d.rawQuery("SELECT doc FROM " + t, null)) {
                    while (c.moveToNext()) arr.put(new JSONObject(c.getString(0)));
                }
                out.put(t, arr);
            }
            JSONObject settings = new JSONObject();
            try (Cursor c = d.rawQuery("SELECT k, doc FROM settings", null)) {
                while (c.moveToNext()) settings.put(c.getString(0), new JSONObject(c.getString(1)).get("v"));
            }
            out.put("settings", settings);
            out.put("ok", true);
        } catch (Throwable t) {
            Log.w(TAG, "loadAll 失败", t);
            try {
                out = new JSONObject();
                out.put("ok", false);
                out.put("message", String.valueOf(t.getMessage() == null ? t : t.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return out.toString();
    }

    // ================= 写 =================

    /**
     * 一个事务里应用一批变更。
     * opsJson: {"clears":["messages"], "puts":{"messages":[{...}]}, "dels":{"messages":["id1"]}}
     */
    public static String apply(Context ctx, String opsJson) {
        JSONObject res = new JSONObject();
        SQLiteDatabase d = null;
        try {
            d = open(ctx);
            JSONObject ops = new JSONObject(opsJson == null || opsJson.isEmpty() ? "{}" : opsJson);
            d.beginTransaction();
            try {
                JSONArray clears = ops.optJSONArray("clears");
                if (clears != null) {
                    for (int i = 0; i < clears.length(); i++) {
                        String t = clears.getString(i);
                        if (isKnown(t)) d.execSQL("DELETE FROM " + t);
                    }
                }
                JSONObject puts = ops.optJSONObject("puts");
                if (puts != null) {
                    JSONArray names = puts.names();
                    if (names != null) {
                        for (int i = 0; i < names.length(); i++) {
                            String t = names.getString(i);
                            if (!isKnown(t)) continue;
                            if ("settings".equals(t)) {
                                JSONArray rows = puts.getJSONArray(t);
                                for (int k = 0; k < rows.length(); k++) {
                                    JSONObject one = rows.getJSONObject(k);
                                    JSONObject wrap = new JSONObject();
                                    wrap.put("v", one.opt("value"));
                                    d.execSQL("INSERT OR REPLACE INTO settings (k, doc) VALUES (?, ?)",
                                            new Object[]{one.optString("key"), wrap.toString()});
                                }
                            } else {
                                JSONArray rows = puts.getJSONArray(t);
                                for (int k = 0; k < rows.length(); k++) {
                                    JSONObject rec = rows.getJSONObject(k);
                                    d.execSQL("INSERT OR REPLACE INTO " + t + " (id, doc) VALUES (?, ?)",
                                            new Object[]{rec.optString("id"), rec.toString()});
                                }
                            }
                        }
                    }
                }
                JSONObject dels = ops.optJSONObject("dels");
                if (dels != null) {
                    JSONArray names = dels.names();
                    if (names != null) {
                        for (int i = 0; i < names.length(); i++) {
                            String t = names.getString(i);
                            if (!isKnown(t)) continue;
                            JSONArray ids = dels.getJSONArray(t);
                            String col = "settings".equals(t) ? "k" : "id";
                            for (int k = 0; k < ids.length(); k++) {
                                d.execSQL("DELETE FROM " + t + " WHERE " + col + " = ?", new Object[]{ids.getString(k)});
                            }
                        }
                    }
                }
                d.setTransactionSuccessful();
            } finally {
                d.endTransaction();
            }
            res.put("ok", true);
        } catch (Throwable t) {
            Log.w(TAG, "apply 失败", t);
            try {
                res.put("ok", false);
                res.put("message", String.valueOf(t.getMessage() == null ? t : t.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return res.toString();
    }

    private static boolean isKnown(String t) {
        if ("settings".equals(t)) return true;
        for (String s : TABLE_STORES) if (s.equals(t)) return true;
        return false;
    }

    // ================= 检索 =================

    /** 在消息里模糊匹配（中文用 LIKE 最稳：FTS 的分词对中文并不友好，且老系统未必带 FTS5）。 */
    public static String search(Context ctx, String q, int limit) {
        JSONArray out = new JSONArray();
        try {
            String needle = q == null ? "" : q.trim();
            if (needle.isEmpty()) return out.toString();
            SQLiteDatabase d = open(ctx);
            int lim = limit <= 0 ? 50 : Math.min(limit, 500);
            try (Cursor c = d.rawQuery(
                    "SELECT doc FROM messages WHERE doc LIKE ? ORDER BY id DESC LIMIT " + lim,
                    new String[]{"%" + needle + "%"})) {
                while (c.moveToNext()) out.put(new JSONObject(c.getString(0)));
            }
        } catch (Throwable t) {
            Log.w(TAG, "search 失败", t);
        }
        return out.toString();
    }

    /** 统计与体积，给设置页显示 */
    public static String stats(Context ctx) {
        JSONObject o = new JSONObject();
        try {
            SQLiteDatabase d = open(ctx);
            long total = 0;
            for (String t : TABLE_STORES) {
                try (Cursor c = d.rawQuery("SELECT COUNT(*) FROM " + t, null)) {
                    if (c.moveToFirst()) {
                        long n = c.getLong(0);
                        total += n;
                        o.put(t, n);
                    }
                }
            }
            File f = new File(ctx.getFilesDir(), FILE_NAME);
            o.put("bytes", f.length());
            o.put("rows", total);
            o.put("ok", true);
        } catch (Throwable t) {
            try {
                o.put("ok", false);
                o.put("message", String.valueOf(t.getMessage() == null ? t : t.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return o.toString();
    }

    /** 切换后端/清空时用：把库文件删掉重建 */
    public static synchronized String wipe(Context ctx) {
        try {
            close();
            File f = new File(ctx.getFilesDir(), FILE_NAME);
            if (f.exists() && !f.delete()) {
                return "{\"ok\":false,\"message\":\"数据库文件删不掉\"}";
            }
            File wal = new File(ctx.getFilesDir(), FILE_NAME + "-wal");
            File shm = new File(ctx.getFilesDir(), FILE_NAME + "-shm");
            if (wal.exists()) wal.delete();
            if (shm.exists()) shm.delete();
            return "{\"ok\":true}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"message\":" + JSONObject.quote(String.valueOf(t)) + "}";
        }
    }
}
