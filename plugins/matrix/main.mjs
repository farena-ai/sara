// The Matrix plugin (comes with Sara; docs/design/BRIDGES4.md §6, docs/MATRIX.md). Her own Matrix
// account (a bot account he made, e.g. @sara-frank:matrix.org) talks with him in an UNENCRYPTED room
// from Element or any Matrix app. Messages come in through the client-server /sync long-poll and go
// out as PUT /send calls, over sockets Sara holds for it (permissions.connect; the plugin never opens
// one itself). Sara decides who the owner is (linking with a code), what anyone may do and every
// turn. Encrypted rooms can't be read (no Olm/Megolm: §6.5); she says so once and leaves or stays
// silent. Her password is never kept: Sara passes it once for *Log her in* and forgets it.
import { createHash } from 'node:crypto';
import { plugin } from './sara-plugin.mjs';
import { Client, MatrixError, serverOf, baseHost } from './cs.mjs';
import { readSync, kindOf, chatOf, roomOf, FILTER, FIRST_FILTER } from './sync.mjs';
import { toMatrix, split } from './html.mjs';
import { codeOf, diagnose } from './diagnose.mjs';
import { pacing } from './pace.mjs';
const { Pacer, CapError, Typing } = pacing('matrix');

const BRIDGE = 'matrix';
const TEXT_MAX = 16_000;
const OWNER_FILE_MAX = 20 * 1024 * 1024;
const MAX_ROOMS = 50;
const SEEN_MAX = 2_000;
const STOP_KEYS = ['⏹', '⏹️', '❌', '🛑'];
export const ENCRYPTED_LINE = "I can't read encrypted rooms yet. To talk with me, make a room with encryption off (it can't be switched off later).";
const STOP_HINT = 'React ⏹ to stop';

let sara;
let cs;
let me = '';
let running = false;
let backoff = 0;
let lastSyncAt = 0;
let authMedia = true;
let uploadMax = 0;
let tokenGone = false;
const pacer = new Pacer();
const typing = new Typing((room, on) => cs.typing(room, me, on).catch(() => undefined));
const rooms = new Map();
const seen = new Set();
const mine = new Set();
const refs = new Map();
const refOf = new Map();
const outFiles = new Map();
const lastIn = new Map();
let txnSeq = 0;
let capNoticeDay = '';

const s = () => sara.settings;
const txn = () => `sara${Date.now().toString(36)}${(++txnSeq).toString(36)}`;
const local = (id) => String(id ?? '').replace(/^@/, '').split(':')[0] || 'someone';

// ------------------------------------------------------------------ rooms she is in

function roomInfo(roomId) {
  let r = rooms.get(roomId);
  if (!r) rooms.set(roomId, (r = { name: '', encrypted: false, members: new Set(), told: false }));
  return r;
}
async function saveRooms() {
  const list = [...rooms.entries()].slice(0, 200).map(([id, r]) => ({ id, name: r.name, encrypted: r.encrypted, members: [...r.members].slice(0, 50), told: r.told }));
  await sara.kv.set('rooms', list).catch(() => {});
}
async function loadRooms() {
  const list = (await sara.kv.get('rooms').catch(() => null)) ?? [];
  for (const x of Array.isArray(list) ? list : []) rooms.set(x.id, { name: x.name ?? '', encrypted: x.encrypted === true, members: new Set(x.members ?? []), told: x.told === true });
}
const isDm = (r) => r.members.size <= 2;

// ------------------------------------------------------------------ the sync loop (§6.3)

