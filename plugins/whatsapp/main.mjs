// The WhatsApp plugin (comes with Sara; docs/design/WHATSAPP.md §4, docs/WHATSAPP.md). Meta's
// official Cloud API with the owner's own WhatsApp Business account and number: messages come in
// as webhooks that Sara has already signature-checked (`webhook`, permissions.webhooks 'bridge'),
// and go out as HTTPS calls to the Graph API over sockets Sara holds for it (permissions.connect;
// the plugin never opens one itself). Sara decides who the owner is (linking with a code, his
// pinned identity key hash), what anyone may do, every turn and the 24-hour window. Unofficial
// WhatsApp Web clients are not used: Meta bans those numbers (§8).
import { createHash } from 'node:crypto';
import { plugin } from './sara-plugin.mjs';
import { Http1, multipart } from './http1.mjs';
import { parsePayload, markOf } from './webhook.mjs';
import { split, toWhatsApp, label, TEXT_MAX, CAPTION_MAX, BUTTON_BODY_MAX } from './format.mjs';
import { codeOf, diagnose } from './diagnose.mjs';
import { Pacer, CapError } from './pace.mjs';

const BRIDGE = 'whatsapp';
const DEDUP_MS = 24 * 3600_000;
const TYPING_EVERY_MS = 20_000;
const CHECK_EVERY_MS = 6 * 3600_000;
const MEDIA_KEEP_MS = 29 * 86_400_000;
const PHOTO_MAX_OUT = 5 * 1024 * 1024;
const OWNER_FILE_MAX = 20 * 1024 * 1024;
const REGISTER_TRIES = 10;
const REGISTER_WINDOW_MS = 72 * 3600_000;

let sara;
let graph;
let media;
let checkTimer;
const pacer = new Pacer();
const seen = new Map();
const sentIds = new Map();
const lastIn = new Map();
const peers = new Map();
const typingTimers = new Map();
const outFiles = new Map();
let capNoticeDay = '';

const s = () => sara.settings;
const v = () => String(s().graphVersion || 'v26.0').replace(/[^\w.]/g, '');
const phoneId = () => String(s().phoneNumberId ?? '').trim();
const wabaId = () => String(s().wabaId ?? '').trim();
const token = () => String(sara.secrets.token ?? '').trim();
const auth = () => ({ Authorization: `Bearer ${token()}` });

class GraphError extends Error {
  constructor(status, err) {
    super(String(err?.message ?? `HTTP ${status}`).replace(/EAA[A-Za-z0-9]{10,}/g, '[key]').slice(0, 300));
    this.status = status;
    this.code = Number(err?.code ?? 0) || status;
    this.subcode = Number(err?.error_subcode ?? 0);
    this.title = String(err?.error_user_title ?? err?.title ?? err?.message ?? '').slice(0, 200);
    this.diag = codeOf(err);
  }
}

function conn() {
  graph ??= new Http1(sara, 'graph', String(s().graphHost || 'graph.facebook.com'));
  return graph;
}

/** One Graph call: JSON in and out, the bearer token, Meta's error codes as GraphError. */
async function api(method, path, body) {
  if (!token()) throw new GraphError(401, { code: 190, message: 'no access token yet' });
  const json = body === undefined ? undefined : JSON.stringify(body);
  const r = await conn().request(method, `/${v()}${path}`, { ...auth(), ...(json ? { 'Content-Type': 'application/json' } : {}) }, json);
  let data = {};
  try {
    data = r.body.length ? JSON.parse(r.body.toString('utf8')) : {};
  } catch {
    data = {};
  }
  if (r.status >= 400 || data.error) throw new GraphError(r.status, data.error ?? { code: r.status });
  return data;
}

// ------------------------------------------------------------------ the connection's health

