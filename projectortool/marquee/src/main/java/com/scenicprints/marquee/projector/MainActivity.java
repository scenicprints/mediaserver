package com.scenicprints.marquee.projector;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;

import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;

/**
 * Marquee on the VAVA projector, with its own browser engine.
 *
 * The projector's system WebView is com.android.webview 52.0.2743.100 — Chrome
 * 52, from 2016 — and it's the AOSP package, signature-locked to the firmware,
 * so it can neither be updated nor replaced. It cannot parse the web UI at all.
 * Loading the site in Samsung Internet worked but put a browser around it.
 *
 * GeckoView is Firefox's engine shipped inside this APK, so the system's is
 * irrelevant. Full screen, no chrome, no address bar: the same shape as the
 * Android TV app on a TV that has a usable WebView.
 *
 * Not ported yet: the MarqueeTV JS bridge (streaming deep-links, the libVLC
 * handoff). GeckoView has no addJavascriptInterface — it uses WebExtension
 * messaging — so the web player does playback here for now.
 */
public class MainActivity extends Activity {

    private static final String URL = "https://marqu33.duckdns.org/?tv=1";

    private GeckoSession session;
    private boolean canGoBack;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        GeckoRuntime runtime = GeckoRuntime.getDefault(this);
        runtime.getSettings().setAutomaticFontSizeAdjustment(false);

        session = new GeckoSession();
        session.setNavigationDelegate(new GeckoSession.NavigationDelegate() {
            @Override
            public void onCanGoBack(GeckoSession s, boolean value) {
                canGoBack = value;
            }
        });
        session.open(runtime);

        GeckoView view = new GeckoView(this);
        view.setSession(session);
        setContentView(view);
        goImmersive();

        session.loadUri(URL);
    }

    /**
     * Back walks the page's own history, matching the TV app. Only when there's
     * nothing left to go back to does it leave, so a stray Back press doesn't
     * dump the viewer out to the launcher mid-browse.
     */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && canGoBack) {
            session.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goImmersive();
    }

    private void goImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    protected void onDestroy() {
        if (session != null) session.close();
        super.onDestroy();
    }
}
