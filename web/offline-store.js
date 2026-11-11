// Feature 4 (works offline): this device's copy of the recent chats and notes, and its outbox.
//
// - Kept in the browser's IndexedDB for this server's address, encrypted with a key the browser
//   makes and never lets out (WebCrypto AES-GCM, non-extractable): the files on disk hold no
//   readable text, and signing out deletes both the copy and the key.
// - One person per device: when another person (or another server at the same address) signs in
//   here, the earlier copy is deleted first, so household members never see each other's chats.
// - Off-the-record chats are never kept; private chats only when "Also keep private chats" is on.
// - At most 30 chats (the newest), the last 200 messages of each, and 200 notes.
//
// No DOM here: the storage is passed in (IndexedDB in the page, a Map in the tests).

export const LIMITS = { chats: 30, messages: 200, notes: 200, text: 20_000 };
const STORES = ['copy', 'outbox'];

/** A storage in memory (tests, and browsers without IndexedDB: nothing survives a reload). */
export function memoryKV() {
  const s = new Map(STORES.map((n) => [n, new Map()]));
  return {
    async get(store, key) {
      return s.get(store).get(key);
    },
    async put(store, key, value) {
      s.get(store).set(key, value);
    },
    async del(store, key) {
      s.get(store).delete(key);
    },
    async all(store) {
      return [...s.get(store).entries()];
    },
    async clear() {
      for (const m of s.values()) m.clear();
    },
    async drop() {
      for (const m of s.values()) m.clear();
    },
  };
}

