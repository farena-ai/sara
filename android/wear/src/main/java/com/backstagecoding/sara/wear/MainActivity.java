package com.backstagecoding.sara.wear;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * D2: setup on the watch. Type the server's address, get a short code, type that code in Sara
 * (Settings → Connections → Phone and notifications → Wear OS watch). The watch picks up its own
 * token; no token is ever typed on the watch. Once paired: what the tile shows, Talk, and Remove.
 */
public class MainActivity extends Activity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ScrollView scroll;
    private TextView body;
    private TextView code;
    private EditText server;
    private Button go;
    private Button talk;
    private Button forget;
    private String poll;
    private long pollUntil;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.main);
        scroll = findViewById(R.id.scroll);
        body = findViewById(R.id.body);
        code = findViewById(R.id.code);
        server = findViewById(R.id.server);
        go = findViewById(R.id.go);
        talk = findViewById(R.id.talk);
        forget = findViewById(R.id.forget);
        if (Store.server(this) != null) server.setText(Store.server(this));
        go.setOnClickListener(v -> start());
        server.setOnEditorActionListener((v, action, e) -> {
            if (action == EditorInfo.IME_ACTION_GO) start();
            return false;
        });
        talk.setOnClickListener(v -> startActivity(new Intent(this, TalkActivity.class)));
        forget.setOnClickListener(v -> {
            Store.forget(this);
            GlanceTile.refresh(this);
            show();
        });
        show();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        poll = null;
        ui.removeCallbacksAndMessages(null);
    }

    private void show() {
        boolean paired = Store.token(this) != null;
        code.setVisibility(View.GONE);
        server.setVisibility(paired ? View.GONE : View.VISIBLE);
        go.setVisibility(paired ? View.GONE : View.VISIBLE);
        talk.setVisibility(paired ? View.VISIBLE : View.GONE);
        forget.setVisibility(paired ? View.VISIBLE : View.GONE);
        if (!paired) {
            body.setText(R.string.setup_intro);
            return;
        }
        body.setText(getString(R.string.paired, Store.name(this)));
        new Thread(() -> {
            GlanceTile.Glance g = GlanceTile.fetch(this);
            ui.post(() -> {
                if (g == null) {
                    body.setText(R.string.signed_out);
                    show();
                    return;
                }
                StringBuilder s = new StringBuilder(getString(R.string.paired, g.name));
                for (String line : g.today) s.append("\n").append(line);
                if (g.today.length == 0 && !g.nothing.isEmpty()) s.append("\n").append(g.nothing);
                if (g.waiting > 0) s.append("\n").append(g.waitingLine);
                body.setText(s.toString());
                top();
                GlanceTile.refresh(this);
            });
        }).start();
    }

    private void start() {
        String s = Store.normalize(server.getText().toString());
        if (s == null) {
            body.setText(R.string.setup_intro);
            return;
        }
        Store.setServer(this, s);
        go.setEnabled(false);
        new Thread(() -> {
            try {
                Net.Response r = Net.request("POST", s + "/api/shortcuts/wear/pair", null, "{}");
                if (r.status != 201) throw new IllegalStateException(errorOf(r));
                JSONObject j = new JSONObject(r.body);
                poll = j.getString("poll");
                pollUntil = System.currentTimeMillis() + j.optLong("expiresIn", 600) * 1000L;
                String shown = j.getString("code");
                ui.post(() -> {
                    go.setEnabled(true);
                    code.setText(shown);
                    code.setVisibility(View.VISIBLE);
                    server.setVisibility(View.GONE);
                    body.setText(R.string.code_intro);
                    top();
                    ui.postDelayed(this::check, 3000);
                });
            } catch (Exception e) {
                String why = e instanceof IllegalStateException && e.getMessage() != null && !e.getMessage().isEmpty() ? e.getMessage() : getString(R.string.cant_reach);
                ui.post(() -> {
                    go.setEnabled(true);
                    body.setText(why);
                });
            }
        }).start();
    }

    /** Every 3 seconds while the code is shown: has it been typed in Sara yet? */
    private void check() {
        final String p = poll;
        final String s = Store.server(this);
        if (p == null || s == null) return;
        if (System.currentTimeMillis() > pollUntil) {
            gone();
            return;
        }
        new Thread(() -> {
            try {
                Net.Response r = Net.request("GET", s + "/api/shortcuts/wear/pair/" + p, null, null);
                if (r.status == 200) {
                    JSONObject j = new JSONObject(r.body);
                    Store.paired(this, j.getString("token"), j.optString("name", "Sara"));
                    poll = null;
                    ui.post(() -> {
                        GlanceTile.refresh(this);
                        show();
                    });
                    return;
                }
                if (r.status == 404) {
                    ui.post(this::gone);
                    return;
                }
            } catch (Exception e) {
                // Try again in a moment.
            }
            ui.postDelayed(this::check, 3000);
        }).start();
    }

    /** Long words on a round screen: always start at the top. */
    private void top() {
        scroll.post(() -> scroll.scrollTo(0, 0));
    }

    private void gone() {
        poll = null;
        code.setVisibility(View.GONE);
        server.setVisibility(View.VISIBLE);
        body.setText(R.string.code_gone);
    }

    private static String errorOf(Net.Response r) {
        try {
            return new JSONObject(r.body).optString("error", "");
        } catch (Exception e) {
            return "";
        }
    }
}
