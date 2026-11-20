// U4.27 (docs/MARKETPLACE.md): Settings → Skills & tools → Get more → "Shared by friends". Browse a
// community's shelf (or a linked friend's), review exactly what an item does and this server's own
// checks, install only what was reviewed; share skills, templates, automations, team recipes and Store
// add-on links; rate, comment, report; the community's owner removes listings. Owner only.
import { serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
const state = { places: [], installs: [], reports: [], items: null, place: '' };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(j, res.statusText));
  return j;
}
const KIND = { skill: 'Skill', template: 'Template', automation: 'Automation', team: 'Team recipe', addon: 'Store add-on', worker: 'Worker' };
const kindLabel = (k) => t(KIND[k] ?? k);
const say = (sel, text) => {
  const s = $(sel);
  if (s) s.textContent = text;
};
const line = (l) => t(l.t, l.p);

/** Settings → Get more opened: places, installed items and reports. */
export async function loadMarket() {
  if (!$('#mk-list')) return;
  try {
    Object.assign(state, await api('/market'));
  } catch {
    state.places = [];
  }
  const sel = $('#mk-place');
  const keep = state.place || sel.value;
  sel.replaceChildren();
  for (const p of state.places) {
    const o = el('option', '', `${p.kind === 'community' ? t('Community') : t('Friend')}: ${p.title}`);
    o.value = p.id;
    sel.append(o);
  }
  $('#mk-empty').hidden = state.places.length > 0;
  $('#mk-browse').hidden = !state.places.length;
  $('#mk-share-box').hidden = !state.places.length;
  if (state.places.some((p) => p.id === keep)) sel.value = keep;
  state.place = sel.value;
  renderInstalled();
  renderReports();
  if (state.place) await browse();
  await fillItems();
}

async function browse() {
  const list = $('#mk-list');
  $('#mk-review').hidden = true;
  list.replaceChildren(el('p', 'muted small sk-line', t('Loading…')));
  try {
    const { listings } = await api(`/market/places/${encodeURIComponent(state.place)}`);
    list.replaceChildren();
    if (!listings.length) list.append(el('p', 'muted small', t('Nothing shared here yet.')));
    for (const l of listings) list.append(card(l));
  } catch (err) {
    list.replaceChildren(el('p', 'muted small', err.message));
  }
}

function stars(r) {
  return r.n ? `★ ${r.avg} (${r.n})` : t('No ratings yet');
}
function card(l) {
  const c = el('article', 'mk-card');
  const head = el('div', 'mk-head');
  head.append(el('strong', '', l.title), el('span', 'mk-kind', kindLabel(l.kind)));
  c.append(head);
  c.append(el('p', 'muted small', t('Version {version} · by {author} · {stars}', { version: l.version, author: l.author, stars: stars(l.rating) })));
  if (l.description) c.append(el('p', 'small', l.description));
  const perms = [...(l.permissions?.tools ?? [])];
  if (perms.length) c.append(el('p', 'muted small', t('Tools: {tools}', { tools: perms.join(', ') })));
  for (const cm of l.comments ?? []) c.append(el('p', 'mk-comment small', `“${cm.text}” — ${cm.who} ${'★'.repeat(cm.stars)}`));
  const row = el('div', 'mk-actions');
  row.append(btn(l.kind === 'addon' ? t('Review the link') : l.kind === 'worker' ? t('Review and hire') : t('Review and install'), '', () => review(l)));
  row.append(btn(t('Rate'), 'ghost', () => rate(l)));
  const host = state.places.find((p) => p.id === state.place)?.host || state.place.startsWith('f:');
  if (l.mine || host) row.append(btn(l.mine ? t('Withdraw') : t('Remove'), 'ghost', () => remove(l)));
  if (!l.mine) row.append(btn(t('Report'), 'ghost', () => report(l)));
  c.append(row);
  return c;
}

async function review(l) {
  const box = $('#mk-review');
  box.hidden = false;
  box.replaceChildren(el('p', 'muted small', t('Checking it on this server…')));
  try {
    const { listing, check } = await api('/market/review', { method: 'POST', body: { place: state.place, listing: l.id } });
    box.replaceChildren();
    box.append(el('strong', '', listing.kind === 'worker' ? t('What hiring “{title}” does', { title: listing.title }) : t('What installing “{title}” does', { title: listing.title })));
    const does = el('ul', 'mk-does');
    for (const d of check.doesLines) does.append(el('li', '', line(d)));
    box.append(does);
    if (!check.ok) {
      box.append(el('p', 'mk-bad small', t('This server’s checks found problems, so it can’t be installed:')));
      const ul = el('ul', 'mk-problems');
      for (const p of check.problemLines) ul.append(el('li', '', line(p)));
      box.append(ul);
    } else box.append(el('p', 'mk-ok small', t('Checked here: no secrets, no hard-limit tools, no protected settings, size within limits, tools present.')));
    box.append(el('p', 'muted small mk-hash', t('Content hash: {hash}', { hash: String(listing.hash).slice(0, 16) })));
    const row = el('div', 'mk-actions');
    if (check.ok) row.append(btn(listing.kind === 'addon' ? t('Open in Get more') : listing.kind === 'worker' ? t('Hire') : t('Install'), '', () => install(listing)));
    row.append(btn(t('Cancel'), 'ghost', () => (box.hidden = true)));
    box.append(row);
    box.scrollIntoView?.({ block: 'nearest' });
  } catch (err) {
    box.replaceChildren(el('p', 'mk-bad small', err.message));
  }
}

