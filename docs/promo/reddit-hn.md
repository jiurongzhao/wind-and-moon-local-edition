# Reddit / Hacker News / Discord 英文发帖稿

> 前提：英文 README（README.en.md）已就绪；发帖前读各版版规（Reddit 多半限制自推比例）。

## r/LocalLLaMA

**Title:** I built a fully offline Android roleplay app — llama.cpp in-process, 13.8MB APK, no Termux, no cloud

**Body:**

I wanted local LLM roleplay on Android without Termux, a PC, or a cloud API. So I built **Wind and Moon · Local Edition** — a fully offline Android app.

- Inference runs **on-device**: llama.cpp official Android arm64 build + LiteRT-LM, and since v1.7 the default is an **in-process JNI engine** (no port, no child process; the persona is compiled into a resident KV prefix, so from turn 2 only the new tokens are decoded).
- The whole APK is **13.8 MB** (engine stripped 276 MB → 27 MB).
- **16 categories × 32,000 CC0 character cards**, downloaded on demand; also imports SillyTavern `chara_card_v2` cards (.json / .png).
- Model source is swappable: local GGUF / LAN Ollama·LM Studio / OpenAI-compatible cloud APIs (DeepSeek, etc.).
- **470 tests**, `./runtests.sh` runs them all.
- Built entirely from scratch in Termux — no Android Studio / Gradle / NDK.

Everything is CC0/MIT-friendly; offline means offline — the chat never leaves the phone.

GitHub: https://github.com/jiurongzhao/wind-and-moon-local-edition
Gitee mirror: https://gitee.com/zhao-jiurong/wind-and-moon-local-edition

Happy to answer questions about the JNI engine, prefix-KV reuse, or PNG card parsing.

## r/SillyTavernAI

**Title:** Android offline client that imports SillyTavern cards natively (no Termux)

**Body:** Short version — it runs llama.cpp on-device and imports `chara_card_v2` .json/.png directly, so your existing cards work. No Termux, no server. 13.8MB APK. [links]. Feedback on card compatibility welcome.

## Show HN

**Title:** Show HN: Offline Android LLM roleplay app – llama.cpp in-process, 13.8 MB

**Body:** One or two paragraphs focused on the engineering: in-process JNI engine, prefix-KV reuse, SELinux/linker64 loading, PNG card parsing, Termux-only build. Link to repo and README engineering notes.

## Discord blurb (SillyTavern / llama.cpp / LocalLLaMA #showcase)

"Built an offline Android client using llama.cpp on-device — 13.8MB, imports SillyTavern cards, in-process JNI engine (no server). Repo: [link]. Would love feedback from this community on card compatibility."
