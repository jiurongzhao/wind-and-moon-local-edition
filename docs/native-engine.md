# 进程内引擎：JNI 直连 libllama

> v1.7 起，本地推理默认不再 fork `llama-server`，而是把 `libllama.so` 直接链进 App 进程。
> 子进程那条路保留着（`engineMode: "server"`，以及进程内起不来时的自动回退）。

## 为什么不继续用 llama-server

子进程 + localhost HTTP 这套本来是"能跑就行"的最省事解，但它有三个绕不开的成本：

1. **前缀缓存是不是命中，全靠求服务端**。llama-server 有自己的 slot / prompt cache 策略，
   我们只能把 prompt 拼好递过去，然后祈祷它命中。而"人设 + 世界书 + 示例对话"这段静态前缀
   是每轮都要复用的 —— 这正是本地角色扮演最该优化的地方，不该交给别人猜。
2. **多一层进程和端口的运维**。要管端口占用、管孤儿进程（README 坑 #11：留一个占 3.5GB 的
   残留，4B 加载会从 19s 变成 140s）、管 `linker64` 回退、管 `/health` 轮询。
3. **多一次拷贝和一轮唤醒**。token 从 C 到 socket 到 WebView，再回显。

把引擎放进本进程之后，KV 缓存归我们自己管，"静态前缀常驻"就成了**可以保证**的事。

## 分工：谁负责什么

| 层 | 负责 |
|---|---|
| 前端（`app.js`） | 聊什么：会话、角色卡、世界书、记忆、剧情开关 —— 组成 `messages` 数组 |
| `Bridge.java` | 把 `messages` 拍平成 `[role, content, …]` 传进 JNI；把原生 token 合批成 `gen` 事件 |
| `jni/fy_engine.c` | 套**模型自带**的对话模板、tokenize、前缀比对、KV 复用、context-shift、采样、流式回调 |
| `NativeEngine.java` | 门面：`load / setPrefix / chat / stop / unload` |

关键点：**中文模板文案一行都不在 C 里**。改提示词、改角色卡不用重编 `.so`；
换模型也不改 Java —— 模板跟着 GGUF 走（`llama_chat_apply_template(NULL, …)`，
和 llama-server 用的是同一套内置模板）。

## 静态前缀是怎么"钉住"的

一轮 `FY.chat(messages, {pinMessages: 1})` 里发生的事：

1. 取前 `pinMessages` 条 message（一般是 1 条 `system`），按 `add_assistant=false` 单独套一遍模板
   → 得到前缀文本 → 数出它有多少 token，记为 `pin`。
2. 全部 messages 套模板（`add_assistant=true`）→ 完整 prompt。
3. **最长公共前缀比对**：拿完整 prompt 的 token 序列和 KV 里存着的序列比，
   只对"新增的那几 token"做 `llama_decode` —— 这就是 `reused`。
4. 长度不够时做 **context-shift**：只从 `[pin, …)` 这段（前缀**之后**）丢最老的一半，
   剩下的位置整体前移；前缀那段永远不动。

第 2 轮实测（`NativeEngineJvmTest`，0.5B）：

```
【4.5】chat 第 1 轮      reused=5   cache=51   gen=24
【4.6】chat 第 2 轮      reused=51  ← 第 1 轮结束时的 cache，一个 token 都没白算
```

换角色 = 换 system = 前缀变了 = 旧的 KV 自然失效，不需要任何"清缓存"的特殊逻辑。

一个边界修复：如果整段 prompt **已经**在 KV 里（用户点"重新生成"、或同一段 prompt 连跑两次），
旧实现这一轮一个 token 都不 decode，采样器就会用**上一轮最后一个 token 的 logits** —— 而那个
位置已经被裁掉了，结果通常是立刻吐 EOG（`gen=0`、`firstMs=-1`）。现在检测到 `common == n_tok`
就把最后一个 prompt token 重新 decode 一遍，换回正确 logits。

## 滑窗口：裁消息不重算

前端按 `historyLimit` 滑窗口，每轮从最前面丢 1~2 条消息。旧实现下"最长公共前缀"会一路
塌回系统前缀，后面每条消息全部重算 prefill —— 真机实测长对话第 11 轮起每轮 25 s。

其实被丢掉的只是最前面一段**连续区间**，后面的历史 KV 原封不动就能用。所以在最长公共
前缀之后多了一步**动态段对齐**：

