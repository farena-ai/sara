// Phase 53, whole guide since Phase 61: the help page in the app's language (the one this device
// last used). Translations come from the same /i18n/<lang>.json as the app, keyed by the English:
// the menu and headings by their text, every other block of the guide (list items, paragraphs,
// table cells, tips) by its HTML, so links, emphasis and code samples keep working.
// scripts/i18n-extract.ts (fromHelp / helpBlocks) lists the same blocks, so a new paragraph without
// translations fails the i18n test.
const norm = (s) => s.replace(/\s+/g, ' ').trim();
let lang = null;
try {
  lang = localStorage.getItem('sara.lang');
} catch {
  /* private mode */
}
// Never opened the app on this device: the browser's language, if the app speaks it.
if (!lang) {
  const c = String(navigator.language ?? '').toLowerCase();
  lang = c.startsWith('pt') ? 'pt-BR' : ['es', 'fr', 'de', 'it'].find((l) => c.startsWith(l)) ?? null;
}

/** Blocks translated as a whole: their HTML (as the browser serializes it) is the key. */
const BLOCKS = 'main li, main p, main td, main th, main div.tip';

async function translateHelp() {
  if (!lang || lang === 'en' || !/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) return;
  const res = await fetch(`/i18n/${lang}.json`, { cache: 'no-cache' }).catch(() => null);
  if (!res?.ok) return;
  const dict = await res.json().catch(() => ({}));
  document.documentElement.lang = lang;
  const textOf = (el) => {
    for (const n of el.childNodes) {
      if (n.nodeType !== Node.TEXT_NODE) continue;
      const tr = dict[norm(n.nodeValue)];
      if (tr) n.nodeValue = n.nodeValue.replace(norm(n.nodeValue), tr);
    }
  };
  const title = dict[norm(document.title)];
  if (title) document.title = title;
  // Phase 114 (PL1d): the How do I…? index adds h4 page titles and <summary> questions (keys the app has).
  for (const el of document.querySelectorAll('nav a, nav .brand, main h1, main h2, main h3, main h4, main summary')) textOf(el);
  for (const el of document.querySelectorAll(BLOCKS)) {
    const tr = dict[norm(el.innerHTML)];
    if (tr) el.innerHTML = tr;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void translateHelp());
else void translateHelp();

// Phase 114 (PL1d): a link to one answer of the How do I…? index (#howto-<page>-<question>) opens it.
function openTarget() {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id ? document.getElementById(id) : null;
  if (el?.tagName === 'DETAILS') el.open = true;
}
addEventListener('hashchange', openTarget);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openTarget);
else openTarget();
