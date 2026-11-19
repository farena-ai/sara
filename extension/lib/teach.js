// D1 (docs/design/D1TEACH.md): "Watch me do this". The recorder and the replayer, run in the page itself
// after you clicked Watch me do this (or Replay here) in the popup. Plain script (no import/export) so
// it can be injected as a file next to lib/fields.js; tests read globalThis.SaraTeach.
// Hard limits: a field SaraFields calls never (password, payment card, one-time code, SSN) gives a
// "you type this yourself" step and its value is never read; hidden and file inputs are ignored; no
// page HTML is kept, only a short description of what you clicked or typed into.
(() => {
  const MAX_STEPS = 60;
  const MAX_VALUE = 200;
  const CLICKABLE = new Set(['A', 'BUTTON', 'SUMMARY', 'LABEL', 'OPTION']);
  const CLICK_INPUTS = new Set(['submit', 'button', 'reset', 'image', 'checkbox', 'radio']);
  const IGNORE_INPUTS = new Set(['hidden', 'file']);
  const LONG_DIGITS = /\d[\d ./-]{10,}\d/;

  const tag = (n) => String((n && n.tagName) || '').toUpperCase();
  const attr = (n, a) => (n && typeof n.getAttribute === 'function' ? n.getAttribute(a) : null) || '';
  const clean = (s, max = 80) => String(s || '').replace(/[\s\u00a0]+/g, ' ').trim().slice(0, max);
  const F = () => globalThis.SaraFields;

  function textOf(n) {
    if (!n) return '';
    if (n.nodeType === 3) return String(n.nodeValue || '');
    if (n.nodeType !== 1 || ['SCRIPT', 'STYLE', 'INPUT', 'SELECT', 'TEXTAREA'].includes(tag(n))) return '';
    return Array.from(n.childNodes || []).map(textOf).join('');
  }

  function walk(n, fn) {
    if (!n || n.nodeType !== 1) return;
    fn(n);
    for (const c of Array.from(n.childNodes || [])) walk(c, fn);
  }

  function labelsOf(doc) {
    const labels = new Map();
    walk(doc.body || doc.documentElement, (n) => {
      if (tag(n) === 'LABEL' && attr(n, 'for')) labels.set(attr(n, 'for'), textOf(n));
    });
    return labels;
  }

  const inputType = (el) => (tag(el) === 'INPUT' ? String(el.type || attr(el, 'type') || 'text').toLowerCase() : tag(el).toLowerCase());
  const isField = (el) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag(el));

  /** A short CSS path (tag:nth-of-type from the nearest id), only as a fallback hint. */
  function pathOf(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentNode) {
      const t = tag(n).toLowerCase();
      if (t === 'body' || t === 'html') break;
      const id = attr(n, 'id');
      if (id && /^[A-Za-z][\w-]{0,40}$/.test(id)) {
        parts.unshift(`#${id}`);
        break;
      }
      const sibs = n.parentNode ? Array.from(n.parentNode.childNodes || []).filter((s) => s.nodeType === 1 && tag(s) === tag(n)) : [];
      parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(n) + 1})` : t);
    }
    return parts.join(' > ').slice(0, 160);
  }

  /** What you clicked or typed into, in words (never its value). */
  function describeTarget(el, labels) {
    const t = tag(el).toLowerCase();
    const out = { tag: t };
    const type = isField(el) ? inputType(el) : '';
    if (type && type !== t) out.type = type;
    const role = clean(attr(el, 'role'), 30);
    if (role) out.role = role;
    const id = clean(attr(el, 'id'), 60);
    if (id) out.id = id;
    const name = clean(attr(el, 'name'), 60);
    if (name) out.name = name;
    if (isField(el) && !CLICK_INPUTS.has(type)) {
      const d = F() ? F().describe(el, labels) : { label: clean(attr(el, 'aria-label') || attr(el, 'placeholder')) };
      if (d.label) out.label = clean(d.label);
    } else {
      const words = clean(attr(el, 'aria-label')) || clean(textOf(el)) || (CLICK_INPUTS.has(type) ? clean(attr(el, 'value')) : '') || clean(attr(el, 'title'));
      if (words) out.text = words;
      // A checkbox or radio: its label says what it is.
      if ((type === 'checkbox' || type === 'radio') && F()) {
        const d = F().describe(el, labels);
        if (d.label) out.label = clean(d.label);
      }
    }
    const href = t === 'a' ? attr(el, 'href') : '';
    if (href && !/^(javascript|data):/i.test(href)) out.href = href.split(/[?#]/)[0].slice(0, 200);
    out.path = pathOf(el);
    return out;
  }

  /** never (password, card, code, SSN), skip (hidden, file, locked) or ok. Reads no value. */
  function fieldKind(el, labels) {
    const type = inputType(el);
    if (IGNORE_INPUTS.has(type)) return 'skip';
    if (!F()) return type === 'password' ? 'never' : 'ok';
    const d = F().describe(el, labels);
    if (type === 'password' || F().classify(d) === 'never') return 'never';
    return d.disabled || d.readOnly ? 'skip' : 'ok';
  }

  /** The step a click makes (or null): buttons, links, checkboxes; not text fields. */
  function clickStep(target, labels) {
    let el = target;
    for (let i = 0; el && el.nodeType === 1 && i < 6; i++, el = el.parentNode) {
      const t = tag(el);
      if (t === 'BODY' || t === 'HTML') return null;
      if (CLICKABLE.has(t) || attr(el, 'role') === 'button' || attr(el, 'role') === 'link' || attr(el, 'role') === 'menuitem' || attr(el, 'role') === 'tab' || attr(el, 'onclick')) break;
      if (t === 'INPUT') break;
      if (t === 'SELECT' || t === 'TEXTAREA') return null;
    }
    if (!el || el.nodeType !== 1 || tag(el) === 'BODY') return null;
    if (tag(el) === 'INPUT') {
      const type = inputType(el);
      if (!CLICK_INPUTS.has(type)) return null;
      if (fieldKind(el, labels) === 'never') return null;
    }
    // A label wrapping or pointing at a text field: the typing step says it all.
    if (tag(el) === 'LABEL') {
      const forId = attr(el, 'for');
      let field = null;
      walk(el, (n) => {
        if (!field && isField(n)) field = n;
      });
      if (field || forId) return null;
    }
    return { kind: 'click', target: describeTarget(el, labels) };
  }

  /** The step a change makes (typed text, a pick), or null. A never field gives a secret step without reading it. */
  function changeStep(el, labels) {
    if (!isField(el)) return null;
    const type = inputType(el);
    if (CLICK_INPUTS.has(type)) return null;
    const kind = fieldKind(el, labels);
    if (kind === 'skip') return null;
    const target = describeTarget(el, labels);
    if (kind === 'never') return { kind: 'type', target, secret: true };
    if (tag(el) === 'SELECT') {
      const opts = Array.from(el.options || []);
      const o = opts.find((x) => x.selected) || opts.find((x) => String(x.value) === String(el.value));
      return { kind: 'pick', target, value: clean(o ? o.text : el.value, MAX_VALUE) };
    }
    const value = String(el.value ?? '').slice(0, MAX_VALUE);
    if (LONG_DIGITS.test(value)) return { kind: 'type', target, secret: true };
    return { kind: 'type', target, value };
  }

  /** Where a page load starts: the address without the query or hash (they can hold sign-in tokens). */
  function goStep(loc) {
    try {
      const u = new URL(String(loc && loc.href ? loc.href : loc));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      return { kind: 'go', url: `${u.origin}${u.pathname}`.slice(0, 300) };
    } catch {
      return null;
    }
  }

  const sameTarget = (a, b) => a && b && a.path === b.path && a.id === b.id && a.name === b.name;

  /** Adds a step to a list: typing into the same field again keeps the last value; capped. */
  function addStep(steps, step) {
    if (!step) return steps;
    const last = steps[steps.length - 1];
    if (step.kind === 'go' && last && last.kind === 'go' && last.url === step.url) return steps;
    if ((step.kind === 'type' || step.kind === 'pick') && last && last.kind === step.kind && sameTarget(last.target, step.target)) {
      steps[steps.length - 1] = step;
      return steps;
    }
    if (steps.length < MAX_STEPS) steps.push(step);
    return steps;
  }

  /** Starts recording this page: emit(step) for each step, first the page itself. Once per page. */
  function start(doc, emit, loc) {
    if (globalThis.__saraTeach) return false;
    const labels = () => labelsOf(doc);
    const onClick = (e) => {
      const s = clickStep(e.target, labels());
      if (s) emit(s);
    };
    const onChange = (e) => {
      const s = changeStep(e.target, labels());
      if (s) emit(s);
    };
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('change', onChange, true);
    globalThis.__saraTeach = { stop: () => (doc.removeEventListener('click', onClick, true), doc.removeEventListener('change', onChange, true)) };
    const g = goStep(loc || globalThis.location);
    if (g) emit(g);
    return true;
  }

  function stop() {
    const r = globalThis.__saraTeach;
    if (!r) return false;
    r.stop();
    delete globalThis.__saraTeach;
    return true;
  }

  // ------------------------------------------------------------------ replay
  /** The element on this page that best fits a recorded target (or null): id, name, label, text, path. */
  function findTarget(doc, target) {
    if (!target) return null;
    const labels = labelsOf(doc);
    let best = null;
    let bestScore = 0;
    walk(doc.body || doc.documentElement, (n) => {
      if (tag(n).toLowerCase() !== target.tag) return;
      const d = describeTarget(n, labels);
      let score = 0;
      if (target.id && d.id === target.id) score += 10;
      if (target.name && d.name === target.name) score += 6;
      if (target.label && d.label && d.label.toLowerCase() === target.label.toLowerCase()) score += 5;
      if (target.text && d.text && d.text.toLowerCase() === target.text.toLowerCase()) score += 5;
      if (target.href && d.href === target.href) score += 4;
      if (target.path && d.path === target.path) score += 3;
      if (target.type && d.type !== target.type) score -= 4;
      if (score > bestScore) {
        best = n;
        bestScore = score;
      }
    });
    return bestScore >= 5 ? best : null;
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

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Runs recorded steps on this page, in order: clicks, typing, picks. A secret step is left for you
   * (listed in needsYou) and never typed; a step whose target is gone is listed in missing and the run
   * stops there. values: optional {index: text} replacing what was typed.
   */
  async function replay(doc, steps, o = {}) {
    const done = [];
    const needsYou = [];
    const missing = [];
    const labels = labelsOf(doc);
    for (let i = 0; i < (steps || []).length; i++) {
      const s = steps[i];
      if (!s || s.kind === 'go') continue;
      // The pause comes before a step (not after), so a last click that opens another page ends the run.
      if (done.length && o.delay !== 0) await wait(o.delay ?? 350);
      if (s.secret) {
        needsYou.push((s.target && (s.target.label || s.target.name)) || '?');
        continue;
      }
      const el = findTarget(doc, s.target);
      if (!el) {
        missing.push(i);
        break;
      }
      if (s.kind === 'click') {
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
        if (typeof el.click === 'function') el.click();
        else el.dispatchEvent({ type: 'click' });
      } else if (s.kind === 'type') {
        if (fieldKind(el, labels) !== 'ok') {
          needsYou.push(s.target.label || s.target.name || '?');
          continue;
        }
        const v = o.values && typeof o.values[i] === 'string' ? o.values[i] : String(s.value ?? '');
        setValue(el, v.slice(0, MAX_VALUE));
      } else if (s.kind === 'pick') {
        const want = String(s.value ?? '').toLowerCase().trim();
        const opt = Array.from(el.options || []).find((x) => String(x.text).toLowerCase().trim() === want || String(x.value).toLowerCase() === want);
        if (!opt) {
          missing.push(i);
          break;
        }
        setValue(el, opt.value);
      }
      done.push(i);
    }
    return { done, needsYou, missing };
  }

  globalThis.SaraTeach = { MAX_STEPS, MAX_VALUE, describeTarget, clickStep, changeStep, goStep, addStep, start, stop, findTarget, replay, labelsOf };
})();