1. 在旧 token 序列里找"新动态段"的起点 `o`（找**最长匹配**的一段后缀，至少 ≥16 token）——
   用 **Z-algorithm** 一次求出所有起点的最长公共扩展（LCE），O(n+m)；朴素"每个起点各比一遍"
   在重复文本上最坏是 O(n·m)（内核实测 4096 token 全是同一 token 时 6.5ms → 0.08ms，结果逐位一致）；
   注意不是要求整个尾巴逐 token 相等——前端落盘前会加工回复（剥思考段/抽选项/截回吐的提示词），
   要求整段相等时这点差异会让对齐失败、退回整段重算（真机偶发一轮 38 s）；
2. `llama_memory_seq_rm(pin, o)` 删掉被裁掉的那段，`llama_memory_seq_add(o, -1, -(o-pin))`
   把剩下的历史整体前移（RoPE 由 `seq_add` 负责，和 context-shift 同一个原语）；
3. 公共前缀直接变成整段保留的历史 —— 一个 token 都不用重算。

真机 40 轮对比（3B / ctx 4096 / historyLimit 20）：

| | 修复前 | 修复后 |
|---|---|---|
| 第 11 轮 reused | 380（塌回前缀） | 1034 |
| 第 11–16 轮耗时 | 25.0 / 24.7 s | 2.8 – 6.1 s |

## 预填充进度心跳

长 prompt 的第一次 `llama_decode` 可能要几十秒，这期间**一个 token 回调都没有**，
前端 60 秒的「冻结看门狗」会把这一轮误判成卡死并 abort —— 真机上就是首轮空回复。
现在预填充按 128 token 一块分块解码，每块通过 `onProgress(done, total)` 报一次进度，
前端收到就给看门狗续命；块小还顺带把 llama.cpp 第一次 decode 的计算图从 512 降到 128。

## 记忆更新不再撕碎前缀

旧实现把摘要拼进 `system`，摘要一变 = 钉住的前缀变了 = 整段 KV 全失效（实测每次摘要更新
之后那一轮要 30–50 s）。现在改成 **append-only 记忆消息**：压缩完成后往会话历史尾部追加
一条带 `mem` 标记的 system 消息，`system` 本身保持静态。于是"记忆更新 = 历史延长"，
上一轮的 messages 永远是这一轮的真前缀，KV 整段复用；旧摘要消息滑出窗口就自然出局。
升级兼容：历史里还没出现 `mem` 消息时，旧记忆记录会作为一条临时 system 消息兜底。

还有一处更隐蔽的：**压缩那次生成本身会把聊天 KV 换掉**（它的 prompt 跟聊天毫无关系），
所以下一轮聊天仍然要重算整段历史（真机实测 +30 s）。现在压缩/工具调用走 `chatAux`：
原生侧在辅助生成前后用 `llama_state_seq_get_data/set_data` 把 seq 0 的状态存下再恢复，
聊天的 KV 原样保留。JVM 用例【4.10】验证：辅助生成跑完后，聊天下一轮 `reused` 仍等于
辅助调用之前的 cache。代价是一次约 KV 大小的内存拷贝，远小于整段 prefill。

## 采样算法与语法约束

采样链按 llama.cpp 惯例串起来，全部可配（前端「采样参数」页）：

| 算法 | 作用 | 默认 |
|---|---|---|
| `penalties`（重复/频率/存在惩罚） | 压小模型的复读 | 重复 1.1 |
| `dry`（DRY） | 按重复片段长度加权惩罚，比裸重复惩罚更不伤表达 | 0.8 |
| `min_p` | 只保留累计概率之上的候选 | 0.05 |
| `top_n_sigma` | 按 logit 的 σ 截断 | 关 |
| `xtc` | 按概率剔除"最平庸"的候选，增加用词变化 | 关 |
| `temp_ext`（动态温度） | 熵越高越降温，长句不崩 | 关 |
| `grammar`（GBNF） | 选项模式保证 `<<<OPTIONS … OPTIONS>>>` 合法 | 关（可开） |

前端把参数压成 `k=v;k=v` 一行交给 Java（`Bridge.buildSamplerCfg`），C 侧 `strtof` 解析，
不引 JSON 库。GBNF 用**懒语法**（`llama_sampler_init_grammar_lazy_patterns`）：正文里出现
`<<<` 之前完全不受约束，之后才按语法走 —— 小模型写不出格式也不会被卡死。

