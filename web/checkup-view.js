// Phase 94 (computer use CU7): the check-up report card and the "one change" card in the chat. Drawn
// from the structured card the server builds from the device's READ-ONLY check (src/cards.ts
// checkupCard): numbers, statuses and short names only. Every sentence is written here through t()
// (names from the computer stay as they are: they are data). Each suggestion is its own action:
// "Do this" puts a request for that one suggestion in the message box (she then asks the computer,
// which shows its own card); "How?" asks her to explain the ones the owner does themselves.
import { t } from './naming.js';
import { icon } from './icons.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== '') e.textContent = text;
  return e;
};

/** Sizes in the reader's language (units are translated: "Go" in French). */
export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return t('{n} GB', { n: (n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 1) });
  if (n >= 1024 ** 2) return t('{n} MB', { n: String(Math.round(n / 1024 ** 2)) });
  return t('{n} KB', { n: String(Math.max(0, Math.round(n / 1024))) });
}

const CHECK_TITLE = () => ({ startup: t('Startup apps'), disk: t('Disk space'), folders: t('Biggest folders'), updates: t('Updates'), battery: t('Battery'), extensions: t('Browser extensions'), temp: t('Temporary files') });
const STATUS = () => ({ good: t('OK'), warn: t('Worth a look'), bad: t('Needs attention'), info: t('Info'), unavailable: t('Not checked') });
const list = (v) => (Array.isArray(v) ? v.map(String) : []);
const placeName = (id, windows) => ({ temp: t('Temporary files'), 'browser-cache': t('Browser caches'), trash: windows ? t('Recycle Bin') : t('Trash'), caches: t('App caches') })[id] ?? '';

/** The main line and the detail lines of one check (from its facts). */
function lines(item, windows) {
  const f = item.facts ?? {};
  if (item.status === 'unavailable') return [t('Not checked on this computer.'), ''];
  switch (item.check) {
    case 'startup':
      return [t('{n} start by themselves', { n: String(f.enabled ?? 0) }), list(f.names).join(', ')];
    case 'disk':
      return [t('{free} free of {total} ({percent}%)', { free: fmtSize(f.free), total: fmtSize(f.total), percent: String(f.percent ?? 0) }), String(f.volume ?? '')];
    case 'folders': {
      const names = list(f.names);
      const sizes = list(f.bytes);
      return [names.length ? t('Biggest: {name}', { name: names[0] }) : t('None found'), names.map((n, i) => `${n} ${fmtSize(sizes[i])}`).join(' · ')];
    }
    case 'updates':
      return [Number(f.pending) ? t('{n} updates waiting', { n: String(f.pending) }) : t('No updates waiting'), f.reboot ? t('A restart is needed to finish one.') : list(f.names).join(', ')];
    case 'battery': {
      if (f.present === false) return [t('No battery (a desktop computer)'), ''];
      const bits = [];
      if (f.percent !== undefined) bits.push(t('{percent}% charged', { percent: String(f.percent) }));
      if (f.cycles !== undefined) bits.push(t('{n} charge cycles', { n: String(f.cycles) }));
      return [f.health !== undefined ? t('Holds {health}% of its original charge', { health: String(f.health) }) : t('Battery found'), bits.join(' · ')];
    }
    case 'extensions':
      return [t('{n} on in your browsers', { n: String(f.enabled ?? 0) }), list(f.names).join(', ')];
    case 'temp': {
      const ids = list(f.ids);
      const sizes = list(f.bytes);
      return [t('{size} in all', { size: fmtSize(f.total) }), ids.map((id, i) => `${placeName(id, windows) || list(f.names)[i] || id} ${fmtSize(sizes[i])}`).join(' · ')];
    }
    default:
      return ['', ''];
  }
}

/** One suggestion in plain words. */
function suggestionText(s, windows) {
  const name = s.name ?? '';
  const size = s.bytes ? fmtSize(s.bytes) : '';
  switch (s.kind) {
    case 'restore-point':
      return t('Make a restore point first (Start, then type \u201cCreate a restore point\u201d). It needs your administrator yes, so you do it.');
    case 'startup.disable':
      return t('Stop \u201c{name}\u201d from starting by itself', { name });
    case 'temp.clean':
      return t('Clean old temporary files ({size})', { size });
    case 'trash.empty':
      return windows ? t('Empty the Recycle Bin ({size})', { size }) : t('Empty the Trash ({size})', { size });
    case 'settings.open':
      return { storage: t('Open the storage settings'), updates: t('Open the update settings so you can install them'), battery: t('Open the battery settings'), startup: t('Open the startup apps settings') }[s.page] ?? t('Open the settings');
    default:
      if (s.check === 'startup') return t('\u201c{name}\u201d starts for everyone: only an administrator can turn it off', { name });
      if (s.check === 'folders') return t('Look through \u201c{name}\u201d ({size}) and delete what you don\u2019t need', { name, size });
      if (s.check === 'extensions') return t('Remove extensions you don\u2019t use on your browser\u2019s extensions page');
      if (s.check === 'temp') return t('Clear the cache in your browser\u2019s settings ({size})', { size });
      return t('You can do this one yourself');
  }
}