async function checkToken() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => void checkToken(), CHECK_EVERY_MS);
  checkTimer.unref?.();
  if (!phoneId() || !wabaId() || !token()) return sara.status('error', diagnose('NOT_SET').title);
  try {
    const p = await api('GET', `/${phoneId()}?fields=display_phone_number,verified_name,quality_rating,platform_type`);
    sara.status('ok', `${p.display_phone_number ?? ''} ${p.verified_name ? `(${p.verified_name})` : ''}`.trim());
    return p;
  } catch (err) {
    if (/private local mode/i.test(String(err?.message))) return sara.status('paused', diagnose('PRIVATE_LOCAL').title);
    sara.status('error', diagnose(err.diag ?? 'UNKNOWN', err.message).title);
    return undefined;
  }
}

// ------------------------------------------------------------------ receiving (Sara checked the signature)

function onWebhook({ body }) {
  let parsed;
  try {
    parsed = parsePayload(JSON.parse(String(body ?? '')), phoneId());
  } catch {
    sara.log('a webhook body that is not JSON was dropped', 'warn');
    return { ok: true, messages: 0 };
  }
  for (const o of parsed.other) sara.skip('not-to-her', o.from || o.phoneNumberId);
  for (const st of parsed.statuses) onStatus(st);
  // Accepted at once (Sara answers Meta 200); the turns run after.
  void (async () => {
    for (const m of parsed.messages) await onMessage(m).catch((err) => sara.log(`a message failed: ${err?.message ?? err}`, 'warn'));
  })();
  return { ok: true, messages: parsed.messages.length, statuses: parsed.statuses.length };
}

function onStatus(st) {
  const known = sentIds.get(st.id);
  if (!known) return sara.skip('status-unknown', st.recipient);
  if (st.status !== 'failed' || !st.error) return;
  sara.failed({ bridge: BRIDGE, chatId: known.chatId, code: String(st.error.code), title: st.error.title, reply: !known.started });
}

const chatOf = (m) => (m.bsuid || m.waId).toLowerCase();

async function onMessage(m) {
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > DEDUP_MS) seen.delete(k);
  if (seen.has(m.id)) return sara.skip('duplicate', m.waId || m.bsuid);
  seen.set(m.id, now);
  if (m.group) return sara.skip('group', m.waId || m.bsuid);
  if (m.reaction) return;
  const chatId = chatOf(m);
  if (!chatId) return;
  peers.set(chatId, { waId: m.waId, bsuid: m.bsuid });
  lastIn.set(chatId, m.id);
  const base = { bridge: BRIDGE, chatId, fromId: chatId, ...(m.waId ? { phone: m.waId } : {}), from: m.name, messageId: m.id, chat: { kind: 'dm' }, ...(m.ts ? { at: new Date(m.ts).toISOString() } : {}), ...(m.identity ? { identity: m.identity } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}) };
  if (s().readReceipts === true && s().typing === false) void markRead(m.id);
  // A reply button: Stop on the working line (`st:<ref>`), or its words as his message.
  if (m.button) {
    if (m.button.id.startsWith('st:')) return sara.bridgeInbound({ ...base, text: '', action: 'stop', ref: m.button.id.slice(3) });
    return sara.bridgeInbound({ ...base, text: m.button.title || m.button.id });
  }
  if (m.type === 'text') {
    if (m.forwarded) return sara.bridgeInbound({ ...base, text: '', forwarded: m.text, untrusted: true });
    return sara.bridgeInbound({ ...base, text: m.text });
  }
  if (m.media && ['image', 'document', 'audio'].includes(m.media.kind)) return onMedia(m, base);
  return sara.bridgeInbound({ ...base, text: m.media?.caption || markOf(m) });
}

