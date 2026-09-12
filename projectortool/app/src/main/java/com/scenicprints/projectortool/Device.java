package com.scenicprints.projectortool;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Random;

/**
 * Everything the tool knows how to ask or do, as plain static calls over a
 * Context — so the on-screen activity and the network bridge share one
 * implementation instead of drifting apart.
 */
final class Device {

    static final int PORT = 8099;
    private static final String PREFS = "projectortool";
    private static final String KEY_PIN = "pin";

    private Device() { }

    // ------------------------------------------------------------ inspection

    /** The engine version is the whole question on this device, and the user
     *  agent is the one place every Android version states it plainly.
     *
     *  Read it from the static WebSettings accessor, never by constructing a
     *  WebView: WebView's thread check doesn't throw where you call it, it posts
     *  the exception to the main thread, so a try/catch here cannot stop it and
     *  the whole process dies. This is called from the bridge's socket thread. */
    static String webViewSummary(Context c) {
        String ua = null;
        try {
            ua = WebSettings.getDefaultUserAgent(c);
        } catch (Throwable ignored) { /* a broken WebView must not kill the tool */ }

        String chrome = null;
        if (ua != null) {
            int i = ua.indexOf("Chrome/");
            if (i >= 0) {
                int end = ua.indexOf(' ', i);
                chrome = ua.substring(i + 7, end < 0 ? ua.length() : end);
            }
        }
        String pkg = webViewPackage(c);
        if (chrome == null) return pkg == null ? "unknown" : pkg;
        return "Chrome " + chrome + (pkg == null ? "" : "  (" + pkg + ")");
    }

