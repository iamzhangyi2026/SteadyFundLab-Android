package com.fundsandbox.app;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * BackgroundRefresh 插件 —— 启停「后台刷新前台服务」。
 *
 * JS 侧用法：
 *   const Bg = registerPlugin('BackgroundRefresh')
 *   await Bg.start()   // 抓取前：保活，防后台被冻结
 *   await Bg.stop()    // 抓完：结束服务、移除常驻通知
 */
@CapacitorPlugin(name = "BackgroundRefresh")
public class BackgroundRefresh extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        try {
            Intent i = new Intent(getContext(), BackgroundRefreshService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(i);
            } else {
                getContext().startService(i);
            }
            call.resolve();
        } catch (Throwable e) {
            call.reject("start failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), BackgroundRefreshService.class));
            call.resolve();
        } catch (Throwable e) {
            call.reject("stop failed: " + e.getMessage());
        }
    }
}
