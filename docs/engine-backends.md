# 推理后端选型：A/B/C 调研 + 双栈定案

> 2026-10 的结论性调研 + 迁移记录。**当前决定（用户拍板）：双栈。**
> A（JNI 直连 libllama / GGUF）继续做默认 —— 0.5B 上同进程实测 ~35 tok/s（真机 ~48），
> 是本地最快的一条；LiteRT-LM（.litertlm / .task）作为可选后端保留（NPU 机型 / 多模态 /
> 会话 KV）；C（MediaPipe / .task）PoC 也保留，不再单独维护；B（纯 Java）判死，只留接口位。
>
> 曾计划「只保留 LiteRT-LM 一条栈并删 A/C」，但真机实测 0.6B int8 在 CPU 上只有 12–16 tok/s
> （比 JNI 慢 3–4 倍），GPU 又会让进程 SIGSEGV —— 只留一条栈必然违反「性能不能变差」，
> 所以退回双栈。定案之后的持续优化见文末「六、双栈后的持续优化」。
>
> 后端注册与扩展办法见 [native-engine.md](native-engine.md) 的「加一个进程内后端（留门）」。

## 一、B —— 纯 Java 推理引擎：不成立

**一句话**：Android 的 ART 不提供 Java Vector API（`jdk.incubator.vector`），也没有
Panama FFM（`java.lang.foreign`）；现成的纯 Java LLM 引擎全部把 Vector API 当核心加速手段，
落到 Android 上只剩标量代码。

| 事实 | 来源 |
|---|---|
| Android API 包索引里没有 `jdk.incubator.vector`、没有 `java.lang.foreign`（直接访问对应页面 404，对照组 `java.util.ArrayList` 200） | <https://developer.android.com/reference/packages> |
| 唯一曾可移植的 SIMD 途径 `android.renderscript` 已在 API 31 弃用并明确"未来版本移除"；且它是图像 intrinsic，不是通用 matmul SIMD | <https://developer.android.com/guide/topics/renderscript/migrate> |
| `llama3.java`：Java 21+，matmul 用 Vector API，运行需 `--add-modules jdk.incubator.vector`；`-Dllama.VectorBitSize=0` 可退回标量 | <https://github.com/mukel/llama3.java> |
| `qwen35.java`：Vector API + `java.lang.foreign` mmap | <https://github.com/mukel/qwen35.java> |
| `Jlama`：默认后端 Panama Vector，需 `--add-modules … --enable-preview` | <https://github.com/kgonia/Jlama> |
| 纯标量基线 `llama2.java` 的公开数字（Xeon E5-2686 v4 / 8 线程 / fp32）：Llama2-7B **无向量化 0.96 tok/s、有向量化 1.94 tok/s**；单线程 0.127 vs 0.383 | 同上仓库 README "Performance Evaluation" |

- **未确认**：0.5B–4B「纯 Java、无 SIMD、arm64 真机」的具体 tok/s 没有公开数据；只能定性——
  无 SIMD 的标量 matmul 远慢于 llama.cpp 的 NEON 内核，3B/4B 基本不可用。
- **工作量**：把 `llama3.java`/`qwen35.java` 移植到 Android（MappedByteBuffer 替 FFM、
  剥离 Vector API、适配无 JDK module 的 javac/d8）约 **15–30 人日**，且性能大概率仍不达标。
- **决定**：不投入。只保留 `EngineBackend` 这个接口位。

## 二、C —— 换现成移动端运行时：成立但有条件

**一句话**：LiteRT-LM/MediaPipe 挂现成的 Qwen2.5-0.5B `.task` 最省事；ONNX Runtime GenAI
可控性最好但要约 70MB native 和一条模型转换管线。两条路都**必须放弃现有 GGUF 资产**。

### C1. LiteRT-LM / MediaPipe（推荐先试这条）