## 加载调参：KV 量化 / Flash Attention / 物理批（实测结论）

`EngineBackend.start(..., tune, ...)` 多了一个可选调参串（`"k=v;k=v"`，不传 = 完全保持老行为），
JNI 这条路认这些键，最终落到 `llama_context_params`：

| 键 | 值 | 落到哪 |
|---|---|---|
| `type_k` / `type_v` | `f16`（默认）/ `f32` / `q8_0` / `q4_0` / `q5_0` / `q5_1` | `cp.type_k/type_v`；量化时会自动打开 Flash Attention |
| `flash_attn` | `-1` auto / `0` 关 / `1` 开 | `cp.flash_attn_type` |
| `ubatch` | 正整数 | `cp.n_ubatch`（预填充物理批大小） |
| `chunk` | 正整数（默认 128） | 预填充逻辑块大小：一次 `llama_decode` 喂多少 token |
| `kv_unified` / `swa_full` | `0/1` | 同名布尔位 |

**结论（Redmi Turbo 3 / 同进程同 libllama，0.5B Q4_K_M，4 线程，Termux 实测）：
这些开关都不提速，所以默认一个都不开、`chunk` 保持 128。**

手机 CPU 频率会飘，单次数字能差 ±20%，所以下表是**每档 4 轮的中位数**（冷前缀约 426 token）：

| tune | 冷预填充 ms | decode tok/s |
|---|---|---|
| 默认（f16 KV，chunk=128） | 5131 | 21.7 |
| `chunk=64` | 5342 | 23.4 |
| `chunk=256` | 4604 | 22.5 |
| `type_k=q8_0;type_v=q8_0` | 5238 | 21.5 |
| `flash_attn=1`（f16 KV） | 4946 | 20.8 |

差异都在噪声量级，没有值得改默认的赢家。线程数则有明确结论：
短上下文实测 4 / 6 / 8 线程 = **35.8 / 28.2 / 17.7** tok/s，越多越被小核同步点拖累
（和 Bridge 里注释的结论一致）。

比所有开关都更重要的是**上下文长度**：同一份配置下，~60 token 上下文 decode ≈ 35.8 tok/s，
涨到 ~426 token 就掉到 ≈ 21.7 —— 这是 attention 的 O(n)，不是 KV 类型能救的。
所以角色扮演真正该优化的是**控制上下文**（`historyLimit` / context-shift），而不是调 KV 类型。
复现：`tests/NativeEngineBench.java`（`NativeEngineBench <模型> 4096 4 128 "tuneA|tuneB" 16 4`，末两参是前缀段数与轮数）。

GBNF 语法约束会显著拖慢采样（同一配置 35.8 → 14.6 tok/s），所以它只该用在
"必须合法格式"的功能（抽选项 / 工具调用），别常开。

## n-gram / prompt-lookup 自投机（默认关）

llama.cpp 的公开 C API 不暴露投机解码（只有 `common/`、`examples/lookup` 自己实现），所以引擎里
手写了一个「看历史猜下一段、一次 batch decode 验证」的版本（`jni/fy_engine.c` 的 `spec_step`）：

- 取 KV 末尾 `lookup` 个 token 当模式，往前找最近一次相同模式，把它后面一段当草稿（最多 `draft` 个）；
- 先用当前 logits 采样第一个 token：和草稿[0] 不符就照常单步；相符就把整段草稿一次 batch decode；
- 逐位采样验证，一致就接受、不一致就停；被拒的草稿 token 从 KV 删掉。
- **分布不变**：每个真正吐出去的 token 都是「当时正确上下文」下从目标分布采样出来的。
- **自适应**：累计提了 ≥20 个草稿、命中率 <40% 就自动关掉本次生成，普通散文上不会一直白算。

tune：`lookup=N`（N = 模式长度，0 = 关，建议 2–3）、`draft=K`（草稿上限，默认 8）。

同机实测（0.5B Q4_K_M，贪心，Termux；CPU 频率会飘，看倍数别看绝对值）：

