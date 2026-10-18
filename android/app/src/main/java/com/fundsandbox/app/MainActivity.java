package com.fundsandbox.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * 主 Activity — 极简版。
 *
 * BridgeActivity 会自动扫描同包下的 @CapacitorPlugin 注解类（APKUpdater、PowerMonitor）。
 * 但 capacitor.sync android 会覆盖 capacitor.plugins.json，导致 JS 侧 getPlugin 找不到本地插件。
 * 因此在 onCreate 中手动注册所有本地插件，确保 JS 侧可用。
 */
public class MainActivity extends BridgeActivity {

    private final Handler handler = new Handler(Looper.getMainLooper());

    /**
     * 前台服务保活期间，定期调 webView.onResume() 防止 JS 定时器被系统/WebView 暂停。
     * 原因：super.onPause() 会调 webView.onPause() 暂停所有 JS 定时器（setTimeout/setInterval/Promise），
     * 导致后台净值补全（refreshNavPool）的退避重试等异步逻辑永远不执行。
     * 每 3 秒恢复一次，确保 JS 定时器不被冻结。
     *
     * 注意：onPause() 时前台服务可能尚未启动（startBackgroundRefresh 是在 appStateChange JS 事件里调的，
     * 而 appStateChange 在 onPause 之后触发）。因此 Runnable 始终继续循环，
     * 在内部判断 isRunning——一旦前台服务启动就开始恢复 WebView。
     */
    private final Runnable resumeWebView = new Runnable() {
        @Override
        public void run() {
            if (BackgroundRefreshService.isRunning) {
                try {
                    Bridge b = getBridge();
                    if (b != null) {
                        WebView wv = b.getWebView();
                        if (wv != null) {
                            wv.onResume();
                            Log.d("BgRefresh", "webView.onResume() called");
                        } else {
                            Log.d("BgRefresh", "webView is null");
                        }
                    } else {
                        Log.d("BgRefresh", "bridge is null");
                    }
                } catch (Throwable t) {
                    Log.d("BgRefresh", "resume error: " + t.getMessage());
                }
            } else {
                Log.d("BgRefresh", "FGS not running, skip");
            }
            // 始终继续循环，由 onResume 停止
            handler.postDelayed(this, 3000);
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注意：必须先注册本地插件再调 super.onCreate()。
        // super.onCreate() 内部会调用 bridgeBuilder.create() 生成桥接实例，
        // 之后注册的插件不会写入已创建的 Bridge，JS 侧 getPluginHeader 找不到。
        registerPlugin(APKUpdater.class);
        registerPlugin(PowerMonitor.class);
        registerPlugin(NativeHttp.class);
        registerPlugin(BackgroundRefresh.class);
        super.onCreate(savedInstanceState);

        // 状态栏透明 + WebView 全屏延伸到状态栏/摄像头区域。
        // 配合 CSS env(safe-area-inset-top) 让顶栏内容（标题/返回键）避让刘海/挖孔，
        // 不再「无脑贴 top:0」被摄像头挡住。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            // LAYOUT_FULLSCREEN 让 WebView 延伸到状态栏/摄像头下方；
            // 同时显式带 LIGHT_STATUS_BAR，否则 setSystemUiVisibility 会覆盖
            // styles.xml 的 windowLightStatusBar=true，导致部分机型把状态栏图标
            // 画成白色（在白底 header 上完全看不见）。LIGHT_STATUS_BAR=深色图标。
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // 始终启动定期恢复循环（前台服务可能尚未启动，Runnable 内部判断 isRunning）
        handler.post(resumeWebView);
    }

    @Override
    public void onResume() {
        super.onResume();
        // 回到前台，停止定期恢复
        handler.removeCallbacks(resumeWebView);
    }
}
