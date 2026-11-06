// R1B1 shared roleplay scenes: owner controls in Settings → Chat apps → Session continuity.
// R1B3: the one shared room seat, the "In scene" chip in the chat header and "Add to scene".
// Every string goes through t(); stored titles, premises, canon and labels are text nodes only.
import { t } from './naming.js';

const $ = selector => document.querySelector(selector);
let ctx;
export function initScenes(context) { ctx = context; }

const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
const button = (text, action, cls = 'ghost small') => { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', action); return node; };
const tip = text => { const node = el('button', 'tip', '?'); node.type = 'button'; node.dataset.tip = text; node.setAttribute('aria-label', t('More about this')); return node; };
const raw = node => { node.dataset.raw = ''; return node; };
// Settings is a dialog <form>: scene boxes are plain groups, and Enter never submits or closes it.
const input = (name, max) => { const node = el('input'); node.name = name; node.maxLength = max; node.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); }); return node; };
const field = (labelText, control, help) => { const label = el('label', 'tidy-stack scene-field'); const head = el('span', '', labelText); if (help) head.append(' ', tip(help)); label.append(head, control); return label; };

const TIPS = {
  scenes: () => t('A shared scene is a story she keeps across the chats you link: a title, a premise and a few canon facts. Raw messages are never copied between chats. Only you create, link and change it.'),
  who: () => t('Everyone in the linked conversations experiences this canon in her replies. Raw messages are never copied between them. Your memories and tools never reach a shared room.'),
  link: () => t('Link your own open chats (web, your Telegram or Discord DM) and at most one shared room: a Discord channel, a Telegram group or a DM with a guest. Private, coding and group chats cannot join.'),
  room: () => t('Guests in the room experience the canon in her replies, never the list itself, your other chats, memories or tools. Their words become canon only when you pick a line with Add to scene.'),
  addToScene: () => t('Saves this exact line as a canon fact of the scene. Everyone linked to the scene experiences it in her replies. Editing, regenerating or forgetting the line, or removing its chat, erases it.'),
  canon: () => t('Canon is the story so far, as short facts with a name (inn, the-duel). Each change keeps the last 5 versions. Facts are fiction: never facts about you, never instructions for her.'),
  adult: () => t('Adult scenes need Adult mode on. While Adult mode is off, an adult scene is never used in any reply. The minors block applies to every scene, always.'),
  status: () => t('Paused: no linked chat uses the scene until you set it back to Active. Your stop word pauses it at once for every linked chat.'),
  reset: () => t('Reset removes all canon and its history. The title, premise and linked chats stay. Delete removes the whole scene. Neither changes any message.'),
  enabled: () => t('On: linked chats see their scene in her replies. Off stops that everywhere and keeps every scene, so you can still look, unlink, reset or delete.'),
};
const BRIDGES = { discord: 'Discord', telegram: 'Telegram' };
/** The exact audience of a shared room, in plain words; the room's name is data (text node only). */
const roomAudience = room => {
  const app = BRIDGES[room?.bridge] ?? room?.bridge ?? '';
  if (room?.kind === 'channel') return t("Everyone who can read {room} on {app} will experience this scene's canon in her replies there. They never see your other chats, memories or tools.", { room: room.name, app });
  if (room?.kind === 'group') return t("Everyone in the {app} group {room} will experience this scene's canon in her replies there. They never see your other chats, memories or tools.", { room: room.name, app });
  return t("{room}, in a {app} DM with her, will experience this scene's canon in her replies there. They never see your other chats, memories or tools.", { room: room?.name ?? '', app });
};
const audience = channel => channel === 'web' ? t('Only you, in your web chat.')
  : /^discord/.test(channel) ? t('Only you, in your Discord DM.')
  : /^telegram/.test(channel) ? t('Only you, in your Telegram DM.')
  : t('Only you, in your own chat on {app}.', { app: channel.replace(/^plugin-/, '') });

