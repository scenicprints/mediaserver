package com.scenicprints.marquee

import android.app.Activity
import android.content.Intent
import android.graphics.Color
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
import org.videolan.libvlc.interfaces.IMedia
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
 * screen) · ◀/▶ = ±10s · ▲ = show HUD · ▼ = the menu (subtitles, audio,
 * version) · Back = close.
 *
 * Soundtrack: the owner's rule for every client is that playback starts on the
 * track this device plays as-is, picked without asking, and the viewer can
 * change it from the menu. libVLC decodes everything here, so the pick is about
 * the right MIX (the feature, not the commentary; surround or a real 2.0 for
 * the speakers), not about what can play.
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
    private lateinit var base: String          // the page's origin: public https or the LAN http://ip:port
    private var token: String? = null          // session token (from the shared cookie jar)
    private lateinit var spec: JSONObject
    private var live = false
    private var startAt = 0.0                  // seconds
    private var progressPath: String? = null

    // ---- the file being played ----
    // Starts as the web's choice; a pick from the Version menu swaps it in
    // place, and everything per-file (stream, subtitles, play info, audio list,
    // heartbeat) follows this rather than the spec.
    private var fileId = 0
    private var specFileId = 0
    private var apiKind = "movie"              // "movie" | "episode", for the per-file APIs
    private var titleId = -1                   // the movie/episode id (versions + remembering a pick)

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

    // ---- credits skip / next episode ----
    // The web shell already tells us whether a next episode exists; it has been
    // arriving in the spec and being ignored, which is why this player had a
    // Skip Intro pill and nothing at the other end.
    private var hasUpNext = false
    private var creditsTaken = false

    // ---- HUD ----
    private lateinit var hud: FrameLayout
    private lateinit var titleView: TextView
    private lateinit var subView: TextView
    private lateinit var timeView: TextView
    private lateinit var playIcon: TextView
    private lateinit var scrub: ScrubView
    private lateinit var skipIntroBtn: TextView
    private lateinit var skipCreditsBtn: TextView
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
    // Every seek makes the decoder refill, which looks exactly like a network
    // stall. It isn't one, and counting it made resumes report phantom rebuffers
    // seconds after playback started. A seek opens this window; the refill it
    // causes closes it without being counted, and if the seek somehow refills
    // without a Buffering event the window expires on its own rather than
    // swallowing the next real stall.
    private var seekGateUntilMs = 0L

    // Both names survive so every call site keeps reading sensibly, but there is
    // only one accent now: the purple/cyan pair existed solely to make a
    // gradient, and Braun does not gradient.
    private val ACCENT = Braun.signal
    private val ACCENT2 = Braun.signal

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        try {
            base = intent.getStringExtra("base") ?: throw IllegalStateException("no base")
            spec = JSONObject(intent.getStringExtra("spec") ?: "{}")
            live = spec.optBoolean("live", false)
            hasUpNext = spec.optBoolean("hasUpNext", false)
            startAt = spec.optDouble("startAt", 0.0)
            progressPath = spec.optString("progressPath").takeIf { it.isNotEmpty() && it != "null" }
            specFileId = spec.optInt("fileId")
            fileId = specFileId
            apiKind = if (spec.optString("kind") == "episode") "episode" else "movie"
            titleId = resolveTitleId()
            token = extractToken()
            buildUi()
            startVlc()
            fetchPlayInfo()
            fetchAudioList()
            fetchVersions()
            ui.postDelayed(netTick, 10000)
            (getSystemService(AUDIO_SERVICE) as? AudioManager)
                ?.requestAudioFocus({ }, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        } catch (e: Exception) {
            tele("error", JSONObject().put("ev", "native-setup").put("msg", e.toString()))
            finishWithResult(failed = true)
        }
    }

    /** The WebView's cookie jar is process-wide; the session cookie IS the token.
     *  On the LAN origin the cookie is the one MainActivity handed over when it
     *  switched there, so the same read works whichever origin the page is on. */
    private fun extractToken(): String? = try {
        val cookies = CookieManager.getInstance().getCookie(base) ?: ""
        Regex("(?:^|;\\s*)mstoken=([^;]+)").find(cookies)?.groupValues?.get(1)
    } catch (_: Exception) { null }

    /** The spec doesn't name the movie/episode itself, but its progress path
     *  does (/api/movies/<id>/progress, /api/episodes/<id>/progress). A channel
     *  has no progress path and so no versions, which is right: a channel is
     *  whatever file the schedule is airing. */
    private fun resolveTitleId(): Int {
        spec.optInt("titleId", -1).takeIf { it > 0 }?.let { return it }
        val m = Regex("^/api/(movies|episodes)/(\\d+)/progress").find(progressPath ?: "") ?: return -1
        return m.groupValues[2].toIntOrNull() ?: -1
    }

    /** The spec's per-file paths each name the web's file id once
     *  (/api/stream/12, /api/play/movie/12?native=1, …). Swap in another id,
     *  keeping whatever prefix and query the web app sends. Unchanged when the
     *  id isn't there as a whole path segment. */
    private fun forFile(path: String, fid: Int = fileId): String {
        val orig = "/$specFileId"
        val at = path.lastIndexOf(orig)
        if (at < 0) return path
        val end = at + orig.length
        if (end < path.length && path[end] != '?' && path[end] != '/') return path // "/12" inside "/123"
        return path.substring(0, at) + "/" + fid + path.substring(end)
    }
    private fun streamPath(fid: Int = fileId) = forFile(spec.optString("streamPath"), fid)
    private fun subListPath() = forFile(spec.optString("subListPath"))
    private fun subBase() = forFile(spec.optString("subBase"))
    private fun playPath() = spec.optString("playPath").takeIf { it.isNotEmpty() }?.let { forFile(it) }

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
        playUrl(mediaUrl(streamPath()))
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
                    // (setTime/setSpuTrack return values in Java — call them as
                    // methods; Kotlin property syntax doesn't compile for them.)
                    if (startAt > 1 && player?.isSeekable == true) {
                        markSeek()
                        player?.setTime((startAt * 1000).toLong())
                    }
                    ui.postDelayed({ forceSubsOffOnce() }, 800) // after tracks settle
                }
                scheduleAutoAudio()
                updateHud()
            }
            // Tracks are reported one at a time as the demuxer finds them; each
            // one is a chance that the full set is now there to map.
            MediaPlayer.Event.ESAdded -> if (!inPreroll) scheduleAutoAudio()
            MediaPlayer.Event.Paused -> { updateHud(); postProgress(); heartbeat() }
            MediaPlayer.Event.TimeChanged -> {
                // Until the resume seek has run, the clock reads the new file's
                // first second, not where the viewer is (a version switch lands
                // here); a progress post from that would wipe the resume point.
                if (inPreroll || !resumeApplied) return
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
                        if (System.currentTimeMillis() < seekGateUntilMs) {
                            seekGateUntilMs = 0L        // this refill is the seek's own
                        } else if (ms > 700) { rebufferCount++
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
        try { if ((player?.spuTrack ?: -1) != -1) player?.setSpuTrack(-1) } catch (_: Exception) {}
    }

    /** A seek's own refill is not a network stall — ignore the next one. The
     *  window is generous but self-expiring: a refill follows a seek within a
     *  second or two, and right after a seek the buffer is legitimately cold. */
    private fun markSeek() {
        seekGateUntilMs = System.currentTimeMillis() + 15000
    }

    private fun seekBy(deltaSec: Int) {
        if (live || inPreroll) return
        val p = player ?: return
        if (!p.isSeekable) return
        val d = durationSec.takeIf { it > 0 } ?: (p.length / 1000.0)
        val target = ((positionSec + deltaSec).coerceIn(0.0, if (d > 1) d - 1 else positionSec + deltaSec)) * 1000
        markSeek()
        try { p.setTime(target.toLong()) } catch (_: Exception) {}
        flashHud()
    }

    private fun togglePause() {
        // A channel does not pause — the OK key and the remote's dedicated
        // media keys both land here, so this is the one place that has to know.
        if (live) return
        if (inPreroll) return
        val p = player ?: return
        try { if (p.isPlaying) p.pause() else p.play() } catch (_: Exception) {}
        flashHud()
    }

    // ================= /api/play: duration + intro (and the server-side stats log) =================

    private fun fetchPlayInfo() {
        val path = playPath() ?: return
        val fid = fileId
        net.execute {
            val body = http("GET", base + path, null) ?: return@execute
            try {
                val j = JSONObject(body)
                ui.post {
                    if (fid != fileId) return@post   // a version switch overtook it
                    if (j.optDouble("duration", 0.0) > 0) durationSec = j.optDouble("duration")
                    val intro = j.optJSONObject("intro")
                    if (intro != null) { introStart = intro.optDouble("start", -1.0); introEnd = intro.optDouble("end", -1.0) }
                }
            } catch (_: Exception) {}
        }
    }

    // ================= ticks =================

    // UI tick rides on TimeChanged (fires only while playing — fine for UI).
    private fun onTick() {
        updateHud()
        // Skip Intro window (fingerprint-detected range from the server).
        val inIntro = !live && !introSkipped && introEnd > 0 && positionSec >= introStart && positionSec < introEnd
        skipIntroBtn.visibility = if (inIntro) View.VISIBLE else View.GONE
        // Skip Credits: the last 45 seconds of an episode that has a next one,
        // matching the web player's window. Never on a live channel — there is
        // nothing to skip into, the next programme arrives on its own.
        val inCredits = !live && hasUpNext && !creditsTaken && durationSec > 0 &&
            positionSec >= durationSec - 45 && positionSec < durationSec - 1
        skipCreditsBtn.visibility = if (inCredits) View.VISIBLE else View.GONE
    }

    // Reporting tick is a real timer: TimeChanged stops while PAUSED, and a
    // paused viewer must stay visible in the admin monitor (that live-session
    // view is how remote problems get caught).
    private val netTick = object : Runnable {
        override fun run() {
            if (mainStarted && !inPreroll) { postProgress(); heartbeat(); flushTele() }
            ui.postDelayed(this, 10000)
        }
    }

    /** Go straight to the next episode. The web shell owns the Up Next chain,
     *  so this reports the same outcome a natural ending does and lets it run —
     *  rather than seeking to the end and waiting for EndReached, which would
     *  make the viewer sit through a black frame first. */
    private fun skipCreditsNow() {
        if (creditsTaken || live || !hasUpNext) return
        creditsTaken = true
        skipCreditsBtn.visibility = View.GONE
        postProgress(watched = true)
        finishWithResult(ended = true)
    }

    private fun skipIntroNow() {
        // seekBy() already refuses on a channel; this is the other way into a
        // seek, so it refuses too.
        if (live) return
        if (introEnd <= 0) return
        introSkipped = true
        skipIntroBtn.visibility = View.GONE
        markSeek()
        try { player?.setTime((introEnd * 1000).toLong()) } catch (_: Exception) {}
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
            .put("fileId", fileId)
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
        renderSubsMenu(keepSelection = false)
        val fid = fileId
        net.execute {
            val body = http("GET", base + subListPath(), null) ?: return@execute
            try { val arr = JSONArray(body); ui.post { if (fid == fileId) { subTracks = arr; renderSubsMenu() } } } catch (_: Exception) {}
        }
    }

    /** The ▼ panel: Subtitles, then Audio, then Version (the Apple TV's order;
     *  subtitles stay first so ▼ then OK still lands on the AI row). Audio and
     *  Version only appear when there is a choice to make. */
    private fun renderSubsMenu(keepSelection: Boolean = true) {
        val keep = if (keepSelection) menuKeys.getOrNull(menuSel) else null
        subsMenuList.removeAllViews()
        menuRows.clear(); menuKeys.clear(); aiRow = null
        subsMenuList.addView(menuHeader("Subtitles"))
        // "✨ Generate with AI…" comes FIRST — the flagship, same as web/Apple TV.
        aiRow = addMenuRow("ai", if (aiJobRunning) "✨ Generating…" else "✨ Generate with AI…", false) { startAiSubs() }
        addMenuRow("sub:off", "Off", currentSubIdx == -1) { selectSub(-1) }
        for (i in 0 until subTracks.length()) {
            val t = subTracks.optJSONObject(i) ?: continue
            val idx = t.optInt("idx", i)
            addMenuRow("sub:$idx", t.optString("label", "Track ${i + 1}"), currentSubIdx == idx) { selectSub(idx) }
        }
        val audio = audioMenuEntries()
        if (audio.size > 1) {
            subsMenuList.addView(menuHeader("Audio"))
            val now = try { player?.audioTrack ?: -1 } catch (_: Exception) { -1 }
            for ((id, label) in audio) addMenuRow("aud:$id", label, id == now) { selectAudio(id) }
        }
        if (versions.length() > 1) {
            subsMenuList.addView(menuHeader("Version"))
            for (i in 0 until versions.length()) {
                val v = versions.optJSONObject(i) ?: continue
                val fid = v.optInt("fileId", -1)
                if (fid < 0) continue
                val label = v.optString("label").takeIf { it.isNotEmpty() && it != "null" } ?: "Version ${i + 1}"
                addMenuRow("ver:$fid", label, fid == fileId) { selectVersion(fid) }
            }
        }
        // A re-render (the subtitle list arriving, the AI job finishing) keeps
        // the highlight on the same row rather than jumping back to the top.
        menuSel = keep?.let { menuKeys.indexOf(it) }?.takeIf { it >= 0 } ?: 0
        paintMenuSel()
    }

    private fun addMenuRow(key: String, text: String, selected: Boolean, onClick: () -> Unit): TextView {
        val row = menuRow(text, selected, onClick)
        subsMenuList.addView(row)
        menuRows.add(row); menuKeys.add(key)
        return row
    }

    private fun selectSub(idx: Int) {
        currentSubIdx = idx
        userPickedSub = true
        try {
            if (idx == -1) player?.setSpuTrack(-1)
            else {
                // Server tracks (sidecars + extracted embedded) are served as WebVTT;
                // load as a selected slave — libVLC renders it over the video.
                val url = mediaUrl(subBase() + "?idx=" + idx)
                player?.addSlave(IMedia.Slave.Type.Subtitle, Uri.parse(url), true)
            }
        } catch (_: Exception) {}
        closeSubsMenu()
    }

    private fun startAiSubs() {
        if (aiJobRunning) return
        aiJobRunning = true
        renderSubsMenu()
        val req = JSONObject().put("kind", spec.optString("kind")).put("fileId", fileId).put("target", "orig")
        net.execute { http("POST", "$base/api/subtitles/generate", req.toString()) }
        pollAiSubs()
    }

    private fun pollAiSubs() {
        net.execute {
            val q = "kind=${spec.optString("kind")}&fileId=$fileId&target=orig"
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
                            val lb = http("GET", base + subListPath(), null)
                            try { val arr = JSONArray(lb ?: "[]"); ui.post { subTracks = arr; if (subsMenu.visibility == View.VISIBLE) renderSubsMenu() } } catch (_: Exception) {}
                        }
                    }
                    "error" -> { aiJobRunning = false; setAiRowText("✨ Failed — try again") }
                    else -> { aiJobRunning = false; if (subsMenu.visibility == View.VISIBLE) renderSubsMenu() }
                }
            }
        }
    }

    private fun setAiRowText(text: String) { aiRow?.text = text }

    private fun closeSubsMenu() { subsMenu.visibility = View.GONE }

    // ================= audio: the automatic pick + the menu's Audio section =================

    // The server's view of the file's audio streams (ffprobe, container order):
    // codec, channels, language, title, commentary. libVLC's own list is only
    // ids and terse names, so this is what ranks and labels them. null = not
    // answered yet; an empty array = answered with nothing.
    private var serverAudio: JSONArray? = null
    private var audioAutoDone = false
    private var userPickedAudio = false
    private val autoAudio = Runnable { tryAutoAudio() }

    private fun fetchAudioList() {
        val fid = fileId
        net.execute {
            val body = http("GET", "$base/api/audio/list/$apiKind/$fid", null)
            val arr = try { JSONObject(body ?: "{}").optJSONArray("tracks") ?: JSONArray() } catch (_: Exception) { JSONArray() }
            ui.post { if (fid == fileId) { serverAudio = arr; tryAutoAudio() } }
        }
    }

    /** libVLC's audio tracks without its "Disable" entry (id -1), in its order. */
    private fun vlcAudioTracks(): List<MediaPlayer.TrackDescription> = try {
        player?.audioTracks?.filter { it.id != -1 } ?: emptyList()
    } catch (_: Exception) { emptyList() }

    /** Tracks trickle in (an ESAdded per stream) and the server list arrives on
     *  its own time: wait for a quiet moment rather than trying on every event. */
    private fun scheduleAutoAudio() {
        if (audioAutoDone) return
        ui.removeCallbacks(autoAudio)
        ui.postDelayed(autoAudio, 400)
    }

    /** Once per file: switch to the server-ranked best track. Both lists are the
     *  file's audio streams in container order, so they map by position, but
     *  only when the counts agree; anything else leaves libVLC's own choice. */
    private fun tryAutoAudio() {
        if (audioAutoDone || userPickedAudio || inPreroll || !mainStarted) return
        val server = serverAudio ?: return
        val vlc = vlcAudioTracks()
        if (vlc.isEmpty()) return                   // not demuxed yet; ESAdded retries
        if (server.length() != vlc.size) return     // still arriving, or a mismatch to leave alone
        audioAutoDone = true
        if (vlc.size < 2) return
        val pick = autoPickAudio(server)
        if (pick < 0 || pick >= vlc.size) return
        try {
            val want = vlc[pick].id
            if (player?.audioTrack != want) player?.setAudioTrack(want)
        } catch (_: Exception) {}
    }

    /** The web's autoPickTrack: playable on this device, never a commentary on
     *  its own; surround speakers want the most channels (up to 7.1), stereo
     *  wants a real 2.0 over a fold-down; then bitrate, then the file's default.
     *  Ties go to the earlier track, as the web's stable sort does. Returns the
     *  server ordinal, or -1 for "nothing to prefer". */
    private fun autoPickAudio(tracks: JSONArray): Int {
        val surround = spec.optString("audioMode") != "stereo"  // not known: surround
        var best = -1
        var bestScore = Double.NEGATIVE_INFINITY
        for (i in 0 until tracks.length()) {
            val t = tracks.optJSONObject(i) ?: continue
            if (t.optBoolean("commentary", false)) continue
            if (t.optJSONObject("playable")?.optBoolean("androidtv", true) == false) continue
            val ch = t.optInt("channels", 0)
            var score = if (surround) ch.coerceAtMost(8) * 10.0
                        else if (ch == 2) 50.0 else (20 - ch).coerceAtLeast(0).toDouble()
            val kbps = t.optDouble("bitrateKbps", 0.0).let { if (it.isNaN()) 0.0 else it }
            score += (kbps / 100.0).coerceAtMost(10.0)
            if (t.optBoolean("default", false)) score += 5.0
            if (score > bestScore) { bestScore = score; best = t.optInt("index", i) }
        }
        return best
    }

    /** (libVLC id, label) for each real audio track: labelled from the server
     *  list when it maps one-to-one, else with libVLC's own names. */
    private fun audioMenuEntries(): List<Pair<Int, String>> {
        val vlc = vlcAudioTracks()
        val server = serverAudio
        val mapped = server != null && server.length() == vlc.size
        return vlc.mapIndexed { i, tr ->
            val t = if (mapped) server?.optJSONObject(i) else null
            tr.id to (if (t != null) audioLabel(t) else (tr.name ?: "Track ${i + 1}"))
        }
    }

    /** CODEC · layout · LANG · title, the web's trackLabel, plus a commentary
     *  tag when the title doesn't already say so. */
    private fun audioLabel(t: JSONObject): String {
        val bits = mutableListOf(t.optString("codec").uppercase(), t.optString("layout"))
        val lang = t.optString("language").takeIf { it.isNotEmpty() && it != "null" }
        if (lang != null) bits.add(lang.uppercase())
        val title = t.optString("title").takeIf { it.isNotEmpty() && it != "null" }
        if (title != null) bits.add(title)
        if (t.optBoolean("commentary", false) && title?.contains("comment", ignoreCase = true) != true) bits.add("commentary")
        return bits.filter { it.isNotEmpty() }.joinToString(" · ")
    }

    private fun selectAudio(id: Int) {
        userPickedAudio = true          // the automatic pick never overrides the viewer
        ui.removeCallbacks(autoAudio)
        try { player?.setAudioTrack(id) } catch (_: Exception) {}
        closeSubsMenu()
    }

    // ================= versions (other files of the same title) =================

    private var versions = JSONArray()   // [{fileId, quality, label}], best first

    private fun fetchVersions() {
        if (live || titleId <= 0) return
        net.execute {
            val body = http("GET", "$base/api/versions/$apiKind/$titleId", null) ?: return@execute
            try {
                val arr = JSONArray(body)
                ui.post { versions = arr; if (subsMenu.visibility == View.VISIBLE) renderSubsMenu() }
            } catch (_: Exception) {}
        }
    }

    /** The web's version switch: same title, same position, another file. The
     *  new file gets everything a fresh start gets (resume seek once Playing,
     *  captions forced off, its own soundtrack pick, its own play info), and
     *  progress keeps going to the same title. */
    private fun selectVersion(fid: Int) {
        closeSubsMenu()
        if (fid == fileId || live || inPreroll) return
        val next = streamPath(fid)
        if (next == streamPath()) return    // the spec's path can't be re-pointed: stay put
        rememberVersion(fid)
        tele("player", JSONObject().put("ev", "version").put("native", true)
            .put("title", spec.optString("title")).put("from", fileId).put("to", fid).put("at", positionSec.toInt()))
        fileId = fid
        startAt = positionSec
        resumeApplied = false
        subsForcedOff = false; userPickedSub = false; currentSubIdx = -1; subTracks = JSONArray()
        ui.removeCallbacks(autoAudio)
        serverAudio = null; audioAutoDone = false; userPickedAudio = false
        durationSec = 0.0; introStart = -1.0; introEnd = -1.0
        rebufferStartedAt = 0L
        playUrl(mediaUrl(next))
        fetchPlayInfo()
        fetchAudioList()
    }

    /** What the web's rememberVersion stores, so the next play of this title
     *  (on any device) opens on the same file. Server-side prefs, never local. */
    private fun rememberVersion(fid: Int) {
        val key = (if (apiKind == "episode") "verid:e" else "verid:m") + titleId
        val pref = JSONObject().put("key", key).put("value", fid).toString()
        net.execute { http("POST", "$base/api/prefs", pref) }
        var quality: String? = null
        for (i in 0 until versions.length()) {
            val v = versions.optJSONObject(i) ?: continue
            if (v.optInt("fileId", -1) == fid) quality = v.optString("quality").takeIf { it.isNotEmpty() && it != "null" }
        }
        if (quality != null) {
            val pq = JSONObject().put("key", "pq").put("value", quality).toString()
            net.execute { http("POST", "$base/api/prefs", pq) }
        }
    }

    // ================= remote keys =================

    // Selectable rows of the ▼ panel in display order (headers aren't in it),
    // each with a stable key so a re-render can keep the highlight in place.
    private val menuRows = ArrayList<TextView>()
    private val menuKeys = ArrayList<String>()
    private var aiRow: TextView? = null
    private var menuSel = 0
    private fun paintMenuSel() {
        for ((i, row) in menuRows.withIndex()) {
            val on = i == menuSel
            row.setBackgroundColor(if (on) Braun.panel2 else Color.TRANSPARENT)
            row.setTextColor(if (on) Braun.signal else Braun.ink2)
        }
        // With three sections the panel can run past the screen: keep the
        // highlighted row in view (after layout, so its position is known).
        menuRows.getOrNull(menuSel)?.let { row ->
            subsMenu.post {
                val h = subsMenu.height
                if (row.top < subsMenu.scrollY) subsMenu.smoothScrollTo(0, row.top)
                else if (row.bottom > subsMenu.scrollY + h) subsMenu.smoothScrollTo(0, row.bottom - h)
            }
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(event)
        // Pre-roll: locked, like the web player. Back still exits everything.
        if (inPreroll) {
            if (event.keyCode == KeyEvent.KEYCODE_BACK) finishWithResult()
            return true
        }
        // The ▼ menu drives its own selection.
        if (subsMenu.visibility == View.VISIBLE) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_BACK -> closeSubsMenu()
                KeyEvent.KEYCODE_DPAD_UP -> { if (menuSel > 0) menuSel--; paintMenuSel() }
                KeyEvent.KEYCODE_DPAD_DOWN -> { if (menuSel < menuRows.size - 1) menuSel++; paintMenuSel() }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> menuRows.getOrNull(menuSel)?.performClick()
            }
            return true
        }
        when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER ->
                if (skipIntroBtn.visibility == View.VISIBLE) skipIntroNow()
                else if (skipCreditsBtn.visibility == View.VISIBLE) skipCreditsNow()
                else togglePause()
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
            .putExtra("position", positionSec)
            .putExtra("fileId", fileId))
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
        titleView = TextView(this).apply { setTextColor(Braun.ink); typeface = Typeface.DEFAULT_BOLD; text = spec.optString("title") }
        sp(titleView, 18f)
        subView = TextView(this).apply { setTextColor(Braun.ink2); text = spec.optString("subtitle") }
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
        playIcon = TextView(this).apply {
            setTextColor(Braun.ink); typeface = Typeface.DEFAULT_BOLD; text = "❚❚"
            // Nothing to indicate on a channel: the state cannot change.
            visibility = if (live) View.GONE else View.VISIBLE
        }
        sp(playIcon, 15f)
        timeView = TextView(this).apply {
            setTextColor(if (live) Braun.signal else Braun.ink)
            letterSpacing = if (live) 0.3f else 0.06f
            text = if (live) "LIVE" else "0:00 / 0:00"
        }
        sp(timeView, 13f)
        val hint = TextView(this).apply {
            setTextColor(Braun.ink3)
            letterSpacing = 0.08f
            // ▼ opens one menu holding subtitles, audio and version (the last
            // two only when the file has a choice); the hint names what it's for.
            text = if (live) "▼ subtitles · audio · Back exit" else "OK play/pause · ◀ ▶ ±10s · ▼ subtitles · audio · Back exit"
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
            text = "SKIP INTRO ▸  (OK)"
            setTextColor(Braun.ink)
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.18f
            setPadding(dp(20), dp(11), dp(20), dp(11))
            background = GradientDrawable().apply {
                cornerRadius = 0f
                setColor(Color.argb(210, 20, 20, 22))
                setStroke(dp(1), Braun.rule)
            }
            visibility = View.GONE
        }
        sp(skipIntroBtn, 14f)
        root.addView(skipIntroBtn, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            rightMargin = dp(40); bottomMargin = dp(90)
        })

        // --- Skip Credits (same pill, same corner: the two never show at once,
        // one being at the start of an episode and the other at the end) ---
        skipCreditsBtn = TextView(this).apply {
            text = "SKIP CREDITS ▸  (OK)"
            setTextColor(Braun.ink)
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.18f
            setPadding(dp(20), dp(11), dp(20), dp(11))
            background = GradientDrawable().apply {
                cornerRadius = 0f
                setColor(Color.argb(210, 20, 20, 22))
                setStroke(dp(1), Braun.rule)
            }
            visibility = View.GONE
        }
        sp(skipCreditsBtn, 14f)
        root.addView(skipCreditsBtn, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            rightMargin = dp(40); bottomMargin = dp(90)
        })

        // --- Buffering splash (web-matched: MARQUEE gradient wordmark) ---
        bufferOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.argb(186, 14, 14, 22))
        }
        val brand = TextView(this).apply {
            text = "MARQUEE"
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.35f
        }
        sp(brand, 34f)
        brand.setTextColor(Braun.ink)
        val loading = TextView(this).apply { setTextColor(Braun.ink2); text = "LOADING…"; letterSpacing = 0.22f }
        sp(loading, 12f)
        bufferOverlay.addView(brand)
        bufferOverlay.addView(loading, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(14) })
        root.addView(bufferOverlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        // --- The ▼ menu: subtitles, audio, version (right-side dark panel, remote-driven) ---
        subsMenuList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(6), dp(10), dp(6), dp(10)) }
        subsMenu = ScrollView(this).apply {
            background = GradientDrawable().apply {
                cornerRadius = 0f
                setColor(Color.argb(246, 29, 29, 32))
                setStroke(dp(1), Braun.rule)
            }
            visibility = View.GONE
            addView(subsMenuList, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        root.addView(subsMenu, FrameLayout.LayoutParams(dp(340), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.END or Gravity.CENTER_VERTICAL).apply {
            rightMargin = dp(30)
        })

        skipIntroBtn.setOnClickListener { skipIntroNow() }
        skipCreditsBtn.setOnClickListener { skipCreditsNow() }
        setContentView(root)
    }

    private fun menuHeader(text: String): TextView = TextView(this).apply {
        this.text = text
        setTextColor(Braun.ink3)
        typeface = Typeface.DEFAULT_BOLD
        letterSpacing = 0.24f
        setPadding(dp(14), dp(8), dp(14), dp(8))
    }.also { sp(it, 11f) }

    private fun menuRow(text: String, selected: Boolean, onClick: () -> Unit): TextView = TextView(this).apply {
        this.text = if (selected) "✓ $text" else text
        setTextColor(Braun.ink2)
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

/** The app's palette, dark finish — the same values as the Apple TV app's
 *  Theme.black. Player chrome is ALWAYS the dark finish whatever the app is set
 *  to: it sits on top of a picture, and light chrome over a picture is
 *  unreadable. Signal is state and never decoration. */
private object Braun {
    val paper = Color.parseColor("#141416")
    val panel = Color.parseColor("#1D1D20")
    val panel2 = Color.parseColor("#232327")
    val sunk = Color.parseColor("#0E0E10")
    val ink = Color.parseColor("#EFEEE9")
    val ink2 = Color.parseColor("#8C8C86")
    val ink3 = Color.parseColor("#65655F")
    val rule = Color.parseColor("#33333A")
    val signal = Color.parseColor("#F26A16")
}

/** A scale, not a tube: a square track with a flat signal-coloured fill. */
private class ScrubView(ctx: android.content.Context, accent: Int, @Suppress("UNUSED_PARAMETER") accent2: Int) : View(ctx) {
    private var progress = 0f
    private val trackPaint = android.graphics.Paint().apply { color = Color.argb(46, 255, 255, 255) }
    private val fillPaint = android.graphics.Paint().apply { color = accent }

    fun setProgress(p: Float) { progress = p.coerceIn(0f, 1f); invalidate() }

    override fun onDraw(canvas: android.graphics.Canvas) {
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), trackPaint)
        if (progress > 0f) canvas.drawRect(0f, 0f, width * progress, height.toFloat(), fillPaint)
    }
}
