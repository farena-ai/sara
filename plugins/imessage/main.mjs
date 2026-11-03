// The iMessage plugin (comes with Sara; docs/design/BRIDGES4.md §4, docs/IMESSAGE.md). He texts her
// from Messages on his iPhone, to HER OWN Apple ID, signed in on a Mac where BlueBubbles Server runs
// (his own Mac, a separate macOS user). Sara talks to BlueBubbles' REST API over a socket she holds
// for it (permissions.connect `bb`: this computer, his home network or his tailnet). Messages arrive
// through a doorbell: BlueBubbles' unsigned webhook reaches Sara, Sara passes this plugin only the
// event and the ids (§3.1 B2), and the plugin fetches each message from BlueBubbles with the password
// before anything reaches her. Without a doorbell it polls; after any gap it catches up (BlueBubbles
// never retries a webhook). Basic mode by default; the Private API's typing, tapbacks, edits and
// replies only if BlueBubbles reports it already on (Sara never asks him to turn SIP off, §14 Q3).
// It refuses to run on his own Apple ID (§4.4, §14 Q5): she would see all his chats and answer as him.
import { plugin } from './sara-plugin.mjs';
import { BB, accountHandles, chatOf, guidOf, isGroupGuid, readInfo } from './bb.mjs';
import { flatten, split, plainCommand, quoteLine } from './format.mjs';
import { codeOf, diagnose } from './diagnose.mjs';
import { pacing } from './pace.mjs';
const { Pacer, CapError, Typing, pollDelay } = pacing('imessage');

const BRIDGE = 'imessage';
const TEXT_MAX = 8_000;
const OWNER_FILE_MAX = 20 * 1024 * 1024;
const SEEN_MAX = 500;
/** Catch-up reads at most this far back; older messages are filed, not answered (§4.3). */
const CATCHUP_MS = 24 * 3600_000;
/** A chat with him counts as active this long after his last message (5-s polling, §4.3). */
const ACTIVE_MS = 10 * 60_000;
/** Apple's edit window (§4.7): no edits after 15 minutes. */
const EDIT_WINDOW_MS = 15 * 60_000;
const HEIC_LINE = "I can't see HEIC photos yet. On your iPhone: Settings → Camera → Formats → Most Compatible, or send it as a file.";

let sara;
let bb;
let info = { version: '', os: '', privateApi: false, account: '', signedIn: false };
let handles = [];
let running = false;
let refused = '';
let pollTimer;
let failures = 0;
let worked = false;
let lastPollOk = 0;
let lastActive = 0;
let lastSeen = 0;
let saveTimer;
const pacer = new Pacer();
const typing = new Typing((chat, on) => bb.typing(guidOf(chat), on).catch(() => undefined));
const seen = new Set();
const mine = new Set();
const texts = new Map();
const refs = new Map();
const outFiles = new Map();
const heicTold = new Set();
let capNoticeDay = '';
let asleepTold = false;

const s = () => sara.settings;
const def = {
  bridge: { files: true, edit: false, places: true, typing: false, react: false, log: true, link: true, textMax: TEXT_MAX, ack: 'line', maxBytes: OWNER_FILE_MAX },
};

// ------------------------------------------------------------------ start, the Apple ID rule, polling

/** Reads server/info before `ready`, so Sara gets the right features (basic or Private API, §4.7). */
async function readServer() {
  const d = await bb.info();
  info = readInfo(d);
  const acc = await bb.account().catch(() => ({}));
  handles = accountHandles(acc, info.account);
  if (info.privateApi) Object.assign(def.bridge, { edit: true, typing: true, react: true, ack: 'react', editLimit: 4, editEveryMs: 20_000 });
}

/** His own Apple ID on the Mac (§4.4): one of its addresses is one of his linked handles. */
async function ownAppleId() {
  for (const h of handles) {
    const who = await sara.bridgeWho({ bridge: BRIDGE, chatId: chatOf(`iMessage;-;${h}`), fromId: h, quiet: true }).catch(() => ({ who: 'none' }));
    if (who.who === 'owner') return h;
  }
  return '';
}