| 项 | 事实 |
|---|---|
| 模型格式 | `.task` / `.litertlm` bundle；**不能直接加载 GGUF，也不能直接加载任意 ONNX** |
| 现成权重 | `litert-community/Qwen2.5-0.5B-Instruct` 已有 f32/q8 的 `.task` 与 `.tflite`：<https://huggingface.co/litert-community/Qwen2.5-0.5B-Instruct> |
| 依赖坐标 | MediaPipe：`com.google.mediapipe:tasks-genai:0.10.35`（Java API，arm64 lib 26.63MB）；LiteRT-LM：`com.google.ai.edge.litertlm:litertlm-android:0.18.0`（**Kotlin API**，arm64 `.so` 22.16MB，依赖 gson/kotlin-reflect/coroutines） |
| 官方现状 | MediaPipe LLM Inference 已 maintenance-only，长期应押 LiteRT-LM：<https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference> · <https://developers.google.com/edge/litert-lm/overview> |
| 自转模型 | `litert-torch export_hf` + `litert-lm-builder`，官方明确 **仅 CPU、需一台 ≥64GB 内存的 Linux 机** |
| 工作量 | 集成 + 手工打包（无 Gradle，Kotlin 依赖要自己拉齐）约 **3–6 人日**；要 3B/4B 中文模型需自转，另加 **5–15 人日** |
| 官方基准 | Samsung S24 Ultra、q8（dynamic_int8）、1280 KV、XNNPACK 4 线程：**prefill 250.7 tk/s · decode 30.0 tk/s · TTFT 2.31s · 峰值 RSS 1.36GB**（来源：`litert-community/Qwen2.5-0.5B-Instruct` 模型卡）。注意这是旗舰 SoC 的官方数字，且我们的集成没有 KV 前缀常驻 |

### C2. ONNX Runtime GenAI

| 项 | 事实 |
|---|---|
| 集成方式 | `onnxruntime-android` 的 AAR 就是 zip：`.so` 放进 APK `lib/arm64-v8a/`、`classes.jar` 用 d8 打 dex、合并 Manifest，**无需 Gradle**（AAR 结构：<https://developer.android.com/studio/projects/android-library#aar-contents>） |
| native 体积 | ORT 的 arm64 `libonnxruntime.so` 解压 **34.2MB**；`onnxruntime-genai-android-0.17.0` 再加 `libonnxruntime-genai.so` 6.67MB + `libmat.so` 28.6MB，**只有 arm64/x86_64** |
| 模型 | `onnxruntime-genai` 支持 Qwen/Llama/Gemma/ChatGLM/Phi/Mistral/DeepSeek：<https://mintlify.wiki/microsoft/onnxruntime-genai/concepts/models>；自转：`python -m onnxruntime_genai.models.builder`（支持 GGUF 输入 + int4 量化） |
| 现成权重 | `onnx-community/Qwen2.5-0.5B-Instruct` 等；3B 级多为社区产出 |
| 工作量 | 手工集成约 **2–4 人日** + 模型转换/校验 **3–10 人日**；APK native 净增约 **34MB(ORT) + 37MB(genai)** |

### 与现有生态的冲突（两条 C 路线共有）

现有 GGUF 0.5B/3B/4B 与 JNI 引擎**完全不能复用**，等于维护双模型资产 + 双推理栈；
角色扮演依赖的采样链（重复惩罚/DRY/min-p/XTC/动态温度）、GBNF、模型自带 chat template
都要在新运行时上重写一遍。ORT 路线的 native 体积还比 llama.cpp 大一个数量级
（llama.cpp 通常 1–3MB）。

## 三、最终决定：双栈并存、可切换（2026-10）

1. **本地推理保留两条栈并列**：A（JNI 直连 libllama / GGUF）继续做默认，0.5B 上同进程实测
   ~35 tok/s（真机 ~48），是本地最快的一条；LiteRT-LM
   （`com.google.ai.edge.litertlm:litertlm-android:0.18.0`）作为官方后续保留，
   面向 NPU 机型 / 多模态 / 会话 KV。两条栈在设置页里可切换。
2. **B（纯 Java）不投入**，理由与数据在上面。
3. **C 的旧 PoC（MediaPipe）不再单独维护**：它已经证明了"第三方运行时能在这 App 里跑"，
   现在由 LiteRT-LM 接棒（LiteRT-LM 就是 MediaPipe LLM Inference 的后续）。
4. 设置页读 `appInfo().engineBackends`：A（jni）/ LiteRT-LM / C 并存，默认 `jni`，
   起不来自动兜底子进程 server。

**为什么 LiteRT-LM 比 MediaPipe PoC 值**（拆 0.18.0 的 AAR 实测 API，不是文档抄的）：

