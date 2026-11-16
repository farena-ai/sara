// S9a (docs/MESSAGES.md): the Messages page. Private chats between the owners of linked Sara servers,
// and communities. Sara is not involved: nothing here calls a model, and a message reaches her only
// when the owner presses "Ask Sara about this" (it opens a new chat with the text in the box, unsent).
import { t } from './naming.js';
import { initSupport, loadSupport, supportRows, supportStrip } from './support.js';

/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, notify?: (title: string, body: string) => void, askHer?: (text: string) => void, confirm?: (text: string) => Promise<boolean> } | null} */
let ctx = null;
let list = null;
let open = '';
let view = null;
let typingAt = 0;
let lastUnread = -1;
let reloadTimer = 0;

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => ctx.el(tag, cls, text);
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const say = (msg) => {
  const s = $('#msgs-status');
  if (s) s.textContent = msg;
};
const time = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const ask = async (text) => (ctx.confirm ? ctx.confirm(text) : window.confirm(text));
const KEEP = () => [
  ['', t('My default')],
  ['1', t('1 day')],
  ['7', t('7 days')],
  ['30', t('30 days')],
  ['90', t('90 days')],
  ['365', t('1 year')],
  ['0', t('Always')],
];

export function initMessages(c) {
  ctx = c;
  // S9b: the support link (help passes, looks, suggested fixes) lives in one-to-one chats.
  initSupport(c, { reload: () => loadMessages(), say, panel });
  $('#msgs-link')?.addEventListener('click', () => void linkCode());
  $('#msgs-join-open')?.addEventListener('click', () => joinForm());
  $('#msgs-new-group')?.addEventListener('click', () => groupForm());
  for (const id of ['#msgs-keep', '#msgs-receipts', '#msgs-typing', '#msgs-name', '#msgs-url']) $(id)?.addEventListener('change', () => void saveSettings());
  $('#msgs')?.addEventListener('close', () => {
    open = '';
    view = null;
  });
}

/** Opens the page (and a chat, when given). */
export async function openMessages(chatId = '') {
  const d = $('#msgs');
  if (!d) return;
  if (!d.open) d.showModal();
  open = chatId || open;
  await loadMessages();
}

export async function loadMessages() {
  if (!ctx) return;
  try {
    list = await ctx.api('/messages');
  } catch (err) {
    say(err.message);
    return;
  }
  await loadSupport();
  paintBadge(list.unread);
  paintSettings(list.settings);
  paintList();
  if (open) await loadChat(open);
  else paintChat();
}

/** The sidebar dot and the page count (also called on start and on each change). */
export async function refreshMessagesBadge() {
  if (!ctx || document.body.classList.contains('member')) return;
  try {
    const r = await ctx.api('/messages');
    // A desktop/browser notification for a new message while the page is not in front.
    if (lastUnread >= 0 && r.unread > lastUnread && (document.hidden || !$('#msgs')?.open)) {
      const c = r.chats.find((x) => x.unread > 0 && !x.muted);
      if (c) ctx.notify?.(c.title, c.last || t('New message'));
    }
    lastUnread = r.unread;
    paintBadge(r.unread);
  } catch {
    /* not available (member, demo) */
  }
}
function paintBadge(n) {
  const dot = $('#msgs-dot');
  if (dot) dot.hidden = !n;
  const b = $('#msgs-unread');
  if (b) {
    b.hidden = !n;
    b.textContent = n ? t('{n} unread', { n }) : '';
  }
}

/** Server event: a chat changed (ids only). */
export function messagesChanged(chatId) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if ($('#msgs')?.open) void loadMessages();
    else void refreshMessagesBadge();
  }, 250);
  void chatId;
}

function paintSettings(s) {
  if (!s) return;
  const set = (id, v) => {
    const n = $(id);
    if (n && document.activeElement !== n) n.type === 'checkbox' ? (n.checked = v) : (n.value = v);
  };
  set('#msgs-keep', String(s.retentionDays));
  set('#msgs-receipts', s.receipts);
  set('#msgs-typing', s.typing);
  set('#msgs-name', s.name);
  set('#msgs-url', s.url);
}
async function saveSettings() {
  try {
    const r = await ctx.api('/messages/settings', { method: 'PUT', body: { retentionDays: Number($('#msgs-keep').value || 0), receipts: $('#msgs-receipts').checked, typing: $('#msgs-typing').checked, name: $('#msgs-name').value, url: $('#msgs-url').value } });
    paintSettings(r.settings);
    say(t('Saved.'));
  } catch (err) {
    say(err.message);
  }
}

