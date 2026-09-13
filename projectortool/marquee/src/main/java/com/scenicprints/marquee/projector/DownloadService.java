package com.scenicprints.marquee.projector;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Offline downloads, as a local web server.
 *
 * The requirement was that a downloaded film plays *in Marquee* — not handed off
 * to some other player. The simplest way to honour that is to keep it a video
 * URL: this service fetches a title from the media server, stores it on the
 * projector, and serves it back over HTTP on loopback. The web UI then points
 * its existing player at http://127.0.0.1:8098/file/<id> instead of
 * /api/stream/<id>, and everything downstream — subtitles, resume, the whole
 * player — carries on unchanged.
 *
 * Bound to the loopback address on purpose: nothing else on the network can
 * reach it, so the media never leaves the device it was downloaded to.
 *
 * Only titles the server reports as direct-play are worth storing. A file that
 * needs transcoding wouldn't play from disk either, so the web UI checks
 * /api/play before offering the button.
 */
public class DownloadService extends Service {

    static final int PORT = 8098;
    private static final String TAG = "MarqueeDownloads";
    private static final String CHANNEL = "downloads";
    private static final String ORIGIN = "https://marqu33.duckdns.org";

    private final Map<String, Entry> entries = new ConcurrentHashMap<>();
    private final ExecutorService workers = Executors.newFixedThreadPool(2);
    private volatile ServerSocket server;
    private File root;
    private File manifest;

    /** One stored (or in-flight) title. */
    private static class Entry {
        String id, kind, title, state = "queued";
        long got, total;
        String file;

        JSONObject toJson() throws Exception {
            JSONObject o = new JSONObject();
            o.put("id", id); o.put("kind", kind); o.put("title", title);
            o.put("state", state); o.put("got", got); o.put("total", total);
            o.put("file", file == null ? JSONObject.NULL : file);
            return o;
        }
    }

    // ------------------------------------------------------------- lifecycle

