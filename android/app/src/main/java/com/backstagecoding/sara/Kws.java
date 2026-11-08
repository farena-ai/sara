package com.backstagecoding.sara;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * C17 (docs/ops/C17_DESIGN.md): the on-device keyword spotter for Hey Sara. The engine (sherpa-onnx,
 * Apache-2.0) is inside the signed app; the 5.4 MB model comes from the person's own Sara server
 * (GET /api/wake/model/<file>) and every file is checked against these pins (the same as
 * src/wake-pack.ts MODEL_FILES and the Windows app) before each load. No audio leaves the phone
 * until the phrase is heard: the detector only hands back a label.
 */
final class Kws {
    /** name, size, SHA-256 (sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20, int8, chunk 16). */
    static final String[][] FILES = {
            {"encoder.int8.onnx", "4599656", "408bbd740838c42d5bf6d1c5b80b3c88b616c7860b92d980328b5b068c76ae48"},
            {"decoder.onnx", "759829", "63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21"},
            {"joiner.int8.onnx", "86629", "190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1"},
            {"tokens.txt", "1928", "2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0"},
    };
    private static boolean loaded;

    static {
        try {
            System.loadLibrary("sarakws");
            loaded = true;
        } catch (Throwable t) {
            loaded = false;
        }
    }

    private static native boolean nativeAvailable();
    private static native long nativeOpen(String dir, String keywords);
    private static native String nativeFeed(long handle, float[] samples, int n);
    private static native void nativeClose(long handle);

    /** The engine is in this build (the fetch script ran before it was built). */
    static boolean available() {
        try {
            return loaded && nativeAvailable();
        } catch (Throwable t) {
            return false;
        }
    }

    static File dir(Context c) {
        return new File(c.getFilesDir(), "wake/1");
    }

    /** Every model file is there and matches its pin (checked each time, as on Windows). */
    static boolean ready(Context c) {
        File d = dir(c);
        for (String[] f : FILES) {
            File x = new File(d, f[0]);
            if (!x.isFile() || x.length() != Long.parseLong(f[1]) || !f[2].equals(sha256(x))) return false;
        }
        return true;
    }

    static int megabytes() {
        long n = 0;
        for (String[] f : FILES) n += Long.parseLong(f[1]);
        return (int) Math.round(n / 1e6);
    }

    /** Downloads the model from her server (signed in with the app's cookie); a file that doesn't match is thrown away. */
    static String install(Context c) {
        String srv = Net.server(c);
        if (srv == null || srv.isEmpty()) return "no-server";
        File d = dir(c);
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        try {
            Net.postJson(c, srv + "/api/wake/model", "{}");
        } catch (Exception ignored) {
            // the GETs below say what's missing
        }
        for (String[] f : FILES) {
            File out = new File(d, f[0]);
            if (out.isFile() && out.length() == Long.parseLong(f[1]) && f[2].equals(sha256(out))) continue;
            File part = new File(d, f[0] + ".part");
            try {
                String url = srv + "/api/wake/model/" + f[0];
                HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
                con.setConnectTimeout(15000);
                con.setReadTimeout(60000);
                con.setInstanceFollowRedirects(false);
                String cookie = Servers.cookieFor(c, url);
                if (cookie != null) con.setRequestProperty("Cookie", cookie);
                con.setRequestProperty("User-Agent", "SaraPhone/1");
                if (con.getResponseCode() != 200) {
                    con.disconnect();
                    return "pack";
                }
                try (InputStream in = con.getInputStream(); FileOutputStream o = new FileOutputStream(part)) {
                    byte[] b = new byte[65536];
                    long total = 0, max = Long.parseLong(f[1]);
                    for (int n; (n = in.read(b)) > 0; ) {
                        total += n;
                        if (total > max) throw new java.io.IOException("too big");
                        o.write(b, 0, n);
                    }
                }
                con.disconnect();
                if (part.length() != Long.parseLong(f[1]) || !f[2].equals(sha256(part)) || !part.renameTo(out)) {
                    //noinspection ResultOfMethodCallIgnored
                    part.delete();
                    return "pack";
                }
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                return "pack";
            }
        }
        return ready(c) ? null : "pack";
    }

    static void remove(Context c) {
        File[] fs = dir(c).listFiles();
        if (fs != null) for (File f : fs) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }

    static String sha256(File f) {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] b = new byte[65536];
            for (int n; (n = in.read(b)) > 0; ) md.update(b, 0, n);
            StringBuilder s = new StringBuilder();
            for (byte x : md.digest()) s.append(String.format("%02x", x));
            return s.toString();
        } catch (Exception e) {
            return "";
        }
    }

    // ---------------- one spotter ----------------

    private long handle;

    private Kws(long h) {
        handle = h;
    }

    /** A spotter with these keyword lines, or null (no engine, no model, a bad line). */
    static Kws open(Context c, String keywords) {
        if (!available() || !ready(c) || keywords == null || keywords.trim().isEmpty()) return null;
        long h = nativeOpen(dir(c).getAbsolutePath(), keywords);
        return h == 0 ? null : new Kws(h);
    }

    /** 16 kHz mono 16-bit samples; returns the label heard, or null. */
    synchronized String feed(short[] pcm, int n) {
        if (handle == 0 || n <= 0) return null;
        float[] f = new float[n];
        for (int i = 0; i < n; i++) f[i] = pcm[i] / 32768f;
        return nativeFeed(handle, f, n);
    }

    synchronized void close() {
        if (handle != 0) nativeClose(handle);
        handle = 0;
    }
}
