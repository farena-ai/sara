// Phase 96 (ST1): Settings → Abilities → Skills (docs/design/STAPLES.md §4.11), and the skill
// cards in the chat. A card per skill: its name, what it is for, where it lives, how often she used
// it, an on/off switch for this companion and a ⋯ menu (open, export, copy, delete). On top: New
// skill (a simple editor), Add a skill (a .zip, a git address or a folder on the server, then a
// review card that shows every file and script before anything is added), From a recipe and Export
// all. Workspaces whose own skills are not trusted yet are listed with a Trust button (owner only).
import { currentIdentity, serverText, t } from './naming.js';
import { icon } from './icons.js';
import { overflowMenu } from './tidy.js';

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
const herName = () => currentIdentity().name || t('Sara');

/** Where a skill lives, in plain words. */
export function scopeWords(scope) {
  if (scope === 'companion') return t('This companion');
  if (scope === 'shared') return t('All my companions');
  if (scope === 'builtin') return t('Built in');
  if (String(scope).startsWith('project:')) return t('Project {name}', { name: scope.slice(8) });
  return scope;
}

// The lenient reader's notes (src/skills.ts): the English templates the server sends, in the app's language.
const DIAG = {
  'unquoted-colon': (p) => t('The {field} has an unquoted ": " in it; it was read as plain text.', p),
  'too-big': (p) => t('SKILL.md is larger than {kb} KB, so it was not read.', p),
  'no-frontmatter': () => t('SKILL.md has no frontmatter (it must start with a line of three dashes).'),
  'bad-yaml': (p) => t("The frontmatter couldn't be read ({why}).", p),
  'no-description': () => t('The description is missing, so she would never know when to use it.'),
  'no-name': (p) => t('The name is missing; the folder name "{folder}" is used.', p),
  'name-folder': (p) => t('The name "{name}" does not match its folder "{folder}"; the folder name is used.', p),
  'name-long': (p) => t('The name is longer than {n} characters.', p),
  'name-chars': () => t('The name should be lower-case letters, digits and single hyphens.'),
  'folder-chars': (p) => t('The folder name "{folder}" is not a valid skill name.', p),
  'description-long': (p) => t('The description is longer than {n} characters; it is cut in her list.', p),
  'metadata-shape': () => t('metadata should be a map of names to text; it was left out.'),
  'compat-long': (p) => t('compatibility is longer than {n} characters.', p),
  'body-long': (p) => t('The body has {n} lines; under {max} is advised.', p),
  folder: (p) => t("The folder can't be used: {why}", p),
};
const diagText = (d) => (DIAG[d.code] ? DIAG[d.code](d.params ?? {}) : d.message);

// What the import scan found (src/packages.ts scanPackage).
const FINDING = {
  injection: (f) => t('In {file}: “{text}” looks like an attempt to change her instructions.', { file: f.file, text: f.text }),
  egress: (f) => t('In {file}: sends data to {host}.', { file: f.file, host: f.host ?? '?' }),
  secret: (f) => t('In {file}: contains what looks like a key or password.', { file: f.file }),
  binary: (f) => t('{file} is not a text file.', { file: f.file }),
};

function chip(text, cls = '') {
  return el('span', `skl-chip${cls ? ` ${cls}` : ''}`, text);
}

function usedLine(s) {
  if (!s.uses) return t('Not used yet');
  const day = s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : '';
  return day ? t('Uses: {n} · last on {day}', { n: s.uses, day }) : t('Uses: {n}', { n: s.uses });
}

let state = { skills: [], scopes: [], projects: [], trusted: [], recipes: [], member: false, migration: null };

function status(text) {
  const s = $('#skl-status');
  if (s) s.textContent = text ?? '';
}

export async function loadSkills() {
  const box = $('#skl-list');
  if (!box) return;
  try {
    state = await api('/skills');
  } catch (err) {
    box.replaceChildren(el('p', 'muted small', err.message));
    return;
  }
  renderMigration();
  renderProjects();
  renderRecipes();
  renderList();
}