async function start() {
  if (!bb.address || !bb.password) return sara.status('error', diagnose('NOT_SET').title);
  if (!info.version) {
    try {
      await readServer();
    } catch (err) {
      return retryStart(err);
    }
  }
  const own = await ownAppleId();
  if (own) {
    refused = 'OWN_APPLE_ID';
    sara.skip('own-apple-id', own);
    sara.log('this Mac is signed in to Messages with his own Apple ID: the plugin refuses to run (OWN_APPLE_ID)', 'warn');
    return sara.status('error', diagnose('OWN_APPLE_ID').title);
  }
  if (!info.signedIn) sara.log('Messages on the Mac reports no iMessage account (MESSAGES_SIGNED_OUT)', 'warn');
  lastSeen = Number(await sara.kv.get('lastSeen').catch(() => 0)) || 0;
  for (const g of (await sara.kv.get('seen').catch(() => [])) ?? []) seen.add(String(g));
  // The very first start answers nothing from before (his history with her Apple ID stays history).
  if (!lastSeen) {
    lastSeen = Date.now();
    await sara.kv.set('lastSeen', lastSeen).catch(() => {});
  }
  running = true;
  sara.status(info.signedIn ? 'ok' : 'error', info.signedIn ? `${info.account} · ${info.privateApi ? 'Private API' : 'basic'}` : diagnose('MESSAGES_SIGNED_OUT').title);
  void tick();
}

let startBackoff = 0;
function retryStart(err) {
  const code = codeOf(err);
  sara.status(code === 'PRIVATE_LOCAL' ? 'paused' : 'error', diagnose(code).title);
  startBackoff = Math.min(60_000, startBackoff ? startBackoff * 2 : 2_000);
  setTimeout(() => void start(), startBackoff).unref?.();
}

async function doorbellOn() {
  const at = await sara.kv.get('doorbellAt').catch(() => null);
  return Boolean(at) && (await sara.kv.get('mode').catch(() => null)) !== 'polling';
}

/** One look at BlueBubbles (the catch-up and the polling): everything after the last message seen. */
async function tick() {
  clearTimeout(pollTimer);
  if (!running) return;
  try {
    await catchUp();
    lastPollOk = Date.now();
    if (failures >= 3) sara.status('ok', `${info.account} · ${info.privateApi ? 'Private API' : 'basic'}`);
    failures = 0;
    worked = true;
    asleepTold = false;
  } catch (err) {
    failures++;
    const code = codeOf(err);
    if (code === 'PRIVATE_LOCAL') sara.status('paused', diagnose('PRIVATE_LOCAL').title);
    else if (worked && failures >= 3 && code === 'BB_UNREACHABLE') {
      sara.status('error', diagnose('MAC_ASLEEP').title);
      if (!asleepTold) {
        asleepTold = true;
        void sara.notify('iMessage: the Mac seems asleep or BlueBubbles closed. Messages wait on the Mac; she reads them when it is back.').catch(() => {});
      }
    } else if (failures >= 3) sara.status('error', diagnose(code).title);
  }
  if (!running) return;
  const delay = pollDelay({ doorbell: await doorbellOn(), active: Date.now() - lastActive < ACTIVE_MS, pollSeconds: s().pollSeconds });
  pollTimer = setTimeout(() => void tick(), delay);
  pollTimer.unref?.();
}

let catching;
function catchUp() {
  // One catch-up at a time; a doorbell ring while one runs waits for it.
  catching ??= (async () => {
    try {
      const after = Math.max(lastSeen - 1, Date.now() - 2 * CATCHUP_MS);
      for (let page = 0; page < 10; page++) {
        const list = await bb.query(after);
        const msgs = Array.isArray(list) ? list : [];
        let fresh = 0;
        for (const m of msgs) if (!seen.has(String(m?.guid ?? ''))) (fresh++, await take(m, 'catchup'));
        if (msgs.length < 50 || !fresh) break;
      }
    } finally {
      catching = undefined;
    }
  })();
  return catching;
}

