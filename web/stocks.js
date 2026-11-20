// P2 (docs/design/P2STOCKS.md): the Stocks tile on Today and its bigger chart. One list: the
// stocks someone tracks and the ones they have "tell me when" alerts on (src/stock-trackers.ts).
// Prices and charts come from the server (free sources, cached there); this file only draws
// them as SVG with theme colors. Refresh is polite: a minute while the US market is open, 15
// minutes when it is closed, slower after errors, and only while Today is open.
import { t } from './naming.js';
import { changeParts, chartGeom, pollEveryMs, priceText } from './stock-chart.js';
import { layoutPrefs, savePrefs } from './today-layout.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement } | null} */
let ctx = null;
let view = null;
let charts = new Map();
let range = '1d';
let editing = false;
let adding = false;
let timer = 0;
let fails = 0;
let introDone = false;
const RANGE_KEY = 'sara.stocks.range';
const RANGES = () => [
  ['1d', '1D', t('1 day')],
  ['1w', '1W', t('1 week')],
  ['1m', '1M', t('1 month')],
  ['1y', '1Y', t('1 year')],
];
const SVG = 'http://www.w3.org/2000/svg';
const el = (tag, cls = '', text = '') => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};
const lang = () => document.documentElement.lang || undefined;
const button = (cls, text, label) => {
  const b = el('button', cls, text);
  b.type = 'button';
  if (label) {
    b.setAttribute('aria-label', label);
    b.title = label;
  }
  return b;
};

export function initStocks(c) {
  ctx = c;
  try {
    range = ['1d', '1w', '1m', '1y'].includes(localStorage.getItem(RANGE_KEY)) ? localStorage.getItem(RANGE_KEY) : '1d';
  } catch {
    /* private window */
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && tileOpen()) schedule(0);
  });
}

const tileOpen = () => {
  const tile = $('#td-stocks');
  return Boolean(tile && !tile.hidden && $('#today')?.open);
};

/** W0.6 age words: "5 minutes ago", "2 hours ago", "3 days ago". */
export function ageWords(iso, now = Date.now()) {
  const t0 = Date.parse(iso ?? '');
  if (!Number.isFinite(t0)) return '';
  const mins = Math.max(0, Math.round((now - t0) / 60_000));
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' });
  if (mins < 60) return rtf.format(-mins, 'minute');
  if (mins < 48 * 60) return rtf.format(-Math.round(mins / 60), 'hour');
  return rtf.format(-Math.round(mins / 1440), 'day');
}
const clock = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(lang(), today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};

/** Today's tile: drawn from the part (symbols only), then prices and charts load. */
export function renderStocksTile(part, tileHead) {
  const tile = $('#td-stocks');
  if (!tile) return;
  tile.hidden = false;
  tileHead?.(tile, t('Stocks'), headExtras());
  maybeIntro(part);
  if (!view) drawBody();
  schedule(0);
}

function headExtras() {
  const add = button('ghost small icon p2s-add-btn', '+', t('Add a stock tracker'));
  add.setAttribute('aria-expanded', String(adding));
  add.addEventListener('click', () => {
    adding = !adding;
    drawBody();
    if (adding) $('#p2s-q')?.focus();
  });
  return [add];
}

/** Someone who already watches stocks gets the tile once; Hide (the tile's ⋯ menu or the note) puts it away. */
function maybeIntro(part) {
  if (introDone || !part?.intro) return;
  introDone = true;
  const own = layoutPrefs()?.tiles?.['td-stocks'];
  void ctx?.api('/data-sources/stocks/intro', { method: 'POST', body: {} }).catch(() => undefined);
  if (own && own.hidden !== undefined) return;
  savePrefs({ tiles: { ...(layoutPrefs()?.tiles ?? {}), 'td-stocks': { ...(own ?? {}), hidden: false } } });
  const tile = $('#td-stocks');
  if (tile) tile.dataset.intro = '1';
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh(), ms);
}

async function refresh({ fresh = false } = {}) {
  if (!ctx || !$('#td-stocks')) return;
  if (!tileOpen() && view) return; // asks again when Today opens (renderStocksTile)
  try {
    view = await ctx.api(`/data-sources/stocks${fresh ? '?fresh=1' : ''}`);
    fails = view.error && !view.localOnly ? fails + 1 : 0;
  } catch (err) {
    fails++;
    view = view ?? { trackers: [], stale: false, localOnly: false, market: { open: false }, nextMs: pollEveryMs(false, fails), max: 12 };
    view = { ...view, error: err.message };
  }
  drawBody();
  void loadCharts();
  if (!view.localOnly) schedule(Math.max(view.nextMs ?? 0, pollEveryMs(view.market?.open, fails)));
}

