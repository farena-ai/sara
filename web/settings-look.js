// SETTINGS3 S1 (docs/design/SETTINGS3.md): the calm look of a Settings page. Each page's top-level
// children are grouped into cards at its <h3> headings (`.s3-card`, a wrapper only: no control moves to
// another page or changes its id), the "On this page" list is drawn from those cards, and the header's
// save chip follows dialogs.js (`sara-saved` events). The CSS is web/settings3.css (outside Sara Classic).

/**
 * Where the cards start: the indexes of `kids` that open a new card. A card opens at the first child
 * and at every <h3>; the page lead and nested sections never open one. Pure, for tests.
 * @param {{ tag: string }[]} kids
 */
export function cardStarts(kids) {
  const starts = [];
  // A top-level `.kit-card` (chat app pages) or `[data-card]` block is a card of its own, and so is whatever follows it.
  kids.forEach((k, i) => {
    if (i === 0 || k.tag === 'H3' || k.kit || kids[i - 1].kit) starts.push(i);
  });
  return starts;
}

/**
 * SETTINGS3 S3: the pages with an Advanced fold, and the control whose card starts it (that card and every
 * card after it fold away; `''` folds the whole section). Closed by default, remembered per device; a
 * search jump, Show me or a tour opens it (howto.js showMe opens closed folds).
 */