function remember(guid, at) {
  seen.add(guid);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  if (at > lastSeen) lastSeen = at;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void sara.kv.set('lastSeen', lastSeen).catch(() => {});
    void sara.kv.set('seen', [...seen].slice(-SEEN_MAX)).catch(() => {});
  }, 200);
}

// ------------------------------------------------------------------ the doorbell (B2)

/** Sara rang: `{event, ids}` only. Each id is fetched from BlueBubbles before anything is read. */
function onWebhook(m) {
  const ping = m.ping ?? {};
  const event = String(ping.event ?? '');
  const ids = (Array.isArray(ping.ids) ? ping.ids : []).map(String).slice(0, 20);
  void sara.kv.set('doorbellAt', new Date().toISOString()).catch(() => {});
  if (event === 'hello-world') return { ok: true };
  if (!running) return { ok: true };
  // Answered at once (BlueBubbles waits 15 s at most); the fetches run after.
  setImmediate(() => void ring(event, ids));
  return { ok: true };
}

async function ring(event, ids) {
  for (const id of ids) {
    if (seen.has(id)) continue;
    let msg;
    try {
      msg = await bb.message(id);
    } catch (err) {
      if (Number(err?.status) === 404 || Number(err?.status) === 400) sara.skip('unknown-id', id);
      else sara.log(`a doorbell's message couldn't be fetched: ${err?.message ?? err}`, 'warn');
      continue;
    }
    if (!msg || String(msg.guid ?? '') !== id) {
      sara.skip('unknown-id', id);
      continue;
    }
    if (event === 'message-send-error' || Number(msg.error) > 0) {
      if (msg.isFromMe) {
        const chat = chatOf(msg.chats?.[0]?.guid ?? '');
        if (chat) sara.failed({ bridge: BRIDGE, chatId: chat, code: 'SEND_FAILED', title: diagnose('SEND_FAILED').title, reply: false });
      }
      continue;
    }
    if (event === 'updated-message') continue;
    if (msg.isFromMe) {
      sara.skip('from-me', id);
      remember(id, Number(msg.dateCreated) || 0);
      continue;
    }
    await take(msg, 'ring');
  }
}

// ------------------------------------------------------------------ messages in

const tapback = (m) => Boolean(m.associatedMessageGuid) || (Number(m.associatedMessageType) >= 2000 && Number(m.associatedMessageType) < 4000);

