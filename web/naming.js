// Shows all built-in wording on the page in the owner's language, with the companion's name and
// pronouns. The page is written in English for "Sara" (she/her). Every companion word goes through
// render() below: never set her name or a pronoun as raw text (test/name-everywhere.test.ts checks).
// Phase 53: translate first, then personalize. Translations live in /i18n/<lang>.json, keyed by the
// English text (trimmed, spaces collapsed). In English, personalize() (shared with the server)
// rewrites name and pronouns. Other languages swap the name, pick a translation's
// {p, select, she {…} he {…} other {…}} variant where grammar needs it, and swap the strong pronouns
// of strings whose English speaks of her (src/identity.ts personalizeTranslation; German has no rule:
// "sie" is also "they", "it" and formal "you").
// Text the owner or the companion wrote (messages, titles, memories, notes, files) is never touched.
import { personalize, personalizeTranslation, selectPronoun } from './identity.js';

// Where owner/companion text lives: never rewritten.
const RAW = [
  '.msg', '.md', '#conversations', '#chat-title', '#mem-list', '#task-list', '#rem-list', '#note-list',
  '.sb-list', '.sb-photos', '#pp-title', '#pp-ws', '#pp-convs', '#pp-tasks', '#pp-notes', '#pp-files', '#pp-file-view',
  '#sd-day', '#sd-status', '.search-hit', '#bk-list', '#provider-list', '#mcp-list', 'pre', 'code', '[data-raw]',
  // Phase 31: other companions' names.
  '#companion-menu', '#cmp-list', '#cmp-from', '#other-note-text', '#cmp-status',
  // Phase 53: the story timeline holds her and your words (its labels use t()).
  '#story-list', '.lookback-text',
  // Logged problems quote program text; gallery cards describe other characters (H4, M7).
  '#log-problems', '.gallery-head', '.gallery-pitch', '.gallery-line', '.gallery-tags',
  // Phase 66: group chats name every member (the line under the title, the member cards).
  '#conv-summary', '#gc-members',
  // Phase 68: the saved servers' names (one may well be called Sara).
  '#servers-list', '#server-btn-name',
  // V4a: "Sara Classic" is the product's palette name, not hers (a renamed companion keeps it).
  '#ap-palette option[value="classic"]', '.ap-pal[data-pal="classic"] .ap-pal-name', '#v1-classic',
].join(',');
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tip', 'aria-description'];
const NAME_RE = /\b(Sara|she|her|hers|herself|She|Her|Hers|Herself)\b/;

/** Languages the app speaks (English is the source). */
export const LANGS = { en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', 'pt-BR': 'Português (Brasil)', it: 'Italiano' };

let identity = { name: 'Sara', pronouns: 'she' };
let lang = 'en';
let dict = {};
const originalText = new WeakMap();
const originalAttr = new WeakMap();
let observer;

/** Any language code ("de-AT", "pt", "es-419") → one of ours, or undefined. */
export function toLang(code) {
  const c = String(code ?? '').trim().toLowerCase().replace('_', '-');
  if (!c) return undefined;
  if (c.startsWith('pt')) return 'pt-BR';
  const base = c.split('-')[0];
  return base in LANGS ? base : undefined;
}
/** The browser's language, if we speak it. */
export const browserLang = () => toLang(navigator.languages?.[0] ?? navigator.language) ?? 'en';
export const currentLang = () => lang;
/** The locale for dates and numbers. */
export const locale = () => (lang === 'en' ? (/^en\b/i.test(navigator.language) ? navigator.language : 'en-US') : lang);

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const raw = (el) => Boolean(el?.closest?.(RAW));

/** English → this language (unknown strings stay English), keeping the original's outer spaces. */
function translate(s) {
  if (lang === 'en' || !s) return s;
  const tr = dict[norm(s)];
  if (!tr) return s;
  return /^\s*/.exec(s)[0] + tr + /\s*$/.exec(s)[0];
}
/** Built-in text about someone else (a gallery character): translated, but names and pronouns kept. */
export const translateOnly = (s, pronouns = 'she') => selectPronoun(translate(String(s ?? '')), pronouns);
/**
 * Built-in English text in the app language for the owner's companion: name and pronouns. English
 * rewrites pronouns (personalize); translations pick their {p, select, …} variant and, when the
 * English speaks of her, swap the strong pronouns (src/identity.ts personalizeTranslation).
 */
const render = (s) => (lang === 'en' ? personalize(s, identity) : personalizeTranslation(s, translate(s), identity, lang));
// Text that names pronouns as choices ("she / her" in a pronoun picker): translated, never personalized.
const NONAME = '[data-noname]';
const renderFor = (el, s) => (el?.closest?.(NONAME) ? translate(s) : render(s));
const needsWork = (s) => NAME_RE.test(s) || (lang !== 'en' && Boolean(dict[norm(s)]));

function fixText(node) {
  if (raw(node.parentElement)) return;
  // Text t() made earlier (perhaps for the old name, kept by a panel and put back): made again now.
  const again = !originalText.has(node) && built.get(node.nodeValue);
  if (again) {
    const v = again();
    if (v !== node.nodeValue) node.nodeValue = v;
    return;
  }
  const orig = originalText.has(node) ? originalText.get(node) : node.nodeValue;
  if (!originalText.has(node)) {
    if (!needsWork(orig)) return;
    originalText.set(node, orig);
  }
  const next = renderFor(node.parentElement, orig);
  if (node.nodeValue !== next) node.nodeValue = next;
}

function fixAttrs(el) {
  if (raw(el)) return;
  let saved = originalAttr.get(el);
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const cur = el.getAttribute(a);
    if (!saved?.[a] || saved[a].shown !== cur) {
      if (!needsWork(cur)) continue;
      saved ??= {};
      saved[a] = { orig: cur };
      originalAttr.set(el, saved);
    }
    const next = renderFor(el, saved[a].orig);
    saved[a].shown = next;
    if (cur !== next) el.setAttribute(a, next);
  }
}

