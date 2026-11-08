package com.backstagecoding.sara;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ClipData;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.CancellationSignal;
import android.os.SystemClock;
import android.util.Base64;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * The app: first a one-screen setup (type your server's address), then the normal Sara web app
 * in a full-screen window, with the microphone, camera and photo picker working.
 */
public class MainActivity extends Activity {
    /** True while the app is on screen (no notification needed then: the chat shows it). */
    static volatile boolean visible;

    /** The demo server (for trying Sara out and for app review). */
    static final String DEMO_SERVER = "https://demo.sara.backstagecoding.com";

    private static final int REQ_PERMS = 1;
    /** EC24: location for one Allow once in Sara's own helper prompt. */
    private static final int REQ_HELPER_GEO = 241;
    private static final int REQ_FILE = 2;
    private static final int REQ_CALL = 4;
    private static final int REQ_UNLOCK = 5;
    private static final int REQ_PLACES = 6;
    private static final int REQ_PLACES_BG = 7;
    private String pendingPlaceName;
    /** With the app lock on, it locks again after this long in the background. */
    private static final long RELOCK_MS = 30_000;

    private WebView web;
    private FrameLayout root;
    private View lockView;
    private boolean locked;
    private long backgroundAt;
    private String pendingCall;
    private String pendingRing;
    /** Text/photos shared from another app, waiting for the page (JSON for window.saraShare). */
    private String pendingShare;
    private PermissionRequest pendingPermission;
    private GeolocationPermissions.Callback pendingGeo;
    private String pendingGeoOrigin;
    private ValueCallback<Uri[]> fileCallback;

    /** Night or Day: the theme the page showed last (the app's own screens, bars and first paint). */
    private Look look = Look.NIGHT;
    /**
     * True while the page draws under the status and navigation bars itself (env(safe-area-inset-*)
     * reaches it); false: the app keeps the page clear of the bars and paints them in the page's
     * colours. Edge to edge only when this phone's web view really reports the insets (checked once
     * per web view version) and the page asks for it (viewport-fit=cover).
     */
    private boolean edge;
    /** The colours at the top and bottom edge of the page (for the bars while the app pads it). */
    private int barTop, barBottom;
    /** The page to open once the safe-area check has run (null: no check running). */
    private String probeThen;
    private boolean clearHistoryNext;

    @Override
    protected void onCreate(Bundle saved) {
        look = Look.saved(this);
        if (look.day) setTheme(R.style.Sara_Day);
        super.onCreate(saved);
        setupWindow();
        applySecureFlag();
        if (handlePairLink(getIntent())) return;
        takeShare(getIntent());
        takeRing(getIntent());
        // Phase 68: the saved servers (the one from before 1.8 becomes the first, as it was).
        Servers.list(this);
        // Opened from a notification of another saved server: that one first.
        String from = getIntent() == null ? null : getIntent().getStringExtra("server");
        Servers.Profile cur = Servers.active(this);
        if (from != null && cur != null && !from.equals(cur.id) && Servers.useId(this, from) != null) LiveInbox.restart(this);
        String server = Net.server(this);
        if (server == null) showSetup(null, null);
        else showWeb(server, getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (handlePairLink(intent)) return;
        if (takeShare(intent)) return;
        if (takeRing(intent)) {
            deliverRing();
            return;
        }
        String conv = intent.getStringExtra("conv");
        // Phase 68: a notification from another saved server opens that server.
        String from = intent.getStringExtra("server");
        Servers.Profile cur = Servers.active(this);
        if (from != null && cur != null && !from.equals(cur.id)) {
            switchTo(from, intent);
            return;
        }
        if (web != null && conv != null) web.loadUrl(Net.server(this) + "/#c=" + Uri.encode(conv));
    }

    /** Phase 68: shows another saved server; every server keeps its sign-in. */
    private void switchTo(String id, Intent intent) {
        Servers.Profile p = Servers.useId(this, id);
        if (p == null) return;
        LiveInbox.restart(this);
        WidgetProvider.refreshAsync(this);
        Toast.makeText(this, getString(R.string.servers_now, p.name), Toast.LENGTH_SHORT).show();
        showWeb(p.url, intent);
    }

    /**
     * sara://pair?s=<server>&c=<code> (from the pairing page): connects to that server and signs
     * in with the one-time code. Without c (the access QR's sign-in page) it connects and shows
     * that server's sign-in. Always asks first, so a link can't quietly switch servers. Phase 68:
     * another server is added next to the ones already here (nobody is signed out).
     */
    private boolean handlePairLink(Intent intent) {
        Uri u = intent == null ? null : intent.getData();
        if (u == null || !"sara".equals(u.getScheme()) || !"pair".equals(u.getHost())) return false;
        String server = u.getQueryParameter("s");
        String given = u.getQueryParameter("c");
        final String code = given == null || given.trim().isEmpty() ? null : given.trim();
        if (server == null) return false;
        String current = Net.server(this);
        Runnable back = () -> {
            if (web == null && Net.server(this) != null) showWeb(Net.server(this), null);
            else if (web == null) showSetup(null, null);
        };
        final String url = Net.pairOrigin(server);
        if (web == null && current == null) showSetup(null, null);
        if (url == null) {
            // A user name before the host, a path, a query or a fragment: not a plain server address.
            new android.app.AlertDialog.Builder(this)
                    .setTitle(R.string.pair_refused_title)
                    .setMessage(R.string.pair_refused_message)
                    .setPositiveButton(android.R.string.ok, (d, w) -> back.run())
                    .setOnCancelListener(d -> back.run())
                    .show();
            return true;
        }
        // Already saved (any of them): sign in there again. A new one: added next to the others.
        boolean adding = current != null && !Net.sameOrigin(current, url) && Servers.byOrigin(this, url) == null;
        android.text.SpannableStringBuilder msg = new android.text.SpannableStringBuilder();
        int start;
        if (adding) {
            String m = getString(R.string.servers_add_message, url);
            msg.append(m);
            start = m.indexOf(url);
            msg.setSpan(new android.text.style.StyleSpan(Typeface.BOLD), start, start + url.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        } else {
            String m = getString(R.string.pair_sign_in_message, url);
            msg.append(m);
            start = m.indexOf(url);
            if (start >= 0) msg.setSpan(new android.text.style.StyleSpan(Typeface.BOLD), start, start + url.length(), android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        if (url.startsWith("http://") && !Net.isPrivateHost(url)) {
            msg.append("\n\n").append(getString(R.string.pair_plain_http));
        }
        if (adding) msg.append("\n\n").append(getString(R.string.servers_add_only_yours));
        boolean switching = adding;
        android.app.AlertDialog.Builder b = new android.app.AlertDialog.Builder(this)
                .setTitle(adding ? getString(R.string.servers_add_title) : getString(code != null ? R.string.pair_code_title : R.string.pair_open_title))
                .setMessage(msg)
                .setOnCancelListener(d -> back.run());
        if (adding) {
            // Cancel is the main (default) choice; adding a server from a link is the careful one.
            b.setPositiveButton(getString(R.string.servers_cancel), (d, w) -> back.run());
            b.setNegativeButton(getString(R.string.servers_add), (d, w) -> connect(url, code));
        } else {
            b.setPositiveButton(getString(R.string.pair_sign_in), (d, w) -> connect(url, code));
            b.setNegativeButton(getString(R.string.servers_cancel), (d, w) -> back.run());
        }
        android.app.AlertDialog dlg = b.create();
        if (switching) {
            dlg.setOnShowListener(d -> {
                Button sw = dlg.getButton(android.app.AlertDialog.BUTTON_NEGATIVE);
                if (sw != null) sw.setTextColor(look.danger);
                Button cancel = dlg.getButton(android.app.AlertDialog.BUTTON_POSITIVE);
                if (cancel != null) {
                    cancel.setTextColor(look.text1);
                    cancel.requestFocus();
                }
            });
        }
        dlg.show();
        return true;
    }

    /**
     * Opens that server (a saved one, or a new one added to the list); with a pairing code, signs
     * in on the way. The server that was in use stays signed in (Phase 68).
     */
    private void connect(String url, String code) {
        Servers.use(this, url);
        LiveInbox.restart(this);
        Intent i = new Intent();
        if (code != null && !code.trim().isEmpty()) i.putExtra("pair", code.trim());
        showWeb(url, i);
    }

    // ---------- setup ----------

    // The new look's colours (web/theme.css) for the app's own screens: Look.NIGHT or Look.DAY.

    private android.graphics.drawable.GradientDrawable rounded(int fill, int stroke, int radiusDp) {
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(dp(radiusDp));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    /** A main (rose → violet) or quiet (outlined) button, like the web app's. */
    private void styleButton(Button b, String label, boolean primary) {
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(16);
        b.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        b.setTextColor(primary ? look.onBtn : look.text1);
        b.setStateListAnimator(null);
        b.setMinHeight(dp(48));
        b.setPadding(dp(18), 0, dp(18), 0);
        android.graphics.drawable.GradientDrawable g;
        if (primary) {
            g = new android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TL_BR, new int[] {look.btnFrom, look.btnTo});
            g.setCornerRadius(dp(12));
        } else {
            g = rounded(look.surface2, look.hairlineStrong, 12);
        }
        b.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(primary ? 0x33FFFFFF : look.ripple), g, null));
    }

    private Button button(String label, boolean primary) {
        Button b = new Button(this);
        styleButton(b, label, primary);
        return b;
    }

    private EditText field(String hint) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setSingleLine(true);
        e.setTextSize(16);
        e.setTextColor(look.text1);
        e.setHintTextColor(look.text3);
        e.setMinHeight(dp(48));
        // The web's inputs: a sunken surface with a hairline edge, the accent edge while typing.
        android.graphics.drawable.StateListDrawable st = new android.graphics.drawable.StateListDrawable();
        android.graphics.drawable.GradientDrawable focused = rounded(look.surface2, 0, 12);
        focused.setStroke(dp(2), look.accentText);
        st.addState(new int[] {android.R.attr.state_focused}, focused);
        st.addState(new int[0], rounded(look.surface2, look.hairlineStrong, 12));
        e.setBackground(st);
        e.setPadding(dp(14), dp(12), dp(14), dp(12));
        return e;
    }

    private TextView label(String s) {
        TextView t = text(s, 14, look.text1);
        t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        t.setPadding(0, dp(16), 0, dp(6));
        return t;
    }

    private static LinearLayout.LayoutParams fullWidth(int topMarginPx) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = topMarginPx;
        return lp;
    }

    /** Her picture in a circle with the accent ring, and "AI companion" under it (as on Today). */
    private View logo() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        android.widget.ImageView img = new android.widget.ImageView(this);
        img.setImageDrawable(roundFace(dp(64)));
        img.setContentDescription(getString(R.string.app_name));
        // The ring: the accent gradient, a thin gap in the card colour, then her picture.
        android.graphics.drawable.GradientDrawable ring = new android.graphics.drawable.GradientDrawable(android.graphics.drawable.GradientDrawable.Orientation.TL_BR, new int[] {look.accentFrom, look.accentTo});
        ring.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        android.graphics.drawable.GradientDrawable gap = new android.graphics.drawable.GradientDrawable();
        gap.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        gap.setColor(look.surface1);
        android.graphics.drawable.LayerDrawable bg = new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[] {ring, gap});
        bg.setLayerInset(1, dp(2), dp(2), dp(2), dp(2));
        img.setBackground(bg);
        img.setPadding(dp(4), dp(4), dp(4), dp(4));
        img.setElevation(dp(6));
        img.setOutlineProvider(android.view.ViewOutlineProvider.BACKGROUND);
        box.addView(img, new LinearLayout.LayoutParams(dp(72), dp(72)));
        TextView chip = text(getString(R.string.ai_companion), 12, look.text2);
        chip.setBackground(rounded(look.surface2, look.hairlineStrong, 999));
        chip.setPadding(dp(10), dp(3), dp(10), dp(4));
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        clp.leftMargin = dp(14);
        box.addView(chip, clp);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(20);
        box.setLayoutParams(lp);
        return box;
    }

    /** Her picture cut to a circle. */
    private android.graphics.drawable.Drawable roundFace(int size) {
        Bitmap src = BitmapFactory.decodeResource(getResources(), R.drawable.icon);
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        android.graphics.Canvas cv = new android.graphics.Canvas(out);
        android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG | android.graphics.Paint.FILTER_BITMAP_FLAG);
        if (src != null) {
            android.graphics.BitmapShader sh = new android.graphics.BitmapShader(src, android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP);
            android.graphics.Matrix m = new android.graphics.Matrix();
            float scale = (float) size / Math.min(src.getWidth(), src.getHeight());
            m.setScale(scale, scale);
            m.postTranslate((size - src.getWidth() * scale) / 2f, (size - src.getHeight() * scale) / 2f);
            sh.setLocalMatrix(m);
            paint.setShader(sh);
        } else {
            paint.setColor(look.surface2);
        }
        cv.drawCircle(size / 2f, size / 2f, size / 2f, paint);
        return new android.graphics.drawable.BitmapDrawable(getResources(), out);
    }

    /** The page background of the app's own screens: the surface with the web's soft glows. */
    private android.graphics.drawable.Drawable pageBackground() {
        int w = getResources().getDisplayMetrics().widthPixels;
        int h = getResources().getDisplayMetrics().heightPixels;
        android.graphics.drawable.GradientDrawable violet = new android.graphics.drawable.GradientDrawable();
        violet.setGradientType(android.graphics.drawable.GradientDrawable.RADIAL_GRADIENT);
        violet.setColors(new int[] {look.glowViolet, look.glowViolet & 0x00FFFFFF});
        violet.setGradientCenter(0.75f, 0.0f);
        violet.setGradientRadius(Math.max(w, h) * 0.6f);
        android.graphics.drawable.GradientDrawable rose = new android.graphics.drawable.GradientDrawable();
        rose.setGradientType(android.graphics.drawable.GradientDrawable.RADIAL_GRADIENT);
        rose.setColors(new int[] {look.glowRose, look.glowRose & 0x00FFFFFF});
        rose.setGradientCenter(0.0f, 1.0f);
        rose.setGradientRadius(Math.max(w, h) * 0.5f);
        return new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[] {new android.graphics.drawable.ColorDrawable(look.bg), violet, rose});
    }

    /** The app's own screens: a card in the middle (scrolls on small phones and with big text). */
    private LinearLayout screen() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(rounded(look.surface1, look.hairlineStrong, 22));
        card.setElevation(dp(look.day ? 10 : 2));
        card.setPadding(dp(24), dp(26), dp(24), dp(22));
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackground(pageBackground());
        scroll.setClipToPadding(false);
        FrameLayout center = new FrameLayout(this);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.min(dp(480), getResources().getDisplayMetrics().widthPixels - dp(32)), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        lp.topMargin = dp(8);
        lp.bottomMargin = dp(8);
        center.addView(card, lp);
        scroll.addView(center, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        // The screen's background runs under the see-through bars; its content stays clear of them.
        keepClearOfBars(scroll, dp(16));
        setContentView(scroll);
        paintBars(look.bg, look.bg);
        card.addView(logo());
        return card;
    }

    private void showSetup(String prefill, String error) {
        dropWeb();
        // Phase 68: with a Sara already here, this screen adds another one (Back returns).
        final Servers.Profile here = Servers.active(this);
        LinearLayout box = screen();

        TextView title = heading(getString(here != null ? R.string.servers_add_a_sara : R.string.setup_title));
        TextView help = text(getString(here != null ? R.string.setup_add_help : R.string.setup_help), 15, look.text2);
        help.setPadding(0, dp(8), 0, 0);
        help.setLineSpacing(0, 1.15f);

        EditText address = field("sara.example.com");
        address.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setImeOptions(EditorInfo.IME_ACTION_NEXT);
        if (prefill != null) address.setText(prefill);

        EditText pairCode = field("XXXX-XXXX-XXXX");
        pairCode.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        pairCode.setImeOptions(EditorInfo.IME_ACTION_GO);
        pairCode.setTypeface(Typeface.MONOSPACE);
        TextView codeHelp = text(getString(R.string.setup_code_help), 13, look.text2);
        codeHelp.setLineSpacing(0, 1.1f);
        codeHelp.setPadding(0, dp(6), 0, 0);

        TextView status = text(error == null ? "" : error, 14, look.danger);
        status.setPadding(0, dp(12), 0, 0);
        status.setVisibility(error == null ? View.GONE : View.VISIBLE);

        Button go = button(getString(R.string.setup_connect), true);
        Runnable connect = () -> {
            String url = Net.normalize(address.getText().toString());
            if (url.isEmpty()) return;
            go.setEnabled(false);
            status.setVisibility(View.VISIBLE);
            status.setTextColor(look.text2);
            status.setText(R.string.setup_checking);
            // Typed without http:// or https://: try https first, then plain http (a server at home).
            String typed = address.getText().toString().trim();
            boolean schemeGiven = typed.startsWith("http://") || typed.startsWith("https://");
            String[] tries = schemeGiven ? new String[] {url} : new String[] {url, "http://" + url.substring("https://".length())};
            new Thread(() -> {
                String err = getString(R.string.setup_unreachable);
                String found = null;
                for (String t : tries) {
                    try {
                        Net.Response r = Net.get(this, t + "/api/health");
                        if (r.status == 200 && r.text().contains("\"ok\"")) {
                            found = t;
                            break;
                        }
                        err = getString(R.string.setup_not_sara);
                    } catch (Exception e) {
                        // try the next one
                    }
                }
                String finalErr = found == null ? err : null;
                String finalUrl = found;
                runOnUiThread(() -> {
                    go.setEnabled(true);
                    if (finalErr != null) {
                        status.setTextColor(look.danger);
                        status.setText(finalErr);
                        return;
                    }
                    connect(finalUrl, pairCode.getText().toString());
                });
            }).start();
        };
        go.setOnClickListener(v -> connect.run());
        pairCode.setOnEditorActionListener((v, id, ev) -> {
            connect.run();
            return true;
        });

        box.addView(title);
        box.addView(help);
        box.addView(label(getString(R.string.setup_address)));
        box.addView(address, fullWidth(0));
        box.addView(label(getString(R.string.setup_code)));
        box.addView(pairCode, fullWidth(0));
        box.addView(codeHelp);
        box.addView(status);
        box.addView(go, fullWidth(dp(18)));
        if (here != null) {
            Button back = button(getString(R.string.servers_back, here.name), false);
            back.setOnClickListener(v -> showWeb(here.url, null));
            box.addView(back, fullWidth(dp(10)));
        } else {
            View line = new View(this);
            line.setBackgroundColor(look.hairlineStrong);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1));
            lp.topMargin = dp(22);
            box.addView(line, lp);
            TextView demoHelp = text(getString(R.string.setup_demo_help), 13, look.text2);
            demoHelp.setPadding(0, dp(14), 0, 0);
            box.addView(demoHelp);
            Button demo = button(getString(R.string.setup_demo), false);
            demo.setOnClickListener(v -> {
                Servers.use(this, DEMO_SERVER);
                Intent i = new Intent();
                i.putExtra("demo", true);
                showWeb(DEMO_SERVER, i);
            });
            box.addView(demo, fullWidth(dp(10)));
        }
    }

    /** A saved Sara isn't answering: Try again, add a Sara, or open one of the others. */
    private void showOffline(String server) {
        dropWeb();
        LinearLayout box = screen();
        TextView title = heading(getString(R.string.offline_title));
        box.addView(title);
        TextView msg = text(getString(R.string.offline_message, Servers.host(server)), 15, look.text2);
        msg.setPadding(0, dp(8), 0, 0);
        msg.setLineSpacing(0, 1.15f);
        box.addView(msg);
        Button retry = button(getString(R.string.offline_retry), true);
        retry.setOnClickListener(v -> showWeb(server, null));
        box.addView(retry, fullWidth(dp(20)));
        Button add = button(getString(R.string.servers_add_a_sara), false);
        add.setOnClickListener(v -> showSetup(null, null));
        box.addView(add, fullWidth(dp(10)));
        // Phase 68: the other saved Saras are one tap away.
        Servers.Profile cur = Servers.active(this);
        boolean first = true;
        for (Servers.Profile p : Servers.list(this)) {
            if (cur != null && p.id.equals(cur.id)) continue;
            if (first) {
                TextView others = text(getString(R.string.offline_others), 13, look.text2);
                others.setPadding(0, dp(18), 0, 0);
                box.addView(others);
                first = false;
            }
            Button b = button((p.emoji == null || p.emoji.isEmpty() ? "" : p.emoji + " ") + p.name, false);
            b.setOnClickListener(v -> switchTo(p.id, null));
            box.addView(b, fullWidth(dp(8)));
        }
    }

    // ---------- the app ----------

    /** Lets go of the web view (switching servers or showing the setup screen). */
    private void dropWeb() {
        probeThen = null;
        if (web == null) return;
        WebView old = web;
        web = null;
        if (root != null) root.removeView(old);
        old.destroy();
    }

    private void showWeb(String server, Intent intent) {
        dropWeb();
        // Test builds only: lets a developer inspect the page from a computer (chrome://inspect).
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // EC24: the page asks for one location fix only after Allow once in Sara's helper prompt.
        s.setGeolocationEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " SaraPhone/1");
        CookieManager.getInstance().setAcceptCookie(true);
        final String host = Uri.parse(server).getHost();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (host != null && host.equals(u.getHost())) return false;
                // Other sites (links, Google sign-in) open in the phone's browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                    // no browser
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame() && probeThen == null) showOffline(server);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (probeThen != null) {
                    view.postDelayed(() -> measureProbe(server), 150);
                    return;
                }
                if (clearHistoryNext) {
                    clearHistoryNext = false;
                    view.clearHistory();
                }
                CookieManager.getInstance().flush();
                view.evaluateJavascript(LOOK_JS, null);
                deliverShare();
                deliverRing();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                List<String> need = new ArrayList<>();
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && !has(Manifest.permission.RECORD_AUDIO)) need.add(Manifest.permission.RECORD_AUDIO);
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && !has(Manifest.permission.CAMERA)) need.add(Manifest.permission.CAMERA);
                }
                if (need.isEmpty()) {
                    request.grant(request.getResources());
                } else {
                    pendingPermission = request;
                    requestPermissions(need.toArray(new String[0]), REQ_PERMS);
                }
            }

            // EC24: one location fix for Sara's own page (never remembered: retain = false).
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (has(Manifest.permission.ACCESS_COARSE_LOCATION) || has(Manifest.permission.ACCESS_FINE_LOCATION)) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeo = callback;
                    pendingGeoOrigin = origin;
                    requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_HELPER_GEO);
                }
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "SaraPhone");
        CallService.listener = this::callEvent;
        // No white flash: the web view and the strips under the bars start in the page's theme.
        web.setBackgroundColor(look.bg);
        root = new FrameLayout(this);
        barTop = look.bg;
        barBottom = look.bg;
        root.setBackground(new BarsDrawable());
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        String target = server + (pairPath(intent));
        Boolean insetsWork = webInsetsWork();
        edge = Build.VERSION.SDK_INT >= 30 && Boolean.TRUE.equals(insetsWork) && Net.prefs(this).getBoolean("cover:" + Servers.host(server), true);
        // Android 15+ draws apps edge to edge: the page either draws under the bars itself
        // (safe-area insets), or the app keeps it clear of the status bar, the navigation/gesture
        // bar and the keyboard and paints the bars in the page's colours.
        webInsets(root);
        setContentView(root);
        paintBars(barTop, barBottom);
        if (lockOn() && locked) {
            locked = false;
            lock();
        }
        if (Build.VERSION.SDK_INT >= 30 && insetsWork == null) probe(target);
        else web.loadUrl(target);

        // Notifications: ask once (Android 13+), then check for her messages in the background.
        if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 3);
        }
        InboxJob.schedule(this);
    }

    private static String pairPath(Intent intent) {
        String conv = intent == null ? null : intent.getStringExtra("conv");
        String pair = intent == null ? null : intent.getStringExtra("pair");
        boolean demo = intent != null && intent.getBooleanExtra("demo", false);
        return pair != null ? "/pair#" + Uri.encode(pair) : demo ? "/?demo=1" : conv != null ? "/#c=" + Uri.encode(conv) : "/";
    }

    // ---------- Bars, safe areas and the page's theme (the new look, 2.7) ----------

    /** See-through status and navigation bars (Android 11+); the screen under them shows through. */
    @SuppressWarnings("deprecation")
    private void setupWindow() {
        android.view.Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            w.setStatusBarColor(Color.TRANSPARENT);
            w.setNavigationBarColor(Color.TRANSPARENT);
            w.setStatusBarContrastEnforced(false);
            w.setNavigationBarContrastEnforced(false);
        }
    }

    /**
     * The colours under the status bar (top) and navigation bar (bottom), and light or dark icons
     * to go with them. With the bars see-through (Android 11+) the root's background shows there;
     * older Android colours the bars themselves.
     */
    @SuppressWarnings("deprecation")
    private void paintBars(int top, int bottom) {
        barTop = top;
        barBottom = bottom;
        android.view.Window w = getWindow();
        boolean lightTop = Look.isLight(top), lightBottom = Look.isLight(bottom);
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int status = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS;
                int nav = android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance((lightTop ? status : 0) | (lightBottom ? nav : 0), status | nav);
            }
        } else {
            w.setStatusBarColor(top);
            w.setNavigationBarColor(bottom);
            View d = w.getDecorView();
            int f = d.getSystemUiVisibility() & ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            if (lightTop) f |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (lightBottom) f |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            d.setSystemUiVisibility(f);
        }
        if (root != null) root.invalidate();
    }

    /** The web view's root: the page's top colour under the status bar, its bottom colour under the navigation bar. */
    private final class BarsDrawable extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint paint = new android.graphics.Paint();

        @Override
        public void draw(android.graphics.Canvas c) {
            android.graphics.Rect b = getBounds();
            int split = root == null ? b.height() / 2 : Math.max(root.getPaddingTop(), b.height() - root.getPaddingBottom());
            paint.setColor(barTop);
            c.drawRect(b.left, b.top, b.right, b.top + split, paint);
            paint.setColor(barBottom);
            c.drawRect(b.left, b.top + split, b.right, b.bottom, paint);
        }

        @Override
        public void setAlpha(int alpha) {
        }

        @Override
        public void setColorFilter(android.graphics.ColorFilter cf) {
        }

        @Override
        @SuppressWarnings("deprecation")
        public int getOpacity() {
            return android.graphics.PixelFormat.OPAQUE;
        }
    }

    /** Pads one of the app's own screens so it stays clear of the bars, cutout and keyboard. */
    private static void keepClearOfBars(View v, int extra) {
        if (Build.VERSION.SDK_INT < 30) {
            v.setPadding(extra, extra, extra, extra);
            return; // the system keeps the window clear of the bars (and resizes for the keyboard)
        }
        v.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
            android.graphics.Insets ime = insets.getInsets(android.view.WindowInsets.Type.ime());
            view.setPadding(bars.left + extra, bars.top + extra, bars.right + extra, Math.max(bars.bottom, ime.bottom) + extra);
            return android.view.WindowInsets.CONSUMED;
        });
    }

    /**
     * The web view's insets. Edge to edge: the page gets the bars as env(safe-area-inset-*) and
     * draws under them; only the keyboard is kept clear (and the page then gets no bottom inset,
     * since the navigation bar is behind the keyboard). Otherwise the page is kept clear of all of
     * them and sees no insets, so nothing is padded twice.
     */
    private void webInsets(FrameLayout v) {
        if (Build.VERSION.SDK_INT < 30) return; // the system keeps the window clear of the bars
        v.setOnApplyWindowInsetsListener((view, insets) -> {
            int sb = android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout();
            android.graphics.Insets bars = insets.getInsets(sb);
            android.graphics.Insets ime = insets.getInsets(android.view.WindowInsets.Type.ime());
            boolean keyboard = ime.bottom > bars.bottom;
            if (!edge) {
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return android.view.WindowInsets.CONSUMED;
            }
            view.setPadding(0, 0, 0, keyboard ? ime.bottom : 0);
            if (!keyboard) return insets;
            return new android.view.WindowInsets.Builder(insets)
                    .setInsets(android.view.WindowInsets.Type.systemBars(), android.graphics.Insets.of(bars.left, bars.top, bars.right, 0))
                    .setInsets(android.view.WindowInsets.Type.displayCutout(), android.graphics.Insets.of(bars.left, bars.top, bars.right, 0))
                    .setInsets(android.view.WindowInsets.Type.ime(), android.graphics.Insets.NONE)
                    .build();
        });
        v.requestApplyInsets();
    }

    /** This web view's version, for remembering whether it reports safe-area insets. */
    private static String webViewVersion() {
        android.content.pm.PackageInfo p = WebView.getCurrentWebViewPackage();
        return p == null ? "?" : p.packageName + "@" + p.versionName;
    }

    /** Does this phone's web view give the page the bars as env(safe-area-inset-*)? null: not checked yet. */
    private Boolean webInsetsWork() {
        String saved = Net.prefs(this).getString("webInsets", "");
        String v = webViewVersion();
        if (!saved.startsWith(v + "=")) return null;
        return saved.endsWith("=yes");
    }

    /** The check (once per web view version): a tiny page edge to edge reads its safe-area insets. */
    private void probe(String then) {
        probeThen = then;
        edge = true;
        if (root != null) root.requestApplyInsets();
        web.loadDataWithBaseURL(null, PROBE_HTML, "text/html", "utf-8", null);
        String mine = then;
        web.postDelayed(() -> {
            if (probeThen != null && probeThen.equals(mine)) finishProbe(null); // no answer: keep it clear of the bars
        }, 2500);
    }

    private static final String PROBE_HTML = "<!doctype html><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
            + "<style>html,body{margin:0;height:100%;background:transparent}#p{position:fixed;left:0;right:0;top:0;bottom:0;"
            + "padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}</style><div id=\"p\"></div>";

    private void measureProbe(String server) {
        if (web == null || probeThen == null) return;
        web.evaluateJavascript("(function(){var s=getComputedStyle(document.getElementById('p'));return JSON.stringify({t:parseFloat(s.paddingTop)||0,b:parseFloat(s.paddingBottom)||0,r:devicePixelRatio||1})})()", result -> {
            Boolean ok = null;
            try {
                JSONObject j = new JSONObject(new JSONArray("[" + result + "]").getString(0));
                android.view.WindowInsets wi = root == null ? null : root.getRootWindowInsets();
                if (wi != null && Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets bars = wi.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                    double r = j.getDouble("r"), t = j.getDouble("t") * r, b = j.getDouble("b") * r;
                    boolean topOk = bars.top > 0 && Math.abs(t - bars.top) <= Math.max(4, bars.top * 0.25);
                    boolean bottomOk = bars.bottom == 0 || Math.abs(b - bars.bottom) <= Math.max(4, bars.bottom * 0.25);
                    ok = topOk && bottomOk;
                    android.util.Log.i("Sara", "Safe-area check (" + webViewVersion() + "): page top " + t + " px, bottom " + b + " px; bars " + bars.top + "/" + bars.bottom + " px: " + (ok ? "edge to edge" : "kept clear"));
                }
            } catch (Exception e) {
                ok = null;
            }
            finishProbe(ok);
        });
    }

    private void finishProbe(Boolean ok) {
        String then = probeThen;
        if (then == null) return;
        probeThen = null;
        if (ok != null) Net.prefs(this).edit().putString("webInsets", webViewVersion() + "=" + (ok ? "yes" : "no")).apply();
        String server = Net.server(this);
        edge = Boolean.TRUE.equals(ok) && server != null && Net.prefs(this).getBoolean("cover:" + Servers.host(server), true);
        if (root != null) root.requestApplyInsets();
        if (web == null) return;
        clearHistoryNext = true;
        web.loadUrl(then);
    }

    /**
     * Runs in each page of her server once loaded (the app's own script, not the page's): tells the
     * app the theme the page shows (html[data-theme], set by web/theme-boot.js and the page's
     * appearance settings), the colours at its top and bottom edge (for the bars; the call screen
     * stays dark in Day too) and whether it draws under the bars (viewport-fit=cover). Checked
     * when the page's theme changes and once a second (cheap: two elementFromPoint calls).
     */
    private static final String LOOK_JS = "(function(){if(window.__saraLook)return window.__saraLook();var P=window.SaraPhone;if(!P||!P.look)return;"
            + "var last='';function hex(n){n=Math.max(0,Math.min(255,Math.round(n)));return(n<16?'0':'')+n.toString(16)}"
            + "function parse(c){if(!c)return null;var m=c.match(/-?[\\d.]+/g);if(!m||m.length<3)return null;var k=/^color\\(/.test(c)?255:1;"
            + "return[+m[0]*k,+m[1]*k,+m[2]*k,m.length>3?+m[3]:1]}"
            + "function at(y,base){var e=document.elementFromPoint(innerWidth/2,y),L=[];while(e&&e.nodeType===1){var c=parse(getComputedStyle(e).backgroundColor);"
            + "if(c&&c[3]>0){L.push(c);if(c[3]>=1)break}e=e.parentElement}"
            // An open modal dialog dims the page under it with its ::backdrop.
            + "var d=document.querySelector('dialog[open]');try{if(d&&d.matches(':modal')){var r=d.getBoundingClientRect();if(y<r.top||y>r.bottom){var k2=parse(getComputedStyle(d,'::backdrop').backgroundColor);if(k2&&k2[3]>0)L.unshift(k2)}}}catch(x){}"
            + "var o=base.slice();for(var i=L.length-1;i>=0;i--){var a=L[i][3];o=[o[0]*(1-a)+L[i][0]*a,o[1]*(1-a)+L[i][1]*a,o[2]*(1-a)+L[i][2]*a]}"
            + "return'#'+hex(o[0])+hex(o[1])+hex(o[2])}"
            + "function send(){var R=document.documentElement,day=R.getAttribute('data-theme')==='light',m=document.querySelector('meta[name=\"theme-color\"]'),"
            + "base=parse(getComputedStyle(document.body||R).backgroundColor)||(day?[250,247,245]:[15,13,23]);if(base[3]<1)base=day?[250,247,245]:[15,13,23];"
            + "if(m&&/^#[0-9a-f]{6}$/i.test(m.content))base=[parseInt(m.content.slice(1,3),16),parseInt(m.content.slice(3,5),16),parseInt(m.content.slice(5,7),16)];"
            + "var v=document.querySelector('meta[name=\"viewport\"]'),cover=!!(v&&/viewport-fit\\s*=\\s*cover/.test(v.content)),"
            + "top=at(1,base),bot=at(innerHeight-1,base),k=[day,top,bot,cover].join('|');if(k===last)return;last=k;P.look(day?'day':'night',top,bot,cover)}"
            + "function safe(){try{send()}catch(e){}}window.__saraLook=safe;setInterval(function(){if(!document.hidden)safe()},1000);addEventListener('resize',safe);"
            + "try{new MutationObserver(safe).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','class']})}catch(e){}safe()})()";

    /** The page's report (LOOK_JS): theme, edge colours, viewport-fit=cover. */
    private void pageLook(String theme, String top, String bottom, boolean cover) {
        if (web == null || probeThen != null) return;
        boolean day = "day".equals(theme);
        if (Look.save(this, day)) {
            look = Look.saved(this);
            lockView = null;
            // Dialogs opened from now on, and the splash at the next start (Android 13+), match.
            getTheme().applyStyle(day ? R.style.SaraDialogsDay : R.style.SaraDialogsNight, true);
            if (Build.VERSION.SDK_INT >= 33) getSplashScreen().setSplashScreenTheme(day ? R.style.Sara_Day : R.style.Sara);
            web.setBackgroundColor(look.bg);
        }
        paintBars(Look.parse(top, look.bg), Look.parse(bottom, look.bg));
        String server = Net.server(this);
        if (server != null && Net.prefs(this).getBoolean("cover:" + Servers.host(server), true) != cover) {
            Net.prefs(this).edit().putBoolean("cover:" + Servers.host(server), cover).apply();
        }
        boolean want = Build.VERSION.SDK_INT >= 30 && Boolean.TRUE.equals(webInsetsWork()) && cover;
        if (want != edge) {
            edge = want;
            if (root != null) root.requestApplyInsets();
        }
    }

    // ---------- Share to her from any app (Phase 18) ----------

    /** Reads text and photos shared from another app; they go into the message box. */
    private boolean takeShare(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return false;
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        CharSequence body = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String text = body == null ? "" : body.toString();
        if (subject != null && !subject.isEmpty() && !text.contains(subject)) text = text.isEmpty() ? subject : subject + "\n" + text;
        List<Uri> uris = new ArrayList<>();
        ClipData clip = intent.getClipData();
        if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) if (clip.getItemAt(i).getUri() != null) uris.add(clip.getItemAt(i).getUri());
        if (uris.isEmpty()) {
            Uri one = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class) : legacyStream(intent);
            if (one != null) uris.add(one);
        }
        final String shareText = text;
        new Thread(() -> {
            try {
                JSONArray images = new JSONArray();
                for (Uri u : uris) {
                    if (images.length() >= 4) break;
                    String data = photoDataUrl(u);
                    if (data != null) images.put(data);
                }
                pendingShare = new JSONObject().put("text", shareText).put("images", images).toString();
                runOnUiThread(this::deliverShare);
            } catch (Exception ignored) {
                // nothing usable
            }
        }).start();
        return true;
    }

    @SuppressWarnings("deprecation")
    private static Uri legacyStream(Intent intent) {
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    /** A shared photo, shrunk to at most 2048 px, as a JPEG data URL. */
    private String photoDataUrl(Uri uri) {
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                BitmapFactory.decodeStream(in, null, o);
            }
            if (o.outWidth <= 0) return null;
            int sample = 1;
            while (Math.max(o.outWidth, o.outHeight) / sample > 2048) sample *= 2;
            BitmapFactory.Options o2 = new BitmapFactory.Options();
            o2.inSampleSize = sample;
            Bitmap bmp;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                bmp = BitmapFactory.decodeStream(in, null, o2);
            }
            if (bmp == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 85, out);
            bmp.recycle();
            return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------- Phase 26: her call, and "Call Sara" ----------

    /** From her ringing notification (show or answer) or the "Call Sara" shortcut. */
    private boolean takeRing(Intent intent) {
        if (intent == null) return false;
        if ("com.backstagecoding.sara.CALL".equals(intent.getAction())) {
            pendingRing = "window.saraStartCall&&window.saraStartCall()";
            intent.setAction(null);
            return true;
        }
        // Phase 126: the Talk to Sara tile and the "turn it back on" notification (a visible screen starts the service).
        if (WakeService.ACTION_TALK.equals(intent.getAction()) || WakeService.ACTION_RESUME.equals(intent.getAction())) {
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, 126);
            else WakeService.start(this, intent.getAction());
            intent.setAction(null);
            return false;
        }
        // Phase 72: opened as the phone's assistant: straight into a voice turn (or the text box).
        if (Intent.ACTION_ASSIST.equals(intent.getAction())) {
            pendingRing = "window.saraAssist&&window.saraAssist()";
            intent.setAction(null);
            return true;
        }
        String action = intent.getStringExtra("ringAction");
        String ring = intent.getStringExtra("ring");
        if (action == null || ring == null) return false;
        intent.removeExtra("ringAction");
        // Over the lock screen, screen on: it's a call.
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        Notify.endRing(this);
        String conv = intent.getStringExtra("ringConv");
        String reason = intent.getStringExtra("ringReason");
        try {
            org.json.JSONObject r = new org.json.JSONObject().put("id", ring).put("conversationId", conv).put("reason", reason == null ? "" : reason).put("state", "ringing");
            pendingRing = "answer".equals(action)
                    ? "window.saraAnswerRing&&window.saraAnswerRing(" + org.json.JSONObject.quote(ring) + "," + org.json.JSONObject.quote(conv) + ")"
                    : "window.saraShowRing&&window.saraShowRing(" + r + ")";
        } catch (Exception e) {
            return false;
        }
        return true;
    }

    private void deliverRing() {
        String js = pendingRing;
        if (js == null || web == null) return;
        pendingRing = null;
        String ready = js.substring(0, js.indexOf("&&"));
        web.evaluateJavascript("(function t(n){if(" + ready + "&&document.querySelector('#main')&&!document.querySelector('#main').hidden)" + js.substring(js.indexOf("&&") + 2) + ";else if(n<240)setTimeout(function(){t(n+1)},250)})(0)", null);
    }

    private void deliverShare() {
        String json = pendingShare;
        if (json == null || web == null) return;
        pendingShare = null;
        web.evaluateJavascript("(function t(n){if(window.saraShare&&document.querySelector('#main')&&!document.querySelector('#main').hidden)window.saraShare(" + json + ");else if(n<240)setTimeout(function(){t(n+1)},250)})(0)", null);
    }

    // ---------- App lock (Phase 18) ----------

    private boolean lockOn() {
        return Net.prefs(this).getBoolean("appLock", false);
    }

    private void applySecureFlag() {
        // Hides the app's content in the recent-apps view while the lock is on.
        if (lockOn()) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    private void lock() {
        if (root == null || locked) return;
        locked = true;
        if (lockView == null) {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setGravity(Gravity.CENTER);
            box.setBackground(pageBackground());
            box.setClickable(true);
            TextView t = text("🔒", 44, look.text1);
            t.setGravity(Gravity.CENTER);
            TextView m = text(getString(R.string.lock_locked), 20, look.text1);
            m.setGravity(Gravity.CENTER);
            m.setPadding(0, dp(8), 0, dp(20));
            Button b = new Button(this);
            styleButton(b, getString(R.string.lock_unlock), true);
            b.setOnClickListener(v -> askToUnlock());
            box.addView(t);
            box.addView(m);
            box.addView(b);
            lockView = box;
        }
        if (lockView.getParent() == null) root.addView(lockView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        askToUnlock();
    }

    private void unlock() {
        locked = false;
        if (lockView != null && lockView.getParent() != null) root.removeView(lockView);
    }

    @SuppressWarnings("deprecation")
    private void askToUnlock() {
        KeyguardManager km = getSystemService(KeyguardManager.class);
        if (km == null || !km.isDeviceSecure()) {
            unlock(); // the phone has no screen lock any more: nothing to check against
            return;
        }
        if (Build.VERSION.SDK_INT >= 28) {
            BiometricPrompt.Builder b = new BiometricPrompt.Builder(this).setTitle(getString(R.string.lock_prompt));
            if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
            else b.setDeviceCredentialAllowed(true);
            b.build().authenticate(new CancellationSignal(), getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    unlock();
                }
            });
        } else {
            Intent i = km.createConfirmDeviceCredentialIntent(getString(R.string.lock_prompt), null);
            if (i != null) startActivityForResult(i, REQ_UNLOCK);
            else unlock();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        applySecureFlag();
        LiveInbox.sync(this);
        if (lockOn() && (backgroundAt == 0 || SystemClock.elapsedRealtime() - backgroundAt > RELOCK_MS)) lock();
    }

    @Override
    protected void onStop() {
        backgroundAt = SystemClock.elapsedRealtime();
        super.onStop();
    }

    // ---------- Live calls run natively (Phase 18) ----------

    private String pendingCallRing;

    // ---------- Phase 29: place reminders ----------

    /** Location while using the app, then "Allow all the time" (needed to notice arriving later). */
    private void askPlacePermissions() {
        if (!has(Manifest.permission.ACCESS_FINE_LOCATION)) {
            requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_PLACES);
            return;
        }
        if (Build.VERSION.SDK_INT >= 29 && !has(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            new android.app.AlertDialog.Builder(this)
                    .setTitle(R.string.places_title)
                    .setMessage(R.string.places_message)
                    .setPositiveButton(R.string.places_continue, (d, w) -> requestPermissions(new String[] {Manifest.permission.ACCESS_BACKGROUND_LOCATION}, REQ_PLACES_BG))
                    .setNegativeButton(R.string.places_not_now, null)
                    .show();
        }
    }

    private void placeResult(boolean ok, String message) {
        web.evaluateJavascript("window.saraPlaceSaved&&window.saraPlaceSaved(" + ok + "," + org.json.JSONObject.quote(message) + ")", null);
    }

    @SuppressWarnings("deprecation")
    private void locateAndSave(String name) {
        android.location.LocationManager lm = getSystemService(android.location.LocationManager.class);
        if (lm == null) {
            placeResult(false, getString(R.string.places_no_service));
            return;
        }
        String provider = lm.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) ? android.location.LocationManager.GPS_PROVIDER
                : lm.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER) ? android.location.LocationManager.NETWORK_PROVIDER : null;
        if (provider == null) {
            placeResult(false, getString(R.string.places_location_off));
            return;
        }
        java.util.function.Consumer<android.location.Location> got = (loc) -> {
            if (loc == null) {
                placeResult(false, getString(R.string.places_not_found));
                return;
            }
            String server = Net.server(this);
            new Thread(() -> {
                try {
                    org.json.JSONObject body = new org.json.JSONObject().put("name", name).put("lat", loc.getLatitude()).put("lon", loc.getLongitude());
                    Net.Response r = Net.postJson(this, server + "/api/places", body.toString());
                    String msg = r.status == 201 ? getString(R.string.places_saved, name) : new org.json.JSONObject(new String(r.body, java.nio.charset.StandardCharsets.UTF_8)).optString("error", getString(R.string.places_save_failed));
                    runOnUiThread(() -> placeResult(r.status == 201, msg));
                    Places.sync(this);
                } catch (Exception e) {
                    android.util.Log.w("Sara", "Saving a place failed", e);
                    runOnUiThread(() -> placeResult(false, getString(R.string.reply_unreachable)));
                }
            }).start();
        };
        try {
            if (Build.VERSION.SDK_INT >= 30) lm.getCurrentLocation(provider, null, getMainExecutor(), got);
            else lm.requestSingleUpdate(provider, new android.location.LocationListener() {
                @Override
                public void onLocationChanged(android.location.Location l) {
                    got.accept(l);
                }
            }, android.os.Looper.getMainLooper());
        } catch (SecurityException e) {
            placeResult(false, getString(R.string.places_need_permission));
        }
    }

    private void beginCall(String conv) {
        beginCall(conv, null);
    }

    private void beginCall(String conv, String ring) {
        if (!has(Manifest.permission.RECORD_AUDIO)) {
            pendingCall = conv;
            pendingCallRing = ring;
            requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQ_CALL);
            return;
        }
        CallService.start(this, conv, ring);
    }

    private void callEvent(String json) {
        runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.saraCallEvent&&window.saraCallEvent(" + json + ")", null);
        });
    }

    /** What the web app can ask the phone app to do (only Sara's own pages load in this window). */
    final class Bridge {
        /** From the app's own look script (LOOK_JS): the page's theme and edge colours. */
        @JavascriptInterface
        public void look(String theme, String top, String bottom, boolean cover) {
            runOnUiThread(() -> pageLook(theme, top, bottom, cover));
        }

        /**
         * Phase 126: Settings → Hey Sara on this phone. op state | set (key on/chime/personal/onlyCharging)
         * | try | remove. The switch starts the service here, while the page is on screen.
         */
        @JavascriptInterface
        public String wake(String op, String json) {
            android.content.SharedPreferences p = WakeService.prefs(MainActivity.this);
            try {
                org.json.JSONObject a = new org.json.JSONObject(json == null || json.isEmpty() ? "{}" : json);
                if ("set".equals(op)) {
                    String key = a.optString("key"), v = a.optString("value");
                    if ("on".equals(key)) {
                        if ("1".equals(v)) {
                            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) runOnUiThread(() -> requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, 126));
                            else runOnUiThread(() -> WakeService.start(MainActivity.this, WakeService.ACTION_START));
                            p.edit().putBoolean("on", true).apply();
                        } else {
                            p.edit().putBoolean("on", false).apply();
                            runOnUiThread(() -> WakeService.start(MainActivity.this, WakeService.ACTION_STOP));
                        }
                    } else if ("chime".equals(key) || "personal".equals(key) || "onlyCharging".equals(key)) p.edit().putBoolean(key, "1".equals(v)).apply();
                    else if ("sensitivity".equals(key)) p.edit().putString("sensitivity", v).apply();
                }
                org.json.JSONObject s = new org.json.JSONObject();
                s.put("available", true).put("on", p.getBoolean("on", false)).put("state", WakeService.state).put("label", android.os.Build.MODEL).put("platform", "android");
                // The keyword model comes with a later 2.59.x app: Talk and the tile work without it.
                s.put("pack", new org.json.JSONObject().put("installed", false).put("mb", 5));
                s.put("sensitivity", p.getString("sensitivity", "normal")).put("chime", p.getBoolean("chime", true)).put("personal", p.getBoolean("personal", true)).put("onlyCharging", p.getBoolean("onlyCharging", false));
                if ("try".equals(op)) return new org.json.JSONObject().put("hits", new org.json.JSONArray()).toString();
                return s.toString();
            } catch (org.json.JSONException e) {
                return "null";
            }
        }

        /** Asks the home screen to place her widget; false if this launcher can't (then: by hand). */
        @JavascriptInterface
        public boolean addWidget() {
            AppWidgetManager m = getSystemService(AppWidgetManager.class);
            if (m == null || !m.isRequestPinAppWidgetSupported()) return false;
            return m.requestPinAppWidget(new ComponentName(MainActivity.this, WidgetProvider.class), null, null);
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> showSetup(null, null));
        }

        // ---- Phase 68: several Saras in one app (the page shows the list; sign-ins stay here) ----

        /** {"servers":[{id,name,host,active,emoji}]}: names and hosts only, never a sign-in. */
        @JavascriptInterface
        public String servers() {
            return Servers.json(MainActivity.this);
        }

        @JavascriptInterface
        public void useServer(String id) {
            runOnUiThread(() -> switchTo(id, null));
        }

        @JavascriptInterface
        public void addServer() {
            runOnUiThread(() -> showSetup(null, null));
        }

        /** Forgets that server's sign-in only (signing this phone out there first). */
        @JavascriptInterface
        public void removeServer(String id) {
            Context c = MainActivity.this;
            Servers.Profile p = Servers.find(Servers.list(c), id);
            if (p == null) return;
            new Thread(() -> {
                try {
                    Net.postJson(c, p.url + "/api/logout", "{}");
                } catch (Exception ignored) {
                    // offline: the sign-in is forgotten here anyway
                }
                Servers.Profile was = Servers.active(c);
                boolean wasActive = was != null && was.id.equals(id);
                Servers.Profile now = Servers.remove(c, id);
                runOnUiThread(() -> {
                    if (!wasActive) {
                        if (web != null) web.evaluateJavascript("window.saraServersChanged&&window.saraServersChanged()", null);
                        return;
                    }
                    LiveInbox.restart(c);
                    if (now == null) showSetup(null, null);
                    else showWeb(now.url, null);
                });
            }).start();
        }

        @JavascriptInterface
        public void renameServer(String id, String name) {
            Servers.rename(MainActivity.this, id, name, true);
        }

        /** The page tells the app her name on this server (names the entry until renamed). */
        @JavascriptInterface
        public void serverName(String name) {
            Servers.Profile p = Servers.active(MainActivity.this);
            if (p != null) Servers.rename(MainActivity.this, p.id, name, false);
        }

        /** Settings kept on the phone: instant, lockPrivate, appLock. */
        @JavascriptInterface
        public String getPref(String name) {
            return String.valueOf(Net.prefs(MainActivity.this).getBoolean(name, false));
        }

        @JavascriptInterface
        public boolean setPref(String name, boolean on) {
            Context c = MainActivity.this;
            switch (name) {
                case "instant":
                case "lockPrivate":
                    Net.prefs(c).edit().putBoolean(name, on).apply();
                    if ("instant".equals(name)) runOnUiThread(() -> LiveInbox.sync(c));
                    return true;
                case "places":
                    // Phase 29: place reminders. On asks for location ("while using", then "all the time").
                    Net.prefs(c).edit().putBoolean(name, on).apply();
                    runOnUiThread(() -> {
                        if (on) askPlacePermissions();
                        Places.syncAsync(c);
                    });
                    return true;
                case "appLock":
                    KeyguardManager km = getSystemService(KeyguardManager.class);
                    if (on && (km == null || !km.isDeviceSecure())) {
                        runOnUiThread(() -> Toast.makeText(c, R.string.lock_needs_screen_lock, Toast.LENGTH_LONG).show());
                        return false;
                    }
                    Net.prefs(c).edit().putBoolean(name, on).apply();
                    runOnUiThread(MainActivity.this::applySecureFlag);
                    return true;
                default:
                    return false;
            }
        }

        @JavascriptInterface
        public void startCall(String conversationId) {
            runOnUiThread(() -> beginCall(conversationId));
        }

        /** Phase 26: can her calls show full screen on a locked phone? "ok", or "ask" (Android 14+ needs the owner's OK). */
        @JavascriptInterface
        public String fullScreenCalls() {
            if (Build.VERSION.SDK_INT < 34) return "ok";
            android.app.NotificationManager nm = getSystemService(android.app.NotificationManager.class);
            return nm != null && nm.canUseFullScreenIntent() ? "ok" : "ask";
        }

        @JavascriptInterface
        public void openFullScreenSettings() {
            if (Build.VERSION.SDK_INT < 34) return;
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())));
                } catch (Exception e) {
                    startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName()));
                }
            });
        }

        /** Phase 29: "off", "need-location", "need-background" (Allow all the time) or "on". */
        @JavascriptInterface
        public String placesStatus() {
            Context c = MainActivity.this;
            if (!Places.on(c)) return "off";
            if (!has(Manifest.permission.ACCESS_FINE_LOCATION)) return "need-location";
            if (!Places.canWatch(c)) return "need-background";
            return "on";
        }

        @JavascriptInterface
        public void fixPlacePermissions() {
            runOnUiThread(MainActivity.this::askPlacePermissions);
        }

        /** Saves the phone's current location as a named place on the server. */
        @JavascriptInterface
        public void savePlaceHere(String name) {
            runOnUiThread(() -> {
                if (!has(Manifest.permission.ACCESS_FINE_LOCATION)) {
                    pendingPlaceName = name;
                    requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_PLACES);
                    return;
                }
                locateAndSave(name);
            });
        }

        /** Phase 36: saves one of her pictures (from this server only) to the phone's Pictures/Sara. */
        @JavascriptInterface
        public void savePicture(String url, String name) {
            Context c = MainActivity.this;
            String server = Net.server(c);
            if (server == null || !Net.sameOrigin(server, url)) return;
            if (Build.VERSION.SDK_INT < 29) {
                runOnUiThread(() -> Toast.makeText(c, R.string.picture_needs_android10, Toast.LENGTH_LONG).show());
                return;
            }
            String file = (name == null || name.isEmpty() ? "Sara" : name.replaceAll("[^\\w .-]", "")) + ".jpg";
            new Thread(() -> {
                String msg;
                try {
                    Net.Response r = Net.get(c, url);
                    if (r.status != 200 || r.body.length == 0) throw new java.io.IOException("HTTP " + r.status);
                    android.content.ContentValues v = new android.content.ContentValues();
                    v.put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, file);
                    v.put(android.provider.MediaStore.Images.Media.MIME_TYPE, r.body.length > 3 && (r.body[0] & 0xff) == 0x89 ? "image/png" : "image/jpeg");
                    v.put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, android.os.Environment.DIRECTORY_PICTURES + "/Sara");
                    Uri out = getContentResolver().insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                    if (out == null) throw new java.io.IOException("no space");
                    try (java.io.OutputStream os = getContentResolver().openOutputStream(out)) {
                        os.write(r.body);
                    }
                    msg = getString(R.string.picture_saved);
                } catch (Exception e) {
                    msg = getString(R.string.picture_failed);
                }
                String m = msg;
                runOnUiThread(() -> Toast.makeText(c, m, Toast.LENGTH_SHORT).show());
            }).start();
        }

        /** Phase 26: answering her call. */
        @JavascriptInterface
        public void answerCall(String conversationId, String ringId) {
            runOnUiThread(() -> beginCall(conversationId, ringId));
        }

        @JavascriptInterface
        public void hangUp() {
            CallService.hangUp(MainActivity.this);
        }
    }

    private boolean has(String perm) {
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == REQ_HELPER_GEO && pendingGeo != null) {
            boolean ok = has(Manifest.permission.ACCESS_COARSE_LOCATION) || has(Manifest.permission.ACCESS_FINE_LOCATION);
            pendingGeo.invoke(pendingGeoOrigin, ok, false);
            pendingGeo = null;
            pendingGeoOrigin = null;
            return;
        }
        if (code == REQ_CALL && pendingCall != null) {
            String conv = pendingCall;
            pendingCall = null;
            String ring = pendingCallRing;
            pendingCallRing = null;
            if (has(Manifest.permission.RECORD_AUDIO)) CallService.start(this, conv, ring);
            else callEvent("{\"type\":\"ended\",\"reason\":\"Microphone: permission denied.\"}");
            return;
        }
        if (code == REQ_PLACES) {
            String name = pendingPlaceName;
            pendingPlaceName = null;
            if (!has(Manifest.permission.ACCESS_FINE_LOCATION)) {
                placeResult(false, getString(R.string.places_need_permission_watch));
                return;
            }
            if (name != null) locateAndSave(name);
            else askPlacePermissions();
            Places.syncAsync(this);
            return;
        }
        if (code == REQ_PLACES_BG) {
            Places.syncAsync(this);
            web.evaluateJavascript("window.saraPlacesChanged&&window.saraPlacesChanged()", null);
            return;
        }
        if (code == REQ_PERMS && pendingPermission != null) {
            List<String> ok = new ArrayList<>();
            for (String r : pendingPermission.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && has(Manifest.permission.RECORD_AUDIO)) ok.add(r);
                else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && has(Manifest.permission.CAMERA)) ok.add(r);
                else if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && !PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) ok.add(r);
            }
            if (ok.isEmpty()) pendingPermission.deny();
            else pendingPermission.grant(ok.toArray(new String[0]));
            pendingPermission = null;
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        if (code == REQ_UNLOCK) {
            if (result == RESULT_OK) unlock();
            return;
        }
        if (code == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(code, result, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        if (Places.on(this)) Places.syncAsync(this);
    }

    @Override
    protected void onDestroy() {
        if (CallService.listener != null) CallService.listener = null;
        super.onDestroy();
    }

    @Override
    protected void onPause() {
        visible = false;
        CookieManager.getInstance().flush();
        WidgetProvider.refreshAsync(this);
        super.onPause();
    }

    /** A screen title: 24 sp, semi-bold with the web's tight letter-spacing. */
    private TextView heading(String s) {
        TextView t = text(s, 24, look.text1);
        t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        t.setLetterSpacing(-0.02f);
        return t;
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