| 能力 | MediaPipe `tasks-genai` | LiteRT-LM 0.18 |
|---|---|---|
| 会话/KV | 无，每轮重 prefill | `Conversation` 自带历史；`Session.runPrefill/runDecode` 可做前缀常驻 |
| 采样 | 运行时内部决定 | `SamplerConfig` + `RepetitionPenaltyConfig` + `NoRepeatNgramConfig` + `SuppressTokensConfig` |
| 中断 | 同步接口，停不了 | `cancelProcess()` |
| 统计 | 只有字符数 | `BenchmarkInfo`：TTFT / prefill tok/s / decode tok/s |
| 后端 | CPU(+GPU) | CPU / GPU / NPU / GOOGLE_TENSOR |

**仍不等价、必须承认的缺口**：DRY / min-p / XTC / 动态温度 / GBNF 在 LiteRT-LM 侧没有对应项；
"去人机化"里这些采样项只能靠 prompt 与能映射的惩罚（rep/freq/pres/no-repeat-ngram）补，
不能假装等价。模型格式也换成 `.litertlm`，GGUF 不能复用。

**迁移期的落地物**：

| 文件 | 作用 |
|---|---|
| `tools/fetch-litertlm.sh` | 从国内镜像拉 AAR + gson/kotlin-stdlib/kotlin-reflect/coroutines，解出 `third_party/litertlm/` |
| `tools/fetch-litertlm-model.sh` | 从 ModelScope 拉 `.litertlm`（`--int4`/`--dyn4`/`--4b` 换变体），带 sha256 校验 |
| `optional/litertlm/LitertLmBackend.java` | `EngineBackend` 实现：Engine→Conversation、流式回调、前缀命中续 KV、cancelProcess |
| `tools/litertlm-device.sh` + `tools/litertlm-{load,chat,poll}.js` | 一条链真机冒烟：装包→放模型→CDP 加载/对话 |
| `build.sh` | `third_party/litertlm/` 存在才编 LitertLmBackend、dex 依赖、打 `liblitertlm_jni.so` |

## 四、真机实测：过得了"性能别变差"这关吗（2026-10-14）

机型 Redmi Turbo 3 / 23117RK66C（Snapdragon 8s Gen 3，8 核）。同一段 prompt（约 55 token）、
`maxTokens=160`、`threads=4`：

| 引擎 / 模型 | 加载 | 本轮 decode | 备注 |
|---|---|---|---|
| **LiteRT-LM** Qwen3-0.6B int8（614MB） | 冷 3372ms / 热 648ms | **≈ 12–16 tok/s** | CPU（XNNPACK） |
| **LiteRT-LM** + GPU 委托 | 4847ms（失败后退回） | 15.8 tok/s | 委托失败，见下 |
| **JNI/libllama** Qwen2.5-0.5B q4_k_m（491MB） | — | **≈ 48 tok/s** | 既有实测（`Bridge` 注释 / 上一版） |

**GPU 委托在这台机器 + 这个模型上直接失败**：

```
LitertLmBackend: GPU 后端起不来，回退 CPU
  Failed to modify graph with delegate
```

而且失败还留下 `..._mldrift_weight_cache.bin`（约 596MB）+ 3 秒加载开销。

**换官方带 GPU 图优化的 dynamic-int4 变体再试 —— 这次不是报错，是把进程干掉了**：

```
I FyLitertLm: LiteRT-LM 跑在 GPU 后端
F DEBUG   : signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0
F DEBUG   : Cmdline: com.fy.local  tid: fy-litertlm-loa
F DEBUG   : #00 pc 0000000000d401f0  /vendor/lib64/libllvm-qgl.so   ← 高通 OpenCL 编译器
F DEBUG   : #01 ... #09 全在 libllvm-qgl.so
```

崩在厂商的 OpenCL shader 编译器里（Redmi Turbo 3 / Snapdragon 8s Gen 3 / Adreno）。
Java 的 try/catch 拦不住 native crash，App 会当场死 —— 这比慢严重得多，所以
**GPU 不做默认**，只在确认可用的机型上才考虑开。

NPU 委托也没注册（AAR 不带厂商 NPU 库：`npu_registry: NPU accelerator could not be loaded`）。

**结论（当时）**：现成 0.6B int8 在 CPU 上比 JNI/GGUF 慢 3–4 倍，**不满足"性能变强"**。
所以在数字翻过来之前，A（JNI/GGUF）与 C（MediaPipe）都**不删**。

> ⚠️ 这条结论后来被推翻了：那批 12–16 tok/s 是**思考没关**时量的。见下面的「复测」。

