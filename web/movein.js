// Phase 104 (MI1, docs/design/MOVE_IN.md §7, §12): Settings → Data & health → Move in from another
// agent. Three steps (get the collector, run it, upload the file), then what the collector packed,
// the preview (one card per destination with counts and three folded samples, the personality card
// to decide by hand, "Was this her?", held categories), Import as one batch with Stop, her report
// and Undo. Every string goes through t(); colours only through theme tokens (web/movein.css).
// Phase 105 (MI2, §8): custom stores as mapping cards: what she thinks each family of tables is,
// masked sample rows, three samples made by the real mapper, a pick-list of destinations and a
// column map (no SQL), Looks right / Skip, progress while the rows stream, and saved mappings.
import { serverText, t } from './naming.js';
import { emptyState } from './tidy.js';

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
/** A ? tip made in code (the app's tip handler opens it like the ones in the page). */
function tip(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.raw ? { 'content-type': 'application/octet-stream' } : opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}
const enc = encodeURIComponent;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const size = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

let helpers = { copyText: async () => {}, openConversation: () => {}, showSettingsTab: () => {} };
let state = { watching: false, overview: null, bundle: null, preview: null, choices: null, paused: false, uploading: null, poll: 0, cards: null, cardPoll: 0, localOnly: true, editing: {}, drafts: {}, cardBusy: false, trans: null, transPoll: 0 };

const SECTION_NAME = {
  persona: () => t('Personality'),
  memories: () => t('Memories'),
  profile: () => t('About you'),
  conversations: () => t('Past conversations'),
  skills: () => t('Skills'),
  schedules: () => t('Schedules'),
  board: () => t('Board'),
  reflections: () => t('Reflections'),
  people: () => t('People'),
  tasks: () => t('Tasks'),
  agenda: () => t('Her goals'),
};
const SECTION_TIP = {
  memories: () => t('Her notes from the old agent, sorted into facts, decisions and promises. Duplicates are merged. Over 2,000 notes, the rest arrive archived: searchable, never brought up by themselves.'),
  profile: () => t('What the old agent knew about you (USER.md). Replaced directives come along as old notes she does not use.'),
  conversations: () => t('Your old chats become past conversations with their dates. She learns facts and style from the last 90 days in the background; older ones stay readable.'),
  skills: () => t('Skill folders become her skills. Skills that run scripts stay off until you check them; nothing runs during the move.'),
  schedules: () => t('Repeating jobs become tasks with the same repeat, one-off ones reminders. Tasks never act by themselves, so nothing messages anyone from here until you say so.'),
  board: () => t('Board cards land on a board of their own, in matching columns. Cards that were running are not restarted.'),
  reflections: () => t('Her diary-like looking back (DREAMS.md). Off unless you want her to keep it.'),
  people: () => t('People cards from her old databases, each with its facts (the newest 200 active, older ones archived). Only from store cards you confirmed.'),
  tasks: () => t('Tasks from her old databases. They land in your to-do list and never act by themselves.'),
  agenda: () => t('Goals and intentions she had. They arrive paused in her own plans, which stay off until you switch them on.'),
};
const LEFT_NAME = {
  secret: () => t('Secrets: never collected (keys stay with you)'),
  log: () => t('Logs: not useful to her'),
  media: () => t('Media and models: skipped by default'),
  backup: () => t('Dated copies and backups: skipped by default'),
  'code-env': () => t('Program code and environments'),
  telemetry: () => t('Telemetry: not useful to her'),
  'sensitive-unchosen': () => t('You said no at collection'),
  'too-big': () => t('Too big for the collector'),
  'owner-never': () => t('You left these out'),
  unreadable: () => t("Couldn't be read"),
  derived: () => t('Search indexes Sara builds herself'),
  other: () => t('Not part of a move-in'),
  since: () => t('Older than your --since date'),
  'safety-layer': () => t("Lines that conflict with Sara's safety layer"),
  'minors-check': () => t('Failed the minors check (not shown)'),
};

const WHY = {
  "Sara's safety layer stays on": () => t("Sara's safety layer stays on"),
  'explicit (Adult mode is off)': () => t('explicit (Adult mode is off)'),
  'already happened': () => t('already happened'),
  'a script job: imported as a task, never run': () => t('a script job: imported as a task, never run'),
};

export function initMoveIn(h) {
  helpers = { ...helpers, ...h };
  $('#mi-copy')?.addEventListener('click', () => void helpers.copyText($('#mi-cmd').textContent, $('#mi-copy')));
  $('#mi-file')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) void upload(f);
  });
  $('#mi-pause')?.addEventListener('click', () => {
    state.paused = true;
    $('#mi-pause').hidden = true;
    $('#mi-resume').hidden = false;
  });
  $('#mi-resume')?.addEventListener('click', () => {
    state.paused = false;
    $('#mi-pause').hidden = false;
    $('#mi-resume').hidden = true;
    if (state.uploading) void upload(state.uploading);
  });
  $('#mi-map-file')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const r = await api('/movein/mappings/import', { method: 'POST', body: JSON.parse(await f.text()) });
      $('#mi-map-note').textContent = t('{n} saved mappings added.', { n: r.imported });
    } catch (err) {
      $('#mi-map-note').textContent = err.message;
    }
    await renderMappings();
  });
  $('#mi-code')?.addEventListener('click', async () => {
    try {
      const r = await api('/movein/code', { method: 'POST', body: {} });
      const line = $('#mi-codeline');
      line.textContent = `python3 sara-movein.py send YOUR-FILE.saramove --to ${location.origin} --code "${r.code}"`;
      line.hidden = false;
    } catch (err) {
      work(errorCard(err.message));
    }
  });
}

/** Server events: a bundle's state moved on. */
export function moveInEvent(ev) {
  if (!document.querySelector('[data-page="dh-movein"]:not([hidden])')) return;
  if (state.bundle && ev?.id === state.bundle) {
    if (ev.line === 'translations' && state.preview?.state === 'ready') void loadTranslations();
    else void refresh();
  }
}

export async function loadMoveIn() {
  try {
    state.overview = await api('/movein');
  } catch (err) {
    work(errorCard(err.message));
    return;
  }
  const col = state.overview.collector;
  $('#mi-cmd').textContent = col ? col.command : t('The collector is not on this server.');
  $('#mi-sha').textContent = col ? t('Collector {v}, SHA-256 {sha}', { v: col.version, sha: col.sha256 }) : '';
  renderBatches();
  void renderMappings();
  const live = state.overview.bundles.find((b) => b.state !== 'imported') ?? state.overview.bundles[0];
  if (live && !state.bundle) state.bundle = live.id;
  if (state.bundle) await refresh();
  else work();
}

function work(...nodes) {
  const w = $('#mi-work');
  if (!w) return;
  w.replaceChildren(...nodes.filter(Boolean));
}
function errorCard(msg) {
  const c = el('div', 'mi-card mi-error');
  c.append(el('p', '', msg));
  return c;
}

// ---------------------------------------------------------------------------------------------
// Step 3: the upload (8 MB pieces, resumable)
// ---------------------------------------------------------------------------------------------
async function upload(file) {
  state.uploading = file;
  const box = $('#mi-upload');
  box.hidden = false;
  const bar = $('#mi-upbar');
  const line = $('#mi-upline');
  try {
    const up = await api('/movein/uploads', { method: 'POST', body: { name: file.name, size: file.size } });
    let off = up.received ?? 0;
    while (off < file.size) {
      if (state.paused) {
        line.textContent = t('Paused at {p}%', { p: Math.floor((100 * off) / file.size) });
        return;
      }
      const piece = file.slice(off, Math.min(file.size, off + up.chunk));
      let r;
      for (let tries = 0; ; tries++) {
        try {
          r = await api(`/movein/uploads/${enc(up.id)}?offset=${off}`, { method: 'PUT', raw: piece });
          break;
        } catch (err) {
          if (tries >= 4) throw err;
          await new Promise((res) => setTimeout(res, 1500 * (tries + 1)));
          const st = await api(`/movein/uploads/${enc(up.id)}`).catch(() => null);
          if (st) off = st.received;
        }
      }
      off = r.received;
      bar.value = off / file.size;
      line.textContent = t('Uploading: {done} of {total}', { done: size(off), total: size(file.size) });
    }
    await api(`/movein/uploads/${enc(up.id)}/done`, { method: 'POST', body: {} });
    state.uploading = null;
    state.bundle = up.id;
    line.textContent = t('Uploaded. Checking the bundle…');
    box.hidden = true;
    await refresh();
  } catch (err) {
    line.textContent = err.message;
  }
}

