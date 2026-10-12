package android.content.res;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;

/** 测试用最小桩：把 AssetManager.open() 接到真实文件目录上（APK 里的 assets/ 等同于这个目录）。 */
public class AssetManager {

    private final File base;

    public AssetManager(String baseDir) {
        this.base = new File(baseDir);
    }

    public InputStream open(String fileName) throws IOException {
        File f = new File(base, fileName);
        if (!f.isFile()) throw new IOException("asset not found: " + fileName);
        return new FileInputStream(f);
    }
}
