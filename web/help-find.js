// W2.5 (docs/HELP_SEARCH.md): searching the help index in the browser. The index is prebuilt by
// scripts/help-index.ts (web/help-index/<lang>.json for the app's answers, guide and tips, docs.json
// for the user docs) and fetched from this server only; nothing goes to an outside service.
// Used by the guide (/help, web/help-search.js) and the app's Help window (initHelpFind in app.js).
// Pure functions first (Node tests import this file), DOM work only inside the functions.

export const HELP_LANGS = ['en', 'es', 'fr', 'de', 'pt-BR', 'it'];
export const foldHelp = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const wordsOf = (q) => foldHelp(q).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 || /\d/.test(w));

const cache = new Map();
/** The index for one language (+ the user docs), fetched once. Unknown languages get English. */
export function loadHelpIndex(lang = 'en', fetcher = (u) => fetch(u, { cache: 'no-cache' })) {
  const l = HELP_LANGS.includes(lang) ? lang : 'en';
  if (!cache.has(l)) {
    const get = (f) =>
      fetcher(`/help-index/${f}.json`)
        .then((r) => (r.ok ? r.json() : { entries: [] }))
        .catch(() => ({ entries: [] }));
    // The docs are written in English: marked as such in the other languages.
    cache.set(l, Promise.all([get(l), get('docs')]).then(([a, d]) => prepareHelp([...a.entries, ...d.entries.map((e) => (l === 'en' ? e : { ...e, e: 1 }))])));
  }
  return cache.get(l);
}

/** Folds each entry's words once, for searching. */
export function prepareHelp(entries) {
  return entries.map((e) => ({ ...e, _t: ` ${foldHelp(`${e.t} ${e.te ?? ''}`)} `, _x: ` ${foldHelp(`${e.x} ${e.p ?? ''}`)} ` }));
}

const KIND_BONUS = { howto: 3, page: 2, guide: 1.5, tip: 1, doc: 0.5 };
/**
 * The best matches, best first: every word must be found (title or text); a word in the title counts
 * more than one in the text, a whole word more than a part, and How do I answers come before docs.
 */
