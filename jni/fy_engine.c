/* fy_engine.c —— 风月·本地版专用推理引擎（JNI 直连 libllama）
 *
 * 为什么不 fork llama-server：
 *   子进程 + localhost HTTP 那一套要管端口、管孤儿进程、管 linker64 回退、管 /health 轮询；
 *   而且**前缀缓存是不是命中全靠"求"服务端**。把引擎放进本进程之后，KV 缓存归我们自己管，
 *   "静态前缀常驻"就成了可以保证的事，而不是祈祷。
 *
 * 这个引擎"专门适配本 App"的地方只有一条，但是要害：
 *   **它知道哪些 token 是静态前缀**（系统提示 + 角色卡 + 示例对话），
 *   于是每轮只需要对"新增的那几 token"做一次 decode。
 *   中文模板文案不写死在这儿 —— 由 Java 传进来注册，改文案不用重编 .so。
 *
 * 编译：jni/build.sh（Termux 自带 clang，默认 target 就是 aarch64-linux-android24，不需要 NDK）
 */
#include <jni.h>
#include <llama.h>
#include <ggml-backend.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ================= 全局状态 ================= */

static struct llama_model   *g_model = NULL;
static struct llama_context *g_ctx   = NULL;
static const struct llama_vocab *g_vocab = NULL;
static llama_memory_t        g_mem   = NULL;

/* 当前 KV 缓存里装着的 token 序列。做前缀比对、context-shift 都要靠它。 */
static llama_token *g_cache      = NULL;
static int          g_cache_n    = 0;
static int          g_cache_cap  = 0;

static int g_n_ctx = 0;
/* 逻辑批（预填充块大小）与本次加载的 tune。generate_text 要从 tune 里读 "chunk"。 */
static int  g_n_batch = 0;
static char g_load_tune[512] = {0};
/* 自投机统计（每轮清零）：提了多少草稿 token、命中多少。 */
static long g_spec_draft = 0;
static long g_spec_accept = 0;
/* 命中率太低的文本（普通散文）上自投机是净亏，所以探测一段后自动关掉本次生成。 */
static int  g_spec_off = 0;
static volatile int g_stop = 0;
static int g_backends_ready = 0;

/* 注册 ggml 后端（CPU 后端是单独的 .so，不注册就什么都加载不了）。
 *
 * 这里踩过一个只有真机才暴露的坑：Termux 里跑测试时我们一直显式设了
 * GGML_BACKEND_PATH，所以从没发现"默认路径找不到后端"这件事。
 * App 里没有这个环境变量，而 ggml 默认只在 cwd / 可执行文件目录附近找 ——
 * 结果 libggml-cpu-*.so 明明躺在 nativeLibraryDir 里，却一个都没注册上，
 * 模型加载直接失败（而且没有任何明显报错，只能看到 load 返回 -1）。
 *
 * 所以顺序是：环境变量 → 本 .so 自己的目录（App 里 CPU 后端和我们同目录）→ 交给 ggml 默认识别。
 */
static void ensure_backends(void) {
    if (g_backends_ready) return;
    g_backends_ready = 1;

    llama_backend_init();

    const char *bdir = getenv("GGML_BACKEND_PATH");
    if (bdir && bdir[0]) {
        ggml_backend_load_all_from_path(bdir);
        return;
    }

    Dl_info info;
    if (dladdr((void *) &ensure_backends, &info) && info.dli_fname) {
        char dir[4096];
        snprintf(dir, sizeof(dir), "%s", info.dli_fname);
        char *slash = strrchr(dir, '/');
        if (slash) {
            *slash = 0;
            ggml_backend_load_all_from_path(dir);
            return;
        }
    }
    ggml_backend_load_all();
}

/* 流式回调 */
static JavaVM   *g_vm = NULL;
static jclass    g_cls = NULL;
static jmethodID g_midToken = NULL;
static jmethodID g_midProgress = NULL;

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long) ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

/* ================= 参数解析（"k=v;k=v" 一行） =================
 *
 * 前端把采样/加载参数压成一行传进来（不引 JSON 解析库）。generate_text 用下面几个取采样项，
 * nativeLoad 用它们取 KV 量化 / Flash Attention / 物理批大小。认不得的键一律回落默认值。
 */
static float cfg_f(const char *cfg, const char *key, float def) {
    if (!cfg) return def;
    size_t klen = strlen(key);
    const char *p = cfg;
    while (p && *p) {
        const char *sep = strchr(p, ';');
        int is_match = (strncmp(p, key, klen) == 0 && p[klen] == '=');
        if (is_match) return strtof(p + klen + 1, NULL);
        if (!sep) break;
        p = sep + 1;
    }
    return def;
}
static int cfg_i(const char *cfg, const char *key, int def) {
    return (int) cfg_f(cfg, key, (float) def);
}
/* 取字符串值：返回指向 cfg 内部的指针，值一直到下一个 ';' 或串尾；没有该键返回 def。 */
static const char *cfg_s(const char *cfg, const char *key, const char *def) {
    if (!cfg) return def;
    size_t klen = strlen(key);
    const char *p = cfg;
    while (p && *p) {
        const char *sep = strchr(p, ';');
        if (strncmp(p, key, klen) == 0 && p[klen] == '=') return p + klen + 1;
        if (!sep) break;
        p = sep + 1;
    }
    return def;
}
/* KV 缓存类型：f32 / f16 / q8_0 / q4_0 / q5_0 / q5_1。认不出返回 def。 */
static enum ggml_type cfg_type(const char *cfg, const char *key, enum ggml_type def) {
    const char *v = cfg_s(cfg, key, NULL);
    if (!v || !v[0]) return def;
    char buf[16];
    size_t i = 0;
    while (i + 1 < sizeof(buf) && v[i] && v[i] != ';') { buf[i] = v[i]; i++; }
    buf[i] = 0;
    if (!strcmp(buf, "f32"))  return GGML_TYPE_F32;
    if (!strcmp(buf, "f16"))  return GGML_TYPE_F16;
    if (!strcmp(buf, "q8_0")) return GGML_TYPE_Q8_0;
    if (!strcmp(buf, "q4_0")) return GGML_TYPE_Q4_0;
    if (!strcmp(buf, "q5_0")) return GGML_TYPE_Q5_0;
    if (!strcmp(buf, "q5_1")) return GGML_TYPE_Q5_1;
    return def;
}
/* 三态布尔：1/true/on、0/false/off；没有该键返回 def。 */
static int cfg_bool(const char *cfg, const char *key, int def) {
    const char *v = cfg_s(cfg, key, NULL);
    if (!v || !v[0]) return def;
    if (v[0] == '1' || strncmp(v, "true", 4) == 0 || strncmp(v, "on", 2) == 0) return 1;
    if (v[0] == '0' || strncmp(v, "false", 5) == 0 || strncmp(v, "off", 3) == 0) return 0;
    return def;
}