async function loadCharts() {
  if (!view || view.localOnly) return;
  const want = view.trackers.slice(0, 8).map((r) => r.symbol).filter((s) => !charts.has(`${s}:${range}`) || stale(charts.get(`${s}:${range}`)));
  await Promise.all(want.map(async (s) => {
    try {
      const c = await ctx.api(`/data-sources/stocks/chart?symbol=${encodeURIComponent(s)}&range=${range}`);
      charts.set(`${s}:${range}`, { ...c, got: Date.now() });
    } catch {
      charts.set(`${s}:${range}`, { points: [], got: Date.now() });
    }
  }));
  if (want.length) drawRows();
}
const stale = (c) => Date.now() - (c?.got ?? 0) > (range === '1d' ? 5 * 60_000 : 30 * 60_000);

function drawBody() {
  const tile = $('#td-stocks');
  const box = tile?.querySelector('.td-body');
  if (!box) return;
  const kids = [];
  if (tile.dataset.intro === '1') {
    const note = el('p', 'p2s-intro small');
    const hide = button('ghost small', t('Hide'));
    hide.addEventListener('click', () => {
      delete tile.dataset.intro;
      savePrefs({ tiles: { ...(layoutPrefs()?.tiles ?? {}), 'td-stocks': { ...(layoutPrefs()?.tiles?.['td-stocks'] ?? {}), hidden: true } } });
    });
    const ok = button('ghost small', t('Keep it'));
    ok.addEventListener('click', () => {
      delete tile.dataset.intro;
      drawBody();
    });
    note.append(el('span', '', t('Shown because you watch stocks.')), ' ', ok, hide);
    kids.push(note);
  }
  const rows = view?.trackers ?? [];
  if (adding || (view && !rows.length)) kids.push(addBox(!rows.length));
  if (rows.length) {
    kids.push(rangeBar(), el('ul', 'p2s-list'));
  }
  kids.push(footLine());
  box.replaceChildren(...kids);
  drawRows();
}

function rangeBar() {
  const bar = el('div', 'p2s-ranges');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('Chart range'));
  for (const [id, short, label] of RANGES()) {
    const b = button(`p2s-range${id === range ? ' on' : ''}`, short, label);
    b.setAttribute('aria-pressed', String(id === range));
    b.addEventListener('click', () => {
      range = id;
      try {
        localStorage.setItem(RANGE_KEY, id);
      } catch {
        /* private window */
      }
      for (const x of bar.children) {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      }
      drawRows();
      void loadCharts();
    });
    bar.append(b);
  }
  const edit = button(`ghost small p2s-edit${editing ? ' on' : ''}`, editing ? t('Done') : t('Edit list'));
  edit.addEventListener('click', () => {
    editing = !editing;
    drawBody();
  });
  bar.append(edit);
  return bar;
}

function footLine() {
  const p = el('p', 'td-foot muted small p2s-foot');
  if (!view) {
    p.textContent = t('Loading…');
    return p;
  }
  if (view.localOnly) {
    p.classList.add('p2s-warn');
    p.textContent = t('Private local mode is on, so prices can’t be fetched.');
    if (view.asOf) p.textContent += ` ${t('as of {time}', { time: clock(view.asOf) })} · ${ageWords(view.asOf)}`;
    return p;
  }
  const bits = [];
  if (view.asOf) bits.push(`${t('as of {time}', { time: clock(view.asOf) })} · ${ageWords(view.asOf)}`);
  bits.push(view.market?.open ? t('Market open') : t('Market closed'));
  if (view.source) bits.push(view.source);
  p.textContent = bits.join(' · ');
  if (view.error) {
    const err = el('span', 'p2s-warn', ` ${t('Couldn’t get prices: {why}', { why: view.error })}${view.stale ? ` ${t('Showing the last prices.')}` : ''}`);
    p.append(err);
  }
  return p;
}

function spark(sym, w = 120, h = 36) {
  const c = charts.get(`${sym}:${range}`);
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, class: 'p2s-spark', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  if (!c?.points?.length) return svg;
  const first = c.points[0][1];
  const last = c.points.at(-1)[1];
  const base = range === '1d' && Number.isFinite(c.prevClose) ? c.prevClose : first;
  const g = chartGeom(c.points, { w, h, pad: 3, levels: range === '1d' && Number.isFinite(c.prevClose) ? [c.prevClose] : [] });
  svg.classList.add(last >= base ? 'up' : 'down');
  svg.append(svgEl('path', { d: g.area, class: 'p2s-area' }), svgEl('line', { x1: 0, x2: w, y1: g.y(base), y2: g.y(base), class: 'p2s-base' }), svgEl('path', { d: g.line, class: 'p2s-line', 'vector-effect': 'non-scaling-stroke' }));
  return svg;
}

