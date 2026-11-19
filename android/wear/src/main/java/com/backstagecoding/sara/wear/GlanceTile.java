package com.backstagecoding.sara.wear;

import android.content.Context;

import androidx.concurrent.futures.CallbackToFutureAdapter;
import androidx.wear.protolayout.ActionBuilders;
import androidx.wear.protolayout.ColorBuilders;
import androidx.wear.protolayout.DimensionBuilders;
import androidx.wear.protolayout.LayoutElementBuilders;
import androidx.wear.protolayout.ModifiersBuilders;
import androidx.wear.protolayout.ResourceBuilders;
import androidx.wear.protolayout.TimelineBuilders;
import androidx.wear.tiles.RequestBuilders;
import androidx.wear.tiles.TileBuilders;
import androidx.wear.tiles.TileService;

import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.Date;

/**
 * D2: the Sara tile. Today (the rest of today's reminders), how many things wait on you (answered on
 * the phone, never here) and a Talk button. Data: GET /api/shortcuts/wear with the watch's token;
 * offline it shows the last glance with its time.
 */
public class GlanceTile extends TileService {
    private static final String RES = "1";
    private static final int ACCENT = 0xFF7C6CF2;
    private static final int SOFT = 0xFFB9B0FF;
    private static final int WHITE = 0xFFFFFFFF;
    private static final int MUTED = 0xFFBDBDC7;
    private static final int AMBER = 0xFFFFC46B;

    @Override
    protected ListenableFuture<TileBuilders.Tile> onTileRequest(RequestBuilders.TileRequest request) {
        return CallbackToFutureAdapter.getFuture(done -> {
            new Thread(() -> {
                try {
                    done.set(tile(this, fetch(this)));
                } catch (Exception e) {
                    done.setException(e);
                }
            }).start();
            return "sara-glance";
        });
    }

    @Override
    protected ListenableFuture<ResourceBuilders.Resources> onTileResourcesRequest(RequestBuilders.ResourcesRequest request) {
        return CallbackToFutureAdapter.getFuture(done -> {
            done.set(new ResourceBuilders.Resources.Builder().setVersion(RES).build());
            return "sara-res";
        });
    }

    /** Ask the tile to be drawn again (after pairing, a talk, or on opening the app). */
    static void refresh(Context c) {
        TileService.getUpdater(c).requestUpdate(GlanceTile.class);
    }

    /** The fresh glance, or the last one marked stale, or null (not set up). */
    static Glance fetch(Context c) {
        String server = Store.server(c);
        String token = Store.token(c);
        if (server == null || token == null) return null;
        try {
            Net.Response r = Net.request("GET", server + "/api/shortcuts/wear", token, null);
            if (r.status == 401) {
                Store.forget(c);
                return null;
            }
            if (r.status == 200) {
                Store.setGlance(c, r.body);
                return Glance.parse(r.body, false);
            }
        } catch (Exception e) {
            // Offline: fall through to the last glance.
        }
        String last = Store.glance(c);
        return last == null ? Glance.offline(Store.name(c)) : Glance.parse(last, true);
    }

    /** What the tile shows. */
    static final class Glance {
        String name = "Sara";
        String[] today = new String[0];
        int more;
        int waiting;
        String waitingLine = "";
        String nothing = "";
        String at;
        boolean stale;

        static Glance parse(String json, boolean stale) {
            Glance g = new Glance();
            g.stale = stale;
            try {
                JSONObject j = new JSONObject(json);
                g.name = j.optString("name", "Sara");
                JSONArray t = j.optJSONArray("today");
                int n = t == null ? 0 : Math.min(3, t.length());
                g.today = new String[n];
                for (int i = 0; i < n; i++) {
                    JSONObject x = t.getJSONObject(i);
                    g.today[i] = x.optString("time") + "  " + x.optString("text");
                }
                g.more = j.optInt("more", 0);
                g.waiting = j.optInt("waiting", 0);
                JSONObject lines = j.optJSONObject("lines");
                if (lines != null) {
                    g.waitingLine = lines.optString("waiting");
                    g.nothing = lines.optString("nothing");
                }
                g.at = j.optString("at", null);
            } catch (Exception e) {
                g.stale = true;
            }
            return g;
        }

        static Glance offline(String name) {
            Glance g = new Glance();
            g.name = name;
            g.stale = true;
            return g;
        }
    }

    private static LayoutElementBuilders.LayoutElement text(String s, float size, int color, boolean bold) {
        return text(s, size, color, bold, 1);
    }