/* 把一段文本推给 Java 侧（NativeEngine.onToken）。回调抛异常就地清掉，别让它污染后续调用。 */
static void emit_piece(const char *piece) {
    if (!g_vm || !g_cls || !g_midToken) return;
    JNIEnv *env = NULL;
    if ((*g_vm)->GetEnv(g_vm, (void **) &env, JNI_VERSION_1_6) != JNI_OK) return;
    jstring s = (*env)->NewStringUTF(env, piece);
    if (!s) return;
    (*env)->CallStaticVoidMethod(env, g_cls, g_midToken, s);
    if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
    (*env)->DeleteLocalRef(env, s);
}

/* 预填充进度心跳：长 prompt 的第一次 decode 可能几十秒，期间没有任何 token 回调，
   前端 60 秒「冻结看门狗」会把这一轮误判成卡死并 abort —— 真机首轮空回复就是这么来的。
   每解码完一小块就报一次进度，前端据此给这一轮续命。 */
static void emit_progress(int done, int total) {
    if (!g_vm || !g_cls || !g_midProgress) return;
    JNIEnv *env = NULL;
    if ((*g_vm)->GetEnv(g_vm, (void **) &env, JNI_VERSION_1_6) != JNI_OK) return;
    (*env)->CallStaticVoidMethod(env, g_cls, g_midProgress, (jint) done, (jint) total);
    if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
}

/* 用 malloc 扩一个 token 缓冲（简单起见用 doubling）。 */
static int ensure_cache_cap(int need) {
    if (need <= g_cache_cap) return 1;
    int cap = g_cache_cap ? g_cache_cap : 4096;
    while (cap < need) cap *= 2;
    llama_token *p = (llama_token *) realloc(g_cache, sizeof(llama_token) * (size_t) cap);
    if (!p) return 0;
    g_cache = p;
    g_cache_cap = cap;
    return 1;
}

/* ================= 加载 / 释放 ================= */

JNIEXPORT jstring JNICALL
Java_com_fy_local_NativeEngine_nativeSystemInfo(JNIEnv *env, jclass cls) {
    /* 先注册后端再问：llama_print_system_info() 报的就是已注册的后端列表，
       后端没注册之前它只会返回空串（真机上第一次看到还以为是 JNI 坏了）。 */
    ensure_backends();
    const char *s = llama_print_system_info();
    return (*env)->NewStringUTF(env, s ? s : "");
}

/* 返回加载耗时（ms），失败 -1 */
JNIEXPORT jlong JNICALL
Java_com_fy_local_NativeEngine_nativeLoad(JNIEnv *env, jclass cls, jstring jpath,
                                          jint nCtx, jint nThreads, jint nBatch, jboolean mlock,
                                          jstring jtune) {
    if (g_ctx) return -1;

    const char *path = (*env)->GetStringUTFChars(env, jpath, NULL);
    const char *tune = jtune ? (*env)->GetStringUTFChars(env, jtune, NULL) : NULL;
    long t0 = now_ms();

    ensure_backends();

    struct llama_model_params mp = llama_model_default_params();
    /* 新版 llama.cpp 把 mlock 从 bool 换成了枚举：MMAP_MLOCK = 边 mmap 边锁进内存。
       App 侧实测过 3B 上 mlock 能把生成速度翻倍（3.6→9 tok/s），代价是内存占用变硬。 */
    mp.load_mode = mlock ? LLAMA_LOAD_MODE_MMAP_MLOCK : LLAMA_LOAD_MODE_AUTO;
    g_model = llama_model_load_from_file(path, mp);
    if (!g_model && mlock) {
        /* 真机上 RLIMIT_MEMLOCK 很小，mlock 基本必然失败（子进程那条路的日志里
           就一直有 "failed to mlock ... Out of memory"）。在 MMAP_MLOCK 模式下
           这会让整个加载失败 —— 于是"想提速"变成"起不来"。
           所以锁不上就退回 AUTO 再试一次：慢一点，但能用。 */
        mp.load_mode = LLAMA_LOAD_MODE_AUTO;
        g_model = llama_model_load_from_file(path, mp);
    }
    (*env)->ReleaseStringUTFChars(env, jpath, path);
    if (!g_model) {
        if (tune) (*env)->ReleaseStringUTFChars(env, jtune, tune);
        return -1;
    }
    g_vocab = llama_model_get_vocab(g_model);

    struct llama_context_params cp = llama_context_default_params();
    cp.n_ctx           = (uint32_t) nCtx;
    cp.n_batch         = (uint32_t) (nBatch > 0 ? nBatch : 512);
    /* 物理批大小（预填充块大小）。默认等于 n_batch；小模型上单独调它有用，所以留一个 tune 口。 */
    uint32_t ub = (uint32_t) cfg_i(tune, "ubatch", (int) cp.n_batch);
    cp.n_ubatch        = ub > 0 ? ub : cp.n_batch;
    cp.n_threads       = nThreads;
    cp.n_threads_batch = nThreads;

    /* KV 缓存量化 + Flash Attention（JNI 线路的提速开关）：
       - type_k/type_v 默认跟着模型走（一般是 f16）；q8_0 把 KV 带宽砍掉约一半。
         decode 是内存带宽受限，小模型上通常直接换到速度。
       - 量化过的 KV 需要 Flash Attention 参与计算，所以用户没显式关 FA 时自动打开。
       两个键只在 tune 里给了才生效，不传 tune 就是老行为。 */
    int kv_set = (cfg_s(tune, "type_k", NULL) != NULL) || (cfg_s(tune, "type_v", NULL) != NULL);
    cp.type_k = cfg_type(tune, "type_k", cp.type_k);
    cp.type_v = cfg_type(tune, "type_v", cp.type_v);
    int fa = cfg_i(tune, "flash_attn", (int) LLAMA_FLASH_ATTN_TYPE_AUTO);
    if (kv_set && fa == (int) LLAMA_FLASH_ATTN_TYPE_AUTO) fa = (int) LLAMA_FLASH_ATTN_TYPE_ENABLED;
    cp.flash_attn_type = (enum llama_flash_attn_type) fa;
    int kvu = cfg_bool(tune, "kv_unified", -1);
    if (kvu >= 0) cp.kv_unified = kvu == 1;
    int swaf = cfg_bool(tune, "swa_full", -1);
    if (swaf >= 0) cp.swa_full = swaf == 1;

    g_n_batch = (int) cp.n_batch;
    if (tune) {
        snprintf(g_load_tune, sizeof(g_load_tune), "%s", tune);
    } else {
        g_load_tune[0] = 0;
    }
    if (tune) { (*env)->ReleaseStringUTFChars(env, jtune, tune); tune = NULL; }
    g_ctx = llama_init_from_model(g_model, cp);
    if (!g_ctx) {
        /* context 建不起来（ctx 要的内存比模型还大时会发生）：模型也要还回去，
           否则下一次 load 会以为还占着，而且这几 GB 就一直挂着。 */
        llama_model_free(g_model);
        g_model = NULL;
        return -1;
    }
    g_mem = llama_get_memory(g_ctx);
    g_n_ctx = nCtx;
    g_cache_n = 0;

    /* 缓存 Java 回调句柄 */
    if (!g_vm) {
        (*env)->GetJavaVM(env, &g_vm);
        jclass local = (*env)->FindClass(env, "com/fy/local/NativeEngine");
        if (local) {
            g_cls = (jclass) (*env)->NewGlobalRef(env, local);
            g_midToken = (*env)->GetStaticMethodID(env, g_cls, "onToken", "(Ljava/lang/String;)V");
            g_midProgress = (*env)->GetStaticMethodID(env, g_cls, "onProgress", "(II)V");
            (*env)->DeleteLocalRef(env, local);
        }
    }
    return (jlong) (now_ms() - t0);
}