async function start() {
  if (!cs.host) return sara.status('error', diagnose('NOT_SET').title);
  if (!cs.token) return sara.status('error', diagnose('NOT_SET').title);
  try {
    const w = await cs.whoami();
    me = String(w.user_id ?? '');
    const want = String(s().mxid ?? '').trim();
    if (want && me.toLowerCase() !== want.toLowerCase()) sara.log(`the token belongs to ${me}, not ${want}`, 'warn');
  } catch (err) {
    return fail(err);
  }
  const v = await cs.versions().catch(() => ({ versions: [] }));
  authMedia = (v.versions ?? []).some((x) => /^v1\.(1[1-9]|[2-9]\d)/.test(String(x)));
  const mc = await cs.mediaConfig(authMedia).catch(() => ({}));
  uploadMax = Number(mc['m.upload.size']) || 0;
  await sara.kv.set('mediaMax', uploadMax).catch(() => {});
  await loadRooms();
  running = true;
  sara.status('connecting', me);
  void loop();
}

function fail(err) {
  const code = codeOf(err);
  if (code === 'TOKEN_GONE') return gone();
  if (code === 'PRIVATE_LOCAL') return sara.status('paused', diagnose('PRIVATE_LOCAL').title);
  sara.status('error', diagnose(code, err?.message).title);
}

/** `M_UNKNOWN_TOKEN`: her login ended. The sync stops and he is told once (§7.4 TOKEN_GONE). */
function gone() {
  running = false;
  tokenGone = true;
  sara.status('error', diagnose('TOKEN_GONE').title);
  void (async () => {
    if ((await sara.kv.get('tokenGoneTold').catch(() => null)) === cs.token.slice(-6)) return;
    await sara.kv.set('tokenGoneTold', cs.token.slice(-6)).catch(() => {});
    await sara.notify('Matrix: her login ended (someone logged that session out). Log her in again in Settings → Matrix.').catch(() => {});
  })();
}

async function filterId(first) {
  const key = first ? 'filterFirst' : 'filter';
  const hash = createHash('sha256').update(JSON.stringify(first ? FIRST_FILTER : FILTER)).digest('hex').slice(0, 12);
  const have = await sara.kv.get(key).catch(() => null);
  if (have?.hash === hash && have.me === me) return have.id;
  const r = await cs.filter(me, first ? FIRST_FILTER : FILTER);
  await sara.kv.set(key, { id: String(r.filter_id), hash, me }).catch(() => {});
  return String(r.filter_id);
}

async function loop() {
  while (running) {
    const since = await sara.kv.get('nextBatch').catch(() => null);
    try {
      const first = !since;
      const res = await cs.sync(since ?? undefined, await filterId(first), first ? 0 : undefined);
      lastSyncAt = Date.now();
      backoff = 0;
      sara.status('ok', me);
      const r = readSync(res, me);
      await handle(r, first);
      if (r.nextBatch) await sara.kv.set('nextBatch', r.nextBatch);
    } catch (err) {
      if (!running) return;
      const code = codeOf(err);
      if (code === 'TOKEN_GONE') return gone();
      if (code === 'PRIVATE_LOCAL') sara.status('paused', diagnose('PRIVATE_LOCAL').title);
      else if (code !== 'RATE_LIMITED') sara.status('error', diagnose(code, err?.message).title);
      backoff = Math.min(60_000, err?.retryMs ?? (backoff ? backoff * 2 : 1_000));
      await new Promise((r) => setTimeout(r, backoff).unref?.());
    }
  }
}

async function handle(r, first) {
  for (const inv of r.invites) await onInvite(inv).catch((err) => sara.log(`an invite failed: ${err?.message ?? err}`, 'warn'));
  // Rooms she left go, except encrypted ones: the card keeps them under *Rooms she can't read*.
  for (const id of r.left) if (!rooms.get(id)?.encrypted) rooms.delete(id);
  for (const room of r.rooms) {
    const info = roomInfo(room.roomId);
    if (room.state.name) info.name = room.state.name;
    for (const m of room.state.joined) info.members.add(m);
    for (const m of room.state.left) info.members.delete(m);
    const wasEncrypted = info.encrypted;
    if (room.state.encrypted) info.encrypted = true;
    if (first) continue;
    if (info.encrypted && !wasEncrypted) await encrypted(room.roomId, false);
    // Turns run after (Sara answers bridge.inbound only when the turn ends): the loop never waits for one.
    for (const e of room.events) {
      const p = onEvent(room.roomId, info, e);
      void Promise.resolve(p).catch((err) => sara.log(`an event failed: ${err?.message ?? err}`, 'warn'));
      await new Promise((r) => setImmediate(r));
    }
  }
  await saveRooms();
}

