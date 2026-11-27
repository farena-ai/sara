// The Settings window's list of pages and its search (moved out of app.js in PL2d, 2.61.3; code moved
// only, docs/design/POLISH2.md C1): the old tab names, the 8 groups (+ Household) and their order,
// the accordion, and the ranked search with Elsewhere (web/settings-search.js holds the index).
import { t } from './naming.js';
import { foldText, rankElsewhere, rankPages, SETTINGS_KEYWORDS } from './settings-search.js';
import { howtoFor, showMe } from './howto.js';
import { controlRecords, rankControls, rowOf } from './settings-find.js';
import { slashCommands } from './slash.js';
import { crumbsFor, homeModel } from './settings-home.js';
import { cardify, paintToc } from './settings-look.js';

const $ = (sel) => document.querySelector(sel);
/** What app.js lends this module (el, isMember, openSearchPlace, pageLead, showSettingsTab). */
let ctx = null;
const isMember = (...a) => ctx.isMember(...a);
const el = (...a) => ctx.el(...a);
const showSettingsTab = (...a) => ctx.showSettingsTab(...a);
const pageLead = (...a) => ctx.pageLead(...a);
const openSearchPlace = (...a) => ctx.openSearchPlace(...a);

// Settings pages (Phase 15): a list of pages grouped by topic, a search box, one page at a time.
// Old tab names still work (links and first-run steps use them).
// Phase 114 (PL1c, S5): Recipes became Skills; its old link lands there and it is out of the list.
// Phase 128 (PL2b): Today's "Runs today" link asked for 'dh-runs', which never existed (it fell back to
// the first page); the run history (Keep runs, Delete run history) is on Health.
export const OLD_TABS = { yours: 'her-character', models: 'models-default', you: 'you-about', abilities: 'ab-tools', connections: 'co-phone', voice: 'her-voice', data: 'dh-health', 'dh-runs': 'dh-health', 'ab-recipes': 'ab-skills' };
// ADULTAPPS: the Adult mode page shows everywhere; in the phone apps (store rules) it shows its state,
// Turn off, and an Open in browser path instead of Turn on. "This computer" only in the desktop app.
// Phase 71: a household member sees only their own pages (data-member-only), never the owner's
// (data-owner-only); the household page isn't on the demo server.
const COMPANION_PAGES = ['her-character', 'her-relationship', 'her-companions', 'her-look', 'her-pictures', 'you-adult'];
export const settingsPages = () =>
  [...document.querySelectorAll('#settings .settings-page')].filter(
    (p) =>
      !(p.dataset.page === 'desktop-app' && !window.SaraDesktop) &&
      !(isMember() ? 'ownerOnly' in p.dataset : 'memberOnly' in p.dataset) &&
      !(['household', 'dh-recovery', 'dh-operations'].includes(p.dataset.page) && document.body.classList.contains('demo')) &&
      // T54: with the companion side off, its Settings pages are not listed.
      !(document.documentElement?.dataset?.companion === 'off' && COMPANION_PAGES.includes(p.dataset.page)) &&
      p.dataset.page !== 'ab-recipes',
  );