**下一步实验（按性价比排序）**：
1. `qwen3_0_6b_mixed_int4.litertlm`（497MB，已下好）与 `Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm`（344MB）：
   int4 权重在 CPU 上通常比 int8 快 1.5–2 倍。
2. 线程数：XNNPACK 的并行模型与 llama.cpp 不同，4 未必最优。
3. 找 GPU 兼容的模型 —— GPU 是唯一可能反超 llama.cpp 的路；跑通后把
   `new Backend.CPU(...)` 换成 `new Backend.GPU()` 并保留 CPU 回退。
4. 若以上都打不过 48 tok/s：LiteRT-LM 只当"有 NPU 的机型 / 多模态"旁路，默认继续 JNI/GGUF。

### 复测（同日晚些；无头广播入口，Qwen3 带 `/no_think`）

同一台机、同一批模型，`maxTokens=160`，回答里 `<think>\n\n</think>` 是空的（思考确实关了）。
单次结果，手机 CPU 频率会飘：

| 线路 / 模型 | tune | gen | 首字 ms | decode tok/s | 加载 ms |
|---|---|---|---|---|---|
| LiteRT-LM Qwen3-0.6B **int8** | 4 线程 | 63 | 1848 | **42.5** | 728 |
| LiteRT-LM Qwen3-0.6B **int8** | 6 线程 | 63 | 1247 | **45.2** | 288 |
| LiteRT-LM Qwen3-0.6B **dynamic-int4** | 4 线程 | 96 | 2510 | 25.4 | 1360 |
| LiteRT-LM Qwen3-0.6B **dynamic-int4** | 6 线程 | 96 | 2006 | 24.7 | 1038 |
| LiteRT-LM `mixed_int4` | — | — | — | **聊天报错**（不兼容） | 2127 |
| MediaPipe Qwen2.5-0.5B `.task` | 默认 | 34 | 617 | **52.1** | 557 |
| MediaPipe Qwen2.5-0.5B `.task` | `mp_session=1` | 49 | **311** | 51.4 | 226 |
| JNI Qwen2.5-0.5B GGUF | 默认 | 9 | 424 | —（输出太短） | 1241 |
| JNI Qwen2.5-0.5B GGUF | `lookup=3` | 9 | 439 | — | 495 |

**新结论**：
- **int8 关掉思考后 ≈ 42–45 tok/s**，和 JNI 同一档，「慢 3–4 倍」不成立；int4 反而更慢（25），
  `mixed_int4` 仍然不兼容。
- `mp_session=1` 把 MediaPipe 的**首字时间 617 → 311 ms**（跨轮 KV 复用真的生效）。
- JNI 那两行只生成了 9 个 token，decode 没量到；要更长输出才能比。
- 所以 LiteRT-LM 已从「旁路」变成「和 JNI 同一档的正式备选」，A/C 继续保留。

### Gemma 4 E2B 的 MTP 投机解码：CPU 上是净亏

`gemma-4-E2B-it.litertlm`（2.4GB）是官方少数带 `TF_LITE_MTP_DRAFTER` 的 bundle（能力探测 `spec=true`）。
同一段 prompt、`maxTokens=48`、4 线程：

| tune | gen | 首字 ms | decode tok/s | 加载 ms |
|---|---|---|---|---|
| `spec=auto`（MTP 开） | 100 | 1687 | **24.5** | 5810 |
| `spec=off`（MTP 关） | 99 | 1041 | **39.8** | 2415 |

**开 MTP 反而慢约 40%** —— 官方「最高 3×」是 GPU 数字，CPU 上 drafter 的验证开销盖过收益。
所以 `conversationPlan` 的 auto 改成**只在 GPU 上自动开**；CPU 上要开得显式 `spec=1`（会慢，但用户自选）。
能力探测同时显示 Gemma 4 的 `backends=[CPU, GPU]`、`thinking=false`。

修好后又复测了一遍（关键：`enableSpeculativeDecoding` 传 `null` 是**继承引擎默认**，Gemma 上默认就是开——
所以 CPU auto 必须显式传 `FALSE`）：默认 **40.5** vs `spec=off` **44.3** tok/s（同档，差异是噪声）；
显式 `spec=1` 仍会开（≈24.5），由用户自选。这版 `conversationPlan` 的三态（null/TRUE/FALSE）有 JVM 测试盯着。