    @Override
    public void onCreate() {
        super.onCreate();
        root = new File(getExternalFilesDir(null), "downloads");
        if (!root.exists()) root.mkdirs();
        manifest = new File(getFilesDir(), "downloads.json");
        loadManifest();
        startForeground(2, notification());
        startServer();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private Notification notification() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(new NotificationChannel(
                        CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW));
            }
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setContentTitle("Marquee downloads")
                .setContentText("Offline library ready")
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setOngoing(true)
                .build();
    }

    // -------------------------------------------------------------- manifest

    private synchronized void loadManifest() {
        try {
            if (!manifest.exists()) return;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(
                    new FileInputStream(manifest), StandardCharsets.UTF_8))) {
                String l;
                while ((l = r.readLine()) != null) sb.append(l);
            }
            JSONArray arr = new JSONArray(sb.toString());
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Entry e = new Entry();
                e.id = o.getString("id");
                e.kind = o.optString("kind", "movie");
                e.title = o.optString("title", e.id);
                e.state = o.optString("state", "done");
                e.got = o.optLong("got");
                e.total = o.optLong("total");
                e.file = o.isNull("file") ? null : o.optString("file", null);
                // A download interrupted by a reboot is not "downloading" any
                // more, and claiming otherwise leaves a spinner forever.
                if ("downloading".equals(e.state) || "queued".equals(e.state)) e.state = "failed";
                if (e.file != null && !new File(e.file).exists()) continue; // pruned externally
                entries.put(e.id, e);
            }
        } catch (Exception ex) {
            Log.e(TAG, "manifest unreadable", ex);
        }
    }

    private synchronized void saveManifest() {
        try {
            JSONArray arr = new JSONArray();
            for (Entry e : entries.values()) arr.put(e.toJson());
            try (FileOutputStream out = new FileOutputStream(manifest)) {
                out.write(arr.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ex) {
            Log.e(TAG, "could not save manifest", ex);
        }
    }

    // -------------------------------------------------------------- download

    private String start(String id, String kind, String title, String token) {
        if (id == null || token == null) return "need id and token";
        Entry existing = entries.get(id);
        if (existing != null && "done".equals(existing.state)) return "already downloaded";

        Entry e = new Entry();
        e.id = id;
        e.kind = kind == null ? "movie" : kind;
        e.title = title == null ? id : title;
        e.state = "queued";
        entries.put(id, e);
        saveManifest();

        workers.submit(() -> fetch(e, token));
        return "started";
    }

    private void fetch(Entry e, String token) {
        HttpURLConnection c = null;
        File dest = new File(root, e.id + ".media");
        try {
            e.state = "downloading";
            saveManifest();

            String path = "episode".equals(e.kind) ? "/api/stream/episode/" : "/api/stream/";
            URL url = new URL(ORIGIN + path + e.id + "?token=" + token);
            c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            if (c.getResponseCode() / 100 != 2) throw new IOException("server said " + c.getResponseCode());
            e.total = c.getContentLength();

            byte[] buf = new byte[64 * 1024];
            long got = 0;
            long lastSave = 0;
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(dest)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    got += n;
                    e.got = got;
                    // Persisting every chunk would hammer the flash for no gain.
                    if (got - lastSave > 16 * 1024 * 1024) { lastSave = got; saveManifest(); }
                }
            }
            e.got = got;
            if (e.total <= 0) e.total = got;
            e.file = dest.getAbsolutePath();
            e.state = "done";
            saveManifest();
            Log.i(TAG, "downloaded " + e.title + " (" + got + " bytes)");
        } catch (Exception ex) {
            Log.e(TAG, "download failed for " + e.id, ex);
            e.state = "failed";
            saveManifest();
            // A partial file is worse than none: it would serve as a playable
            // URL and then cut off mid-film.
            if (dest.exists()) dest.delete();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private String delete(String id) {
        Entry e = entries.remove(id);
        if (e == null) return "not here";
        if (e.file != null) new File(e.file).delete();
        saveManifest();
        return "removed";
    }

    // ---------------------------------------------------------------- server

    private void startServer() {
        new Thread(() -> {
            try {
                server = new ServerSocket(PORT, 8, InetAddress.getByName("127.0.0.1"));
                while (!server.isClosed()) {
                    Socket s = server.accept();
                    workers.submit(() -> serve(s));
                }
            } catch (Exception ex) {
                Log.e(TAG, "local server stopped", ex);
            }
        }, "marquee-downloads").start();
    }

    private void serve(Socket socket) {
        try (Socket s = socket) {
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            String line = in.readLine();
            if (line == null) return;
            String[] parts = line.split(" ");
            if (parts.length < 2) return;

            String range = null;
            String h;
            while ((h = in.readLine()) != null && !h.isEmpty()) {
                if (h.toLowerCase().startsWith("range:")) range = h.substring(6).trim();
            }

            String target = parts[1];
            String path = target;
            Map<String, String> q = new LinkedHashMap<>();
            int qm = target.indexOf('?');
            if (qm >= 0) {
                path = target.substring(0, qm);
                for (String pair : target.substring(qm + 1).split("&")) {
                    int eq = pair.indexOf('=');
                    if (eq > 0) q.put(dec(pair.substring(0, eq)), dec(pair.substring(eq + 1)));
                }
            }

            if ("OPTIONS".equals(parts[0])) { send(s, 204, "text/plain", ""); return; }

            if (path.startsWith("/file/")) { serveFile(s, path.substring(6), range); return; }

            switch (path) {
                case "/ping":   send(s, 200, "application/json", "{\"ok\":true,\"version\":1}"); break;
                case "/list":   send(s, 200, "application/json", listJson()); break;
                case "/start":  send(s, 200, "application/json", result(
                        start(q.get("id"), q.get("kind"), q.get("title"), q.get("token")))); break;
                case "/delete": send(s, 200, "application/json", result(delete(q.get("id")))); break;
                default:        send(s, 404, "application/json", "{\"error\":\"no such route\"}");
            }
        } catch (Exception ignored) { }
    }

    private String listJson() {
        JSONArray arr = new JSONArray();
        for (Entry e : entries.values()) {
            try { arr.put(e.toJson()); } catch (Exception ignored) { }
        }
        return arr.toString();
    }

    /** Range-capable, because the player seeks and <video> expects 206s. */
    private void serveFile(Socket s, String id, String range) throws Exception {
        Entry e = entries.get(id);
        if (e == null || e.file == null || !"done".equals(e.state)) {
            send(s, 404, "application/json", "{\"error\":\"not downloaded\"}");
            return;
        }
        File f = new File(e.file);
        long len = f.length();
        long from = 0, to = len - 1;
        boolean partial = false;

        if (range != null && range.startsWith("bytes=")) {
            String[] bits = range.substring(6).split("-", 2);
            try {
                if (!bits[0].isEmpty()) from = Long.parseLong(bits[0].trim());
                if (bits.length > 1 && !bits[1].trim().isEmpty()) to = Long.parseLong(bits[1].trim());
            } catch (NumberFormatException ignored) { }
            if (from < 0 || from >= len) { send(s, 416, "text/plain", ""); return; }
            if (to >= len) to = len - 1;
            partial = true;
        }

        long count = to - from + 1;
        OutputStream out = s.getOutputStream();
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(partial ? "206 Partial Content" : "200 OK").append("\r\n")
                .append("Content-Type: video/mp4\r\n")
                .append("Accept-Ranges: bytes\r\n")
                .append("Content-Length: ").append(count).append("\r\n")
                .append("Access-Control-Allow-Origin: *\r\n");
        if (partial) {
            head.append("Content-Range: bytes ").append(from).append('-').append(to)
                    .append('/').append(len).append("\r\n");
        }
        head.append("Connection: close\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.UTF_8));

        try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
            raf.seek(from);
            byte[] buf = new byte[64 * 1024];
            long left = count;
            while (left > 0) {
                int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
                if (n <= 0) break;
                out.write(buf, 0, n);
                left -= n;
            }
        }
        out.flush();
    }

    // -------------------------------------------------------------- plumbing

    private static String result(String message) {
        return "{\"result\":\"" + message.replace("\"", "\\\"") + "\"}";
    }

    private static void send(Socket s, int code, String type, String body) throws Exception {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + code + " OK\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + payload.length + "\r\n"
                // The page is served from the media server's origin, so every
                // call here is cross-origin and needs this to be readable.
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Headers: *\r\n"
                + "Connection: close\r\n\r\n";
        OutputStream out = s.getOutputStream();
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(payload);
        out.flush();
    }

    private static String dec(String s) {
        try { return URLDecoder.decode(s, "UTF-8"); } catch (Exception e) { return s; }
    }

    @Override
    public void onDestroy() {
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        workers.shutdownNow();
        super.onDestroy();
    }
}