export async function loadSceneSettings() {
  const box = $('#scenes-settings');
  if (!ctx || !box) return;
  if (document.body.classList.contains('demo') || document.body.classList.contains('member')) { box.hidden = true; return; }
  try {
    const value = await ctx.api('/scenes');
    $('#scenes-enabled').checked = value.enabled;
    box.dataset.loaded = '1'; box.hidden = false;
    renderList($('#scenes-box'), value);
  } catch { box.hidden = true; }
}
export async function saveSceneSettings() {
  if (!ctx || !$('#scenes-settings')?.dataset.loaded) return;
  const status = $('#scenes-status');
  try {
    const value = await ctx.api('/scenes/settings', { method: 'PUT', body: { enabled: $('#scenes-enabled').checked } });
    status.textContent = value.enabled ? t('Shared scenes are on.') : t('Shared scenes are off. Every scene is kept.');
  } catch (error) {
    status.textContent = t('Could not save the shared scenes switch. Your choice is kept; try again.');
    throw error;
  }
}

/** Who wrote a canon fact: she did (scene_canon in your own linked chat), a line you picked, or you typed it. */
const sourceLabel = entry => entry.author === 'owner-turn' ? t('Written by her in a linked chat')
  : entry.source?.audience === 'room' ? t('From a line in the shared room')
  : entry.source ? t('From a line in a linked chat') : t('You typed this');

function limitText(error, what) {
  if (error?.status === 413) return what === 'create' ? t('You have 20 scenes, the most there can be. Delete one to start another.')
    : what === 'link' ? t('A scene can have 3 of your own chats.') : t('A scene can have 40 canon facts. Retire one first.');
  if (error?.status === 409 && what === 'link') return t('That chat could not be linked. It may already be in a scene, this scene may already have its one shared room, its chat app may be off, or an adult scene needs an adult room. Reload and try again.');
  if (error?.status === 409) return t('This scene changed. Reload it to see the current canon.');
  if (error?.status === 400) return t('That was not saved. Check the text (canon keys use lower-case letters, digits and dashes) and the safety rules.');
  return t('Could not save. Your text is kept; try again.');
}

function renderList(host, data) {
  const status = $('#scenes-status');
  const list = el('div', 'scene-list tidy-stack');
  if (!data.scenes.length) list.append(el('p', 'muted small', t('No scenes yet. Start one and link the chats where you play it.')));
  for (const scene of data.scenes) {
    const card = el('article', 'tidy-card tidy-stack scene-card');
    const head = el('div', 'scene-head');
    head.append(raw(el('h4', 'scene-title', scene.title)), el('span', 'status-chip', scene.status === 'paused' ? t('Paused') : t('Active')));
    if (scene.adult) head.append(el('span', 'status-chip', t('Adult')));
    card.append(head, el('p', 'muted small', t('{seats} linked chats · {canon} canon facts', { seats: scene.seatCount, canon: scene.canonCount })));
    if (scene.idle) card.append(el('p', 'muted small', t('Not used for a while')));
    card.append(button(t('Open scene'), () => void openScene(host, scene.id)));
    list.append(card);
  }
  const form = el('div', 'tidy-card tidy-stack scene-new'); form.hidden = true; form.setAttribute('role', 'group');
  const title = input('scene-title', 80);
  const premise = el('textarea'); premise.name = 'scene-premise'; premise.maxLength = 1500; premise.rows = 3;
  form.append(field(t('Title'), title), field(t('Premise'), premise));
  const adult = el('input'); adult.type = 'checkbox'; adult.name = 'scene-adult';
  if (data.adultAvailable) { const row = el('label', 'row'); row.append(adult, ' ', el('span', '', t('Adult scene')), ' ', tip(TIPS.adult())); form.append(row); }
  const actions = el('div', 'actions-left');
  const save = button(t('Create scene'), () => void create(), 'small');
  actions.append(save, button(t('Cancel'), () => { form.hidden = true; start.hidden = false; start.focus(); }));
  form.append(actions);
  const create = async () => {
    save.disabled = true;
    try {
      const out = await ctx.api('/scenes', { method: 'POST', body: { title: title.value, premise: premise.value, ...(data.adultAvailable && adult.checked ? { adult: true } : {}) } });
      status.textContent = t('Scene created. Link the chats where you play it.');
      await openScene(host, out.scene.id);
    } catch (error) { status.textContent = limitText(error, 'create'); }
    finally { save.disabled = false; }
  };
  const start = button(t('New scene'), () => { form.hidden = false; start.hidden = true; title.focus(); }, 'small');
  host.replaceChildren(list, start, form);
}

async function backToList(host) {
  try { renderList(host, await ctx.api('/scenes')); } catch { $('#scenes-status').textContent = t('Could not load your scenes.'); }
}

