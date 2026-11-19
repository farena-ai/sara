// V5.2 (docs/design/V5LEDGER.md): Settings → Privacy & system → Privacy → What left this server.
// One day at a time: every request her server sent out, grouped by why (model, search, mail...)
// with the place (host name), how many and about how much was sent. The server keeps only names
// and counts, never contents; host names are drawn as text.
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status, data });
  return data;
}

const PURPOSE = {
  model: () => [t('AI models'), t('Your messages and what she needs to answer them go to the model you picked.')],
  search: () => [t('Web search'), t('Search words go to your search service.')],
  web: () => [t('Web pages and feeds'), t('Pages, feeds and links she opened for you.')],
  mail: () => [t('Mail and calendar'), t('Reading, sorting and sending your mail, and your calendars.')],
  notifications: () => [t('Phone notifications'), t('Short alerts to your phones through Apple, Google or your browser.')],
  'chat-apps': () => [t('Chat apps'), t('Messages to and from the chat apps you connected.')],
  voice: () => [t('Voices'), t('Text read aloud or speech heard by a cloud voice service.')],
  makers: () => [t("Sara's makers"), t('The anonymous check-in, reports you sent and the Store list.')],
  github: () => ['GitHub', t('Code, issues and update checks on GitHub.')],
  'add-ons': () => [t('Add-ons'), t('Add-ons and the programs they download.')],
  'home-network': () => [t('Your home network'), t('Devices on your home network or Tailscale.')],
  other: () => [t('Other places'), t('Everything else, like weather, prices and services your add-ons use.')],
};

const ALLOWED = { updates: () => t('update checks'), 'model-downloads': () => t('model downloads') };

const lang = () => document.documentElement.lang || 'en';
function size(bytes) {
  const units = [['gigabyte', 1e9], ['megabyte', 1e6], ['kilobyte', 1e3]];
  for (const [unit, n] of units) if (bytes >= n) return new Intl.NumberFormat(lang(), { style: 'unit', unit, maximumFractionDigits: 1 }).format(bytes / n);
  return new Intl.NumberFormat(lang(), { style: 'unit', unit: 'byte', unitDisplay: 'long' }).format(bytes);
}
const num = (n) => new Intl.NumberFormat(lang()).format(n);
function dayLabel(day, today) {
  if (day === today) return t('Today');
  return new Intl.DateTimeFormat(lang(), { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00`));
}
const time = (iso) => new Intl.DateTimeFormat(lang(), { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

let wired = false;
let shownDay = null;

/** Fills the section (called when the Privacy page opens). */
export async function loadLedger(day) {
  const box = $('#pv-ledger-list');
  if (!box) return;
  if (!wired) {
    wired = true;
    $('#pv-ledger-day')?.addEventListener('change', (e) => void loadLedger(e.target.value));
    $('#pv-ledger-forget')?.addEventListener('click', () => void forget());
  }
  try {
    const want = day ?? shownDay;
    const r = await api(`/private-local/ledger${want ? `?day=${encodeURIComponent(want)}` : ''}`);
    shownDay = r.day;
    draw(r);
  } catch (err) {
    $('#pv-ledger-sum').textContent = err.status === 404 ? t('Not available on this server.') : err.message;
    box.replaceChildren();
  }
}

function draw(r) {
  const pick = $('#pv-ledger-day');
  const days = [r.today, ...r.days.map((d) => d.day).filter((d) => d !== r.today)];
  if (!days.includes(r.day)) days.push(r.day);
  pick.replaceChildren(...days.map((d) => {
    const o = el('option', '', dayLabel(d, r.today));
    o.value = d;
    return o;
  }));
  pick.value = r.day;
  const sum = $('#pv-ledger-sum');
  if (r.total.count) {
    sum.textContent = t('Requests: {count} · Places: {places} · Sent: about {size}', { count: num(r.total.count), places: num(r.total.places), size: size(r.total.bytes) });
  } else {
    sum.textContent = r.privateLocal ? t('Nothing left this server: "Nothing leaves this computer" is on.') : t('Nothing left this server on this day.');
  }
  // W5.2: the switch's state next to the evidence, with what is allowed while it is on.
  const mode = $('#pv-ledger-mode');
  if (mode) {
    const allowed = (r.localAllow ?? []).map((id) => (ALLOWED[id] ?? (() => id))());
    mode.textContent = !r.privateLocal ? t('Local-only mode is off.') : allowed.length ? t('Local-only mode is on. Allowed: {list}.', { list: allowed.join(', ') }) : t('Local-only mode is on. Nothing is allowed out.');
  }
  const box = $('#pv-ledger-list');
  const out = [];
  for (const g of r.groups) {
    const [name, why] = (PURPOSE[g.purpose] ?? PURPOSE.other)();
    const card = el('div', 'pv-lg');
    const head = el('div', 'pv-lg-head');
    head.append(el('strong', '', name), el('span', 'pv-lg-n', t('{count} requests', { count: num(g.count) })));
    card.append(head, el('p', 'muted small pv-lg-why', why));
    const list = el('ul', 'pv-lg-hosts');
    for (const h of g.hosts) {
      const li = el('li');
      const bits = [`${num(h.count)}×`];
      if (h.bytes) bits.push(size(h.bytes));
      bits.push(t('last {time}', { time: time(h.last) }));
      li.append(el('span', 'pv-lg-host', h.host), el('span', 'muted small', bits.join(' · ')));
      list.append(li);
    }
    card.append(list);
    out.push(card);
  }
  if (r.stopped?.length) {
    const card = el('div', 'pv-lg pv-lg-stopped');
    const total = r.stopped.reduce((n, s) => n + s.count, 0);
    const head = el('div', 'pv-lg-head');
    head.append(el('strong', '', t('Stopped before leaving')), el('span', 'pv-lg-n', t('{count} requests', { count: num(total) })));
    card.append(head, el('p', 'muted small pv-lg-why', t('"Nothing leaves this computer" was on, so these never left.')));
    const list = el('ul', 'pv-lg-hosts');
    for (const s of r.stopped) {
      const li = el('li');
      li.append(el('span', 'pv-lg-host', s.host), el('span', 'muted small', `${num(s.count)}×`));
      list.append(li);
    }
    card.append(list);
    out.push(card);
  }
  box.replaceChildren(...out);
  $('#pv-ledger-forget').hidden = !r.days.length;
}

async function forget() {
  if (!confirm(t('Clear the list of what left this server? Counting starts again from now.'))) return;
  try {
    await api('/private-local/ledger', { method: 'DELETE' });
    shownDay = null;
    await loadLedger();
  } catch (err) {
    $('#pv-ledger-sum').textContent = err.message;
  }
}
