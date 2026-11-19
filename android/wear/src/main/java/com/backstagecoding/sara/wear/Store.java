package com.backstagecoding.sara.wear;

import android.content.Context;
import android.content.SharedPreferences;

/** The watch's own settings: the server, its watch token (from pairing) and the last glance. */
final class Store {
    private Store() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("sara-wear", Context.MODE_PRIVATE);
    }

    static String server(Context c) { return prefs(c).getString("server", null); }
    static String token(Context c) { return prefs(c).getString("token", null); }
    static String name(Context c) { return prefs(c).getString("name", "Sara"); }
    static String glance(Context c) { return prefs(c).getString("glance", null); }

    static void setServer(Context c, String server) { prefs(c).edit().putString("server", server).apply(); }

    static void paired(Context c, String token, String name) {
        prefs(c).edit().putString("token", token).putString("name", name == null || name.isEmpty() ? "Sara" : name).remove("glance").apply();
    }

    static void setGlance(Context c, String json) { prefs(c).edit().putString("glance", json).apply(); }

    /** Removed in Sara, or "Remove from this watch": back to setup. */
    static void forget(Context c) { prefs(c).edit().remove("token").remove("glance").apply(); }

    /** "sara.example.com" -> https://sara.example.com; an address with a port or a bare IP -> http (home servers). */
    static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (s.isEmpty()) return null;
        if (s.startsWith("http://") || s.startsWith("https://")) return s;
        boolean local = s.matches("^[0-9.]+(:\\d+)?$") || s.matches("^[^/]+:\\d+$") || s.startsWith("localhost");
        return (local ? "http://" : "https://") + s;
    }
}