async function take(m, source) {
  const id = String(m?.guid ?? '');
  if (!id || seen.has(id)) return;
  const at = Number(m.dateCreated) || Date.now();
  remember(id, at);
  if (m.isFromMe) return;
  const chat = Array.isArray(m.chats) ? m.chats[0] : m.chat;
  const chatGuid = String(chat?.guid ?? '');
  if (!chatGuid) return;
  const chatId = chatOf(chatGuid);
  const fromId = String(m.handle?.address ?? '').trim().toLowerCase();
  if (!fromId) return;
  const group = isGroupGuid(chatGuid) || (Array.isArray(chat?.participants) && chat.participants.length > 1);
  const members = Array.isArray(chat?.participants) ? chat.participants.map((p) => String(p?.address ?? '').toLowerCase()).filter(Boolean) : [];
  const age = Date.now() - at;
  if (age > CATCHUP_MS) {
    sara.skip('old', fromId);
    return;
  }
  if (tapback(m)) {
    if (group) sara.bridgeLog({ bridge: BRIDGE, chatId, messageId: id, fromId, from: fromId, text: '[tapback]' });
    return;
  }
  const raw = String(m.text ?? '').replace(/\ufffc/g, '').trim();
  const text = plainCommand(raw);
  texts.set(id, raw);
  if (texts.size > 300) texts.delete(texts.keys().next().value);
  const herName = String(sara.herName || 'Sara');
  const addressed = new RegExp(`^@?${herName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  const replyToHer = Boolean(m.threadOriginatorGuid && mine.has(String(m.threadOriginatorGuid)));
  const base = {
    bridge: BRIDGE,
    chatId,
    fromId,
    from: fromId,
    messageId: id,
    chat: group ? { kind: 'group', title: String(chat?.displayName ?? '').trim() || 'iMessage group', members } : { kind: 'dm' },
    at: new Date(Math.min(at, Date.now())).toISOString(),
    ...(source === 'catchup' ? { caughtUp: true } : {}),
    addressed,
    replyToHer,
    ...(m.threadOriginatorGuid ? { replyTo: String(m.threadOriginatorGuid) } : {}),
  };
  if (group) sara.bridgeLog({ bridge: BRIDGE, chatId, messageId: id, fromId, from: fromId, text: raw || '[attachment]', at: base.at });
  if (!group) {
    lastActive = Date.now();
    void receipt(chatGuid, chatId, fromId);
  }
  const atts = (Array.isArray(m.attachments) ? m.attachments : []).filter((a) => a?.guid).slice(0, 4);
  if (atts.length) return onMedia(m, atts, { ...base, text });
  if (!text) return;
  return void sara.bridgeInbound({ ...base, text }).catch((err) => sara.log(`a message failed: ${err?.message ?? err}`, 'warn'));
}

/** *Send read receipts* (Private API only): his own chat only, never anyone else's. */
async function receipt(chatGuid, chatId, fromId) {
  if (!info.privateApi || s().readReceipts !== true) return;
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId, fromId, quiet: true }).catch(() => ({ who: 'none' }))).who;
  if (who === 'owner') await bb.read(chatGuid).catch(() => undefined);
}

const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const isPng = (b) => b.length > 8 && b.subarray(1, 4).toString('latin1') === 'PNG';
const isHeic = (a) => /heic|heif/i.test(String(a.mimeType ?? '')) || /\.(heic|heif)$/i.test(String(a.transferName ?? ''));

async function onMedia(m, atts, base) {
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId: base.chatId, fromId: base.fromId }).catch(() => ({ who: 'none' }))).who;
  const mark = (a) => (m.isAudioMessage || /audio/i.test(String(a.mimeType ?? '')) ? '[voice message]' : /^image\//i.test(String(a.mimeType ?? '')) || isHeic(a) ? '[photo]' : '[file]');
  const send = (more) => void sara.bridgeInbound({ ...base, ...more }).catch((err) => sara.log(`a message failed: ${err?.message ?? err}`, 'warn'));
  // Strangers' files are never downloaded; partners' only pictures (BR1).
  if (who !== 'owner' && who !== 'partner') return send({ text: base.text || mark(atts[0]) });
  const files = [];
  let heic = false;
  let voice = false;
  for (const a of atts) {
    const image = /^image\//i.test(String(a.mimeType ?? '')) || isHeic(a);
    if (who === 'partner' && !image) continue;
    if (Number(a.totalBytes) > OWNER_FILE_MAX) continue;
    try {
      const r = await bb.download(String(a.guid));
      if (isHeic(a) && !isJpeg(r.bytes) && !isPng(r.bytes)) {
        heic = true;
        continue;
      }
      const audio = Boolean(m.isAudioMessage) || /audio/i.test(String(a.mimeType ?? ''));
      if (audio) voice = true;
      const name = String(a.transferName ?? 'file').slice(0, 120);
      const mime = isHeic(a) && isJpeg(r.bytes) ? 'image/jpeg' : String(a.mimeType ?? r.type ?? 'application/octet-stream');
      files.push({ name: isHeic(a) && isJpeg(r.bytes) ? name.replace(/\.(heic|heif)$/i, '.jpg') : name, mime, data: r.bytes });
    } catch (err) {
      sara.log(`an attachment couldn't be downloaded: ${err?.message ?? err}`, 'warn');
    }
  }
  if (heic && !heicTold.has(base.chatId)) {
    heicTold.add(base.chatId);
    void onSend({ chatId: base.chatId, text: HEIC_LINE });
  }
  if (!files.length) return send({ text: base.text || (heic ? '[HEIC photo]' : mark(atts[0])) });
  return void sara.sendFile({ ...base, text: base.text, files: voice ? files.slice(0, 1) : files, ...(voice ? { voice: true } : {}) }).catch((err) => sara.log(`a file failed: ${err?.message ?? err}`, 'warn'));
}

