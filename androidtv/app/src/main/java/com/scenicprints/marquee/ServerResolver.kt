package com.scenicprints.marquee

import android.content.Context
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Finds the server on the home network when the internet is gone. The shell
 * used to know only the public name, so an outage stranded a TV sitting on the
 * same LAN as the Dell. This is the client half of docs/LAN.md, and that file
 * is the spec: if the protocol changes, change it there and in every client.
 *
 * Everything here blocks, so call resolve() and learn() off the main thread.
 * State lives in the app's "marquee" SharedPreferences (lanBases, serverId,
 * lanKey, token, pairId, lastBase). Which LAN bases passed the proof check in
 * this process is kept in memory only: a pass is only good for the network it
 * happened on, so it must be earned again after every restart.
 */
class ServerResolver(context: Context) {

    companion object {
        /** The public HTTPS address. Always safe to talk to: TLS proves who it is. */
        const val PUBLIC_BASE = "https://marqu33.duckdns.org"

        private const val LAN_TIMEOUT_MS = 2500
        private const val PUBLIC_TIMEOUT_MS = 6000
        private const val LEARN_TIMEOUT_MS = 6000

        // LAN bases that answered with a correct proof in this process. Shared by
        // every resolver instance so an activity recreate doesn't forget them.
        private val verifiedLan: MutableSet<String> = Collections.synchronizedSet(HashSet())

        private val rng = SecureRandom()
        private const val ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

        fun randomId(len: Int): String {
            val sb = StringBuilder(len)
            repeat(len) { sb.append(ALNUM[rng.nextInt(ALNUM.length)]) }
            return sb.toString()
        }

        /** scheme://host[:port] of a URL, or null for anything that isn't http(s). */
        fun originOf(url: String?): String? = try {
            if (url == null) null else {
                val u = URL(url)
                if (u.protocol != "http" && u.protocol != "https") null
                else "${u.protocol}://${u.host}${if (u.port > 0) ":${u.port}" else ""}"
            }
        } catch (_: Exception) { null }
    }

    /** What a resolve settled on. `base` is null when nothing answered. */
    class Result(val base: String?, val viaLan: Boolean)

    private val sp = context.applicationContext.getSharedPreferences("marquee", Context.MODE_PRIVATE)

    // ---- persisted state ----

    /** Random, made once per install. It is a credential (the server trades it
     *  for the session token), so it only ever goes to trusted bases. */
    val pairId: String

    init {
        val saved = sp.getString("pairId", null)
        pairId = if (saved != null && saved.length >= 32 && saved.all { it in ALNUM }) saved else {
            val id = randomId(40)
            sp.edit().putString("pairId", id).apply()
            id
        }
    }

    val token: String? get() = sp.getString("token", null)?.takeIf { it.isNotEmpty() }

    var lastBase: String?
        get() = sp.getString("lastBase", null)
        set(v) { sp.edit().putString("lastBase", v).apply() }

    private fun lanBases(): List<String> = try {
        val arr = JSONArray(sp.getString("lanBases", "[]"))
        (0 until arr.length()).mapNotNull { cleanLan(arr.optString(it)) }.distinct()
    } catch (_: Exception) { emptyList() }

    /** True when something we already load can be trusted with the pair id and
     *  the session: the public HTTPS base, or a LAN base that proved itself. */
    fun isTrusted(base: String?): Boolean =
        base != null && (base == PUBLIC_BASE || verifiedLan.contains(base))

    // ================= resolving =================

    /**
     * Race the cached LAN bases against the public base (docs/LAN.md, Resolving).
     * The first LAN pass wins outright; public is taken only once every LAN probe
     * has failed or run out of time. With nothing cached there is nothing to race,
     * so public comes back at once and a first launch is never slowed down.
     */
    fun resolve(): Result {
        val key = sp.getString("lanKey", null)?.takeIf { it.isNotEmpty() }
            ?: return Result(PUBLIC_BASE, false)
        val id = sp.getString("serverId", null)?.takeIf { it.isNotEmpty() }
            ?: return Result(PUBLIC_BASE, false)
        val lans = lanBases()
        if (lans.isEmpty()) return Result(PUBLIC_BASE, false)

        // A private pool per resolve: probes that outlive the decision just run
        // into their own timeouts and die with it.
        val pool = Executors.newFixedThreadPool(lans.size + 1)
        val results = LinkedBlockingQueue<Pair<String, Boolean>>()
        try {
            pool.execute { results.put(PUBLIC_BASE to probePublic()) }
            for (lan in lans) pool.execute { results.put(lan to probeLan(lan, key, id)) }

            val start = SystemClock.elapsedRealtime()
            // HttpURLConnection's connect and read timeouts stack, so the wall
            // clock decides when a probe has "timed out", not the connection.
            val lanDeadline = start + LAN_TIMEOUT_MS + 500
            val publicDeadline = start + PUBLIC_TIMEOUT_MS + 500
            var lanPending = lans.size
            var publicOk: Boolean? = null
            while (true) {
                val now = SystemClock.elapsedRealtime()
                val lanDone = lanPending == 0 || now >= lanDeadline
                if (lanDone && publicOk == true) return Result(PUBLIC_BASE, false)
                if (lanDone && (publicOk == false || now >= publicDeadline)) return Result(null, false)
                val wait = (if (!lanDone) lanDeadline else publicDeadline) - now
                val r = results.poll(maxOf(wait, 1L), TimeUnit.MILLISECONDS) ?: continue
                if (r.first == PUBLIC_BASE) {
                    publicOk = r.second
                } else if (r.second) {
                    verifiedLan.add(r.first)
                    return Result(r.first, true)
                } else {
                    verifiedLan.remove(r.first)
                    lanPending--
                }
            }
        } catch (_: Exception) {
            // Interrupted or a pool failure: treat it as "nothing answered".
        } finally {
            pool.shutdown()
        }
        return Result(null, false)
    }

