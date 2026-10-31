// Phase 100 (ST5, docs/design/STAPLES.md §8.6, docs/A2A.md): Settings → Connections → Other agents.
// Her switches (let other agents reach her, her name on the public card, the home network in private
// mode, the name she answers for), her agent card address, the agents (In: may ask her; Out: she may
// ask), "Give an agent a key" (a checklist of what it may do, shown once), "Add an agent she can ask"
// (its card as a review card, the shared proposal card), and the last 20 requests. Everything an
// agent sends is set as text: nothing from outside becomes markup.
import { serverText, t } from './naming.js';
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
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}
const enc = encodeURIComponent;
/** A ? tip made in code (the app's tip handler opens it like the ones in the page). */
function tip(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  return b;
}

let state = { settings: {}, peers: [], recent: [], skills: [], card: null, cardUrl: '' };
let helpers = { copyText: async () => {}, openConversation: () => {} };
let review = null;

function status(text) {
  const s = $('#a2a-status');
  if (s) s.textContent = text ?? '';
}

const STATE = {
  TASK_STATE_SUBMITTED: () => t('Waiting to start'),
  TASK_STATE_WORKING: () => t('Working'),
  TASK_STATE_INPUT_REQUIRED: () => t('Needs an answer'),
  TASK_STATE_AUTH_REQUIRED: () => t('Waiting for your OK'),
  TASK_STATE_COMPLETED: () => t('Done'),
  TASK_STATE_FAILED: () => t('Failed'),
  TASK_STATE_CANCELED: () => t('Canceled'),
  TASK_STATE_REJECTED: () => t('Turned away'),
};
export const taskStateText = (s) => STATE[s]?.() ?? s;

export function initAgents(h) {
  helpers = { ...helpers, ...h };
  const save = async (patch) => {
    try {
      const r = await api('/agents', { method: 'PUT', body: patch });
      state.settings = r.settings;
      status(t('Saved.'));
      await loadAgents();
    } catch (err) {
      status(err.message);
    }
  };
  $('#a2a-on')?.addEventListener('change', (e) => void save({ enabled: e.target.checked }));
  $('#a2a-name')?.addEventListener('change', (e) => void save({ showName: e.target.checked }));
  $('#a2a-lan')?.addEventListener('change', (e) => void save({ lanInPrivate: e.target.checked }));
  $('#a2a-operator')?.addEventListener('change', (e) => void save({ operator: e.target.value }));
  $('#a2a-card-copy')?.addEventListener('click', () => void helpers.copyText(state.cardUrl, $('#a2a-card-copy')));
  $('#a2a-in-copy')?.addEventListener('click', () => void helpers.copyText($('#a2a-in-token').textContent, $('#a2a-in-copy')));
  $('#a2a-in-make')?.addEventListener('click', () => void makeKey());
  $('#a2a-out-look')?.addEventListener('click', () => void lookUp());
  $('#a2a-out-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void lookUp();
    }
  });
}

export async function loadAgents() {
  const box = $('#a2a-peers');
  if (!box) return;
  try {
    state = await api('/agents');
  } catch (err) {
    $('#a2a-off').hidden = false;
    $('#a2a-off').textContent = err.status === 403 || err.status === 404 ? t('Other agents are off on this server.') : err.message;
    box.replaceChildren();
    return;
  }
  $('#a2a-off').hidden = true;
  const s = state.settings;
  $('#a2a-on').checked = Boolean(s.enabled);
  $('#a2a-name').checked = Boolean(s.showName);
  $('#a2a-lan').checked = Boolean(s.lanInPrivate);
  if (document.activeElement !== $('#a2a-operator')) $('#a2a-operator').value = s.operator === 'its owner' ? '' : (s.operator ?? '');
  $('#a2a-card-url').textContent = state.cardUrl;
  $('#a2a-card-sum').textContent = s.enabled
    ? t('Her public card says "{name}", a personal AI assistant, and that a key is needed. Streaming: yes · push notifications: no.', { name: state.card?.name ?? 'Sara' })
    : t('Off: nobody can see her card or send her tasks.');
  renderSkills($('#a2a-in-skills'), []);
  renderPeers();
  renderRecent();
}

