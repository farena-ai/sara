// V4.4 (docs/MEETINGS.md "Captions"): Library → Meetings → a meeting → Captions. Big captions that
// follow a room (or an upload being heard) live, with an optional translated line under each one.
// Polls GET /api/meetings/:id/captions every 1.2 s while the meeting is live or being heard, and while
// translations are still coming; follows the newest line unless you scrolled up (then "Jump to the
// latest"). The language picked here is the same setting as Settings → Voice → Meetings.
// Translation is local first (src/meeting-captions.ts); the line under a caption says who translated.
import { serverText, t } from './naming.js';

const POLL_MS = 1200;
const SIZE_KEY = 'sara.captionSize';
const SIZES = [18, 22, 28, 36, 46];
/** A language's name in the page's language (the browser knows them all; the English name otherwise). */
export function langLabel(code, fallback = code) {
  try {
    const name = new Intl.DisplayNames([document.documentElement.lang || navigator.language || 'en'], { type: 'language' }).of(code);
    return name ? name.charAt(0).toLocaleUpperCase() + name.slice(1) : fallback;
  } catch {
    return fallback;
  }
}

let view = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

/** Fills a language picker (the Settings one and the view's). */
export function fillLangs(select, langs, value) {
  select.replaceChildren(new Option(t('No translation'), ''), ...(langs ?? []).map((l) => new Option(langLabel(l.code, l.name), l.code)));
  select.value = value ?? '';
}

export function closeCaptions() {
  if (!view) return;
  clearTimeout(view.timer);
  if (document.fullscreenElement === view.box) void document.exitFullscreen?.().catch(() => {});
  view = null;
}

/**
 * Shows the captions of meeting `id` in `host` (the Meetings body); `onBack` returns to the meeting.
 * Returns the view's root element.
 */
