# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# ============================================
# 基本配置
# ============================================
-keepattributes SourceFile,LineNumberTable
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes Exceptions
-keepattributes InnerClasses

# ============================================
# Capacitor
# ============================================
-keep class com.getcapacitor.** { *; }
-keep class com.capacitor.** { *; }

# ============================================
# 本地自定义插件（必须 keep，否则 release 混淆后反射找不到类）
# ============================================
-keep class com.fundsandbox.app.** { *; }
-keepclassmembers class com.fundsandbox.app.** { *; }

# ============================================
# @capgo/capacitor-updater（CapacitorUpdaterPlugin）
# ============================================
-keep class ee.forgr.capacitor_updater.** { *; }
-keepclassmembers class ee.forgr.capacitor_updater.** { *; }

# ============================================
# OkHttp (网络请求)
# ============================================
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-keepnames class okhttp3.internal.publicsuffix.PublicSuffixDatabase

# ============================================
# AndroidX
# ============================================
-keep class androidx.** { *; }
-keep interface androidx.** { *; }

# ============================================
# Google Play Services
# ============================================
-keep class com.google.android.gms.** { *; }
-dontwarn com.google.android.gms.**

# ============================================
# 极光/个推 推送 (如果使用)
# ============================================
# -keep class cn.jiguang.** { *; }
# -keep class com.getui.** { *; }

# ============================================
# WebView 保护
# ============================================
-keepclassmembers class * extends android.webkit.WebViewClient {
    public void *(android.webkit.WebView, java.lang.String, android.graphics.Bitmap);
    public boolean *(android.webkit.WebView, java.lang.String);
}
-keepclassmembers class * extends android.webkit.WebChromeClient {
    public void *(android.webkit.WebView, java.lang.String);
}

# ============================================
# 混淆时保留日志 (调试时可关闭)
# ============================================
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
}

# ============================================
# SQLCipher（@capacitor-community/sqlite 加密模式）
# release 混淆后启动即崩
#   NoSuchFieldError: no "J" field "mNativeHandle" in
#   class "net.sqlcipher.database.SQLiteDatabase"
# 原因：R8 把 SQLCipher 字段名改了，而它的 native .so 仍按
#      原名反射找字段 → SIGABRT。必须 keep 字段名。
# ============================================
-keep class net.sqlcipher.** { *; }
-keep class net.sqlcipher.database.** { *; }
-keepclassmembers class net.sqlcipher.** { *; }
-keepclassmembers class net.sqlcipher.database.** { *; }
# sqlite-android 自身的 JNI 回调
-keep class com.getcapacitor.community.database.** { *; }
-keepclassmembers class com.getcapacitor.community.database.** { *; }
# 第三方加密库（若启用）
-keep class androidx.sqlite.** { *; }
-dontwarn net.sqlcipher.**
-dontwarn com.getcapacitor.community.database.**
