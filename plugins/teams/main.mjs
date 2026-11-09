// The Microsoft Teams plugin (comes with Sara; docs/ops/EC7_DESIGN.md, docs/TEAMS.md). An Azure Bot he
// registers talks with him in her personal chat and, when mentioned, in the channels and group chats he
// switched on. Teams calls Sara: every activity reaches her bridge hook, where Sara checks Microsoft's
// signed token before handing the body here (`webhook`). Messages go out with the Bot Connector REST
// API (send, reply in the thread, update). Sara decides who the owner is (linking with a code), what
// anyone may do and every turn; her requests for his OK come as an Adaptive Card with Allow / Deny that
// only he can answer (Sara checks it, not the plugin).
import { plugin } from './sara-plugin.mjs';
import { Api, DEFAULT_SERVICE, TeamsError } from './api.mjs';
import { card, consent, DOWNLOAD_INFO, fileInfo, tapOf } from './cards.mjs';
import { fromTeams, split, toTeams } from './format.mjs';
import { codeOf, diagnose } from './diagnose.mjs';
import { pacing } from './pace.mjs';
const { Pacer, CapError } = pacing('teams');

const BRIDGE = 'teams';
const TEXT_MAX = 7_000;
const FILE_MAX = 20 * 1024 * 1024;
const SEEN_MAX = 2_000;
const CONSENT_MS = 3600_000;
const BACKOFF_MAX_MS = 60_000;

let sara;
let api;
let running = false;
let tokenOk = false;
let ended = '';
let lastCallAt = 0;
let capNoticeDay = '';
const pacer = new Pacer();
const seen = new Set();
const convs = new Map(); // chat id → { serviceUrl, kind, title }
const threadOf = new Map(); // activity id → the conversation id to answer in (a channel thread)
const refs = new Map(); // progress ref → { chat, conv, id, serviceUrl }
const asks = new Map(); // card activity id → her request's text
const outFiles = new Map(); // file ids being streamed from Sara
const waiting = new Map(); // fileId → { chat, name, mime, data, at } (until he taps Allow)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const remember = (map, k, v, max = 500) => {
  map.set(k, v);
  if (map.size > max) map.delete(map.keys().next().value);
};
const chatIdOf = (conversationId) => String(conversationId ?? '').split(';messageid=')[0];
const fromIdOf = (from) => String(from?.aadObjectId || from?.id || '').toLowerCase();

// ------------------------------------------------------------------ starting (the token)

async function start() {
  if (!api.ready) return sara.status('error', diagnose('NOT_SET').title);
  running = true;
  sara.status('connecting', 'Microsoft Teams');
  const known = await sara.kv.get('convs').catch(() => null);
  if (known) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(known))) convs.set(k, v);
    } catch {
      /* a fresh list */
    }
  }
  // "Reconnect" for a webhook app: the token, retried 1, 2, 4 … 60 s; a refused secret stops and says so once.
  for (let attempt = 0; running; attempt++) {
    try {
      await api.bearer(true);
      tokenOk = true;
      ended = '';
      return sara.status('ok', 'Microsoft Teams');
    } catch (err) {
      const code = codeOf(err);
      if (['SECRET_WRONG', 'SECRET_EXPIRED', 'APP_ID_WRONG', 'TENANT_WRONG'].includes(code)) return gone(code);
      sara.status(code === 'PRIVATE_LOCAL' ? 'paused' : 'error', diagnose(code).title);
      await sleep(Math.round(Math.min(BACKOFF_MAX_MS, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4)));
    }
  }
}

/** Her secret stopped working: no more retries, and he is told once. */
function gone(code) {
  running = false;
  tokenOk = false;
  ended = code;
  api.forget();
  sara.status('error', diagnose(code).title);
  void (async () => {
    const tail = `${code}${api.secret.slice(-4)}`;
    if ((await sara.kv.get('goneTold').catch(() => null)) === tail) return;
    await sara.kv.set('goneTold', tail).catch(() => {});
    await sara.notify(`Microsoft Teams: ${diagnose(code).title} Paste a new client secret in Settings → Microsoft Teams.`).catch(() => {});
  })();
}