**实测踩到并修掉的坑**：
- `EngineConfig` 的 vision/audio 槽位不能塞 CPU 后端：纯文本模型会在 `createConversation` 报
  `NOT_FOUND: tf_lite_audio_encoder_hw not found`，必须传 null。
- `Conversation.getTokenCount()` 是**会话总量**（prompt + 历史 + 本轮生成），不是本轮生成量；
  `BenchmarkInfo` 在 `sendMessageAsync` 这条路上全给 0/-1，TTFT / decode 只能自己量。
- `maxTokens` 必须走带 `maxOutputToken` 的重载才生效（已验证：32→总量 87、160→总量 215）。
- `cancelProcess()` 不保证回调回来：不设看门狗时 `nativeBusy` 会永久卡住，之后所有聊天都报
  "上一轮还在生成"，只能重启 App。

## 五、C 路线 PoC 的工程落地

已经接好并在默认构建之外验证过的部分：

| 文件 | 作用 |
|---|---|
| `tools/fetch-mediapipe.sh` | 从国内镜像（Aliyun / 腾讯）拉 MediaPipe `tasks-genai:0.10.35` AAR + guava-android + failureaccess + protobuf-javalite，解出 `third_party/mediapipe/{classes.jar,*.jar,libllm_inference_engine_jni.so}`。gitignore 掉，不入库 |
| `optional/mediapipe/MediaPipeBackend.java` | `EngineBackend` 实现：`LlmInference.createFromOptions` 加载 `.task`，`generateResponse` 生成；token 复用主 Activity 的 gen 事件通道 |
| `build.sh` | 只有 `third_party/mediapipe/` 存在时，才把它编进 javac、把 jar 一起 dex、把 arm64 `.so` 打进 APK |
| `MainActivity` | 反射注册（`Class.forName("com.fy.local.MediaPipeBackend")`）：默认构建没有这个类也不会炸 |
| `ModelStore` | `list()/importFromUri()` 现在也认 `.task`（以前只认 `.gguf`，会把 .task 改名成 .gguf） |

**跑 PoC 的步骤**（需要真机，adb 无线调试或手动装均可）：

```bash
./tools/fetch-mediapipe.sh          # 约 31MB
./build.sh --debug                  # APK 从 13.8MB 涨到 ~25MB
```

1. 下模型（约 **547MB**）：`./tools/fetch-litert-model.sh ~/storage/downloads`
   —— 走 **ModelScope 镜像**（HuggingFace 国内这条线实测被限到 ~9KB/s，ModelScope 1.5MB/s），
   下完自动按官方 sha256 校验（`e608953f…0452fd2`）；
2. 装新 APK → App「设置 → 导入模型」选这个 `.task`；
3. 「推理方式」切到 **MediaPipe / LiteRT（.task）** → 启动引擎 → 聊天；
4. 看引擎状态栏里的加载耗时，和生成速度。

**真机实测（Redmi Turbo 3 / 23117RK66C，MediaPipe tasks-genai 0.10.35）**：

| 项 | 实测 |
|---|---|
| 加载 `.task`（冷，第一次） | **1725 ms** |
| 加载 `.task`（页缓存已热） | **367 ms** |
| 生成 315 字 | **4.02 s ≈ 78 字/秒** |
| 生成 406 字 | **4.95 s ≈ 82 字/秒** |

> `gen` 是后端按字符数估的（MediaPipe 不暴露真实 token 计数），不是 token/s；按 Qwen 中文
> ≈1 token/1–1.5 字折算大约 **50–80 tok/s**，与模型卡给的 S24 Ultra `decode 30 tok/s` 同量级。
> 注意这是**短上下文**的数字：因为下面第一条限制，历史一长每轮都要重新 prefill，会明显变慢。

**PoC 已知限制**（这就是它为什么不做默认）：

- 只支持"一问一答"：把 messages 拍成一段纯文本喂 `generateResponse`，
  **没有 KV 前缀常驻**，长对话每轮都要重新 prefill，等于放弃了 v1.7 最大的那个优化；
- 采样参数（重复惩罚 / DRY / min-p / XTC / GBNF）由 MediaPipe 内部决定，前端那套用不上；
- 当前实现用同步 `generateResponse`，**中断不了**一轮生成（异步 API 有 ProgressListener，但还没接）；
- GGUF 与 `.task` 是两套模型资产，APK 也多 26.6MB native。

