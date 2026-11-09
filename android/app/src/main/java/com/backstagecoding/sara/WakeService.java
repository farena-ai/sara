package com.backstagecoding.sara;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.media.ToneGenerator;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * Phase 126 (docs/design/WAKE.md §6.4): Hey Sara on Android, a microphone foreground service the
 * person starts from a visible screen (the switch in Settings → Hey Sara, the notification's Resume,
 * the Quick Settings tile). Its ongoing notification says "Listening for “Hey Sara”" with Talk,
 * Pause 1 h and Stop, and Android shows its own microphone dot while the microphone is open.
 *
 * C17: the phrase itself is heard on the phone. The keyword spotter (Kws, sherpa-onnx inside the
 * signed app, the model checked from her own server) reads 16 kHz audio in memory and only hands
 * back a label; nothing is sent until it hears her phrase. Then the exchange runs here: it records
 * (until 0.8 s of quiet, 15 s at most), sends it to /api/wake/turn with the app's sign-in, plays her
 * pieces in order (the AI notice first, crisis resources in full, then her reply) and shows what she
 * heard and said. The audio is never kept. Off by default; the microphone is closed (and Android's
 * dot goes away) whenever it waits: Pause 1 h, "only while charging", "only while Sara is open",
 * low battery or Battery Saver, his quiet hours (the server says "quiet"), another app recording.
 * A build without the engine (the fetch script not run) keeps Talk only.
 */
public class WakeService extends Service {
    static final String ACTION_START = "com.backstagecoding.sara.WAKE_START";
    static final String ACTION_TALK = "com.backstagecoding.sara.WAKE_TALK";
    static final String ACTION_PAUSE = "com.backstagecoding.sara.WAKE_PAUSE";
    static final String ACTION_RESUME = "com.backstagecoding.sara.WAKE_RESUME";
    static final String ACTION_STOP = "com.backstagecoding.sara.WAKE_STOP";
    static final String CHANNEL = "hey-sara";
    static final String CHANNEL_HEARD = "hey-sara-heard";
    static final int NOTE_ID = 126;
    static final int HEARD_ID = 127;
    static final int BOOT_ID = 128;

