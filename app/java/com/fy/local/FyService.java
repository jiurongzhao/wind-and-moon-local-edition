package com.fy.local;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * 引擎前台服务 —— 存在的唯一理由：**别让系统把 App 冻住**。
 *
 * 实测（Redmi Turbo 3 / Android 16 / HyperOS）：只要引擎在跑而 App 退到后台，
 * 系统立刻把整个进程塞进冻结 cgroup（cgroup.freeze=1）。后果是：
 *   - llama-server 是子进程，跟着一起冻住 → 生成停摆；
 *   - WebView 也冻住 → 再切回来界面「点不动」，像死了一样；
 *   - 放着不管还会被 MIUI 直接杀掉（连带引擎）。
 *
 * 挂一个前台服务后进程是 foreground-service 级别，不再是 cached，系统就不会冻它，
 * 引擎能在后台继续跑、切回来界面也是活的。
 */
public class FyService extends Service {

    public static final int NOTIF_ID = 1001;
    private static final String CHANNEL = "fy_running";
    public static final String EXTRA_TEXT = "text";

    /** 通知内容统一在这里构造，MainActivity 更新进度时复用同一个 id。 */
    public static Notification build(Context ctx, String text) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, piFlags);

        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(ctx, CHANNEL)
                : new Notification.Builder(ctx);
        b.setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("风月·本地版")
                .setContentText(text)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(pi);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            b.setCategory(Notification.CATEGORY_SERVICE);
        }
        return b.build();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel c = new NotificationChannel(CHANNEL, "风月在后台运行",
                        NotificationManager.IMPORTANCE_LOW);
                c.setShowBadge(false);
                nm.createNotificationChannel(c);
            }
        }
        /* 立刻进前台，而不是等到 onStartCommand。
         *
         * 真机（Redmi Turbo 3 / Android 16）：startForegroundService() 之后系统只给约 5 秒
         * 让 Service.startForeground() 落地，而 onCreate/onStartCommand 都在主线程上排队。
         * 加载 3B（2.1GB）期间 App 一旦被系统冻进冻结 cgroup，这个排队就永远走不到，
         * 5 秒后直接 ForegroundServiceDidNotStartInTimeException 杀进程（实测崩过）。
         * 在 onCreate 里先占住前台，是能拿到的最早时机。 */
        try {
            startForeground(NOTIF_ID, build(this, "风月在后台运行"));
        } catch (Throwable t) {
            Log.w("FyService", "startForeground(in onCreate) 失败: " + t);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent == null ? null : intent.getStringExtra(EXTRA_TEXT);
        if (text == null || text.isEmpty()) text = "风月在后台运行";
        startForeground(NOTIF_ID, build(this, text));
        // 不要 START_STICKY：服务被杀时引擎也没了，重启一个空服务没有意义。
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopForeground(true);
        super.onDestroy();
    }
}