| 场景 | lookup=0 | lookup=2 | lookup=3 |
|---|---|---|---|
| 逐字复制一段长文本（草稿 74 / 命中 74） | 29.4 tok/s | **61.7（2.1×）** | 54.5（1.85×） |
| 普通生成 | 噪声内 | 噪声内 | 噪声内 |

结论：**它是「复制 / 摘录 / 结构化输出」这类任务的加速器（卡片文本、摘要、抽取），不是通用加速；
所以默认关**。要开就在设置页「引擎调参」填 `lookup=2`。输出与不开时一致（37 项 JVM 回归全绿）。

## 模板在哪一层套（以及为什么不是 Java）

`llama_chat_apply_template` 需要模型对象才能拿到 GGUF 里那份模板，所以只能在 C 侧套。
好处是自动跟随模型：Qwen 是 ChatML，别的模型是别的格式，Java 与前端都不用知道。

已知取舍：这条 C API **不支持 jinja 的额外 kwargs**，所以 `chat_template_kwargs:{enable_thinking:false}`
在进程内这条路上发不过去（llama-server 那条路可以）。替代方案见下面的「开关与取舍」。

## 流式：为什么要在 Java 侧再合批一次

C 侧每出一个 token 就 JNI 回调一次。如果每次回调都 `evaluateJavascript`，
加载和生成时会把 WebView 拖卡（引擎日志踩过同一个坑）。
所以 `MainActivity` 按「攒够 24 字 **或** 距上次推送 60ms」合批，一次推一个 `gen` 事件：

```js
{ id, state: 'delta', delta: '…' }
{ id, state: 'done',  stats: { gen, reused, prompt, cache, prefillMs, firstMs, totalMs } }
{ id, state: 'error', message: '…' }
```

同一时刻只允许一轮生成（`nativeBusy` 锁 + 前端 `nativeQueue` 串行队列）：
`llama_context` 不是可重入的，并发进去就是崩。

## 回退路径

`engineStart` 先试进程内；失败（缺库、ABI 不符、内存不够）就推一条 `loading`
说明原因，然后照旧走 `Engine.java` 的 `llama-server` 子进程。前端不用分叉：
`engineStatus().native` 是 `true` 就走 `FY.chat()`，否则走 HTTP，两条路都收口在
`streamChat()` / `postJson()` 里。

## 开关与取舍

设置页 →「推理方式」：

| 选项 | 什么时候用 |
|---|---|
| 进程内（默认） | 平时都用这个：没有端口、没有子进程，人设常驻 KV |
| 子进程 llama-server | 排查问题、或某些机型上进程内跑不动时的退路（界面不变，只是换了推理通道） |

> 这个开关**下次启动引擎时生效**，不会中途换引擎。

已知取舍：

- `llama_chat_apply_template` **不支持 jinja 的额外 kwargs**，所以
  `chat_template_kwargs:{enable_thinking:false}` 在进程内这条路上发不过去。
  替代方案是 Qwen3 自己认的软开关：前端在 `applyNoThink()` 里给 system 补一句 `/no_think`
  （只在模型是 Qwen3、且 system 里还没有时才补；不改原消息数组，前缀复用不受影响）。
  效果比硬开关弱一点，但比"什么都不做"好得多 —— 创作者工具和记忆压缩在 Qwen3 上不会再白吐一大段思考。
- 同一时刻只允许一轮生成（`llama_context` 不可重入）：前端把原生请求排成一条队列，
  原生侧还有一把 `nativeBusy` 锁兜底。

### 语义陷阱：available() 是「这条路在不在」，不是「模型加载了没」

`EngineBackend.available()` 原来在 JNI 上返回 `NativeEngine.isLoaded()`（模型加载标志），进程刚起来恒为 false，
于是 `Bridge.engineStart` 会**悄悄回退子进程 llama-server** —— 「进程内 JNI 是默认」在真机 UI 上从来没真正发生过。
现在 `available()` 问的是 `NativeEngine.soLoaded()`（.so 加载成功即 true）；模型状态仍由 `state()/active()` 表达。
真机验证：注册表从 `jni:unavailable` 变成 `jni:stopped`。

### 调试用无头测试入口（不抢用户屏幕）

