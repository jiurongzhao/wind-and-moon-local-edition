package android.util;

/**
 * JVM 测试桩：把 android.util.Base64 的解码映射到 JDK 实现。
 * 只覆盖测试用得到的部分（DEFAULT / NO_WRAP / URL_SAFE）。
 * 注意：类名与 java.util.Base64 同名，所以这里必须用全限定名。
 */
public final class Base64 {

    public static final int DEFAULT = 0;
    public static final int NO_PADDING = 1;
    public static final int NO_WRAP = 2;
    public static final int URL_SAFE = 8;

    private Base64() {
    }

    public static byte[] decode(String str, int flags) {
        String s = str == null ? "" : str.trim();
        if ((flags & URL_SAFE) != 0) {
            return java.util.Base64.getUrlDecoder().decode(s);
        }
        // MIME 解码器容忍换行/空白，和 Android 的 DEFAULT 行为一致
        return java.util.Base64.getMimeDecoder().decode(s);
    }
}
