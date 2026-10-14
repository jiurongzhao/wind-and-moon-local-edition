import com.fy.local.NativeEngine;
import java.util.Arrays;

/**
 * NativeEngineBench —— 在 Termux 里（同一颗手机 SoC、同一份 libllama）横向量 JNI 线路：
 *   冷预填充（长 persona 前缀，前缀复用无从谈起时才花的那笔） + steady-state decode。
 *
 * 手机 CPU 频率会飘，单次数字能差 20%。所以每个 tune 跑 ROUNDS 轮取**中位数**，
 * 别拿一次测量下结论。
 *
 * 用法:
 *   LD_LIBRARY_PATH=native GGML_BACKEND_PATH=native \
 *     java -Djava.library.path=native -cp build/jvmtest NativeEngineBench \
 *     [模型] [ctx] [线程] [maxTokens] [tuneA|tuneB|...] [前缀重复段数] [轮数]
 */
public class NativeEngineBench {

    static int num(String json, String key) {
        int i = json.indexOf("\"" + key + "\":");
        if (i < 0) return -1;
        int j = i + key.length() + 3;
        int k = j;
        while (k < json.length() && (Character.isDigit(json.charAt(k)) || json.charAt(k) == '-')) k++;
        try { return Integer.parseInt(json.substring(j, k)); } catch (Exception e) { return -1; }
    }

    static double median(double[] v) {
        if (v.length == 0) return -1;
        double[] a = v.clone();
        Arrays.sort(a);
        return a[a.length / 2];
    }

    static final String SYSTEM = "<|im_start|>system\n你叫林夏，是深夜书店的店员，说话短。<|im_end|>\n";

    static String longPrefix(int reps) {
        StringBuilder sb = new StringBuilder();
        String s = "旧书店的木门被风推得吱呀响，柜台后面的老钟走得很慢，窗外的雨把招牌洗得发亮。";
        for (int i = 0; i < reps; i++) sb.append(s);
        return sb.toString();
    }

    public static void main(String[] args) throws Exception {
        String root = System.getProperty("user.home") + "/2/fy";
        String model = args.length > 0 ? args[0] : root + "/models/qwen2.5-0.5b-instruct-q4_k_m.gguf";
        int ctx = args.length > 1 ? Integer.parseInt(args[1]) : 4096;
        int threads = args.length > 2 ? Integer.parseInt(args[2]) : 4;
        int maxTok = args.length > 3 ? Integer.parseInt(args[3]) : 128;
        String spec = args.length > 4 ? args[4] : "";
        int reps = args.length > 5 ? Integer.parseInt(args[5]) : 16;
        int rounds = args.length > 6 ? Integer.parseInt(args[6]) : 5;
        String[] tunes = spec.isEmpty() ? new String[]{""} : spec.split("\\|");

        System.out.println("=== JNI 线路基准（中位数，rounds=" + rounds + "）===");
        System.out.println("model=" + model + " ctx=" + ctx + " threads=" + threads
                + " maxTokens=" + maxTok + " prefixReps=" + reps);
        System.out.printf("%-40s %7s %7s %10s %11s %9s%n",
                "tune", "prompt", "gen", "prefillMs", "decodeTps", "reused");

        for (String tune : tunes) {
            try {
                NativeEngine.unload();
                long ms = NativeEngine.load(model, ctx, threads, false, tune.isEmpty() ? null : tune);
                if (ms < 0) { System.out.printf("%-40s  加载失败%n", tune.isEmpty() ? "(default)" : tune); continue; }
                String p = SYSTEM + "<|im_start|>user\n" + longPrefix(reps)
                        + "请从 1 数到 300，每个数字单独一行。<|im_end|>\n"
                        + "<|im_start|>assistant\n1\n2\n3\n4\n5\n";
                // 冷预填充：第一次必然全量 prefill
                String cold = NativeEngine.generate(p, maxTok, 0.0f, 0, 1.0f, 1);
                int prompt = num(cold, "prompt");
                int prefillMs = num(cold, "prefillMs");
                double[] tps = new double[rounds];
                int gen = num(cold, "gen");
                int reused = num(cold, "reused");
                for (int r = 0; r < rounds; r++) {
                    String st = NativeEngine.generate(p, maxTok, 0.0f, 0, 1.0f, 1);
                    gen = num(st, "gen");
                    reused = num(st, "reused");
                    int firstMs = num(st, "firstMs");
                    int totalMs = num(st, "totalMs");
                    tps[r] = (gen > 0 && firstMs >= 0 && totalMs > firstMs)
                            ? gen / ((totalMs - firstMs) / 1000.0) : -1;
                }
                System.out.printf("%-40s %7d %7d %10d %11.2f %9d%n",
                        tune.isEmpty() ? "(default/chunk=128)" : tune, prompt, gen, prefillMs, median(tps), reused);
            } catch (Throwable t) {
                System.out.printf("%-40s  异常 %s%n", tune, t);
            }
        }
        NativeEngine.unload();
    }
}
