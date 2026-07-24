package com.scenicprints.marquee

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Native libVLC player — the Android analog of the Apple TV VLCKit player.
 * Direct-plays the server's raw byte-range stream (`/api/stream/…`): libVLC
 * decodes every container/codec on-device, so the server NEVER transcodes.
 *
 * Launched by MainActivity when the web UI hands off playback (a JSON "spec"
 * extra). Finishes with {ended, failed, position} — on `failed` the web app
 * automatically falls back to its own <video> player, so the worst case is
 * exactly the old behavior.
 *
 * Remote control is pure key-mapping (no Android focus juggling — simplest
 * thing that can't get lost): OK = play/pause (or Skip Intro while that's on
 * screen) · ◀/▶ = ±10s · ▲ = show HUD · ▼ = subtitles · Back = close.
 *
 * Apple TV port lessons applied here:
 *  - libVLC callbacks may arrive off-main → every UI/player touch is posted
 *    to the main thread.
 *  - libVLC auto-enables the first embedded subtitle track → force OFF until
 *    the viewer picks one.
 *  - Resume must seek ONCE, only after the player is actually Playing and
 *    seekable — early seeks crashed tvOS.
 *  - NO display-mode/HDR switching from the app (the unresolved tvOS crash);
 *    Android's MediaCodec + SurfaceView path handles HDR on its own.
 */
class PlayerActivity : Activity() {

    // ---- spec (from the web app) ----
    private lateinit var base: String          // e.g. https://marqu33.duckdns.org
    private var token: String? = null          // session token (from the shared cookie jar)
    private lateinit var spec: JSONObject
    private var live = false
    private var startAt = 0.0                  // seconds
    private var progressPath: String? = null

    // ---- player ----
    private var libVLC: LibVLC? = null
    private var player: MediaPlayer? = null
    private lateinit var videoLayout: VLCVideoLayout
    private var inPreroll = false
    private var mainStarted = false
    private var resumeApplied = false
    private var subsForcedOff = false
    private var userPickedSub = false
    private var durationSec = 0.0              // authoritative from /api/play, else libVLC length
    private var positionSec = 0.0
    private var endedNaturally = false

    // ---- intro skip (from /api/play) ----
    private var introStart = -1.0
    private var introEnd = -1.0
    private var introSkipped = false

    // ---- HUD ----
    private lateinit var hud: FrameLayout
    private lateinit var titleView: TextView
    private lateinit var subView: TextView
    private lateinit var timeView: TextView
    private lateinit var playIcon: TextView
    private lateinit var scrub: ScrubView
    private lateinit var skipIntroBtn: TextView
    private lateinit var bufferOverlay: LinearLayout
    private lateinit var subsMenu: ScrollView
    private lateinit var subsMenuList: LinearLayout
    private var hudVisible = false
    private val ui = Handler(Looper.getMainLooper())
    private val hideHud = Runnable { setHudVisible(false) }

    // ---- network (progress / heartbeat / telemetry) ----
    private val net = Executors.newSingleThreadExecutor()
    private val sessionId = UUID.randomUUID().toString()
    private val teleQueue = JSONArray()
    private var rebufferStartedAt = 0L
    private var rebufferCount = 0