    static volatile String state = "off";
    /** Why the microphone is closed while the service runs ("" = listening; see web/wake.js PAUSE_WORDS). */
    static volatile String reason = "";
    /** Set by MainActivity.onStart/onStop, for "only while Sara is open". */
    static volatile boolean appVisible = false;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean talking = false;
    private long pausedUntil = 0;
    private volatile Thread listener;
    private volatile boolean charging = false;
    private BroadcastReceiver power;
    private volatile String keywords = "";
    private volatile String serverPause = "";
    private volatile org.json.JSONObject companions = new org.json.JSONObject();
    private long configAt = 0;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("hey-sara", MODE_PRIVATE);
    }
    static boolean on(Context c) {
        return prefs(c).getBoolean("on", false);
    }

    /** Only from a visible screen (Android 14+ won't start a microphone service from the background). */
    static void start(Context c, String action) {
        Intent i = new Intent(c, WakeService.class).setAction(action);
        if (ACTION_STOP.equals(action)) {
            // Play 2.88: Stop never goes through startForegroundService. A service started that way
            // must call startForeground, and Stop doesn't, so switching off while nothing listened
            // crashed the app (ForegroundServiceDidNotStartInTimeException).
            prefs(c).edit().putBoolean("on", false).apply();
            if (!running) {
                state = "off";
                reason = "";
                return;
            }
            try {
                c.startService(i);
            } catch (IllegalStateException e) {
                c.stopService(new Intent(c, WakeService.class));
            }
            return;
        }
        c.startForegroundService(i);
    }

    /** Is the service up (between onCreate and onDestroy)? */
    static volatile boolean running;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void channels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.channel_hey), NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_HEARD, getString(R.string.channel_hey_heard), NotificationManager.IMPORTANCE_HIGH));
    }

    private PendingIntent self(String action, int code) {
        return PendingIntent.getService(this, code, new Intent(this, WakeService.class).setAction(action), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification ongoing() {
        boolean paused = "paused".equals(state) || !reason.isEmpty();
        String text = "paused".equals(state) ? getString(R.string.hey_paused_text) : pausedText(reason);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(Notify.COLOR)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentTitle(paused ? getString(R.string.hey_paused) : getString(R.string.hey_listening))
                .setContentText(paused ? text : getString(Kws.available() ? R.string.hey_listening_wake : R.string.hey_listening_text))
                .setContentIntent(PendingIntent.getActivity(this, 1260, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        if (!paused) b.addAction(new Notification.Action.Builder(null, getString(R.string.hey_talk), self(ACTION_TALK, 1261)).build());
        boolean hour = "paused".equals(state);
        b.addAction(new Notification.Action.Builder(null, hour ? getString(R.string.hey_resume) : getString(R.string.hey_pause), self(hour ? ACTION_RESUME : ACTION_PAUSE, 1262)).build());
        b.addAction(new Notification.Action.Builder(null, getString(R.string.hey_stop), self(ACTION_STOP, 1263)).build());
        return b.build();
    }

    private String pausedText(String why) {
        switch (why) {
            case "charging": return getString(R.string.hey_paused_charging);
            case "battery": return getString(R.string.hey_paused_battery);
            case "open": return getString(R.string.hey_paused_open);
            case "quiet": return getString(R.string.hey_paused_quiet);
            case "mic": return getString(R.string.hey_paused_mic);
            case "pack": return getString(R.string.hey_pack);
            default: return getString(R.string.hey_paused_text);
        }
    }

    /** Updates the ongoing notification from any thread (startForeground only from onStartCommand). */
    private void refresh() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && !"off".equals(state)) nm.notify(NOTE_ID, ongoing());
    }

    private void setReason(String why) {
        String w = why == null ? "" : why;
        if (w.equals(reason)) return;
        reason = w;
        refresh();
    }

    private void show() {
        Notification n = ongoing();
        if (Build.VERSION.SDK_INT >= 30) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        else startForeground(NOTE_ID, n);
    }

    private void heard(String title, String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        Notification n = new Notification.Builder(this, CHANNEL_HEARD).setSmallIcon(R.drawable.ic_notify).setColor(Notify.COLOR).setContentTitle(title).setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true).build();
        nm.notify(HEARD_ID, n);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        channels();
        running = true;
        String a = intent == null ? ACTION_START : String.valueOf(intent.getAction());
        if (ACTION_STOP.equals(a)) {
            prefs(this).edit().putBoolean("on", false).apply();
            state = "off";
            reason = "";
            listener = null;
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE.equals(a)) {
            state = "paused";
            pausedUntil = System.currentTimeMillis() + 3600_000L;
            main.postDelayed(() -> {
                if ("paused".equals(state) && System.currentTimeMillis() >= pausedUntil) {
                    state = "asleep";
                    show();
                    startListening();
                }
            }, 3600_000L);
        } else if (ACTION_RESUME.equals(a) || ACTION_START.equals(a)) {
            prefs(this).edit().putBoolean("on", true).apply();
            state = "asleep";
        }
        show();
        if (!"paused".equals(state)) startListening();
        if (ACTION_TALK.equals(a) && !talking && !"paused".equals(state)) {
            talking = true;
            new Thread(() -> talk("TALK"), "sara-talk").start();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        state = "off";
        listener = null;
        if (power != null) {
            try {
                unregisterReceiver(power);
            } catch (Exception ignored) {
                // already gone
            }
            power = null;
        }
        super.onDestroy();
    }

    // ---------------- listening for the phrase (C17) ----------------

    private void startListening() {
        if (power == null) {
            power = new BroadcastReceiver() {
                @Override
                public void onReceive(Context c, Intent i) {
                    charging = Intent.ACTION_POWER_CONNECTED.equals(i.getAction());
                }
            };
            IntentFilter f = new IntentFilter();
            f.addAction(Intent.ACTION_POWER_CONNECTED);
            f.addAction(Intent.ACTION_POWER_DISCONNECTED);
            registerReceiver(power, f);
            BatteryManager bm = getSystemService(BatteryManager.class);
            charging = bm != null && bm.isCharging();
        }
        if (listener != null && listener.isAlive()) return;
        Thread t = new Thread(this::listenLoop, "sara-wake");
        listener = t;
        t.start();
    }

    /** Why the microphone stays closed now, or null to listen. */
    private String whyNot() {
        if ("paused".equals(state)) return "hour";
        SharedPreferences p = prefs(this);
        if (p.getBoolean("onlyOpen", false) && !appVisible) return "open";
        if (p.getBoolean("onlyCharging", false) && !charging) return "charging";
        if (!charging) {
            PowerManager pm = getSystemService(PowerManager.class);
            BatteryManager bm = getSystemService(BatteryManager.class);
            int level = bm == null ? 100 : bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            if ((pm != null && pm.isPowerSaveMode()) || (level > 0 && level < 20)) return "battery";
        }
        if (!serverPause.isEmpty()) return serverPause;
        return null;
    }

    /** /api/wake/config every 60 s: her phrases' keyword lines, the server's pause ("quiet"…), a remote off. */
    private void maybeConfig() {
        long now = System.currentTimeMillis();
        if (now - configAt < 60_000L) return;
        configAt = now;
        try {
            String srv = Net.server(this);
            if (srv == null || srv.isEmpty()) return;
            Net.Response r = Net.get(this, srv + "/api/wake/config?platform=android");
            if (r.status != 200) return;
            JSONObject c = new JSONObject(r.text());
            StringBuilder lines = new StringBuilder();
            org.json.JSONObject map = new org.json.JSONObject();
            JSONArray ph = c.optJSONArray("phrases");
            for (int i = 0; ph != null && i < ph.length(); i++) {
                JSONObject one = ph.getJSONObject(i);
                map.put(one.optString("label"), one.optString("companionId"));
                JSONArray ls = one.optJSONArray("lines");
                for (int j = 0; ls != null && j < ls.length(); j++) lines.append(ls.getString(j)).append('\n');
            }
            keywords = lines.toString();
            companions = map;
            serverPause = c.optString("paused", "");
            if (!c.optBoolean("on", true) && c.has("offBy")) {
                // Switched off from another of his devices (or everywhere): off here too, visibly.
                prefs(this).edit().putBoolean("on", false).apply();
                main.post(() -> start(this, ACTION_STOP));
            }
        } catch (Exception ignored) {
            // the server is away: keep the last lines
        }
    }

    private static AudioRecord openMic() {
        int rate = 16000;
        int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        try {
            AudioRecord r = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, rate));
            if (r.getState() != AudioRecord.STATE_INITIALIZED) {
                r.release();
                return null;
            }
            r.startRecording();
            return r;
        } catch (SecurityException | IllegalStateException e) {
            return null;
        }
    }

    private static void closeMic(AudioRecord r) {
        if (r == null) return;
        try {
            r.stop();
        } catch (IllegalStateException ignored) {
            // not started
        }
        r.release();
    }

    private void listenLoop() {
        if (!Kws.available()) {
            setReason("");
            return; // Talk only in this build
        }
        if (!Kws.ready(this)) {
            setReason("pack");
            if (Kws.install(this) != null) {
                setReason("pack");
                return;
            }
        }
        Kws kws = null;
        String kwFor = null;
        AudioRecord mic = null;
        short[] buf = new short[1600]; // 100 ms
        long zeroMs = 0;
        try {
            while (listener == Thread.currentThread() && !"off".equals(state)) {
                maybeConfig();
                String why = whyNot();
                if (why == null && (kws == null || !keywords.equals(kwFor))) {
                    if (kws != null) kws.close();
                    kws = Kws.open(this, keywords.isEmpty() ? "HH EY1 S EH1 R AH0 :1.5 #0.25 @W1\nHH EY1 S AA1 R AH0 :1.5 #0.25 @W1" : keywords);
                    kwFor = keywords;
                    if (kws == null) why = "pack";
                }
                if (why != null || talking) {
                    closeMic(mic);
                    mic = null;
                    if (why != null) setReason(why);
                    Thread.sleep(1000);
                    continue;
                }
                if (mic == null) {
                    mic = openMic();
                    if (mic == null) {
                        setReason("mic");
                        Thread.sleep(5000);
                        continue;
                    }
                }
                int n = mic.read(buf, 0, buf.length);
                if (n <= 0) {
                    closeMic(mic);
                    mic = null;
                    continue;
                }
                boolean silent = true;
                for (int i = 0; i < n && silent; i++) silent = buf[i] == 0;
                // Another app holds the microphone: Android hands Sara exact zeros. Say so, don't pretend.
                zeroMs = silent ? zeroMs + n / 16 : 0;
                setReason(zeroMs > 3000 ? "mic" : "");
                String label = kws.feed(buf, n);
                if (label != null && label.startsWith("W")) {
                    closeMic(mic);
                    mic = null;
                    talking = true;
                    talk(label);
                }
            }
        } catch (InterruptedException ignored) {
            // stopping
        } finally {
            closeMic(mic);
            if (kws != null) kws.close();
        }
    }

    private void chime() {
        if (!prefs(this).getBoolean("chime", true)) return;
        try {
            ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 60);
            tg.startTone(ToneGenerator.TONE_PROP_BEEP, 150);
            main.postDelayed(tg::release, 400);
        } catch (RuntimeException ignored) {
            // no tone on this phone
        }
    }

    // ---------------- the exchange (Talk) ----------------

    /** Records 16 kHz mono until 0.8 s of quiet after speech (15 s at most, 5 s with nothing said). */
    private byte[] record() {
        int rate = 16000;
        int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord r;
        try {
            r = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, rate));
        } catch (SecurityException e) {
            return null;
        }
        if (r.getState() != AudioRecord.STATE_INITIALIZED) return null;
        ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        short[] buf = new short[320];
        float floor = 0.006f;
        boolean spoke = false;
        int quiet = 0, total = 0;
        r.startRecording();
        try {
            while (true) {
                int n = r.read(buf, 0, buf.length);
                if (n <= 0) break;
                double sum = 0;
                for (int i = 0; i < n; i++) {
                    float x = buf[i] / 32768f;
                    sum += x * x;
                    pcm.write(buf[i] & 0xff);
                    pcm.write((buf[i] >> 8) & 0xff);
                }
                float rms = (float) Math.sqrt(sum / n);
                int ms = n / 16;
                total += ms;
                if (rms > floor * 3) {
                    spoke = true;
                    quiet = 0;
                } else {
                    floor = floor * 0.98f + rms * 0.02f;
                    if (spoke) quiet += ms;
                }
                if ((spoke && quiet > 800) || total > 15000 || (!spoke && total > 5000)) break;
            }
        } finally {
            r.stop();
            r.release();
        }
        return spoke ? wav(pcm.toByteArray()) : new byte[0];
    }

    static byte[] wav(byte[] pcm) {
        ByteBuffer b = ByteBuffer.allocate(44 + pcm.length).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + pcm.length).put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII));
        b.putInt(16).putShort((short) 1).putShort((short) 1).putInt(16000).putInt(32000).putShort((short) 2).putShort((short) 16);
        b.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length).put(pcm);
        return b.array();
    }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (in == null) return new byte[0];
        byte[] b = new byte[8192];
        for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
        in.close();
        return out.toByteArray();
    }

    private Net.Response post(String path, String type, byte[] body, String claim, String label) throws java.io.IOException {
        String url = Net.server(this) + path;
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setConnectTimeout(15000);
        con.setReadTimeout(90000);
        con.setRequestMethod("POST");
        con.setDoOutput(true);
        con.setInstanceFollowRedirects(false);
        String cookie = Servers.cookieFor(this, url);
        if (cookie != null) con.setRequestProperty("Cookie", cookie);
        con.setRequestProperty("User-Agent", "SaraPhone/1");
        con.setRequestProperty("Content-Type", type);
        if (claim != null) {
            con.setRequestProperty("X-Sara-Wake-Claim", claim);
            con.setRequestProperty("X-Sara-Wake-Label", label);
            String companion = companions.optString(label, "");
            if (!companion.isEmpty()) con.setRequestProperty("X-Sara-Companion", companion);
        }
        con.setFixedLengthStreamingMode(body.length);
        OutputStream o = con.getOutputStream();
        o.write(body);
        o.close();
        int status = con.getResponseCode();
        byte[] data = readAll(status >= 400 ? con.getErrorStream() : con.getInputStream());
        con.disconnect();
        return new Net.Response(status, data);
    }

    private void play(byte[] audio) {
        try {
            File f = File.createTempFile("say", ".audio", getCacheDir());
            try (FileOutputStream o = new FileOutputStream(f)) {
                o.write(audio);
            }
            MediaPlayer mp = new MediaPlayer();
            mp.setDataSource(f.getAbsolutePath());
            mp.prepare();
            final Object done = new Object();
            mp.setOnCompletionListener(p -> {
                synchronized (done) {
                    done.notifyAll();
                }
            });
            mp.start();
            synchronized (done) {
                done.wait(Math.max(1000, mp.getDuration() + 1500));
            }
            mp.release();
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        } catch (Exception e) {
            // her words stay in the notification
        }
    }

    private void talk(String label) {
        try {
            String srv = Net.server(this);
            if (srv == null || srv.isEmpty()) {
                heard(getString(R.string.app_name), getString(R.string.hey_no_server));
                return;
            }
            state = "hearing";
            heard("TALK".equals(label) ? getString(R.string.hey_listening_now) : getString(R.string.hey_heard_you), getString(R.string.hey_say));
            if (!"TALK".equals(label)) chime();
            Net.Response c = Net.postJson(this, Net.server(this) + "/api/wake/claim", new JSONObject().put("label", label).toString());
            JSONObject cj = new JSONObject(c.text());
            if (c.status != 200 || !cj.optBoolean("ok")) {
                heard(getString(R.string.app_name), cj.optString("error", cj.optString("by", "")));
                return;
            }
            byte[] w = record();
            if (w == null) {
                heard(getString(R.string.app_name), getString(R.string.hey_no_mic));
                return;
            }
            if (w.length == 0) {
                heard(getString(R.string.app_name), getString(R.string.hey_nothing));
                return;
            }
            state = "thinking";
            Net.Response r = post("/api/wake/turn", "audio/wav", w, cj.getString("claim"), label);
            JSONObject j = new JSONObject(r.text());
            if (r.status != 200) {
                heard(getString(R.string.app_name), j.optString("error", "HTTP " + r.status));
                return;
            }
            String said = j.optString("heard", "");
            JSONArray pieces = j.optJSONArray("spoken");
            StringBuilder shown = new StringBuilder();
            if (!said.isEmpty()) shown.append("“").append(said).append("”");
            state = "speaking";
            for (int i = 0; pieces != null && i < pieces.length() && "speaking".equals(state); i++) {
                String text = pieces.getJSONObject(i).optString("text");
                shown.append(shown.length() > 0 ? "\n\n" : "").append(text);
                heard(getString(R.string.app_name), shown.toString());
                Net.Response a = post("/api/voice/speak", "application/json", new JSONObject().put("text", text).toString().getBytes(StandardCharsets.UTF_8), null, null);
                if (a.status == 200) play(a.body);
            }
        } catch (Exception e) {
            heard(getString(R.string.app_name), String.valueOf(e.getMessage()));
        } finally {
            talking = false;
            if (!"paused".equals(state) && !"off".equals(state)) state = "asleep";
        }
    }

    /** After a restart or an update: never started by itself; a notification asks (§6.4). */
    static void afterBoot(Context c) {
        if (!on(c)) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, c.getString(R.string.channel_hey), NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(c, MainActivity.class).setAction(ACTION_RESUME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Notification n = new Notification.Builder(c, CHANNEL).setSmallIcon(R.drawable.ic_notify).setColor(Notify.COLOR).setContentTitle(c.getString(R.string.app_name))
                .setContentText(c.getString(R.string.hey_after_boot)).setStyle(new Notification.BigTextStyle().bigText(c.getString(R.string.hey_after_boot)))
                .setAutoCancel(true).setContentIntent(PendingIntent.getActivity(c, 1264, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build();
        nm.notify(BOOT_ID, n);
    }
}
