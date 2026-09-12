package com.scenicprints.projectortool;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.core.content.FileProvider;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * A service hatch for the VAVA projector.
 *
 * On screen it answers the questions you otherwise have to guess at from the
 * couch: what Android this really is, which WebView it has, what its address is.
 * Over the network it exposes the same information plus the ability to open any
 * settings screen and install an APK, so the projector can be worked on from a
 * laptop instead of through a remote control.
 *
 * Deliberate ceiling: an unprivileged app cannot write secure settings, so it
 * cannot enable ADB, change the default launcher, or swap the WebView on its
 * own. Those actions are *opened* here and confirmed by whoever is holding the
 * remote. Anything read-only needs nobody.
 */
public class MainActivity extends Activity {

    private static final int PORT = 8099;
    private static final String PREFS = "projectortool";
    private static final String KEY_PIN = "pin";

    private String pin;
    private TextView report;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pin = loadOrMakePin();
        setContentView(buildUi());
        startServer();
    }

    // ---------------------------------------------------------------- screen

    private View buildUi() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(28);
        col.setPadding(pad, pad, pad, pad);
        col.setBackgroundColor(Color.BLACK);

        col.addView(text("PROJECTOR TOOL", 26, Color.WHITE, true));
        report = text("", 17, Color.parseColor("#B6E3FF"), false);
        report.setPadding(0, dp(14), 0, dp(20));
        col.addView(report);
        refreshReport();

        col.addView(button("Open Developer Options", v -> {
            String which = openDeveloperOptions();
            toastLine(which == null
                    ? "Could not open Developer Options by any route."
                    : "Opened via " + which);
        }));
        col.addView(button("Open Home App Picker", v ->
                openAny(new Intent(Settings.ACTION_HOME_SETTINGS))));
        col.addView(button("Open All Settings", v ->
                openAny(new Intent(Settings.ACTION_SETTINGS))));
        col.addView(button("Open Wi-Fi Settings", v ->
                openAny(new Intent(Settings.ACTION_WIFI_SETTINGS))));
        col.addView(button("Refresh", v -> refreshReport()));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return scroll;
    }

    private void refreshReport() {
        StringBuilder b = new StringBuilder();
        b.append("Device      ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n');
        b.append("Android     ").append(Build.VERSION.RELEASE)
                .append("  (API ").append(Build.VERSION.SDK_INT).append(")\n");
        b.append("CPU         ").append(join(supportedAbis(), ", ")).append('\n');
        b.append("WebView     ").append(webViewSummary()).append('\n');
        b.append("Home app    ").append(defaultHome()).append('\n');
        b.append('\n');
        String ip = localIp();
        b.append("Reach me at http://").append(ip == null ? "(no network)" : ip)
                .append(':').append(PORT).append('\n');
        b.append("PIN         ").append(pin);
        report.setText(b.toString());
    }

    // ------------------------------------------------------------ inspection

    /** The engine version is the whole question on this device, and the user
     *  agent is the one place every Android version reports it plainly. */
    private String webViewSummary() {
        String ua = null;
        try {
            ua = new WebView(this).getSettings().getUserAgentString();
        } catch (Throwable ignored) { /* a broken WebView must not kill the tool */ }

        String chrome = null;
        if (ua != null) {
            int i = ua.indexOf("Chrome/");
            if (i >= 0) {
                int end = ua.indexOf(' ', i);
                chrome = ua.substring(i + 7, end < 0 ? ua.length() : end);
            }
        }

        String pkg = webViewPackage();
        if (chrome == null) return pkg == null ? "unknown" : pkg;
        return "Chrome " + chrome + (pkg == null ? "" : "  (" + pkg + ")");
    }

    private String webViewPackage() {
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                PackageInfo pi = WebView.getCurrentWebViewPackage();
                if (pi != null) return pi.packageName + " " + pi.versionName;
            } catch (Throwable ignored) { }
        }
        // Pre-26 there is no public accessor, so fall back to whichever of the
        // known provider packages is actually installed.
        for (String p : new String[]{"com.google.android.webview", "com.android.webview",
                "com.android.chrome", "com.google.android.trichromelibrary"}) {
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(p, 0);
                return pi.packageName + " " + pi.versionName;
            } catch (PackageManager.NameNotFoundException ignored) { }
        }
        return null;
    }

    private String defaultHome() {
        Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME);
        ResolveInfo ri = getPackageManager().resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY);
        if (ri == null || ri.activityInfo == null) return "unknown";
        String pkg = ri.activityInfo.packageName;
        // The chooser itself resolving means no launcher has been made default.
        if (pkg.contains("android.internal") || "android".equals(pkg)) return "(not set - chooser)";
        return pkg;
    }

    private List<String> supportedAbis() {
        List<String> out = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 21 && Build.SUPPORTED_ABIS != null) {
            Collections.addAll(out, Build.SUPPORTED_ABIS);
        }
        return out;
    }

    private String localIp() {
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (ni.isLoopback() || !ni.isUp()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!a.isLoopbackAddress() && a.getAddress().length == 4) {
                        return a.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    // --------------------------------------------------------------- actions

    /** VAVA stripped the normal way in, and different ROMs hide it differently,
     *  so try every known entry point and report which one answered. */
    private String openDeveloperOptions() {
        Intent byAction = new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS);
        if (openAny(byAction)) return "the standard intent";

        String[][] comps = {
                {"com.android.settings", "com.android.settings.DevelopmentSettings"},
                {"com.android.settings", "com.android.settings.Settings$DevelopmentSettingsActivity"},
                {"com.android.settings", "com.android.settings.development.DevelopmentSettingsDashboardActivity"},
                {"com.android.settings", "com.android.settings.DevelopmentSettingsDashboardActivity"},
        };
        for (String[] c : comps) {
            Intent i = new Intent();
            i.setComponent(new ComponentName(c[0], c[1]));
            if (openAny(i)) return c[1];
        }
        return null;
    }

    private boolean openAny(Intent i) {
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** Download an APK and hand it to the package installer. The confirm dialog
     *  on the TV is the system's, and there is no way around it unprivileged. */
    private String installFromUrl(String url) {
        try {
            File apk = new File(getCacheDir(), "remote.apk");
            try (InputStream in = new URL(url).openStream();
                 FileOutputStream out = new FileOutputStream(apk)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            runOnUiThread(() -> startActivity(i));
            return "installer opened for " + apk.length() + " bytes - confirm on the TV";
        } catch (Exception e) {
            return "failed: " + e;
        }
    }

    // ---------------------------------------------------------------- bridge

    private void startServer() {
        new Thread(() -> {
            try (ServerSocket server = new ServerSocket(PORT)) {
                while (!Thread.currentThread().isInterrupted()) {
                    Socket s = server.accept();
                    new Thread(() -> serve(s)).start();
                }
            } catch (Exception ignored) { /* port taken / app closing */ }
        }, "projector-bridge").start();
    }

    private void serve(Socket socket) {
        try (Socket s = socket) {
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            String line = in.readLine();
            if (line == null) return;
            String[] parts = line.split(" ");
            if (parts.length < 2) return;

            String target = parts[1];
            String path = target;
            Map<String, String> q = new LinkedHashMap<>();
            int qm = target.indexOf('?');
            if (qm >= 0) {
                path = target.substring(0, qm);
                for (String pair : target.substring(qm + 1).split("&")) {
                    int eq = pair.indexOf('=');
                    if (eq < 0) continue;
                    q.put(dec(pair.substring(0, eq)), dec(pair.substring(eq + 1)));
                }
            }

            if ("/".equals(path)) {
                send(s, 200, "text/plain; charset=utf-8",
                        "Projector Tool. Add ?pin=" + "NNNNNN" + " to every call.\n"
                                + "/info /packages /launch /settings /install /open /logcat\n");
                return;
            }
            if (!pin.equals(q.get("pin"))) {
                send(s, 403, "application/json", "{\"error\":\"bad or missing pin\"}");
                return;
            }

            switch (path) {
                case "/info":     send(s, 200, "application/json", infoJson()); break;
                case "/packages": send(s, 200, "application/json", packagesJson()); break;
                case "/logcat":   send(s, 200, "text/plain; charset=utf-8", logcat()); break;
                case "/settings": send(s, 200, "application/json",
                        ok(openSettings(q.get("s")))); break;
                case "/launch":   send(s, 200, "application/json",
                        ok(launch(q.get("pkg"), q.get("action"), q.get("comp")))); break;
                case "/open":     send(s, 200, "application/json",
                        ok(openAny(new Intent(Intent.ACTION_VIEW, Uri.parse(q.get("url"))))
                                ? "opened" : "no handler")); break;
                case "/install":  send(s, 200, "application/json",
                        ok(installFromUrl(q.get("url")))); break;
                default:          send(s, 404, "application/json", "{\"error\":\"no such route\"}");
            }
        } catch (Exception ignored) { }
    }

    private String openSettings(String which) {
        if (which == null) which = "all";
        switch (which) {
            case "dev": {
                String r = openDeveloperOptions();
                return r == null ? "could not open developer options" : "opened via " + r;
            }
            case "home": return openAny(new Intent(Settings.ACTION_HOME_SETTINGS)) ? "opened" : "failed";
            case "apps": return openAny(new Intent(Settings.ACTION_APPLICATION_SETTINGS)) ? "opened" : "failed";
            case "wifi": return openAny(new Intent(Settings.ACTION_WIFI_SETTINGS)) ? "opened" : "failed";
            default:     return openAny(new Intent(Settings.ACTION_SETTINGS)) ? "opened" : "failed";
        }
    }

    private String launch(String pkg, String action, String comp) {
        if (pkg != null) {
            Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
            if (i == null) return "no launch intent for " + pkg;
            return openAny(i) ? "launched " + pkg : "failed";
        }
        if (comp != null) {
            int slash = comp.indexOf('/');
            if (slash < 0) return "comp must be package/class";
            Intent i = new Intent();
            i.setComponent(new ComponentName(comp.substring(0, slash), comp.substring(slash + 1)));
            return openAny(i) ? "launched " + comp : "failed";
        }
        if (action != null) return openAny(new Intent(action)) ? "fired " + action : "failed";
        return "pass pkg, comp or action";
    }

    private String infoJson() {
        StringBuilder b = new StringBuilder("{");
        b.append(kv("manufacturer", Build.MANUFACTURER)).append(',');
        b.append(kv("model", Build.MODEL)).append(',');
        b.append(kv("device", Build.DEVICE)).append(',');
        b.append(kv("androidRelease", Build.VERSION.RELEASE)).append(',');
        b.append("\"sdkInt\":").append(Build.VERSION.SDK_INT).append(',');
        b.append(kv("fingerprint", Build.FINGERPRINT)).append(',');
        b.append(kv("abis", join(supportedAbis(), ","))).append(',');
        b.append(kv("webView", webViewSummary())).append(',');
        b.append(kv("webViewPackage", String.valueOf(webViewPackage()))).append(',');
        b.append(kv("defaultHome", defaultHome())).append(',');
        b.append(kv("ip", String.valueOf(localIp()))).append('}');
        return b.toString();
    }

    private String packagesJson() {
        StringBuilder b = new StringBuilder("[");
        List<ApplicationInfo> apps = getPackageManager().getInstalledApplications(0);
        boolean first = true;
        for (ApplicationInfo ai : apps) {
            String ver = "";
            try {
                ver = getPackageManager().getPackageInfo(ai.packageName, 0).versionName;
            } catch (Exception ignored) { }
            boolean system = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
            if (!first) b.append(',');
            first = false;
            b.append('{').append(kv("package", ai.packageName)).append(',')
                    .append(kv("label", String.valueOf(ai.loadLabel(getPackageManager())))).append(',')
                    .append(kv("version", String.valueOf(ver))).append(',')
                    .append("\"system\":").append(system).append('}');
        }
        return b.append(']').toString();
    }

    /** Since Jelly Bean an app only sees its own log lines, so this is our own
     *  crash trail rather than a system-wide view. Still the fastest way to find
     *  out why something here misbehaved. */
    private String logcat() {
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

    // ---------------------------------------------------------------- plumbing

    private static void send(Socket s, int code, String type, String body) throws Exception {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        OutputStream out = s.getOutputStream();
        String head = "HTTP/1.1 " + code + " OK\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + payload.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(payload);
        out.flush();
    }

    private static String ok(String message) {
        return "{" + kv("result", message) + "}";
    }

    private static String kv(String k, String v) {
        return "\"" + k + "\":\"" + esc(v == null ? "" : v) + "\"";
    }

    private static String esc(String s) {
        StringBuilder b = new StringBuilder();
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"':  b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n");  break;
                case '\r': b.append("\\r");  break;
                case '\t': b.append("\\t");  break;
                default:
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.toString();
    }

    private static String dec(String s) {
        try { return URLDecoder.decode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    private static String join(List<String> items, String sep) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) b.append(sep);
            b.append(items.get(i));
        }
        return b.toString();
    }

    /** Stable across launches so a written-down PIN keeps working. */
    private String loadOrMakePin() {
        SharedPreferences p = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String existing = p.getString(KEY_PIN, null);
        if (existing != null) return existing;
        String made = String.format("%06d", new Random().nextInt(1000000));
        p.edit().putString(KEY_PIN, made).apply();
        return made;
    }

    private void toastLine(String message) {
        android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show();
        refreshReport();
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(t.getTypeface(), android.graphics.Typeface.BOLD);
        else t.setTypeface(android.graphics.Typeface.MONOSPACE);
        return t;
    }

    private Button button(String label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        b.setAllCaps(false);
        b.setFocusable(true);
        b.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(10);
        b.setLayoutParams(lp);
        return b;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
