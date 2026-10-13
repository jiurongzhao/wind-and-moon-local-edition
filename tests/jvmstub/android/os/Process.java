package android.os;

/**
 * JVM 桩：只实现 Engine.java 用到的那几个方法。
 *
 * 注意 killProcess 在 JVM 上是「真的杀」——用 ProcessHandle，这样
 * tests/EngineReapJvmTest.java 能真的起一个假引擎进程、验证它被收掉，
 * 同时验证不相关的进程不会被误杀。
 */
public class Process {

    public static int myPid() {
        try {
            return (int) ProcessHandle.current().pid();
        } catch (Throwable t) {
            return -1;
        }
    }

    public static int myUid() {
        return 0;
    }

    public static void killProcess(int pid) {
        try {
            ProcessHandle.of((long) pid).ifPresent(ProcessHandle::destroyForcibly);
        } catch (Throwable ignored) {
        }
    }
}