    static String webViewPackage(Context c) {
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                PackageInfo pi = WebView.getCurrentWebViewPackage();
                if (pi != null) return pi.packageName + " " + pi.versionName;
            } catch (Throwable ignored) { }
        }
        for (String p : new String[]{"com.google.android.webview", "com.android.webview",
                "com.android.chrome", "com.google.android.trichromelibrary"}) {
            try {
                PackageInfo pi = c.getPackageManager().getPackageInfo(p, 0);
                return pi.packageName + " " + pi.versionName;
            } catch (PackageManager.NameNotFoundException ignored) { }
        }
        return null;
    }

    static String defaultHome(Context c) {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        ResolveInfo ri = c.getPackageManager().resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY);
        if (ri == null || ri.activityInfo == null) return "unknown";
        String pkg = ri.activityInfo.packageName;
        if (pkg.contains("android.internal") || "android".equals(pkg)) return "(not set - chooser)";
        return pkg;
    }

    static List<String> abis() {
        List<String> out = new ArrayList<>();
        if (Build.SUPPORTED_ABIS != null) Collections.addAll(out, Build.SUPPORTED_ABIS);
        return out;
    }

    static String localIp() {
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (ni.isLoopback() || !ni.isUp()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!a.isLoopbackAddress() && a.getAddress().length == 4) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    // --------------------------------------------------------------- actions

    static boolean openAny(Context c, Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** VAVA stripped the normal way in and different ROMs hide it differently,
     *  so try every known entry point and report which one answered. */
    static String openDeveloperOptions(Context c) {
        if (openAny(c, new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))) {
            return "the standard intent";
        }
        String[][] comps = {
                {"com.android.settings", "com.android.settings.DevelopmentSettings"},
                {"com.android.settings", "com.android.settings.Settings$DevelopmentSettingsActivity"},
                {"com.android.settings", "com.android.settings.development.DevelopmentSettingsDashboardActivity"},
                {"com.android.settings", "com.android.settings.DevelopmentSettingsDashboardActivity"},
        };
        for (String[] cm : comps) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(cm[0], cm[1]));
            if (openAny(c, i)) return cm[1];
        }
        return null;
    }

    static String openSettings(Context c, String which) {
        if (which == null) which = "all";
        switch (which) {
            case "dev": {
                String r = openDeveloperOptions(c);
                return r == null ? "could not open developer options" : "opened via " + r;
            }
            case "home": return openAny(c, new Intent(Settings.ACTION_HOME_SETTINGS)) ? "opened" : "failed";
            case "apps": return openAny(c, new Intent(Settings.ACTION_APPLICATION_SETTINGS)) ? "opened" : "failed";
            case "wifi": return openAny(c, new Intent(Settings.ACTION_WIFI_SETTINGS)) ? "opened" : "failed";
            default:     return openAny(c, new Intent(Settings.ACTION_SETTINGS)) ? "opened" : "failed";
        }
    }

    /** Fire the HOME intent. With no default launcher set the system answers with
     *  its own "Complete action using" chooser, which — unlike the phone-shaped
     *  Settings app on this firmware — actually takes D-pad input. */
    static String chooseHome(Context c) {
        Intent i = new Intent(Intent.ACTION_MAIN);
        i.addCategory(Intent.CATEGORY_HOME);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return openAny(c, i) ? "home fired - pick a launcher on the TV" : "failed";
    }

    static String launch(Context c, String pkg, String action, String comp) {
        if (pkg != null) {
            Intent i = c.getPackageManager().getLaunchIntentForPackage(pkg);
            if (i == null) return "no launch intent for " + pkg;
            return openAny(c, i) ? "launched " + pkg : "failed";
        }
        if (comp != null) {
            int slash = comp.indexOf('/');
            if (slash < 0) return "comp must be package/class";
            Intent i = new Intent();
            i.setComponent(new ComponentName(comp.substring(0, slash), comp.substring(slash + 1)));
            return openAny(c, i) ? "launched " + comp : "failed";
        }
        if (action != null) return openAny(c, new Intent(action)) ? "fired " + action : "failed";
        return "pass pkg, comp or action";
    }

    /** Open a url in a specific browser, or the system's choice. */
    static String openUrl(Context c, String url, String pkg) {
        if (url == null) return "pass url";
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        if (pkg != null && !pkg.isEmpty()) i.setPackage(pkg);
        return openAny(c, i) ? "opened" : "no handler";
    }

    static String uninstall(Context c, String pkg) {
        if (pkg == null) return "pass pkg";
        Intent i = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg));
        return openAny(c, i) ? "uninstall prompt shown for " + pkg : "failed";
    }

    /** Download an APK and hand it to the package installer. The confirm dialog
     *  is the system's; there is no way past it unprivileged. */
    static String installFromUrl(Context c, String url) {
        if (url == null) return "pass url";
        try {
            File apk = new File(c.getCacheDir(), "remote.apk");
            try (InputStream in = new URL(url).openStream();
                 FileOutputStream out = new FileOutputStream(apk)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            Uri uri = FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return openAny(c, i)
                    ? "installer opened for " + apk.length() + " bytes - confirm on the TV"
                    : "could not open the installer";
        } catch (Exception e) {
            return "failed: " + e;
        }
    }

    /** Since Jelly Bean an app only sees its own log lines, so this is our own
     *  trail rather than a system-wide view. */
    static String logcat() {
        try {
            Process p = Runtime.getRuntime().exec(new String[]{"logcat", "-d", "-t", "300"});
            StringBuilder b = new StringBuilder();
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            String l;
            while ((l = r.readLine()) != null) b.append(l).append('\n');
            return b.length() == 0 ? "(empty)" : b.toString();
        } catch (Exception e) {
            return "failed: " + e;
        }
    }

    // ------------------------------------------------------------------ json

    static String infoJson(Context c) {
        StringBuilder b = new StringBuilder("{");
        b.append(kv("manufacturer", Build.MANUFACTURER)).append(',');
        b.append(kv("model", Build.MODEL)).append(',');
        b.append(kv("device", Build.DEVICE)).append(',');
        b.append(kv("androidRelease", Build.VERSION.RELEASE)).append(',');
        b.append("\"sdkInt\":").append(Build.VERSION.SDK_INT).append(',');
        b.append(kv("fingerprint", Build.FINGERPRINT)).append(',');
        b.append(kv("abis", join(abis(), ","))).append(',');
        b.append(kv("webView", webViewSummary(c))).append(',');
        b.append(kv("webViewPackage", String.valueOf(webViewPackage(c)))).append(',');
        b.append(kv("defaultHome", defaultHome(c))).append(',');
        b.append(kv("ip", String.valueOf(localIp()))).append('}');
        return b.toString();
    }

    static String packagesJson(Context c) {
        PackageManager pm = c.getPackageManager();
        StringBuilder b = new StringBuilder("[");
        List<ApplicationInfo> apps = pm.getInstalledApplications(0);
        boolean first = true;
        for (ApplicationInfo ai : apps) {
            String ver = "";
            try { ver = pm.getPackageInfo(ai.packageName, 0).versionName; } catch (Exception ignored) { }
            if (!first) b.append(',');
            first = false;
            b.append('{').append(kv("package", ai.packageName)).append(',')
                    .append(kv("label", String.valueOf(ai.loadLabel(pm)))).append(',')
                    .append(kv("version", String.valueOf(ver))).append(',')
                    .append("\"system\":").append((ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0).append('}');
        }
        return b.append(']').toString();
    }

    static String ok(String message) { return "{" + kv("result", message) + "}"; }

    static String kv(String k, String v) { return "\"" + k + "\":\"" + esc(v == null ? "" : v) + "\""; }

    static String esc(String s) {
        StringBuilder b = new StringBuilder();
        for (char ch : s.toCharArray()) {
            switch (ch) {
                case '"':  b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n");  break;
                case '\r': b.append("\\r");  break;
                case '\t': b.append("\\t");  break;
                default:
                    if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
                    else b.append(ch);
            }
        }
        return b.toString();
    }

    static String join(List<String> items, String sep) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) b.append(sep);
            b.append(items.get(i));
        }
        return b.toString();
    }

    /** Stable across launches so a written-down PIN keeps working. */
    static String pin(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String existing = p.getString(KEY_PIN, null);
        if (existing != null) return existing;
        String made = String.format("%06d", new Random().nextInt(1000000));
        p.edit().putString(KEY_PIN, made).apply();
        return made;
    }
}
