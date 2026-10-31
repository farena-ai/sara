// Phase 98 (ST3): Settings → Abilities → Plugins (docs/design/STAPLES.md §6.11, docs/PLUGINS.md).
// A card per plugin: name, version, which companions it is on for, the fence chip, the last thing it
// did, and a ⋯ menu (settings, log, check for updates, roll back, remove). Add a plugin: a .zip, a
// git address or a folder on the server, then the review card (the shared proposal card): every
// permission in plain words, riskiest first, the scan, the files and the hash, and where the server
// can't fence plugins in, the "I trust this plugin's author" tick. In the chat: plugin notes and
// cards, labelled with the plugin's name. Nothing a plugin sends is ever used as markup or script.
import { serverText, t } from './naming.js';
import { icon } from './icons.js';
import { overflowMenu } from './tidy.js';
import { proposalCard } from './proposal-card.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => void onClick(b));
  return b;
}
async function api(path, opts = {}) {
  const raw = opts.raw !== undefined;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: raw ? { 'content-type': 'application/zip' } : opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: raw ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}
const enc = encodeURIComponent;
const lang = () => document.documentElement.lang || 'en';

// The review card's lines (src/plugins/manifest.ts permissionLines), in the app's language.
const PERM = {
  'Can reach {host}': (p) => t('Can reach {host}', p),
  'Can ask her to use {tool} (asks you first)': (p) => t('Can ask her to use {tool} (asks you first)', p),
  'Can use her model up to {n} times a day (billed to you)': (p) => t('Can use her model up to {n} times a day (billed to you)', p),
  'Can read your main workspace (read only)': () => t('Can read your main workspace (read only)'),
  'Can read the notes about you that other apps may see (read only)': () => t('Can read the notes about you that other apps may see (read only)'),
  'Carries chats with her for {bridge}': (p) => t('Carries chats with her for {bridge}', p),
  "Sees what you write before each reply (it can add a note for her, it can't change her rules)": () => t("Sees what you write before each reply (it can add a note for her, it can't change her rules)"),
  'Sees each step before it runs (it can stop it or make it ask you, never let it through)': () => t('Sees each step before it runs (it can stop it or make it ask you, never let it through)'),
  "Sees each step's result (it can add a card under it)": () => t("Sees each step's result (it can add a card under it)"),
  "Sees each reply after it's sent (it can add a card or a note of its own)": () => t("Sees each reply after it's sent (it can add a card or a note of its own)"),
  'Is told when your to-dos, reminders or notes change (what changed, not what they say)': () => t('Is told when your to-dos, reminders or notes change (what changed, not what they say)'),
  'Is told when a background job starts or ends': () => t('Is told when a background job starts or ends'),
  'Gets the webhooks you send to it': () => t('Gets the webhooks you send to it'),
  'Is told when a card on a board moves': () => t('Is told when a card on a board moves'),
  'Runs every day at {at}': (p) => t('Runs every day at {at}', p),
  'Runs every {n} days at {at}': (p) => t('Runs every {n} days at {at}', p),
  'Runs every hour': () => t('Runs every hour'),
  'Runs every {n} hours': (p) => t('Runs every {n} hours', p),
  'Runs every {n} minutes': (p) => t('Runs every {n} minutes', p),
  'Adds a tool: {tool} (asks you first)': (p) => t('Adds a tool: {tool} (asks you first)', p),
  'Can show cards (text, a picture and buttons, never its own code)': () => t('Can show cards (text, a picture and buttons, never its own code)'),
  'Has its own settings: {names}': (p) => t('Has its own settings: {names}', p),
  'Keeps its own files in its own folder': () => t('Keeps its own files in its own folder'),
};
export const permText = (l) => (PERM[l.key] ? PERM[l.key](l.params ?? {}) : l.key);
const lines = (ls) => (ls ?? []).map((l) => ({ id: l.id, text: permText(l), risk: l.risk }));

/** A plugin's own words in the app's language (its manifest's i18n, English fallback). */
const own = (i18n, text) => i18n?.[lang()]?.[text] ?? text;

const FENCE = {
  bwrap: () => t('Fenced in (bubblewrap)'),
  seatbelt: () => t('Fenced in (macOS sandbox)'),
  'node-only': () => t('Not fenced in'),
};
const STATE = {
  ready: () => t('Running'),
  starting: () => t('Starting'),
  waiting: () => t('Restarting after a crash'),
  crashed: () => t('Stopped: it kept crashing'),
  stopped: () => t('Off'),
};

