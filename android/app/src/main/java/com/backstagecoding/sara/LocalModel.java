package com.backstagecoding.sara;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * V5.6 (docs/design/V5_PHONE_MODEL.md): the phone fallback model. While the server is away the page
 * (web/offline-answer.js) asks this small model for a short answer, marked "Offline answer" and
 * synced into the chat later. The engine (llama.cpp, MIT) is inside the signed app (cpp/llm.c,
 * android/fetch-llm-libs.sh); the model file is data, downloaded only when the person taps Download
 * in Settings, straight from Hugging Face (a public file, no account), resumed when cut, and checked
 * against its SHA-256 before it is ever used. Remove deletes it.
 */
final class LocalModel {
    static final String NAME = "Qwen2.5 0.5B";
    static final String FILE = "qwen2.5-0.5b-instruct-q4_k_m.gguf";
    static final String URL_ = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf";
    static final long SIZE = 491400032L;
    static final String SHA = "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db";
    /** Room for the brief, six kept messages, the question and the answer (web/offline-answer.js). */
    static final int N_CTX = 2048;
    static final int MAX_TOKENS = 400;

    interface Reply {
        void answer(String id, String json);
    }

    private static boolean loaded;
    private static Boolean available;
    private static long handle;
    private static volatile Thread download;
    private static volatile long got;
    private static volatile String error;
    private static volatile boolean busy;
    private static final ExecutorService WORK = Executors.newSingleThreadExecutor();

    static {
        try {
            System.loadLibrary("saralm");
            loaded = true;
        } catch (Throwable t) {
            loaded = false;
        }
    }

    private static native boolean nativeAvailable(String libDir);
    private static native long nativeOpen(String path, int nCtx, int threads);
    private static native byte[] nativeAsk(long handle, String[] roles, String[] texts, int maxTokens);
    private static native void nativeCancel(long handle);
    private static native void nativeClose(long handle);

    /** The engine is in this build for this phone's processor. */
    static synchronized boolean engine(Context c) {
        if (available == null) {
            try {
                available = loaded && nativeAvailable(c.getApplicationInfo().nativeLibraryDir);
            } catch (Throwable t) {
                available = false;
            }
        }
        return available;
    }

    private static File dir(Context c) {
        return new File(c.getFilesDir(), "models");
    }

    static File file(Context c) {
        return new File(dir(c), FILE);
    }

    private static File part(Context c) {
        return new File(dir(c), FILE + ".part");
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("sara-local-model", Context.MODE_PRIVATE);
    }

    /** On unless the person switched it off (the download itself is the opt-in). */
    static boolean on(Context c) {
        return prefs(c).getBoolean("on", true);
    }

    /** The file is there and was checked against its pin when it arrived (size and time unchanged since). */
    static boolean ready(Context c) {
        File f = file(c);
        return f.isFile() && f.length() == SIZE && (f.length() + ":" + f.lastModified()).equals(prefs(c).getString("checked", ""));
    }

