// E1 (docs/DATA.md): Settings → Data sources (a provider per kind, keys, Test, the quota line and
// the person's "tell me when" watches), the Today "Watching" tile and the chat card a watch posts.
// Keys are sent once and never shown again (the server only says whether one is saved).
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, openSettings?: (page: string) => void } | null} */
let ctx = null;
let data = null;

export function initDataSources(c) {
  ctx = c;
  for (const kind of ['quote', 'sports', 'odds']) {
    $(`#ds-test-${kind}`)?.addEventListener('click', () => void testKind(kind));
    $(`#ds-${kind}`)?.addEventListener('change', () => showKeys());
  }
}

const el = (tag, cls, text) => ctx.el(tag, cls, text);

const PROVIDER_WORDS = {
  'No key. Prices can be delayed up to 15 minutes.': () => t('No key. Prices can be delayed up to 15 minutes.'),
  'No key. End-of-day and delayed prices.': () => t('No key. End-of-day and delayed prices.'),
  'Free key: 60 requests a minute, US stocks.': () => t('Free key: 60 requests a minute, US stocks.'),
  'Free key: 25 requests a day.': () => t('Free key: 25 requests a day.'),
  'No key. Scores, schedules and standings.': () => t('No key. Scores, schedules and standings.'),
  'Free test key built in (team results and next games).': () => t('Free test key built in (team results and next games).'),
  'Free key: 500 credits a month (one market in one region is one credit).': () => t('Free key: 500 credits a month (one market in one region is one credit).'),
};
const free = (s) => (PROVIDER_WORDS[s] ? PROVIDER_WORDS[s]() : s);

function quotaLine(k) {
  const q = k.quota;
  if (!q) return '';
  if (q.pausedUntil && Date.parse(q.pausedUntil) > Date.now()) return t('Free allowance used up until {when}.', { when: new Date(q.pausedUntil).toLocaleString() });
  if (q.remaining !== null && q.remaining !== undefined) return t('{n} free requests left (checked {when}).', { n: q.remaining, when: new Date(q.at).toLocaleTimeString() });
  return '';
}

function showKeys() {
  if (!data) return;
  for (const k of data.kinds) {
    const picked = $(`#ds-${k.kind}`)?.value ?? k.provider;
    for (const p of k.providers) {
      const row = $(`#ds-key-${p.id}-row`);
      if (row) row.hidden = !(p.needsKey || p.keyOptional) || p.id !== picked;
    }
  }
}

export async function loadDataSources() {
  if (!ctx || !$('#ds-quote')) return;
  try {
    data = await ctx.api('/data-sources');
  } catch {
    $('#ds-status').textContent = t('Live data is not available here.');
    return;
  }
  for (const k of data.kinds) {
    const sel = $(`#ds-${k.kind}`);
    sel.replaceChildren(...k.providers.map((p) => {
      const o = el('option', '', `${p.label} · ${p.needsKey ? t('free key') : t('no key')}`);
      o.value = p.id;
      return o;
    }));
    sel.value = k.provider;
    const p = k.providers.find((x) => x.id === k.provider);
    $(`#ds-about-${k.kind}`).textContent = [p ? free(p.free) : '', k.ready ? '' : t('Needs a key: paste it below.'), quotaLine(k)].filter(Boolean).join(' ');
    for (const x of k.providers) {
      const input = $(`#ds-key-${x.id}`);
      if (!input) continue;
      input.value = '';
      input.placeholder = x.hasKey ? t('Saved. Paste a new key to replace it.') : t('Paste your free key');
      const link = $(`#ds-key-${x.id}-get`);
      if (link && x.keyUrl) link.href = x.keyUrl;
    }
  }
  showKeys();
  renderWatchList();
}

export async function saveDataSources() {
  if (!data) return;
  const providers = {};
  for (const kind of ['quote', 'sports', 'odds']) providers[kind] = $(`#ds-${kind}`).value;
  const keys = {};
  for (const id of ['finnhub', 'alphavantage', 'theoddsapi', 'thesportsdb']) {
    const v = $(`#ds-key-${id}`)?.value.trim();
    if (v) keys[id] = v;
  }
  data = await ctx.api('/data-sources', { method: 'PUT', body: { providers, keys } });
  for (const id of Object.keys(keys)) $(`#ds-key-${id}`).value = '';
  await loadDataSources();
}

async function testKind(kind) {
  const out = $(`#ds-test-${kind}-out`);
  out.textContent = t('Checking…');
  try {
    await saveDataSources();
    const r = await ctx.api('/data-sources/test', { method: 'POST', body: { kind } });
    out.textContent = r.ok ? `✓ ${r.message}` : `✗ ${r.message}`;
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
  }
  await loadDataSources();
}

function renderWatchList() {
  const box = $('#ds-watches');
  if (!box) return;
  const list = data?.watches ?? [];
  if (!list.length) {
    box.replaceChildren(el('p', 'muted small', t('No watches yet. Ask her: “tell me when AAPL goes above 400”.')));
    return;
  }
  box.replaceChildren(...list.map((w) => {
    const row = el('div', 'ds-watch');
    row.append(el('strong', '', w.label), el('span', 'muted small', ` · ${stateWords(w)}${w.lastValue ? ` · ${w.lastValue}` : ''}`));
    if (w.lastError) row.append(el('p', 'small warn', w.lastError));
    const del = el('button', 'ghost small', t('Remove'));
    del.type = 'button';
    del.addEventListener('click', async () => {
      await ctx.api(`/data-sources/watches/${w.id}`, { method: 'DELETE' });
      await loadDataSources();
    });
    row.append(' ', del);
    return row;
  }));
}

function stateWords(w) {
  if (w.state === 'paused') return w.reason === 'quota' ? t('paused: free allowance used up') : t('paused');
  if (w.state === 'done') return t('ended');
  return w.lastCheckAt ? t('checked {when}', { when: new Date(w.lastCheckAt).toLocaleTimeString() }) : t('not checked yet');
}

/** Today: the small "Watching" tile. */
export function renderWatchingTile(part, tileHead) {
  const tile = $('#td-watching');
  if (!tile) return;
  const items = part?.items ?? [];
  tile.hidden = !items.length;
  if (!items.length) return;
  tileHead?.(tile, t('Watching'));
  tile.querySelector('.td-body').replaceChildren(...items.map((w) => {
    // E7: the calm row look of On the board (a bare button is a filled accent button: the line under it was hard to read).
    const b = el('button', 'today-item td-bd-item', '');
    b.type = 'button';
    b.addEventListener('click', () => ctx?.openSettings?.('ab-data'));
    b.append(el('span', 'td-bd-title', w.label), el('span', 'muted small td-bd-sub', w.state === 'active' ? (w.lastValue ?? t('not checked yet')) : stateWords(w)));
    return b;
  }));
}

/** The chat card a watch posts when it fires (or pauses). */
export function liveWatchNotice(m) {
  const w = m.meta?.liveWatch ?? {};
  const card = el('div', 'msg notice live-watch');
  card.append(el('strong', 'small', `🔔 ${w.label ?? t('Watch')}`), el('p', 'small', m.content.replace(/^livewatch:/, '')));
  const open = el('button', 'ghost small', t('Data sources'));
  open.type = 'button';
  open.addEventListener('click', () => ctx?.openSettings?.('ab-data'));
  card.append(open);
  return card;
}
