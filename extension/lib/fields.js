// U4.25 (docs/EXTENSION.md): the form fields of a page, read and filled in the page itself. Hard
// limit, checked here AND on Sara's server: password, payment card, one-time / 2FA code and SSN fields
// are never filled (they go to Sara as a label only, never with a value), whatever Sara answers.
// Fields are filled only after the person approves them in the popup's card, and the form is never
// sent. Plain script (no import/export) so it can be injected as a file; tests read globalThis.SaraFields.
(() => {
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio', 'range', 'color']);
  const NEVER_AUTO = /^(cc-|one-time-code$|current-password$|new-password$)/;
  const NEVER_WORDS = /password|passcode|passwd|kennwort|contrase|mot de passe|passwort|senha|\bpin\b|card ?number|cardnumber|credit ?card|debit ?card|\bcc[-_ ]?(num|number|exp|csc|cvv|name)|\bcvv|\bcvc|\bcsc\b|security code|expir|name on card|cardholder|one[- ]?time|verification code|\botp\b|2fa|two[- ]?factor|auth(entication)? code|social security|\bssn\b/i;

  const tag = (n) => String(n.tagName || '').toUpperCase();
  const attr = (n, a) => (typeof n.getAttribute === 'function' ? n.getAttribute(a) : null) || '';
  const clean = (s) => String(s || '').replace(/[\s\u00a0]+/g, ' ').trim().slice(0, 80);

  function textOf(n) {
    if (n.nodeType === 3) return String(n.nodeValue || '');
    if (n.nodeType !== 1 || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SCRIPT', 'STYLE'].includes(tag(n))) return '';
    return Array.from(n.childNodes || []).map(textOf).join('');
  }

  function walk(n, fn) {
    if (n.nodeType !== 1) return;
    fn(n);
    for (const c of n.childNodes || []) walk(c, fn);
  }

  /** What a field is (no value, ever). `labels` maps an id to its <label for> text. */
  function describe(el, labels) {
    let label = clean(attr(el, 'aria-label'));
    if (!label && labels && attr(el, 'id')) label = clean(labels.get(attr(el, 'id')));
    if (!label) {
      for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) {
        if (tag(p) === 'LABEL') {
          label = clean(textOf(p));
          break;
        }
      }
    }
    const placeholder = clean(attr(el, 'placeholder'));
    const name = clean(attr(el, 'name'));
    const id = clean(attr(el, 'id'));
    const type = tag(el) === 'INPUT' ? String(el.type || attr(el, 'type') || 'text').toLowerCase() : tag(el).toLowerCase();
    return { label: label || placeholder || name || id, name, id, placeholder, autocomplete: clean(attr(el, 'autocomplete')).toLowerCase(), type, disabled: Boolean(el.disabled), readOnly: Boolean(el.readOnly) };
  }

  /** 'never' (password, card, code, SSN), 'skip' (not a text field, or locked) or 'ok'. */
  function classify(d) {
    const auto = String(d.autocomplete || '').split(/\s+/).pop() || '';
    if (d.type === 'password' || NEVER_AUTO.test(auto)) return 'never';
    if (NEVER_WORDS.test([d.label, d.name, d.id, d.placeholder].join(' | '))) return 'never';
    if (SKIP_TYPES.has(d.type) || d.disabled || d.readOnly) return 'skip';
    return 'ok';
  }

  /** Every field worth asking about, in page order: refs f0, f1… (elements[i] is ref f<i>). */
  function collect(doc) {
    const root = doc.body || doc.documentElement;
    const labels = new Map();
    const controls = [];
    walk(root, (n) => {
      const t = tag(n);
      if (t === 'LABEL' && attr(n, 'for')) labels.set(attr(n, 'for'), textOf(n));
      if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') controls.push(n);
    });
    const fields = [];
    const elements = [];
    for (const el of controls) {
      const d = describe(el, labels);
      const kind = classify(d);
      if (kind === 'skip') continue;
      const ref = `f${elements.length}`;
      elements.push(el);
      if (kind === 'never') fields.push({ ref, label: d.label, type: d.type, never: true });
      else fields.push({ ref, label: d.label, name: d.name, id: d.id, placeholder: d.placeholder, autocomplete: d.autocomplete, type: d.type });
      if (elements.length >= 200) break;
    }
    return { fields, elements };
  }

  function setValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, value);
    else el.value = value;
    for (const type of ['input', 'change']) {
      const ev = typeof Event === 'function' ? new Event(type, { bubbles: true }) : { type };
      el.dispatchEvent(ev);
    }
  }

  function pickOption(el, value) {
    const want = String(value).toLowerCase().trim();
    const opts = Array.from(el.options || []);
    const hit = opts.find((o) => String(o.value).toLowerCase() === want || String(o.text).toLowerCase().trim() === want) || opts.find((o) => want.length > 1 && o.value && String(o.text).toLowerCase().includes(want));
    return hit ? hit.value : undefined;
  }

  /** Fills the approved values only; a never field (or one that changed into one) is refused. */
  function applyFills(elements, fills) {
    const filled = [];
    const refused = [];
    for (const f of fills || []) {
      const m = /^f(\d+)$/.exec(String(f && f.ref));
      const el = m ? elements[Number(m[1])] : undefined;
      if (!el || typeof f.value !== 'string' || classify(describe(el, null)) !== 'ok') {
        refused.push(String(f && f.ref));
        continue;
      }
      if (tag(el) === 'SELECT') {
        const v = pickOption(el, f.value);
        if (v === undefined) {
          refused.push(f.ref);
          continue;
        }
        setValue(el, v);
      } else setValue(el, f.value.slice(0, 500));
      filled.push(f.ref);
    }
    return { filled, refused };
  }

  globalThis.SaraFields = { describe, classify, collect, applyFills };
})();