// ---------------------------------------------------------------------------------------------
// The bundle: checking, the plan and preview, importing, done
// ---------------------------------------------------------------------------------------------
async function refresh() {
  clearTimeout(state.poll);
  if (!state.bundle) return;
  let pv;
  try {
    pv = state.choices ? await api(`/movein/bundles/${enc(state.bundle)}/preview`, { method: 'POST', body: { choices: state.choices } }) : await api(`/movein/bundles/${enc(state.bundle)}`);
  } catch (err) {
    if (err.status === 404) {
      state.bundle = null;
      state.choices = null;
      work();
      return;
    }
    work(errorCard(err.message));
    return;
  }
  state.preview = pv;
  if (['checking', 'reading', 'uploading'].includes(pv.state)) {
    work(progressCard(pv.line || t('Checking the bundle…'), false));
    state.poll = setTimeout(() => void refresh(), 1200);
    return;
  }
  if (pv.state === 'importing') {
    state.watching = true;
    work(progressCard(pv.line || t('Moving in…'), true));
    state.poll = setTimeout(() => void refresh(), 1200);
    return;
  }
  if (pv.state === 'failed') {
    const c = errorCard(pv.error || t("The bundle couldn't be read."));
    c.append(btn(t('Delete the bundle now'), 'ghost small', deleteBundle));
    work(c);
    return;
  }
  if (pv.state === 'imported') {
    // Phase 114 (B3): the batch runs in the background; when it is done her name and face are
    // re-loaded (the Import press itself only started it).
    if (state.watching) {
      state.watching = false;
      document.dispatchEvent(new CustomEvent('sara:persona-changed'));
    }
    await renderDone(pv);
    return;
  }
  state.choices ??= defaults(pv);
  renderPreview(pv);
}

function progressCard(line, stoppable) {
  const c = el('div', 'mi-card mi-progress');
  c.append(el('progress', ''), el('p', 'small', line));
  c.querySelector('progress').removeAttribute('value');
  if (stoppable) c.append(btn(t('Stop'), 'ghost small', async () => api(`/movein/bundles/${enc(state.bundle)}/stop`, { method: 'POST', body: {} })));
  return c;
}

function defaults(pv) {
  const sections = {};
  for (const [k, v] of Object.entries(pv.sections)) if (k !== 'later') sections[k] = k !== 'reflections' && (v.found > 0);
  return { herPast: true, sections, sensitive: {}, learnAll: false, persona: {} };
}

/** What the collector packed and skipped (its plan screen, as it was accepted). */
function planCard(pv) {
  const plan = pv.plan;
  const c = el('details', 'mi-card mi-plan');
  c.open = true;
  const sum = el('summary', 'mi-plan-head');
  sum.append(el('strong', '', t("Here's what the collector packed")), tip(t('The plan the collector showed on the old computer: what it packed, and what it skipped with the reason. Secrets were never opened.')));
  c.append(sum);
  if (!plan) {
    c.append(el('p', 'muted small', t('This bundle has no plan.')));
    return c;
  }
  const ul = el('ul', 'mi-plan-list');
  for (const s of plan.sections ?? []) {
    const li = el('li', 'mi-plan-row');
    li.append(el('span', 'mi-plan-key', SECTION_NAME[s.key]?.() ?? planKey(s.key)), el('span', 'mi-plan-text', s.text), el('span', 'mi-pill', s.action === 'pack' ? t('packed') : t('schema and data')));
    ul.append(li);
  }
  for (const [reason, v] of Object.entries(plan.skipped ?? {})) {
    const li = el('li', 'mi-plan-row mi-plan-skip');
    li.append(el('span', 'mi-plan-key', LEFT_NAME[reason]?.() ?? reason), el('span', 'mi-plan-text', t('{n} files, {size}', { n: v.files, size: size(v.bytes) })), el('span', 'mi-pill mi-pill-off', t('skipped')));
    ul.append(li);
  }
  c.append(ul);
  return c;
}
function planKey(k) {
  return { personality: t('Personality'), code: t('Hooks and plugins'), stores: t('Plugin stores'), config: t('Settings'), sessions: t('Past conversations') }[k] ?? k;
}

function renderPreview(pv) {
  const ch = state.choices;
  const root = el('div', 'mi-preview');
  const head = el('div', 'mi-card mi-head');
  head.append(el('h4', '', t('Moving in: {name} ({agent})', { name: pv.source.displayName, agent: pv.source.agent })), el('p', 'muted small', t('Bundle from {date}', { date: fmtDate(pv.createdAt) })));
  // "Was this her?" (§6.5)
  const her = el('fieldset', 'mi-her');
  const lg = el('legend', '', t("Is this Sara's past (she moved here), or another assistant you used?"));
  lg.append(tip(t('Yes: its replies become her own past words and its personality can replace hers. Another assistant: she keeps who she is and remembers it was someone else.')));
  her.append(lg);
  for (const [v, label] of [[true, t("Yes, it's her")], [false, t('Another assistant')]]) {
    const l = el('label', 'mi-radio');
    const r = el('input');
    r.type = 'radio';
    r.name = 'mi-her';
    r.checked = ch.herPast === v;
    r.addEventListener('change', () => {
      ch.herPast = v;
      if (!v) ch.persona = {};
      renderPreview(state.preview);
    });
    l.append(r, el('span', '', label));
    her.append(l);
  }
  head.append(her);
  root.append(planCard(pv), head);
  if (pv.persona) root.append(personaCard(pv));
  if (pv.stores?.cards) root.append(storesBox(pv));
  if (pv.translations?.config || pv.translations?.code) root.append(translationsBox());
  for (const key of ['memories', 'profile', 'people', 'conversations', 'skills', 'schedules', 'tasks', 'board', 'agenda', 'reflections']) {
    const s = pv.sections[key];
    if (!s || (!s.found && key !== 'memories')) continue;
    root.append(sectionCard(pv, key, s));
  }
  if (Object.values(pv.held).some((n) => n > 0)) root.append(heldCard(pv));
  if (pv.sections.later?.list?.length) root.append(laterCard(pv.sections.later.list));
  root.append(leftCard(pv.leftBehind));
  const go = el('div', 'mi-actions');
  const personaPending = pv.persona && !pv.persona.refused && pv.persona.drafts.length && ch.herPast && ch.persona?.decided !== true;
  const imp = btn(t('Import'), 'primary', async (b) => {
    b.disabled = true;
    try {
      await api(`/movein/bundles/${enc(state.bundle)}/import`, { method: 'POST', body: { choices: ch } });
      // Her name, picture line and companion list follow when the batch is done (see refresh).
      state.watching = true;
      await refresh();
    } catch (err) {
      b.disabled = false;
      $('#mi-note').textContent = err.message;
    }
  });
  imp.disabled = Boolean(personaPending) || Boolean(pv.stores?.busy) || Boolean(pv.translations?.busy);
  go.append(imp, btn(t('Not now'), 'ghost', async () => {
    state.choices = null;
    state.bundle = null;
    work();
  }), btn(t('Delete the bundle now'), 'ghost', deleteBundle));
  const note = el('p', 'muted small');
  note.id = 'mi-note';
  note.textContent = personaPending ? t('Decide on her personality first (above).') : pv.stores?.busy ? t('Wait for the store cards to finish.') : pv.stores?.undecided ? t('{n} store cards are not decided yet: nothing from them is imported.', { n: pv.stores.undecided }) : t('Nothing is changed until you press Import. Undo removes it all for 30 days.');
  root.append(go, note);
  work(root);
}

/** The character sheet card (§6.3): a draft from the old persona files, decided by hand. */
function personaCard(pv) {
  const p = pv.persona;
  const ch = state.choices;
  const c = el('section', 'mi-card mi-persona');
  const h = el('h4', '', t('Her personality'));
  h.append(tip(t('A draft of her sheet from the old persona files. What fits goes on the sheet, the rest becomes her notes, and lines that would switch off her safety rules are left out. You decide.')));
  c.append(h);
  if (p.refused) {
    c.append(el('p', 'mi-error', p.refused));
    return c;
  }
  if (!p.drafts.length) {
    c.append(el('p', 'muted small', t('No personality files were found.')));
    return c;
  }
  if (!ch.herPast) {
    c.append(el('p', 'muted small', t('Another assistant: she keeps her own personality, {name}.', { name: p.current.name })));
    return c;
  }
  const idx = ch.persona?.draft ?? 0;
  const d = p.drafts[idx] ?? p.drafts[0];
  if (p.drafts.length > 1) {
    const row = el('label', 'mi-field');
    row.append(el('span', '', t('Based on')));
    const sel = el('select');
    sel.id = 'mi-draft';
    p.drafts.forEach((x, i) => {
      const o = el('option', '', x.label);
      o.value = String(i);
      o.selected = i === idx;
      sel.append(o);
    });
    sel.addEventListener('change', () => {
      ch.persona = { ...ch.persona, draft: Number(sel.value), decided: false, use: undefined };
      renderPreview(state.preview);
    });
    row.append(sel, tip(t('Other personalities and dated older versions found with it. Pick one as the base; they are never merged into one.')));
    c.append(row);
  }
  const sheet = el('div', 'mi-sheet');
  const nameRow = el('label', 'mi-field');
  const name = el('input');
  name.id = 'mi-name';
  name.value = ch.persona?.name ?? d.sheet.name;
  name.maxLength = 40;
  name.addEventListener('input', () => (ch.persona = { ...ch.persona, name: name.value }));
  nameRow.append(el('span', '', t('Name')), name, tip(t('Her name on the new sheet. You can change it here or later in Settings → Her.')));
  const ageRow = el('label', 'mi-field');
  const age = el('input');
  age.id = 'mi-age';
  age.type = 'number';
  age.min = '18';
  age.max = '120';
  age.value = String(ch.persona?.age ?? d.sheet.age);
  age.addEventListener('input', () => (ch.persona = { ...ch.persona, age: Number(age.value) }));
  ageRow.append(el('span', '', t('Age')), age, tip(d.ageGuessed ? t('The old files do not say her age, so this is her current one. Companions are always adults.') : t('Her age from the old files. Companions are always adults.')));
  sheet.append(nameRow, ageRow, el('p', 'mi-summary', d.sheet.summary));
  const cols = el('div', 'mi-cols');
  const col = (title, items, cls) => {
    const box = el('div', `mi-col ${cls}`);
    box.append(el('h5', '', `${title} (${items.length})`));
    const ul = el('ul', 'small');
    for (const x of items.slice(0, 12)) {
      const li = el('li', '', x.text);
      if (x.why) li.append(el('span', 'mi-why', ` (${x.why})`));
      if (x.tag) li.append(el('span', 'mi-pill', x.tag));
      ul.append(li);
    }
    if (items.length > 12) ul.append(el('li', 'muted', t('and {n} more', { n: items.length - 12 })));
    box.append(ul);
    return box;
  };
  const onSheet = [...d.sheet.personality, ...d.sheet.speech, ...d.sheet.boundaries, ...d.sheet.background].map((text) => ({ text }));
  cols.append(col(t('Goes on her sheet'), onSheet, 'mi-col-sheet'), col(t('Kept as her notes'), d.notes, 'mi-col-notes'), col(t('Left out (why)'), d.leftOut.map((x) => ({ ...x, why: WHY[x.why]?.() ?? x.why })), 'mi-col-left'));
  sheet.append(cols);
  c.append(sheet);
  if (p.history?.length) c.append(el('p', 'muted small', t('{n} earlier versions found (newest first in "Based on").', { n: p.history.length })));
  const tryOut = el('p', 'mi-try small');
  const acts = el('div', 'mi-actions');
  acts.append(
    btn(t('Try her voice'), 'ghost', async (b) => {
      b.disabled = true;
      tryOut.textContent = t('She is trying it out…');
      try {
        const r = await api('/persona/studio/try', { method: 'POST', body: { persona: { ...d.sheet, name: name.value || d.sheet.name, age: Number(age.value) || d.sheet.age } } });
        const s = r.samples?.[0];
        tryOut.textContent = s ? `${s.label}: ${s.text}\n\n${s.after}` : t('No sample came back.');
      } catch (err) {
        tryOut.textContent = err.message;
      }
      b.disabled = false;
    }),
    btn(ch.persona?.decided && ch.persona.use !== undefined ? t('✓ Use this personality') : t('Use this personality'), ch.persona?.decided && ch.persona.use !== undefined ? 'primary' : '', () => {
      ch.persona = { ...ch.persona, use: idx, decided: true };
      renderPreview(state.preview);
    }),
    btn(ch.persona?.decided && ch.persona.use === undefined ? t('✓ Keep my current Sara') : t('Keep my current Sara'), ch.persona?.decided && ch.persona.use === undefined ? 'primary' : 'ghost', () => {
      ch.persona = { draft: idx, decided: true };
      renderPreview(state.preview);
    }),
  );
  c.append(acts, tryOut);
  return c;
}

