package android.content;

import android.content.pm.ApplicationInfo;
import android.os.PowerManager;

import java.io.File;

/**
 * 测试用最小桩 Context：把 Engine 需要的几个方法接到真实文件系统上，
 * 这样就能在 Termux 里直接跑 Engine.java（而不需要 Android 设备）。
 */
public class Context {

    public static final String POWER_SERVICE = "power";
    public static final int MODE_PRIVATE = 0;

    private final File filesDir;
    private final File cacheDir;
    private final ApplicationInfo appInfo = new ApplicationInfo();

    public Context(String nativeLibraryDir, String filesDir, String cacheDir) {
        this.appInfo.nativeLibraryDir = nativeLibraryDir;
        this.appInfo.packageName = "com.fy.local";
        this.filesDir = new File(filesDir);
        this.cacheDir = new File(cacheDir);
        this.filesDir.mkdirs();
        this.cacheDir.mkdirs();
    }

    public Context getApplicationContext() {
        return this;
    }

    public ApplicationInfo getApplicationInfo() {
        return appInfo;
    }

    public File getFilesDir() {
        return filesDir;
    }

    public File getCacheDir() {
        return cacheDir;
    }

    public Object getSystemService(String name) {
        return POWER_SERVICE.equals(name) ? new PowerManager() : null;
    }

    public String getPackageName() {
        return appInfo.packageName;
    }

    private final java.util.Map<String, SharedPreferences> prefs = new java.util.HashMap<>();

    public SharedPreferences getSharedPreferences(String name, int mode) {
        SharedPreferences p = prefs.get(name);
        if (p == null) {
            p = new SharedPreferences();
            prefs.put(name, p);
        }
        return p;
    }
}