JNIEXPORT void JNICALL
Java_com_fy_local_NativeEngine_nativeRelease(JNIEnv *env, jclass cls) {
    if (g_ctx)   { llama_free(g_ctx);        g_ctx = NULL; }
    if (g_model) { llama_model_free(g_model); g_model = NULL; }
    g_mem = NULL; g_vocab = NULL; g_cache_n = 0;
}

/* ================= 前缀 =================
 *
 * 把"静态前缀"（系统提示 + 角色卡 + 示例对话）先解码进 KV，之后它就一直待在那儿。
 * 前缀的**内容**由 Java 决定，这里只负责 tokenize + 解码 + 记住。
 *
 * 返回：前缀 token 数；失败返回 -1
 */
JNIEXPORT jint JNICALL
Java_com_fy_local_NativeEngine_nativeSetPrefix(JNIEnv *env, jclass cls, jstring jprefix) {
    if (!g_ctx) return -1;

    const char *text = (*env)->GetStringUTFChars(env, jprefix, NULL);
    int len = (int) strlen(text);
    int cap = len + 64;
    llama_token *toks = (llama_token *) malloc(sizeof(llama_token) * (size_t) cap);
    int n = llama_tokenize(g_vocab, text, len, toks, cap, true, true);
    (*env)->ReleaseStringUTFChars(env, jprefix, text);
    if (n <= 0) { free(toks); return -1; }

    llama_memory_clear(g_mem, true);
    g_cache_n = 0;

    if (!ensure_cache_cap(n)) { free(toks); return -1; }

    int batch = 512;
    for (int i = 0; i < n; i += batch) {
        int m = (n - i) < batch ? (n - i) : batch;
        struct llama_batch b = llama_batch_get_one(toks + i, m);
        if (llama_decode(g_ctx, b) != 0) { free(toks); return -1; }
    }
    memcpy(g_cache, toks, sizeof(llama_token) * (size_t) n);
    g_cache_n = n;
    free(toks);
    return (jint) n;
}

/* ================= 生成核心 =================
 *
 * 两条入口（nativeGenerate 收现成 prompt、nativeChat 收 messages）最后都汇到这里。
 * 引擎在这里做三件事：
 *   1. 跟 KV 里的 token 序列比对，找最长公共前缀 → 只 decode 增量（这就是"前缀复用"）
 *   2. 放不下时从**静态前缀之后**丢最老的一段，并把位置整体前移（context-shift）
 *   3. 边采样边回调，token 一出来就推给 Java
 *
 * text 在整个调用期间必须有效（nativeChat 传的是自己 malloc 的渲染结果）。
 * pin = 静态前缀的 token 数，这一段任何情况下都不许被 context-shift 丢掉。
 */
/* 语法约束：给了 trigger 就用「懒语法」——生成里出现 trigger 之前完全不受限（正文自由），
   出现之后才按 grammar 约束；没给 trigger 就用严格语法（整段输出都必须满足）。 */
static struct llama_sampler *make_grammar(const char *grammar, const char *trigger) {
    if (!grammar || !grammar[0]) return NULL;
    if (trigger && trigger[0]) {
        const char *patterns[1];
        patterns[0] = trigger;
        return llama_sampler_init_grammar_lazy_patterns(g_vocab, grammar, "root", patterns, 1, NULL, 0);
    }
    return llama_sampler_init_grammar(g_vocab, grammar, "root");
}

/* Z-algorithm：z[i] = s[0..] 与 s[i..] 的最长公共前缀长度，线性时间。
   用在"滑窗口对齐"里一次算完新模式与旧 KV 序列的全部最长公共扩展（LCE）。 */
static void z_function(const llama_token *s, int n, int *z) {
    z[0] = n;
    int l = 0, r = 0;
    for (int i = 1; i < n; i++) {
        int k = 0;
        if (i < r) k = (z[i - l] < r - i) ? z[i - l] : r - i;
        while (i + k < n && s[k] == s[i + k]) k++;
        z[i] = k;
        if (i + k > r) { l = i; r = i + k; }
    }
}

/* ================= n-gram / prompt-lookup 自投机 =================
 *
 * llama.cpp 的公开 C API 不暴露投机解码（只有 common/ 与 examples/lookup 基于公开 API 自己实现），
 * 所以这里手写一个"看历史猜下一段、一次 batch decode 验证"的版本：
 *
 *   1. 取 KV 末尾 look_n 个 token 当模式，往前找最近一次相同模式，把它后面一段当草稿；
 *   2. 先用当前 logits 采样第一个 token：和草稿[0] 不符就照常单步（不亏，只是多一次采样）；
 *   3. 相符就把整段草稿一次 batch decode（每个位置都要 logits），逐个采样验证：
 *      采到的 token 和草稿一致就接受，不一致就停在那一位；
 *   4. 被拒绝的草稿 token 从 KV 里删掉，只保留采定的那串。
 *
 * **分布不变**：每个真正吐出去的 token 都是在"当时正确的上下文"下从目标分布采样得到的
 * （一致就复用草稿那份，不一致就用采到的那份），所以它只是省 decode，不改语义。
 *
 * 默认关（tune 的 lookup=0）。命中率低时它只是多算一次 batch，所以必须"量到正收益才开"。
 */