// ------------------------------------------------------------------ invites and encrypted rooms (§6.3, §6.5)

async function onInvite(inv) {
  const chatId = chatOf(inv.roomId);
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId, fromId: inv.inviter.toLowerCase(), invite: true, text: '' }).catch(() => ({ who: 'none' }))).who;
  const ok = who === 'owner' || who === 'setup' || who === 'partner';
  const joined = [...rooms.values()].length;
  if (!ok || joined >= MAX_ROOMS) {
    if (ok) sara.log(`an invite was declined: she is in ${MAX_ROOMS} rooms already`, 'warn');
    await cs.leave(inv.roomId).catch(() => undefined);
    return;
  }
  await cs.join(inv.roomId);
  const info = roomInfo(inv.roomId);
  info.name = inv.name || info.name;
  info.members.add(me);
  if (inv.inviter) info.members.add(inv.inviter);
  if (inv.encrypted) {
    info.encrypted = true;
    await encrypted(inv.roomId, true);
    return;
  }
  await sara.kv.set('lastJoin', { room: inv.roomId, name: info.name, at: new Date().toISOString() }).catch(() => {});
  sara.log(`joined a room (${who === 'partner' ? 'a partner' : 'him'})`);
}

/** Once per room, in plain text; then she leaves (just joined) or stays silent (encryption turned on later). */
async function encrypted(roomId, leave) {
  const info = roomInfo(roomId);
  info.encrypted = true;
  sara.skip('encrypted', chatOf(roomId));
  if (!info.told) {
    info.told = true;
    await post(roomId, { msgtype: 'm.notice', body: ENCRYPTED_LINE }).catch(() => undefined);
  }
  await saveRooms();
  if (leave) await cs.leave(roomId).catch(() => undefined);
}

// ------------------------------------------------------------------ messages in