function rememberConv(chat, o) {
  const was = convs.get(chat);
  if (was && was.serviceUrl === o.serviceUrl && was.kind === o.kind && (!o.title || was.title === o.title) && (!o.user || was.user === o.user)) return;
  remember(convs, chat, { ...was, ...o, title: o.title || was?.title || '' }, 300);
  void sara.kv.set('convs', JSON.stringify(Object.fromEntries(convs))).catch(() => {});
}

// ------------------------------------------------------------------ activities in (Sara checked the token)

function onWebhook({ body }) {
  let a;
  try {
    a = JSON.parse(String(body ?? ''));
  } catch {
    sara.log('a call that is not JSON was dropped', 'warn');
    return { ok: true };
  }
  lastCallAt = Date.now();
  // Accepted at once (Sara answers Teams 200); the turn runs after.
  void onActivity(a).catch((err) => sara.log(`an activity failed: ${err?.message ?? err}`, 'warn'));
  return { ok: true };
}

async function onActivity(a) {
  if (!a || typeof a !== 'object' || a.channelId !== 'msteams') return;
  const key = String(a.id ?? '');
  if (key) {
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  }
  const conv = a.conversation ?? {};
  const kind = conv.conversationType === 'personal' ? 'dm' : 'group';
  const chat = chatIdOf(conv.id);
  if (!chat) return;
  const title = kind === 'dm' ? '' : String(a.channelData?.channel?.name || conv.name || a.channelData?.team?.name || '').slice(0, 80);
  // A personal chat belongs to one person (Teams makes one per user and bot): the first sender is kept.
  rememberConv(chat, { serviceUrl: String(a.serviceUrl || DEFAULT_SERVICE), kind, title, ...(kind === 'dm' && !convs.get(chat)?.user ? { user: fromIdOf(a.from) } : {}) });
  if (a.type === 'invoke' && a.name === 'fileConsent/invoke') return onConsent(a, chat);
  if (a.type !== 'message') return;
  if (!a.from?.id || a.from.id === a.recipient?.id) return;
  remember(threadOf, key, String(conv.id));
  const base = baseOf(a, chat, kind, title);
  const tap = tapOf(a);
  if (tap) return onTap(a, base, tap);
  const botNames = (a.entities ?? []).filter((e) => e?.type === 'mention' && e.mentioned?.id === a.recipient?.id).map((e) => String(e.text ?? e.mentioned?.name ?? ''));
  if (kind === 'group') base.addressed = botNames.length > 0 || conv.conversationType === 'channel';
  const text = fromTeams(a.text, botNames);
  const files = (a.attachments ?? []).filter((x) => x && (x.contentType === DOWNLOAD_INFO || /^image\//.test(String(x.contentType ?? ''))));
  if (files.length) return onFiles(files, base, text);
  if (!text) return;
  return sara.bridgeInbound({ ...base, text });
}

function baseOf(a, chat, kind, title) {
  return {
    bridge: BRIDGE,
    chatId: chat,
    fromId: fromIdOf(a.from),
    from: String(a.from?.name || 'someone').slice(0, 60),
    ...(a.id ? { messageId: String(a.id) } : {}),
    ...(a.timestamp ? { at: new Date(Math.min(Date.parse(a.timestamp) || Date.now(), Date.now())).toISOString() } : {}),
    chat: kind === 'dm' ? { kind: 'dm' } : { kind: 'group', title: title || 'Teams channel', ownerIn: false },
  };
}

async function onFiles(files, base, text) {
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId: base.chatId, fromId: base.fromId }).catch(() => ({ who: 'none' }))).who;
  const pics = files.filter((f) => /^image\//.test(String(f.contentType)) || /^(png|jpe?g|gif|webp)$/i.test(String(f.content?.fileType ?? '')));
  const mark = pics.length === files.length ? '[photo]' : '[file]';
  // Strangers' files are never downloaded; partners' only pictures (the Matrix rule).
  const take = who === 'owner' ? files : who === 'partner' ? pics : [];
  if (!take.length) return sara.bridgeInbound({ ...base, text: text || mark });
  const got = [];
  for (const f of take.slice(0, 5)) {
    const url = f.contentType === DOWNLOAD_INFO ? f.content?.downloadUrl : f.contentUrl;
    try {
      const r = await api.download(url, FILE_MAX);
      const type = f.contentType === DOWNLOAD_INFO ? r.type : String(f.contentType);
      got.push({ name: String(f.name || (f.contentType === DOWNLOAD_INFO ? 'file' : 'picture')).slice(0, 120), mime: type, data: r.bytes });
    } catch (err) {
      if (codeOf(err) === 'FILE_TOO_BIG') sara.failed({ bridge: BRIDGE, chatId: base.chatId, code: 'FILE_TOO_BIG', title: diagnose('FILE_TOO_BIG').title, reply: false });
      else sara.log(`a file couldn't be downloaded: ${err?.message ?? err}`, 'warn');
    }
  }
  if (!got.length) return sara.bridgeInbound({ ...base, text: text || mark });
  return sara.sendFile({ ...base, text, files: got });
}