let state = { plugins: [], companions: [], waiting: [], fence: 'node-only' };
let pending = null;
let editing = null;

function status(text) {
  const s = $('#plg-status');
  if (s) s.textContent = text ?? '';
}

export async function loadPlugins() {
  const box = $('#plg-list');
  if (!box) return;
  try {
    state = await api('/plugins');
  } catch (err) {
    $('#plg-off').hidden = false;
    $('#plg-off').textContent = err.status === 403 || err.status === 404 ? t('Plugins are off on this server.') : err.message;
    $('#plg-add').hidden = true;
    box.replaceChildren();
    return;
  }
  $('#plg-off').hidden = true;
  $('#plg-add').hidden = false;
  $('#plg-fence-note').hidden = state.fence !== 'node-only';
  renderWaiting();
  renderList();
}

function renderWaiting() {
  const box = $('#plg-waiting');
  box.replaceChildren(
    ...state.waiting.map((w) =>
      proposalCard({
        title: t('{plugin} asks her to: {what}', { plugin: w.name, what: w.summary }),
        source: t('From a plugin'),
        why: [t('A plugin asked for this on its own. Nothing runs until you say yes; it waits 10 minutes.')],
        body: [el('pre', 'prop-args small', JSON.stringify(w.args, null, 2))],
        buttons: [
          { label: t('Allow once'), onClick: (b) => void decideCall(w, true, b) },
          { label: t("Don't"), cls: 'ghost', onClick: (b) => void decideCall(w, false, b) },
        ],
      }),
    ),
  );
  $('#plg-waiting-head').hidden = !state.waiting.length;
}

async function decideCall(w, approved, b) {
  b.disabled = true;
  try {
    await api(`/plugins/${enc(w.plugin)}/calls/${enc(w.id)}`, { method: 'POST', body: { approved } });
  } catch (err) {
    status(err.message);
  }
  await loadPlugins();
}

function chip(text, cls = '') {
  return el('span', `skl-chip${cls ? ` ${cls}` : ''}`, text);
}

