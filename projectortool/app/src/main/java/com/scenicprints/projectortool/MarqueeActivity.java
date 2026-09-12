package com.scenicprints.projectortool;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

import java.util.List;

/**
 * A home-screen icon that opens the Marquee web UI and nothing else.
 *
 * The projector's system WebView predates Chrome 55, so the native Marquee app
 * can't render the page. Firefox brings its own engine, but making the owner
 * open a browser and type an address every time is not a UI. This activity is
 * the icon: tap it, land in Marquee, no address bar.
 */
public class MarqueeActivity extends Activity {

    private static final String URL = "https://marqu33.duckdns.org/?tv=1";

    /** Browsers that ship their own engine, best first. Firefox for Fire TV is
     *  built for a D-pad remote, so it leads. Samsung Internet is next because
     *  it's already on this projector and is Chromium 87 — new enough for
     *  everything the UI uses, where the system WebView is Chrome 52. */
    private static final String[] PREFERRED = {
            "org.mozilla.tv.firefox",
            "com.sec.android.app.sbrowser",
            "org.mozilla.firefox",
            "org.mozilla.fennec_fdroid",
            "com.android.chrome",
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        for (String pkg : PREFERRED) {
            if (launch(pkg)) { finish(); return; }
        }
        // Nothing preferred is installed: let the system offer whatever can open
        // a link. On a stock VAVA that may be nothing at all, hence the message.
        if (launch(null)) { finish(); return; }

        Toast.makeText(this,
                "No browser installed. Install Firefox from Aptoide, then tap this again.",
                Toast.LENGTH_LONG).show();
        finish();
    }

    /** @param pkg a specific browser package, or null to let the system choose. */
    private boolean launch(String pkg) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(URL));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (pkg != null) {
            // Only target this browser if it's actually present — setPackage on a
            // missing app throws, and we'd rather fall through to the next one.
            i.setPackage(pkg);
            List<ResolveInfo> hits = getPackageManager().queryIntentActivities(i, 0);
            if (hits == null || hits.isEmpty()) return false;
        }
        try {
            startActivity(i);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }
}
