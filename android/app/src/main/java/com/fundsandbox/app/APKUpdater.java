package com.fundsandbox.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;

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
 * APKUpdater — 下载远程 APK 并触发系统安装。
 *
 * JS 侧调用：
 *   const plugin = Capacitor.getPlugin('APKUpdater');
 *   await plugin.downloadAndInstall({ url: apkUrl });
 */
@CapacitorPlugin(name = "APKUpdater")
public class APKUpdater extends Plugin {

    private static final String APK_DIR = "apks";
    private static final String APK_FILENAME = "update.apk";

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("缺少 url 参数");
            return;
        }

        new Thread(() -> {
            try {
                File cacheDir = getActivity().getCacheDir();
                File apkDir = new File(cacheDir, APK_DIR);
                if (!apkDir.exists()) apkDir.mkdirs();

                File apkFile = new File(apkDir, APK_FILENAME);

                HttpURLConnection conn = (HttpURLConnection) java.net.URI.create(url).toURL().openConnection();
                conn.setConnectTimeout(30_000);
                conn.setReadTimeout(300_000);
                conn.setRequestProperty("User-Agent", "FundSandbox/1.0");

                int code = conn.getResponseCode();
                if (code != HttpURLConnection.HTTP_OK) {
                    fail(call, "下载失败：HTTP " + code);
                    return;
                }

                long total = conn.getContentLengthLong();
                long downloaded = 0;
                int lastProgress = -1;

                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(apkFile)) {
                    byte[] buf = new byte[8192];
                    int len;
                    while ((len = in.read(buf)) != -1) {
                        out.write(buf, 0, len);
                        downloaded += len;
                        if (total > 0) {
                            int pct = (int) (downloaded * 100L / total);
                            if (pct != lastProgress && pct % 10 == 0) {
                                lastProgress = pct;
                                notifyListeners("downloadProgress",
                                    new JSObject().put("percent", pct).put("downloaded", downloaded).put("total", total));
                            }
                        }
                    }
                }

                // 下载完成，触发系统安装器
                Uri uri = FileProvider.getUriForFile(
                    getActivity(),
                    getActivity().getPackageName() + ".fileprovider",
                    apkFile
                );

                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (!getActivity().getPackageManager().canRequestPackageInstalls()) {
                        fail(call, "系统不允许自动安装，请在设置中允许来源");
                        return;
                    }
                }

                getActivity().startActivity(intent);
                call.resolve(new JSObject().put("path", apkFile.getAbsolutePath()));

            } catch (Exception e) {
                fail(call, "下载并安装失败：" + e.getMessage());
            }
        }).start();

        call.setKeepAlive(true);
    }

    private void fail(PluginCall call, String msg) {
        getActivity().runOnUiThread(() -> call.reject(msg));
    }
}