async function onEvent(roomId, info, e) {
  const id = String(e.event_id);
  if (seen.has(id)) return;
  seen.add(id);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  const sender = String(e.sender ?? '');
  // Her own events never start a turn (the loop guard).
  if (sender === me) {
    mine.add(id);
    return;
  }
  const k = kindOf(e);
  if (k.kind === 'other') return;
  if (k.kind === 'encrypted' || info.encrypted) {
    if (!info.told) await encrypted(roomId, false);
    else sara.skip('encrypted', chatOf(roomId));
    return;
  }
  const chatId = chatOf(roomId);
  const dm = isDm(info);
  const fromId = sender.toLowerCase();
  const base = { bridge: BRIDGE, chatId, fromId, from: local(sender), messageId: id, chat: dm ? { kind: 'dm' } : { kind: 'group', title: info.name || 'Matrix room', members: [...info.members].map((x) => x.toLowerCase()) }, ...(k.at ? { at: new Date(Math.min(k.at, Date.now())).toISOString() } : {}) };
  if (k.kind === 'redaction') {
    if (!dm) sara.bridgeLog({ bridge: BRIDGE, chatId, messageId: k.target, deleted: true });
    return;
  }
  if (k.kind === 'edit') {
    if (!dm) sara.bridgeLog({ bridge: BRIDGE, chatId, messageId: k.target, edited: true, text: k.text, fromId });
    return;
  }
  if (k.kind === 'reaction') {
    // His ⏹ (or ❌) on her progress message = /stop for that turn (Sara checks it is him).
    const ref = refOf.get(k.target);
    if (ref && STOP_KEYS.includes(k.key)) return void (await sara.bridgeInbound({ ...base, text: '', action: 'stop', ref }));
    return;
  }
  lastIn.set(chatId, id);
  const text = k.kind === 'media' ? k.caption : String(k.text ?? '');
  const herName = String(sara.herName || 'Sara');
  const addressed = k.mentions.includes(me) || new RegExp(`^@?${herName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text.trim());
  const replyToHer = Boolean(k.replyTo && mine.has(k.replyTo));
  if (!dm) sara.bridgeLog({ bridge: BRIDGE, chatId, messageId: id, fromId, from: local(sender), text: text || (k.kind === 'media' ? `[${k.media}]` : ''), ...(k.replyTo ? { replyTo: k.replyTo } : {}), ...(base.at ? { at: base.at } : {}) });
  const more = { addressed, replyToHer, ...(k.replyTo ? { replyTo: k.replyTo } : {}) };
  if (dm) void receipt(roomId, chatId, fromId, id);
  if (k.kind === 'media') return onMedia(roomId, k, { ...base, ...more });
  if (k.kind === 'mark') return sara.bridgeInbound({ ...base, ...more, text: k.text });
  if (!text.trim()) return;
  return sara.bridgeInbound({ ...base, ...more, text });
}

/** A read receipt on his message in his room (*Send read receipts*, §6.7); never for anyone else. */
async function receipt(roomId, chatId, fromId, eventId) {
  if (s().readReceipts === false) return;
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId, fromId, quiet: true }).catch(() => ({ who: 'none' }))).who;
  if (who === 'owner') await cs.receipt(roomId, eventId).catch(() => undefined);
}

async function onMedia(roomId, k, base) {
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId: base.chatId, fromId: base.fromId }).catch(() => ({ who: 'none' }))).who;
  const mark = k.media === 'image' ? '[photo]' : k.media === 'audio' ? '[voice message]' : '[file]';
  // Strangers' files are never downloaded; partners' only pictures (BR1).
  if (who !== 'owner' && who !== 'partner') return sara.bridgeInbound({ ...base, text: k.caption || mark });
  if (who === 'partner' && k.media !== 'image') return sara.bridgeInbound({ ...base, text: k.caption || mark });
  if (k.encryptedFile || !k.server || !k.mediaId) return sara.bridgeInbound({ ...base, text: k.caption || mark });
  if (k.size > OWNER_FILE_MAX) {
    sara.failed({ bridge: BRIDGE, chatId: base.chatId, code: 'MEDIA_TOO_BIG', title: diagnose('MEDIA_TOO_BIG').title, reply: false });
    return sara.bridgeInbound({ ...base, text: k.caption || mark });
  }
  try {
    const r = await cs.download(k.server, k.mediaId, authMedia);
    const name = k.voice ? 'voice.ogg' : k.name;
    return sara.sendFile({ ...base, text: k.caption, files: [{ name, mime: k.mime || r.type, data: r.bytes }], ...(k.voice ? { voice: true } : {}) });
  } catch (err) {
    sara.log(`a ${k.media} couldn't be downloaded: ${err?.message ?? err}`, 'warn');
    if (codeOf(err) === 'TOKEN_GONE') gone();
    return sara.bridgeInbound({ ...base, text: k.caption || mark });
  }
}

// ------------------------------------------------------------------ sending (§6.7–§6.10)

const retryMs = (err) => (err instanceof MatrixError && err.status === 429 ? err.retryMs : undefined);

async function post(roomId, content, type = 'm.room.message') {
  const r = await pacer.send(roomId, () => cs.send(roomId, type, txn(), content), retryMs);
  const id = String(r?.event_id ?? '');
  if (id) mine.add(id);
  return id;
}

function refused(chatId, err, started) {
  if (err instanceof CapError) {
    const day = new Date().toISOString().slice(0, 10);
    if (capNoticeDay !== day) {
      capNoticeDay = day;
      void sara.notify(`Matrix: she reached the ${err.cap} cap of messages, so the rest stays in the app.`).catch(() => {});
    }
    return;
  }
  const code = codeOf(err);
  sara.log(`a send was refused: ${err?.message ?? err}`, 'warn');
  if (code === 'TOKEN_GONE') gone();
  sara.failed({ bridge: BRIDGE, chatId, code, title: diagnose(code).title, reply: !started });
}

