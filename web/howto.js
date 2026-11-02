// Phase 114 (PL1c, docs/design/POLISH.md §4.5): the "How do I…?" block at the top of every Settings
// page and every view. The answers live in one file, web/howto.json (keyed by Settings page id or view
// id), so they are translated with the rest (scripts/i18n-extract.ts reads it) and a test checks every
// page has 2–4 questions and every "Show me" selector exists in index.html.
//
//   howtoBlock(id, { t, open })  → a closed <details class="howto"> (null when the page has no entry)
//   showMe(selector)             → scrolls to the control and pulses it (the tour's ring colour)
//
// No DOM work at import time, so the data helpers can be checked in Node.

let data = null;
let loading = null;

/** Loads web/howto.json once (later calls get the same object). */
export function loadHowto(fetcher = (u) => fetch(u)) {
  if (data) return Promise.resolve(data);
  loading ??= fetcher('/howto.json')
    .then((r) => r.json())
    .then((d) => (data = d))
    .catch(() => (data = {}));
  return loading;
}
/** For tests and the guide: use this data instead of fetching it. */
export function setHowto(d) {
  data = d;
}
/** The questions of one page or view ([] when it has none). */
export function howtoFor(id) {
  return data?.[id] ?? [];
}
/** The Settings page and question that answer a Getting started step (from `start` in howto.json). */
export function howtoForStep(step) {
  for (const [page, list] of Object.entries(data ?? {})) {
    const q = list.find((x) => x.start === step);
    if (q) return { page, q: q.id };
  }
  return null;
}

/** Scrolls to the first visible match of a selector and pulses it for a moment. */
export function showMe(sel, doc = document) {
  const hit = [...doc.querySelectorAll(sel)].find((n) => n.getClientRects().length) ?? doc.querySelector(sel);
  if (!hit) return false;
  const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  hit.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  hit.classList.remove('howto-pulse');
  void hit.offsetWidth;
  hit.classList.add('howto-pulse');
  setTimeout(() => hit.classList.remove('howto-pulse'), 1800);
  if (hit.matches('button, input, select, textarea, a[href], [tabindex]')) hit.focus({ preventScroll: true });
  return true;
}

/**
 * The block: "How do I…?" folded; inside, each question folds open to numbered steps and, when the
 * answer names one control, a Show me button. `open` = a question id to show expanded (Getting started).
 */
export function howtoBlock(id, { t = (s) => s, open = '', doc = document, about = null } = {}) {
  const list = howtoFor(id);
  if (!list.length) return null;
  const mk = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const box = mk('details', 'howto');
  box.dataset.howto = id;
  const sum = mk('summary', 'howto-sum');
  sum.append(mk('span', 'howto-mark', '?'), mk('span', 'howto-title', t('How do I…?')), mk('span', 'howto-count muted small', String(list.length)));
  box.append(sum);
  const qs = mk('div', 'howto-list');
  // S2: a page's longer paragraph lives here, so the page shows one intro (the header line).
  if (about) {
    about.classList.add('howto-about');
    qs.append(about);
  }
  for (const item of list) {
    const q = mk('details', 'howto-q');
    q.dataset.q = item.id;
    q.append(mk('summary', '', t(item.q)));
    const ol = mk('ol', 'howto-steps');
    for (const s of item.steps) ol.append(mk('li', '', t(s)));
    q.append(ol);
    if (item.show) {
      const b = mk('button', 'linkish small howto-show', t('Show me'));
      b.type = 'button';
      b.addEventListener('click', () => showMe(item.show, doc));
      q.append(b);
    }
    if (item.id === open) {
      q.open = true;
      box.open = true;
    }
    qs.append(q);
  }
  box.append(qs);
  return box;
}

/** Where each view's block goes: after the window's title and its one intro (Today: under the hero). */
export const VIEW_HOWTO = {
  today: '#today .td-hero',
  planner: '#planner',
  // PL2c (N21): a How do I…? per Planner tab that had none.
  'planner-reminders': '#planner .tab-panel[data-panel="reminders"]',
  'planner-repeats': '#planner .tab-panel[data-panel="repeats"]',
  'planner-routines': '#planner .tab-panel[data-panel="routines"]',
  memory: '#memory',
  library: '#lib-home',
  scrapbook: '#scrapbook',
  moments: '#moments',
  story: '#story',
  team: '#team',
  findings: '#findings',
  evals: '#evals',
};
/** Puts the "How do I…?" block into every view once (the content is static; the windows keep it). */
export function mountViewHowtos(t = (s) => s, doc = document) {
  for (const [id, sel] of Object.entries(VIEW_HOWTO)) {
    const host = doc.querySelector(sel);
    if (!host || doc.querySelector(`[data-howto="${id}"]`)) continue;
    const block = howtoBlock(id, { t, doc });
    if (!block) continue;
    if (id === 'today') {
      block.classList.add('td-howto');
      host.after(block);
      continue;
    }
    const h2 = host.querySelector('h2');
    let anchor = h2;
    const next = h2?.nextElementSibling;
    if (next?.matches('p.muted')) anchor = next.nextElementSibling?.matches('.dlg-more') ? next.nextElementSibling : next;
    if (anchor) anchor.after(block);
    else host.prepend(block);
  }
}
