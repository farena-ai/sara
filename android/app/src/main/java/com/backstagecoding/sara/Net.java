package com.backstagecoding.sara;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.webkit.CookieManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Small helpers: the saved server address, and requests signed in with the app's own sign-in. */
final class Net {
    private Net() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("sara", Context.MODE_PRIVATE);
    }

    /** The address of the server in use, e.g. https://sara.example.com (no trailing slash), or null. */
    static String server(Context c) {
        return prefs(c).getString("server", null);
    }

    /** "sara.example.com" becomes "https://sara.example.com"; trailing slashes go. */
    static String normalize(String input) {
        String s = input.trim();
        if (s.isEmpty()) return s;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    /**
     * The server address in a pairing link, cleaned to scheme://host[:port], or null when it
     * isn't a plain server address: anything with a user name or password before the host
     * (https://real.com@other.net), a path other than "/", a query or a fragment is refused, so a
     * link can't dress up another server as yours.
     */
    static String pairOrigin(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (!(s.startsWith("https://") || s.startsWith("http://"))) return null;
        try {
            java.net.URI u = new java.net.URI(s);
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(java.util.Locale.ROOT);
            if (!scheme.equals("https") && !scheme.equals("http")) return null;
            if (u.getRawUserInfo() != null || s.substring(scheme.length() + 3).contains("@")) return null;
            String host = u.getHost();
            if (host == null || host.isEmpty()) return null;
            String path = u.getRawPath();
            if (path != null && !path.isEmpty() && !path.equals("/")) return null;
            if (u.getRawQuery() != null || u.getRawFragment() != null || s.contains("#") || s.contains("?")) return null;
            int port = u.getPort();
            return scheme + "://" + host.toLowerCase(java.util.Locale.ROOT) + (port == -1 ? "" : ":" + port);
        } catch (Exception e) {
            return null;
        }
    }

    /** True for addresses that stay at home or on a private network (plain http is fine there). */
    static boolean isPrivateHost(String origin) {
        try {
            String h = new java.net.URI(origin).getHost().toLowerCase(java.util.Locale.ROOT);
            if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
            if (h.equals("localhost") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa") || h.endsWith(".ts.net")) return true;
            if (h.equals("::1") || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return h.contains(":") || h.equals("::1");
            String[] p = h.split("\\.");
            if (p.length != 4) return false;
            int a = Integer.parseInt(p[0]);
            int b = Integer.parseInt(p[1]);
            return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31) || (a == 169 && b == 254) || (a == 100 && b >= 64 && b <= 127);
        } catch (Exception e) {
            return false;
        }
    }

    static final class Response {
        final int status;
        final byte[] body;

        Response(int status, byte[] body) {
            this.status = status;
            this.body = body;
        }

        String text() {
            return new String(body, StandardCharsets.UTF_8);
        }
    }

    /**
     * Adds the sign-in cookie only when the request goes to the saved server itself (same scheme,
     * host and port). A newly typed address, or any other site, never gets it; redirects are not
     * followed, so the cookie can't be carried somewhere else either.
     */
    private static void signIn(Context c, HttpURLConnection con, String url) {
        con.setInstanceFollowRedirects(false);
        // Phase 68: the sign-in of the saved server at exactly this address (the one in use, or
        // another one's put-away sign-in); never one server's sign-in for another.
        String cookie = Servers.cookieFor(c, url);
        if (cookie != null) con.setRequestProperty("Cookie", cookie);
    }

    static boolean sameOrigin(String a, String b) {
        try {
            URL x = new URL(a);
            URL y = new URL(b);
            return x.getProtocol().equalsIgnoreCase(y.getProtocol()) && x.getHost().equalsIgnoreCase(y.getHost()) && (x.getPort() == -1 ? x.getDefaultPort() : x.getPort()) == (y.getPort() == -1 ? y.getDefaultPort() : y.getPort());
        } catch (Exception e) {
            return false;
        }
    }

    /** POST JSON with the app's sign-in (no Origin header: it's the app, not a web page). */
    static Response postJson(Context c, String url, String json) throws IOException {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setConnectTimeout(15000);
        con.setReadTimeout(20000);
        con.setRequestMethod("POST");
        con.setDoOutput(true);
        signIn(c, con, url);
        con.setRequestProperty("User-Agent", "SaraPhone/1");
        con.setRequestProperty("Content-Type", "application/json");
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        con.setFixedLengthStreamingMode(body.length);
        con.getOutputStream().write(body);
        int status = con.getResponseCode();
        InputStream in = status >= 400 ? con.getErrorStream() : con.getInputStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (in != null) {
            byte[] b = new byte[4096];
            for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
            in.close();
        }
        con.disconnect();
        return new Response(status, out.toByteArray());
    }

    /** N5b: one part of a form upload (a file, or a text field when filename is null). */
    static final class Part {
        final String name;
        final String filename;
        final String type;
        final byte[] data;

        Part(String name, String filename, String type, byte[] data) {
            this.name = name;
            this.filename = filename;
            this.type = type;
            this.data = data;
        }
    }

    /** N5b: POST multipart/form-data with the app's sign-in (Share to Sara: files into her Library). */
    static Response postMultipart(Context c, String url, java.util.List<Part> parts) throws IOException {
        String boundary = "----sara" + Long.toHexString(System.nanoTime());
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (Part p : parts) {
            String safe = p.filename == null ? null : p.filename.replace("\"", "_").replace("\r", "").replace("\n", "");
            String head = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + p.name + "\"" + (safe != null ? "; filename=\"" + safe + "\"" : "") + "\r\nContent-Type: " + p.type + "\r\n\r\n";
            body.write(head.getBytes(StandardCharsets.UTF_8));
            body.write(p.data);
            body.write("\r\n".getBytes(StandardCharsets.UTF_8));
        }
        body.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setConnectTimeout(15000);
        con.setReadTimeout(60000);
        con.setRequestMethod("POST");
        con.setDoOutput(true);
        signIn(c, con, url);
        con.setRequestProperty("User-Agent", "SaraPhone/1");
        con.setRequestProperty("Accept", "application/json");
        con.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        byte[] bytes = body.toByteArray();
        con.setFixedLengthStreamingMode(bytes.length);
        con.getOutputStream().write(bytes);
        int status = con.getResponseCode();
        InputStream in = status >= 400 ? con.getErrorStream() : con.getInputStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        if (in != null) {
            byte[] b = new byte[4096];
            for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
            in.close();
        }
        con.disconnect();
        return new Response(status, out.toByteArray());
    }

    /** GET with the sign-in cookie the app's web view holds for this server. */
    static Response get(Context c, String url) throws IOException {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setConnectTimeout(15000);
        con.setReadTimeout(20000);
        signIn(c, con, url);
        con.setRequestProperty("User-Agent", "SaraPhone/1");
        try {
            int status = con.getResponseCode();
            InputStream in = status >= 400 ? con.getErrorStream() : con.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (in != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0 && out.size() < 4_000_000) out.write(buf, 0, n);
                in.close();
            }
            return new Response(status, out.toByteArray());
        } finally {
            con.disconnect();
        }
    }

    static Bitmap image(Context c, String url, int size) throws IOException {
        Response r = get(c, url);
        if (r.status != 200) return null;
        Bitmap b = BitmapFactory.decodeByteArray(r.body, 0, r.body.length);
        return b == null ? null : Bitmap.createScaledBitmap(b, size, size, true);
    }
}
