package com.backstagecoding.sara;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

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
 * In this build the keyword engine isn't in the app yet (the sherpa-onnx JNI libraries are a
 * later 2.59.x step), so the service gives the hands-free exchange through Talk: it records here
 * after Talk (16 kHz, until 0.8 s of quiet), sends it to /api/wake/turn with the app's sign-in,
 * plays her pieces in order (the AI notice first, crisis resources in full, then her reply) and
 * shows what she heard and said. Nothing is recorded before Talk; the audio is never kept.
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
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean talking = false;
    private long pausedUntil = 0;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("hey-sara", MODE_PRIVATE);
    }
    static boolean on(Context c) {
        return prefs(c).getBoolean("on", false);
    }

    /** Only from a visible screen (Android 14+ won't start a microphone service from the background). */
    static void start(Context c, String action) {
        Intent i = new Intent(c, WakeService.class).setAction(action);
        c.startForegroundService(i);
    }

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
        boolean paused = "paused".equals(state);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(Notify.COLOR)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentTitle(paused ? getString(R.string.hey_paused) : getString(R.string.hey_listening))
                .setContentText(paused ? getString(R.string.hey_paused_text) : getString(R.string.hey_listening_text))
                .setContentIntent(PendingIntent.getActivity(this, 1260, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        if (!paused) b.addAction(new Notification.Action.Builder(null, getString(R.string.hey_talk), self(ACTION_TALK, 1261)).build());
        b.addAction(new Notification.Action.Builder(null, paused ? getString(R.string.hey_resume) : getString(R.string.hey_pause), self(paused ? ACTION_RESUME : ACTION_PAUSE, 1262)).build());
        b.addAction(new Notification.Action.Builder(null, getString(R.string.hey_stop), self(ACTION_STOP, 1263)).build());
        return b.build();
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
        String a = intent == null ? ACTION_START : String.valueOf(intent.getAction());
        if (ACTION_STOP.equals(a)) {
            prefs(this).edit().putBoolean("on", false).apply();
            state = "off";
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
                }
            }, 3600_000L);
        } else if (ACTION_RESUME.equals(a) || ACTION_START.equals(a)) {
            prefs(this).edit().putBoolean("on", true).apply();
            state = "asleep";
        }
        show();
        if (ACTION_TALK.equals(a) && !talking && !"paused".equals(state)) {
            talking = true;
            new Thread(this::talk, "sara-talk").start();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        state = "off";
        super.onDestroy();
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

    private Net.Response post(String path, String type, byte[] body, String claim) throws java.io.IOException {
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
            con.setRequestProperty("X-Sara-Wake-Label", "TALK");
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

    private void talk() {
        try {
            String srv = Net.server(this);
            if (srv == null || srv.isEmpty()) {
                heard(getString(R.string.app_name), getString(R.string.hey_no_server));
                return;
            }
            state = "hearing";
            heard(getString(R.string.hey_listening_now), getString(R.string.hey_say));
            Net.Response c = Net.postJson(this, Net.server(this) + "/api/wake/claim", "{\"label\":\"TALK\"}");
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
            Net.Response r = post("/api/wake/turn", "audio/wav", w, cj.getString("claim"));
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
                Net.Response a = post("/api/voice/speak", "application/json", new JSONObject().put("text", text).toString().getBytes(StandardCharsets.UTF_8), null);
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