async function openScene(host, id) {
  const status = $('#scenes-status');
  let data;
  try { data = await ctx.api(`/scenes/${id}`); } catch { status.textContent = t('Could not load this scene.'); return; }
  const scene = data.scene; const path = `/scenes/${scene.id}`;
  const root = el('section', 'tidy-stack scene-detail');
  const reload = () => void openScene(host, scene.id);
  /** 409: keep the draft, say so, offer an explicit Reload. */
  const conflictRow = el('div', 'actions-left'); conflictRow.hidden = true;
  conflictRow.append(el('p', 'small', t('This scene changed. Reload it to see the current canon.')), button(t('Reload'), reload, 'small'));
  const run = async (what, work, done) => {
    try { await work(); if (done) status.textContent = done; reload(); }
    catch (error) { status.textContent = limitText(error, what); if (error?.status === 409) conflictRow.hidden = false; }
  };
  const confirmBox = (question, yesText, action, cls = 'small danger') => {
    const box = el('div', 'tidy-card tidy-stack'); const row = el('div', 'actions-left');
    const no = button(t('Cancel'), () => box.remove());
    row.append(button(yesText, () => { box.remove(); void action(); }, cls), no);
    box.append(el('p', 'small', question), row);
    box.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); box.remove(); } });
    return box;
  };

  // Heading, chips, title/premise editor.
  const head = el('div', 'scene-head');
  head.append(raw(el('h4', 'scene-title', scene.title)));
  if (scene.adult) head.append(el('span', 'status-chip', t('Adult')));
  const premise = raw(el('p', 'small scene-premise', scene.premise || t('No premise yet.')));
  const edit = el('div', 'tidy-card tidy-stack'); edit.hidden = true; edit.setAttribute('role', 'group');
  const titleIn = input('scene-edit-title', 80); titleIn.value = scene.title;
  const premiseIn = el('textarea'); premiseIn.name = 'scene-edit-premise'; premiseIn.maxLength = 1500; premiseIn.rows = 3; premiseIn.value = scene.premise;
  const editSave = button(t('Save'), () => void run('edit', () => ctx.api(path, { method: 'PATCH', body: { expectedRevision: scene.revision, title: titleIn.value, premise: premiseIn.value } }), t('Scene saved.')), 'small');
  const editRow = el('div', 'actions-left'); editRow.append(editSave, button(t('Cancel'), () => { edit.hidden = true; }));
  edit.append(field(t('Title'), titleIn), field(t('Premise'), premiseIn), editRow);
  const statusPick = el('select'); statusPick.name = 'scene-status';
  for (const [value, label] of [['active', t('Active')], ['paused', t('Paused')]]) { const o = el('option', '', label); o.value = value; statusPick.append(o); }
  statusPick.value = scene.status;
  statusPick.addEventListener('change', () => void run('edit', () => ctx.api(path, { method: 'PATCH', body: { expectedRevision: scene.revision, status: statusPick.value } }), statusPick.value === 'paused' ? t('Scene paused.') : t('Scene active again.')));
  const top = el('div', 'actions-left');
  top.append(button(t('All scenes'), () => void backToList(host)), button(t('Edit title and premise'), () => { edit.hidden = false; titleIn.focus(); }));
  root.append(top, head, premise, edit, field(t('Status'), statusPick, TIPS.status()));

  // Seats.
  const seats = el('section', 'tidy-stack');
  const seatHead = el('h4', '', t('Linked chats')); seatHead.append(' ', tip(TIPS.who()));
  seats.append(seatHead);
  if (!data.seats.length) seats.append(el('p', 'muted small', t('No chats linked yet. Until you link one, she does not use this scene anywhere.')));
  for (const seat of data.seats) {
    const card = el('article', 'tidy-card tidy-stack scene-seat');
    card.append(raw(el('p', 'small', seat.title || t('Untitled'))));
    if (seat.audience === 'room') {
      const chips = el('div', 'scene-head'); chips.append(el('span', 'status-chip', t('Shared room')), raw(el('span', 'status-chip', seat.room?.name ?? t('Untitled'))), tip(TIPS.room()));
      card.append(chips, el('p', 'muted small', roomAudience(seat.room)));
    } else card.append(el('p', 'muted small', audience(seat.channel)));
    const remove = button(t('Remove from scene'), () => {
      card.append(confirmBox(t('Remove this chat from the scene? Canon taken from its lines is erased; typed canon stays.'), t('Confirm remove'), () => run('unlink', () => ctx.api(`/scenes/${scene.id}/seats/${encodeURIComponent(seat.conversationId)}`, { method: 'DELETE', body: { expectedRevision: scene.revision } }), t('Chat removed from the scene.'))));
    }, 'ghost small danger-text');
    card.append(remove); seats.append(card);
  }
  const linkBox = el('div', 'tidy-stack');
  const pick = el('select'); pick.name = 'scene-link'; const blank = el('option', '', t('Choose a chat')); blank.value = ''; pick.append(blank);
  const sentence = el('p', 'small'); sentence.hidden = true;
  // R1B3: a shared room shows its exact audience and what guests get before Confirm.
  const roomNote = el('div', 'tidy-card tidy-stack scene-room-confirm'); roomNote.hidden = true;
  const confirmRow = el('div', 'actions-left'); confirmRow.hidden = true;
  const options = new Map();
  const confirmLink = button(t('Confirm link'), () => {
    const option = options.get(pick.value);
    const body = { conversationId: pick.value, expectedRevision: scene.revision, confirmAudience: true, ...(option?.room ? { confirmRoomId: option.room.id } : {}) };
    void run('link', () => ctx.api(`/scenes/${scene.id}/seats`, { method: 'POST', body }), option?.room ? t('Shared room linked to the scene.') : t('Chat linked to the scene.'));
  }, 'small');
  const clear = () => { pick.value = ''; sentence.hidden = true; roomNote.hidden = true; confirmRow.hidden = true; };
  confirmRow.append(confirmLink, button(t('Cancel'), clear));
  pick.addEventListener('change', () => {
    const option = options.get(pick.value);
    sentence.hidden = !option; confirmRow.hidden = !option; roomNote.hidden = !option?.room;
    confirmLink.disabled = false;
    if (!option) { sentence.textContent = ''; return; }
    if (!option.room) { sentence.textContent = t('Who will experience this scene: {who} She uses its canon in her replies there.', { who: audience(option.channel) }); return; }
    sentence.textContent = t('Who will experience this scene: {who}', { who: roomAudience(option.room) });
    const facts = [t('Room: {room} ({kind})', { room: option.room.name, kind: option.room.kind === 'channel' ? t('Discord channel') : option.room.kind === 'group' ? t('Telegram group') : t('DM with a guest') }),
      t('Guests will see the effects of this scene in her replies, never the canon list itself.'),
      t('Their words become canon only when you pick a line with Add to scene.'),
      t('A scene has one shared room. A second room needs a second scene.')];
    const list = el('ul', 'small'); for (const fact of facts) list.append(el('li', '', fact));
    const head = el('p', 'small'); head.append(el('strong', '', t('Linking a shared room')), ' ', tip(TIPS.room()));
    roomNote.replaceChildren(head, list);
    if (scene.adult && !option.adultEligible) {
      roomNote.append(el('p', 'small danger-text', t('An adult scene can only use an adult room (a Discord NSFW channel or a room you listed as adult) while Adult mode is on. A DM with a guest never can.')));
      confirmLink.disabled = true;
    }
  });
  linkBox.append(field(t('Link a chat'), pick, TIPS.link()), sentence, roomNote, confirmRow);
  seats.append(linkBox);
  root.append(seats);
  void ctx.api(`/scenes/${scene.id}/seat-options`).then(result => {
    for (const option of result.options) {
      options.set(option.conversationId, option);
      const o = el('option', '', option.room ? `${option.room.name} · ${t('Shared room')}` : `${option.title} · ${audience(option.channel)}`); o.value = option.conversationId; pick.append(o);
    }
    if (!result.options.length) { pick.disabled = true; blank.textContent = t('No eligible chats to link'); }
  }).catch(() => { pick.disabled = true; });

  // Canon.
  const canon = el('section', 'tidy-stack');
  const canonHead = el('h4', '', t('Canon')); canonHead.append(' ', tip(TIPS.canon()));
  canon.append(canonHead);
  if (!data.canon.length) canon.append(el('p', 'muted small', t('No canon yet. Add the facts the story should keep.')));
  const composer = (key, text, onDone) => {
    const form = el('div', 'tidy-card tidy-stack'); form.setAttribute('role', 'group');
    const keyIn = input('scene-canon-key', 40); keyIn.value = key ?? ''; if (key) keyIn.readOnly = true;
    const textIn = el('textarea'); textIn.name = 'scene-canon-text'; textIn.maxLength = 400; textIn.rows = 2; textIn.value = text ?? '';
    const save = button(t('Save canon'), () => void run('canon', () => ctx.api(`/scenes/${scene.id}/canon`, { method: 'POST', body: { expectedRevision: scene.revision, key: keyIn.value.trim(), text: textIn.value } }), t('Canon saved.')), 'small');
    const row = el('div', 'actions-left'); row.append(save);
    if (onDone) row.append(button(t('Cancel'), onDone));
    form.append(field(t('Name (lower-case letters, digits and dashes)'), keyIn), field(t('Fact'), textIn), el('p', 'muted small', t('Seen in her replies in every linked chat.')), row);
    return form;
  };
  for (const entry of data.canon) {
    const card = el('article', 'tidy-card tidy-stack scene-canon');
    const top2 = el('div', 'scene-head'); top2.append(raw(el('strong', '', entry.key)), el('span', 'status-chip', sourceLabel(entry)));
    if (entry.blocked) top2.append(el('span', 'status-chip danger-text', t('Blocked by the safety check')));
    card.append(top2, raw(el('p', 'small scene-text', entry.text)));
    const versions = data.history[entry.key] ?? [];
    if (versions.length > 1) {
      const fold = el('details', 'scene-history'); fold.append(el('summary', 'small', t('History ({n} versions)', { n: versions.length })));
      for (const v of versions) fold.append(raw(el('p', 'muted small', `v${v.version}: ${v.retired ? t('(retired)') : v.text}`)));
      card.append(fold);
    }
    const row = el('div', 'actions-left');
    row.append(button(t('Edit'), () => { row.hidden = true; card.append(composer(entry.key, entry.text, () => { row.hidden = false; card.lastChild.remove(); })); }),
      button(t('Retire'), () => card.append(confirmBox(t('Retire this fact? It stays in its history.'), t('Confirm retire'), () => run('canon', () => ctx.api(`/scenes/${scene.id}/canon/${encodeURIComponent(entry.key)}`, { method: 'DELETE', body: { expectedRevision: scene.revision } }), t('Fact retired.')))), 'ghost small danger-text'));
    card.append(row); canon.append(card);
  }
  canon.append(composer());
  root.append(canon, conflictRow);

  // Danger.
  const danger = el('details', 'tidy-card tidy-stack scene-danger');
  const summary = el('summary', 'small', t('Danger')); danger.append(summary);
  const dangerRow = el('div', 'actions-left');
  dangerRow.append(
    button(t('Reset canon'), () => danger.append(confirmBox(t('Reset this scene? All canon and its history are removed; title, premise and linked chats stay.'), t('Confirm reset'), () => run('reset', () => ctx.api(`/scenes/${scene.id}/reset`, { method: 'POST', body: { expectedRevision: scene.revision } }), t('Scene reset.'))))),
    button(t('Delete scene'), () => danger.append(confirmBox(t('Delete this scene? Its canon, history and links are removed. Messages stay.'), t('Confirm delete'), async () => {
      try { await ctx.api(path, { method: 'DELETE', body: { expectedRevision: scene.revision } }); status.textContent = t('Scene deleted.'); await backToList(host); }
      catch (error) { status.textContent = limitText(error, 'delete'); if (error?.status === 409) conflictRow.hidden = false; }
    })), 'ghost small danger-text'),
  );
  danger.append(el('p', 'muted small', TIPS.reset()), dangerRow);
  root.append(danger);
  host.replaceChildren(root);
}