static void emit_piece_for(llama_token id) {
    char piece[256];
    int np = llama_token_to_piece(g_vocab, id, piece, (int) sizeof(piece), 0, true);
    if (np > 0) { piece[np] = 0; emit_piece(piece); }
}

/* 返回本轮真正采定的 token 数；-1 = 这次没跑（调用方走普通单步，且本函数没消耗任何采样）。 */
static int spec_step(struct llama_sampler *smpl, int look_n, int draft_max, int budget,
                     long start_ms, long *first_ms) {
    if (look_n < 1 || g_stop || budget < 2) return -1;
    if (g_spec_off) return -1;
    if (g_cache_n < look_n + 1) return -1;

    /* 1. 找最近一次相同 n-gram，取后面一段当草稿（草稿里遇到 EOG 就截断） */
    llama_token draft[16];
    int pat = g_cache_n - look_n;
    int best = -1;
    for (int j = pat - look_n; j >= 0; j--) {
        if (memcmp(g_cache + j, g_cache + pat, sizeof(llama_token) * (size_t) look_n) == 0) { best = j; break; }
    }
    if (best < 0) return -1;
    int src = best + look_n;
    int kmax = draft_max;
    if (kmax > (int) (sizeof(draft) / sizeof(draft[0]))) kmax = (int) (sizeof(draft) / sizeof(draft[0]));
    if (kmax > budget - 1) kmax = budget - 1;   /* 还要留一位给"bonus" */
    int k = 0;
    while (k < kmax && src + k < g_cache_n) {
        llama_token t = g_cache[src + k];
        if (llama_vocab_is_eog(g_vocab, t)) break;
        draft[k++] = t;
    }
    if (k <= 0) return -1;
    if (!ensure_cache_cap(g_cache_n + k + 1)) return -1;
    g_spec_draft += k;

    /* 2. 第一个 token：用当前 logits 采样，和草稿[0] 比 */
    llama_token t0 = llama_sampler_sample(smpl, g_ctx, -1);
    if (t0 != draft[0]) {
        if (llama_vocab_is_eog(g_vocab, t0)) { g_stop = 1; return 0; }
        llama_sampler_accept(smpl, t0);
        if (*first_ms < 0) *first_ms = now_ms() - start_ms;
        emit_piece_for(t0);
        g_cache[g_cache_n++] = t0;
        struct llama_batch one = llama_batch_get_one(&t0, 1);
        if (llama_decode(g_ctx, one) != 0) g_stop = 1;
        return 1;
    }
    llama_sampler_accept(smpl, draft[0]);
    g_spec_accept++;

    /* 3. 一次 batch decode 整段草稿，每个位置都要 logits（显式 pos，别赌 NULL 的语义） */
    int base = g_cache_n;
    struct llama_batch b = llama_batch_init(k, 0, 1);
    for (int i = 0; i < k; i++) {
        b.token[i] = draft[i];
        b.pos[i] = (llama_pos) (base + i);
        b.n_seq_id[i] = 1;
        b.seq_id[i][0] = 0;
        b.logits[i] = 1;
    }
    b.n_tokens = k;
    if (llama_decode(g_ctx, b) != 0) {
        llama_batch_free(b);
        /* 只采定了 draft[0]：KV 回到 base 再单步 decode 它 */
        llama_memory_seq_rm(g_mem, 0, base, -1);
        if (*first_ms < 0) *first_ms = now_ms() - start_ms;
        emit_piece_for(draft[0]);
        g_cache[g_cache_n++] = draft[0];
        struct llama_batch one = llama_batch_get_one(&draft[0], 1);
        if (llama_decode(g_ctx, one) != 0) g_stop = 1;
        return 1;
    }
    llama_batch_free(b);

    /* 4. 逐个验证（draft[0] 已经采定） */
    int accepted = 1;
    int rej = -1;
    llama_token bonus = 0;
    for (int i = 1; i < k; i++) {
        llama_token ti = llama_sampler_sample(smpl, g_ctx, i - 1);
        if (ti == draft[i]) {
            llama_sampler_accept(smpl, draft[i]);
            g_spec_accept++;
            accepted++;
        } else {
            rej = i;
            bonus = ti;
            break;
        }
    }
    if (rej < 0) bonus = llama_sampler_sample(smpl, g_ctx, k - 1);

    /* 5. 修 KV：只留 [base, base+accepted)，丢掉的草稿尾巴删掉 */
    if (base + accepted < base + k) llama_memory_seq_rm(g_mem, 0, base + accepted, -1);

    if (*first_ms < 0) *first_ms = now_ms() - start_ms;
    for (int i = 0; i < accepted; i++) {
        emit_piece_for(draft[i]);
        g_cache[g_cache_n++] = draft[i];
    }
    int emitted = accepted;
    if (llama_vocab_is_eog(g_vocab, bonus)) { g_stop = 1; return emitted; }
    llama_sampler_accept(smpl, bonus);
    emit_piece_for(bonus);
    g_cache[g_cache_n++] = bonus;
    struct llama_batch one = llama_batch_get_one(&bonus, 1);
    if (llama_decode(g_ctx, one) != 0) g_stop = 1;
    return emitted + 1;
}

