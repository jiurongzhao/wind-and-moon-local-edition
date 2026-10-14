# Reddit / Hacker News 英文发帖稿（定稿）

> 前提：英文 README（`README.en.md`）已就绪。**每个版块先读 sidebar 规则并选对 flair。**
> Reddit 自推一般限制在总发帖量的 ~10%，先参与讨论再分享。
> 素材：首图用 `docs/social-preview.png`（1200×630）；正文/评论里放仓库里 `docs/demo-airplane.gif` 的链接（真机飞行模式录屏）。

---

## r/LocalLLaMA

**Title:** I built a fully offline Android roleplay app — llama.cpp running in-process, 13.8 MB APK, no Termux, no cloud

**Body:**

I wanted local-LLM roleplay on an Android phone without Termux, a PC, or a cloud API. So I built **Wind and Moon · Local Edition** — a fully offline Android app (MIT, open source).

How it runs:

- Inference is on-device. llama.cpp's official Android arm64 build is bundled in the APK, and since v1.7 the default backend is an **in-process JNI engine** — no HTTP port, no child process.
- The persona/world info is compiled into a **resident KV prefix**, so from turn 2 onward only the new tokens are decoded.
- **13.8 MB APK** total (engine stripped 276 MB → 27 MB before packing).
- Qwen2.5-0.5B Q4_K_M measured at **42–52 tok/s** on CPU (4 threads); 3B/4B also load.
- **16 categories × 32,000 CC0 character/story cards**, downloaded on demand (not in the APK). It imports SillyTavern `chara_card_v2` cards (.json/.png).
- Model source is swappable: local GGUF / LAN Ollama·LM Studio / OpenAI-compatible cloud APIs — switch from the top bar.
- **470 tests**, `./runtests.sh` runs them all (JVM with the real engine + a real 4B end-to-end).
- Built entirely in Termux — no Android Studio / Gradle / NDK.

The GIF in the repo is a real screen recording with the phone in **airplane mode**: pick a character → type → the on-device 0.5B streams the reply.

Repo: https://github.com/jiurongzhao/wind-and-moon-local-edition
Mirror (faster in CN): https://gitee.com/zhao-jiurong/wind-and-moon-local-edition

Happy to answer questions about the JNI engine, prefix-KV reuse, or SELinux/linker64 loading.

---

## r/SillyTavernAI

**Title:** Android offline client that imports SillyTavern cards natively — no Termux, no server

**Body:**

Short version: it runs llama.cpp on-device and imports `chara_card_v2` .json/.png directly, so your existing cards work as-is. No Termux, no server. 13.8 MB APK.

It can also point at a LAN endpoint (Ollama / LM Studio / llama.cpp server) if you'd rather run the model elsewhere.

Repo: https://github.com/jiurongzhao/wind-and-moon-local-edition

Card-compatibility feedback is very welcome — if a card imports wrong, post it and I'll fix it.

---

## r/androidapps

**Title:** [Dev] A fully offline AI roleplay app for Android — 13.8 MB, no account, no cloud

**Body:**

I made an Android app for local AI roleplay that's actually offline: the model runs on the phone, there's no login, and no chat ever leaves the device.

- 13.8 MB APK, no Termux / PC / Android Studio needed
- On-device inference (llama.cpp); 0.5B runs at 42–52 tok/s, 3B/4B also load
- 16 categories × 32,000 CC0 roleplay cards, downloaded on demand
- Also works with LAN Ollama/LM Studio or your own cloud API key
- Dark / light / system themes; no external assets

Repo (MIT): https://github.com/jiurongzhao/wind-and-moon-local-edition

Would love feedback on device compatibility.

---

## Show HN

**Title:** Show HN: Fully offline Android LLM roleplay app – llama.cpp in-process, 13.8 MB

**Body:**

I built an Android app that runs llama.cpp entirely on-device, with no server component. The interesting part is that since v1.7 the engine runs **in-process** (JNI straight into libllama) rather than as a child process on a local port. That removed a class of problems: no port collisions, no orphaned engine processes, no fighting the system's background killer. The persona is compiled into a resident KV prefix, so subsequent turns only decode new tokens.

The whole APK is 13.8 MB: the engine is stripped from 276 MB to 27 MB before packing. The 32,000-card library ships as repo attachments and is fetched on demand, so it doesn't bloat the install.

Everything was built in Termux on the phone itself — no Android Studio, Gradle, or NDK. There are 470 tests, including a JVM suite that drives the real engine and a real 4B end-to-end run.

Repo: https://github.com/jiurongzhao/wind-and-moon-local-edition

---

## Discord blurb（SillyTavern / llama.cpp / LocalLLaMA #showcase）

Built an offline Android client using llama.cpp on-device — 13.8 MB, imports SillyTavern `chara_card_v2` cards, in-process JNI engine (no server, no Termux). Repo: https://github.com/jiurongzhao/wind-and-moon-local-edition — would love feedback from this community on card compatibility.

---

## 发帖备注

- **顺序**：先在 r/LocalLLaMA 或 Show HN 起量，再看反馈决定要不要铺 r/SillyTavernAI、r/androidapps。
- **标题别吹**：不写 "best/fastest/revolutionary"；HN 尤其反感营销词。
- **诚实**：0.5B 质量有限，被问到就直说"小模型胜在快和完全离线，质量要高就切云 API 或局域网大模型"。
- **Reddit 自推比例**：先正常回几个别人的帖子，再发自己的；同一天不要跨多个版块发同一份内容。
- **Show HN**：发出去后头两个小时留在评论区回问题，HN 排名很吃早期互动。
- 有人要 APK 时给仓库发行版链接，不要私传文件。
