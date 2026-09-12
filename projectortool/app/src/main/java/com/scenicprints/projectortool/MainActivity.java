package com.scenicprints.projectortool;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * The on-screen half: what this projector actually is, and the handful of
 * screens its own menus don't offer a way to reach.
 *
 * The network bridge lives in {@link BridgeService}, not here, so it survives
 * this activity being backgrounded.
 */
public class MainActivity extends Activity {

    private TextView report;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildUi());
        startBridge();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshReport(); // the default launcher may have changed while we were away
    }

    private void startBridge() {
        Intent i = new Intent(this, BridgeService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
    }

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

        // First, because it's the one the remote can actually drive: the system
        // launcher chooser takes D-pad input, while this firmware's Settings app
        // is a phone layout that won't move focus.
        col.addView(button("Set the home screen (launcher chooser)", v ->
                say(Device.chooseHome(this))));
        col.addView(button("Open Developer Options", v -> {
            String which = Device.openDeveloperOptions(this);
            say(which == null ? "Could not open Developer Options by any route."
                              : "Opened via " + which);
        }));
        col.addView(button("Open All Settings", v -> say(Device.openSettings(this, "all"))));
        col.addView(button("Open Wi-Fi Settings", v -> say(Device.openSettings(this, "wifi"))));
        col.addView(button("Refresh", v -> refreshReport()));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(col, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return scroll;
    }

    private void refreshReport() {
        String ip = Device.localIp();
        String s = "Device      " + Build.MANUFACTURER + ' ' + Build.MODEL + '\n'
                + "Android     " + Build.VERSION.RELEASE + "  (API " + Build.VERSION.SDK_INT + ")\n"
                + "CPU         " + Device.join(Device.abis(), ", ") + '\n'
                + "WebView     " + Device.webViewSummary(this) + '\n'
                + "Home app    " + Device.defaultHome(this) + '\n'
                + '\n'
                + "Reach me at http://" + (ip == null ? "(no network)" : ip) + ':' + Device.PORT + '\n'
                + "PIN         " + Device.pin(this) + '\n'
                + '\n'
                + "The bridge keeps running when you leave this screen.";
        report.setText(s);
    }

    private void say(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        refreshReport();
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setTypeface(bold ? Typeface.DEFAULT_BOLD : Typeface.MONOSPACE);
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