static jstring generate_text(JNIEnv *env, const char *text, int maxTokens, float temp,
                             int topK, float topP, int seed, int pinTokens,
                             const char *samplerCfg, const char *grammar, const char *grammarTrigger) {
    if (!g_ctx) return (*env)->NewStringUTF(env, "{\"error\":\"engine not loaded\"}");

    /* 在这一轮最开始就把停止标志清掉（而不是预填充之后）。
       否则长上下文预填充期间点"停止"会被这次清零吃掉 —— 几百 token 的 prefill 要等好几秒，
       用户点了停止却停不下来，体感就是"按了没反应"。 */
    g_stop = 0;
    g_spec_draft = 0;
    g_spec_accept = 0;
    g_spec_off = 0;

    int len = (int) strlen(text);
    int cap = len + 64;
    llama_token *toks = (llama_token *) malloc(sizeof(llama_token) * (size_t) cap);
    if (!toks) return (*env)->NewStringUTF(env, "{\"error\":\"out of memory\"}");

    /* add_special=true：让模型自己决定要不要在开头放 BOS。
       这里必须和 nativeSetPrefix / 前缀计数用同一套规则 —— 规则不一致的话，
       同一个前缀在两处会被切成不同的 token 序列，第一轮就复用不上（而且很难查）。 */
    int n_tok = llama_tokenize(g_vocab, text, len, toks, cap, true, true);
    if (n_tok <= 0) { free(toks); return (*env)->NewStringUTF(env, "{\"error\":\"tokenize failed\"}"); }

    long t0 = now_ms();

    /* ---- 1. 最长公共前缀 ---- */
    int common = 0;
    int lim = (g_cache_n < n_tok) ? g_cache_n : n_tok;
    while (common < lim && g_cache[common] == toks[common]) common++;
    int reused = common;

    int pin = pinTokens > 0 ? pinTokens : 0;
    if (pin > g_cache_n) pin = g_cache_n;
    if (pin > n_tok)    pin = n_tok;

    /* ---- 1b. 前端裁掉了最老的一批消息 → 新动态段是旧动态段的一个后缀 ----
     *
     * 前端按 historyLimit 滑窗口时，每轮都会从最前面丢掉 1~2 条消息。旧做法下公共
     * 前缀会一路塌回系统前缀（真机实测 reused 1122 → 380），后面每条消息都要重算一遍
     * prefill —— 这就是长对话"越聊越卡"的根因。
     *
     * 其实被丢掉的只是最前面一段**连续区间**，后面的历史 KV 原封不动就能用：在旧 token
     * 序列里找到"新动态段"的起点 o，把 [pin, o) 从 KV 里删掉、剩下的位置整体前移
     * （RoPE 由 llama_memory_seq_add 负责，和 context-shift 用的是同一个原语），
     * 保留下来的部分一个 token 都不用重算。
     *
     * 只在"系统前缀还对得上、但动态段断了"时尝试；要求匹配至少 minMatch 个 token。
     *
     * 注意这里找的是"最长匹配的一段后缀"，而不是要求旧序列的整个尾巴逐 token 相等：
     * 前端会在落盘前加工模型回复（剥思考段、抽选项、截掉回吐的提示词），所以上一条回复
     * 的"存储形态"常常和 KV 里的原始 token 有几个 token 的差异。要求整段尾巴相等时，
     * 这点差异会让对齐整个失败、退回整段重算（真机实测偶尔冒出一轮 38 s）。放宽成
     * "最长匹配 + 至少 minMatch"之后，只有被改掉的那几个 token 需要重算。 */
    if (pin > 0 && common >= pin && common < g_cache_n && n_tok > pin) {
        const int minMatch = 16;
        int best = -1, best_len = 0;
        /* 一次算完所有起点的最长公共扩展（LCE）：把"新动态段"当模式、旧 KV 序列当文本，
           中间塞一个不可能出现的负 token 当分隔符，跑一遍 Z-algorithm。
           原做法是对每个起点各比一遍（最坏 O(n·m)），现在是 O(n+m)。
           结果与朴素实现逐位一致：取"首个达到最大匹配长度"的起点。 */
        int pat_len = n_tok - pin;
        int old_len = g_cache_n - pin;
        int ztotal = pat_len + 1 + old_len;
        llama_token *zcomb = (llama_token *) malloc(sizeof(llama_token) * (size_t) ztotal);
        int *zarr = (int *) malloc(sizeof(int) * (size_t) ztotal);
        if (zcomb && zarr) {
            memcpy(zcomb, toks + pin, sizeof(llama_token) * (size_t) pat_len);
            zcomb[pat_len] = (llama_token) -1;   /* token id 不会是负的，匹配不会越过模式边界 */
            memcpy(zcomb + pat_len + 1, g_cache + pin, sizeof(llama_token) * (size_t) old_len);
            z_function(zcomb, ztotal, zarr);
            for (int j = 1; j < old_len; j++) {
                int m = zarr[pat_len + 1 + j];
                if (m >= minMatch && m > best_len) { best_len = m; best = pin + j; }
            }
        }
        free(zarr);
        free(zcomb);
        if (best > pin && best_len >= minMatch && llama_memory_can_shift(g_mem)) {
            int drop = best - pin;
            llama_memory_seq_rm(g_mem, 0, pin, best);          /* 删掉被裁掉的那一段 */
            llama_memory_seq_add(g_mem, 0, best, -1, -drop);   /* 后面的历史整体前移 */
            memmove(g_cache + pin, g_cache + best,
                    sizeof(llama_token) * (size_t) (g_cache_n - best));
            g_cache_n -= drop;
            common = pin + best_len;                            /* 只复用真正对上的那一段 */
            if (common > n_tok) common = n_tok;
            if (common > g_cache_n) common = g_cache_n;
            reused = common;
        }
    }

    /* 整段 prompt 都已经在 KV 里时（用户点"重新生成"、或同一段 prompt 连着跑两次），
       common == n_tok，本轮一个 token 都不用 decode —— 采样器会拿上一轮最后一个 token
       的 logits，而那个位置已经被上面裁掉了，结果通常是立刻吐 EOG（真机/本地都复现过：
       gen=0、firstMs=-1）。这里强制把最后一个 prompt token 重新 decode 一遍换回正确 logits。 */
    if (common == n_tok && n_tok > 0) common = n_tok - 1;
    reused = common;
    if (common < g_cache_n) {
        llama_memory_seq_rm(g_mem, 0, common, -1);
        g_cache_n = common;
    }

    /* ---- 2. context-shift：放不下就从"前缀之后"丢最老的一段 ---- */
    int need = n_tok - common + maxTokens;
    while (g_cache_n + need > g_n_ctx) {
        int room = g_cache_n - pin;                 /* 前缀之后还有多少可以丢 */
        if (room <= 0) break;                       /* 前缀自己就快占满，没得丢了 */
        int drop = room / 2;
        if (drop < 64) drop = room;
        if (drop > room) drop = room;
        if (!llama_memory_can_shift(g_mem)) break;  /* 这份 KV 不支持移位，只能作罢 */
        llama_memory_seq_rm(g_mem, 0, pin, pin + drop);
        llama_memory_seq_add(g_mem, 0, pin + drop, -1, -drop);
        memmove(g_cache + pin, g_cache + pin + drop,
                sizeof(llama_token) * (size_t) (g_cache_n - pin - drop));
        g_cache_n -= drop;
        need = n_tok - common + maxTokens;
        if (common > g_cache_n) common = g_cache_n;
        if (common < pin && pin - common > 0) {
            /* 丢掉的区间落在公共前缀里：退回丢之前的状态，靠调用方缩上下文 */
            break;
        }
    }

    /* ---- 3. decode 增量 ----
       分块预填充（128/块）：一是让 g_stop 在长 prefill 中间也能生效；二是每块报一次
       进度，前端看门狗不会把「还没出 token 的 prefill」误杀成冻结；三是 llama.cpp 第一次
       decode 就按 batch 预留计算图，512 的图在 3B 上又大又慢（真机首轮就卡在这儿）。 */
    /* 预填充块大小：默认 128（原行为）。大块少几次 decode 调用、GPU/CPU 上矩阵乘更满，
       但一次调用更久、中途点"停止"要等它跑完，所以做成可调（tune 的 "chunk"，默认不变）。 */
    int batch = cfg_i(g_load_tune, "chunk", 128);
    if (batch < 32) batch = 32;
    if (g_n_batch > 0 && batch > g_n_batch) batch = g_n_batch;
    int prefill_total = n_tok - common;
    long first_ms = -1;
    for (int i = common; i < n_tok; i += batch) {
        if (g_stop) break;                          /* 预填充期间也要能停 */
        int m = (n_tok - i) < batch ? (n_tok - i) : batch;
        if (!ensure_cache_cap(g_cache_n + m)) break;
        struct llama_batch b = llama_batch_get_one(toks + i, m);
        if (llama_decode(g_ctx, b) != 0) { free(toks); return (*env)->NewStringUTF(env, "{\"error\":\"prefill decode failed\"}"); }
        memcpy(g_cache + g_cache_n, toks + i, sizeof(llama_token) * (size_t) m);
        g_cache_n += m;
        emit_progress(g_cache_n - common, prefill_total);
    }
    long prefill_ms = now_ms() - t0;
    free(toks);
    /* 喂进去的 prompt 总长（= prefill 结束时的 KV 长度）。前端拿它校正 token 估算。 */
    int prompt_tokens = g_cache_n;

    /* ---- 4. 采样 + 流式回调 ---- */
    struct llama_sampler *smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());

    /* 惩罚类先做（改的是 logits），顺序按 llama.cpp 的惯例：
       惩罚/DRY → top-k → top-p → min-p → top-n-sigma → XTC → 温度 → 语法 → 分布。 */
    {
        int pen_n = cfg_i(samplerCfg, "pen_n", 64);
        float pen_rep = cfg_f(samplerCfg, "pen_rep", 1.0f);
        float pen_freq = cfg_f(samplerCfg, "pen_freq", 0.0f);
        float pen_pres = cfg_f(samplerCfg, "pen_pres", 0.0f);
        if (pen_n != 0 && (pen_rep != 1.0f || pen_freq != 0.0f || pen_pres != 0.0f)) {
            llama_sampler_chain_add(smpl,
                llama_sampler_init_penalties(llama_vocab_n_tokens(g_vocab),
                    pen_n, pen_rep, pen_freq, pen_pres));
        }
        float dry_mult = cfg_f(samplerCfg, "dry_mult", 0.0f);
        if (dry_mult > 0.0f) {
            llama_sampler_chain_add(smpl,
                llama_sampler_init_dry(g_vocab, dry_mult,
                    cfg_f(samplerCfg, "dry_base", 1.75f),
                    cfg_i(samplerCfg, "dry_allowed", 2),
                    cfg_i(samplerCfg, "dry_n", 256),
                    NULL, 0));
        }
    }
    if (temp <= 0.0f) {
        /* 贪心：温度关掉时 top-k/top-p 对 argmax 没意义，只留语法 */
        { struct llama_sampler *gs = make_grammar(grammar, grammarTrigger); if (gs) llama_sampler_chain_add(smpl, gs); }
        llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
    } else {
        if (topK > 0) llama_sampler_chain_add(smpl, llama_sampler_init_top_k(topK));
        if (topP < 1.0f) llama_sampler_chain_add(smpl, llama_sampler_init_top_p(topP, 1));
        float min_p = cfg_f(samplerCfg, "min_p", 0.0f);
        if (min_p > 0.0f) llama_sampler_chain_add(smpl, llama_sampler_init_min_p(min_p, 1));
        float top_ns = cfg_f(samplerCfg, "top_ns", 0.0f);
        if (top_ns > 0.0f) llama_sampler_chain_add(smpl, llama_sampler_init_top_n_sigma(top_ns));
        float xtc_p = cfg_f(samplerCfg, "xtc_p", 0.0f);
        if (xtc_p > 0.0f) {
            llama_sampler_chain_add(smpl,
                llama_sampler_init_xtc(xtc_p, cfg_f(samplerCfg, "xtc_t", 0.1f), 1,
                    (uint32_t) (seed > 0 ? seed : 1234)));
        }
        float tdelta = cfg_f(samplerCfg, "temp_delta", 0.0f);
        if (tdelta > 0.0f) {
            llama_sampler_chain_add(smpl,
                llama_sampler_init_temp_ext(temp, tdelta, cfg_f(samplerCfg, "temp_exp", 1.0f)));
        } else {
            llama_sampler_chain_add(smpl, llama_sampler_init_temp(temp));
        }
        { struct llama_sampler *gs = make_grammar(grammar, grammarTrigger); if (gs) llama_sampler_chain_add(smpl, gs); }
        llama_sampler_chain_add(smpl, llama_sampler_init_dist((uint32_t) (seed > 0 ? seed : 1234)));
    }

    int gen = 0;
    /* 自投机：默认 lookup=0（关）。lookup=N 时用末尾 N 个 token 做 n-gram 草稿。 */
    int lookup_n = cfg_i(g_load_tune, "lookup", 0);
    int draft_max = cfg_i(g_load_tune, "draft", 8);
    if (draft_max < 1) draft_max = 1;
    if (draft_max > 16) draft_max = 16;

    int step = 0;
    while (step < maxTokens && !g_stop) {
        int got = -1;
        if (lookup_n > 0) {
            got = spec_step(smpl, lookup_n, draft_max, maxTokens - step, t0, &first_ms);
            /* 自适应：累计提了 >=20 个草稿、命中 < 40% 就关掉，避免在普通散文上白算 */
            if (g_spec_draft >= 20 && g_spec_accept * 5 < g_spec_draft * 2) g_spec_off = 1;
        }
        if (got < 0) {
            /* 普通单步（和以前一字不差） */
            llama_token id = llama_sampler_sample(smpl, g_ctx, -1);
            if (llama_vocab_is_eog(g_vocab, id)) break;
            llama_sampler_accept(smpl, id);
            char piece[256];
            int np = llama_token_to_piece(g_vocab, id, piece, (int) sizeof(piece), 0, true);
            if (np > 0) {
                piece[np] = 0;
                if (first_ms < 0) first_ms = now_ms() - t0;
                emit_piece(piece);
            }
            if (!ensure_cache_cap(g_cache_n + 1)) break;
            g_cache[g_cache_n++] = id;
            struct llama_batch b = llama_batch_get_one(&id, 1);
            if (llama_decode(g_ctx, b) != 0) break;
            got = 1;
        }
        step += got;
        gen += got;
    }
    long total_ms = now_ms() - t0;
    llama_sampler_free(smpl);

    /* 统计信息给 Java 侧用（Java 只管把 token 推给前端，不解析这段 JSON 也行） */
    char res[192];
    snprintf(res, sizeof(res),
             "{\"gen\":%d,\"reused\":%d,\"prompt\":%d,\"cache\":%d,"
             "\"prefillMs\":%ld,\"firstMs\":%ld,\"totalMs\":%ld,"
             "\"specDraft\":%ld,\"specAccept\":%ld}",
             gen, reused, prompt_tokens, g_cache_n, prefill_ms, first_ms, total_ms,
             g_spec_draft, g_spec_accept);
    return (*env)->NewStringUTF(env, res);
}

