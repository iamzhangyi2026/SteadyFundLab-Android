package com.fundsandbox.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * 后台刷新前台服务 —— 只为「保活」而存在。
 *
 * Android 会冻结退到后台的 App 进程（含 WebView 的 JS 引擎），
 *   导致「夜间 WiFi+充电 自动全量抓取」在后台无法执行。
 *
 * 方案：
 *   抓取期间启动本前台服务，把进程优先级提到 FOREGROUND_SERVICE（带常驻通知），
 *   进程与 WebView 不再被冻结 → JS 侧的分批抓取得以继续执行；
 *   抓完由 JS 侧调插件 `BackgroundRefresh.stop()` 结束服务、移除通知。
 *
 * 说明：本服务**不自己抓数据**，只负责保活（抓取逻辑仍在 JS 侧，避免重复实现）。
 */
public class BackgroundRefreshService extends Service {

    public static final String CHANNEL_ID = "bg_refresh";
    public static final int NOTIFY_ID = 90001;

    /** 前台服务是否正在运行（供 MainActivity 判断是否需要定期恢复 WebView） */
    public static volatile boolean isRunning = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        isRunning = true;
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("基金数据后台更新中")
                .setContentText("正在补全基金与净值数据，可继续使用手机")
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setSilent(true)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFY_ID, n);
            }
        } catch (Throwable t) {
            // 前台服务启动失败（如通知权限被拒）→ 退化为普通服务，不崩
            try { startForeground(NOTIFY_ID, n); } catch (Throwable ignored) { }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        try { stopForeground(true); } catch (Throwable ignored) { }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "后台数据更新", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setDescription("夜间自动补全基金数据时显示");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }
}