/** Puts a request in the message box (the owner reads it and presses Send). */
function ask(text) {
  const box = document.getElementById('input');
  if (!box) return;
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.focus();
}

/** The report card: one tile per check, then the numbered suggestions, each its own action. */
export function checkupCard(c) {
  const windows = c.windows === true;
  const card = el('div', 'rcard rcard-checkup');
  card.setAttribute('role', 'group');
  const title = c.computer ? t('Check-up of {computer}', { computer: c.computer }) : t('Computer check-up');
  card.setAttribute('aria-label', title);
  const head = el('div', 'rcard-head');
  const ic = el('span', 'rcard-icon');
  ic.setAttribute('aria-hidden', 'true');
  const svg = icon('monitor');
  if (svg) {
    ic.append(svg);
    head.append(ic);
  }
  head.append(el('span', 'rcard-title', title));
  card.append(head, el('p', 'ck-sub', t('Read only: nothing was changed.')));
  const grid = el('div', 'ck-grid');
  const names = CHECK_TITLE();
  const st = STATUS();
  for (const it of c.items ?? []) {
    const tile = el('div', `ck-tile ck-${it.status}`);
    const top = el('div', 'ck-tile-top');
    top.append(el('span', 'ck-name', names[it.check] ?? it.check), el('span', `ck-status ck-status-${it.status}`, st[it.status] ?? ''));
    const [main, detail] = lines(it, windows);
    tile.append(top, el('p', 'ck-main', main));
    if (detail) tile.append(el('p', 'ck-detail', detail));
    if (it.check === 'extensions') tile.append(el('p', 'ck-note', t('Shown only: Sara never changes your own browser.')));
    grid.append(tile);
  }
  card.append(grid);
  if (c.flagged) card.append(el('p', 'ck-flag', t('{n} names on this computer read like instructions. Sara treats them as text and ignores them.', { n: String(c.flagged) })));
  const sugg = c.suggestions ?? [];
  if (sugg.length) {
    card.append(el('h4', 'ck-h', t('Suggested changes')));
    const ol = el('ol', 'ck-list');
    for (const s of sugg) {
      const li = el('li', `ck-sugg${s.kind === 'restore-point' ? ' ck-first' : ''}`);
      li.append(el('span', 'ck-id', s.id), el('span', 'ck-text', suggestionText(s, windows)));
      const b = el('button', s.how === 'apply' ? 'ck-do' : 'ck-how ghost', s.how === 'apply' ? t('Do this') : t('How?'));
      b.type = 'button';
      b.addEventListener('click', () => ask(s.how === 'apply' ? t('Please do suggestion {id} from the check-up.', { id: s.id }) : t('How do I do suggestion {id} from the check-up?', { id: s.id })));
      li.append(b);
      ol.append(li);
    }
    card.append(ol, el('p', 'ck-foot', t('Each change is separate and asks you on that computer first. Nothing is deleted or uninstalled without your yes there.')));
  } else card.append(el('p', 'ck-foot', t('Nothing to change: it looks fine.')));
  return card;
}

/** One change: done after the owner's yes on the computer, or declined there. */
export function checkupChangeCard(c) {
  const done = c.outcome === 'done';
  const card = el('div', `rcard rcard-checkup-change ${done ? 'ok' : ''}`.trim());
  card.setAttribute('role', 'group');
  const title = done ? (c.computer ? t('Done on {computer}', { computer: c.computer }) : t('Done')) : t('Not changed: you said no on the computer');
  card.setAttribute('aria-label', title);
  const head = el('div', 'rcard-head');
  head.append(el('span', 'rcard-title', title));
  card.append(head, el('p', 'ck-main', suggestionText({ kind: c.change, check: '', name: c.name, bytes: c.bytes, page: c.page }, c.windows !== false)));
  return card;
}