function walk(root) {
  if (root.nodeType === Node.TEXT_NODE) return fixText(root);
  if (root.nodeType !== Node.ELEMENT_NODE || raw(root)) return;
  fixAttrs(root);
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && n.matches(RAW) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) fixText(n);
    else fixAttrs(n);
  }
}

function applyAll() {
  observer?.disconnect();
  // Text built in code (t()) under the old name, pronouns or language.
  refreshBuilt();
  walk(document.body);
  document.title = identity.name;
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', identity.name);
  observer?.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

function ensureObserver() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    observer.disconnect();
    for (const r of records) {
      if (r.type === 'childList') for (const n of r.addedNodes) walk(n);
      else if (r.type === 'characterData') {
        // JS replaced the text: forget the old original.
        if (originalText.has(r.target) && r.target.nodeValue !== renderFor(r.target.parentElement, originalText.get(r.target))) originalText.delete(r.target);
        fixText(r.target);
      } else if (r.type === 'attributes') fixAttrs(r.target);
    }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  });
}

/** Sets the companion's identity and rewrites the page; later changes are followed automatically. */
export function setIdentity(next) {
  if (!next?.name) return;
  identity = { name: next.name, pronouns: next.pronouns ?? 'she' };
  ensureObserver();
  applyAll();
  // V4a: parts that build her name in code (her panel's title) redraw at once.
  if (typeof CustomEvent === 'function') document.dispatchEvent?.(new CustomEvent('sara-identity', { detail: identity }));
}

// Dates and numbers follow the app language (calls that pass no locale of their own).
for (const [proto, names] of [[Date.prototype, ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']], [Number.prototype, ['toLocaleString']]]) {
  for (const name of names) {
    const orig = proto[name];
    proto[name] = function (loc, opts) {
      return orig.call(this, loc === undefined || (Array.isArray(loc) && !loc.length) ? locale() : loc, opts);
    };
  }
}

/**
 * Loads a language (English needs nothing) and re-renders the page's built-in text. Remembered on
 * this device so the sign-in page opens in it next time.
 */
export async function setLanguage(code) {
  const next = toLang(code) ?? 'en';
  let d = {};
  if (next !== 'en') {
    try {
      const res = await fetch(`/i18n/${next}.json`, { cache: 'no-cache' });
      if (res.ok) d = await res.json();
    } catch {
      /* offline: stay in English */
    }
  }
  lang = next;
  dict = d;
  document.documentElement.lang = next;
  try {
    localStorage.setItem('sara.lang', next);
  } catch {
    /* private mode */
  }
  ensureObserver();
  applyAll();
  return next;
}

/** The language this device used last time (before sign-in we don't know the owner's pick). */
export const savedLang = () => {
  try {
    return toLang(localStorage.getItem('sara.lang')) ?? browserLang();
  } catch {
    return browserLang();
  }
};

/**
 * For text built in code: translate, then name/pronouns. `{name}`-style placeholders are filled from
 * `vars` after translating, so translations can move them: t('{n} new', { n: 3 }).
 */
export const t = (s, vars) => {
  let out = render(String(s));
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  // Remembered so a rename re-renders text built in code too (refreshBuilt), not only the page's own.
  if (out !== s || NAME_RE.test(out)) {
    if (built.size > 4000) built.delete(built.keys().next().value);
    built.set(out, () => t(s, vars));
  }
  return out;
};
/** Where words are hers or the owner's (messages, titles, notes, code): never re-rendered. */
const WRITTEN = '.md, pre, code, #conversations, #chat-title, #mem-list, #note-list, #task-list, .search-hit, #story-list, .lookback-text';
/** Text t() produced → how to make it again (for the companion's current name and pronouns). */
const built = new Map();
/** After a rename or a new language: text that code put on the page with t() follows too. */
function refreshBuilt() {
  if (!built.size || !document.body || typeof document.createTreeWalker !== 'function') return;
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      // Also in raw spots (cards and facts that hold names or model ids) when the text is exactly what
      // t() made; never in what she or the owner wrote.
      const again = !originalText.has(n) && !n.parentElement?.closest(WRITTEN) && built.get(n.nodeValue);
      if (again) n.nodeValue = again();
    } else if (!raw(n)) {
      for (const a of ATTRS) {
        const again = n.hasAttribute(a) && !originalAttr.get(n)?.[a] && built.get(n.getAttribute(a));
        if (again) n.setAttribute(a, again());
      }
    }
  }
}
export const currentIdentity = () => identity;
/**
 * Phase 61: a message the server sent ({ error } or a notice's { key, params }) in the app language.
 * Fixed messages are keyed by their English text; messages with values come with `errorKey`/`key`
 * (the English template) and `params`. Unknown messages stay as the server's English.
 */
export const serverText = (data, fallback = '') => {
  const key = data?.errorKey ?? data?.key ?? data?.error ?? data?.text;
  return key ? t(String(key), data?.params && typeof data.params === 'object' ? data.params : undefined) : fallback;
};