    private static LayoutElementBuilders.LayoutElement text(String s, float size, int color, boolean bold, int lines) {
        LayoutElementBuilders.FontStyle.Builder f = new LayoutElementBuilders.FontStyle.Builder()
                .setSize(DimensionBuilders.sp(size))
                .setColor(ColorBuilders.argb(color));
        if (bold) f.setWeight(LayoutElementBuilders.FONT_WEIGHT_BOLD);
        return new LayoutElementBuilders.Text.Builder()
                .setText(s)
                .setFontStyle(f.build())
                .setMaxLines(lines)
                .setMultilineAlignment(LayoutElementBuilders.TEXT_ALIGN_CENTER)
                .setOverflow(LayoutElementBuilders.TEXT_OVERFLOW_ELLIPSIZE_END)
                .build();
    }

    private static LayoutElementBuilders.LayoutElement gap(float dp) {
        return new LayoutElementBuilders.Spacer.Builder().setHeight(DimensionBuilders.dp(dp)).build();
    }

    private static ModifiersBuilders.Clickable open(Context c, Class<?> activity, String id) {
        return new ModifiersBuilders.Clickable.Builder()
                .setId(id)
                .setOnClick(new ActionBuilders.LaunchAction.Builder()
                        .setAndroidActivity(new ActionBuilders.AndroidActivity.Builder()
                                .setPackageName(c.getPackageName())
                                .setClassName(activity.getName())
                                .build())
                        .build())
                .build();
    }

    private static LayoutElementBuilders.LayoutElement pill(Context c, String label) {
        return new LayoutElementBuilders.Box.Builder()
                .setWidth(DimensionBuilders.dp(96))
                .setHeight(DimensionBuilders.dp(34))
                .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
                .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
                .setModifiers(new ModifiersBuilders.Modifiers.Builder()
                        .setClickable(open(c, TalkActivity.class, "talk"))
                        .setBackground(new ModifiersBuilders.Background.Builder()
                                .setColor(ColorBuilders.argb(ACCENT))
                                .setCorner(new ModifiersBuilders.Corner.Builder().setRadius(DimensionBuilders.dp(17)).build())
                                .build())
                        .build())
                .addContent(text(label, 14, WHITE, true))
                .build();
    }

    /** The tile's layout for a glance (null = not set up yet). Built on the watch, so its words are the watch's language. */
    static TileBuilders.Tile tile(Context c, Glance g) {
        LayoutElementBuilders.Column.Builder col = new LayoutElementBuilders.Column.Builder()
                .setWidth(DimensionBuilders.expand())
                .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER);
        if (g == null) {
            col.addContent(text(c.getString(R.string.app_name), 15, SOFT, true))
                    .addContent(gap(8))
                    .addContent(new LayoutElementBuilders.Box.Builder()
                            .setModifiers(new ModifiersBuilders.Modifiers.Builder().setClickable(open(c, MainActivity.class, "setup")).build())
                            .addContent(text(c.getString(R.string.not_set_up), 13, WHITE, false, 3))
                            .build());
        } else {
            col.addContent(text(g.name, 15, SOFT, true)).addContent(gap(6));
            if (g.today.length == 0) col.addContent(text(g.nothing.isEmpty() ? c.getString(R.string.nothing_today) : g.nothing, 13, MUTED, false));
            for (String line : g.today) col.addContent(text(line, 13, WHITE, false));
            if (g.more > 0) col.addContent(text(c.getString(R.string.more, g.more), 12, MUTED, false));
            if (g.waiting > 0) col.addContent(gap(4)).addContent(text(g.waitingLine, 12, AMBER, true, 2));
            if (g.stale) {
                String when = g.at == null ? "" : stamp(g.at);
                col.addContent(text(when.isEmpty() ? c.getString(R.string.offline) : c.getString(R.string.updated, when), 11, MUTED, false));
            }
            col.addContent(gap(8)).addContent(pill(c, c.getString(R.string.talk)));
        }
        LayoutElementBuilders.LayoutElement root = new LayoutElementBuilders.Box.Builder()
                .setWidth(DimensionBuilders.expand())
                .setHeight(DimensionBuilders.expand())
                .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
                .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
                .setModifiers(new ModifiersBuilders.Modifiers.Builder()
                        .setPadding(new ModifiersBuilders.Padding.Builder().setStart(DimensionBuilders.dp(20)).setEnd(DimensionBuilders.dp(20)).build())
                        .build())
                .addContent(col.build())
                .build();
        return new TileBuilders.Tile.Builder()
                .setResourcesVersion(RES)
                .setFreshnessIntervalMillis(15 * 60 * 1000L)
                .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(root))
                .build();
    }

    private static String stamp(String iso) {
        try {
            java.time.Instant t = java.time.Instant.parse(iso);
            return DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(t.toEpochMilli()));
        } catch (Exception e) {
            return "";
        }
    }
}