function sectionCard(pv, key, s) {
  const ch = state.choices;
  const c = el('section', 'mi-card mi-section');
  const top = el('div', 'mi-section-top');
  const l = el('label', 'mi-switch');
  const box = el('input');
  box.type = 'checkbox';
  box.id = `mi-sec-${key}`;
  box.checked = ch.sections[key] !== false && (ch.sections[key] === true || key !== 'reflections');
  box.addEventListener('change', () => {
    ch.sections[key] = box.checked;
    void refresh();
  });
  l.append(box, el('span', 'mi-section-name', SECTION_NAME[key]()));
  top.append(l, tip(SECTION_TIP[key]?.() ?? ''));
  const parts = [t('{n} to import', { n: s.writes })];
  if (s.duplicates) parts.push(t('{n} duplicates merged', { n: s.duplicates }));
  if (s.already) parts.push(t('{n} already here from your last move-in', { n: s.already }));
  if (key === 'memories' && pv.notes.archived) parts.push(t('{a} active, {b} archived', { a: pv.notes.active, b: pv.notes.archived }));
  if (key === 'people' && s.facts) parts.push(t('{n} facts', { n: s.facts }));
  if (key === 'conversations' && pv.conversations.count) parts.push(`${fmtDate(pv.conversations.from)} – ${fmtDate(pv.conversations.to)}`);
  top.append(el('span', 'mi-count', parts.join(' · ')));
  c.append(top);
  if (key === 'conversations' && pv.conversations.count) {
    const learn = el('label', 'mi-switch small');
    const lb = el('input');
    lb.type = 'checkbox';
    lb.id = 'mi-learn-all';
    lb.checked = ch.learnAll === true;
    lb.addEventListener('change', () => (ch.learnAll = lb.checked));
    const est = t('She learns from the last {d} days ({n} conversations, about {tok} tokens{model}).', { d: pv.conversations.learnDays, n: pv.conversations.learnRecent, tok: pv.conversations.tokensRecent.toLocaleString(), model: pv.conversations.model ? ` · ${pv.conversations.model}` : '' });
    c.append(el('p', 'muted small', est));
    learn.append(lb, el('span', '', t('Learn from all of them (about {tok} tokens)', { tok: pv.conversations.tokensAll.toLocaleString() })));
    c.append(learn);
  }
  if (s.samples?.length) {
    const det = el('details', 'mi-samples');
    det.append(el('summary', '', t('Samples')));
    for (const x of s.samples) {
      const fig = el('figure', 'mi-sample');
      fig.append(el('figcaption', 'muted small', x.from), el('p', 'small', x.text));
      det.append(fig);
    }
    c.append(det);
  }
  if (s.list?.length && (key === 'skills' || key === 'schedules')) {
    const det = el('details', 'mi-samples');
    det.append(el('summary', '', t('The list')));
    const ul = el('ul', 'small');
    for (const x of s.list) {
      const li = el('li', '', x.title);
      if (x.scripts) li.append(el('span', 'mi-pill', t('runs scripts: off until you check it')));
      if (x.bundled) li.append(el('span', 'mi-pill mi-pill-off', t('came with the old agent: Sara has her own')));
      if (x.held) li.append(el('span', 'mi-pill mi-pill-off', t('held')));
      if (x.target) li.append(el('span', 'mi-pill', { task: t('a task'), reminder: t('a reminder'), 'needs-you': t('needs you'), left: t('left behind') }[x.target] ?? x.target), el('span', 'muted', ` ${x.words}${x.why ? ` · ${WHY[x.why]?.() ?? x.why}` : ''}`));
      ul.append(li);
    }
    det.append(ul);
    c.append(det);
  }
  return c;
}

function heldCard(pv) {
  const ch = state.choices;
  const c = el('section', 'mi-card mi-held');
  const h = el('h4', '', t('Held for you'));
  h.append(tip(t('Health and intimate items stay out unless you say yes for that category. Intimate items also need Adult mode. Saying no keeps them out of Sara completely.')));
  c.append(h);
  for (const [cat, n] of Object.entries(pv.held)) {
    if (!n) continue;
    const row = el('fieldset', 'mi-her');
    row.append(el('legend', '', cat === 'medical' ? t('Health/medical: {n} items held. Import them?', { n }) : t('Intimate: {n} items held. Import them?', { n })));
    for (const [v, label] of [[true, t('Yes, import them')], [false, t('No, keep them out')]]) {
      const l = el('label', 'mi-radio');
      const r = el('input');
      r.type = 'radio';
      r.name = `mi-held-${cat}`;
      r.checked = (ch.sensitive[cat] === true) === v;
      r.disabled = cat === 'intimate' && v && !pv.adultOn;
      r.addEventListener('change', () => {
        ch.sensitive[cat] = v;
        void refresh();
      });
      l.append(r, el('span', '', label));
      row.append(l);
    }
    if (cat === 'intimate' && !pv.adultOn) row.append(el('p', 'muted small', t('Switch on Adult mode first (Settings → You).')));
    c.append(row);
  }
  return c;
}

function laterCard(list) {
  const c = el('details', 'mi-card mi-later');
  const s = el('summary', '');
  s.append(el('strong', '', t('Also for you to look at ({n})', { n: list.length })), tip(t('Things Sara found but does not bring in by herself, each with what to do instead. They are listed in your report too.')));
  c.append(s);
  const ul = el('ul', 'small');
  for (const x of list) ul.append(el('li', '', `${x.what}: ${x.why}`));
  c.append(ul);
  return c;
}

function leftCard(lines) {
  const c = el('details', 'mi-card mi-left');
  const s = el('summary', '');
  s.append(el('strong', '', t('Left behind (why)')), tip(t('Nothing is skipped silently: every skipped thing has a reason. Secrets were never even opened; reconnect accounts in Sara instead.')));
  c.append(s);
  const ul = el('ul', 'small');
  for (const l of lines) {
    const li = el('li', '');
    li.append(el('strong', '', LEFT_NAME[l.key]?.() ?? (l.key.startsWith('skip-') ? t('Skipped in sessions: {what}', { what: l.key.slice(5).replace('-', ' ') }) : l.key)), el('span', 'muted', ` · ${l.count}${l.examples?.length ? ` · ${l.examples.join(', ')}` : ''}`));
    ul.append(li);
  }
  c.append(ul);
  return c;
}