function renderMigration() {
  const p = $('#skl-migrated');
  const m = state.migration;
  p.hidden = !m;
  if (!m) return;
  p.replaceChildren(el('span', '', t('Recipes are skills now: {n} of your recipes became skills ({names}).', { n: m.count, names: m.names.slice(0, 6).join(', ') })), btn(t('Got it'), 'ghost', async () => {
    await api('/skills/migration/seen', { method: 'POST', body: {} }).catch(() => {});
    p.hidden = true;
  }));
}

function renderProjects() {
  const box = $('#skl-projects');
  const head = $('#skl-projects-head');
  const any = !state.member && (state.projects.length || state.trusted.length);
  box.hidden = !any;
  head.hidden = !any;
  if (!any) return;
  const rows = [];
  for (const p of state.projects) {
    const card = el('div', 'skl-project');
    card.append(el('p', '', t('Workspace {ws} has skills of its own: {names}.', { ws: p.workspace, names: p.names.join(', ') })));
    card.append(el('p', 'muted small', t('Only trust a project you know: its skills can steer her while she works there.')));
    card.append(btn(t('Trust its skills'), '', async (b) => {
      b.disabled = true;
      try {
        await api('/skills/trust-project', { method: 'POST', body: { workspace: p.workspace, trusted: true } });
        await loadSkills();
      } catch (err) {
        status(err.message);
        b.disabled = false;
      }
    }));
    rows.push(card);
  }
  for (const ws of state.trusted) {
    const card = el('div', 'skl-project');
    card.append(el('p', '', t('Workspace {ws}: its skills are trusted.', { ws })));
    card.append(btn(t('Stop trusting'), 'ghost', async (b) => {
      b.disabled = true;
      try {
        await api('/skills/trust-project', { method: 'POST', body: { workspace: ws, trusted: false } });
        await loadSkills();
      } catch (err) {
        status(err.message);
        b.disabled = false;
      }
    }));
    rows.push(card);
  }
  box.replaceChildren(...rows);
}

function renderRecipes() {
  const row = $('#skl-recipe-row');
  const sel = $('#skl-recipe');
  const left = state.recipes.filter((r) => !r.skill);
  row.hidden = state.member || !left.length;
  sel.replaceChildren(...left.map((r) => {
    const o = el('option', '', r.title);
    o.value = String(r.id);
    return o;
  }));
}

function renderList() {
  const box = $('#skl-list');
  const show = $('#skl-show').value;
  const list = state.skills.filter((s) => (show === 'on' ? s.enabled : show === 'mine' ? s.scope === 'companion' || s.scope === 'shared' : show === 'builtin' ? s.scope === 'builtin' : true));
  if (!list.length) {
    box.replaceChildren(el('p', 'muted small', state.skills.length ? t('No skills match.') : t('No skills yet. Make one with New skill, or add one from a zip, a git address or a folder.')));
    return;
  }
  box.replaceChildren(...list.map(card));
}

