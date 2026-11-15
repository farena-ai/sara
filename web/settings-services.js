// SETTINGS3 S2/S5 (docs/design/SETTINGS3.md): Connections › Apps and services, the hub of the tile pages.
// Every tile is an existing Settings page (data-tile in index.html, its id unchanged): a status dot and
// one line per tile; a tile opens its page. Statuses come from endpoints that already exist (tileStatus).

/** The hub's sections, in order (English; t() at draw). */
/** Marks a string for translation (scripts/i18n-extract.ts finds t('…')); buildServices translates at draw. */
const t = (s) => s;
export const TILE_GROUPS = [
  { id: 'chat', label: t('Chat apps') },
  { id: 'accounts', label: t('Your accounts') },
  { id: 'sources', label: t('Sources') },
  { id: 'dev', label: t('For developers') },
];
/** Two letters on a tile (brands keep their usual short form). */
const MARK = Object.fromEntries('co-telegram=Tg co-discord=Dc co-whatsapp=Wa co-signal=Si co-imessage=iM co-matrix=Mx co-slack=Sl co-teams=Te co-email=@ co-pickup=Pu ab-mail=Ma ab-google=G ab-home=HA ab-github=Gh co-spotify=Sp ab-search=Ws ab-data=Ds co-apps=Ap co-agents=Ag co-hooks=Wh'.split(' ').map((x) => x.split('=')));
export const tileMark = (id, title = '') => MARK[id] ?? title.slice(0, 2);
/** A tile's caption: her own mailbox reads "Her own email" on the hub (its page keeps its title). */
const CAPTION = { 'co-email': t('Her own email') };
export const tileCaption = (id, title) => CAPTION[id] ?? title;

/**
 * The hub model: [{ id, label, tiles: [{ id, title }] }] in TILE_GROUPS order, tiles in `orderOf`.
 * `pages` are the tile pages this person may see (dataset.page/tile/title). Pure, for tests.
 */
export function servicesModel(pages, orderOf = () => 0) {
  return TILE_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    tiles: [...pages].filter((p) => p.dataset.tile === g.id).sort((a, b) => orderOf(a) - orderOf(b)).map((p) => ({ id: p.dataset.page, title: tileCaption(p.dataset.page, p.dataset.title) })),
  })).filter((g) => g.tiles.length);
}

/**
 * A tile's state from what Settings already loaded: 'on' (connected / in use), 'warn' (set up but
 * failing), 'off' (not set up). `facts` is { [pageId]: { state, line } } filled by app.js loaders.
 */
export function tileState(id, facts = {}) {
  const f = facts[id];
  if (!f) return { state: 'off', line: t('Not set up') };
  return { state: f.state ?? 'off', line: f.line ?? (f.state === 'on' ? t('Connected') : f.state === 'warn' ? t('Needs you') : t('Not set up')) };
}

/** Draws the hub into `box`. opts: { t, open(id), facts, filter: 'all'|'on'|'warn', setFilter(f) }. */
export function buildServices(box, pages, orderOf, opts) {
  if (!box) return;
  const t = opts.t ?? ((s) => s);
  const facts = opts.facts ?? {};
  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const model = servicesModel(pages, orderOf);
  const all = model.flatMap((g) => g.tiles);
  const count = (s) => all.filter((x) => tileState(x.id, facts).state === s).length;
  const filter = opts.filter ?? 'all';
  const bar = mk('div', 's3-filter');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('Show'));
  for (const [f, label, n] of [['all', t('All'), all.length], ['on', t('Connected'), count('on')], ['warn', t('Needs you'), count('warn')]]) {
    const b = mk('button', 's3-filter-opt');
    b.type = 'button';
    b.dataset.filter = f;
    b.setAttribute('aria-pressed', String(f === filter));
    b.append(mk('span', '', label), mk('span', 's3-filter-n', String(n)));
    b.addEventListener('click', () => opts.setFilter?.(f));
    bar.append(b);
  }
  const out = [bar];
  for (const g of model) {
    const tiles = g.tiles.filter((x) => filter === 'all' || tileState(x.id, facts).state === filter);
    if (!tiles.length) continue;
    const sec = mk('section', 's3-tiles');
    sec.dataset.tiles = g.id;
    const h = mk('h3', 's3-tiles-head', t(g.label));
    h.id = `s3-tiles-${g.id}`;
    sec.setAttribute('aria-labelledby', h.id);
    const grid = mk('div', 's3-tile-grid');
    for (const x of tiles) {
      const st = tileState(x.id, facts);
      const b = mk('button', 's3-tile');
      b.type = 'button';
      b.dataset.page = x.id;
      b.dataset.state = st.state;
      const mark = mk('span', 's3-tile-mark', tileMark(x.id, x.title));
      mark.setAttribute('aria-hidden', 'true');
      const text = mk('span', 's3-tile-text');
      const line = mk('span', 's3-tile-line');
      const dot = mk('span', 's3-dot');
      dot.dataset.state = st.state;
      dot.setAttribute('aria-hidden', 'true');
      line.append(dot, mk('span', '', t(st.line)));
      text.append(mk('span', 's3-tile-title', t(x.title)), line);
      const chev = mk('span', 's3-tile-chev', '›');
      chev.setAttribute('aria-hidden', 'true');
      b.append(mark, text, chev);
      b.addEventListener('click', () => opts.open(x.id));
      grid.append(b);
    }
    sec.append(h, grid);
    out.push(sec);
  }
  if (out.length === 1) out.push(mk('p', 'muted s3-tiles-none', t('Nothing here yet.')));
  box.replaceChildren(...out);
}
