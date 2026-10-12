package android.os;

/** 测试用最小桩：唤醒锁直接当空操作，只记录状态。 */
public class PowerManager {

    public static final int PARTIAL_WAKE_LOCK = 1;

    public WakeLock newWakeLock(int levelAndFlags, String tag) {
        return new WakeLock(tag);
    }

    public static class WakeLock {
        private final String tag;
        private boolean held = false;
        private boolean refCounted = true;

        WakeLock(String tag) {
            this.tag = tag;
        }

        public void setReferenceCounted(boolean value) {
            this.refCounted = value;
        }

        public void acquire(long timeout) {
            held = true;
            System.out.println("[PowerManager] acquire " + tag + " timeout=" + timeout);
        }

        public void acquire() {
            acquire(0);
        }

        public void release() {
            held = false;
            System.out.println("[PowerManager] release " + tag);
        }

        public boolean isHeld() {
            return held;
        }
    }
}