function content(text, o = {}) {
  const c = { msgtype: 'm.text', ...toMatrix(text) };
  if (o.replyTo || o.thread) {
    const rel = {};
    if (o.thread) Object.assign(rel, { rel_type: 'm.thread', event_id: o.thread, is_falling_back: !o.replyTo });
    if (o.replyTo) rel['m.in_reply_to'] = { event_id: o.replyTo };
    c['m.relates_to'] = rel;
  }
  return c;
}

const progressText = (text) => (/^✅/.test(String(text).trim()) ? String(text) : `${text}\n\n${STOP_HINT}`);

async function onSend(m) {
  const chatId = String(m.chatId);
  const roomId = roomOf(chatId);
  const started = m.started === true;
  try {
    if (m.files?.length) {
      outFiles.set(m.files.map((f) => f.fileId).join(','), { roomId, chatId, text: m.text ?? '', files: m.files.map((f) => ({ ...f, parts: [], done: false })), started });
      return;
    }
    const text = String(m.text ?? '');
    if (!text.trim()) return;
    if (roomInfo(roomId).encrypted && !roomInfo(roomId).told) return;
    const thread = typeof m.thread === 'object' && m.thread ? String(m.thread.id ?? '') : typeof m.thread === 'string' ? m.thread : '';
    let first = '';
    const parts = m.ref ? [progressText(text)] : split(text, TEXT_MAX);
    for (const [i, p] of parts.entries()) {
      const id = await post(roomId, content(p, i === 0 ? { replyTo: m.replyTo, thread } : { thread }));
      if (i === 0) first = id;
    }
    if (m.ref && first) {
      refs.set(m.ref, first);
      refOf.set(first, m.ref);
      if (refs.size > 200) {
        const [oldRef, oldId] = refs.entries().next().value;
        refs.delete(oldRef);
        refOf.delete(oldId);
      }
    }
    if (!m.ref) typing.off(roomId);
    if (first) sara.bridgeSent({ bridge: BRIDGE, ...(m.ref ? { ref: m.ref } : {}), messageId: first });
  } catch (err) {
    refused(chatId, err, started);
  }
}

/** The progress message (§6.8): `m.replace` with `m.new_content` and a `* ` fallback body. */
async function onEdit(m) {
  const roomId = roomOf(String(m.chatId));
  const target = refs.get(m.ref);
  if (!target) return;
  const next = toMatrix(progressText(m.text));
  const c = { msgtype: 'm.text', body: `* ${next.body}`, ...(next.formatted_body ? { format: next.format, formatted_body: `* ${next.formatted_body}` } : {}), 'm.new_content': { msgtype: 'm.text', ...next }, 'm.relates_to': { rel_type: 'm.replace', event_id: target } };
  await post(roomId, c).catch((err) => sara.log(`an edit failed: ${err?.message ?? err}`, 'warn'));
}