// ----- R1B3: the "In scene" chip in the chat header and "Add to scene" in the message menu -----
const ownerView = () => !document.body.classList.contains('demo') && !document.body.classList.contains('member');

/** Shows "In scene: <title>" beside the chat title for a linked conversation (owner only). */
export function renderSceneChip(conv) {
  const wrap = document.querySelector('#chat-head .title-wrap');
  if (!wrap) return;
  let chip = wrap.querySelector('#scene-chip');
  const scene = ownerView() ? conv?.scene : undefined;
  if (!scene) { chip?.remove(); return; }
  if (!chip) { chip = el('span', 'status-chip scene-chip'); chip.id = 'scene-chip'; wrap.querySelector('#chat-title')?.after(chip); }
  chip.dataset.raw = '';
  chip.textContent = scene.status === 'paused' ? t('In scene: {title} (paused)', { title: scene.title }) : t('In scene: {title}', { title: scene.title });
  // The full name stays readable where the header cuts the chip short (phone width).
  chip.title = `${chip.textContent}. ${scene.audience === 'room' ? t('This shared room is linked to a shared scene. Only you see this chip.') : t('This chat is linked to a shared scene. Only you see this chip.')}`;
}

/** The message-menu action for a line of a linked conversation (owner only; user and her lines). */
export function addToSceneAction(m, conv, make) {
  if (!ownerView() || !conv?.scene || !m?.id || (m.role !== 'user' && m.role !== 'assistant')) return undefined;
  if (m.meta?.blocked || m.meta?.forgotten || m.meta?.group || m.meta?.importedFrom) return undefined;
  const action = make('story', t('Add to scene'));
  action.classList.add('scene-add-action');
  action.addEventListener('click', () => void openAddToScene(m, conv.scene));
  return action;
}