## 六、双栈后的持续优化（2026-10 下半场）

### 5.1 LiteRT-LM：让模型自己决定用什么算法

不再靠模型名猜，改用 LiteRT-LM 自带的 `ModelInfo`（拆 AAR + javap 得到的确切 API）：

| 探测项 | 用途 |
|---|---|
| `ModelInfo.Llm.supportsThinking()` | true 时给 ConversationConfig 传 `ThinkingConfig(false)`，原生关思考 |
| `ModelInfo.Llm.hasSpeculativeDecodingSupport()` | true 时才传 `enableSpeculativeDecoding=TRUE` |
| `ModelInfo.supportedBackends(TEXT)` / `npuBrand` / `socName` / `maxContextTokens()` | 记日志、决定能不能开 GPU/NPU |

**关思考的坑**：`ThinkingConfig(false)` 只有在 bundle 的 `LlmMetadata` 声明了 thought channel
时才生效；Qwen3-0.6B.litertlm / mixed-int4 都属于“没声明 channel”的文件，此时它是静默 no-op
（思考会混进正文）。所以代码同时用 `extraContext{"enable_thinking": false}` 直接喂给模型自带的
Jinja 模板（官方 Android 指南的机制）；并且 `ConversationConfig.channels` 传 `null`（用默认），
**不能传空列表** —— 文档写明 "If empty, channels will be disabled"。

**投机解码（MTP）的真实门槛**（据官方 CLI 文档 + native 符号）：bundle 里必须有
`TF_LITE_MTP_DRAFTER` 段；官方只有 **Gemma 4 E2B/E4B** 的 `.litertlm` 带，
Qwen3-0.6B / Qwen2.5-0.5B 都只有 `tf_lite_prefill_decode`，开了会直接报错。
所以代码只在 `hasSpeculativeDecodingSupport()` 为真时打开 —— Qwen 上等于不生效，
换 Gemma 4 才自动启用。

**`.task` 不能喂给 LiteRT-LM**：`.litertlm` 头是 magic `LITERTLM`，`.task` 是 PK zip
（MediaPipe 容器），loader 直接报 "Invalid magic number. Expected 'LITERTLM'"。
所以 LiteRT-LM 只能比 Qwen3-0.6B 的 int8 / mixed-int4 / dynamic-int4 这几个 `.litertlm` 变体，
Qwen2.5-0.5B 那条 `.task` 走 MediaPipe 线路。
LiteRT-LM 侧的 `tune` 认 `thinking` / `spec` / `backend=gpu|npu` / `act=f32|f16|int8|int16`。

**GPU/NPU**：native 库里就有高通的告警串
"Adreno 8xx with compiler E031.47.12.xxx is not well supported in MLDrift OpenCL backend…"，
和真机 SIGSEGV 一致。所以 GPU 默认关，只有 tune 显式 `backend=gpu` 才开（并保留 CPU 回退）。

### 5.2 JNI：加载调参实测无增益

KV 量化 / Flash Attention / 物理批大小在这颗 CPU 上都不提速，`q8_0` KV 反而慢 ~5%；
详见 [native-engine.md](native-engine.md) 的「加载调参」。默认一个都不开。
顺带修了一个边界 bug：整段 prompt 命中 KV 时 stale logits 导致 `gen=0`。

### 5.3 MediaPipe：从同步 PoC 升级为可流式 / 可中断

- 默认走 `generateResponseAsync(prompt, ProgressListener)`：真流式、可取消；
  token 数改用 `sizeInTokens`（不再按字符估）。
- `tune=mp_session=1` 时启用显式 `LlmInferenceSession`，跨轮保留 KV，只喂新增的用户消息
  （默认关：会话语义没在真机验过；任何异常自动退回一次性 prompt）。
- 中断：`cancelGenerateResponseAsync()` + future.cancel + 5 秒看门狗，避免 nativeBusy 卡死。

### 5.4 ONNX Runtime GenAI（被放弃的 C2）再评估：仍不划算

`onnxruntime-genai-android-0.17.0.aar` 的 arm64 三个 `.so` 解压合计 **~35.6 MiB**，
且**不含** `libonnxruntime.so` —— 还要再从 onnxruntime-android 拿一份（~34MB）。
合计 ~70MB native、双模型资产、采样链重写，收益不明确，继续不投入。