/** The "Use these skills" ticks (her skills she may offer an agent). */
function renderSkills(box, picked, prefix = 'a2a-in-skill') {
  if (!box) return;
  box.replaceChildren();
  if (!state.skills.length) return;
  const head = el('p', 'small a2a-skills-head');
  head.append(el('span', '', t('Use these skills:')), ' ', tip(t('Her skills this agent may use. They are listed on its card, and she follows one when it asks for it. Skill scripts never run for an agent.')));
  box.append(head);
  for (const s of state.skills) {
    const row = el('label', 'row a2a-skill');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = s.name;
    input.checked = picked.includes(s.name);
    input.id = `${prefix}-${s.name}`;
    row.append(input, ' ', el('span', '', s.name), el('span', 'muted small', ` ${s.description}`));
    box.append(row);
  }
}
const pickedSkills = (box) => [...(box?.querySelectorAll('input[type=checkbox]:checked') ?? [])].map((i) => i.value);

async function makeKey() {
  const label = $('#a2a-in-label').value.trim();
  if (!label) return status(t('Name the agent first.'));
  const policy = {
    tools: [...($('#a2a-in-web').checked ? ['web'] : []), ...($('#a2a-in-todo').checked ? ['todo'] : [])],
    memory: $('#a2a-in-notes').checked ? 'shared' : 'none',
    skills: pickedSkills($('#a2a-in-skills')),
    tasksPerDay: Number($('#a2a-in-tasks').value),
    tokensPerDay: Number($('#a2a-in-tokens').value),
  };
  try {
    const r = await api('/agents', { method: 'POST', body: { kind: 'in', label, policy, days: Number($('#a2a-in-days').value) } });
    $('#a2a-in-token').textContent = r.token;
    $('#a2a-in-show').hidden = false;
    $('#a2a-in-label').value = '';
    status(t('Key made for {name}. Copy it now: it is shown only once.', { name: label }));
    await loadAgents();
  } catch (err) {
    status(err.message);
  }
}

