package com.fy.local;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 推理后端注册表 —— 前端设置页「推理方式」那个下拉框背后真正的东西。
 *
 * <p>已注册的后端 = 这个 App 现在拥有的"进程内推理路"。没注册的 id 一律视为
 * "没这条路"，{@code Bridge} 会当作选了子进程 server 处理，所以加后端不需要动调度。
 *
 * <p>子进程 {@link Engine}（llama-server + HTTP）不在这里：它不是进程内后端，
 * 聊天走的是 HTTP，前端用 {@code native=false} 分辨。第三方（云端 / 局域网 OpenAI 兼容）
 * 也不在这里：那条路前端直接发 {@code /api}，连 Java 都不经过。
 */
public final class EngineRegistry {

    private final Map<String, EngineBackend> backends = new LinkedHashMap<>();

    public void register(EngineBackend b) {
        if (b == null || b.id() == null || b.id().isEmpty()) return;
        backends.put(b.id(), b);
    }

    public EngineBackend get(String id) {
        return id == null ? null : backends.get(id);
    }

    /** 注册顺序 = 设置页展示顺序。 */
    public List<EngineBackend> all() {
        return new ArrayList<>(backends.values());
    }

    /**
     * 当前"该被 engineStatus 报出来"的进程内后端：在跑或正在起的那一个。
     * 同一时刻只会有一个（start 前会先停旧的），所以取第一个命中即可。
     */
    public EngineBackend active() {
        for (EngineBackend b : backends.values()) {
            if (b.active() || "loading".equals(b.state())) return b;
        }
        return null;
    }

    /** 聊天该用哪个：优先正在跑的那个，其次第一个可用且支持进程内聊天的。 */
    public EngineBackend forChat() {
        EngineBackend a = active();
        if (a != null && a.inProcessChat()) return a;
        for (EngineBackend b : backends.values()) {
            if (b.inProcessChat() && b.available()) return b;
        }
        return a;
    }

    /** 给调试页 / appInfo 用的一行摘要，例如 {@code jni:ready, onnx:unavailable}。 */
    public String summary() {
        StringBuilder sb = new StringBuilder();
        for (EngineBackend b : backends.values()) {
            if (sb.length() > 0) sb.append(", ");
            sb.append(b.id()).append(':').append(b.available() ? b.state() : "unavailable");
        }
        return sb.toString();
    }
}