JNIEXPORT jstring JNICALL
Java_com_fy_local_NativeEngine_nativeGenerate(JNIEnv *env, jclass cls, jstring jprompt,
                                              jint maxTokens, jfloat temp, jint topK, jfloat topP,
                                              jint seed, jint prefixTokens,
                                              jstring jcfg, jstring jgrammar, jstring jtrigger) {
    const char *text = (*env)->GetStringUTFChars(env, jprompt, NULL);
    if (!text) return (*env)->NewStringUTF(env, "{\"error\":\"bad prompt\"}");
    const char *cfg = jcfg ? (*env)->GetStringUTFChars(env, jcfg, NULL) : NULL;
    const char *grammar = jgrammar ? (*env)->GetStringUTFChars(env, jgrammar, NULL) : NULL;
    const char *trigger = jtrigger ? (*env)->GetStringUTFChars(env, jtrigger, NULL) : NULL;
    jstring r = generate_text(env, text, maxTokens, temp, topK, topP, seed, prefixTokens, cfg, grammar, trigger);
    if (trigger) (*env)->ReleaseStringUTFChars(env, jtrigger, trigger);
    if (grammar) (*env)->ReleaseStringUTFChars(env, jgrammar, grammar);
    if (cfg) (*env)->ReleaseStringUTFChars(env, jcfg, cfg);
    (*env)->ReleaseStringUTFChars(env, jprompt, text);
    return r;
}

