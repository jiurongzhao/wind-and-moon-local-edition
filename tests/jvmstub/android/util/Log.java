package android.util;

/** 测试用最小桩：把 Log 打到 stdout/stderr。 */
public final class Log {
    public static int i(String tag, String msg) {
        System.out.println("[" + tag + "] " + msg);
        return 0;
    }

    public static int w(String tag, String msg) {
        System.out.println("[W/" + tag + "] " + msg);
        return 0;
    }

    public static int w(String tag, String msg, Throwable t) {
        System.out.println("[W/" + tag + "] " + msg + " :: " + t);
        return 0;
    }

    public static int e(String tag, String msg) {
        System.out.println("[E/" + tag + "] " + msg);
        return 0;
    }

    public static int e(String tag, String msg, Throwable t) {
        System.out.println("[E/" + tag + "] " + msg + " :: " + t);
        return 0;
    }
}
