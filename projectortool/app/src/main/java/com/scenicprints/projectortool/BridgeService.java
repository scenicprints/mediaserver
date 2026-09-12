package com.scenicprints.projectortool;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The bridge, as a foreground service.
 *
 * The first version ran the socket inside the activity, which meant every action
 * that opened another app backgrounded this one, and a 2 GB Android 7.1 box then
 * killed the process — the tool cut its own connection on every useful command.
 * A foreground service with a boot receiver keeps it up whatever is on screen,
 * so the projector is reachable without anybody opening anything.
 */
public class BridgeService extends Service {

    private static final String CHANNEL = "bridge";
    private static final int NOTE_ID = 1;
    private volatile ServerSocket server;

    @Override
    public void onCreate() {
        super.onCreate();
        startForeground(NOTE_ID, buildNotification());
        startServer();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY; // let Android bring it back if it ever dies
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        super.onDestroy();
    }

    private Notification buildNotification() {
        String ip = Device.localIp();
        String text = "http://" + (ip == null ? "?" : ip) + ":" + Device.PORT;

        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Projector bridge", NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }

        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class),
                Build.VERSION.SDK_INT >= 23
                        ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                        : PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return b.setContentTitle("Projector Tool")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentIntent(open)
                .setOngoing(true)
                .build();
    }

    // ---------------------------------------------------------------- server

    private void startServer() {
        new Thread(() -> {
            try {
                server = new ServerSocket(Device.PORT);
                while (!Thread.currentThread().isInterrupted() && !server.isClosed()) {
                    Socket s = server.accept();
                    new Thread(() -> serve(s)).start();
                }
            } catch (Exception ignored) { /* port taken, or we're shutting down */ }
        }, "projector-bridge").start();
    }

    private void serve(Socket socket) {
        Context c = getApplicationContext();
        try (Socket s = socket) {
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            String line = in.readLine();
            if (line == null) return;
            String[] parts = line.split(" ");
            if (parts.length < 2) return;

            String target = parts[1];
            String path = target;
            Map<String, String> q = new LinkedHashMap<>();
            int qm = target.indexOf('?');
            if (qm >= 0) {
                path = target.substring(0, qm);
                for (String pair : target.substring(qm + 1).split("&")) {
                    int eq = pair.indexOf('=');
                    if (eq < 0) continue;
                    q.put(dec(pair.substring(0, eq)), dec(pair.substring(eq + 1)));
                }
            }

            if ("/".equals(path)) {
                send(s, 200, "text/plain; charset=utf-8",
                        "Projector Tool. Every call needs ?pin=NNNNNN\n"
                                + "/info /packages /logcat\n"
                                + "/settings?s=dev|home|apps|wifi|all\n"
                                + "/home   (fires the launcher chooser)\n"
                                + "/launch?pkg= | ?comp=pkg/class | ?action=\n"
                                + "/open?url=  [&pkg=]\n"
                                + "/install?url=   /uninstall?pkg=\n");
                return;
            }
            if (!Device.pin(c).equals(q.get("pin"))) {
                send(s, 403, "application/json", "{\"error\":\"bad or missing pin\"}");
                return;
            }

            switch (path) {
                case "/info":      send(s, 200, "application/json", Device.infoJson(c)); break;
                case "/packages":  send(s, 200, "application/json", Device.packagesJson(c)); break;
                case "/logcat":    send(s, 200, "text/plain; charset=utf-8", Device.logcat()); break;
                case "/settings":  send(s, 200, "application/json",
                        Device.ok(Device.openSettings(c, q.get("s")))); break;
                case "/home":      send(s, 200, "application/json",
                        Device.ok(Device.chooseHome(c))); break;
                case "/launch":    send(s, 200, "application/json",
                        Device.ok(Device.launch(c, q.get("pkg"), q.get("action"), q.get("comp")))); break;
                case "/open":      send(s, 200, "application/json",
                        Device.ok(Device.openUrl(c, q.get("url"), q.get("pkg")))); break;
                case "/install":   send(s, 200, "application/json",
                        Device.ok(Device.installFromUrl(c, q.get("url")))); break;
                case "/uninstall": send(s, 200, "application/json",
                        Device.ok(Device.uninstall(c, q.get("pkg")))); break;
                default:           send(s, 404, "application/json", "{\"error\":\"no such route\"}");
            }
        } catch (Exception ignored) { }
    }

    private static void send(Socket s, int code, String type, String body) throws Exception {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        OutputStream out = s.getOutputStream();
        String head = "HTTP/1.1 " + code + " OK\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + payload.length + "\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(payload);
        out.flush();
    }

    private static String dec(String s) {
        try { return URLDecoder.decode(s, "UTF-8"); } catch (Exception e) { return s; }
    }
}
