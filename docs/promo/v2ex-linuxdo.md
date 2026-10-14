# V2EX / LINUX DO 发帖稿（定稿）

> 两个站都吃"技术细节 + 诚实踩坑"，别写成广告。**把取舍和踩过的坑讲清楚更容易起量。**
> 素材：正文里贴 `docs/demo-airplane.gif` 的仓库链接（或直接上传 GIF），再附 README 的性能表。

---

## A. V2EX「分享创造」

**标题**：分享创造：一个完全离线的 Android AI 角色扮演 App（13.8MB，不用 Termux）

**正文（直接复制）**

做了个安卓上的本地大模型角色扮演 App，想解决一个很具体的麻烦：

**在手机上玩 AI 角色扮演，要么在 Termux 里装 Ollama + 前端，要么连电脑或云服务。** 我想做到"装个 APK 就能聊，而且飞行模式也行"。

- 引擎用 llama.cpp 官方 Android arm64 预编译库 + LiteRT-LM，内置进 APK；v1.7 起默认**进程内引擎**（JNI 直连 libllama），没有端口和子进程，人设编译成常驻 KV 前缀，第二轮起只 decode 新增的 token
- 整个 APK **13.8MB**（引擎从 276MB strip 到 27MB 再压进来）
- 内置 **16 类 × 32000 张 CC0 原创卡**，按需下载；也能导入 SillyTavern 的 `chara_card_v2` 卡（.json / .png）
- 创作者工具：16 类模板 + 48 个骨架 + 七维评分 + AI 辅助扩写
- 模型来源可切：本地 GGUF / 局域网 Ollama·LM Studio / OpenAI 兼容云 API
- 全部在 Termux 里从零构建，不用 Android Studio / Gradle / NDK
- **470 项测试**，`./runtests.sh` 一条命令跑完

技术上踩过的坑都写进 README 折起来了（后台冻结、SELinux 加载 .so、前缀 KV 复用、PNG 卡解析、引擎进程清理……）。0.5B Q4_K_M 在 CPU 4 线程上实测稳定 42–52 字/秒。

仓库：
- GitHub：https://github.com/jiurongzhao/wind-and-moon-local-edition
- Gitee：https://gitee.com/zhao-jiurong/wind-and-moon-local-edition

长期找 bug，也欢迎提需求。有兼容性问题（机型 / 系统）贴出来我尽量适配。

---

## B. LINUX DO「分享创造」

**标题**：分享创造：完全离线的 Android AI 角色扮演 App —— 进程内 llama.cpp，13.8MB

**正文（直接复制）**

在安卓上把 llama.cpp 跑进 App 进程里，做了一个完全离线的 AI 角色扮演应用。想解决的问题：手机上玩本地角色扮演目前基本只有 Termux + 前端，或者连电脑。

几个自己做下来觉得值得说的点：

- **进程内引擎**：v1.7 起默认 JNI 直连 libllama，不再起子进程 / 占端口。省掉了进程间通信和端口冲突，也避开了自启动被杀、SELinux 加载 .so 这类坑（踩坑记录都在仓库 README 里）。
- **常驻 KV 前缀**：人设 / 世界观在第一轮编译成前缀钉住，之后只 decode 新说的话，第二轮起明显省时。
- **体积**：引擎 276MB → strip 到 27MB → APK 一共 13.8MB。32000 张卡走仓库附件，按需下载，不撑大安装包。
- **多后端**：本地 GGUF / 局域网 Ollama·LM Studio / OpenAI 兼容云 API，顶栏一键切；默认关掉 Qwen3 的思考模式（实测先吐一大段思考会让小模型又慢又乱）。
- **测试**：470 项，含 JVM 真跑引擎和真实 4B 端到端，`./runtests.sh`。

内容上内置 16 类 × 32000 张 CC0 卡（1000 角色 + 1000 剧情 / 类），也兼容 SillyTavern 的 chara_card_v2。

仓库：
- GitHub：https://github.com/jiurongzhao/wind-and-moon-local-edition
- Gitee：https://gitee.com/zhao-jiurong/wind-and-moon-local-edition

欢迎拍砖，尤其是引擎那块。有想加的机型 / 场景也可以直接说。

---

## 发帖备注

- 首选 V2EX；LINUX DO 可稍晚一两天，正文换掉标题和开头，别原样复制。
- 别在标题里出现"免费""最强"这类词；分享创造板块看重"你自己做的"。
- 附上 README 里的性能表和「为什么是这套架构」一节链接，被追问时直接贴。
- 有人质疑"0.5B 能干嘛"就实话实说：小模型胜在快和完全离线，质量要求高就切云 API 或局域网大模型。