async function onMedia(m, base) {
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId: base.chatId, fromId: base.fromId, ...(base.phone ? { phone: base.phone } : {}) }).catch(() => ({ who: 'none' }))).who;
  const caption = m.media.caption ?? '';
  // Strangers' files are never downloaded: Sara answers them as it answers a stranger.
  if (who !== 'owner' && who !== 'partner') return sara.bridgeInbound({ ...base, text: caption || (m.media.kind === 'image' ? '[photo]' : '[file]') });
  if (who === 'partner' && m.media.kind !== 'image') return sara.bridgeInbound({ ...base, text: caption || '[file]' });
  try {
    const file = await download(m.media);
    const voice = m.media.kind === 'audio' && m.media.voice === true;
    const name = m.media.filename || (m.media.kind === 'image' ? 'photo.jpg' : voice ? 'voice.ogg' : 'file');
    return sara.sendFile({ ...base, text: caption, files: [{ name, mime: m.media.mime, data: file }], ...(voice ? { voice: true } : {}) });
  } catch (err) {
    const code = err?.diag ?? 'MEDIA_FAILED';
    sara.log(`a ${m.media.kind} couldn't be downloaded: ${err?.message ?? err}`, 'warn');
    if (code === 'MEDIA_HOST') sara.status('error', diagnose('MEDIA_HOST').title);
    sara.failed({ bridge: BRIDGE, chatId: base.chatId, code, title: diagnose(code).title, reply: false });
    if (caption) return sara.bridgeInbound({ ...base, text: caption });
  }
}

/** GET /<media id> → url (5 minutes), then the bytes with the same token; checks the host and Meta's hash. */
async function download(md, again = false) {
  const info = await api('GET', `/${encodeURIComponent(md.id)}`);
  const url = new URL(String(info.url ?? md.url ?? ''));
  const want = String(s().mediaHost || 'lookaside.fbsbx.com').toLowerCase();
  if (url.protocol !== 'https:' || url.host.toLowerCase() !== want) {
    const e = new Error(`Meta serves media from ${url.host}`);
    e.diag = 'MEDIA_HOST';
    throw e;
  }
  if (Number(info.file_size ?? 0) > OWNER_FILE_MAX) {
    const e = new Error('over 20 MB');
    e.diag = 'MEDIA_FAILED';
    throw e;
  }
  media ??= new Http1(sara, 'media', want);
  const r = await media.request('GET', `${url.pathname}${url.search}`, auth());
  if (r.status === 404 && !again) return download(md, true);
  if (r.status >= 400) {
    const e = new Error(`HTTP ${r.status}`);
    e.diag = 'MEDIA_FAILED';
    throw e;
  }
  const want256 = String(info.sha256 ?? md.sha256 ?? '');
  if (want256) {
    const h = createHash('sha256').update(r.body);
    const hex = h.copy().digest('hex');
    const b64 = h.digest('base64');
    if (want256 !== hex && want256 !== b64) {
      const e = new Error("the file's hash doesn't match what Meta said");
      e.diag = 'MEDIA_FAILED';
      throw e;
    }
  }
  return r.body;
}

// ------------------------------------------------------------------ sending

const isRate = (err) => err instanceof GraphError && (err.code === 131056 || err.code === 130429);
const to = (chatId) => {
  const p = peers.get(chatId) ?? {};
  if (p.waId) return { to: p.waId };
  if (p.bsuid) return { recipient: p.bsuid };
  if (/^\d{6,20}$/.test(chatId)) return { to: chatId };
  return { recipient: chatId };
};

