// W4.6 (docs/RECORDS.md): Library → Public records report (the owner's only, personal use only).
// He types a name (and/or address, phone, email, username, city, state); she searches free public
// sources on the server (never from this page), and the report shows here by section with a
// confidence per match, the link and date seen for every fact, "Not found" sections, Find more
// sources and Download PDF. Below it, the places-to-search list he can edit. Polls while it works.
import { serverText, t } from './naming.js';

const $ = (s) => document.querySelector(s);
const POLL_MS = 1500;
let current = null;
let timer = null;

const SECTION = () => ({
  social: t('Profiles and social media'),
  news: t('News and mentions'),
  court: t('Court records'),
  property: t('Property records'),
  business: t('Business registrations'),
  web: t('Other public pages'),
});
const CONF = () => ({ high: t('High confidence'), medium: t('Medium confidence'), low: t('Low confidence') });
const WHY = () => ({ name: t('name'), city: t('city'), state: t('state'), phone: t('phone'), email: t('email'), username: t('username'), address: t('address') });
const PLACE_STATUS = () => ({ works: t('Works'), new: t('Not tried yet'), failing: t('Failing'), paid: t('Wants payment'), off: t('Off') });
const SOURCE_STATUS = () => ({
  read: t('read'),
  preview: t('search preview only (sign-in site)'),
  broker: t('skipped: paid broker'),
  robots: t('skipped: the site asks robots not to read it'),
  'bot-wall': t('not read: bot check'),
  paid: t('not used: wants payment'),
  'sign-in': t('not read: sign-in wall'),
  failed: t('could not be read'),
  'not-found': t('page not found'),
  'no-match': t('read, no match'),
});

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/api${path}`, { method, headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data;
}
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    const me = e.currentTarget;
    void (async () => {
      me.disabled = true;
      try {
        await onClick();
      } catch (err) {
        status(err.message, true);
      } finally {
        me.disabled = false;
      }
    })();
  });
  return b;
};
const status = (text, bad = false) => {
  const s = $('#prr-status');
  if (!s) return;
  s.textContent = text;
  s.classList.toggle('error', bad);
};
const stopPolling = () => {
  if (timer) clearTimeout(timer);
  timer = null;
};
const link = (href, text) => {
  const a = el('a', '', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
};

export function openRecords(id = null) {
  const lib = $('#library');
  if (lib && !lib.open) lib.showModal();
  for (const sel of ['#lib-home', '#lib-doc', '#lib-research', '#lib-topics', '#lib-meetings', '#lib-study', '#lib-media', '#lib-scan', '#lib-journal', '#lib-apps']) {
    const n = $(sel);
    if (n) n.hidden = true;
  }
  $('#lib-records').hidden = false;
  current = id;
  status('');
  void render();
}

async function render() {
  stopPolling();
  const host = $('#prr-body');
  if (!host || $('#lib-records').hidden) return;
  try {
    const all = await api('/records');
    drawPlaces(all.places ?? []);
    if (!current) {
      host.replaceChildren(pastReports(all.reports ?? []));
      return;
    }
    const { report, sections } = await api(`/records/${encodeURIComponent(current)}`);
    host.replaceChildren(drawReport(report, sections), pastReports((all.reports ?? []).filter((r) => r.id !== report.id)));
    if (report.status === 'running') timer = setTimeout(() => void render(), POLL_MS);
  } catch (err) {
    status(err.message, true);
  }
}

function pastReports(list) {
  const box = el('div', 'prr-past');
  if (!list.length) return box;
  box.append(el('h3', '', t('Earlier reports')));
  const ul = el('ul', 'prr-list');
  for (const r of list) {
    const li = el('li');
    const open = el('button', 'linklike', r.subject);
    open.type = 'button';
    open.addEventListener('click', () => {
      current = r.id;
      void render();
    });
    li.append(open, el('span', 'muted small', ` · ${new Date(r.createdAt).toLocaleDateString()} · ${t('{n} facts', { n: r.facts })}`));
    ul.append(li);
  }
  box.append(ul);
  return box;
}

function drawReport(r, sections) {
  const box = el('article', 'prr-report');
  const head = el('div', 'prr-head');
  head.append(el('h3', '', t('Report: {who}', { who: r.subject })));
  const line =
    r.status === 'running' ? t('Searching free public sources… {n} facts so far.', { n: r.facts.length }) : r.status === 'refused' ? r.refusal || t('Refused.') : r.status === 'failed' ? t('The search stopped: {why}', { why: r.error || '' }) : t('{n} facts from {sites} sites, {searches} searches, round {round}.', { n: r.facts.length, sites: new Set(r.facts.map((f) => f.domain)).size, searches: r.searches.length, round: r.rounds });
  head.append(el('p', r.status === 'refused' ? 'prr-refused' : 'muted small', line));
  const acts = el('p', 'prr-acts');
  if (r.status === 'running') acts.append(btn(t('Stop'), 'ghost small', async () => (await api(`/records/${r.id}/stop`, { body: {} }), render())));
  if (r.status !== 'running' && r.status !== 'refused') {
    acts.append(btn(t('Find more sources'), 'small', async () => (await api(`/records/${r.id}/more`, { body: {} }), status(t('Looking for more sources…')), render())));
    acts.append(link(`/api/records/${r.id}/pdf`, t('Download PDF')));
  }
  acts.append(
    btn(t('Delete report'), 'ghost small', async () => {
      if (!confirm(t('Delete this report?'))) return;
      await api(`/records/${r.id}`, { method: 'DELETE' });
      current = null;
      await render();
    }),
  );
  head.append(acts);
  box.append(head);
  if (r.status === 'refused') return box;
  const labels = SECTION();
  const conf = CONF();
  const why = WHY();
  for (const s of sections) {
    const sec = el('section', 'prr-sec');
    sec.append(el('h4', '', labels[s.type] ?? s.label));
    if (s.notFound) sec.append(el('p', 'muted small', r.status === 'running' ? t('Nothing yet.') : t('Not found in the free public sources searched.')));
    const ul = el('ul', 'prr-facts');
    for (const f of s.facts) {
      const li = el('li', `prr-fact c-${f.confidence}`);
      const top = el('div', 'prr-fact-top');
      top.append(el('span', `prr-chip c-${f.confidence}`, conf[f.confidence]), el('strong', '', f.title));
      li.append(top, el('q', 'prr-quote', f.quote));
      const meta = el('p', 'muted small prr-meta');
      meta.append(link(f.url, f.domain), ` · ${t('seen {date}', { date: f.seen })} · ${t('matched: {what}', { what: f.why.map((w) => why[w] ?? w).join(', ') })}`);
      if (f.cross) meta.append(` · ${t('also on {n} other sites', { n: f.cross })}`);
      if (f.via === 'preview') meta.append(` · ${t('search preview only')}`);
      li.append(meta);
      ul.append(li);
    }
    sec.append(ul);
    box.append(sec);
  }
  const det = el('details', 'prr-sources');
  det.append(el('summary', '', t('Sources ({n})', { n: r.sources.length })));
  const ol = el('ol');
  const word = SOURCE_STATUS();
  for (const s of r.sources) {
    const li = el('li');
    li.append(link(s.url, s.title || s.domain), el('span', 'muted small', ` · ${s.seen} · ${word[s.status] ?? s.status}`));
    ol.append(li);
  }
  det.append(ol);
  const qs = el('details', 'prr-sources');
  qs.append(el('summary', '', t('Searches run ({n})', { n: r.searches.length })));
  const ul = el('ul');
  for (const s of r.searches) ul.append(el('li', 'small', `${s.q} · ${t('{n} results', { n: s.results })}`));
  qs.append(ul);
  box.append(det, qs);
  return box;
}

function drawPlaces(places) {
  const host = $('#prr-places');
  if (!host) return;
  const labels = SECTION();
  const word = PLACE_STATUS();
  const rows = [...places].sort((a, b) => (a.status === 'off') - (b.status === 'off') || b.hits - a.hits);
  const ul = el('ul', 'prr-place-list');
  for (const p of rows) {
    const li = el('li', `prr-place s-${p.status}`);
    const top = el('div', 'prr-place-top');
    top.append(el('strong', '', p.domain), el('span', `prr-chip s-${p.status}`, word[p.status] ?? p.status));
    const info = el('p', 'muted small', `${p.types.map((x) => labels[x] ?? x).join(', ')} · ${p.region === 'any' ? t('anywhere') : p.region} · ${t('{n} hits', { n: p.hits })}${p.origin === 'learned' ? ` · ${t('learned')}` : ''}`);
    const holds = el('p', 'small', p.holds);
    const acts = el('p', 'prr-place-acts');
    acts.append(
      btn(p.status === 'off' ? t('Turn on') : t('Turn off'), 'ghost small', async () => {
        await api(`/records/places/${p.id}`, { method: 'PUT', body: { ...p, status: p.status === 'off' ? 'new' : 'off' } });
        await render();
      }),
      btn(t('Edit'), 'ghost small', async () => {
        const holdsNew = prompt(t('What it holds'), p.holds);
        if (holdsNew === null) return;
        const how = prompt(t('How to search it (use {name}, {city}, {state}, {phone}, {email}, {username} or {address})'), p.how);
        if (how === null) return;
        await api(`/records/places/${p.id}`, { method: 'PUT', body: { ...p, holds: holdsNew, how } });
        await render();
      }),
      btn(t('Remove'), 'ghost small', async () => {
        await api(`/records/places/${p.id}`, { method: 'DELETE' });
        await render();
      }),
    );
    li.append(top, info, holds, el('p', 'muted small prr-how', p.how), acts);
    ul.append(li);
  }
  host.replaceChildren(ul);
}

async function start() {
  const body = {};
  for (const k of ['name', 'city', 'state', 'address', 'phone', 'email', 'username', 'age']) {
    const v = $(`#prr-${k}`)?.value?.trim();
    if (v) body[k] = v;
  }
  try {
    status(t('Searching free public sources…'));
    const { report } = await api('/records', { body });
    current = report.id;
    await render();
  } catch (err) {
    status(err.message, true);
  }
}

async function addPlace() {
  const domain = $('#prr-p-domain').value.trim();
  if (!domain) return status(t('Type the site first, like courtlistener.com.'), true);
  try {
    await api('/records/places', { body: { domain, types: [$('#prr-p-type').value], region: $('#prr-p-region').value.trim() || 'any', holds: $('#prr-p-holds').value.trim() } });
    $('#prr-p-domain').value = '';
    $('#prr-p-holds').value = '';
    status(t('Place added.'));
    await render();
  } catch (err) {
    status(err.message, true);
  }
}

export function initRecords() {
  const sec = $('#lib-records');
  if (!sec) return;
  $('#lib-records-open')?.addEventListener('click', () => openRecords());
  $('#prr-back')?.addEventListener('click', () => {
    stopPolling();
    sec.hidden = true;
    $('#lib-home').hidden = false;
  });
  $('#prr-start')?.addEventListener('click', () => void start());
  $('#prr-p-add')?.addEventListener('click', () => void addPlace());
  // Stop polling when the view is hidden (Library closed or another view opened).
  new MutationObserver(() => {
    if (sec.hidden) stopPolling();
  }).observe(sec, { attributes: true, attributeFilter: ['hidden'] });
}