export function searchHelp(prepared, query, limit = 12) {
  const ws = wordsOf(query);
  if (!ws.length) return [];
  const phrase = foldHelp(query).trim();
  const hits = [];
  for (const e of prepared) {
    let score = 0;
    let all = true;
    for (const w of ws) {
      const whole = new RegExp(`[^\\p{L}\\p{N}]${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u');
      if (e._t.includes(w)) score += whole.test(e._t) ? 6 : 3;
      else if (e._x.includes(w)) score += whole.test(e._x) ? 2 : 1;
      else {
        all = false;
        break;
      }
    }
    if (!all) continue;
    if (ws.length > 1 && e._t.includes(phrase)) score += 6;
    else if (ws.length > 1 && e._x.includes(phrase)) score += 2;
    score += KIND_BONUS[e.k] ?? 0;
    if (e.e) score -= 0.5;
    hits.push({ e, score });
  }
  hits.sort((a, b) => b.score - a.score || a.e.t.length - b.e.t.length);
  return hits.slice(0, limit).map((h) => h.e);
}

const KIND_LABEL = { howto: 'How do I…?', page: 'Setting', tip: 'Setting', guide: 'Guide', doc: 'Docs' };
const REPO_DOCS = 'https://github.com/farena-ai/sara/blob/main/';

/**
 * Draws the hits into `box`. o: { t, doc, open(entry), show(entry) | null, read(entry) | null }.
 * - open: the main action (the guide answer, the Settings page, the doc section);
 * - show: "Show me" for answers and settings that name a control (in the app);
 * - a clip (entry.c) gets a Watch button that plays it inline (from /docs/media/).
 */
export function renderHelpHits(box, hits, o = {}) {
  const t = o.t ?? ((s) => s);
  const doc = o.doc ?? document;
  const mk = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  box.replaceChildren();
  if (!hits.length) {
    if (o.query) box.append(mk('p', 'muted small hf-none', t('Nothing found. Try other words, or ask her in a chat.')));
    return;
  }
  const list = mk('ul', 'hf-list');
  for (const e of hits) {
    const li = mk('li', 'hf-hit');
    li.dataset.id = e.i;
    const head = mk('div', 'hf-head');
    head.append(mk('span', 'hf-kind', t(KIND_LABEL[e.k] ?? 'Guide')));
    if (e.e) head.append(mk('span', 'hf-en', t('In English')));
    const title = mk('button', 'hf-title linkish', e.t.length > 110 ? `${e.t.slice(0, 107)}…` : e.t);
    title.type = 'button';
    title.addEventListener('click', () => o.open?.(e));
    li.append(head, title);
    if (e.p) li.append(mk('div', 'hf-place muted small', e.p));
    const text = e.k === 'howto' ? e.x.split('\n').map((s, n) => `${n + 1}. ${s}`).join(' ') : e.x;
    li.append(mk('p', 'hf-text small', text.length > 220 ? `${text.slice(0, 217)}…` : text));
    const acts = mk('div', 'hf-acts');
    if (o.show && (e.s || /^\/#view=/.test(e.l))) {
      const b = mk('button', 'linkish small hf-show', t('Show me'));
      b.type = 'button';
      b.addEventListener('click', () => o.show(e));
      acts.append(b);
    }
    if (e.c) {
      const b = mk('button', 'linkish small hf-watch', `▶ ${t('Watch it')}`);
      b.type = 'button';
      b.addEventListener('click', () => {
        const had = li.querySelector('video');
        if (had) return void had.remove();
        const v = mk('video', 'hf-video');
        v.src = `/docs/media/${e.c}`;
        v.controls = true;
        v.muted = true;
        v.autoplay = true;
        v.playsInline = true;
        v.loop = true;
        li.append(v);
      });
      acts.append(b);
    }
    if (e.k === 'doc') {
      const a = mk('a', 'small hf-gh', `${t('Whole page')} ↗`);
      a.href = REPO_DOCS + e.l;
      a.target = '_blank';
      a.rel = 'noopener';
      acts.append(a);
    }
    if (acts.childNodes.length) li.append(acts);
    list.append(li);
  }
  box.append(list);
}

/** Splits "/#view=settings:<page>&howto=<q>&show=<id>" into its parts (null when it is not a Settings link). */
export function settingsTarget(link) {
  const m = /^\/#view=settings:([\w-]+)(?:&howto=([\w-]+))?(?:&show=([\w-]+))?$/.exec(link ?? '');
  return m ? { page: m[1], howto: m[2] ?? '', show: m[3] ?? '' } : null;
}

/**
 * The app's Help window search (#hm-q, #hm-hits). ctx: { t, lang(), openSettings, showMe, closeHelp, openView }.
 */
export function initHelpFind(ctx) {
  const doc = ctx.doc ?? document;
  const input = doc.querySelector('#hm-q');
  const box = doc.querySelector('#hm-hits');
  if (!input || !box) return;
  let timer = 0;
  const open = async (e) => {
    const set = settingsTarget(e.l);
    if (set) {
      ctx.closeHelp?.();
      await ctx.openSettings(set.page, { howto: set.howto });
      const sel = set.show ? `#${set.show}` : e.s;
      if (sel) setTimeout(() => ctx.showMe(sel), 350);
      return;
    }
    if (/^\/#view=/.test(e.l)) {
      ctx.closeHelp?.();
      location.hash = e.l.slice(1);
      return;
    }
    // The guide (and the docs, shown in the guide's reader) open in a new tab.
    const url = e.k === 'doc' ? `/help?doc=${encodeURIComponent(e.i.slice(2))}` : e.a ? `/help#${e.a}` : e.l;
    window.open(url, '_blank', 'noopener');
  };
  const run = async () => {
    const q = input.value.trim();
    if (!q) return void box.replaceChildren();
    const idx = await loadHelpIndex(ctx.lang?.() ?? 'en');
    if (input.value.trim() !== q) return;
    renderHelpHits(box, searchHelp(idx, q, 8), { t: ctx.t, doc, query: q, open, show: (e) => open(e) });
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 120);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') box.querySelector('.hf-title')?.click();
  });
}
