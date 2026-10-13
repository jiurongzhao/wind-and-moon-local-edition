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

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long) ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
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
                                          jint nCtx, jint nThreads, jint nBatch, jboolean mlock) {
    if (g_ctx) return -1;

    const char *path = (*env)->GetStringUTFChars(env, jpath, NULL);
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
    if (!g_model) return -1;
    g_vocab = llama_model_get_vocab(g_model);

    struct llama_context_params cp = llama_context_default_params();
    cp.n_ctx           = (uint32_t) nCtx;
    cp.n_batch         = (uint32_t) (nBatch > 0 ? nBatch : 512);
    cp.n_ubatch        = cp.n_batch;
    cp.n_threads       = nThreads;
    cp.n_threads_batch = nThreads;
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
static jstring generate_text(JNIEnv *env, const char *text, int maxTokens, float temp,
                             int topK, float topP, int seed, int pinTokens) {
    if (!g_ctx) return (*env)->NewStringUTF(env, "{\"error\":\"engine not loaded\"}");

    /* 在这一轮最开始就把停止标志清掉（而不是预填充之后）。
       否则长上下文预填充期间点"停止"会被这次清零吃掉 —— 几百 token 的 prefill 要等好几秒，
       用户点了停止却停不下来，体感就是"按了没反应"。 */
    g_stop = 0;

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

    if (common < g_cache_n) {
        llama_memory_seq_rm(g_mem, 0, common, -1);
        g_cache_n = common;
    }

    /* ---- 2. context-shift：放不下就从"前缀之后"丢最老的一段 ---- */
    int pin = pinTokens > 0 ? pinTokens : 0;
    if (pin > g_cache_n) pin = g_cache_n;
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

    /* ---- 3. decode 增量 ---- */
    int batch = 512;
    long first_ms = -1;
    for (int i = common; i < n_tok; i += batch) {
        if (g_stop) break;                          /* 预填充期间也要能停 */
        int m = (n_tok - i) < batch ? (n_tok - i) : batch;
        if (!ensure_cache_cap(g_cache_n + m)) break;
        struct llama_batch b = llama_batch_get_one(toks + i, m);
        if (llama_decode(g_ctx, b) != 0) { free(toks); return (*env)->NewStringUTF(env, "{\"error\":\"prefill decode failed\"}"); }
        memcpy(g_cache + g_cache_n, toks + i, sizeof(llama_token) * (size_t) m);
        g_cache_n += m;
    }
    long prefill_ms = now_ms() - t0;
    free(toks);
    /* 喂进去的 prompt 总长（= prefill 结束时的 KV 长度）。前端拿它校正 token 估算。 */
    int prompt_tokens = g_cache_n;

    /* ---- 4. 采样 + 流式回调 ---- */
    struct llama_sampler *smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    if (temp <= 0.0f) {
        llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
    } else {
        if (topK > 0) llama_sampler_chain_add(smpl, llama_sampler_init_top_k(topK));
        if (topP < 1.0f) llama_sampler_chain_add(smpl, llama_sampler_init_top_p(topP, 1));
        llama_sampler_chain_add(smpl, llama_sampler_init_temp(temp));
        llama_sampler_chain_add(smpl, llama_sampler_init_dist((uint32_t) (seed > 0 ? seed : 1234)));
    }

    int gen = 0;
    char out[8192];
    int olen = 0;
    for (int i = 0; i < maxTokens && !g_stop; i++) {
        llama_token id = llama_sampler_sample(smpl, g_ctx, -1);
        if (llama_vocab_is_eog(g_vocab, id)) break;
        llama_sampler_accept(smpl, id);

        char piece[256];
        int np = llama_token_to_piece(g_vocab, id, piece, (int) sizeof(piece), 0, true);
        if (np > 0) {
            piece[np] = 0;
            if (first_ms < 0) first_ms = now_ms() - t0;
            if (olen + np < (int) sizeof(out) - 1) { memcpy(out + olen, piece, (size_t) np); olen += np; }
            emit_piece(piece);
        }
        if (!ensure_cache_cap(g_cache_n + 1)) break;
        g_cache[g_cache_n++] = id;
        struct llama_batch b = llama_batch_get_one(&id, 1);
        if (llama_decode(g_ctx, b) != 0) break;
        gen++;
    }
    out[olen] = 0;
    long total_ms = now_ms() - t0;
    llama_sampler_free(smpl);

    /* 统计信息给 Java 侧用（Java 只管把 token 推给前端，不解析这段 JSON 也行） */
    char res[160];
    snprintf(res, sizeof(res),
             "{\"gen\":%d,\"reused\":%d,\"prompt\":%d,\"cache\":%d,"
             "\"prefillMs\":%ld,\"firstMs\":%ld,\"totalMs\":%ld}",
             gen, reused, prompt_tokens, g_cache_n, prefill_ms, first_ms, total_ms);
    return (*env)->NewStringUTF(env, res);
}

JNIEXPORT jstring JNICALL
Java_com_fy_local_NativeEngine_nativeGenerate(JNIEnv *env, jclass cls, jstring jprompt,
                                              jint maxTokens, jfloat temp, jint topK, jfloat topP,
                                              jint seed, jint prefixTokens) {
    const char *text = (*env)->GetStringUTFChars(env, jprompt, NULL);
    if (!text) return (*env)->NewStringUTF(env, "{\"error\":\"bad prompt\"}");
    jstring r = generate_text(env, text, maxTokens, temp, topK, topP, seed, prefixTokens);
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
JNIEXPORT jstring JNICALL
Java_com_fy_local_NativeEngine_nativeChat(JNIEnv *env, jclass cls, jobjectArray jmsgs,
                                          jint pinMessages, jint maxTokens, jfloat temp,
                                          jint topK, jfloat topP, jint seed) {
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
    jstring out = generate_text(env, buf, maxTokens, temp, topK, topP, seed, pin);
    free(buf);
    return out;
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
