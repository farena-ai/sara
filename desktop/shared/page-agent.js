// Sara's page agent (Phase 87, docs/design/COMPUTER_USE.md §4.2): the ONE fixed script that reads a
// web page for her. It is used by the server's testing browser (src/browser.ts), by the reference
// hands (src/hands-ref.ts) and by the Sara browser of the Windows and Mac apps (bundled into each).
// It only reads the page or finds an element and its position: clicks and typing are real input
// events sent through the DevTools protocol by the code that runs it (Phase 88: target, focusFor,
// choose, scroll, keys, fileInput, mark and state for the hands' acting ops). No other expression is ever
// evaluated in a page by Sara: callers run exactly this file followed by `.call("<name>", <json>)`.
//
// The file is one expression (no trailing semicolon) so callers can write `(<file>).call(n, args)`.
// Rules kept here for every caller: password and other secret fields never give their value (not as
// a value, not as a name), and text that looks like a key or token is masked before it leaves.
(function () {
  'use strict';
  var SECRET_SHAPES = [
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{30,}/g,
    /\bxai-[A-Za-z0-9]{20,}/g,
    /\bsara_(?:dev|hands|m)\.[\w-]+\.[\w-]+/g,
    /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  ];
  function mask(s) {
    var t = String(s == null ? '' : s);
    for (var i = 0; i < SECRET_SHAPES.length; i++) t = t.replace(SECRET_SHAPES[i], '[hidden]');
    return t;
  }
  function isSecretField(e) {
    if (!e || e.tagName !== 'INPUT') return false;
    var type = String(e.type || '').toLowerCase();
    var ac = String(e.getAttribute('autocomplete') || '').toLowerCase();
    return type === 'password' || /password|one-time-code|cc-number|cc-csc|cc-exp/.test(ac);
  }
  function vis(el) {
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
  }
  function name(e) {
    var v = isSecretField(e) ? '' : e.value;
    return String(e.getAttribute('aria-label') || e.innerText || v || e.title || e.getAttribute('placeholder') || e.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
  }
  function desc(e) {
    var t = e.tagName.toLowerCase();
    var n = name(e).slice(0, 60);
    return (e.id ? t + '#' + e.id : t) + (n ? ' "' + n + '"' : '');
  }

  // Finds an element by CSS selector or its visible text (the testing browser's click/type, and the
  // hands' "text" targeting): the element itself, or null / {error}.
  function findEl(a) {
    var el = null;
    if (a.selector) {
      try {
        var all = Array.prototype.slice.call(document.querySelectorAll(a.selector));
        el = all.find(vis) || all[0] || null;
      } catch (e) {
        if (!a.text) return { error: 'That is not a valid CSS selector.' };
      }
    }
    if (!el && a.text) {
      var want = a.text.replace(/\s+/g, ' ').trim().toLowerCase();
      var pool = a.field ? 'input, textarea, select, [contenteditable=""], [contenteditable=true]' : 'button, a, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], input[type=submit], input[type=button], input[type=checkbox], input[type=radio], summary, label, [onclick]';
      var cands = Array.prototype.slice.call(document.querySelectorAll(pool)).filter(vis);
      var labelOf = function (e) {
        var l = e.id && document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
        return String((l && l.innerText) || (e.closest('label') && e.closest('label').innerText) || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
      };
      var key = function (e) { return a.field ? labelOf(e) : name(e).toLowerCase(); };
      el = cands.find(function (e) { return key(e) === want; }) || cands.find(function (e) { return key(e).indexOf(want) >= 0; }) || null;
      if (!el && !a.field) {
        var leaves = Array.prototype.slice.call(document.querySelectorAll('body *')).filter(function (e) { return !e.children.length && vis(e); });
        var tx = function (e) { return String(e.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase(); };
        el = leaves.find(function (e) { return tx(e) === want; }) || leaves.find(function (e) { return tx(e).indexOf(want) >= 0; }) || null;
      }
    }
    return el;
  }
  function find(a) {
    var el = findEl(a);
    if (el && el.error) return el;
    if (!el) return { found: false };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var top = document.elementFromPoint(x, y);
    var covered = top && top !== el && !el.contains(top) && !top.contains(el) ? desc(top) : '';
    if (a.focus) {
      el.focus();
      if (el.select && el.tagName !== 'SELECT') el.select();
      if (el.tagName === 'SELECT' && a.value !== undefined) {
        var w = String(a.value).toLowerCase();
        var o = Array.prototype.slice.call(el.options).find(function (o) { return o.text.trim().toLowerCase() === w || o.value.toLowerCase() === w; });
        if (!o) return { found: true, desc: desc(el), error: 'No option "' + a.value + '" in that list.' };
        el.value = o.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, desc: desc(el), selected: o.text.trim() };
      }
    }
    return { found: true, x: x, y: y, desc: desc(el), covered: covered, disabled: Boolean(el.disabled), secret: isSecretField(el) };
  }

  // The page's text and a short list of its controls (the testing browser's browser_read).
  function read(a) {
    var root = document.body;
    if (a.selector) {
      try { root = document.querySelector(a.selector); } catch (e) { return { error: 'That is not a valid CSS selector.' }; }
      if (!root) return { error: 'Nothing matches ' + a.selector + '.' };
    }
    var max = a.max || 6000;
    var text = mask(String((root && root.innerText) || '').replace(/\n{3,}/g, '\n\n').trim());
    var hint = function (e) { var t = e.tagName.toLowerCase(); if (e.id) return '#' + e.id; if (e.name) return t + '[name="' + e.name + '"]'; return t; };
    var controls = [];
    var list = root ? root.querySelectorAll('a[href], button, [role=button], input, textarea, select, summary') : [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (controls.length >= 50) break;
      if (!vis(e) || e.type === 'hidden') continue;
      var t = e.tagName.toLowerCase();
      var kind = t === 'a' ? 'link' : t === 'input' ? 'input:' + (e.type || 'text') : t === 'select' ? 'list' : t === 'textarea' ? 'text box' : 'button';
      var label = (e.labels && e.labels[0] && e.labels[0].innerText) || name(e);
      var extra = t === 'a' ? ' → ' + String(e.getAttribute('href') || '').slice(0, 80) : (t === 'input' || t === 'textarea') && !isSecretField(e) && e.value ? ' = "' + String(e.value).slice(0, 40) + '"' : t === 'select' && e.selectedOptions[0] ? ' = "' + e.selectedOptions[0].text.trim().slice(0, 40) + '"' : '';
      controls.push(mask(kind + ' "' + String(label).replace(/\s+/g, ' ').trim().slice(0, 60) + '" (' + hint(e) + ')' + extra + (e.disabled ? ' [disabled]' : '')));
    }
    return { title: mask(document.title), url: location.pathname + location.search, text: text.slice(0, max), more: text.length > max, controls: controls, width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
  }

  // Script-free assertions (the testing browser's browser_check).
  function check(checks) {
    var body = String((document.body && document.body.innerText) || '').toLowerCase();
    var q = function (s) { try { return Array.prototype.slice.call(document.querySelectorAll(s)); } catch (e) { return null; } };
    return checks.map(function (c) {
      var t = String(c.text || '').toLowerCase();
      var l;
      switch (c.type) {
        case 'text_visible': return { ok: body.indexOf(t) >= 0 };
        case 'text_absent': return { ok: body.indexOf(t) < 0 };
        case 'element_exists': l = q(c.selector); return l ? { ok: l.length > 0, detail: l.length + ' found' } : { ok: false, detail: 'bad selector' };
        case 'element_visible': l = q(c.selector); return l ? { ok: l.some(vis), detail: l.length + ' found, ' + l.filter(vis).length + ' visible' } : { ok: false, detail: 'bad selector' };
        case 'element_hidden': l = q(c.selector); return l ? { ok: !l.some(vis) } : { ok: false, detail: 'bad selector' };
        case 'count_at_least': l = q(c.selector); return l ? { ok: l.length >= Number(c.count || 1), detail: l.length + ' found' } : { ok: false, detail: 'bad selector' };
        case 'title_contains': return { ok: document.title.toLowerCase().indexOf(t) >= 0, detail: 'title: ' + document.title.slice(0, 80) };
        case 'url_contains': return { ok: (location.pathname + location.search).toLowerCase().indexOf(t) >= 0, detail: location.pathname };
        case 'no_horizontal_scroll': { var w = document.documentElement.scrollWidth; return { ok: w <= innerWidth + 1, detail: 'page ' + w + 'px wide, window ' + innerWidth + 'px' }; }
        case 'input_value': { l = q(c.selector); if (l && l[0] && isSecretField(l[0])) return { ok: false, detail: 'a password field (never read)' }; var v = l && l[0] ? String(l[0].value) : null; return { ok: v !== null && v.toLowerCase().indexOf(t) >= 0, detail: v === null ? 'not found' : 'value: ' + v.slice(0, 60) }; }
        default: return { ok: false, detail: 'unknown check' };
      }
    });
  }

  // ---- The hands' element list (b.snapshot) and visible text (b.read) ----
  var INTERACTIVE = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=textbox], [role=option], [contenteditable=""], [contenteditable=true], h1, h2, h3, h4, h5, h6, img[alt], [role=heading], [role=alert], [role=dialog]';
  function roleOf(e) {
    var r = e.getAttribute('role');
    if (r) return r;
    var t = e.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'img') return 'img';
    if (t === 'input') {
      var ty = String(e.type || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button';
      if (ty === 'password') return 'password';
      return 'textbox';
    }
    if (e.isContentEditable) return 'textbox';
    return t;
  }
  function labelFor(e) {
    var l = e.labels && e.labels[0] && e.labels[0].innerText;
    var by = e.getAttribute('aria-labelledby');
    var lb = by ? by.split(/\s+/).map(function (id) { var x = document.getElementById(id); return x ? x.innerText : ''; }).join(' ') : '';
    return String(e.getAttribute('aria-label') || lb || l || '').replace(/\s+/g, ' ').trim();
  }
  function elements() {
    var out = [];
    var list = document.querySelectorAll(INTERACTIVE);
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.type === 'hidden' || !vis(e)) continue;
      out.push(e);
    }
    return out;
  }
  function nameFor(e, role) {
    var nm = labelFor(e) || (role === 'textbox' || role === 'password' || role === 'combobox' ? String(e.getAttribute('placeholder') || e.name || '') : name(e));
    return mask(String(nm).replace(/\s+/g, ' ').trim().slice(0, 80));
  }
  /** What an element is, short (the hands check it didn't change between looking and acting). */
  function fp(e) {
    var role = roleOf(e);
    return role + '|' + nameFor(e, role).toLowerCase().slice(0, 40);
  }
  function itemOf(e, i) {
    var role = roleOf(e);
    var secret = isSecretField(e);
    var it = { ref: 'e' + (i + 1), role: role, name: nameFor(e, role) };
    var r = e.getBoundingClientRect();
    it.box = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    var t = e.tagName;
    if (secret) it.secret = true;
    else if (t === 'INPUT' && (e.type === 'checkbox' || e.type === 'radio')) it.checked = Boolean(e.checked);
    else if (t === 'INPUT' || t === 'TEXTAREA') { if (e.value) it.value = mask(String(e.value).slice(0, 80)); }
    else if (t === 'SELECT' && e.selectedOptions && e.selectedOptions[0]) it.value = mask(e.selectedOptions[0].text.trim().slice(0, 80));
    if (t === 'A') it.href = mask(String(e.getAttribute('href') || '').slice(0, 120));
    if (e.disabled) it.disabled = true;
    var ex = e.getAttribute('aria-expanded');
    if (ex === 'true' || ex === 'false') it.expanded = ex === 'true';
    if (/^H[1-6]$/.test(t)) it.level = Number(t.slice(1));
    return it;
  }
  function snapshot(a) {
    var from = Math.max(0, Number(a.from) || 0);
    var limit = Math.min(400, Math.max(1, Number(a.limit) || 400));
    var els = elements();
    var items = [];
    for (var i = from; i < els.length && items.length < limit; i++) items.push(itemOf(els[i], i));
    return { title: mask(document.title), url: location.href, items: items, total: els.length, more: from + items.length < els.length, width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth };
  }
  function text(a) {
    var max = Math.min(20000, Math.max(200, Number(a.max) || 8000));
    var root = document.body;
    if (a.ref) {
      var n = Number(String(a.ref).replace(/^e/, '')) - 1;
      var els = elements();
      if (!(n >= 0 && n < els.length)) return { error: 'No element ' + a.ref + ' on the page now: look again.' };
      root = els[n];
      if (isSecretField(root)) return { error: 'That is a password field: its value is never read.' };
    }
    var raw = String((root && root.innerText) || (root && !isSecretField(root) && root.value) || '').replace(/\n{3,}/g, '\n\n').trim();
    var t = mask(raw);
    return { title: mask(document.title), url: location.href, text: t.slice(0, max), more: t.length > max };
  }


  // ---- Phase 88 (CU2): acting. The agent finds the target and says what it is; the click, the typing
  // and the keys are real input events the caller sends through DevTools at the point it returns. ----
  var CARD = /(^|\s)cc-(number|csc|exp|exp-month|exp-year|name|type)\b/;
  function isCardField(e) {
    if (!e || (e.tagName !== 'INPUT' && e.tagName !== 'SELECT')) return false;
    var ac = String(e.getAttribute('autocomplete') || '').toLowerCase();
    var nm = (String(e.name || '') + ' ' + String(e.id || '') + ' ' + String(e.getAttribute('placeholder') || '') + ' ' + labelFor(e)).toLowerCase();
    return CARD.test(ac) || /card.?number|cardnumber|\bcvc\b|\bcvv\b|security code|expiry|expiration/.test(nm);
  }
  function pageFacts() {
    var card = false, pw = false;
    var list = document.querySelectorAll('input, select');
    for (var i = 0; i < list.length && i < 500; i++) {
      if (isCardField(list[i])) card = true;
      if (String(list[i].type || '').toLowerCase() === 'password') pw = true;
    }
    return { url: location.href, title: mask(document.title), hasCard: card, hasPassword: pw };
  }
  function editable(e) {
    if (!e) return false;
    if (e.isContentEditable) return true;
    if (e.tagName === 'TEXTAREA') return !e.disabled && !e.readOnly;
    if (e.tagName !== 'INPUT') return false;
    var ty = String(e.type || 'text').toLowerCase();
    return !e.disabled && !e.readOnly && !/^(button|submit|reset|image|checkbox|radio|file|hidden|range|color)$/.test(ty);
  }
  /** The element a ref (from snapshot, checked against `expect`), a text or a picture point means. */
  function resolve(a) {
    if (a.ref) {
      var n = Number(String(a.ref).replace(/^e/, '')) - 1;
      var els = elements();
      if (!(n >= 0 && n < els.length)) return { stale: 'There is no ' + a.ref + ' on the page now: look again.' };
      var e = els[n];
      if (a.expect && fp(e) !== String(a.expect)) return { stale: 'The page changed since you looked (' + a.ref + ' is now ' + desc(e) + '): look again.' };
      return { el: e };
    }
    if (a.text) {
      var f = findEl({ text: String(a.text), field: a.field === true });
      if (f && f.error) return { missing: f.error };
      return f ? { el: f } : { missing: 'Nothing called "' + String(a.text).slice(0, 80) + '" on the page.' };
    }
    if (a.x !== undefined && a.y !== undefined) {
      var w = Number(a.w) || innerWidth, h = Number(a.h) || innerHeight;
      var x = Number(a.x) * innerWidth / w, y = Number(a.y) * innerHeight / h;
      if (!(x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)) return { missing: 'That point is outside the page.' };
      var at = document.elementFromPoint(x, y);
      return { el: at || document.body, point: { x: x, y: y } };
    }
    return { missing: 'Say what to act on: a ref from pc_browser_look, its text, or a point on a screenshot.' };
  }
  function targetOf(a, scroll) {
    var r = resolve(a);
    if (r.stale) return { found: false, stale: true, error: r.stale };
    if (r.missing) return { found: false, error: r.missing };
    var e = r.el;
    if (!r.point && scroll !== false) e.scrollIntoView({ block: 'center', inline: 'center' });
    var b = e.getBoundingClientRect();
    var x = r.point ? r.point.x : b.left + b.width / 2, y = r.point ? r.point.y : b.top + b.height / 2;
    var top = document.elementFromPoint(x, y);
    var covered = !r.point && top && top !== e && !e.contains(top) && !top.contains(e) ? desc(top) : '';
    var role = roleOf(e);
    var form = e.form || (e.closest && e.closest('form'));
    return {
      found: true, x: Math.round(x), y: Math.round(y), box: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
      desc: mask(desc(e)), role: role, name: nameFor(e, role), fp: fp(e), tag: e.tagName.toLowerCase(), type: String(e.type || '').toLowerCase(),
      secret: isSecretField(e), card: isCardField(e), editable: editable(e), disabled: Boolean(e.disabled), covered: mask(covered),
      formText: form ? mask(String(form.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)) : '',
      page: pageFacts(),
    };
  }
  function target(a) { return targetOf(a, true); }
  /** Focuses the target for typing (after the caller's real click) and selects what's there when `clear`. */
  function focusFor(a) {
    var t = targetOf(a, false);
    if (!t.found) return t;
    var e = resolve(a).el;
    if (isSecretField(e)) return { found: true, secret: true, error: 'That is a password field: Sara never types into those.' };
    if (!editable(e)) return { found: true, error: desc(e) + ' is not a text field.' };
    if (document.activeElement !== e) e.focus();
    if (a.clear) {
      if (e.isContentEditable) { var rg = document.createRange(); rg.selectNodeContents(e); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg); }
      else if (e.select) e.select();
    } else if (!e.isContentEditable && typeof e.value === 'string' && e.setSelectionRange) {
      try { e.setSelectionRange(e.value.length, e.value.length); } catch (err) { /* some types have no caret */ }
    }
    return { found: true, focused: document.activeElement === e, desc: mask(desc(e)) };
  }
  /** Picks an option in a list (select). */
  function choose(a) {
    var r = resolve(a);
    if (r.stale) return { stale: true, error: r.stale };
    if (r.missing) return { error: r.missing };
    var e = r.el;
    if (e.tagName !== 'SELECT') e = e.querySelector ? e.querySelector('select') : null;
    if (!e || e.tagName !== 'SELECT') return { error: 'That is not a list to choose from.' };
    if (e.disabled) return { error: 'That list is disabled.' };
    var w = String(a.option || '').trim().toLowerCase();
    var opts = Array.prototype.slice.call(e.options);
    var o = opts.find(function (x) { return x.text.trim().toLowerCase() === w || x.value.toLowerCase() === w; }) || opts.find(function (x) { return x.text.trim().toLowerCase().indexOf(w) >= 0; });
    if (!w || !o) return { error: 'No option "' + String(a.option || '') + '" in that list. Options: ' + opts.slice(0, 20).map(function (x) { return '"' + x.text.trim() + '"'; }).join(', ') };
    e.focus();
    e.value = o.value;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    var b = e.getBoundingClientRect();
    return { selected: mask(o.text.trim()), desc: mask(desc(e)), x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  }
  function scroll(a) {
    if (a.ref || a.text) {
      var r = resolve(a);
      if (r.stale) return { stale: true, error: r.stale };
      if (r.missing) return { error: r.missing };
      r.el.scrollIntoView({ block: 'center' });
    } else window.scrollBy(0, Math.max(-20000, Math.min(20000, Number(a.dy) || innerHeight * 0.8)));
    var se = document.scrollingElement || document.documentElement;
    return { scrollY: Math.round(scrollY), maxY: Math.max(0, Math.round(se.scrollHeight - innerHeight)) };
  }
  // The keys she may press (a fixed list, checked here on the device): named keys, and Ctrl / Shift /
  // Alt / Meta with one letter or digit. The caller sends exactly these key events.
  var NAMED = { enter: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9, ''], escape: ['Escape', 'Escape', 27, ''], esc: ['Escape', 'Escape', 27, ''], backspace: ['Backspace', 'Backspace', 8, ''], delete: ['Delete', 'Delete', 46, ''], space: [' ', 'Space', 32, ' '], arrowup: ['ArrowUp', 'ArrowUp', 38, ''], arrowdown: ['ArrowDown', 'ArrowDown', 40, ''], arrowleft: ['ArrowLeft', 'ArrowLeft', 37, ''], arrowright: ['ArrowRight', 'ArrowRight', 39, ''], up: ['ArrowUp', 'ArrowUp', 38, ''], down: ['ArrowDown', 'ArrowDown', 40, ''], left: ['ArrowLeft', 'ArrowLeft', 37, ''], right: ['ArrowRight', 'ArrowRight', 39, ''], home: ['Home', 'Home', 36, ''], end: ['End', 'End', 35, ''], pageup: ['PageUp', 'PageUp', 33, ''], pagedown: ['PageDown', 'PageDown', 34, ''] };
  var MODS = { ctrl: 2, control: 2, shift: 8, alt: 1, option: 1, meta: 4, cmd: 4, command: 4 };
  var COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };
  function keys(a) {
    var combo = String(a.combo || '').trim();
    if (!combo || combo.length > 40) return { error: 'Say which keys, like "Enter", "Tab", "Shift+Tab" or "Ctrl+A".' };
    var parts = combo.split('+').map(function (p) { return p.trim().toLowerCase(); }).filter(Boolean);
    var mods = 0, main = null;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (MODS[p] && i < parts.length - 1) { mods |= MODS[p]; continue; }
      if (i !== parts.length - 1) return { error: 'Not a key combination Sara presses: ' + combo };
      if (NAMED[p]) { var n = NAMED[p]; main = { key: n[0], code: n[1], vk: n[2], text: n[3] }; }
      else if (/^[a-z0-9]$/.test(p)) { var up = p.toUpperCase(); main = { key: mods & 8 ? up : p, code: /[a-z]/.test(p) ? 'Key' + up : 'Digit' + p, vk: up.charCodeAt(0), text: mods & 8 ? up : p }; }
      else return { error: 'Not a key Sara presses: ' + parts[i] + ' (Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, or Ctrl/Shift/Alt/Meta with a letter or digit).' };
    }
    if (!main) return { error: 'Say which key.' };
    var chord = (mods & (2 | 1 | 4)) !== 0;
    // Phase 90: no typing into a password field key by key either (Enter still submits it).
    if (main.text && main.key !== 'Enter' && !chord && isSecretField(document.activeElement)) return { error: 'That is a password field: Sara never types into those.' };
    var down = { type: main.text && !chord ? 'keyDown' : 'rawKeyDown', key: main.key, code: main.code, windowsVirtualKeyCode: main.vk, modifiers: mods };
    if (main.text && !chord) down.text = main.text;
    if (chord && (mods & (2 | 4)) && COMMANDS[main.key.toLowerCase()]) down.commands = [COMMANDS[main.key.toLowerCase()]];
    return { events: [down, { type: 'keyUp', key: main.key, code: main.code, windowsVirtualKeyCode: main.vk, modifiers: mods }], combo: combo };
  }
  /** The upload target: the file input itself (the caller hands the file to the browser for it). */
  function fileInput(a) {
    var r = resolve(a);
    if (!r.el) return null;
    var e = r.el;
    if (!(e.tagName === 'INPUT' && String(e.type).toLowerCase() === 'file')) e = (e.control && e.control.type === 'file' ? e.control : null) || (e.querySelector && e.querySelector('input[type=file]')) || (e.closest && e.closest('label') && e.closest('label').querySelector('input[type=file]'));
    return e && e.tagName === 'INPUT' && String(e.type).toLowerCase() === 'file' && !e.disabled ? e : null;
  }
  /** Her visible cursor and highlight in the Sara browser, so the person watching sees where she acts. */
  function mark(a) {
    var old = document.getElementById('sara-agent-mark');
    if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'sara-agent-mark';
    m.setAttribute('aria-hidden', 'true');
    var bx = a.box && a.box.w > 0 ? a.box : { x: Number(a.x) - 14, y: Number(a.y) - 14, w: 28, h: 28 };
    var st = m.style;
    st.position = 'fixed'; st.left = bx.x - 3 + 'px'; st.top = bx.y - 3 + 'px'; st.width = bx.w + 6 + 'px'; st.height = bx.h + 6 + 'px';
    st.border = '3px solid #ff3d8b'; st.borderRadius = '8px'; st.boxShadow = '0 0 0 4px rgba(255,61,139,.25)'; st.pointerEvents = 'none'; st.zIndex = '2147483647'; st.boxSizing = 'border-box'; st.transition = 'opacity .4s';
    var dot = document.createElement('div');
    var ds = dot.style;
    ds.position = 'absolute'; ds.left = Number(a.x) - bx.x + 3 - 7 + 'px'; ds.top = Number(a.y) - bx.y + 3 - 7 + 'px'; ds.width = '14px'; ds.height = '14px'; ds.borderRadius = '50%'; ds.background = '#ff3d8b'; ds.border = '2px solid #fff';
    var tag = document.createElement('div');
    tag.textContent = String(a.label || 'Sara').slice(0, 40);
    var ts = tag.style;
    ts.position = 'absolute'; ts.left = '0'; ts.top = '-22px'; ts.font = '600 12px system-ui, sans-serif'; ts.color = '#fff'; ts.background = '#ff3d8b'; ts.padding = '1px 6px'; ts.borderRadius = '6px'; ts.whiteSpace = 'nowrap';
    m.appendChild(dot);
    m.appendChild(tag);
    (document.body || document.documentElement).appendChild(m);
    setTimeout(function () { st.opacity = '0'; }, 1600);
    setTimeout(function () { if (m.parentNode) m.parentNode.removeChild(m); }, 2100);
    return { shown: true };
  }
  /** What the page is like now (the after-state of an action). */
  function state() {
    var alerts = Array.prototype.slice.call(document.querySelectorAll('[role=alert], [role=status], .error, .alert')).filter(vis).map(function (e) { return mask(String(e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160)); }).filter(Boolean).slice(0, 4);
    var h = document.querySelector('h1');
    return { url: location.href, title: mask(document.title), count: elements().length, heading: h ? mask(String(h.innerText || '').trim().slice(0, 120)) : '', alerts: alerts, focus: document.activeElement && document.activeElement !== document.body ? mask(desc(document.activeElement)) : '' };
  }

  // ---- Phase 90 (CU4, §8.2): saved logins. The device fills a saved login itself: these functions only
  // find the sign-in fields and focus them (the caller types through DevTools input, on this computer).
  // They never return a field's value. The one exception is catchLogins: it hands what the person just
  // typed into a sign-in form to the device's own binding (saraLoginCaught, in an isolated world of its
  // own), so the device can offer "Use what I just typed" in its save window. That never leaves the
  // computer: the binding is DevTools on the pipe, not the hands channel. ----
  function loginPassField(root) {
    var list = Array.prototype.slice.call((root || document).querySelectorAll('input[type=password]')).filter(function (e) { return vis(e) && !e.disabled && !e.readOnly; });
    return list.find(function (e) { return String(e.getAttribute('autocomplete') || '').toLowerCase().indexOf('current-password') >= 0; }) || list.find(function (e) { return String(e.getAttribute('autocomplete') || '').toLowerCase().indexOf('new-password') < 0; }) || list[0] || null;
  }
  function loginUserField(pass) {
    var scope = (pass && (pass.form || (pass.closest && pass.closest('form')))) || document;
    var cands = Array.prototype.slice.call(scope.querySelectorAll('input')).filter(function (e) {
      var ty = String(e.type || 'text').toLowerCase();
      return vis(e) && !e.disabled && !e.readOnly && (ty === 'text' || ty === 'email' || ty === 'tel' || ty === '');
    });
    var by = function (re) { return cands.find(function (e) { return re.test(String(e.getAttribute('autocomplete') || '').toLowerCase()); }); };
    var named = cands.find(function (e) { return /user|email|login|account|identifier/.test((String(e.name || '') + ' ' + String(e.id || '')).toLowerCase()); });
    var before = null;
    if (pass) for (var i = 0; i < cands.length; i++) if (cands[i].compareDocumentPosition(pass) & 4) before = cands[i];
    return by(/username/) || by(/email/) || cands.find(function (e) { return String(e.type).toLowerCase() === 'email'; }) || named || before || null;
  }
  function spot(e) {
    if (!e) return null;
    e.scrollIntoView({ block: 'center', inline: 'center' });
    var b = e.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), box: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }, desc: mask(desc(e)) };
  }
  /** Where the sign-in fields of this page are (never their values), and the page's own origin. */
  function loginFields() {
    var pass = loginPassField();
    var user = loginUserField(pass);
    return { origin: location.origin, pass: spot(pass), user: spot(user) };
  }
  /** Focuses one of the sign-in fields (after the caller's real click) and selects what is there. */
  function focusLogin(a) {
    var pass = loginPassField();
    var e = a.which === 'pass' ? pass : loginUserField(pass);
    if (!e) return { focused: false, origin: location.origin };
    if (document.activeElement !== e) e.focus();
    if (e.select) e.select();
    return { focused: document.activeElement === e, origin: location.origin, secret: isSecretField(e) };
  }
  /** Installed by the device in its own isolated world on every page: remembers a sign-in the person typed. */
  function catchLogins() {
    if (window.__saraCatching) return { installed: true };
    window.__saraCatching = true;
    var send = function (form) {
      if (typeof window.saraLoginCaught !== 'function') return;
      var pass = loginPassField(form || document);
      if (!pass || !pass.value) return;
      var user = loginUserField(pass);
      try { window.saraLoginCaught(JSON.stringify({ origin: location.origin, username: user ? String(user.value || '') : '', password: String(pass.value) })); } catch (err) { /* the device isn't listening */ }
    };
    document.addEventListener('submit', function (ev) { send(ev.target); }, true);
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && isSecretField(ev.target)) send(ev.target.form); }, true);
    document.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('button, input[type=submit], [role=button]') : null;
      if (b && loginPassField(b.form || document)) send(b.form);
    }, true);
    return { installed: true };
  }

  // Linux browser-only takeover: installed in a device-owned isolated world. The device
  // matches its own CDP events by session/type/coordinates; no page script gets the binding.
  function watchOwner() {
    if (window.__saraOwnerWatching) return { installed: true };
    window.__saraOwnerWatching = true;
    ['pointerdown', 'pointermove', 'keydown', 'wheel'].forEach(function (type) {
      document.addEventListener(type, function (ev) {
        if (!ev.isTrusted || typeof window.saraOwnerInput !== 'function') return;
        if (type === 'pointermove' && !ev.movementX && !ev.movementY) return;
        window.saraOwnerInput(JSON.stringify({ type: type, x: ev.clientX || 0, y: ev.clientY || 0, key: ev.key || '' }));
      }, true);
    });
    return { installed: true };
  }
  function privacy() {
    var boxes = [];
    function add(r) { if (r.width > 0 && r.height > 0) boxes.push({ x: r.left, y: r.top, w: r.width, h: r.height }); }
    var fields = document.querySelectorAll('input, textarea, [contenteditable=true], iframe');
    if (fields.length > 20000) return { complete: false };
    for (var i = 0; i < fields.length; i++) {
      var value = String(fields[i].value || fields[i].textContent || '');
      if (fields[i].tagName === 'IFRAME' || isSecretField(fields[i]) || mask(value) !== value) add(fields[i].getBoundingClientRect());
    }
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    var node, count = 0;
    while ((node = walker.nextNode())) {
      if (++count > 20000) return { complete: false };
      if (mask(node.data) !== node.data && node.parentElement && !/^(SCRIPT|STYLE)$/.test(node.parentElement.tagName)) {
        var range = document.createRange(); range.selectNodeContents(node);
        Array.from(range.getClientRects()).forEach(add);
      }
    }
    return { complete: true, boxes: boxes, width: innerWidth, height: innerHeight, url: location.href };
  }
  // Pixel redaction happens in a detached canvas in the device's isolated world, after capture.
  // A page cannot remove a DOM overlay to recover pixels that leave the device.
  function redactPicture(a) {
    return new Promise(function (resolve, reject) {
      if (!a.data || a.data.length > 16000000 || a.w * a.h > 16000000) return reject(new Error('Picture too large'));
      var image = new Image();
      image.onerror = function () { reject(new Error('Picture could not be decoded locally')); };
      image.onload = function () {
        try {
          var canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          if (canvas.width !== a.w || canvas.height !== a.h) return reject(new Error('Picture size changed'));
          var context = canvas.getContext('2d'); context.drawImage(image, 0, 0); context.fillStyle = '#000';
          a.boxes.forEach(function (r) {
            context.fillRect(Math.floor(r.x * a.scale) - 3, Math.floor(r.y * a.scale) - 3, Math.ceil(r.w * a.scale) + 6, Math.ceil(r.h * a.scale) + 6);
          });
          resolve({ data: canvas.toDataURL('image/jpeg', Math.max(0.1, Math.min(0.9, a.quality / 100))).split(',')[1] });
        } catch (err) { reject(err); }
      };
      image.src = 'data:image/jpeg;base64,' + a.data;
    });
  }

  var API = { find: find, read: read, check: check, snapshot: snapshot, text: text, target: target, focusFor: focusFor, choose: choose, scroll: scroll, keys: keys, fileInput: fileInput, mark: mark, state: state, loginFields: loginFields, focusLogin: focusLogin, catchLogins: catchLogins, watchOwner: watchOwner, privacy: privacy, redactPicture: redactPicture };
  return {
    version: 1,
    call: function (fn, args) {
      if (!Object.prototype.hasOwnProperty.call(API, fn)) return { error: 'unknown page-agent function' };
      return API[fn](args || {});
    },
  };
})()