function chip(text, cls = '') {
  return el('span', `skl-chip${cls ? ` ${cls}` : ''}`, text);
}
const when = (iso) => (iso ? new Date(iso).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

function policyLines(p) {
  const out = [];
  if (p.direction !== 'out') {
    out.push(p.policy.tools.includes('web') ? t('Can search the web') : '', p.policy.tools.includes('todo') ? t('Can add to-dos (asks you)') : '', p.policy.memory === 'shared' ? t("Sees notes that aren't private") : '');
    if (!p.policy.tools.length && p.policy.memory !== 'shared') out.push(t('Answers questions only'));
    if (p.policy.skills.length) out.push(t('Skills: {list}', { list: p.policy.skills.join(', ') }));
  }
  return out.filter(Boolean);
}

function renderPeers() {
  const box = $('#a2a-peers');
  if (!state.peers.length) {
    box.replaceChildren(el('p', 'muted small', t('No agents yet. Give one a key below, or add one she can ask.')));
    return;
  }
  box.replaceChildren(...state.peers.map(peerCard));
}

function peerCard(p) {
  const card = el('article', 'skl-card a2a-peer');
  const head = el('div', 'a2a-head');
  const title = el('div', 'a2a-title');
  title.append(el('strong', '', p.label), el('span', 'skl-desc', p.card?.description ?? (p.direction === 'in' ? t('May ask her') : '')));
  const more = el('button', 'ghost skl-more', '⋯');
  more.type = 'button';
  more.dataset.moreId = `a2a-${p.id}`;
  more.setAttribute('aria-label', t('More for {name}', { name: p.label }));
  const menu = el('div', 'tidy-items');
  menu.hidden = true;
  menu.append(
    ...(p.direction !== 'out' ? [btn(t('What it may do'), 'ghost', () => editPolicy(p, card)), btn(t('Make a new key'), 'ghost', () => rotate(p))] : []),
    ...(p.direction !== 'in' ? [btn(p.hasKey ? t('Change its key') : t('Paste its key'), 'ghost', () => pasteKey(p, card)), btn(t('Check its card again'), 'ghost', () => recheck(p))] : []),
    btn(t('Remove'), 'ghost danger-text', () => remove(p)),
  );
  overflowMenu(more, menu);
  head.append(title, more, menu);
  card.append(head);
  const chips = el('div', 'skl-chips');
  chips.append(chip(p.direction === 'in' ? t('In: may ask her') : p.direction === 'out' ? t('Out: she may ask it') : t('Both ways')));
  if (p.direction !== 'in' && !p.hasKey) chips.append(chip(t('No key yet'), 'warn'));
  if (p.expiresAt) chips.append(chip(t('Key until {when}', { when: when(p.expiresAt) }), 'muted'));
  card.append(chips);
  for (const line of policyLines(p)) card.append(el('p', 'small a2a-line', line));
  if (p.card?.skills?.length) card.append(el('p', 'muted small a2a-line', t('Its skills: {list}', { list: p.card.skills.map((s) => s.name).join(', ') })));
  const d = p.today ?? { tasks: 0, tokens: 0, usd: 0, sent: 0 };
  card.append(el('p', 'muted small a2a-line', p.direction === 'out' ? t('Asked today: {n} · last seen: {when}', { n: d.sent, when: when(p.lastSeen) || t('never') }) : t('Tasks today: {n} · tokens: {tokens} · last seen: {when}', { n: d.tasks, tokens: d.tokens.toLocaleString(), when: when(p.lastSeen) || t('never') })));
  return card;
}

function editPolicy(p, card) {
  card.querySelector('.a2a-edit')?.remove();
  const box = el('div', 'a2a-edit');
  const tick = (id, label, on, help) => {
    const row = el('label', 'row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `${id}-${p.id}`;
    input.checked = on;
    row.append(input, ' ', el('span', '', label), ' ', tip(help));
    box.append(row);
    return input;
  };
  const web = tick('a2a-e-web', t('Use web search'), p.policy.tools.includes('web'), t("She may search and read the web for this agent's questions. It runs without a card, like in your chats."));
  const todo = tick('a2a-e-todo', t('Add to-dos (asks you)'), p.policy.tools.includes('todo'), t('She may add to-dos for this agent, but each one waits for your OK on a card (even if her to-dos usually run on their own). Until you answer, the agent sees "waiting for approval".'));
  const notes = tick('a2a-e-notes', t("Share notes that aren't private"), p.policy.memory === 'shared', t('Off: she knows nothing about you in these chats. On: she may use notes other apps may see too. Never private, partner, imported or adult chats, people or keys.'));
  const skills = el('div', 'a2a-skills');
  box.append(skills);
  renderSkills(skills, p.policy.skills, `a2a-e-skill-${p.id}`);
  const row = el('div', 'prop-buttons');
  row.append(
    btn(t('Save'), '', async () => {
      try {
        await api(`/agents/${enc(p.id)}/policy`, { method: 'PUT', body: { policy: { tools: [...(web.checked ? ['web'] : []), ...(todo.checked ? ['todo'] : [])], memory: notes.checked ? 'shared' : 'none', skills: pickedSkills(skills) } } });
        status(t('Saved.'));
        await loadAgents();
      } catch (err) {
        status(err.message);
      }
    }),
    btn(t('Cancel'), 'ghost', () => box.remove()),
  );
  box.append(row);
  card.append(box);
}

async function rotate(p) {
  if (!confirm(t('Make a new key for {name}? The old one stops working at once.', { name: p.label }))) return;
  try {
    const r = await api(`/agents/${enc(p.id)}/key`, { method: 'POST', body: {} });
    $('#a2a-in-token').textContent = r.token;
    $('#a2a-in-show').hidden = false;
    status(t('New key for {name}. Copy it now: it is shown only once.', { name: p.label }));
    $('#a2a-in-show').scrollIntoView({ block: 'nearest' });
  } catch (err) {
    status(err.message);
  }
}

function keyInput(id) {
  const input = document.createElement('input');
  input.type = 'password';
  input.id = id;
  input.autocomplete = 'off';
  input.placeholder = t('Paste the key it gave you');
  return input;
}

function pasteKey(p, card) {
  card.querySelector('.a2a-edit')?.remove();
  const box = el('div', 'a2a-edit');
  const label = el('label');
  const input = keyInput(`a2a-key-${p.id}`);
  const words = el('span');
  words.append(t('Its key'), ' ', tip(t('The key its owner gave you for Sara. It is kept encrypted in her vault, never shown again and never written to a log.')));
  label.append(words, ' ', input);
  const row = el('div', 'prop-buttons');
  row.append(
    btn(t('Save'), '', async () => {
      try {
        await api(`/agents/${enc(p.id)}/key`, { method: 'POST', body: { key: input.value } });
        status(t('Key saved for {name}.', { name: p.label }));
        await loadAgents();
      } catch (err) {
        status(err.message);
      }
    }),
    btn(t('Cancel'), 'ghost', () => box.remove()),
  );
  box.append(label, row);
  card.append(box);
  input.focus();
}

async function recheck(p) {
  try {
    const r = await api(`/agents/${enc(p.id)}/recheck`, { method: 'POST', body: {} });
    if (!r.changed) return status(t('{name}: its card is the same as when you added it.', { name: p.label }));
    review = { ...r.review, peerId: p.id };
    renderReview();
    status(t('{name} changed its card: look at it below and accept it, or remove the agent.', { name: p.label }));
  } catch (err) {
    status(err.message);
  }
}

async function remove(p) {
  if (!confirm(t('Remove {name}? Its key stops working and its tasks stop.', { name: p.label }))) return;
  try {
    await api(`/agents/${enc(p.id)}`, { method: 'DELETE' });
    status(t('{name} was removed.', { name: p.label }));
    await loadAgents();
  } catch (err) {
    status(err.message);
  }
}

async function lookUp() {
  const url = $('#a2a-out-url').value.trim();
  if (!url) return status(t("Paste the agent's address first."));
  status(t('Reading its card…'));
  try {
    const r = await api('/agents/fetch-card', { method: 'POST', body: { url } });
    review = r.review;
    renderReview();
    status('');
  } catch (err) {
    review = null;
    renderReview();
    status(err.message);
  }
}

const SIG = { verified: () => t('Signed: the signature checks out'), none: () => t('Not signed'), unverifiable: () => t("Signed, but the key isn't in the card") };

/** The review card for an agent she could ask (the "peer pairing card"). */
function renderReview() {
  const box = $('#a2a-out-review');
  if (!review) return box.replaceChildren();
  const r = review;
  let host = '';
  try {
    host = new URL(r.url).host;
  } catch {
    /* shown as is */
  }
  const keyLabel = el('label', 'a2a-key-row');
  const key = keyInput('a2a-out-key');
  const words = el('span');
  words.append(t('Its key'), ' ', tip(t('The key its owner gave you for Sara. It is kept encrypted in her vault, never shown again and never written to a log.')));
  keyLabel.append(words, ' ', key);
  const ifaces = el('ul', 'a2a-ifaces small');
  for (const i of r.interfaces) ifaces.append(el('li', '', `${i.protocolBinding} ${i.protocolVersion} · ${i.url}`));
  const body = [el('p', 'prop-can-head small', t('Where it answers')), ifaces, el('p', 'small', t('Sign-in: {list}', { list: r.auth.length ? r.auth.join(', ') : t('none listed') }))];
  if (!r.peerId) body.push(keyLabel);
  box.replaceChildren(
    proposalCard({
      title: r.name,
      source: r.provider ? t('{host} · by {who}', { host, who: r.provider }) : host,
      chips: [{ text: r.binding === 'JSONRPC' ? 'JSON-RPC' : 'HTTP+JSON' }, { text: r.streaming ? t('Streams its answers') : t('Answers when done') }, { text: SIG[r.signature]?.() ?? r.signature, cls: r.signature === 'verified' ? '' : 'warn' }],
      why: [r.description],
      can: r.skills.map((s, i) => ({ id: `s${i}`, text: s.description ? `${s.name}: ${s.description}` : s.name })),
      warn: [...r.warnings, t('Her messages to it wait for your OK, and its answers are never treated as instructions.')],
      body,
      buttons: [
        {
          label: r.peerId ? t('Accept the new card') : t('Add'),
          onClick: async (b) => {
            b.disabled = true;
            try {
              if (r.peerId) await api(`/agents/${enc(r.peerId)}/card`, { method: 'POST', body: { sha: r.sha } });
              else await api('/agents', { method: 'POST', body: { kind: 'out', url: r.url, sha: r.sha, key: key.value } });
              status(t('{name} was added. She can ask it from now on (each message asks you first).', { name: r.name }));
              review = null;
              $('#a2a-out-url').value = '';
              renderReview();
              await loadAgents();
            } catch (err) {
              b.disabled = false;
              status(err.message);
            }
          },
        },
        {
          label: t('Not now'),
          cls: 'ghost',
          onClick: () => {
            review = null;
            renderReview();
          },
        },
      ],
    }),
  );
}

function renderRecent() {
  const ul = $('#a2a-recent');
  if (!state.recent.length) return ul.replaceChildren(el('li', 'muted small', t('Nothing yet.')));
  ul.replaceChildren(
    ...state.recent.map((r) => {
      const li = el('li', 'a2a-recent');
      const what = el('span', 'a2a-recent-text');
      what.append(el('strong', '', r.direction === 'in' ? t('{name} asked her', { name: r.peer }) : t('She asked {name}', { name: r.peer })), ' · ', el('span', '', taskStateText(r.state)), r.text ? el('span', 'muted', ` · ${r.text}`) : '');
      li.append(what, el('span', 'muted small', when(r.at)));
      if (r.conversationId) li.append(btn(t('Open'), 'ghost small', () => helpers.openConversation(r.conversationId)));
      return li;
    }),
  );
}