async function post(chatId, payload, meta = {}) {
  const r = await pacer.send(chatId, () => api('POST', `/${phoneId()}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', ...to(chatId), ...payload }), isRate);
  const id = String(r?.messages?.[0]?.id ?? '');
  if (id) {
    const now = Date.now();
    for (const [k, x] of sentIds) if (now - x.at > DEDUP_MS) sentIds.delete(k);
    sentIds.set(id, { chatId, at: now, started: meta.started === true });
  }
  return id;
}

function refused(chatId, err, started) {
  if (err instanceof CapError) {
    const day = new Date().toISOString().slice(0, 10);
    if (capNoticeDay !== day) {
      capNoticeDay = day;
      void sara.notify(`WhatsApp: she reached the ${err.cap} cap of messages, so the rest stays in the app.`).catch(() => {});
    }
    return;
  }
  const code = err instanceof GraphError ? String(err.code) : 'UNKNOWN';
  sara.log(`a send was refused: ${err?.message ?? err}`, 'warn');
  if (err instanceof GraphError && err.diag === 'RESTRICTED') sara.status('error', diagnose('RESTRICTED').title);
  if (err instanceof GraphError && err.diag === 'TOKEN_EXPIRED') sara.status('error', diagnose('TOKEN_EXPIRED').title);
  sara.failed({ bridge: BRIDGE, chatId, code, title: err instanceof GraphError ? diagnose(err.diag).title : String(err?.message ?? err).slice(0, 160), reply: !started });
}

async function sendText(chatId, text, o = {}) {
  const parts = split(toWhatsApp(text), TEXT_MAX);
  let first = '';
  for (const [i, p] of parts.entries()) {
    const id = await post(chatId, { type: 'text', text: { body: p, preview_url: false }, ...(i === 0 && o.replyTo ? { context: { message_id: o.replyTo } } : {}) }, o);
    if (i === 0) first = id;
  }
  return first;
}

async function sendButtons(chatId, text, buttons, o = {}) {
  const body = toWhatsApp(text).slice(0, BUTTON_BODY_MAX);
  return post(chatId, { type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: label(b.label) } })) } } }, o);
}

async function onSend(m) {
  const chatId = String(m.chatId).toLowerCase();
  const started = m.started === true;
  try {
    if (m.files?.length) {
      outFiles.set(m.files.map((f) => f.fileId).join(','), { chatId, text: m.text ?? '', files: m.files.map((f) => ({ ...f, parts: [], done: false })), replyTo: m.replyTo, started });
      return;
    }
    if (m.template) {
      await post(chatId, { type: 'template', template: { name: String(m.template), language: { code: 'en' } } }, { started: true });
      return;
    }
    const text = String(m.text ?? '');
    if (!text.trim()) return;
    const id = m.buttons?.length ? await sendButtons(chatId, text, m.buttons, { started }) : await sendText(chatId, text, { replyTo: m.replyTo, started });
    stopTyping(chatId);
    if (id) sara.bridgeSent({ bridge: BRIDGE, ...(m.ref ? { ref: m.ref } : {}), messageId: id });
  } catch (err) {
    refused(chatId, err, started);
  }
}

/** Her pictures and files: one upload each (cached by hash for 29 days), then image or document. */
async function onFile(m) {
  for (const [key, out] of outFiles) {
    const f = out.files.find((x) => x.fileId === m.fileId);
    if (!f) continue;
    f.parts.push(Buffer.from(String(m.data ?? ''), 'base64'));
    if (m.last) f.done = true;
    if (!out.files.every((x) => x.done)) return;
    outFiles.delete(key);
    try {
      const caption = out.text && out.text.length <= CAPTION_MAX ? toWhatsApp(out.text) : '';
      if (out.text && !caption) await sendText(out.chatId, out.text, { started: out.started });
      for (const [i, x] of out.files.entries()) {
        const data = Buffer.concat(x.parts);
        const id = await upload(data, x);
        const asImage = /^image\/(jpeg|png)$/.test(x.mime) && data.length <= PHOTO_MAX_OUT;
        const cap = i === 0 && caption ? { caption } : {};
        await post(out.chatId, asImage ? { type: 'image', image: { id, ...cap } } : { type: 'document', document: { id, filename: String(x.name).slice(0, 120), ...cap } }, { started: out.started });
      }
    } catch (err) {
      refused(out.chatId, err, out.started);
    }
    return;
  }
}

async function upload(data, f) {
  const hash = createHash('sha256').update(data).digest('hex');
  const cached = await sara.kv.get(`media:${hash}`).catch(() => null);
  if (cached && Date.now() - Number(cached.at) < MEDIA_KEEP_MS) return cached.id;
  const { body, type } = multipart({ messaging_product: 'whatsapp', type: f.mime || 'application/octet-stream' }, { name: f.name, mime: f.mime, data });
  const r = await conn().request('POST', `/${v()}/${phoneId()}/media`, { ...auth(), 'Content-Type': type }, body);
  const j = JSON.parse(r.body.toString('utf8') || '{}');
  if (r.status >= 400 || j.error || !j.id) throw new GraphError(r.status, j.error ?? { code: r.status });
  await sara.kv.set(`media:${hash}`, { id: String(j.id), at: Date.now() }).catch(() => {});
  return String(j.id);
}

async function markRead(messageId, typing = false) {
  await api('POST', `/${phoneId()}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: messageId, ...(typing ? { typing_indicator: { type: 'text' } } : {}) }).catch(() => {});
}