/** Her pictures and files: an upload each (within m.upload.size), then m.image (with info) or m.file. */
async function onFile(m) {
  for (const [key, out] of outFiles) {
    const f = out.files.find((x) => x.fileId === m.fileId);
    if (!f) continue;
    f.parts.push(Buffer.from(String(m.data ?? ''), 'base64'));
    if (m.last) f.done = true;
    if (!out.files.every((x) => x.done)) return;
    outFiles.delete(key);
    try {
      if (out.text) await post(out.roomId, content(out.text));
      for (const x of out.files) {
        const data = Buffer.concat(x.parts);
        if (uploadMax && data.length > uploadMax) {
          sara.failed({ bridge: BRIDGE, chatId: out.chatId, code: 'MEDIA_TOO_BIG', title: diagnose('MEDIA_TOO_BIG', '', { mb: Math.floor(uploadMax / 1048576) }).title, reply: !out.started });
          continue;
        }
        const up = await cs.upload(data, x.mime || 'application/octet-stream', x.name);
        const image = /^image\/(jpeg|png|gif|webp)$/.test(x.mime ?? '');
        const size = image ? imageSize(data) : undefined;
        await post(out.roomId, { msgtype: image ? 'm.image' : 'm.file', body: String(x.name ?? 'file').slice(0, 120), url: String(up.content_uri), info: { mimetype: x.mime || 'application/octet-stream', size: data.length, ...(size ? { w: size.w, h: size.h } : {}) } });
      }
      typing.off(out.roomId);
    } catch (err) {
      refused(out.chatId, err, out.started);
    }
    return;
  }
}

/** Width and height from a PNG, GIF or JPEG header (Sara's own header reading, no decoder). */
export function imageSize(b) {
  if (b.length > 24 && b.subarray(1, 4).toString('latin1') === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 10 && b.subarray(0, 3).toString('latin1') === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return undefined;
}

async function onTyping(m) {
  const chatId = String(m.chatId);
  const roomId = roomOf(chatId);
  if (!m.on) return typing.off(roomId);
  if (s().typing === false || !isDm(roomInfo(roomId))) return;
  // Only in his own room (off for partners and rooms, §14 Q19).
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId, quiet: true }).catch(() => ({ who: 'none' }))).who;
  if (who === 'owner') typing.on(roomId);
}

async function onReact(m) {
  const roomId = roomOf(String(m.chatId));
  await post(roomId, { 'm.relates_to': { rel_type: 'm.annotation', event_id: String(m.messageId), key: String(m.emoji ?? '👀') } }, 'm.reaction').catch(() => undefined);
}

async function onLeave(m) {
  const roomId = roomOf(String(m.chatId));
  await cs.leave(roomId).catch(() => undefined);
  rooms.delete(roomId);
  await saveRooms();
}

// ------------------------------------------------------------------ the setup card's checks (§7.3–§7.5)

async function onCheck(m) {
  const step = String(m.step ?? '');
  const fail = (code, detail, params) => ({ ok: false, diagnosis: diagnose(code, detail, params) });
  const g = (err) => fail(codeOf(err), err?.message);
  try {
    if (step === 'discover') {
      // Her server from her Matrix ID: .well-known first, then /versions on the server itself.
      const server = serverOf(m.mxid ?? s().mxid);
      if (!server) return fail('HS_NOT_FOUND', 'not a Matrix ID');
      const wk = await cs.wellKnown().catch(() => undefined);
      const base = baseHost(wk?.['m.homeserver']?.base_url);
      if (base && base.toLowerCase() !== cs.host.toLowerCase()) return { ok: true, homeserver: base, moved: true };
      const v = await cs.versions().catch((err) => ({ error: err }));
      if (v.error || !Array.isArray(v.versions)) return fail('HS_NOT_FOUND', v.error?.message ?? 'no /versions', { server });
      return { ok: true, homeserver: cs.host, versions: v.versions.slice(-3) };
    }
    if (step === 'login') {
      // The password arrives once, is sent once to /login and is forgotten (never kept or logged).
      const mxid = String(m.mxid ?? '').trim();
      const password = String(m.password ?? '');
      if (!serverOf(mxid) || !password) return fail('LOGIN_WRONG');
      const flows = await cs.loginFlows().catch((err) => ({ error: err }));
      if (flows.error) return g(flows.error);
      if (!(flows.flows ?? []).some((f) => f?.type === 'm.login.password')) return fail('NO_PASSWORD_LOGIN');
      let r;
      try {
        r = await cs.login(mxid, password);
      } catch (err) {
        return err instanceof MatrixError && (err.errcode === 'M_FORBIDDEN' || err.status === 403) ? fail('LOGIN_WRONG') : g(err);
      }
      return { ok: true, token: String(r.access_token ?? ''), deviceId: String(r.device_id ?? ''), userId: String(r.user_id ?? mxid) };
    }
    if (step === 'whoami') {
      if (!cs.token) return fail('NOT_SET');
      const w = await cs.whoami();
      me = String(w.user_id ?? me);
      await cs.setName(me, `${sara.herName || 'Sara'} (AI)`).catch(() => undefined);
      return { ok: true, userId: me, deviceId: String(w.device_id ?? '') };
    }
    if (step === 'rooms') {
      const list = [...rooms.entries()].map(([id, r]) => ({ id: chatOf(id), name: r.name || 'Matrix room', encrypted: r.encrypted, members: r.members.size, place: r.encrypted ? 'encrypted' : isDm(r) ? 'dm' : 'room' }));
      return { ok: true, me, rooms: list, syncing: running && Date.now() - lastSyncAt < 60_000, tokenGone, mediaMax: uploadMax, lastJoin: await sara.kv.get('lastJoin').catch(() => null) };
    }
    if (step === 'logout') {
      running = false;
      if (cs.token) await cs.logout().catch(() => undefined);
      return { ok: true };
    }
    if (step === 'join' || step === 'leave') {
      const roomId = roomOf(String(m.room ?? ''));
      if (step === 'join') await cs.join(roomId);
      else await onLeave({ chatId: roomId });
      return { ok: true };
    }
  } catch (err) {
    return g(err);
  }
  return fail('UNKNOWN', `no check called ${step.slice(0, 40)}`);
}