function card(s) {
  const c = el('div', `skl-card${s.enabled ? '' : ' off'}`);
  c.dataset.scope = s.scope;
  c.dataset.name = s.name;
  const head = el('div', 'skl-card-head');
  const ic = el('span', 'skl-icon');
  ic.setAttribute('aria-hidden', 'true');
  const svg = icon(s.scope === 'builtin' ? 'sparkle' : 'book');
  if (svg) ic.append(svg);
  const title = el('button', 'skl-title');
  title.type = 'button';
  title.append(el('strong', '', s.name), el('span', 'skl-desc', s.description || t('(no description)')));
  title.addEventListener('click', () => void openSkill(s.scope, s.name));
  const sw = el('label', 'skl-switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.checked = s.enabled;
  input.setAttribute('aria-label', t('Use {name}', { name: s.name }));
  input.addEventListener('change', async () => {
    try {
      await api(`/skills/${enc(s.scope)}/${enc(s.name)}/enable`, { method: 'POST', body: { enabled: input.checked } });
      s.enabled = input.checked;
      c.classList.toggle('off', !input.checked);
      status(input.checked ? t('{name} is on.', { name: s.name }) : t('{name} is off.', { name: s.name }));
      void loadSkills();
    } catch (err) {
      input.checked = !input.checked;
      status(err.message);
    }
  });
  sw.append(input, el('span', 'skl-knob'));
  const more = el('button', 'ghost skl-more', '⋯');
  more.type = 'button';
  more.dataset.moreId = `skl-${s.scope}-${s.name}`;
  more.setAttribute('aria-label', t('More for {name}', { name: s.name }));
  const actions = el('div', 'skl-actions-hidden');
  actions.hidden = true;
  actions.append(btn(t('Open'), '', () => openSkill(s.scope, s.name)));
  actions.append(btn(t('Export'), '', () => download(`/api/skills/${enc(s.scope)}/${enc(s.name)}/export`)));
  if (s.scope === 'builtin' || s.scope.startsWith('project:') || s.scope === 'shared') actions.append(btn(t('Copy to this companion'), '', () => copy(s, 'companion')));
  if (s.scope === 'companion' && state.scopes.includes('shared')) actions.append(btn(t('Copy to all my companions'), '', () => copy(s, 'shared')));
  if (s.scope === 'companion' || s.scope === 'shared') actions.append(btn(t('Delete'), 'danger-text', () => remove(s)));
  overflowMenu(more, actions);
  head.append(ic, title, sw, more, actions);
  const chips = el('div', 'skl-chips');
  chips.append(chip(scopeWords(s.scope)));
  if (s.source === 'imported') chips.append(chip(t('Added from outside')));
  if (s.source === 'recipe') chips.append(chip(t('From a recipe')));
  if (s.status === 'needs-review') chips.append(chip(t('Changed: needs a new review'), 'warn'));
  if (s.status === 'broken') chips.append(chip(t("Can't be read"), 'bad'));
  if (s.shadowedBy) chips.append(chip(t('Hidden by the one in {where}', { where: scopeWords(s.shadowedBy) }), 'muted'));
  if (s.pinned) chips.append(chip(t('Always listed')));
  if (s.scriptsAuto) chips.append(chip(t('Scripts run without asking'), 'warn'));
  const warns = s.diagnostics.filter((d) => d.level === 'error' || d.code === 'name-folder' || d.code === 'description-long');
  c.append(head, chips, el('p', 'skl-used muted small', usedLine(s)));
  if (warns.length) c.append(el('p', 'skl-diag small', warns.map(diagText).join(' ')));
  return c;
}

function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

async function copy(s, to) {
  try {
    await api(`/skills/${enc(s.scope)}/${enc(s.name)}/copy`, { method: 'POST', body: { to } });
    status(t('Copied {name} to {where}.', { name: s.name, where: scopeWords(to) }));
    await loadSkills();
  } catch (err) {
    status(err.message);
  }
}

async function remove(s) {
  if (!confirm(t('Delete the skill "{name}"? It goes to the trash for 30 days.', { name: s.name }))) return;
  try {
    await api(`/skills/${enc(s.scope)}/${enc(s.name)}`, { method: 'DELETE' });
    status(t('Deleted {name}.', { name: s.name }));
    $('#skill-editor').close();
    await loadSkills();
  } catch (err) {
    status(err.message);
  }
}

// ---------------------------------------------------------------------------------------------
// The editor (a dialog; a full-screen sheet on phones)
// ---------------------------------------------------------------------------------------------

let editing = null;
const slug = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '');

function editorMode(readOnly, fresh) {
  const d = $('#skill-editor');
  d.classList.toggle('read-only', readOnly);
  for (const id of ['#ske-desc', '#ske-body', '#ske-file-name', '#ske-file-text']) $(id).readOnly = readOnly;
  $('#ske-new-only').hidden = !fresh;
  $('#ske-old-only').hidden = fresh;
  $('#ske-save').hidden = readOnly;
  $('#ske-copy').hidden = !readOnly;
  $('#ske-delete').hidden = fresh || readOnly;
  $('#ske-file-row').hidden = readOnly;
}