// ------------------------------------------------------------------ sending (§4.6–§4.11)

function refusedSend(chatId, err, started) {
  if (err instanceof CapError) {
    const day = new Date().toISOString().slice(0, 10);
    if (capNoticeDay !== day) {
      capNoticeDay = day;
      void sara.notify(`iMessage: she reached the ${err.cap} cap of messages, so the rest stays in the app.`).catch(() => {});
    }
    return;
  }
  const code = codeOf(err) === 'UNKNOWN' ? 'SEND_FAILED' : codeOf(err);
  sara.log(`a send was refused: ${err?.message ?? err}`, 'warn');
  sara.failed({ bridge: BRIDGE, chatId, code, title: diagnose(code).title, reply: !started });
}

/** One send through the pacer; a failure is tried once more after 10 s (§4.11). */
async function sendOnce(chatId, fn) {
  try {
    return await pacer.send(chatId, fn);
  } catch (err) {
    if (err instanceof CapError || codeOf(err) === 'PRIVATE_LOCAL' || codeOf(err) === 'NOT_IMESSAGE') throw err;
    await new Promise((r) => setTimeout(r, Number(process.env.SARA_IMESSAGE_RETRY_MS ?? 10_000)).unref?.());
    return pacer.send(chatId, fn);
  }
}

async function post(chatId, text, o = {}) {
  const r = await sendOnce(chatId, () => bb.sendText(guidOf(chatId), text, { privateApi: info.privateApi, ...(o.replyTo ? { replyTo: o.replyTo } : {}) }));
  const guid = String(r?.guid ?? '');
  if (guid) mine.add(guid);
  if (mine.size > 500) mine.delete(mine.values().next().value);
  return guid;
}

async function onSend(m) {
  const chatId = String(m.chatId);
  const started = m.started === true;
  try {
    if (m.files?.length) {
      outFiles.set(m.files.map((f) => f.fileId).join(','), { chatId, text: m.text ?? '', files: m.files.map((f) => ({ ...f, parts: [], done: false })), started });
      return;
    }
    const flat = flatten(String(m.text ?? ''));
    if (!flat) return;
    // Basic mode has no real replies: an answer in a group (or /btw) quotes his words in text.
    const replyTo = m.replyTo ? String(m.replyTo) : '';
    const quote = replyTo && !info.privateApi ? quoteLine(texts.get(replyTo)) : '';
    const parts = m.ref ? [flat] : split(quote ? `${quote}\n${flat}` : flat);
    let first = '';
    for (const [i, p] of parts.entries()) {
      const g = await post(chatId, p, i === 0 && info.privateApi && replyTo ? { replyTo } : {});
      if (i === 0) first = g;
    }
    if (m.ref && first) {
      refs.set(m.ref, { guid: first, at: Date.now() });
      if (refs.size > 100) refs.delete(refs.keys().next().value);
    }
    if (!m.ref) typing.off(chatId);
    if (first) sara.bridgeSent({ bridge: BRIDGE, ...(m.ref ? { ref: m.ref } : {}), messageId: first });
  } catch (err) {
    refusedSend(chatId, err, started);
  }
}