function stopTyping(chatId) {
  clearInterval(typingTimers.get(chatId));
  typingTimers.delete(chatId);
}

async function onTyping(m) {
  const chatId = String(m.chatId).toLowerCase();
  stopTyping(chatId);
  if (!m.on || s().typing === false) return;
  const msgId = lastIn.get(chatId);
  if (!msgId) return;
  // Typing also marks his message read (Meta: only show it if you will answer); off for partners.
  const who = (await sara.bridgeWho({ bridge: BRIDGE, chatId, fromId: chatId }).catch(() => ({ who: 'none' }))).who;
  if (who !== 'owner') return;
  const tick = () => void markRead(msgId, true);
  tick();
  const t = setInterval(tick, TYPING_EVERY_MS);
  t.unref?.();
  typingTimers.set(chatId, t);
}

async function onReact(m) {
  // Her 👀 on a steer; a failed reaction is simply no acknowledgement (the typing dots show she works).
  await pacer.send(String(m.chatId).toLowerCase(), () => api('POST', `/${phoneId()}/messages`, { messaging_product: 'whatsapp', ...to(String(m.chatId).toLowerCase()), type: 'reaction', reaction: { message_id: String(m.messageId), emoji: String(m.emoji ?? '👀') } }), isRate).catch(() => {});
}

// ------------------------------------------------------------------ the setup card's checks (W6)

const digits = (x) => /^\d{10,20}$/.test(x);
const keyShaped = (x) => /^EAA[A-Za-z0-9]{20,}$/.test(x);

async function onCheck(m) {
  const step = String(m.step ?? '');
  const fail = (code, detail, params) => ({ ok: false, diagnosis: diagnose(code, detail, params) });
  const g = (err) => fail(err?.diag ?? 'UNKNOWN', err?.message, err?.code ? { code: err.code } : {});
  try {
    if (step === 'ids') {
      if (keyShaped(phoneId()) || keyShaped(wabaId())) return fail('NOT_SET');
      return digits(phoneId()) && digits(wabaId()) ? { ok: true } : fail('NOT_SET');
    }
    if (step === 'token') {
      if (!phoneId() || !wabaId() || !token()) return fail('NOT_SET');
      let p;
      try {
        p = await api('GET', `/${phoneId()}?fields=display_phone_number,verified_name,quality_rating,platform_type,code_verification_status`);
      } catch (err) {
        // The WhatsApp account id where the phone number id belongs (and the other way round).
        if (err?.code === 100) {
          const w = await api('GET', `/${wabaId()}?fields=display_phone_number`).catch(() => undefined);
          if (w?.display_phone_number) return fail('IDS_SWAPPED');
        }
        return g(err);
      }
      // The WhatsApp account answered where the phone number should: the two IDs are swapped.
      if (!p.display_phone_number) {
        const w = await api('GET', `/${wabaId()}?fields=display_phone_number`).catch(() => undefined);
        return fail(w?.display_phone_number ? 'IDS_SWAPPED' : 'TOKEN_WRONG_APP');
      }
      const list = await api('GET', `/${wabaId()}/phone_numbers`).catch((err) => ({ error: err }));
      if (list.error) return g(list.error);
      if (!(list.data ?? []).some((x) => String(x.id) === phoneId())) return fail('TOKEN_WRONG_APP');
      if (p.platform_type && p.platform_type !== 'CLOUD_API') return fail('NOT_REGISTERED');
      sara.status('ok', `${p.display_phone_number ?? ''} ${p.verified_name ? `(${p.verified_name})` : ''}`.trim());
      return { ok: true, number: { display: p.display_phone_number ?? '', verifiedName: p.verified_name ?? '', quality: p.quality_rating ?? '', test: /test/i.test(String(p.verified_name ?? '')) } };
    }
    if (step === 'subscribed') {
      const r = await api('GET', `/${wabaId()}/subscribed_apps`);
      return (r.data ?? []).length ? { ok: true } : fail('NOT_SUBSCRIBED');
    }
    if (step === 'fix-subscribe') {
      await api('POST', `/${wabaId()}/subscribed_apps`, {});
      return { ok: true };
    }
    if (step === 'fix-identity') {
      await api('POST', `/${phoneId()}/settings`, { user_identity_change: { enable_identity_key_check: true } });
      await sara.kv.set('identityCheck', true);
      return { ok: true };
    }
    if (step === 'register') {
      const pin = String(m.pin ?? '');
      const id = String(m.phoneNumberId ?? phoneId());
      if (!/^\d{6}$/.test(pin) || !digits(id)) return fail('NOT_SET');
      const tries = ((await sara.kv.get('registerTries').catch(() => null)) ?? []).filter((t) => Date.now() - t < REGISTER_WINDOW_MS);
      if (tries.length >= REGISTER_TRIES) return fail('REGISTER_LIMIT');
      await sara.kv.set('registerTries', [...tries, Date.now()]);
      await api('POST', `/${id}/register`, { messaging_product: 'whatsapp', pin });
      return { ok: true };
    }
    if (step === 'send-test') {
      const chatId = String(m.chatId ?? '').toLowerCase();
      if (!chatId) return fail('NOT_SET');
      await sendText(chatId, String(m.text ?? 'Test from Sara: it works.'), { started: false });
      return { ok: true };
    }
    if (step === 'about') {
      await api('POST', `/${phoneId()}/whatsapp_business_profile`, { messaging_product: 'whatsapp', about: String(m.about ?? 'An AI companion, not a person.').slice(0, 139) });
      return { ok: true };
    }
    if (step === 'identity-state') return { ok: (await sara.kv.get('identityCheck').catch(() => null)) === true };
  } catch (err) {
    return g(err);
  }
  return fail('UNKNOWN', `no check called ${step.slice(0, 40)}`);
}

