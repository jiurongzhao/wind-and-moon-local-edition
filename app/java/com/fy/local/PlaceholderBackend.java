package com.fy.local;

/**
 * 占位后端：把"评估过、但目前没接"的推理路线留在设置页里，明确显示为不可用。
 *
 * <p>它不是纯空壳，而是"有结论的空壳"：用户能看见这条路存在、为什么没开；
 * 将来真要接入时，把这个类换成真正的实现、并让 {@link #available()} 返回 true 即可，
 * 其余调度（Bridge / 前端下拉框）一行都不用动。评估结论见 docs/engine-backends.md。
 *
 * <p>注意：{@code available()==false} + {@code inProcessChat()==true} 的组合是安全的 ——
 * {@link EngineRegistry#forChat()} 只会在 {@code available()} 的后端里挑聊天对象，
 * 所以占位后端永远不会被误选。
 */
public final class PlaceholderBackend implements EngineBackend {

    private final String id;
    private final String label;
    private final String reason;

    public PlaceholderBackend(String id, String label, String reason) {
        this.id = id;
        this.label = label;
        this.reason = reason;
    }

    @Override public String id() { return id; }
    @Override public String label() { return label; }

    /** 一直 false：这就是"留位不落地"的表达方式。 */
    @Override public boolean available() { return false; }

    @Override public boolean inProcessChat() { return true; }
    @Override public String state() { return "stopped"; }
    @Override public String message() { return reason; }
    @Override public String model() { return ""; }
    @Override public long loadMs() { return -1; }
    @Override public boolean active() { return false; }
    @Override public boolean generating() { return false; }

    @Override
    public void start(String absModelPath, int ctx, int threads, boolean mlock, Runnable onStartFailed) {
        /* 正常情况下调用方看到 available()=false 就不会进来；万一进来，直接报告失败让对方回退。 */
        if (onStartFailed != null) onStartFailed.run();
    }

    @Override public void stop() { }
    @Override public void unload() { }
    @Override public String chat(String[] flatMessages, ChatOptions opts) { return null; }
    @Override public void stopChat() { }
}
