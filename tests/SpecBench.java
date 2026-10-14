import com.fy.local.NativeEngine;

/** SpecBench —— 量 n-gram 自投机：让模型逐字复制一段长文本（复制的下一段就在 KV 里）。 */
public class SpecBench {
    static int num(String json, String key) {
        int i = json.indexOf("\"" + key + "\":");
        if (i < 0) return -1;
        int j = i + key.length() + 3;
        int k = j;
        while (k < json.length() && (Character.isDigit(json.charAt(k)) || json.charAt(k) == '-')) k++;
        try { return Integer.parseInt(json.substring(j, k)); } catch (Exception e) { return -1; }
    }

    static final String SYSTEM = "<|im_start|>system\n你叫林夏，是深夜书店的店员。<|im_end|>\n";
    static final String PASSAGE =
            "深夜的书店很安静，只有雨声和翻页声。林夏把最后一盏灯留在窗边，"
          + "等着那个总在凌晨出现的客人。木地板被踩得吱呀作响，旧钟敲了三下，"
          + "门帘被风掀起一角。她把热茶推到对面，说今天来得早。客人笑了笑，"
          + "从口袋里掏出一本没有封面的旧书，轻轻放在柜台上，说：帮我找找它的结局。";
    static final String PROMPT = SYSTEM
            + "<|im_start|>user\n请一字不差地把下面这段话复述一遍，不要总结、不要改动：\n"
            + PASSAGE + "<|im_end|>\n<|im_start|>assistant\n深夜的书店很安静，只有雨声和翻页声。";

    public static void main(String[] args) throws Exception {
        String root = System.getProperty("user.home") + "/2/fy";
        String model = args.length > 0 ? args[0] : root + "/models/qwen2.5-0.5b-instruct-q4_k_m.gguf";
        int ctx = args.length > 1 ? Integer.parseInt(args[1]) : 2048;
        int maxTok = args.length > 2 ? Integer.parseInt(args[2]) : 200;
        String spec = args.length > 3 ? args[3] : "|lookup=2|lookup=3|lookup=4";
        String[] tunes = spec.split("\\|");

        System.out.println("=== n-gram 自投机基准（贪心，逐字复制）===");
        System.out.println("passage chars=" + PASSAGE.length());
        System.out.printf("%-22s %5s %9s %11s %11s %9s%n",
                "tune", "gen", "specDraft", "specAccept", "decodeTps", "textLen");
        for (String tune : tunes) {
            NativeEngine.unload();
            long ms = NativeEngine.load(model, ctx, 4, false, tune.isEmpty() ? null : tune);
            if (ms < 0) { System.out.printf("%-22s 加载失败%n", tune); continue; }
            NativeEngine.setPrefix(SYSTEM);
            final StringBuilder acc = new StringBuilder();
            NativeEngine.setListener(new NativeEngine.Listener() {
                @Override public void onToken(String piece) { acc.append(piece); }
                @Override public void onDone(String statsJson) { }
            });
            String st = NativeEngine.generate(PROMPT, maxTok, 0.0f, 0, 1.0f, 1);
            int gen = num(st, "gen");
            int draft = num(st, "specDraft");
            int accept = num(st, "specAccept");
            int firstMs = num(st, "firstMs");
            int totalMs = num(st, "totalMs");
            double tps = (gen > 0 && firstMs >= 0 && totalMs > firstMs) ? gen / ((totalMs - firstMs) / 1000.0) : -1;
            System.out.printf("%-22s %5d %9d %11d %11.2f %9d%n",
                    tune.isEmpty() ? "(lookup=0)" : tune, gen, draft, accept, tps, acc.length());
            if (tune.isEmpty()) System.out.println("   text[:70]=" + acc.substring(0, Math.min(70, acc.length())).replace("\n", "⏎"));
        }
        NativeEngine.unload();
    }
}
