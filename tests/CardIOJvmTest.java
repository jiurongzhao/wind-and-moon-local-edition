import com.fy.local.PngCardText;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.zip.Deflater;

/**
 * PngCardText 的 PNG 角色卡解析真跑（JVM，不需要设备）。
 *
 * 为什么要单独测：PNG 卡是「二进制块 + base64」的组合，最容易在边界上出错
 * （块长度、CRC、关键字、zlib 压缩），而这条路径在 jsdom 里根本覆盖不到。
 * 这里手工拼出 mini PNG，把 tEXt / zTXt 两种写法都跑一遍。
 */
public class CardIOJvmTest {

    private static int pass = 0, fail = 0;

    private static void check(String name, boolean ok) {
        check(name, ok, null);
    }

    private static void check(String name, boolean ok, String extra) {
        if (ok) {
            pass++;
            System.out.println("  ✅ " + name);
        } else {
            fail++;
            System.out.println("  ❌ " + name + (extra == null ? "" : " — " + extra));
        }
    }

    public static void main(String[] args) throws Exception {
        System.out.println("=== CardIO PNG 角色卡解析（JVM 真跑）===");

        String json = "{\"spec\":\"chara_card_v2\",\"data\":{\"name\":\"测试\",\"description\":\"人设\"}}";
        String b64 = Base64.getEncoder().encodeToString(json.getBytes(StandardCharsets.UTF_8));

        /* 1) tEXt（未压缩，v2 卡最常见的写法） */
        byte[] pngText = png(new byte[][]{textChunk("chara", b64)});
        String got = PngCardText.extractPngText(pngText);
        check("tEXt/chara 能解出卡片 JSON", json.equals(got), String.valueOf(got));

        /* 2) zTXt（zlib 压缩） */
        byte[] comp = deflate(b64.getBytes(StandardCharsets.ISO_8859_1));
        byte[] pngZtxt = png(new byte[][]{ztxtChunk("chara", comp)});
        String got2 = PngCardText.extractPngText(pngZtxt);
        check("zTXt/chara（压缩）能解出卡片 JSON", json.equals(got2), String.valueOf(got2));

        /* 3) iTXt 未压缩 */
        byte[] pngItxt = png(new byte[][]{itxtChunk("ccv3", b64)});
        String got3 = PngCardText.extractPngText(pngItxt);
        check("iTXt/ccv3 能解出卡片 JSON", json.equals(got3), String.valueOf(got3));

        /* 4) 无关的 tEXt 块不能误命中 */
        byte[] pngOther = png(new byte[][]{textChunk("Comment", b64)});
        check("关键字不匹配时返回 null（不瞎认）", PngCardText.extractPngText(pngOther) == null);

        /* 5) 普通 PNG（没有文本块） */
        byte[] plain = png(new byte[][]{});
        check("普通 PNG 返回 null", PngCardText.extractPngText(plain) == null);

        /* 6) 截断的文件不能越界崩溃 */
        byte[] truncated = new byte[20];
        System.arraycopy(pngText, 0, truncated, 0, 20);
        boolean threw = false;
        try {
            PngCardText.extractPngText(truncated);
        } catch (Throwable t) {
            threw = true;
        }
        check("截断文件不抛异常", !threw);

        System.out.println("\n结果：" + pass + " 通过 / " + fail + " 失败");
        if (fail > 0) System.exit(1);
    }

    // ---------- 拼 PNG 的最小工具 ----------

    private static byte[] png(byte[][] chunks) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(new byte[]{(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'});
        out.write(chunk("IHDR", new byte[]{0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0}));
        for (byte[] c : chunks) out.write(c);
        out.write(chunk("IEND", new byte[0]));
        return out.toByteArray();
    }

    private static byte[] textChunk(String keyword, String text) throws Exception {
        ByteArrayOutputStream d = new ByteArrayOutputStream();
        d.write(keyword.getBytes(StandardCharsets.ISO_8859_1));
        d.write(0);
        d.write(text.getBytes(StandardCharsets.ISO_8859_1));
        return chunk("tEXt", d.toByteArray());
    }

    private static byte[] ztxtChunk(String keyword, byte[] compressed) throws Exception {
        ByteArrayOutputStream d = new ByteArrayOutputStream();
        d.write(keyword.getBytes(StandardCharsets.ISO_8859_1));
        d.write(0);
        d.write(0);                     // 压缩方法：只有 0（zlib）合法
        d.write(compressed);
        return chunk("zTXt", d.toByteArray());
    }

    private static byte[] itxtChunk(String keyword, String text) throws Exception {
        ByteArrayOutputStream d = new ByteArrayOutputStream();
        d.write(keyword.getBytes(StandardCharsets.ISO_8859_1));
        d.write(0);
        d.write(0);                     // 压缩标志：0 = 未压缩
        d.write(0);                     // 压缩方法
        d.write(0);                     // 语言标签（空）
        d.write(0);                     // 翻译后的关键字（空）
        d.write(text.getBytes(StandardCharsets.UTF_8));
        return chunk("iTXt", d.toByteArray());
    }

    private static byte[] chunk(String type, byte[] data) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeInt(out, data.length);
        out.write(type.getBytes(StandardCharsets.US_ASCII));
        out.write(data);
        writeInt(out, 0);               // CRC 不校验，写 0 就行
        return out.toByteArray();
    }

    private static void writeInt(ByteArrayOutputStream out, int v) {
        out.write((v >>> 24) & 0xFF);
        out.write((v >>> 16) & 0xFF);
        out.write((v >>> 8) & 0xFF);
        out.write(v & 0xFF);
    }

    private static byte[] deflate(byte[] raw) {
        Deflater def = new Deflater();
        def.setInput(raw);
        def.finish();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        while (!def.finished()) {
            int n = def.deflate(buf);
            bos.write(buf, 0, n);
        }
        def.end();
        return bos.toByteArray();
    }
}
