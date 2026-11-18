package com.backstagecoding.sara;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.media.AudioAttributes;
import android.media.RingtoneManager;

/** Her messages as notifications: Reply right from the notification, optional lock-screen privacy. */
final class Notify {
    private Notify() {}

    static final String CHANNEL = "messages";
    static final String KEY_REPLY = "reply";
    static final int COLOR = 0xFFE0607E;

    static NotificationManager manager(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, c.getString(R.string.channel_name), NotificationManager.IMPORTANCE_HIGH));
        return nm;
    }

    static void message(Context c, String name, String conversationId, long id, String text, String kind) {
        Servers.Profile p = Servers.active(c);
        message(c, name, conversationId, id, text, kind, p == null ? null : p.id, null);
    }

    /**
     * Phase 68: `server` is the saved server it came from (tapping it opens that one); `from` is
     * shown under the name when the app has more than one.
     */
    static void message(Context c, String name, String conversationId, long msgId, String text, String kind, String server, String from) {
        NotificationManager nm = manager(c);
        if (nm == null) return;
        // Message ids are per server: keep two servers' notifications apart.
        long id = server == null || "s1".equals(server) ? msgId : msgId * 31 + server.hashCode();
        Intent open = new Intent(c, MainActivity.class).putExtra("conv", conversationId).putExtra("server", server).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        Notification.Builder b = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(COLOR)
                .setContentTitle("reminder".equals(kind) ? "⏰ " + name : name)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setGroup("messages")
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(c, (int) id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        if (from != null) b.setSubText(from);
        if (conversationId != null && !conversationId.isEmpty()) {
            RemoteInput input = new RemoteInput.Builder(KEY_REPLY).setLabel(c.getString(R.string.notify_reply_to, name)).build();
            Intent reply = new Intent(c, ReplyReceiver.class).putExtra("conv", conversationId).putExtra("id", (int) id).putExtra("name", name).putExtra("server", server);
            // Mutable: Android fills in the typed reply.
            PendingIntent pi = PendingIntent.getBroadcast(c, (int) id, reply, PendingIntent.FLAG_MUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.addAction(new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_notify), c.getString(R.string.notify_reply), pi).addRemoteInput(input).setAllowGeneratedReplies(true).build());
        }
        privacy(c, b, name);
        nm.notify((int) id, b.build());
    }

    // ---------- U2.9: Messages from people (the Messages page), not from her ----------
    static final String PEOPLE_CHANNEL = "people";
    static final String COMMUNITY_CHANNEL = "community";

    /**
     * A message from a person: one-to-one on "Messages from people" (heads-up), community mentions and
     * communities set to Everything on "Community messages" (no heads-up; each can be silenced in the
     * phone's settings). Tapping opens Messages. `badge` is the app's number (one-to-one + mentions +
     * approvals waiting) for launchers that show one.
     */
    static void person(Context c, String server, String chat, String msgId, String kind, String title, String from, boolean mention, String text, int badge, String host) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        boolean direct = "direct".equals(kind);
        nm.createNotificationChannel(new NotificationChannel(PEOPLE_CHANNEL, c.getString(R.string.channel_people), NotificationManager.IMPORTANCE_HIGH));
        nm.createNotificationChannel(new NotificationChannel(COMMUNITY_CHANNEL, c.getString(R.string.channel_community), NotificationManager.IMPORTANCE_DEFAULT));
        int id = ("pm:" + server + ":" + chat + ":" + msgId).hashCode();
        Intent open = new Intent(c, MainActivity.class).putExtra("path", "/#view=messages").putExtra("server", server).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        String head = direct ? from : mention ? c.getString(R.string.notify_mentioned, title) : title;
        String body = direct ? text : from + ": " + text;
        Notification.Builder b = new Notification.Builder(c, direct ? PEOPLE_CHANNEL : COMMUNITY_CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(COLOR)
                .setContentTitle(head)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setGroup("pm-" + chat)
                .setAutoCancel(true)
                .setContentIntent(PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        if (badge > 0) b.setNumber(badge);
        if (host != null) b.setSubText(host);
        privacy(c, b, head);
        nm.notify(id, b.build());
    }

    /** After a reply from the notification: show what was sent (Android expects the update). */
    static void replied(Context c, int id, String name, CharSequence reply, String problem) {
        NotificationManager nm = manager(c);
        if (nm == null) return;
        Notification.Builder b = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(COLOR)
                .setContentTitle(name)
                .setContentText(problem != null ? problem : c.getString(R.string.notify_you, reply))
                .setSubText(problem != null ? null : c.getString(R.string.notify_sent))
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
                .setTimeoutAfter(problem != null ? 0 : 8000)
                .setContentIntent(PendingIntent.getActivity(c, id, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        privacy(c, b, name);
        nm.notify(id, b.build());
    }

    // ---------- Phase 26: she is calling ----------
    static final String RING_CHANNEL = "ringing";
    static final int RING_ID = 7862;

    /**
     * Her incoming call: rings (the phone's ringtone, repeating), shows full screen when the phone
     * is locked or idle, with Answer and Decline. Answer opens the app, which starts the call.
     */
    static void incoming(Context c, String name, String ringId, String conversationId, String reason, long expiresAtMs) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(RING_CHANNEL, c.getString(R.string.channel_ringing, name), NotificationManager.IMPORTANCE_HIGH);
        ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[] {0, 800, 600, 800, 600});
        nm.createNotificationChannel(ch);
        Intent show = new Intent(c, MainActivity.class).putExtra("ringAction", "show").putExtra("ring", ringId).putExtra("ringConv", conversationId).putExtra("ringReason", reason).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        Intent answer = new Intent(show).putExtra("ringAction", "answer");
        PendingIntent showPi = PendingIntent.getActivity(c, 71, show, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent answerPi = PendingIntent.getActivity(c, 72, answer, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent declinePi = PendingIntent.getBroadcast(c, 73, new Intent(c, CallActionReceiver.class).putExtra("ring", ringId), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        long left = Math.max(5000, expiresAtMs - System.currentTimeMillis());
        Notification.Builder b = new Notification.Builder(c, RING_CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(COLOR)
                .setContentTitle(c.getString(R.string.notify_calling, name))
                .setContentText(reason)
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(false)
                .setTimeoutAfter(left)
                .setContentIntent(showPi)
                .setFullScreenIntent(showPi, true);
        if (Build.VERSION.SDK_INT >= 31) {
            b.setStyle(Notification.CallStyle.forIncomingCall(new android.app.Person.Builder().setName(name).setImportant(true).build(), declinePi, answerPi));
        } else {
            b.addAction(new Notification.Action.Builder(null, c.getString(R.string.notify_decline), declinePi).build());
            b.addAction(new Notification.Action.Builder(null, c.getString(R.string.notify_answer), answerPi).build());
        }
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT;
        nm.notify(RING_ID, n);
    }

    /** The ring ended (answered here or elsewhere, missed, declined). */
    static void endRing(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(RING_ID);
    }

    private static void privacy(Context c, Notification.Builder b, String name) {
        if (!Net.prefs(c).getBoolean("lockPrivate", false)) return;
        b.setVisibility(Notification.VISIBILITY_PRIVATE);
        b.setPublicVersion(new Notification.Builder(c, CHANNEL).setSmallIcon(R.drawable.ic_notify).setColor(COLOR).setContentTitle(name).setContentText(c.getString(R.string.notify_new_message)).build());
    }
}
