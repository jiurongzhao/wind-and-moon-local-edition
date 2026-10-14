# V2EX / LINUX DO「分享创造」发帖稿

## 标题

「分享创造」风月·本地版：一个完全离线的 Android AI 角色扮演 App（13.8MB，不用 Termux）

## 正文

做了个安卓上的本地大模型角色扮演 App，想解决一个很具体的麻烦：

**在手机上玩 AI 角色扮演，要么 Termux 里装 Ollama + 前端，要么连电脑/云端。** 我想做到「装个 APK 就能聊，而且飞行模式也行」。

于是：

- 引擎用 llama.cpp 官方 Android arm64 预编译库 + LiteRT-LM，内置进 APK；v1.7 起默认**进程内引擎**（JNI 直连 libllama），没有端口和子进程，人设编译成常驻前缀，第二轮起只 decode 新增的 token；
- 整个 APK **13.8MB**（引擎从 276MB strip 到 27MB 再压进来）；
- 内置 **16 类 × 32000 张 CC0 原创卡**，按需下载；也能导入 SillyTavern 的 chara_card_v2 卡（.json / .png）；
- 创作者工具：模板 + 骨架 + 七维评分 + AI 辅助扩写；
- 模型来源可切：本地 GGUF / 局域网 Ollama·LM Studio / 云端 API；
- 全部在 Termux 里从零构建，不用 Android Studio / Gradle / NDK。

技术上踩过的坑都写进 README 折起来了（后台冻结、SELinux 加载 .so、前缀 KV 复用、PNG 卡解析……）。有 **470 项测试**，跑 `./runtests.sh` 一条命令。

**仓库**
- GitHub：https://github.com/jiurongzhao/wind-and-moon-local-edition
- Gitee：https://gitee.com/zhao-jiurong/wind-and-moon-local-edition

长期找 bug、也欢迎提需求。有任何兼容性问题（机型/系统）贴出来我尽量适配。

## 备注

- LINUX DO 和 V2EX 都吃「技术细节 + 诚实踩坑」，别写得像广告；把踩坑和取舍讲清楚更容易起量。
- 附上 README 里的性能表和「为什么是这套架构」一节链接。