function lastLine(p) {
  const a = p.lastActivity;
  if (!a) return t('Nothing yet');
  const when = new Date(a.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return t('Last: {what} · {when}', { what: a.detail.slice(0, 120), when });
}

function renderList() {
  const box = $('#plg-list');
  if (!state.plugins.length) {
    box.replaceChildren(el('p', 'muted small', t('No plugins yet. Add one to give her a new ability without changing Sara itself.')));
    return;
  }
  box.replaceChildren(...state.plugins.map(pluginCard));
}

function pluginCard(p) {
  const card = el('article', `skl-card plg-card${p.status !== 'installed' ? ' off' : ''}`);
  const head = el('div', 'plg-head');
  const ic = el('span', 'skl-icon');
  ic.append(icon('tool'));
  const title = el('div', 'plg-title');
  title.append(el('strong', '', `${p.name} ${p.version}`), el('span', 'skl-desc', own(p.i18n, p.description)));
  const more = el('button', 'ghost skl-more', '⋯');
  more.type = 'button';
  more.dataset.moreId = `plg-${p.id}`;
  more.setAttribute('aria-label', t('More for {name}', { name: p.name }));
  const menu = el('div', 'tidy-items');
  menu.hidden = true;
  menu.append(
    btn(t('Settings and log'), 'ghost', () => openSettings(p)),
    btn(t('Check for updates'), 'ghost', () => updateCheck(p)),
    ...(p.canRollback ? [btn(t('Go back to {version}', { version: p.prevVersion }), 'ghost', () => rollback(p))] : []),
    btn(t('Remove'), 'ghost danger-text', () => remove(p)),
  );
  overflowMenu(more, menu);
  head.append(ic, title, more, menu);
  card.append(head);
  const chips = el('div', 'skl-chips');
  chips.append(chip(FENCE[p.fenced]?.() ?? p.fenced, p.fenced === 'node-only' ? 'warn' : ''));
  if (p.status === 'crashed') chips.append(chip(t('Switched off: it kept crashing'), 'bad'));
  if (p.status === 'disabled' && p.statusNote === 'changed') chips.append(chip(t('Switched off: its files changed'), 'bad'));
  if (p.author) chips.append(chip(t('By {who}', { who: p.author }), 'muted'));
  card.append(chips);
  const on = el('div', 'plg-companions');
  for (const c of p.companions) {
    const row = el('label', 'plg-on');
    const sw = el('span', 'skl-switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = c.on;
    input.disabled = p.status === 'disabled' && p.statusNote === 'changed';
    input.setAttribute('aria-label', t('On for {name}', { name: c.name }));
    input.addEventListener('change', () => void setOn(p, c.id, input.checked, input));
    sw.append(input, el('span', 'skl-knob'));
    row.append(sw, el('span', '', c.on ? t('On for {name}', { name: c.name }) : t('Off for {name}', { name: c.name })), el('span', 'muted small', c.on ? (STATE[c.state]?.() ?? c.state) : ''));
    on.append(row);
  }
  card.append(on, el('p', 'muted small plg-last', lastLine(p)));
  return card;
}

async function setOn(p, companion, on, input) {
  input.disabled = true;
  try {
    await api(`/plugins/${enc(p.id)}/enable`, { method: 'POST', body: { companion, on } });
    status(on ? t('{name} is on. It starts in a moment.', { name: p.name }) : t('{name} is off.', { name: p.name }));
  } catch (err) {
    status(err.message);
  }
  await loadPlugins();
}

async function updateCheck(p) {
  status(t('Looking for a new version…'));
  try {
    const r = await api(`/plugins/${enc(p.id)}/update-check`, { method: 'POST', body: {} });
    if (r.upToDate) return status(t('{name} {version} is up to date.', { name: p.name, version: r.version }));
    status('');
    openAdd();
    pending = r;
    renderReview();
  } catch (err) {
    status(err.message);
  }
}

async function rollback(p) {
  if (!confirm(t('Go back to {name} {version}?', { name: p.name, version: p.prevVersion }))) return;
  try {
    await api(`/plugins/${enc(p.id)}/rollback`, { method: 'POST', body: {} });
    status(t('Went back to {version}.', { version: p.prevVersion }));
  } catch (err) {
    status(err.message);
  }
  await loadPlugins();
}

async function remove(p) {
  if (!confirm(t('Remove {name}? Its files, its own data and its saved keys are deleted.', { name: p.name }))) return;
  try {
    await api(`/plugins/${enc(p.id)}`, { method: 'DELETE' });
    status(t('{name} was removed.', { name: p.name }));
  } catch (err) {
    status(err.message);
  }
  await loadPlugins();
}

// ---------- Add a plugin and the review card ----------

export function openAdd() {
  pending = null;
  $('#pla-url').value = '';
  $('#pla-path').value = '';
  $('#pla-file').value = '';
  $('#pla-review').replaceChildren();
  $('#pla-status').textContent = '';
  $('#pla-cancel').hidden = false;
  pickSource('zip');
  $('#plugin-add').showModal();
}

function pickSource(kind) {
  for (const b of document.querySelectorAll('#pla-sources .pick-card')) b.setAttribute('aria-checked', String(b.dataset.kind === kind));
  $('#pla-zip-row').hidden = kind !== 'zip';
  $('#pla-url-row').hidden = kind !== 'git';
  $('#pla-folder-row').hidden = kind !== 'folder';
  $('#pla-sources').dataset.kind = kind;
}

async function lookAtIt(b) {
  const kind = $('#pla-sources').dataset.kind;
  const st = $('#pla-status');
  st.textContent = t('Reading it…');
  b.disabled = true;
  try {
    if (kind === 'zip') {
      const f = $('#pla-file').files?.[0];
      if (!f) throw new Error(t('Choose a .zip file first.'));
      pending = await api(`/plugins/install?name=${enc(f.name)}`, { method: 'POST', raw: await f.arrayBuffer() });
    } else if (kind === 'git') pending = await api('/plugins/install', { method: 'POST', body: { url: $('#pla-url').value.trim() } });
    else pending = await api('/plugins/install', { method: 'POST', body: { path: $('#pla-path').value.trim() } });
    st.textContent = '';
    renderReview();
  } catch (err) {
    st.textContent = err.message;
  } finally {
    b.disabled = false;
  }
}

const FINDING = {
  injection: (f) => t('In {file}: “{text}” looks like an attempt to change her instructions.', { file: f.file, text: f.text }),
  egress: (f) => t('In {file}: sends data to {host}.', { file: f.file, host: f.host ?? '?' }),
  secret: (f) => t('In {file}: contains what looks like a key or password.', { file: f.file }),
  binary: (f) => t('{file} is not a text file.', { file: f.file }),
};

function kb(n) {
  return n < 1024 ? t('{n} bytes', { n }) : t('{n} KB', { n: Math.round(n / 102.4) / 10 });
}

/** The review card for the staged plugin (install, or an update: short when nothing new is asked). */
export function reviewCard(r, opts = {}) {
  const m = r.manifest;
  const i18n = m.i18n;
  const title = r.kind === 'update' ? (r.short ? t('{name} {version}: same permissions', { name: m.name, version: m.version }) : t('{name} {version} asks for more', { name: m.name, version: m.version })) : t('Add {name} {version}?', { name: m.name, version: m.version });
  const chips = [{ text: FENCE[r.fence]?.() ?? r.fence, cls: r.fence === 'node-only' ? 'warn' : '' }, ...(m.license ? [{ text: m.license }] : []), ...(r.current ? [{ text: t('Now: {version}', { version: r.current.version }) }] : [])];
  const why = [own(i18n, m.description)];
  if (m.author) why.push(t('By {who}', { who: m.author }));
  const warn = [];
  if (r.fence === 'node-only') warn.push(t("This computer can't fence the plugin in. Only add plugins you trust."));
  for (const f of r.findings ?? []) warn.push(FINDING[f.kind] ? FINDING[f.kind](f) : f.text);
  if (r.unknownCallTools?.length) warn.push(t('It asks for tools this server does not have: {names}', { names: r.unknownCallTools.join(', ') }));
  const body = [];
  if (!r.short) {
    const files = el('details', 'skl-body-box');
    files.append(el('summary', '', t('{n} files, {size}', { n: r.files.length, size: kb(r.size) })));
    const ul = el('ul', 'skl-files');
    for (const f of r.files) {
      const li = el('li', 'skl-file');
      li.append(el('code', '', f.path), el('span', 'muted small', kb(f.size)));
      ul.append(li);
    }
    files.append(ul, el('p', 'muted small plg-sha', t('Fingerprint (sha256): {sha}', { sha: r.sha })));
    body.push(files);
    if (m.homepage) {
      const a = el('a', 'small', t('Its home page'));
      a.href = m.homepage;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      body.push(a);
    }
  }
  if (r.needsTrust) {
    const row = el('label', 'row plg-trust');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'pla-trust';
    row.append(box, el('span', '', t("I trust this plugin's author")));
    body.push(row);
  }
  return proposalCard({
    title,
    source: t('A plugin'),
    chips,
    why,
    can: lines(r.short ? [] : r.lines),
    added: r.added,
    warn,
    body,
    buttons: opts.buttons ?? [],
  });
}

function renderReview() {
  const box = $('#pla-review');
  // The card has its own Cancel; the window's one is for before a card is shown.
  $('#pla-cancel').hidden = Boolean(pending);
  if (!pending) return box.replaceChildren();
  box.replaceChildren(
    reviewCard(pending, {
      buttons: [
        { label: pending.kind === 'update' ? t('Update') : t('Install'), onClick: (b) => void approve(b) },
        { label: t('Cancel'), cls: 'ghost', onClick: () => void cancelAdd() },
      ],
    }),
  );
}

async function approve(b) {
  if (!pending) return;
  const trust = $('#pla-trust')?.checked === true;
  if (pending.needsTrust && !trust) {
    $('#pla-status').textContent = t("Tick \"I trust this plugin's author\" first.");
    return;
  }
  b.disabled = true;
  try {
    await api(`/plugins/${enc(pending.manifest.id)}/approve`, { method: 'POST', body: { review: pending.id, trust } });
    status(pending.kind === 'update' ? t('{name} was updated.', { name: pending.manifest.name }) : t('{name} was added. It is off until you switch it on for a companion.', { name: pending.manifest.name }));
    pending = null;
    $('#plugin-add').close();
  } catch (err) {
    $('#pla-status').textContent = err.message;
  } finally {
    b.disabled = false;
  }
  await loadPlugins();
}

async function cancelAdd() {
  if (pending) await api(`/plugins/install/${enc(pending.id)}`, { method: 'DELETE' }).catch(() => {});
  pending = null;
  $('#plugin-add').close();
}

// ---------- A plugin's settings and log ----------

async function openSettings(p) {
  editing = p;
  $('#pls-heading').textContent = p.name;
  const pick = $('#pls-companion');
  pick.replaceChildren(...state.companions.map((c) => Object.assign(el('option', '', c.name), { value: c.id })));
  $('#pls-status').textContent = '';
  $('#plugin-settings').showModal();
  await renderSettings();
  await renderLog();
}

function tipButton(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', text);
  return b;
}

async function renderSettings() {
  const p = editing;
  const box = $('#pls-fields');
  let v;
  try {
    v = await api(`/plugins/${enc(p.id)}/settings?companion=${enc($('#pls-companion').value)}`);
  } catch (err) {
    box.replaceChildren(el('p', 'muted small', err.message));
    return;
  }
  const rows = v.settings.map((s) => {
    const label = el('label', s.type === 'switch' ? 'row plg-field' : 'plg-field');
    const name = el('span', '', own(p.i18n, s.label));
    let input;
    if (s.type === 'choice') {
      input = document.createElement('select');
      for (const c of s.choices) input.append(Object.assign(el('option', '', own(p.i18n, c)), { value: c }));
      input.value = String(s.value ?? '');
    } else {
      input = document.createElement('input');
      input.type = s.type === 'switch' ? 'checkbox' : s.type === 'number' ? 'number' : s.type === 'secret' ? 'password' : 'text';
      if (s.type === 'switch') input.checked = s.value === true;
      else if (s.type === 'secret') {
        input.placeholder = s.set ? t('Saved (type to replace)') : t('Not set');
        input.autocomplete = 'off';
      } else input.value = s.value ?? '';
      if (s.type === 'number') {
        if (s.min !== undefined) input.min = String(s.min);
        if (s.max !== undefined) input.max = String(s.max);
      }
    }
    input.dataset.key = s.key;
    input.dataset.type = s.type;
    input.dataset.nodirty = '';
    if (s.type === 'switch') label.append(input, name, tipButton(own(p.i18n, s.tip)));
    else {
      const head = el('span', 'plg-field-name');
      head.append(name, tipButton(own(p.i18n, s.tip)));
      label.append(head, input);
    }
    return label;
  });
  if (v.bridge) {
    const chats = el('label', 'plg-field');
    const ci = document.createElement('input');
    ci.id = 'pls-bridge-chats';
    ci.value = v.bridge.ownerChats.join(', ');
    ci.dataset.nodirty = '';
    const chatsHead = el('span', 'plg-field-name');
    chatsHead.append(el('span', '', t('Your own chat ids')), tipButton(t('Chats listed here are you: she answers as she does in the app. Find the id in the chat service; separate several with commas.')));
    chats.append(chatsHead, ci);
    const others = el('label', 'row plg-field');
    const oi = document.createElement('input');
    oi.type = 'checkbox';
    oi.id = 'pls-bridge-others';
    oi.checked = v.bridge.others;
    others.append(oi, el('span', '', t('Let other people talk to her there')), tipButton(t('Off: chats that are not yours are ignored. On: other people get her partner chat: no tools, no memory, the AI notice first.')));
    rows.push(chats, others);
  }
  if (!rows.length) rows.push(el('p', 'muted small', t('This plugin has no settings.')));
  box.replaceChildren(...rows);
  $('#pls-save').hidden = !v.settings.length && !v.bridge;
}

async function saveSettings(b) {
  const p = editing;
  const values = {};
  for (const i of document.querySelectorAll('#pls-fields [data-key]')) {
    const type = i.dataset.type;
    if (type === 'secret' && !i.value) continue;
    values[i.dataset.key] = type === 'switch' ? i.checked : type === 'number' ? Number(i.value) : i.value;
  }
  const bridge = $('#pls-bridge-chats') ? { ownerChats: $('#pls-bridge-chats').value, others: $('#pls-bridge-others').checked } : undefined;
  b.disabled = true;
  try {
    await api(`/plugins/${enc(p.id)}/settings`, { method: 'PUT', body: { companion: $('#pls-companion').value, values, ...(bridge ? { bridge } : {}) } });
    $('#pls-status').textContent = t('Saved. The plugin restarts with them.');
    await renderSettings();
  } catch (err) {
    $('#pls-status').textContent = err.message;
  } finally {
    b.disabled = false;
  }
}

const LOG_KIND = {
  hook: () => t('Hook'),
  tool: () => t('Tool'),
  call: () => t('Asked Sara'),
  denied: () => t('Refused'),
  crash: () => t('Crash'),
  timeout: () => t('Too slow'),
  log: () => t('Note'),
};

async function renderLog() {
  const box = $('#pls-log');
  try {
    const { log } = await api(`/plugins/${enc(editing.id)}/log`);
    if (!log.length) return box.replaceChildren(el('li', 'muted small', t('Nothing yet')));
    box.replaceChildren(
      ...log.slice(0, 100).map((r) => {
        const li = el('li', `plg-log-row ${r.kind}`);
        li.append(el('span', 'muted small', new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })), el('span', `skl-chip${r.kind === 'denied' || r.kind === 'crash' ? ' bad' : r.kind === 'timeout' ? ' warn' : ' muted'}`, LOG_KIND[r.kind]?.() ?? r.kind), el('span', 'plg-log-text', r.detail));
        return li;
      }),
    );
  } catch (err) {
    box.replaceChildren(el('li', 'muted small', err.message));
  }
}

