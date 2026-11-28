// T62 (the owner's decision 2026-11-28: companions are fully separate identities): her picture and the
// appearance set are kept per companion on a device. The main companion keeps the plain keys
// (sara.herPicture, sara.palette…), so a device with one companion sees no change; another companion
// keeps hers under `<key>@<id>` (sara.herPicture@ana). Until she changes something of her own she shows
// the device's look (the plain keys); her first change copies that look into her keys and marks her
// (sara.lookOwn@<id>), so from then on only her own keys count (Reset gives her the defaults, and a
// later change for the main companion no longer reaches her).
// A plain script (like theme-boot.js, which needs it before the first paint): loaded in <head> before
// theme-boot.js, and imported by app.js, avatar-settings.js… for its global, window.saraKeys.
(function (g) {
  var MAIN = 'main';
  var COOKIE = 'sara_companion';
  /** The keys that follow the companion (everything else on the device stays shared). */
  var KEYS = ['sara.herPicture', 'sara.palette', 'sara.vrm', 'sara.faceFit', 'sara.portrait', 'sara.decor', 'sara.theme', 'sara.accent', 'sara.accentPicked', 'sara.accentCustom', 'sara.density', 'sara.glass', 'sara.chatbg', 'sara.textSize', 'sara.runDetails'];
  var OWN = 'sara.lookOwn';

  /** The companion a cookie string names: 'main' when absent, empty or 'main'. */
  function companionFromCookie(cookie) {
    var parts = String(cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(COOKIE + '=') !== 0) continue;
      var v = p.slice(COOKIE.length + 1);
      try {
        v = decodeURIComponent(v);
      } catch (e) {
        /* kept as written */
      }
      v = v.trim();
      return v && v !== MAIN ? v : MAIN;
    }
    return MAIN;
  }
  var isMain = function (id) {
    return !id || id === MAIN;
  };
  /** Any name with the companion's suffix (main: unchanged), e.g. an IndexedDB record. */
  function suffix(name, id) {
    return isMain(id) ? name : name + '@' + id;
  }
  /** The storage key for `key` and companion `id` (keys outside KEYS are shared: unchanged). */
  function scoped(key, id) {
    return KEYS.indexOf(key) >= 0 ? suffix(key, id) : key;
  }
  /** Her value: her own key; until she has her own look, the device's. */
  function read(store, key, id) {
    var own = scoped(key, id);
    if (own === key) return store.getItem(key);
    var v = store.getItem(own);
    if (v !== null) return v;
    return store.getItem(suffix(OWN, id)) === '1' ? null : store.getItem(key);
  }
  /** Her first change: the device's current look becomes her own starting point. */
  function fork(store, id) {
    if (isMain(id) || store.getItem(suffix(OWN, id)) === '1') return;
    for (var i = 0; i < KEYS.length; i++) {
      var v = store.getItem(KEYS[i]);
      if (v !== null && store.getItem(suffix(KEYS[i], id)) === null) store.setItem(suffix(KEYS[i], id), v);
    }
    store.setItem(suffix(OWN, id), '1');
  }
  function write(store, key, value, id) {
    var own = scoped(key, id);
    if (own !== key) fork(store, id);
    store.setItem(own, value);
  }
  function remove(store, key, id) {
    var own = scoped(key, id);
    if (own !== key) fork(store, id);
    store.removeItem(own);
  }

  var current = function () {
    try {
      return companionFromCookie(g.document ? g.document.cookie : '');
    } catch (e) {
      return MAIN;
    }
  };
  var ls = function () {
    return g.localStorage;
  };
  g.saraKeys = {
    MAIN: MAIN,
    KEYS: KEYS,
    companionFromCookie: companionFromCookie,
    suffix: suffix,
    scoped: scoped,
    read: read,
    write: write,
    remove: remove,
    /** The companion this page is (from the cookie the server reads too). */
    current: current,
    /** localStorage for the current companion. */
    get: function (key) {
      return read(ls(), key, current());
    },
    set: function (key, value) {
      write(ls(), key, value, current());
    },
    del: function (key) {
      remove(ls(), key, current());
    },
  };
})(globalThis);