export const ADVANCED = {
  'her-character': 'char-export',
  'you-details': 'md-v1-make',
  'models-default': 'history-budget',
  'co-telegram': 'tg-cmd-native',
  'co-discord': 'dc-bots',
  'co-apps': 'oa-tools',
  'ab-tools': 'iso-status',
  'ab-mcp': 'prq-installs',
  'ab-projects': 'lg-line',
  'dh-operations': 'mon-box',
  'household': 'hmt-box',
};
const ADV_KEY = 'sara.settingsAdvanced';
const advOpen = () => {
  try {
    return new Set(JSON.parse(globalThis.localStorage?.getItem(ADV_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
};
/** Folds a page's advanced cards into one closed "Advanced" block (after cardify). */
export function foldAdvanced(sec, t = (s) => s) {
  const page = sec?.dataset.page;
  if (!(page in ADVANCED) || sec.querySelector(':scope > details.s3-adv')) return;
  const cards = [...sec.children].filter((n) => n.matches('.s3-card'));
  const startAt = ADVANCED[page] ? cards.findIndex((c) => c.querySelector(`#${ADVANCED[page]}`)) : 0;
  // Never fold a page's first card (its controls live in one wrapper: nothing would be left to see).
  if (startAt < 0 || (startAt === 0 && ADVANCED[page])) return;
  const fold = document.createElement('details');
  fold.className = 's3-adv';
  fold.dataset.adv = page;
  fold.open = advOpen().has(page);
  const sum = document.createElement('summary');
  sum.className = 's3-adv-sum';
  sum.textContent = t('Advanced');
  cards[startAt].before(fold);
  fold.append(sum, ...cards.slice(startAt));
  fold.addEventListener('toggle', () => {
    const set = advOpen();
    if (fold.open) set.add(page);
    else set.delete(page);
    try {
      globalThis.localStorage?.setItem(ADV_KEY, JSON.stringify([...set]));
    } catch {}
  });
}

/** Wraps a page's top-level children into cards once (marked data-s3). Safe to call again. */
export function cardify(sec, t = (s) => s) {
  if (!sec || sec.dataset.s3 || typeof document === 'undefined') return;
  sec.dataset.s3 = '1';
  const kids = [...sec.children].filter((n) => !n.matches('section, .s3-card, .s3-section-head'));
  if (!kids.length) return;
  const starts = new Set(cardStarts(kids.map((n) => ({ tag: n.tagName, kit: n.matches('.kit-card, [data-card]') }))));
  let card = null;
  for (const [i, n] of kids.entries()) {
    if (starts.has(i)) {
      card = document.createElement('div');
      card.className = 's3-card';
      if (n.tagName === 'H3') card.classList.add('s3-has-head');
      n.before(card);
    }
    card.append(n);
  }
  foldAdvanced(sec, t);
}

/** The headings of the cards on screen, for "On this page" (text without the tip button). */
export function cardHeads(secs) {
  const out = [];
  for (const sec of secs) {
    if (sec.dataset.host) {
      const head = sec.querySelector(':scope > .s3-section-head');
      if (head) out.push({ node: head, label: head.textContent.trim() });
    }
    for (const h of sec.querySelectorAll(':scope > .s3-card > h3:first-child, :scope > details.s3-adv > .s3-card > h3:first-child, :scope > .s3-card > .kit-card > h3:first-child, :scope > .s3-card > .kit-card > .card-head > h3, :scope > details.s3-adv > .s3-card > .kit-card > h3:first-child, :scope > details.s3-adv > .s3-card > .kit-card > .card-head > h3, :scope > .s3-card > .sp-box > h3, :scope > details.s3-adv > .s3-card > .sp-box > h3')) {
      if (h.closest('[hidden]')) continue;
      const label = [...h.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !n.matches('button, .tip'))).map((n) => n.textContent).join('').trim();
      if (label) out.push({ node: h, label });
    }
  }
  return out;
}

/** Draws "On this page" (desktop ≥ 1280 px shows it; fewer than 3 headings hides it). */
export function paintToc(box, secs, t = (s) => s) {
  if (!box) return;
  const heads = cardHeads(secs);
  box.replaceChildren();
  box.hidden = heads.length < 3;
  if (box.hidden) return;
  const cap = document.createElement('p');
  cap.className = 's3-toc-cap';
  cap.textContent = t('On this page');
  const list = document.createElement('ul');
  for (const [i, h] of heads.entries()) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 's3-toc-item';
    b.textContent = h.label;
    if (i === 0) b.setAttribute('aria-current', 'true');
    b.addEventListener('click', () => {
      for (const x of box.querySelectorAll('[aria-current]')) x.removeAttribute('aria-current');
      b.setAttribute('aria-current', 'true');
      const fold = h.node.closest('details.s3-adv:not([open])');
      if (fold) fold.open = true;
      h.node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    li.append(b);
    list.append(li);
  }
  box.append(cap, list);
  box.heads = heads.map((h, i) => [h.node, list.children[i].firstChild]);
}

/** Keeps "On this page" on the heading at the top while the page scrolls. */
export function initTocSpy(scroller, box) {
  if (!scroller || !box) return;
  let queued = false;
  scroller.addEventListener('scroll', () => {
    if (queued || box.hidden || !box.heads) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const top = scroller.getBoundingClientRect().top + 48;
      let cur = box.heads[0];
      for (const pair of box.heads) if (pair[0].getBoundingClientRect().top <= top) cur = pair;
      for (const [, b] of box.heads) b.toggleAttribute('aria-current', b === cur[1]);
      if (cur) cur[1].setAttribute('aria-current', 'true');
    });
  }, { passive: true });
}

/** The header chip: "All changes saved", "Saved" for a moment after a save, or the error. */
export function initSaveChip(dialog, chip, t = (s) => s) {
  if (!dialog || !chip) return;
  let timer = 0;
  const rest = () => {
    chip.classList.remove('s3-just', 's3-error');
    chip.querySelector('.s3-chip-text').textContent = t('All changes saved');
  };
  rest();
  dialog.addEventListener('sara-saved', (e) => {
    clearTimeout(timer);
    const error = Boolean(e.detail?.error);
    chip.classList.toggle('s3-error', error);
    chip.classList.toggle('s3-just', !error);
    chip.querySelector('.s3-chip-text').textContent = error ? e.detail.text : t('Saved');
    if (!error) timer = setTimeout(rest, 2000);
  });
}
