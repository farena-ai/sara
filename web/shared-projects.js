// U4.26 (docs/SHARED_PROJECTS.md): shared projects between linked friends.
// The project page's "Shared with friends" card (share, roles, what is shared, items, activity, notices,
// leave / remove / stop) and the Settings → Connections → Phone and notifications "Shared projects" list
// (invitations with Accept / Decline, every shared project with Open). Owner only (the server says 403
// to members, kid mode and the demo, and the card stays hidden).
import { t } from './naming.js';

const $ = (s) => globalThis.document?.querySelector(s);
let ctx = { openProject: () => {} };
let current = null; // { project, conversations }

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const when = (iso) => {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
};
const KIND_LABEL = { notes: () => t('Notes'), tasks: () => t('To-dos'), files: () => t('Files'), chats: () => t('Chats (never private or adult ones)') };
const ROLE_LABEL = { viewer: () => t('Can view'), contributor: () => t('Can edit') };
const NOTIFY_LABEL = { quiet: () => t('Quiet: count changes, no notice'), all: () => t('Tell me about every change'), none: () => t('Nothing') };
const STATUS_LABEL = { invited: () => t('invited'), active: () => t('active'), declined: () => t('declined'), left: () => t('left'), removed: () => t('removed'), ended: () => t('sharing ended') };
const WHAT = {
  added: (a) => t('{who} added {title}', a),
  changed: (a) => t('{who} changed {title}', a),
  removed: (a) => t('{who} removed {title}', a),
  conflict: (a) => t('Both changed a file at once: kept {title}', a),
  invited: (a) => t('{who} invited {title}', a),
  joined: (a) => t('{who} joined', a),
  declined: (a) => t('{who} declined', a),
  left: (a) => t('{who} left', a),
  'removed-member': (a) => t('{who} removed {title} from the project', a),
};
const select = (id, options, value, label) => {
  const s = el('select');
  if (id) s.id = id;
  s.setAttribute('aria-label', label);
  for (const [v, l] of options) {
    const o = el('option', '', l);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  return s;
};

export function initSharedProjects(c = {}) {
  ctx = { ...ctx, ...c };
}

/** Something changed on either side (a live 'pm' event with chat `sproj:<id>`). */
export function sharedChanged() {
  if ($('#project-page')?.open && current) void renderProjectShare(current.project, current.conversations);
  if ($('#settings')?.open && $('#shp-list') && !$('#shp-list').closest('[hidden]')) void loadSharedSettings();
}

/** The project page's card. Hidden for channel projects and for people who can't share (members, kids). */
export async function renderProjectShare(project, conversations = []) {
  const box = $('#pp-shared');
  const card = $('#pp-shared-box');
  if (!box || !card) return;
  current = { project, conversations };
  if (project.builtin) return void (card.hidden = true);
  let list;
  try {
    list = await api('/shared-projects');
  } catch {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const share = list.shares.find((s) => s.projectId === project.id && (s.status === 'active' || s.status === 'ended'));
  if (!share) return void box.replaceChildren(...shareForm(project, list));
  const d = await api(`/shared-projects/${share.id}`);
  box.replaceChildren(...shareView(d, list, conversations));
  if (d.share.unseen) void api(`/shared-projects/${share.id}/seen`, { method: 'POST', body: {} }).catch(() => undefined);
}

function shareForm(project, list) {
  if (list.privateLocal) return [el('p', 'muted small', t('Private local mode is on: nothing is shared until it is off.'))];
  if (!list.friends.length) return [el('p', 'muted small', t('Link with a friend’s Sara under Messages first, then share this project with them.'))];
  const open = btn(t('Share this project'), 'ghost small', () => {
    form.hidden = false;
    open.hidden = true;
  });
  const form = el('div', 'shp-form');
  form.hidden = true;
  const friend = select('', list.friends.map((f) => [f.id, f.name]), list.friends[0].id, t('Friend'));
  const role = select('', [['viewer', ROLE_LABEL.viewer()], ['contributor', ROLE_LABEL.contributor()]], 'viewer', t('What they may do'));
  const kinds = el('div', 'shp-kinds');
  const boxes = {};
  for (const k of list.kinds) {
    const lab = el('label', 'shp-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = k === 'notes' || k === 'tasks';
    boxes[k] = cb;
    lab.append(cb, el('span', '', KIND_LABEL[k]()));
    kinds.append(lab);
  }
  const status = el('span', 'muted small');
  status.setAttribute('role', 'status');
  const go = btn(t('Send the invitation'), 'small', async () => {
    go.disabled = true;
    try {
      await api('/shared-projects', { method: 'POST', body: { project: project.id, link: friend.value, role: role.value, kinds: list.kinds.filter((k) => boxes[k].checked) } });
      await renderProjectShare(project, current?.conversations);
    } catch (err) {
      status.textContent = err.message;
      go.disabled = false;
    }
  });
  form.append(field(t('Friend'), friend), field(t('What they may do'), role), el('p', 'small shp-label', t('What is shared')), kinds, el('p', 'muted small', t('Shared notes and to-dos are copies: your other notes, files and chats stay yours.')), el('div', 'shp-actions', ''), status);
  form.querySelector('.shp-actions').append(go);
  return [el('p', 'muted small', t('Not shared. Only you see this project.')), open, form];
}
function field(label, control) {
  const l = el('label', 'shp-field');
  l.append(el('span', 'small', label), control);
  return l;
}

function shareView(d, list, conversations) {
  const s = d.share;
  const out = [];
  const host = s.side === 'host';
  const id = s.id;
  const redraw = () => renderProjectShare(current.project, current.conversations);
  const act = (f) => async () => {
    try {
      await f();
      await redraw();
    } catch (err) {
      say.textContent = err.message;
    }
  };
  const say = el('p', 'muted small');
  say.setAttribute('role', 'status');
  // Who and what.
  if (host) {
    const people = el('div', 'shp-people');
    for (const m of s.members.filter((x) => x.status !== 'removed' && x.status !== 'declined')) {
      const row = el('div', 'shp-person');
      row.append(el('strong', '', m.name), el('span', 'muted small', STATUS_LABEL[m.status]?.() ?? m.status));
      if (m.status === 'active' || m.status === 'invited') {
        const r = select('', [['viewer', ROLE_LABEL.viewer()], ['contributor', ROLE_LABEL.contributor()]], m.role, t('What {name} may do', { name: m.name }));
        r.addEventListener('change', act(() => api(`/shared-projects/${id}/members/${m.link}`, { method: 'PATCH', body: { role: r.value } })));
        row.append(r, btn(t('Remove'), 'ghost small', act(() => api(`/shared-projects/${id}/members/${m.link}`, { method: 'DELETE' }))));
      }
      people.append(row);
    }
    out.push(people);
    const more = list.friends.filter((f) => !s.members.some((m) => m.link === f.id && (m.status === 'active' || m.status === 'invited')));
    if (more.length) {
      const f = select('', more.map((x) => [x.id, x.name]), more[0].id, t('Friend'));
      const r = select('', [['viewer', ROLE_LABEL.viewer()], ['contributor', ROLE_LABEL.contributor()]], 'viewer', t('What they may do'));
      const add = el('div', 'shp-row');
      add.append(f, r, btn(t('Invite'), 'ghost small', act(() => api('/shared-projects', { method: 'POST', body: { project: s.projectId, link: f.value, role: r.value, kinds: s.kinds } }))));
      out.push(add);
    }
    const kinds = el('div', 'shp-kinds');
    for (const k of list.kinds) {
      const lab = el('label', 'shp-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = s.kinds.includes(k);
      cb.addEventListener('change', act(() => api(`/shared-projects/${id}`, { method: 'PATCH', body: { kinds: list.kinds.filter((x) => (x === k ? cb.checked : s.kinds.includes(x))) } })));
      lab.append(cb, el('span', '', KIND_LABEL[k]()));
      kinds.append(lab);
    }
    out.push(el('p', 'small shp-label', t('What is shared')), kinds);
  } else {
    out.push(el('p', 'small', s.status === 'ended' ? t('{name} no longer shares this project with you. This is the last copy.', { name: s.from }) : s.role === 'contributor' ? t('Shared by {name}. You can view and edit.', { name: s.from }) : t('Shared by {name}. You can view.', { name: s.from })));
  }
  // Items.
  const mayEdit = s.status === 'active' && (host || s.role === 'contributor');
  const items = el('div', 'shp-items');
  for (const it of d.items) items.append(itemRow(it, id, mayEdit, act));
  if (!d.items.length) items.append(el('p', 'muted small', t('Nothing shared yet.')));
  out.push(items);
  if (mayEdit) out.push(addRow(s, id, conversations, act));
  // Activity.
  if (d.activity.length) {
    const det = el('details', 'shp-activity');
    det.append(el('summary', 'small', t('Activity')));
    for (const a of d.activity.slice(0, 15)) {
      const line = el('div', 'small');
      line.append(el('span', '', WHAT[a.what]?.({ who: a.who, title: a.title }) ?? a.what), el('span', 'muted', ` · ${when(a.at)}`));
      det.append(line);
    }
    out.push(det);
  }
  // Notices and the way out.
  const notify = select('', Object.keys(NOTIFY_LABEL).map((k) => [k, NOTIFY_LABEL[k]()]), s.notify, t('Notices for changes'));
  notify.addEventListener('change', act(() => api(`/shared-projects/${id}`, { method: 'PATCH', body: { notify: notify.value } })));
  const foot = el('div', 'shp-row');
  foot.append(field(t('Notices for changes'), notify));
  if (host) foot.append(btn(t('Stop sharing'), 'ghost small danger', act(async () => { if (confirm(t('Stop sharing this project with everyone? Their copies stop updating.'))) await api(`/shared-projects/${id}`, { method: 'DELETE' }); })));
  else if (s.status === 'active') foot.append(btn(t('Leave'), 'ghost small danger', act(async () => { if (confirm(t('Leave this shared project? Your copy stays here, read-only.'))) await api(`/shared-projects/${id}/leave`, { method: 'POST', body: {} }); })));
  else foot.append(btn(t('Delete this copy'), 'ghost small danger', act(async () => { if (confirm(t('Delete your copy of this shared project?'))) await api(`/shared-projects/${id}`, { method: 'DELETE' }); })));
  out.push(foot, say);
  return out;
}

function itemRow(it, id, mayEdit, act) {
  const row = el('div', `shp-item shp-${it.kind}`);
  const by = el('small', 'muted', ` ${t('by {name}', { name: it.by })}`);
  if (it.kind === 'task') {
    const lab = el('label', 'shp-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = it.done;
    cb.disabled = !mayEdit;
    cb.addEventListener('change', act(() => api(`/shared-projects/${encodeURIComponent(id)}/items/${encodeURIComponent(it.id)}`, { method: 'PATCH', body: { done: cb.checked } })));
    lab.append(cb, el('span', '', it.title), by);
    row.append(lab);
  } else if (it.kind === 'file') {
    const a = el('a', '', it.title);
    a.href = `/api/shared-projects/${encodeURIComponent(id)}/items/${encodeURIComponent(it.id)}/file`;
    a.download = it.title;
    const main = el('span', 'shp-main');
    main.append(a, by);
    row.append(el('span', 'shp-kind', t('File')), main);
  } else {
    const det = el('details');
    const sum = el('summary', '', it.title);
    sum.append(by);
    det.append(sum);
    const body = el('div', 'shp-body', it.body);
    det.append(body);
    if (mayEdit && it.kind === 'note') {
      const ed = btn(t('Edit'), 'ghost small', () => {
        const ta = el('textarea');
        ta.value = it.body;
        ta.rows = 5;
        ta.setAttribute('aria-label', it.title);
        const save = btn(t('Save'), 'small', act(() => api(`/shared-projects/${encodeURIComponent(id)}/items/${encodeURIComponent(it.id)}`, { method: 'PATCH', body: { body: ta.value } })));
        body.replaceWith(ta);
        ed.replaceWith(save);
      });
      det.append(ed);
    }
    row.append(el('span', 'shp-kind', it.kind === 'chat' ? t('Chat') : t('Note')), det);
  }
  if (mayEdit) {
    const del = btn('✕', 'ghost small shp-del', act(async () => { if (confirm(t('Remove {title} for everyone?', { title: it.title }))) await api(`/shared-projects/${encodeURIComponent(id)}/items/${encodeURIComponent(it.id)}`, { method: 'DELETE' }); }));
    del.title = t('Remove');
    del.setAttribute('aria-label', t('Remove'));
    row.append(del);
  }
  return row;
}

function addRow(s, id, conversations, act) {
  const opts = [['note', t('Note')], ['task', t('To-do')], ['file', t('File')], ['chat', t('Chat')]].filter(([k]) => s.kinds.includes({ note: 'notes', task: 'tasks', file: 'files', chat: 'chats' }[k]));
  const wrap = el('div', 'shp-row shp-add');
  if (!opts.length) return wrap;
  const kind = select('', opts, opts[0][0], t('Add'));
  const title = el('input');
  title.placeholder = t('Title');
  title.setAttribute('aria-label', t('Title'));
  title.maxLength = 200;
  const file = el('input');
  file.type = 'file';
  file.setAttribute('aria-label', t('File'));
  const chats = (conversations ?? []).filter((c) => !c.private && !c.partner && !String(c.channel ?? '').endsWith('-nsfw') && c.channel !== 'a2a');
  const chat = select('', chats.map((c) => [c.id, c.title]), chats[0]?.id ?? '', t('Chat'));
  const sync = () => {
    title.hidden = kind.value === 'file' || kind.value === 'chat';
    file.hidden = kind.value !== 'file';
    chat.hidden = kind.value !== 'chat';
  };
  kind.addEventListener('change', sync);
  sync();
  const go = btn(t('Add'), 'small', act(async () => {
    if (kind.value === 'file') {
      const f = file.files?.[0];
      if (!f) return;
      const data = await new Promise((ok) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1] ?? '');
        r.readAsDataURL(f);
      });
      await api(`/shared-projects/${id}/items`, { method: 'POST', body: { kind: 'file', file: { name: f.name, data } } });
    } else if (kind.value === 'chat') await api(`/shared-projects/${id}/items`, { method: 'POST', body: { kind: 'chat', conversation: chat.value } });
    else if (title.value.trim()) await api(`/shared-projects/${id}/items`, { method: 'POST', body: { kind: kind.value, title: title.value } });
  }));
  wrap.append(kind, title, file, chat, go);
  return wrap;
}

/** Settings → Connections → Phone and notifications → Shared projects (invitations and the list). */
export async function loadSharedSettings() {
  const box = $('#shp-list');
  if (!box) return;
  let d;
  try {
    d = await api('/shared-projects');
  } catch {
    return void box.replaceChildren(el('p', 'muted small', t('Only the owner of this server can share projects.')));
  }
  if (!d.shares.length) return void box.replaceChildren(el('p', 'muted small', t('Nothing shared yet. Open a project and use Shared with friends to invite a linked friend.')));
  box.replaceChildren(
    ...d.shares.map((s) => {
      const row = el('div', 'shp-person');
      const who = s.side === 'host' ? t('with {names}', { names: s.members.filter((m) => m.status === 'active' || m.status === 'invited').map((m) => m.name).join(', ') || '—' }) : t('from {name}', { name: s.from });
      row.append(el('strong', '', s.name), el('span', 'muted small', `${who} · ${STATUS_LABEL[s.status]?.() ?? s.status}${s.unseen ? ` · ${t('{n} new', { n: s.unseen })}` : ''}`));
      if (s.status === 'invited') {
        const role = s.role === 'contributor' ? ROLE_LABEL.contributor() : ROLE_LABEL.viewer();
        row.append(el('span', 'small', role));
        row.append(
          btn(t('Accept'), 'small', async () => {
            await api(`/shared-projects/${s.id}/accept`, { method: 'POST', body: { accept: true } });
            await loadSharedSettings();
          }),
          btn(t('Decline'), 'ghost small', async () => {
            await api(`/shared-projects/${s.id}/accept`, { method: 'POST', body: { accept: false } });
            await loadSharedSettings();
          }),
        );
      } else if (s.projectId) row.append(btn(t('Open'), 'ghost small', () => ctx.openProject(s.projectId)));
      return row;
    }),
  );
}
