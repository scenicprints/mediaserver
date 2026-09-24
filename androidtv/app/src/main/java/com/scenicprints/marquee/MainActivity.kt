package com.scenicprints.marquee

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.util.concurrent.Executors

/**
 * A thin, full-screen WebView shell around the Marquee media server. It loads the
 * existing web UI (with ?tv=1, which hides the fullscreen button + cursor and
 * turns on TV mode). The web app's own focus engine drives the D-pad; login is
 * remembered by the server's HttpOnly cookie, so it's a one-time sign-in.
 *
 * Which address it loads is decided by ServerResolver (docs/LAN.md): the home
 * network's direct address when the server proves itself there, else the public
 * name. Switching origin carries the session across so nobody signs in twice.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private val REQ_PLAYER = 4242

    // Picks between the public name and the server's LAN address, and remembers
    // what it learned. The page URL is always <base>/?tv=1 (TV mode) plus our
    // pair id, which the web app registers so we can learn the session token.
    private lateinit var resolver: ServerResolver
    private var activeBase = ServerResolver.PUBLIC_BASE
    private val ui = Handler(Looper.getMainLooper())
    // Separate threads so a slow learn (6 s worst case offline) never holds up a
    // resolve the viewer is waiting on.
    private val resolveExec = Executors.newSingleThreadExecutor()
    private val learnExec = Executors.newSingleThreadExecutor()

    // Resolve bookkeeping. All of it is touched on the main thread only.
    private var resolving = false
    private var resolveAgain = false        // something changed while a resolve ran
    private var resolveAfterPlayer = false  // a result arrived mid-playback; redo it after
    private var lastResolveAt = 0L
    private var playerOpen = false
    private var mainFrameFailed = false
    private var failStreak = 0
    private var nextFailResolveAt = 0L
    private var lastLearnAt = 0L
    private var learnTries = 0
    private var netCallback: ConnectivityManager.NetworkCallback? = null

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

        resolver = ServerResolver(this)
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
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                mainFrameFailed = false
            }
            override fun onPageFinished(view: WebView, url: String?) {
                flushPendingNative() // report a crash/renderer-death from a previous run
                if (!mainFrameFailed) {
                    failStreak = 0
                    nextFailResolveAt = 0L
                    learnSoon(url)
                }
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // Only the page itself failing means the server is out of reach; a
                // missing poster or a dropped fetch is the web app's business.
                if (!request.isForMainFrame) return
                mainFrameFailed = true
                resolveAfterFailure()
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

        // Restore the previous page only if its origin is one we still trust in
        // this process (after a process death a LAN origin has to prove itself
        // again, and restoring it would send it our cookie first). Otherwise the
        // resolve below picks the base and loads it.
        val savedOrigin = savedInstanceState?.getString("marqueeOrigin")
        if (savedInstanceState != null && savedOrigin != null && resolver.isTrusted(savedOrigin)) {
            web.restoreState(savedInstanceState)
            activeBase = savedOrigin
        }
        requestResolve()
        watchNetwork()

        checkForUpdate()
    }

    // ================= choosing the server address =================

    /** Run a resolve off the main thread and act on it. With nothing cached this
     *  returns the public base at once, so a first launch is not slowed down;
     *  with a LAN address cached the worst case is the ~6 s public probe. */
    private fun requestResolve() {
        if (isFinishing) return
        if (resolving) { resolveAgain = true; return }
        resolving = true
        lastResolveAt = SystemClock.elapsedRealtime()
        try {
            resolveExec.execute {
                val r = try { resolver.resolve() } catch (_: Exception) { ServerResolver.Result(null, false) }
                runOnUiThread { onResolved(r) }
            }
        } catch (_: Exception) { resolving = false } // executor already shut down
    }

    private fun onResolved(r: ServerResolver.Result) {
        resolving = false
        if (isFinishing || isDestroyed) return
        // Reloading now would pull the page out from under the player (and lose
        // the web app's Up Next hand-off). Ask again once the player is closed.
        if (playerOpen) { resolveAfterPlayer = true; return }

        val shown = ServerResolver.originOf(web.url)
        val target = r.base
        if (target == null) {
            // Nothing answered. Keep whatever is on screen, which shows its own
            // "can't reach" state, and keep retrying. With nothing on screen yet,
            // open the public name, never an unproven LAN address: loading it
            // would send that host our cookie.
            if (shown == null) loadBase(ServerResolver.PUBLIC_BASE)
            else if (mainFrameFailed) resolveAfterFailure()
        } else if (target != shown || mainFrameFailed) {
            // A different address, or the same one answering again after the page
            // failed and needing another go.
            loadBase(target)
        }
        if (resolveAgain) { resolveAgain = false; requestResolve() }
    }

    /** Point the WebView at a base, carrying the session over first. The pair id
     *  only goes to a base we trust (public HTTPS, or a LAN base that proved itself). */
    private fun loadBase(base: String) {
        val from = ServerResolver.originOf(web.url) ?: resolver.lastBase
        val trusted = resolver.isTrusted(base)
        if (trusted) handOver(base, switching = base != from)
        activeBase = base
        resolver.lastBase = base
        web.loadUrl(if (trusted) "$base/?tv=1&pair=${resolver.pairId}" else "$base/?tv=1")
    }

    /**
     * The WebView can't read the server's HttpOnly cookie, so the session token we
     * learned through the pair id is set as the new origin's `mstoken` cookie.
     * On a real switch it always overwrites: a cookie left on that origin by an
     * earlier outage may be dead, and ours is the newest we know. Reloading the
     * same origin leaves an existing cookie alone, because the server set that
     * one and it is fresher than ours if someone just signed in again.
     */
    private fun handOver(base: String, switching: Boolean) {
        val token = resolver.token ?: return
        try {
            val cm = CookieManager.getInstance()
            val has = Regex("(?:^|;\\s*)mstoken=").containsMatchIn(cm.getCookie(base) ?: "")
            if (has && !switching) return
            val secure = if (base.startsWith("https:")) "; Secure" else ""
            cm.setCookie(base, "mstoken=${Uri.encode(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax$secure")
            cm.flush()
        } catch (_: Exception) {}
    }

    // A main-frame load failed. Resolve again, backing off (10 s doubling to 2 min)
    // so a server that is simply down doesn't spin the TV in a reload loop. The
    // backoff resets once a page loads, or when the network itself changes.
    private val failResolve = Runnable {
        nextFailResolveAt = SystemClock.elapsedRealtime() + minOf(10_000L shl minOf(failStreak, 4), 120_000L)
        failStreak++
        requestResolve()
    }
    private fun resolveAfterFailure() {
        ui.removeCallbacks(failResolve)
        ui.postDelayed(failResolve, maxOf(0L, nextFailResolveAt - SystemClock.elapsedRealtime()))
    }

    /** Re-resolve when the network changes: joining the home Wi-Fi, losing the
     *  internet (Android drops VALIDATED), or getting it back. Callbacks arrive on
     *  a system thread, so everything hops to the main thread. */
    private fun watchNetwork() {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        // The first onAvailable only reports the network we launched on, which
        // the launch resolve already covers. With no network at launch it is a
        // real change, so it counts then.
        val launchedOnline = try { cm.activeNetwork != null } catch (_: Exception) { false }
        val cb = object : ConnectivityManager.NetworkCallback() {
            private var skipFirst = launchedOnline
            private var validated: Boolean? = null
            override fun onAvailable(network: Network) {
                if (skipFirst) { skipFirst = false; return }
                runOnUiThread { onNetworkChanged() }
            }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                val v = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                val prev = validated
                validated = v
                if (prev != null && prev != v) runOnUiThread { onNetworkChanged() }
            }
        }
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                cm.registerDefaultNetworkCallback(cb)
            } else {
                cm.registerNetworkCallback(
                    NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), cb
                )
            }
            netCallback = cb
        } catch (_: Exception) { /* no callback: launch and load-failure resolves still work */ }
    }

    private fun onNetworkChanged() {
        if (isFinishing || isDestroyed) return
        failStreak = 0
        nextFailResolveAt = 0L
        requestResolve()
    }

    // ================= learning the LAN address + session =================

    /** After a healthy page load on a trusted base, ask it for the LAN address,
     *  proof key and our session token. Throttled, since page loads come in bursts. */
    private fun learnSoon(url: String?) {
        val origin = ServerResolver.originOf(url) ?: return
        if (origin != activeBase || !resolver.isTrusted(origin)) return
        if (SystemClock.elapsedRealtime() - lastLearnAt < 20_000L) return
        learnTries = 0
        ui.removeCallbacks(learnRetry)
        learnNow()
    }

    private val learnRetry = Runnable { learnNow() }

    private fun learnNow() {
        val base = activeBase
        if (isFinishing || !resolver.isTrusted(base)) return
        lastLearnAt = SystemClock.elapsedRealtime()
        try {
            learnExec.execute {
                val gotToken = try { resolver.learn(base) } catch (_: Exception) { false }
                // The web app registers our pair id only once someone is signed
                // in, which on a first run happens well after this page load. Ask
                // again a few times so the token is in hand before it is needed.
                if (!gotToken) runOnUiThread {
                    if (!isDestroyed && learnTries < 4) {
                        learnTries++
                        ui.removeCallbacks(learnRetry)
                        ui.postDelayed(learnRetry, 45_000L)
                    }
                }
            }
        } catch (_: Exception) {} // executor already shut down
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
                    URL(updateUrlFor(meta)).openStream().use { input ->
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

    /** Pick the APK matching this device's ABI so a 32-bit device (the VAVA
     *  projector) never downloads the universal build's arm64 half. version.json
     *  carries a `urls` map keyed by ABI plus the plain `url` universal fallback,
     *  which is what older installs read — so both formats keep working. */
    private fun updateUrlFor(meta: JSONObject): String {
        val urls = meta.optJSONObject("urls")
        if (urls != null) {
            for (abi in Build.SUPPORTED_ABIS) {
                if (urls.has(abi)) return urls.getString(abi)
            }
        }
        return meta.getString("url")
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
                    // The origin the page is actually on: that is where the session
                    // cookie lives and where the spec's paths point, LAN or public.
                    val base = ServerResolver.originOf(web.url) ?: activeBase
                    startActivityForResult(
                        Intent(this@MainActivity, PlayerActivity::class.java)
                            .putExtra("spec", specJson)
                            .putExtra("base", base),
                        REQ_PLAYER
                    )
                    playerOpen = true
                } catch (e: Exception) {
                    // Never strand the viewer: report failure so the web player takes over.
                    notifyNativeDone(false, true, 0.0)
                }
            }
        }
        /** For the web app to call when its requests stop getting through. An
         *  already-loaded page never fails as a whole, so without this an outage
         *  that starts mid-session is only noticed on a network change, a return
         *  to the app, or the next launch. Throttled; safe to call repeatedly. */
        @JavascriptInterface
        fun serverUnreachable() {
            runOnUiThread {
                if (SystemClock.elapsedRealtime() - lastResolveAt > 20_000L) requestResolve()
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
        playerOpen = false
        // A switch was held back during playback. Redo it after a beat so the web
        // app can start Up Next first; if it does, the player is open again and
        // the switch waits for that one too.
        if (resolveAfterPlayer) {
            resolveAfterPlayer = false
            ui.postDelayed(resolveAfterPlayback, 1500L)
        }
        notifyNativeDone(
            data?.getBooleanExtra("ended", false) ?: false,
            data?.getBooleanExtra("failed", false) ?: (resultCode != RESULT_OK),
            data?.getDoubleExtra("position", 0.0) ?: 0.0
        )
    }
    private val resolveAfterPlayback = Runnable {
        if (playerOpen) {
            resolveAfterPlayer = true
        } else {
            requestResolve()
        }
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

    override fun onResume() {
        super.onResume()
        // Coming back to the app is when a viewer who saw "can't reach" tries
        // again, so look again if it has been a while.
        if (lastResolveAt != 0L && !playerOpen && SystemClock.elapsedRealtime() - lastResolveAt > 30_000L) requestResolve()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
        outState.putString("marqueeOrigin", ServerResolver.originOf(web.url))
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        netCallback?.let { cb ->
            try { (getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(cb) } catch (_: Exception) {}
        }
        netCallback = null
        resolveExec.shutdown()
        learnExec.shutdown()
        super.onDestroy()
    }
}
