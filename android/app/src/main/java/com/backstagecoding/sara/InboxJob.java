package com.backstagecoding.sara;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * About every 15 minutes (Android decides the exact time): checks for messages she sent on her
 * own (texting first, reminders, finished jobs, the morning briefing), shows them as
 * notifications, and refreshes the widget. While the app is open the chat shows them instead.
 */
public class InboxJob extends JobService {
    private static final int JOB_ID = 7860;

    static void schedule(Context c) {
        JobScheduler js = c.getSystemService(JobScheduler.class);
        if (js == null || js.getPendingJob(JOB_ID) != null) return;
        js.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(c, InboxJob.class))
                .setPeriodic(15 * 60 * 1000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try {
                check(getApplicationContext());
                if (Places.on(getApplicationContext())) Places.sync(getApplicationContext());
                WidgetProvider.refresh(getApplicationContext());
            } finally {
                jobFinished(params, false);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    /** Phase 68: every saved server, each with its own sign-in. */
    static void check(Context c) {
        Servers.Profile act = Servers.active(c);
        java.util.List<Servers.Profile> all = Servers.list(c);
        for (Servers.Profile p : all) check(c, p, act != null && act.id.equals(p.id), all.size() > 1);
    }

    private static void check(Context c, Servers.Profile p, boolean inUse, boolean several) {
        if (MainActivity.DEMO_SERVER.equals(p.url)) return;
        long after = inUse ? Net.prefs(c).getLong("lastId", p.lastId) : p.lastId;
        try {
            // U2.9: Messages from people too (cursor per saved server; -1 = first check, start from now).
            android.content.SharedPreferences pm = c.getSharedPreferences("sara-pm", Context.MODE_PRIVATE);
            long pmAfter = pm.getLong(p.id, -1);
            Net.Response r = Net.get(c, p.url + "/api/phone/inbox?after=" + after + "&pmAfter=" + Math.max(0, pmAfter));
            if (r.status != 200) return;
            JSONObject j = new JSONObject(r.text());
            long latest = j.optLong("latest", after);
            String name = j.optString("name", "Sara");
            if (inUse) Net.prefs(c).edit().putString("name", name).apply();
            Servers.rename(c, p.id, name, false);
            // First check after connecting: start from now, don't replay old messages. While the
            // app is open the chat shows the server in use; the others still notify.
            if (after > 0 && !(inUse && MainActivity.visible)) {
                JSONArray list = j.optJSONArray("messages");
                for (int i = 0; list != null && i < list.length(); i++) {
                    JSONObject m = list.getJSONObject(i);
                    Notify.message(c, name, m.optString("conversationId"), m.optLong("id"), m.optString("text"), m.optString("kind"), p.id, several ? Servers.host(p.url) : null);
                }
            }
            Servers.setLastId(c, p.id, Math.max(after, latest));
            JSONArray people = j.optJSONArray("people");
            if (pmAfter >= 0 && people != null && !(inUse && MainActivity.visible)) {
                int badge = j.optInt("badge", 0);
                for (int i = 0; i < people.length(); i++) {
                    JSONObject m = people.getJSONObject(i);
                    Notify.person(c, p.id, m.optString("chat"), m.optString("id"), m.optString("kind"), m.optString("title"), m.optString("from"), m.optBoolean("mention"), m.optString("text"), badge, several ? Servers.host(p.url) : null);
                }
            }
            if (j.has("pmLatest")) pm.edit().putLong(p.id, Math.max(pmAfter, j.optLong("pmLatest", 0))).apply();
        } catch (Exception ignored) {
            // offline: try next time
        }
    }
}