export function newSkill() {
  editing = null;
  const d = $('#skill-editor');
  $('#ske-heading').textContent = t('New skill');
  for (const id of ['#ske-title-in', '#ske-name', '#ske-desc', '#ske-body', '#ske-file-name', '#ske-file-text']) $(id).value = '';
  $('#ske-scope').replaceChildren(...state.scopes.map((s) => {
    const o = el('option', '', scopeWords(s));
    o.value = s;
    return o;
  }));
  $('#ske-files').replaceChildren();
  $('#ske-info').replaceChildren();
  $('#ske-status').textContent = '';
  editorMode(false, true);
  d.showModal();
  $('#ske-title-in').focus();
}

export async function openSkill(scope, name) {
  let s;
  try {
    s = await api(`/skills/${enc(scope)}/${enc(name)}`);
  } catch (err) {
    status(err.message);
    return;
  }
  editing = s;
  const ro = scope === 'builtin' || scope.startsWith('project:');
  $('#ske-heading').textContent = s.name;
  $('#ske-desc').value = s.description;
  $('#ske-body').value = s.body;
  $('#ske-file-name').value = '';
  $('#ske-file-text').value = '';
  $('#ske-pin').checked = s.pinned;
  $('#ske-scripts').checked = s.scriptsAuto;
  $('#ske-scripts-row').hidden = ro || !s.files.some((f) => f.script) || state.member;
  $('#ske-version').replaceChildren(el('option', '', t('Choose a version…')), ...s.versions.map((v) => {
    const o = el('option', '', `${t('Version {n}', { n: v.version })} · ${new Date(v.at).toLocaleString()}${v.why ? ` · ${v.why}` : ''}`);
    o.value = String(v.version);
    return o;
  }));
  $('#ske-version-row').hidden = ro || !s.versions.length;
  const info = [el('span', '', scopeWords(s.scope)), el('span', '', usedLine(s))];
  if (s.license) info.push(el('span', '', t('License: {l}', { l: s.license })));
  if (s.compatibility) info.push(el('span', '', t('Needs: {c}', { c: s.compatibility })));
  if (s.allowedTools) info.push(el('span', '', t('The skill says it uses: {tools} (shown only; it changes nothing)', { tools: s.allowedTools })));
  $('#ske-info').replaceChildren(...info);
  if (s.status === 'needs-review') {
    const p = el('p', 'skl-warn', t('This skill changed on disk since you added it. Read it, then keep it as it is now, or delete it.'));
    p.append(btn(t('Keep it as it is now'), '', async () => {
      try {
        await api(`/skills/${enc(scope)}/${enc(name)}/approve`, { method: 'POST', body: {} });
        await loadSkills();
        await openSkill(scope, name);
      } catch (err) {
        $('#ske-status').textContent = err.message;
      }
    }));
    $('#ske-info').append(p);
  }
  for (const d of s.diagnostics) $('#ske-info').append(el('p', 'skl-diag small', diagText(d)));
  $('#ske-files').replaceChildren(...s.files.map((f) => fileRow(f)));
  $('#ske-status').textContent = '';
  editorMode(ro, false);
  if (!$('#skill-editor').open) $('#skill-editor').showModal();
}

function fileRow(f) {
  const li = el('li', f.script ? 'skl-file script' : 'skl-file');
  li.append(el('code', '', f.path), el('span', 'muted small', `${Math.max(1, Math.round(f.size / 1024))} KB`));
  if (f.script) li.append(chip(t('Script: asks before it runs'), 'warn'));
  return li;
}

async function saveEditor() {
  const st = $('#ske-status');
  const file = $('#ske-file-name').value.trim() ? [{ path: $('#ske-file-name').value.trim(), content: $('#ske-file-text').value }] : undefined;
  try {
    if (!editing) {
      const name = $('#ske-name').value.trim() || slug($('#ske-title-in').value);
      const body = $('#ske-body').value;
      const made = await api('/skills', { method: 'POST', body: { scope: $('#ske-scope').value, name, description: $('#ske-desc').value, body, ...(file ? { files: file } : {}) } });
      await loadSkills();
      await openSkill(made.scope, made.name);
      $('#ske-status').textContent = t('Saved.');
      return;
    }
    await api(`/skills/${enc(editing.scope)}/${enc(editing.name)}`, { method: 'PUT', body: { description: $('#ske-desc').value, body: $('#ske-body').value, ...(file ? { files: file } : {}) } });
    await loadSkills();
    await openSkill(editing.scope, editing.name);
    $('#ske-status').textContent = t('Saved. The old version is kept.');
  } catch (err) {
    st.textContent = err.message;
  }
}