/** The progress message (Private API only, §4.7): edits within Apple's 15 minutes; after that, none. */
async function onEdit(m) {
  const r = refs.get(m.ref);
  if (!r || !info.privateApi || Date.now() - r.at > EDIT_WINDOW_MS) return;
  await bb.edit(r.guid, flatten(String(m.text ?? '')).slice(0, 2_000)).catch((err) => sara.log(`an edit failed: ${err?.message ?? err}`, 'warn'));
}

/** Her pictures and files: one multipart `message/attachment` each, the caption as a text message first. */
async function onFile(m) {
  for (const [key, out] of outFiles) {
    const f = out.files.find((x) => x.fileId === m.fileId);
    if (!f) continue;
    f.parts.push(Buffer.from(String(m.data ?? ''), 'base64'));
    if (m.last) f.done = true;
    if (!out.files.every((x) => x.done)) return;
    outFiles.delete(key);
    try {
      const caption = flatten(out.text);
      if (caption) await post(out.chatId, caption);
      for (const x of out.files) {
        const r = await sendOnce(out.chatId, () => bb.sendFile(guidOf(out.chatId), { name: x.name, mime: x.mime, data: Buffer.concat(x.parts) }, { privateApi: info.privateApi }));
        if (r?.guid) mine.add(String(r.guid));
      }
      typing.off(out.chatId);
    } catch (err) {
      refusedSend(out.chatId, err, out.started);
    }
    return;
  }
}

async function onTyping(m) {
  const chatId = String(m.chatId);
  if (!m.on) return typing.off(chatId);
  if (!info.privateApi || isGroupGuid(guidOf(chatId))) return;
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId, quiet: true }).catch(() => ({ who: 'none' }))).who;
  if (who === 'owner') typing.on(chatId);
}

/** BR2's 👀 on a steer → the ‼ tapback, the nearest of Apple's classic six (Private API only). */
async function onReact(m) {
  if (!info.privateApi) return;
  await bb.react(guidOf(String(m.chatId)), String(m.messageId), 'emphasize').catch(() => undefined);
}

// ------------------------------------------------------------------ the setup card's checks (§7.1, §7.5)