// ---------- In the chat ----------

/** A plugin's card (data only: title, lines, a picture from its own folder, a link, buttons). */
export function pluginResultCard(c, opts = {}) {
  const card = el('div', 'result-card plg-result');
  const head = el('div', 'plg-result-head');
  head.append(el('span', 'plg-from small', t('From {plugin}', { plugin: c.name })));
  if (c.title) head.append(el('strong', 'plg-result-title', c.title));
  card.append(head);
  if (c.image) {
    const img = document.createElement('img');
    img.className = 'plg-result-img';
    img.alt = '';
    img.loading = 'lazy';
    img.src = `/api/plugins/${enc(c.plugin)}/file?path=${enc(c.image)}`;
    card.append(img);
  }
  for (const l of c.lines ?? []) card.append(el('p', 'plg-result-line small', l));
  if (c.link) {
    const a = el('a', 'small', t('Open the link'));
    a.href = c.link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    card.append(a);
  }
  if (c.buttons?.length) {
    const row = el('div', 'plg-result-buttons');
    for (const b of c.buttons) {
      row.append(
        btn(b.label, 'ghost', async (me) => {
          me.disabled = true;
          try {
            const r = await api(`/plugins/${enc(c.plugin)}/action`, { method: 'POST', body: { tool: b.tool, args: b.args ?? {}, companion: opts.companion } });
            card.after(r.card ? pluginResultCard(r.card, opts) : el('p', 'muted small plg-result-line', r.content));
          } catch (err) {
            card.after(el('p', 'muted small', err.message));
          } finally {
            me.disabled = false;
          }
        }),
      );
    }
    card.append(row);
  }
  return card;
}

