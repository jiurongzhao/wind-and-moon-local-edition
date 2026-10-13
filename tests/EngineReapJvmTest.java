import android.content.Context;
import com.fy.local.Engine;

import java.io.File;
import java.nio.file.Files;

/**
 * EngineReapJvmTest —— 验证 Engine.reapStrayEngines()（孤儿引擎进程清理）。
 *
 * 为什么值得单独测：这段代码会**真的杀进程**，写错就是"把用户的别的 App 杀掉"。
 * 所以除了"该杀的杀掉"，更要盯住"不该杀的不许动"。
 *
 * 覆盖：
 *   1. 没有残留时返回 0；
 *   2. 命令行里带引擎文件名（libfy_llama_server.so）的残留进程会被收掉；
 *   3. 名字里没有引擎文件名的进程**必须活着**（安全性质）；
 *   4. 再收一次返回 0（幂等）。
 *
 * 用法: java -cp <classes> EngineReapJvmTest
 */
public class EngineReapJvmTest {

    static int pass = 0, fail = 0;

    static void check(String name, boolean ok) {
        check(name, ok, null);
    }

    static void check(String name, boolean ok, String extra) {
        if (ok) {
            pass++;
            System.out.println("  ✅ " + name);
        } else {
            fail++;
            System.out.println("  ❌ " + name + (extra != null ? " — " + extra : ""));
        }
    }

    public static void main(String[] args) throws Exception {
        String root = System.getProperty("user.home") + "/2/fy";
        String work = root + "/build/jvmtest/reap";
        File dir = new File(work);
        dir.mkdirs();

        System.out.println("=== Engine 孤儿进程清理 测试 ===");
        Context ctx = new Context(root + "/native", work + "/files", work + "/cache");
        Engine engine = new Engine(ctx, new Engine.Listener() {
            @Override
            public void onState(String state, String message) {
            }

            @Override
            public void onLog(String line) {
                System.out.println("    [log] " + line);
            }
        });

        System.out.println("\n【1】基线：没有残留进程");
        int base = engine.reapStrayEngines();
        check("没有残留时返回 0（拿到 " + base + "）", base == 0);

        System.out.println("\n【2】造两个进程：一个像引擎，一个不像");
        String sh = firstExisting("/system/bin/sh", "/bin/sh",
                "/data/data/com.termux/files/usr/bin/sh", "/usr/bin/sh");
        check("找得到可用的 sh", sh != null, String.valueOf(sh));
        if (sh == null) {
            summary();
            return;
        }

        // 坑：不能用 sh -c "sleep 30" —— sh 会把最后一条命令直接 exec 掉，
        // 进程名就变成 sleep，cmdline 里再也看不到脚本路径（第一版就是这么写的，
        // 被这个测试当场抓出来）。必须写成带 shebang 的可执行脚本、直接跑，
        // cmdline 才会是 "/system/bin/sh /…/libfy_llama_server.so"。
        File fake = new File(dir, Engine.EXEC_NAME);          // libfy_llama_server.so
        writeScript(fake, sh, "sleep 30");
        Process stray = new ProcessBuilder(fake.getAbsolutePath()).start();

        File other = new File(dir, "not-an-engine.sh");
        writeScript(other, sh, "sleep 30");
        Process innocent = new ProcessBuilder(other.getAbsolutePath()).start();

        Thread.sleep(500);
        String strayCmd = cmdline(stray.pid());
        check("假引擎进程起来了，且 cmdline 里能看到引擎文件名",
                stray.isAlive() && strayCmd.contains(Engine.EXEC_NAME), strayCmd);
        check("无关进程也起来了", innocent.isAlive(), cmdline(innocent.pid()));

        System.out.println("\n【3】收残留");
        int n = engine.reapStrayEngines();
        check("收掉至少 1 个（拿到 " + n + "）", n >= 1);
        Thread.sleep(700);
        check("假引擎进程已经死了", !stray.isAlive());
        check("无关进程没有被误杀 ← 最重要的安全性质", innocent.isAlive());

        System.out.println("\n【4】幂等");
        check("再收一次返回 0", engine.reapStrayEngines() == 0);

        innocent.destroyForcibly();
        innocent.waitFor();
        fake.delete();
        other.delete();

        summary();
    }

    /** 写一个带 shebang 的可执行脚本 —— 这样进程 cmdline 里会保留脚本路径。 */
    static void writeScript(File f, String sh, String body) throws Exception {
        Files.write(f.toPath(), ("#!" + sh + "\n" + body + "\n").getBytes("UTF-8"));
        f.setExecutable(true, false);
    }

    static String cmdline(long pid) {
        try {
            byte[] b = Files.readAllBytes(new File("/proc/" + pid + "/cmdline").toPath());
            return new String(b).replace('\0', ' ').trim();
        } catch (Exception e) {
            return "(读不到)";
        }
    }

    static String firstExisting(String... paths) {
        for (String p : paths) {
            File f = new File(p);
            if (f.isFile() && f.canExecute()) return p;
        }
        return null;
    }

    static void summary() {
        System.out.println("\n" + "─".repeat(56));
        System.out.println("结果： " + pass + " 通过 / " + fail + " 失败");
        System.exit(fail == 0 ? 0 : 1);
    }
}
