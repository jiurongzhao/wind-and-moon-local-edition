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

## 模板在哪一层套（以及为什么不是 Java）

`llama_chat_apply_template` 需要模型对象才能拿到 GGUF 里那份模板，所以只能在 C 侧套。
好处是自动跟随模型：Qwen 是 ChatML，别的模型是别的格式，Java 与前端都不用知道。

已知取舍：这条 C API **不支持 jinja 的额外 kwargs**，所以 `chat_template_kwargs:{enable_thinking:false}`
在进程内这条路上不生效（llama-server 那条路生效）。Qwen3 的思考抑制靠人设里那句 `/no_think`
兜着 —— 内置人设本来就都带。

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

## 怎么验证

```bash
./jni/build.sh                     # Termux clang 编 native/libfy_engine.so
LD_LIBRARY_PATH=native GGML_BACKEND_PATH=native \
  java -Djava.library.path=native -cp build/jvmtest NativeEngineJvmTest
# → 27 项：加载 / 前缀常驻 / 复用 / 换人设失效 / 模板 / 小 ctx 溢出 / 中途停止 / 卸载
```

`./runtests.sh` 的 3.7 步就是它（缺模型或缺 `.so` 时跳过）。
前端那条链路由 jsdom 用例【39】盯着（假装"进程内引擎就绪"，验证走的是 `FY.chat` 而不是 `fetch`）。

## 实测数据

| 项 | 0.5B Q4_K_M |
|---|---|
| 加载（含 `backend_init`） | ~1.3 s |
| 首 token（前缀已常驻） | ~140 ms |
| 第 2 轮复用 | 51/51 token（100%） |
| 生成速度 | 与 `llama-server` 同量级（同一份 libllama） |

进程内的收益主要不在单轮速度，而在**多轮**：前缀复用是可保证的，
不用每轮把几百 token 的人设重新 prefill 一遍。
