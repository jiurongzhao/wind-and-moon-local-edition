# 参与开发 / 自己构建

这个项目的构建方式比较特别：**全程在 Android 手机上（Termux 里）完成**，
不需要 Android Studio、不需要 Gradle、不需要 NDK。
下面的步骤在电脑 Linux 上同样适用（把 Termux 的包换成发行版的包）。

## 一、准备依赖

```bash
# 1) 工具链（Termux）
pkg install openjdk-17 aapt2 apksigner d8 curl unzip nodejs-lts

# 2) 两个"大件"第三方产物（仓库刻意不提交）
./tools/fetch-deps.sh
#    ├─ native/           llama.cpp 官方 Android 预编译（约 27MB，MIT）
#    └─ sdk/android-36/   android.jar（约 28MB，Google SDK）

# 3) 国内网络慢 / 拉不动 GitHub 时，用镜像：
#    维护者把引擎包传到 Gitee 发行版后，其他人这样取（见下面「依赖镜像」）

# 3) 模型（自己准备，仓库不含）
mkdir -p models && cp /path/to/qwen2.5-0.5b-instruct-q4_k_m.gguf models/
```

## 二、构建 / 测试

```bash
./build.sh              # 正式包 → fy.apk（release 签名，无 debuggable）
./build.sh --debug      # 调试包 → fy-debug.apk（可接 WebView DevTools）
./build.sh --check      # 只检查工具链

cd tests && npm install # 首次
./runtests.sh --quick   # 不需要模型的测试（前端 jsdom + JVM 两个套件）
./runtests.sh           # 全量（会真起 llama-server，需要 models/ 里有 0.5B）
```

> **发布签名**：`build.sh` 首次运行会生成 `release.keystore` + `release-signing.properties`。
> 这两个文件**必须备份**（丢了就无法给已安装用户推送更新），且**已被 .gitignore 排除，不要提交**。

## 二点五、依赖镜像（国内网络）

`fetch-engine.sh` 默认从 llama.cpp 官方 GitHub release 下载，国内经常超时。
维护者可以把准备好的引擎打成包，传到 **Gitee 发行版**当附件：

```bash
./tools/pack-engine.sh                       # 产出 dist/native-b11552.tar.gz（约 27MB）
# 然后在 Gitee 仓库 → 发行版 → 新建，上传这个 tar.gz

# 其他人这样取（脚本会优先用镜像）：
export GITEE_MIRROR=https://gitee.com/zhaojiurong/wind-and-moon-local-edition/releases/download/v1.0.0/native-b11552.tar.gz
./tools/fetch-engine.sh
```

也可以完全离线：把 `native-b11552.tar.gz` 放到任意位置后

```bash
ENGINE_TARBALL=/path/to/native-b11552.tar.gz ./tools/fetch-engine.sh
```

`android.jar` 如果也拉不动，可以从任意一台装过 Android SDK 的机器上拷
`sdk/android-36/android.jar`（约 28MB）过来即可。

## 三、跑分脚本（改性能前先量一遍）

```bash
cd tests
MODEL=qwen2.5-0.5b-instruct-q4_k_m.gguf node bench-flags.mjs    # 引擎启动参数 A/B
SHAPE=stable node bench-prefix.mjs                              # 多轮前缀复用
node bench-db.mjs 2000 3                                        # 数据库真实规模
```

结论都写在 [README](README.md) 的「实测性能」一节 —— 改这些参数前请先复现基线，
这台机器上"看起来更快"的配置经常是噪声（投机解码就是这么被否掉的）。

## 四、提交前自查

- [ ] `cd tests && node ui.test.mjs` 全绿（当前 147 项）
- [ ] `./runtests.sh --quick` 全绿
- [ ] `./build.sh` 通过（发布包自检会拦 `debuggable`、`resources.arsc` 对齐等）
- [ ] **没有提交**：`release.keystore` / `release-signing.properties` / `*.apk` / `models/` / `native/` / `sdk/`
- [ ] 新增的第三方素材（图标、字体、代码）已在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 登记

## 五、代码结构速查

| 想改什么 | 去哪 |
|---|---|
| 界面样式 | `app/assets/ui/style.css` |
| 界面逻辑 / 提示词 / 流式解析 | `app/assets/ui/app.js` |
| 数据模型与存储（四个后端） | `app/assets/ui/store.js` |
| 角色卡格式（chara_card_v2） | `app/assets/ui/cards.js` |
| 引擎子进程管理 / 启动参数 | `app/java/com/fy/local/Engine.java` |
| SQLite 后端 | `app/java/com/fy/local/Db.java` |
| PNG 角色卡解析（纯逻辑，可 JVM 测） | `app/java/com/fy/local/PngCardText.java` |
| 打包与对齐 | `tools/packapk.py` / `tools/checkapk.py` |

## 六、欢迎的贡献方向

- 更多机型的实测数据（尤其不同 SoC 上的线程数甜点，见 `bench-flags.mjs`）；
- 界面美化（当前是手写 CSS，欢迎有设计感的 PR）；
- 角色卡生态兼容（其它格式的导入适配）；
- 文档与翻译。

**请注意**：涉及第三方角色卡内容的 PR 我们不接受（版权问题），
请只提交你自己创作或明确许可的内容。
