package com.backstagecoding.sara.wear;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.view.Gravity;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;

/**
 * D2 push-to-talk: the watch's own speech recognizer hears the question, POST /api/shortcuts/ask
 * (the watch's own chat in Sara) and her short answer shows here. Anything that needs an OK is
 * answered on the phone: her reply says so.
 */
public class TalkActivity extends Activity {
    private static final int HEAR = 1;
    private TextView out;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        out = new TextView(this);
        out.setGravity(Gravity.CENTER);
        out.setTextSize(15);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        out.setPadding(pad, pad, pad, pad);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(out);
        setContentView(scroll);
        out.setOnClickListener(v -> listen());
        if (Store.token(this) == null) {
            out.setText(R.string.not_set_up);
            out.setOnClickListener(v -> {
                startActivity(new Intent(this, MainActivity.class));
                finish();
            });
            return;
        }
        if (saved == null) listen();
    }

    private void listen() {
        Intent hear = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, getString(R.string.speak_prompt));
        try {
            startActivityForResult(hear, HEAR);
        } catch (ActivityNotFoundException e) {
            out.setText(R.string.no_speech);
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != HEAR) return;
        ArrayList<String> said = data == null ? null : data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (result != RESULT_OK || said == null || said.isEmpty() || said.get(0).trim().isEmpty()) {
            finish();
            return;
        }
        ask(said.get(0).trim());
    }

    private void ask(String text) {
        out.setText(getString(R.string.asking, text));
        String server = Store.server(this);
        String token = Store.token(this);
        new Thread(() -> {
            String say;
            try {
                Net.Response r = Net.request("POST", server + "/api/shortcuts/ask", token, new JSONObject().put("text", text).toString());
                JSONObject j = new JSONObject(r.body.isEmpty() ? "{}" : r.body);
                if (r.status == 401) {
                    Store.forget(this);
                    say = getString(R.string.signed_out);
                } else {
                    say = j.optString("say", j.optString("error", ""));
                    if (say.isEmpty()) say = getString(R.string.talk_failed);
                }
            } catch (Exception e) {
                say = getString(R.string.talk_failed);
            }
            final String shown = say;
            runOnUiThread(() -> {
                out.setText(shown);
                GlanceTile.refresh(this);
            });
        }).start();
    }
}