/** A plugin's note or card posted after her reply (or from its schedule): labelled, never as her. */
export function pluginNotice(m) {
  const p = m.meta?.plugin ?? {};
  if (p.card) return pluginResultCard(p.card);
  const box = el('div', 'msg notice plg-note');
  box.append(el('span', 'plg-from small', t('From {plugin}', { plugin: p.name ?? t('a plugin') })), el('p', 'plg-note-text', p.note ?? m.content.replace(/^plugin:/, '')));
  return box;
}

/** The step line's words for what a plugin did ("Weather alerts added a note"). */
export function pluginStepWords(ev) {
  const p = { plugin: ev.name };
  if (ev.what === 'note') return t('{plugin} added a note', p);
  if (ev.what === 'asked') return t('{plugin} asked to check this step with you', p);
  if (ev.what === 'denied') return t('{plugin} stopped a step: {why}', { ...p, why: ev.text ?? '' });
  if (ev.what === 'card') return t('{plugin} added a card', p);
  if (ev.what === 'followup') return t('{plugin} added a note after her reply', p);
  if (ev.what === 'skipped') return t("{plugin} didn't answer in time (skipped)", p);
  if (ev.what === 'dropped') return t('{plugin} answered with something a plugin may not do (ignored)', p);
  return ev.name;
}

/** The plugin line on an approval card that a plugin asked for. */
export function pluginAskLine(plugin) {
  return el('p', 'plg-ask small', t('{plugin} asked to check this step with you: {why}', { plugin: plugin.name, why: plugin.reason }));
}

export function initPlugins() {
  if (!$('#plg-list')) return;
  $('#plg-add').addEventListener('click', openAdd);
  for (const b of document.querySelectorAll('#pla-sources .pick-card')) b.addEventListener('click', () => pickSource(b.dataset.kind));
  $('#pla-look').addEventListener('click', (e) => void lookAtIt(e.currentTarget));
  $('#pla-cancel').addEventListener('click', () => void cancelAdd());
  $('#pls-companion').addEventListener('change', () => void renderSettings());
  $('#pls-save').addEventListener('click', (e) => void saveSettings(e.currentTarget));
  $('#pls-refresh').addEventListener('click', () => void renderLog());
}
