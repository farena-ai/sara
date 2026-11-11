// Feature 4 (works offline): what this device kept, read-only, when the server can't be reached.
// Drawn over the app (web/offline-hook.js) and on the service worker's offline page (offline.js):
// the recent chats and notes, a bar with when the copy was made, and an outbox: messages written
// now wait as "Waiting to send" bubbles (edit or delete them) and go when the connection is back.
// Note changes are added to the end of the note (never overwriting what changed meanwhile).
import { asOfText } from './offline-sync.js';

/**
 * Every word this view shows, through `t` (the app's translations). The app saves them with the
 * copy (in the person's language), so the offline page, which has no translations, shows them too.
 */
export function offlineWords(t) {
  return {
    bar: t('Offline — showing what this device kept (as of {time})'),
    barNone: t("Offline — this device hasn't kept anything yet"),
    retry: t('Try again'),
    checking: t('Checking…'),
    chats: t('Chats'),
    notes: t('Notes'),
    back: t('Back'),
    empty: t("Nothing was kept on this device yet. Chats and notes you open while connected are kept here for offline reading (Settings → Connections → Devices and sign-in)."),
    pick: t('Pick a chat or a note to read it.'),
    noNotes: t('No notes kept.'),
    you: t('You'),
    her: t('Sara'),
    waiting: t('Waiting to send'),
    refused: t("Couldn't send: {error}"),
    edit: t('Edit'),
    save: t('Save'),
    cancel: t('Cancel'),
    remove: t('Delete'),
    copyText: t('Copy'),
    write: t('Write a message (it is sent when you are back online)'),
    queue: t('Send when back online'),
    addNote: t('Add to this note (added to the end when you are back online)'),
    queueNote: t('Add when back online'),
    newNote: t('New note'),
    newTitle: t('Title'),
    noteWaiting: t('Waiting to be added'),
    older: t('Only the last {n} messages are kept on this device.'),
    maybeSent: t('This one may already have reached her; it can only be deleted.'),
  };
}
const fill = (s, vars = {}) => Object.entries(vars).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), String(s));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(text, cls, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Shows the view. `copy` is the device's copy (web/offline-store.js), `words` offlineWords(t),
 * `onRetry` checks the connection now (resolves true when back).
 */
export function mountOfflineView({ copy, words, onRetry, root = document.body, locale, herName }) {
  const W = { ...offlineWords((s) => s), ...(words ?? {}) };
  if (herName) W.her = herName;
  const view = el('div', 'offv');
  view.id = 'offline-view';
  view.setAttribute('role', 'region');
  view.setAttribute('aria-label', W.chats);
  const bar = el('div', 'offv-bar');
  bar.setAttribute('role', 'status');
  const barText = el('span', 'offv-bar-text');
  const retry = button(W.retry, 'offv-retry', async () => {
    retry.disabled = true;
    retry.textContent = W.checking;
    try {
      await onRetry?.();
    } finally {
      retry.disabled = false;
      retry.textContent = W.retry;
    }
  });
  bar.append(barText, retry);
  const side = el('nav', 'offv-side');
  const pane = el('section', 'offv-pane');
  pane.setAttribute('aria-live', 'polite');
  const body = el('div', 'offv-body');
  body.append(side, pane);
  view.append(bar, body);
  let picked = null; // { kind: 'chat' | 'note', id }

  async function drawBar() {
    const asOf = await copy.asOf();
    barText.textContent = asOf ? fill(W.bar, { time: asOfText(asOf, { locale }) }) : W.barNone;
  }

  async function drawSide() {
    const [list, notes] = await Promise.all([copy.list(), copy.notes()]);
    const items = [];
    if (!list.length && !notes.length) items.push(el('p', 'offv-muted', W.empty));
    if (list.length) {
      items.push(el('h2', 'offv-h', W.chats));
      const ul = el('ul', 'offv-list');
      for (const c of list) {
        const li = el('li');
        const b = button(c.title || '…', `offv-item${picked?.kind === 'chat' && picked.id === c.id ? ' on' : ''}`, () => openChat(c.id));
        b.dataset.chat = c.id;
        li.append(b);
        ul.append(li);
      }
      items.push(ul);
    }
    const nh = el('div', 'offv-h-row');
    nh.append(el('h2', 'offv-h', W.notes), button(W.newNote, 'offv-small', () => openNewNote()));
    items.push(nh);
    if (notes.length) {
      const ul = el('ul', 'offv-list');
      for (const n of notes) {
        const li = el('li');
        const b = button(n.title || '…', `offv-item${picked?.kind === 'note' && picked.id === n.id ? ' on' : ''}`, () => openNote(n.id));
        b.dataset.note = String(n.id);
        li.append(b);
        ul.append(li);
      }
      items.push(ul);
    } else items.push(el('p', 'offv-muted', W.noNotes));
    side.replaceChildren(...items);
  }

  const showPane = (on) => view.classList.toggle('offv-reading', on);
  const backRow = (title) => {
    const head = el('div', 'offv-pane-head');
    head.append(button(`‹ ${W.back}`, 'offv-back', () => {
      picked = null;
      showPane(false);
      void drawSide();
    }), el('h2', 'offv-title', title));
    return head;
  };

  /** An outbox bubble: Waiting to send (Edit, Delete), or refused with the reason (Copy, Delete). */
  function waitingBubble(item, label) {
    const b = el('div', `offv-msg user waiting${item.state === 'refused' ? ' refused' : ''}`);
    b.dataset.outbox = item.id;
    const textEl = el('div', 'offv-text', item.text);
    const meta = el('div', 'offv-wait', item.state === 'refused' ? fill(W.refused, { error: item.error ?? '' }) : label);
    const acts = el('div', 'offv-acts');
    if (item.state !== 'refused' && !item.tried)
      acts.append(button(W.edit, 'offv-small', () => {
        const box = el('textarea', 'offv-input');
        box.value = item.text;
        box.rows = Math.min(8, Math.max(2, item.text.split('\n').length));
        const row = el('div', 'offv-acts');
        row.append(button(W.save, 'offv-small primary', async () => {
          await copy.edit(item.id, box.value);
          await redraw();
        }), button(W.cancel, 'offv-small', () => redraw()));
        b.replaceChildren(box, row);
        box.focus();
      }));
    if (item.state === 'refused') acts.append(button(W.copyText, 'offv-small', () => void navigator.clipboard?.writeText(item.text)));
    if (item.tried && item.state !== 'refused') meta.textContent = `${label} · ${W.maybeSent}`;
    acts.append(button(W.remove, 'offv-small', async () => {
      await copy.remove(item.id);
      await redraw();
    }));
    b.append(textEl, meta, acts);
    return b;
  }

  async function openChat(id) {
    picked = { kind: 'chat', id };
    const [chat, outbox] = await Promise.all([copy.chat(id), copy.outbox()]);
    const listed = (await copy.list()).find((c) => c.id === id);
    const msgs = el('div', 'offv-msgs');
    if ((chat?.messages?.length ?? 0) >= 200) msgs.append(el('p', 'offv-muted offv-center', fill(W.older, { n: 200 })));
    for (const m of chat?.messages ?? []) {
      const b = el('div', `offv-msg ${m.role === 'user' ? 'user' : 'her'}`);
      b.append(el('div', 'offv-who', m.role === 'user' ? W.you : W.her), el('div', 'offv-text', m.content));
      msgs.append(b);
    }
    for (const item of outbox.filter((x) => x.kind === 'chat' && x.conversationId === id)) msgs.append(waitingBubble(item, W.waiting));
    const form = el('form', 'offv-compose');
    const box = el('textarea', 'offv-input');
    box.id = 'offv-input';
    box.rows = 2;
    box.placeholder = W.write;
    box.setAttribute('aria-label', W.write);
    const go = el('button', 'primary', W.queue);
    go.type = 'submit';
    form.append(box, go);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!box.value.trim()) return;
      await copy.queue({ kind: 'chat', conversationId: id, text: box.value });
      box.value = '';
      await openChat(id);
      document.getElementById('offv-input')?.focus();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    pane.replaceChildren(backRow(chat?.title || listed?.title || '…'), msgs, form);
    showPane(true);
    await drawSide();
    msgs.scrollTop = msgs.scrollHeight;
  }

  function noteForm(onAdd, placeholder) {
    const form = el('form', 'offv-compose');
    const box = el('textarea', 'offv-input');
    box.rows = 3;
    box.placeholder = placeholder;
    box.setAttribute('aria-label', placeholder);
    const go = el('button', 'primary', W.queueNote);
    go.type = 'submit';
    form.append(box, go);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (box.value.trim()) await onAdd(box.value);
    });
    return form;
  }

  async function openNote(id) {
    picked = { kind: 'note', id };
    const [notes, outbox] = await Promise.all([copy.notes(), copy.outbox()]);
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    const wrap = el('div', 'offv-msgs');
    wrap.append(el('div', 'offv-note', n.body));
    for (const item of outbox.filter((x) => x.kind === 'note' && x.noteId === id)) wrap.append(waitingBubble(item, W.noteWaiting));
    const form = noteForm(async (text) => {
      await copy.queue({ kind: 'note', noteId: n.id, title: n.title, text });
      await openNote(id);
    }, W.addNote);
    pane.replaceChildren(backRow(n.title), wrap, form);
    showPane(true);
    await drawSide();
  }

  async function openNewNote() {
    picked = { kind: 'new-note' };
    const outbox = await copy.outbox();
    const wrap = el('div', 'offv-msgs');
    for (const item of outbox.filter((x) => x.kind === 'note' && !x.noteId)) {
      const b = waitingBubble(item, W.noteWaiting);
      b.prepend(el('div', 'offv-who', item.title));
      wrap.append(b);
    }
    const title = el('input', 'offv-input offv-title-input');
    title.placeholder = W.newTitle;
    title.setAttribute('aria-label', W.newTitle);
    title.maxLength = 120;
    const form = noteForm(async (text) => {
      if (!title.value.trim()) return title.focus();
      await copy.queue({ kind: 'note', title: title.value.trim(), text });
      await openNewNote();
    }, W.newNote);
    form.prepend(title);
    pane.replaceChildren(backRow(W.newNote), wrap, form);
    showPane(true);
    await drawSide();
  }

  async function redraw() {
    await drawBar();
    if (picked?.kind === 'chat') return openChat(picked.id);
    if (picked?.kind === 'note') return openNote(picked.id);
    if (picked?.kind === 'new-note') return openNewNote();
    await drawSide();
    pane.replaceChildren(el('p', 'offv-muted offv-center', W.pick));
  }

  root.append(view);
  return {
    el: view,
    /** The chat being read (to open it in the app when the server is back). */
    get chatId() {
      return picked?.kind === 'chat' ? picked.id : null;
    },
    /** Opens a chat (the one that was open in the app) or the first kept one on a big screen. */
    async show(openId) {
      view.hidden = false;
      document.documentElement.classList.add('offline-reading');
      await redraw();
      const list = await copy.list();
      const first = list.find((c) => c.id === openId) ?? (matchMedia?.('(min-width: 800px)').matches ? list[0] : undefined);
      if (first && !picked) await openChat(first.id);
    },
    hide() {
      view.hidden = true;
      document.documentElement.classList.remove('offline-reading');
    },
    redraw,
  };
}
