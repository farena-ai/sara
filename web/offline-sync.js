// Feature 4 (works offline): noticing the connection is gone or back, and sending the outbox.
// No DOM here (web/offline-view.js draws); fetch and timers are passed in so the tests run in Node.

/**
 * Whether this device keeps a copy when nobody chose: yes in Sara's own apps (the Windows and Mac
 * app, the phone app) and an installed web app, which are one person's device; no in a plain
 * browser tab, which may be a shared or borrowed computer.
 */
export function keepByDefault({ ua = '', standalone = false } = {}) {
  return /\bSara(Desktop|Phone)\//.test(String(ua)) || Boolean(standalone);
}

/** This device's choice ('1'/'0' in localStorage), else the default above. */
export function keepChoice(storage, env) {
  let v = null;
  try {
    v = storage?.getItem('sara.offline.keep');
  } catch {
    /* private mode */
  }
  return v === '1' ? true : v === '0' ? false : keepByDefault(env);
}
export function privateChoice(storage) {
  try {
    return storage?.getItem('sara.offline.private') === '1';
  } catch {
    return false;
  }
}

/**
 * Sends the outbox in the order it was written. Each item goes with its own key, so one that
 * reached the server before (the answer was lost) is not stored again. Stops at the first item
 * that can't be sent yet (no connection, she's busy in that chat) so the order is kept; an item
 * the server refuses stays in the outbox with the reason (its text is never thrown away).
 *
 * `post(path, body)` → a fetch Response (or throws when there is no connection).
 * Returns { sent, notes (of sent), waiting, refused, stopped }.
 */
export async function flushOutbox(copy, { post, onSent = () => {} } = {}) {
  const out = { sent: 0, notes: 0, refused: 0, waiting: 0, stopped: false };
  const items = await copy.outbox();
  for (const [i, item] of items.entries()) {
    if (item.state === 'refused') {
      out.refused++;
      continue;
    }
    await copy.mark(item.id, { tried: true, state: 'sending' });
    let res;
    try {
      res =
        item.kind === 'note'
          ? await post('/api/notes/add', { ...(item.noteId ? { id: item.noteId } : {}), title: item.title ?? '', text: item.text, clientKey: item.key, writtenAt: item.writtenAt })
          : await post(`/api/conversations/${encodeURIComponent(item.conversationId)}/messages`, { content: item.text, clientKey: item.key });
    } catch {
      // No answer at all: it may or may not have arrived; the key decides on the next try.
      await copy.mark(item.id, { state: 'waiting' });
      out.stopped = true;
      out.waiting = items.length - i;
      break;
    }
    if (res.ok) {
      // Sent (or it was already there). A chat reply streams: wait for her to finish before the
      // next message, or that one would find her busy.
      await copy.remove(item.id);
      out.sent++;
      if (item.kind === 'note') out.notes++;
      onSent(item);
      try {
        await res.text();
      } catch {
        /* the connection dropped while she answered: the message itself is stored */
      }
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 || res.status === 429 || res.status >= 500) {
      // Busy, or the server is still starting: later, in order. It wasn't stored.
      await copy.mark(item.id, { state: 'waiting', tried: false });
      out.stopped = true;
      out.waiting = items.length - i;
      break;
    }
    if (res.status === 401) {
      await copy.mark(item.id, { state: 'waiting', tried: false });
      out.stopped = true;
      out.waiting = items.length - i;
      break;
    }
    await copy.mark(item.id, { state: 'refused', tried: false, error: String(data.error ?? `HTTP ${res.status}`) });
    out.refused++;
  }
  return out;
}

/**
 * Watches the connection: the browser's online/offline events, a failed request the page reports
 * (`hint()`), and a regular /api/health check (every 30 s; every 5 s while offline). Two failed
 * checks in a row mean offline; one good one means back.
 */
export function watchConnection({ check, onChange, every = 30_000, offlineEvery = 5_000, startOnline = true, win = globalThis, timers = globalThis }) {
  let online = startOnline;
  let misses = 0;
  let timer;
  let running = false;
  let stopped = false;
  const plan = (ms) => {
    timers.clearTimeout(timer);
    if (!stopped) timer = timers.setTimeout(run, ms);
  };
  async function run() {
    if (running || stopped) return;
    running = true;
    let ok = false;
    try {
      ok = await check();
    } catch {
      ok = false;
    }
    running = false;
    if (ok) {
      misses = 0;
      if (!online) {
        online = true;
        onChange(true);
      }
    } else if (++misses >= 2 && online) {
      online = false;
      onChange(false);
    }
    plan(!online || misses ? offlineEvery : every);
  }
  const onOnline = () => plan(0);
  const onOffline = () => {
    misses = Math.max(misses, 1);
    plan(0);
  };
  win.addEventListener?.('online', onOnline);
  win.addEventListener?.('offline', onOffline);
  plan(online ? every : offlineEvery);
  return {
    get online() {
      return online;
    },
    /** A request just failed: check now (twice, quickly) instead of waiting. */
    hint() {
      if (online) plan(0);
    },
    checkNow: () => run(),
    stop() {
      stopped = true;
      timers.clearTimeout(timer);
      win.removeEventListener?.('online', onOnline);
      win.removeEventListener?.('offline', onOffline);
    },
  };
}

/** "10:42" today, "Nov 10, 10:42" before (in the page's language). */
export function asOfText(iso, { now = new Date(), locale } = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