    private val ACCENT = Color.parseColor("#6c5cff")
    private val ACCENT2 = Color.parseColor("#37c2ff")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        try {
            base = intent.getStringExtra("base") ?: throw IllegalStateException("no base")
            spec = JSONObject(intent.getStringExtra("spec") ?: "{}")
            live = spec.optBoolean("live", false)
            startAt = spec.optDouble("startAt", 0.0)
            progressPath = spec.optString("progressPath").takeIf { it.isNotEmpty() && it != "null" }
            token = extractToken()
            buildUi()
            startVlc()
            fetchPlayInfo()
            (getSystemService(AUDIO_SERVICE) as? AudioManager)
                ?.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        } catch (e: Exception) {
            tele("error", JSONObject().put("ev", "native-setup").put("msg", e.toString()))
            finishWithResult(failed = true)
        }
    }

    /** The WebView's cookie jar is process-wide; the session cookie IS the token. */
    private fun extractToken(): String? = try {
        val cookies = CookieManager.getInstance().getCookie(base) ?: ""
        Regex("(?:^|;\\s*)mstoken=([^;]+)").find(cookies)?.groupValues?.get(1)
    } catch (_: Exception) { null }

    /** Media/subtitle URLs carry ?token= (libVLC doesn't send our cookies);
     *  JSON API calls send the Cookie header instead (see http()). */
    private fun mediaUrl(path: String): String {
        val sep = if (path.contains('?')) '&' else '?'
        return base + path + (token?.let { "${sep}token=$it" } ?: "")
    }

    // ================= playback =================

    private fun startVlc() {
        libVLC = LibVLC(this, arrayListOf("--audio-time-stretch", "--drop-late-frames", "--skip-frames"))
        player = MediaPlayer(libVLC)
        player!!.attachViews(videoLayout, null, true, false)
        player!!.setEventListener { e -> ui.post { onVlcEvent(e) } } // main thread, always (tvOS lesson)
        val preroll = spec.optString("prerollPath").takeIf { it.isNotEmpty() && it != "null" }
        if (preroll != null && !live) { inPreroll = true; playUrl(mediaUrl(preroll)) }
        else startMain()
    }

    private fun startMain() {
        inPreroll = false
        mainStarted = true
        playUrl(mediaUrl(spec.optString("streamPath")))
        tele("player", JSONObject().put("ev", "load").put("native", true).put("mode", "direct")
            .put("title", spec.optString("title")).put("live", live).put("at", startAt.toInt()))
    }

    private fun playUrl(url: String) {
        try {
            val media = Media(libVLC, Uri.parse(url))
            media.setHWDecoderEnabled(true, false)     // MediaCodec for 4K HEVC; safe fallback allowed
            media.addOption(":network-caching=4000")   // real cushion for remote streams
            player!!.media = media
            media.release()
            showBuffering(true)
            player!!.play()
        } catch (e: Exception) {
            if (inPreroll) { startMain() } // a broken pre-roll must never trap the viewer (web parity)
            else { tele("error", JSONObject().put("ev", "native-play").put("msg", e.toString())); finishWithResult(failed = true) }
        }
    }

    private fun onVlcEvent(e: MediaPlayer.Event) {
        when (e.type) {
            MediaPlayer.Event.Playing -> {
                showBuffering(false)
                if (inPreroll) return
                // Resume: exactly once, only now that we're Playing (tvOS lesson).
                if (!resumeApplied) {
                    resumeApplied = true
                    if (startAt > 1 && player?.isSeekable == true) player?.time = (startAt * 1000).toLong()
                    ui.postDelayed({ forceSubsOffOnce() }, 800) // after tracks settle
                }
                updateHud()
            }
            MediaPlayer.Event.Paused -> { updateHud(); postProgress() }
            MediaPlayer.Event.TimeChanged -> {
                if (inPreroll) return
                positionSec = e.timeChanged / 1000.0
                onTick()
            }
            MediaPlayer.Event.LengthChanged -> {
                if (!inPreroll && durationSec <= 0 && e.lengthChanged > 0) durationSec = e.lengthChanged / 1000.0
            }
            MediaPlayer.Event.Buffering -> {
                if (!mainStarted && !inPreroll) return
                val pct = e.buffering
                if (pct < 100f) {
                    if (rebufferStartedAt == 0L && player?.isPlaying != false) rebufferStartedAt = System.currentTimeMillis()
                    showBuffering(true)
                } else {
                    val started = rebufferStartedAt
                    rebufferStartedAt = 0L
                    showBuffering(false)
                    // Only count real stalls (not the initial spin-up, not blips).
                    if (!inPreroll && resumeApplied && started > 0) {
                        val ms = System.currentTimeMillis() - started
                        if (ms > 700) { rebufferCount++
                            tele("buffer", JSONObject().put("kind", "rebuffer").put("native", true).put("ms", ms).put("at", positionSec.toInt())) }
                    }
                }
            }
            MediaPlayer.Event.EndReached -> {
                if (inPreroll) { startMain(); return }
                endedNaturally = true
                postProgress(watched = true)
                finishWithResult(ended = true)
            }
            MediaPlayer.Event.EncounteredError -> {
                if (inPreroll) { startMain(); return } // web parity: bad pre-roll → just play the movie
                tele("error", JSONObject().put("ev", "native-media-error").put("title", spec.optString("title")).put("at", positionSec.toInt()))
                finishWithResult(failed = true)
            }
        }
    }

    /** libVLC auto-enables the first embedded text track; keep captions OFF
     *  until the viewer picks one (tvOS lesson). */
    private fun forceSubsOffOnce() {
        if (subsForcedOff || userPickedSub) return
        subsForcedOff = true
        try { if ((player?.spuTrack ?: -1) != -1) player?.spuTrack = -1 } catch (_: Exception) {}
    }

    private fun seekBy(deltaSec: Int) {
        if (live || inPreroll) return
        val p = player ?: return
        if (!p.isSeekable) return
        val d = durationSec.takeIf { it > 0 } ?: (p.length / 1000.0)
        val target = ((positionSec + deltaSec).coerceIn(0.0, if (d > 1) d - 1 else positionSec + deltaSec)) * 1000
        try { p.time = target.toLong() } catch (_: Exception) {}
        flashHud()
    }

    private fun togglePause() {
        if (inPreroll) return
        val p = player ?: return
        try { if (p.isPlaying) p.pause() else p.play() } catch (_: Exception) {}
        flashHud()
    }

    // ================= /api/play: duration + intro (and the server-side stats log) =================

    private fun fetchPlayInfo() {
        val path = spec.optString("playPath").takeIf { it.isNotEmpty() } ?: return
        net.execute {
            val body = http("GET", base + path, null) ?: return@execute
            try {
                val j = JSONObject(body)
                ui.post {
                    if (j.optDouble("duration", 0.0) > 0) durationSec = j.optDouble("duration")
                    val intro = j.optJSONObject("intro")
                    if (intro != null) { introStart = intro.optDouble("start", -1.0); introEnd = intro.optDouble("end", -1.0) }
                }
            } catch (_: Exception) {}
        }
    }

    // ================= per-half-second UI tick =================

    private var lastNetTick = 0L
    private fun onTick() {
        updateHud()
        // Skip Intro window (fingerprint-detected range from the server).
        val inIntro = !live && !introSkipped && introEnd > 0 && positionSec >= introStart && positionSec < introEnd
        skipIntroBtn.visibility = if (inIntro) View.VISIBLE else View.GONE
        // Progress + heartbeat every ~10s.
        val now = System.currentTimeMillis()
        if (now - lastNetTick > 10000) { lastNetTick = now; postProgress(); heartbeat(); flushTele() }
    }

    private fun skipIntroNow() {
        if (introEnd <= 0) return
        introSkipped = true
        skipIntroBtn.visibility = View.GONE
        try { player?.time = (introEnd * 1000).toLong() } catch (_: Exception) {}
    }

    // ================= server reporting =================

    private fun postProgress(watched: Boolean = false) {
        val path = progressPath ?: return
        if (inPreroll || positionSec <= 0) return
        val d = durationSec.takeIf { it > 0 }
        val done = watched || (d != null && positionSec / d > 0.92)
        val body = JSONObject().put("position", positionSec)
        if (d != null) body.put("duration", d)
        if (done) body.put("watched", 1)
        net.execute { http("POST", base + path, body.toString()) }
    }

    private fun heartbeat() {
        val body = JSONObject()
            .put("sessionId", sessionId)
            .put("kind", spec.optString("kind"))
            .put("fileId", spec.optInt("fileId"))
            .put("title", spec.optString("title"))
            .put("subtitle", spec.optString("subtitle"))
            .put("mode", "direct")
            .put("position", positionSec)
            .put("duration", durationSec)
            .put("paused", player?.isPlaying != true)
            .put("live", live)
            .put("stalls", rebufferCount)
            .put("tv", true)
            .put("native", true)
            .put("audioMode", "native")
        net.execute { http("POST", "$base/api/session/heartbeat", body.toString()) }
    }

    private fun tele(type: String, data: JSONObject) {
        synchronized(teleQueue) {
            teleQueue.put(JSONObject().put("ts", System.currentTimeMillis()).put("type", type).put("data", data))
        }
    }

    private fun flushTele() {
        val batch: JSONArray
        synchronized(teleQueue) {
            if (teleQueue.length() == 0) return
            batch = JSONArray()
            for (i in 0 until teleQueue.length()) batch.put(teleQueue.opt(i))
            while (teleQueue.length() > 0) teleQueue.remove(0)
        }
        val body = JSONObject().put("device", spec.optString("deviceId")).put("events", batch).toString()
        net.execute { http("POST", "$base/api/telemetry", body) }
    }

    /** Blocking JSON HTTP on the net executor. Cookie-authenticated; never throws. */
    private fun http(method: String, url: String, body: String?): String? = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        token?.let { conn.setRequestProperty("Cookie", "mstoken=$it") }
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            OutputStreamWriter(conn.outputStream).use { it.write(body) }
        }
        val text = conn.inputStream.bufferedReader().use { it.readText() }
        conn.disconnect()
        text
    } catch (_: Exception) { null }

    // ================= subtitles =================

    private var subTracks = JSONArray()  // [{label, idx}] from the server
    private var currentSubIdx = -1       // server idx, -1 = off
    private var aiJobRunning = false

    private fun openSubsMenu() {
        if (inPreroll) return
        subsMenu.visibility = View.VISIBLE
        setHudVisible(false)
        renderSubsMenu()
        net.execute {
            val body = http("GET", base + spec.optString("subListPath"), null) ?: return@execute
            try { val arr = JSONArray(body); ui.post { subTracks = arr; renderSubsMenu() } } catch (_: Exception) {}
        }
    }

    private fun renderSubsMenu() {
        subsMenuList.removeAllViews()
        subsMenuList.addView(menuHeader("Subtitles"))
        // "✨ Generate with AI…" comes FIRST — the flagship, same as web/Apple TV.
        subsMenuList.addView(menuRow(if (aiJobRunning) "✨ Generating…" else "✨ Generate with AI…", false) { startAiSubs() })
        subsMenuList.addView(menuRow("Off", currentSubIdx == -1) { selectSub(-1) })
        for (i in 0 until subTracks.length()) {
            val t = subTracks.optJSONObject(i) ?: continue
            val idx = t.optInt("idx", i)
            subsMenuList.addView(menuRow(t.optString("label", "Track ${i + 1}"), currentSubIdx == idx) { selectSub(idx) })
        }
        menuSel = 1.coerceAtMost(subsMenuList.childCount - 1)
        paintMenuSel()
    }

    private fun selectSub(idx: Int) {
        currentSubIdx = idx
        userPickedSub = true
        try {
            if (idx == -1) player?.spuTrack = -1
            else {
                // Server tracks (sidecars + extracted embedded) are served as WebVTT;
                // load as a selected slave — libVLC renders it over the video.
                val url = mediaUrl(spec.optString("subBase") + "?idx=" + idx)
                player?.addSlave(Media.Slave.Type.Subtitle, Uri.parse(url), true)
            }
        } catch (_: Exception) {}
        closeSubsMenu()
    }

    private fun startAiSubs() {
        if (aiJobRunning) return
        aiJobRunning = true
        renderSubsMenu()
        val req = JSONObject().put("kind", spec.optString("kind")).put("fileId", spec.optInt("fileId")).put("target", "orig")
        net.execute { http("POST", "$base/api/subtitles/generate", req.toString()) }
        pollAiSubs()
    }

    private fun pollAiSubs() {
        net.execute {
            val q = "kind=${spec.optString("kind")}&fileId=${spec.optInt("fileId")}&target=orig"
            val body = http("GET", "$base/api/subtitles/generate?$q", null)
            ui.post {
                val j = try { JSONObject(body ?: "{}") } catch (_: Exception) { JSONObject() }
                when (j.optString("status")) {
                    "running" -> {
                        setAiRowText("✨ Generating… ${j.optInt("pct")}% (${j.optString("phase")})")
                        ui.postDelayed({ pollAiSubs() }, 2500)
                    }
                    "done" -> {
                        aiJobRunning = false
                        // Refresh the track list — the new AI track appears in it.
                        net.execute {
                            val lb = http("GET", base + spec.optString("subListPath"), null)
                            try { val arr = JSONArray(lb ?: "[]"); ui.post { subTracks = arr; if (subsMenu.visibility == View.VISIBLE) renderSubsMenu() } } catch (_: Exception) {}
                        }
                    }
                    "error" -> { aiJobRunning = false; setAiRowText("✨ Failed — try again") }
                    else -> { aiJobRunning = false; if (subsMenu.visibility == View.VISIBLE) renderSubsMenu() }
                }
            }
        }
    }

    private fun setAiRowText(text: String) {
        if (subsMenuList.childCount > 1) (subsMenuList.getChildAt(1) as? TextView)?.text = text
    }

    private fun closeSubsMenu() { subsMenu.visibility = View.GONE }

    // ================= remote keys =================

    private var menuSel = 1
    private fun paintMenuSel() {
        for (i in 1 until subsMenuList.childCount) {
            val row = subsMenuList.getChildAt(i) as? TextView ?: continue
            val on = i == menuSel
            row.setBackgroundColor(if (on) Color.argb(70, 108, 92, 255) else Color.TRANSPARENT)
            row.setTextColor(if (on) Color.WHITE else Color.parseColor("#c7ccda"))
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(event)
        // Pre-roll: locked, like the web player. Back still exits everything.
        if (inPreroll) {
            if (event.keyCode == KeyEvent.KEYCODE_BACK) finishWithResult()
            return true
        }
        // Subtitles menu drives its own selection.
        if (subsMenu.visibility == View.VISIBLE) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_BACK -> closeSubsMenu()
                KeyEvent.KEYCODE_DPAD_UP -> { if (menuSel > 1) menuSel--; paintMenuSel() }
                KeyEvent.KEYCODE_DPAD_DOWN -> { if (menuSel < subsMenuList.childCount - 1) menuSel++; paintMenuSel() }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> (subsMenuList.getChildAt(menuSel))?.performClick()
            }
            return true
        }
        when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER ->
                if (skipIntroBtn.visibility == View.VISIBLE) skipIntroNow() else togglePause()
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> togglePause()
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_MEDIA_REWIND -> seekBy(-10)
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> seekBy(10)
            KeyEvent.KEYCODE_DPAD_UP -> flashHud()
            KeyEvent.KEYCODE_DPAD_DOWN -> openSubsMenu()
            KeyEvent.KEYCODE_BACK -> { if (hudVisible) setHudVisible(false) else { postProgress(); finishWithResult() } }
            else -> return super.dispatchKeyEvent(event)
        }
        return true
    }

    // ================= finishing =================

    private var finished = false
    private fun finishWithResult(ended: Boolean = false, failed: Boolean = false) {
        if (finished) return
        finished = true
        tele("player", JSONObject().put("ev", "close").put("native", true)
            .put("title", spec.optString("title")).put("at", positionSec.toInt()).put("dur", durationSec.toInt())
            .put("ended", ended).put("failed", failed))
        flushTele()
        setResult(RESULT_OK, Intent()
            .putExtra("ended", ended || endedNaturally)
            .putExtra("failed", failed)
            .putExtra("position", positionSec))
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        try { postProgress() } catch (_: Exception) {}
        net.execute { http("POST", "$base/api/session/end", JSONObject().put("sessionId", sessionId).toString()) }
        try {
            player?.stop()
            player?.detachViews()
            player?.release()
            libVLC?.release()
        } catch (_: Exception) {}
        player = null; libVLC = null
        ui.removeCallbacksAndMessages(null)
        net.shutdown()
    }

    // ================= UI construction (all code, no XML) =================

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
    private fun sp(t: TextView, size: Float) = t.setTextSize(TypedValue.COMPLEX_UNIT_SP, size)

    private fun buildUi() {
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        videoLayout = VLCVideoLayout(this)
        root.addView(videoLayout, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // --- HUD (title top / time+scrubber bottom, web-matched dark scrims) ---
        hud = FrameLayout(this)
        val top = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(34), dp(22), dp(34), dp(30))
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.argb(178, 0, 0, 0), Color.TRANSPARENT))
        }
        titleView = TextView(this).apply { setTextColor(Color.WHITE); typeface = Typeface.DEFAULT_BOLD; text = spec.optString("title") }
        sp(titleView, 18f)
        subView = TextView(this).apply { setTextColor(Color.parseColor("#c7ccda")); text = spec.optString("subtitle") }
        sp(subView, 13f)
        top.addView(titleView); top.addView(subView)
        if (spec.optString("subtitle").isEmpty()) subView.visibility = View.GONE
        hud.addView(top, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))

        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(34), dp(30), dp(34), dp(24))
            background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                intArrayOf(Color.argb(200, 0, 0, 0), Color.TRANSPARENT))
        }
        scrub = ScrubView(this, ACCENT, ACCENT2)
        bottom.addView(scrub, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(4)).apply { bottomMargin = dp(10) })
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        playIcon = TextView(this).apply { setTextColor(Color.WHITE); typeface = Typeface.DEFAULT_BOLD; text = "❚❚" }
        sp(playIcon, 15f)
        timeView = TextView(this).apply { setTextColor(Color.WHITE); text = if (live) "LIVE" else "0:00 / 0:00" }
        sp(timeView, 13f)
        val hint = TextView(this).apply {
            setTextColor(Color.parseColor("#8a91a5"))
            text = if (live) "OK pause · ▼ subtitles · Back exit" else "OK play/pause · ◀ ▶ ±10s · ▼ subtitles · Back exit"
            gravity = Gravity.END
        }
        sp(hint, 12f)
        row.addView(playIcon, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = dp(14) })
        row.addView(timeView)
        row.addView(hint, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bottom.addView(row)
        if (live) scrub.visibility = View.GONE
        hud.addView(bottom, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        hud.visibility = View.GONE
        root.addView(hud, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // --- Skip Intro (web-matched pill; OK activates it while visible) ---
        skipIntroBtn = TextView(this).apply {
            text = "Skip Intro ▸  (OK)"
            setTextColor(Color.BLACK)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(18), dp(10), dp(18), dp(10))
            background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(Color.WHITE) }
            visibility = View.GONE
        }
        sp(skipIntroBtn, 14f)
        root.addView(skipIntroBtn, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            rightMargin = dp(40); bottomMargin = dp(90)
        })

        // --- Buffering splash (web-matched: MARQUEE gradient wordmark) ---
        bufferOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.argb(158, 5, 6, 9))
        }
        val brand = TextView(this).apply {
            text = "MARQUEE"
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.35f
        }
        sp(brand, 34f)
        brand.post {
            brand.paint.shader = LinearGradient(0f, 0f, brand.width.toFloat(), 0f, ACCENT, ACCENT2, Shader.TileMode.CLAMP)
            brand.invalidate()
        }
        val loading = TextView(this).apply { setTextColor(Color.parseColor("#c9cfdf")); text = "LOADING…"; letterSpacing = 0.15f }
        sp(loading, 12f)
        bufferOverlay.addView(brand)
        bufferOverlay.addView(loading, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) })
        root.addView(bufferOverlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // --- Subtitles menu (right-side dark panel, remote-driven) ---
        subsMenuList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(6), dp(10), dp(6), dp(10)) }
        subsMenu = ScrollView(this).apply {
            background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(Color.argb(242, 17, 19, 28)) }
            visibility = View.GONE
            addView(subsMenuList, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        root.addView(subsMenu, FrameLayout.LayoutParams(dp(340), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.END or Gravity.CENTER_VERTICAL).apply {
            rightMargin = dp(30)
        })

        skipIntroBtn.setOnClickListener { skipIntroNow() }
        setContentView(root)
    }

    private fun menuHeader(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(Color.parseColor("#8a91a5"))
        typeface = Typeface.DEFAULT_BOLD
        letterSpacing = 0.1f
        setPadding(dp(14), dp(8), dp(14), dp(8))
    }.also { sp(it, 11f) }

    private fun menuRow(text: String, selected: Boolean, onClick: () -> Unit): TextView = TextView(this).apply {
        this.text = if (selected) "✓ $text" else text
        setTextColor(Color.parseColor("#c7ccda"))
        setPadding(dp(14), dp(11), dp(14), dp(11))
        setOnClickListener { onClick() }
    }.also { sp(it, 14f) }

    // ================= HUD helpers =================

    private fun setHudVisible(v: Boolean) {
        hudVisible = v
        hud.visibility = if (v) View.VISIBLE else View.GONE
        ui.removeCallbacks(hideHud)
        if (v) ui.postDelayed(hideHud, 4000)
    }
    private fun flashHud() { setHudVisible(true); updateHud() }

    private fun updateHud() {
        if (!hudVisible) return
        playIcon.text = if (player?.isPlaying == true) "❚❚" else "▶"
        if (!live) {
            val d = durationSec.takeIf { it > 0 } ?: ((player?.length ?: 0L) / 1000.0)
            timeView.text = "${fmt(positionSec)} / ${fmt(d)}"
            scrub.setProgress(if (d > 0) (positionSec / d).toFloat() else 0f)
        }
    }

    private fun showBuffering(v: Boolean) { bufferOverlay.visibility = if (v) View.VISIBLE else View.GONE }

    private fun fmt(sec: Double): String {
        val s = sec.toInt().coerceAtLeast(0)
        val h = s / 3600; val m = (s % 3600) / 60; val ss = s % 60
        return if (h > 0) String.format("%d:%02d:%02d", h, m, ss) else String.format("%d:%02d", m, ss)
    }
}

/** Minimal gradient scrubber: a rounded track with a gradient fill — the same
 *  visual language as the web player's --grad progress bar. */
private class ScrubView(ctx: android.content.Context, accent: Int, accent2: Int) : View(ctx) {
    private var progress = 0f
    private val trackPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(64, 255, 255, 255) }
    private val fillPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    private val a1 = accent; private val a2 = accent2

    fun setProgress(p: Float) { progress = p.coerceIn(0f, 1f); invalidate() }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
        fillPaint.shader = LinearGradient(0f, 0f, w.toFloat(), 0f, a1, a2, Shader.TileMode.CLAMP)
    }
    override fun onDraw(canvas: android.graphics.Canvas) {
        val r = height / 2f
        canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), r, r, trackPaint)
        if (progress > 0f) canvas.drawRoundRect(0f, 0f, width * progress, height.toFloat(), r, r, fillPaint)
    }
}
