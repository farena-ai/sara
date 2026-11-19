package com.backstagecoding.sara;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Instant notifications without any outside service (Phase 18, optional): keeps one quiet
 * connection to the server's event stream and shows her messages the moment they arrive. Android
 * requires a small ongoing notification for this. Off: the 15-minute check (InboxJob) still runs.
 */
public class LiveInbox extends Service {
    private static final int ONGOING_ID = 7861;
    private static final String CHANNEL = "connection";
    private volatile boolean running;
    private volatile HttpURLConnection current;
    private Thread thread;

    /** Phase 68: another server is in use: reconnect to it. */
    static void restart(Context c) {
        try {
            c.stopService(new Intent(c, LiveInbox.class));
        } catch (Exception ignored) {
            // not running
        }
        sync(c);
    }

    /** Starts or stops the service to match the setting. */
    static void sync(Context c) {
        boolean on = Net.prefs(c).getBoolean("instant", false) && Net.server(c) != null;
        Intent i = new Intent(c, LiveInbox.class);
        try {
            if (on) c.startForegroundService(i);
            else c.stopService(i);
        } catch (Exception ignored) {
            // not allowed right now (e.g. app in the background); the next app start retries
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_live), NotificationManager.IMPORTANCE_MIN);
        ch.setShowBadge(false);
        if (nm != null) nm.createNotificationChannel(ch);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(Notify.COLOR)
                .setContentTitle(getString(R.string.live_title))
                .setContentText(getString(R.string.live_text))
                .setOngoing(true)
                .setGroup("connection")
                .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE))
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(ONGOING_ID, n);
        if (thread == null || !thread.isAlive()) {
            running = true;
            thread = new Thread(this::loop, "sara-inbox");
            thread.start();
        }
        return START_STICKY;
    }

    private void loop() {
        long backoff = 5000;
        while (running) {
            String server = Net.server(this);
            if (server == null) break;
            try {
                listen(server);
                backoff = 5000;
            } catch (Exception e) {
                // offline or the server restarted: try again
            }
            if (!running) break;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                break;
            }
            backoff = Math.min(backoff * 2, 120_000);
        }
    }

    private void listen(String server) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(server + "/api/events").openConnection();
        current = con;
        con.setConnectTimeout(15000);
        // The server pings every 25 s; silence for 70 s means the connection is gone.
        con.setReadTimeout(70000);
        String cookie = CookieManager.getInstance().getCookie(server);
        if (cookie != null) con.setRequestProperty("Cookie", cookie);
        con.setRequestProperty("Accept", "text/event-stream");
        con.setRequestProperty("User-Agent", "SaraPhone/1");
        if (con.getResponseCode() != 200) {
            con.disconnect();
            throw new Exception("status " + con.getResponseCode());
        }
        // Catch up on anything sent while we weren't connected.
        InboxJob.check(this);
        try (BufferedReader r = new BufferedReader(new InputStreamReader(con.getInputStream(), StandardCharsets.UTF_8))) {
            String event = "message";
            StringBuilder data = new StringBuilder();
            for (String line; running && (line = r.readLine()) != null; ) {
                if (line.isEmpty()) {
                    if (data.length() > 0) handle(event, data.toString());
                    event = "message";
                    data.setLength(0);
                } else if (line.startsWith("event:")) {
                    event = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(line.substring(5).trim());
                }
            }
        } finally {
            con.disconnect();
        }
    }

    private void handle(String event, String data) {
        if ("ring".equals(event)) {
            ring(data);
            return;
        }
        // Phase 29: reminders changed; the places to watch may have too.
        if ("planner".equals(event)) {
            if (Places.on(this)) Places.syncAsync(this);
            return;
        }
        // U2.9: a person wrote (the Messages page): the app's own check shows it (cursor, quiet rules, badge).
        if ("pm".equals(event)) {
            if (data.contains("\"notice\":true") && !MainActivity.visible) new Thread(() -> InboxJob.check(this)).start();
            return;
        }
        // W1.3: Continue on my phone: the app's own check shows it (once per handoff, with the chat to open).
        if ("continue".equals(event)) {
            if (!MainActivity.visible) new Thread(() -> InboxJob.check(this)).start();
            return;
        }
        // Phase 31: another companion on the same server called or wrote.
        if ("other".equals(event)) {
            other(data);
            return;
        }
        if (!"message".equals(event)) return;
        try {
            JSONObject ev = new JSONObject(data);
            JSONObject m = ev.getJSONObject("message");
            if ("notice".equals(m.optString("role")) || "user".equals(m.optString("role"))) return;
            long id = m.optLong("id");
            long last = Net.prefs(this).getLong("lastId", 0);
            if (id > last) Net.prefs(this).edit().putLong("lastId", id).apply();
            if (MainActivity.visible || id <= last) return;
            String name = Net.prefs(this).getString("name", "Sara");
            Notify.message(this, name, ev.optString("conversationId"), id, m.optString("content"), ev.optString("reason"));
            WidgetProvider.refresh(this);
        } catch (Exception ignored) {
            // not a message we understand
        }
    }

    /** Phase 31: another companion's call or message (named after her). */
    private void other(String data) {
        try {
            JSONObject n = new JSONObject(data);
            String name = n.optString("name", "Sara");
            if ("ring".equals(n.optString("kind"))) {
                JSONObject r = n.getJSONObject("ring");
                if (!"ringing".equals(r.optString("state"))) {
                    Notify.endRing(this);
                    return;
                }
                // The app is open: the page shows "<name> is calling" itself.
                if (MainActivity.visible) return;
                long expires;
                try {
                    expires = java.time.Instant.parse(r.optString("expiresAt")).toEpochMilli();
                } catch (Exception ignored) {
                    expires = System.currentTimeMillis() + 45000;
                }
                Notify.incoming(this, name, r.optString("id"), r.optString("conversationId"), r.optString("reason"), expires);
                return;
            }
            if (!"assistant".equals(n.optString("role"))) return;
            String key = "lastId-" + n.optString("companion");
            long id = n.optLong("messageId");
            long last = Net.prefs(this).getLong(key, 0);
            if (id > last) Net.prefs(this).edit().putLong(key, id).apply();
            if (id <= last || MainActivity.visible) return;
            Notify.message(this, name, n.optString("conversationId"), id, n.optString("preview"), "proactive");
        } catch (Exception e) {
            android.util.Log.w("Sara", "Couldn't show another companion's call or message", e);
        }
    }

    /** Phase 26: her call rings here (or stops ringing when it ended anywhere). */
    private void ring(String data) {
        try {
            JSONObject r = new JSONObject(data).getJSONObject("ring");
            if (!"ringing".equals(r.optString("state"))) {
                Notify.endRing(this);
                return;
            }
            // The app is open: the page shows the call itself.
            if (MainActivity.visible) return;
            long expires = 0;
            try {
                expires = java.time.Instant.parse(r.optString("expiresAt")).toEpochMilli();
            } catch (Exception ignored) {
                expires = System.currentTimeMillis() + 45000;
            }
            String name = Net.prefs(this).getString("name", "Sara");
            Notify.incoming(this, name, r.optString("id"), r.optString("conversationId"), r.optString("reason"), expires);
        } catch (Exception e) {
            android.util.Log.w("Sara", "Couldn't show her call", e);
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection c = current;
        if (c != null) new Thread(c::disconnect).start();
        if (thread != null) thread.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
