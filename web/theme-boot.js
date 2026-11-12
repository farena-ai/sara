// Phase 75: runs in <head> before anything is drawn, so the page never flashes the wrong theme.
// Night is the default; Day only when it was picked on this device (or "Follow the system" and
// the system is light). Also the page side of the native-app contract (docs/design/NEW_LOOK.md →
// Native apps): the Windows/Mac apps add class shell-windows / shell-mac to <html> and set
// window.saraShell = { platform, titlebar } before the page runs; then the page leaves a drag
// strip of that height at the top. ?shell=windows&titlebar=32 (or mac) tries it in a browser.
(function () {
  // Messages to the Windows app (WebView2) or the Mac app (WKWebView), when the page runs in one.
  window.saraShellSay = function (msg) {
    try {
      if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(msg);
      else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sara) {
        var p = window.webkit.messageHandlers.sara.postMessage(msg);
        if (p && p.catch) p.catch(function () {});
      }
    } catch (e) {
      /* not in an app */
    }
  };
  var root = document.documentElement;
  var pick = null;
  var get = function (k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  };
  // V3 (docs/ops/V3_DESIGN.md §5, the owner's defaults): the palette first, because Sara Classic keeps
  // its own earlier defaults (Night, its rose, decoration on, the large picture).
  var pal = get('sara.palette');
  if (!/^(graphite|midnight|slate|nord|solarized|paper|ember|contrast|classic)$/.test(pal || '')) pal = 'graphite';
  pick = get('sara.theme');
  // Not picked on this device yet: the Windows/Mac app's own choice (its first paint used it).
  var appPick = window.saraShell && String(window.saraShell.theme || '');
  if (!pick && appPick) pick = appPick === 'day' || appPick === 'light' ? 'light' : appPick === 'system' ? 'system' : 'dark';
  // Nothing picked: Follow the system (Sara Classic: Night).
  if (pick !== 'light' && pick !== 'system' && pick !== 'dark') pick = pal === 'classic' ? 'dark' : 'system';
  var light = pick === 'light' || (pick === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
  root.setAttribute('data-theme', light ? 'light' : 'dark');
  root.classList.add(light ? 'theme-day' : 'theme-night');
  // The other per-device looks, so they don't change after the first paint either.
  // Colour: Violet unless picked (V4e; Sara Classic: its own rose, the stored value "rose" = the palette's own).
  var looks = { accent: pal === 'classic' ? 'rose' : 'violet', chatbg: 'none', density: 'comfy' };
  for (var k in looks) root.setAttribute('data-' + k, get('sara.' + k) || looks[k]);
  // V1 (docs/ops/V1_DESIGN.md): the palette (Graphite unless picked; unknown names too), decoration
  // (off for every palette but Sara Classic unless picked; the system's reduced transparency forces it
  // off), her portrait in work views (small unless picked; Sara Classic keeps it large) and a custom accent's three colours, which
  // app.js worked out when it was saved (no maths before the first paint).
  root.setAttribute('data-palette', pal);
  // V3: Full decoration by default for every palette (outside Classic it is the refined glass and light).
  var decor = get('sara.decor');
  if (decor !== 'on' && decor !== 'off') decor = 'on';
  if (window.matchMedia && matchMedia('(prefers-reduced-transparency: reduce)').matches) decor = 'off';
  root.setAttribute('data-decor', decor);
  var portrait = get('sara.portrait');
  if (!/^(large|small|hidden)$/.test(portrait || '')) portrait = pal === 'classic' ? 'large' : 'small';
  root.setAttribute('data-portrait', portrait);
  // V4 (docs/ops/V4_DESIGN.md): the background field moves unless turned off here (reduced motion
  // stops it too, in web/v4.js and the CSS).
  root.setAttribute('data-motion', get('sara.motion') === 'off' ? 'off' : 'on');
  function hexHsl(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, s = 0, l = (mx + mn) / 2, d = mx - mn;
    if (d) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    }
    return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
  }
  if (get('sara.accent') === 'custom') {
    try {
      var c = JSON.parse(get('sara.accentCustom') || 'null')[light ? 'light' : 'dark'];
      var ok = function (v) { return /^#[0-9a-f]{6}$/i.test(v); };
      if (c && ok(c.fill) && ok(c.text) && ok(c.on)) {
        var set = { '--accent-solid': c.fill, '--accent-text': c.text, '--on-accent': c.on, '--accent': c.fill, '--accent-2': c.text, '--btn-fill': c.fill, '--on-btn': c.on };
        for (var v in set) root.style.setProperty(v, set[v]);
        // V4: the same colour's hue for the glows and the background field (decorative only).
        var hsl = hexHsl(c.fill);
        root.style.setProperty('--acc-h', String(hsl[0]));
        root.style.setProperty('--acc-s', hsl[1] + '%');
        root.style.setProperty('--acc-l', hsl[2] + '%');
      }
    } catch (e) {
      /* a broken value: the palette's own accent */
    }
  }

  var shell = window.saraShell;
  var q = /[?&]shell=(windows|mac)\b/.exec(location.search);
  if (!shell && q) {
    var tb = /[?&]titlebar=(\d{1,3})\b/.exec(location.search);
    shell = window.saraShell = { platform: q[1], titlebar: tb ? Number(tb[1]) : 32, test: true };
  }
  var marked = root.classList.contains('shell-windows') || root.classList.contains('shell-mac');
  if (shell || marked) {
    var plat = (shell && shell.platform) || (root.classList.contains('shell-mac') ? 'mac' : 'windows');
    plat = plat === 'mac' || plat === 'darwin' ? 'mac' : 'windows';
    var h = Math.round(Number(shell && shell.titlebar));
    if (!(h >= 0 && h <= 96)) h = plat === 'mac' ? 28 : 32;
    root.classList.add('shell', 'shell-' + plat);
    if (shell && shell.test) root.classList.add('shell-test');
    root.style.setProperty('--titlebar', h + 'px');
    // Tell the app the page draws its header in the strip (until then it keeps its own title strip).
    if (h > 0 && !(shell && shell.test)) {
      window.saraShellSay && window.saraShellSay({ type: 'shell', titlebar: true });
      // Fred fix A: a page restored from the back/forward cache runs no script again: say it again.
      if (typeof window.addEventListener === 'function') window.addEventListener('pageshow', function (e) {
        if (e.persisted) window.saraShellSay && window.saraShellSay({ type: 'shell', titlebar: true });
      });
    }
  }
})();