// ---- the left column: chats, communities, requests -----------------------------------------------
function paintList() {
  const box = $('#msgs-list');
  if (!box) return;
  box.replaceChildren(...supportRows((id) => void showChat(id)));
  for (const r of list.requests ?? []) {
    const row = el('div', 'msgs-req');
    row.append(el('span', '', t('{name} wants to chat with you privately.', { name: r.fromName })));
    const acts = el('span', 'msgs-acts');
    acts.append(
      btn(t('Accept'), 'small', () => void answer(r.id, true)),
      btn(t('Ignore'), 'ghost small', () => void answer(r.id, false)),
    );
    row.append(acts);
    box.append(row);
  }
  if (!list.chats.length) {
    box.append(el('p', 'muted small msgs-empty', t('No chats yet. Link a server with a one-time code, or join a community with its code.')));
    return;
  }
  for (const c of list.chats) {
    const b = btn('', 'msgs-item', () => void showChat(c.id));
    b.setAttribute('aria-current', String(c.id === open));
    const top = el('span', 'msgs-item-top');
    top.append(el('strong', '', `${c.kind === 'community' ? '👥 ' : ''}${c.title}`));
    if (c.unread) top.append(el('span', 'msgs-badge', String(c.unread)));
    if (c.muted) top.append(el('span', 'muted small', t('muted')));
    if (c.status === 'ended') top.append(el('span', 'muted small', t('ended')));
    b.append(top, el('span', 'muted small msgs-item-last', c.blocked ? t('Blocked') : c.last || ' '));
    box.append(b);
  }
}
async function answer(id, accept) {
  try {
    const r = await ctx.api(`/messages/requests/${id}`, { method: 'POST', body: { accept } });
    if (r.chat) open = r.chat.id;
    await loadMessages();
  } catch (err) {
    say(err.message);
  }
}

// ---- forms: link code, paste a code, new community ------------------------------------------------
function panel(...nodes) {
  const p = $('#msgs-panel');
  p.replaceChildren(...nodes, btn(t('Close'), 'ghost small', () => (p.hidden = true)));
  p.hidden = false;
}
async function linkCode() {
  try {
    const r = await ctx.api('/messages/invite', { method: 'POST', body: {} });
    const code = el('input', 'msgs-code');
    code.readOnly = true;
    code.value = r.code;
    code.setAttribute('aria-label', t('One-time code'));
    panel(el('p', 'small', t('Send this code to the other owner. It works once, for 30 minutes. They paste it under Messages → Paste a code.')), code, btn(t('Copy'), 'small', () => void navigator.clipboard?.writeText(r.code).then(() => say(t('Copied.')))));
    code.select();
  } catch (err) {
    say(err.message);
  }
}
function joinForm() {
  const input = el('input', 'msgs-code');
  input.placeholder = 'sara-msg:…';
  input.setAttribute('aria-label', t('Code'));
  const go = btn(t('Link'), 'small', async () => {
    try {
      const r = await ctx.api('/messages/join', { method: 'POST', body: { code: input.value } });
      $('#msgs-panel').hidden = true;
      open = r.chat.id;
      say(r.chat.kind === 'community' ? t('You joined {name}.', { name: r.chat.title }) : t('Linked with {name}.', { name: r.chat.title }));
      await loadMessages();
    } catch (err) {
      say(err.message);
    }
  });
  panel(el('p', 'small', t('Paste a one-time code from another owner, or a community code.')), input, go);
  input.focus();
}
function groupForm() {
  const input = el('input', 'msgs-code');
  input.maxLength = 60;
  input.placeholder = t('Name of the community');
  input.setAttribute('aria-label', t('Name of the community'));
  const go = btn(t('Create'), 'small', async () => {
    try {
      const r = await ctx.api('/messages/communities', { method: 'POST', body: { name: input.value } });
      $('#msgs-panel').hidden = true;
      open = r.chat.id;
      await loadMessages();
    } catch (err) {
      say(err.message);
    }
  });
  panel(el('p', 'small', t('Your server hosts the community: anyone with its code can join, and you (and moderators you pick) can remove or ban people.')), input, go);
  input.focus();
}

