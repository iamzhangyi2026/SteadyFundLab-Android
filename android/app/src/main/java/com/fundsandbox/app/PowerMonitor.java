package com.fundsandbox.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;

import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * PowerMonitor — 监听充电插拔事件，转发给 JS 侧。
 *
 * 触发流程：
 *   系统广播 ACTION_POWER_CONNECTED / ACTION_POWER_DISCONNECTED
 *   → 本 Receiver 收到 → notifyListeners('onCharging', { charging: bool })
 *   → JS autoRefresh.js 响应
 */
@CapacitorPlugin(name = "PowerMonitor")
public class PowerMonitor extends Plugin {

    private PowerReceiver receiver;

    @PluginMethod
    public void start(PluginCall call) {
        if (receiver != null) {
            call.resolve();
            return;
        }

        receiver = new PowerReceiver();
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_POWER_CONNECTED);
        filter.addAction(Intent.ACTION_POWER_DISCONNECTED);
        // Android 8+ 对后台广播有限制，REGISTER_RECEIVER_WHILE_RUNNING 确保在前台时可靠接收
        getActivity().registerReceiver(
            receiver, filter,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                ? Context.RECEIVER_NOT_EXPORTED : 0
        );

        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (receiver != null) {
            getActivity().unregisterReceiver(receiver);
            receiver = null;
        }
        call.resolve();
    }

    /**
     * 内部 BroadcastReceiver：捕获充电状态变化并触发 JS 事件。
     */
    private class PowerReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            boolean charged = Intent.ACTION_POWER_CONNECTED.equals(intent.getAction());
            bridge.getActivity().runOnUiThread(() ->
                notifyListeners("onCharging", new JSObject().put("charging", charged))
            );
        }
    }
}