async function openAddToScene(m, chip) {
  document.querySelector('#scene-add')?.remove();
  const dialog = el('dialog', 'scene-add-dialog'); dialog.id = 'scene-add';
  dialog.setAttribute('aria-labelledby', 'scene-add-title');
  const form = el('form', 'settings-body tidy-stack'); form.method = 'dialog';
  const title = el('h2', '', t('Add to scene')); title.id = 'scene-add-title'; title.append(' ', tip(TIPS.addToScene()));
  const sceneLine = el('p', 'muted small'); sceneLine.append(t('Scene:'), ' ', raw(el('strong', '', chip.title)));
  const quote = raw(el('blockquote', 'small scene-add-line', m.content));
  const status = el('p', 'small'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const pick = el('select'); pick.name = 'scene-add-key';
  const keyIn = input('scene-add-new-key', 40);
  const keyField = field(t('Name (lower-case letters, digits and dashes)'), keyIn);
  const actions = el('div', 'actions');
  const cancel = button(t('Cancel'), () => dialog.close(), 'ghost');
  const save = button(t('Add to scene'), () => void submit(), '');
  const reload = button(t('Reload'), () => void load(), 'ghost small'); reload.hidden = true;
  actions.append(cancel, save);
  form.append(title, sceneLine, quote, field(t('Canon fact'), pick), keyField,
    el('p', 'muted small', t("Saved to the scene's canon. Everyone linked to this scene experiences it in her replies; nobody is messaged.")), status, reload, actions);
  form.addEventListener('submit', event => event.preventDefault());
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  let revision = chip.revision;
  const load = async () => {
    status.textContent = ''; reload.hidden = true;
    try {
      const data = await ctx.api(`/scenes/${chip.id}`);
      revision = data.scene.revision;
      const keep = pick.value;
      const fresh = el('option', '', t('A new fact')); fresh.value = '';
      pick.replaceChildren(fresh);
      for (const entry of data.canon) { const o = el('option', '', t('Replace “{key}”', { key: entry.key })); o.value = entry.key; o.dataset.raw = ''; pick.append(o); }
      if ([...pick.options].some(o => o.value === keep)) pick.value = keep;
      keyField.hidden = Boolean(pick.value);
    } catch { status.textContent = t('Could not load this scene.'); }
  };
  pick.addEventListener('change', () => { keyField.hidden = Boolean(pick.value); });
  const submit = async () => {
    const key = pick.value || keyIn.value.trim();
    save.disabled = true;
    try {
      await ctx.api(`/scenes/${chip.id}/canon`, { method: 'POST', body: { expectedRevision: revision, key, fromMessageId: m.id } });
      status.textContent = t('Added to the scene.');
      dialog.close();
    } catch (error) {
      status.textContent = error?.status === 413 ? t('That line is longer than 400 characters. Retell it as typed canon in Settings.')
        : error?.status === 404 ? t('That line is no longer in a linked chat of this scene.')
        : limitText(error, 'canon');
      if (error?.status === 409) reload.hidden = false;
    } finally { save.disabled = false; }
  };
  await load();
  dialog.showModal();
  (pick.options.length > 1 ? pick : keyIn).focus();
}