    static String status(Context c) {
        try {
            JSONObject o = new JSONObject();
            o.put("engine", engine(c));
            o.put("on", on(c));
            o.put("name", NAME);
            o.put("size", SIZE);
            boolean dl = download != null;
            o.put("state", dl ? "downloading" : ready(c) ? "ready" : error != null ? "error" : "none");
            o.put("got", dl ? got : part(c).length());
            if (error != null) o.put("error", error);
            o.put("busy", busy);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /** The page's calls (MainActivity.Bridge.localModel): status, on, download, remove, ask, cancel. */
    static String op(Context c, String op, String json, Reply reply) {
        try {
            JSONObject a = json == null || json.isEmpty() ? new JSONObject() : new JSONObject(json);
            switch (op) {
                case "status":
                    return status(c);
                case "on":
                    prefs(c).edit().putBoolean("on", a.optBoolean("on", true)).apply();
                    if (!a.optBoolean("on", true)) closeModel();
                    return status(c);
                case "download":
                    startDownload(c);
                    return status(c);
                case "remove":
                    remove(c);
                    return status(c);
                case "cancel":
                    synchronized (LocalModel.class) {
                        if (handle != 0) nativeCancel(handle);
                    }
                    return "ok";
                case "ask":
                    return ask(c, a, reply);
                default:
                    return "{}";
            }
        } catch (Exception e) {
            return "{}";
        }
    }

    private static String ask(Context c, JSONObject a, Reply reply) throws Exception {
        if (busy || !on(c) || !ready(c) || !engine(c)) return "busy";
        final String id = a.getString("id");
        JSONArray m = a.getJSONArray("messages");
        final String[] roles = new String[m.length()];
        final String[] texts = new String[m.length()];
        for (int i = 0; i < m.length(); i++) {
            JSONObject x = m.getJSONObject(i);
            String r = x.optString("role", "user");
            roles[i] = r.equals("system") || r.equals("assistant") ? r : "user";
            texts[i] = x.optString("content", "");
        }
        final int max = Math.max(16, Math.min(MAX_TOKENS, a.optInt("maxTokens", 220)));
        final Context app = c.getApplicationContext();
        busy = true;
        WORK.execute(() -> {
            String out;
            try {
                long h = open(app);
                byte[] b = h == 0 ? null : nativeAsk(h, roles, texts, max);
                JSONObject r = new JSONObject();
                if (b == null) r.put("error", h == 0 ? "the model didn't load" : "no answer");
                else r.put("text", new String(b, StandardCharsets.UTF_8).trim());
                out = r.toString();
            } catch (Throwable t) {
                out = "{\"error\":\"the model stopped\"}";
            } finally {
                busy = false;
            }
            reply.answer(id, out);
        });
        return "ok";
    }

    private static synchronized long open(Context c) {
        if (handle != 0) return handle;
        int threads = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors() - 1));
        handle = nativeOpen(file(c).getAbsolutePath(), N_CTX, threads);
        return handle;
    }

    /** Frees the model's memory (switched off, removed, or the phone needs the memory back). */
    static synchronized void closeModel() {
        if (handle == 0 || busy) return;
        nativeClose(handle);
        handle = 0;
    }

    static synchronized void remove(Context c) {
        Thread d = download;
        if (d != null) d.interrupt();
        closeModel();
        //noinspection ResultOfMethodCallIgnored
        file(c).delete();
        //noinspection ResultOfMethodCallIgnored
        part(c).delete();
        prefs(c).edit().remove("checked").apply();
        error = null;
    }

    static synchronized void startDownload(Context c) {
        if (download != null || ready(c)) return;
        final Context app = c.getApplicationContext();
        error = null;
        Thread t = new Thread(() -> {
            try {
                fetch(app);
            } catch (Exception e) {
                error = e.getMessage() == null ? "no connection" : e.getMessage();
            } finally {
                download = null;
            }
        }, "sara-local-model");
        download = t;
        t.start();
    }

    /** Resumes a cut download (Range), then checks the whole file before it may be used. */
    private static void fetch(Context c) throws Exception {
        File d = dir(c);
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        File p = part(c);
        long have = p.isFile() ? p.length() : 0;
        if (have > SIZE) {
            //noinspection ResultOfMethodCallIgnored
            p.delete();
            have = 0;
        }
        got = have;
        if (have < SIZE) {
            HttpURLConnection h = (HttpURLConnection) new URL(URL_).openConnection();
            h.setConnectTimeout(20_000);
            h.setReadTimeout(60_000);
            h.setInstanceFollowRedirects(true);
            if (have > 0) h.setRequestProperty("Range", "bytes=" + have + "-");
            int code = h.getResponseCode();
            if (code == 200) have = 0;
            else if (code != 206) throw new Exception("HTTP " + code);
            try (InputStream in = h.getInputStream(); FileOutputStream out = new FileOutputStream(p, have > 0)) {
                byte[] buf = new byte[1 << 16];
                int n;
                got = have;
                while ((n = in.read(buf)) > 0) {
                    if (Thread.interrupted()) throw new Exception("stopped");
                    out.write(buf, 0, n);
                    got += n;
                    if (got > SIZE) throw new Exception("the file is larger than expected");
                }
            } finally {
                h.disconnect();
            }
        }
        if (p.length() != SIZE || !SHA.equals(sha256(p))) {
            //noinspection ResultOfMethodCallIgnored
            p.delete();
            throw new Exception("the file didn't match its checksum");
        }
        File f = file(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
        if (!p.renameTo(f)) throw new Exception("couldn't save the file");
        prefs(c).edit().putString("checked", f.length() + ":" + f.lastModified()).apply();
    }

    static String sha256(File f) {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
