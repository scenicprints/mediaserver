package com.scenicprints.marquee.projector;

import android.app.Activity;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;

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
    private GeckoView view;
    private boolean canGoBack;
    private long lastBackAt;

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

        view = new GeckoView(this);
        view.setSession(session);
        setContentView(view);
        view.requestFocus(); // content must hold focus or forwarded keys go nowhere
        goImmersive();

        session.loadUri(URL);
    }

    /**
     * Back belongs to the page, not to Android.
     *
     * The web UI drives its own layers — player, detail view, settings — off a
     * Backspace keydown, which is what the WebView TV app forwards. This build
     * didn't forward anything, so Back fell through to the activity and closed
     * the whole app from inside a movie.
     *
     * So: hand Back to content as Backspace (KEYCODE_DEL) and let the page close
     * whatever is on top. Then page history, if there is any. Leaving the app at
     * all takes a deliberate second press, because on a projector an accidental
     * exit mid-film is the worst outcome of the three.
     */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode != KeyEvent.KEYCODE_BACK) return super.onKeyDown(keyCode, event);

        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {   // second press, deliberately
            finish();
            return true;
        }
        lastBackAt = now;

        forwardToContent(KeyEvent.KEYCODE_DEL);
        if (canGoBack) session.goBack();
        else Toast.makeText(this, "Press Back again to leave Marquee", Toast.LENGTH_SHORT).show();
        return true;
    }

    /** Synthesise a key press into the page. GeckoView has no JS bridge, but it
     *  does route real key events to content once the view holds focus. */
    private void forwardToContent(int keyCode) {
        if (view == null) return;
        view.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, keyCode));
        view.dispatchKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, keyCode));
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