/* ================= 对话（套模型自带模板） =================
 *
 * 模板为什么在 C 侧套：.so 里链着 libllama，只有它拿得到 GGUF 里那份模板
 * （llama_chat_apply_template(NULL, ...) 就是 llama-server 用的同一套）。
 * 于是换模型 = 自动换模板：Java 与前端一行都不用改，更不用重编 App。
 * 反过来说，如果哪天要支持模型没带模板的 GGUF，只需要在 Java 侧多传一个模板名。
 *
 * 把 [role0, content0, role1, content1, ...] 的扁平数组渲染成 prompt（malloc，调用方 free）。
 * 失败返回 NULL。n_msg 可以小于数组长度 —— 用来单独渲染"静态前缀"那几条。
 */
static char *render_chat(JNIEnv *env, jobjectArray jmsgs, int n_msg, bool add_ass) {
    if (!jmsgs || n_msg <= 0) return NULL;

    jstring *refs = (jstring *) calloc((size_t) n_msg * 2, sizeof(jstring));
    const char **role = (const char **) calloc((size_t) n_msg, sizeof(char *));
    const char **content = (const char **) calloc((size_t) n_msg, sizeof(char *));
    struct llama_chat_message *chat =
            (struct llama_chat_message *) calloc((size_t) n_msg, sizeof(*chat));
    if (!refs || !role || !content || !chat) {
        free(refs); free(role); free(content); free(chat);
        return NULL;
    }

    size_t chars = 0;
    for (int i = 0; i < n_msg; i++) {
        refs[i * 2]     = (jstring) (*env)->GetObjectArrayElement(env, jmsgs, i * 2);
        refs[i * 2 + 1] = (jstring) (*env)->GetObjectArrayElement(env, jmsgs, i * 2 + 1);
        if (refs[i * 2])     role[i]    = (*env)->GetStringUTFChars(env, refs[i * 2], NULL);
        if (refs[i * 2 + 1]) content[i] = (*env)->GetStringUTFChars(env, refs[i * 2 + 1], NULL);
        if (!role[i])    role[i]    = "";
        if (!content[i]) content[i] = "";
        chat[i].role = role[i];
        chat[i].content = content[i];
        chars += strlen(role[i]) + strlen(content[i]);
    }

    /* 官方建议 2×字符数；再加一点余量给模板自带的角色标记。 */
    int cap = (int) (2 * chars + 512);
    char *buf = (char *) malloc((size_t) cap);
    if (buf) {
        int need = llama_chat_apply_template(NULL, chat, (size_t) n_msg, add_ass, buf, cap);
        if (need > 0 && need >= cap) {
            char *bigger = (char *) realloc(buf, (size_t) need + 1);
            if (!bigger) { free(buf); buf = NULL; }
            else {
                buf = bigger;
                int cap2 = need + 1;
                need = llama_chat_apply_template(NULL, chat, (size_t) n_msg, add_ass, buf, cap2);
            }
        }
        if (buf) {
            if (need <= 0) { free(buf); buf = NULL; }
            else buf[need] = 0;
        }
    }

    for (int i = 0; i < n_msg; i++) {
        if (role[i] && refs[i * 2])         (*env)->ReleaseStringUTFChars(env, refs[i * 2], role[i]);
        if (content[i] && refs[i * 2 + 1])  (*env)->ReleaseStringUTFChars(env, refs[i * 2 + 1], content[i]);
        if (refs[i * 2])     (*env)->DeleteLocalRef(env, refs[i * 2]);
        if (refs[i * 2 + 1]) (*env)->DeleteLocalRef(env, refs[i * 2 + 1]);
    }
    free(refs); free(role); free(content); free(chat);
    return buf;
}

/* 数一段文本会切成多少 token（失败返回 0）。 */
static int count_tokens(const char *text, int len) {
    int cap = len + 64;
    llama_token *tmp = (llama_token *) malloc(sizeof(llama_token) * (size_t) cap);
    if (!tmp) return 0;
    int n = llama_tokenize(g_vocab, text, len, tmp, cap, true, true);
    free(tmp);
    return n > 0 ? n : 0;
}