function changeEl(r) {
  const c = changeParts(r.change, r.changePct);
  const span = el('span', `p2s-chg ${c.dir}`);
  if (!c.text) return span;
  span.append(el('span', 'p2s-arrow', c.arrow), ' ', el('span', '', c.text));
  span.setAttribute('aria-label', c.dir === 'up' ? t('up {text} today', { text: c.text }) : c.dir === 'down' ? t('down {text} today', { text: c.text }) : c.text);
  span.firstChild.setAttribute('aria-hidden', 'true');
  return span;
}

function drawRows() {
  const ul = $('#td-stocks .p2s-list');
  if (!ul || !view) return;
  const rows = view.trackers;
  ul.replaceChildren(...rows.map((r, i) => {
    const li = el('li', 'p2s-row');
    const main = button('p2s-open', '', t('Chart of {symbol}', { symbol: r.symbol }));
    const who = el('span', 'p2s-who');
    const symLine = el('strong', 'p2s-sym', r.symbol);
    if (r.alerts?.length) {
      const bell = el('span', 'p2s-bell', '🔔');
      bell.title = t('Your alerts');
      bell.setAttribute('aria-label', t('Your alerts'));
      symLine.append(' ', bell);
    }
    who.append(symLine, el('span', 'p2s-name muted small', r.name ?? ''));
    const price = el('span', 'p2s-price');
    price.append(el('span', 'p2s-num', priceText(r.price, lang())), changeEl(r));
    main.append(who, spark(r.symbol), price);
    main.addEventListener('click', () => void openChart(r.symbol));
    li.append(main);
    if (editing) {
      const tools = el('span', 'p2s-tools');
      const up = button('ghost small icon', '↑', t('Move up'));
      up.disabled = i === 0;
      up.addEventListener('click', () => void move(i, -1));
      const down = button('ghost small icon', '↓', t('Move down'));
      down.disabled = i === rows.length - 1;
      down.addEventListener('click', () => void move(i, 1));
      const n = r.alerts?.length ?? 0;
      const rm = button('ghost small icon p2s-rm', '✕', n ? t('Remove {symbol} and its {n} alerts', { symbol: r.symbol, n }) : t('Remove {symbol}', { symbol: r.symbol }));
      rm.addEventListener('click', () => void remove(r.symbol));
      tools.append(up, down, rm);
      li.append(tools);
    }
    return li;
  }));
}

async function move(i, dir) {
  const syms = view.trackers.map((r) => r.symbol);
  const j = i + dir;
  if (j < 0 || j >= syms.length) return;
  [syms[i], syms[j]] = [syms[j], syms[i]];
  view = { ...view, trackers: syms.map((s) => view.trackers.find((r) => r.symbol === s)) };
  drawRows();
  $(`#td-stocks .p2s-list li:nth-child(${j + 1}) button[aria-label="${dir < 0 ? t('Move up') : t('Move down')}"]`)?.focus();
  await ctx.api('/data-sources/stocks/order', { method: 'PUT', body: { symbols: syms } }).catch(() => undefined);
}

async function remove(sym) {
  try {
    await ctx.api(`/data-sources/stocks/${encodeURIComponent(sym)}`, { method: 'DELETE' });
  } catch (err) {
    status(err.message);
  }
  await refresh();
}

function status(text) {
  const s = $('#td-stocks .p2s-status');
  if (s) s.textContent = text;
}

