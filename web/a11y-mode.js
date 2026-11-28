// V5.5 Accessibility switch (docs/design/V5_ACCESS.md): Settings → You → Appearance → Accessibility.
// One switch for easier reading, still motion and a large layout (plus line focus on its own), kept per
// device in localStorage. web/theme-boot.js applies the same keys before the first paint (a test keeps the
// two equal), so a reload never flashes the plain look.

/** The keys this device keeps. */
export const KEYS = { on: 'sara.a11y', read: 'sara.read', lineFocus: 'sara.lineFocus', reduceMotion: 'sara.reduceMotion', large: 'sara.large' };
/** What the switch turns on (line focus follows the pointer, so it stays a choice of its own). */
const PARTS = { [KEYS.read]: 'easy', [KEYS.reduceMotion]: 'on', [KEYS.large]: 'on' };
const TEXT = 'sara.textSize';
const PREV = 'sara.a11yPrev';
const LARGE_TEXT = 17;

/** The stored choices; anything unknown is off. `get(key)` returns a string or null. */
export function a11yState(get) {
  return {
    on: get(KEYS.on) === 'on',
    read: get(KEYS.read) === 'easy' ? 'easy' : 'normal',
    lineFocus: get(KEYS.lineFocus) === 'on',
    reduceMotion: get(KEYS.reduceMotion) === 'on',
    large: get(KEYS.large) === 'on',
  };
}

/** Puts a state on <html> (the same attributes theme-boot sets); `motion` = the stored Background motion. */
export function applyA11y(root, s, motion) {
  const set = (k, on, v = 'on') => {
    if (on) root.dataset[k] = v;
    else delete root.dataset[k];
  };
  set('read', s.read === 'easy', 'easy');
  set('large', s.large);
  set('lineFocus', s.lineFocus);
  root.classList.toggle('reduce-motion', s.reduceMotion);
  if (s.reduceMotion) root.dataset.motion = 'off';
  else if (motion !== undefined) root.dataset.motion = motion === 'off' ? 'off' : 'on';
}

/**
 * The switch: what to store and remove. On writes the parts (text at least Large) and remembers what they
 * were; off puts those back (or turns the parts off when nothing was remembered).
 */
export function switchAll(on, get) {
  const set = {}, remove = [];
  if (on) {
    const prev = {};
    for (const k of [...Object.keys(PARTS), TEXT]) prev[k] = get(k);
    Object.assign(set, { [KEYS.on]: 'on', ...PARTS });
    set[TEXT] = String(Math.max(Number(get(TEXT) ?? 15) || 15, LARGE_TEXT));
    set[PREV] = JSON.stringify(prev);
    return { set, remove };
  }
  set[KEYS.on] = 'off';
  let prev = null;
  try {
    prev = JSON.parse(get(PREV) ?? 'null');
  } catch {
    prev = null;
  }
  for (const k of [...Object.keys(PARTS), TEXT]) {
    const v = prev && typeof prev === 'object' ? prev[k] : null;
    if (typeof v === 'string') set[k] = v;
    // Text size: only forgotten when the switch remembered it was never picked (the default).
    else if (k !== TEXT || (prev && typeof prev === 'object' && k in prev)) remove.push(k);
  }
  remove.push(PREV);
  return { set, remove };
}

/** A synced state (src/appearance.ts `access`) as the keys to store. */
export function accessKeys(a) {
  return { [KEYS.on]: a.on ? 'on' : 'off', [KEYS.read]: a.read === 'easy' ? 'easy' : 'normal', [KEYS.lineFocus]: a.lineFocus ? 'on' : 'off', [KEYS.reduceMotion]: a.reduceMotion ? 'on' : 'off', [KEYS.large]: a.large ? 'on' : 'off' };
}

// ---------- the page side ----------

const doc = globalThis.document;
const ls = () => globalThis.localStorage;
// T62: Text size in chat is kept per companion (web/companion-keys.js); the other keys pass through.
const keys = () => (ls() ? globalThis.saraKeys : null);
const get = (k) => {
  try {
    return (keys() ? keys().get(k) : ls()?.getItem(k)) ?? null;
  } catch {
    return null;
  }
};
const store = ({ set, remove }) => {
  const s = keys();
  for (const [k, v] of Object.entries(set)) {
    if (s) s.set(k, v);
    else ls()?.setItem(k, v);
  }
  for (const k of remove) {
    if (s) s.del(k);
    else ls()?.removeItem(k);
  }
};