async function renderDone(pv) {
  const b = pv.batchId ? await api(`/movein/batches/${enc(pv.batchId)}`).catch(() => null) : null;
  const c = el('section', 'mi-card mi-done');
  c.append(el('h4', '', b?.state === 'partial' ? t('Stopped part way') : t('Moved in')));
  if (b?.report) c.append(reportView(b.report, b.id));
  const acts = el('div', 'mi-actions');
  if (b) {
    const dl = el('a', 'button ghost', t('Download the report'));
    dl.href = `/api/movein/batches/${enc(b.id)}/report.md`;
    dl.setAttribute('download', '');
    acts.append(dl);
  }
  if (b) acts.append(btn(t('Undo this move-in'), 'danger', () => undo(b.id)));
  acts.append(btn(t('Delete the bundle now'), 'ghost', deleteBundle));
  c.append(acts, el('p', 'muted small', t('The bundle is deleted from the server 48 hours after the move-in. Delete your own copy too.')));
  work(c);
  void loadOverview();
}

function reportView(r, batchId) {
  const wrap = el('div', 'mi-report-wrap');
  const box = el('div', 'mi-report');
  const list = (title, lines, cls, tipText) => {
    const sec = el('div', `mi-report-list ${cls}`);
    const h = el('h5', '', `${title} (${(lines ?? []).reduce((n, l) => n + (l.count || 0), 0)})`);
    h.append(tip(tipText));
    sec.append(h);
    const ul = el('ul', 'small');
    if (!lines?.length) ul.append(el('li', 'muted', t('nothing')));
    for (const l of lines ?? []) {
      const li = el('li', 'mi-r-line');
      li.append(el('span', '', reportLine(l)));
      if (l.examples?.length && /^(cfg|code|tr|connect|rebuild)/.test(l.key)) li.append(el('span', 'muted', ` · ${l.examples[0]}`));
      const go = l.page ? pageButton(l.page, t('Open')) : null;
      if (go) li.append(go);
      if (l.key === 'rebuild' && l.ref && batchId) {
        li.append(btn(t('Rebuild as a Sara plugin'), 'small', async (b) => {
          b.disabled = true;
          try {
            const x = await api(`/movein/batches/${enc(batchId)}/rebuild`, { method: 'POST', body: { key: l.ref } });
            helpers.openConversation(x.conversationId);
          } catch (err) {
            b.disabled = false;
            li.append(el('p', 'mi-error small', err.message));
          }
        }));
      }
      ul.append(li);
    }
    sec.append(ul);
    box.append(sec);
  };
  list(t('Imported'), r.imported, 'mi-r-in', t('What came in as it was: personality, notes, past chats, skills, tasks and cards.'));
  list(t('Translated'), r.translated, 'mi-r-tr', t('Old settings, schedules, hooks and plugins turned into the way Sara does the same thing.'));
  list(t('Needs you'), r.needsYou, 'mi-r-need', t('Keys to paste, channels to reconnect, cards you did not decide and rebuild plans. Each line says what to do.'));
  list(t('Left behind'), r.leftBehind, 'mi-r-left', t('What stayed out on purpose, each with the reason: secrets, logs, copies, old approvals and things Sara does her own way.'));
  wrap.append(box);
  if (r.lives?.length) {
    const d = el('details', 'mi-card mi-lives');
    const sm = el('summary', '');
    sm.append(el('strong', '', t('Where your old features live now ({n})', { n: r.lives.length })), tip(t('Every old feature and the place in Sara where you find it now.')));
    d.append(sm);
    const tbl = el('table', 'mi-rows-table small');
    const hr = el('tr', '');
    hr.append(el('th', '', t('On the old agent')), el('th', '', t('In Sara now')));
    tbl.append(hr);
    for (const x of r.lives) {
      const tr = el('tr', '');
      const now = el('td', '', x.now);
      const go = x.page ? pageButton(x.page, t('Open')) : null;
      if (go) now.append(go);
      tr.append(el('td', '', x.old), now);
      tbl.append(tr);
    }
    d.append(tbl);
    wrap.append(d);
  }
  return wrap;
}
function reportLine(l) {
  const map = {
    persona: () => t('Her personality'),
    memories: () => t('Memories: {n}', { n: l.count }),
    profile: () => t('About you: {n} facts', { n: l.count }),
    reflections: () => t('Reflections: {n}', { n: l.count }),
    conversations: () => t('Past conversations: {n}', { n: l.count }),
    skills: () => t('Skills: {n}', { n: l.count }),
    board: () => t('Board cards: {n}', { n: l.count }),
    people: () => t('People cards: {n}', { n: l.count }),
    tasks: () => t('Tasks: {n}', { n: l.count }),
    goals: () => t('Goals (paused in her own plans): {n}', { n: l.count }),
    'telemetry-tables': () => t('Log and telemetry tables: {n}', { n: l.count }),
    'custom-skipped': () => t('Store cards you skipped: {n}', { n: l.count }),
    'custom-card': () => t('A store card not confirmed: nothing from it came in ({text})', { text: l.text.split('"')[3] ?? '' }),
    schedules: () => t('Old schedules → {n} tasks and reminders (they never act by themselves)', { n: l.count }),
    'skills-held': () => t('{n} skills run scripts: off until you check them (Settings → Add-ons → Skills)', { n: l.count }),
    'store-copies': () => t('{n} copies of one store (same tables): only one was mapped', { n: l.count }),
  };
  if (map[l.key]) return map[l.key]();
  if (LEFT_NAME[l.key]) return `${LEFT_NAME[l.key]()} · ${l.count}`;
  if (l.key.startsWith('skip-')) return `${t('Skipped in sessions: {what}', { what: l.key.slice(5).replace('-', ' ') })} · ${l.count}`;
  return l.text;
}

async function undo(batchId) {
  let pre;
  try {
    pre = await api(`/movein/batches/${enc(batchId)}/undo`);
  } catch (err) {
    work(errorCard(err.message));
    return;
  }
  const dlg = el('div', 'mi-card mi-undo');
  dlg.append(el('h4', '', t('Undo this move-in?')));
  const n = Object.values(pre.counts).reduce((a, b) => a + b, 0);
  dlg.append(el('p', '', t('This removes the {n} things it brought (notes, conversations, skills, tasks and cards) and puts her old personality back.', { n })));
  if (pre.counts.setting || pre.counts['persona-rule']) dlg.append(el('p', '', t('It also removes the providers it added and puts back the settings and rules it changed, unless you changed them again since.')));
  let keep = null;
  if (pre.edited.length) {
    const l = el('label', 'mi-switch');
    keep = el('input');
    keep.type = 'checkbox';
    keep.id = 'mi-keep-edited';
    keep.checked = true;
    l.append(keep, el('span', '', t('You edited {n} imported notes: keep them', { n: pre.edited.length })), tip(t('Notes you changed after the move-in are yours now. Keep them, or let Undo remove them too.')));
    dlg.append(l);
  }
  const acts = el('div', 'mi-actions');
  acts.append(
    btn(t('Undo this move-in'), 'danger', async (b) => {
      b.disabled = true;
      try {
        await api(`/movein/batches/${enc(batchId)}/undo`, { method: 'POST', body: { keepEdited: keep?.checked === true } });
        document.dispatchEvent(new CustomEvent('sara:persona-changed'));
        state.bundle = null;
        state.choices = null;
        const done = el('div', 'mi-card mi-done');
        done.append(el('h4', '', t('Undone')), el('p', '', t('Everything this move-in brought is gone, and her personality is back as it was.')));
        work(done);
        await loadOverview();
      } catch (err) {
        b.disabled = false;
        dlg.append(el('p', 'mi-error', err.message));
      }
    }),
    btn(t('Never mind'), 'ghost', () => (state.bundle ? refresh() : work())),
  );
  dlg.append(acts);
  work(dlg);
}

async function deleteBundle() {
  if (!state.bundle) return;
  await api(`/movein/bundles/${enc(state.bundle)}`, { method: 'DELETE' }).catch(() => null);
  state.bundle = null;
  state.choices = null;
  work();
  await loadOverview();
}

async function loadOverview() {
  state.overview = await api('/movein').catch(() => state.overview);
  renderBatches();
}

// ---------------------------------------------------------------------------------------------
// Saved mappings (§8.5): names only, exportable
// ---------------------------------------------------------------------------------------------
async function renderMappings() {
  const box = $('#mi-mappings');
  if (!box) return;
  const r = await api('/movein/mappings').catch(() => ({ mappings: [] }));
  if (!r.mappings.length) {
    box.replaceChildren(emptyState({ icon: 'package', text: t('No saved mappings.'), why: t('A store card you confirm is saved here, so the same kind of store maps itself next time.') }));
    return;
  }
  const ul = el('ul', 'mi-batch-list');
  for (const m of r.mappings) {
    const li = el('li', 'mi-batch');
    const used = m.mapping.tables.filter((x) => x.target !== 'skip').map((x) => `${x.table} → ${targetName(x.target)}`).join(', ');
    const text = el('div', 'mi-saved-text');
    text.append(el('span', 'mi-batch-name', `${m.storeLabel} · ${m.family}`), el('span', 'muted small', `${fmtDate(m.confirmedAt)} · ${used || t('all skipped')}`));
    li.append(text);
    li.append(btn(t('Delete'), 'ghost small', async () => {
      await api(`/movein/mappings/${enc(m.fingerprint)}`, { method: 'DELETE' }).catch(() => null);
      await renderMappings();
    }));
    ul.append(li);
  }
  box.replaceChildren(ul);
}