function addBox(empty) {
  const box = el('div', 'p2s-addbox');
  if (empty) box.append(el('p', 'muted small', t('Track a stock to see its price, the day’s change and a chart here.')));
  const row = el('div', 'p2s-addrow');
  const q = el('input', 'p2s-q');
  q.id = 'p2s-q';
  q.type = 'search';
  q.autocomplete = 'off';
  q.placeholder = t('Search a company or ticker');
  q.setAttribute('aria-label', t('Search a company or ticker'));
  const go = button('small', t('Add'));
  const list = el('ul', 'p2s-hits');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('Matches'));
  const st = el('p', 'p2s-status muted small');
  st.setAttribute('role', 'status');
  let seq = 0;
  let typing = 0;
  const add = async (sym) => {
    if (!sym) return;
    go.disabled = true;
    st.textContent = t('Adding {symbol}…', { symbol: sym });
    try {
      view = await ctx.api('/data-sources/stocks', { method: 'POST', body: { symbol: sym } });
      adding = false;
      drawBody();
      void loadCharts();
    } catch (err) {
      st.textContent = err.message;
      go.disabled = false;
    }
  };
  const search = async () => {
    const text = q.value.trim();
    const n = ++seq;
    if (text.length < 1) return void list.replaceChildren();
    try {
      const r = await ctx.api(`/data-sources/stocks/search?q=${encodeURIComponent(text)}`);
      if (n !== seq) return;
      if (r.error) st.textContent = view?.localOnly ? t('Private local mode is on, so prices can’t be fetched.') : r.error;
      list.replaceChildren(...r.results.map((h) => {
        const li = el('li');
        const b = button('p2s-hit', '');
        b.setAttribute('role', 'option');
        const have = view?.trackers?.some((r) => r.symbol === h.symbol && r.tracked);
        b.append(el('strong', '', h.symbol), el('span', 'muted small', ` ${h.name}${h.exchange ? ` · ${h.exchange}` : ''}${have ? ` · ${t('on your list')}` : ''}`));
        b.disabled = Boolean(have);
        b.addEventListener('click', () => void add(h.symbol));
        li.append(b);
        return li;
      }));
      if (!r.results.length && !r.error) st.textContent = t('No matches. If you know the ticker, type it and press Add.');
      else if (!r.error) st.textContent = '';
    } catch (err) {
      st.textContent = err.message;
    }
  };
  q.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => void search(), 300);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = list.querySelector('.p2s-hit:not(:disabled) strong')?.textContent;
      const typed = q.value.trim().toUpperCase();
      void add(/^[A-Z0-9.\-^=]{1,15}$/.test(typed) ? typed : first);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list.querySelector('.p2s-hit')?.focus();
    } else if (e.key === 'Escape' && !empty) {
      e.stopPropagation();
      adding = false;
      drawBody();
    }
  });
  go.addEventListener('click', () => void add(q.value.trim().toUpperCase() || list.querySelector('.p2s-hit strong')?.textContent));
  row.append(q, go);
  box.append(row, list, st);
  return box;
}

// ---------- the bigger chart ----------

let dlgSym = '';
let dlgRange = '1d';

async function openChart(sym) {
  const dlg = $('#stock-chart');
  if (!dlg) return;
  dlgSym = sym;
  dlgRange = range;
  if (!dlg.open) dlg.showModal();
  await drawChart();
}

async function drawChart() {
  const dlg = $('#stock-chart');
  const body = $('#p2s-dlg-body');
  if (!dlg || !body) return;
  const r = view?.trackers.find((x) => x.symbol === dlgSym) ?? { symbol: dlgSym, alerts: [] };
  $('#p2s-dlg-title').textContent = r.name ? `${r.symbol} · ${r.name}` : r.symbol;
  const head = el('p', 'p2s-dlg-price');
  head.append(el('span', 'p2s-num big', priceText(r.price, lang())), ' ', changeEl(r));
  const bar = el('div', 'p2s-ranges');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('Chart range'));
  for (const [id, short, label] of RANGES()) {
    const b = button(`p2s-range${id === dlgRange ? ' on' : ''}`, short, label);
    b.setAttribute('aria-pressed', String(id === dlgRange));
    b.addEventListener('click', () => {
      dlgRange = id;
      void drawChart();
    });
    bar.append(b);
  }
  const fig = el('figure', 'p2s-big');
  fig.append(el('p', 'muted small', t('Loading…')));
  body.replaceChildren(head, bar, fig, alertsBox(r));
  let c;
  try {
    c = await ctx.api(`/data-sources/stocks/chart?symbol=${encodeURIComponent(dlgSym)}&range=${dlgRange}`);
  } catch (err) {
    fig.replaceChildren(el('p', 'p2s-warn small', view?.localOnly ? t('Private local mode is on, so prices can’t be fetched.') : err.message));
    return;
  }
  fig.replaceChildren(bigChart(c, fig.clientWidth || body.clientWidth));
}