WebView CDP 只在 Activity 前台时才有 target，`am` 广播又会被 HyperOS 的 **Greezer** 直接拒发（`dumpsys activity broadcasts`
里能看到 `SKIPPED ... reason: Greezer Denial`）。所以 debug 构建做了三件事：启动就注册一个导出广播接收器、
启动就把 `FyService` 立成前台服务（进程不再被冻）、把结果写到 `files/devtest/result.json`。
驱动脚本：`tools/devtest.sh`（`status` / `load <id> <model> [tune] [threads]` / `chat <id> [maxTokens] < messages.json`）、
`tools/devtest-bench.sh`（一把跑三条线路）。注意无头通道绕过前端 `applyNoThink`，Qwen3 要自己带 `/no_think`。

## 加一个进程内后端（"留门"）

推理后端统一收在 `EngineBackend` 这个契约上（`app/java/com/fy/local/EngineBackend.java`），
`EngineRegistry` 是注册表，`JniEngineBackend` 是现有的那个（JNI 直连 libllama）。
子进程 `Engine`（llama-server + HTTP）**不在注册表里**：它聊天走 HTTP，前端用 `native=false` 分辨；
云端 / 局域网 OpenAI 兼容也不在：那条路前端直接发 `/api`，连 Java 都不过。

加 B（纯 Java）/ C（ONNX / MediaPipe）时只要三步，**Bridge 的调度和前端的分叉都不用动**：

1. 写一个类实现 `EngineBackend`（状态取值保持 `stopped/loading/ready/error`）；
2. 在 `MainActivity.onCreate` 里 `registry.register(new XxxBackend(this))`；
3. 设置页「推理方式」自动多一项 —— 下拉框读的是 `appInfo().engineBackends`，前端一行不用改。
   `available()` 返回 false 的后端显示成「（不可用）」并禁用，启动时兜底走子进程。

约定：同一时刻只有一个进程内后端在跑（`start` 前调用方先停旧的）；`start()` 起不来通过
`onStartFailed` 回调，由 Bridge 决定是否回退到 llama-server。

B（纯 Java）与 C（ONNX / LiteRT）的**选型结论与数据**见 [engine-backends.md](engine-backends.md)。
两条都还没接入，但都在设置页留了位：`PlaceholderBackend` 的 `available()` 恒为 false，
下拉框里显示「（不可用）」并禁用，用户能看见路存在、点不动，启动时自动兜底子进程。

## 怎么验证

```bash
./jni/build.sh                     # Termux clang 编 native/libfy_engine.so
LD_LIBRARY_PATH=native GGML_BACKEND_PATH=native \
  java -Djava.library.path=native -cp build/jvmtest NativeEngineJvmTest
# 速度对比（同进程同 libllama，换 tune 横向比）：
#   javac -d build/jvmtest app/java/com/fy/local/NativeEngine.java tests/NativeEngineBench.java
#   LD_LIBRARY_PATH=native GGML_BACKEND_PATH=native java -cp build/jvmtest NativeEngineBench \
#     models/qwen2.5-0.5b-instruct-q4_k_m.gguf 2048 4 128 "type_k=q8_0;type_v=q8_0|flash_attn=1"
# → 37 项：加载 / 前缀常驻 / 复用 / 换人设失效 / 模板 / 小 ctx 溢出 / 中途停止 / 卸载
#          + 滑窗口对齐（裁掉最老一段后保留的历史仍复用；上一条回复被裁尾也能对齐）
#          + 采样算法全家桶（penalties/DRY/min-p/XTC/动态温度一次全开不崩）
#          + GBNF 语法约束（输出被限制成纯数字）
#          + 预填充进度心跳
#          + 辅助生成（记忆压缩）不破坏聊天 KV
```

`./runtests.sh` 的 3.7 步就是它（缺模型或缺 `.so` 时跳过）。
前端那条链路由 jsdom 用例【39】／【40】／【41】盯着：假装"进程内引擎就绪"，
验证走的是 `FY.chat` 而不是 `fetch`、推理方式开关能落盘、Qwen3 关思考会补 `/no_think`。

## 实测数据

| 项 | 0.5B Q4_K_M |
|---|---|
| 加载（含 `backend_init`） | ~1.3 s |
| 第一句话（前缀已常驻） | ~140 ms |
| 第 2 轮复用 | 51/51 token（100%） |
| 生成速度 | 与 `llama-server` 同量级（同一份 libllama） |

进程内的收益主要不在单轮速度，而在**多轮**：前缀复用是可保证的，
不用每轮把几百 token 的人设重新 prefill 一遍。
