# 风月·本地版 —— JS ↔ Java 桥接口契约

> 前端（`app/assets/ui/`）只能通过这里定义的接口和原生层交互。
> 所有方法都在 `window.FY` 命名空间下；所有返回值都是 **JSON 字符串**（前端请 `JSON.parse`）。

## 1. 同步方法（返回 JSON 字符串）

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `FY.appInfo()` | — | `{version, abi, sdk, model, filesDir, nativeDir, modelDir}` | 设备与路径信息 |
| `FY.engineStatus()` | — | `{state, port, model, message, lastError}` | `state`: `stopped`/`starting`/`ready`/`error` |
| `FY.engineStart(optsJson)` | JSON 字符串 `{model, ctx, threads, gpuLayers, port}` | `{ok, message}` | 异步启动，进度通过事件推送 |
| `FY.engineStop()` | — | `{ok}` | 停止本地推理服务 |
| `FY.listModels()` | — | `[{name, sizeBytes, path, installed}]` | 扫描模型目录 |
| `FY.deleteModel(name)` | 文件名 | `{ok, message}` | 删除模型 |
| `FY.importModel(uri)` | 内容 URI（来自文件选择器） | `{ok, name, message}` | 复制外部模型到模型目录 |
| `FY.pickModelFile()` | — | `{ok}` | 打开系统文件选择器，选中后通过 `import` 事件回传 |
| `FY.downloadModel(url, name)` | 下载地址、保存名 | `{ok, message}` | 内置下载器（带 `download` 进度事件） |
| `FY.listDownloadSources()` | — | `[{name, url, sizeHint, note}]` | 内置推荐模型源（ModelScope 直链） |
| `FY.pickCharacterCard()` | — | `{ok}` | 打开文件选择器挑角色卡（`.json` / `.png`），结果通过 `card` 事件回传 |
| `FY.saveCharacterCard(name, json)` | 文件名、卡片 JSON 文本 | `{ok, path}` | 把卡导出到 `Download/`（API 29+ 走 MediaStore，无需存储权限） |
| `FY.speak(text)` | 文本 | `{ok}` | 系统 TTS 朗读 |
| `FY.stopSpeak()` | — | `{ok}` | 停止朗读 |
| `FY.startListening()` | — | `{ok}` | 开始语音识别 |
| `FY.stopListening()` | — | `{ok}` | 停止语音识别 |
| `FY.keepAwake(on)` | `true`/`false` | `{ok}` | 推理时保持屏幕常亮/唤醒锁 |
| `FY.toast(msg)` | 文本 | `{ok}` | 弹系统 Toast（调试用） |
| `FY.setSpeechRate(rate)` | 0.5–2.0 | `{ok}` | 调 TTS 语速 |
| `FY.engineLog()` | — | `["日志行", ...]` | 取引擎 stdout 最近 200 行 |
| `FY.exitApp()` | — | `{ok}` | 退出 App |
| `FY.log(msg)` | 文本 | — | 写 logcat，便于调试 |

> `engineStatus()` 里还多返回一个 `launchStrategy` 字段：`"direct"`（直接 exec）
> 或 `"linker64"`（用 `/system/bin/linker64` 加载）。真机上引擎起不来时，先看这个值。

## 2. 异步事件（Java → JS）

前端需要实现全局函数：

```js
window.fyEvent = function (name, payloadJson) { /* ... */ }
```

| `name` | payload | 触发时机 |
|---|---|---|
| `engine` | `{state, message}` | 引擎启动各阶段：`starting` → `loading` → `ready` / `error` |
| `download` | `{name, received, total, percent, state}` | 模型下载进度；`state`: `running`/`done`/`error` |
| `import` | `{ok, name, message}` | 文件选择器导入结果 |
| `card` | `{ok, name, json, message}` | 角色卡文件读取结果；`json` 是卡片文本（PNG 里的 `chara` 块已在 Java 侧解出），字段映射交给前端 `cards.js` |
| `stt` | `{text, final}` | 语音识别中间/最终结果 |
| `tts` | `{state}` | `start`/`done`/`error` |
| `log` | `{line}` | 引擎 stdout 日志行（调试面板用） |

## 3. 本地推理 API（前端直接调用，不经过 Java）

引擎就绪后，前端直接对本地端口发 HTTP 请求（llama-server 的 OpenAI 兼容接口）：

```
POST http://127.0.0.1:<port>/v1/chat/completions
{
  "messages": [{"role":"system","content":"..."},{"role":"user","content":"..."}],
  "stream": true,
  "temperature": 0.8,
  "top_p": 0.9,
  "max_tokens": 512,
  "stop": ["<|im_end|>"]
}
```

- 端口从 `engineStatus().port` 获取。
- `stream: true` 时返回 SSE：`data: {...}\n\n`，用 `fetch` + `ReadableStream` 解析。
- llama-server 已开启 `Access-Control-Allow-Origin: *`，`file://` 页面的 fetch 可直连。
- 其它可用端点：`GET /health`、`GET /v1/models`、`POST /v1/chat/completions`。

### 3.1 通用下载代理 `GET /fetch?url=<urlencoded>`

AssetServer 自己提供的同源 https 下载接口（**不是** `window.FY` 桥方法，前端直接 `fetch` 本机地址）。
「在线卡库」用它拉目录与卡包分片：Gitee 的 raw / 发行版附件都不带 `Access-Control-Allow-Origin`，
WebView 直连外域必被 CORS 拦，走同源代理就没这个问题。

```
GET http://127.0.0.1:<port>/fetch?url=https%3A%2F%2Fexample.com%2Ffy-library%2Fmystery-character-1.json
```

| 情况 | 返回 |
|---|---|
| 正常 | `200` + 上游响应体（Content-Type 透传） |
| 缺 `url` / 地址非法 / 非 `https` / 非 GET | `400` / `405`（纯文本原因） |
| 上游非 200、连不上、超时 | `502`（附上游状态码或异常原因） |
| 响应体超过上限（默认 64MB） | `413` |

安全边界：**只允许 `https`**；**不转发前端的任何请求头**（Cookie / Authorization / Referer 全部丢弃），
所以它不能被当成任意内网探测器，也不会泄漏凭证。跟随重定向，连接 15s / 读取 60s 超时。

## 4. 数据存储

前端自己用 **IndexedDB**（或 localStorage）保存角色卡、会话历史、记忆摘要。
不经过 Java 层，避免来回序列化。清空 App 数据会一起清掉，导入/导出用 JSON 文件。
