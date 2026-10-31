// Phase 104 (MI1, docs/design/MOVE_IN.md §7, §12): Settings → Data & health → Move in from another
// agent. Three steps (get the collector, run it, upload the file), then what the collector packed,
// the preview (one card per destination with counts and three folded samples, the personality card
// to decide by hand, "Was this her?", held categories), Import as one batch with Stop, her report
// and Undo. Every string goes through t(); colours only through theme tokens (web/movein.css).
import { serverText, t } from './naming.js';

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

let helpers = { copyText: async () => {}, openConversation: () => {} };
let state = { overview: null, bundle: null, preview: null, choices: null, paused: false, uploading: null, poll: 0 };

const SECTION_NAME = {
  persona: () => t('Personality'),
  memories: () => t('Memories'),
  profile: () => t('About you'),
  conversations: () => t('Past conversations'),
  skills: () => t('Skills'),
  schedules: () => t('Schedules'),
  board: () => t('Board'),
  reflections: () => t('Reflections'),
};
const SECTION_TIP = {
  memories: () => t('Her notes from the old agent, sorted into facts, decisions and promises. Duplicates are merged. Over 2,000 notes, the rest arrive archived: searchable, never brought up by themselves.'),
  profile: () => t('What the old agent knew about you (USER.md). Replaced directives come along as old notes she does not use.'),
  conversations: () => t('Your old chats become past conversations with their dates. She learns facts and style from the last 90 days in the background; older ones stay readable.'),
  skills: () => t('Skill folders become her skills. Skills that run scripts stay off until you check them; nothing runs during the move.'),
  schedules: () => t('Repeating jobs become tasks with the same repeat, one-off ones reminders. Tasks never act by themselves, so nothing messages anyone from here until you say so.'),
  board: () => t('Board cards land on a board of their own, in matching columns. Cards that were running are not restarted.'),
  reflections: () => t('Her diary-like looking back (DREAMS.md). Off unless you want her to keep it.'),
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
  if (state.bundle && ev?.id === state.bundle) void refresh();
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
  for (const key of ['memories', 'profile', 'conversations', 'skills', 'schedules', 'board', 'reflections']) {
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
      // Her name, picture line and companion list show the new personality right away.
      document.dispatchEvent(new CustomEvent('sara:persona-changed'));
      await refresh();
    } catch (err) {
      b.disabled = false;
      $('#mi-note').textContent = err.message;
    }
  });
  imp.disabled = Boolean(personaPending);
  go.append(imp, btn(t('Not now'), 'ghost', async () => {
    state.choices = null;
    state.bundle = null;
    work();
  }), btn(t('Delete the bundle now'), 'ghost', deleteBundle));
  const note = el('p', 'muted small');
  note.id = 'mi-note';
  note.textContent = personaPending ? t('Decide on her personality first (above).') : t('Nothing is changed until you press Import. Undo removes it all for 30 days.');
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
  s.append(el('strong', '', t('Read in the next updates ({n})', { n: list.length })), tip(t('Custom stores, settings, hooks and plugins stay in the bundle. Sara reads them in the 2.38 and 2.39 updates: import the same bundle again then and only the new parts come in.')));
  c.append(s);
  const ul = el('ul', 'small');
  for (const x of list) ul.append(el('li', '', x.what));
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
  if (b?.report) c.append(reportView(b.report));
  const acts = el('div', 'mi-actions');
  if (b) acts.append(btn(t('Undo this move-in'), 'danger', () => undo(b.id)));
  acts.append(btn(t('Delete the bundle now'), 'ghost', deleteBundle));
  c.append(acts, el('p', 'muted small', t('The bundle is deleted from the server 48 hours after the move-in. Delete your own copy too.')));
  work(c);
  void loadOverview();
}

function reportView(r) {
  const box = el('div', 'mi-report');
  const list = (title, lines, cls) => {
    if (!lines?.length) return;
    const sec = el('div', `mi-report-list ${cls}`);
    sec.append(el('h5', '', `${title} (${lines.reduce((n, l) => n + (l.count || 0), 0)})`));
    const ul = el('ul', 'small');
    for (const l of lines) ul.append(el('li', '', reportLine(l)));
    sec.append(ul);
    box.append(sec);
  };
  list(t('Imported'), r.imported, 'mi-r-in');
  list(t('Translated'), r.translated, 'mi-r-tr');
  list(t('Needs you'), r.needsYou, 'mi-r-need');
  list(t('Left behind'), r.leftBehind, 'mi-r-left');
  return box;
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
    schedules: () => t('Old schedules → {n} tasks and reminders (they never act by themselves)', { n: l.count }),
    'skills-held': () => t('{n} skills run scripts: off until you check them (Settings → Abilities → Skills)', { n: l.count }),
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

function renderBatches() {
  const box = $('#mi-batches');
  if (!box || !state.overview) return;
  const list = state.overview.batches ?? [];
  if (!list.length) {
    box.replaceChildren(el('p', 'muted small', t('None yet.')));
    return;
  }
  const ul = el('ul', 'mi-batch-list');
  for (const b of list) {
    const li = el('li', 'mi-batch');
    const label = { done: t('moved in'), partial: t('stopped part way'), undone: t('undone'), importing: t('moving in…') }[b.state] ?? b.state;
    li.append(el('span', 'mi-batch-name', `${b.agentName} · ${b.sourceKind === 'openclaw' ? 'OpenClaw' : 'Hermes Agent'}`), el('span', 'muted small', `${fmtDate(b.createdAt)} · ${label}`));
    if (b.state === 'done' || b.state === 'partial') li.append(btn(t('Undo'), 'ghost small', () => undo(b.id)));
    ul.append(li);
  }
  box.replaceChildren(ul);
}
