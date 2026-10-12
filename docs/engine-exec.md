# 在 Android 应用里跑 llama-server：可行性证据链

这份笔记记录「把 llama.cpp 官方 Android 预编译二进制塞进 APK 并执行」这条路的关键论据，
免得以后（或换机器时）重新踩一遍。

## 1. Android 10+ 禁止执行应用数据目录里的文件

这是 W^X 限制：`targetSdk >= 29` 的应用不能在 `filesDir` / `cacheDir`（SELinux 类型 `app_data_file`）
里执行任何东西。所以「把引擎解压到 filesDir 再 exec」这条路是死的。

**绕过方式**：`nativeLibraryDir`（`/data/app/~~xxx==/<pkg>-yyy==/lib/arm64`，SELinux 类型 `apk_data_file`）
里的文件是允许执行的，而且只要满足两个条件它就是**真实文件**（而不是只在 APK 里）：

```xml
android:extractNativeLibs="true"
```
并且文件名要匹配 `lib*.so`（`lib/<abi>/` 目录下的文件才会被安装器解包）。

于是把 `llama-server` 改名成 `libfy_llama_server.so` 放进 `jniLibs/arm64-v8a/` 即可。

## 2. SELinux 策略依据（AOSP 源码原文）

`system/sepolicy/private/app.te`（LineageOS `lineage-22.0` = Android 15 分支，AOSP 同名同内容）：

```te
# Allow apps to read/execute installed binaries
allow appdomain apk_data_file:dir { open getattr read search ioctl lock };
allow appdomain apk_data_file:file { getattr open read ioctl lock map x_file_perms };
```

而 `public/global_macros` 里：

```te
define(`x_file_perms', `{ getattr execute execute_no_trans map }')
```

结论：**所有 app 域（含 `untrusted_app`）对 `apk_data_file` 明确拥有 `execute` / `execute_no_trans` 权限。**
`neverallow appdomain exec_type:file {...}` 那条只限制「写入/改属性」，不限制执行，不冲突。

> 本地留存副本：`docs/policy/L_private_app.te`、`docs/policy/global_macros`

## 3. 二进制本身要满足的条件

- 架构：`arm64-v8a`（本项目只用 arm64，`abiFilters` 意义上的单一 ABI）
- 依赖库：`llama-server` 的 `DT_NEEDED` 有 6 个（`libllama-server-impl.so`、`libllama-common.so`、
  `libmtmd.so`、`libllama.so`、`libggml.so`、`libggml-base.so`），
  它们的**文件名必须保持原样**放在同一个 `lib/arm64-v8a/` 里，
  并在启动子进程时设置 `LD_LIBRARY_PATH=<nativeLibraryDir>` 让动态链接器找到它们。
- ggml 的 CPU 后端是**运行时按 CPU 特性 dlopen** 的（日志可见
  `load_backend: loaded CPU backend from .../libggml-cpu-android_armv8.6_1.so`），
  所以那几个 `libggml-cpu-android_armv*_*.so` 要全部带上，不能只留一个。
- 页对齐：本项目引擎来自 llama.cpp 官方 `b11552` Android 构建，段对齐 `align=0x4000`（16KB），
  同时兼容 4KB 页（本机 `getconf PAGE_SIZE = 4096`）和 16KB 页设备。

## 4. 兜底方案

`Engine.java` 里实现了两级启动策略，防止某些 ROM 的策略差异：

1. `direct`：直接 `exec` `nativeLibraryDir/libfy_llama_server.so`
2. `linker64`：`/system/bin/linker64 <该文件> ...`（进程成功 fork 但立刻因权限退出时自动回退）

启动方式会写进 `engineStatus().launchStrategy` 和日志，真机上一眼能看出走的哪条。

## 5. GPU / NPU 结论（本机实测，别重复尝试）

| 后端 | 结果 |
|---|---|
| CPU (`libggml-cpu-android_*`) | ✅ 可用，Qwen3-4B 生成 12.0 tok/s（6 线程） |
| OpenCL (`--device GPUOpenCL -ngl 99`) | ❌ 模型加载到 GPU 后进程被系统 SIGKILL（Adreno 驱动/显存问题） |
| Hexagon NPU (`HTP0`) | ❌ 报 `failed to open session`，设备上没有 QNN 运行库 |

snapdragon 特供包（`llama-*-bin-android-arm64-snapdragon.tar.gz`）才有 OpenCL/HTP 后端，
普通包是纯 CPU，体积更小、依赖更干净——本项目用普通包。