function renderBatches() {
  const box = $('#mi-batches');
  if (!box || !state.overview) return;
  const list = state.overview.batches ?? [];
  if (!list.length) {
    box.replaceChildren(emptyState({ icon: 'package', text: t('No move-ins yet.'), howto: true }));
    return;
  }
  const ul = el('ul', 'mi-batch-list');
  for (const b of list) {
    const li = el('li', 'mi-batch');
    const label = { done: t('moved in'), partial: t('stopped part way'), undone: t('undone'), importing: t('moving in…') }[b.state] ?? b.state;
    li.append(el('span', 'mi-batch-name', `${b.agentName} · ${b.sourceKind === 'openclaw' ? 'OpenClaw' : b.sourceKind === 'custom' ? t('custom agent') : 'Hermes Agent'}`), el('span', 'muted small', `${fmtDate(b.createdAt)} · ${label}`));
    if (b.hasReport && b.state !== 'undone') {
      const dl = el('a', 'button ghost small', t('Report'));
      dl.href = `/api/movein/batches/${enc(b.id)}/report.md`;
      dl.setAttribute('download', '');
      li.append(dl);
    }
    if (b.state === 'done' || b.state === 'partial') li.append(btn(t('Undo'), 'ghost small', () => undo(b.id)));
    ul.append(li);
  }
  box.replaceChildren(ul);
}

// ---------------------------------------------------------------------------------------------
// Custom stores: the mapping cards (§8.3). Nothing imports from a card until "Looks right".
// ---------------------------------------------------------------------------------------------
const TARGET_NAME = {
  memory: () => t('her notes'),
  owner_fact: () => t('what she knows about you'),
  person: () => t('people cards'),
  person_fact: () => t('facts on people cards'),
  person_alias: () => t('other names on people cards'),
  goal: () => t('her goals (paused)'),
  opinion: () => t('her opinions'),
  diary: () => t('her diary (reflection notes)'),
  task: () => t('tasks'),
  conversation: () => t('past conversations'),
  message: () => t('messages of past conversations'),
  skip: () => t('skip'),
};
const TARGET_FIELDS = {
  memory: ['content', 'kind', 'happenedOn', 'evidence', 'pinned'],
  owner_fact: ['content', 'happenedOn'],
  person: ['name', 'aliases', 'relation', 'birthday', 'notes'],
  person_fact: ['person', 'content', 'source', 'happenedOn', 'confidence'],
  person_alias: ['person', 'alias'],
  goal: ['title', 'why', 'happenedOn'],
  opinion: ['content', 'happenedOn'],
  diary: ['content', 'happenedOn'],
  task: ['title', 'notes', 'dueAt', 'done'],
  conversation: ['title', 'startedAt', 'channel'],
  message: ['conversation', 'role', 'text', 'at'],
  skip: [],
};
const FIELD_NAME = {
  content: () => t('Text'), kind: () => t('Kind'), happenedOn: () => t('Date'), evidence: () => t('Where it came from'), pinned: () => t('Pinned'),
  name: () => t('Name'), aliases: () => t('Other names'), relation: () => t('Relation'), birthday: () => t('Birthday'), notes: () => t('Notes'),
  person: () => t('Which person'), source: () => t('Source'), confidence: () => t('How sure'), alias: () => t('Other name'),
  title: () => t('Title'), why: () => t('Why'), dueAt: () => t('Due'), done: () => t('Done'), startedAt: () => t('Started'), channel: () => t('Channel'),
  conversation: () => t('Which conversation'), role: () => t('Who spoke'), text: () => t('Message'), at: () => t('When'),
};
const DATE_FIELDS = new Set(['happenedOn', 'birthday', 'dueAt', 'startedAt', 'at']);
const targetName = (k) => TARGET_NAME[k]?.() ?? k;
const STATE_NAME = {
  new: () => t('not mapped yet'),
  proposing: () => t('she is reading it…'),
  proposed: () => t('her proposal'),
  failed: () => t("couldn't map: pick by hand"),
  mapping: () => t('mapping the rows…'),
  confirmed: () => t('✓ confirmed'),
  skipped: () => t('skipped'),
};

function exprText(e) {
  if (!e) return '—';
  if (e.col) return e.col;
  if (e.date_from) return `${e.date_from.col} (${e.date_from.as})`;
  if (e.concat) return e.concat.map(exprText).join(' + ');
  if (e.first_non_empty) return e.first_non_empty.map(exprText).join(' / ');
  if (e.lookup) return `${e.lookup.table}.${e.lookup.value} ← ${e.lookup.col}`;
  if (e.json_path) return `${e.json_path.col}.${e.json_path.path}`;
  if ('const' in e) return `"${e.const}"`;
  return '?';
}
function filterText(f) {
  if (f.eq) return t('only rows where {col} is {v}', { col: f.eq.col, v: String(f.eq.value) });
  if (f.not_null) return t('only rows with {col}', { col: f.not_null });
  if (f.newest) return t('the newest {n} by {col}', { n: f.newest.n, col: f.newest.col });
  if (f.active_only) return t('only active rows ({col})', { col: f.active_only });
  return '';
}

function storesBox(pv) {
  const box = el('section', 'mi-card mi-stores');
  box.id = 'mi-stores';
  const h = el('h4', '', t('Her old databases'));
  h.append(tip(t('Tables from custom stores, grouped into cards. She proposes where each one goes; you confirm or skip every card. Log and telemetry tables are skipped. Nothing imports from a card you did not confirm.')));
  box.append(h, el('p', 'muted small', t('Loading the cards…')));
  void loadCards();
  return box;
}

async function loadCards() {
  clearTimeout(state.cardPoll);
  if (!state.bundle) return;
  const q = `?localOnly=${state.localOnly ? '1' : '0'}&sensitive=${Object.entries(state.choices?.sensitive ?? {}).filter(([, v]) => v).map(([k]) => k).join(',')}`;
  let r;
  try {
    r = await api(`/movein/bundles/${enc(state.bundle)}/cards${q}`);
  } catch (err) {
    const b = $('#mi-stores');
    if (b) b.append(el('p', 'mi-error small', err.message));
    return;
  }
  const was = state.cards;
  state.cards = r;
  renderCards(r);
  const busy = r.cards.some((c) => c.state === 'proposing' || c.state === 'mapping');
  if (busy) state.cardPoll = setTimeout(() => void loadCards(), 1200);
  // A card finished mapping: the sections above count its rows now.
  const finished = was && r.cards.some((c) => c.state === 'confirmed' && was.cards.find((x) => x.key === c.key)?.state === 'mapping');
  if ((finished || (state.cardBusy && !busy)) && state.preview?.state === 'ready') {
    state.cardBusy = busy;
    await refresh();
    return;
  }
  state.cardBusy = busy;
}

function renderCards(r) {
  const box = $('#mi-stores');
  if (!box) return;
  const h = box.querySelector('h4');
  const parts = [h];
  for (const s of r.stores) {
    const line = el('details', 'mi-store');
    const sum = el('summary', '');
    sum.append(el('strong', '', s.label), el('span', 'muted small', t('{kind} · {n} tables · {f} cards · {tele} log and telemetry tables skipped', { kind: s.kind === 'postgres' ? 'Postgres' : 'SQLite', n: s.tables, f: s.families, tele: s.telemetry.length })), tip(t('Tables that look like logs, traces, metrics or caches (by name, shape, volume and the lack of real sentences) are skipped. Bring one back if it holds something she should know.')));
    line.append(sum);
    const ul = el('ul', 'mi-tele small');
    for (const x of s.telemetry.slice(0, 60)) {
      const li = el('li', '');
      li.append(el('span', '', `${x.name} · ${x.rows.toLocaleString()} `), el('span', 'muted', x.signals?.length ? x.signals.map(signalName).join(', ') : t('skipped by the collector')));
      if (x.packed) li.append(btn(t('Bring it back'), 'ghost small', async () => {
        await api(`/movein/bundles/${enc(state.bundle)}/cards/pull`, { method: 'POST', body: { store: s.id, table: x.key } }).catch((err) => say(err.message));
        await loadCards();
      }));
      ul.append(li);
    }
    if (s.telemetry.length > 60) ul.append(el('li', 'muted', t('and {n} more', { n: s.telemetry.length - 60 })));
    for (const x of s.left) ul.append(el('li', 'muted', `${x.name} · ${x.why}`));
    line.append(ul);
    parts.push(line);
  }
  // MI3: copies of one store (backups, probe and round-trip copies) are mapped once.
  if (r.copies?.length) {
    const d = el('details', 'mi-store');
    const sm = el('summary', '');
    sm.append(el('strong', '', t('{n} copies of a store, mapped once', { n: r.copies.length })), tip(t('Stores with exactly the same tables as another one (backups, test or round-trip copies) are not mapped again. Only the main one gets cards.')));
    d.append(sm);
    const ul = el('ul', 'mi-tele small');
    for (const x of r.copies.slice(0, 60)) ul.append(el('li', '', `${x.label} → ${x.ofLabel}`));
    if (r.copies.length > 60) ul.append(el('li', 'muted', t('and {n} more', { n: r.copies.length - 60 })));
    d.append(ul);
    parts.push(d);
  }
  // Ask her (one model call per card) or map by hand.
  const todo = r.cards.filter((c) => c.state === 'new' || c.state === 'failed').length;
  const ask = el('div', 'mi-ask');
  const est = r.estimate;
  const estLine = est?.model ? t('{n} cards to map: {n} model calls, about {tok} tokens on {model}{cost}. The rows themselves need no model.', { n: est.calls, tok: (est.inputTokens + est.outputTokens).toLocaleString(), model: est.model.label, cost: est.model.local ? ` (${t('on this computer')})` : est.model.usd !== null ? ` (~$${est.model.usd})` : '' }) : est?.problem ? `${serverText({ error: est.problem }, est.problem)} ${t('You can still map them by hand.')}` : '';
  // Once every card is decided there is nothing to ask her: the box shrinks to one line.
  ask.append(el('p', 'small', todo || r.cards.some((c) => c.state === 'proposing') ? estLine : t('Every card is decided.')));
  const local = el('label', 'mi-switch small');
  const lb = el('input');
  lb.type = 'checkbox';
  lb.id = 'mi-local-only';
  lb.checked = state.localOnly;
  lb.addEventListener('change', () => {
    state.localOnly = lb.checked;
    void loadCards();
  });
  local.append(lb, el('span', '', t('Only models on this computer')), tip(t('Sample rows from your old databases go to the model that reads them (secrets removed, health and intimate values hidden). Keep this on to use only a model on this computer.')));
  const acts = el('div', 'mi-actions');
  const propose = (useModel) => async (b) => {
    b.disabled = true;
    try {
      await api(`/movein/bundles/${enc(state.bundle)}/cards/propose`, { method: 'POST', body: { localOnly: state.localOnly, useModel } });
    } catch (err) {
      say(err.message);
    }
    state.cardBusy = true;
    await loadCards();
  };
  if (todo) acts.append(btn(t('Ask her to map them'), 'primary', propose(true)), btn(t('Guess from the names (no model)'), 'ghost', propose(false)));
  if (r.cards.some((c) => c.state === 'proposing')) acts.append(btn(t('Stop'), 'ghost small', async () => api(`/movein/bundles/${enc(state.bundle)}/cards/stop`, { method: 'POST', body: {} })));
  if (todo || r.cards.some((c) => c.state === 'proposing')) ask.append(local, acts);
  if (r.saved) ask.append(el('p', 'muted small', t('Cards that match a saved mapping map themselves, with no model calls.')));
  parts.push(ask);
  const grid = el('div', 'mi-card-grid');
  for (const c of r.cards) grid.append(mappingCard(c));
  parts.push(grid);
  box.replaceChildren(...parts);
}