/** The Test button (§7.5): read-only calls, sends nothing to anyone. */
async function onTest() {
  const steps = [];
  const add = (label, ok, fix) => steps.push({ label, ok, ...(ok ? {} : { fix }) });
  add('Her homeserver is set', Boolean(cs.host), 'Log her in (step 2).');
  if (!cs.host) return { steps };
  const v = await cs.versions().catch(() => undefined);
  add(`Her homeserver answers (${cs.host})`, Boolean(v?.versions), diagnose('HS_NOT_FOUND').title);
  let w;
  try {
    w = cs.token ? await cs.whoami() : undefined;
  } catch {
    w = undefined;
  }
  add(w ? `Logged in as ${w.user_id}` : 'Her login works', Boolean(w), cs.token ? diagnose('TOKEN_GONE').title : 'Log her in (step 2).');
  add('Sync is running', running && Date.now() - lastSyncAt < 60_000, 'Wait a moment, or log her in again.');
  const list = [...rooms.values()];
  const plain = list.filter((r) => !r.encrypted);
  add(plain.length ? `She is in ${plain.length === 1 ? '1 room' : `${plain.length} rooms`} without encryption` : 'She is in a room without encryption', plain.length > 0, list.length ? diagnose('ENCRYPTED_ROOM').title : diagnose('NOT_INVITED').title);
  add(uploadMax ? `Files up to ${Math.floor(uploadMax / 1048576)} MB` : 'Her server allows files', true);
  return { steps };
}

sara = plugin({
  bridge: { files: true, edit: true, places: true, typing: true, react: true, log: true, link: true, editLimit: 30, editEveryMs: 3000, textMax: TEXT_MAX, ack: 'react', maxBytes: OWNER_FILE_MAX },
  bridges: {
    [BRIDGE]: {
      send: (m) => onSend(m),
      edit: (m) => onEdit(m),
      file: (m) => onFile(m),
      typing: (m) => onTyping(m),
      react: (m) => onReact(m),
      leave: (m) => onLeave(m),
      check: (m) => onCheck(m),
      test: () => onTest(),
    },
  },
  tools: [],
  init: async (api0) => {
    sara = api0;
    cs = new Client(sara);
    setTimeout(() => void start(), 0);
  },
});

process.on('SIGTERM', () => {
  running = false;
  void cs?.close();
});