async function switchOn(field, value) {
  if (!editing) return;
  try {
    await api(`/skills/${enc(editing.scope)}/${enc(editing.name)}/enable`, { method: 'POST', body: { [field]: value } });
    $('#ske-status').textContent = t('Saved.');
    void loadSkills();
  } catch (err) {
    $('#ske-status').textContent = err.message;
    if (field === 'scriptsAuto') $('#ske-scripts').checked = !value;
    if (field === 'pinned') $('#ske-pin').checked = !value;
  }
}

// ---------------------------------------------------------------------------------------------
// Add a skill: a .zip, a git address or a server folder, then the review card
// ---------------------------------------------------------------------------------------------

let pending = null;

export function openImport() {
  pending = null;
  $('#ski-url').value = '';
  $('#ski-path').value = '';
  $('#ski-file').value = '';
  $('#ski-review').replaceChildren();
  $('#ski-review-row').hidden = true;
  $('#ski-status').textContent = '';
  $('#ski-path-row').hidden = state.member;
  pickSource('zip');
  $('#ski-scope').replaceChildren(...state.scopes.map((s) => {
    const o = el('option', '', scopeWords(s));
    o.value = s;
    return o;
  }));
  $('#skill-import').showModal();
}

function pickSource(kind) {
  for (const b of document.querySelectorAll('#ski-sources .pick-card')) b.setAttribute('aria-checked', String(b.dataset.kind === kind));
  $('#ski-zip-row').hidden = kind !== 'zip';
  $('#ski-url-row').hidden = kind !== 'git';
  $('#ski-folder-row').hidden = kind !== 'folder';
  $('#ski-sources').dataset.kind = kind;
}

async function lookAtIt(b) {
  const kind = $('#ski-sources').dataset.kind;
  const st = $('#ski-status');
  st.textContent = t('Reading it…');
  b.disabled = true;
  try {
    if (kind === 'zip') {
      const f = $('#ski-file').files?.[0];
      if (!f) throw new Error(t('Choose a .zip file first.'));
      pending = await api(`/skills/import?name=${enc(f.name)}`, { method: 'POST', raw: await f.arrayBuffer() });
    } else if (kind === 'git') pending = await api('/skills/import', { method: 'POST', body: { url: $('#ski-url').value.trim() } });
    else pending = await api('/skills/import', { method: 'POST', body: { path: $('#ski-path').value.trim() } });
    st.textContent = '';
    renderReview();
  } catch (err) {
    st.textContent = err.message;
  } finally {
    b.disabled = false;
  }
}

/** The review card: everything in the skill before it is added (name, what it says, files, scripts, warnings). */
export function reviewCard(s, many) {
  const c = el('div', `skl-review${s.ok ? '' : ' bad'}`);
  const head = el('div', 'skl-review-head');
  if (many && s.ok) {
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.checked = true;
    pick.dataset.name = s.name;
    pick.className = 'ski-pick';
    pick.setAttribute('aria-label', t('Add {name}', { name: s.name }));
    head.append(pick);
  }
  head.append(el('strong', '', s.name));
  if (s.exists) head.append(chip(t('You already have one with this name: this one gets a new name'), 'warn'));
  c.append(head, el('p', 'skl-desc', s.description || t('(no description)')));
  const facts = el('div', 'skl-chips');
  const scripts = s.files.filter((f) => f.script);
  facts.append(chip(t('Files: {n}', { n: s.files.length })));
  facts.append(chip(scripts.length ? t('Scripts: {n}', { n: scripts.length }) : t('No scripts'), scripts.length ? 'warn' : ''));
  if (s.license) facts.append(chip(t('License: {l}', { l: s.license })));
  c.append(facts);
  if (s.allowedTools) c.append(el('p', 'small', t('The skill says it uses: {tools} (shown only; it changes nothing)', { tools: s.allowedTools })));
  if (s.compatibility) c.append(el('p', 'small', t('Needs: {c}', { c: s.compatibility })));
  const risky = s.findings.filter((f) => f.kind !== 'script');
  if (risky.length) {
    const w = el('ul', 'skl-findings');
    for (const f of risky.slice(0, 20)) w.append(el('li', '', FINDING[f.kind] ? FINDING[f.kind](f) : f.text));
    c.append(el('p', 'skl-warn', t('Look at these before you add it:')), w);
  }
  for (const d of s.diagnostics) c.append(el('p', 'skl-diag small', diagText(d)));
  if (scripts.length) c.append(el('p', 'small muted', t('Scripts never run by themselves: each run asks you first and shows the script.')));
  const files = el('ul', 'skl-files');
  files.append(...s.files.map(fileRow));
  const body = el('div', 'skl-body');
  body.dataset.raw = '';
  body.textContent = s.body;
  const det = el('details', 'skl-body-box');
  det.open = true;
  det.append(el('summary', '', t('What it tells her')), body);
  c.append(el('p', 'small', t('Files in it:')), files, det);
  return c;
}