/** The Test button: read-only Graph calls, sends nothing to anyone. */
async function onTest() {
  const steps = [];
  const add = (label, ok, fix) => steps.push({ label, ok, ...(ok ? {} : { fix }) });
  add('The two IDs are set', digits(phoneId()) && digits(wabaId()), 'Paste the Phone number ID and the WhatsApp account ID (step 3).');
  add('The key is set', Boolean(token()), 'Paste the access token (step 5).');
  if (!token() || !phoneId()) return { steps };
  const t = await onCheck({ step: 'token' });
  add(t.ok ? `The key works for ${t.number?.display ?? 'her number'}` : 'The key works', t.ok, t.diagnosis?.title);
  if (t.ok) {
    add(`Quality: ${String(t.number?.quality || 'unknown').toLowerCase()}`, !t.number?.quality || t.number.quality === 'GREEN', 'Open WhatsApp Manager → Account quality.');
    const sub = await onCheck({ step: 'subscribed' });
    add('Your app is subscribed to the account', sub.ok, sub.diagnosis?.title);
    add("Meta's identity check is on", (await onCheck({ step: 'identity-state' })).ok, 'Link your WhatsApp again, or press Fix it on the card.');
  }
  return { steps };
}

sara = plugin({
  bridge: { files: true, edit: false, typing: true, react: true, link: true, textMax: TEXT_MAX, ack: 'react', window: { hours: 24 }, buttons: 3, maxBytes: OWNER_FILE_MAX },
  bridges: {
    [BRIDGE]: {
      send: (m) => onSend(m),
      file: (m) => onFile(m),
      typing: (m) => onTyping(m),
      react: (m) => onReact(m),
      webhook: (m) => onWebhook(m),
      check: (m) => onCheck(m),
      test: () => onTest(),
    },
  },
  tools: [],
  init: async (api0) => {
    sara = api0;
    setTimeout(() => void checkToken(), 0);
  },
});

process.on('SIGTERM', () => {
  void graph?.close();
  void media?.close();
});
