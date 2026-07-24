package com.scenicprints.marquee

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.URL

/**
 * A thin, full-screen WebView shell around the Marquee media server. It loads the
 * existing web UI (with ?tv=1, which hides the fullscreen button + cursor and
 * turns on TV mode). The web app's own focus engine drives the D-pad; login is
 * remembered by the server's HttpOnly cookie, so it's a one-time sign-in.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private val REQ_PLAYER = 4242

    // The server's public HTTPS address. `?tv=1` switches the web UI to TV mode.
    private val startUrl = "https://marqu33.duckdns.org/?tv=1"

    // The rolling release publishes version.json (latest versionCode + APK url).
    private val VERSION_URL =
        "https://github.com/scenicprints/mediaserver/releases/download/marquee-tv-latest/version.json"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Flight recorder: an uncaught native exception is recorded first, then
        // handed to the system (the app still crashes — but the NEXT launch
        // reports it to the server's telemetry, so remote crashes aren't silent).
        val prevHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            recordNativeEvent("crash", e.toString() + "\n" + e.stackTrace.take(6).joinToString("\n"))
            prevHandler?.uncaughtException(t, e)
        }

        web = WebView(this)
        setContentView(web)
        goImmersive()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true                  // localStorage: token mirror, tvMode
            mediaPlaybackRequiresUserGesture = false  // let the player start audio/video
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        // Bridge for the web app: streaming titles call MarqueeTV.openApp(url) so
        // they launch the real Netflix/Disney+/… app instead of loading the
        // service's website inside this WebView (a web page can't hand off to a
        // native app; only we can, from here).
        web.addJavascriptInterface(TvBridge(), "MarqueeTV")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                return false // keep every server page inside this WebView
            }
            override fun onPageFinished(view: WebView, url: String) {
                flushPendingNative() // report a crash/renderer-death from a previous run
            }
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                // The WebView renderer died (usually OOM on a low-RAM TV). Record
                // it and rebuild the activity instead of letting the app be killed.
                val why = if (Build.VERSION.SDK_INT >= 26 && detail.didCrash()) "renderer crashed" else "renderer killed (likely OOM)"
                recordNativeEvent("renderer-gone", why)
                recreate()
                return true
            }
        }
        web.webChromeClient = WebChromeClient()

        if (savedInstanceState == null) web.loadUrl(startUrl) else web.restoreState(savedInstanceState)

        checkForUpdate()
    }

    // Best-effort in-app updater: compare this build's versionCode against the
    // published version.json; if newer, download the signed APK and launch the
    // installer. Fully guarded + off the main thread, so it can never break the
    // app — worst case, self-update silently no-ops and the WebView still loads.
    private fun checkForUpdate() {
        Thread {
            try {
                val info = packageManager.getPackageInfo(packageName, 0)
                val current = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
                val meta = JSONObject(URL(VERSION_URL).readText())
                if (meta.getLong("versionCode") > current) {
                    val apk = File(cacheDir, "update.apk")
                    URL(meta.getString("url")).openStream().use { input ->
                        FileOutputStream(apk).use { input.copyTo(it) }
                    }
                    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apk)
                    startActivity(Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, "application/vnd.android.package-archive")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    })
                }
            } catch (_: Exception) { /* offline / no update / declined — ignore */ }
        }.start()
    }

    /** Exposed to the web app as `window.MarqueeTV`. The web UI calls openApp()
     *  for a streaming deep-link; we fire it from the native side so the OS can
     *  route it to the installed app. appVersion() feeds the telemetry boot event.
     *  playNative() hands playback to the libVLC PlayerActivity — the web checks
     *  for this method's existence to decide whether native playback is available. */
    inner class TvBridge {
        @JavascriptInterface
        fun openApp(url: String) { runOnUiThread { openExternal(url) } }
        @JavascriptInterface
        fun playNative(specJson: String) {
            runOnUiThread {
                try {
                    val u = Uri.parse(startUrl)
                    startActivityForResult(
                        Intent(this@MainActivity, PlayerActivity::class.java)
                            .putExtra("spec", specJson)
                            .putExtra("base", "${u.scheme}://${u.host}${if (u.port > 0) ":${u.port}" else ""}"),
                        REQ_PLAYER
                    )
                } catch (e: Exception) {
                    // Never strand the viewer: report failure so the web player takes over.
                    notifyNativeDone(false, true, 0.0)
                }
            }
        }
        @JavascriptInterface
        fun appVersion(): String = try {
            val info = packageManager.getPackageInfo(packageName, 0)
            val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
            "${info.versionName} ($code)"
        } catch (_: Exception) { "?" }
    }

    /** The native player finished (user backed out / episode ended / it failed):
     *  hand the outcome to the web app, which chains Up Next, falls back to the
     *  web player on failure, or just refreshes its resume state. */
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PLAYER) return
        notifyNativeDone(
            data?.getBooleanExtra("ended", false) ?: false,
            data?.getBooleanExtra("failed", false) ?: (resultCode != RESULT_OK),
            data?.getDoubleExtra("position", 0.0) ?: 0.0
        )
    }
    private fun notifyNativeDone(ended: Boolean, failed: Boolean, position: Double) {
        try {
            val json = JSONObject().put("ended", ended).put("failed", failed).put("position", position).toString()
            web.evaluateJavascript("window.__marqueeNativeDone && window.__marqueeNativeDone($json);", null)
        } catch (_: Exception) {}
    }

    // ---- Flight recorder (native side) ----
    // The web telemetry (window.tele) can't witness a native crash or a dead
    // WebView renderer, so those are captured here, parked in SharedPreferences,
    // and injected into the page's recorder on the next healthy page load.
    private fun recordNativeEvent(type: String, detail: String) {
        try {
            getSharedPreferences("marquee", MODE_PRIVATE).edit()
                .putString("pendingNative", JSONObject().put("type", type).put("stack", detail.take(1500)).toString())
                .apply()
        } catch (_: Exception) {}
    }
    private fun flushPendingNative() {
        try {
            val sp = getSharedPreferences("marquee", MODE_PRIVATE)
            val pending = sp.getString("pendingNative", null) ?: return
            sp.edit().remove("pendingNative").apply()
            web.evaluateJavascript("window.tele&&window.tele('native',$pending);", null)
        } catch (_: Exception) {}
    }
    /** Tell the page how a deep-link actually resolved (JSON-safe: package names only). */
    private fun teleDeeplink(result: String) {
        try {
            val safe = result.replace(Regex("[^A-Za-z0-9_.:-]"), "")
            web.evaluateJavascript("window.tele&&window.tele('deeplink',{result:'$safe'});", null)
        } catch (_: Exception) {}
    }

    // Streaming domains we hand off to a native app, each mapped to its known
    // Android TV package(s), best first. The bridge is only meant for these
    // deep-links from our own UI, so this doubles as an allowlist. These must
    // also be declared in the manifest's <queries> (Android 11+ hides other
    // packages from us otherwise).
    private val streamApps = mapOf(
        "netflix.com" to listOf("com.netflix.ninja"),
        "primevideo.com" to listOf("com.amazon.amazonvideo.livingroom", "com.amazon.avod.thirdpartyclient"),
        "amazon.com" to listOf("com.amazon.amazonvideo.livingroom", "com.amazon.avod.thirdpartyclient"),
        "disneyplus.com" to listOf("com.disney.disneyplus"),
        "hulu.com" to listOf("com.hulu.livingroomplus", "com.hulu.plus"),
        "max.com" to listOf("com.wbd.stream", "com.hbo.hbonow"),
        "tv.apple.com" to listOf("com.apple.atve.androidtv.appletv"),
        "paramountplus.com" to listOf("com.cbs.ott", "com.cbs.ca"),
        "peacocktv.com" to listOf("com.peacocktv.peacockandroid")
    )

    /** Launch a streaming URL in the service's real TV app. TV apps rarely
     *  register web intent-filters for their site URLs, so a plain ACTION_VIEW
     *  fell through to whatever calls itself a browser — on many TVs that's
     *  "Downloader" (the bug this replaces). Instead: try the URL scoped to each
     *  known package (lands in the app, on its title search if it takes URLs),
     *  then just open the app, and NEVER hand the URL to a browser. */
    private fun openExternal(url: String) {
        val uri = try { Uri.parse(url) } catch (_: Exception) { return }
        if (uri.scheme != "https") return
        val host = (uri.host ?: "").removePrefix("www.")
        val pkgs = streamApps.entries.firstOrNull { host == it.key || host.endsWith(".${it.key}") }?.value ?: return
        // 1) The URL, scoped to the service's own app.
        for (pkg in pkgs) {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                teleDeeplink("url:$pkg")
                return
            } catch (_: Exception) { /* not installed / doesn't take URLs — next */ }
        }
        // 2) At least open the app itself (its TV launcher entry).
        for (pkg in pkgs) {
            try {
                val launch = packageManager.getLeanbackLaunchIntentForPackage(pkg)
                    ?: packageManager.getLaunchIntentForPackage(pkg)
                if (launch != null) {
                    startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    teleDeeplink("launch:$pkg")
                    return
                }
            } catch (_: Exception) {}
        }
        // 3) Some other REAL app may claim the link (never a browser; only Android
        //    11+ can promise that, so older devices stop at the toast instead).
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                startActivity(
                    Intent(Intent.ACTION_VIEW, uri)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER)
                )
                teleDeeplink("nonbrowser")
                return
            } catch (_: Exception) {}
        }
        teleDeeplink("none:notinstalled")
        try {
            android.widget.Toast.makeText(this, "That app isn't installed on this TV", android.widget.Toast.LENGTH_LONG).show()
        } catch (_: Exception) {}
    }

    /** TV is always fullscreen: hide the status + navigation bars. */
    private fun goImmersive() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    /**
     * The remote's BACK button: forward it into the web app (focus.js uses
     * Backspace as Back) rather than closing the app. Use the TV Home button to
     * leave. (D-pad arrows/Enter flow to the WebView natively for focus.js.)
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            web.evaluateJavascript(
                "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',keyCode:8,which:8,bubbles:true}));",
                null
            )
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }
}