// Settings groups (UI cleanup): real headers with an icon, opened and closed by a click; only the
// group of the page on screen is open at first, and the choice is remembered on this device.
// SETTINGS3 (docs/design/SETTINGS3.md): 6 groups + Household, a two-level rail (the group of the page on
// screen shows its pages), 51 entries instead of 82. Page ids never change; a page's group is its
// data-group in index.html. A merged page (data-host) is a section of its host and has no entry of its
// own; a tile page (data-tile) is reached from Apps and services (co-services). The first group is named
// after her: naming.js rewrites "Sara" to her name wherever it is shown.
const SETTINGS_GROUPS = [
  { name: 'Sara', icon: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z' },
  { name: 'You', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4.4 3.6-7 8-7s8 2.6 8 7' },
  { name: 'Models & usage', icon: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4' },
  { name: 'Connections', icon: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' },
  { name: 'Skills & tools', icon: 'M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z' },
  { name: 'Privacy & system', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4' },
  { name: 'Household', icon: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6' },
];
/** The Apps and services hub: a nav entry and a view, not a settings page (web/settings-services.js). */
export const SERVICES = 'co-services';
/**
 * Where pages used to be (for “moved to …” in search, one release): Abilities and Connections moved in
 * 2.61.1; Her, Models, Chat apps, Add-ons, Coding and Data & health became the SETTINGS3 groups.
 */
const SETTINGS_WAS = {
  Abilities: ['ab-store', 'ab-tools', 'ab-skills', 'ab-plugins', 'ab-search', 'ab-library', 'ab-google', 'ab-home', 'ab-mcp', 'ab-projects', 'ab-precise', 'ab-budgets', 'ab-persist', 'ab-when', 'ab-github', 'ab-ssh'],
  Connections: ['co-telegram', 'co-discord', 'co-signal', 'co-email', 'co-whatsapp', 'co-matrix', 'co-imessage', 'co-pickup'],
  Her: ['her-character', 'her-relationship', 'her-look', 'her-pictures', 'her-voice', 'her-hey', 'her-calls', 'her-work', 'her-companions', 'her-import'],
  Models: ['models-default', 'models-routes', 'models-providers', 'models-subs', 'models-local'],
  'Chat apps': ['co-telegram', 'co-discord', 'co-signal', 'co-email', 'co-whatsapp', 'co-matrix', 'co-imessage', 'co-slack', 'co-teams', 'co-pickup', 'co-continuity'],
  'Add-ons': ['ab-store', 'ab-skills', 'ab-plugins', 'ab-mcp', 'ab-search', 'ab-data', 'ab-library', 'ab-mail', 'ab-google', 'ab-home'],
  Coding: ['ab-projects', 'ab-precise', 'ab-persist', 'ab-budgets', 'ab-github', 'ab-ssh', 'ab-tools'],
  'Data & health': ['dh-safety', 'dh-health', 'dh-quality', 'dh-operations', 'dh-recovery', 'dh-backups', 'dh-data', 'dh-movein', 'dh-updates', 'dh-usage', 'dh-privacy', 'dh-reports'],
};
/** The old group names in the app's language (search matches them for one release). */
const WAS_WORDS = { Abilities: () => t('Abilities'), Connections: () => t('Connections'), Her: () => t('Her'), Models: () => t('Models'), 'Chat apps': () => t('Chat apps'), 'Add-ons': () => t('Add-ons'), Coding: () => t('Coding'), 'Data & health': () => t('Data & health') };
/** The names that went away in SETTINGS3 (their message says so; Abilities/Connections keep theirs). */
const WAS_S3 = new Set(['Her', 'Models', 'Chat apps', 'Add-ons', 'Coding', 'Data & health']);
// The order of the pages inside each group. Page ids stay the same: links, tips, tours and tests use them.
// A merged page follows its host; tile pages follow the group's own pages in tile order.
const SETTINGS_ORDER = [
  'her-character', 'her-relationship', 'her-look', 'her-pictures', 'her-voice', 'her-hey', 'her-calls', 'her-companions', 'her-work',
  'you-about', 'you-appearance', 'you-briefing', 'you-leave-by', 'ab-when', 'you-automations', 'you-details', 'you-upkeep', 'you-business', 'you-knows', 'you-adult',
  'models-default', 'models-routes', 'models-providers', 'models-subs', 'models-local', 'dh-usage', 'ab-budgets',
  // Connections: the tiles of Apps and services first (search breaks ties in this order: "tailscale"
  // finds WhatsApp and Matrix before Devices), then the group's own pages. 3.0.3: Devices and sign-in
  // (where codes for a new phone or computer are made) sits right before Phone; its id stays dh-devices.
  'co-telegram', 'co-discord', 'co-whatsapp', 'co-signal', 'co-imessage', 'co-matrix', 'co-slack', 'co-teams', 'co-email', 'co-pickup', 'co-continuity',
  'ab-mail', 'ab-google', 'ab-home', 'ab-github', 'co-spotify', 'ab-search', 'ab-data', 'co-apps', 'co-agents', 'co-hooks',
  'dh-devices', 'co-phone', 'co-shortcuts', 'desktop-app', 'co-computer',
  'ab-store', 'ab-skills', 'ab-plugins', 'ab-mcp', 'ab-tools', 'ab-library', 'ab-recipes',
  'ab-projects', 'ab-precise', 'ab-persist', 'ab-ssh',
  'dh-safety', 'dh-privacy', 'dh-backups', 'dh-data', 'her-import', 'dh-movein', 'dh-health', 'dh-quality', 'dh-recovery', 'dh-operations', 'dh-updates', 'dh-reports', 'dh-timeline',
  'household', 'dh-policy', 'dh-audit', 'dh-retention', 'dh-trust', 'dh-usage-report', 'dh-shares', 'account',
];
// A small heading inside a group, before the first of these pages (owner decision: Coding is a
// sub-heading of Skills & tools, not a group).
const SETTINGS_SUB = { 'ab-projects': 'Coding' };
const NS_SVG = 'http://www.w3.org/2000/svg';
function lineIcon(d, cls = '') {
  const s = document.createElementNS(NS_SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) s.setAttribute(k, v);
  if (cls) s.setAttribute('class', cls);
  const path = document.createElementNS(NS_SVG, 'path');
  path.setAttribute('d', d);
  s.append(path);
  return s;
}
/** A page with its own entry in the rail (not a section of another page, not a tile of the hub). */
export const ownEntry = (p) => !p.dataset.host && !p.dataset.tile;
export function setGroupOpen(box, open, remember = true) {
  // Phase 114 (PL1c, S1): an accordion: opening a group closes the others (one scrollbar, never two).
  if (open && remember) for (const g of document.querySelectorAll('#settings-nav-list .settings-nav-group.open')) if (g !== box) setGroupOpen(g, false, false);
  box.classList.toggle('open', open);
  box.querySelector('.settings-nav-head').setAttribute('aria-expanded', String(open));
  box.querySelector('.settings-nav-items').hidden = !open;
  if (!remember) return;
  const set = new Set([...document.querySelectorAll('#settings-nav-list .settings-nav-group.open')].map((g) => g.dataset.group));
  localStorage.setItem('sara.settingsGroups', JSON.stringify([...set]));
}

const order = (p) => {
  const i = SETTINGS_ORDER.indexOf(p.dataset.page);
  return i < 0 ? SETTINGS_ORDER.length : i;
};
/** A merged page's host id, or '' (the page itself is a host or stands alone). */
export const hostOf = (page) => document.querySelector(`#settings .settings-page[data-page="${page}"]`)?.dataset.host ?? '';
/** The rail entry that shows a page: its host, the hub for a tile, else the page. */
export function entryOf(page) {
  const sec = document.querySelector(`#settings .settings-page[data-page="${page}"]`);
  if (!sec) return page;
  if (sec.dataset.host) return entryOf(sec.dataset.host);
  return sec.dataset.tile ? SERVICES : page;
}
export function buildSettingsNav() {
  const nav = $('#settings-nav-list');
  const groups = new Map();
  const seen = new Set();
  // One entry per page (a page listed twice once showed up twice at the end of the list).
  const pages = settingsPages().sort((x, y) => order(x) - order(y));
  for (const sec of pages) {
    if (seen.has(sec.dataset.page)) continue;
    seen.add(sec.dataset.page);
    if (!groups.has(sec.dataset.group)) groups.set(sec.dataset.group, []);
    if (ownEntry(sec)) groups.get(sec.dataset.group).push(sec);
  }
  // SETTINGS3: Apps and services leads Connections when any of its tiles is there for this person.
  const tiles = pages.filter((p) => p.dataset.tile);
  if (tiles.length) {
    const hub = { dataset: { page: SERVICES, title: 'Apps and services', group: tiles[0].dataset.group } };
    if (!groups.has(hub.dataset.group)) groups.set(hub.dataset.group, []);
    groups.get(hub.dataset.group).unshift(hub);
  }
  const rank = (g) => {
    const i = SETTINGS_GROUPS.findIndex((x) => x.name === g);
    return i < 0 ? SETTINGS_GROUPS.length : i;
  };
  // V3 §2 / SETTINGS3: the overview first; screens.css/v3.css hide it in Sara Classic.
  const home = el('button', 'settings-nav-item settings-nav-home');
  home.type = 'button';
  home.dataset.page = 'home';
  home.append(lineIcon('M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', 'sng-icon'), el('span', '', t('Overview')));
  home.addEventListener('click', () => showSettingsTab('home', { focus: true }));
  nav.replaceChildren(
    home,
    ...[...groups].filter(([, secs]) => secs.length).sort(([x], [y]) => rank(x) - rank(y)).map(([g, secs], gi) => {
      const box = el('div', 'settings-nav-group');
      box.dataset.group = g;
      const head = el('button', 'settings-nav-head');
      head.type = 'button';
      const listId = `settings-group-${gi}`;
      head.setAttribute('aria-controls', listId);
      const info = SETTINGS_GROUPS.find((x) => x.name === g);
      head.append(lineIcon(info?.icon ?? 'M4 6h16M4 12h16M4 18h16', 'sng-icon'), el('span', 'sng-name', t(g)), el('span', 'sng-count', String(secs.length)), lineIcon('M9 6l6 6-6 6', 'sng-chev'));
      const items = el('div', 'settings-nav-items');
      items.id = listId;
      // SETTINGS3: the group's name opens its first page (and shows its pages under it).
      head.addEventListener('click', () => {
        const open = !box.classList.contains('open');
        setGroupOpen(box, open);
        // Phones drill down: Settings › group (its pages listed here) › page.
        const wide = typeof matchMedia === 'function' && matchMedia('(min-width: 721px)').matches;
        if (open && wide && !box.querySelector('[aria-current="true"]')) showSettingsTab(secs[0].dataset.page, { focus: true });
      });
      for (const sec of secs) {
        if (SETTINGS_SUB[sec.dataset.page]) items.append(el('div', 'settings-nav-sub', t(SETTINGS_SUB[sec.dataset.page])));
        const b = el('button', 'settings-nav-item', t(sec.dataset.title));
        b.type = 'button';
        b.dataset.page = sec.dataset.page;
        b.addEventListener('click', () => {
          if ($('#settings-search').value) {
            $('#settings-search').value = '';
            clearSettingsSearch();
          }
          showSettingsTab(sec.dataset.page, { focus: true });
        });
        items.append(b);
      }
      box.append(head, items);
      setGroupOpen(box, false, false);
      return box;
    }),
  );
}
/**
 * V3 §2: the Settings home: every page under its group's name and one-line purpose. Drawn each time it
 * opens (the language, the member's pages and the demo's pages can change).
 */
export function buildSettingsHome() {
  const box = $('#settings-home');
  if (!box) return;
  const grid = el('div', 'sh-grid');
  for (const { group, desc, pages } of homeModel(settingsPages(), order)) {
    const sec = el('section', 'sh-group');
    sec.dataset.group = group;
    const info = SETTINGS_GROUPS.find((x) => x.name === group);
    const h = el('h3', 'sh-head');
    h.append(lineIcon(info?.icon ?? 'M4 6h16M4 12h16M4 18h16', 'sh-icon'), el('span', '', t(group)));
    const list = el('ul', 'sh-list');
    for (const p of pages) {
      const b = el('button', 'sh-link');
      b.type = 'button';
      b.dataset.page = p.dataset.page;
      const lead = t(ctx.help()[p.dataset.page]?.[0] ?? '');
      b.append(el('span', 'sh-title', t(p.dataset.title)), ...(lead ? [el('span', 'sh-lead', lead)] : []), lineIcon('M9 6l6 6-6 6', 'sh-chev'));
      b.addEventListener('click', () => showSettingsTab(p.dataset.page, { focus: true }));
      const li = el('li');
      li.append(b);
      list.append(li);
    }
    sec.append(h, el('p', 'sh-desc', t(desc)), list);
    grid.append(sec);
  }
  box.replaceChildren(el('p', 'sh-intro', t('Every page, by topic. Search finds any setting by its name, its tip or a word you would use.')), grid);
}
/** The sections of a host page on screen (its merged pages), in SETTINGS_ORDER. */
export const partsOf = (page) => (page ? [...document.querySelectorAll(`#settings .settings-page[data-host="${page.dataset.page}"]`)].filter((p) => !p.hidden).sort((x, y) => order(x) - order(y)) : []);
/** A merged page's own heading at the top of its section (its old page title). */
function partHead(sec) {
  if (sec.querySelector(':scope > .s3-section-head')) return;
  const h = el('p', 's3-section-head', t(sec.dataset.title));
  h.setAttribute('role', 'heading');
  h.setAttribute('aria-level', '3');
  h.id = `s3-part-${sec.dataset.page}`;
  sec.prepend(h);
}
/** V3 §2: Settings › group (› Apps and services) above a page's title (empty on the home and in search results). */
export function paintCrumbs(page) {
  // SETTINGS3 S1/S2: the page on screen and its merged sections sit in cards at their headings;
  // "On this page" lists them.
  const toc = $('#settings-toc');
  if (toc) toc.hidden = true;
  if (page?.isConnected) {
    const parts = partsOf(page);
    for (const p of parts) partHead(p);
    for (const p of [page, ...parts]) cardify(p, t);
    paintToc(toc, [page, ...parts], t);
  }
  const nav = $('#settings-crumbs');
  if (!nav) return;
  if (!page) return void nav.replaceChildren();
  const parts = [];
  // The page's own name is the title right under the crumbs, so the trail stops at its parent.
  for (const [i, c] of crumbsFor(page, (id) => document.querySelector(`#settings .settings-page[data-page="${id}"]`)?.dataset.title ?? id).filter((c) => c.to).entries()) {
    if (i) {
      const sep = el('span', 'sc-sep', '›');
      sep.setAttribute('aria-hidden', 'true');
      parts.push(sep);
    }
    const b = el('button', 'sc-link', t(c.label));
    b.type = 'button';
    b.addEventListener('click', () => showSettingsTab(c.to, { focus: true }));
    parts.push(b);
  }
  nav.replaceChildren(...parts);
}

/** Opens the group of the page on screen (and closes the others: S1). */
export function openGroupOf(page) {
  const box = document.querySelector(`#settings-nav-list [data-page="${entryOf(page)}"]`)?.closest('.settings-nav-group');
  if (box && !box.classList.contains('open')) setGroupOpen(box, true);
}
export function clearSettingsSearch() {
  $('.settings-pages').classList.remove('searching');
  if ($('#settings-hits')) $('#settings-hits').hidden = true;
  $('#settings-results').hidden = true;
  $('#settings-results-back').hidden = true;
  $('#settings-elsewhere').hidden = true;
  for (const x of document.querySelectorAll('#settings-nav-list .dim, #settings-nav-list .no-match')) x.classList.remove('dim', 'no-match');
  const last = localStorage.getItem('sara.settingsPage');
  const keep = document.querySelector(`#settings-nav-list [data-page="${last ? entryOf(last) : ''}"]`)?.closest('.settings-nav-group');
  for (const g of document.querySelectorAll('#settings-nav-list .settings-nav-group')) setGroupOpen(g, g === keep, false);
  $('#settings-nav-list').classList.remove('searching');
}

// Search: every word may match a page's title, group, description, labels, tips or text.
// Phase 128 (PL2b, N30): one index for Settings and Ctrl+K (web/settings-search.js): page keywords
// and synonyms, the pages' "How do I…?" questions, ranked name → question → label, and *Elsewhere*
// (Planner tabs and chat commands). The list keeps up (only matching pages, their groups opened).
/** A page's headline words: title, group, description, headings, labels and tips. */
function settingsHeadText(p) {
  const bits = [t(p.dataset.title), p.dataset.title, t(p.dataset.group), t(ctx.help()[p.dataset.page]?.[0] ?? '')];
  for (const n of p.querySelectorAll('h3, h4, label, legend, summary, [data-tip], [aria-label], [placeholder]')) bits.push(n.matches('h3, h4, label, legend, summary') ? n.textContent : '', n.dataset.tip ?? '', n.getAttribute('aria-label') ?? '', n.getAttribute('placeholder') ?? '');
  return foldText(bits.join(' '));
}
// PL2d fix: `.settings-page` (the nav button with the same data-page comes first and has no group).
const wasGroup = (page) => Object.keys(SETTINGS_WAS).find((g) => SETTINGS_WAS[g].includes(page) && document.querySelector(`#settings .settings-page[data-page="${page}"]`)?.dataset.group !== g) ?? '';
/** The search record of a Settings page (web/settings-search.js). */
function settingsRecord(p, headOf = settingsHeadText, bodyOf = (p) => foldText(`${p.textContent} ${pageLead(p.dataset?.page)?.textContent ?? ''}`)) {
  const page = p.dataset.page;
  const was = wasGroup(page);
  return {
    p,
    id: page,
    title: foldText(`${t(p.dataset.title)} ${p.dataset.title}`),
    group: foldText(`${t(p.dataset.group)} ${p.dataset.group}`),
    was: was ? foldText(`${WAS_WORDS[was]()} ${was}`) : '',
    keywords: (SETTINGS_KEYWORDS[page] ?? []).map(foldText),
    questions: (howtoFor(page) ?? []).map((x) => foldText(`${t(x.q)} ${x.q}`)),
    head: headOf(p),
    body: bodyOf(p),
  };
}
/** The pages that match a search, best first. */
export function matchSettings(q, pages, headOf, bodyOf) {
  return rankPages(q, pages.map((p) => settingsRecord(p, headOf, bodyOf))).map((r) => r.p);
}
// The pages' order in the page (restored after a search, which shows the best match first).
let SETTINGS_DOM_ORDER = [];
export function restoreSettingsOrder() {
  const box = $('.settings-pages');
  const empty = $('#settings-empty');
  for (const sec of SETTINGS_DOM_ORDER) box.insertBefore(sec, empty);
}
/** Elsewhere: the Planner tabs and chat commands that match (one click opens them). */
export function paintElsewhere(raw) {
  const box = $('#settings-elsewhere');
  const hits = raw ? rankElsewhere(raw, isMember() ? [] : slashCommands()) : [];
  // Q2: for one release the old group names say where their pages went.
  const moved = raw ? Object.keys(SETTINGS_WAS).filter((g) => foldText(raw).trim().length >= 4 && [WAS_WORDS[g](), g].some((w) => foldText(w).startsWith(foldText(raw).trim()))) : [];
  box.replaceChildren();
  box.hidden = !hits.length && !moved.length;
  if (box.hidden) return;
  for (const g of moved) {
    const now = [...new Set(SETTINGS_WAS[g].map((id) => document.querySelector(`#settings .settings-page[data-page="${id}"]`)?.dataset.group).filter((x) => x && x !== g))];
    if (!now.length) continue;
    const groups = now.map((x) => t(x)).join(', ');
    box.append(el('p', 'muted small se-moved', WAS_S3.has(g) ? t('{old} is gone: its pages are now in {groups}.', { old: WAS_WORDS[g](), groups }) : t('Some {old} pages moved in 2.61.1, to {groups}.', { old: WAS_WORDS[g](), groups })));
  }
  if (!hits.length) return;
  box.append(el('h3', 'se-head', t('Elsewhere')));
  const list = el('div', 'se-list');
  for (const h of hits) {
    const b = el('button', 'ghost se-item');
    b.type = 'button';
    // 3.3.0 (ezplain): an everyday place ("delete a chat") says where it is in the app language.
    const detail = h.id === 'howto:delete-chat' ? t('In the list of chats, press ⋯ next to the chat, then Delete.') : h.detail;
    b.append(el('span', 'se-label', h.label.map((x) => (x.startsWith('/') ? x : t(x))).join(' → ')), ...(detail ? [el('span', 'muted small se-detail', detail)] : []));
    b.addEventListener('click', () => void openSearchPlace(h.id));
    list.append(b);
  }
  box.append(list);
}

/** Called by app.js where this code used to be, so everything runs in the same order as before. */
/** A page's place in the rail order (Apps and services draws its tiles in it). */
export const settingsOrderOf = order;
export function initSettingsNav(c) {
  ctx = c;
  // SETTINGS3: a merged page's section follows its host in the page (index.html keeps each section where
  // it was, so tips and tests read them as before).
  const all = [...document.querySelectorAll('#settings .settings-pages > .settings-page')];
  for (const host of all) {
    const parts = all.filter((p) => p.dataset.host === host.dataset.page).sort((x, y) => order(x) - order(y));
    if (parts.length) host.after(...parts);
  }
  SETTINGS_DOM_ORDER = [...document.querySelectorAll('#settings .settings-pages > .settings-page')];
}

/**
 * SETTINGS3 S4: opens a setting found by search: its page (Advanced unfolded), the control scrolled into
 * view and its row highlighted for 2 s. Choosing never changes the setting.
 */
export function jumpToSetting(page, id) {
  showSettingsTab(page, { focus: false, searchResult: true });
  $('#settings-hits').hidden = true;
  $('#settings-results').hidden = true;
  $('#settings-elsewhere').hidden = true;
  $('#settings-results-back').hidden = false;
  requestAnimationFrame(() => {
    const c = document.getElementById(id);
    if (!c || !showMe(`#${CSS.escape(id)}`)) return;
    const row = rowOf(c);
    row.classList.remove('s3-hit');
    void row.offsetWidth;
    row.classList.add('s3-hit');
    setTimeout(() => row.classList.remove('s3-hit'), 2000);
  });
}
/** The single settings that match (label, where it lives, its value now), above the pages. */
function paintHits(raw, pages) {
  const box = $('#settings-hits');
  if (!box) return 0;
  const groupOf = (p) => t(p.dataset.group);
  const titleOf = (p) => {
    const host = p.dataset.host && pages.find((x) => x.dataset.page === p.dataset.host);
    return t((host ?? p).dataset.title);
  };
  const hits = rankControls(raw, controlRecords(pages, (p) => `${groupOf(p)} › ${titleOf(p)}`, t));
  box.replaceChildren();
  box.hidden = !hits.length;
  if (!hits.length) return 0;
  const list = el('div', 's3-hit-list');
  for (const h of hits) {
    const b = el('button', 's3-hit-item');
    b.type = 'button';
    b.dataset.control = h.id;
    const text = el('span', 's3-hit-text');
    text.append(el('span', 's3-hit-label', h.label), el('span', 's3-hit-path', h.path));
    b.append(text, ...(h.value ? [el('span', 's3-hit-value', h.value)] : []));
    b.addEventListener('click', () => jumpToSetting(h.page, h.id));
    list.append(b);
  }
  box.append(el('h3', 's3-hits-head', t('Settings')), list, el('h3', 's3-hits-head', t('Pages')));
  return hits.length;
}

/** Metadata only: choosing a result never dispatches a settings input/change event. */
export function paintSettingsResults(raw, { focus = false } = {}) {
  const pages = settingsPages();
  const ranked = matchSettings(raw, pages);
  for (const p of document.querySelectorAll('#settings .settings-page')) p.hidden = true;
  if ($('#settings-home')) $('#settings-home').hidden = true;
  if ($('#settings-overview')) $('#settings-overview').hidden = true;
  if ($('#settings-services')) $('#settings-services').hidden = true;
  paintCrumbs(null);
  const box = $('#settings-results');
  box.replaceChildren(...ranked.map((p) => {
    const a = el('a', 'settings-result');
    a.href = '/' + '#' + `view=settings:${p.dataset.page}`;
    a.dataset.result = p.dataset.page;
    a.append(el('span', 'muted small', `${t(p.dataset.group)} › ${t(p.dataset.title)}`), el('strong', '', t(p.dataset.title)), el('span', 'muted small', t(ctx.help()[p.dataset.page]?.[0] ?? p.dataset.title)));
    a.addEventListener('click', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      box.dataset.last = p.dataset.page;
      showSettingsTab(p.dataset.page, { focus: true, searchResult: true });
      box.hidden = true;
      $('#settings-elsewhere').hidden = true;
      $('#settings-results-back').hidden = false;
    });
    return a;
  }));
  box.hidden = false;
  $('#settings-results-back').hidden = true;
  const controls = paintHits(raw, pages);
  paintElsewhere(raw);
  $('#settings-page-title').textContent = ranked.length === 1 ? t('1 page with “{q}”', { q: raw }) : t('{n} pages with “{q}”', { n: ranked.length, q: raw });
  $('#settings-page-desc').hidden = true;
  $('#settings-howto').replaceChildren();
  $('#settings-empty').hidden = ranked.length > 0 || controls > 0 || !$('#settings-elsewhere').hidden;
  $('#settings').classList.add('page-open');
  if (focus) (box.querySelector(`[data-result="${box.dataset.last}"]`) ?? box.querySelector('a') ?? $('#settings-search')).focus();
}
