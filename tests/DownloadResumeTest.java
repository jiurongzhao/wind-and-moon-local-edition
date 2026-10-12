import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;

/**
 * DownloadResumeTest —— 用 JDK 的 HttpURLConnection（与 Android 里同一套 API）
 * 实测 ModelStore.download() 的那套逻辑在真实 ModelScope 上成不成立：
 *
 *   1. 重定向能不能自动跟随
 *   2. Range 断点续传有没有被支持
 *   3. 【关键】「下 2MB → 中断 → 从 2MB 续」拼出来的前 4MB，
 *      与「一次性下 4MB」是不是逐字节一致
 *
 * 用法: java DownloadResumeTest <url>
 */
public class DownloadResumeTest {

    static final int CHUNK = 2 * 1024 * 1024;   // 先下 2MB
    static final int VERIFY = 4 * 1024 * 1024;  // 校验前 4MB

    static HttpURLConnection open(String url, long from) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        if (from > 0) c.setRequestProperty("Range", "bytes=" + from + "-");
        return c;
    }

    /** 下载 [from, from+len) 的字节，返回实际拿到的数据 */
    static byte[] fetch(String url, long from, int len) throws IOException {
        HttpURLConnection c = open(url, from);
        int code = c.getResponseCode();
        System.out.printf("    Range=%d -> HTTP %d, contentLength=%d, 最终URL主机=%s%n",
                from, code, c.getContentLength(), new URL(c.getURL().toString()).getHost());
        if (code != 200 && code != 206) throw new IOException("HTTP " + code);
        ByteArrayOutputStream bos = new ByteArrayOutputStream(len);
        try (InputStream in = c.getInputStream()) {
            byte[] buf = new byte[65536];
            int n;
            while (bos.size() < len && (n = in.read(buf, 0, Math.min(buf.length, len - bos.size()))) > 0) {
                bos.write(buf, 0, n);
            }
        } finally {
            c.disconnect();
        }
        return bos.toByteArray();
    }

    public static void main(String[] args) throws Exception {
        String url = args.length > 0 ? args[0]
                : "https://www.modelscope.cn/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/master/qwen2.5-0.5b-instruct-q4_k_m.gguf";
        System.out.println("目标: " + url);
        boolean ok = true;

        System.out.println("\n[1] 一次性下前 " + (VERIFY / 1048576) + "MB（基准）");
        byte[] baseline = fetch(url, 0, VERIFY);
        System.out.println("    拿到 " + baseline.length + " 字节");
        if (baseline.length != VERIFY) { ok = false; System.out.println("    ❌ 长度不对"); }

        System.out.println("\n[2] 模拟「下 " + (CHUNK / 1048576) + "MB → 中断 → 从断点续」");
        byte[] first = fetch(url, 0, CHUNK);
        System.out.println("    第一段 " + first.length + " 字节");
        byte[] rest = fetch(url, first.length, VERIFY - first.length);
        System.out.println("    续传段 " + rest.length + " 字节");
        byte[] joined = new byte[first.length + rest.length];
        System.arraycopy(first, 0, joined, 0, first.length);
        System.arraycopy(rest, 0, joined, first.length, rest.length);

        System.out.println("\n[3] 逐字节比对");
        if (joined.length != baseline.length) {
            ok = false;
            System.out.println("    ❌ 长度不一致: " + joined.length + " vs " + baseline.length);
        } else if (Arrays.equals(joined, baseline)) {
            System.out.println("    ✅ 完全一致（" + joined.length + " 字节）——断点续传可靠");
        } else {
            ok = false;
            int bad = -1;
            for (int i = 0; i < joined.length; i++) {
                if (joined[i] != baseline[i]) { bad = i; break; }
            }
            System.out.println("    ❌ 第 " + bad + " 字节起不一致 —— 续传会拼出坏文件！");
        }

        System.out.println("\n[4] 验证 GGUF 魔术字节（文件头是 'GGUF'）");
        if (baseline.length >= 4 && baseline[0] == 'G' && baseline[1] == 'G'
                && baseline[2] == 'U' && baseline[3] == 'F') {
            System.out.println("    ✅ 文件头 GGUF");
        } else {
            ok = false;
            System.out.println("    ❌ 文件头不是 GGUF: " + baseline[0] + baseline[1] + baseline[2] + baseline[3]);
        }

        System.out.println("\n结论：" + (ok ? "全部通过 ✅" : "存在问题 ❌"));
        System.exit(ok ? 0 : 1);
    }
}