async function onCheck(m) {
  const step = String(m.step ?? '');
  const fail = (code, detail, params) => ({ ok: false, diagnosis: diagnose(code, detail, params) });
  try {
    if (step === 'server') {
      if (!bb.address || !bb.password) return fail('NOT_SET');
      await bb.ping();
      const d = readInfo(await bb.info());
      const acc = await bb.account().catch(() => ({}));
      const hs = accountHandles(acc, d.account);
      const out = { version: d.version, os: d.os, privateApi: d.privateApi, account: d.account || hs[0] || '', handles: hs };
      if (!d.signedIn) return { ...fail('MESSAGES_SIGNED_OUT'), ...out };
      return { ok: true, ...out };
    }
    if (step === 'register') {
      // The doorbell (§4.3): Sara's hook address in BlueBubbles, made again if it was there before.
      const url = String(m.url ?? '');
      if (!/^https?:\/\/[^\s?#]+\/hook\/h[0-9a-f]{12}\.[A-Za-z0-9_-]{16,64}$/.test(url)) return fail('UNKNOWN', 'not a hook address');
      const list = await bb.webhooks().catch(() => []);
      for (const w of Array.isArray(list) ? list : []) if (/\/hook\/h[0-9a-f]{12}\./.test(String(w?.url ?? '')) && w?.id !== undefined) await bb.removeWebhook(w.id).catch(() => undefined);
      await bb.addWebhook(url, ['new-message', 'updated-message', 'message-send-error', 'hello-world']);
      await sara.kv.set('mode', 'doorbell').catch(() => {});
      return { ok: true };
    }
    if (step === 'unregister' || step === 'polling') {
      const list = await bb.webhooks().catch(() => []);
      for (const w of Array.isArray(list) ? list : []) if (/\/hook\/h[0-9a-f]{12}\./.test(String(w?.url ?? '')) && w?.id !== undefined) await bb.removeWebhook(w.id).catch(() => undefined);
      await sara.kv.set('mode', 'polling').catch(() => {});
      return { ok: true };
    }
    if (step === 'state') {
      return { ok: true, running, refused, version: info.version, os: info.os, privateApi: info.privateApi, account: info.account, handles, doorbellAt: await sara.kv.get('doorbellAt').catch(() => null), mode: (await sara.kv.get('mode').catch(() => null)) ?? null, polling: running && Date.now() - lastPollOk < 120_000, failures, today: pacer.counts() };
    }
  } catch (err) {
    return fail(codeOf(err), err?.message);
  }
  return fail('UNKNOWN', `no check called ${step.slice(0, 40)}`);
}

/** The Test button (§7.5): read-only calls, sends nothing to anyone. */
async function onTest() {
  const steps = [];
  const add = (label, ok, fix) => steps.push({ label, ok, ...(ok ? {} : { fix }) });
  add('BlueBubbles address and password are set', Boolean(bb.address && bb.password), diagnose('NOT_SET').title);
  if (!bb.address || !bb.password) return { steps };
  let pinged;
  try {
    await bb.ping();
    pinged = true;
  } catch (err) {
    const code = codeOf(err);
    add(`BlueBubbles answers at ${bb.address}`, code === 'BB_PASSWORD', diagnose(code).title);
    if (code === 'BB_PASSWORD') add('BlueBubbles takes the password', false, diagnose('BB_PASSWORD').title);
    return { steps };
  }
  add(`BlueBubbles answers at ${bb.address}`, pinged);
  add('BlueBubbles takes the password', true);
  const d = readInfo(await bb.info().catch(() => ({})));
  add(d.signedIn ? `Messages is signed in as ${d.account}` : 'Messages is signed in to iMessage', d.signedIn, diagnose('MESSAGES_SIGNED_OUT').title);
  add("It isn't your own Apple ID", refused !== 'OWN_APPLE_ID', diagnose('OWN_APPLE_ID').title);
  const door = await doorbellOn();
  add(door ? 'BlueBubbles rings Sara' : 'Sara checks for messages every few seconds', running && (door || Date.now() - lastPollOk < 120_000), diagnose('MAC_ASLEEP').title);
  add(d.privateApi ? 'Private API: on (typing, tapbacks, edits)' : "Private API: off (that's fine)", true);
  return { steps };
}

def.bridges = {
  [BRIDGE]: {
    send: (m) => onSend(m),
    edit: (m) => onEdit(m),
    file: (m) => onFile(m),
    typing: (m) => onTyping(m),
    react: (m) => onReact(m),
    webhook: (m) => onWebhook(m),
    check: (m) => onCheck(m),
    test: () => onTest(),
  },
};
def.tools = [];
def.init = async (api0) => {
  sara = api0;
  bb = new BB(sara);
  // server/info first (≤ 6 s), so `ready` says basic or Private API; if the Mac doesn't answer yet,
  // she starts in basic mode and the start is tried again.
  if (bb.address && bb.password) {
    await Promise.race([readServer().catch(() => undefined), new Promise((r) => setTimeout(r, 6_000).unref?.())]);
    announced = info.privateApi;
  }
  setTimeout(() => void start(), 0);
  // When the Private API is switched on or off in BlueBubbles, the bridge restarts with the other features (§4.7).
  const watch = setInterval(async () => {
    if (!running) return;
    const d = await bb.info().catch(() => undefined);
    if (d && readInfo(d).privateApi !== announced) {
      sara.status('connecting', 'The Private API was switched in BlueBubbles: starting again');
      sara.log('the Private API changed in BlueBubbles: the bridge restarts with the other features');
      setTimeout(() => process.exit(0), 200);
    }
  }, 5 * 60_000);
  watch.unref?.();
};
let announced = false;
sara = plugin(def);

process.on('SIGTERM', () => {
  running = false;
  clearTimeout(pollTimer);
  void bb?.close();
});