/** A short line under the Import button (errors from the cards). */
function say(msg) {
  const n = $('#mi-note');
  if (n) n.textContent = msg;
}

function signalName(s) {
  return { name: t('its name'), shape: t('its shape'), volume: t('its volume'), 'no-owner-words': t('no real sentences') }[s] ?? s;
}

function mappingCard(c) {
  const card = el('article', `mi-map mi-map-${c.state}`);
  card.dataset.key = c.key;
  const head = el('div', 'mi-map-head');
  const title = el('h5', '', c.family.title);
  head.append(title, el('span', `mi-pill${c.state === 'skipped' ? ' mi-pill-off' : ''}`, STATE_NAME[c.state]?.() ?? c.state));
  if (c.by === 'saved') head.append(el('span', 'mi-pill', t('your saved mapping from {date}', { date: fmtDate(c.savedAt) })));
  card.append(head);
  const chips = el('p', 'mi-chips small');
  for (const tb of c.tables) chips.append(el('span', 'mi-chip', `${tb.schema && tb.schema !== 'public' ? `${tb.schema}.` : ''}${tb.name} · ${tb.rows.toLocaleString()}`));
  card.append(chips);
  if (c.state === 'proposing' || c.state === 'mapping') {
    const pg = el('progress', '');
    if (c.progress?.total) {
      pg.max = c.progress.total;
      pg.value = c.progress.done;
    } else pg.removeAttribute('value');
    card.append(pg, el('p', 'muted small', c.progress ? t('{table}: {done} of {total}', { table: c.progress.table, done: c.progress.done.toLocaleString(), total: c.progress.total.toLocaleString() }) : (c.line ? serverText({ error: c.line }, c.line) : '')));
  }
  // What she thinks it is: table → destination, the reason, how sure.
  if (c.mapping) {
    const ul = el('ul', 'mi-think small');
    for (const m of c.mapping.tables) {
      const li = el('li', '');
      li.append(el('strong', '', m.table), el('span', '', ` → ${targetName(m.target)}`));
      if (m.target !== 'skip') {
        const f = Object.entries(m.fields).map(([k, v]) => `${FIELD_NAME[k]?.() ?? k} ← ${exprText(v)}`).join(' · ');
        if (f) li.append(el('span', 'muted mi-fields', f));
        for (const x of m.filter ?? []) li.append(el('span', 'muted mi-fields', filterText(x)));
      }
      if (m.reason) li.append(el('span', 'mi-why', ` “${m.reason}”${m.confidence ? ` · ${Math.round(m.confidence * 100)}%` : ''}`));
      ul.append(li);
    }
    card.append(ul);
  }
  for (const e of c.errors ?? []) card.append(el('p', 'mi-error small', e));
  for (const w of c.warnings ?? []) card.append(el('p', 'muted small', `⚠ ${w}`));
  // What it makes (three samples through the real mapper).
  const made = c.preview?.samples ? Object.values(c.preview.samples).flat() : [];
  if (made.length) {
    const det = el('details', 'mi-samples mi-made');
    det.open = c.state === 'proposed' || c.state === 'failed';
    det.append(el('summary', '', t('What it makes ({n} samples)', { n: made.length })));
    for (const x of made.slice(0, 6)) {
      const fig = el('figure', 'mi-sample');
      fig.append(el('figcaption', 'small', `${SECTION_NAME[x.section]?.() ?? x.section} · ${heldText(x.title)}`));
      for (const l of x.lines) fig.append(el('p', 'small', heldText(l)));
      det.append(fig);
    }
    if (c.preview.joinCheck?.checked) det.append(el('p', 'muted small', t('{m} of {n} facts found their person in the first rows.', { m: c.preview.joinCheck.matched, n: c.preview.joinCheck.checked })));
    card.append(det);
  }
  // Sample rows (masked) of each table.
  const rowsDet = el('details', 'mi-samples');
  rowsDet.append(el('summary', '', t('Sample rows')));
  for (const tb of c.tables) {
    if (!tb.samples?.length) continue;
    const wrap = el('div', 'mi-rows');
    wrap.append(el('p', 'small mi-rows-name', tb.name));
    const table = el('table', 'mi-rows-table small');
    const cols = tb.columns.slice(0, 6).map((x) => x.name);
    const tr = el('tr');
    for (const k of cols) tr.append(el('th', '', k));
    table.append(tr);
    for (const row of tb.samples.slice(0, 3)) {
      const r = el('tr');
      for (const k of cols) r.append(el('td', '', cellText(row[k])));
      table.append(r);
    }
    wrap.append(table);
    rowsDet.append(wrap);
  }
  card.append(rowsDet);
  if (state.editing[c.key]) card.append(editor(c));
  if (c.state === 'confirmed' && c.staged) {
    const n = Object.entries(c.staged).map(([k, v]) => `${SECTION_NAME[k]?.() ?? k}: ${v}`).join(' · ');
    card.append(el('p', 'small mi-staged', n || t('Nothing to import from this card.')));
    const dropped = Object.entries(c.result?.dropped ?? {}).filter(([k]) => k !== 'filtered');
    if (dropped.length) card.append(el('p', 'muted small', dropped.map(([k, v]) => `${{ 'no-person': t('facts without a person'), empty: t('empty rows'), tool: t('tool messages'), 'minors-check': t('failed the minors check'), duplicates: t('duplicates') }[k] ?? k}: ${v}`).join(' · ')));
  }
  const acts = el('div', 'mi-actions');
  const post = (what, body = {}) => async (b) => {
    b.disabled = true;
    try {
      await api(`/movein/bundles/${enc(state.bundle)}/cards/${what}`, { method: 'POST', body: { key: c.key, ...body } });
      if (what === 'confirm') state.cardBusy = true;
    } catch (err) {
      say(err.message);
    }
    await loadCards();
  };
  if (c.state === 'proposed' || (c.state === 'failed' && c.mapping && !c.errors?.length)) acts.append(btn(t('Looks right'), 'primary', post('confirm')));
  if (c.state !== 'mapping' && c.state !== 'proposing') {
    if (c.state !== 'skipped') acts.append(btn(t('Skip'), 'ghost', post('skip')));
    if (c.state === 'confirmed' || c.state === 'skipped') acts.append(btn(t('Change my mind'), 'ghost', post('reset')));
    if (c.state !== 'confirmed') acts.append(btn(state.editing[c.key] ? t('Close the details') : t('Change'), 'ghost', () => {
      state.editing[c.key] = !state.editing[c.key];
      if (state.editing[c.key] && !state.drafts[c.key]) state.drafts[c.key] = structuredClone(c.mapping ?? { tables: c.tables.map((x) => ({ table: x.key, target: 'skip', fields: {}, reason: '', confidence: 0 })) });
      renderCards(state.cards);
    }));
    if (c.state === 'failed' || c.state === 'new') acts.append(btn(t('Ask her again'), 'ghost', async (b) => {
      b.disabled = true;
      await api(`/movein/bundles/${enc(state.bundle)}/cards/propose`, { method: 'POST', body: { keys: [c.key], localOnly: state.localOnly } }).catch((err) => say(err.message));
      await loadCards();
    }));
  }
  card.append(acts);
  return card;
}