/* 调试/测试用：看看模型模板把 messages 渲染成什么样（前端"查看实际 prompt"也靠它）。 */
JNIEXPORT jstring JNICALL
Java_com_fy_local_NativeEngine_nativeApplyTemplate(JNIEnv *env, jclass cls, jobjectArray jmsgs,
                                                   jboolean addAss) {
    if (!jmsgs) return (*env)->NewStringUTF(env, "");
    int n_msg = (int) ((*env)->GetArrayLength(env, jmsgs) / 2);
    char *s = render_chat(env, jmsgs, n_msg, addAss == JNI_TRUE);
    if (!s) return (*env)->NewStringUTF(env, "");
    jstring out = (*env)->NewStringUTF(env, s);
    free(s);
    return out;
}

/* messages 走模型自带模板，然后流式生成。
 * pinMessages：前几条算"静态前缀"（一般是 1 条 system）。引擎量出它的 token 数并钉住，
 *              于是"人设/世界书常驻"这件事可以被保证；换角色 = 前缀变了 = 缓存自然失效。 */
static jstring chat_impl(JNIEnv *env, jobjectArray jmsgs, int pinMessages, int maxTokens, float temp,
                         int topK, float topP, int seed,
                         jstring jcfg, jstring jgrammar, jstring jtrigger) {
    if (!g_ctx) return (*env)->NewStringUTF(env, "{\"error\":\"engine not loaded\"}");
    if (!jmsgs) return (*env)->NewStringUTF(env, "{\"error\":\"no messages\"}");
    int n_msg = (int) ((*env)->GetArrayLength(env, jmsgs) / 2);
    if (n_msg <= 0) return (*env)->NewStringUTF(env, "{\"error\":\"no messages\"}");

    int pin = 0;
    if (pinMessages > 0) {
        int km = pinMessages > n_msg ? n_msg : pinMessages;
        /* 前缀按 add_ass=false 单独渲染一遍：模板没有"收尾"标记，量出来的就是公共前缀的长度。 */
        char *pfx = render_chat(env, jmsgs, km, false);
        if (pfx) {
            pin = count_tokens(pfx, (int) strlen(pfx));
            free(pfx);
        }
    }

    char *buf = render_chat(env, jmsgs, n_msg, true);
    if (!buf) return (*env)->NewStringUTF(env, "{\"error\":\"chat template failed\"}");
    const char *cfg = jcfg ? (*env)->GetStringUTFChars(env, jcfg, NULL) : NULL;
    const char *grammar = jgrammar ? (*env)->GetStringUTFChars(env, jgrammar, NULL) : NULL;
    const char *trigger = jtrigger ? (*env)->GetStringUTFChars(env, jtrigger, NULL) : NULL;
    jstring out = generate_text(env, buf, maxTokens, temp, topK, topP, seed, pin, cfg, grammar, trigger);
    if (trigger) (*env)->ReleaseStringUTFChars(env, jtrigger, trigger);
    if (grammar) (*env)->ReleaseStringUTFChars(env, jgrammar, grammar);
    if (cfg) (*env)->ReleaseStringUTFChars(env, jcfg, cfg);
    free(buf);
    return out;
}

/* 辅助生成（记忆压缩 / 创作者工具）：它的 prompt 跟聊天毫无关系，会把 KV 缓存整个换掉，
   下一轮聊天就得把整段历史重新 prefill（真机实测每次摘要更新后那一轮要 30 s）。
   这里在辅助生成前后把 seq 0 的状态存下来 / 恢复回去 —— 聊天的 KV 原样保留，
   下一轮继续整段复用。代价是一次约 KV 大小的内存拷贝，远小于重算。 */
JNIEXPORT jstring JNICALL
Java_com_fy_local_NativeEngine_nativeChatAux(JNIEnv *env, jclass cls, jobjectArray jmsgs,
                                             jint pinMessages, jint maxTokens, jfloat temp,
                                             jint topK, jfloat topP, jint seed,
                                             jstring jcfg, jstring jgrammar, jstring jtrigger) {
    if (!g_ctx) return (*env)->NewStringUTF(env, "{\"error\":\"engine not loaded\"}");

    /* 1) 存聊天序列的状态（KV + 位置）和我们的 token 镜像 */
    size_t sz = llama_state_seq_get_size(g_ctx, 0);
    uint8_t *state = sz ? (uint8_t *) malloc(sz) : NULL;
    size_t got = 0;
    if (state) got = llama_state_seq_get_data(g_ctx, state, sz, 0);
    int saved_n = g_cache_n;
    llama_token *saved = NULL;
    if (saved_n > 0) {
        saved = (llama_token *) malloc(sizeof(llama_token) * (size_t) saved_n);
        if (saved) memcpy(saved, g_cache, sizeof(llama_token) * (size_t) saved_n);
    }

    /* 2) 跑辅助生成（会把 seq 0 换掉） */
    jstring out = chat_impl(env, jmsgs, pinMessages, maxTokens, temp, topK, topP, seed,
                            jcfg, jgrammar, jtrigger);

    /* 3) 把聊天序列恢复回来 */
    if (state && got) llama_state_seq_set_data(g_ctx, state, got, 0);
    if (saved && ensure_cache_cap(saved_n)) {
        memcpy(g_cache, saved, sizeof(llama_token) * (size_t) saved_n);
        g_cache_n = saved_n;
    }
    free(saved);
    free(state);
    return out;
}

JNIEXPORT jstring JNICALL
Java_com_fy_local_NativeEngine_nativeChat(JNIEnv *env, jclass cls, jobjectArray jmsgs,
                                          jint pinMessages, jint maxTokens, jfloat temp,
                                          jint topK, jfloat topP, jint seed,
                                          jstring jcfg, jstring jgrammar, jstring jtrigger) {
    return chat_impl(env, jmsgs, pinMessages, maxTokens, temp, topK, topP, seed,
                     jcfg, jgrammar, jtrigger);
}

JNIEXPORT void JNICALL
Java_com_fy_local_NativeEngine_nativeStop(JNIEnv *env, jclass cls) {
    g_stop = 1;
}

/* 给测试和上下文预算用：一段文本在模型词表下是多少 token（未加载返回 -1）。 */
JNIEXPORT jint JNICALL
Java_com_fy_local_NativeEngine_nativeCountTokens(JNIEnv *env, jclass cls, jstring jtext) {
    if (!g_ctx) return -1;
    const char *t = (*env)->GetStringUTFChars(env, jtext, NULL);
    if (!t) return -1;
    int n = count_tokens(t, (int) strlen(t));
    (*env)->ReleaseStringUTFChars(env, jtext, t);
    return (jint) n;
}

/* 给测试用：当前 KV 里有多少 token */
JNIEXPORT jint JNICALL
Java_com_fy_local_NativeEngine_nativeCacheTokens(JNIEnv *env, jclass cls) {
    return (jint) g_cache_n;
}
