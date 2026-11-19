// W2.5 (docs/HELP_SEARCH.md): the search box at the top of the guide (/help). Searches the prebuilt
// local index (web/help-find.js) in the guide's language: How do I answers open in place, settings open
// the app at the control ("Show me"), doc sections open in a reader here (/help?doc=<FILE>#<section>).
import { loadHelpIndex, renderHelpHits, searchHelp } from './help-find.js';

let lang = 'en';
try {
  lang = localStorage.getItem('sara.lang') || '';
} catch {
  /* private mode */
}
if (!lang) {
  const c = String(navigator.language ?? '').toLowerCase();
  lang = c.startsWith('pt') ? 'pt-BR' : ['es', 'fr', 'de', 'it'].find((l) => c.startsWith(l)) ?? 'en';
}
let dict = {};
const t = (s) => dict[s] ?? s;
const $ = (s) => document.querySelector(s);

/** A "How do I" link into the app also pulses its control when the selector is a plain id. */
const appLink = (e) => (e.s && /^#[\w-]+$/.test(e.s) && !/&show=/.test(e.l) && e.l.includes('settings:') ? `${e.l}&show=${e.s.slice(1)}` : e.l);

function readDoc(e) {
  const box = $('#help-doc');
  if (!box || !e) return;
  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const close = mk('button', 'linkish small hd-close', t('Back to results'));
  close.type = 'button';
  close.addEventListener('click', () => {
    box.hidden = true;
    const hits = $('#help-hits');
    if (hits) hits.hidden = false;
    $('#help-q')?.focus();
  });
  const gh = mk('a', 'small', `${t('Read the whole page')} ↗`);
  gh.href = `https://github.com/farena-ai/sara/blob/main/${e.l}`;
  gh.target = '_blank';
  gh.rel = 'noopener';
  const head = mk('div', 'hf-head');
  head.append(mk('span', 'hf-kind', t('Docs')));
  if (lang !== 'en') head.append(mk('span', 'hf-en', t('In English')));
  box.replaceChildren(close, head, mk('h3', '', e.t), mk('div', 'muted small', e.p ?? ''), mk('p', 'hd-text', e.x), gh);
  box.hidden = false;
  // The reader takes the results' place; Back to results brings them back.
  const hits = $('#help-hits');
  if (hits) hits.hidden = true;
  box.scrollIntoView({ block: 'nearest' });
}

function open(e) {
  if (e.k === 'doc') return readDoc(e);
  if (e.a) {
    location.hash = e.a;
    return;
  }
  if (e.l.startsWith('/help#')) {
    location.hash = e.l.slice(6);
    return;
  }
  location.href = appLink(e);
}

/** On a phone the guide's menu comes first and is long: the search box goes above it. */
function placeBox() {
  const box = $('#help-find');
  const nav = document.querySelector('.wrap > nav');
  const lead = $('main > h1 + p.muted');
  if (!box || !nav || !lead) return;
  const mq = matchMedia('(max-width: 760px)');
  const place = () => (mq.matches ? nav.before(box) : lead.after(box));
  mq.addEventListener('change', place);
  place();
}

async function init() {
  const input = $('#help-q');
  const hits = $('#help-hits');
  if (!input || !hits) return;
  placeBox();
  if (lang !== 'en') dict = await fetch(`/i18n/${lang}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  input.placeholder = t('Search the help: a setting, a question, a word');
  input.setAttribute('aria-label', t('Search the help'));
  let timer = 0;
  const run = async () => {
    $('#help-doc').hidden = true;
    hits.hidden = false;
    const q = input.value.trim();
    if (!q) return void hits.replaceChildren();
    const idx = await loadHelpIndex(lang);
    if (input.value.trim() !== q) return;
    renderHelpHits(hits, searchHelp(idx, q, 12), { t, query: q, open, show: (e) => (location.href = appLink(e)) });
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 120);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') hits.querySelector('.hf-title')?.click();
  });
  // /help?doc=<FILE>#<section> (from the app's Help window) opens that doc section here.
  const want = new URLSearchParams(location.search).get('doc');
  if (want) {
    const idx = await loadHelpIndex(lang);
    readDoc(idx.find((e) => e.i === `d:${want}`));
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init());
else void init();