/** A card button: Allow / Deny (Sara decides), ⏹ on the progress message, or a reply button's words. */
async function onTap(a, base, id) {
  const conv = String(a.conversation?.id ?? base.chatId);
  const serviceUrl = String(a.serviceUrl || DEFAULT_SERVICE);
  const ap = /^ap:([\w-]{1,80}):([01])$/.exec(id);
  if (ap) {
    const r = await sara.bridgeInbound({ ...base, text: '', action: 'decide', approval: ap[1], allow: ap[2] === '1' }).catch((err) => ({ decided: 'refused', line: String(err?.message ?? '') }));
    const line = String(r.line ?? '');
    const cardId = String(a.replyToId ?? '');
    if ((r.decided === 'allowed' || r.decided === 'denied') && cardId) {
      const was = asks.get(cardId) ?? '';
      asks.delete(cardId);
      const text = was ? `${was}\n\n${line}` : line;
      await pace(base.chatId, () => api.update(serviceUrl, conv, cardId, { type: 'message', attachments: [card(text)] })).catch((err) => sara.log(`an update failed: ${err?.message ?? err}`, 'warn'));
    } else if (line) await pace(base.chatId, () => api.send(serviceUrl, conv, { type: 'message', text: toTeams(line), textFormat: 'markdown' })).catch(() => undefined);
    return;
  }
  if (id.startsWith('st:')) return sara.bridgeInbound({ ...base, text: '', action: 'stop', ref: id.slice(3) });
  if (id) return sara.bridgeInbound({ ...base, text: id.replace(/^b:/, '').slice(0, 200) });
}

/** His answer to a file-consent card: Allow → her file goes to his OneDrive and shows in the chat. */
async function onConsent(a, chat) {
  const v = a.value ?? {};
  const fileId = String(v.context?.fileId ?? '');
  const w = waiting.get(fileId);
  if (!w || w.chat !== chat) return;
  // Only the person whose personal chat it is (and only if that is the linked owner) can let a file in.
  if (convs.get(chat)?.user && convs.get(chat).user !== fromIdOf(a.from)) return sara.log('a file answer from someone else was ignored', 'warn');
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId: chat, fromId: fromIdOf(a.from) }).catch(() => ({ who: 'none' }))).who;
  if (who !== 'owner') return;
  waiting.delete(fileId);
  const serviceUrl = String(a.serviceUrl || DEFAULT_SERVICE);
  if (v.action !== 'accept') return;
  const info = v.uploadInfo ?? {};
  try {
    await api.upload(info.uploadUrl, w.data);
    await pace(chat, () => api.send(serviceUrl, chat, { type: 'message', attachments: [fileInfo(info)] }));
  } catch (err) {
    refused(chat, err, true);
  }
}

// ------------------------------------------------------------------ sending

