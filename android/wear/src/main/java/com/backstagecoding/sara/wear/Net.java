package com.backstagecoding.sara.wear;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Plain HTTP to the Sara server (no libraries). The watch token goes in the Authorization header only. */
final class Net {
    private Net() {}

    static final class Response {
        final int status;
        final String body;
        Response(int status, String body) { this.status = status; this.body = body; }
    }

    static Response request(String method, String url, String token, String json) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(url).openConnection();
        try {
            h.setRequestMethod(method);
            h.setConnectTimeout(8000);
            h.setReadTimeout(json != null && url.endsWith("/ask") ? 30000 : 10000);
            h.setRequestProperty("Accept", "application/json");
            if (token != null) h.setRequestProperty("Authorization", "Bearer " + token);
            if (json != null) {
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = h.getOutputStream()) { out.write(json.getBytes(StandardCharsets.UTF_8)); }
            }
            int status = h.getResponseCode();
            InputStream in = status >= 400 ? h.getErrorStream() : h.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            if (in != null) {
                try (InputStream i = in) {
                    byte[] b = new byte[8192];
                    for (int n; (n = i.read(b)) > 0; ) {
                        buf.write(b, 0, n);
                        if (buf.size() > 256_000) break;
                    }
                }
            }
            return new Response(status, buf.toString("UTF-8"));
        } finally {
            h.disconnect();
        }
    }
}