async function install(listing) {
  try {
    const r = await api('/market/install', { method: 'POST', body: { place: state.place, listing: listing.id, hash: listing.hash } });
    if (r.open) {
      const q = $('#sto-q');
      if (q) {
        q.value = r.open;
        q.dispatchEvent(new Event('input', { bubbles: true }));
        q.scrollIntoView?.({ block: 'center' });
      }
      $('#mk-review').hidden = true;
      return;
    }
    if (r.installed.kind === 'worker') {
      // V3.3: hired paused; one tap to Team → Workers that stay to look it over and turn it on.
      const box = $('#mk-review');
      box.replaceChildren(el('p', 'mk-ok small', t('Hired, paused. Look it over and turn it on in Team → Workers that stay.')), btn(t('Open Workers'), '', () => {
        document.querySelector('#settings')?.close?.();
        location.hash = '#view=team';
      }));
      await loadMarket();
      $('#mk-review').hidden = false;
      return;
    }
    say('#mk-review', r.installed.kind === 'automation' ? t('Installed, paused. Turn it on in Automations when you are ready.') : t('Installed. It starts on trial; you can switch it off in Skills.'));
    await loadMarket();
  } catch (err) {
    say('#mk-review', err.message);
  }
}

async function rate(l) {
  const n = Number(prompt(t('How many stars (1 to 5)?'), '5'));
  if (!n) return;
  const comment = prompt(t('A short comment (optional):'), '') ?? '';
  try {
    await api('/market/rate', { method: 'POST', body: { place: state.place, listing: l.id, stars: n, comment } });
    await browse();
  } catch (err) {
    say('#mk-status', err.message);
  }
}
async function report(l) {
  const why = prompt(t('What is wrong with it? The community’s owner sees this.'), '');
  if (!why) return;
  try {
    await api('/market/report', { method: 'POST', body: { place: state.place, listing: l.id, why } });
    say('#mk-status', t('Reported. Thank you.'));
  } catch (err) {
    say('#mk-status', err.message);
  }
}
async function remove(l) {
  if (!confirm(t('Remove “{title}” from this shelf?', { title: l.title }))) return;
  try {
    await api('/market/remove', { method: 'POST', body: { place: state.place, listing: l.id } });
    await loadMarket();
  } catch (err) {
    say('#mk-status', err.message);
  }
}

function renderInstalled() {
  const box = $('#mk-installed');
  box.replaceChildren();
  if (!state.installs.length) box.append(el('p', 'muted small', t('Nothing installed from friends yet.')));
  for (const i of state.installs) {
    const r = el('div', 'mk-inst');
    r.append(el('span', '', `${i.title} · ${kindLabel(i.kind)} · ${i.version} · ${i.author}`));
    if (i.update) {
      r.append(el('span', 'mk-update', t('Version {version} is out', { version: i.update })));
      r.append(
        btn(t('Review the update'), 'ghost', async () => {
          state.place = i.place;
          $('#mk-place').value = i.place;
          await browse();
          await review({ id: i.listing });
        }),
      );
    }
    box.append(r);
  }
}
function renderReports() {
  const box = $('#mk-reports');
  box.replaceChildren();
  box.hidden = !state.reports.length;
  if (state.reports.length) box.append(el('strong', '', t('Reports to you')));
  for (const r of state.reports) {
    const row = el('div', 'mk-inst');
    row.append(el('span', '', t('{who} reported “{title}”: {why}', { who: r.who, title: r.title, why: r.why })));
    row.append(
      btn(t('Remove'), 'ghost', async () => {
        await api('/market/remove', { method: 'POST', body: { place: r.place, listing: r.listing } }).catch((e) => say('#mk-status', e.message));
        await loadMarket();
      }),
      btn(t('Keep it'), 'ghost', async () => {
        await api(`/market/reports/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => {});
        await loadMarket();
      }),
    );
    box.append(row);
  }
}

async function fillItems() {
  const kind = $('#mk-kind').value;
  const sel = $('#mk-item');
  const typed = kind === 'template' || kind === 'addon';
  $('#mk-item-row').hidden = typed;
  $('#mk-title-row').hidden = !typed;
  $('#mk-text-row').hidden = kind !== 'template';
  if (typed) return;
  if (!state.items) state.items = await api('/market/items').catch(() => ({ skill: [], automation: [], team: [] }));
  sel.replaceChildren();
  for (const it of state.items[kind] ?? []) {
    const o = el('option', '', it.title);
    o.value = it.ref;
    sel.append(o);
  }
  if (!sel.options.length) sel.append(Object.assign(el('option', '', t('Nothing to share yet')), { value: '' }));
}

async function share() {
  const kind = $('#mk-kind').value;
  const body = {
    place: state.place,
    kind,
    ref: kind === 'addon' ? $('#mk-title').value.trim() : $('#mk-item').value,
    title: $('#mk-title').value.trim(),
    text: $('#mk-text').value,
    version: $('#mk-version').value.trim() || '1.0.0',
    description: $('#mk-desc').value.trim(),
    tools: $('#mk-tools').value.split(/[,\s]+/).filter(Boolean),
  };
  say('#mk-status', t('Checking and sharing…'));
  try {
    await api('/market/publish', { method: 'POST', body });
    say('#mk-status', t('Shared.'));
    await browse();
  } catch (err) {
    say('#mk-status', err.message);
  }
}

export function initMarket() {
  $('#mk-place')?.addEventListener('change', (e) => {
    state.place = e.target.value;
    void browse();
  });
  $('#mk-kind')?.addEventListener('change', () => void fillItems());
  $('#mk-share')?.addEventListener('click', () => void share());
}