/** IndexedDB, one database per page origin (so per server address). */
export function idbKV(name = 'sara-offline') {
  let opening;
  const db = () =>
    (opening ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => {
        for (const n of STORES) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  const run = async (store, mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    put: (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key)),
    del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
    async all(store) {
      const d = await db();
      return new Promise((resolve, reject) => {
        const out = [];
        const req = d.transaction(store, 'readonly').objectStore(store).openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve(out);
          out.push([c.key, c.value]);
          c.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },
    async clear() {
      for (const n of STORES) await run(n, 'readwrite', (s) => s.clear());
    },
    /** Signing out: the whole database goes (the key with it). */
    async drop() {
      const d = await db().catch(() => null);
      d?.close();
      opening = undefined;
      await new Promise((resolve) => {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = r.onblocked = () => resolve();
      });
    },
  };
}

/** Whether a chat may be kept on this device. */
export function keepable(conv, { allowPrivate = false } = {}) {
  if (!conv?.id || conv.offRecord) return false;
  if (conv.private && !allowPrivate) return false;
  // Imported histories and her own worker chats aren't what you'd read offline.
  if (/^import-/.test(String(conv.channel ?? ''))) return false;
  return true;
}

/** The parts of a message worth reading offline (her words and yours, no tool output). */
export function slimMessages(messages) {
  return (messages ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() && !m.meta?.hidden)
    .slice(-LIMITS.messages)
    .map((m) => ({ id: m.id, role: m.role, content: m.content.slice(0, LIMITS.text), createdAt: m.createdAt, ...(m.meta?.clientKey ? { clientKey: m.meta.clientKey } : {}) }));
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Opens this device's copy. `kv` is the storage; `crypto` WebCrypto (globalThis.crypto by default).
 * Every value is sealed with the copy's own key; a value that can't be opened counts as missing.
 */
export async function openOfflineCopy(kv, { crypto = globalThis.crypto, now = () => new Date() } = {}) {
  let key = await kv.get('copy', 'key');
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await kv.put('copy', 'key', key);
  }
  const seal = async (value) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
    return { iv, data };
  };
  const open = async (box) => {
    if (!box?.iv || !box?.data) return undefined;
    try {
      return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.data)));
    } catch {
      return undefined;
    }
  };
  const read = async (store, k) => open(await kv.get(store, k));
  const write = async (store, k, v) => kv.put(store, k, await seal(v));
  let lastOrder = 0;
  const stamp = async () => write('copy', 'asOf', now().toISOString());

  const copy = {
    /** Who this copy belongs to: { serverId, space } (undefined before the first sign-in here). */
    owner: () => read('copy', 'owner'),
    /**
     * The page knows who signed in: another person or another server than the copy's owner
     * deletes the copy (and its outbox) first. Returns true when something was deleted.
     */
    async signedIn({ serverId, space }) {
      const who = await copy.owner();
      const same = who && who.serverId === serverId && who.space === space;
      if (who && !same) await copy.wipe({ keepKey: true });
      if (!same) await write('copy', 'owner', { serverId, space });
      return Boolean(who && !same);
    },
    /** Deletes everything kept here (signing out deletes the key too: use drop()). */
    async wipe({ keepKey = false } = {}) {
      await kv.clear();
      if (keepKey) await kv.put('copy', 'key', key);
    },
    async asOf() {
      return (await read('copy', 'asOf')) ?? null;
    },
    /** The chat list: the newest keepable chats, at most 30. Chats no longer listed are dropped. */
    async saveList(convs, opts = {}) {
      const list = (convs ?? [])
        .filter((c) => keepable(c, opts) && !c.archivedAt)
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
        .slice(0, LIMITS.chats)
        .map((c) => ({ id: c.id, title: String(c.title ?? ''), updatedAt: c.updatedAt ?? null, ...(c.private ? { private: true } : {}) }));
      const old = (await read('copy', 'list')) ?? [];
      const keep = new Set(list.map((c) => c.id));
      for (const c of old) if (!keep.has(c.id)) await kv.del('copy', `chat:${c.id}`);
      // A private chat kept earlier goes when private chats may no longer be kept.
      if (!opts.allowPrivate) for (const [k] of await kv.all('copy')) if (String(k).startsWith('chat:') && !keep.has(String(k).slice(5))) await kv.del('copy', k);
      await write('copy', 'list', list);
      await stamp();
      return list;
    },
    async list() {
      return (await read('copy', 'list')) ?? [];
    },
    /** One chat's newest messages, as loaded. A chat that may not be kept is deleted instead. */
    async saveChat(conv, messages, opts = {}) {
      if (!keepable(conv, opts)) return void (conv?.id && (await kv.del('copy', `chat:${conv.id}`)));
      const list = await copy.list();
      if (!list.some((c) => c.id === conv.id)) {
        list.unshift({ id: conv.id, title: String(conv.title ?? ''), updatedAt: conv.updatedAt ?? null, ...(conv.private ? { private: true } : {}) });
        for (const gone of list.splice(LIMITS.chats)) await kv.del('copy', `chat:${gone.id}`);
        await write('copy', 'list', list);
      }
      const prev = (await read('copy', `chat:${conv.id}`))?.messages ?? [];
      // Messages loaded now replace the kept ones in their range (a regenerated reply is gone);
      // the newest page (the default) also ends the chat; an earlier page (scrolled up) adds to it.
      const fresh = slimMessages(messages);
      const ids = (messages ?? []).map((m) => Number(m.id)).filter(Number.isFinite);
      const lo = ids.length ? Math.min(...ids) : Infinity;
      const hi = opts.latest === false ? (ids.length ? Math.max(...ids) : -Infinity) : Infinity;
      const merged = [...prev.filter((m) => m.id < lo || m.id > hi), ...fresh].sort((a, b) => a.id - b.id).slice(-LIMITS.messages);
      await write('copy', `chat:${conv.id}`, { id: conv.id, title: String(conv.title ?? ''), updatedAt: conv.updatedAt ?? null, messages: merged, savedAt: now().toISOString() });
      await stamp();
    },
    chat: (id) => read('copy', `chat:${id}`),
    async saveNotes(notes) {
      const list = (notes ?? []).slice(0, LIMITS.notes).map((n) => ({ id: n.id, title: String(n.title ?? ''), body: String(n.body ?? '').slice(0, 50_000), updatedAt: n.updatedAt ?? null }));
      await write('copy', 'notes', list);
      await stamp();
    },
    async notes() {
      return (await read('copy', 'notes')) ?? [];
    },
    /** The page's words in this person's language (the offline page has no translations of its own). */
    saveWords: (words) => write('copy', 'words', words),
    async words() {
      return (await read('copy', 'words')) ?? {};
    },

    // ---------- the outbox ----------
    /**
     * Something written offline: { kind: 'chat', conversationId, text } or
     * { kind: 'note', noteId?, title, text }. Each item gets its own key (sent with it every time).
     */
    async queue(item) {
      const text = String(item.text ?? '').trim();
      if (!text) throw new Error('empty');
      const at = now();
      // Written in this order (two in the same millisecond too): the outbox sends them so.
      lastOrder = Math.max(at.getTime(), lastOrder + 1, ...(await copy.outbox()).map((x) => (x.order ?? 0) + 1));
      const id = `ob-${lastOrder}-${[...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      const entry = { ...item, text, id, key: id, order: lastOrder, writtenAt: at.toISOString(), state: 'waiting' };
      await write('outbox', id, entry);
      return entry;
    },
    async outbox() {
      const out = [];
      for (const [, box] of await kv.all('outbox')) {
        const v = await open(box);
        if (v) out.push(v);
      }
      return out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    /**
     * Edit a waiting item: it gets a fresh key (nothing of it reached the server yet). An item whose
     * send was cut off on the way may already be there, so it can't be edited (only deleted).
     */
    async edit(id, text) {
      const cur = await read('outbox', id);
      if (!cur || cur.tried) return null;
      const t = String(text ?? '').trim();
      if (!t) return null;
      const next = { ...cur, text: t, key: `${id}-e${now().getTime().toString(36)}`, state: 'waiting', error: undefined };
      await write('outbox', id, next);
      return next;
    },
    async mark(id, patch) {
      const cur = await read('outbox', id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      await write('outbox', id, next);
      return next;
    },
    remove: (id) => kv.del('outbox', id),
  };
  return copy;
}