    /** Passes only on a correct proof for OUR server. Sends nothing secret: the
     *  nonce is fresh and useless to anyone else. */
    private fun probeLan(base: String, key: String, id: String): Boolean {
        val nonce = randomId(32)
        val (code, body) = get("$base/api/lan?nonce=$nonce", LAN_TIMEOUT_MS) ?: return false
        if (code != 200 || body == null) return false
        return try {
            val j = JSONObject(body)
            val proof = j.optString("proof", "")
            j.optString("app") == "marquee" &&
                j.optString("id") == id &&
                proof.isNotEmpty() &&
                MessageDigest.isEqual(proof.toByteArray(Charsets.UTF_8), hmacHex(key, "marquee-lan:$nonce").toByteArray(Charsets.UTF_8))
        } catch (_: Exception) { false }
    }

    /** Any answer below 500 proves the server is up (an old build answers 401). */
    private fun probePublic(): Boolean {
        val (code, _) = get("$PUBLIC_BASE/api/lan", PUBLIC_TIMEOUT_MS) ?: return false
        return code in 1..499
    }

    // ================= learning =================

    /**
     * Ask a trusted base for the LAN addresses, server id, proof key and the
     * session token bound to our pair id (docs/LAN.md, Learning). Returns true
     * when a token came back. Refuses outright for an unverified LAN base,
     * because the pair id would hand that host our session.
     */
    fun learn(base: String): Boolean {
        if (!isTrusted(base)) return false
        val pair = URLEncoder.encode(pairId, "UTF-8")
        val (code, body) = get("$base/api/lan?pair=$pair", LEARN_TIMEOUT_MS) ?: return false
        if (code != 200 || body == null) return false
        val j = try { JSONObject(body) } catch (_: Exception) { return false }
        if (j.optString("app") != "marquee") return false

        val ed = sp.edit()
        j.optJSONArray("lan")?.let { arr ->
            val clean = JSONArray()
            for (i in 0 until arr.length()) cleanLan(arr.optString(i))?.let { clean.put(it) }
            ed.putString("lanBases", clean.toString())
        }
        j.optString("id").takeIf { it.isNotEmpty() }?.let { ed.putString("serverId", it) }
        j.optString("key").takeIf { it.isNotEmpty() }?.let { ed.putString("lanKey", it) }
        // The server only returns the token while the pair is registered and its
        // session is still valid, so a missing token means ours is dead (signed
        // out, or never registered yet). Forget it rather than hand a dead
        // session to the next origin over a live one.
        val tok = j.optString("token")
        if (tok.isNotEmpty()) ed.putString("token", tok) else ed.remove("token")
        ed.apply()
        return tok.isNotEmpty()
    }

    // ================= helpers =================

    /** A LAN entry we are willing to probe: http(s)://host[:port], no path. */
    private fun cleanLan(s: String?): String? {
        val o = originOf(s?.trim()) ?: return null
        return if (o == PUBLIC_BASE) null else o
    }

    private fun hmacHex(key: String, msg: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val out = mac.doFinal(msg.toByteArray(Charsets.UTF_8))
        val hex = "0123456789abcdef"
        val sb = StringBuilder(out.size * 2)
        for (b in out) {
            val v = b.toInt() and 0xff
            sb.append(hex[v ushr 4]).append(hex[v and 0x0f])
        }
        return sb.toString()
    }

    /** Plain GET: (status, body when 2xx), or null if nothing answered. No
     *  cookies (HttpURLConnection doesn't share the WebView's jar) and no
     *  redirects, so a probe can't be bounced somewhere with our query string. */
    private fun get(url: String, timeoutMs: Int): Pair<Int, String?>? {
        var conn: HttpURLConnection? = null
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            conn = c
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.instanceFollowRedirects = false
            c.useCaches = false
            c.setRequestProperty("Accept", "application/json")
            val code = c.responseCode
            val body = if (code in 200..299) c.inputStream.bufferedReader().use { it.readText() } else null
            code to body
        } catch (_: Exception) {
            null
        } finally {
            try { conn?.disconnect() } catch (_: Exception) {}
        }
    }
}
