package com.fundsandbox.app;

import android.net.Uri;
import androidx.annotation.NonNull;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native HTTP 插件：直接使用 Java HttpURLConnection，绕过 WebView fetch 的 DNS/TLS 问题。
 * Android 13 WebView 的 fetch() 可能解析失败，而系统网络请求正常，问题在 WebView 网络栈。
 */
@CapacitorPlugin(name = "NativeHttp")
public class NativeHttp extends Plugin {

    private static final int DEFAULT_TIMEOUT_MS = 30000;
    private static final ExecutorService executor = Executors.newFixedThreadPool(3);

    // 信任所有证书的 TrustManager（用于处理 IP 直连导致的 TLS SAN 不匹配）
    private static final TrustManager[] ALL_TRUSTING = new TrustManager[]{
        new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] chain, String authType) {}
            public void checkServerTrusted(X509Certificate[] chain, String authType) {}
        }
    };
    private static final SSLContext sslContext;
    private static final HostnameVerifier allHostsValid = (hostname, session) -> true;
    static {
        try {
            sslContext = SSLContext.getInstance("TLS");
            sslContext.init(null, ALL_TRUSTING, new SecureRandom());
        } catch (Exception e) {
            throw new RuntimeException("SSL init failed", e);
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String urlStr = call.getString("url");
        int timeoutMs = call.getInt("timeout", DEFAULT_TIMEOUT_MS);
        JSObject headers = call.getObject("headers");

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("url is required");
            return;
        }

        executor.execute(() -> {
            try {
                String result = fetchUrl(urlStr, timeoutMs, headers);
                com.getcapacitor.JSObject out = new com.getcapacitor.JSObject();
                out.put("result", result);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("request failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void post(PluginCall call) {
        String urlStr = call.getString("url");
        int timeoutMs = call.getInt("timeout", DEFAULT_TIMEOUT_MS);
        JSObject headers = call.getObject("headers");
        String body = call.getString("body", "");

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("url is required");
            return;
        }

        executor.execute(() -> {
            try {
                String result = fetchUrl(urlStr, timeoutMs, headers, "POST", body);
                com.getcapacitor.JSObject out = new com.getcapacitor.JSObject();
                out.put("result", result);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("request failed: " + e.getMessage(), e);
            }
        });
    }

    private String fetchUrl(String urlStr, int timeoutMs, JSObject headers) throws IOException {
        return fetchUrl(urlStr, timeoutMs, headers, "GET", null);
    }

    private String fetchUrl(String urlStr, int timeoutMs, JSObject headers, String method, String body) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) java.net.URI.create(urlStr).toURL().openConnection();

        // 如果是 HTTPS 且 URL 包含 IP 地址，配置 SSL 绕过证书验证
        if (urlStr.startsWith("https://")) {
            Uri uri = Uri.parse(urlStr);
            String host = uri.getHost();
            if (host != null && host.matches("\\d+\\.\\d+\\.\\d+\\.\\d+")) {
                ((HttpsURLConnection) conn).setSSLSocketFactory(sslContext.getSocketFactory());
                ((HttpsURLConnection) conn).setHostnameVerifier(allHostsValid);
            }
        }

        conn.setRequestMethod(method);
        if ("POST".equalsIgnoreCase(method)) {
            conn.setDoOutput(true);
        }
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setRequestProperty("User-Agent",
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
        conn.setRequestProperty("Accept", "*/*");
        if ("POST".equalsIgnoreCase(method)) {
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        }

        // 应用调用方传入的请求头（如新浪必需的 Referer）
        if (headers != null) {
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String k = it.next();
                String v = headers.getString(k);
                if (k != null && v != null && !v.isEmpty()) {
                    conn.setRequestProperty(k, v);
                }
            }
        }

        // IP 直连时必须设置 Host header，否则 CDN/负载均衡器返回 403
        Uri uri = Uri.parse(urlStr);
        String host = uri.getHost();
        if (host != null && !host.matches("\\d+\\.\\d+\\.\\d+\\.\\d+")) {
            // 域名 URL：使用 URL 中的 host（已自动设置）
        } else if (host != null) {
            // IP 直连：映射到对应域名作为 Host header
            if ("61.129.129.60".equals(host)) conn.setRequestProperty("Host", "fundmobapi.eastmoney.com");
            else if ("182.140.249.95".equals(host)) conn.setRequestProperty("Host", "fund.eastmoney.com");
        }

        // POST：写入请求体（必须在 getResponseCode 之前）
        if ("POST".equalsIgnoreCase(method) && body != null && !body.isEmpty()) {
            try (java.io.OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes("UTF-8"));
                os.flush();
            }
        }

        int responseCode = conn.getResponseCode();
        InputStream is = responseCode >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (is == null) return "";

        // 检测响应编码：优先从 Content-Type 获取，fallback 到 GBK（新浪财经等中文API）
        String charset = "UTF-8";
        String contentType = conn.getContentType();
        if (contentType != null && contentType.contains("charset=")) {
            String[] parts = contentType.split(";");
            for (String part : parts) {
                String trimmed = part.trim().toLowerCase();
                if (trimmed.startsWith("charset=")) {
                    charset = trimmed.substring("charset=".length()).trim();
                    break;
                }
            }
        }
        // 新浪等中文 API 返回 GBK/GB18030，统一转换
        if (!charset.equalsIgnoreCase("UTF-8")
                && !charset.equalsIgnoreCase("ISO-8859-1")) {
            charset = "GBK";
        }

        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, charset))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
        }
        return sb.toString();
    }

}
