package com.fundapp;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * APK 自更新插件
 * ------------------------------------------------------------
 * 解决一件事：需要重新打包 APK 时，用户不用等开发者手动发文件过来。
 *
 * 流程：App 内下载 APK 到缓存目录 → 调系统安装器 → 用户点「安装」。
 *
 * 为什么必须有原生代码：
 *   安装 APK 要发 Intent.ACTION_VIEW 给系统安装器，
 *   这是纯 Web 层做不到的。
 *
 * 为什么需要 REQUEST_INSTALL_PACKAGES 权限：
 *   Android 8.0 起，安装非应用商店来源的 APK 需要用户显式授权
 *   「安装未知应用」。这个权限声明在 AndroidManifest 里，
 *   但实际开关由用户在系统设置里控制，代码只能引导他过去打开。
 *
 * 注意：下载完 APK 后，Android 会杀掉本 App 进程（程序文件正在被替换），
 *   所以安装完必须由用户手动重新打开 App —— 这是系统设计，绕不过。
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    /** 查是否已允许「安装未知应用」 */
    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean allowed = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            allowed = getContext().getPackageManager().canRequestPackageInstalls();
        }
        JSObject ret = new JSObject();
        ret.put("allowed", allowed);
        call.resolve(ret);
    }

    /** 打开「安装未知应用」的系统设置页，让用户去打开开关 */
    @PluginMethod
    public void openInstallPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }

    /** 下载 APK 并拉起系统安装器 */
    @PluginMethod
    public void downloadAndInstall(final PluginCall call) {
        final String urlStr = call.getString("url");
        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("缺少 url 参数");
            return;
        }

        // 先检查安装权限，没有就明确告诉 JS 层去引导用户
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            JSObject ret = new JSObject();
            ret.put("needPermission", true);
            call.reject("需要先允许「安装未知应用」", "NEED_INSTALL_PERMISSION", ret);
            return;
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File dir = new File(getContext().getCacheDir(), "apk");
                    if (!dir.exists() && !dir.mkdirs()) {
                        call.reject("无法创建缓存目录");
                        return;
                    }

                    File out = new File(dir, "update.apk");
                    if (out.exists() && !out.delete()) {
                        call.reject("无法清理上一次的安装包");
                        return;
                    }

                    HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(120000);
                    conn.setInstanceFollowRedirects(true);
                    conn.connect();

                    int code = conn.getResponseCode();
                    if (code != HttpURLConnection.HTTP_OK) {
                        conn.disconnect();
                        call.reject("下载失败：HTTP " + code);
                        return;
                    }

                    InputStream in = conn.getInputStream();
                    FileOutputStream fos = new FileOutputStream(out);
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        fos.write(buf, 0, n);
                    }
                    fos.flush();
                    fos.close();
                    in.close();
                    conn.disconnect();

                    if (!out.exists() || out.length() <= 0) {
                        call.reject("下载的安装包为空");
                        return;
                    }

                    Uri uri = FileProvider.getUriForFile(
                            getContext(),
                            getContext().getPackageName() + ".fileprovider",
                            out
                    );

                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(uri, "application/vnd.android.package-archive");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);

                    JSObject ret = new JSObject();
                    ret.put("size", out.length());
                    call.resolve(ret);

                } catch (Exception e) {
                    String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                    call.reject("下载或安装失败：" + msg);
                }
            }
        }).start();
    }
}
