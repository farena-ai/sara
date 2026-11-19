// Feature 4 (works offline): the app's side. Keeps this device's copy up to date while connected
// (chats as they open, the 30 newest in the background, notes), notices when the server is gone,
// shows the kept chats and notes over the app, and sends the outbox when it is back.
// web/app.js calls these few hooks; the copy is web/offline-store.js, the view web/offline-view.js.
import { idbKV, openOfflineCopy } from './offline-store.js';
import { LIST_LIMITS, slimBoard } from './offline-lists.js';
import { flushOutbox, keepChoice, privateChoice, watchConnection } from './offline-sync.js';
import { mountOfflineView, offlineWords } from './offline-view.js';
import { phoneModel } from './offline-answer.js';

const env = () => ({ ua: navigator.userAgent, standalone: Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches) });
// Until the app lends its translator: English, with {params} filled (never shown raw).
const fillIn = (s, p = {}) => Object.entries(p).reduce((o, [k, v]) => o.split(`{${k}}`).join(String(v)), String(s));
const st = { copy: null, view: null, watch: null, on: false, t: fillIn, current: () => null, onBack: () => {}, flushing: false, refreshTimer: 0, pop: null, modelTimer: 0 };

/** Whether this device keeps a copy (Settings → Connections → Devices and sign-in). */
export const offlineKeepOn = () => keepChoice(globalThis.localStorage, env());

