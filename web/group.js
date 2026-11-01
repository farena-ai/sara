// Phase 66: group chats in the web app: the "+ Group" window (who's in it, title, who answers,
// banter, private), the room's settings (saved as you change them), and who-said-what on the
// bubbles (her face, name and colour). The round itself streams through app.js runStream, which
// calls speakerHeader() for each reply. See docs/GROUP_CHATS.md.
import { t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
const ctx = { api: null, openConversation: null, loadConversations: null, switchCompanion: null, companions: () => [], current: () => null };
const dlg = { editing: null, picked: [] };

export const isGroup = (conv) => conv?.channel === 'group';

/** Her face for a group bubble (her own picture or look, through her companion). */
export const faceUrl = (id) => `/api/companions/${encodeURIComponent(id)}/face`;

/** The name, face and colour on a reply in a group chat. */
export function speakerHeader(div, sp) {
  if (!div || !sp) return;
  div.classList.add('from-companion', `spk-${Number(sp.color) % 4}`);
  if (div.querySelector(':scope > .msg-speaker')) return;
  const head = document.createElement('div');
  head.className = 'msg-speaker';
  const img = document.createElement('img');
  img.className = 'spk-face';
  img.src = faceUrl(sp.id);
  img.alt = '';
  img.loading = 'lazy';
  const name = document.createElement('span');
  name.className = 'spk-name';
  name.textContent = sp.name;
  head.append(img, name);
  div.prepend(head);
}

/** The list row's label: the members' names. */
export function groupTag(c) {
  const names = (c.group?.members ?? []).map((m) => m.name);
  return names.length ? `👥 ${names.join(', ')}` : `👥 ${t('Group')}`;
}

const STYLE_HINT = {
  fits: 'A quick helper step picks who answers (one or two). Name someone with @ to ask them.',
  everyone: 'Each companion answers in turn, every time.',
  turns: 'One answer per message, taking turns.',
  mention: 'Only who you name with @ answers (for example @Mia); without a name, whoever fits.',
};

function renderMembers() {
  const box = $('#gc-members');
  const cur = ctx.current();
  const locked = Boolean(dlg.editing);
  box.replaceChildren(
    ...ctx.companions().map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick-card gc-member';
      b.setAttribute('role', 'checkbox');
      const on = dlg.picked.includes(c.id);
      b.setAttribute('aria-checked', String(on));
      b.disabled = locked;
      const img = document.createElement('img');
      img.className = 'spk-face';
      img.src = faceUrl(c.id);
      img.alt = '';
      const name = document.createElement('strong');
      name.textContent = c.name;
      b.append(img, name);
      if (c.id === cur) b.append(Object.assign(document.createElement('small'), { className: 'muted', textContent: t('talking to now') }));
      b.addEventListener('click', () => {
        if (locked) return;
        dlg.picked = on ? dlg.picked.filter((x) => x !== c.id) : dlg.picked.length >= 4 ? dlg.picked : [...dlg.picked, c.id];
        renderMembers();
        syncCreate();
      });
      return b;
    }),
  );
}

function syncCreate() {
  const n = dlg.picked.length;
  $('#gc-count').textContent = t('{n} of 2 to 4 picked', { n });
  $('#gc-create').disabled = !dlg.editing && (n < 2 || n > 4);
  $('#gc-style-hint').textContent = t(STYLE_HINT[$('#gc-style').value] ?? STYLE_HINT.fits);
  // Phase 114 (§3.4): the value in words (0 calm, 1 some, 2 lively).
  $('#gc-banter-n').textContent = [t('Calm (0)'), t('Some (1)'), t('Lively (2)')][Number($('#gc-banter').value)] ?? $('#gc-banter').value;
}

/** Opens the window: a new group chat, or (with a conversation) that room's settings. */
export function openGroupDialog(conv = null) {
  const room = conv?.group ?? null;
  dlg.editing = room ? { room, convId: conv.id } : null;
  dlg.picked = room ? room.members.map((m) => m.id) : [ctx.current()].filter(Boolean);
  $('#gc-heading-text').textContent = room ? t('Group chat settings') : t('New group chat');
  $('#gc-title').value = room?.title ?? '';
  $('#gc-style').value = room?.turnStyle ?? 'fits';
  $('#gc-banter').value = String(room?.banter ?? 0);
  $('#gc-private').checked = Boolean(room?.private);
  $('#gc-private').disabled = Boolean(room);
  $('#gc-create').hidden = Boolean(room);
  $('#gc-saved').textContent = '';
  $('#gc-error').textContent = '';
  renderMembers();
  syncCreate();
  $('#group-dialog').showModal();
  if (!room) $('#gc-title').focus();
}

/** Room settings save as they change (title on leaving the box). */
async function autosave(patch) {
  if (!dlg.editing) return;
  try {
    const r = await ctx.api(`/groups/${dlg.editing.room.id}`, { method: 'PATCH', body: patch });
    dlg.editing.room = r.room;
    ctx.onRoom?.(r.room);
    $('#gc-saved').textContent = t('Saved.');
    $('#gc-error').textContent = '';
    await ctx.loadConversations();
  } catch (err) {
    $('#gc-error').textContent = err.message;
  }
}

async function create() {
  $('#gc-error').textContent = '';
  const body = { title: $('#gc-title').value.trim() || t('Group chat'), members: dlg.picked, turnStyle: $('#gc-style').value, banter: Number($('#gc-banter').value), private: $('#gc-private').checked };
  $('#gc-create').disabled = true;
  try {
    const r = await ctx.api('/groups', { method: 'POST', body });
    $('#group-dialog').close();
    // Made from a companion who isn't in it: the app switches to the first one who is.
    if (r.companion) return ctx.switchCompanion(r.companion, r.conversationId);
    await ctx.loadConversations();
    await ctx.openConversation(r.conversationId);
  } catch (err) {
    $('#gc-error').textContent = err.message;
  } finally {
    syncCreate();
  }
}

export function initGroups(opts) {
  Object.assign(ctx, opts);
  $('#new-group').addEventListener('click', () => openGroupDialog());
  $('#gc-create').addEventListener('click', () => void create());
  $('#gc-style').addEventListener('change', () => {
    syncCreate();
    void autosave({ turnStyle: $('#gc-style').value });
  });
  $('#gc-banter').addEventListener('input', syncCreate);
  $('#gc-banter').addEventListener('change', () => void autosave({ banter: Number($('#gc-banter').value) }));
  $('#gc-title').addEventListener('change', () => {
    const title = $('#gc-title').value.trim();
    if (title) void autosave({ title });
  });
}

/** "+ Group" shows once there are two companions or more. */
export function showGroupButton(n) {
  $('#new-group').hidden = n < 2;
}