// ---- one chat -----------------------------------------------------------------------------------
async function showChat(id) {
  open = id;
  await loadChat(id);
  paintList();
}
async function loadChat(id) {
  try {
    view = await ctx.api(`/messages/chats/${id}`);
  } catch {
    open = '';
    view = null;
    return paintChat();
  }
  paintChat();
  if (view.messages.some((m) => !m.mine)) {
    const c = list?.chats.find((x) => x.id === id);
    if (c?.unread) {
      await ctx.api(`/messages/chats/${id}/read`, { method: 'POST', body: {} }).catch(() => undefined);
      c.unread = 0;
      paintList();
      void refreshMessagesBadge();
    }
  }
}
function paintChat() {
  const box = $('#msgs-chat');
  if (!box) return;
  box.replaceChildren();
  $('#msgs')?.classList.toggle('msgs-in-chat', Boolean(view));
  if (!view) {
    box.append(el('p', 'muted small msgs-empty', t('Pick a chat.')));
    return;
  }
  const { chat } = view;
  const head = el('div', 'msgs-head');
  head.append(btn(t('Back'), 'ghost small msgs-back', () => {
    open = '';
    view = null;
    paintChat();
    paintList();
  }));
  const title = el('div', 'msgs-title');
  title.append(el('strong', '', chat.title));
  const sub = chat.kind === 'community' ? t('{n} members', { n: view.members.length }) + (chat.role === 'host' ? ` · ${t('you host it')}` : chat.role === 'mod' ? ` · ${t('moderator')}` : '') : chat.status === 'ended' ? t('This chat has ended.') : t('Linked server');
  title.append(el('span', 'muted small', sub));
  head.append(title, chatMenu(chat));
  box.append(head, supportStrip(chat));
  const msgs = el('div', 'msgs-scroll');
  msgs.setAttribute('role', 'log');
  for (const m of view.messages) msgs.append(bubble(chat, m));
  if (view.typing.length) msgs.append(el('p', 'muted small msgs-typing', t('{name} is typing…', { name: view.typing.join(', ') })));
  if (!view.messages.length) msgs.append(el('p', 'muted small msgs-empty', t('No messages yet. Messages are kept for the days you chose, then removed.')));
  box.append(msgs);
  if (chat.status === 'active' && !chat.blocked) box.append(composer(chat));
  msgs.scrollTop = msgs.scrollHeight;
}
function chatMenu(chat) {
  const d = el('details', 'msgs-menu');
  const s = el('summary', 'ghost small', t('Options'));
  d.append(s);
  const body = el('div', 'msgs-menu-body');
  const patch = async (b) => {
    try {
      await ctx.api(`/messages/chats/${chat.id}`, { method: 'PATCH', body: b });
      await loadMessages();
    } catch (err) {
      say(err.message);
    }
  };
  if (chat.status === 'active') {
    body.append(btn(chat.muted ? t('Unmute') : t('Mute'), 'ghost small', () => void patch({ muted: !chat.muted })));
    if (chat.kind === 'direct') body.append(btn(chat.blocked ? t('Unblock') : t('Block'), 'ghost small', () => void patch({ blocked: !chat.blocked })));
  }
  const keep = el('label', 'msgs-keep');
  keep.append(el('span', 'small', t('Keep messages')));
  const sel = el('select');
  for (const [v, label] of KEEP()) sel.append(Object.assign(el('option', '', label), { value: v }));
  sel.value = chat.retentionDays === null ? '' : String(chat.retentionDays);
  sel.addEventListener('change', () => void patch({ retentionDays: sel.value === '' ? null : Number(sel.value) }));
  keep.append(sel);
  body.append(keep);
  if (chat.kind === 'community') body.append(members(chat));
  if (view.code) {
    const code = el('input', 'msgs-code');
    code.readOnly = true;
    code.value = view.code;
    code.setAttribute('aria-label', t('Community code'));
    body.append(el('span', 'small', t('Community code (anyone with it can join):')), code);
  }
  if (chat.kind === 'community' && chat.status === 'active' && (chat.role === 'host' || chat.role === 'mod')) {
    body.append(btn(t('Make a new code'), 'ghost small', async () => {
      if (!(await ask(t('Make a new code? The old one stops working for newcomers.')))) return;
      const r = await ctx.api(`/messages/communities/${chat.id}/code`, { method: 'POST', body: {} }).catch((err) => (say(err.message), null));
      if (r?.pending) say(t('Asked the host for a new code.'));
      await loadChat(chat.id);
    }));
  }
  for (const r of view.reports ?? []) body.append(el('p', 'small msgs-report', t('Reported by {name}: {why}', { name: r.by, why: r.why || '—' }) + (r.text ? ` “${r.text}”` : '')));
  const endLabel = chat.status === 'ended' ? t('Remove this chat') : chat.kind === 'direct' ? t('Unlink') : chat.role === 'host' ? t('Close the community') : t('Leave');
  body.append(btn(endLabel, 'ghost small danger-text', async () => {
    if (!(await ask(chat.status === 'ended' ? t('Remove this chat and its history from this server?') : t('{what}? The keys for this link are deleted on both servers.', { what: endLabel })))) return;
    const keepIt = chat.status === 'ended' ? false : await ask(t('Keep the history on this server? (OK keeps it, Cancel removes it)'));
    try {
      await ctx.api(`/messages/chats/${chat.id}?history=${keepIt ? 'keep' : 'remove'}`, { method: 'DELETE' });
      if (!keepIt) open = '';
      await loadMessages();
    } catch (err) {
      say(err.message);
    }
  }));
  d.append(body);
  return d;
}
function members(chat) {
  const box = el('div', 'msgs-members');
  box.append(el('span', 'small', t('Members')));
  for (const m of view.members) {
    const row = el('div', 'msgs-member');
    row.append(el('span', '', m.name + (m.role === 'host' ? ` (${t('creator')})` : m.role === 'mod' ? ` (${t('moderator')})` : '')));
    const acts = el('span', 'msgs-acts');
    const mod = async (action) => {
      if ((action === 'kick' || action === 'ban') && !(await ask(action === 'ban' ? t('Ban {name}? Their server can’t join again with any code.', { name: m.name }) : t('Remove {name}? They can join again with the code.', { name: m.name })))) return;
      try {
        await ctx.api(`/messages/communities/${chat.id}/members/${m.id}`, { method: 'POST', body: { action } });
        await loadChat(chat.id);
      } catch (err) {
        say(err.message);
      }
    };
    const self = m.id === view.me;
    if (chat.status === 'active' && !self) {
      acts.append(btn(t('Message privately'), 'ghost small', async () => {
        try {
          await ctx.api(`/messages/communities/${chat.id}/intro`, { method: 'POST', body: { member: m.id } });
          say(t('Asked {name}. The chat starts when they accept.', { name: m.name }));
        } catch (err) {
          say(err.message);
        }
      }));
    }
    if (chat.role === 'host' && m.role !== 'host') acts.append(btn(m.role === 'mod' ? t('Not a moderator') : t('Make moderator'), 'ghost small', () => void mod(m.role === 'mod' ? 'unmod' : 'mod')));
    if ((chat.role === 'host' && m.role !== 'host') || (chat.role === 'mod' && m.role === 'member')) acts.append(btn(t('Remove'), 'ghost small', () => void mod('kick')), btn(t('Ban'), 'ghost small danger-text', () => void mod('ban')));
    row.append(acts);
    box.append(row);
  }
  return box;
}
function bubble(chat, m) {
  const b = el('div', `msgs-msg${m.mine ? ' mine' : ''}`);
  if (chat.kind === 'community' && !m.mine) b.append(el('span', 'msgs-author small', m.author));
  if (m.deleted) b.append(el('span', 'muted small', t('Message deleted')));
  else {
    if (m.text) b.append(el('p', 'msgs-text', m.text));
    if (m.file) {
      const url = `/api/messages/chats/${chat.id}/m/${m.id}/file`;
      if (m.file.type.startsWith('image/')) {
        const img = el('img', 'msgs-img');
        img.src = url;
        img.alt = m.file.name;
        img.loading = 'lazy';
        b.append(img);
      } else {
        const a = el('a', 'msgs-file', `📎 ${m.file.name}`);
        a.href = url;
        a.download = m.file.name;
        b.append(a);
      }
    }
  }
  const meta = el('span', 'msgs-meta muted small', time(m.at) + (m.editedAt ? ` · ${t('edited')}` : ''));
  if (m.mine && !m.deleted) meta.append(` · ${m.state === 'queued' ? t('waiting to send') : m.state === 'failed' ? t('not sent') : m.readAt ? t('read') : t('sent')}`);
  b.append(meta);
  if (!m.deleted && chat.status === 'active') {
    const acts = el('span', 'msgs-acts');
    if (m.mine) {
      acts.append(btn(t('Edit'), 'linkish small', () => void editMsg(chat, m)), btn(t('Delete'), 'linkish small', async () => {
        if (!(await ask(t('Delete this message for everyone?')))) return;
        await ctx.api(`/messages/chats/${chat.id}/m/${m.id}`, { method: 'DELETE' }).catch((err) => say(err.message));
        await loadChat(chat.id);
      }));
    } else if (chat.kind === 'community' && chat.role !== 'host') {
      acts.append(btn(t('Report'), 'linkish small', async () => {
        const why = window.prompt(t('Why are you reporting it? (the community’s creator sees this)')) ?? null;
        if (why === null) return;
        await ctx.api(`/messages/chats/${chat.id}/m/${m.id}/report`, { method: 'POST', body: { why } }).then(() => say(t('Reported to the creator.')), (err) => say(err.message));
      }));
    }
    // Forwarding to her is a choice: a new chat opens with the text in the box, not sent.
    if (m.text && ctx.askHer) acts.append(btn(t('Ask Sara about this'), 'linkish small', () => ctx.askHer(`“${m.text}” (${m.mine ? t('my message') : t('a message from {name}', { name: m.author })})\n\n`)));
    b.append(acts);
  }
  return b;
}
async function editMsg(chat, m) {
  const text = window.prompt(t('Edit your message'), m.text);
  if (text === null || !text.trim()) return;
  await ctx.api(`/messages/chats/${chat.id}/m/${m.id}`, { method: 'PATCH', body: { text } }).catch((err) => say(err.message));
  await loadChat(chat.id);
}
function composer(chat) {
  const f = el('div', 'msgs-compose');
  const box = el('textarea', 'msgs-input');
  box.rows = 2;
  box.maxLength = 4000;
  box.placeholder = t('Write a message');
  box.setAttribute('aria-label', t('Write a message'));
  const file = el('input');
  file.type = 'file';
  file.hidden = true;
  file.accept = 'image/jpeg,image/png,image/webp,image/gif,application/pdf,.txt,.md,.csv';
  let picked = null;
  const chip = el('span', 'muted small msgs-chip');
  file.addEventListener('change', () => {
    picked = file.files?.[0] ?? null;
    chip.textContent = picked ? `📎 ${picked.name}` : '';
  });
  const send = async () => {
    const text = box.value.trim();
    if (!text && !picked) return;
    let body = { text };
    if (picked) {
      if (picked.size > (list?.limits?.fileMB ?? 5) * 1024 * 1024) return say(t('Files can be up to {n} MB.', { n: list?.limits?.fileMB ?? 5 }));
      const data = await new Promise((ok) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1] ?? '');
        r.readAsDataURL(picked);
      });
      body = { text, file: { name: picked.name, data } };
    }
    try {
      await ctx.api(`/messages/chats/${chat.id}/send`, { method: 'POST', body });
      box.value = '';
      picked = null;
      file.value = '';
      chip.textContent = '';
      await loadChat(chat.id);
      $('#msgs-chat .msgs-input')?.focus();
    } catch (err) {
      say(err.message);
    }
  };
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  box.addEventListener('input', () => {
    if (Date.now() - typingAt < 4000) return;
    typingAt = Date.now();
    void ctx.api(`/messages/chats/${chat.id}/typing`, { method: 'POST', body: {} }).catch(() => undefined);
  });
  const attach = btn(t('Attach'), 'ghost small', () => file.click());
  attach.setAttribute('aria-label', t('Attach a picture or file'));
  f.append(box, file, el('div', 'msgs-compose-row'));
  f.lastChild.append(attach, chip, btn(t('Send'), 'small', () => void send()));
  return f;
}