async function postJson(path, body) {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const health = async () => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    return (await fetch('/api/health', { cache: 'no-store', signal: ctl.signal })).ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * After sign-in (web/app.js boot): `session` from /api/session, `t` the app's translations,
 * `current()` the open chat's id, `onBack()` reloads the list and the open chat when the server is back.
 */
export async function initOffline({ session, t, current, onBack, open }) {
  st.t = t;
  st.open = open ?? st.open;
  // Back from the offline page (/?back=…): the address is the app's own again.
  if (/[?&]back=\d+/.test(location.search)) history.replaceState(history.state, '', location.pathname + location.hash);
  st.session = session;
  st.current = current ?? st.current;
  st.onBack = onBack ?? st.onBack;
  if (session?.demo || !session?.serverId || !globalThis.indexedDB || !globalThis.crypto?.subtle) return;
  if (!offlineKeepOn()) {
    st.on = false;
    // Turned off on this device: nothing stays here (the outbox can't exist without the copy).
    await idbKV().drop().catch(() => {});
    st.copy = null;
    return;
  }
  try {
    st.copy ??= await openOfflineCopy(idbKV());
    await st.copy.signedIn({ serverId: session.serverId, space: session.space ?? 'owner' });
    await st.copy.saveWords({ ...offlineWords(t), her: t('Sara'), lang: document.documentElement.lang || 'en', ...(session.member?.child ? { noPhoneModel: true } : {}) });
  } catch (err) {
    console.warn('offline copy:', err);
    st.copy = null;
    return;
  }
  st.on = true;
  st.watch ??= watchConnection({ check: health, onChange: (online) => void (online ? backOnline() : goneOffline()) });
  // The newest chats and the notes, a little after the page is ready, then every 10 minutes.
  clearTimeout(st.refreshTimer);
  st.refreshTimer = setTimeout(() => void refreshCopy(), 4000);
  // Something written offline on the offline page is sent now that the page is back.
  void sendOutbox().then((r) => {
    if (r?.sent || r?.refused) {
      st.onBack();
      tellSent(r);
    }
  });
}

/** web/app.js: the conversation list just loaded. */
export function offlineSawList(convs) {
  if (st.on) void st.copy?.saveList(convs, { allowPrivate: privateChoice(globalThis.localStorage) }).catch(() => {});
}
/** web/app.js: the open chat was drawn with these messages (its newest ones); saved a moment later. */
const sawTimers = new Map();
export function offlineSawChat(conv, messages, { latest = true } = {}) {
  if (!st.on || !conv?.id) return;
  clearTimeout(sawTimers.get(conv.id));
  const snap = { conv: { id: conv.id, title: conv.title, updatedAt: conv.updatedAt, private: conv.private, offRecord: conv.offRecord, channel: conv.channel }, messages: [...messages] };
  sawTimers.set(conv.id, setTimeout(() => {
    sawTimers.delete(conv.id);
    void st.copy?.saveChat(snap.conv, snap.messages, { allowPrivate: privateChoice(globalThis.localStorage), latest }).catch(() => {});
  }, 1200));
}
/** web/app.js: a request found no server (fetch threw): check the connection now. */
export function offlineHint() {
  st.watch?.hint();
}
/** web/app.js: signing out deletes this device's copy, its outbox and its key. */
export async function offlineSignOut() {
  st.on = false;
  st.view?.hide();
  st.copy = null;
  await idbKV().drop().catch(() => {});
}
/**
 * Settings → Connections → Devices and sign-in → Offline on this device: the two switches (this
 * device's own choice, in localStorage). Off deletes the copy at once; on makes it now.
 */
export function showOfflineSettings() {
  showPhoneModelSettings();
  const keep = document.getElementById('offline-keep');
  const priv = document.getElementById('offline-private');
  if (!keep || !priv) return;
  keep.checked = offlineKeepOn();
  priv.checked = privateChoice(globalThis.localStorage);
  priv.disabled = !keep.checked;
  if (keep.dataset.wired) return;
  keep.dataset.wired = '1';
  const save = (k, on) => {
    try {
      localStorage.setItem(k, on ? '1' : '0');
    } catch {
      /* private mode */
    }
  };
  keep.addEventListener('change', async () => {
    save('sara.offline.keep', keep.checked);
    priv.disabled = !keep.checked;
    if (!keep.checked) return offlineSignOut();
    await initOffline({ session: st.session, t: st.t });
    void refreshCopy();
  });
  priv.addEventListener('change', () => {
    save('sara.offline.private', priv.checked);
    void refreshCopy(); // kept or dropped now
  });
}

/**
 * V5.6: Answers while offline (the Android app's own small model). Outside the app the controls
 * stay visible with "Only in the Android app" (a hidden setting reads as a deleted one).
 */
function showPhoneModelSettings() {
  const on = document.getElementById('offans-on');
  const state = document.getElementById('offans-state');
  const get = document.getElementById('offans-get');
  const del = document.getElementById('offans-del');
  if (!on || !state || !get || !del) return;
  const t = st.t;
  const kid = Boolean(st.session?.member?.child);
  const pm = kid ? null : phoneModel(globalThis);
  clearTimeout(st.modelTimer);
  const draw = () => {
    if (!pm) {
      on.checked = false;
      on.disabled = get.disabled = true;
      del.hidden = true;
      state.textContent = kid ? t("Not used for children's accounts.") : t('Only in the Android app. Elsewhere, messages written offline wait for her as before.');
      return;
    }
    const s = pm.status();
    on.checked = Boolean(s.on);
    on.disabled = !s.engine;
    get.hidden = s.state === 'ready';
    get.disabled = !s.engine || s.state === 'downloading';
    del.hidden = !(s.state === 'ready' || s.state === 'error' || (s.state === 'none' && s.got > 0));
    const mb = (n) => Math.max(1, Math.round((Number(n) || 0) / 1e6));
    state.textContent = !s.engine
      ? t("This copy of the app has no model engine for this phone's processor.")
      : s.state === 'ready'
        ? t('Ready on this phone: {name}, {mb} MB.', { name: s.name ?? '', mb: mb(s.size) })
        : s.state === 'downloading'
          ? t('Downloading… {pct}% of {mb} MB', { pct: s.size ? Math.floor((100 * (s.got ?? 0)) / s.size) : 0, mb: mb(s.size) })
          : s.state === 'error'
            ? t('The download stopped: {error}. Press Download to go on.', { error: s.error ?? '' })
            : t('Not downloaded yet. Wi-Fi is best.');
    const box = document.getElementById('offline-box');
    if (s.state === 'downloading' && box?.isConnected) st.modelTimer = setTimeout(draw, 1500);
  };
  draw();
  if (on.dataset.wired) return;
  on.dataset.wired = '1';
  on.addEventListener('change', () => {
    phoneModel(globalThis)?.set(on.checked);
    draw();
  });
  get.addEventListener('click', () => {
    phoneModel(globalThis)?.download();
    setTimeout(showPhoneModelSettings, 300);
  });
  del.addEventListener('click', () => {
    if (!confirm(t('Remove the model from this phone?'))) return;
    phoneModel(globalThis)?.remove();
    showPhoneModelSettings();
  });
}

async function refreshCopy() {
  clearTimeout(st.refreshTimer);
  st.refreshTimer = setTimeout(() => void refreshCopy(), 10 * 60_000);
  if (!st.on || !st.copy || st.view?.el && !st.view.el.hidden) return;
  try {
    const r = await fetch('/api/conversations?cap=200', { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    const convs = Array.isArray(data) ? data : data.conversations ?? [];
    const allowPrivate = privateChoice(globalThis.localStorage);
    const list = await st.copy.saveList(convs, { allowPrivate });
    for (const c of list) {
      const kept = await st.copy.chat(c.id);
      if (kept && kept.updatedAt === c.updatedAt) continue;
      const m = await fetch(`/api/conversations/${encodeURIComponent(c.id)}/messages?limit=200`, { cache: 'no-store' });
      if (!m.ok) continue;
      await st.copy.saveChat(convs.find((x) => x.id === c.id) ?? c, (await m.json()).messages, { allowPrivate });
      await new Promise((res) => setTimeout(res, 150));
    }
    const n = await fetch('/api/notes', { cache: 'no-store' });
    if (n.ok) await st.copy.saveNotes(await n.json());
    // R9: Today as it was last shown, and the lists for shopping mode (shared ones first).
    const snap = todaySnapshot();
    if (snap?.tiles.length) await st.copy.saveToday(snap);
    const b = await fetch('/api/boards', { cache: 'no-store' });
    if (b.ok) {
      const boards = ((await b.json()).boards ?? []).sort((x, y) => Number(Boolean(y.members)) - Number(Boolean(x.members))).slice(0, LIST_LIMITS.lists);
      const lists = [];
      for (const x of boards) {
        const v = await fetch(`/api/boards/${encodeURIComponent(String(x.id))}`, { cache: 'no-store' });
        if (v.ok) lists.push(slimBoard(await v.json()));
      }
      await st.copy.saveLists(lists.filter((l) => l.id && l.items.length));
    }
  } catch {
    /* gone offline meanwhile: the watch notices */
  }
}

/** Today's tiles as text (what the person last saw there), for reading offline. */
export function todaySnapshot(root = document) {
  const tiles = [...(root.getElementById?.('td-tiles')?.querySelectorAll('.td-tile:not([hidden])') ?? [])]
    .map((tile) => ({
      title: tile.querySelector('.td-tile-head h3')?.textContent?.trim() ?? '',
      lines: [...tile.querySelectorAll('li, .td-body > p, .today-list > p')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8),
    }))
    .filter((x) => x.title && x.lines.length);
  return { greeting: root.getElementById?.('td-greeting')?.textContent?.trim() ?? '', tiles };
}

function goneOffline() {
  if (!st.on || !st.copy) return;
  st.view ??= mountOfflineView({ copy: st.copy, words: offlineWords(st.t), kid: Boolean(st.session?.member?.child), onRetry: () => st.watch?.checkNow() });
  void st.view.show(st.current());
}

async function backOnline() {
  // The chat read offline is the one open when the app comes back.
  const reading = st.view && !st.view.el.hidden ? st.view.chatId : null;
  st.view?.hide();
  if (reading) st.open?.(reading);
  const r = await sendOutbox();
  st.onBack();
  void refreshCopy();
  tellSent(r);
}

/** "Back online — sent 2 messages" (and what couldn't be sent, with Show). */
function tellSent(r) {
  const t = st.t;
  const notes = r?.notes ?? 0;
  const lists = r?.lists ?? 0;
  const sent = (r?.sent ?? 0) - notes - lists;
  let text = notes
    ? sent === 1
      ? t('Back online — sent 1 message and added your note changes')
      : sent > 1
        ? t('Back online — sent {n} messages and added your note changes', { n: sent })
        : t('Back online — your note changes were added')
    : sent === 1
      ? t('Back online — sent 1 message')
      : sent > 1
        ? t('Back online — sent {n} messages', { n: sent })
        : lists
        ? t('Back online — your list changes were synced')
        : t('Back online');
  // Last writer wins per item: a newer change made elsewhere stays, and the note says which.
  const kept = (r?.kept ?? []).filter((k) => k.why === 'newer').map((k) => k.title).filter(Boolean);
  if (kept.length) text = `${text}. ${t('Changed on another device after you: {items} (the newer change was kept).', { items: kept.slice(0, 5).join(', ') })}`;
  popNote(r?.refused ? `${text}. ${t("{n} couldn't be sent; they are kept on this device.", { n: r.refused })}` : text, r?.refused ? () => showOutbox() : null);
}

async function sendOutbox() {
  if (!st.copy || st.flushing) return null;
  st.flushing = true;
  try {
    if (!(await st.copy.outbox()).length) return { sent: 0, refused: 0 };
    return await flushOutbox(st.copy, { post: postJson, get: (path) => fetch(path, { cache: 'no-store' }), onSent: () => st.onBack() });
  } catch {
    return null;
  } finally {
    st.flushing = false;
  }
}

function showOutbox() {
  st.view ??= mountOfflineView({ copy: st.copy, words: offlineWords(st.t), kid: Boolean(st.session?.member?.child), onRetry: () => st.watch?.checkNow() });
  void st.view.show(st.current());
  // Online: Try again sends what is left and closes the view.
  setTimeout(() => {
    const b = st.view?.el.querySelector('.offv-retry');
    if (b) b.onclick = () => void backOnline();
  }, 0);
}

function popNote(text, onShow) {
  st.pop?.remove();
  const p = document.createElement('div');
  p.className = 'offv-note-pop';
  p.id = 'offline-back-note';
  p.setAttribute('role', 'status');
  p.textContent = text;
  if (onShow) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'offv-small';
    b.textContent = st.t('Show');
    b.addEventListener('click', () => {
      p.remove();
      onShow();
    });
    p.append(b);
  }
  document.body.append(p);
  st.pop = p;
  setTimeout(() => p.remove(), onShow ? 20_000 : 9000);
}
