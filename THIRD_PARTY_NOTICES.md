# 第三方组件与许可证

本项目**自己写的代码**（`app/`、`tools/`、`tests/`、`docs/`）以 [MIT](LICENSE) 发布。
下面这些是运行时依赖的第三方组件，各自遵循原许可证。

---

## 1. llama.cpp（推理引擎）—— MIT

- **用途**：App 的全部推理能力。`llama-server` 以子进程方式运行，模型在设备本地加载。
- **版本**：`0.6.0-dev (build 11552, commit 23b0202a1)`，取自官方 release
  [`b11552` 的 Android arm64 预编译包](https://github.com/ggml-org/llama.cpp/releases/tag/b11552)
  （`llama-b11552-bin-android-arm64.tar.gz`）。
- **获取方式**：`./tools/fetch-engine.sh` 会从上面的官方地址重新下载并准备这 15 个文件。
  仓库不提交这些二进制，避免体积与溯源问题。
- **改动**：仅做 `strip`（去符号）与改名（`llama-server` → `libfy_llama_server.so`，
  因为 Android 只允许执行 `lib*.so` 形式的 native 库），**没有修改任何代码**。
- **许可证全文**：见 [third_party/llama.cpp-LICENSE](third_party/llama.cpp-LICENSE)
  （MIT，Copyright (c) 2023-2026 The ggml authors）。

```
MIT License
Copyright (c) 2023-2026 The ggml authors
```

## 2. Android SDK（`android.jar` 等）—— Android SDK 许可证

- **用途**：仅用于**编译期**（`javac` / `d8` / `aapt2`），不会打进 APK。
- **获取方式**：`./tools/fetch-sdk.sh`，从 Google 官方仓库下载 `platform-36-ext19_r01.zip`。
- 使用时请遵守 [Android SDK 许可协议](https://developer.android.com/studio/terms)。

## 3. 应用图标 / 界面素材 —— 本项目原创

- 启动图标由 `tools/genicons.py` **用代码绘制**（深紫圆底 + 弯月 + 三颗星），
  矢量前景见 `app/res/drawable/ic_launcher_foreground.xml`；
- 界面是手写 HTML/CSS，**没有引入任何第三方图标库或素材**；
- 因此上架/分发时不需要处理额外素材授权。

## 4. 模型文件 —— 由用户自行提供，不在本仓库内

本 App **不内置任何模型**，也不要求特定模型。仓库文档里推荐的几款：

| 模型 | 许可证 |
|---|---|
| Qwen2.5 系列（0.5B / 3B） | Apache-2.0（[Qwen 官方](https://github.com/QwenLM/Qwen2.5)） |
| Qwen3 系列（4B） | Apache-2.0（[Qwen 官方](https://github.com/QwenLM/Qwen3)） |

如果你导入了其它模型，请自行确认其许可证与用途限制。
**下载与使用模型时请遵守模型提供方的许可条款。**

## 5. 测试依赖（仅开发期）

| 组件 | 用途 | 许可证 |
|---|---|---|
| [jsdom](https://github.com/jsdom/jsdom) | 前端集成测试 | MIT |
| [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) | 数据库测试 | Apache-2.0 |

它们只在 `tests/` 里用，不会进入 APK。

## 6. 创作者工具的知识来源 —— 只借鉴模式，不含第三方卡片正文

「创作者工具」的分类模板、骨架与写作要点**全部由本项目原创撰写**，
不含任何第三方卡片正文。成文时参考了以下公开来源的**结构与分类口径**：

| 来源 | 许可证 | 借鉴了什么 | 有没有引入原文 |
|---|---|---|---|
| [marcodsn/SPB-2603](https://huggingface.co/datasets/marcodsn/SPB-2603)（Synthetic Persona Bank，合成人设库） | **CC-BY-4.0** | 人设的 7 个质量评分维度（内在一致性 / 原型贴合度 / 展示而非告知 / 心理真实度 / 扮演实用性 / 辨识度 / 格式合规） | ❌ 只借维度名称与口径，判定逻辑是本项目自己写的启发式规则 |
| [kwaroran/character-card-spec-v3](https://github.com/kwaroran/character-card-spec-v3) | MIT | `chara_card_v3` 字段定义 | ❌ 未复制规范正文 |
| [malfoyslastname/character-card-spec-v2](https://github.com/malfoyslastname/character-card-spec-v2) | 未声明许可证 | `chara_card_v2` 字段语义（本项目一直兼容它） | ❌ 仅按规范实现字段映射 |
| [Sn0w123/booru-characters](https://huggingface.co/datasets/Sn0w123/booru-characters) | MIT | 「按覆盖率阈值把标签自动分级」的思路 | ❌ 未取任何标签数据 |
| [Gryphe/CharcardCodex](https://huggingface.co/datasets/Gryphe/CharcardCodex) | unknown | 把 `objective`（用户目标）与 `user_role`（用户身份）显式字段化的思路 | ❌ 许可证不明，**只看了字段结构** |

**明确没有采用**的来源（许可证带 NC/SA，会污染本项目的 CC0 产出）：
`proj-persona/PersonaHub`（CC-BY-NC-SA-4.0）等一切 NC / SA 语料。

> SPB-2603 为 CC-BY-4.0：署名要求已在此满足。若你要在别处分发基于这 7 个维度名称的衍生作品，
> 请一并保留本条署名。
>
> 联网参考面板（「💡 灵感」）在运行时展示的来源包括：
> - `datasets-server.huggingface.co` 上 SPB-2603 的**字段结构**（CC-BY-4.0）；
> - `api.chub.ai` 搜索接口返回的**角色名与 topics 标签**（社区创作者保留版权，仅作标签词表参考，
>   已按 `nsfw_image` 标记过滤，且不下载、不保存、不分发任何卡正文）；
> - `api.github.com` 仓库检索返回的**仓库元数据与许可证**。
>
> 这些内容**不会被打包进 APK**，只在用户主动点击「拉取」时即时请求并显示。

---

## 内容声明（非许可证，但请一并阅读）

- 本 App 生成的所有角色回复**由设备本地模型实时生成**，不代表开发者观点，
  仅供娱乐与创作参考，不构成任何专业建议。
- 角色卡导入功能支持第三方 `chara_card_v2` 卡，**导入内容的合法性与适当性由使用者自负**。
- 本项目面向成年人；请勿用于生成或传播违反所在地法律法规的内容。