function bigChart(c, room) {
  // Drawn at the space it gets, so the labels stay a readable size on phones.
  const w = Math.round(Math.max(280, Math.min(720, room || 640)));
  const h = w < 500 ? 200 : 240;
  const levels = (c.levels ?? []).map((l) => l.value);
  const prev = dlgRange === '1d' && Number.isFinite(c.prevClose) ? c.prevClose : null;
  const g = chartGeom(c.points, { w, h, pad: 14, levels: prev === null ? levels : [...levels, prev] });
  const first = c.points[0]?.[1];
  const last = c.points.at(-1)?.[1];
  const base = prev ?? first;
  const range = RANGES().find((x) => x[0] === dlgRange)?.[2] ?? '';
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, class: `p2s-chart ${last >= base ? 'up' : 'down'}`, role: 'img', 'aria-label': t('Price chart for {symbol}, {range}: from {a} to {b}', { symbol: c.symbol, range, a: priceText(first, lang()), b: priceText(last, lang()) }) });
  svg.append(svgEl('path', { d: g.area, class: 'p2s-area' }));
  const label = (y, text, cls) => {
    const tx = svgEl('text', { x: w - 6, y: Math.max(12, y - 4), 'text-anchor': 'end', class: cls });
    tx.textContent = text;
    return tx;
  };
  if (prev !== null) svg.append(svgEl('line', { x1: 0, x2: w, y1: g.y(prev), y2: g.y(prev), class: 'p2s-base' }), label(g.y(prev), `${t('Previous close')} ${priceText(prev, lang())}`, 'p2s-lbl'));
  for (const l of c.levels ?? []) {
    const y = g.y(l.value);
    svg.append(svgEl('line', { x1: 0, x2: w, y1: y, y2: y, class: `p2s-level ${l.when}` }), label(y, l.when === 'above' ? t('Alert above {v}', { v: priceText(l.value, lang()) }) : t('Alert below {v}', { v: priceText(l.value, lang()) }), `p2s-lbl p2s-level-lbl ${l.when}`));
  }
  svg.append(svgEl('path', { d: g.line, class: 'p2s-line' }));
  const minT = svgEl('text', { x: 4, y: h - 4, class: 'p2s-lbl' });
  minT.textContent = new Date(c.points[0]?.[0]).toLocaleString(lang(), dlgRange === '1d' ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' });
  const hi = svgEl('text', { x: 4, y: 12, class: 'p2s-lbl' });
  hi.textContent = priceText(g.max, lang());
  svg.append(minT, hi);
  const wrap = el('div', 'p2s-chart-wrap');
  const cap = el('figcaption', 'muted small', `${t('as of {time}', { time: clock(c.at) })} · ${ageWords(c.at)} · ${c.source ?? ''}`);
  wrap.append(svg, cap);
  return wrap;
}

function alertsBox(r) {
  const box = el('div', 'p2s-alerts');
  box.append(el('h3', '', t('Your alerts')));
  const ul = el('ul', 'p2s-alert-list');
  for (const a of r.alerts ?? []) {
    const li = el('li');
    li.append(el('span', '', a.when === 'above' ? t('Alert above {v}', { v: priceText(a.value, lang()) }) : a.when === 'below' ? t('Alert below {v}', { v: priceText(a.value, lang()) }) : a.label));
    const rm = button('ghost small icon', '✕', t('Remove this alert'));
    rm.addEventListener('click', async () => {
      await ctx.api(`/data-sources/watches/${a.id}`, { method: 'DELETE' }).catch(() => undefined);
      await refresh();
      await drawChart();
    });
    li.append(rm);
    ul.append(li);
  }
  if (!r.alerts?.length) ul.append(el('li', 'muted small', t('No alerts yet.')));
  const form = el('div', 'p2s-alert-add');
  const when = el('select');
  when.setAttribute('aria-label', t('Alert me when the price is'));
  for (const [v, text] of [['above', t('above')], ['below', t('below')]]) {
    const o = el('option', '', text);
    o.value = v;
    when.append(o);
  }
  const val = el('input');
  val.type = 'number';
  val.step = 'any';
  val.inputMode = 'decimal';
  val.setAttribute('aria-label', t('Price'));
  if (Number.isFinite(r.price)) val.placeholder = priceText(r.price, lang());
  const go = button('small', t('Add alert'));
  const st = el('span', 'muted small');
  st.setAttribute('role', 'status');
  go.addEventListener('click', async () => {
    const v = Number(val.value);
    if (!val.value || !Number.isFinite(v)) return void (st.textContent = t('Type a price first.'));
    try {
      await ctx.api('/data-sources/stocks/alert', { method: 'POST', body: { symbol: r.symbol, when: when.value, value: v } });
      await refresh();
      await drawChart();
    } catch (err) {
      st.textContent = err.message;
    }
  });
  form.append(el('span', 'small', t('Alert me when the price is')), when, val, go, st);
  box.append(ul, form);
  return box;
}
