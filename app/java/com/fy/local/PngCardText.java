package com.fy.local;

import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.Inflater;

/**
 * PNG 角色卡文本块解析 —— 纯逻辑，不碰文件/Context，所以能在 JVM 上直接真跑测试。
 *
 * SillyTavern 系的 PNG 卡把卡片 JSON 以 base64 塞在 PNG 的文本块里：
 *   tEXt  关键字 chara（v2）/ ccv3（v3），值就是 base64
 *   zTXt  值先 zlib 压缩再 base64
 *   iTXt  带语言标签，压缩标志可选
 * 这段代码要在二进制里按块长度走路，最容易在边界上出错，所以单独拆出来 + 单独测。
 */
public final class PngCardText {

    private static final String TAG = "FY/Cards";
    private static final String[] CARD_KEYWORDS = {"chara", "ccv3", "card"};

    private PngCardText() {
    }

    public static boolean isPng(byte[] d) {
        return d != null && d.length > 8
                && (d[0] & 0xFF) == 0x89 && d[1] == 'P' && d[2] == 'N' && d[3] == 'G';
    }

    /** 走 PNG 块，按关键字取卡片 JSON 文本；找不到返回 null。 */
    public static String extractPngText(byte[] d) {
        if (d == null || d.length < 8) return null;
        int pos = 8; // 跳过 PNG 签名
        while (pos + 8 <= d.length) {
            long len = ((long) (d[pos] & 0xFF) << 24) | ((d[pos + 1] & 0xFF) << 16)
                    | ((d[pos + 2] & 0xFF) << 8) | (d[pos + 3] & 0xFF);
            String type = new String(d, pos + 4, 4, StandardCharsets.US_ASCII);
            int dataStart = pos + 8;
            if (len < 0 || dataStart + len > d.length) break;   // 文件截断，别越界
            int dataLen = (int) len;
            try {
                if ("tEXt".equals(type)) {
                    int zero = indexOf(d, dataStart, dataStart + dataLen, (byte) 0);
                    if (zero > 0) {
                        String kw = new String(d, dataStart, zero - dataStart, StandardCharsets.ISO_8859_1);
                        String val = new String(d, zero + 1, dataStart + dataLen - zero - 1, StandardCharsets.ISO_8859_1);
                        String hit = decodeIfWanted(kw, val);
                        if (hit != null) return hit;
                    }
                } else if ("zTXt".equals(type)) {
                    int zero = indexOf(d, dataStart, dataStart + dataLen, (byte) 0);
                    if (zero > 0) {
                        String kw = new String(d, dataStart, zero - dataStart, StandardCharsets.ISO_8859_1);
                        if (isWanted(kw)) {
                            int textStart = zero + 2;   // 跳过关键字后的 \0 和压缩方法字节
                            byte[] raw = inflate(d, textStart, dataStart + dataLen);
                            if (raw != null) return decodeBase64(new String(raw, StandardCharsets.ISO_8859_1));
                        }
                    }
                } else if ("iTXt".equals(type)) {
                    int zero = indexOf(d, dataStart, dataStart + dataLen, (byte) 0);
                    if (zero > 0) {
                        String kw = new String(d, dataStart, zero - dataStart, StandardCharsets.ISO_8859_1);
                        int p = zero + 1;
                        if (p + 2 <= dataStart + dataLen) {
                            int compFlag = d[p] & 0xFF;
                            p += 2;                                       // 压缩标志 + 压缩方法
                            p = skipCString(d, p, dataStart + dataLen);    // 语言标签
                            p = skipCString(d, p, dataStart + dataLen);    // 翻译后的关键字
                            if (isWanted(kw) && p <= dataStart + dataLen) {
                                if (compFlag == 1) {
                                    byte[] raw = inflate(d, p, dataStart + dataLen);
                                    if (raw != null) return decodeBase64(new String(raw, StandardCharsets.UTF_8));
                                }
                                String val = new String(d, p, dataStart + dataLen - p, StandardCharsets.UTF_8);
                                String hit = decodeIfWanted(kw, val);
                                if (hit != null) return hit;
                            }
                        }
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "解析 PNG " + type + " 块失败", t);
            }
            pos = dataStart + dataLen + 4;   // 跳过数据 + CRC
            if ("IEND".equals(type)) break;
        }
        return null;
    }

    private static boolean isWanted(String kw) {
        for (String k : CARD_KEYWORDS) if (k.equalsIgnoreCase(kw)) return true;
        return false;
    }

    /** 关键字命中就把内容当 base64 解出来，否则返回 null。 */
    private static String decodeIfWanted(String kw, String val) {
        if (!isWanted(kw)) return null;
        return decodeBase64(val);
    }

    private static String decodeBase64(String s) {
        try {
            String t = s == null ? "" : s.trim();
            if (t.isEmpty()) return null;
            return new String(Base64.decode(t, Base64.DEFAULT), StandardCharsets.UTF_8);
        } catch (Throwable t) {
            Log.w(TAG, "base64 解码失败", t);
            return null;
        }
    }

    private static int indexOf(byte[] d, int from, int to, byte b) {
        for (int i = from; i < to && i < d.length; i++) if (d[i] == b) return i;
        return -1;
    }

    private static int skipCString(byte[] d, int from, int to) {
        int i = indexOf(d, from, to, (byte) 0);
        return i < 0 ? to : i + 1;
    }

    private static byte[] inflate(byte[] d, int from, int to) {
        try {
            Inflater inf = new Inflater();
            inf.setInput(d, from, to - from);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            while (!inf.finished()) {
                int n = inf.inflate(buf);
                if (n == 0) break;
                bos.write(buf, 0, n);
            }
            inf.end();
            return bos.toByteArray();
        } catch (Throwable t) {
            Log.w(TAG, "zlib 解压失败", t);
            return null;
        }
    }
}