const retryOf = (err) => (err instanceof TeamsError ? err.retryMs : undefined);
const pace = (chat, fn) => pacer.send(chat, fn, retryOf);
const serviceOf = (chat) => convs.get(chat)?.serviceUrl || DEFAULT_SERVICE;

function refused(chatId, err, started) {
  if (err instanceof CapError) {
    const day = new Date().toISOString().slice(0, 10);
    if (capNoticeDay !== day) {
      capNoticeDay = day;
      void sara.notify(`Microsoft Teams: she reached the ${err.cap} cap of messages, so the rest stays in the app.`).catch(() => {});
    }
    return;
  }
  const code = codeOf(err);
  sara.log(`a send was refused: ${err?.message ?? err}`, 'warn');
  if (['SECRET_WRONG', 'SECRET_EXPIRED', 'APP_ID_WRONG', 'TENANT_WRONG'].includes(code)) gone(code);
  sara.failed({ bridge: BRIDGE, chatId, code, title: diagnose(code).title, reply: !started });
}

/** In a channel she answers in the mention's thread; in her personal chat there are no threads. */
function convFor(m) {
  const chat = String(m.chatId);
  if (m.replyTo && threadOf.has(String(m.replyTo))) return threadOf.get(String(m.replyTo));
  return chat;
}

async function onSend(m) {
  const chat = String(m.chatId);
  const started = m.started === true;
  const conv = convFor(m);
  const serviceUrl = serviceOf(chat);
  try {
    if (m.files?.length) {
      outFiles.set(m.files.map((f) => f.fileId).join(','), { chat, conv, text: String(m.text ?? ''), files: m.files.map((f) => ({ ...f, parts: [], done: false })), started });
      return;
    }
    const text = String(m.text ?? '');
    if (!text.trim()) return;
    const md = toTeams(text);
    const buttons = m.ref ? [{ id: `st:${m.ref}`, label: '⏹' }] : (m.buttons ?? []);
    let first = '';
    if (buttons.length) {
      const r = await pace(chat, () => api.send(serviceUrl, conv, { type: 'message', attachments: [card(text, buttons)] }));
      first = String(r.id ?? '');
      if (first && buttons.some((b) => String(b.id).startsWith('ap:'))) remember(asks, first, text, 200);
    } else {
      for (const [i, part] of split(md, TEXT_MAX).entries()) {
        const r = await pace(chat, () => api.send(serviceUrl, conv, { type: 'message', text: part, textFormat: 'markdown' }));
        if (i === 0) first = String(r.id ?? '');
      }
    }
    if (m.ref && first) remember(refs, m.ref, { chat, conv, id: first, serviceUrl }, 200);
    if (first) sara.bridgeSent({ bridge: BRIDGE, ...(m.ref ? { ref: m.ref } : {}), messageId: first });
  } catch (err) {
    refused(chat, err, started);
  }
}

/** The progress message: the same card updated in place, keeping ⏹ until the ✅ summary. */
async function onEdit(m) {
  const t = refs.get(m.ref);
  if (!t) return;
  const text = String(m.text ?? '');
  const done = /^✅/.test(text.trim());
  await pace(t.chat, () => api.update(t.serviceUrl, t.conv, t.id, { type: 'message', attachments: [card(text, done ? [] : [{ id: `st:${m.ref}`, label: '⏹' }])] })).catch((err) => sara.log(`an edit failed: ${err?.message ?? err}`, 'warn'));
}