/** The server marks health and intimate values «held: medical»; the card says so in the owner's language. */
function heldText(s) {
  return String(s).replace(/«held: (medical|intimate)»/g, (_, cat) => (cat === 'medical' ? t('(held: health)') : t('(held: intimate)')));
}

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return v.$date ?? (v.$blob || v.$skipped ? t('(file)') : v.$redacted ? t('(secret removed)') : JSON.stringify(v));
  const s = heldText(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** The hand edit: per table a destination, per field a column (dates read as the column says). No SQL. */
function editor(c) {
  const draft = state.drafts[c.key];
  const box = el('div', 'mi-editor');
  box.append(el('p', 'muted small', t('Pick where each table goes and which column fills each field. Sara checks it and shows the samples again before you confirm.')));
  for (const tb of c.tables) {
    let m = draft.tables.find((x) => x.table === tb.key);
    if (!m) {
      m = { table: tb.key, target: 'skip', fields: {}, reason: '', confidence: 0 };
      draft.tables.push(m);
    }
    const fs = el('fieldset', 'mi-edit-table');
    fs.append(el('legend', '', tb.name));
    const row = el('label', 'mi-field');
    const sel = el('select');
    sel.id = `mi-dest-${c.key}-${tb.key}`.replace(/[^\w-]/g, '_');
    for (const k of Object.keys(TARGET_NAME)) {
      const o = el('option', '', targetName(k));
      o.value = k;
      o.selected = m.target === k;
      sel.append(o);
    }
    sel.addEventListener('change', () => {
      m.target = sel.value;
      m.fields = {};
      renderCards(state.cards);
    });
    row.append(el('span', '', t('Goes to')), sel, tip(t('Where the rows of this table land in Sara. Skip leaves the table out.')));
    fs.append(row);
    for (const f of TARGET_FIELDS[m.target] ?? []) {
      const r = el('label', 'mi-field');
      const s2 = el('select');
      s2.id = `mi-f-${c.key}-${tb.key}-${f}`.replace(/[^\w-]/g, '_');
      const none = el('option', '', t('— none —'));
      none.value = '';
      s2.append(none);
      const cur = m.fields[f];
      const curCol = cur?.col ?? cur?.date_from?.col;
      for (const col of tb.columns) {
        const o = el('option', '', `${col.name}${col.date ? ` (${col.date})` : ''}`);
        o.value = col.name;
        o.selected = curCol === col.name;
        s2.append(o);
      }
      if (cur && !curCol) {
        const o = el('option', '', exprText(cur));
        o.value = '__keep';
        o.selected = true;
        s2.append(o);
      }
      s2.addEventListener('change', () => {
        if (s2.value === '__keep') return;
        if (!s2.value) delete m.fields[f];
        else {
          const col = tb.columns.find((x) => x.name === s2.value);
          m.fields[f] = DATE_FIELDS.has(f) && col?.date ? { date_from: { col: col.name, as: col.date } } : { col: s2.value };
        }
      });
      r.append(el('span', '', FIELD_NAME[f]?.() ?? f), s2, tip(t('Which column fills this field. Dates are read the way the column stores them (seconds, milliseconds or text).')));
      fs.append(r);
    }
    box.append(fs);
  }
  const acts = el('div', 'mi-actions');
  acts.append(btn(t('Check it'), 'primary', async (b) => {
    b.disabled = true;
    try {
      await api(`/movein/bundles/${enc(state.bundle)}/cards/edit`, { method: 'POST', body: { key: c.key, mapping: draft } });
      state.editing[c.key] = false;
      delete state.drafts[c.key];
    } catch (err) {
      say(err.message);
    }
    await loadCards();
  }));
  box.append(acts);
  return box;
}

// ---------------------------------------------------------------------------------------------
// Phase 106 (MI3, §9): settings and channels as proposals, hooks and plugins as explainer cards.
// Nothing here runs old code: the server only ever reads it as text. Confirm or Skip each card.
// ---------------------------------------------------------------------------------------------
/** Server page names → the Settings pages they open. */
const PAGE = {
  models: 'models-providers', voice: 'her-voice', telegram: 'co-telegram', discord: 'co-discord', hooks: 'co-hooks', agents: 'co-agents',
  abilities: 'ab-tools', skills: 'ab-skills', plugins: 'ab-plugins', mcp: 'ab-mcp', you: 'you-about', her: 'her-character', companions: 'her-companions',
  google: 'ab-google', library: 'ab-library', look: 'her-look', budgets: 'ab-budgets', checkup: 'dh-health', runs: 'dh-reports', memory: 'dh-data', agenda: 'her-character',
};
const KIND_NAME = {
  provider: () => t('Model provider'), 'sign-in': () => t('Sign-in'), local: () => t('Local models'), route: () => t('Which model does what'), voice: () => t('Voice'),
  channel: () => t('Channel'), peer: () => t('Other agent'), webhook: () => t('Webhooks'), mcp: () => t('MCP server'), timezone: () => t('Time zone'),
  approvals: () => t('Approvals'), roster: () => t('Another agent'), knob: () => t('Other setting'),
};
const KIND_TIP = {
  provider: () => t('A model service the old agent used. Confirm adds it to Sara with an empty key: paste your own key in Settings → Models. Pick another kind if the match is wrong.'),
  'sign-in': () => t('The old agent signed in to a subscription. Confirm adds Sara\'s own sign-in for it; you sign in again with your account.'),
  local: () => t('Models on the old computer or your home network. Sara adds them only if her server can reach that address.'),
  voice: () => t('Her old voice. Confirm switches Sara to the same service and voice when she has it; paste that service\'s key in Settings → Voice.'),
  channel: () => t('Where you talked to the old agent. Sara never connects a channel by herself: confirm puts the reconnect steps in your report. Stop the old bot first, or both of us will answer.'),
  peer: () => t('Another agent the old one talked to. It is never connected by a move-in: add it again in Settings → Other agents with a new key.'),
  webhook: () => t('Outside services that sent events to the old agent. Sara makes new signed addresses; confirm puts the steps in your report.'),
  mcp: () => t('Tool servers the old agent started. Programs never start from a move-in; add the ones you still want in Settings → Add-ons → Other programs (MCP).'),
  timezone: () => t('Your time zone from the old agent. Sara uses it only when she has none yet.'),
  info: () => t('Shown so nothing is silent, never copied. Old allowlists and approvals never become "Always allowed" in Sara.'),
};
const TR_NAME = {
  rule: () => t('Becomes a personality rule'), guard: () => t('Sara asks first'), feature: () => t('Sara does this already'), left: () => t('Left behind'),
  rebuild: () => t('A rebuild plan'), flag: () => t('Needs you: not translated'),
};
const INTENT_NAME = {
  style: () => t('reply style'), context: () => t('adds context'), guard: () => t('tool guard'), logging: () => t('logging'), ritual: () => t('session start'),
  memory: () => t('memory engine'), integration: () => t('integration'), unclear: () => t('unclear'),
};
const FLAG_NAME = { 'reads-secrets': () => t('reads secret files'), obfuscated: () => t('hides what it does'), 'runs-programs': () => t('runs programs'), 'writes-files': () => t('writes files') };

function pageButton(page, label) {
  const id = PAGE[page];
  if (!id) return null;
  return btn(label ?? t('Open'), 'ghost small', () => helpers.showSettingsTab(id));
}

function translationsBox() {
  const box = el('section', 'mi-card mi-trans');
  box.id = 'mi-trans';
  const h = el('h4', '', t('Settings, channels, hooks and plugins'));
  h.append(tip(t('Her old settings as cards. Confirm what you want, skip the rest. Keys never move: you paste them again. Hooks and plugins were read as text and never run.')));
  box.append(h, el('p', 'muted small', t('Loading the cards…')));
  void loadTranslations();
  return box;
}

async function loadTranslations() {
  clearTimeout(state.transPoll);
  if (!state.bundle) return;
  let r;
  try {
    r = await api(`/movein/bundles/${enc(state.bundle)}/translations`);
  } catch (err) {
    $('#mi-trans')?.append(el('p', 'mi-error small', err.message));
    return;
  }
  state.trans = r;
  renderTranslations(r);
  if (r.busy) state.transPoll = setTimeout(() => void loadTranslations(), 1200);
  const note = $('#mi-note');
  if (note && r.undecided && !state.preview?.stores?.undecided) note.textContent = t('{n} setting and hook cards are not decided yet: they change nothing.', { n: r.undecided });
}

function renderTranslations(r) {
  const box = $('#mi-trans');
  if (!box) return;
  const parts = [box.querySelector('h4')];
  if (!r.config.length && !r.code.length) {
    parts.push(el('p', 'muted small', t('No settings, hooks or plugins in this bundle.')));
    box.replaceChildren(...parts);
    return;
  }
  const act = r.config.filter((p) => p.mode !== 'info');
  const info = r.config.filter((p) => p.mode === 'info');
  if (act.length) {
    parts.push(el('h5', 'mi-trans-head', t('Settings and channels ({n})', { n: act.length })));
    const grid = el('div', 'mi-card-grid');
    for (const p of act) grid.append(configCard(p));
    parts.push(grid);
  }
  if (r.code.length) {
    const hh = el('h5', 'mi-trans-head', t('Hooks and plugins ({n})', { n: r.code.length }));
    hh.append(tip(t('Each hook or plugin explained in plain words, with what Sara saw in its code. Nothing of it ever runs. Rules and guards apply when you confirm them; integrations become rebuild plans.')));
    parts.push(hh);
    const grid = el('div', 'mi-card-grid');
    for (const c of r.code) grid.append(codeCard(c));
    parts.push(grid);
  }
  if (info.length) {
    const d = el('details', 'mi-info');
    const sm = el('summary', '');
    sm.append(el('strong', '', t('Shown, not copied ({n})', { n: info.length })), tip(KIND_TIP.info()));
    d.append(sm);
    const ul = el('ul', 'mi-info-list small');
    for (const p of info) {
      const li = el('li', '');
      li.append(el('strong', '', `${KIND_NAME[p.kind]?.() ?? p.kind}: ${p.title}`), el('span', 'muted', ` · ${p.old}`));
      if (p.why) li.append(el('span', 'mi-why', ` · ${p.why}`));
      const go = pageButton(p.page, t('Open'));
      if (go) li.append(go);
      ul.append(li);
    }
    d.append(ul);
    parts.push(d);
  }
  box.replaceChildren(...parts);
}

function decisionRow(card, kind) {
  const row = el('div', 'mi-actions');
  const send = async (decision, b) => {
    b.disabled = true;
    try {
      const body = { key: card.key, decision };
      const sel = row.parentElement?.querySelector('select.mi-pick');
      if (sel && decision === 'confirm') body.choice = sel.value;
      await api(`/movein/bundles/${enc(state.bundle)}/translations/${kind}`, { method: 'POST', body });
      await loadTranslations();
    } catch (err) {
      b.disabled = false;
      row.append(el('p', 'mi-error small', err.message));
    }
  };
  const on = card.state === 'confirmed';
  const off = card.state === 'skipped';
  row.append(btn(on ? t('✓ Confirmed') : t('Confirm'), on ? 'primary' : '', (b) => send(on ? 'reset' : 'confirm', b)), btn(off ? t('✓ Skipped') : t('Skip'), off ? 'primary' : 'ghost', (b) => send(off ? 'reset' : 'skip', b)));
  return row;
}

function configCard(p) {
  const c = el('article', `mi-map mi-cfg mi-map-${p.state === 'confirmed' ? 'confirmed' : p.state === 'skipped' ? 'skipped' : 'new'}`);
  const head = el('div', 'mi-map-head');
  const h = el('h5', '', p.title);
  head.append(h, el('span', 'mi-pill', KIND_NAME[p.kind]?.() ?? p.kind), tip(KIND_TIP[p.kind]?.() ?? KIND_TIP.info()));
  c.append(head, el('p', 'small', t('On the old agent: {what}', { what: p.old })));
  if (p.options?.length) {
    const lab = el('label', 'mi-field');
    const sel = el('select', 'mi-pick');
    for (const o of p.options) {
      const opt = el('option', '', o.value === 'other-openai' ? t('Other (OpenAI-compatible, same address)') : o.value === 'local' ? t("Sara's own voice on the server") : o.value === 'off' ? t('No voice') : o.label);
      opt.value = o.value;
      opt.selected = o.value === p.choice;
      sel.append(opt);
    }
    sel.addEventListener('change', () => {
      if (p.state === 'confirmed') void api(`/movein/bundles/${enc(state.bundle)}/translations/config`, { method: 'POST', body: { key: p.key, decision: 'confirm', choice: sel.value } }).then(loadTranslations).catch(() => null);
    });
    lab.append(el('span', '', p.kind === 'voice' ? t('Becomes') : t('In Sara')), sel, tip(p.kind === 'voice' ? t('The voice service Sara uses. Her own voice on the server needs no key.') : t("Sara's name for this kind of service. The key stays empty until you paste yours.")));
    c.append(lab);
  }
  c.append(el('p', 'muted small', t('Lives in Sara now: {where}', { where: p.lives })));
  if (p.secrets?.length) c.append(el('p', 'small mi-keys', t('Keys removed, never moved: {names}', { names: p.secrets.join(', ') })));
  if (p.warn) c.append(el('p', 'small mi-warn', p.warn));
  if (p.why) c.append(el('p', 'small mi-why', p.why));
  if (p.steps?.length) {
    const ol = el('ol', 'small mi-steps-list');
    for (const x of p.steps) ol.append(el('li', '', x));
    c.append(ol);
  }
  if (p.reach === 'yes') c.append(el('p', 'small mi-staged', t('✓ Sara reaches this address from her server.')));
  c.append(decisionRow(p, 'config'));
  const go = pageButton(p.page, t('Open in Settings'));
  if (go) c.append(go);
  return c;
}

function codeCard(cd) {
  const tr = cd.translation;
  const c = el('article', `mi-map mi-code mi-map-${cd.state === 'confirmed' ? 'confirmed' : cd.state === 'skipped' ? 'skipped' : tr.type === 'flag' ? 'failed' : 'new'}`);
  const head = el('div', 'mi-map-head');
  head.append(el('h5', '', cd.name), el('span', 'mi-pill', cd.kind === 'hook' ? t('hook') : t('plugin')), el('span', 'mi-pill mi-pill-off', INTENT_NAME[cd.intent]?.() ?? cd.intent));
  if (cd.enabled === false) head.append(el('span', 'mi-pill mi-pill-off', t('was off')));
  head.append(tip(t('Read as text, never run. Sara says what it did in plain words and quotes the code for every claim; claims she could not quote are dropped.')));
  c.append(head, el('p', '', cd.summary));
  const what = el('div', 'mi-ask');
  what.append(el('strong', '', TR_NAME[tr.type]?.() ?? tr.type));
  if (tr.type === 'rule') what.append(el('p', '', `“${tr.rule}”`), el('p', 'muted small', t('Added to her sheet under "How she talks" when you confirm. Her safety rules stay as they are.')));
  if (tr.type === 'guard') what.append(el('p', '', t('Sara will ask you before every "{tool}" step. This only ever makes her more careful.', { tool: tr.tool })));
  if (tr.type === 'feature' || tr.type === 'left') what.append(el('p', '', tr.feature ?? tr.why ?? ''));
  if (tr.where) what.append(el('p', 'muted small', t('Lives in Sara now: {where}', { where: tr.where })));
  if (tr.type === 'rebuild' && tr.plan) {
    const ul = el('ul', 'small mi-think');
    ul.append(el('li', '', t('What it did: {what}', { what: tr.plan.did })), el('li', '', t('Hosts: {list}', { list: tr.plan.hosts.join(', ') || t('none found') })), el('li', '', t('Secrets it needs (names only): {list}', { list: tr.plan.secrets.join(', ') || t('none') })));
    what.append(ul, el('p', 'muted small', t('After the move-in, the report has "Rebuild as a Sara plugin": a coding task you approve, ending in the normal plugin review.')));
  }
  if (tr.type === 'flag' && tr.why) what.append(el('p', 'small mi-warn', tr.why));
  c.append(what);
  if (cd.flags?.length) c.append(el('p', 'mi-chips small', cd.flags.map((f) => FLAG_NAME[f]?.() ?? f).join(' · ')));
  if (cd.claims?.length) {
    const d = el('details', 'mi-samples');
    d.append(el('summary', '', t('What Sara saw in the code ({n})', { n: cd.claims.length })));
    const ul = el('ul', 'small mi-think');
    for (const x of cd.claims) {
      const li = el('li', '');
      li.append(el('span', '', `${x.text} `), el('code', 'mi-quote', x.quote), el('span', 'muted', ` · ${x.file}`));
      ul.append(li);
    }
    d.append(ul);
    c.append(d);
  }
  if (cd.by === 'model') c.append(el('p', 'muted small', t('Read by {model}; {n} claims without a real quote were dropped.', { model: cd.model || t('her model'), n: cd.dropped ?? 0 })));
  const code = el('details', 'mi-samples');
  code.append(el('summary', '', t('Show the code (as text)')));
  code.addEventListener('toggle', async () => {
    if (!code.open || code.dataset.loaded) return;
    code.dataset.loaded = '1';
    try {
      const r = await api(`/movein/bundles/${enc(state.bundle)}/translations/text?key=${enc(cd.key)}`);
      for (const f of r.files) {
        const pre = el('pre', 'mi-cmd mi-code-text', f.text);
        pre.setAttribute('translate', 'no');
        code.append(el('p', 'small mi-rows-name', f.path), pre);
      }
    } catch (err) {
      code.append(el('p', 'mi-error small', err.message));
    }
  });
  c.append(code);
  const acts = el('div', 'mi-actions');
  if (['rule', 'guard', 'feature'].includes(tr.type)) c.append(decisionRow(cd, 'code'));
  else {
    const off = cd.state === 'skipped';
    acts.append(btn(off ? t('✓ Skipped') : t('Skip'), off ? 'primary' : 'ghost', async (b) => {
      b.disabled = true;
      await api(`/movein/bundles/${enc(state.bundle)}/translations/code`, { method: 'POST', body: { key: cd.key, decision: off ? 'reset' : 'skip' } }).catch(() => null);
      await loadTranslations();
    }));
  }
  acts.append(btn(t('Ask her to read it'), 'ghost small', async (b) => {
    b.disabled = true;
    try {
      await api(`/movein/bundles/${enc(state.bundle)}/translations/ask`, { method: 'POST', body: { key: cd.key, localOnly: state.localOnly } });
      b.textContent = t('She is reading it…');
      setTimeout(() => void loadTranslations(), 800);
    } catch (err) {
      b.disabled = false;
      acts.append(el('p', 'mi-error small', err.message));
    }
  }), tip(t('Her model reads the code as untrusted text (your own hardware only, unless you allowed other models for the store cards). Every claim must quote the code.')));
  c.append(acts);
  return c;
}