export async function openCaptions(id, { host, onBack } = {}) {
  closeCaptions();
  const box = el('div', 'cap-view');
  box.dataset.id = String(id);
  const size = Math.min(SIZES.length - 1, Math.max(0, Number(localStorage.getItem(SIZE_KEY) ?? 1) || 0));
  box.style.setProperty('--cap-size', `${SIZES[size]}px`);
  const bar = el('div', 'cap-bar');
  const back = btn(t('← Back to the meeting'), 'ghost small', () => {
    closeCaptions();
    onBack?.();
  });
  const title = el('strong', 'cap-title');
  const state = el('span', 'cap-state small');
  state.setAttribute('role', 'status');
  const lang = document.createElement('select');
  lang.id = 'cap-lang';
  lang.setAttribute('aria-label', t('Translate into'));
  const langRow = el('label', 'cap-lang small');
  langRow.htmlFor = 'cap-lang';
  const tip = el('button', 'tip', '?');
  tip.type = 'button';
  tip.dataset.tip = t('Shows a translated line under each caption. A model on this computer translates; a cloud model only if you allow it in Settings → Voice → Meetings.');
  tip.setAttribute('aria-label', t('What is this?'));
  langRow.append(el('span', '', t('Translate into')), tip, lang);
  const smaller = btn('A−', 'ghost small cap-size', () => resize(-1));
  smaller.setAttribute('aria-label', t('Smaller text'));
  const bigger = btn('A+', 'ghost small cap-size', () => resize(1));
  bigger.setAttribute('aria-label', t('Bigger text'));
  const full = btn(t('Full screen'), 'ghost small cap-full', () => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void box.requestFullscreen?.().catch(() => {});
  });
  const tools = el('div', 'cap-tools');
  tools.append(langRow, smaller, bigger, ...(box.requestFullscreen ? [full] : []));
  bar.append(back, title, state, tools);
  const note = el('p', 'cap-note small muted');
  note.setAttribute('role', 'status');
  const lines = el('ol', 'cap-lines');
  lines.setAttribute('aria-live', 'polite');
  lines.setAttribute('aria-label', t('Captions'));
  const empty = el('p', 'cap-empty muted', t('Waiting for the first words…'));
  const jump = btn(t('Jump to the latest'), 'cap-jump small', () => follow(true));
  jump.hidden = true;
  box.append(bar, note, empty, lines, jump);
  host.replaceChildren(box);
  view = { id, box, lines, timer: 0, last: 0, pending: new Set(), lang: '', rows: new Map(), stick: true };
  const v = view;

  function resize(d) {
    const i = Math.min(SIZES.length - 1, Math.max(0, SIZES.indexOf(parseInt(box.style.getPropertyValue('--cap-size'), 10)) + d));
    box.style.setProperty('--cap-size', `${SIZES[i]}px`);
    localStorage.setItem(SIZE_KEY, String(i));
    follow();
  }
  // Follow the newest line unless the person scrolled up to read.
  lines.addEventListener('scroll', () => {
    v.stick = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 40;
    jump.hidden = v.stick;
  });
  function follow(force = false) {
    if (force) v.stick = true;
    if (v.stick) lines.scrollTop = lines.scrollHeight;
    jump.hidden = v.stick;
  }
  lang.addEventListener('change', async () => {
    try {
      await api('/meetings/captions', { method: 'PUT', body: { lang: lang.value } });
    } catch (e) {
      note.textContent = e.message;
    }
    v.lang = lang.value;
    v.last = 0;
    v.pending.clear();
    v.rows.clear();
    lines.replaceChildren();
    void poll();
  });

  function row(l) {
    const li = el('li', `cap-line cap-${l.kind}`);
    li.dataset.n = String(l.n);
    if (l.kind !== 'notice') li.append(el('span', 'cap-who', l.speaker));
    li.append(el('span', 'cap-said', l.text));
    return li;
  }
  function translated(n, text) {
    const li = v.rows.get(n);
    if (!li) return;
    let tr = li.querySelector('.cap-tr');
    if (text === null) {
      if (!tr) li.append(el('span', 'cap-tr cap-wait', t('Translating…')));
      return;
    }
    if (!text) return tr?.remove();
    if (!tr) li.append((tr = el('span', 'cap-tr')));
    tr.classList.remove('cap-wait');
    tr.textContent = text;
    tr.lang = v.lang;
  }

  const ENGINE = {
    local: () => t('Translated on this computer.'),
    cloud: () => t('Translated by your cloud model.'),
    off: () => '',
  };
  const STATE = {
    live: () => t('Live'),
    hearing: () => t('Hearing the recording…'),
  };

  async function poll() {
    clearTimeout(v.timer);
    if (view !== v || !box.isConnected) return;
    try {
      const want = [...v.pending].slice(-200).join(',');
      // The first ask uses the saved language; later ones the one picked here.
      const rest = `${v.started ? `&lang=${encodeURIComponent(v.lang)}` : ''}${want ? `&want=${want}` : ''}`;
      const { captions: c } = await api(`/meetings/${id}/captions?since=${v.last}${rest}`);
      if (view !== v) return;
      if (!v.started) {
        v.started = true;
        v.lang = c.lang;
        const info = await api('/meetings').catch(() => ({}));
        fillLangs(lang, info.captions?.langs ?? [], c.lang);
      }
      title.textContent = c.title;
      state.textContent = STATE[c.status]?.() ?? t('Transcript');
      state.classList.toggle('cap-live', c.status === 'live');
      for (const l of c.lines) {
        if (v.rows.has(l.n)) continue;
        const li = row(l);
        v.rows.set(l.n, li);
        lines.append(li);
      }
      v.last = Math.max(v.last, c.last);
      empty.hidden = v.rows.size > 0;
      for (const [n, text] of Object.entries(c.tr)) {
        v.pending.delete(Number(n));
        translated(Number(n), text);
      }
      for (const n of c.pending) {
        v.pending.add(n);
        translated(n, null);
      }
      note.textContent = c.engine === 'none' ? serverText({ error: c.why }, c.why ?? '') : ENGINE[c.engine]?.() ?? '';
      note.classList.toggle('error', c.engine === 'none');
      follow();
      const more = c.status === 'live' || c.status === 'hearing' || v.pending.size > 0;
      if (more) v.timer = setTimeout(() => void poll(), POLL_MS);
    } catch (e) {
      note.textContent = e.message;
      v.timer = setTimeout(() => void poll(), POLL_MS * 3);
    }
  }
  await poll();
  return box;
}
