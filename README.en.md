# 🌙 Wind and Moon · Local Edition

**A fully offline Android AI roleplay app** — both the inference engine and the GGUF models run on your phone. No login, no network, no uploads. The whole app is built from scratch inside Termux; no Android Studio / Gradle / NDK required.

[中文说明 (Chinese README)](README.md) · [Gitee mirror](https://gitee.com/zhao-jiurong/wind-and-moon-local-edition)

## Why install it

| | |
|---|---|
| 🔒 **Truly offline** | llama.cpp's official Android arm64 build is bundled into the APK; models live on-device. **Airplane mode works.** Your chats never leave the phone. |
| 🧠 **Runs on-device** | From 0.5B up. A 0.5B model runs at **42–52 chars/s**. Since v1.7 the default is an **in-process JNI engine** (libllama linked directly into the app): the persona is compiled into a resident KV prefix, so from turn 2 only the new tokens are decoded. |
| 🎭 **32,000 original cards** | 16 categories × (1,000 character cards + 1,000 story cards), all **CC0**, downloaded on demand (not shipped in the APK). |
| ✍️ **Creator tools** | 16 templates + 48 persona skeletons + 7-dimension quality scoring + AI-assisted writing with your own model. |
| 🔁 **Swap model sources** | Local GGUF / LAN Ollama·LM Studio / OpenAI-compatible cloud APIs (DeepSeek, etc.). |
| 🎨 **Hand-drawn UI** | Material-3-style design system, all icons are inline SVG, dark / light / system themes, zero external assets. |
| 📦 **Only 13.8 MB** | Engine stripped from 276 MB to 27 MB. The 32,000-card library ships as release assets. |
| 🧪 **470 tests** | jsdom frontend + JVM tests that really run the engine / proxy / PNG card parsing. `./runtests.sh` runs them all. |

## Quick start

**Install the ready-made APK**: download `fy.apk` (~13.8 MB) from [Releases](../../releases) and open it (you need to allow "install unknown apps").

Pick one path on first launch:

| Path | Best for | How |
|---|---|---|
| **Cloud API (DeepSeek preset)** | Lowest effort, small phones, best quality | Settings → Model source → External service; DeepSeek is pre-filled, just paste an API key |
| **Local model (fully offline)** | No network, no API cost | Settings → Models → download the built-in 0.5B (~0.5 GB), or paste any GGUF direct link |
| **LAN self-hosted** | You have a PC/VPS running a big model | Enter `http://your-pc-ip:11434/v1` (Ollama / LM Studio / llama.cpp server) |

### Requirements

- Android 10+ (minSdk 24), **arm64**
- 6 GB+ RAM recommended; 0.5B needs ~1 GB free, 3B ~3.5 GB

## Build from source

```bash
git clone https://github.com/jiurongzhao/wind-and-moon-local-edition.git
cd wind-and-moon-local-edition
./tools/fetch-deps.sh     # pulls llama.cpp prebuilt engine + android.jar
./build.sh                # produces fy.apk (release-signed)
```

Works in Termux or any Linux; no Android Studio required. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Engineering notes

The interesting parts are documented (in Chinese) under `docs/`:

- [docs/native-engine.md](docs/native-engine.md) — in-process JNI engine, prefix-KV reuse
- [docs/engine-backends.md](docs/engine-backends.md) — backend selection, device measurements
- [docs/user-guide.md](docs/user-guide.md) — user guide

## License

MIT (see [LICENSE](LICENSE)). Bundled llama.cpp and LiteRT-LM components keep their own licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Links

- **GitHub**: https://github.com/jiurongzhao/wind-and-moon-local-edition
- **Gitee (fast in China)**: https://gitee.com/zhao-jiurong/wind-and-moon-local-edition