/** The reading band for line focus: follows the pointer, a tap or the keyboard focus. */
let band = null;
function topHost() {
  const open = [...doc.querySelectorAll('dialog[open]')].filter((d) => d.matches(':modal'));
  return open.at(-1) ?? doc.body;
}
function placeBand(y) {
  if (!band) return;
  const host = topHost();
  if (band.parentElement !== host) host.append(band);
  band.style.setProperty('--a11y-y', `${Math.round(y)}px`);
  band.hidden = false;
}
function lineFocus(on) {
  if (!doc?.body) return;
  if (!on) {
    band?.remove();
    band = null;
    return;
  }
  if (band) return;
  band = doc.createElement('div');
  band.id = 'a11y-line';
  band.setAttribute('aria-hidden', 'true');
  band.hidden = true;
  doc.body.append(band);
}
function wireBand() {
  doc.addEventListener('pointermove', (e) => band && placeBand(e.clientY), { passive: true });
  doc.addEventListener('pointerdown', (e) => band && placeBand(e.clientY), { passive: true });
  doc.addEventListener('focusin', (e) => {
    if (!band || !(e.target instanceof Element)) return;
    const r = e.target.getBoundingClientRect();
    if (r.height) placeBand(r.top + Math.min(r.height, 40) / 2);
  });
}

/**
 * Screen readers announce a dialog by its name: a dialog with no aria-label(ledby) is named after its
 * first heading (an id is given when it has none). Runs on every dialog in `root`.
 */
export function nameDialogs(root) {
  let n = 0;
  for (const d of root.querySelectorAll('dialog')) {
    if (d.hasAttribute('aria-label') || d.hasAttribute('aria-labelledby')) continue;
    const h = d.querySelector('h1, h2, h3');
    if (!h) continue;
    if (!h.id) h.id = `${d.id || 'dlg'}-name`;
    d.setAttribute('aria-labelledby', h.id);
    n++;
  }
  return n;
}

/** Applies what this device keeps and fills the controls. */
export function refreshA11y() {
  if (!doc) return;
  const s = a11yState(get);
  applyA11y(doc.documentElement, s, get('sara.motion'));
  lineFocus(s.lineFocus);
  const $ = (id) => doc.getElementById(id);
  if ($('ap-a11y')) $('ap-a11y').checked = s.on;
  if ($('ap-read')) $('ap-read').value = s.read;
  if ($('ap-linefocus')) $('ap-linefocus').value = s.lineFocus ? 'on' : 'off';
  if ($('ap-reduce')) $('ap-reduce').value = s.reduceMotion ? 'on' : 'system';
  if ($('ap-large')) $('ap-large').value = s.large ? 'on' : 'off';
  return s;
}

/** Wires the Accessibility controls. `after()` lets app.js redraw what reads the same keys (text size). */
export function initA11y({ after = () => {} } = {}) {
  if (!doc) return;
  nameDialogs(doc);
  wireBand();
  const $ = (id) => doc.getElementById(id);
  const changed = () => {
    refreshA11y();
    after();
  };
  $('ap-a11y')?.addEventListener('change', () => {
    store(switchAll($('ap-a11y').checked, get));
    changed();
  });
  const one = (id, key, onValue) =>
    $(id)?.addEventListener('change', () => {
      const on = $(id).value === onValue;
      ls()?.setItem(key, on ? onValue : id === 'ap-read' ? 'normal' : 'off');
      changed();
    });
  one('ap-read', KEYS.read, 'easy');
  one('ap-linefocus', KEYS.lineFocus, 'on');
  one('ap-reduce', KEYS.reduceMotion, 'on');
  one('ap-large', KEYS.large, 'on');
  // Background motion picked On while Reduce motion is on: everything stays still.
  $('ap-motion')?.addEventListener('change', () => setTimeout(refreshA11y, 0));
  refreshA11y();
}

/** "Use on all my devices": the choices to send, and a device that never chose starts from them. */
export function currentAccess() {
  const s = a11yState(get);
  return { on: s.on, read: s.read, lineFocus: s.lineFocus, reduceMotion: s.reduceMotion, large: s.large };
}
export function adoptAccess(a) {
  if (!a || typeof a !== 'object' || get(KEYS.on) !== null) return;
  store({ set: accessKeys(a), remove: [] });
  refreshA11y();
}
