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

---

## 内容声明（非许可证，但请一并阅读）

- 本 App 生成的所有角色回复**由设备本地模型实时生成**，不代表开发者观点，
  仅供娱乐与创作参考，不构成任何专业建议。
- 角色卡导入功能支持第三方 `chara_card_v2` 卡，**导入内容的合法性与适当性由使用者自负**。
- 本项目面向成年人；请勿用于生成或传播违反所在地法律法规的内容。