function renderReview() {
  const box = $('#ski-review');
  const many = pending.skills.length > 1;
  box.replaceChildren(el('p', 'small', many ? t('{n} skills in {origin}. Untick the ones you don\'t want.', { n: pending.skills.length, origin: pending.origin }) : t('From {origin}:', { origin: pending.origin })), ...pending.skills.map((s) => reviewCard(s, many)));
  $('#ski-review-row').hidden = !pending.skills.some((s) => s.ok);
  // The places it can go come with the review (the list may not have loaded yet).
  const sel = $('#ski-scope');
  if (Array.isArray(pending.scopes) && pending.scopes.length && sel.options.length !== pending.scopes.length) {
    sel.replaceChildren(...pending.scopes.map((s) => {
      const o = el('option', '', scopeWords(s));
      o.value = s;
      return o;
    }));
  }
  box.scrollIntoView({ block: 'nearest' });
}

async function acceptImport(b) {
  if (!pending) return;
  const names = [...document.querySelectorAll('#ski-review .ski-pick')].filter((x) => x.checked).map((x) => x.dataset.name);
  b.disabled = true;
  try {
    const r = await api(`/skills/import/${enc(pending.id)}/accept`, { method: 'POST', body: { scope: $('#ski-scope').value, ...(pending.skills.length > 1 ? { names } : {}) } });
    pending = null;
    $('#skill-import').close();
    status(t('Added: {names}.', { names: r.skills.map((s) => s.name).join(', ') }));
    await loadSkills();
  } catch (err) {
    $('#ski-status').textContent = err.message;
  } finally {
    b.disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------
// The skill cards in the chat (skill_run / skill_save / skill_update approvals)
// ---------------------------------------------------------------------------------------------

/** Fills an approval card for a skill (`ev.skill`): the section and only the answers it allows. */
export function skillApproval(card, title, ev, decide) {
  const k = ev.skill;
  card.classList.add('approval-skill', 'approval-tidy');
  title.className = 'approval-title';
  title.dataset.raw = '';
  const sec = el('div', 'skl-approval');
  const row = el('div', 'row');
  const yes = (label, how) => btn(label, '', () => decide(true, how));
  const no = (label) => btn(label, 'ghost', () => decide(false));
  if (k.kind === 'skill') {
    title.textContent = t('{name} wants to run a script from the skill “{skill}”', { name: herName(), skill: k.skill });
    sec.append(el('p', 'small', t('Where it lives: {where}', { where: scopeWords(k.scope) })));
    if (k.source === 'imported') sec.append(el('p', 'skl-warn small', t('This skill was added from outside: read the script before you allow it.')));
    sec.append(el('p', 'small', t('Script: {path}', { path: k.script })));
    sec.append(el('p', 'small', k.args.length ? t('Arguments: {args}', { args: k.args.join(' ') }) : t('No arguments')));
    const pre = el('pre', 'skl-head', k.head || t('(empty file)'));
    pre.dataset.raw = '';
    sec.append(el('p', 'small muted', t('Its first 40 lines:')), pre);
    if (k.allowedTools) sec.append(el('p', 'small muted', t('The skill says it uses: {tools} (shown only; it changes nothing)', { tools: k.allowedTools })));
    row.append(yes(t('Allow once')), ...(k.choices.includes('task') ? [yes(t('Allow for this task'), 'task')] : []), no(t('Deny')));
  } else if (k.kind === 'skill-draft') {
    title.textContent = k.exists ? t('{name} wants to change her skill “{skill}”', { name: herName(), skill: k.skill }) : t('{name} wants to save a new skill “{skill}”', { name: herName(), skill: k.skill });
    const pre = el('pre', 'skl-head', k.skillMd);
    pre.dataset.raw = '';
    sec.append(pre, el('p', 'small muted', t('You can edit it afterwards in Settings → Abilities → Skills.')));
    row.append(yes(t('Save it')), no(t("Don't save")));
  } else {
    title.textContent = t('{name} wants to change her skill “{skill}”', { name: herName(), skill: k.skill });
    if (k.why) sec.append(el('p', 'small', t('Why: {why}', { why: k.why })));
    const pair = (label, v) => {
      const box = el('div', 'skl-change');
      const pre = el('pre', 'skl-head', `${v.description}\n\n${v.body}`);
      pre.dataset.raw = '';
      box.append(el('p', 'small muted', label), pre);
      return box;
    };
    sec.append(pair(t('Now'), k.before), pair(t('After'), k.after), el('p', 'small muted', t('The old version is kept.')));
    row.append(yes(t('Change it')), no(t('Keep it as it is')));
  }
  card.append(title, sec, row);
}

export function initSkills() {
  if (!$('#skl-list')) return;
  $('#skl-new').addEventListener('click', newSkill);
  $('#skl-add').addEventListener('click', openImport);
  $('#skl-export-all').addEventListener('click', () => download('/api/skills/export'));
  $('#skl-show').addEventListener('change', renderList);
  $('#skl-recipe-go').addEventListener('click', async () => {
    try {
      const v = await api('/skills/from-recipe', { method: 'POST', body: { id: Number($('#skl-recipe').value) } });
      status(t('{name} is a skill now.', { name: v.name }));
      await loadSkills();
    } catch (err) {
      status(err.message);
    }
  });
  $('#ske-title-in').addEventListener('input', () => {
    if (!editing && !$('#ske-name').dataset.typed) $('#ske-name').value = slug($('#ske-title-in').value);
  });
  $('#ske-name').addEventListener('input', () => ($('#ske-name').dataset.typed = $('#ske-name').value ? '1' : ''));
  $('#ske-save').addEventListener('click', () => void saveEditor());
  $('#ske-delete').addEventListener('click', () => editing && void remove(editing));
  $('#ske-copy').addEventListener('click', () => editing && void copy(editing, 'companion').then(() => $('#skill-editor').close()));
  $('#ske-pin').addEventListener('change', () => void switchOn('pinned', $('#ske-pin').checked));
  $('#ske-scripts').addEventListener('change', () => void switchOn('scriptsAuto', $('#ske-scripts').checked));
  $('#ske-restore').addEventListener('click', async () => {
    const v = Number($('#ske-version').value);
    if (!editing || !v) return;
    try {
      await api(`/skills/${enc(editing.scope)}/${enc(editing.name)}/restore`, { method: 'POST', body: { version: v } });
      await loadSkills();
      await openSkill(editing.scope, editing.name);
      $('#ske-status').textContent = t('Went back to version {n}.', { n: v });
    } catch (err) {
      $('#ske-status').textContent = err.message;
    }
  });
  for (const b of document.querySelectorAll('#ski-sources .pick-card')) b.addEventListener('click', () => pickSource(b.dataset.kind));
  $('#ski-look').addEventListener('click', (e) => void lookAtIt(e.currentTarget));
  $('#ski-accept').addEventListener('click', (e) => void acceptImport(e.currentTarget));
  $('#ski-cancel').addEventListener('click', async () => {
    if (pending) await api(`/skills/import/${enc(pending.id)}`, { method: 'DELETE' }).catch(() => {});
    pending = null;
    $('#skill-import').close();
  });
}