/** Her files: in her personal chat a file-consent card (he taps Allow); in channels, a plain note. */
async function onFile(m) {
  for (const [key, out] of outFiles) {
    const f = out.files.find((x) => x.fileId === m.fileId);
    if (!f) continue;
    f.parts.push(Buffer.from(String(m.data ?? ''), 'base64'));
    if (m.last) f.done = true;
    if (!out.files.every((x) => x.done)) return;
    outFiles.delete(key);
    const serviceUrl = serviceOf(out.chat);
    try {
      if (out.text.trim()) await pace(out.chat, () => api.send(serviceUrl, out.conv, { type: 'message', text: toTeams(out.text), textFormat: 'markdown' }));
      if (convs.get(out.chat)?.kind !== 'dm') {
        sara.failed({ bridge: BRIDGE, chatId: out.chat, code: 'FILE_NOT_HERE', title: diagnose('FILE_NOT_HERE').title, reply: !out.started });
        return;
      }
      for (const x of out.files) {
        const data = Buffer.concat(x.parts);
        if (data.length > FILE_MAX) {
          sara.failed({ bridge: BRIDGE, chatId: out.chat, code: 'FILE_TOO_BIG', title: diagnose('FILE_TOO_BIG').title, reply: !out.started });
          continue;
        }
        for (const [id, w] of waiting) if (Date.now() - w.at > CONSENT_MS) waiting.delete(id);
        const fileId = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        remember(waiting, fileId, { chat: out.chat, name: x.name, mime: x.mime, data, at: Date.now() }, 20);
        await pace(out.chat, () => api.send(serviceUrl, out.conv, { type: 'message', attachments: [consent(x.name || 'file', data.length, fileId, 'From her: tap Allow to put it in your OneDrive.')] }));
      }
    } catch (err) {
      refused(out.chat, err, out.started);
    }
    return;
  }
}

async function onTyping(m) {
  if (!m.on) return;
  const chat = String(m.chatId);
  await api.send(serviceOf(chat), chat, { type: 'typing' }).catch(() => undefined);
}

function onLeave(m) {
  convs.delete(String(m.chatId));
  void sara.kv.set('convs', JSON.stringify(Object.fromEntries(convs))).catch(() => {});
}

// ------------------------------------------------------------------ the setup card's checks

async function onCheck(m) {
  const step = String(m.step ?? '');
  const no = (code, detail) => ({ ok: false, diagnosis: diagnose(code, detail, {}, api.secret) });
  if (step === 'auth') {
    if (!api.ready) return no('NOT_SET');
    try {
      await api.bearer(true);
      tokenOk = true;
      ended = '';
      if (!running) void start();
      return { ok: true };
    } catch (err) {
      return no(codeOf(err), err?.message);
    }
  }
  if (step === 'status') return { ok: true, tokenOk, ended, lastCallAt: lastCallAt ? new Date(lastCallAt).toISOString() : null, running };
  if (step === 'channels') {
    const list = [...convs.entries()].filter(([, v]) => v.kind === 'group').map(([id, v]) => ({ id, name: v.title || '', private: false }));
    return { ok: true, channels: list.slice(0, 200) };
  }
  if (step === 'logout') {
    running = false;
    tokenOk = false;
    api.forget();
    return { ok: true };
  }
  return no('UNKNOWN', `no check called ${step.slice(0, 40)}`);
}

/** The Test button: read-only, sends nothing to anyone. */
async function onTest() {
  const steps = [];
  const add = (label, ok, fix) => steps.push({ label, ok, ...(ok ? {} : { fix }) });
  add('The App ID and the client secret are set', api.ready, 'Step 2: paste them.');
  if (!api.ready) return { steps };
  let err;
  try {
    await api.bearer(true);
  } catch (e) {
    err = e;
  }
  add('Microsoft gives her a token (App ID, directory and secret work)', !err, err ? diagnose(codeOf(err)).title : '');
  return { steps };
}

sara = plugin({
  bridge: { files: true, edit: true, places: true, typing: true, link: true, editEveryMs: 3000, textMax: TEXT_MAX, ack: 'none', buttons: 3, maxBytes: FILE_MAX },
  bridges: {
    [BRIDGE]: {
      send: (m) => onSend(m),
      edit: (m) => onEdit(m),
      file: (m) => onFile(m),
      typing: (m) => onTyping(m),
      leave: (m) => onLeave(m),
      webhook: (m) => onWebhook(m),
      check: (m) => onCheck(m),
      test: () => onTest(),
    },
  },
  tools: [],
  init: async (api0) => {
    sara = api0;
    api = new Api(sara);
    setTimeout(() => void start(), 0);
  },
});

process.on('SIGTERM', () => {
  running = false;
  void api?.close();
});
